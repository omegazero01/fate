import {serveActivityStream} from '../activity-stream.js';
import {readActivityPage} from '../../db/activity-content.js';
// 探索图路由（按 expID 寻址，M5 新契约）：节点/边/活动分页/frontier + 活动实时 SSE。
// SSE 与 Go streamActivity 同构：先 `: connected`，回放 since 之后的 DB 历史，
// 再桥接 engine.bus 的 activity 事件；每帧 `id: <seq>\ndata: {json}\n\n`，20s 心跳 `: ping`。

import type { FastifyInstance } from "fastify";
import type { EngineActivity } from "../../engine/engine.js";
import {authorizedNodes} from '../../db/graph_view.js';
import {buildGraphOverview} from '../../tools/overview.js';
import {runContext} from '../../tools/context.js';

/** engine.bus activity 事件（EngineActivity + 落库后的自增 id）。 */
type BusActivity = EngineActivity & { id?: number };


function num(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function registerExplorationRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  app.get('/api/exploration/:expID/context',async(req,reply)=>{
    const expID=num((req.params as {expID:string}).expID);
    const task=(await db().query('SELECT id FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL',[expID])).rows[0];
    if(!task)return reply.code(404).send({error:'task not found'});
    return buildGraphOverview(runContext(db(),Number(task.id),expID,'mainagent'));
  });

  app.get("/api/exploration/:expID/nodes", async (req) => {
    const expID = num((req.params as { expID: string }).expID);
    const q = req.query as Record<string, unknown>;
    const kind = typeof q["kind"] === "string" && q["kind"] !== "" ? q["kind"] : null;
    const state = typeof q["state"] === "string" && q["state"] !== "" ? q["state"] : null;
    const limit = Math.min(2000, Math.max(1, num(q["limit"], 500)));
    const res = await db().query(
      `SELECT id, kind, payload, priority, state, COALESCE(origin,'') AS origin, COALESCE(owner,'') AS owner,
              COALESCE(blocked_reason,'') AS blocked_reason, created_at
       FROM exploration_nodes
       WHERE exploration_id=$1 AND exploration_node_readable($1,id) AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR state=$3)
       ORDER BY id DESC LIMIT $4`,
      [expID, kind, state, limit],
    );
    return {
      items: res.rows.map((r) => ({
        id: Number(r["id"]),
        kind: String(r["kind"]),
        payload: r["payload"] ?? {},
        priority: Number(r["priority"] ?? 0),
        state: String(r["state"]),
        origin: r["origin"] || undefined,
        owner: r["owner"] || undefined,
        blocked_reason: r["blocked_reason"] || undefined,
        created_at: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
      })),
      total: res.rows.length,
    };
  });

  app.get("/api/exploration/:expID/edges", async (req) => {
    const expID = num((req.params as { expID: string }).expID);
    const res = await db().query(
      `SELECT id, src_id, rel, dst_id, created_at FROM exploration_edges WHERE exploration_id=$1 AND exploration_node_readable($1,src_id) AND exploration_node_readable($1,dst_id) ORDER BY id LIMIT 20000`,
      [expID],
    );
    return {
      items: res.rows.map((r) => ({
        id: Number(r["id"]),
        src_id: Number(r["src_id"]),
        rel: String(r["rel"]),
        dst_id: Number(r["dst_id"]),
        created_at: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
      })),
    };
  });

  // 活动分页（?since=<seq>&limit=&node=<intentID>）：前端活动流回放/增量拉取共用。
  app.get("/api/exploration/:expID/activity", async (req) => {
    const expID = num((req.params as { expID: string }).expID);
    const q = req.query as Record<string, unknown>;
    const since = Math.max(0, num(q["since"], 0));
    const limit = Math.min(1000, Math.max(1, num(q["limit"], 300)));
    const node = q["node"] !== undefined && q["node"] !== "" ? num(q["node"], 0) : null;
    const intent = q["intent"] !== undefined && q["intent"] !== "" ? num(q["intent"], 0) : null;
    const nodeFilter = node ?? intent;
    const res = await readActivityPage(db(),'task','exploration_id=$1 AND id>$2 AND exploration_activity_readable($1,node_id,metadata) AND ($3::bigint IS NULL OR node_id=$3)',[expID,since,nodeFilter],'ASC',limit);
    const items = res.rows.map((r) => ({
      id: Number(r["id"]),
      node_id: r["node_id"] === null ? null : Number(r["node_id"]),
      worker: String(r["worker"] ?? ""),
      kind: String(r["kind"] ?? ""),
      tool: r["tool"] ?? null,
      tool_use_id: r["tool_use_id"] ?? null,
      is_error: r["is_error"] === true,
      summary: String(r["summary"] ?? ""),
      detail: r["detail"] ?? null,
      detail_total_chars:r.detail_total_chars,detail_truncated:r.detail_truncated,detail_version:r.detail_version,metadata_truncated:r.metadata_truncated,summary_truncated:r.summary_truncated,
      created_at: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
    }));
    return { items, cursor: items.length > 0 ? items[items.length - 1]!.id : since, has_more:res.hasMore };
  });

  app.get("/api/exploration/:expID/frontier", async (req) => {
    const expID = num((req.params as { expID: string }).expID);
    const limit = Math.min(500, Math.max(1, num((req.query as Record<string, unknown>)["limit"], 50)));
    const task=(await db().query('SELECT id FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL',[expID])).rows[0];
    if(!task)throw Object.assign(new Error('任务不存在'),{statusCode:404});
    const items = await authorizedNodes(db(),Number(task.id),expID,await db().exploration(expID).frontier(limit));
    return { items };
  });

  // ─── 活动实时流（SSE）──────────────────────────────────────────────────────

  app.get("/api/exploration/activity/stream", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    // expID 显式给定时优先；否则把 task=<taskID> 换算成 exploration_id
    // （activity 按 exp 寻址——task 值直接当 expID 用会回放到错库的流）。
    let expID = num(q["expID"] ?? q["exp"], 0);
    if (expID <= 0 && q["task"] !== undefined && q["task"] !== "") {
      const taskID = num(q["task"], 0);
      const res = await db().query<{ exploration_id: number }>(
        `SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
        [taskID],
      );
      const row = res.rows[0];
      if (!row) return reply.code(404).send({ error: `任务 #${taskID} 不存在` });
      expID = Number(row.exploration_id);
    }
    if (expID <= 0) {
      return reply.code(400).send({ error: "缺少或无效的 expID 查询参数" });
    }
    await serveActivityStream(db(),req,reply,'task',expID);
  });
}
