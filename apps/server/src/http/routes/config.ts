import {catalogTools} from '../../agent/tool-catalog.js';
import {roleContextPolicy,CONTEXT_DEFAULTS} from '../../agent/context-policy.js';
import {toolIdentity} from '../../agent/tool-registry.js';
import {assertActiveRole} from '../../agent/retired-roles.js';
import {resolveRolePrompt,PROMPT_VERSION,hostProtocol} from '../../agent/prompts.js';
import {runtimeConfiguration} from '../../engine/runtime-config.js';
// 系统配置路由：settings KV / agents（列表+提示词）/ LLM profiles / MCP / skills 文件树。
// web-search、judge、http-auth、pool 等子配置属已删除模块（routes/removed.ts 统一 404）。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { testProfileConnection, type ProfileLike } from "../../pi/providerFromProfile.js";
import type { Agent, LLMProfile } from "../../db/platform.js";
import { ActiveLLMProfileDeleteError, LLMProfileNotFoundError } from "../../db/platform.js";

function agentDTO(a: Agent): Record<string, unknown> {
  return { ...a };
}

function profileDTO(p: LLMProfile): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    format: p.format,
    base_url: p.baseURL,
    proxy: p.proxy,
    model: p.model,
    api_key: "", // 列表面不回传 key
    api_key_hint: p.apiKeyHint,
    rate_per_second: p.ratePerSecond,
    rate_per_minute: p.ratePerMinute,
    context_window_k: p.contextWindowK,
    supports_images:p.supportsImages===true,
    thinking_type: p.thinkingType,
    reasoning_effort: p.reasoningEffort,
    is_default: p.isDefault,
    priority: p.priority,
    pool_exclude: p.poolExclude,
    streaming: p.streaming,
    max_tokens: p.maxTokens,
    max_tokens_field: p.maxTokensField,
    session_header_key: p.sessionHeaderKey,
    retry: p.retry,
  };
}

