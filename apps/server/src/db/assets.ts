// 资产图 store：assets + companies + company_scope —— 归一化、幂等 upsert、公司归属匹配。
// 忠实平移自 Go 版 db/assets.go + db/companies.go + db/company_scope.go + db/nkey.go 的核心路径。
// eTLD+1 解析：Go 用 golang.org/x/net/publicsuffix，TS 侧用 tldts（allowPrivateDomains 对齐
// Go 列表含私有段的行为）；IDNA 转写用 node:url 的 domainToASCII（对齐 idna.Lookup.ToASCII）。

import { domainToASCII } from "node:url";
import { parse as tldtsParse } from "tldts";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { Database } from "./index.js";

// ─── 通用查询接口（Go 里 *sql.DB / *sql.Tx 共用的 companyScopeQueryer）─────────

export interface SQLQuerier {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

// Unicode White_Space 全集（对齐 Go unicode.IsSpace；JS \s 额外含 \uFEFF，此处不用 \s）。
const UNICODE_SPACE = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
function hasUnicodeSpace(s: string): boolean {
  return UNICODE_SPACE.test(s);
}
/** Go strings.Fields：按 Unicode 空白切分并丢弃空段。 */
function fields(s: string): string[] {
  return s.split(UNICODE_SPACE).filter((p) => p !== "");
}
function runeLen(s: string): number {
  return [...s].length;
}

// ─── 归一化（db/nkey.go）──────────────────────────────────────────────────────

/** 域名键：trim + 小写 + 去一个尾部点（DomainKey）。 */
export function domainKey(fqdn: string): string {
  return fqdn.trim().toLowerCase().replace(/\.$/, "");
}

export function ipKey(ip: string): string {
  return ip.trim();
}

/** companyNKey：小写 + trim + 折叠空白为公司自然键。 */
export function companyNKey(name: string): string {
  return fields(name.toLowerCase()).join(" ");
}

// ─── IP 解析/格式化（对齐 Go net.ParseIP + net.IP.String 的规范化）────────────

const IPV4_PART = /^\d{1,3}$/;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

function parseIPv4Groups(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!IPV4_PART.test(p) || (p.length > 1 && p.startsWith("0"))) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** 解析冒号段（可含尾部内嵌 IPv4）；空串返回 []（供 "::" 两侧使用）。 */
function parseIPv6Groups(part: string): number[] | null {
  if (part === "") return [];
  const pieces = part.split(":");
  const out: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const isLast = i === pieces.length - 1;
    if (isLast && piece.includes(".")) {
      const octets = parseIPv4Groups(piece);
      if (octets === null) return null;
      out.push((octets[0]! << 8) | octets[1]!);
      out.push((octets[2]! << 8) | octets[3]!);
      continue;
    }
    if (!HEX_GROUP.test(piece)) return null;
    out.push(parseInt(piece, 16));
  }
  return out;
}

function parseIPv6(s: string): number[] | null {
  const dc = s.indexOf("::");
  if (dc === -1) {
    const groups = parseIPv6Groups(s);
    if (groups === null || groups.length !== 8) return null;
    return groups;
  }
  if (s.indexOf("::", dc + 1) !== -1) return null;
  const head = parseIPv6Groups(s.slice(0, dc));
  const tail = parseIPv6Groups(s.slice(dc + 2));
  if (head === null || tail === null) return null;
  if (head.length + tail.length >= 8) return null;
  const zeros = new Array<number>(8 - head.length - tail.length).fill(0);
  return [...head, ...zeros, ...tail];
}

/** RFC 5952 规范化输出；v4 映射地址（::ffff:0:0/96）输出点分十进制（Go To4 语义）。 */
function formatIPv6(groups: number[]): string {
  let v4Mapped = true;
  for (let g = 0; g < 5; g++) {
    if (groups[g] !== 0) {
      v4Mapped = false;
      break;
    }
  }
  if (v4Mapped && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  // 最长零段压缩（>=2 组，取最靠左的一段）。
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] === 0) {
      let j = i;
      while (j < 8 && groups[j] === 0) j++;
      if (j - i > bestLen) {
        bestLen = j - i;
        bestStart = i;
      }
      i = j;
    } else {
      i++;
    }
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(":");
  const head = groups.slice(0, bestStart).map((g) => g.toString(16)).join(":");
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(":");
  return `${head}::${tail}`;
}

/**
 * 解析 IP 并返回规范化字符串（Go net.ParseIP + ip.String()），非法输入返回 null。
 * 与 Go 一致：先出现 "." 走 IPv4、先出现 ":" 走 IPv6，不做 trim。
 */
export function parseIP(value: string): string | null {
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === ".") {
      const octets = parseIPv4Groups(value);
      return octets !== null ? octets.join(".") : null;
    }
    if (c === ":") {
      const groups = parseIPv6(value);
      return groups !== null ? formatIPv6(groups) : null;
    }
  }
  return null;
}

/** net.ParseCIDR：返回掩码后的网络规范化串 + 前缀长度。 */
export interface ParsedCIDR {
  network: string;
  ones: number;
  bits: 32 | 128;
}

export function parseCIDR(s: string): ParsedCIDR | null {
  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  if (s.indexOf("/", slash + 1) !== -1) return null;
  const addr = s.slice(0, slash);
  const maskStr = s.slice(slash + 1);
  if (!/^\d{1,3}$/.test(maskStr)) return null;
  const ones = Number(maskStr);
  if (addr.includes(":")) {
    const groups = parseIPv6(addr);
    if (groups === null || ones > 128) return null;
    const full = Math.floor(ones / 16);
    const rem = ones % 16;
    const masked = groups.map((g, i) => {
      if (i < full) return g;
      if (i === full) return rem === 0 ? 0 : g & ((0xffff << (16 - rem)) & 0xffff);
      return 0;
    });
    return { network: `${formatIPv6(masked)}/${ones}`, ones, bits: 128 };
  }
  const octets = parseIPv4Groups(addr);
  if (octets === null || ones > 32) return null;
  const masked = octets.map((o, i) => {
    const bitsLeft = ones - i * 8;
    if (bitsLeft >= 8) return o;
    if (bitsLeft <= 0) return 0;
    return o & ((0xff << (8 - bitsLeft)) & 0xff);
  });
  return { network: `${masked.join(".")}/${ones}`, ones, bits: 32 };
}

/** C 段：IPv4 → /24、IPv6 → /48（calcCSegment）。 */
export function calcCSegment(ipStr: string): string {
  if (ipStr === "") return "";
  const canonical = parseIP(ipStr);
  if (canonical === null) return "";
  if (!canonical.includes(":")) {
    const parts = canonical.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    return "";
  }
  const groups = parseIPv6(canonical);
  if (groups === null) return "";
  const masked = [groups[0]!, groups[1]!, groups[2]!, 0, 0, 0, 0, 0];
  return `${formatIPv6(masked)}/48`;
}

/** RootDomain：eTLD+1（tldts 对齐 Go publicsuffix）。IP/无法分类的主机以自身为根。 */
export function rootDomain(host: string): { root: string; isApex: boolean } {
  const h = domainKey(host);
  if (h === "" || parseIP(h) !== null) return { root: h, isApex: true };
  const p = tldtsParse(h, { allowPrivateDomains: true });
  const etld1 = p?.domain ?? "";
  if (etld1 === "") return { root: h, isApex: true };
  return { root: etld1, isApex: h === etld1 };
}

/** 是否为 ICANN 公共后缀本身（ParseScopeLine 的裸 TLD 拒绝条件）。 */
function isIcannPublicSuffix(d: string): boolean {
  const p = tldtsParse(d, { allowPrivateDomains: true });
  return p?.isIcann === true && p.publicSuffix === d;
}

// ─── URL 归一化（assets.go normalizeURL/parseURL/defaultPort）────────────────

