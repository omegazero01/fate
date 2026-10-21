import {assetCoverage,queryAssets} from './asset-query.js';
import { rootDomain } from "./assets.js";
// 任务资产关联、范围登记与覆盖度。
import net from "node:net";
import type { PoolClient } from "pg";
import type { Database } from "./index.js";
import type { Node } from "./exploration.js";

// ─── 常量与错误（db/task_assets.go）──────────────────────────────────────────

export const MAX_TASK_ASSET_MUTATION_COUNT = 100;
export const MAX_TASK_ASSET_SUMMARY_RUNES = 500;


export class TaskAssetInvalidError extends Error {
  constructor(message = "invalid task asset association") {
    super(message);
    this.name = "TaskAssetInvalidError";
  }
}
export class TaskAssetTaskNotFoundError extends Error {
  constructor(message = "task not found") {
    super(message);
    this.name = "TaskAssetTaskNotFoundError";
  }
}
export class TaskAssetNotFoundError extends Error {
  constructor(message = "asset not found") {
    super(message);
    this.name = "TaskAssetNotFoundError";
  }
}
/** 归一化域自然键：trim + 小写 + 去尾点（Go DomainKey）。 */
export function domainKey(fqdn: string): string {
  return fqdn.trim().toLowerCase().replace(/\.$/, "");
}

/** 常见二级公共后缀（publicsuffix 的近似子集；Go 用完整 PSL）。 */
export { rootDomain } from "./assets.js";

/** 规范化 IP 字面量（Go net.ParseIP + ip.String()）；非法返回 null。IPv6 输出压缩形。 */
export function parseCanonicalIP(v: string): string | null {
  const t = v.trim();
  const kind = net.isIP(t);
  if (kind === 4) return t;
  if (kind === 6) {
    try {
      return new URL(`http://[${t}]/`).hostname.replace(/^\[/, "").replace(/\]$/, "");
    } catch {
      return null;
    }
  }
  return null;
}

/** 裸 IP → 单主机 CIDR（/32 或 /128）；非法返回 ""（Go ipToHostCIDR）。 */
export function ipToHostCIDR(ip: string): string {
  const t = ip.trim();
  const kind = net.isIP(t);
  if (kind === 0) return "";
  const v4 = kind === 4 || (kind === 6 && t.toLowerCase().startsWith("::ffff:")); // Go To4() 含 v4 映射地址
  return t + (v4 ? "/32" : "/128");
}

/** 去掉 host:port / [v6]:port 的端口；裸主机/裸 IPv6 原样返回（Go stripHostPort / net.SplitHostPort）。 */
export function stripHostPort(v: string): string {
  const t = v.trim();
  const v6 = t.match(/^\[([0-9a-fA-F:.]+)\]:\d+$/);
  if (v6) return v6[1]!;
  const m = t.match(/^([^\[\]:]+):(\d+)$/);
  if (m) return m[1]!;
  return t;
}

/** 校验并归一化 Agent 主机名（Go NormalizeAgentHost）：IP→规范形，域名→ASCII 小写。 */
export function normalizeAgentHost(raw: string, allowSingle: boolean): string {
  let h = domainKey(raw);
  const ip = parseCanonicalIP(h);
  if (ip !== null) return ip;
  try {
    // IDNA ToASCII 近似：URL 构造器完成 punycode 编码与小写化。
    h = new URL(`http://${h}`).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    /* 保持原值，由下方标签校验拒绝 */
  }
  if (h === "" || h.length > 253 || (!allowSingle && !h.includes("."))) {
    throw new TaskAssetInvalidError(`invalid host "${raw}": 需要明确的主机名，不能使用变量或占位符`);
  }
  for (const label of h.split(".")) {
    if (label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
      throw new TaskAssetInvalidError(`invalid host "${raw}"`);
    }
    for (const c of label) {
      if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-")) {
        throw new TaskAssetInvalidError(`invalid host "${raw}": 不得使用变量、下划线或占位符`);
      }
    }
  }
  return h;
}

/** 任务侧主机身份归一化（Go normalizeTaskAssetHost：trim/小写/去方括号 → URL 主机 → IP 规范形 → 去尾点）。 */
export function normalizeTaskAssetHost(value: string): string {
  let v = value.trim().toLowerCase().replace(/^\[+/, "").replace(/\]+$/, "");
  if (v.includes("://")) {
    try {
      const h = new URL(v).hostname;
      if (h !== "") v = h.replace(/^\[/, "").replace(/\]$/, "");
    } catch {
      /* 无主机名的相对引用：保持原值（与 Go url.Parse Hostname()=='' 分支一致） */
    }
  }
  const ip = parseCanonicalIP(v);
  if (ip !== null) return ip;
  return v.replace(/\.$/, "");
}

