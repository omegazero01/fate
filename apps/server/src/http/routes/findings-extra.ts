import {assembleReport} from '../../evidence/reproduction.js';
import {readBlob} from '../../evidence/blobs.js';
import {reportZip} from '../../evidence/report-zip.js';
import {READABLE_FINDINGS} from "./finding-projection.js";
// 批次 C6：发现页增强——真资产树 / 导出（md/csv）/ 漏洞深挖。
// 对齐前端 web/src/lib/api.ts 的 findingAssetTree/exportFindings/deepenFinding 与
// web/src/lib/types.ts 的 FindingAssetTree/FindingAssetNode/FindingDeepenResponse 形状。
//
// ⚠ 路径归属：GET /api/exploration/findings/asset-tree 与 GET /api/exploration/findings/export
// 已由 routes/compat.ts 注册（空态/简版桩）。同路径重复注册会与 Fastify 冲突，故本文件
// 的 registerFindingsExtraRoutes() 只注册 POST /:id/deepen；asset-tree/export 的真实现
// 以处理器工厂（makeFindingsAssetTreeHandler / makeFindingsExportHandler）导出，由
// app.ts 维护者替换 compat.ts 中的两个桩（详见批次简报）。

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RelDerivedFrom } from "../../db/exploration.js";

// ─── 筛选条件（与 compat.ts findings 列表同参数族）──────────────────────────

interface FindingFilter {
  severity?: string[];
  status?: string[];
  vulnclass?: string;
  q?: string;
  taskID?: number;
}

function parseFilter(q: Record<string, string>): FindingFilter {
  const f: FindingFilter = {};
  if (q["severity"] && q["severity"] !== "all") f.severity = q["severity"].split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (q["status"] && q["status"] !== "all") f.status = q["status"].split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (q["vulnclass"] && q["vulnclass"] !== "all") f.vulnclass = q["vulnclass"];
  if (q["q"] && q["q"].trim() !== "") f.q = q["q"].trim();
  if (q["task_id"] && q["task_id"] !== "all" && Number(q["task_id"]) > 0) f.taskID = Number(q["task_id"]);
  return f;
}

/** findings 通用 WHERE（含 task_relations 继承视图，与列表一致）。 */
function findingWhere(f: FindingFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  let where = ` WHERE true`;
  if (f.taskID) {
    params.push(f.taskID);
    where += ` AND (f.task_id=$${params.length} OR f.task_id IN (SELECT source_task_id FROM task_relations WHERE task_id=$${params.length}))`;
  }
  if (f.severity && f.severity.length > 0) {
    params.push(f.severity);
    where += ` AND f.severity=ANY($${params.length}::text[])`;
  }
  if (f.status && f.status.length > 0) {
    params.push(f.status);
    where += ` AND f.status=ANY($${params.length}::text[])`;
  }
  if (f.vulnclass) {
    params.push(f.vulnclass);
    where += ` AND f.vulnclass=$${params.length}`;
  }
  if (f.q) {
    params.push(`%${f.q}%`);
    where += ` AND (f.summary ILIKE $${params.length} OR f.name ILIKE $${params.length} OR f.vulnclass ILIKE $${params.length})`;
  }
  return { where, params };
}

// ─── 资产树（makeFindingsAssetTreeHandler）───────────────────────────────────

const TREE_FINDING_CAP = 3000;
const UNASSIGNED = "__none__";
const ASSET_KINDS = new Set(["root_domain", "subdomain", "ip", "service", "app", "endpoint"]);

interface TreeNodeAcc {
  key: string;
  parent?: string;
  kind: string;
  label: string;
  assetID?: number;
  companyID?: number;
  findings: Set<number>;
}

