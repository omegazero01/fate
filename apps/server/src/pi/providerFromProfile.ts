import type {Database} from '../db/index.js';
import {meterProvider} from './usage-meter.js';
// LLM profile → pi-ai provider/model 构造（index.ts 的模型解析器与 /api/llm/test 共享）。

import { createProvider } from "@earendil-works/pi-ai";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import * as anthropic from "@earendil-works/pi-ai/api/anthropic-messages";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSource } from "../agent/roles.js";
import { nonStreamingFetch } from './nonStreaming.js';

export interface ProfileLike {
  supportsImages?: boolean;
  id: number;
  name: string;
  model: string;
  baseURL: string;
  apiKey: string;
  contextWindowK: number;
  maxTokens: number;
  thinkingType?: string;
  reasoningEffort?: string;
  format?: string;
  proxy?: string;
  streaming?: boolean;
  maxTokensField?: string;
  sessionHeaderKey?: string;
  sessionHeaderValue?: string;
}

const proxyAgents=new Map<string,ProxyAgent>();
/** Catalogue requests and PI calls must use the same configured transport. */
export function profileFetch(proxy?: string, fallback: typeof fetch = globalThis.fetch): typeof fetch {
  const address = proxy?.trim();
  if (!address) return fallback;
  let dispatcher = proxyAgents.get(address);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(address);
    proxyAgents.set(address, dispatcher);
  }
  const agent = dispatcher;
  return ((input, init) => undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...init, dispatcher: agent } as never)) as typeof fetch;
}

/** Keep upstream authentication failures distinct from the platform's login. */
export function describeModelError(error: unknown, apiKey: string): string {
  let detail = error instanceof Error ? error.message : String(error);
  if (apiKey) detail = detail.replaceAll(apiKey, '[REDACTED]');
  detail = detail.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
  const status = Number((error as { status?: number } | null)?.status)
    || Number(detail.match(/^(?:HTTP\s+)?(\d{3})(?:\b|:)/)?.[1]);
  const reason = status === 401
    ? '模型服务认证失败（HTTP 401），请检查 API Key、服务地址和协议是否匹配；这不是系统登录失效。'
    : status === 403 ? '模型服务拒绝访问（HTTP 403），请检查密钥权限及模型访问权限。'
    : '';
  return `${reason}${reason ? ' 服务返回：' : ''}${detail.slice(0, 1500)}`;
}

function configuredStreams(module:unknown,profile:ProfileLike,api:string){
  const source=module as Record<string,unknown>,out={...source};
  for(const name of ['stream','streamSimple']){
    const base=source[name];if(typeof base!=='function')continue;
    out[name]=(model:unknown,context:unknown,options?:Record<string,unknown>)=>{
      const original=options??{},headers={...((original.headers&&typeof original.headers==='object'?original.headers:{}) as Record<string,string|null>)};
      if(profile.sessionHeaderKey&&profile.sessionHeaderValue)headers[profile.sessionHeaderKey]=profile.sessionHeaderValue;
      let fetcher=original.fetch;
      if(profile.proxy){
        fetcher=profileFetch(profile.proxy);
      }
      if(profile.streaming===false)fetcher=nonStreamingFetch((fetcher??globalThis.fetch) as typeof fetch,api);
      const previous=original.onPayload as ((payload:unknown,model:unknown)=>unknown|Promise<unknown>)|undefined;
      const onPayload=async(payload:unknown,selectedModel:unknown)=>{
        const next=(await previous?.(payload,selectedModel))??payload;
        if(!next||typeof next!=='object')return next;
        const requested=Number(original.maxTokens);
        const explicitLimit=Number.isFinite(requested)&&requested>0;
        if(profile.maxTokens<=0&&!explicitLimit){
          // OpenAI accepts an omitted limit. PI's model-capacity default must not
          // turn an unset profile limit into an application output budget.
          if(api==='anthropic-messages')return next;
          const unlimited={...next as Record<string,unknown>};
          for(const key of ['max_tokens','max_completion_tokens','max_output_tokens',profile.maxTokensField??''])delete unlimited[key];
          return unlimited;
        }
        // Preserve pi's protocol compatibility detection (e.g. DeepSeek uses
        // max_tokens). A configured field remains an explicit user override.
        const nativeField=['max_tokens','max_completion_tokens','max_output_tokens'].find(key=>Object.hasOwn(next,key));
        const field=profile.maxTokensField?.trim()||nativeField||(api==='anthropic-messages'?'max_tokens':api==='openai-responses'?'max_output_tokens':'max_completion_tokens');
        const result={...next as Record<string,unknown>};
        for(const key of ['max_tokens','max_completion_tokens','max_output_tokens'])delete result[key];
        result[field]=explicitLimit?(profile.maxTokens>0?Math.min(profile.maxTokens,requested):requested):profile.maxTokens;
        return result;
      };
      return (base as (model:unknown,context:unknown,options:Record<string,unknown>)=>unknown)(model,context,{
        ...original,headers,...(fetcher?{fetch:fetcher}:{}),onPayload,
        // pi's host model policy owns retries/failover; provider clients must not
        // replay a request after the session has committed tool work.
        maxRetries:0,
      });
    };
  }
  return out;
}