// RFC 3986 拆分：scheme: "//" authority path "?" query "#" fragment。
// 不用 WHATWG URL：其会把空路径补 "/"、删除 http 默认端口等，与 Go net/url 的
// u.String() 重建结果不一致（url 列是去重键，必须保持 Go 的重建语义）。
const URL_SPLIT_RE = /^([A-Za-z][A-Za-z0-9+.\-]*):(?:\/\/([^/?#]*)([^?#]*))?(\?[^#]*)?(#.*)?$/;

/** Go URL.EscapedPath/Fragment: retain a valid raw spelling; otherwise escape decoded UTF-8 bytes. */
function escapedURLPart(raw:string,fragment=false):string {
  const valid=fragment?/^[A-Za-z0-9_~.\-!$&'()*+,;=:@/?%\[\]]*$/:/^[A-Za-z0-9_~.\-!$&'()*+,;=:@/%\[\]]*$/;
  if(valid.test(raw)&&!/%(?![0-9a-f]{2})/i.test(raw))return raw;
  const bytes:number[]=[];
  for(const part of raw.match(/%[0-9a-f]{2}|[^%]+|%/gi)??[]) {
    if(/^%[0-9a-f]{2}$/i.test(part))bytes.push(parseInt(part.slice(1),16));else bytes.push(...Buffer.from(part));
  }
  return bytes.map(b=>{const c=String.fromCharCode(b);return /[A-Za-z0-9_~.\-$&+,/:;=@]/.test(c)||fragment&&/[?!()*]/.test(c)?c:'%'+b.toString(16).toUpperCase().padStart(2,'0');}).join('');
}
/** normalizeURL：scheme/host 小写；裸根去掉尾斜杠。解析失败原样返回。 */
export function normalizeURL(raw: string): string {
  const m = URL_SPLIT_RE.exec(raw);
  if (!m || /[\u0000-\u001f\u007f]/.test(raw) || /%(?![0-9a-f]{2})/i.test(raw)) return raw;
  const scheme = m[1]!;
  if (m[2] === undefined) {
    // 无 "//"（opaque/相对形式）：仅小写 scheme，其余原样（Go u.String() 行为）。
    return scheme.toLowerCase() + raw.slice(scheme.length);
  }
  const authority = m[2];
  const path = escapedURLPart(m[3] ?? "");
  const query = m[4] ?? "";
  const fragment = m[5] ? "#"+escapedURLPart(m[5].slice(1),true) : "";
  let userinfo = "";
  let hostPart = authority;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    userinfo = authority.slice(0, at + 1);
    hostPart = authority.slice(at + 1);
  }
  let s = `${scheme.toLowerCase()}://${userinfo}${hostPart.toLowerCase()}${path}${query}${fragment}`;
  if (s.endsWith("/") && path === "/" && query === "") s = s.slice(0, -1);
  return s;
}

function defaultPort(scheme: string, p: string): number {
  if (p !== "") {
    const n = Number.parseInt(p, 10);
    if (!Number.isNaN(n)) return n;
  }
  switch (scheme) {
    case "https":
      return 443;
    case "http":
      return 80;
    default:
      return 0;
  }
}

function hostnameOf(authority: string): { host: string; portStr: string } {
  let host = authority;
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close >= 0) {
      return { host: host.slice(1, close), portStr: host.slice(close + 1).replace(/^:/, "") };
    }
    return { host: "", portStr: "" };
  }
  const colon = host.lastIndexOf(":");
  if (colon >= 0) return { host: host.slice(0, colon), portStr: host.slice(colon + 1) };
  return { host, portStr: "" };
}

/** parseURL：从 URL 提取 domain/port/service_name。 */
export function parseURL(raw: string): { domain: string; port: number; serviceName: string } {
  const m = URL_SPLIT_RE.exec(raw);
  if (!m) return { domain: "", port: 0, serviceName: "" };
  const scheme = m[1]!.toLowerCase();
  const { host, portStr } = hostnameOf(m[2] ?? "");
  let serviceName: string;
  switch (scheme) {
    case "https":
      serviceName = "HTTPS";
      break;
    case "http":
      serviceName = "HTTP";
      break;
    default:
      serviceName = scheme.toUpperCase();
  }
  return { domain: host.toLowerCase(), port: defaultPort(scheme, portStr), serviceName };
}

// ─── 数组/参数序列化（assets.go marshal*，PG 数组字面量）──────────────────────

export function marshalStringArray(items: string[]): string {
  if (items.length === 0) return "{}";
  return "{" + items.map((s) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(",") + "}";
}

export function marshalJSONBArray(items: Record<string, unknown>[]): string {
  if (items.length === 0) return "{}";
  return (
    "{" +
    items
      .map((m) => {
        // PG jsonb[] 数组字面量：元素整体双引号包裹，内部反斜杠与双引号转义。
        const s = JSON.stringify(m).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        return `"${s}"`;
      })
      .join(",") +
    "}"
  );
}

export interface PortService {
  port: number;
  service: string;
}

export function marshalPortServices(ps: PortService[]): string {
  return marshalJSONBArray(ps.map((p) => ({ port: p.port, service: p.service })));
}

function taskIDsLiteral(taskID: number): string {
  return taskID > 0 ? `{${taskID}}` : "{}";
}

function nullablePort(port: number): number | null {
  return port === 0 ? null : port;
}

// ─── 资产 IP 校验（assets.go ValidateAssetIP）────────────────────────────────

export class AssetIPInvalidError extends Error {
  constructor(message = "invalid asset ip") {
    super(message);
    this.name = "AssetIPInvalidError";
  }
}

/** assets.ip 只接受 IPv4/IPv6（网段归属会把该列 cast 成 inet，主机名会被静默漏归属）。 */
export function validateAssetIP(value: string): void {
  if (value === "" || parseIP(value) !== null) return;
  throw new AssetIPInvalidError(
    `ip 必须是 IPv4/IPv6 地址，收到 ${JSON.stringify(value)}。` +
      `若这是主机名，请改用 type=subdomain 并填 domain 字段；` +
      `若确实要登记地址，请先解析出 A/AAAA 记录，再用解析出的地址填 ip`,
  );
}

// ─── 任务资产主机归一化（task_assets.go normalizeTaskAssetHost，linkHostAssets 用）──

export function normalizeTaskAssetHost(value: string): string {
  let v = value.trim().toLowerCase().replace(/^[\[]+/, "").replace(/[\]]+$/, "");
  const m = URL_SPLIT_RE.exec(v);
  if (m !== null && m[2] !== undefined) {
    const host = hostnameOf(m[2]).host; // 剥 userinfo/端口/IPv6 括号（Go u.Hostname()）
    if (host !== "") v = host;
  }
  const ip = parseIP(v);
  if (ip !== null) return ip;
  return v.replace(/\.$/, "");
}

// ─── 资产类型与读取映射 ───────────────────────────────────────────────────────

export interface Asset {
  id: number;
  type: string;
  company_id?: number;
  task_ids: number[];
  domain: string;
  root_domain: string;
  ip: string;
  c_segment: string;
  port?: number;
  icp: string;
  bound_domains: string[];
  open_ports: Record<string, unknown>[];
  record_type: string;
  record_value: string[];
  bundle_id: string;
  app_name: string;
  category: string;
  app_description: string;
  app_icp: string;
  url: string;
  service_type: string;
  service_name: string;
  favicon_mmh3: string;
  status_code?: number;
  content_length?: number;
  page_title: string;
  technologies: string[];
  auth: Record<string, unknown>[];
  method: string;
  params: Record<string, unknown>[];
  extra: Record<string, unknown>;
  last_seen: string;
}

// 宽 SELECT：与 Go assetSelectCols 同列（jsonb 参数化由 pg 自动解析，数组列用 ::text 传输后 JSON.parse）。
const ASSET_SELECT_COLS = `SELECT id, type, company_id, array_to_json(task_ids)::text AS task_ids,
       COALESCE(domain,'') AS domain, COALESCE(root_domain,'') AS root_domain, COALESCE(ip,'') AS ip,
       COALESCE(c_segment::text,'') AS c_segment, port,
       COALESCE(icp,'') AS icp, array_to_json(bound_domains)::text AS bound_domains,
       array_to_json(open_ports)::text AS open_ports, COALESCE(record_type,'') AS record_type,
       array_to_json(record_value)::text AS record_value, COALESCE(bundle_id,'') AS bundle_id, COALESCE(app_name,'') AS app_name,
       COALESCE(category,'') AS category, COALESCE(app_description,'') AS app_description, COALESCE(app_icp,'') AS app_icp,
       COALESCE(url,'') AS url, COALESCE(service_type,'') AS service_type, COALESCE(service_name,'') AS service_name,
       COALESCE(favicon_mmh3,'') AS favicon_mmh3, status_code, content_length,
       COALESCE(page_title,'') AS page_title, array_to_json(technologies)::text AS technologies, array_to_json(auth)::text AS auth,
       COALESCE(method,'') AS method, array_to_json(params)::text AS params, extra, last_seen::text AS last_seen
FROM assets`;

function parseJSONColumn<T>(v: unknown): T {
  return typeof v === "string" && v.length > 0 ? (JSON.parse(v) as T) : ([] as unknown as T);
}

function mapAsset(row: Record<string, unknown>): Asset {
  return {
    id: Number(row["id"]),
    type: String(row["type"]),
    company_id: row["company_id"] === null || row["company_id"] === undefined ? undefined : Number(row["company_id"]),
    task_ids: parseJSONColumn<number[]>(row["task_ids"]),
    domain: String(row["domain"] ?? ""),
    root_domain: String(row["root_domain"] ?? ""),
    ip: String(row["ip"] ?? ""),
    c_segment: String(row["c_segment"] ?? ""),
    port: row["port"] === null || row["port"] === undefined ? undefined : Number(row["port"]),
    icp: String(row["icp"] ?? ""),
    bound_domains: parseJSONColumn<string[]>(row["bound_domains"]),
    open_ports: parseJSONColumn<Record<string, unknown>[]>(row["open_ports"]),
    record_type: String(row["record_type"] ?? ""),
    record_value: parseJSONColumn<string[]>(row["record_value"]),
    bundle_id: String(row["bundle_id"] ?? ""),
    app_name: String(row["app_name"] ?? ""),
    category: String(row["category"] ?? ""),
    app_description: String(row["app_description"] ?? ""),
    app_icp: String(row["app_icp"] ?? ""),
    url: String(row["url"] ?? ""),
    service_type: String(row["service_type"] ?? ""),
    service_name: String(row["service_name"] ?? ""),
    favicon_mmh3: String(row["favicon_mmh3"] ?? ""),
    status_code: row["status_code"] === null || row["status_code"] === undefined ? undefined : Number(row["status_code"]),
    content_length:
      row["content_length"] === null || row["content_length"] === undefined ? undefined : Number(row["content_length"]),
    page_title: String(row["page_title"] ?? ""),
    technologies: parseJSONColumn<string[]>(row["technologies"]),
    auth: parseJSONColumn<Record<string, unknown>[]>(row["auth"]),
    method: String(row["method"] ?? ""),
    params: parseJSONColumn<Record<string, unknown>[]>(row["params"]),
    extra: (row["extra"] as Record<string, unknown>) ?? {},
    last_seen: String(row["last_seen"] ?? ""),
  };
}

// ─── Scope 解析（db/company_scope.go）────────────────────────────────────────

export interface ParsedScope {
  kind: string; // "domain" | "ip" | "cidr" | "icp" | "keyword"
  domain?: string;
  net?: string;
  value?: string;
  raw: string;
}

export interface ScopeInput {
  kind?: string;
  value: string;
  manual?: boolean;
}

/** NormalizeICP：去全部 Unicode 空白 + 小写（备案号匹配是精确相等，不做模糊归一）。 */
export function normalizeICP(value: string): string {
  return value.trim().replace(new RegExp(UNICODE_SPACE.source, "g"), "").toLowerCase();
}

function normalizeKeyword(value: string): string {
  return fields(value).join(" ").toLowerCase();
}

export function looksLikeIPAddress(value: string): boolean {
  value = value.trim();
  if (value.includes("://") || hasUnicodeSpace(value)) return false;
  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount >= 2) {
    // 要求形似 IPv6 前缀：普通冒号分隔的关键词不会被当成 IP，
    // 但 2001:db8::zz 这类畸形值仍会命中（与 Go 一致）。
    const parts = value.split(":");
    let validSegments = 0;
    for (const part of parts) {
      if (part === "") {
        if (validSegments > 0 || value.startsWith("::")) return true;
        continue;
      }
      if (part.length > 4) return false;
      for (const r of part) {
        if (!((r >= "0" && r <= "9") || (r >= "a" && r <= "f") || (r >= "A" && r <= "F"))) return false;
      }
      validSegments++;
      if (validSegments >= 2) return true;
    }
    return false;
  }
  if (!value.includes(".")) return false;
  for (const r of value) {
    if (r !== "." && (r < "0" || r > "9")) return false;
  }
  return true;
}