/** 按公司/根域→资产的资产树。形状对齐 FindingAssetTree/FindingAssetNode。 */
export function makeFindingsAssetTreeHandler(app: FastifyInstance) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<unknown> => {
    const db = () => app.db;
    const q = req.query as Record<string, string>;
    const { where, params } = findingWhere(parseFilter(q));

    const total = await db().query<{ n: string }>(`SELECT count(*) AS n FROM ${READABLE_FINDINGS} f${where}`, params);
    const rows = await db().query(
      `SELECT f.id, f.task_id, f.node_id, f.name, f.vulnclass, COALESCE(f.severity,'') AS severity, f.asset_ids, f.created_at
       FROM ${READABLE_FINDINGS} f${where} ORDER BY f.created_at DESC LIMIT $${params.length + 1}`,
      [...params, TREE_FINDING_CAP],
    );
    const truncated = rows.rows.length >= TREE_FINDING_CAP;
    const findingTotal = Number(total.rows[0]?.n ?? 0);

    interface Row {
      id: number;
      severity: string;
      created_at: Date | string;
      asset_ids: unknown;
    }
    const findings = rows.rows as unknown as Row[];

    // 收集资产并取行。
    const assetIDSet = new Set<number>();
    for (const f of findings) {
      for (const id of Array.isArray(f.asset_ids) ? (f.asset_ids as unknown[]) : []) {
        const n = Number(id);
        if (Number.isInteger(n) && n > 0) assetIDSet.add(n);
      }
    }
    const assetRows =
      assetIDSet.size > 0
        ? (
            await db().query(
              `SELECT a.id, a.type, a.company_id, COALESCE(a.domain,'') AS domain, COALESCE(a.root_domain,'') AS root_domain,
                      COALESCE(a.ip,'') AS ip, COALESCE(a.url,'') AS url, COALESCE(a.app_name,'') AS app_name,
                      COALESCE(c.name,'') AS company_name
               FROM assets a LEFT JOIN companies c ON c.id=a.company_id WHERE a.id=ANY($1::bigint[])`,
              [[...assetIDSet]],
            )
          ).rows
        : [];

    // 根域名已有资产行的：根节点复用该资产行（a:<id>），否则合成 r:<domain>。
    const rootDomainAsset = new Map<string, { key: string; companyID?: number; companyName: string }>();
    for (const a of assetRows) {
      if (String(a["type"]) === "root_domain" && String(a["domain"] ?? "") !== "") {
        rootDomainAsset.set(String(a["domain"]), {
          key: `a:${Number(a["id"])}`,
          companyID: a["company_id"] ? Number(a["company_id"]) : undefined,
          companyName: String(a["company_name"] ?? ""),
        });
      }
    }

    const nodes = new Map<string, TreeNodeAcc>();
    const createdDates = new Map<number, string>();
    const severities = new Map<number, string>();
    const droppedKinds = new Set<string>();

    const node = (key: string, init: Omit<TreeNodeAcc, "findings">): TreeNodeAcc => {
      let n = nodes.get(key);
      if (!n) {
        n = { ...init, findings: new Set() };
        nodes.set(key, n);
      }
      return n;
    };

    const companyNode = (id: number, label: string): TreeNodeAcc =>
      node(`c:${id}`, { key: `c:${id}`, kind: "company", label: label === "" ? `企业 #${id}` : label, companyID: id });

    const rootDomainNode = (domain: string): TreeNodeAcc => {
      const info = rootDomainAsset.get(domain);
      if (info) return node(info.key, { key: info.key, kind: "root_domain", label: domain });
      return node(`r:${domain}`, { key: `r:${domain}`, kind: "root_domain", label: domain });
    };

    for (const f of findings) {
      createdDates.set(f.id, f.created_at instanceof Date ? f.created_at.toISOString() : String(f.created_at));
      severities.set(f.id, f.severity);
      const ids = (Array.isArray(f.asset_ids) ? (f.asset_ids as unknown[]) : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) {
        node(UNASSIGNED, { key: UNASSIGNED, kind: "none", label: "未关联资产" }).findings.add(f.id);
        continue;
      }
      for (const id of ids) {
        const a = assetRows.find((r) => Number(r["id"]) === id);
        if (!a) {
          // 资产已被删除：按未关联处理（同一 finding 的其他有效资产仍正常挂树）。
          node(UNASSIGNED, { key: UNASSIGNED, kind: "none", label: "未关联资产" }).findings.add(f.id);
          continue;
        }
        const type = String(a["type"]);
        if (!ASSET_KINDS.has(type)) {
          droppedKinds.add(type);
          node(UNASSIGNED, { key: UNASSIGNED, kind: "none", label: "未关联资产" }).findings.add(f.id);
          continue;
        }
        const label =
          String(a["domain"] ?? "") ||
          String(a["ip"] ?? "") ||
          String(a["url"] ?? "") ||
          String(a["app_name"] ?? "") ||
          `资产 #${id}`;
        const companyID = a["company_id"] ? Number(a["company_id"]) : undefined;

        // 祖先链：subdomain/service/endpoint 挂根域；其余（root_domain/app/ip）直挂公司。
        let parentKey: string | undefined;
        let rootLabel = "";
        if (type === "subdomain" || type === "service" || type === "endpoint") {
          rootLabel = String(a["root_domain"] ?? "") || String(a["domain"] ?? "");
        }
        if (rootLabel !== "" && rootLabel !== label) {
          const rn = rootDomainNode(rootLabel);
          parentKey = rn.key;
          const info = rootDomainAsset.get(rootLabel);
          const rnCompany = info?.companyID ?? companyID;
          if (rnCompany !== undefined) {
            rn.parent = companyNode(rnCompany, info?.companyName || String(a["company_name"] ?? "")).key;
          }
        } else if (companyID !== undefined) {
          parentKey = companyNode(companyID, String(a["company_name"] ?? "")).key;
        }
        const an = node(`a:${id}`, {
          key: `a:${id}`,
          kind: type,
          label,
          assetID: id,
          ...(companyID !== undefined ? { companyID } : {}),
        });
        if (parentKey && an.parent === undefined) an.parent = parentKey;
        an.findings.add(f.id);
      }
    }

    // 子树聚合（后序 DFS）：total/档位计数按 finding id 去重。
    const children = new Map<string, string[]>();
    for (const n of nodes.values()) {
      if (n.parent) {
        const list = children.get(n.parent) ?? [];
        list.push(n.key);
        children.set(n.parent, list);
      }
    }
    const agg = new Map<string, { total: Set<number>; last: string }>();
    const visit = (key: string): { total: Set<number>; last: string } => {
      const memo = agg.get(key);
      if (memo) return memo;
      const n = nodes.get(key)!;
      const total = new Set(n.findings);
      let last = "";
      for (const id of n.findings) {
        const ts = createdDates.get(id) ?? "";
        if (ts > last) last = ts;
      }
      for (const child of children.get(key) ?? []) {
        const sub = visit(child);
        for (const id of sub.total) total.add(id);
        if (sub.last > last) last = sub.last;
      }
      const out = { total, last };
      agg.set(key, out);
      return out;
    };
    const order = ["company", "root_domain", "subdomain", "ip", "app", "service", "endpoint", "none"];
    const out = [...nodes.values()]
      .sort((x, y) => {
        const ko = order.indexOf(x.kind) - order.indexOf(y.kind);
        return ko !== 0 ? ko : x.label.localeCompare(y.label);
      })
      .map((n) => {
        const a = visit(n.key);
        let critical = 0;
        let high = 0;
        let medium = 0;
        let low = 0;
        for (const id of a.total) {
          const s = severities.get(id) ?? "";
          if (s === "critical") critical += 1;
          else if (s === "high") high += 1;
          else if (s === "medium") medium += 1;
          else if (s === "low") low += 1;
        }
        return {
          key: n.key,
          ...(n.parent ? { parent: n.parent } : {}),
          kind: n.kind,
          label: n.label,
          ...(n.assetID !== undefined ? { asset_id: n.assetID } : {}),
          ...(n.companyID !== undefined ? { company_id: n.companyID } : {}),
          self: n.findings.size,
          total: a.total.size,
          critical,
          high,
          medium,
          low,
          last_found_at: a.last,
        };
      });

    return {
      nodes: out,
      finding_total: findingTotal,
      truncated,
      ...(droppedKinds.size > 0 ? { dropped_kinds: [...droppedKinds] } : {}),
    };
  };
}

