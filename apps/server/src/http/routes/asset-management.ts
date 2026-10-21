// 任务资产关联、范围登记及企业/资产管理。
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ScopeInput } from "../../db/assets.js";
import {
  CompanyNameConflictError,
  CompanyNotFoundError,
  parseScopeInput,
} from "../../db/assets.js";
import {
  TaskAssetInvalidError,
  TaskAssetNotFoundError,
  TaskAssetTaskNotFoundError,
  normalizeTaskAssetIDs,
} from "../../db/task_scope.js";

/** 企业范围编辑互斥锁（db/companies.go companyScopeMutationLock；与 store 内字面量一致）。 */
const COMPANY_SCOPE_MUTATION_LOCK = 7337741003;


function str(v: unknown, def = ""): string {
  return typeof v === "string" ? v : def;
}

/** TaskAsset* 错误 → HTTP 状态映射（资产关联）。 */
function taskAssetErrorReply(err: unknown, reply: FastifyReply): unknown {
  if (err instanceof TaskAssetTaskNotFoundError) return reply.code(404).send({ error: "任务不存在" });
  if (err instanceof TaskAssetNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof TaskAssetInvalidError) return reply.code(400).send({ error: err.message });
  return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
}

async function taskExists(app: FastifyInstance, taskID: number): Promise<boolean> {
  const res = await app.db.query<{ ok: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL) AS ok`,
    [taskID],
  );
  return res.rows[0]?.ok === true;
}

export function registerAssetManagementRoutes(app: FastifyInstance): void {
  const db = () => app.db;
  const scopeStore = () => app.db.taskScope();

  const postTaskAssets = async (req: { params: unknown; body?: unknown }, reply: FastifyReply): Promise<unknown> => {
    const taskID = Number((req.params as { id: string }).id);
    if (!(await taskExists(app, taskID))) return reply.code(404).send({ error: "任务不存在" });
    const b = (req.body ?? {}) as Record<string, unknown>;

    if (Array.isArray(b["scope"])) {
      const rules = b["scope"] as unknown[];
      if (rules.length === 0) return reply.code(400).send({ error: "请填写有效测试范围" });
      const reason = typeof b["reason"] === "string" && b["reason"] !== "" ? b["reason"] : "用户在测试资产页手工新增";
      // 先整体校验（企业范围同一套解析规则），再逐条写入——无效输入不落半截。
      for (let i = 0; i < rules.length; i++) {
        const item = rules[i] as { kind?: unknown; value?: unknown };
        const value = str(item?.["value"]);
        try {
          parseScopeInput({ kind: str(item?.["kind"]) || undefined, value });
        } catch (err) {
          return reply
            .code(400)
            .send({ error: `第 ${i + 1} 条范围无效：${err instanceof Error ? err.message : String(err)}` });
        }
      }
      const before = await db().query<{ ids: string; links: string }>(
        `SELECT (SELECT count(*) FROM task_scope WHERE task_id=$1)::text AS ids,
                (SELECT count(*) FROM task_asset_links WHERE task_id=$1)::text AS links`,
        [taskID],
      );
      const scopeRows: { kind: string; domain?: string; net?: string; company_id?: number | null }[] = [];
      for (let i = 0; i < rules.length; i++) {
        const item = rules[i] as { kind?: unknown; value?: unknown };
        const kindRaw = str(item?.["kind"]);
        const value = str(item?.["value"]).trim();
        // 企业范围 kind（domain）→ 任务范围 kind（root_domain）；其余同名复用 addAgentScope 的归一化。
        const kind = kindRaw === "domain" ? "root_domain" : kindRaw;
        try {
          const ts = await scopeStore().addAgentScope(taskID, kind, value, reason, "manual");
          scopeRows.push(ts);
        } catch (err) {
          return reply
            .code(400)
            .send({ error: `第 ${i + 1} 条范围无效：${err instanceof Error ? err.message : String(err)}` });
        }
      }
      const after = await db().query<{ ids: string; links: string }>(
        `SELECT (SELECT count(*) FROM task_scope WHERE task_id=$1)::text AS ids,
                (SELECT count(*) FROM task_asset_links WHERE task_id=$1)::text AS links`,
        [taskID],
      );
      const scopesAdded = Number(after.rows[0]?.ids ?? 0) - Number(before.rows[0]?.ids ?? 0);
      const linksBefore = Number(before.rows[0]?.links ?? 0);
      const linksAfter = Number(after.rows[0]?.links ?? 0);
      // 范围命中的已挂资产数（domain/net 条件 OR 连接）。
      const conds: string[] = [];
      const args: unknown[] = [taskID];
      for (const ts of scopeRows) {
        if (ts.kind === "company" && ts.company_id) {
          args.push(ts.company_id);
          conds.push(`a.company_id=$${args.length}`);
        } else if ((ts.kind === "root_domain" || ts.kind === "subdomain") && ts.domain) {
          args.push(ts.domain);
          conds.push(`a.root_domain=$${args.length} OR a.domain=$${args.length}`);
        } else if ((ts.kind === "ip" || ts.kind === "cidr") && ts.net) {
          args.push(ts.net);
          conds.push(`(try_inet(a.ip) IS NOT NULL AND $${args.length}::cidr >>= try_inet(a.ip))`);
        }
      }
      let assetsExisting = 0;
      if (conds.length > 0) {
        const matched = await db().query<{ n: string }>(
          `SELECT count(*) AS n FROM assets a WHERE (${conds.join(" OR (")})${")".repeat(conds.length - 1)}
           AND EXISTS(SELECT 1 FROM task_asset_links l WHERE l.task_id=$1 AND l.asset_id=a.id)`,
          args,
        );
        assetsExisting = Math.max(0, Number(matched.rows[0]?.n ?? 0) - (linksAfter - linksBefore));
      }
      return {
        requested: rules.length,
        assets_linked: linksAfter - linksBefore,
        assets_existing: assetsExisting,
        scopes_added: scopesAdded,
        scopes_existing: rules.length - scopesAdded,
      };
    }

    const rawIDs = Array.isArray(b["asset_ids"]) ? b["asset_ids"].map(Number) : [];
    const sourceSummary = str(b["source_summary"]).trim();
    let ids: number[];
    try {
      ids = normalizeTaskAssetIDs(rawIDs);
    } catch (err) {
      return taskAssetErrorReply(err, reply);
    }
    if (sourceSummary === "") return reply.code(400).send({ error: "请选择资产并填写来源说明" });
    const client = await db().pool.connect();
    let attached = 0;
    let existing = 0;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      const task = await client.query<{ ok: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL) AS ok`,
        [taskID],
      );
      if (task.rows[0]?.ok !== true) throw new TaskAssetTaskNotFoundError();
      for (const id of ids) {
        const had = await client.query<{ ok: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM task_asset_links WHERE task_id=$1 AND asset_id=$2) AS ok`,
          [taskID, id],
        );
        await client.query(
          `UPDATE assets SET task_ids=CASE WHEN $1=ANY(task_ids) THEN task_ids ELSE array_append(task_ids,$1) END WHERE id=$2`,
          [taskID, id],
        );
        await client.query(
          `INSERT INTO task_asset_links(task_id,asset_id,source,source_summary)
           VALUES ($1,$2,'manual',$3)
           ON CONFLICT(task_id,asset_id) DO UPDATE SET source='manual',source_summary=EXCLUDED.source_summary,
             source_node_id=NULL`,
          [taskID, id, sourceSummary],
        );
        if (had.rows[0]?.ok === true) existing++;
        else attached++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      return taskAssetErrorReply(err, reply);
    }
    client.release();
    return { requested: ids.length, attached, existing };
  };
  app.post("/api/tasks/:id/assets", async (req, reply) => postTaskAssets(req, reply));
  app.post("/api/tasks/:id/assets/register-scopes", async (req, reply) => postTaskAssets(req, reply));

  async function detachAssets(taskID: number, assetIDs: number[]): Promise<number> {
    const client = await db().pool.connect();
    let detached = 0;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      for (const id of assetIDs) {
        const row = await client.query<{ type: string; own: boolean; linked: boolean }>(
          `SELECT a.type,
             EXISTS(SELECT 1 FROM task_asset_links l2 WHERE l2.task_id=$1 AND l2.asset_id=a.id) AS own,
             EXISTS(SELECT 1 FROM task_asset_links l3
                    WHERE l3.asset_id=a.id
                      AND (l3.task_id=$1 OR l3.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id=$1))) AS linked
           FROM assets a WHERE a.id=$2`,
          [taskID, id],
        );
        const asset = row.rows[0];
        if (!asset || !asset.linked) throw new TaskAssetNotFoundError(`资产 ${id} 未关联当前任务或来源任务`);
        if(!asset.own)throw new TaskAssetInvalidError('来源任务资产只读，请先解除任务来源关联');
        if (asset.own === true) {
          await client.query(
            `UPDATE assets SET task_ids=ARRAY(SELECT tid FROM unnest(task_ids) AS t(tid) WHERE tid<>$1) WHERE id=$2`,
            [taskID, id],
          );
          await client.query(`DELETE FROM task_asset_links WHERE task_id=$1 AND asset_id=$2`, [taskID, id]);
        }
        detached++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return detached;
  }

  app.post("/api/tasks/:id/assets/detach", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(b["asset_ids"])) return reply.code(400).send({ error: "asset_ids 不能为空" });
    try {
      const ids = normalizeTaskAssetIDs(b["asset_ids"].map(Number));
      const detached = await detachAssets(taskID, ids);
      return { detached };
    } catch (err) {
      return taskAssetErrorReply(err, reply);
    }
  });

  app.delete("/api/tasks/:id/assets/:assetId", async (req, reply) => {
    const taskID = Number((req.params as { id: string }).id);
    const assetId = Number((req.params as { assetId: string }).assetId);
    try {
      const detached = await detachAssets(taskID, [assetId]);
      return { detached };
    } catch (err) {
      return taskAssetErrorReply(err, reply);
    }
  });

  // ─── B3：企业与资产 ────────────────────────────────────────────────────────

  app.post("/api/companies", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b["name"]).trim();
    if (name === "") return reply.code(400).send({ error: "企业名称不能为空" });
    const scope = Array.isArray(b["scope"]) ? (b["scope"] as ScopeInput[]) : [];
    try {
      const res = await db().assets().companies.createCompanyWithScope(name, "", scope, "用户创建企业");
      return reply.code(201).send({
        id: res.id,
        created: true,
        scope_added: res.added,
        scope_skipped: res.skipped,
        scope_invalid: res.invalid,
        scope_errors: res.validationErrors,
      });
    } catch (err) {
      if (err instanceof CompanyNameConflictError) return reply.code(409).send({ error: "企业已存在" });
      throw err;
    }
  });

  // POST /api/companies/:id/scope — 追加；reset=true 覆盖（无效规则先拒绝，不动旧范围）。
  app.post("/api/companies/:id/scope", async (req, reply) => {
    const companyID = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(b["scope"])) return reply.code(400).send({ error: "scope 不能为空" });
    const inputs = b["scope"] as ScopeInput[];
    const reason = str(b["reason"]);
    const reset = b["reset"] === true;
    if (reset) {
      let invalid = 0;
      const errors: string[] = [];
      for (let i = 0; i < inputs.length; i++) {
        try {
          parseScopeInput(inputs[i]!);
        } catch (err) {
          invalid++;
          errors.push(`${inputs[i]!.value}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (invalid > 0) return reply.code(400).send({ error: "企业范围包含无效规则，未覆盖原有范围", errors });
    }
    try {
      const exists = await db().query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM companies WHERE id=$1) AS ok`, [
        companyID,
      ]);
      if (exists.rows[0]?.ok !== true) return reply.code(404).send({ error: "企业不存在" });
      if (reset) {
        const client = await db().pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
          await client.query(`DELETE FROM company_scope WHERE company_id=$1`, [companyID]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      }
      const res = await db().assets().companies.addScopeInputsChecked(companyID, inputs, reason);
      return { added: res.added, skipped: res.skipped, invalid: res.invalid, errors: res.validationErrors };
    } catch (err) {
      if (err instanceof CompanyNotFoundError) return reply.code(404).send({ error: "企业不存在" });
      throw err;
    }
  });

  // PATCH /api/companies/:id/scope/:sid — 单行替换（删旧插新 + 重建派生归属）。
  app.patch("/api/companies/:id/scope/:sid", async (req, reply) => {
    const p = req.params as { id: string; sid: string };
    const companyID = Number(p.id);
    const sid = Number(p.sid);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const input: ScopeInput = { kind: str(b["kind"]) || undefined, value: str(b["value"]) };
    let rule;
    try {
      rule = parseScopeInput(input);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const reason = str(b["reason"]);
    const client = await db().pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
      const del = await client.query(`DELETE FROM company_scope WHERE id=$1 AND company_id=$2 RETURNING id`, [sid, companyID]);
      if (del.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "范围行不存在" });
      }
      const ins = await client.query<Record<string, unknown>>(
        `INSERT INTO company_scope(company_id, kind, domain, net, raw, reason)
         VALUES ($1, $2, $3, $4::cidr, $5, NULLIF($6,'')) RETURNING id, kind,
           COALESCE(domain,'') AS domain, COALESCE(net::text,'') AS net, COALESCE(value,'') AS value, raw`,
        [
          companyID,
          rule.kind,
          rule.domain ?? null,
          rule.net ?? null,
          rule.raw,
          reason,
        ],
      );
      await client.query("COMMIT");
      await db().assets().companies.recomputeAttribution();
      const r = ins.rows[0]!;
      return {
        id: Number(r["id"]),
        company_id: companyID,
        kind: String(r["kind"]),
        domain: String(r["domain"]),
        net: String(r["net"]),
        value: String(r["value"]),
        raw: String(r["raw"]),
        reason,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  app.delete("/api/companies/:id/scope/:sid", async (req, reply) => {
    const p = req.params as { id: string; sid: string };
    const del = await db().query(`DELETE FROM company_scope WHERE id=$1 AND company_id=$2 RETURNING id`, [
      Number(p.sid),
      Number(p.id),
    ]);
    if (del.rows.length === 0) return reply.code(404).send({ error: "范围行不存在" });
    await db().assets().companies.recomputeAttribution();
    return { deleted: del.rows.length };
  });

  // PATCH /api/companies/:id — 最小改名（nkey 随动，唯一冲突 → 409）。
  app.patch("/api/companies/:id", async (req, reply) => {
    const companyID = Number((req.params as { id: string }).id);
    const name = str((req.body as Record<string, unknown> | undefined)?.["name"]).trim();
    if (name === "") return reply.code(400).send({ error: "企业名称不能为空" });
    const nkey = name.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    try {
      const res = await db().query(`UPDATE companies SET name=$2, nkey=$3 WHERE id=$1 RETURNING id, COALESCE(logo,'') AS logo`, [
        companyID,
        name,
        nkey,
      ]);
      if (res.rows.length === 0) return reply.code(404).send({ error: "企业不存在" });
      return { id: Number(res.rows[0]!["id"]), name, logo: String(res.rows[0]!["logo"]) };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send({ error: "企业已存在" });
      throw err;
    }
  });

  app.delete("/api/companies/:id", async (req, reply) => {
    const companyID = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const exists = await db().query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM companies WHERE id=$1) AS ok`, [
      companyID,
    ]);
    if (exists.rows[0]?.ok !== true) return reply.code(404).send({ error: "企业不存在" });
    let assetsDeleted = 0;
    if (b["delete_assets"] === true) {
      const del = await db().query(`DELETE FROM assets WHERE company_id=$1 RETURNING id`, [companyID]);
      assetsDeleted = del.rows.length;
    }
    await db().query(`DELETE FROM companies WHERE id=$1`, [companyID]);
    return { deleted: 1, assets_deleted: assetsDeleted };
  });

  app.delete("/api/assets", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = new Set<number>((Array.isArray(b["ids"]) ? b["ids"] : []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
    const hosts = (Array.isArray(b["hosts"]) ? b["hosts"] : []).map(String).filter((h) => h.trim() !== "");
    if (ids.size === 0 && hosts.length === 0) return reply.code(400).send({ error: "ids 或 hosts 不能为空" });
    if (hosts.length > 0) {
      const res = await db().query<{ id: string }>(
        `SELECT id FROM assets WHERE domain=ANY($1::text[]) OR ip=ANY($1::text[]) OR url=ANY($2::text[])`,
        [hosts, hosts.map((h) => `http://${h}/`)],
      );
      for (const r of res.rows) ids.add(Number(r.id));
    }
    if (ids.size === 0) return { deleted: 0 };
    const idList = [...ids];
    const del = await db().query(`DELETE FROM assets WHERE id=ANY($1::bigint[]) RETURNING id`, [idList]);
    return { deleted: del.rows.length };
  });
}