/** 小写 scheme/host、裸根去尾斜杠（Go normalizeURL）。 */
export function normalizeURL(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  let s = u.toString();
  if (s.endsWith("/") && u.pathname === "/" && u.search === "") s = s.slice(0, -1);
  return s;
}

function defaultPort(scheme: string, p: string): number {
  if (p !== "") {
    const n = Number.parseInt(p, 10);
    if (!Number.isNaN(n)) return n;
  }
  if (scheme === "https") return 443;
  if (scheme === "http") return 80;
  return 0;
}

/** 从 URL 提取 domain/port/service_name（Go parseURL）。 */
export function parseURL(raw: string): { domain: string; port: number; serviceName: string } {
  try {
    const u = new URL(raw);
    const scheme = u.protocol.replace(":", "").toLowerCase();
    let serviceName: string;
    if (scheme === "https") serviceName = "HTTPS";
    else if (scheme === "http") serviceName = "HTTP";
    else serviceName = scheme.toUpperCase();
    return {
      domain: u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, ""),
      port: defaultPort(scheme, u.port),
      serviceName,
    };
  } catch {
    return { domain: "", port: 0, serviceName: "" };
  }
}


export interface AssetIdentity {
  id: number;
  type: string;
  domain?: string | null;
  root_domain?: string | null;
  ip?: string | null;
  url?: string | null;
  method?: string | null;
  service_name?: string | null;
  port?: number | null;
  bundle_id?: string | null;
  app_name?: string | null;
}

/**
 */
export interface TaskScope {
  id?: number;
  task_id: number;
  kind: string; // company|root_domain|subdomain|ip|cidr|icp|keyword
  company_id?: number | null;
  company_name?: string;
  domain?: string;
  net?: string;
  value?: string;
  /** 空 = 写入端默认：upsert 落 'auto'，addAgentScope 落 'agent'。 */
  source?: string;
  reason?: string;
}

export interface CoverageAsset {
  id: number;
  type: string;
  label: string;
}

export interface CoverageByType {
  type: string;
  total: number;
  tested: number;
}

export interface Coverage {
  enabled: boolean;
  scopeRows: number;
  denominator: number;
  tested: number;
  pct: number | null;
  byType: CoverageByType[];
  coverage_basis?: string;
  legacy_unverified?: number;
}

export function normalizeTaskAssetIDs(ids: number[]): number[] {
  if (ids.length === 0) throw new TaskAssetInvalidError("invalid task asset association: asset_ids is required");
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const id of ids) {
    if (id <= 0) throw new TaskAssetInvalidError("invalid task asset association: asset id must be positive");
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
    if (normalized.length > MAX_TASK_ASSET_MUTATION_COUNT) {
      throw new TaskAssetInvalidError(
        `invalid task asset association: at most ${MAX_TASK_ASSET_MUTATION_COUNT} assets per request`,
      );
    }
  }
  return normalized;
}

/** 建任务路径的可选归一化：空列表合法。 */
export function normalizeTaskAssetIDsForCreate(ids: number[]): number[] {
  if (ids.length === 0) return [];
  return normalizeTaskAssetIDs(ids);
}

