import { domainTool } from "./define.js";
import type { ToolRunContext } from "./context.js";
import { writeAssets } from "../db/asset-write.js";
import { ASSET_TYPES, queryAssets, type AssetRow } from "../db/asset-query.js";
const string = { type: "string" },
	strings = { type: "array", items: string },
	objects = { type: "array", items: { type: "object" } };
export const assetInputSchema = {
	type: "object",
	required: ["type"],
	properties: {
		type: { type: "string", enum: ASSET_TYPES },
		domain: string,
		icp: string,
		record_type: string,
		record_value: {
			anyOf: [strings, string],
			description: "DNS 值数组；旧字符串兼容为单项数组",
		},
		ip: string,
		bound_domains: strings,
		open_ports: {
			type: "array",
			items: {
				type: "object",
				required: ["port"],
				properties: {
					port: { type: "integer", minimum: 1, maximum: 65535 },
					service: string,
				},
			},
		},
		app_name: string,
		name: { ...string, description: "app_name 的历史别名" },
		bundle_id: string,
		category: string,
		description: string,
		app_icp: string,
		company_id: { type: "integer", minimum: 1 },
		url: string,
		service_ip: string,
		service_name: string,
		port: { type: "integer", minimum: 1, maximum: 65535 },
		technologies: strings,
		status_code: { type: "integer" },
		content_length: { type: "integer" },
		page_title: string,
		favicon_mmh3: string,
		auth: objects,
		method: string,
		params: {
			type: "array",
			items: {
				type: "object",
				required: ["location", "name"],
				properties: { location: string, name: string, value: {}, type: string },
			},
		},
		related: {
			type: "boolean",
			description: "默认 true；false 仅登记发现，不自动扩展测试范围",
		},
	},
};
export function insertAssetsTool(ctx: ToolRunContext) {
	return domainTool<{ assets?: unknown[]; items?: unknown[] }>(
		{
			name: "insert_assets",
			description:
				"发现资产时立即写入资产图。assets 按 type 填写原始观察：root_domain/subdomain 用 domain；ip 用 ip；HTTP service 用 url；其他 service 用 domain/ip、port、service_name；endpoint 必须 url、method；app 用 app_name。record_value 是数组，params/auth/technologies 追加合并。返回逐项 results/errors，成功记录立即可读。探索结论用 record_fact。",
			parameters: {
				type: "object",
				properties: {
					assets: { type: "array", minItems: 1, items: assetInputSchema },
					items: {
						type: "array",
						minItems: 1,
						items: assetInputSchema,
						description: "历史 assets 别名；不能同时提供",
					},
				},
				anyOf: [{ required: ["assets"] }, { required: ["items"] }],
			},
			transactional: false,
			async run(args, c) {
				if (args.assets && args.items)
					throw new Error("assets/items 只能提供一种");
				const items = args.assets ?? args.items;
				if (!Array.isArray(items) || !items.length)
					throw new Error("assets 必须是非空数组");
				return writeAssets(c.db, items, {
					taskID: c.taskID,
					intentID: c.intentID,
					agent: c.workerName ?? c.role,
					callID: c.toolCallID,
					session: String(c.conversationID ?? c.mainSegment ?? ""),
					signal: c.signal,
					assertOwnership: c.hooks.assertOwnership,
				});
			},
		},
		ctx,
	);
}
const searchProperties = {
	dsl: {
		type: "string",
		description:
			"如 port==443 AND technology=nginx；= 模糊、== 精确、!= 排除，支持 AND/OR/括号",
	},
	type: { type: "string", enum: ASSET_TYPES },
	untested: { type: "boolean" },
	limit: { type: "integer", minimum: 1, maximum: 50 },
	offset: { type: "integer", minimum: 0 },
};
export function assetSearchTool(ctx: ToolRunContext) {
	return domainTool<{
		dsl?: string;
		type?: string;
		untested?: boolean;
		limit?: number;
		offset?: number;
	}>(
		{
			name: "asset_search",
			description:
				"检索本任务及直接来源任务的资产摘要。普通检索必须提供非空 dsl；untested=true 可直接查覆盖范围内未测资产。默认10、最多50，使用 next_offset 续页，详情用 asset_get。",
			parameters: { type: "object", properties: searchProperties },
			readOnly: true,
			async run(a, c) {
				if (!a.untested && !a.dsl?.trim())
					throw new Error(
						"需要 dsl；已知 ID 使用 asset_get，未测使用 untested=true",
					);
				if (
					a.untested &&
					(!c.taskID || !(await c.db.taskScope().coverageEnabled(c.taskID)))
				)
					throw new Error("未测查询需要启用覆盖度的任务");
				if (c.taskID <= 0)
					return { assets: [], total: 0, count: 0, has_more: false };
				return queryAssets(c.db, {
					taskID: c.taskID,
					type: a.type,
					dsl: a.dsl,
					untested: a.untested,
					limit: a.limit ?? 10,
					offset: a.offset ?? 0,
					summary: true,
				});
			},
		},
		ctx,
	);
}
function groups(a: AssetRow, fields: string[]) {
	const pick = (keys: string[]) =>
		Object.fromEntries(keys.map((k) => [k, a[k] ?? null]));
	const all: AssetRow = {
		identity: pick([
			"domain",
			"root_domain",
			"ip",
			"url",
			"port",
			"method",
			"app_name",
			"bundle_id",
			"company_id",
		]),
		fingerprint: pick([
			"page_title",
			"status_code",
			"content_length",
			"technologies",
			"service_name",
			"service_type",
			"favicon_mmh3",
		]),
		dns: pick(["record_type", "record_value", "bound_domains", "open_ports"]),
		params: a.params ?? [],
		auth: a.auth ?? [],
		extra: a.extra ?? {},
	};
	return Object.fromEntries(fields.map((k) => [k, all[k]]));
}
export function assetGetTool(ctx: ToolRunContext) {
	return domainTool<{
		ids: number[];
		fields?: string[];
		field?: string;
		index?: number;
		offset?: number;
		max_chars?: number;
	}>(
		{
			name: "asset_get",
			description:
				"按 ids 读取1..5个资产。fields 默认 identity/fingerprint；dns、params、auth、extra 按需显式选择。field 使用 JSON Pointer；按返回 next 续读。max_chars 为整批正文字符上限，默认8000，最多24000。",
			parameters: {
				type: "object",
				required: ["ids"],
				properties: {
					ids: {
						type: "array",
						minItems: 1,
						maxItems: 5,
						items: { type: "integer", minimum: 1 },
					},
					fields: {
						type: "array",
						items: {
							type: "string",
							enum: [
								"identity",
								"fingerprint",
								"dns",
								"params",
								"auth",
								"extra",
							],
						},
					},
					field: string,
					index: { type: "integer", minimum: 0 },
					offset: { type: "integer", minimum: 0 },
					max_chars: { type: "integer", minimum: 1, maximum: 24000 },
				},
			},
			readOnly: true,
			async run(a, c) {
				const ids = [...new Set(a.ids)],
					fields = a.fields ?? ["identity", "fingerprint"];
				if (
					ids.length < 1 ||
					ids.length > 5 ||
					ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
				)
					throw new Error("ids 须为1..5个正整数");
				if (
					fields.some(
						(f) =>
							![
								"identity",
								"fingerprint",
								"dns",
								"params",
								"auth",
								"extra",
							].includes(f),
					)
				)
					throw new Error("未知 fields");
				if (a.field && !a.field.startsWith("/"))
					throw new Error("field 必须为 JSON Pointer");
				const budget = Math.min(24000, a.max_chars ?? 8000),
					share = Math.floor(budget / ids.length);
				if (
					budget < 1 ||
					[a.index, a.offset].some(
						(v) => v !== undefined && (!Number.isInteger(v) || v < 0),
					)
				)
					throw new Error("读取窗口无效");
				const rows =
					c.taskID > 0
						? (await queryAssets(c.db, { taskID: c.taskID, ids, limit: 5 }))
								.assets
						: [];
				const aliases = (
					await c.db.query(
						"SELECT old_id,asset_id FROM asset_id_aliases WHERE old_id=ANY($1::bigint[])",
						[ids],
					)
				).rows;
				return {
					assets: ids.map((id) => {
						const canonical = Number(
							aliases.find((r) => Number(r.old_id) === id)?.asset_id ?? id,
						);
						const row = rows.find((r) => r.id === canonical);
						if (!row) return { asset_id: id, error: "资产不可用" };
						if (!share) return { asset_id: id, error: "正文预算不足" };
						let value: any = groups(row, fields);
						for (const part of (a.field ?? "").split("/").slice(1)) {
							const k = part.replaceAll("~1", "/").replaceAll("~0", "~");
							value =
								value && typeof value === "object" && Object.hasOwn(value, k)
									? value[k]
									: undefined;
						}
						const out: AssetRow = {
							id: canonical,
							asset_id: canonical,
							...(canonical !== id ? { requested_id: id } : {}),
							type: row.type,
							source_task_id: row.source_task_id,
							inherited: row.inherited,
						};
						if (value === undefined) {
							out.details = { error: "字段不存在或未选择所属 fields" };
							return out;
						}
						const next = {
							ids: [id],
							fields,
							field: a.field ?? "",
							index: a.index ?? 0,
							offset: a.offset ?? 0,
							max_chars: budget,
						};
						if (typeof value === "string") {
							const chars = Array.from(value),
								offset = a.offset ?? 0;
							out.details = {
								value: chars.slice(offset, offset + share).join(""),
								offset,
								total_chars: chars.length,
							};
							if (offset + share < chars.length) {
								out.details.next_offset = offset + share;
								out.next = { ...next, offset: offset + share };
							}
						} else if (value !== null && typeof value === "object") {
							const entries = Array.isArray(value)
								? value.map((v, i) => [String(i), v] as const)
								: Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
							const index = a.index ?? 0,
								per = Math.max(1, Math.floor(share / 20));
							out.details = {
								entries: entries.slice(index, index + 20).map(([key, v]) => {
									const field =
										(a.field ?? "") +
										"/" +
										key.replaceAll("~", "~0").replaceAll("/", "~1");
									return Array.from(JSON.stringify(v)).length <= per
										? { field, value: v }
										: {
												field,
												deferred: true,
												type: Array.isArray(v) ? "array" : typeof v,
											};
								}),
							};
							if (index + 20 < entries.length) {
								out.details.next_index = index + 20;
								out.next = { ...next, index: index + 20 };
							}
						} else out.details = { value };
						return out;
					}),
				};
			},
		},
		ctx,
	);
}
export function listAssetsTool(ctx: ToolRunContext) {
	return domainTool<{
		type?: string;
		dsl?: string;
		id?: number;
		ids?: number[];
		limit?: number;
		offset?: number;
	}>(
		{
			name: "list_assets",
			description:
				"历史资产检索兼容入口，新会话使用 asset_search / asset_get。",
			parameters: {
				type: "object",
				properties: {
					...searchProperties,
					id: { type: "integer" },
					ids: { type: "array", items: { type: "integer" } },
				},
			},
			readOnly: true,
			async run(a, c) {
				if (c.taskID <= 0) return { assets: [], total: 0, count: 0 };
				const r = await queryAssets(c.db, {
					...a,
					taskID: c.taskID,
					ids: a.ids ?? (a.id ? [a.id] : undefined),
					limit: Math.min(50, a.limit ?? 20),
					summary: true,
				});
				return {
					...r,
					assets: r.assets.map((x) => ({
						...x,
						host: x.domain || x.ip || x.url || x.app_name || x.bundle_id,
						title: x.page_title,
						status: x.status_code,
					})),
				};
			},
		},
		ctx,
	);
}
export function listUntestedAssetsTool(ctx: ToolRunContext) {
	return domainTool<{ type?: string; limit?: number; offset?: number }>(
		{
			name: "list_untested_assets",
			description:
				"历史未测查询兼容入口，新会话使用 asset_search(untested=true)。",
			parameters: { type: "object", properties: searchProperties },
			readOnly: true,
			async run(a, c) {
				const r = await c.db
					.taskScope()
					.listUntestedAssets(
						c.taskID,
						c.expID,
						a.type ?? "",
						a.limit ?? 10,
						a.offset ?? 0,
					);
				return { assets: r.page, total: r.total };
			},
		},
		ctx,
	);
}

interface AddTaskScopeArgs {
	kind: "root_domain" | "subdomain" | "ip" | "cidr" | "keyword";
	value: string;
	reason?: string;
}

export function addTaskScopeTool(ctx: ToolRunContext) {
	return domainTool<AddTaskScopeArgs>(
		{
			name: "add_task_scope",
			description:
				"把资产纳入本任务测试范围（覆盖度分母）。planner 判定某类资产该测但不在范围内时使用；" +
				"登记后可直接继续探索。",
			promptSnippet: "扩展任务测试范围",
			parameters: {
				type: "object",
				properties: {
					kind: {
						type: "string",
						enum: ["root_domain", "subdomain", "ip", "cidr", "keyword"],
					},
					value: { type: "string", description: "域名/IP/CIDR/关键词" },
					reason: { type: "string", description: "为什么纳入范围（可追溯）" },
				},
				required: ["kind", "value"],
			},
			async run(args, c) {
				await c.db
					.taskScope()
					.addAgentScope(
						c.taskID,
						args.kind,
						args.value,
						args.reason ?? "",
						"agent",
					);
				return { added: true, kind: args.kind, value: args.value };
			},
		},
		ctx,
	);
}
