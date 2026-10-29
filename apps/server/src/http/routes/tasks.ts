import {aggregateUsage} from '../../db/usage-ledger.js';
import {requireTaskGoal} from "../../agent/task-goal.js";
import {assetContextCTE} from '../../db/asset-query.js';
import {registerOperationRoutes} from './operations.js';
import {executionSnapshot,executionSnapshots} from '../../engine/coordinator.js';
import {prepareAttachments} from "../../evidence/attachments.js";
// 任务路由：CRUD + 生命周期（start/pause/resume/stop|finish|control/delete）+ 意图控制 + 主对话。
// 生命周期约定（对齐 Go manager/engine 分层）：tasks 表状态先落库，再驱动 engine；
// engine 侧未运行（无运行时）时引擎调用静默跳过，DB 状态仍是唯一真源。

import type { FastifyInstance } from "fastify";
import type { Task } from "../../db/tasks.js";
import { isTerminalTaskStatus,TASK_DISPLAY_STATUS } from "../../db/tasks.js";
import { IntentStateConflictError } from "../../db/exploration.js";

/** 列表/详情 DTO：在 store Task 之上补前端仪表盘需要的聚合位（goals/counts 在详情填充）。 */
function taskDTO(t: Task): Record<string, unknown> {
  const out: Record<string, unknown> = { ...t, id: String(t.id) };
  if (t.created_at) out["created_unix"] = Math.floor(new Date(t.created_at).getTime() / 1000);
  if (t.completed_at) out["completed_unix"] = Math.floor(new Date(t.completed_at).getTime() / 1000);
  const related = (t as unknown as { source_task_ids?: unknown }).source_task_ids;
  if (Array.isArray(related)) out["source_task_ids"] = related.map(String);
  return out;
}

/** 引擎调用包装：任务未在引擎中运行（mustRt 抛错）→ no-op。 */
async function engineNoop(p: unknown): Promise<void> {
  await Promise.resolve(p).catch(() => undefined);
}