/** ParseScopeInput：显式类型化规则；空 kind 走自动分类。非法输入抛 Error。 */
export function parseScopeInput(input: ScopeInput): ParsedScope {
  if (input.manual === true) {
    const raw = input.value.trim();
    if (raw === "") throw new Error("范围内容不能为空");
    const cidr = parseCIDR(raw);
    if (cidr !== null) return { kind: "cidr", net: cidr.network, raw };
    // URL 与证书本身就是证据：不强转 host/keyword，不丢路径/端口/大小小/换行。
    if (!raw.includes("://") && !raw.includes("-----BEGIN")) {
      try {
        const rule = parseScopeInput({ kind: input.kind, value: input.value });
        if (rule.kind !== "keyword") return rule;
      } catch {
        // 自动分类失败 → 关键词兜底
      }
    }
    return { kind: "keyword", value: raw, raw };
  }
  const kind = (input.kind ?? "").trim().toLowerCase();
  const raw = input.value.trim();
  if (kind === "") return parseAutoScopeLine(raw);
  switch (kind) {
    case "domain":
    case "ip":
    case "cidr": {
      const rule = parseScopeLine(raw);
      if (rule.kind !== kind) throw new Error(`"${raw}" 不是有效的 ${kind} 范围`);
      return rule;
    }
    case "icp": {
      const value = normalizeICP(raw);
      if (value === "") throw new Error("ICP 不能为空");
      return { kind, value, raw };
    }
    case "keyword": {
      const value = normalizeKeyword(raw);
      if (value === "") throw new Error("企业关键词不能为空");
      return { kind, value, raw };
    }
    default:
      throw new Error(`不支持的范围类型: ${kind}`);
  }
}

/** ParseAutoScopeLine：无类型文本行的自动分类（网络/域名从严，其余为关键词）。 */
export function parseAutoScopeLine(line: string): ParsedScope {
  const raw = line.trim();
  if (raw === "") throw new Error("空行");

  if (parseCIDR(raw) !== null) return parseScopeLine(raw);
  if (parseIP(raw) !== null) return parseScopeLine(raw);
  const slash = raw.lastIndexOf("/");
  if (slash > 0) {
    const address = raw.slice(0, slash).trim();
    if (parseIP(address) !== null || looksLikeIPAddress(address)) {
      throw new Error(`无效 CIDR: ${raw}`);
    }
  }
  if (looksLikeIPAddress(raw)) throw new Error(`无效 IP: ${raw}`);

  const looksLikeDomain = raw.includes("://") || (raw.includes(".") && !hasUnicodeSpace(raw));
  if (looksLikeDomain) return parseScopeLine(raw);
  // 备案号本身不含点号（如 京ICP备12345678号-1）。带点的文本归为关键词：
  // ICP 归属走精确相等比较，存成死规则毫无意义。
  const lower = raw.toLowerCase();
  if (!/[.．。]/.test(raw) && (lower.includes("icp") || raw.includes("备案"))) {
    return parseScopeInput({ kind: "icp", value: raw });
  }
  return parseScopeInput({ kind: "keyword", value: raw });
}

/** scopeHostname：从原始行提取规范主机名（支持 //、URL、IDNA、IPv6）。失败抛 Error。 */
function scopeHostname(raw: string): string {
  let candidate = raw.trim();
  if (candidate.startsWith("//")) {
    candidate = "http:" + candidate;
  } else if (!candidate.includes("://")) {
    candidate = "http://" + candidate;
  }
  // 与 Go net/url.Parse 的 Host 提取对齐：不用 WHATWG URL——它会把非 ASCII 主机
  // 就地 punycode、并拒绝形如 1.2.3.999 的 IPv4 样式主机（Go 两者都放行到后续校验）。
  const m = URL_SPLIT_RE.exec(candidate);
  if (m === null || m[2] === undefined) throw new Error("缺少主机名");
  let host = hostnameOf(m[2]).host.trim().replace(/\.$/, "");
  if (host === "") throw new Error("主机名为空");
  const ip = parseIP(host);
  if (ip !== null) return ip;
  // domainToASCII 带 WHATWG 主机校验（拒绝 1.2.3.999 这类 IPv4 样式主机），而 Go 的
  // idna 对纯 ASCII 主机原样放行、交给后续标签校验——这里对齐 Go：纯 ASCII 不因转写失败而拒绝。
  let ascii = domainToASCII(host);
  if (ascii === "" && /^[\x21-\x7e]+$/.test(host)) ascii = host;
  if (ascii === "") throw new Error("invalid idna host");
  host = ascii.toLowerCase();
  if (host.length > 253) throw new Error("域名超过 253 个字符");
  const labels = host.split(".");
  if (labels.length < 2) throw new Error("域名至少需要两个标签");
  for (const label of labels) {
    if (label === "" || label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
      throw new Error("域名标签无效");
    }
    for (const r of label) {
      if (!((r >= "a" && r <= "z") || (r >= "0" && r <= "9") || r === "-")) {
        throw new Error("域名包含无效字符");
      }
    }
  }
  return host;
}

function ipScopeNet(canonicalIP: string): string {
  return canonicalIP.includes(":") ? `${canonicalIP}/128` : `${canonicalIP}/32`;
}

/** ParseScopeLine：域名/IP/CIDR 三类的分类与校验（护栏：裸 TLD、过宽网段、IP 段写法）。 */
export function parseScopeLine(line: string): ParsedScope {
  const raw = line.trim();
  if (raw === "") throw new Error("空行");
  // CIDR 优先：URL 解析会把 "/" 当路径分隔符。
  const cidr = parseCIDR(raw);
  if (cidr !== null) {
    if (cidr.bits === 32 && cidr.ones < 16) throw new Error(`网段过宽(IPv4 需 >= /16): ${raw}`);
    if (cidr.bits === 128 && cidr.ones < 32) throw new Error(`网段过宽(IPv6 需 >= /32): ${raw}`);
    return { kind: "cidr", net: cidr.network, raw };
  }
  let ip = parseIP(raw);
  if (ip !== null) return { kind: "ip", net: ipScopeNet(ip), raw };
  let host: string;
  try {
    host = scopeHostname(raw);
  } catch {
    throw new Error(`无法识别为有效域名/IP/CIDR: ${raw}`);
  }
  ip = parseIP(host);
  if (ip !== null) return { kind: "ip", net: ipScopeNet(ip), raw };
  if (looksLikeIPAddress(host)) throw new Error(`无效 IP: ${raw}`);
  if (raw.includes("-") && (raw.match(/\./g) ?? []).length >= 6) {
    throw new Error(`IP 段请用 CIDR 表示(如 1.2.3.0/24): ${raw}`);
  }
  // 域名（按注册域存储）：拒绝裸 TLD / 公共后缀。
  const d = domainKey(host);
  if (isIcannPublicSuffix(d)) throw new Error(`不能用裸 TLD 作为范围: ${raw}`);
  return { kind: "domain", domain: d, raw };
}

// ─── 公司层（db/companies.go）────────────────────────────────────────────────

export interface Company {
  id: number;
  name: string;
  nkey: string;
  logo?: string;
  created_at: string;
  updated_at: string;
}

export interface ScopeRule {
  id: number;
  company_id: number;
  kind: string;
  domain: string;
  net: string;
  value: string;
  raw: string;
  reason: string;
}

export class CompanyNameConflictError extends Error {
  constructor(message = "company name already exists") {
    super(message);
    this.name = "CompanyNameConflictError";
  }
}

export class CompanyNotFoundError extends Error {
  constructor(message = "company not found") {
    super(message);
    this.name = "CompanyNotFoundError";
  }
}

/** 客户端可修正的范围错误（存储/事务错误用普通 Error 抛出）。 */
export class CompanyScopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyScopeValidationError";
  }
}