export function registerConfigRoutes(app: FastifyInstance): void {
  app.get('/api/tasks/:id/runtime-config',async(req,reply)=>{const id=Number((req.params as {id:string}).id);if(!await app.db.tasks().getTask(id))return reply.code(404).send({error:'task not found'});return runtimeConfiguration(app.db,{taskID:id});});
  app.get('/api/conversations/:id/runtime-config',async(req,reply)=>{const id=Number((req.params as {id:string}).id);if(!(await app.db.query('SELECT id FROM conversations WHERE id=$1',[id])).rowCount)return reply.code(404).send({error:'conversation not found'});return runtimeConfiguration(app.db,{conversationID:id});});
  // ─── LLM 测试连接：按 body 参数（或已存 profile id）构造 provider 做一次最小补全 ───
  // ─── 内置工具目录 ───
  app.get("/api/tools", async () => catalogTools(app.db));

  app.put("/api/tools/:key", async (req) => {
    const p = req.params as { key: string };
    const catalogRow=(await app.db.query('SELECT kind FROM tools WHERE key=$1',[p.key])).rows[0];
    if(catalogRow&&['retired','unsupported'].includes(toolIdentity(p.key,String(catalogRow.kind)).implementation_status))throw Object.assign(new Error('当前版本不支持此历史工具，不能重新启用'),{statusCode:410});
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof b["description"] === "string") { params.push(b["description"]); sets.push(`description=$${params.length}`); }
    if (Array.isArray(b["agents"])) { params.push(JSON.stringify(b["agents"])); sets.push(`agents=$${params.length}::jsonb`); }
    if (typeof b["enabled"] === "boolean") { params.push(b["enabled"]); sets.push(`enabled=$${params.length}`); }
    if (sets.length === 0) return { ok: false, error: "无可更新字段" };
    params.push(p["key"]);
    const r = await app.db.query(`UPDATE tools SET ${sets.join(", ")} WHERE key=$${params.length}`, params);
    return { ok: (r.rowCount ?? 0) === 1 };
  });

  app.post("/api/tools/:key/reset", async (req) => {
    const p = req.params as { key: string };
    const catalogRow=(await app.db.query('SELECT kind FROM tools WHERE key=$1',[p.key])).rows[0];
    if(catalogRow&&['retired','unsupported'].includes(toolIdentity(p.key,String(catalogRow.kind)).implementation_status))throw Object.assign(new Error('当前版本不支持此历史工具，不能重新启用'),{statusCode:410});
    const r = await app.db.query(`UPDATE tools SET enabled=true WHERE key=$1`, [p["key"]]);
    return { ok: (r.rowCount ?? 0) === 1 };
  });

  // POST /api/llm/test — 兼容三族字段名：profile_id / id（已存 profile，直接字段
  // 非空时覆盖对应项——表单里改了 model 就用改后的，Key 留空回落库存 Key）与
  // provider/model/base_url/api_key 直连参数（新建未保存时的探测）。
  app.post("/api/llm/test", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const profileID = Number(b["profile_id"] ?? b["id"]) || 0;
    let profile: ProfileLike | null = null;
    if (profileID > 0) {
      const rows = await app.db.query(`SELECT * FROM llm_profiles WHERE id=$1`, [profileID]);
      const r = rows.rows[0] as Record<string, unknown> | undefined;
      if (r) {
        const bodyModel = typeof b["model"] === "string" && b["model"] !== "" ? b["model"] : "";
        const bodyKey = typeof b["api_key"] === "string" && b["api_key"] !== "" ? b["api_key"] : "";
        const bodyBase = typeof b["base_url"] === "string" && b["base_url"] !== "" ? b["base_url"] : "";
        profile = {
          id: Number(r["id"]), name: String(r["name"] ?? ""),
          model: bodyModel || String(r["model"] ?? ""),
          baseURL: bodyBase || String(r["base_url"] ?? ""),
          apiKey: bodyKey || String(r["api_key"] ?? ""),
          contextWindowK: Number(r["context_window_k"] ?? 0), maxTokens: Number(r["max_tokens"] ?? 0),
          thinkingType: String(b["thinking_type"] ?? r["thinking_type"] ?? ""),
          format: String(b["format"] ?? r["format"] ?? "openai"),
          reasoningEffort: String(b["reasoning_effort"] ?? r["reasoning_effort"] ?? ""),
          proxy: String(b["proxy"] ?? r["proxy"] ?? ""),
          streaming: (b["streaming"] ?? r["streaming"]) !== false,
          maxTokensField: String(b["max_tokens_field"] ?? r["max_tokens_field"] ?? ""),
          sessionHeaderKey: String(b["session_header_key"] ?? r["session_header_key"] ?? ""),
          sessionHeaderValue: 'connectivity-probe',
        };
      }
    }
    if (!profile) {
      profile = {
        id: 0, name: String(b["name"] ?? "probe"),
        model: String(b["model"] ?? ""), baseURL: String(b["base_url"] ?? ""), apiKey: String(b["api_key"] ?? ""),
        contextWindowK: Number(b["context_window_k"] ?? 0), maxTokens: Number(b["max_tokens"] ?? 0),
        thinkingType: String(b["thinking_type"] ?? ""),
        format: String(b["format"] ?? "openai"),
        reasoningEffort: String(b["reasoning_effort"] ?? ""),
        proxy: String(b["proxy"] ?? ""), streaming: b["streaming"] !== false,
        maxTokensField: String(b["max_tokens_field"] ?? ""),
        sessionHeaderKey: String(b["session_header_key"] ?? ""), sessionHeaderValue: 'connectivity-probe',
      };
    }
    if (!profile.model || !profile.baseURL) {
      return { ok: false, error: "缺少 model 或 base_url" };
    }
    const result = await testProfileConnection(profile,app.db);
    // 前端契约：一个字都不回的配置直接判失败（网络异常在 pi 层可能只产空回复）。
    if (result.ok && (result.reply ?? "") === "") {
      return { ...result, ok: false, error: `模型 ${profile.model} 未返回任何内容（base_url 不可达或配置无效）` };
    }
    return result;
  });

  // POST /api/llm/models — OpenAI 兼容模型目录拉取（api.fetchLLMModels）。
  // base_url 直接拼 /models（api.deepseek.com 风格），404 再回落 /v1/models；
  // profile_id 可代替 base_url+api_key（编辑已存配置时 Key 框留空）。
  // 失败也回 200 {ok:false, models:[], error}——前端据此渲染空态并 toast。
  app.post("/api/llm/models", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    let baseURL = typeof b["base_url"] === "string" ? b["base_url"].trim() : "";
    let apiKey = typeof b["api_key"] === "string" ? b["api_key"].trim() : "";
    const profileID = Number(b["profile_id"] ?? b["id"]) || 0;
    if (profileID > 0) {
      const rows = await app.db.query(`SELECT base_url, api_key FROM llm_profiles WHERE id=$1`, [profileID]);
      const r = rows.rows[0] as Record<string, unknown> | undefined;
      if (r) {
        if (baseURL === "") baseURL = String(r["base_url"] ?? "");
        if (apiKey === "") apiKey = String(r["api_key"] ?? "");
      }
    }
    if (baseURL === "") return { ok: false, models: [], error: "缺少 base_url" };
    const root = baseURL.replace(/\/+$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey !== "") headers["Authorization"] = `Bearer ${apiKey}`;
    const attempt = async (url: string): Promise<string[]> => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        const err = new Error(`HTTP ${String(res.status)} ${url}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      const body = (await res.json()) as {
        data?: Array<{ id?: string; model?: string } | string>;
        models?: Array<{ id?: string; model?: string } | string>;
      };
      const list = body.data ?? body.models ?? [];
      const ids = list
        .map((m) => (typeof m === "string" ? m : String(m?.id ?? m?.model ?? "")))
        .filter((id) => id !== "");
      return [...new Set(ids)].sort();
    };
    try {
      let models: string[];
      try {
        models = await attempt(`${root}/models`);
      } catch (err) {
        // 根路径未暴露 models（OpenAI 惯例挂 /v1）：404/405 时再试一次。
        const status = (err as { status?: number }).status;
        if (status !== 404 && status !== 405) throw err;
        models = await attempt(`${root}/v1/models`);
      }
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  const platform = () => app.db.platform();

  // ─── settings KV（保留键的最小面）─────────────────────────────────────────

  app.get("/api/settings", async () => {
    const [workers, activeTask] = await Promise.all([
      platform().workers(),
      platform().getSetting("active_task"),
    ]);
    return { workers,
      planner_context_budget_tokens:Number((await platform().getSetting('planner_context_budget_tokens'))??CONTEXT_DEFAULTS.planner),
      worker_context_budget_tokens:Number((await platform().getSetting('worker_context_budget_tokens'))??CONTEXT_DEFAULTS.worker),
      pi_context_policy:(await platform().getSetting('pi_context_policy'))??'domain',pi_mcp_loading:(await platform().getSetting('pi_mcp_loading'))??'deferred', task_concurrency_enabled:(await platform().getSetting("task_concurrency_enabled"))==="true", task_concurrency_limit:Number(await platform().getSetting("task_concurrency_limit"))||5, effective:{workers:"per task; next claim",role_settings:"next session",task_concurrency:"next admission",planner_context_budget_tokens:'next planner session',worker_context_budget_tokens:'next worker session'}, active_task: activeTask ?? "" };
  });

  const setSettings = async (req: { body?: unknown }, reply: { code(c: number): { send(v: unknown): unknown } }): Promise<unknown> => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for(const [key,allowed] of Object.entries({pi_context_policy:['domain','native'],pi_mcp_loading:['deferred','direct']})){
      if(b[key]!==undefined&&!allowed.includes(String(b[key])))return reply.code(400).send({error:`无效 ${key}`});
    }
    const contextKeys=(['planner','worker'] as const).map(role=>({role,key:`${role}_context_budget_tokens`}));
    for(const {role,key} of contextKeys){
      if(b[key]===undefined)continue;
      if(typeof b[key]!=='number')return reply.code(400).send({error:`${key} 必须为整数`});
      try{roleContextPolicy(role,0,String(b[key]));}catch(error){return reply.code(400).send({error:(error as Error).message});}
    }
    // Both role settings are validated before either is changed.
    await app.db.transaction(async tx=>{
      for(const {key} of contextKeys)if(b[key]!==undefined){
        await tx.platform().setSetting(key,String(b[key]));
        out[key]=b[key];out.applies='next_session';
      }
    });
    for(const key of ['pi_context_policy','pi_mcp_loading'])if(b[key]!==undefined){await platform().setSetting(key,String(b[key]));out[key]=b[key];out.applies='next_session';}
    if(b["task_concurrency_enabled"]!==undefined)await platform().setSetting("task_concurrency_enabled",String(b["task_concurrency_enabled"]===true));
    if(b["task_concurrency_limit"]!==undefined){const n=Number(b["task_concurrency_limit"]);if(!Number.isInteger(n)||n<1)return reply.code(400).send({error:"task_concurrency_limit 必须为正整数"});await platform().setSetting("task_concurrency_limit",String(n));}
    if (b["workers"] !== undefined) {
      const n = Number(b["workers"]);
      if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: "workers 必须 >0" });
      try{await app.db.plannerLockPool(Math.min(128,n));}catch(error){return reply.code(400).send({error:(error as Error).message});}
      await platform().setWorkers(n);
      out["workers"] = n;
    }
    if (typeof b["active_task"] === "string") {
      await platform().setSetting("active_task", b["active_task"]);
      out["active_task"] = b["active_task"];
    }
    return out;
  };
  app.post("/api/settings", async (req, reply) => setSettings(req, reply));
  app.put("/api/settings", async (req, reply) => setSettings(req, reply));

  // ─── agents ────────────────────────────────────────────────────────────────

  app.get("/api/agents", async () => {
    const agents = await platform().listAgents();
    return { agents: agents.map(agentDTO) };
  });

  // POST /api/agents — 新建自定义 agent（key 唯一）。
  app.post("/api/agents", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const key = typeof b["key"] === "string" ? b["key"].trim() : "";
    const name = typeof b["name"] === "string" ? b["name"].trim() : "";
    const description = typeof b["description"] === "string" ? b["description"] : "";
    assertActiveRole(key);
    if (!/^[a-z0-9_-]{1,64}$/i.test(key) || name === "") {
      return reply.code(400).send({ error: "key 仅限字母数字/_/-（<=64），name 不能为空" });
    }
    if (await platform().getAgentByKey(key)) return reply.code(409).send({ error: `agent key ${key} 已存在` });
    const res = await app.db.query(
      `INSERT INTO agents(key, name, description, role, builtin, enabled) VALUES ($1,$2,NULLIF($3,''),'assistant',false,true) RETURNING id`,
      [key, name, description],
    );
    const agent = await platform().getAgentByKey(key);
    return reply.code(201).send(agentDTO(agent ?? ({ id: Number(res.rows[0]!.id) } as unknown as Agent)));
  });

  app.get("/api/agents/:key", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await platform().getAgentByKey(key);
    if (!agent) return reply.code(404).send({ error: `agent ${key} 不存在` });
    const [prompt, variables] = await Promise.all([platform().currentPrompt(agent.id), platform().promptVars(agent.id)]);
    const effective = await resolveRolePrompt(app.db, key);
    return { ...agentDTO(agent), prompt: prompt || effective.template, variables,
      prompt_source: effective.source, effective_prompt: effective.template, builtin_version: PROMPT_VERSION,
      prompt_candidate: effective.candidate, host_protocol: hostProtocol(key) };
  });

  // PUT /api/agents/:key/prompt — 保存提示词新版本并切换 current。
  app.put("/api/agents/:key/prompt", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await platform().getAgentByKey(key);
    if (!agent) return reply.code(404).send({ error: `agent ${key} 不存在` });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b["template"] !== "string" || b["template"].trim() === "") {
      return reply.code(400).send({ error: "template 不能为空" });
    }
    const note = typeof b["note"] === "string" ? b["note"] : "";
    const version = await platform().savePrompt(agent.id, b["template"], note, "user");
    return { version };
  });

  // ─── LLM profiles ──────────────────────────────────────────────────────────

  app.get("/api/llm/profiles", async () => {
    const profiles = await platform().listProfiles();
    return { profiles: profiles.map(profileDTO) };
  });

  app.post("/api/llm/profiles", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const retry = (b["retry"] ?? {}) as Record<string, unknown>;
    const id = await platform().saveProfile({
      id: b["id"] === undefined || b["id"] === null ? undefined : Number(b["id"]),
      name: String(b["name"] ?? ""),
      format: String(b["format"] ?? "openai"),
      baseURL: typeof b["base_url"] === "string" ? b["base_url"] : "",
      proxy: typeof b["proxy"] === "string" ? b["proxy"] : "",
      model: String(b["model"] ?? ""),
      apiKey: typeof b["api_key"] === "string" ? b["api_key"] : "",
      apiKeyHint: typeof b["api_key_hint"] === "string" ? b["api_key_hint"] : "",
      ratePerSecond: Number(b["rate_per_second"]) || 0,
      ratePerMinute: Number(b["rate_per_minute"]) || 0,
      contextWindowK: Number(b["context_window_k"]) || 0,
      supportsImages: typeof b["supports_images"]==='boolean'?b["supports_images"]:undefined,
      thinkingType: typeof b["thinking_type"] === "string" ? b["thinking_type"] : "",
      reasoningEffort: typeof b["reasoning_effort"] === "string" ? b["reasoning_effort"] : "",
      priority: Number(b["priority"]) || 0,
      poolExclude: b["pool_exclude"] === true,
      streaming: b["streaming"] !== false,
      maxTokens: Number(b["max_tokens"]) || 0,
      maxTokensField: typeof b["max_tokens_field"] === "string" ? b["max_tokens_field"] : "",
      sessionHeaderKey: typeof b["session_header_key"] === "string" ? b["session_header_key"] : "",
      retry: {
        connect: (retry["connect"] ?? {}) as { attempts?: number; interval_ms?: number },
        empty: (retry["empty"] ?? {}) as { attempts?: number; interval_ms?: number },
        stream: (retry["stream"] ?? {}) as { attempts?: number; interval_ms?: number },
      },
    });
    return { id };
  });

  app.delete("/api/llm/profiles/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      await platform().deleteProfile(id);
      return { deleted: 1 };
    } catch (err) {
      if (err instanceof LLMProfileNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof ActiveLLMProfileDeleteError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  const activate = async (req: { body?: unknown }, reply: { code(c: number): { send(v: unknown): unknown } }): Promise<unknown> => {
    const id = Number((req.body as { id?: unknown })?.["id"]);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "bad profile id" });
    try {
      await platform().setActiveProfile(id);
    } catch (err) {
      if (err instanceof LLMProfileNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
    return { ok: true };
  };
  // 前端契约路径与 M5 规格别名各注册一个。
  app.post("/api/llm/profiles/active", async (req, reply) => activate(req, reply));
  app.post("/api/llm/active", async (req, reply) => activate(req, reply));

  // GET /api/llm — 激活 profile 摘要（引擎 modelResolver 的同一来源）。
  app.get("/api/llm", async () => {
    const p = await platform().activeProfile();
    if (!p) return { configured: false, provider: "", model: "", base_url: "", key_set: false };
    return {
      configured: true,
      provider: p.format,
      model: p.model,
      base_url: p.baseURL,
      proxy: p.proxy,
      key_set: p.apiKey !== "",
      rate_per_second: p.ratePerSecond,
      rate_per_minute: p.ratePerMinute,
      context_window_k: p.contextWindowK,
    supports_images:p.supportsImages===true,
      thinking_type: p.thinkingType,
      reasoning_effort: p.reasoningEffort,
    };
  });

  // ─── MCP ───────────────────────────────────────────────────────────────────

  app.get("/api/mcp", async () => {
    const servers = await platform().listMCP();
    return {
      servers: servers.map((m) => ({
        id: m.id,
        name: m.name,
        transport: m.transport,
        command: m.command,
        args: m.args,
        env: m.env,
        url: m.url,
        enabled: m.enabled,
        insecure: m.insecure,
      })),
    };
  });

  app.post("/api/mcp", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = await platform().saveMCP({
      id: b["id"] === undefined || b["id"] === null ? undefined : Number(b["id"]),
      name: String(b["name"] ?? ""),
      transport: String(b["transport"] ?? "stdio"),
      command: typeof b["command"] === "string" ? b["command"] : "",
      args: Array.isArray(b["args"]) ? b["args"] : [],
      env: (b["env"] ?? {}) as Record<string, unknown>,
      url: typeof b["url"] === "string" ? b["url"] : "",
      enabled: b["enabled"] === true,
      insecure: b["insecure"] === true,
    });
    return { id };
  });

  app.delete("/api/mcp/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    await platform().deleteMCP(id);
    return { deleted: 1 };
  });

  // ─── skills（文件系统：列表文件树 + SKILL.md 读写）────────────────────────

  app.get("/api/skills", async () => {
    const root = app.skillsRoot;
    const skills: Array<Record<string, unknown>> = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(root).filter((n) => {
        try {
          return statSync(path.join(root, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return { skills: [] };
    }
    for (const name of entries) {
      const dir = path.join(root, name);
      let description = "";
      try {
        description = skillDescription(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
      } catch {
        continue; // 无 SKILL.md 的目录不是 skill
      }
      const files = listFiles(dir, dir).map((f) => f.split(path.sep).join("/"));
      skills.push({ name, description, files });
    }
    return { skills };
  });

  // POST /api/skills/file — 读（无 content）或写（有 content）skill 内文本文件。
  app.post("/api/skills/file", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b["name"] === "string" ? b["name"] : "";
    const file = typeof b["file"] === "string" ? b["file"] : "";
    if (name === "" || file === "" || name.includes("..") || file.includes("..")) {
      return reply.code(400).send({ error: "name/file 不能为空且不允许路径穿越" });
    }
    const target = path.resolve(app.skillsRoot, name, file);
    if (!target.startsWith(path.resolve(app.skillsRoot) + path.sep)) {
      return reply.code(400).send({ error: "路径越界" });
    }
    if (b["content"] === undefined) {
      try {
        return { name, file, content: readFileSync(target, "utf8") };
      } catch {
        return reply.code(404).send({ error: "文件不存在" });
      }
    }
    if (typeof b["content"] !== "string") return reply.code(400).send({ error: "content 必须是字符串" });
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, b["content"]);
    return { ok: true, name, file };
  });
}

/** 递归列出 skill 目录内文件（相对 skill 根；跳过 node_modules/.git，深度<=5）。 */
function listFiles(dir: string, root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || out.length > 500) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, root, depth + 1, out);
    else if (e.isFile()) out.push(path.relative(root, p));
  }
  return out;
}

/** 从 SKILL.md 提取描述：优先 YAML frontmatter 的 description，回退首个非标题行。 */
function skillDescription(md: string): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1]!.match(/^description:\s*(.+)$/m);
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, "");
  }
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (t !== "" && !t.startsWith("#")) return t.slice(0, 200);
  }
  return "";
}