// ─── 导出（makeFindingsExportHandler：format=md/csv/json + scope/筛选）───────

function csvCell(v: string): string {
  const s = v ?? "";
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function makeFindingsExportHandler(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const db = () => app.db;
    const q = req.query as Record<string, string>;
    const format = (q["format"] ?? "md").toLowerCase();
    const scope = q["scope"] ?? "filtered";
    if (!["md", "md-single", "md-zip", "csv", "json"].includes(format)) {
      return reply.code(400).send({ error: `不支持的 format: ${format}` });
    }
    if (!["filtered", "all", "selected"].includes(scope)) {
      return reply.code(400).send({ error: `不支持的 scope: ${scope}` });
    }

    let where = "";
    let params: unknown[] = [];
    if (scope === "filtered") {
      const w = findingWhere(parseFilter(q));
      where = w.where;
      params = w.params;
    } else {
      where = ` WHERE true`;
    }
    if (scope === "selected") {
      const ids = (q["ids"] ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) return reply.code(400).send({ error: "scope=selected 需要 ids（finding_id 逗号列表）" });
      where = ` WHERE f.id=ANY($1::bigint[])`;
      params = [ids];
    }

    const rows = await db().query(
      `SELECT f.id, f.task_id, f.node_id, COALESCE(f.name,'') AS name, COALESCE(f.vulnclass,'') AS vulnclass,
              COALESCE(f.severity,'') AS severity, COALESCE(f.status,'') AS status,
              COALESCE(f.summary,'') AS summary, COALESCE(f.evidence,'') AS evidence, f.created_at
       FROM ${READABLE_FINDINGS} f${where} ORDER BY f.created_at DESC LIMIT 5000`,
      params,
    );
    const currentIDs=rows.rows.filter(r=>Number(r.id)>0).map(r=>Number(r.id));
    const details=new Map((await db().query('SELECT id,reproduction,report,report_sections,evidence_version,report_evidence_version FROM findings WHERE id=ANY($1::bigint[]) AND finding_readable(id)',[currentIDs])).rows.map(r=>[String(r.id),r]));
    const imageRows=(await db().query('SELECT finding_id,id,step_id,caption,mime,position,blob_hash FROM finding_step_images WHERE finding_id=ANY($1::bigint[]) ORDER BY finding_id,position,id',[currentIDs])).rows;
    const imagesByFinding=new Map<string,typeof imageRows>();for(const image of imageRows){const key=String(image.finding_id),list=imagesByFinding.get(key)??[];list.push(image);imagesByFinding.set(key,list);}
    for(const row of rows.rows)Object.assign(row,details.get(String(row.id)));
    const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    if (format === "csv") {
      const head = "id,name,vulnclass,severity,status,task_id,created_at,summary";
      const lines = [head];
      for (const r of rows.rows) {
        lines.push(
          [
            String(r["id"]),
            csvCell(String(r["name"])),
            csvCell(String(r["vulnclass"])),
            csvCell(String(r["severity"])),
            csvCell(String(r["status"])),
            r["task_id"] === null ? "" : String(r["task_id"]),
            iso(r["created_at"]),
            csvCell(String(r["summary"])),
          ].join(","),
        );
      }
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="findings-export-${stamp}.csv"`);
      return lines.join("\r\n");
    }

    if (format === "json") {
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="findings-export-${stamp}.json"`);
      return JSON.stringify(
        rows.rows.map((r) => ({
          id: String(r["node_id"] ?? r["id"]),
          finding_id: String(r["id"]),
          name: String(r["name"]),
          vulnclass: String(r["vulnclass"]),
          severity: String(r["severity"]),
          status: String(r["status"]),
          task_id: r["task_id"] === null ? null : String(r["task_id"]),
          summary: String(r["summary"]),
          evidence: String(r["evidence"]),
          reproduction:r.reproduction??null,report_sections:r.report_sections??null,images:(imagesByFinding.get(String(r.id))??[]).map(({blob_hash,...meta})=>meta),
          created_at: iso(r["created_at"]),
        })),
        null,
        2,
      );
    }

    const lines=['# 发现导出',''],files:Array<{name:string;bytes:Buffer}>=[];
    let imageBytes=0;
    for(const f of rows.rows){
      const images=imagesByFinding.get(String(f.id))??[];
      const available:typeof images=[];
      for(const image of images){
        if(format==='md-zip'){
          try{const bytes=await readBlob(db(),String(image.blob_hash));imageBytes+=bytes.length;if(imageBytes>120*1024*1024)throw Object.assign(new Error('截图总量过大，请缩小导出范围'),{statusCode:413});files.push({name:`assets/${image.id}.${String(image.mime).split('/')[1]}`,bytes});available.push(image);}
          catch(e){if((e as {statusCode?:number}).statusCode===413)throw e;lines.push(`> 截图 ${image.id} 不可用。`);}
        }else available.push(image);
      }
      lines.push(assembleReport(f,available as never,format==='md-zip'?id=>`assets/${id}.${String(images.find(i=>i.id===id)?.mime).split('/')[1]}`:undefined),'');
    }
    if(format==='md-zip')return reply.type('application/zip').header('Content-Disposition',`attachment; filename="findings-export-${stamp}.zip"`).send(reportZip([{name:'report.md',bytes:Buffer.from(lines.join('\n'))},...files]));
    lines.push('> Markdown 单文件未打包截图；离线交付请选择 Markdown ZIP。');
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="findings-export-${stamp}.md"`);
    return lines.join("\n");
  };
}

// ─── 深挖（registerFindingsExtraRoutes：POST /:id/deepen）────────────────────

export function registerFindingsExtraRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  async function findingByAnyId(idStr: string, recordOnly = false): Promise<Record<string, unknown> | null> {
    const id = Number(idStr);
    if (!Number.isInteger(id)) return null;
    let res = await db().query(`SELECT * FROM findings WHERE ${recordOnly ? "id" : "node_id"}=$1 AND finding_readable(id)`, [id]);
    if (!recordOnly && res.rows.length === 0) res = await db().query(`SELECT * FROM findings WHERE id=$1 AND finding_readable(id)`, [id]);
    return res.rows[0] ?? null;
  }

  // POST /api/exploration/findings/:id/deepen — 以该漏洞为 parent 派一条深挖意图并唤醒引擎。
  app.post("/api/exploration/findings/:id/deepen", async (req, reply) => {
    const p = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const description = typeof b["description"] === "string" ? b["description"].trim() : "";
    if (description === "") return reply.code(400).send({ error: "description 不能为空" });
    const row = await findingByAnyId(p["id"]!, (req.query as {id_kind?:string}).id_kind === "record");
    if (!row) return reply.code(404).send({ error: "漏洞不存在" });

    const taskID = Number(row["task_id"] ?? 0);
    const taskRes = await db().query<{ exploration_id: number; queued: boolean }>(
      `SELECT exploration_id, queued FROM tasks WHERE id=$1 AND deleted_at IS NULL`,
      [taskID],
    );
    const task = taskRes.rows[0];
    if (!task) return reply.code(404).send({ error: "漏洞所属任务不存在或已删除" });

    const nodeID = Number(row["node_id"] ?? 0);
    const title = String(row["name"] ?? "") !== "" ? String(row["name"]) : String(row["vulnclass"] ?? "") || `#${String(row["id"])}`;
    const anchors = (Array.isArray(row["asset_ids"]) ? (row["asset_ids"] as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);
    const payload: Record<string, unknown> = {
      summary: `[漏洞深挖] ${title}（finding #${String(row["id"])}）：${description}`,
    };
    if (nodeID > 0) payload["parent_id"] = nodeID;

    const s = db().exploration(Number(task.exploration_id));
    const { id: intentID, created } = await s.addIntentDeduplicated(payload, 8, anchors, "user");
    if (created && nodeID > 0) await s.link(nodeID, RelDerivedFrom, intentID);
    // 派发：任务在引擎中 → 踢一轮；不在 → 只落库（下次启动由 frontier 领取）。
    app.engine.notify(taskID);

    const node = await s.getNode(intentID).catch(() => null);
    return {
      task_id: String(taskID),
      intent_id: String(intentID),
      state: node?.state ?? "open",
      queued: task.queued === true,
    };
  });
}
