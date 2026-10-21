import {workIdentity,storedWorkIdentity,overlappingWork,directionIdentity,type WorkAsset} from '../agent/work-identity.js';
// 探索图 store：节点/边/锚点、意图指纹去重、advisory-lock 队列领取、状态机、activity 写入。
// 忠实平移自 Go 版 db/exploration.go + db/worker_queue.go 的核心路径；
// 列表/统计类只读方法按需在后续模块补充。

import { createHash } from "node:crypto";
import {normalizeContract,workFingerprint} from '../agent/intent-contract.js';
import type { PoolClient } from "pg";
import type { Database } from "./index.js";

// ─── 常量（db/constants.go / db/execution_mode.go）─────────────────────────

export const KindBegin = "begin";
export const KindGoal = "goal";
export const KindIntent = "intent";
export const KindFact = "fact";
export const KindFinding = "finding";
export const KindHint = "hint";
export const KindDigest = "digest";

export const StateOrigin = "origin";
export const StateDigestActive = "active";
export const StateDigestSuperseded = "superseded";

export const RelSpawns = "spawns";
export const RelDerivedFrom = "derived_from";
export const RelYields = "yields";
export const RelProves = "proves";
export const RelCovers = "covers";

export const EXECUTION_MANAGED = "managed";
export const EXECUTION_MANUAL = "manual";

/** CAS 状态迁移失败（HTTP 409 语义）。 */
export class IntentStateConflictError extends Error {
  constructor(message = "intent state changed concurrently") {
    super(message);
    this.name = "IntentStateConflictError";
  }
}
export class PlannerManualModeError extends Error {
  constructor() {
    super("手工模式下 Planner 已停止规划");
    this.name = "PlannerManualModeError";
  }
}

// ─── 文本/JSONB 清洗（exploration.go utf8Clean/jsonbClean）──────────────────

/** PG text 列安全：去 NUL。JS 字符串本身不会携带非法 UTF-8（驱动层已替换）。 */
export function utf8Clean(s: string): string {
  return s.replace(/\x00/g, "");
}

/** PG jsonb 列安全：剥掉真实的 \u0000 转义（偶数前置反斜杠才算真转义）。 */
export function jsonbClean(b: string): string {
  if (!b.includes("\\u0000")) return b;
  let out = "";
  let bs = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c === "\\" && bs % 2 === 0 && b.slice(i + 1, i + 6) === "u0000") {
      i += 5;
      bs = 0;
      continue;
    }
    if (c === "\\") bs++;
    else bs = 0;
    out += c;
  }
  return out;
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface Node {
  content_version?: number;
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  priority: number;
  state: string;
  origin?: string;
  owner?: string;
  blocked_reason?: string;
  created_at: string;
  // 视图扩展字段（finding 关联读取时填充）
  finding_id?: number;
  source_task_id?: number;
  inherited?: boolean;
}

export function nodeDispatchRequested(n: Node): boolean {
  return n.payload["dispatch_requested"] === true;
}
export function nodeCancelledByUser(n: Node): boolean {
  return n.payload["cancelled_by_user"] === true;
}

export interface Activity {
  id?: number;
  node_id?: number | null;
  worker?: string;
  kind?: string;
  tool?: string;
  tool_use_id?: string;
  is_error?: boolean;
  summary?: string;
  detail?: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  main_seg?: number | null;
}

// ─── SQL 片段（db/main_execution.go / db/execution_mode.go）─────────────────

function intentAssetAllowedSQL(task: string, asset: string, _node: string): string {
  return `task_asset_linked(${task},${asset})`;
}

const INTENT_DISPATCH_PREDICATE =
  ` AND NOT EXISTS (SELECT 1 FROM tasks ended_task WHERE ended_task.exploration_id=exploration_nodes.exploration_id ` +
  `AND (ended_task.deleted_at IS NOT NULL OR ended_task.status IN ('done','failed','timeout'))) ` +
  `AND (payload->>'dispatch_requested'='true' OR NOT EXISTS ` +
  `(SELECT 1 FROM tasks dispatch_task WHERE dispatch_task.exploration_id=exploration_nodes.exploration_id ` +
  `AND dispatch_task.deleted_at IS NULL AND dispatch_task.execution_mode='manual'))`;

