import { effectiveToolDescription } from '../agent/tool-descriptions.js';
import {roleToolDescription,roleToolParameters} from '../agent/tool-description-policy.js';
// 领域工具定义 helper：JSON Schema 字面量 → pi ToolDefinition。
// 统一负责：输出 clamp（有界 JSON）、错误 → isError 工具结果（模型可消化）、
// 只读/幂等标注。完整结果持久保存，超长 JSON 返回有界分片和续读引用。

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolRunContext } from "./context.js";
import {saveToolOutput} from '../evidence/tool-outputs.js';

export const MAX_TOOL_OUTPUT = 20 * 1024;

export function clampOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_TOOL_OUTPUT) return text;
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { value = { content: text }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = { content: value };
  const root = value as Record<string, unknown>, changed = new Set<string>();
  const size = () => Buffer.byteLength(JSON.stringify(root), "utf8");
  const walkStrings = (v: unknown, prefix: string, out: { parent: Record<string, unknown> | unknown[]; key: string | number; value: string; path: string }[]) => {
    if (typeof v === "string") { out.push({ parent: {}, key: "", value: v, path: prefix }); return; }
    if (Array.isArray(v)) { for (let i=0;i<v.length;i++) walkStrings(v[i], `${prefix}[${i}]`, out); return; }
    if (v && typeof v === "object") for (const [key,child] of Object.entries(v)) walkStrings(child, prefix ? `${prefix}.${key}` : key, out);
  };
  const findParent = (v: unknown, path: string, prefix = ""): { parent: Record<string, unknown> | unknown[]; key: string | number } | undefined => {
    if (Array.isArray(v)) {
      for (let i=0;i<v.length;i++) { const childPath=`${prefix}[${i}]`; if(childPath===path)return {parent:v,key:i}; const found=findParent(v[i],path,childPath);if(found)return found; }
    } else if (v && typeof v === "object") {
      for (const [key,child] of Object.entries(v)) { const childPath=prefix?`${prefix}.${key}`:key;if(childPath===path)return {parent:v as Record<string,unknown>,key};const found=findParent(child,path,childPath);if(found)return found; }
    }
    return undefined;
  };
  for (let pass=0;size()>MAX_TOOL_OUTPUT-256&&pass<400;pass++) {
    const strings:{parent:Record<string,unknown>|unknown[];key:string|number;value:string;path:string}[]=[];
    walkStrings(root,"",strings);
    strings.sort((a,b)=>Buffer.byteLength(b.value)-Buffer.byteLength(a.value));
    const candidate=strings.find(s=>Buffer.byteLength(s.value)>96);
    if(candidate){
      const parent=findParent(root,candidate.path);if(!parent)break;
      const current=Buffer.byteLength(candidate.value),excess=size()-(MAX_TOOL_OUTPUT-256);
      const target=Math.max(48,current-Math.max(128,excess));
      const bytes=Buffer.from(candidate.value,"utf8");let end=Math.min(bytes.length,target);
      while(end>0&&(bytes[end]!&0xc0)===0x80)end--;
      (parent.parent as Record<string|number,unknown>)[parent.key]=bytes.subarray(0,end).toString("utf8")+"…[续读/窄化查询]";
      changed.add(candidate.path);continue;
    }
    let largest:{array:unknown[];path:string}|undefined;
    const findArray=(v:unknown,prefix:string)=>{if(Array.isArray(v)){if(v.length>2&&(!largest||v.length>largest.array.length))largest={array:v,path:prefix};for(let i=0;i<v.length;i++)findArray(v[i],`${prefix}[${i}]`);}else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))findArray(x,prefix?`${prefix}.${k}`:k);};
    findArray(root,"");
    if(largest){largest.array.splice(Math.ceil(largest.array.length/2));changed.add(largest.path);continue;}
    break;
  }
  root.truncated_fields=[...changed].slice(0,64);
  let output=JSON.stringify(root);
  if(Buffer.byteLength(output,"utf8")>MAX_TOOL_OUTPUT){
    let preview=Buffer.from(text,"utf8").subarray(0,MAX_TOOL_OUTPUT-300).toString("utf8");
    output=JSON.stringify({truncated:true,preview});
    while(Buffer.byteLength(output,"utf8")>MAX_TOOL_OUTPUT){preview=preview.slice(0,Math.floor(preview.length*0.8));output=JSON.stringify({truncated:true,preview});}
  }
  return output;
}

export interface DomainToolSpec<T> {
  name: string;
  description: string;
  /** SDK 默认提示的工具摘要；自定义 system prompt 下仍须提供完整的 description/Schema。 */
  promptSnippet?: string;
  /** JSON Schema（对象类型，properties/required）。 */
  parameters: Record<string, unknown>;
  readOnly?: boolean;
  transactional?: boolean;
  idempotent?: boolean;
  /** 返回 string 原样输出；对象则 JSON 序列化（经 clamp）。 */
  run: (args: T, ctx: ToolRunContext) => Promise<string | Record<string, unknown>>;
}

export function domainTool<T>(spec: DomainToolSpec<T>, ctx: ToolRunContext) {
  return defineTool({
    name: spec.name,
    label: spec.name,
    description: roleToolDescription(spec.name,effectiveToolDescription(spec.name, spec.description),ctx.role),
    promptSnippet: spec.promptSnippet,
    // pi otherwise prepares a whole batch before starting its tools in parallel.
    // Domain writes must preserve model order: evidence -> finding -> summary.
    // A sequential tool serializes its entire native batch, including MCP/bash.
    executionMode: spec.readOnly === true ? 'parallel' : 'sequential',
    parameters: roleToolParameters(spec.name,spec.parameters,ctx.role) as never,
    annotations: {
      readOnlyHint: spec.readOnly === true,
      idempotentHint: spec.idempotent === true,
    },
    async execute(_toolCallId: string, params: T, signal?: AbortSignal) {
      try {
        signal?.throwIfAborted();
        if(ctx.hooks.assertOwnership && spec.transactional===false)await ctx.hooks.assertOwnership(ctx.db);
        const execute=(db:typeof ctx.db)=>spec.run(params, { ...ctx, db, signal, toolCallID: _toolCallId });
        const out = ctx.hooks.assertOwnership && spec.transactional!==false ? await ctx.db.transaction(async db=>{await ctx.hooks.assertOwnership!(db);return execute(db);}) : await execute(ctx.db);
        const text = typeof out === "string" ? JSON.stringify({ content: out }) : JSON.stringify(out);
        const response=Buffer.byteLength(text,'utf8')>MAX_TOOL_OUTPUT?JSON.stringify(await saveToolOutput(ctx.db,ctx,spec.name,_toolCallId,text)):text;
        return { content: [{ type: "text" as const, text: response }], details: undefined };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: clampOutput(JSON.stringify({ error: msg })) }],
          isError: true,
          details: undefined,
        };
      }
    },
  });
}
