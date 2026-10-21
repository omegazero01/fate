import {previewRoleTools} from '../../agent/tool-catalog.js';
import {assertActiveRole} from '../../agent/retired-roles.js';
import {platformPolicy} from '../../pi/platform-policy.js';
import {builtinPrompt,renderPrompt,hostProtocol,PROMPT_VERSION,resolveRolePrompt} from '../../agent/prompts.js';
import {textSize} from '../../agent/prompt-diagnostics.js';
// 批次 C3：agent 运行配置 / 收尾词 / 任务级超时收尾词 / 提示词恢复与预览 / P3 触发器。
// 对齐前端 web/src/lib/api.ts 的 saveAgentConfig/saveAgentWrapup/resetAgentWrapup/
// saveAgentTaskTimeoutWrapup/resetAgentTaskTimeoutWrapup/resetAgentPrompt/agentTriggers/
// createTrigger/updateTrigger/deleteTrigger/previewAgentPrompt 方法族。
// 注意前端真实路径：任务级超时收尾词是 /agents/:key/wrapup/task-timeout（+ /reset），
// 不是任务描述里的 /:key/task-timeout-wrapup。
// 内置默认提示词/收尾词 import 自 src/agent/prompts.ts（只读）。

import type { FastifyInstance } from "fastify";
import { GOALS_PROMPT, MAIN_PROMPT, PLANNER_PROMPT, WORKER_PROMPT } from "../../agent/prompts.js";
import {
  MAIN_WRAPUP,
  PLANNER_TASK_TIMEOUT_WRAPUP,
  PLANNER_WRAPUP,
  WORKER_TASK_TIMEOUT_WRAPUP,
  WORKER_WRAPUP,
} from "../../agent/prompts.js";

/** agent key → 内置默认收尾词（空串=该角色不支持收尾）。 */
function builtinWrapup(key: string): string {
  if (key === "planner") return PLANNER_WRAPUP;
  if (key === "worker") return WORKER_WRAPUP;
  if (key === "mainagent") return MAIN_WRAPUP;
  return "";
}

/** agent key → 内置默认任务级超时收尾词（空串=不支持；仅 worker/planner）。 */
function builtinTaskTimeoutWrapup(key: string): string {
  if (key === "planner") return PLANNER_TASK_TIMEOUT_WRAPUP;
  if (key === "worker") return WORKER_TASK_TIMEOUT_WRAPUP;
  return "";
}

/** 内置默认收尾轮数（展示用提示「0=默认N」；0=引擎侧内置）。 */
const DEFAULT_WRAPUP_MAX_TURNS = 3;

/** 触发器行 → 前端 AgentTrigger 形状（tool_names TEXT 逗号串 ↔ string[]）。 */
function mapTrigger(row: Record<string, unknown>): Record<string, unknown> {
  const toolNames = String(row["tool_names"] ?? "");
  return {
    id: Number(row["id"]),
    agent_key: String(row["agent_key"]),
    enabled: row["enabled"] === true,
    interval_sec: Number(row["interval_sec"] ?? 0),
    on_finding: row["on_finding"] === true,
    on_goal_met: row["on_goal_met"] === true,
    on_task_timeout: row["on_task_timeout"] === true,
    on_tool_call: row["on_tool_call"] === true,
    on_task_create: row["on_task_create"] === true,
    interval_message: String(row["interval_message"] ?? ""),
    finding_message: String(row["finding_message"] ?? ""),
    goal_message: String(row["goal_message"] ?? ""),
    task_timeout_message: String(row["task_timeout_message"] ?? ""),
    tool_call_message: String(row["tool_call_message"] ?? ""),
    task_create_message: String(row["task_create_message"] ?? ""),
    tool_names: toolNames === "" ? [] : toolNames.split(",").map((s) => s.trim()).filter((s) => s !== ""),
    ...(row["last_fire"] ? { last_fire: row["last_fire"] instanceof Date ? (row["last_fire"] as Date).toISOString() : String(row["last_fire"]) } : {}),
  };
}

/** 触发器写列白名单（PATCH/POST 共用）。 */
function triggerSets(b: Record<string, unknown>): { cols: string[]; params: unknown[] } | { error: string } {
  const cols: string[] = [];
  const params: unknown[] = [];
  const bools = ["enabled", "on_finding", "on_goal_met", "on_task_timeout", "on_tool_call", "on_task_create"] as const;
  for (const col of bools) {
    if (typeof b[col] === "boolean") {
      params.push(b[col]);
      cols.push(`${col}=$${params.length}`);
    }
  }
  for (const col of ["interval_sec"] as const) {
    if (b[col] !== undefined && Number.isFinite(Number(b[col])) && Number(b[col]) >= 0) {
      params.push(Math.trunc(Number(b[col])));
      cols.push(`${col}=$${params.length}`);
    }
  }
  for (const col of ["interval_message", "finding_message", "goal_message", "task_timeout_message", "tool_call_message", "task_create_message"] as const) {
    if (typeof b[col] === "string") {
      params.push(b[col]);
      cols.push(`${col}=$${params.length}`);
    }
  }
  if (Array.isArray(b["tool_names"])) {
    params.push(b["tool_names"].map(String).filter((s) => s.trim() !== "").join(","));
    cols.push(`tool_names=$${params.length}`);
  }
  return { cols, params };
}

