import {migrateDirectionWriteback} from '../agent/direction-migration.js';
import {TOOL_POLICY_VERSION,ACTIVE_ROLES} from '../agent/tool-registry.js';
import {migrateConstraintProvenance} from './constraint-provenance.js';
import {migrateIsolatedGoalsPrompt} from '../agent/goals-migration.js';
import {migrateConstraintPrompts} from '../agent/constraint-migration.js';
import {migrateAssetTools} from './asset-migration.js';
import {migrateArtex} from './artex-migration.js';
import {migrateBuiltinPrompts,migrateApprovalPrompts,migrateSeriesPlannerPrompt} from '../agent/prompts.js';
// 平台配置 store：settings KV / agent 提示词 / 工具目录 / MCP / LLM profile / 内置种子。
// 平移自 Go 版 db/settings.go + db/config.go(settings·prompts·mcp·profiles 部分) + db/tools.go +
// task_llm_profiles 链已按决策删除：profile 只有 CRUD + 激活/故障转移链读取。

import type { Database } from "./index.js";
import { jsonbClean, utf8Clean } from "./exploration.js";


/** 并发 worker 数（未设置/非法时默认 3）。 */
export const SETTING_WORKERS = "workers";
export const DEFAULT_WORKERS = 3;

// ─── LLM profile 类型（db/config.go）─────────────────────────────────────────

export interface RetryRule {
  attempts: number; // 0=继承全局 / -1=关闭 / >0=该值
  interval_ms: number; // 0=默认指数退避 / >0=固定毫秒
}

export interface RetryOverride {
  connect: RetryRule;
  empty: RetryRule;
  stream: RetryRule;
}

export interface LLMProfile {
  supportsImages?: boolean;
  id: number;
  name: string;
  format: string;
  baseURL: string;
  proxy: string;
  model: string;
  apiKey: string; // 仅 activeProfile/profileByID/poolProfiles 填充；列表走 hint
  apiKeyHint: string;
  ratePerSecond: number;
  ratePerMinute: number;
  contextWindowK: number;
  thinkingType: string;
  reasoningEffort: string;
  isDefault: boolean;
  priority: number;
  poolExclude: boolean;
  streaming: boolean;
  maxTokens: number;
  maxTokensField: string;
  sessionHeaderKey: string;
  retry: RetryOverride;
}

/** SaveProfile 入参；缺省字段按零值语义写入。id 为 0/缺省 = 插入。 */
export interface LLMProfileInput {
  supportsImages?: boolean;
  id?: number;
  name: string;
  format: string;
  baseURL?: string;
  proxy?: string;
  model: string;
  /** 更新时留空 = 保留现有 key（Go 语义）。 */
  apiKey?: string;
  apiKeyHint?: string;
  ratePerSecond?: number;
  ratePerMinute?: number;
  contextWindowK?: number;
  thinkingType?: string;
  reasoningEffort?: string;
  priority?: number;
  poolExclude?: boolean;
  streaming?: boolean;
  maxTokens?: number;
  maxTokensField?: string;
  sessionHeaderKey?: string;
  retry?: Partial<{ connect: Partial<RetryRule>; empty: Partial<RetryRule>; stream: Partial<RetryRule> }>;
}

export class LLMProfileNotFoundError extends Error {
  constructor(id: number | string = "") {
    super(id === "" ? "LLM profile not found" : `LLM profile not found: ${id}`);
    this.name = "LLMProfileNotFoundError";
  }
}
export class ActiveLLMProfileDeleteError extends Error {
  constructor() {
    super("cannot delete the active LLM profile; activate another profile first");
    this.name = "ActiveLLMProfileDeleteError";
  }
}

const MAX_RETRY_ATTEMPTS = 20;
const MAX_RETRY_INTERVAL_MS = 3_600_000;

function clampRule(r: Partial<RetryRule> | undefined): RetryRule {
  let attempts = Math.trunc(r?.attempts ?? 0);
  if (attempts < -1) attempts = -1;
  if (attempts > MAX_RETRY_ATTEMPTS) attempts = MAX_RETRY_ATTEMPTS;
  let interval = Math.trunc(r?.interval_ms ?? 0);
  if (interval < 0) interval = 0;
  if (interval > MAX_RETRY_INTERVAL_MS) interval = MAX_RETRY_INTERVAL_MS;
  return { attempts, interval_ms: interval };
}

// ─── agent / prompt 类型（db/config.go）──────────────────────────────────────

export interface Agent {
  id: number;
  key: string;
  name: string;
  description: string;
  role: string;
  builtin: boolean;
  enabled: boolean;
  llmProfileID: number | null;
  maxTurns: number;
  runSeconds: number;
  webSearch: boolean;
  interactiveShell: boolean;
  wrapupPrompt: string;
  wrapupMaxTurns: number;
  taskTimeoutWrapupPrompt: string;
  taskTimeoutWrapupMaxTurns: number;
  triggerRunMode: string;
  triggerMergeMode: string;
  triggerMaxParallel: number;
}

export interface PromptVar {
  name: string;
  description: string;
  example: string;
  source: string;
}

export interface PromptVersion {
  version: number;
  template: string;
  note: string;
  createdAt: string;
}

// ─── 工具目录类型（db/tools.go）──────────────────────────────────────────────

export interface Tool {
  key: string;
  system: boolean;
  description: string;
  schema: Record<string, unknown>;
  agents: string[];
  enabled: boolean;
  kind: string; // builtin | shell | command | script | http
  exec: Record<string, unknown>;
  deferred: boolean;
  directory: string;
  usageHelp: string;
  whenToUse: string;
  executable: string;
}

/**
 * mergeToolMetadata 把 DB 保存的 schema 元数据合并进代码 schema（平移
 * agent/tool_contract.go 的核心）：只覆盖 description 与 default（结构由代码所有），
 * 递归下钻 properties/items。Go 版对 default 会做 schema 校验，DB 层平移直存，
 * 校验留在运行时装配处（M 后续接 actool 等价物）。
 */
