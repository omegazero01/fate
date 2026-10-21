import { domainToASCII } from "node:url";
import type { Database } from "./index.js";
import {
	normalizeURL,
	parseURL,
	parseIP,
	domainKey,
	type AssetStore,
} from "./assets.js";
import { ASSET_TYPES, AssetRow } from "./asset-query.js";
export class AssetInputError extends Error {
	statusCode = 400;
}
export function assetHost(raw: string): string {
	const h = domainKey(raw),
		ip = parseIP(h);
	if (ip) return ip;
	const ascii = domainToASCII(h).toLowerCase();
	if (
		!ascii ||
		ascii.length > 253 ||
		!ascii
			.split(".")
			.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
	)
		throw new AssetInputError("domain 必须是有效域名；IP 请使用 ip 类型");
	return ascii;
}
export function assetURL(raw: string): string {
	const norm = normalizeURL(raw),
		m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(norm);
	if (
		!m ||
		m[2]!.includes("@") ||
		/[\u0000-\u0020]/u.test(norm) ||
		/%(?![0-9a-f]{2})/i.test(norm)
	)
		throw new AssetInputError("url 必须是完整的 HTTP/HTTPS URL");
	const { domain, port } = parseURL(norm),
		host = assetHost(domain);
	if (port < 1 || port > 65535)
		throw new AssetInputError("port 必须为 1..65535");
	const authority = m[2]!,
		explicit = authority.startsWith("[")
			? authority.slice(authority.indexOf("]") + 1)
			: authority.slice(domain.length);
	if (explicit && !/^:\d+$/.test(explicit))
		throw new AssetInputError("URL 端口无效");
	return `${m[1]!.toLowerCase()}://${host.includes(":") ? "[" + host + "]" : host}${explicit}${m[3]}`;
}
export function normalizeAssetInput(raw: unknown): AssetRow {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new AssetInputError("每项资产必须为对象");
	const a = { ...(raw as AssetRow) };
	if (!ASSET_TYPES.includes(a.type)) throw new AssetInputError("未知资产类型");
	for (const key of [
		"domain",
		"ip",
		"url",
		"method",
		"record_type",
		"app_name",
		"name",
		"bundle_id",
		"service_name",
		"service_ip",
		"icp",
		"app_icp",
		"page_title",
		"favicon_mmh3",
		"category",
		"description",
	])
		if (a[key] != null && typeof a[key] !== "string")
			throw new AssetInputError(`${key} 必须是字符串`);
	if (typeof a.record_value === "string") a.record_value = [a.record_value];
	for (const key of [
		"record_value",
		"bound_domains",
		"technologies",
		"open_ports",
		"params",
		"auth",
	])
		if (a[key] != null) {
			if (!Array.isArray(a[key]))
				throw new AssetInputError(`${key} 必须是数组`);
			for (const v of a[key])
				if (
					["record_value", "bound_domains", "technologies"].includes(key)
						? typeof v !== "string"
						: !v || typeof v !== "object" || Array.isArray(v)
				)
					throw new AssetInputError(`${key} 元素类型无效`);
		}
	for (const key of ["port", "status_code", "content_length", "company_id"])
		if (a[key] != null && (!Number.isSafeInteger(a[key]) || a[key] < 0))
			throw new AssetInputError(`${key} 必须为非负整数`);
	if (a.related != null && typeof a.related !== "boolean")
		throw new AssetInputError("related 必须是布尔值");
	if (
		a.type === "subdomain" &&
		a.domain?.startsWith("_") &&
		["TXT", "SRV"].includes(String(a.record_type).toUpperCase())
	) {
		const labels = domainKey(a.domain).split(".");
		while (labels[0]?.startsWith("_")) {
			if (!/^_[a-z0-9_-]{1,62}$/.test(labels.shift()!))
				throw new AssetInputError("DNS owner 无效");
		}
		assetHost(labels.join("."));
	} else if (a.domain) {
		a.domain = assetHost(a.domain);
		if (["root_domain", "subdomain"].includes(a.type) && parseIP(a.domain))
			throw new AssetInputError("IP 请使用 ip 类型");
	}
	for (const key of ["ip", "service_ip"])
		if (a[key]) {
			const ip = parseIP(a[key].trim());
			if (!ip) throw new AssetInputError(`${key} 必须为 IPv4/IPv6 地址`);
			a[key] = ip;
		}
	if (a.url) a.url = assetURL(a.url);
	if (a.bound_domains) a.bound_domains = a.bound_domains.map(assetHost);
	if (a.open_ports)
		for (const p of a.open_ports) {
			if (
				!Number.isInteger(p.port) ||
				p.port < 1 ||
				p.port > 65535 ||
				(p.service != null && typeof p.service !== "string")
			)
				throw new AssetInputError("open_ports 需要有效 port/service");
		}
	if (a.method) a.method = a.method.trim().toUpperCase();
	if (a.record_type) a.record_type = a.record_type.trim().toUpperCase();
	if (a.service_name && !a.url) a.service_name = a.service_name.trim().toLowerCase();
	a.app_name ??= a.name;
	a.app_icp ??= a.icp;
	a.service_ip ??= a.ip;
	const required =
		a.type === "root_domain" || a.type === "subdomain"
			? ["domain"]
			: a.type === "ip"
				? ["ip"]
				: a.type === "app"
					? ["app_name"]
					: a.type === "endpoint"
						? ["url", "method"]
						: a.url
							? ["url"]
							: ["port", "service_name"];
	for (const key of required)
		if (!a[key]) throw new AssetInputError(`${a.type}.${key} 必填`);
	if (a.params)
		for (const p of a.params)
			if (typeof p.location !== "string" || typeof p.name !== "string")
				throw new AssetInputError("params 需要 location/name");
	return a;
}
export async function upsertAsset(
	store: AssetStore,
	a: AssetRow,
	taskID: number,
): Promise<number> {
	switch (a.type) {
		case "root_domain":
			return store.upsertRootDomain({ domain: a.domain, icp: a.icp, taskID });
		case "subdomain":
			return store.upsertSubdomain({
				domain: a.domain,
				recordType: a.record_type,
				recordValue: a.record_value,
				icp: a.icp,
				taskID,
			});
		case "ip":
			return store.upsertIP({
				ip: a.ip,
				boundDomains: a.bound_domains,
				openPorts: a.open_ports,
				taskID,
			});
		case "app":
			return store.upsertApp({
				name: a.app_name,
				bundleID: a.bundle_id,
				category: a.category,
				description: a.description,
				icp: a.app_icp,
				companyID: a.company_id,
				taskID,
			});
		case "endpoint":
			return store.upsertEndpoint({
				url: a.url,
				method: a.method,
				params: a.params,
				ip: a.service_ip,
				taskID,
			});
		case "service":
			return a.url
				? store.upsertHTTPService({
						url: a.url,
						technologies: a.technologies,
						statusCode: a.status_code,
						contentLength: a.content_length,
						pageTitle: a.page_title,
						faviconMMH3: a.favicon_mmh3,
						auth: a.auth,
						ip: a.service_ip,
						taskID,
					})
				: store.upsertOtherService({
						domain: a.domain,
						ip: a.ip,
						port: a.port,
						serviceName: a.service_name,
						auth: a.auth,
						taskID,
					});
		default:
			throw new AssetInputError("未知资产类型");
	}
}
export interface AssetWriteOrigin {
	taskID: number;
	intentID?: number;
	agent: string;
	callID?: string;
	session?: string;
	signal?: AbortSignal;
	assertOwnership?: (db: Database) => Promise<void>;
	user?: boolean;
}
export async function writeAssets(
	db: Database,
	items: unknown[],
	origin: AssetWriteOrigin,
) {
	const results: { index: number; id: number; type: string }[] = [],
		errors: { index: number; error: string }[] = [];
	for (let index = 0; index < items.length; index++) {
		origin.signal?.throwIfAborted();
		try {
			const a = normalizeAssetInput(items[index]);
			const result = await db.transaction(async (tx) => {
				origin.signal?.throwIfAborted();
				await origin.assertOwnership?.(tx);
				if (origin.taskID > 0 && !(await tx.tasks().getTask(origin.taskID)))
					throw new AssetInputError("任务不存在");
				const execution = `${origin.taskID}:${origin.intentID ?? 0}:${origin.agent}:${origin.session ?? ""}`;
				if (origin.callID) {
					await tx.query(
						"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
						[`${execution}:${origin.callID}:${index}`],
					);
					const old = await tx.query(
						"SELECT result FROM asset_tool_writes WHERE execution=$1 AND call_id=$2 AND item_index=$3",
						[execution, origin.callID, index],
					);
					if (old.rowCount)
						return old.rows[0]!.result as {
							index: number;
							id: number;
							type: string;
						};
				}
				const id = origin.user
					? await upsertAsset(tx.assets(), a, origin.taskID)
					: await tx
							.assets()
							.registerAgentAsset(
								origin.taskID,
								origin.agent,
								origin.intentID,
								origin.callID,
								(s) => upsertAsset(s, a, origin.taskID),
							);
				if (origin.intentID)
					await tx.query(
						"INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
						[origin.intentID, id],
					);
				if (origin.user && origin.taskID > 0)
					await tx.query(
						"UPDATE task_asset_links SET source='api',source_summary='用户通过资产 API 登记' WHERE task_id=$1 AND asset_id=$2",
						[origin.taskID, id],
					);
				if (
					a.related !== false &&
					origin.taskID > 0 &&
					(await tx.taskScope().coverageEnabled(origin.taskID))
				) {
					const host =
						a.type === "subdomain" && a.domain.startsWith("_")
							? a.domain.replace(/^(?:_[^.]+\.)+/, "")
							: (a.domain ?? "");
					await tx
						.taskScope()
						.addAutoScope(
							origin.taskID,
							a.type,
							host,
							a.url ?? "",
							a.service_ip ?? a.ip ?? "",
						);
				}
				origin.signal?.throwIfAborted();
				await origin.assertOwnership?.(tx);
				const result = { index, id, type: a.type as string };
				if (origin.callID)
					await tx.query(
						"INSERT INTO asset_tool_writes(execution,call_id,item_index,asset_id,result) VALUES($1,$2,$3,$4,$5)",
						[execution, origin.callID, index, id, result],
					);
				return result;
			});
			results.push(result);
		} catch (e) {
			if (origin.signal?.aborted) throw e;
			errors.push({ index, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return {
		results,
		errors,
		inserted: results.length,
		assets: results.map((r) => ({
			type: r.type,
			asset_id: r.id,
			key: String(r.id),
		})),
	};
}