export function registerAgentConfigRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  async function agentOr404(reply: { code(c: number): { send(v: unknown): unknown } }, key: string) {
    const agent = await db().platform().getAgentByKey(key);
    if (!agent) {
      await reply.code(404).send({ error: `agent ${key} 不存在` });
      return null;
    }
    return agent;
  }

  // ─── 运行配置列（max_turns/run_seconds/llm_profile_id/web_search/enabled 等）───

  app.put("/api/agents/:key/config", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];

    if (b["llm_profile_id"] !== undefined) {
      const v = b["llm_profile_id"];
      if (v === null || v === 0) {
        params.push(null);
        sets.push(`llm_profile_id=$${params.length}`);
      } else {
        const id = Number(v);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "llm_profile_id 非法" });
        const exists = await db().query(`SELECT 1 FROM llm_profiles WHERE id=$1`, [id]);
        if (exists.rows.length === 0) return reply.code(400).send({ error: `llm profile ${id} 不存在` });
        params.push(id);
        sets.push(`llm_profile_id=$${params.length}`);
      }
    }
    for (const col of ["max_turns", "run_seconds", "trigger_max_parallel"] as const) {
      if (b[col] !== undefined) {
        const n = Number(b[col]);
        if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: `${col} 必须为非负整数` });
        params.push(n);
        sets.push(`${col}=$${params.length}`);
      }
    }
    for (const col of ["web_search", "interactive_shell", "enabled"] as const) {
      if (typeof b[col] === "boolean") {
        params.push(b[col]);
        sets.push(`${col}=$${params.length}`);
      }
    }
    if (b["trigger_run_mode"] !== undefined) {
      const v = String(b["trigger_run_mode"]);
      if (v !== "serial" && v !== "parallel") return reply.code(400).send({ error: "trigger_run_mode 仅 serial|parallel" });
      params.push(v);
      sets.push(`trigger_run_mode=$${params.length}`);
    }
    if (b["trigger_merge_mode"] !== undefined) {
      const v = String(b["trigger_merge_mode"]);
      if (v !== "by_task" && v !== "all" && v !== "none") return reply.code(400).send({ error: "trigger_merge_mode 仅 by_task|all|none" });
      params.push(v);
      sets.push(`trigger_merge_mode=$${params.length}`);
    }
    if (sets.length === 0) return reply.code(400).send({ error: "无可更新字段" });
    params.push(agent.id);
    await db().query(`UPDATE agents SET ${sets.join(", ")} WHERE id=$${params.length}`, params);
    return { ok: true };
  });

  // ─── 收尾词 + 任务级超时收尾词 ─────────────────────────────────────────────

  app.put("/api/agents/:key/wrapup", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b["prompt"] !== "string") return reply.code(400).send({ error: "prompt 必须是字符串（空串=清除覆盖）" });
    const sets = [`wrapup_prompt=$1`];
    const params: unknown[] = [b["prompt"]];
    if (b["max_turns"] !== undefined) {
      const n = Number(b["max_turns"]);
      if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: "max_turns 必须为非负整数（0=内置默认）" });
      params.push(n);
      sets.push(`wrapup_max_turns=$${params.length}`);
    }
    params.push(agent.id);
    await db().query(`UPDATE agents SET ${sets.join(", ")} WHERE id=$${params.length}`, params);
    return { ok: true };
  });

  app.post("/api/agents/:key/wrapup/reset", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    await db().query(`UPDATE agents SET wrapup_prompt='', wrapup_max_turns=0 WHERE id=$1`, [agent.id]);
    return { ok: true, wrapup_default: builtinWrapup(key), wrapup_max_turns_default: DEFAULT_WRAPUP_MAX_TURNS };
  });

  app.put("/api/agents/:key/wrapup/task-timeout", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b["prompt"] !== "string") return reply.code(400).send({ error: "prompt 必须是字符串（空串=清除覆盖）" });
    const sets = [`task_timeout_wrapup_prompt=$1`];
    const params: unknown[] = [b["prompt"]];
    if (b["max_turns"] !== undefined) {
      const n = Number(b["max_turns"]);
      if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: "max_turns 必须为非负整数（0=内置默认）" });
      params.push(n);
      sets.push(`task_timeout_wrapup_max_turns=$${params.length}`);
    }
    params.push(agent.id);
    await db().query(`UPDATE agents SET ${sets.join(", ")} WHERE id=$${params.length}`, params);
    return { ok: true };
  });

  app.post("/api/agents/:key/wrapup/task-timeout/reset", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    await db().query(`UPDATE agents SET task_timeout_wrapup_prompt='', task_timeout_wrapup_max_turns=0 WHERE id=$1`, [agent.id]);
    return {
      ok: true,
      task_timeout_wrapup_default: builtinTaskTimeoutWrapup(key),
      task_timeout_wrapup_max_turns_default: DEFAULT_WRAPUP_MAX_TURNS,
    };
  });

  // ─── 提示词：恢复内置默认 / 变量渲染预览 ───────────────────────────────────

  app.post("/api/agents/:key/prompt/reset", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    const tmpl = builtinPrompt(key);
    if (tmpl === null) return reply.code(400).send({ error: `agent ${key} 无内置默认提示词` });
    const version = await db().platform().resetPromptToDefault(agent.id, tmpl);
    return { version };
  });

  app.post("/api/agents/:key/prompt/preview", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b["template"] !== "string" || b["template"] === "") {
      return reply.code(400).send({ error: "template 不能为空" });
    }
    // 变量取值优先级：sample 覆盖 > 变量目录 example > Now（runtime）。
    const vars = await db().platform().promptVars(agent.id);
    const sample = (b["sample"] ?? {}) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const v of vars) values[v.name] = v.example;
    values["Now"] = new Date().toISOString();
    for (const [k, v] of Object.entries(sample)) {
      if (typeof v === "string") values[k] = v;
    }
    // 两种占位形态都替换：{{.Var}}（Go template 风格，与 prompts.ts 一致）与 {{Var}}。
    const rendered = renderPrompt(b["template"], values);
    const resolved = await resolveRolePrompt(db(), key);
    const candidate = builtinPrompt(key);
    return { rendered, platform_policy:await platformPolicy(db(),key), candidate: candidate === null ? null : renderPrompt(candidate, values),
      configured_source: resolved.source, builtin_version: PROMPT_VERSION, host_protocol: hostProtocol(key),
      diagnostics: { role_body: {...textSize(rendered),source:'preview_template'},
        host_protocol: {...textSize(hostProtocol(key)),source:'host'},
        task_context:{status:'not_assembled_in_template_preview'},
        tool_schemas:await previewRoleTools(db(),key),skill_index:{status:'available_in_runtime_diagnostics'},
        mcp_schemas:{status:'not_loaded',reason:'预览不会启动 MCP；未知 Schema 不计入估算'} } };

  });

  // ─── P3 触发器（agent_triggers 表）─────────────────────────────────────────

  app.get("/api/agents/:key/triggers", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    const res = await db().query(`SELECT * FROM agent_triggers WHERE agent_key=$1 ORDER BY id`, [key]);
    void agent;
    return { triggers: res.rows.map(mapTrigger) };
  });

  app.post("/api/agents/:key/triggers", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const agent = await agentOr404(reply, key);
    if (!agent) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = triggerSets(b);
    if ("error" in r) return reply.code(400).send({ error: r.error });
    if (r.cols.length === 0) return reply.code(400).send({ error: "无可写入字段" });
    const res = await db().query(
      `INSERT INTO agent_triggers(agent_key, ${r.cols.map((c) => c.split("=")[0]).join(", ")})
       VALUES ($1, ${r.params.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING *`,
      [key, ...r.params],
    );
    return reply.code(201).send(mapTrigger(res.rows[0]!));
  });

  app.patch("/api/triggers/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const trigger=(await db().query('SELECT agent_key FROM agent_triggers WHERE id=$1',[id])).rows[0];
    if(trigger)assertActiveRole(String(trigger.agent_key));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = triggerSets(b);
    if ("error" in r) return reply.code(400).send({ error: r.error });
    if (r.cols.length === 0) return reply.code(400).send({ error: "无可更新字段" });
    r.params.push(id);
    const res = await db().query(`UPDATE agent_triggers SET ${r.cols.join(", ")} WHERE id=$${r.params.length} RETURNING *`, r.params);
    if (res.rows.length === 0) return reply.code(404).send({ error: "触发器不存在" });
    return { ok: true };
  });

  app.delete("/api/triggers/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const res = await db().query(`DELETE FROM agent_triggers WHERE id=$1 RETURNING id`, [id]);
    if (res.rows.length === 0) return reply.code(404).send({ error: "触发器不存在" });
    return { deleted: Number(res.rows[0]!["id"]) };
  });
}
