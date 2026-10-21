import type { Database } from "./index.js";
import { compileAssetDSL, AssetQueryError } from "./asset-dsl.js";
export const ASSET_TYPES = [
	"root_domain",
	"subdomain",
	"ip",
	"service",
	"endpoint",
	"app",
] as const;
export type AssetRow = Record<string, any>;
/** Exactly one source hop. Shared by assets, coverage, graph and Planner. */
export const assetContextCTE = `context_tasks AS (
 SELECT id task_id,exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL
 UNION SELECT s.id,s.exploration_id FROM tasks c JOIN task_relations r ON r.task_id=c.id JOIN tasks s ON s.id=r.source_task_id
 WHERE c.id=$1 AND c.deleted_at IS NULL AND s.deleted_at IS NULL
), visible AS (SELECT DISTINCT l.asset_id id FROM task_asset_links l JOIN context_tasks c ON c.task_id=l.task_id),
 target AS (
 SELECT DISTINCT a.id FROM assets a JOIN visible v ON v.id=a.id JOIN task_scope s ON (
 (s.kind='company' AND a.company_id=s.company_id) OR (s.kind='root_domain' AND a.root_domain=s.domain)
 OR(s.kind='subdomain' AND a.domain=s.domain) OR(s.kind IN('ip','cidr') AND (s.net >>= try_inet(a.ip) OR s.net >>= try_inet(a.domain)))
 OR(s.kind='icp' AND (lower(regexp_replace(COALESCE(a.icp,''),'[[:space:]]+','','g'))=s.value OR lower(regexp_replace(COALESCE(a.app_icp,''),'[[:space:]]+','','g'))=s.value)))
 JOIN context_tasks c ON c.task_id=s.task_id
 UNION SELECT e.asset_id FROM exploration_anchors e JOIN exploration_nodes n ON n.id=e.node_id JOIN context_tasks c ON c.exploration_id=n.exploration_id JOIN visible v ON v.id=e.asset_id
), legacy_tested AS (
 SELECT l.asset_id FROM task_asset_links l JOIN context_tasks c ON c.task_id=l.task_id WHERE l.tested
 UNION SELECT e.asset_id FROM exploration_anchors e JOIN exploration_nodes n ON n.id=e.node_id AND n.kind IN('fact','finding') JOIN context_tasks c ON c.exploration_id=n.exploration_id WHERE NOT(n.payload ? 'writeback')
), tested_records AS (
 SELECT e.asset_id,n.created_at,n.origin FROM exploration_anchors e
 JOIN exploration_nodes n ON n.id=e.node_id JOIN context_tasks c ON c.exploration_id=n.exploration_id
 WHERE n.state='confirmed' AND n.payload->'writeback'->>'coverage_eligible'='true'
 AND NULLIF(btrim(n.payload->'scope'->>'tested'),'') IS NOT NULL
 AND exploration_node_readable(n.exploration_id,n.id)
 AND ((n.kind='fact' AND n.payload->>'observation_type' IN('observed','negative') AND NULLIF(btrim(n.payload->>'evidence'),'') IS NOT NULL)
   OR (n.kind='finding' AND EXISTS(SELECT 1 FROM findings f WHERE f.node_id=n.id AND f.status<>'false_positive' AND btrim(f.evidence)<>'')))
), tested AS (
 SELECT DISTINCT asset_id FROM tested_records
)`;
export interface AssetQuery {
	taskID?: number;
	type?: string;
	dsl?: string;
	companyID?: number;
	tested?: boolean;
	untested?: boolean;
	ids?: number[];
	limit?: number;
	offset?: number;
	summary?: boolean;
}
export function assetDTO(a: AssetRow): AssetRow {
	for (const key of [
		"id",
		"company_id",
		"port",
		"status_code",
		"content_length",
		"source_task_id",
		"task_source_node_id",
	])
		if (a[key] !== undefined && a[key] !== null) a[key] = Number(a[key]);
	if (Array.isArray(a.task_ids)) a.task_ids = a.task_ids.map(Number);
	if (a.source_task_id !== undefined) a.task_source_task_id = a.source_task_id;
	if (a.inherited !== undefined) a.task_inherited = a.inherited;
	if (a.read_only !== undefined) a.task_read_only = a.read_only;
	return a;
}
export async function queryAssets(db: Database, q: AssetQuery) {
	const taskID = q.taskID ?? 0,
		values: unknown[] = [taskID];
	if (q.type && !ASSET_TYPES.includes(q.type as any))
		throw new AssetQueryError("无效资产类型");
	const param = (v: unknown) => {
		values.push(v);
		return `$${values.length}`;
	};
	const where = [
		taskID > 0 ? "a.id IN(SELECT id FROM visible)" : "TRUE",
		compileAssetDSL(q.dsl ?? "", values),
	];
	if (q.type) where.push(`a.type=${param(q.type)}`);
	if (q.companyID) where.push(`a.company_id=${param(q.companyID)}`);
	if (q.ids)
		where.push(
			`a.id IN(SELECT COALESCE(x.asset_id,w.id) FROM unnest(${param(q.ids)}::bigint[]) w(id) LEFT JOIN asset_id_aliases x ON x.old_id=w.id)`,
		);
	if (q.untested)
		where.push(
			"a.id IN(SELECT id FROM target) AND a.id NOT IN(SELECT asset_id FROM tested)",
		);
	if (q.tested !== undefined)
		where.push(`(a.id IN(SELECT asset_id FROM tested))=${param(q.tested)}`);
	const limit = q.limit ?? 50,
		offset = q.offset ?? 0;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		!Number.isSafeInteger(offset) ||
		offset < 0
	)
		throw new AssetQueryError("limit/offset 无效");
	const cols = q.summary
		? "a.id,a.type,a.company_id,a.domain,a.root_domain,a.ip,a.port,a.url,a.method,a.service_type,a.service_name,a.app_name,a.bundle_id,a.page_title,a.status_code,a.technologies,a.last_seen"
		: "a.*";
	const rows = await db.query(
		`WITH ${assetContextCTE}, matched AS MATERIALIZED (
 SELECT ${cols},(a.id IN(SELECT asset_id FROM tested)) tested,(a.id IN(SELECT asset_id FROM legacy_tested)) legacy_tested,
 (SELECT min(t.created_at) FROM tested_records t WHERE t.asset_id=a.id) tested_at,
 (SELECT t.origin FROM tested_records t WHERE t.asset_id=a.id ORDER BY t.created_at LIMIT 1) tested_by,
 link.source task_source,link.source_summary task_source_summary,link.source_node_id task_source_node_id,
 link.source_origin,link.task_id source_task_id,COALESCE(link.task_id<>$1,false) inherited,COALESCE(link.task_id<>$1,false) read_only
 FROM assets a LEFT JOIN LATERAL(SELECT l.* FROM task_asset_links l JOIN context_tasks c ON c.task_id=l.task_id WHERE l.asset_id=a.id ORDER BY (l.task_id=$1) DESC,l.task_id LIMIT 1)link ON true
 WHERE ${where.join(" AND ")}), page AS (SELECT * FROM matched ORDER BY ${q.untested ? "id" : "last_seen DESC NULLS LAST,id DESC"} LIMIT ${param(limit)} OFFSET ${param(offset)})
 SELECT (SELECT count(*)::int FROM matched) total,COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]') assets`,
		values,
	);
	const total = Number(rows.rows[0]?.total ?? 0),
		assets = ((rows.rows[0]?.assets as AssetRow[]) ?? []).map(assetDTO);
	return {
		assets,
		total,
		count: assets.length,
		has_more: offset + assets.length < total,
		...(offset + assets.length < total
			? { next_offset: offset + assets.length }
			: {}),
	};
}
export async function assetCounts(db: Database, taskID = 0) {
	const r = await db.query(
		`WITH ${assetContextCTE} SELECT type,count(*)::int n FROM assets WHERE $1=0 OR id IN(SELECT id FROM visible) GROUP BY type`,
		[taskID],
	);
	return Object.fromEntries(
		ASSET_TYPES.map((t) => [
			t,
			Number(r.rows.find((r) => r.type === t)?.n ?? 0),
		]),
	);
}
export async function assetCoverage(db: Database, taskID: number) {
	const row = await db.query(
		`WITH ${assetContextCTE}, counts AS (SELECT a.type,count(*)::int total,count(*) FILTER(WHERE a.id IN(SELECT asset_id FROM tested))::int tested FROM assets a JOIN target t ON t.id=a.id GROUP BY a.type)
 SELECT COALESCE((SELECT coverage_enabled FROM tasks WHERE id=$1),true) enabled,
 (SELECT count(*)::int FROM task_scope s JOIN context_tasks c ON c.task_id=s.task_id) scope_rows,
 COALESCE((SELECT jsonb_agg(to_jsonb(counts) ORDER BY type) FROM counts),'[]') by_type,
 (SELECT count(DISTINCT host)::int FROM assets a JOIN visible v ON v.id=a.id CROSS JOIN LATERAL(VALUES(NULLIF(a.domain,'')),(NULLIF(a.ip,''))) h(host)) host_count,
 (SELECT count(*)::int FROM target t WHERE t.id IN(SELECT asset_id FROM legacy_tested) AND t.id NOT IN(SELECT asset_id FROM tested)) legacy_unverified`,
		[taskID],
	);
	const r = row.rows[0]!,
		enabled = r.enabled === true,
		byType = enabled
			? (r.by_type as { type: string; total: number; tested: number }[])
			: [];
	const denominator = byType.reduce((n, r) => n + r.total, 0),
		tested = byType.reduce((n, r) => n + r.tested, 0);
	return {
		enabled,
		scopeRows: enabled ? Number(r.scope_rows) : 0,
		denominator,
		tested,
		pct: denominator ? tested / denominator : null,
		byType,
		host_count: Number(r.host_count),
    coverage_basis:'scoped-report-v1',legacy_unverified:enabled?Number(r.legacy_unverified):0,
	};
}
export async function coverageGraph(db: Database, taskID: number) {
	const rows = await db.query(
		`WITH ${assetContextCTE} SELECT a.id,a.type,a.company_id,a.domain,a.root_domain,a.ip,a.url,a.method,a.port,a.service_type,a.app_name,a.page_title,a.status_code,(a.id IN(SELECT asset_id FROM tested)) tested,(a.id IN(SELECT asset_id FROM legacy_tested)) legacy_tested FROM assets a JOIN target t ON t.id=a.id ORDER BY a.id`,
		[taskID],
	);
	const nodes: AssetRow[] = rows.rows.map((r) => ({
		...assetDTO(r),
		key: `a:${r.id}`,
		asset_id: Number(r.id),
		kind: r.type,
		label: r.type === "endpoint" ? `${r.method} ${r.url}` : r.url || r.domain || r.ip || r.app_name || String(r.id),
		in_scope: true,
	}));
	const roots = new Map<string, string>(),
		subs = new Map<string, string>(),
		ips = new Map<string, string>(),
		services = new Map<string, string>(),
		hosts = new Map<string, string>();
	for (const n of nodes) {
		if (n.kind === "root_domain") roots.set(n.domain, n.key);
		if (n.kind === "subdomain") subs.set(n.domain, n.key);
		if (n.kind === "ip") ips.set(n.ip, n.key);
		if (n.kind === "service") {
			const h = n.domain || n.ip;
			if (h) {
				services.set(`${h}|${n.port}`, n.key);
				hosts.set(h, n.key);
			}
		}
	}
	const missing = [
		...new Set(
			nodes
				.filter(
					(n) =>
						n.kind === "subdomain" &&
						n.root_domain &&
						!roots.has(n.root_domain),
				)
				.map((n) => n.root_domain),
		),
	];
	const parents = missing.length
		? (
				await db.query(
					"SELECT id,domain,company_id FROM assets WHERE type='root_domain' AND domain=ANY($1::text[])",
					[missing],
				)
			).rows
		: [];
	for (const root of missing) {
		const r = parents.find((r) => r.domain === root);
		const key = r ? `a:${r.id}` : `r:${root}`;
		roots.set(root, key);
		nodes.push({
			key,
			kind: "root_domain",
			asset_id: r ? Number(r.id) : 0,
			domain: root,
			label: root,
			company_id: r?.company_id ? Number(r.company_id) : null,
			in_scope: false,
			tested: false,
		});
	}
	const companyIDs = [
		...new Set(nodes.map((n) => n.company_id).filter(Boolean)),
	];
	if (companyIDs.length)
		for (const c of (
			await db.query(
				"SELECT id,name FROM companies WHERE id=ANY($1::bigint[])",
				[companyIDs],
			)
		).rows)
			nodes.push({
				key: `c:${c.id}`,
				kind: "company",
				company_id: Number(c.id),
				asset_id: 0,
				label: c.name,
				in_scope: false,
				tested: false,
			});
	const keys = new Set(nodes.map((n) => n.key)),
		edges: { src: string; dst: string }[] = [];
	for (const n of nodes) {
		let parent: string | undefined;
		if (n.kind === "subdomain") parent = roots.get(n.root_domain);
		else if (["root_domain", "app", "ip"].includes(n.kind) && n.company_id)
			parent = `c:${n.company_id}`;
		else if (n.kind === "service")
			parent = subs.get(n.domain) || ips.get(n.ip) || roots.get(n.root_domain);
		else if (n.kind === "endpoint") {
			const h = n.domain || n.ip;
			parent =
				services.get(`${h}|${n.port}`) ||
				hosts.get(h) ||
				subs.get(h) ||
				ips.get(h) ||
				ips.get(n.ip) ||
				roots.get(n.root_domain);
		}
		if (parent && parent !== n.key && keys.has(parent))
			edges.push({ src: n.key, dst: parent });
	}
	return { nodes, edges };
}