export function buildModelSource(profile: ProfileLike): Promise<ModelSource> {
  profile = { ...profile, apiKey: profile.apiKey.trim(), baseURL: profile.baseURL.trim(), model: profile.model.trim() };
  const api = profile.format === "anthropic" ? "anthropic-messages" : profile.format === "openai-responses" ? "openai-responses" : "openai-completions";
  if (profile.format && !["openai", "anthropic", "openai-responses"].includes(profile.format)) throw new Error(`不支持的 LLM 协议：${profile.format}`);
  const effort = profile.reasoningEffort || profile.thinkingType || "off";
  const thinkingLevel = (["off", "minimal", "low", "medium", "high", "xhigh"].includes(effort) ? effort : effort === "disabled" ? "off" : "medium") as ModelSource["thinkingLevel"];
  // Capability and the selected level are different. Current DeepSeek hybrid
  // models default to thinking on; PI emits thinking.type=disabled only when
  // the model advertises the capability. Never silently turn an explicit off
  // configuration into server-default reasoning (including summary calls).
  const deepSeekHybrid=api==='openai-completions'&&/^deepseek-(?:flash|v4(?:\.1)?-(?:flash|pro))$/i.test(profile.model);
  const providerId = `series-p${profile.id}`;
  const contextWindow = profile.contextWindowK > 0 ? profile.contextWindowK * 1000 : 128_000;
  const model = {
    id: profile.model,
    name: profile.name !== "" ? profile.name : profile.model,
    api,
    provider: providerId,
    baseUrl: profile.baseURL,
    input: profile.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: profile.maxTokens > 0 ? profile.maxTokens : 8192,
    // 思考档位：profile.thinking_type 非空即启用（pi 统一档位映射到 provider 原生参数）。
    reasoning: deepSeekHybrid || thinkingLevel !== "off",
  } as Record<string, unknown>;
  const provider = createProvider({
    id: providerId,
    name: profile.name !== "" ? profile.name : providerId,
    baseUrl: profile.baseURL,
    auth: {
      apiKey: {
        name: `SERIES_PROFILE_${profile.id}_KEY`,
        resolve: async () => ({ auth: { apiKey: profile.apiKey } }),
      },
    },
    models: [model as never],
    api: { [api]: configuredStreams(api === "anthropic-messages" ? anthropic : api === "openai-responses" ? openaiResponses : openaiCompletions,profile,api) as never },
  });
  return (async () => {
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    await modelRuntime.registerNativeProvider(provider as never);
    await modelRuntime.refresh({allowNetwork:false});
    return { modelRuntime, model: model as never, thinkingLevel, streaming:profile.streaming!==false } satisfies ModelSource;
  })();
}

/** 一次最小补全用于测试连接：返回 {ok, latency_ms, model, reply, error}。 */
export async function testProfileConnection(
  profile: ProfileLike,
  db?:Database,
): Promise<{ ok: boolean; latency_ms: number; model: string; reply?: string; error?: string }> {
  const start = Date.now();
  try {
    const source = await buildModelSource(profile);
    if(db){const provider=source.modelRuntime.getProvider(source.model.provider)!;
      await source.modelRuntime.registerNativeProvider(meterProvider(db,provider,{id:profile.id??0,name:profile.name??'连接诊断',model:profile.model},()=>({role:'system',purpose:'diagnostic'})));}
    const models = source.modelRuntime as unknown as { completeSimple: (model: unknown, context: unknown, options?: unknown) => Promise<{ stopReason?:string;errorMessage?:string;content?: Array<{ type: string; text?: string }> }> };
    const result = await models.completeSimple(
      source.model,
      { systemPrompt: "You are a connectivity probe. Reply with the single word: pong", messages: [{ role: "user", content: "ping" }] },
      { maxTokens: 512 },
    );
    if(result.stopReason==='error')throw new Error(result.errorMessage??'模型请求失败');
    const reply = (result.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    if(!reply)throw new Error("模型没有返回有效文本");
    return { ok: true, latency_ms: Date.now() - start, model: profile.model, reply };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, model: profile.model, error: describeModelError(err, profile.apiKey.trim()) };
  }
}