function normalizeICP(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeKeyword(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** 校验 CIDR 字符串（Go net.ParseCIDR 近似：IP 合法 + 掩码位数在族范围内）。 */
function validCIDR(v: string): boolean {
  const slash = v.lastIndexOf("/");
  if (slash <= 0) return false;
  const addr = v.slice(0, slash);
  const mask = Number.parseInt(v.slice(slash + 1), 10);
  if (!/^\d+$/.test(v.slice(slash + 1)) || Number.isNaN(mask)) return false;
  const kind = net.isIP(addr);
  if (kind === 4) return mask >= 0 && mask <= 32;
  if (kind === 6) return mask >= 0 && mask <= 128;
  return false;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class TaskScopeStore {
  workerRead = false;

  constructor(private db: Database, private tx?: PoolClient) {}

  private exec<T extends Record<string, unknown>>(text: string, values?: unknown[]) {
    return this.tx ? this.tx.query<T>(text, values) : this.db.query<T>(text, values);
  }

  // ─── 范围写入（upsertTaskScopeResult/AddAutoScope/AddAgentScope）───────────

  /** 幂等插一条 scope（uq_task_scope）；重复静默忽略。返回是否新插入。 */
  async upsertTaskScopeResult(ts: TaskScope): Promise<boolean> {
    if (ts.task_id <= 0 || ts.kind === "") return false;
    const res = await this.exec(
      `INSERT INTO task_scope(task_id, kind, company_id, domain, net, value, source, reason)
       VALUES ($1,$2,$3,$4,$5::cidr,$6,$7,NULLIF($8,''))
       ON CONFLICT DO NOTHING`,
      [
        ts.task_id,
        ts.kind,
        ts.company_id && ts.company_id > 0 ? ts.company_id : null,
        ts.domain || null,
        ts.net || null,
        ts.value || null,
        ts.source || "auto",
        ts.reason ?? "",
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async upsertTaskScope(ts: TaskScope): Promise<void> {
    await this.upsertTaskScopeResult(ts);
  }

  /**
   * 记录单个显式插入资产隐含的保守任务范围（source='auto'）。只允许 insertAssets
   * 顶层循环调用——绝不从 db 层副作用（linkHostAssets）调用，派生资产不盲目扩范围。
   * 粒度跟随资产自身类型。taskID<=0 → no-op。
   */
  async addAutoScope(taskID: number, assetType: string, domain: string, rawURL: string, ip: string): Promise<void> {
    if (taskID <= 0) return;
    switch (assetType) {
      case "root_domain": {
        const d = domainKey(domain);
        if (d !== "") return this.upsertTaskScope({ task_id: taskID, kind: "root_domain", domain: d });
        return;
      }
      case "subdomain": {
        const d = domainKey(domain);
        if (d !== "") return this.upsertTaskScope({ task_id: taskID, kind: "subdomain", domain: d });
        return;
      }
      case "service":
      case "endpoint": {
        let host = domain;
        if (host === "" && rawURL !== "") host = parseURL(normalizeURL(rawURL)).domain;
        host = domainKey(host);
        if (host !== "" && parseCanonicalIP(host) === null) {
          return this.upsertTaskScope({ task_id: taskID, kind: "subdomain", domain: host });
        }
        // IP 字面量主机或无主机 → 有 IP 就回退 ip 范围。
        const c = ipToHostCIDR(ip || host);
        if (c !== "") return this.upsertTaskScope({ task_id: taskID, kind: "ip", net: c });
        return;
      }
      case "ip": {
        const c = ipToHostCIDR(ip);
        if (c !== "") return this.upsertTaskScope({ task_id: taskID, kind: "ip", net: c });
        return;
      }
    }
  }

  /**
   * 解析 (kind,value) 并记录任务范围。LLM 工具传 source='agent'，UI 传 'manual'。
   * company：企业名或 id（须已存在）。root_domain/subdomain：域名。ip/cidr：裸 IP
   */
  async addAgentScope(taskID: number, kind: string, value: string, reason: string, source: string): Promise<TaskScope> {
    if (source === "") source = "agent";
    const ts: TaskScope = { task_id: taskID, kind, source, reason };
    if (taskID <= 0) throw new Error("需要 task_id");
    value = value.trim();
    if (value === "") throw new Error("value 不能为空");
    switch (kind) {
      case "company": {
        const companyID = await this.findCompanyID(value);
        if (companyID === null) {
          throw new Error(`company 不存在: ${value}（先用 list_companies 确认，或建好企业）`);
        }
        ts.company_id = companyID;
        break;
      }
      case "root_domain": {
        const d = domainKey(stripHostPort(value));
        let root = rootDomain(d).root;
        if (root === "") root = d;
        if (root === "") throw new Error(`无效根域: ${value}`);
        ts.domain = root;
        break;
      }
      case "subdomain": {
        const d = domainKey(stripHostPort(value));
        if (d === "") throw new Error(`无效子域: ${value}`);
        ts.domain = d;
        break;
      }
      case "ip":
      case "cidr": {
        let v = value;
        if (!v.includes("/")) {
          v = ipToHostCIDR(stripHostPort(v));
          ts.kind = "ip";
        } else {
          ts.kind = "cidr";
        }
        if (v === "") throw new Error(`无效 ip/cidr: ${value}`);
        if (!validCIDR(v)) throw new Error(`无效 ip/cidr: ${value}`);
        ts.net = v;
        break;
      }
      case "icp": {
        const parsed = normalizeICP(value);
        if (parsed === "") throw new Error("ICP 不能为空");
        ts.value = parsed;
        break;
      }
      case "keyword": {
        const parsed = normalizeKeyword(value);
        if (parsed === "") throw new Error("企业关键词不能为空");
        ts.value = parsed;
        break;
      }
      default:
        throw new Error(`不支持的 kind: ${kind}（company/root_domain/subdomain/ip/cidr/icp/keyword）`);
    }
    if (source !== "manual") {
      await this.upsertTaskScope(ts);
      return ts;
    }

    if (this.tx) {
      await this.upsertTaskScope(ts);
      await this.linkScopeAssets(this.tx, ts);
      return ts;
    }
    // 操作者登记的范围与资产关联在同一事务提交。
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const scoped = new TaskScopeStore(this.db, client);
      await scoped.upsertTaskScope(ts);
      await scoped.linkScopeAssets(client, ts);
      await client.query("COMMIT");
      return ts;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 企业 id/名 → companies.id（Go CompanyStore.GetCompany / GetCompanyByName 的 companyNKey）。 */
  private async findCompanyID(value: string): Promise<number | null> {
    if (/^[+-]?\d+$/.test(value)) {
      const res = await this.exec<{ id: string }>(`SELECT id FROM companies WHERE id=$1`, [Number(value)]);
      return res.rows[0] ? Number(res.rows[0].id) : null;
    }
    const nkey = value
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    const res = await this.exec<{ id: string }>(`SELECT id FROM companies WHERE nkey=$1`, [nkey]);
    return res.rows[0] ? Number(res.rows[0].id) : null;
  }

  /**
   * 关联 source='manual' 范围内已有的资产。
   */
  private async linkScopeAssets(client: PoolClient, scope: TaskScope): Promise<void> {
    if (scope.task_id <= 0) return;
    let where = "";
    let arg: unknown = null;
    switch (scope.kind) {
      case "company":
        if (!scope.company_id || scope.company_id <= 0) return;
        where = "a.company_id=$1";
        arg = scope.company_id;
        break;
      case "root_domain":
        where = "a.domain=$1 OR a.domain LIKE '%.'||$1 OR a.root_domain=$1";
        arg = scope.domain ?? "";
        break;
      case "subdomain":
        where = "a.domain=$1";
        arg = scope.domain ?? "";
        break;
      case "ip":
      case "cidr":
        where = "try_inet(a.ip) IS NOT NULL AND $1::cidr >>= try_inet(a.ip)";
        arg = scope.net ?? "";
        break;
      case "icp":
        where = `(lower(regexp_replace(COALESCE(a.icp,''), '[[:space:]]+', '', 'g'))=$1
OR lower(regexp_replace(COALESCE(a.app_icp,''), '[[:space:]]+', '', 'g'))=$1)`;
        arg = scope.value ?? "";
        break;
      default:
        return;
    }
    const rows = await client.query<Record<string, unknown>>(
      `SELECT a.id,a.type,COALESCE(a.domain,'') AS domain,COALESCE(a.root_domain,'') AS root_domain,COALESCE(a.ip,'') AS ip,COALESCE(a.url,'') AS url,COALESCE(a.method,'') AS method,COALESCE(a.service_name,'') AS service_name,COALESCE(a.port,0) AS port FROM assets a WHERE (${where})`,
      [arg],
    );
    const summary = "用户在测试资产页手工新增";
    let reason = String(scope.reason ?? "").trim();
    if (reason === "") reason = "手动范围登记";
    for (const row of rows.rows) {
      const a: AssetIdentity = {
        id: Number(row["id"]),
        type: String(row["type"]),
        domain: row["domain"] as string,
        root_domain: (row["root_domain"] as string) || null,
        ip: row["ip"] as string,
        url: row["url"] as string,
        method: row["method"] as string,
        service_name: row["service_name"] as string,
        port: Number(row["port"] ?? 0),
      };
      await client.query(
        `UPDATE assets SET task_ids=CASE WHEN $1=ANY(task_ids) THEN task_ids ELSE array_append(task_ids,$1) END WHERE id=$2`,
        [scope.task_id, a.id],
      );
      await client.query(
        `INSERT INTO task_asset_links(task_id,asset_id,source,source_summary)
         VALUES($1,$2,'manual',$3) ON CONFLICT(task_id,asset_id) DO UPDATE
         SET source='manual',source_summary=EXCLUDED.source_summary,source_node_id=NULL`,
        [scope.task_id,a.id,summary],
      );
    }
  }

  /** 删除单条 scope（限定任务）；返回是否真的删除了一行。 */
  async deleteTaskScope(taskID: number, scopeID: number): Promise<boolean> {
    const res = await this.exec(`DELETE FROM task_scope WHERE id=$1 AND task_id=$2`, [scopeID, taskID]);
    return (res.rowCount ?? 0) > 0;
  }

  /** 列出任务全部 scope 行（含企业名解析）。 */
  async listTaskScope(taskID: number): Promise<TaskScope[]> {
    const res = await this.exec<{
      id: string;
      kind: string;
      company_id: string;
      company_name: string;
      domain: string;
      net: string;
      value: string;
      source: string;
      reason: string;
    }>(
      `SELECT ts.id, ts.kind, COALESCE(ts.company_id,0) AS company_id, COALESCE(c.name,'') AS company_name, COALESCE(ts.domain,'') AS domain,
             COALESCE(ts.net::text,'') AS net, COALESCE(ts.value,'') AS value, ts.source, COALESCE(ts.reason,'') AS reason
      FROM task_scope ts
      LEFT JOIN companies c ON c.id=ts.company_id
      WHERE ts.task_id=$1 ORDER BY ts.id`,
      [taskID],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      task_id: taskID,
      kind: r.kind,
      company_id: Number(r.company_id) > 0 ? Number(r.company_id) : null,
      company_name: r.company_name,
      domain: r.domain,
      net: r.net,
      value: r.value,
      source: r.source,
      reason: r.reason,
    }));
  }

  // ─── 覆盖度（CoverageEnabled/TaskCoverage/ListUntestedAssets）──────────────

  /** 覆盖度功能开关（tasks.coverage_enabled）；缺失/出错 fail-open 为 true。taskID<=0 → true。 */
  async coverageEnabled(taskID: number): Promise<boolean> {
    if (taskID <= 0) return true;
    try {
      const res = await this.exec<{ coverage_enabled: boolean }>(
        `SELECT COALESCE(coverage_enabled,true) AS coverage_enabled FROM tasks WHERE id=$1`,
        [taskID],
      );
      return res.rows[0]?.coverage_enabled !== false;
    } catch {
      return true;
    }
  }

  /**
   * 粗粒度按类型覆盖度。分母=匹配任一活跃 task_scope 的资产；分子=有明确范围、资产关联和实测证据的记录
   * （不表示所有方向测试完毕，历史范围不明单独展示）。Go 版 Enabled 由 API 层填；TS 版在此直接读开关。
   */
  async taskCoverage(taskID: number, expID: number): Promise<Coverage> {
    return assetCoverage(this.db,taskID);
  }

  async listUntestedAssets(taskID:number,_expID:number,typ:string,limit:number,offset:number):Promise<{page:CoverageAsset[];total:number}> {
    if(!await this.coverageEnabled(taskID))return {page:[],total:0};
    const result=await queryAssets(this.db,{taskID,type:typ,untested:true,limit:limit>0?limit:10,offset:Math.max(0,offset),summary:true});
    return {page:result.assets.map(a=>({id:a.id,type:a.type,label:a.url||a.domain||a.ip||a.app_name||''})),total:result.total};
  }

  /** Assets used as graph anchors must belong to this task or a directly linked source. */
  async validateTaskAssets(taskID: number, assetIDs: number[]): Promise<void> {
    if(!assetIDs.length)return;
    const ids=normalizeTaskAssetIDs(assetIDs);
    const rows=await this.exec<{id:string}>('SELECT id FROM assets WHERE id=ANY($2::bigint[]) AND task_asset_linked($1,id)',[taskID,ids]);
    if(rows.rows.length!==ids.length)throw new TaskAssetNotFoundError('资产不存在或不属于当前任务及直接来源任务');
  }

  async markTaskAssetsTested(taskID: number, assetIDs: number[], agentKey: string): Promise<void> {
    if (taskID <= 0 || assetIDs.length === 0) return;
    const ids = normalizeTaskAssetIDs(assetIDs);
    await this.exec(
      `UPDATE task_asset_links
      SET tested=true, tested_at=COALESCE(tested_at,now()), tested_by=COALESCE(NULLIF($3,''),tested_by)
       WHERE task_id=$1 AND asset_id=ANY($2::bigint[]) AND NOT tested`,
      [taskID, ids, agentKey.trim()],
    );
  }
}

// 企业范围编辑互斥锁（db/companies.go companyScopeMutationLock）。
const COMPANY_SCOPE_MUTATION_LOCK = 7337741003;