const NODE_COLS = `id, kind, payload, priority, state, COALESCE(origin,'') AS origin, COALESCE(owner,'') AS owner, COALESCE(blocked_reason,'') AS blocked_reason, created_at, content_version`;

// ─── 队列事务（worker_queue.go beginQueue：探索级 advisory xact lock）────────

export class QueueTx {
  constructor(private client: PoolClient, private ownsTransaction = true) {}
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) {
    return this.client.query<T>(text, values);
  }
  async commit(): Promise<void> {
    if (this.ownsTransaction) await this.client.query("COMMIT");
  }
  async rollback(): Promise<void> {
    try {
      if (this.ownsTransaction) await this.client.query("ROLLBACK");
    } catch {
      /* already aborted */
    }
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class ExplorationStore {
  readonly expID: number;
  workerRead = false;

  constructor(private db: Database, expID: number) {
    this.expID = expID;
  }

  withWorkerRead(): ExplorationStore {
    const copy = new ExplorationStore(this.db, this.expID);
    copy.workerRead = true;
    return copy;
  }

  private async beginQueue(): Promise<{ tx: QueueTx; release: () => void }> {
    if (this.db.transactionClient) {
      await this.db.query("SELECT pg_advisory_xact_lock($1)", [-this.expID]);
      return { tx: new QueueTx(this.db.transactionClient, false), release: () => {} };
    }
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [-this.expID]);
      const tx = new QueueTx(client);
      return { tx, release: () => client.release() };
    } catch (err) {
      client.release();
      throw err;
    }
  }

  /** 以队列锁执行单条写语句（Go queueExec）。 */
  private async queueExec(text: string, ...values: unknown[]): Promise<number> {
    const { tx, release } = await this.beginQueue();
    try {
      const res = await tx.query(text, values);
      await tx.commit();
      return res.rowCount ?? 0;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      release();
    }
  }

  private mapNode(row: Record<string, unknown>): Node {
    return {
      id: Number(row["id"]),
      content_version: Number(row['content_version']??0),
      kind: String(row["kind"]),
      payload: (row["payload"] as Record<string, unknown>) ?? {},
      priority: Number(row["priority"] ?? 0),
      state: String(row["state"]),
      origin: (row["origin"] as string) || undefined,
      owner: (row["owner"] as string) || undefined,
      blocked_reason: (row["blocked_reason"] as string) || undefined,
      created_at: row["created_at"] instanceof Date ? row["created_at"].toISOString() : String(row["created_at"]),
    };
  }

  // ─── 根与建图 ─────────────────────────────────────────────────────────────

  async root(): Promise<{ description: string; goal: string }> {
    const res = await this.db.query<{ description: string | null; goal: string | null }>(
      `SELECT description, goal FROM explorations WHERE id=$1`,
      [this.expID],
    );
    const row = res.rows[0];
    return { description: row?.description ?? "", goal: row?.goal ?? "" };
  }

  async addNode(
    kind: string,
    payload: Record<string, unknown>,
    priority: number,
    state: string,
    origin: string,
    anchors: number[],
  ): Promise<number> {
    const raw = jsonbClean(JSON.stringify(payload));
    const { tx, release } = await this.beginQueue();
    try {
      const res = await tx.query<{ id: string }>(
        `INSERT INTO exploration_nodes(exploration_id, kind, payload, priority, state, origin)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
        [this.expID, kind, raw, priority, state, origin],
      );
      const id = Number(res.rows[0]!.id);
      for (const a of anchors) {
        await tx.query(`INSERT INTO exploration_anchors(node_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, a]);
      }
      await tx.commit();
      return id;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      release();
    }
  }

  async addIntent(payload: Record<string, unknown>, priority: number, anchors: number[], origin: string): Promise<number> {
    const { id } = await this.addIntentDeduplicated(payload, priority, anchors, origin);
    return id;
  }

  async addGoal(payload: Record<string, unknown>, origin: string): Promise<number> {
    return this.addNode(KindGoal, payload, 0, "open", origin, []);
  }

  async originFactID(): Promise<number> {
    const res = await this.db.query<{ id: string }>(
      `SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='origin' ORDER BY id LIMIT 1`,
      [this.expID],
    );
    return res.rows[0] ? Number(res.rows[0].id) : 0;
  }

  // ─── 意图去重（addIntentDeduplicated）─────────────────────────────────────

  async addIntentDeduplicated(
    payload: Record<string, unknown>,
    priority: number,
    anchors: number[],
    origin: string,
  ): Promise<{ id: number; created: boolean; dedup?:{version:3;strength:string;match?:string;related_intent_ids?:number[]} }> {
    return this.addIntentDeduplicatedInner(payload, priority, anchors, origin, false);
  }

  async addPlannerIntentDeduplicated(
    payload: Record<string, unknown>,
    priority: number,
    anchors: number[],
    origin: string,
  ): Promise<{ id: number; created: boolean; dedup?:{version:3;strength:string;match?:string;related_intent_ids?:number[]} }> {
    return this.addIntentDeduplicatedInner(payload, priority, anchors, origin, true);
  }

  private async addIntentDeduplicatedInner(
    payload: Record<string, unknown>,
    priority: number,
    anchors: number[],
    origin: string,
    requireManaged: boolean,
  ): Promise<{ id: number; created: boolean; dedup?:{version:3;strength:string;match?:string;related_intent_ids?:number[]} }> {
    if (origin === "") origin = "planner";
    const summary = typeof payload["summary"] === "string" ? payload["summary"] : "";
    const contract = normalizeContract(payload.contract,summary);
    const fingerprint = workFingerprint(contract,anchors) ?? intentFingerprint(summary, anchors);
    payload = {...payload,contract};
    if (fingerprint === "" && !requireManaged) {
      const id = await this.addNode(KindIntent, payload, priority, "open", origin, anchors);
      return { id, created: true };
    }

    const { tx, release } = await this.beginQueue();
    try {
      if (requireManaged) {
        const modeRes = await tx.query<{ mode: string }>(
          `SELECT COALESCE((SELECT execution_mode FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL), 'managed') AS mode`,
          [this.expID],
        );
        if (modeRes.rows[0]?.mode === EXECUTION_MANUAL) throw new PlannerManualModeError();
      }
      for(const ref of contract.basis){
        const basis=await tx.query(`SELECT 1 FROM exploration_nodes n WHERE n.id=$2 AND n.content_version=$3 AND n.kind IN ('fact','finding') AND n.state IN ('confirmed','origin')
          AND (n.exploration_id=$1 OR n.exploration_id IN (SELECT src.exploration_id FROM tasks current JOIN task_relations r ON r.task_id=current.id JOIN tasks src ON src.id=r.source_task_id WHERE current.exploration_id=$1 AND src.deleted_at IS NULL))
          AND exploration_node_readable(n.exploration_id,n.id)`,[this.expID,ref.node_id,ref.version]);
        if(!basis.rowCount)throw new Error(`依据 #${ref.node_id} 已变化或不再授权，请刷新上下文后重新规划`);
      }
      const rows = await tx.query<{ id: string; state:string; payload: Record<string, unknown>; anchors: string }>(
        `SELECT n.id, n.state, n.payload,
                COALESCE((SELECT json_agg(a.asset_id ORDER BY a.asset_id) FROM exploration_anchors a WHERE a.node_id=n.id), '[]'::json)::text AS anchors
         FROM exploration_nodes n
         WHERE n.exploration_id=$1 AND n.kind='intent'
         ORDER BY CASE WHEN n.state IN ('open','running','paused') THEN 0 ELSE 1 END,n.id DESC`,
        [this.expID],
      );
      const allAssets=new Set(anchors);
      const collectResource=(contract:unknown)=>{const match=/^asset:([1-9][0-9]*)$/.exec(String((contract as {work?:{resource?:string}}|undefined)?.work?.resource??''));if(match)allAssets.add(Number(match[1]));};
      collectResource(contract);
      for(const row of rows.rows){for(const id of JSON.parse(row.anchors) as number[])allAssets.add(id);collectResource(row.payload.contract);}
      const assetRows=allAssets.size?(await tx.query('SELECT id,type,url,method,params,domain,ip,port FROM assets WHERE id=ANY($1::bigint[])',[[...allAssets]])).rows:[];
      const assetMap=new Map<number,WorkAsset>(assetRows.map(a=>[Number(a.id),{...a,id:Number(a.id),type:String(a.type)} as WorkAsset]));
      const identity=workIdentity(contract,summary,anchors,assetMap);
      const rowIdentities=new Map(rows.rows.map(row=>[row.id,storedWorkIdentity(row.payload.work_identity)??workIdentity(normalizeContract(row.payload.contract,String(row.payload.summary??'')),String(row.payload.summary??''),(row.payload.dispatch_asset_ids??row.payload.asset_ids??JSON.parse(row.anchors)) as number[],assetMap)]));
      const sameWork=(row:typeof rows.rows[number])=>{
        const old=rowIdentities.get(row.id)!;
        return old.key===identity.key || ((!contract.work || !(row.payload.contract as {work?:unknown}|undefined)?.work) &&
          directionIdentity(String(row.payload.summary??''))===directionIdentity(summary) && JSON.stringify(old.targets)===JSON.stringify(identity.targets));
      };
      if(payload.retry_of){
        const previous=rows.rows.find(row=>Number(row.id)===Number(payload.retry_of));
        if(!previous||!sameWork(previous))throw new Error('retry_of 必须指向本任务的同一项工作');
      }
      for (const row of rows.rows) {
        const existing = row.payload ?? {};
        if (sameWork(row)) {
          if(payload.retry_of && existing.cancelled_by_user===true)throw new Error('用户已取消此意图，不能借重试绕过');
          if(payload.retry_of && Number(payload.retry_of)===Number(row.id) && !['open','running','paused'].includes(row.state)){
            const reason=payload.retry_reason;
            if(typeof reason!=='string'||!reason.trim())throw new Error('重试必须说明原因');
            if(payload.retry_kind==='transient_failure' && ['blocked','exhausted','stopped'].includes(row.state))break;
            const oldBasis=(existing.contract as {basis?:{node_id:number;version:number}[]}|undefined)?.basis??[];
            if(payload.retry_kind==='new_evidence' && contract.basis.some(ref=>!oldBasis.some(old=>old.node_id===ref.node_id&&old.version===ref.version)))break;
            throw new Error('重试需可恢复故障或新的有效事实依据');
          }
          await tx.commit();
          return { id: Number(row.id), created: false, dedup:{version:3,strength:identity.strength,match:"equivalent_work"} };
        }
      }

      if(payload.retry_of && !rows.rows.some(row=>Number(row.id)===Number(payload.retry_of)))throw new Error('retry_of 必须属于本任务');

      const related=rows.rows.filter(row=>(['open','running','paused'].includes(row.state)||row.payload.cancelled_by_user===true)&&overlappingWork(identity,rowIdentities.get(row.id)!));
      const stopped=related.find(row=>row.state==='paused'||row.payload.cancelled_by_user===true);
      if(stopped)throw new Error(`方向与用户暂停或取消的意图 #${stopped.id} 重叠，不能借新意图绕过；先读取原意图及用户限制。`);
      const stored: Record<string, unknown> = { ...payload, fingerprint,work_identity:identity,dispatch_asset_ids:[...new Set(anchors)].sort((a,b)=>a-b) };
      const cleanAnchors = [...new Set(anchors.filter((a) => a > 0))].sort((a, b) => a - b);
      if (cleanAnchors.length > 0) stored["asset_ids"] = cleanAnchors;
      const raw = jsonbClean(JSON.stringify(stored));
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO exploration_nodes(exploration_id, kind, payload, priority, state, origin)
         VALUES ($1, 'intent', $2::jsonb, $3, 'open', $4) RETURNING id`,
        [this.expID, raw, priority, origin],
      );
      const id = Number(ins.rows[0]!.id);
      for (const assetID of cleanAnchors) {
        await tx.query(`INSERT INTO exploration_anchors(node_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, assetID]);
      }
      await tx.commit();
      return { id, created: true, dedup:{version:3,strength:identity.strength,...(related.length?{related_intent_ids:related.map(row=>Number(row.id))}:{})} };
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      release();
    }
  }

  // ─── 锚点与边 ─────────────────────────────────────────────────────────────

  async anchor(nodeID: number, assetID: number): Promise<void> {
    if (nodeID <= 0 || assetID <= 0) return;
    await this.queueExec(`INSERT INTO exploration_anchors(node_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, nodeID, assetID);
  }

  async anchorAssetIDs(nodeID: number): Promise<number[]> {
    if (nodeID <= 0) return [];
    const res = await this.db.query<{ asset_id: string }>(
      `SELECT anchor.asset_id FROM exploration_anchors anchor
       JOIN exploration_nodes node ON node.id=anchor.node_id AND node.exploration_id=$2
       WHERE anchor.node_id=$1 ORDER BY anchor.asset_id`,
      [nodeID, this.expID],
    );
    return res.rows.map((r) => Number(r.asset_id));
  }

  async lineageAnchorAssetIDsForNodes(nodeIDs: number[]): Promise<Map<number, number[]>> {
    const byNode = new Map<number, number[]>();
    if (nodeIDs.length === 0) return byNode;
    const res = await this.db.query<{ root_id: string; asset_id: string }>(
      `WITH RECURSIVE lineage(root_id,id) AS (
         SELECT id,id FROM exploration_nodes WHERE id=ANY($1::bigint[]) AND exploration_id=$2
         UNION
         SELECT child.root_id,edge.src_id
         FROM exploration_edges edge
         JOIN lineage child ON child.id=edge.dst_id
         WHERE edge.exploration_id=$2
       )
       SELECT DISTINCT lineage.root_id,anchor.asset_id
       FROM lineage
       JOIN exploration_anchors anchor ON anchor.node_id=lineage.id
       ORDER BY lineage.root_id,anchor.asset_id`,
      [nodeIDs, this.expID],
    );
    for (const row of res.rows) {
      const root = Number(row.root_id);
      const list = byNode.get(root) ?? [];
      list.push(Number(row.asset_id));
      byNode.set(root, list);
    }
    return byNode;
  }

  async lineageAnchorAssetIDs(nodeID: number): Promise<number[]> {
    return (await this.lineageAnchorAssetIDsForNodes([nodeID])).get(nodeID) ?? [];
  }

  async link(from: number, rel: string, to: number): Promise<void> {
    await this.queueExec(
      `INSERT INTO exploration_edges(exploration_id, src_id, rel, dst_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (exploration_id, src_id, rel, dst_id) DO NOTHING`,
      this.expID, from, rel, to,
    );
  }

  // ─── 状态机 ───────────────────────────────────────────────────────────────

  async setNodeState(id: number, state: string): Promise<void> {
    await this.queueExec(
      `UPDATE exploration_nodes SET state=$1, blocked_reason=NULL, content_version=content_version+1
       WHERE id=$2 AND exploration_id=$3 AND (kind<>'intent' OR payload->>'cancelled_by_user' IS DISTINCT FROM 'true')`,
      state, id, this.expID,
    );
  }

  async updateGoalPayload(id: number, text: string, vulnclass: string): Promise<void> {
    const payload: Record<string, unknown> = { text };
    if (vulnclass !== "") payload["vulnclass"] = vulnclass;
    const n = await this.queueExec(
      `UPDATE exploration_nodes SET payload=$1::jsonb WHERE id=$2 AND exploration_id=$3 AND kind='goal'`,
      jsonbClean(JSON.stringify(payload)), id, this.expID,
    );
    if (n === 0) throw new Error("目标不存在");
  }

  async deleteGoal(id: number): Promise<void> {
    const n = await this.queueExec(`DELETE FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='goal'`, id, this.expID);
    if (n === 0) throw new Error("目标不存在");
  }

  async resetRunningIntents(): Promise<number> {
    return this.queueExec(
      `UPDATE exploration_nodes SET state='open', completed_at=NULL, blocked_reason=NULL,
       payload=payload||jsonb_build_object('resume_requested',true,'execution_stop',jsonb_build_object(
         'version',1,'reason','executor_recovered','summary','原执行器不可用，由新租约恢复',
         'recorded_at',now(),'accepted_result',false,
         'recovery','先核对已保存事实、工具结果和检查点，仅继续未完成的验收；不得重复已成功的操作。已提交结果由宿主重新验收。'
           ||CASE WHEN payload->'progress'->>'next_step' IS NOT NULL THEN ' 上次检查点记录（可能早于事实写回）：'||(payload->'progress'->>'next_step') ELSE '' END))
       WHERE exploration_id=$1 AND kind='intent' AND state='running' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'`,
      this.expID,
    );
  }

  async reopenIntent(id: number): Promise<boolean> {
    const n = await this.queueExec(
      `UPDATE exploration_nodes SET state='open', completed_at=NULL, blocked_reason=NULL,
         payload=CASE WHEN payload ? 'execution_result' THEN (payload-'execution_result'-'execution_result_basis')||jsonb_build_object('previous_result',payload->'execution_result') ELSE payload END
       WHERE id=$1 AND exploration_id=$2 AND kind='intent'
         AND state IN ('paused','blocked','exhausted','stopped') AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'`,
      id, this.expID,
    );
    return n > 0;
  }

  async reopenBlockedIntents(): Promise<number> {
    return this.queueExec(
      `UPDATE exploration_nodes SET state='open', completed_at=NULL, blocked_reason=NULL,
         payload=CASE WHEN payload ? 'execution_result' THEN (payload-'execution_result'-'execution_result_basis')||jsonb_build_object('previous_result',payload->'execution_result') ELSE payload END
       WHERE exploration_id=$1 AND kind='intent' AND state='blocked' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'`,
      this.expID,
    );
  }

  private isTerminalIntentState(state: string): boolean {
    return state === "done" || state === "blocked" || state === "exhausted" || state === "stopped";
  }

  async setIntentState(id: number, state: string): Promise<void> {
    const terminal = this.isTerminalIntentState(state);
    await this.queueExec(
      `UPDATE exploration_nodes
       SET state=$1, blocked_reason=NULL, content_version=content_version+1, completed_at = CASE WHEN $4 THEN now() ELSE NULL END
       WHERE id=$2 AND exploration_id=$3 AND kind='intent' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'`,
      state, id, this.expID, terminal,
    );
  }

  async compareAndSetIntentState(id: number, expected: string, state: string): Promise<boolean> {
    const terminal = this.isTerminalIntentState(state);
    const n = await this.queueExec(
      `UPDATE exploration_nodes
       SET state=$1, blocked_reason=NULL, content_version=content_version+1, completed_at = CASE WHEN $5 THEN now() ELSE NULL END
       WHERE id=$2 AND exploration_id=$3 AND kind='intent' AND state=$4 AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'`,
      state, id, this.expID, expected, terminal,
    );
    return n === 1;
  }

  // ─── 读取 ─────────────────────────────────────────────────────────────────

  async getNode(id: number): Promise<Node | null> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${NODE_COLS} FROM exploration_nodes WHERE exploration_id=$1 AND id=$2`,
      [this.expID, id],
    );
    return res.rows[0] ? this.mapNode(res.rows[0]) : null;
  }

  async nodesByIDs(ids: number[]): Promise<Node[]> {
    if (ids.length === 0) return [];
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${NODE_COLS} FROM exploration_nodes WHERE exploration_id=$1 AND id=ANY($2::bigint[]) ORDER BY id`,
      [this.expID, ids],
    );
    return res.rows.map((r) => this.mapNode(r));
  }

  async listByKind(kind: string, limit = 500): Promise<Node[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${NODE_COLS} FROM exploration_nodes WHERE exploration_id=$1 AND kind=$2 ORDER BY id DESC LIMIT $3`,
      [this.expID, kind, limit],
    );
    return res.rows.map((r) => this.mapNode(r));
  }

  async frontier(limit = 50): Promise<Node[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT ${NODE_COLS} FROM exploration_nodes
       WHERE exploration_id=$1 AND kind='intent' AND state='open' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'
       ORDER BY CASE WHEN (SELECT worker_queue_manual FROM explorations WHERE id=$1) THEN queue_position ELSE 0 END,
                CASE WHEN (SELECT worker_queue_manual FROM explorations WHERE id=$1) THEN 0 ELSE priority END DESC, id ASC LIMIT $2`,
      [this.expID, limit],
    );
    return res.rows.map((r) => this.mapNode(r));
  }

  async hasActiveIntent(): Promise<boolean> {
    const res = await this.db.query<{ ok: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND state IN ('open','running')) AS ok`,
      [this.expID],
    );
    return res.rows[0]?.ok === true;
  }

  async hasRunningIntent(): Promise<boolean> {
    const res = await this.db.query<{ ok: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND state='running') AS ok`,
      [this.expID],
    );
    return res.rows[0]?.ok === true;
  }

  async hasOpenIntent(): Promise<boolean> {
    const res = await this.db.query<{ ok: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM exploration_nodes
       WHERE exploration_id=$1 AND kind='intent' AND state='open' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'
       AND NOT EXISTS(SELECT 1 FROM exploration_anchors ea JOIN tasks t ON t.exploration_id=$1
       WHERE ea.node_id=exploration_nodes.id AND NOT ${intentAssetAllowedSQL("t.id", "ea.asset_id", "exploration_nodes")})) AS ok`,
      [this.expID],
    );
    return res.rows[0]?.ok === true;
  }

  async executionCounts(): Promise<{ running: number; goals: number; met: number }> {
    const res = await this.db.query<{ running: string; goals: string; met: string }>(
      `SELECT count(*) FILTER (WHERE kind='intent' AND state='running') AS running,
              count(*) FILTER (WHERE kind='goal') AS goals,
              count(*) FILTER (WHERE kind='goal' AND state='met') AS met
       FROM exploration_nodes WHERE exploration_id=$1 AND kind IN ('intent','goal')`,
      [this.expID],
    );
    const row = res.rows[0];
    return { running: Number(row?.running ?? 0), goals: Number(row?.goals ?? 0), met: Number(row?.met ?? 0) };
  }

  // ─── Worker 队列（worker_queue.go）────────────────────────────────────────

  private async queueSnapshot(tx: QueueTx): Promise<{ executionMode: string; version: number; manual: boolean; items: Node[] }> {
    const meta = await tx.query<{ worker_queue_manual: boolean; worker_queue_version: number }>(
      `SELECT worker_queue_manual, worker_queue_version FROM explorations WHERE id=$1`,
      [this.expID],
    );
    const m = meta.rows[0]!;
    const modeRes = await tx.query<{ mode: string }>(
      `SELECT COALESCE((SELECT execution_mode FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL),'managed') AS mode`,
      [this.expID],
    );
    const res = await tx.query<Record<string, unknown>>(
      `SELECT ${NODE_COLS} FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND state='open'
       AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'
       ORDER BY CASE WHEN $2 THEN queue_position ELSE 0 END, CASE WHEN $2 THEN 0 ELSE priority END DESC,id`,
      [this.expID, m.worker_queue_manual],
    );
    return {
      executionMode: modeRes.rows[0]?.mode ?? EXECUTION_MANAGED,
      version: Number(m.worker_queue_version),
      manual: m.worker_queue_manual,
      items: res.rows.map((r) => this.mapNode(r)),
    };
  }

  async workerQueue(): Promise<{ executionMode: string; version: number; manual: boolean; items: Node[] }> {
    const { tx, release } = await this.beginQueue();
    try {
      const q = await this.queueSnapshot(tx);
      await tx.commit();
      return q;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      release();
    }
  }

  async moveWorker(id: number, before: number | null, version: number): Promise<{ executionMode: string; version: number; manual: boolean; items: Node[] }> {
    const { tx, release } = await this.beginQueue();
    try {
      const q = await this.queueSnapshot(tx);
      if (q.version !== version) throw new IntentStateConflictError();
      const moving = q.items.find((n) => n.id === id);
      const remaining = q.items.filter((n) => n.id !== id);
      const validTarget = before === null || q.items.some((n) => n.id === before);
      if (!moving || !validTarget || before === id) throw new IntentStateConflictError();
      const ordered: Node[] = [];
      for (const n of remaining) {
        if (before !== null && n.id === before) ordered.push(moving!);
        ordered.push(n);
      }
      if (before === null) ordered.push(moving!);
      await tx.query(`UPDATE explorations SET worker_queue_manual=true,worker_queue_version=worker_queue_version+1 WHERE id=$1`, [this.expID]);
      for (let i = 0; i < ordered.length; i++) {
        await tx.query(`UPDATE exploration_nodes SET queue_position=$1 WHERE id=$2 AND exploration_id=$3`, [i + 1, ordered[i]!.id, this.expID]);
      }
      const q2 = await this.queueSnapshot(tx);
      await tx.commit();
      return q2;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      release();
    }
  }

  /** 快照与认领同事务：重排无法使 frontier 快照失效；CAS open→running 原子领取。 */
  async claimNextWorker(owner: string, eligible?: (n: Node) => boolean): Promise<Node | null> {
    const { tx, release } = await this.beginQueue();
    try {
      const q = await this.queueSnapshot(tx);
      for (const n of q.items) {
        if (q.executionMode === EXECUTION_MANUAL && !nodeDispatchRequested(n)) continue;
        if (eligible && !eligible(n)) continue;
        if(n.payload.needs_replanning===true)continue;
        const contract=normalizeContract(n.payload.contract,String(n.payload.summary??''));
        let stale=false;
        for(const ref of contract.basis){
          // A resumed attempt continues its original session against current
          // evidence. Version changes do not strand it, but deleted/revoked or
          // no-longer-confirmed evidence still requires fresh planning.
          if(!(await tx.query("SELECT 1 FROM exploration_nodes n WHERE n.id=$1 AND ($4::boolean OR n.content_version=$2) AND n.kind IN ('fact','finding') AND n.state IN ('confirmed','origin') AND exploration_node_readable(n.exploration_id,n.id) AND (n.exploration_id=$3 OR n.exploration_id IN (SELECT src.exploration_id FROM tasks current JOIN task_relations r ON r.task_id=current.id JOIN tasks src ON src.id=r.source_task_id WHERE current.exploration_id=$3 AND src.deleted_at IS NULL))",[ref.node_id,ref.version,this.expID,n.payload.resume_requested===true])).rowCount){stale=true;break;}
        }
        if(stale){await tx.query("UPDATE exploration_nodes SET payload=payload||'{\"needs_replanning\":true}'::jsonb WHERE id=$1",[n.id]);continue;}
        if(q.executionMode!==EXECUTION_MANUAL&&n.origin==='planner'&&n.payload.resume_requested!==true&&n.payload.dispatch_source!=='mainagent'){
          // Serialize the final goal proof with the actual claim, not only the
          // earlier reservation. No new automatic work after goal completion.
          const met=await tx.query("SELECT 1 WHERE EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind='goal') AND NOT EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind='goal' AND state<>'met')",[this.expID]);
          if(met.rowCount)continue;
        }
        const res = await tx.query(
          `UPDATE exploration_nodes SET state='running',owner=$1,payload=payload || jsonb_build_object('dispatch_requested',true)
           WHERE id=$2 AND exploration_id=$3 AND state='open' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'
           AND NOT EXISTS (SELECT 1 FROM exploration_anchors ea JOIN tasks t ON t.exploration_id=exploration_nodes.exploration_id AND t.deleted_at IS NULL
            WHERE ea.node_id=exploration_nodes.id AND NOT ${intentAssetAllowedSQL("t.id", "ea.asset_id", "exploration_nodes")})${INTENT_DISPATCH_PREDICATE}`,
          [owner, n.id, this.expID],
        );
        if ((res.rowCount ?? 0) === 1) {
          await tx.commit();
          return n;
        }
      }
      await tx.commit();
      return null;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      release();
    }
  }

  // ─── Activity（appendActivity 平移）───────────────────────────────────────

  async appendActivity(a: Activity): Promise<number> {
    if(!this.db.transactionClient)return this.db.transaction(db=>db.exploration(this.expID).appendActivity(a));
    await this.db.query("SELECT pg_advisory_xact_lock($1)",[-this.expID]);
    const tokens = a.kind === "result";
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO activity(exploration_id, node_id, worker, kind, tool, tool_use_id, is_error, summary, detail, metadata,
                            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, main_seg)
       VALUES ($1,$2,NULLIF($3,''),$4,NULLIF($5,''),NULLIF($6,''),$7,NULLIF($8,''),$9,$10::jsonb,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        this.expID,
        a.node_id ?? null,
        utf8Clean(a.worker ?? ""),
        a.kind ?? null,
        utf8Clean(a.tool ?? ""),
        a.tool_use_id ?? null,
        a.is_error ?? false,
        utf8Clean(a.summary ?? "").slice(0, 20000),
        utf8Clean(a.detail ?? ""),
        a.metadata ? jsonbClean(JSON.stringify(a.metadata)) : "{}",
        tokens ? (a.input_tokens ?? null) : null,
        tokens ? (a.output_tokens ?? null) : null,
        tokens ? (a.cache_read_tokens ?? null) : null,
        tokens ? (a.cache_write_tokens ?? null) : null,
        a.main_seg ?? null,
      ],
    );
    return Number(res.rows[0]!.id);
  }
}

// ─── 意图指纹（IntentFingerprint 平移）──────────────────────────────────────

export function intentFingerprint(summary: string, anchors: number[]): string {
  const normalized = directionIdentity(summary);
  if (normalized === "") return "";
  const ids = [...new Set(anchors.filter((a) => a > 0))].sort((a, b) => a - b);
  const key = normalized + "\x00" + JSON.stringify(ids);
  return createHash("sha256").update(key, "utf8").digest("hex");
}
