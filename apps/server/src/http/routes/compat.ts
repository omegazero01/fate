import {aggregateUsage,unverifiedUsageHistory} from '../../db/usage-ledger.js';
import {coverageGraph,queryAssets} from '../../db/asset-query.js';
import {READABLE_FINDINGS} from "./finding-projection.js";
import {modelTokenUsage} from '../model-token-usage.js';
import {executionSnapshot} from '../../engine/coordinator.js';
import { resolveModelProfiles } from "../../pi/modelResolver.js";
import {authorizedNodes,resolveGraphNode,TASK_GRAPH_CTE} from '../../db/graph_view.js';
// 前端（Go 版契约）兼容层：task 寻址的探索端点 + findings 族 + goals/constraints/
// coverage-graph + 意图控制别名 + stats/audit。响应形状对齐 web/src/lib/types.ts。
// 高级端点（findings 分组/资产树/导出、traffic 绑定、retests）返回可渲染的空态。

import type { FastifyInstance } from "fastify";
import { RelDerivedFrom, RelYields } from "../../db/exploration.js";
import { makeFindingsAssetTreeHandler, makeFindingsExportHandler } from "./findings-extra.js";

interface CtxNode {
  id: string;
  type: string;
  payload: string;
  priority: number;
  state: string;
  origin: string;
  ts: string;
  source_task_id?: string;
  inherited?: boolean;
}

function mapNode(row: Record<string, unknown>): CtxNode {
  const payload = row["payload"];
  return {
    id: String(row["id"]),
    type: String(row["kind"]),
    payload: typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
    priority: Number(row["priority"] ?? 0),
    state: String(row["state"] ?? ""),
    origin: String(row["origin"] ?? ""),
    ts: row["created_at"] instanceof Date ? (row["created_at"] as Date).toISOString() : String(row["created_at"] ?? ""),
    ...(row["source_task_id"] ? { source_task_id: String(row["source_task_id"]) } : {}),
    ...(row["inherited"] ? { inherited: true } : {}),
  };
}

function mapActivity(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: Number(row["id"]),
    metadata: row["metadata"] ?? {},
    ...Object.fromEntries(["turn_id","stream_id","channel","interrupted"].map(k=>[k,(row["metadata"] as Record<string,unknown>|undefined)?.[k]])),
    worker: row["worker"] === "main" ? "mainagent" : String(row["worker"] ?? ""),
    ts: row["created_at"] instanceof Date ? (row["created_at"] as Date).toISOString() : String(row["created_at"] ?? ""),
    kind: String(row["kind"] ?? ""),
    summary: String(row["summary"] ?? ""),
    is_error: row["is_error"] === true,
  };
  if (row["node_id"] !== null && row["node_id"] !== undefined) out["intent_id"] = String(row["node_id"]);
  if (row["tool"]) out["tool"] = row["tool"];
  if (row["tool_use_id"]) out["tool_use_id"] = row["tool_use_id"];
  if (row["main_seg"] !== null && row["main_seg"] !== undefined) out["main_seg"] = Number(row["main_seg"]);
  for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const) {
    if (row[k] !== null && row[k] !== undefined) out[k] = Number(row[k]);
  }
  return out;
}

function mapFinding(row: Record<string, unknown>, task?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: String(row["node_id"] ?? row["id"]),
    ...(Number(row["id"])>0?{finding_id:String(row["id"])}:{}),
    vulnclass: String(row["vulnclass"] ?? ""),
    name: String(row["name"] ?? ""),
    severity: String(row["severity"] ?? "medium"),
    status: String(row["status"] ?? "pending"),
    summary: String(row["summary"] ?? ""),
    evidence: String(row["evidence"] ?? ""),
    ts: row["created_at"] instanceof Date ? (row["created_at"] as Date).toISOString() : String(row["created_at"] ?? ""),
    traffic_count: Number(row["traffic_count"] ?? 0),
    evidence_version: Number(row["evidence_version"] ?? 0),
    report_evidence_version: Number(row["report_evidence_version"] ?? 0),
    report_stale: Number(row["evidence_version"] ?? 0) > Number(row["report_evidence_version"] ?? 0),
  };
  if (row["task_id"]) out["task_id"] = String(row["task_id"]);
  if (task) {
    out["task_description"] = String(task["description"] ?? "");
  }
  return out;
}