export const MAX_COMPANY_SCOPE_RAW_RUNES = 65536;
export const MAX_COMPANY_SCOPE_VALUE_RUNES = 65536;

// scope 写入会全局重建派生归属，advisory 锁串行化；7337741001 是 schema 锁，
// 7337741002 是跨包测试锁，7337741003 留给公司变更。
const COMPANY_SCOPE_MUTATION_LOCK = 7337741003;

export function validateCompanyScopeInputBounds(inputs: ScopeInput[]): void {
  for (let i = 0; i < inputs.length; i++) {
    if (runeLen(inputs[i]!.value) > MAX_COMPANY_SCOPE_RAW_RUNES) {
      throw new CompanyScopeValidationError(
        `企业范围第 ${i + 1} 条原始值过长: 最多 ${MAX_COMPANY_SCOPE_RAW_RUNES} 个字符`,
      );
    }
  }
}

function validateParsedScopeBounds(rules: ParsedScope[]): void {
  for (let i = 0; i < rules.length; i++) {
    if (runeLen(rules[i]!.raw) > MAX_COMPANY_SCOPE_RAW_RUNES) {
      throw new CompanyScopeValidationError(
        `企业范围第 ${i + 1} 条原始值过长: 最多 ${MAX_COMPANY_SCOPE_RAW_RUNES} 个字符`,
      );
    }
    if (runeLen(rules[i]!.value ?? "") > MAX_COMPANY_SCOPE_VALUE_RUNES) {
      throw new CompanyScopeValidationError(
        `企业范围第 ${i + 1} 条规范化值过长: 最多 ${MAX_COMPANY_SCOPE_VALUE_RUNES} 个字符`,
      );
    }
  }
}

function parseScopeInputs(inputs: ScopeInput[]): { rules: ParsedScope[]; invalid: number; validationErrors: string[] } {
  const rules: ParsedScope[] = [];
  let invalid = 0;
  const validationErrors: string[] = [];
  for (const input of inputs) {
    try {
      rules.push(parseScopeInput(input));
    } catch (err) {
      invalid++;
      validationErrors.push(`${input.value}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { rules, invalid, validationErrors };
}

async function lockCompanyScopeMutation(q: SQLQuerier): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock($1)`, [COMPANY_SCOPE_MUTATION_LOCK]);
}

async function ensureCompanyExistsTx(q: SQLQuerier, companyID: number): Promise<void> {
  const res = await q.query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM companies WHERE id = $1) AS ok`, [companyID]);
  if (res.rows[0]?.ok !== true) throw new CompanyNotFoundError();
}

/** 插入一条 scope 规则；inserted=false 表示 ON CONFLICT 忽略的重复项。 */
async function insertScopeRuleTx(q: SQLQuerier, companyID: number, rule: ParsedScope, reason: string): Promise<boolean> {
  let res: QueryResult;
  switch (rule.kind) {
    case "domain":
      res = await q.query(
        `INSERT INTO company_scope(company_id, kind, domain, raw, reason)
         VALUES ($1, 'domain', $2, $3, $4)
         ON CONFLICT ON CONSTRAINT uq_sv2_domain DO NOTHING`,
        [companyID, rule.domain, rule.raw, reason],
      );
      break;
    case "ip":
    case "cidr":
      res = await q.query(
        `INSERT INTO company_scope(company_id, kind, net, raw, reason)
         VALUES ($1, $2, $3::cidr, $4, $5)
         ON CONFLICT ON CONSTRAINT uq_sv2_net DO NOTHING`,
        [companyID, rule.kind, rule.net, rule.raw, reason],
      );
      break;
    case "icp":
    case "keyword":
      res = await q.query(
        `INSERT INTO company_scope(company_id, kind, value, raw, reason)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, kind, md5(value)) WHERE kind IN ('icp','keyword') DO NOTHING`,
        [companyID, rule.kind, rule.value, rule.raw, reason],
      );
      break;
    default:
      throw new Error(`unsupported company scope kind "${rule.kind}"`);
  }
  return (res.rowCount ?? 0) > 0;
}

async function insertScopeRulesTx(
  q: SQLQuerier,
  companyID: number,
  rules: ParsedScope[],
  reason: string,
): Promise<{ added: number; skipped: number; needsAttribution: boolean }> {
  let added = 0;
  let skipped = 0;
  let needsAttribution = false;
  for (const rule of rules) {
    const inserted = await insertScopeRuleTx(q, companyID, rule, reason);
    if (!inserted) {
      skipped++;
      continue;
    }
    added++;
    needsAttribution = needsAttribution || rule.kind !== "keyword";
  }
  return { added, skipped, needsAttribution };
}

const MALFORMED_IP_ASSETS_SAMPLED = 5;

function logAttributionWarning(warning: string): void {
  if (warning !== "") console.log(`[assets] ${warning}`);
}

/** 报告 ip 列无法解析的资产：它们对网段规则不可见，必须让运维知道而不是静默跳过。 */
async function malformedIPAssetWarning(q: SQLQuerier): Promise<string> {
  const res = await q.query<{ id: string; ip: string; total: string }>(
    `SELECT id, ip, count(*) OVER () AS total
     FROM assets
     WHERE ip IS NOT NULL AND ip <> '' AND try_inet(ip) IS NULL
       AND type IN ('ip','subdomain','service','endpoint')
     ORDER BY id
     LIMIT $1`,
    [MALFORMED_IP_ASSETS_SAMPLED],
  );
  if (res.rows.length === 0) return "";
  const total = Number(res.rows[0]!.total);
  const samples = res.rows.map((r) => `#${r.id} ${r.ip}`);
  let warning =
    `${total} 条资产的 ip 字段不是合法 IP，已跳过 IP/CIDR 范围匹配（这些资产不会被网段规则归属到企业）：` +
    samples.join("、");
  if (total > samples.length) warning += ` 等 ${total} 条`;
  return warning;
}

/** RecomputeAttributionTx：只重建派生（scope）归属。优先级 domain > IP/CIDR > 精确 ICP；keyword 不归属。 */
async function recomputeAttributionTx(q: SQLQuerier): Promise<string> {
  // 只清派生行；无来源标记的历史行按 schema 约定保守视为 explicit。
  await q.query(`UPDATE assets SET company_id = NULL, company_source = 'scope' WHERE company_source = 'scope'`);

  // 域名归属（root_domain 精确匹配，长域名优先）。
  await q.query(`
    WITH matched AS (
        SELECT DISTINCT ON (a.id) a.id AS asset_id, cs.company_id
        FROM assets a
        JOIN company_scope cs ON cs.kind = 'domain' AND a.root_domain = cs.domain
        WHERE a.company_id IS NULL
          AND a.type IN ('root_domain','subdomain','service','endpoint')
          AND a.root_domain IS NOT NULL
        ORDER BY a.id, length(cs.domain) DESC, cs.company_id
    )
    UPDATE assets a
    SET company_id = matched.company_id, company_source = 'scope'
    FROM matched
    WHERE a.id = matched.asset_id`);

  // IP/CIDR 归属（仍无主的资产；try_inet 跳过脏 ip 行）。
  await q.query(`
    WITH matched AS (
        SELECT DISTINCT ON (a.id) a.id AS asset_id, cs.company_id
        FROM assets a
        JOIN company_scope cs ON cs.kind IN ('ip','cidr') AND cs.net >>= try_inet(a.ip)
        WHERE a.company_id IS NULL
          AND a.type IN ('ip','subdomain','service','endpoint')
          AND a.ip IS NOT NULL
        ORDER BY a.id, masklen(cs.net) DESC, cs.company_id
    )
    UPDATE assets a
    SET company_id = matched.company_id, company_source = 'scope'
    FROM matched
    WHERE a.id = matched.asset_id`);

  // 精确 ICP 归属（最后）。
  await q.query(`
    WITH matched AS (
        SELECT DISTINCT ON (a.id) a.id AS asset_id, cs.company_id
        FROM assets a
        JOIN company_scope cs ON cs.kind = 'icp'
          AND (
            lower(regexp_replace(COALESCE(a.icp,''), '[[:space:]]+', '', 'g')) = cs.value
            OR lower(regexp_replace(COALESCE(a.app_icp,''), '[[:space:]]+', '', 'g')) = cs.value
          )
        WHERE a.company_id IS NULL
          AND (COALESCE(a.icp,'') <> '' OR COALESCE(a.app_icp,'') <> '')
        ORDER BY a.id, cs.company_id
    )
    UPDATE assets a
    SET company_id = matched.company_id, company_source = 'scope'
    FROM matched
    WHERE a.id = matched.asset_id`);
  return malformedIPAssetWarning(q);
}

/** 插入时归属解析：domain > IP/CIDR > 规范化 ICP（镜像 RecomputeAttribution）。 */
export async function resolveCompanyWithICP(
  q: SQLQuerier,
  rootDomain: string,
  ipStr: string,
  icp: string,
): Promise<number | null> {
  if (rootDomain !== "") {
    const r = await q.query<{ company_id: string }>(
      `SELECT company_id FROM company_scope
       WHERE kind = 'domain' AND domain = $1
       ORDER BY length(domain) DESC, company_id
       LIMIT 1`,
      [rootDomain],
    );
    if (r.rows.length > 0) return Number(r.rows[0]!.company_id);
  }
  if (ipStr !== "" && parseIP(ipStr) !== null) {
    const r = await q.query<{ company_id: string }>(
      `SELECT company_id FROM company_scope
       WHERE kind IN ('ip','cidr')
         AND net >>= $1::inet
       ORDER BY masklen(net) DESC, company_id
       LIMIT 1`,
      [ipStr],
    );
    if (r.rows.length > 0) return Number(r.rows[0]!.company_id);
  }
  const normalized = normalizeICP(icp);
  if (normalized !== "") {
    const r = await q.query<{ company_id: string }>(
      `SELECT company_id FROM company_scope
       WHERE kind = 'icp' AND value = $1
       ORDER BY company_id
       LIMIT 1`,
      [normalized],
    );
    if (r.rows.length > 0) return Number(r.rows[0]!.company_id);
  }
  return null;
}

