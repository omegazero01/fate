import {queryAssets,assetCounts,AssetRow} from '../../db/asset-query.js';
import {writeAssets,AssetInputError} from '../../db/asset-write.js';
// 资产/公司/任务范围/覆盖度路由。
// 资产列表/公司列表是只读投影（AssetStore 的写路径与 mapAsset 宽列留在工具侧使用），
// 直接 SQL 取需要的列；task scope 与 coverage 走 db.taskScope()。

import type { FastifyInstance } from "fastify";
import { TaskAssetInvalidError, TaskAssetTaskNotFoundError } from "../../db/task_scope.js";

export function registerAssetRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  app.get('/api/assets',async(req)=>{
    const q=req.query as Record<string,string>,taskID=Number(q.task_id??0);
    if(!Number.isSafeInteger(taskID)||taskID<0)throw new AssetInputError('task_id 无效');
    if(q.tested&&!['true','false','all'].includes(q.tested))throw new AssetInputError('tested 必须为 all/true/false');
    const ids=q.id===undefined?undefined:q.id.split(',').map(Number);
    if(ids?.some(id=>!Number.isSafeInteger(id)||id<=0))throw new AssetInputError('id 无效');
    return queryAssets(db(),{taskID,ids,type:q.type,dsl:q.dsl,companyID:Number(q.company_id)||undefined,tested:q.tested==='true'?true:q.tested==='false'?false:undefined,limit:Math.min(500,Number(q.limit)||50),offset:Number(q.offset)||0});
  });
  app.get('/api/assets/counts',async(req)=>{
    const q=req.query as Record<string,string>,taskID=Number(q.task_id??0);
    if(!Number.isSafeInteger(taskID)||taskID<0||q.task_id!==undefined&&taskID===0)throw new AssetInputError('task_id 无效');
    return assetCounts(db(),taskID);
  });
  app.post('/api/assets',async(req)=>{
    const b=req.body as AssetRow,taskID=Number(b.task_id??0);
    if(!Number.isSafeInteger(taskID)||taskID<0||!Array.isArray(b.assets)||!b.assets.length)throw new AssetInputError('需要有效 task_id 和非空 assets 数组');
    return writeAssets(db(),b.assets,{taskID,agent:'user',user:true});
  });

  // GET /api/companies — 公司列表（含资产计数，前端企业页最小面）。
  app.get("/api/companies", async () => {
    const res = await db().query(
      `SELECT c.id, c.name, COALESCE(c.logo,'') AS logo,
              (SELECT count(*) FROM assets a WHERE a.company_id=c.id) AS asset_count
       FROM companies c ORDER BY c.id`,
    );
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      name: String(r["name"]),
      logo: String(r["logo"] ?? ""),
      asset_count: Number(r["asset_count"] ?? 0),
    }));
  });

  // ─── 任务范围（scope）与覆盖度 ─────────────────────────────────────────────

  function scopeDTO(r: Record<string, unknown>): Record<string, unknown> {
    return {
      id: r["id"] === undefined ? undefined : Number(r["id"]),
      task_id: Number(r["task_id"] ?? 0),
      kind: String(r["kind"] ?? ""),
      company_id: r["company_id"] === null || r["company_id"] === undefined ? null : Number(r["company_id"]),
      company_name: r["company_name"] ?? "",
      domain: r["domain"] ?? "",
      net: r["net"] ?? "",
      value: r["value"] ?? "",
      source: r["source"] ?? "",
      reason: r["reason"] ?? "",
    };
  }

  app.get("/api/tasks/:id/scope", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const task = await db().tasks().getTask(taskID);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const rows = await db().taskScope().listTaskScope(taskID);
    return { scope: rows.map((r) => scopeDTO(r as unknown as Record<string, unknown>)) };
  });

  // POST /api/tasks/:id/scope — 手动新增测试范围 {kind,value,reason}。
  const addScope = async (
    req: { params: unknown; body?: unknown },
    reply: { code(c: number): { send(v: unknown): unknown } },
  ): Promise<unknown> => {
    const taskID = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof b["kind"] === "string" ? b["kind"] : "";
    const value = typeof b["value"] === "string" ? b["value"] : "";
    const reason = typeof b["reason"] === "string" ? b["reason"] : "";
    if (kind === "" || value === "") return reply.code(400).send({ error: "kind/value 不能为空" });
    try {
      // HTTP/UI 手工登记的测试范围，source 为 manual，同时关联匹配资产。
      const ts = await db().taskScope().addAgentScope(taskID, kind, value, reason, "manual");
      return reply.code(201).send(scopeDTO(ts as unknown as Record<string, unknown>));
    } catch (err) {
      if (err instanceof TaskAssetTaskNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof TaskAssetInvalidError) return reply.code(400).send({ error: err.message });
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post("/api/tasks/:id/scope", async (req, reply) => addScope(req, reply));
  app.post("/api/task/:id/scope", async (req, reply) => addScope(req, reply)); // M5 规格单数路径别名

  app.delete("/api/tasks/:id/scope/:sid", async (req) => {
    const taskID = Number((req.params as { id: string }).id);
    const sid = Number((req.params as { sid: string }).sid);
    const ok = await db().taskScope().deleteTaskScope(taskID, sid);
    return { ok };
  });

  app.get("/api/tasks/:id/coverage", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const task = await db().tasks().getTask(taskID);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const cov = await db().taskScope().taskCoverage(taskID, task.exploration_id);
    return {
      enabled: cov.enabled,
      scope_rows: cov.scopeRows,
      denominator: cov.denominator,
      tested: cov.tested,
      coverage_basis: cov.coverage_basis,
      legacy_unverified: cov.legacy_unverified,
      pct: cov.pct,
      by_type: cov.byType.map((b) => ({ type: b.type, total: b.total, tested: b.tested })),
    };
  });
}