export function mergeToolMetadata(
  code: Record<string, unknown> | null | undefined,
  saved: Record<string, unknown> | null | undefined,
): void {
  if (!code || !saved) return;
  if (typeof saved["description"] === "string") code["description"] = saved["description"];
  if ("default" in saved) code["default"] = saved["default"];
  const props = asRecord(code["properties"]);
  const oldProps = asRecord(saved["properties"]);
  if (props) {
    for (const key of Object.keys(props)) mergeToolMetadata(asRecord(props[key]), asRecord(oldProps?.[key]));
  }
  mergeToolMetadata(asRecord(code["items"]), asRecord(saved["items"]));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 运行时装配层的工具描述符（对应 Go actool.CoreTool 的 Description/InputSchema 面）。 */
export interface ToolDescriptor {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** resolveToolsForAgent 的输出：DB 覆盖生效后的模型可见面。 */
export interface ResolvedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  system: boolean;
}

// ─── MCP 类型（db/config.go）─────────────────────────────────────────────────

export interface MCPServer {
  id: number;
  name: string;
  transport: string;
  command: string;
  args: unknown; // JSONB（通常 string[]）
  env: unknown; // JSONB（通常 Record<string,string>）
  url: string;
  enabled: boolean;
  insecure: boolean;
}

// ─── 列清单 ──────────────────────────────────────────────────────────────────

const PROFILE_RETRY_COLS =
  `COALESCE(retry_connect_attempts,0) AS retry_connect_attempts,` +
  `COALESCE(retry_connect_interval_ms,0) AS retry_connect_interval_ms,` +
  `COALESCE(retry_empty_attempts,0) AS retry_empty_attempts,` +
  `COALESCE(retry_empty_interval_ms,0) AS retry_empty_interval_ms,` +
  `COALESCE(retry_stream_attempts,0) AS retry_stream_attempts,` +
  `COALESCE(retry_stream_interval_ms,0) AS retry_stream_interval_ms`;
const PROFILE_COLS = "supports_images," +
  `id,name,format,COALESCE(base_url,'') AS base_url,COALESCE(proxy,'') AS proxy,model,` +
  `COALESCE(api_key_hint,'') AS api_key_hint,` +
  `rate_per_second,rate_per_minute,context_window_k,COALESCE(reasoning_effort,'') AS reasoning_effort,is_default,` +
  `priority,pool_exclude,COALESCE(thinking_type,'') AS thinking_type,` +
  `COALESCE(streaming,true) AS streaming,COALESCE(max_tokens,0) AS max_tokens,` +
  `COALESCE(max_tokens_field,'') AS max_tokens_field,` +
  `COALESCE(session_header_key,'') AS session_header_key,` + PROFILE_RETRY_COLS;
const PROFILE_COLS_KEY = PROFILE_COLS.replace(
  "COALESCE(api_key_hint,'') AS api_key_hint",
  "COALESCE(api_key,'') AS api_key",
);

const AGENT_COLS =
  `id,key,name,COALESCE(description,'') AS description,role,builtin,enabled,COALESCE(max_turns,0) AS max_turns,` +
  `COALESCE(run_seconds,600) AS run_seconds,COALESCE(web_search,false) AS web_search,` +
  `COALESCE(interactive_shell,false) AS interactive_shell,` +
  `COALESCE(wrapup_prompt,'') AS wrapup_prompt,COALESCE(wrapup_max_turns,0) AS wrapup_max_turns,` +
  `COALESCE(task_timeout_wrapup_prompt,'') AS task_timeout_wrapup_prompt,` +
  `COALESCE(task_timeout_wrapup_max_turns,0) AS task_timeout_wrapup_max_turns,` +
  `COALESCE(trigger_run_mode,'serial') AS trigger_run_mode,` +
  `COALESCE(trigger_merge_mode,'all') AS trigger_merge_mode,` +
  `COALESCE(trigger_max_parallel,5) AS trigger_max_parallel,llm_profile_id`;

const TOOL_COLS =
  `key, system, description, schema, agents, enabled, kind, exec, deferred, directory, usage_help, when_to_use, executable`;

// ─── Store ───────────────────────────────────────────────────────────────────

export class PlatformStore {
  constructor(private db: Database) {}

  // ─── settings KV（db/settings.go）────────────────────────────────────────

  /** 读取 setting；未设置返回 null（Go: value, ok）。 */
  async getSetting(key: string): Promise<string | null> {
    const res = await this.db.query<{ value: string }>(`SELECT value FROM settings WHERE key=$1`, [key]);
    return res.rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO settings(key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }

  /** 只在 key 尚未存在时写入（auth.password_hash 等只许首设的键）。 */
  async insertSettingIfAbsent(key: string, value: string): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getBool(key: string, def = false): Promise<boolean> {
    const v = await this.getSetting(key);
    if (v === null) return def;
    return v === "true" || v === "1";
  }

  async setBool(key: string, val: boolean): Promise<void> {
    await this.setSetting(key, val ? "true" : "false");
  }

  async getInt(key: string, def: number): Promise<number> {
    const v = await this.getSetting(key);
    if (v === null) return def;
    const n = Number(v.trim());
    return Number.isFinite(n) ? Math.trunc(n) : def;
  }

  async getChoice(key: string, def: string, allowed: string[]): Promise<string> {
    const v = await this.getSetting(key);
    if (v === null) return def;
    const t = v.trim();
    return allowed.includes(t) ? t : def;
  }

  // ─── 常用键的类型化访问器 ────────────────────────────────────────────────

  /** 并发 worker 数（默认 3；非法/非正数回退默认）。 */
  async workers(): Promise<number> {
    const v = await this.getSetting(SETTING_WORKERS);
    if (v === null) return DEFAULT_WORKERS;
    const n = Number(v.trim());
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WORKERS;
    return Math.trunc(n);
  }

  /** 设置并发 worker 数；<=0 拒绝（Go manager.SetWorkers 语义）。 */
  async setWorkers(n: number): Promise<void> {
    if (n <= 0) throw new Error("workers 必须 >0");
    await this.setSetting(SETTING_WORKERS, String(Math.trunc(n)));
  }

  // ─── agents / 提示词（db/config.go Agents·prompts 段）─────────────────────

  private mapAgent(row: Record<string, unknown>): Agent {
    return {
      id: Number(row["id"]),
      key: String(row["key"]),
      name: String(row["name"]),
      description: String(row["description"] ?? ""),
      role: String(row["role"]),
      builtin: row["builtin"] === true,
      enabled: row["enabled"] === true,
      llmProfileID: row["llm_profile_id"] === null || row["llm_profile_id"] === undefined
        ? null
        : Number(row["llm_profile_id"]),
      maxTurns: Number(row["max_turns"] ?? 0),
      runSeconds: Number(row["run_seconds"] ?? 600),
      webSearch: row["web_search"] === true,
      interactiveShell: row["interactive_shell"] === true,
      wrapupPrompt: String(row["wrapup_prompt"] ?? ""),
      wrapupMaxTurns: Number(row["wrapup_max_turns"] ?? 0),
      taskTimeoutWrapupPrompt: String(row["task_timeout_wrapup_prompt"] ?? ""),
      taskTimeoutWrapupMaxTurns: Number(row["task_timeout_wrapup_max_turns"] ?? 0),
      triggerRunMode: String(row["trigger_run_mode"] ?? "serial"),
      triggerMergeMode: String(row["trigger_merge_mode"] ?? "all"),
      triggerMaxParallel: Number(row["trigger_max_parallel"] ?? 5),
    };
  }

  async listAgents(): Promise<Agent[]> {
    const res = await this.db.query<Record<string, unknown>>(`SELECT ${AGENT_COLS} FROM agents WHERE key<>'retester' ORDER BY id`);
    return res.rows.map((r) => this.mapAgent(r));
  }

  async getAgentByKey(key: string): Promise<Agent | null> {
    const res = await this.db.query<Record<string, unknown>>(`SELECT ${AGENT_COLS} FROM agents WHERE key=$1`, [key]);
    return res.rows[0] ? this.mapAgent(res.rows[0]) : null;
  }

  /** agent 当前生效的提示词模板（无版本返回 ""）。 */
  async currentPrompt(agentID: number): Promise<string> {
    const res = await this.db.query<{ template_text: string }>(
      `SELECT p.template_text FROM agents a JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.id=$1`,
      [agentID],
    );
    return res.rows[0]?.template_text ?? "";
  }

  /**
   * PromptOverride 钩子的 DB 侧（Go: agent.PromptOverride 按 agent key）：
   * 返回存储的模板；agent 不存在或无版本返回 null（调用方回退代码内置默认）。
   */
  async promptOverride(agentKey: string): Promise<string | null> {
    const a = await this.getAgentByKey(agentKey);
    if (!a) return null;
    const t = await this.currentPrompt(a.id);
    return t === "" ? null : t;
  }

  async promptVars(agentID: number): Promise<PromptVar[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT var_name,COALESCE(description,'') AS description,COALESCE(example,'') AS example,source
       FROM agent_prompt_vars WHERE agent_id=$1 ORDER BY var_name`,
      [agentID],
    );
    return res.rows.map((r) => ({
      name: String(r["var_name"]),
      description: String(r["description"] ?? ""),
      example: String(r["example"] ?? ""),
      source: String(r["source"]),
    }));
  }

  /** 追加新版本并把 current_prompt_id 指过去；返回新版本号。 */
  async savePrompt(agentID: number, template: string, note: string, by: string): Promise<number> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const verRes = await client.query<{ ver: string }>(
        `SELECT COALESCE(max(version),0)+1 AS ver FROM agent_prompts WHERE agent_id=$1`,
        [agentID],
      );
      const ver = Number(verRes.rows[0]!.ver);
      const ins = await client.query<{ id: string }>(
        `INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
         VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,'')) RETURNING id`,
        [agentID, ver, utf8Clean(template), note, by],
      );
      await client.query(`UPDATE agents SET current_prompt_id=$1 WHERE id=$2`, [ins.rows[0]!.id, agentID]);
      await client.query("COMMIT");
      return ver;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 仅当 agent 从未有过任何版本时写入代码默认模板（用户编辑永不被覆盖）。 */
  async seedPromptIfEmpty(agentID: number, tmpl: string): Promise<void> {
    const res = await this.db.query<{ current_prompt_id: string | null }>(
      `SELECT current_prompt_id FROM agents WHERE id=$1`,
      [agentID],
    );
    if (res.rows[0]?.current_prompt_id != null) return; // 已 seed 或用户已编辑
    await this.savePrompt(agentID, tmpl, "内置默认", "system");
  }

  /** 显式「恢复为内置默认」：追加新版本并切过去。 */
  async resetPromptToDefault(agentID: number, tmpl: string): Promise<number> {
    return this.savePrompt(agentID, tmpl, "恢复为内置默认", "system");
  }

  async listPromptVersions(agentID: number): Promise<PromptVersion[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT version,template_text,COALESCE(note,'') AS note,created_at
       FROM agent_prompts WHERE agent_id=$1 ORDER BY version DESC`,
      [agentID],
    );
    return res.rows.map((r) => ({
      version: Number(r["version"]),
      template: String(r["template_text"]),
      note: String(r["note"] ?? ""),
      createdAt: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
    }));
  }

  // ─── 工具目录（db/tools.go）──────────────────────────────────────────────

  private mapTool(row: Record<string, unknown>): Tool {
    const agents = row["agents"];
    return {
      key: String(row["key"]),
      system: row["system"] === true,
      description: String(row["description"] ?? ""),
      schema: (row["schema"] as Record<string, unknown>) ?? {},
      agents: Array.isArray(agents) ? agents.map(String) : [],
      enabled: row["enabled"] === true,
      kind: String(row["kind"] ?? "builtin"),
      exec: (row["exec"] as Record<string, unknown>) ?? {},
      deferred: row["deferred"] === true,
      directory: String(row["directory"] ?? ""),
      usageHelp: String(row["usage_help"] ?? ""),
      whenToUse: String(row["when_to_use"] ?? ""),
      executable: String(row["executable"] ?? ""),
    };
  }

  async listTools(): Promise<Tool[]> {
    const res = await this.db.query<Record<string, unknown>>(`SELECT ${TOOL_COLS} FROM tools ORDER BY key`);
    return res.rows.map((r) => this.mapTool(r));
  }

  async getTool(key: string): Promise<Tool | null> {
    const res = await this.db.query<Record<string, unknown>>(`SELECT ${TOOL_COLS} FROM tools WHERE key=$1`, [key]);
    return res.rows[0] ? this.mapTool(res.rows[0]) : null;
  }

  /** 首插入 only：已有行（可能被 UI 改过）永不覆盖。 */
  async seedTool(key: string, desc: string, schema: Record<string, unknown>, agents: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO tools(key, system, description, schema, agents, enabled)
       VALUES ($1, true, $2, $3::jsonb, $4::jsonb, true)
       ON CONFLICT (key) DO NOTHING`,
      [key, utf8Clean(desc), jsonbClean(JSON.stringify(schema ?? {})), jsonbClean(JSON.stringify(agents ?? []))],
    );
  }

  /** 页面可编辑字段保存（key 不可改）。 */
  async updateTool(
    key: string,
    desc: string,
    schema: Record<string, unknown>,
    agents: string[],
    enabled: boolean,
  ): Promise<void> {
    await this.db.query(
      `UPDATE tools SET description=$2, schema=$3::jsonb, agents=$4::jsonb, enabled=$5 WHERE key=$1`,
      [key, utf8Clean(desc), jsonbClean(JSON.stringify(schema ?? {})), jsonbClean(JSON.stringify(agents ?? [])), enabled],
    );
  }

  /**
   * ToolResolve 核心（server/assembly.go + agent/toolcatalog.go 的 DB 侧）：
   * 按 DB tools 行对已装配工具做「按 agent 过滤 + 描述覆盖 + schema 元数据合并」。
   * 无 DB 行的工具（MCP/skill/host 工具）原样放行；禁用或未绑定该 agent 的丢弃。
   * system 工具结构由代码所有（schema 以代码版为底、合并保存的 description/default）；
   * 自定义工具以 DB 行为准。Go 版里按工具名保留代码契约描述/结构白名单与参数默认值
   * 注入属运行时装配层（actool），此处平移 DB 层核心。
   */
  async resolveToolsForAgent(agentKey: string, tools: ToolDescriptor[]): Promise<ResolvedTool[]> {
    const rows = await this.listTools();
    const byKey = new Map(rows.map((t) => [t.key, t]));
    const out: ResolvedTool[] = [];
    for (const t of tools) {
      const row = byKey.get(t.name);
      if (!row) {
        out.push({ name: t.name, description: t.description, schema: t.schema, system: false });
        continue;
      }
      if (!row.enabled || !row.agents.includes(agentKey)) continue; // 全局禁用或未绑定 → 丢弃
      const desc = row.description !== "" ? row.description : t.description;
      let schema: Record<string, unknown>;
      if (row.system) {
        schema = structuredClone(t.schema);
        mergeToolMetadata(schema, row.schema);
      } else {
        schema = row.schema;
      }
      out.push({ name: t.name, description: desc, schema, system: row.system });
    }
    return out;
  }

  // ─── MCP（db/config.go MCP 段）───────────────────────────────────────────

  private mapMCP(row: Record<string, unknown>): MCPServer {
    return {
      id: Number(row["id"]),
      name: String(row["name"]),
      transport: String(row["transport"]),
      command: String(row["command"] ?? ""),
      args: row["args"] ?? [],
      env: row["env"] ?? {},
      url: String(row["url"] ?? ""),
      enabled: row["enabled"] === true,
      insecure: row["insecure"] === true,
    };
  }

  async listMCP(): Promise<MCPServer[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT id,name,transport,COALESCE(command,'') AS command,args,env,
              COALESCE(url,'') AS url,enabled,insecure
       FROM mcp_servers ORDER BY id`,
    );
    return res.rows.map((r) => this.mapMCP(r));
  }

  /** 插入（id=0/缺省）或更新；返回行 id。 */
  async saveMCP(m: Omit<MCPServer, "id"> & { id?: number }): Promise<number> {
    const args = m.args === undefined || m.args === null ? "[]" : JSON.stringify(m.args);
    const env = m.env === undefined || m.env === null ? "{}" : JSON.stringify(m.env);
    if (!m.id || m.id === 0) {
      const res = await this.db.query<{ id: string }>(
        `INSERT INTO mcp_servers(name,transport,command,args,env,url,enabled,insecure)
         VALUES ($1,$2,NULLIF($3,''),$4::jsonb,$5::jsonb,NULLIF($6,''),$7,$8) RETURNING id`,
        [m.name, m.transport, m.command, jsonbClean(args), jsonbClean(env), m.url, m.enabled, m.insecure],
      );
      return Number(res.rows[0]!.id);
    }
    await this.db.query(
      `UPDATE mcp_servers SET name=$1,transport=$2,command=NULLIF($3,''),args=$4::jsonb,env=$5::jsonb,
       url=NULLIF($6,''),enabled=$7,insecure=$8 WHERE id=$9`,
      [m.name, m.transport, m.command, jsonbClean(args), jsonbClean(env), m.url, m.enabled, m.insecure, m.id],
    );
    return m.id;
  }

  async deleteMCP(id: number): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM agent_visibility WHERE resource_kind='mcp' AND resource_id=$1`, [id]);
      await client.query(`DELETE FROM mcp_servers WHERE id=$1`, [id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** server 已发现的工具名缓存（发现前为空）。 */
  async mcpToolNames(serverID: number): Promise<string[]> {
    const res = await this.db.query<{ tool_name: string }>(
      `SELECT tool_name FROM mcp_tools_cache WHERE server_id=$1 ORDER BY tool_name`,
      [serverID],
    );
    return res.rows.map((r) => r.tool_name);
  }

  // ─── LLM profiles（db/config.go profiles 段；task_llm_profiles 链已删）────

  private mapProfile(row: Record<string, unknown>): LLMProfile {
    return {
      id: Number(row["id"]),
      name: String(row["name"]),
      format: String(row["format"]),
      baseURL: String(row["base_url"] ?? ""),
      proxy: String(row["proxy"] ?? ""),
      model: String(row["model"]),
      apiKey: String(row["api_key"] ?? ""), // 列表查询时该位实为 hint
      apiKeyHint: String(row["api_key_hint"] ?? ""),
      ratePerSecond: Number(row["rate_per_second"] ?? 0),
      ratePerMinute: Number(row["rate_per_minute"] ?? 0),
      contextWindowK: Number(row["context_window_k"] ?? 0),
      supportsImages: row["supports_images"]===true,
      reasoningEffort: String(row["reasoning_effort"] ?? ""),
      isDefault: row["is_default"] === true,
      priority: Number(row["priority"] ?? 0),
      poolExclude: row["pool_exclude"] === true,
      thinkingType: String(row["thinking_type"] ?? ""),
      streaming: row["streaming"] !== false,
      maxTokens: Number(row["max_tokens"] ?? 0),
      maxTokensField: String(row["max_tokens_field"] ?? ""),
      sessionHeaderKey: String(row["session_header_key"] ?? ""),
      retry: {
        connect: { attempts: Number(row["retry_connect_attempts"] ?? 0), interval_ms: Number(row["retry_connect_interval_ms"] ?? 0) },
        empty: { attempts: Number(row["retry_empty_attempts"] ?? 0), interval_ms: Number(row["retry_empty_interval_ms"] ?? 0) },
        stream: { attempts: Number(row["retry_stream_attempts"] ?? 0), interval_ms: Number(row["retry_stream_interval_ms"] ?? 0) },
      },
    };
  }

  /** 列表（hint 版，不带 api key）。 */
  async listProfiles(): Promise<LLMProfile[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS} FROM llm_profiles ORDER BY id`,
    );
    return res.rows.map((r) => {
      const p = this.mapProfile(r);
      p.apiKey = ""; // 列表面不泄漏 key
      p.apiKeyHint = String(r["api_key_hint"] ?? "");
      return p;
    });
  }

  /** 激活（默认）profile，带 api key；无激活返回 null。 */
  async activeProfile(): Promise<LLMProfile | null> {
    // is_default 优先；无标记时兜底取最新可用 profile（防测试/误操作清标记后引擎全停）。
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS_KEY} FROM llm_profiles WHERE is_default LIMIT 1`,
    );
    if (res.rows[0]) return this.mapProfile(res.rows[0]);
    const fallback = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS_KEY} FROM llm_profiles WHERE COALESCE(api_key,'')<>'' AND COALESCE(model,'')<>'' ORDER BY id DESC LIMIT 1`,
    );
    return fallback.rows[0] ? this.mapProfile(fallback.rows[0]) : null;
  }

  async profileByID(id: number): Promise<LLMProfile | null> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS_KEY} FROM llm_profiles WHERE id=$1`,
      [id],
    );
    return res.rows[0] ? this.mapProfile(res.rows[0]) : null;
  }

  /** 故障转移链（运行顺序即策略）：激活 profile 领头，其余有 key 且未排除的按 priority DESC。 */
  async poolProfiles(): Promise<LLMProfile[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLS_KEY} FROM llm_profiles
       WHERE COALESCE(api_key,'') <> '' AND (is_default OR NOT pool_exclude)
       ORDER BY is_default DESC, priority DESC, id ASC`,
    );
    return res.rows.map((r) => this.mapProfile(r));
  }

  /** 插入（无 id）或更新。更新时 apiKey 留空=保留现有 key。 */
  async saveProfile(p: LLMProfileInput): Promise<number> {
    const id=await this.saveProfileBase(p);
    if(p.supportsImages!==undefined)await this.db.query("UPDATE llm_profiles SET supports_images=$2 WHERE id=$1",[id,p.supportsImages]);
    return id;
  }
  private async saveProfileBase(p: LLMProfileInput): Promise<number> {
    const sessionHeaderKey = (p.sessionHeaderKey ?? "").trim();
    let hint = p.apiKeyHint ?? "";
    if ((p.apiKey ?? "").length >= 4) hint = "…" + p.apiKey!.slice(-4);
    const connect = clampRule(p.retry?.connect);
    const empty = clampRule(p.retry?.empty);
    const stream = clampRule(p.retry?.stream);
    const retryVals = [
      connect.attempts, connect.interval_ms, empty.attempts, empty.interval_ms,
      stream.attempts, stream.interval_ms,
    ];
    if (!p.id || p.id === 0) {
      const res = await this.db.query<{ id: string }>(
        `INSERT INTO llm_profiles(name,format,base_url,proxy,model,api_key,api_key_hint,rate_per_second,
           rate_per_minute,context_window_k,reasoning_effort,priority,pool_exclude,thinking_type,streaming,
           max_tokens,max_tokens_field,session_header_key,retry_connect_attempts,retry_connect_interval_ms,
           retry_empty_attempts,retry_empty_interval_ms,retry_stream_attempts,retry_stream_interval_ms)
         VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,NULLIF($6,''),NULLIF($7,''),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING id`,
        [
          p.name, p.format, p.baseURL ?? "", p.proxy ?? "", p.model, p.apiKey ?? "", hint,
          p.ratePerSecond ?? 0, p.ratePerMinute ?? 0, p.contextWindowK ?? 0, p.reasoningEffort ?? "",
          p.priority ?? 0, p.poolExclude ?? false, p.thinkingType ?? "", p.streaming ?? true,
          p.maxTokens ?? 0, p.maxTokensField ?? "", sessionHeaderKey, ...retryVals,
        ],
      );
      return Number(res.rows[0]!.id);
    }
    if ((p.apiKey ?? "") === "") {
      await this.db.query(
        `UPDATE llm_profiles SET name=$1,format=$2,base_url=NULLIF($3,''),proxy=NULLIF($4,''),model=$5,
           rate_per_second=$6,rate_per_minute=$7,context_window_k=$8,reasoning_effort=$9,priority=$10,
           pool_exclude=$11,thinking_type=$12,streaming=$13,max_tokens=$14,max_tokens_field=$15,
           session_header_key=$16,retry_connect_attempts=$17,retry_connect_interval_ms=$18,
           retry_empty_attempts=$19,retry_empty_interval_ms=$20,retry_stream_attempts=$21,retry_stream_interval_ms=$22
         WHERE id=$23`,
        [
          p.name, p.format, p.baseURL ?? "", p.proxy ?? "", p.model,
          p.ratePerSecond ?? 0, p.ratePerMinute ?? 0, p.contextWindowK ?? 0, p.reasoningEffort ?? "",
          p.priority ?? 0, p.poolExclude ?? false, p.thinkingType ?? "", p.streaming ?? true,
          p.maxTokens ?? 0, p.maxTokensField ?? "", sessionHeaderKey, ...retryVals, p.id,
        ],
      );
      return p.id;
    }
    await this.db.query(
      `UPDATE llm_profiles SET name=$1,format=$2,base_url=NULLIF($3,''),proxy=NULLIF($4,''),model=$5,
         api_key=$6,api_key_hint=$7,rate_per_second=$8,rate_per_minute=$9,context_window_k=$10,
         reasoning_effort=$11,priority=$12,pool_exclude=$13,thinking_type=$14,streaming=$15,max_tokens=$16,
         max_tokens_field=$17,session_header_key=$18,retry_connect_attempts=$19,retry_connect_interval_ms=$20,
         retry_empty_attempts=$21,retry_empty_interval_ms=$22,retry_stream_attempts=$23,retry_stream_interval_ms=$24
       WHERE id=$25`,
      [
        p.name, p.format, p.baseURL ?? "", p.proxy ?? "", p.model, p.apiKey, hint,
        p.ratePerSecond ?? 0, p.ratePerMinute ?? 0, p.contextWindowK ?? 0, p.reasoningEffort ?? "",
        p.priority ?? 0, p.poolExclude ?? false, p.thinkingType ?? "", p.streaming ?? true,
        p.maxTokens ?? 0, p.maxTokensField ?? "", sessionHeaderKey, ...retryVals, p.id,
      ],
    );
    return p.id;
  }

  /** 设为全局默认（单默认不变式；事务内两步）。 */
  async setActiveProfile(id: number): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE llm_profiles SET is_default=false WHERE is_default`);
      const res = await client.query(`UPDATE llm_profiles SET is_default=true WHERE id=$1`, [id]);
      if ((res.rowCount ?? 0) !== 1) throw new LLMProfileNotFoundError(id);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 删除非激活 profile；激活中的拒绝（先激活别的）。task_llm_profiles 链已删，无链保存逻辑。 */
  async deleteProfile(id: number): Promise<void> {
    const cur = await this.db.query<{ is_default: boolean }>(`SELECT is_default FROM llm_profiles WHERE id=$1`, [id]);
    if (cur.rows.length === 0) throw new LLMProfileNotFoundError(id);
    if (cur.rows[0]!.is_default) throw new ActiveLLMProfileDeleteError();
    await this.db.query(`DELETE FROM llm_profiles WHERE id=$1`, [id]);
  }
}

// ─── 内置种子（db/db.go seedBuiltins 及其子种子）─────────────────────────────

/** 内置 agent + 提示词变量目录（docs §5(a)）。 */
interface BuiltinAgent {
  key: string;
  name: string;
  role: string;
  desc: string;
  vars: PromptVar[];
  /** 建行时的默认交互式 shell 开关；ON CONFLICT 不覆盖用户后续手动开关。 */
  interactiveShell: boolean;
  /** 建行时的单次 run 墙钟上限(秒)；null=用种子默认(1200)，0=不限时。 */
  runSeconds: number | null;
}

const BUILTIN_AGENTS: BuiltinAgent[] = [
  {
    key: "goals", name: "目标拆解", role: "goals",
    desc: "先提取原文约束与资产，再用独立会话仅拆解目标栏。",
    vars: [
      // Now 是全局 runtime 变量(server.globalPromptVars)，不再在各 agent 目录里重复定义。
      { name: "Goal", description: "目标栏原文（唯一目标来源）", example: "资产测试覆盖度100%", source: "exploration" },
      { name: "EngagementDescription", description: "描述背景（仅阶段一可见；目标阶段置空）", example: "测试 example.com 站点", source: "exploration" },
    ],
    interactiveShell: false, runSeconds: null,
  },
  {
    key: "planner", name: "规划", role: "planner",
    desc: "读取态势、判定目标，只在确有未覆盖的新方向时补充探索意图（每任务一个规划循环）。",
    vars: [
      { name: "Goal", description: "任务总目标", example: "拿下 example.com 的管理员权限", source: "exploration" },
      { name: "AssetSummary", description: "资产计数/类型分布摘要(可选)", example: "domain:3 ip:5 site:2", source: "distilled" },
    ],
    interactiveShell: false, runSeconds: null,
  },
  {
    key: "mainagent", name: "主", role: "main",
    desc: "人机接口：观察进展，把人的意图落成 hint 或高优先级意图。",
    vars: [
      { name: "Goal", description: "当前任务目标", example: "拿下 example.com 的管理员权限", source: "exploration" },
      { name: "AssetSummary", description: "开局态势摘要(可选)", example: "domain:3 ip:5", source: "distilled" },
      { name: "FindingsSummary", description: "已确认漏洞摘要(可选)", example: "high:1 medium:2", source: "distilled" },
    ],
    interactiveShell: false, runSeconds: null,
  },
  {
    key: "worker", name: "执行", role: "worker",
    desc: "领取一条意图执行，把发现的事实/漏洞写回知识图谱后停止。",
    vars: [
      { name: "ProxyAddr", description: "记录代理地址(驱动 if 双文案)", example: "127.0.0.1:8080", source: "runtime" },
      { name: "WorkerName", description: "worker 自我标识(可选)", example: "worker-1", source: "runtime" },
    ],
    interactiveShell: false, runSeconds: null,
  },
  // Auto:内置「平台操作」agent。不参与渗透编排循环,经对话页驱动,用工具操作平台。
  {
    key: "auto", name: "Auto", role: "assistant",
    desc: "平台操作助手：用工具管理任务(建/看/暂停/给提示)与资产，并可创建/修改 skill、自定义工具、MCP。",
    vars: [], interactiveShell: false, runSeconds: null,
  },
  // 渗透测试:内置「独立渗透」agent。经对话页驱动,一人从侦察到收尾走完整条渗透链,自己规划自己执行自己验证。默认开启交互式 shell。
  {
    key: "pentest", name: "渗透测试", role: "assistant",
    desc: "独立渗透 agent：一人从侦察→找攻击面→深入利用→验证→收尾走完整条链，自己规划、自己执行、自己对抗式验证。",
    vars: [], interactiveShell: true, runSeconds: 0,
  },
];

const BUILTIN_SKILL_VISIBILITY: Record<string,string[]> = {"api-recon":["auto","pentest","worker"]};

export async function seedBuiltinTools(db: Database): Promise<void> {
  const P = ["planner"], W = ["worker"], M = ["mainagent"], G = ["goals"];
  const SHARED = ["planner", "worker", "mainagent"];
  const ALL = ["planner", "worker", "mainagent", "goals"];
  const seeds: Array<[string, string, string[]]> = [
    ["bash", "执行 shell 命令（出口网关记录任务流量）", ALL],
    ["read", "读取文件", [...ALL,"auto","reporter","pentest"]],
    ["write", "写入文件", ["worker"]],
    ["edit", "编辑文件（字符串替换）", ["worker"]],
    ["graph_overview", "读取探索态势总览（目标/frontier/在跑/近期事实/覆盖度）", SHARED],
    ["node_detail", "钻取节点详情与血缘", SHARED],
    ["search_worker_traces", "检索其他 work 的执行过程观察", SHARED],
    ["get_worker_trace", "读取指定 work 的执行轨迹与结论", SHARED],
    ["record_fact", "写回探索事实（含负面结论，带证据与置信度）", W],
    ["insert_assets", "登记发现的资产（域名/IP/服务/端点/应用）", W],
    ["report_finding", "报告确认的漏洞（须可复现）", W],
    ["list_findings", "查询已报漏洞", ["worker", "planner", "mainagent"]],
    ["list_assets", "查询资产库", SHARED],
    ["list_untested_assets", "列出范围内未测资产", ["planner", "mainagent"]],
    ["add_intent", "派发探索意图（先查重）", ["planner", "mainagent"]],
    ["prove_goal", "证明目标达成并收官", P],
    ["kill_work", "终止在跑意图", ["planner", "mainagent"]],
    ["steer_work", "运行中纠偏（不打断）", ["planner", "mainagent"]],
    ["add_task_scope", "扩展任务测试范围", P],
    ["todo_write", "更新攻击链待办（跨轮共享）", P],
    ["dispatch_intents", "下发待执行意图", M],
    ["set_goals", "设定/替换任务目标", ["mainagent", "goals"]],
    ["set_constraints", "登记操作约束（allow/deny）", ["mainagent", "goals"]],
    ["register_user_target", "登记用户明确授权的目标", G],
  ];
  for (const [key, desc, agents] of seeds) {
    await db.query(
      `INSERT INTO tools(key, system, description, schema, agents, enabled, kind) VALUES ($1, true, $2, '{}'::jsonb, $3::jsonb, true, 'builtin') ON CONFLICT (key) DO NOTHING`,
      [key, desc, JSON.stringify(agents)],
    );
  }
}

export async function seedBuiltins(db: Database): Promise<void> {
  // New roles are insert-only: operator prompts, budgets and bindings survive upgrades.
  await db.query(`INSERT INTO agents(key,name,role,builtin,enabled,trigger_run_mode,trigger_merge_mode,trigger_max_parallel)
    VALUES ('reporter','Reporter','assistant',false,true,'parallel','none',5) ON CONFLICT(key) DO NOTHING`);
  await seedBuiltinTools(db);
  await db.query(`INSERT INTO settings(key,value) SELECT 'tool_catalog_before_'||$1,jsonb_agg(to_jsonb(t) ORDER BY key)::text FROM tools t WHERE kind='builtin' ON CONFLICT(key) DO NOTHING`,[TOOL_POLICY_VERSION]);
  await db.query(`INSERT INTO tools(key,system,kind,description,schema,agents,enabled) VALUES('tool_search',true,'builtin','按需发现已绑定工具；使用英文工具名或关键词','{}',$1::jsonb,true) ON CONFLICT(key) DO NOTHING`,[JSON.stringify(ACTIVE_ROLES)]);
  await db.transaction(async tx=>{
    // Retire the active catalog entries, preserving customized historical metadata.
    const retired=['checkpoint_intent','complete_intent'];
    await tx.query(`INSERT INTO settings(key,value)
      SELECT 'pi_worker_removed_tools_previous',jsonb_agg(to_jsonb(t) ORDER BY key)::text
      FROM tools t WHERE system AND kind='builtin' AND key=ANY($1::text[]) HAVING count(*)>0
      ON CONFLICT(key) DO NOTHING`,[retired]);
    await tx.query("DELETE FROM tools WHERE system AND kind='builtin' AND key=ANY($1::text[])",[retired]);
  });
  const store = new PlatformStore(db);
  const extensionTools:Array<[string,string,string[]]>=[
   ...['shell_open','shell_send','shell_read','shell_close','shell_list'].map(key=>[key,'当前 PI 执行会话的交互终端',['worker','planner','mainagent']] as [string,string,string[]]),
   ['context_search','检索授权探索节点、执行结果与冷图原文',['worker','planner','mainagent','pentest','auto','goals','reporter']],
   ['context_get','按稳定引用分页读取节点详情与血缘',['worker','planner','mainagent','pentest','auto','goals','reporter']],
   ['read_tool_output','续读完整工具 JSON 原文',['goals','planner','mainagent','worker','auto','pentest','reporter']],
   ['http_request','执行授权 HTTP 请求并保存证据',['worker','pentest']],
   ['traffic_body','分页读取流量证据',['worker','pentest','reporter']],
   ['read_attachment','分页读取当前会话附件',['worker','mainagent','auto','pentest','reporter']],
   ['get_finding','读取漏洞和证据版本',['reporter','auto','pentest']],
   ['update_finding_report','以证据版本更新报告',['reporter','auto']],
   ['list_tasks','列出平台任务',['auto']],['get_task','查询任务状态',['auto']],
   ['record_conversation_fact','绑定任务的 Pentest 写回有来源的事实',['pentest']],['report_conversation_finding','绑定任务的 Pentest 原子提交有证据的漏洞',['pentest']],['resume_task','恢复任务并查询准入结果',['auto']],
   ['spawn_task','创建任务',['auto']],['pause_task','暂停任务',['auto']],['add_task_hint','给任务追加提示',['auto']],
  ];
  for(const [key,description,agents] of extensionTools)await db.query(`INSERT INTO tools(key,system,description,schema,agents,enabled,kind) VALUES($1,true,$2,'{}',$3::jsonb,true,'builtin') ON CONFLICT(key) DO NOTHING`,[key,description,JSON.stringify(agents)]);
  if(await store.getSetting('pi_extra_role_bindings_v1')!=='true'){
    const legacyShared=['planner','worker','mainagent'],legacyAll=[...legacyShared,'goals'];
    const bindings:Array<[string[],string[],string[]]>=[
      [['bash'],legacyAll,['pentest']],
      [['read'],legacyAll,['pentest','auto','reporter']],
      [['write','edit'],['worker'],['pentest']],
      [['graph_overview','node_detail'],legacyShared,['pentest']],
      [['list_assets'],legacyShared,['pentest','auto']],
      [['list_findings'],['worker','planner','mainagent'],['pentest','reporter','auto']],
    ];
    // Only recognize untouched legacy defaults; never broaden a custom binding.
    for(const [keys,before,added] of bindings)await db.query('UPDATE tools SET agents=agents||$3::jsonb WHERE key=ANY($1::text[]) AND agents=$2::jsonb AND enabled',[keys,JSON.stringify(before),JSON.stringify(added)]);
    await store.setSetting('pi_extra_role_bindings_v1','true');
  }
  if(await store.getSetting('pi_reporter_trigger_v1')!=='true'){
    await db.query(`INSERT INTO agent_triggers(agent_key,on_finding,finding_message) SELECT 'reporter',true,'根据本次漏洞及其证据完善报告，先读取证据版本再提交。' WHERE NOT EXISTS(SELECT 1 FROM agent_triggers WHERE agent_key='reporter')`);
    await store.setSetting('pi_reporter_trigger_v1','true');
  }


  // 1. 内置 agent（ON CONFLICT 只刷 name/description，interactive_shell/run_seconds 不覆盖用户改动）
  for (const a of BUILTIN_AGENTS) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO agents(key, name, description, role, builtin, enabled, interactive_shell, run_seconds)
       VALUES ($1, $2, NULLIF($3,''), $4, true, true, $5, COALESCE($6, 1200))
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [a.key, a.name, a.desc, a.role, a.interactiveShell, a.runSeconds],
    );
    const agentID = Number(res.rows[0]!.id);
    for (const v of a.vars) {
      await db.query(
        `INSERT INTO agent_prompt_vars(agent_id, var_name, description, example, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent_id, var_name) DO UPDATE
           SET description = EXCLUDED.description, example = EXCLUDED.example, source = EXCLUDED.source`,
        [agentID, v.name, v.description, v.example, v.source],
      );
    }
  }

  // 2. 清掉已更名变量的目录残留（EngagementTitle→Description；Now 升为全局 runtime 变量）
  await db.query(`DELETE FROM agent_prompt_vars WHERE var_name IN ('EngagementTitle', 'CoverageGaps', 'Now')`);

  // 3. 运行时 agent(planner/worker/mainagent/auto) 的交互式 shell 默认开——只做一次，
  //    之后尊重用户 toggle-off（settings 旗标门控）。goals(一次性拆解器)保持关。
  if ((await store.getSetting("interactive_shell_default_v1")) !== "true") {
    await db.query(`UPDATE agents SET interactive_shell=true WHERE key IN ('planner','worker','mainagent','auto')`);
    await store.setSetting("interactive_shell_default_v1", "true");
  }

  // 4. 历史 Playwright 行名 "browser" → "playwright"：仅当规范名空闲时原地改名（保留
  //    id/缓存/可见性/用户配置）；两名并存则都不动。
  await db.query(
    `UPDATE mcp_servers SET name='playwright'
     WHERE name='browser' AND NOT EXISTS (SELECT 1 FROM mcp_servers WHERE name='playwright')`,
  );

  await migrateBuiltinPrompts(db);
  await migrateConstraintProvenance(db);
  await migrateConstraintPrompts(db);
  await migrateIsolatedGoalsPrompt(db);
  await migrateArtex(db);
  await migrateApprovalPrompts(db);
  await migrateAssetTools(db);
  await migrateSeriesPlannerPrompt(db);
  await migrateDirectionWriteback(db);

  // 5. 内置 MCP 只是配置预设：disabled 且不授予任何 agent。ON CONFLICT 保证重启不覆盖用户改动。
  await db.query(
    `INSERT INTO mcp_servers(name, transport, command, args, env, enabled)
     VALUES
       ('playwright', 'stdio', 'npx', '["@playwright/mcp","--headless"]', '{}', false),
       ('web_search', 'stdio', 'npx', '["-y","@zhafron/mcp-web-search"]', '{}', false),
       ('chrome-devtools', 'stdio', 'npx', '["-y","chrome-devtools-mcp","--slim","--headless"]', '{}', false)
     ON CONFLICT (name) DO NOTHING`,
  );
  // 注：ScopeSentry 占位 MCP（空 URL、disabled）由 schema.sql §F 直接播种，psql 裸初始化也有。

  // 6. 内置 skill 可见性（插缺不覆盖：用户关掉的不会被重启复活）
  for (const [skillName, agentKeys] of Object.entries(BUILTIN_SKILL_VISIBILITY)) {
    for (const key of agentKeys) {
      await db.query(
        `INSERT INTO agent_skill_visibility(agent_id, skill_name, enabled)
         SELECT id, $2, true FROM agents WHERE key=$1
         ON CONFLICT (agent_id, skill_name) DO NOTHING`,
        [key, skillName],
      );
    }
  }

}