export class CompanyStore {
  constructor(private readonly db: Database) {}

  /** UpsertCompany：按 nkey 幂等；返回 id 与是否新建（xmax=0）。 */
  async upsertCompany(name: string, logo: string): Promise<{ id: number; created: boolean }> {
    const nkey = companyNKey(name);
    const res = await this.db.query<{ id: string; created: boolean }>(
      `INSERT INTO companies(name, nkey, logo)
       VALUES ($1, $2, $3)
       ON CONFLICT (nkey) DO UPDATE SET
           name = EXCLUDED.name,
           logo = COALESCE(EXCLUDED.logo, companies.logo),
           updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [name, nkey, logo !== "" ? logo : null],
    );
    const row = res.rows[0]!;
    return { id: Number(row.id), created: row.created === true };
  }

  async upsertByName(name: string): Promise<number> {
    return (await this.upsertCompany(name, "")).id;
  }

  async getCompany(id: number): Promise<Company | null> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT id, name, nkey, logo, created_at::text AS created_at, updated_at::text AS updated_at
       FROM companies WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? mapCompany(res.rows[0]) : null;
  }

  async getCompanyByName(name: string): Promise<Company | null> {
    const nkey = companyNKey(name);
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT id, name, nkey, logo, created_at::text AS created_at, updated_at::text AS updated_at
       FROM companies WHERE nkey = $1`,
      [nkey],
    );
    return res.rows[0] ? mapCompany(res.rows[0]) : null;
  }