export function registerTaskRoutes(app: FastifyInstance): void {
  registerOperationRoutes(app);
  const tasks = () => app.db.tasks();
  const serializeTask = async (task: Task, batch?:{pending:Set<number>;snapshot:Awaited<ReturnType<typeof executionSnapshots>>}) => {
    const dto = taskDTO(task);
    if (!isTerminalTaskStatus(task.status)) {
      const pending = task.paused && (batch?batch.pending.has(task.id):!!(await app.db.query("SELECT 1 FROM runtime_task_commands WHERE task_id=$1 AND command='pause' AND status='pending' LIMIT 1", [task.id])).rowCount);
      dto.status = task.paused ? (pending ? task.status : 'paused') : task.queued ? 'queued' : task.status;
      dto.execution_status = pending ? 'waiting_for_executor' : dto.status;
      dto.pause_pending = pending;
    }
    dto.scheduling=batch?batch.snapshot(task.id):await executionSnapshot(app.db,task.id);
    dto.in_flight=(dto.scheduling as {task_active:number}).task_active;
    const occupancy=dto.scheduling as {task_active:number;ready:number;planning:number};
    dto.engine_mode=task.paused?'paused':occupancy.task_active+occupancy.ready+occupancy.planning>0?'exploring':'idle';
    return dto;
  };

  // ─── 列表与创建 ────────────────────────────────────────────────────────────

  app.get("/api/tasks", async (req,reply) => {
    const q=req.query as Record<string,string|undefined>;
    if(['page','page_size'].some(k=>q[k]!==undefined&&(!Number.isSafeInteger(Number(q[k]))||Number(q[k])<1))||
      (q.category!==undefined&&!['all','uncategorized'].includes(q.category)&&(!Number.isSafeInteger(Number(q.category))||Number(q.category)<1)))
      return reply.code(400).send({error:'无效的分页或分类参数'});
    const paged=Object.keys(q).some(k=>['page','page_size','q','status','category','sort','direction','recent'].includes(k));
    const result=paged?await tasks().listTasksPage({page:Math.max(1,Number(q.page)||1),pageSize:Math.min(100,Math.max(1,Number(q.page_size)||20)),q:q.q,status:q.status,category:q.category,sort:q.sort,direction:q.direction,recent:q.recent==='true'}):{tasks:await tasks().listTasks()};
    const list=result.tasks,ids=list.map(t=>t.id);
    const snapshot=await executionSnapshots(app.db);
    const pending=new Set((await app.db.query("SELECT task_id FROM runtime_task_commands WHERE task_id=ANY($1::bigint[]) AND command='pause' AND status='pending'",[ids])).rows.map(r=>Number(r.task_id)));
    const active = (await app.db.platform().getSetting("active_task")) ?? "";
    // 派生位聚合：findings 四档 / goals 进度 / 在跑 / 最近活动 / 任务级 token。
    const agg = await app.db.query(
      `SELECT t.id,
              COALESCE((SELECT json_build_object('critical',count(*) FILTER (WHERE f.severity='critical'),'high',count(*) FILTER (WHERE f.severity='high'),'medium',count(*) FILTER (WHERE f.severity='medium'),'low',count(*) FILTER (WHERE f.severity='low'))
                 FROM findings f WHERE f.task_id=t.id),'{"critical":0,"high":0,"medium":0,"low":0}'::json) findings,
              COALESCE((SELECT json_build_object('total',count(*),'met',count(*) FILTER (WHERE state='met'))
                 FROM exploration_nodes n WHERE n.exploration_id=t.exploration_id AND n.kind='goal'),'{"total":0,"met":0}'::json) goals,
              COALESCE((SELECT count(*) FROM engine_worker_slots s JOIN engine_task_leases l ON l.task_id=s.task_id AND l.token=s.token WHERE s.task_id=t.id AND s.phase='running' AND l.expires_at>now()),0) in_flight,
              EXTRACT(EPOCH FROM COALESCE((SELECT max(a.created_at) FROM activity a WHERE a.exploration_id=t.exploration_id), t.created_at))::bigint last_activity_unix
       FROM tasks t WHERE t.id=ANY($1::bigint[])`,[ids]) as never;
    const tokenRows=new Map((await aggregateUsage(app.db,{taskIDs:ids},'task')).map(r=>[Number(r.bucket),r]));
    const aggRows = new Map<number, Record<string, unknown>>();
    for (const r of (agg as unknown as { rows: Array<Record<string, unknown>> }).rows) aggRows.set(Number(r["id"]), r);
    const items=[];
    for(const t of list){
        const dto = await serializeTask(t,{snapshot,pending});
        const a = aggRows.get(Number(t.id));
        if (a) {
          dto["findings"] = a["findings"];
          dto["goals_total"] = ((a["goals"] as { total?: number }) ?? {}).total ?? 0;
          dto["goals_met"] = ((a["goals"] as { met?: number }) ?? {}).met ?? 0;
          dto["in_flight"] = Number(a["in_flight"] ?? 0);
          dto["last_activity_unix"] = Number(a["last_activity_unix"] ?? 0);
          dto["tokens"] = tokenRows.get(t.id)??{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,usage_complete:true,version:'usage-v2'};
        }
        items.push(dto);
    }
    return {...result,tasks:items,active};
  });

  app.get('/api/tasks/summary',async()=>{
    const rows=(await app.db.query(`SELECT ${TASK_DISPLAY_STATUS} status,count(*) n FROM tasks WHERE deleted_at IS NULL GROUP BY 1`)).rows;
    const by_status=Object.fromEntries(rows.map(r=>[String(r.status),Number(r.n)]));
    return {total:rows.reduce((n,r)=>n+Number(r.n),0),by_status};
  });

  app.post("/api/tasks", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const description = typeof b["description"] === "string" && b["description"].trim() !== "" ? b["description"] : "未命名任务";
    let goal: string;
    try { goal = requireTaskGoal(b["goal"]); } catch (error) { return reply.code(400).send({error:(error as Error).message,code:"TASK_GOAL_REQUIRED"}); }
    const sourceTaskIDs = Array.isArray(b["source_task_ids"])
      ? b["source_task_ids"].map((v) => Number(v)).filter((n) => Number.isInteger(n))
      : [];
    const llmProfileIDs = Array.isArray(b["llm_profile_ids"])
      ? b["llm_profile_ids"].map((v) => Number(v)).filter((n) => Number.isInteger(n))
      : [];
    const task = await tasks().createTaskWithOptions(description, goal, {
      initializeGoals:true,
      name: typeof b["name"] === "string" ? b["name"].trim() : "",
      categoryID: b["category_id"] === null || b["category_id"] === undefined ? null : Number(b["category_id"]) || null,
      sourceTaskIDs,
      assetIDs: Array.isArray(b.asset_ids) ? b.asset_ids.map(Number) : undefined,
      companyIDs: Array.isArray(b.company_ids) ? b.company_ids.map(Number) : undefined,
      seedFirstIntent: b.seed_first_intent === true,
      executionMode: b.execution_mode === 'manual' ? 'manual' : 'managed',
      llmProfileIDs,
      timeoutSeconds: Math.max(0, Number(b["timeout_seconds"]) || 0),
      planHeartbeatSeconds: Math.max(0, Number(b["plan_heartbeat_seconds"]) || 0),
      coverageEnabled: b["coverage_enabled"] === undefined ? true : b["coverage_enabled"] !== false,
    });
    // 状态先落库（running），再后台跑 goals 分解 + 引擎循环；分解失败由引擎以活动事件记录。
    await app.engine.admitTask(task.id, { decompose: { description } });
    return reply.code(201).send(await serializeTask((await tasks().getTask(task.id))!));
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const task = await tasks().getTask(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const s = app.db.exploration(task.exploration_id);
    const [goals, counts, coverage, modelChain] = await Promise.all([
      s.listByKind("goal", 500).catch(() => []),
      s.executionCounts().catch(() => ({ running: 0, goals: 0, met: 0 })),
      app.db.taskScope().taskCoverage(id, task.exploration_id).catch(() => null),
      app.db.query('SELECT profile_id FROM task_llm_profiles WHERE task_id=$1 ORDER BY position', [id]),
    ]);
    return {
      ...await serializeTask(task),
      llm_profile_ids: modelChain.rows.map((row) => Number(row.profile_id)),
      goals: goals.map((g) => ({ id: g.id, text: g.payload["text"] ?? "", vulnclass: g.payload["vulnclass"] ?? "", state: g.state })),
      counts,goals_total:counts.goals,goals_met:counts.met,
      coverage: coverage ?? { enabled: false, scope_rows: 0, denominator: 0, tested: 0, pct: null, by_type: [] },
    };
  });

  // PATCH /api/tasks/:id — 名称/置顶等元数据。
  app.patch("/api/tasks/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const task = await tasks().getTask(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b["name"] === "string") {
      await app.db.query(`UPDATE tasks SET name=$2 WHERE id=$1`, [id, b["name"]]);
    }
    if (typeof b["pinned"] === "boolean") {
      await app.db.query(`UPDATE tasks SET pinned_at=$2 WHERE id=$1`, [id, b["pinned"] ? new Date() : null]);
    }
    return serializeTask((await tasks().getTask(id))!);
  });

  // ─── 生命周期 ──────────────────────────────────────────────────────────────

  async function startTask(id: number): Promise<Record<string, unknown>> {
    const task = await tasks().getTask(id);
    if (!task) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    await app.engine.admitTask(id);
    const after=await tasks().getTask(id);
    return { id, status: after?.paused ? "paused" : after?.queued ? "queued" : after?.status, paused:after?.paused===true, queued: after?.queued === true };
  }

  async function pauseTask(id: number): Promise<Record<string, unknown>> {
    try {
      await app.db.control().tasks().applyTaskPause(id); // 原子：paused=true + 出队；不可暂停（终态/已暂停）→ 409
    } catch (err) {
      throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { statusCode: 409 });
    }
    const result=await app.engine.pause(id);
    return { id, paused: result.status==='paused', status: result.status, command_id: result.command_id };
  }

  async function resumeTask(id: number): Promise<Record<string, unknown>> {
    await app.engine.admitTask(id);
    const after=await tasks().getTask(id);
    return { id, paused: after?.paused===true, queued: after?.queued === true, status: after?.paused ? "paused" : after?.queued ? "queued" : after?.status };
  }

  async function stopTask(id: number): Promise<Record<string, unknown>> {
    const task = await tasks().getTask(id);
    if (!task) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    await engineNoop(app.engine.stop(id)); // abort 在跑 + 等循环退出（无运行时则 no-op）
    // 手动收官：全部目标已证明 → done，否则 failed（对齐 Go finish 的终态语义简化）。
    const counts = await app.db.exploration(task.exploration_id).executionCounts().catch(() => ({ running: 0, goals: 0, met: 0 }));
    const status = counts.goals > 0 && counts.met >= counts.goals ? "done" : "failed";
    await tasks().setTaskStatusGuarded(id, status);
    return { id, status };
  }

  app.post("/api/tasks/:id/start", async (req) => startTask(Number((req.params as { id: string }).id)));
  app.post("/api/tasks/:id/pause", async (req) => pauseTask(Number((req.params as { id: string }).id)));
  app.post("/api/tasks/:id/resume", async (req) => resumeTask(Number((req.params as { id: string }).id)));
  app.post("/api/tasks/:id/stop", async (req) => stopTask(Number((req.params as { id: string }).id)));

  // POST /api/tasks/:id/control — 前端现有契约（action=pause|resume|finish）。
  app.post("/api/tasks/:id/control", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const action = (req.body as { action?: unknown })?.["action"];
    if (action !== "pause" && action !== "resume" && action !== "finish") {
      return reply.code(400).send({ error: "action must be pause|resume|finish" });
    }
    let lifecycle:Record<string,unknown>|undefined;
    if (action === "pause") lifecycle=await pauseTask(id);
    else if (action === "resume") lifecycle=await resumeTask(id);
    else await stopTask(id);
    const t = await tasks().getTask(id);
    return { id, paused: t?.paused === true, queued: t?.queued === true,
      status: lifecycle?.status ?? (t?.queued ? "queued" : t?.status ?? "created"),
      ...(lifecycle?.command_id === undefined ? {} : { command_id:lifecycle.command_id }) };
  });

  app.delete("/api/tasks/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    await engineNoop(app.engine.stop(id));
    await app.db.query(`UPDATE tasks SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL`, [id]);
    return { ok: true, id };
  });

  // POST /api/active — 当前打开的任务 id（前端任务页切换用）。
  app.post("/api/active", async (req, reply) => {
    const id = Number((req.body as { id?: unknown })?.["id"]);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "bad task id" });
    const task = await tasks().getTask(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    await app.db.platform().setSetting("active_task", String(id));
    return { active: String(id) };
  });

  // ─── 意图控制 ──────────────────────────────────────────────────────────────

  async function taskExploration(taskID: number): Promise<number> {
    const task = await tasks().getTask(taskID);
    if (!task) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    return task.exploration_id;
  }

  for (const action of ['pause','resume','cancel'] as const) {
    app.post(`/api/tasks/:id/intents/:intentID/${action}`, async req => {
      const p = req.params as {id:string;intentID:string};
      return app.engine.controlIntent(Number(p.id),Number(p.intentID),action,String((req.body as {reason?:string})?.reason ?? ''));
    });
  }

  // Historical messages remain readable; Worker control is button-only.
  app.post("/api/tasks/:id/intents/:intentID/messages", async (_req, reply) =>
    reply.code(410).send({ error: "Worker 不支持直接对话，请使用暂停或恢复按钮" }));

  app.get("/api/tasks/:id/worker-queue", async (req) => {
    const taskID = Number((req.params as { id: string }).id);
    const expID = await taskExploration(taskID);
    const q = await app.db.exploration(expID).workerQueue();
    return {
      scheduling:await executionSnapshot(app.db,taskID),
      items: q.items.map((n) => ({ ...n, id: String(n.id),execution_phase:q.executionMode==='manual'?(n.payload.dispatch_requested?'ready':'pending_dispatch'):n.payload.dispatch_requested?'ready':'awaiting_planner' })),
      version: q.version,
      manual: q.manual,
      execution_mode: q.executionMode,
    };
  });

  app.post("/api/tasks/:id/worker-queue/move", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const expID = await taskExploration(taskID);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = Number(b["id"]);
    const before = b["before_id"] === null || b["before_id"] === undefined ? null : Number(b["before_id"]);
    const version = Number(b["version"]) || 0;
    try {
      const q = await app.db.exploration(expID).moveWorker(id, before, version);
      return { items: q.items, version: q.version, manual: q.manual, execution_mode: q.executionMode };
    } catch (err) {
      if (err instanceof IntentStateConflictError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // Main chat never starts the task scheduler implicitly.
  const chat = async (taskID: number, body: Record<string, unknown>) => {
    const segment = body["seg"] === undefined ? 0 : Number(body["seg"]);
    if (!Number.isSafeInteger(segment) || segment < 0) throw Object.assign(new Error("无效会话分段"), { statusCode: 400 });
    const expID = await taskExploration(taskID);
    if (segment > 0) {
      const exists = await app.db.query(`SELECT 1 FROM main_sessions WHERE exploration_id=$1 AND seq=$2`, [expID, segment]);
      if (!exists.rowCount) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    }
    const message = typeof body["message"] === "string" ? body["message"] : "";
    if (!message.trim() && !(Array.isArray(body["attachments"]) && body["attachments"].length)) throw Object.assign(new Error("message 不能为空"), { statusCode: 400 });
    const attached=await prepareAttachments(app.db,app.dataDir,taskID,body["attachments"]);
    const requestID=body["request_id"];
    if(requestID!==undefined&&(typeof requestID!=="string"||!/^[-a-zA-Z0-9:]{1,120}$/.test(requestID)))throw Object.assign(new Error("request_id 无效"),{statusCode:400});
    return { reply: await app.engine.mainChat(taskID,[message,attached.text].filter(Boolean).join('\n\n'),segment,attached,requestID as string|undefined), mode: "main" };
  };
  app.post("/api/tasks/:id/chat", async (req) => chat(Number((req.params as { id: string }).id), (req.body ?? {}) as Record<string, unknown>));
  app.post("/api/chat", async (req) => {
    const taskID = Number((req.query as Record<string, unknown>)["task"]);
    if (!Number.isSafeInteger(taskID) || taskID <= 0) throw Object.assign(new Error("缺少或无效的 task 查询参数"), { statusCode: 400 });
    return chat(taskID, (req.body ?? {}) as Record<string, unknown>);
  });
  app.post("/api/tasks/:id/chat/stop", async (req) => {
    const taskID = Number((req.params as { id: string }).id);
    await taskExploration(taskID);
    await app.engine.stopMainChat(taskID);
    const pending=!!(await app.db.query("SELECT 1 FROM runtime_session_leases WHERE key LIKE $1 AND expires_at>now()",[`main:${taskID}:%`])).rowCount;
    return { ok: true, status: pending?'waiting_for_executor':'stopped' };
  });
  app.get("/api/tasks/:id/chat/status", async (req) => {
    const taskID = Number((req.params as { id: string }).id);
    await taskExploration(taskID);
    return { running: app.engine.mainChatRunning(taskID)||!!(await app.db.query("SELECT 1 FROM runtime_session_leases WHERE key LIKE $1 AND expires_at>now()",[`main:${taskID}:%`])).rowCount };
  });

  // GET /api/chat/mentions?task=&kind=&q=&cursor= — @ 提及候选（对齐 api.chatMentions）。
  // 最小面：本任务 open/running 意图 + 探索图锚定资产；offset 分页（与 Go 版同构）。
  app.get("/api/chat/mentions", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const taskID = Number(q["task"]);
    if (!Number.isInteger(taskID) || taskID <= 0) return reply.code(400).send({ error: "缺少或无效的 task 查询参数" });
    const expID = await taskExploration(taskID);
    const kind = typeof q["kind"] === "string" ? q["kind"] : "";
    const needle = typeof q["q"] === "string" ? q["q"].trim().toLowerCase() : "";
    const offset = Math.max(0, Number(q["cursor"]) || 0);
    const PAGE = 20;
    const candidates: Array<{ kind: string; id: number; label: string; description: string }> = [];
    const intents = await app.db.query(
      `SELECT id, state, COALESCE(NULLIF(payload->>'summary',''), NULLIF(payload->>'text',''), '') AS summary
       FROM exploration_nodes
       WHERE exploration_id=$1 AND kind='intent' AND state IN ('open','running')
       ORDER BY id DESC LIMIT 200`,
      [expID],
    );
    for (const r of intents.rows) {
      const summary = String(r["summary"] ?? "");
      candidates.push({
        kind: "intent",
        id: Number(r["id"]),
        label: summary.slice(0, 100) || `意图 #${String(r["id"])}`,
        description: `意图 · ${String(r["state"])}`,
      });
    }
    const assets = await app.db.query(
      `SELECT DISTINCT a.id, a.type,
              COALESCE(NULLIF(a.domain,''),'') AS domain, COALESCE(NULLIF(a.ip,''),'') AS ip,
              COALESCE(NULLIF(a.url,''),'') AS url, COALESCE(NULLIF(a.app_name,''),'') AS app_name,
              COALESCE(NULLIF(a.service_name,''),'') AS service_name
       FROM exploration_anchors x
       JOIN exploration_nodes n ON n.id=x.node_id AND n.exploration_id=$1
       JOIN assets a ON a.id=x.asset_id
       ORDER BY a.id DESC LIMIT 200`,
      [expID],
    );
    for (const r of assets.rows) {
      const label = String(
        r["domain"] || r["ip"] || r["url"] || r["app_name"] || r["service_name"] || `资产 #${String(r["id"])}`,
      );
      candidates.push({ kind: String(r["type"]), id: Number(r["id"]), label, description: String(r["type"]) });
    }
    // kind 过滤对齐前端 mention 语义：kind=asset 泛匹配资产类；空 kind 浏览全部。
    const isAssetKind = (k: string): boolean => !["finding", "company", "intent"].includes(k);
    const filtered = candidates.filter(
      (c) =>
        (kind === "" || c.kind === kind || (kind === "asset" && isAssetKind(c.kind))) &&
        (needle === "" || String(c.id) === needle || `${c.label} ${c.description}`.toLowerCase().includes(needle)),
    );
    return {
      items: filtered.slice(offset, offset + PAGE),
      next_cursor: offset + PAGE < filtered.length ? String(offset + PAGE) : "",
    };
  });

  // ─── 任务总览：LLM 绑定 / 资产引用 ──────────────────────────────────────────

  // PUT /api/tasks/:id/llm — 更新任务 LLM 绑定（单绑定：tasks.llm_profile_id 存第一项，
  // 链序同步 task_llm_profiles，active 缺省回落第一项）。
  app.put("/api/tasks/:id/llm", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const task = await tasks().getTask(taskID);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b["llm_profile_ids"])
      ? b["llm_profile_ids"].map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const activeRaw = Number(b["active_llm_profile_id"]);
    const activeID = Number.isInteger(activeRaw) && activeRaw > 0 ? activeRaw : null;
    if(new Set(ids).size!==ids.length || (activeID && !ids.includes(activeID)))return reply.code(400).send({error:'模型链不能重复，激活模型必须属于模型链'});
    const first = ids[0] ?? null;
    await app.db.transaction(async tx=>{
      await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskID]);
      await tx.query(`UPDATE tasks SET llm_profile_id=$2::bigint,active_llm_profile_id=COALESCE($3::bigint,$2::bigint) WHERE id=$1`,[taskID,first,activeID]);
      await tx.query(`DELETE FROM task_llm_profiles WHERE task_id=$1`,[taskID]);
      for(let pos=0;pos<ids.length;pos++)await tx.query(`INSERT INTO task_llm_profiles(task_id,profile_id,position) VALUES($1,$2,$3)`,[taskID,ids[pos],pos]);
    });
    return { ok: true, llm_profile_ids: ids, active_llm_profile_id: activeID ?? first };
  });

  // GET /api/tasks/:id/asset-refs?asset_id= — 某资产在本任务探索图里的意图/事实/发现引用。
  app.get("/api/tasks/:id/asset-refs", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const expID = await taskExploration(taskID);
    const assetID = Number((req.query as Record<string, unknown>)["asset_id"]);
    if (!Number.isInteger(assetID) || assetID <= 0) return reply.code(400).send({ error: "缺少或无效的 asset_id" });
    const rows = await app.db.query(
      `WITH ${assetContextCTE} SELECT n.id,n.kind,n.state,c.task_id source_task_id,c.task_id<>$1 inherited,
       COALESCE(NULLIF(n.payload->>'summary',''),NULLIF(n.payload->>'text',''),'') summary
       FROM exploration_anchors x JOIN exploration_nodes n ON n.id=x.node_id JOIN context_tasks c ON c.exploration_id=n.exploration_id
       WHERE x.asset_id=COALESCE((SELECT asset_id FROM asset_id_aliases WHERE old_id=$2),$2) AND x.asset_id IN(SELECT id FROM visible) ORDER BY n.id DESC`,[taskID,assetID]);
    const bucket = (nodeKind: string) =>
      rows.rows
        .filter((r) => String(r["kind"]) === nodeKind)
        .map((r) => ({
          id: Number(r["id"]),
          kind: String(r["kind"]),source_task_id:Number(r.source_task_id),inherited:r.inherited===true,
          state: String(r["state"]),
          summary: String(r["summary"] ?? ""),
        }));
    return { intents: bucket("intent"), facts: bucket("fact"), findings: bucket("finding") };
  });

  // GET /api/tasks/:id/intent-assets?before=&limit= — 意图锚定资产（意图 → anchors → assets）。
  app.get("/api/tasks/:id/intent-assets", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const expID = await taskExploration(taskID);
    const q = req.query as Record<string, unknown>;
    const before = Number(q["before"]) || 0;
    const limit = Math.min(Math.max(Number(q["limit"]) || 300, 1), 500);
    const rows = await app.db.query(
      `SELECT n.id AS intent_id, a.id AS asset_id, a.type,
              COALESCE(NULLIF(a.domain,''),'') AS domain, COALESCE(NULLIF(a.ip,''),'') AS ip,
              COALESCE(NULLIF(a.url,''),'') AS url, COALESCE(NULLIF(a.app_name,''),'') AS app_name,
              COALESCE(NULLIF(a.service_name,''),'') AS service_name,
              l.source, l.source_summary, l.source_node_id, l.task_id AS link_task_id
       FROM exploration_anchors x
       JOIN exploration_nodes n ON n.id=x.node_id AND n.exploration_id=$1 AND n.kind='intent'
       JOIN assets a ON a.id=x.asset_id
       LEFT JOIN task_asset_links l ON l.task_id=$2 AND l.asset_id=a.id
       WHERE ($3::bigint = 0 OR n.id < $3)
       ORDER BY n.id DESC LIMIT $4`,
      [expID, taskID, before, limit],
    );
    return {
      assets: rows.rows.map((r) => ({
        intent_id: Number(r["intent_id"]),
        asset_id: Number(r["asset_id"]),
        type: String(r["type"]),
        label: String(
          r["domain"] || r["ip"] || r["url"] || r["app_name"] || r["service_name"] || `#${String(r["asset_id"])}`,
        ),
        source: r["source"] === null || r["source"] === undefined ? "agent" : String(r["source"]),
        source_summary: r["source_summary"] === null || r["source_summary"] === undefined ? "" : String(r["source_summary"]),
        ...(r["source_node_id"] ? { source_node_id: Number(r["source_node_id"]) } : {}),
        source_task_id: r["link_task_id"] === null || r["link_task_id"] === undefined ? taskID : Number(r["link_task_id"]),
        inherited: false,
      })),
    };
  });
}