export function registerCompatRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  /** task id → exploration id（含存在性）。 */
  async function expOf(taskID: number): Promise<number> {
    const res = await db().query<{ exploration_id: number }>(
      `SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
      [taskID],
    );
    const row = res.rows[0];
    if (!row) throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
    return Number(row.exploration_id);
  }

  async function taskRow(taskID: number): Promise<Record<string, unknown> | undefined> {
    const res = await db().query(`SELECT * FROM tasks WHERE id=$1`, [taskID]);
    return res.rows[0];
  }

  const NODE_COLS = `id, kind, payload, priority, state, COALESCE(origin,'') AS origin, created_at`;

  function q2n(v: unknown, dflt: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  // ─── 探索图（graph / nodes / node detail）─────────────────────────────────

  app.get("/api/exploration/graph", async (req) => {
    const q = req.query as Record<string, string>;
    const taskID=q2n(q["task"],0);await expOf(taskID);
    const nodes = await db().query(`WITH ${TASK_GRAPH_CTE} SELECT ${NODE_COLS},source_task_id,inherited FROM visible ORDER BY inherited,id LIMIT 2001`, [taskID]);
    const page=nodes.rows.slice(0,2000),ids=page.map(n=>Number(n.id));
    const edges = await db().query(`SELECT src_id::text AS src, dst_id::text AS dst, rel FROM exploration_edges WHERE src_id=ANY($1::bigint[]) AND dst_id=ANY($1::bigint[]) ORDER BY id LIMIT 4001`, [ids]);
    return { nodes: page.map(mapNode), edges: edges.rows.slice(0,4000), has_more:nodes.rows.length>2000||edges.rows.length>4000, continuation:'/api/exploration/nodes?task='+taskID };
  });

  app.get("/api/exploration/nodes", async (req) => {
    const q = req.query as Record<string, string>;
    const taskID=q2n(q["task"],0);await expOf(taskID);
    const page = Math.max(q2n(q["page"], 1), 1);
    const size = Math.min(Math.max(q2n(q["size"], 20), 1), 100);
    const params: unknown[] = [taskID];
    let where = `true`;
    if (q["kind"]) {
      params.push(q["kind"].split(","));
      where += ` AND kind=ANY($${params.length}::text[])`;
    }
    if (q["state"]) {
      params.push(q["state"].split(","));
      where += ` AND state=ANY($${params.length}::text[])`;
    }
    if (q["q"]) {
      params.push(`%${q["q"]}%`);
      where += ` AND payload::text ILIKE $${params.length}`;
    }
    const order = q["order"] === "asc" ? "ASC" : "DESC";
    if (q["count_only"]) {
      const c = await db().query<{ n: string }>(`WITH ${TASK_GRAPH_CTE} SELECT count(*) AS n FROM visible WHERE ${where}`, params);
      return { items: [], total: Number(c.rows[0]?.n ?? 0), page, size, edges: [], refs: {} };
    }
    const rows = await db().query(
      `WITH ${TASK_GRAPH_CTE} SELECT ${NODE_COLS},source_task_id,inherited FROM visible WHERE ${where} ORDER BY id ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    );
    const total = await db().query<{ n: string }>(`WITH ${TASK_GRAPH_CTE} SELECT count(*) AS n FROM visible WHERE ${where}`, params);
    const ids = rows.rows.map((r) => Number(r["id"]));
    const edges =
      ids.length > 0
        ? await db().query(
            `WITH ${TASK_GRAPH_CTE} SELECT e.src_id::text AS src,e.dst_id::text AS dst,e.rel FROM exploration_edges e JOIN visible s ON s.id=e.src_id JOIN visible d ON d.id=e.dst_id WHERE e.src_id=ANY($2::bigint[]) OR e.dst_id=ANY($2::bigint[]) ORDER BY e.id`,
            [taskID, ids],
          )
        : { rows: [] };
    return {
      items: rows.rows.map(mapNode),
      total: Number(total.rows[0]?.n ?? 0),
      page,
      size,
      edges: edges.rows,
      refs: {},
    };
  });

  app.get("/api/exploration/nodes/:id", async (req) => {
    const q = req.query as Record<string, string>;
    const p = req.params as Record<string, string>;
    const taskID=q2n(q["task"],0),localExp=await expOf(taskID);
    let resolved;
    try{resolved=await resolveGraphNode(db(),taskID,localExp,Number(p.id));}catch{throw Object.assign(new Error('节点不存在或未获授权'),{statusCode:404});}
    const expID=resolved.expID;
    const res = await db().query(`SELECT ${NODE_COLS} FROM exploration_nodes WHERE exploration_id=$1 AND id=$2`, [expID, Number(p["id"])]);
    const node = res.rows[0];
    if (!node) throw Object.assign(new Error("节点不存在"), { statusCode: 404 });
    const edges = await db().query(
      `SELECT src_id::text AS src, dst_id::text AS dst, rel FROM exploration_edges WHERE exploration_id=$1 AND exploration_node_readable($1,src_id) AND exploration_node_readable($1,dst_id) AND (src_id=$2 OR dst_id=$2) LIMIT 200 OFFSET $3`,
      [expID, Number(p["id"]), q2n(q["edge_offset"], 0)],
    );
    const payload = typeof node.payload==='string'?node.payload:JSON.stringify(node.payload??{});
    const bodyOffset = q2n(q["body_offset"], 0);
    const WINDOW = 8000;
    const body = payload.slice(bodyOffset, bodyOffset + WINDOW);
    const anchorIDs=(await db().query('SELECT asset_id FROM exploration_anchors WHERE node_id=$1 ORDER BY asset_id',[Number(p.id)])).rows.map(r=>Number(r.asset_id));
    const assets=await queryAssets(db(),{taskID,ids:anchorIDs,limit:50,offset:q2n(q.asset_offset,0),summary:true});
    return {
      assets:assets.assets,assets_total:assets.total,assets_next_offset:assets.next_offset,
      node: mapNode({...node,...(resolved.inherited?{source_task_id:resolved.taskID,inherited:true}:{})}),
      payload: body,
      payload_next_offset: bodyOffset + body.length < payload.length ? bodyOffset + body.length : 0,
      edges: edges.rows,
      edges_next_offset: edges.rows.length >= 200 ? q2n(q["edge_offset"], 0) + 200 : 0,
      refs: {},
    };
  });

  app.get("/api/exploration/frontier", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const items = await authorizedNodes(db(),q2n(q.task,0),expID,await db().exploration(expID).frontier(100));
    return items.map((n) =>
      mapNode({ id: n.id, kind: n.kind, payload: n.payload, priority: n.priority, state: n.state, origin: n.origin ?? "", created_at: n.created_at }),
    );
  });

  app.get("/api/exploration/intents", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const before = q2n(q["before"], 0);
    const limit = Math.min(q2n(q["limit"], 300), 500);
    const params: unknown[] = [expID, limit];
    let where = `exploration_id=$1 AND kind='intent' AND exploration_node_readable($1,id)`;
    if (before > 0) {
      params.push(before);
      where += ` AND id < $${params.length}`;
    }
    const rows = await db().query(`SELECT ${NODE_COLS},EXISTS(SELECT 1 FROM engine_worker_slots s JOIN engine_task_leases l ON l.task_id=s.task_id AND l.token=s.token WHERE s.intent_id=exploration_nodes.id AND s.phase='running' AND l.expires_at>now()) executor_active FROM exploration_nodes WHERE ${where} ORDER BY id DESC LIMIT $2`, params);
    const total = await db().query<{ n: string }>(`SELECT count(*) AS n FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND exploration_node_readable($1,id)`, [expID]);
    return { items: rows.rows.map(row=>({...mapNode(row),executor_active:row.executor_active===true})), has_more: Number(total.rows[0]?.n ?? 0) > 0 && rows.rows.length >= limit };
  });

  // ─── 活动流（列表/详情/历史/搜索）─────────────────────────────────────────

  const ACT_COLS = `id, node_id, worker, kind, tool, tool_use_id, is_error, summary, created_at, main_seg, metadata,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens`;

  app.get("/api/exploration/activity", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const params: unknown[] = [expID];
    let where = `exploration_id=$1 AND kind NOT IN ('round') AND exploration_activity_readable($1,node_id,metadata)`;
    if (q["intent"]) {
      params.push(Number(q["intent"]));
      where += ` AND node_id=$${params.length}`;
    }
    if (q["since"] && Number(q["since"]) > 0) {
      params.push(Number(q["since"]));
      where += ` AND id > $${params.length}`;
    }
    params.push(Math.min(q2n(q["limit"], 200), 1000));
    const forward=q.since!==undefined;
    const rows = await db().query(
      `SELECT ${ACT_COLS} FROM activity WHERE ${where} ORDER BY id ${forward?'ASC':'DESC'} LIMIT $${params.length}`,
      params,
    );
    const ordered=forward?rows.rows:rows.rows.reverse();
    return { items: ordered.map(mapActivity), cursor: Number(ordered.at(-1)?.id ?? q.since ?? 0), has_more: rows.rows.length===params.at(-1) };
  });

  app.get("/api/exploration/activity/:id", async (req) => {
    const p = req.params as Record<string, string>;
    const res = await db().query(`SELECT detail FROM activity WHERE id=$1 AND exploration_activity_readable(exploration_id,node_id,metadata)`, [Number(p["id"])]);
    if(!res.rowCount)throw Object.assign(new Error('活动不存在或未获授权'),{statusCode:404});
    return { detail: String(res.rows[0]?.["detail"] ?? "") };
  });

  app.get("/api/exploration/activity/history", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const session = q["session"] ?? "main";
    const before = q2n(q["before"], 0);
    const limit = Math.min(q2n(q["limit"], 200), 500);
    const snap = await db().query<{ m: string | null }>(`SELECT max(id) AS m FROM activity WHERE exploration_id=$1`, [expID]);
    const snapshot = Number(snap.rows[0]?.m ?? 0);
    const params: unknown[] = [expID, snapshot];
    let sessionWhere = ` AND exploration_activity_readable($1,node_id,metadata)`;
    if (session === "main" || /^main:\d+$/.test(session)) {
      params.push(session.startsWith("main:") ? Number(session.slice(5)) : Number(q["seg"]) || 0);
      sessionWhere += ` AND worker IN ('mainagent','main') AND COALESCE(main_seg,0)=$${params.length}`;
    }
    else if (session === "plan") sessionWhere += ` AND worker IN ('planner','goals')`;
    else if (session.startsWith("intent:")) {
      params.push(Number(session.slice("intent:".length)));
      sessionWhere += ` AND node_id=$${params.length}`;
    }
    if (session === "main" && q["seg"] !== undefined) {
      params.push(Number(q["seg"]) || 0);
      sessionWhere += ` AND COALESCE(main_seg,0)=$${params.length}`;
    }
    if (before > 0) {
      params.push(before);
      const rangeIdx = params.length;
      params.push(limit);
      var rows = await db().query(
        `SELECT ${ACT_COLS} FROM activity WHERE exploration_id=$1 AND id <= $2 AND kind NOT IN ('round')${sessionWhere} AND id < $${rangeIdx}
         ORDER BY id DESC LIMIT $${params.length}`,
        params,
      );
    } else {
      params.push(limit);
      var rows = await db().query(
        `SELECT ${ACT_COLS} FROM activity WHERE exploration_id=$1 AND id <= $2 AND kind NOT IN ('round')${sessionWhere}
         ORDER BY id DESC LIMIT $${params.length}`,
        params,
      );
    }
    const items = rows.rows.map(mapActivity).reverse();
    return {
      items,
      snapshot_cursor: snapshot,
      earliest_cursor: items.length > 0 ? Number(rows.rows[rows.rows.length - 1]!["id"]) : 0,
      latest_cursor: items.length > 0 ? Number(rows.rows[0]!["id"]) : 0,
      has_newer: items.length > 0 ? Number(rows.rows[0]!["id"]) < snapshot : false,
      has_more: rows.rows.length >= limit,
    };
  });

  // 会话内关键词搜索（session-search 弹层）：session 过滤同 history（main→worker
  // mainagent/main、plan→planner、intent:N→node_id），summary ILIKE q，id 倒序翻页。
  app.get("/api/exploration/activity/search", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const session = q["session"] ?? "main";
    const needle = (q["q"] ?? "").trim();
    const cursor = q2n(q["cursor"], 0);
    const limit = Math.min(Math.max(q2n(q["limit"], 20), 1), 100);
    const params: unknown[] = [expID];
    let where = `exploration_id=$1 AND exploration_activity_readable($1,node_id,metadata)`;
    if (session === "main") where += ` AND worker IN ('mainagent','main')`;
    else if (session === "plan") where += ` AND worker IN ('planner','goals')`;
    else if (session.startsWith("intent:")) {
      params.push(Number(session.slice("intent:".length)));
      where += ` AND node_id=$${params.length}`;
    }
    if (cursor > 0) {
      params.push(cursor);
      where += ` AND id < $${params.length}`;
    }
    if (needle !== "") {
      params.push(`%${needle}%`);
      where += ` AND summary ILIKE $${params.length}`;
    }
    const rows = await db().query(
      `SELECT id, kind, summary FROM activity WHERE ${where} ORDER BY id DESC LIMIT $${params.length + 1}`,
      [...params, limit + 1],
    );
    const items = rows.rows.slice(0, limit).map((r) => ({
      id: Number(r["id"]),
      kind: String(r["kind"] ?? ""),
      snippet: String(r["summary"] ?? "").slice(0, 240),
    }));
    return { items, next_cursor: rows.rows.length > limit ? String(items[items.length - 1]!.id) : "" };
  });

  // 主对话分段：段 0 隐式（建任务即有），main_sessions 只存"新建会话"产生的 seq>=1 段。
  app.get("/api/exploration/main-sessions", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const t = await db().query<{ created_at: Date }>(`SELECT created_at FROM explorations WHERE id=$1`, [expID]);
    const rows = await db().query<{ seq: number; created_at: Date }>(
      `SELECT seq, created_at FROM main_sessions WHERE exploration_id=$1 ORDER BY seq`,
      [expID],
    );
    const sessions = [
      { seq: 0, created_at: t.rows[0]?.created_at ?? new Date() },
      ...rows.rows.map((r) => ({ seq: Number(r["seq"]), created_at: r["created_at"] })),
    ];
    return { sessions, current: sessions[sessions.length - 1]!.seq };
  });

  app.post("/api/exploration/main-session/new", async (req) => {
    const q = req.query as Record<string, string>;
    const expID = await expOf(q2n(q["task"], 0));
    const res = await db().query<{ seq: number; created_at: Date }>(
      `INSERT INTO main_sessions(exploration_id, seq)
       VALUES ($1, (SELECT COALESCE(max(seq),0)+1 FROM main_sessions WHERE exploration_id=$1))
       RETURNING seq, created_at`,
      [expID],
    );
    const r = res.rows[0]!;
    return { seq: Number(r["seq"]), created_at: r["created_at"], current: Number(r["seq"]) };
  });

  // ─── Findings 族 ──────────────────────────────────────────────────────────

  app.get("/api/exploration/findings", async (req) => {
    const q = req.query as Record<string, string>;
    if(q.legacy_node){
      const tid=Number(q.context_task??q.task),owner=await taskRow(tid);
      if(!owner)throw Object.assign(new Error('任务不存在'),{statusCode:404});
      const resolved=await resolveGraphNode(db(),tid,Number(owner.exploration_id),Number(q.legacy_node));
      if(resolved.node.kind!=='finding')throw Object.assign(new Error('不是发现节点'),{statusCode:404});
      const row=(await db().query(`SELECT * FROM ${READABLE_FINDINGS} f WHERE node_id=$1`,[resolved.node.id])).rows[0];
      if(!row)throw Object.assign(new Error('发现不存在'),{statusCode:404});
      return {...mapFinding(row,await taskRow(resolved.taskID)),report:row.report,...(resolved.inherited?{inherited:true,source_task_id:String(resolved.taskID)}:{})};
    }
    const page = Math.max(q2n(q["page"], 1), 1);
    const limit = Math.min(Math.max(q2n(q["limit"], 20), 1), 100);
    const params: unknown[] = [];
    let where = ` WHERE true`;
    const contextTask = q["context_task"] ?? q["task"] ?? q["task_id"];
    if (contextTask && Number(contextTask) > 0) {
      params.push(Number(contextTask));
      where += ` AND (f.task_id=$${params.length} OR f.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id=$${params.length}))`;
    }
    if (q["severity"] && q["severity"] !== "all") {
      params.push(q["severity"].split(","));
      where += ` AND f.severity=ANY($${params.length}::text[])`;
    }
    if (q["status"] && q["status"] !== "all") {
      params.push(q["status"].split(","));
      where += ` AND f.status=ANY($${params.length}::text[])`;
    }
    if (q["q"]) {
      params.push(`%${q["q"]}%`);
      where += ` AND (f.summary ILIKE $${params.length} OR f.name ILIKE $${params.length} OR f.vulnclass ILIKE $${params.length})`;
    }
    if(q.vulnclass && q.vulnclass!=='all'){params.push(q.vulnclass);where+=` AND f.vulnclass=$${params.length}`;}
    const total = await db().query<{ n: string }>(`SELECT count(*) AS n FROM ${READABLE_FINDINGS} f${where}`, params);
    const rows = await db().query(
      `SELECT f.*,(SELECT count(*) FROM finding_traffic_bindings b WHERE b.finding_id=f.id) AS traffic_count FROM ${READABLE_FINDINGS} f${where} ORDER BY f.created_at ${q.direction==='asc'?'ASC':'DESC'},f.id ${q.direction==='asc'?'ASC':'DESC'} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    const taskCache = new Map<number, Record<string, unknown>>();
    const assetIDs=[...new Set(rows.rows.flatMap(r=>Array.isArray(r.asset_ids)?r.asset_ids.map(Number):[]))];
    const assetMap=new Map((await db().assets().getByIDs(assetIDs)).map(a=>[a.id,{id:String(a.id),type:a.type,label:a.domain||a.ip||a.url||a.app_name||a.bundle_id||String(a.id)}]));
    const items = [];
    for (const r of rows.rows) {
      const tid = Number(r["task_id"] ?? 0);
      if (tid > 0 && !taskCache.has(tid)) taskCache.set(tid, (await taskRow(tid)) ?? {});
      const item=mapFinding(r,taskCache.get(tid));
      item.assets=(Array.isArray(r.asset_ids)?r.asset_ids:[]).map(id=>assetMap.get(Number(id))).filter(Boolean);
      if(contextTask && Number(contextTask)!==tid){item.inherited=true;item.source_task_id=String(tid);}
      items.push(item);
    }
    return { items, total: Number(total.rows[0]?.n ?? 0), page, page_size: limit };
  });

  app.get("/api/exploration/findings/stats", async () => {
    const rows = await db().query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status='pending') AS pending,
              count(*) FILTER (WHERE severity='critical') AS critical,
              count(*) FILTER (WHERE severity='high') AS high,
              count(*) FILTER (WHERE severity='medium') AS medium,
              count(*) FILTER (WHERE severity='low') AS low,
              array_agg(DISTINCT vulnclass) FILTER (WHERE vulnclass <> '') AS vulnclasses
       FROM ${READABLE_FINDINGS} findings WHERE true`,
    );
    const r = rows.rows[0] ?? {};
    const tasks = await db().query(
      `SELECT f.task_id::text AS id, t.description AS description, count(*) AS count FROM ${READABLE_FINDINGS} f
       LEFT JOIN tasks t ON t.id=f.task_id WHERE true GROUP BY f.task_id, t.description ORDER BY count DESC LIMIT 50`,
    );
    return {
      total: Number(r["total"] ?? 0),
      pending: Number(r["pending"] ?? 0),
      critical: Number(r["critical"] ?? 0),
      high: Number(r["high"] ?? 0),
      medium: Number(r["medium"] ?? 0),
      low: Number(r["low"] ?? 0),
      vulnclasses: (r["vulnclasses"] as string[]) ?? [],
      tasks: tasks.rows,
    };
  });

  app.get("/api/exploration/findings/groups", async (req) => {
    const q = req.query as Record<string, string>;
    const page = Math.max(q2n(q["page"], 1), 1);
    const limit = Math.min(Math.max(q2n(q["limit"], 20), 1), 100);
    const rows = await db().query(
      `SELECT f.task_id::text AS task_id, COALESCE(t.name,'') AS task_name, COALESCE(t.description,'') AS task_description,
              COALESCE(t.status,'') AS task_status, count(*) AS count,
              count(*) FILTER (WHERE f.severity='critical') AS critical,
              count(*) FILTER (WHERE f.severity='high') AS high,
              count(*) FILTER (WHERE f.severity='medium') AS medium,
              count(*) FILTER (WHERE f.severity='low') AS low,
              max(f.created_at)::text AS last_found_at
       FROM ${READABLE_FINDINGS} f LEFT JOIN tasks t ON t.id=f.task_id WHERE true
       GROUP BY f.task_id, t.name, t.description, t.status ORDER BY max(f.created_at) DESC LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
    const findingTotal = await db().query<{ n: string }>(`SELECT count(*) AS n FROM ${READABLE_FINDINGS} findings WHERE true`);
    return {
      items: rows.rows.map((r) => ({
        task_id: r["task_id"],
        task_name: r["task_name"],
        task_description: r["task_description"],
        task_status: r["task_status"],
        count: Number(r["count"]),
        critical: Number(r["critical"]),
        high: Number(r["high"]),
        medium: Number(r["medium"]),
        low: Number(r["low"]),
        last_found_at: r["last_found_at"],
      })),
      total: rows.rows.length,
      finding_total: Number(findingTotal.rows[0]?.n ?? 0),
      page,
      page_size: limit,
    };
  });

  async function findingByAnyId(idStr: string, record=false): Promise<Record<string, unknown>> {
    const id = Number(idStr);
    let res = await db().query(record?`SELECT * FROM findings WHERE id=$1`:`SELECT * FROM findings WHERE node_id=$1`, [id]);
    if (res.rows.length === 0 && !record) res = await db().query(`SELECT * FROM findings WHERE id=$1`, [id]);
    const row = res.rows[0];
    if (!row) throw Object.assign(new Error("漏洞不存在"), { statusCode: 404 });
    return row;
  }

  app.get("/api/exploration/findings/:id", async (req) => {
    const p = req.params as Record<string, string>;
    const row = await findingByAnyIDGuard(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
    const tid = Number(row["task_id"] ?? 0);
    const out = mapFinding(row, tid > 0 ? await taskRow(tid) : undefined);
    const context=Number((req.query as Record<string,string>).context_task);
    if(context && context!==tid){const related=await db().query('SELECT 1 FROM task_relations WHERE task_id=$1 AND source_task_id=$2',[context,tid]);if(!related.rowCount)throw Object.assign(new Error('漏洞不属于任务及直接来源任务'),{statusCode:403});out.inherited=true;out.source_task_id=String(tid);}
    out["report"] = String(row["report"] ?? "");
    const assetIDs = Array.isArray(row["asset_ids"]) ? (row["asset_ids"] as number[]) : [];
    if (assetIDs.length > 0) {
      const assets = await db().assets().getByIDs(assetIDs);
      out["assets"] = assets.map((a) => ({
        id: String(a.id),
        type: a.type,
        label: a.domain || a.ip || a.url || a.app_name || a.bundle_id || String(a.id),
      }));
    } else {
      out["assets"] = [];
    }
    return out;
  });

  async function findingByAnyIDGuard(idStr: string, record=false): Promise<Record<string, unknown>> {
    const row=await findingByAnyId(idStr,record);
    if(!(await db().query('SELECT 1 WHERE finding_readable($1)',[Number(row.id)])).rowCount)throw Object.assign(new Error('漏洞不存在或未获授权'),{statusCode:404});
    return row;
  }

  app.patch("/api/exploration/findings/:id", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const row = await findingByAnyIDGuard(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of [
      ["status", "status"],
      ["severity", "severity"],
      ["name", "name"],
      ["summary", "summary"],
      ["report", "report"],
    ] as const) {
      if (typeof b[k] === "string") {
        params.push(b[k]);
        sets.push(`${col}=$${params.length}`);
      }
    }
    if (sets.length > 0) {
      params.push(Number(row["id"]));
      await db().query(`UPDATE findings SET ${sets.join(", ")} WHERE id=$${params.length}`, params);
    }
    return findingByAnyId(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
  });

  app.delete("/api/exploration/findings/:id", async (req) => {
    const p = req.params as Record<string, string>;
    const row = await findingByAnyIDGuard(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
    await db().query(`DELETE FROM findings WHERE id=$1`, [Number(row["id"])]);
    if (row["node_id"]) await db().query(`DELETE FROM exploration_nodes WHERE id=$1`, [Number(row["node_id"])]);
    return { deleted: true, id: Number(row["id"]) };
  });

  app.get("/api/exploration/findings/:id/lineage", async (req) => {
    const p = req.params as Record<string, string>;
    const row = await findingByAnyIDGuard(p["id"]!,(req.query as Record<string,string>).id_kind==='record');
    const nodeID = Number(row["node_id"] ?? 0);
    if (!nodeID) return { nodes: [], edges: [] };
    const expID = await expOf(Number(row["task_id"] ?? 0));
    // 沿 derived_from/yields 向上走两层血缘。
    const nodesRes = await db().query(
      `WITH RECURSIVE up(id) AS (
         SELECT $2 WHERE EXISTS (SELECT 1 FROM exploration_nodes WHERE id=$2 AND exploration_id=$1)
         UNION
         SELECT e.src_id FROM exploration_edges e JOIN up ON e.dst_id=up.id
         WHERE e.exploration_id=$1 AND e.rel IN ('${RelDerivedFrom}','${RelYields}')
       ) SELECT n.id, n.kind, n.payload, n.priority, n.state, COALESCE(n.origin,''), n.created_at
       FROM exploration_nodes n JOIN up ON n.id=up.id WHERE n.exploration_id=$1`,
      [expID, nodeID],
    );
    const ids = nodesRes.rows.map((r) => Number(r["id"]));
    const edgesRes =
      ids.length > 0
        ? await db().query(
            `SELECT src_id::text AS src, dst_id::text AS dst, rel FROM exploration_edges
             WHERE exploration_id=$1 AND rel IN ('${RelDerivedFrom}','${RelYields}') AND dst_id=ANY($2::bigint[])`,
            [expID, ids],
          )
        : { rows: [] };
    return { nodes: nodesRes.rows.map(mapNode), edges: edgesRes.rows };
  });

  // ─── 任务侧：goals / constraints / coverage-graph / 意图控制别名 ────────────

  app.get("/api/tasks/:id/goals", async (req) => {
    const p = req.params as Record<string, string>;
    const expID = await expOf(Number(p["id"]));
    const rows = await db().query(
      `SELECT id, payload, state, COALESCE(origin,''), created_at FROM exploration_nodes WHERE exploration_id=$1 AND kind='goal' ORDER BY id`,
      [expID],
    );
    return {
      goals: rows.rows.map((r) => {
        const payload = r["payload"] as Record<string, unknown>;
        return {
          id: String(r["id"]),
          text: String(payload["text"] ?? ""),
          vulnclass: payload["vulnclass"] ? String(payload["vulnclass"]) : "",
          state: String(r["state"]),
          origin: String(r["origin"] ?? ""),
          ts: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
        };
      }),
    };
  });

  app.post("/api/tasks/:id/goals", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const expID = await expOf(Number(p["id"]));
    const id = await db().exploration(expID).addGoal(
      { text: String(b["text"] ?? ""), ...(b["vulnclass"] ? { vulnclass: String(b["vulnclass"]) } : {}) },
      "user",
    );
    return { id: String(id), text: String(b["text"] ?? ""), state: "open", ts: new Date().toISOString() };
  });

  app.patch("/api/tasks/:id/goals/:gid", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const expID = await expOf(Number(p["id"]));
    await db().exploration(expID).updateGoalPayload(Number(p["gid"]), String(b["text"] ?? ""), String(b["vulnclass"] ?? ""));
    return { id: p["gid"], text: String(b["text"] ?? ""), vulnclass: String(b["vulnclass"] ?? "") };
  });

  app.delete("/api/tasks/:id/goals/:gid", async (req) => {
    const p = req.params as Record<string, string>;
    const expID = await expOf(Number(p["id"]));
    await db().exploration(expID).deleteGoal(Number(p["gid"]));
    return { ok: true };
  });

  app.get("/api/tasks/:id/constraints", async (req) => {
    const p = req.params as Record<string, string>;
    const expID = await expOf(Number(p["id"]));
    const rows = await db().query(`SELECT id, kind, text, COALESCE(origin,'') AS origin, source, created_at FROM task_constraints WHERE exploration_id=$1 ORDER BY id`, [expID]);
    return {
      constraints: rows.rows.map((r) => ({
        id: String(r["id"]),
        kind: r["kind"],
        text: r["text"],
        origin: r["origin"],
        source: r["source"],
        ts: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : String(r["created_at"]),
      })),
    };
  });

  app.post("/api/tasks/:id/constraints", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const expID = await expOf(Number(p["id"]));
    const res = await db().query(
      `INSERT INTO task_constraints(exploration_id, kind, text, origin) VALUES ($1,$2,$3,'user') RETURNING id, created_at`,
      [expID, String(b["kind"] ?? "deny"), String(b["text"] ?? "")],
    );
    const r = res.rows[0]!;
    return { id: String(r["id"]), kind: b["kind"], text: b["text"], origin: "user", ts: String(r["created_at"]) };
  });

  app.patch("/api/tasks/:id/constraints/:cid", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const changed=await db().query(`UPDATE task_constraints SET kind=$1, text=$2,origin='user',source='{}'::jsonb,updated_at=now() WHERE id=$3 AND exploration_id=$4`, [String(b["kind"] ?? "deny"), String(b["text"] ?? ""), Number(p["cid"]),await expOf(Number(p["id"]))]);
    if(!changed.rowCount)throw Object.assign(new Error("constraint not found"),{statusCode:404});
    return { id: p["cid"], ...b };
  });

  app.delete("/api/tasks/:id/constraints/:cid", async (req) => {
    const p = req.params as Record<string, string>;
    const changed=await db().query(`DELETE FROM task_constraints WHERE id=$1 AND exploration_id=$2`, [Number(p["cid"]),await expOf(Number(p["id"]))]);
    if(!changed.rowCount)throw Object.assign(new Error("constraint not found"),{statusCode:404});
    return { ok: true };
  });

  app.get("/api/tasks/:id/coverage-graph", async (req) => {
    const p = req.params as Record<string, string>;
    const taskID = Number(p["id"]);
    await expOf(taskID);
    return coverageGraph(db(),taskID);
  });

  app.post("/api/tasks/:id/intents/:iid/control", async (req, reply) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const action = String(b["action"] ?? "");
    const taskID = Number(p["id"]);
    const intentID = Number(p["iid"]);
    if (!['pause','resume','cancel'].includes(action)) return reply.code(400).send({error:'未知 action'});
    return app.engine.controlIntent(taskID,intentID,action as 'pause'|'resume'|'cancel',String(b['reason'] ?? ''));
  });

  app.post("/api/tasks/:id/intents/:iid/rerun", async (req) => {
    const p = req.params as Record<string, string>;
    const expID = await expOf(Number(p["id"]));
    const current=await db().exploration(expID).getNode(Number(p["iid"]));
    if(!current)throw Object.assign(new Error("intent not found"),{statusCode:404});
    await app.engine.controlIntent(Number(p["id"]),Number(p["iid"]),"resume");
    const reopened=true;
    return { id: Number(p["id"]), reopened: reopened ? 1 : 0 };
  });

  app.post("/api/tasks/:id/intents/rerun-blocked", async (req) => {
    const p = req.params as Record<string, string>;
    const expID = await expOf(Number(p["id"]));
    const n = await db().exploration(expID).reopenBlockedIntents();
    if(n>0)await app.engine.admitTask(Number(p["id"]));
    return { id: Number(p["id"]), reopened: n };
  });

  app.post("/api/tasks/:id/intents/dispatch", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b["intent_ids"]) ? (b["intent_ids"] as unknown[]).map(Number) : [];
    const results = [];
    for (const id of ids) {
      try { results.push(await app.engine.dispatchIntent(Number(p['id']),id)); }
      catch(error) { results.push({id,status:'error',error:String(error)}); }
    }
    return { results };
  });

  app.patch("/api/tasks/:id/execution-mode", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const mode = String(b["execution_mode"] ?? "managed");
    const expID = await expOf(Number(p["id"]));
    const res = await db().tasks().setExecutionMode(expID, mode === "manual" ? "manual" : "managed");
    return { id: p["id"], execution_mode: mode, changed: res };
  });

  app.get("/api/tasks/:id/llm", async (req) => {
    const id=Number((req.params as {id:string}).id);
    const result=await resolveModelProfiles(db(),id,'worker');
    const task=await db().tasks().getTask(id);
    const rows=await db().query(`SELECT p.id,p.name,p.model,p.format,c.position,c.status,c.last_error,c.exhausted_at FROM task_llm_profiles c JOIN llm_profiles p ON p.id=c.profile_id WHERE c.task_id=$1 ORDER BY c.position`,[id]);
    return {profiles:rows.rows.map(r=>({...r,id:Number(r.id)})),default_profile_id:task?.llm_profile_id??null,
      active_llm_profile_id:result.profiles[0]?.id??null,failover_enabled:rows.rows.length>1};
  });
  app.get("/api/tasks/:id/llm/resolution", async (req) => {
    const id=Number((req.params as {id:string}).id);
    const roles=['mainagent','planner','worker'];
    return Object.fromEntries(await Promise.all(roles.map(async role=>[role,(await resolveModelProfiles(db(),id,role)).resolution])));
  });
  app.get("/api/tasks/:id/llm/attempts",async req=>{
    const id=Number((req.params as {id:string}).id);await expOf(id);
    const q=req.query as {before?:string};
    return {attempts:(await db().query(`SELECT id,role,profile_id,model,status,error,usage,purpose,created_at,finished_at FROM llm_request_attempts WHERE task_id=$1 AND ($2::bigint=0 OR id<$2) ORDER BY id DESC LIMIT 100`,[id,Number(q.before)||0])).rows};
  });

  app.patch("/api/tasks/:id/category", async (req) => {
    const p = req.params as Record<string, string>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    await db().query(`UPDATE tasks SET category_id=$1 WHERE id=$2`, [b["category_id"] ?? null, Number(p["id"])]);
    return { ok: true };
  });

  app.delete("/api/tasks/:id/intents/:iid", async (req) => {
    const p = req.params as Record<string, string>;
    return app.engine.controlIntent(Number(p['id']),Number(p['iid']),'delete');
  });

  // findings 补真（findings-extra 的工厂注册，替代原空壳）
  app.get("/api/exploration/findings/asset-tree", makeFindingsAssetTreeHandler(app));
  app.get("/api/exploration/findings/export", makeFindingsExportHandler(app));

  // ─── 仪表盘 / 审计 ────────────────────────────────────────────────────────

  app.get("/api/stats", async (req) => {
    const a = await db().query<{ n: string }>(`SELECT count(*) AS n FROM assets`);
    const f = await db().query<{ n: string }>(`SELECT count(*) AS n FROM findings WHERE status NOT IN ('false_positive','duplicate','ignored')`);
    const activeID = (req.query as {task?:string}).task ?? await db().platform().getSetting("active_task");
    let activeTask: Record<string, unknown> | undefined;
    if (activeID && Number(activeID) > 0) activeTask = await taskRow(Number(activeID));
    if(activeTask){
      const scheduling=await executionSnapshot(db(),Number(activeTask.id));
      const counts=await db().exploration(Number(activeTask.exploration_id)).executionCounts();
      Object.assign(activeTask,{in_flight:scheduling.task_active,scheduling,goals_total:counts.goals,goals_met:counts.met,engine_mode:activeTask.paused?'paused':scheduling.task_active+scheduling.planning+scheduling.ready>0?'exploring':'idle'});
    }
    const llm = await db().platform().activeProfile().catch(() => null);
    return {
      assets: Number(a.rows[0]?.n ?? 0),
      engine_mode: activeTask?.engine_mode??"idle",
      llm_configured: llm !== null,
      roe_enabled: false,
      findings_confirmed: Number(f.rows[0]?.n ?? 0),
      ...(activeTask ? { active_task: { ...activeTask, id: String(activeTask["id"]) } } : {}),
    };
  });

  app.get("/api/audit", async () => ({ entries: [], attributions: {} }));

  // Counts are unique physical requests. Task-bound conversations are not added twice.
  app.get('/api/exploration/tokens',async req=>{
    const q=req.query as Record<string,string>;
    const expID=await expOf(q2n(q.task,0));
    const task=(await db().query('SELECT id FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL',[expID])).rows[0];
    if(!task)throw Object.assign(new Error('任务不存在'),{statusCode:404});
    const scope={taskID:Number(task.id)};
    const [total,workers,sessions]=await Promise.all([aggregateUsage(db(),scope),aggregateUsage(db(),scope,'worker'),aggregateUsage(db(),scope,'session')]);
    const mainSegments=sessions.filter(r=>String(r.bucket).startsWith('main:'));
    return {total:total[0],workers:workers.map(r=>({...r,worker:r.bucket})),sessions:sessions.map(r=>({...r,session:r.bucket})),
      session_aliases:{main:{session:'main',is_alias:true,alias_of:mainSegments.map(r=>r.bucket),input_tokens:mainSegments.reduce((n,r)=>n+r.input_tokens,0),output_tokens:mainSegments.reduce((n,r)=>n+r.output_tokens,0),cache_read_tokens:mainSegments.reduce((n,r)=>n+r.cache_read_tokens,0),cache_write_tokens:mainSegments.reduce((n,r)=>n+r.cache_write_tokens,0)}},version:'usage-v2'};
  });
  const usageWindow=(q:Record<string,string>,defaultDays:number)=>({days:Math.min(Math.max(q2n(q.days,defaultDays),1),3650)});
  app.get('/api/tokens/usage',async req=>{
    const scope=usageWindow(req.query as Record<string,string>,365);
    const [total,profiles,daily,undated]=await Promise.all([aggregateUsage(db()),aggregateUsage(db(),{},'profile'),aggregateUsage(db(),scope,'profile_day'),aggregateUsage(db(),{timeKnown:false})]);
    return {version:'usage-v2',timezone:'Asia/Shanghai',total_scope:'retained_all_time',daily_days:scope.days,daily_complete:total[0]!.time_unknown_records===0,unassigned_time:undated[0],total:total[0],by_profile:profiles,daily,unverified_history:await unverifiedUsageHistory(db())};
  });
  app.get('/api/tokens/daily',async req=>(await aggregateUsage(db(),usageWindow(req.query as Record<string,string>,30),'day')).map(r=>({...r,day:r.bucket,date:r.bucket})));
  app.get('/api/tokens/conversations',async()=>{
    const usage=await aggregateUsage(db(),{},'conversation');
    const conversations=(await db().query('SELECT id,title,agent_key AS role,task_id FROM conversations')).rows;
    return usage.map(r=>{const c=conversations.find(c=>String(c.id)===r.bucket);return {...r,id:r.bucket,conversation_id:r.bucket,title:c?.title??'已删除',role:c?.role??r.role,deleted:!c,llm_profile_id:r.profile_id,task_id:r.task_id==null?null:String(r.task_id)};});
  });

  app.get("/api/llm/records/by-model", async (req) => {
    const q = req.query as Record<string, string>;
    const taskID=q.task===undefined?undefined:Number(q.task);
    if(taskID!==undefined){
      if(!Number.isSafeInteger(taskID)||taskID<1)throw Object.assign(new Error('任务 ID 无效'),{statusCode:400});
      await expOf(taskID);
    }
    return modelTokenUsage(db(),taskID);
  });
}