  async getScope(companyID: number): Promise<ScopeRule[]> {
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT id, company_id, kind,
              COALESCE(domain,'') AS domain, COALESCE(net::text,'') AS net, COALESCE(value,'') AS value,
              raw, COALESCE(reason,'') AS reason
       FROM company_scope
       WHERE company_id = $1
       ORDER BY id`,
      [companyID],
    );
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      company_id: Number(r["company_id"]),
      kind: String(r["kind"]),
      domain: String(r["domain"] ?? ""),
      net: String(r["net"] ?? ""),
      value: String(r["value"] ?? ""),
      raw: String(r["raw"]),
      reason: String(r["reason"] ?? ""),
    }));
  }

  /** CreateCompanyWithScope：建司不入旧（nkey 冲突报错）；有效规则与归属原子提交。 */
  async createCompanyWithScope(
    name: string,
    logo: string,
    inputs: ScopeInput[],
    reason: string,
  ): Promise<{ id: number; added: number; skipped: number; invalid: number; validationErrors: string[] }> {
    validateCompanyScopeInputBounds(inputs);
    const { rules, invalid, validationErrors } = parseScopeInputs(inputs);
    validateParsedScopeBounds(rules);
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCompanyScopeMutation(client);
      let id: number;
      let added = 0;
      let skipped = 0;
      try {
        const nkey = companyNKey(name);
        const ins = await client.query<{ id: string }>(
          `INSERT INTO companies(name, nkey, logo)
           VALUES ($1, $2, $3)
           ON CONFLICT (nkey) DO NOTHING
           RETURNING id`,
          [name, nkey, logo !== "" ? logo : null],
        );
        if (ins.rows.length === 0) throw new CompanyNameConflictError();
        id = Number(ins.rows[0]!.id);
        const r = await insertScopeRulesTx(client, id, rules, reason);
        added = r.added;
        skipped = r.skipped;
        if (r.needsAttribution) {
          logAttributionWarning(await recomputeAttributionTx(client));
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      return { id, added, skipped, invalid, validationErrors };
    } finally {
      client.release();
    }
  }

  /** AddScope：文本行形式。 */
  async addScope(
    companyID: number,
    lines: string[],
    reason: string,
  ): Promise<{ added: number; skipped: number; invalid: number; validationErrors: string[] }> {
    return this.addScopeInputs(
      companyID,
      lines.map((line) => ({ value: line })),
      reason,
    );
  }

  /** AddScopeInputs：存储/事务错误并入 validationErrors 返回（不抛）。 */
  async addScopeInputs(
    companyID: number,
    inputs: ScopeInput[],
    reason: string,
  ): Promise<{ added: number; skipped: number; invalid: number; validationErrors: string[] }> {
    try {
      return await this.addScopeInputsChecked(companyID, inputs, reason);
    } catch (err) {
      return {
        added: 0,
        skipped: 0,
        invalid: 0,
        validationErrors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  /** AddScopeInputsChecked：校验反馈与存储错误分离。 */
  async addScopeInputsChecked(
    companyID: number,
    inputs: ScopeInput[],
    reason: string,
  ): Promise<{ added: number; skipped: number; invalid: number; validationErrors: string[] }> {
    validateCompanyScopeInputBounds(inputs);
    const { rules, invalid, validationErrors } = parseScopeInputs(inputs);
    validateParsedScopeBounds(rules);
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCompanyScopeMutation(client);
      let added = 0;
      let skipped = 0;
      try {
        await ensureCompanyExistsTx(client, companyID);
        if (rules.length === 0) {
          await client.query("COMMIT");
          return { added: 0, skipped: 0, invalid, validationErrors };
        }
        const r = await insertScopeRulesTx(client, companyID, rules, reason);
        added = r.added;
        skipped = r.skipped;
        if (r.needsAttribution) {
          // recompute 自身的错误直接抛出（对应 Go 的 fmt.Errorf("重新计算企业归属失败: %w")）。
          logAttributionWarning(await recomputeAttributionTx(client));
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      return { added, skipped, invalid, validationErrors };
    } finally {
      client.release();
    }
  }

  async resolveCompany(rootDomain: string, ipStr: string): Promise<number | null> {
    return resolveCompanyWithICP(this.db, rootDomain, ipStr, "");
  }

  async resolveCompanyWithICP(rootDomain: string, ipStr: string, icp: string): Promise<number | null> {
    return resolveCompanyWithICP(this.db, rootDomain, ipStr, icp);
  }

  /** RecomputeAttribution：显式归属不可变，只重建派生归属。 */
  async recomputeAttribution(): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCompanyScopeMutation(client);
      try {
        const warning = await recomputeAttributionTx(client);
        logAttributionWarning(warning);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    } finally {
      client.release();
    }
  }
}

function mapCompany(row: Record<string, unknown>): Company {
  return {
    id: Number(row["id"]),
    name: String(row["name"]),
    nkey: String(row["nkey"]),
    logo: row["logo"] === null || row["logo"] === undefined ? undefined : String(row["logo"]),
    created_at: String(row["created_at"]),
    updated_at: String(row["updated_at"]),
  };
}

// ─── 资产 store（db/assets.go AssetStore）────────────────────────────────────

export class AssetStore {
  private readonly tx: PoolClient | null;
  readonly companies: CompanyStore;

  constructor(
    private readonly db: Database,
    tx: PoolClient | null = null,
  ) {
    this.tx = tx;
    this.companies = new CompanyStore(db);
  }

  /**
   * scope 解析与消费其结果的资产写在同一事务内串行（advisory xact lock）。
   * 嵌套副作用通过 scoped store 复用同一事务。
   */
  private async withCompanyScopeMutation(fn: (scoped: AssetStore) => Promise<number>): Promise<number> {
    if (this.tx !== null) return fn(this);
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await lockCompanyScopeMutation(client);
      const scoped = new AssetStore(this.db, client);
      let id: number;
      try {
        id = await fn(scoped);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      return id;
    } finally {
      client.release();
    }
  }

  /** Discovery, side-effect parents, provenance and template reconciliation commit together. */
  async registerAgentAsset(taskID: number, agent: string, owner: number | undefined, toolCallID: string | undefined,
    write: (store: AssetStore) => Promise<number>): Promise<number> {
    return this.withCompanyScopeMutation(async (store) => {
      const tx = store.tx!;
      if(owner){const row=await tx.query("SELECT n.id FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id WHERE t.id=$1 AND n.id=$2 AND n.kind='intent' AND n.payload->>'cancelled_by_user' IS DISTINCT FROM 'true'",[taskID,owner]);if(!row.rowCount)throw new Error('资产发现来源意图不存在或不属于本任务');}
      await tx.query("SELECT set_config('series.agent_discovery','on',true),set_config('series.origin_task',$1,true),set_config('series.asset_origin',$2,true)",
        [String(taskID), JSON.stringify({ agent_key: agent, node_id: owner ?? null, tool_use_id: toolCallID ?? null })]);
      const id = await write(store);
      await tx.query(`UPDATE task_asset_links SET source='agent',source_summary=$3,source_node_id=$4
        WHERE task_id=$1 AND asset_id=$2 AND source IN ('agent','system')`,
        [taskID,id,owner ? `Worker 意图 #${owner} 通过 insert_assets 登记` : 'Agent 通过 insert_assets 登记',owner ?? null]);
      return id;
    });
  }

  private async resolveCompanyWithICP(rootDomain: string, ipStr: string, icp: string): Promise<number | null> {
    if (this.tx !== null) return resolveCompanyWithICP(this.tx, rootDomain, ipStr, icp);
    return resolveCompanyWithICP(this.db, rootDomain, ipStr, icp);
  }

  // ─── UpsertRootDomain ──────────────────────────────────────────────────────

  async upsertRootDomain(req: { domain: string; icp?: string; taskID?: number }): Promise<number> {
    const domain = domainKey(req.domain);
    if (domain === "") throw new Error("domain is required");
    if (this.tx === null) {
      return this.withCompanyScopeMutation((scoped) => scoped.upsertRootDomain(req));
    }
    const icp = req.icp ?? "";
    const taskID = req.taskID ?? 0;
    const companyID = await this.resolveCompanyWithICP(domain, "", icp);
    const res = await this.tx.query<{ id: string }>(
      `INSERT INTO assets(type, domain, root_domain, icp, company_id, company_source, task_ids)
      VALUES ('root_domain', $1, $1, $2, $3, 'scope', $4::bigint[])
      ON CONFLICT (domain) WHERE type = 'root_domain' DO UPDATE SET
          icp        = COALESCE(EXCLUDED.icp, assets.icp),
          company_id = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN assets.company_id
              ELSE COALESCE(EXCLUDED.company_id, assets.company_id)
          END,
          company_source = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN 'explicit'
              WHEN EXCLUDED.company_id IS NOT NULL THEN 'scope'
              ELSE assets.company_source
          END,
          task_ids   = (SELECT ARRAY(SELECT DISTINCT unnest(assets.task_ids || EXCLUDED.task_ids))),
          extra      = assets.extra || EXCLUDED.extra,
          last_seen  = now()
      RETURNING id`,
      [domain, icp !== "" ? icp : null, companyID, taskIDsLiteral(taskID)],
    );
    return Number(res.rows[0]!.id);
  }

  // ─── UpsertIP ──────────────────────────────────────────────────────────────

  async upsertIP(req: {
    ip: string;
    boundDomains?: string[];
    openPorts?: PortService[];
    taskID?: number;
  }): Promise<number> {
    const parsed = parseIP(req.ip.trim());
    if (parsed !== null) req.ip = parsed;
    if (req.ip === "") throw new Error("ip is required");
    validateAssetIP(req.ip);
    if (this.tx === null) {
      return this.withCompanyScopeMutation((scoped) => scoped.upsertIP(req));
    }
    const taskID = req.taskID ?? 0;
    const cseg = calcCSegment(req.ip);
    const companyID = await this.resolveCompanyWithICP("", req.ip, "");
    const boundDomains = marshalStringArray(req.boundDomains ?? []);
    const openPortsJSON = marshalPortServices(req.openPorts ?? []);
    const res = await this.tx.query<{ id: string }>(
      `INSERT INTO assets(type, ip, c_segment, bound_domains, open_ports, company_id, company_source, task_ids)
      VALUES ('ip', $1, $2::cidr, $3::text[], $4::jsonb[], $5, 'scope', $6::bigint[])
      ON CONFLICT (ip) WHERE type = 'ip' DO UPDATE SET
          bound_domains = (SELECT ARRAY(SELECT DISTINCT unnest(assets.bound_domains || EXCLUDED.bound_domains))),
          open_ports    = (
              SELECT ARRAY(
                  SELECT DISTINCT ON ((elem->>'port')::int) elem
                  FROM unnest(assets.open_ports || EXCLUDED.open_ports) AS elem
                  ORDER BY (elem->>'port')::int,
                           CASE WHEN elem->>'service' IS NOT NULL AND elem->>'service' <> '' THEN 0 ELSE 1 END
              )
          ),
          c_segment  = COALESCE(assets.c_segment, EXCLUDED.c_segment),
          company_id = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN assets.company_id
              ELSE COALESCE(EXCLUDED.company_id, assets.company_id)
          END,
          company_source = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN 'explicit'
              WHEN EXCLUDED.company_id IS NOT NULL THEN 'scope'
              ELSE assets.company_source
          END,
          task_ids   = (SELECT ARRAY(SELECT DISTINCT unnest(assets.task_ids || EXCLUDED.task_ids))),
          last_seen  = now()
      RETURNING id`,
      [req.ip, cseg !== "" ? cseg : null, boundDomains, openPortsJSON, companyID, taskIDsLiteral(taskID)],
    );
    return Number(res.rows[0]!.id);
  }

  /** AppendIPPort：向既有 ip 资产追加 {port, service}。 */
  async appendIPPort(ipStr: string, port: number, serviceName: string): Promise<void> {
    if (ipStr === "" || port === 0) return;
    const entry = JSON.stringify({ port, service: serviceName });
    await this.db.query(
      `UPDATE assets SET
          open_ports = (
              SELECT ARRAY(
                  SELECT DISTINCT ON ((elem->>'port')::int) elem
                  FROM unnest(open_ports || ARRAY[$1::jsonb]) AS elem
                  ORDER BY (elem->>'port')::int,
                           CASE WHEN elem->>'service' IS NOT NULL AND elem->>'service' <> '' THEN 0 ELSE 1 END
              )
          ),
          last_seen = now()
      WHERE type = 'ip' AND ip = $2`,
      [entry, ipStr],
    );
  }

  /** AppendIPBoundDomain：向既有 ip 资产追加绑定域名。 */
  async appendIPBoundDomain(ipStr: string, domain: string): Promise<void> {
    if (ipStr === "" || domain === "") return;
    await this.db.query(
      `UPDATE assets SET
          bound_domains = (SELECT ARRAY(SELECT DISTINCT unnest(bound_domains || ARRAY[$1::text]))),
          last_seen = now()
      WHERE type = 'ip' AND ip = $2`,
      [domain, ipStr],
    );
  }

  // ─── UpsertSubdomain ───────────────────────────────────────────────────────

  async upsertSubdomain(req: {
    domain: string;
    recordType?: string;
    recordValue?: string[];
    icp?: string;
    taskID?: number;
  }): Promise<number> {
    const recordType = (req.recordType ?? "").trim().toUpperCase();
    const icp = req.icp ?? "";
    const taskID = req.taskID ?? 0;
    const domain = domainKey(req.domain);
    if (domain === "") throw new Error("domain is required");
    if (this.tx === null) {
      return this.withCompanyScopeMutation((scoped) => scoped.upsertSubdomain(req));
    }
    if (domain.startsWith('_') && ['TXT','SRV'].includes(recordType)) {
      const host=domain.replace(/^(?:_[^.]+\.)+/, '');
      const root=rootDomain(host);
      const id=root.isApex ? await this.upsertRootDomain({domain:host,icp,taskID}) : await this.upsertSubdomain({domain:host,icp,taskID});
      await this.tx.query(`UPDATE assets SET extra=jsonb_set(extra,'{dns_records}',
       (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(COALESCE(extra->'dns_records','[]')||jsonb_build_array($2::jsonb))v)) WHERE id=$1`,
       [id,JSON.stringify({owner:domain,type:recordType,values:req.recordValue??[]})]);
      return id;
    }
    const rd = rootDomain(domain);
    let root = rd.root;
    if (root === "") root = domain;

    // 先按根域解析，再按子域自身的精确规范化 ICP。
    let companyID = await this.resolveCompanyWithICP(root, "", icp);

    // 副作用 1：确保根域存在（失败忽略，与 Go 一致）。
    await this.upsertRootDomain({ domain: root, taskID });

    // 副作用 2：A/AAAA 记录 → 逐 IP upsert 并绑定域名；RecordValue 元素可能是逗号分隔（legacy）。
    let ipStr = ""; // 第一个合法 IP，写进子域行本身
    const dnsIPs: string[] = [];
    const seenDNSIPs = new Set<string>();
    if (recordType === "A" || recordType === "AAAA") {
      for (const rv of req.recordValue ?? []) {
        for (const part of rv.split(",")) {
          const candidate = part.trim();
          const normalized = parseIP(candidate);
          if (candidate === "" || normalized === null) continue;
          if (ipStr === "") ipStr = normalized;
          if (!seenDNSIPs.has(normalized)) {
            seenDNSIPs.add(normalized);
            dnsIPs.push(normalized);
          }
          await this.upsertIP({
            ip: normalized,
            boundDomains: [domain],
            taskID,
          });
        }
      }
    }

    const cseg = calcCSegment(ipStr);
    if (companyID === null && ipStr !== "") {
      companyID = await this.resolveCompanyWithICP("", ipStr, "").catch(() => null);
    }

    const res = await this.tx.query<{ id: string }>(
      `INSERT INTO assets(type, domain, root_domain, record_type, record_value, ip, c_segment, icp, company_id, company_source, task_ids)
      VALUES ('subdomain', $1, $2, $3, $4::text[], $5, $6::cidr, $7, $8, 'scope', $9::bigint[])
      ON CONFLICT (domain, COALESCE(record_type,'')) WHERE type = 'subdomain' DO UPDATE SET
          ip           = COALESCE(EXCLUDED.ip, assets.ip),
          c_segment    = COALESCE(EXCLUDED.c_segment, assets.c_segment),
          icp          = COALESCE(EXCLUDED.icp, assets.icp),
          company_id   = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN assets.company_id
              ELSE COALESCE(EXCLUDED.company_id, assets.company_id)
          END,
          company_source = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN 'explicit'
              WHEN EXCLUDED.company_id IS NOT NULL THEN 'scope'
              ELSE assets.company_source
          END,
          task_ids     = (SELECT ARRAY(SELECT DISTINCT unnest(assets.task_ids || EXCLUDED.task_ids))),
          record_value = (SELECT ARRAY(SELECT DISTINCT unnest(assets.record_value || EXCLUDED.record_value))),
          extra        = assets.extra || EXCLUDED.extra,
          last_seen    = now()
      RETURNING id`,
      [
        domain,
        root,
        recordType,
        marshalStringArray(req.recordValue ?? []),
        ipStr !== "" ? ipStr : null,
        cseg !== "" ? cseg : null,
        icp !== "" ? icp : null,
        companyID,
        taskIDsLiteral(taskID),
      ],
    );
    const id = Number(res.rows[0]!.id);
    return id;
  }

  // ─── UpsertApp ─────────────────────────────────────────────────────────────

  async upsertApp(req: {
    name: string;
    bundleID?: string;
    category?: string;
    description?: string;
    icp?: string;
    companyID?: number | null; // 显式归属；空则按精确 ICP 自动归属
    taskID?: number;
  }): Promise<number> {
    if (req.name === "") throw new Error("app name is required");
    if (this.tx === null) {
      return this.withCompanyScopeMutation((scoped) => scoped.upsertApp(req));
    }
    const taskID = req.taskID ?? 0;
    const bundleID = req.bundleID ?? "";
    const category = req.category ?? "";
    const description = req.description ?? "";
    const icp = req.icp ?? "";
    let companyIDVal: number | null = null;
    let companySource = "scope";
    if (req.companyID != null) {
      companyIDVal = req.companyID;
      companySource = "explicit";
    } else {
      const resolved = await this.resolveCompanyWithICP("", "", icp);
      if (resolved !== null) companyIDVal = resolved;
    }

    const taskIDs = taskIDsLiteral(taskID);
    if (bundleID !== "") {
      const res = await this.tx.query<{ id: string }>(
        `INSERT INTO assets(type, bundle_id, app_name, category, app_description, app_icp, company_id, company_source, task_ids)
        VALUES ('app', $1, $2, $3, $4, $5, $6, $7, $8::bigint[])
        ON CONFLICT (bundle_id) WHERE type = 'app' AND bundle_id IS NOT NULL DO UPDATE SET
            app_name        = COALESCE(EXCLUDED.app_name, assets.app_name),
            category        = COALESCE(EXCLUDED.category, assets.category),
            app_description = COALESCE(EXCLUDED.app_description, assets.app_description),
            app_icp         = COALESCE(EXCLUDED.app_icp, assets.app_icp),
            company_id      = CASE
                WHEN EXCLUDED.company_source = 'explicit' THEN EXCLUDED.company_id
                WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN assets.company_id
                ELSE COALESCE(EXCLUDED.company_id, assets.company_id)
            END,
            company_source  = CASE
                WHEN EXCLUDED.company_source = 'explicit' THEN 'explicit'
                WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN 'explicit'
                WHEN EXCLUDED.company_id IS NOT NULL THEN 'scope'
                ELSE assets.company_source
            END,
            task_ids        = (SELECT ARRAY(SELECT DISTINCT unnest(assets.task_ids || EXCLUDED.task_ids))),
            last_seen       = now()
        RETURNING id`,
        [
          bundleID,
          req.name,
          category !== "" ? category : null,
          description !== "" ? description : null,
          icp !== "" ? icp : null,
          companyIDVal,
          companySource,
          taskIDs,
        ],
      );
      return Number(res.rows[0]!.id);
    }
    const res = await this.tx.query<{ id: string }>(
      `INSERT INTO assets(type, bundle_id, app_name, category, app_description, app_icp, company_id, company_source, task_ids)
      VALUES ('app', NULL, $1, $2, $3, $4, $5, $6, $7::bigint[])
      ON CONFLICT (app_name) WHERE type = 'app' AND bundle_id IS NULL DO UPDATE SET
          category        = COALESCE(EXCLUDED.category, assets.category),
          app_description = COALESCE(EXCLUDED.app_description, assets.app_description),
          app_icp         = COALESCE(EXCLUDED.app_icp, assets.app_icp),
          company_id      = CASE
              WHEN EXCLUDED.company_source = 'explicit' THEN EXCLUDED.company_id
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN assets.company_id
              ELSE COALESCE(EXCLUDED.company_id, assets.company_id)
          END,
          company_source  = CASE
              WHEN EXCLUDED.company_source = 'explicit' THEN 'explicit'
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN 'explicit'
              WHEN EXCLUDED.company_id IS NOT NULL THEN 'scope'
              ELSE assets.company_source
          END,
          task_ids        = (SELECT ARRAY(SELECT DISTINCT unnest(assets.task_ids || EXCLUDED.task_ids))),
          last_seen       = now()
      RETURNING id`,
      [
        req.name,
        category !== "" ? category : null,
        description !== "" ? description : null,
        icp !== "" ? icp : null,
        companyIDVal,
        companySource,
        taskIDs,
      ],
    );
    return Number(res.rows[0]!.id);
  }

  // ─── UpsertHTTPService ─────────────────────────────────────────────────────

  async upsertHTTPService(req: {
    url: string;
    technologies?: string[];
    statusCode?: number | null;
    contentLength?: number | null;
    pageTitle?: string;
    faviconMMH3?: string;
    auth?: Record<string, unknown>[];
    ip?: string;
    taskID?: number;
  }): Promise<number> {
    if (req.url === "") throw new Error("url is required");
    const ip = req.ip ?? "";
    validateAssetIP(ip);
    if (this.tx === null) {
      return this.withCompanyScopeMutation((scoped) => scoped.upsertHTTPService(req));
    }
    const taskID = req.taskID ?? 0;
    const normURL = normalizeURL(req.url);
    const { domain, port, serviceName } = parseURL(normURL);
    const rd = rootDomain(domain);
    let root = rd.root;
    if (root === "") root = domain;

    const cseg = calcCSegment(ip);
    const companyID = await this.resolveCompanyWithICP(root, ip, "");

    const pageTitle = req.pageTitle ?? "";
    const faviconMMH3 = req.faviconMMH3 ?? "";
    const res = await this.tx.query<{ id: string }>(
      `INSERT INTO assets(
          type, url, service_type, service_name, domain, ip, port, root_domain,
          c_segment, favicon_mmh3, technologies, status_code, content_length, page_title,
          auth, company_id, company_source, task_ids
      )
      VALUES (
          'service', $1, 'http', $2, $3, $4, $5, $6,
          $7::cidr, $8, $9::text[], $10, $11, $12,
          $13::jsonb[], $14, 'scope', $15::bigint[]
      )
      ON CONFLICT (url) WHERE type = 'service' AND service_type = 'http' DO UPDATE SET
          status_code    = COALESCE(EXCLUDED.status_code,    assets.status_code),
          content_length = COALESCE(EXCLUDED.content_length, assets.content_length),
          page_title     = COALESCE(EXCLUDED.page_title,     assets.page_title),
          favicon_mmh3   = COALESCE(EXCLUDED.favicon_mmh3,   assets.favicon_mmh3),
          ip             = COALESCE(EXCLUDED.ip,             assets.ip),
          c_segment      = COALESCE(EXCLUDED.c_segment,      assets.c_segment),
          technologies   = (SELECT ARRAY(SELECT DISTINCT unnest(assets.technologies || EXCLUDED.technologies))),
          auth           = (
              SELECT ARRAY(
                  SELECT DISTINCT ON (elem::text) elem
                  FROM unnest(assets.auth || EXCLUDED.auth) AS elem
              )
          ),
          task_ids       = (SELECT ARRAY(SELECT DISTINCT unnest(assets.task_ids || EXCLUDED.task_ids))),
          company_id     = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN assets.company_id
              ELSE COALESCE(EXCLUDED.company_id, assets.company_id)
          END,
          company_source = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN 'explicit'
              WHEN EXCLUDED.company_id IS NOT NULL THEN 'scope'
              ELSE assets.company_source
          END,
          last_seen      = now()
      RETURNING id`,
      [
        normURL,
        serviceName,
        domain !== "" ? domain : null,
        ip !== "" ? ip : null,
        nullablePort(port),
        root,
        cseg !== "" ? cseg : null,
        faviconMMH3 !== "" ? faviconMMH3 : null,
        marshalStringArray(req.technologies ?? []),
        req.statusCode ?? null,
        req.contentLength ?? null,
        pageTitle !== "" ? pageTitle : null,
        marshalJSONBArray(req.auth ?? []),
        companyID,
        taskIDsLiteral(taskID),
      ],
    );
    const id = Number(res.rows[0]!.id);

    // 副作用：root_domain + subdomain（以及 IP）也登记为独立资产。
    await this.linkHostAssets(domain, root, taskID);
    if (ip !== "") {
      const boundDomains = domain !== "" ? [domain] : [];
      const openPorts = port > 0 ? [{ port, service: serviceName }] : [];
      await this.upsertIP({ ip, boundDomains, openPorts, taskID });
    }
    return id;
  }

  // ─── UpsertOtherService ────────────────────────────────────────────────────

  async upsertOtherService(req: {
    domain?: string;
    ip?: string;
    port: number;
    serviceName: string;
    auth?: Record<string, unknown>[];
    taskID?: number;
  }): Promise<number> {
    const domain0 = req.domain ?? "";
    const ip = req.ip ?? "";
    if (domain0 === "" && ip === "") throw new Error("domain or ip is required");
    validateAssetIP(ip);
    if (req.port === 0) throw new Error("port is required");
    if (req.serviceName === "") throw new Error("service_name is required");
    if (this.tx === null) {
      return this.withCompanyScopeMutation((scoped) => scoped.upsertOtherService(req));
    }
    const taskID = req.taskID ?? 0;
    // service_name 小写归一，避免 (domain,ip,port,service_name) 键把 "SSH"/"ssh" 拆成两行。
    const serviceName = req.serviceName.trim().toLowerCase();

    const domain = domainKey(domain0);
    let rootDomainVal = "";
    if (domain !== "") {
      const rd = rootDomain(domain);
      rootDomainVal = rd.root;
      if (rootDomainVal === "") rootDomainVal = domain;
    }

    const cseg = calcCSegment(ip);
    const companyID = await this.resolveCompanyWithICP(rootDomainVal, ip, "");
    const res = await this.tx.query<{ id: string }>(
      `INSERT INTO assets(
          type, service_type, service_name, domain, ip, port, root_domain,
          c_segment, auth, company_id, company_source, task_ids
      )
      VALUES ('service', 'other', $1, $2, $3, $4, $5, $6::cidr, $7::jsonb[], $8, 'scope', $9::bigint[])
      ON CONFLICT (COALESCE(domain,''), COALESCE(ip,''), port, service_name) WHERE type = 'service' AND service_type = 'other' DO UPDATE SET
          domain     = COALESCE(EXCLUDED.domain,     assets.domain),
          ip         = COALESCE(EXCLUDED.ip,         assets.ip),
          c_segment  = COALESCE(EXCLUDED.c_segment,  assets.c_segment),
          auth       = (
              SELECT ARRAY(
                  SELECT DISTINCT ON (elem::text) elem
                  FROM unnest(assets.auth || EXCLUDED.auth) AS elem
              )
          ),
          task_ids   = (SELECT ARRAY(SELECT DISTINCT unnest(assets.task_ids || EXCLUDED.task_ids))),
          company_id = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN assets.company_id
              ELSE COALESCE(EXCLUDED.company_id, assets.company_id)
          END,
          company_source = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN 'explicit'
              WHEN EXCLUDED.company_id IS NOT NULL THEN 'scope'
              ELSE assets.company_source
          END,
          last_seen  = now()
      RETURNING id`,
      [
        serviceName,
        domain !== "" ? domain : null,
        ip !== "" ? ip : null,
        req.port,
        rootDomainVal !== "" ? rootDomainVal : null,
        cseg !== "" ? cseg : null,
        marshalJSONBArray(req.auth ?? []),
        companyID,
        taskIDsLiteral(taskID),
      ],
    );
    const id = Number(res.rows[0]!.id);

    // 副作用
    if (ip !== "" && req.port > 0) {
      const boundDomains = domain !== "" ? [domain] : [];
      await this.upsertIP({
        ip,
        boundDomains,
        openPorts: [{ port: req.port, service: serviceName }],
        taskID,
      });
    }
    await this.linkHostAssets(domain, rootDomainVal, taskID);
    return id;
  }

  /** linkHostAssets：把派生资产的主机也原子登记（IP → ip 资产；否则根域 + 子域）。 */
  private async linkHostAssets(domain: string, rootDomain: string, taskID: number): Promise<void> {
    domain = normalizeTaskAssetHost(domain);
    const ip = parseIP(domain);
    if (ip !== null) {
      await this.upsertIP({ ip, taskID });
      return;
    }
    if (rootDomain !== "") {
      await this.upsertRootDomain({ domain: rootDomain, taskID });
    }
    if (domain !== "" && domain !== rootDomain) {
      await this.upsertSubdomain({ domain, taskID });
    }
  }

  // ─── UpsertEndpoint ────────────────────────────────────────────────────────

  async upsertEndpoint(req: {
    url: string;
    method: string;
    params?: Record<string, unknown>[];
    ip?: string;
    taskID?: number;
  }): Promise<number> {
    if (req.url === "") throw new Error("url is required");
    if (req.method === "") throw new Error("method is required");
    const ip = req.ip ?? "";
    validateAssetIP(ip);
    if (this.tx === null) {
      return this.withCompanyScopeMutation((scoped) => scoped.upsertEndpoint(req));
    }
    const taskID = req.taskID ?? 0;
    const method = req.method.toUpperCase();
    const normURL = normalizeURL(req.url);
    const { domain, port } = parseURL(normURL);
    const rd = rootDomain(domain);
    let root = rd.root;
    if (root === "") root = domain;

    const cseg = calcCSegment(ip);
    const companyID = await this.resolveCompanyWithICP(root, ip, "");
    const res = await this.tx.query<{ id: string }>(
      `INSERT INTO assets(
          type, url, method, domain, ip, port, root_domain,
          params, company_id, company_source, task_ids, c_segment
      )
      VALUES ('endpoint', $1, $2, $3, $4, $5, $6, $7::jsonb[], $8, 'scope', $9::bigint[], $10::cidr)
      ON CONFLICT (url, method) WHERE type = 'endpoint' DO UPDATE SET
          params     = (
              SELECT ARRAY(
                  SELECT DISTINCT ON ((elem->>'location'), (elem->>'name')) elem
                  FROM unnest(assets.params || EXCLUDED.params) AS elem
                  ORDER BY (elem->>'location'), (elem->>'name'), elem::text DESC
              )
          ),
          ip         = COALESCE(EXCLUDED.ip,        assets.ip),
          c_segment  = COALESCE(EXCLUDED.c_segment, assets.c_segment),
          task_ids   = (SELECT ARRAY(SELECT DISTINCT unnest(assets.task_ids || EXCLUDED.task_ids))),
          company_id = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN assets.company_id
              ELSE COALESCE(EXCLUDED.company_id, assets.company_id)
          END,
          company_source = CASE
              WHEN assets.company_source = 'explicit' AND assets.company_id IS NOT NULL THEN 'explicit'
              WHEN EXCLUDED.company_id IS NOT NULL THEN 'scope'
              ELSE assets.company_source
          END,
          last_seen  = now()
      RETURNING id`,
      [
        normURL,
        method,
        domain !== "" ? domain : null,
        ip !== "" ? ip : null,
        nullablePort(port),
        root !== "" ? root : null,
        marshalJSONBArray(req.params ?? []),
        companyID,
        taskIDsLiteral(taskID),
        cseg !== "" ? cseg : null,
      ],
    );
    const id = Number(res.rows[0]!.id);
    // 副作用：endpoint 此前不登记主机 —— 现把其主机登记为 root_domain + subdomain(+IP)。
    await this.linkHostAssets(domain, root, taskID);
    if (ip !== "") {
      await this.upsertIP({ ip, taskID });
    }
    return id;
  }

  // ─── 查询 ─────────────────────────────────────────────────────────────────

  async getByIDs(ids: number[]): Promise<Asset[]> {
    if (ids.length === 0) return [];
    const res = await this.db.query(
      `${ASSET_SELECT_COLS} WHERE id IN(SELECT COALESCE(x.asset_id,w.id) FROM unnest($1::bigint[])w(id) LEFT JOIN asset_id_aliases x ON x.old_id=w.id) ORDER BY last_seen DESC, id DESC`,
      [ids],
    );
    return res.rows.map((r) => mapAsset(r as Record<string, unknown>));
  }

  async queryByType(typ: string, limit: number, offset: number): Promise<Asset[]> {
    if (limit <= 0) limit = 50;
    if (offset < 0) offset = 0;
    const res = await this.db.query(
      `${ASSET_SELECT_COLS} WHERE type = $1 ORDER BY last_seen DESC, id DESC LIMIT $2 OFFSET $3`,
      [typ, limit, offset],
    );
    return res.rows.map((r) => mapAsset(r as Record<string, unknown>));
  }

  async queryByCompany(companyID: number, typ: string, limit: number, offset: number): Promise<Asset[]> {
    let q = `${ASSET_SELECT_COLS} WHERE company_id = $1`;
    const args: unknown[] = [companyID];
    if (typ !== "") {
      args.push(typ);
      q += ` AND type = $${args.length}`;
    }
    q += ` ORDER BY last_seen DESC, id DESC`;
    if (limit > 0) {
      args.push(limit);
      q += ` LIMIT $${args.length}`;
    }
    if (offset > 0) {
      args.push(offset);
      q += ` OFFSET $${args.length}`;
    }
    const res = await this.db.query(q, args);
    return res.rows.map((r) => mapAsset(r as Record<string, unknown>));
  }

  async countByType(typ: string): Promise<number> {
    const res = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM assets WHERE type = $1`, [typ]);
    return Number(res.rows[0]?.n ?? 0);
  }

  async countsByType(): Promise<Map<string, number>> {
    const res = await this.db.query<{ type: string; n: string }>(`SELECT type, COUNT(*) AS n FROM assets GROUP BY type`);
    return new Map(res.rows.map((r) => [r.type, Number(r.n)]));
  }

  /** HostsByTask：任务资产的精确 HTTP 主机候选（domain/ip 列 + URL 主机）。 */
  async hostsByTask(taskID: number): Promise<string[]> {
    const res = await this.db.query<{ domain: string | null; ip: string | null; url: string | null }>(
      `SELECT COALESCE(domain,'') AS domain, COALESCE(ip,'') AS ip, COALESCE(url,'') AS url
       FROM assets WHERE $1 = ANY(task_ids)`,
      [taskID],
    );
    const hosts = new Set<string>();
    const add = (host: string) => {
      const t = host.trim().toLowerCase();
      if (t !== "") hosts.add(t);
    };
    for (const r of res.rows) {
      add(r.domain ?? "");
      add(r.ip ?? "");
      const m = URL_SPLIT_RE.exec(r.url ?? "");
      if (m !== null && m[2] !== undefined) add(hostnameOf(m[2]).host);
    }
    return [...hosts].sort();
  }
}
