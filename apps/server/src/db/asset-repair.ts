import { Database } from "./index.js";
import { normalizeAssetInput, upsertAsset } from "./asset-write.js";
import { rootDomain, parseURL } from "./assets.js";
import { assetDTO, type AssetRow } from "./asset-query.js";
function identity(a: AssetRow) {
	switch (a.type) {
		case "root_domain":
			return [a.type, a.domain];
		case "subdomain":
			return [a.type, a.domain, (a.record_type ?? "").toUpperCase()];
		case "ip":
			return [a.type, a.ip];
		case "app":
			return [a.type, a.bundle_id || null, a.bundle_id ? null : a.app_name];
		case "endpoint":
			return [a.type, a.url, a.method];
		case "service":
			return a.url
				? [a.type, "http", a.url]
				: [
						a.type,
						"other",
						a.domain ?? "",
						a.ip ?? "",
						a.port,
						String(a.service_name).toLowerCase(),
					];
		default:
			return [a.type, a.id];
	}
}
async function needsParents(db: Database, a: AssetRow, task: number) {
	const host = a.url ? parseURL(a.url).domain : (a.domain ?? ""),
		root = rootDomain(host).root;
	const specs: { type: string; domain?: string; ip?: string }[] = [];
	if (["subdomain", "service", "endpoint"].includes(a.type) && host) {
		if (
			(/^[0-9a-f:.]+$/i.test(host) && host.includes(":")) ||
			/^\d+\.\d+\.\d+\.\d+$/.test(host)
		)
			specs.push({ type: "ip", ip: host });
		else {
			specs.push({ type: "root_domain", domain: root });
			if (a.type !== "subdomain" && host !== root)
				specs.push({ type: "subdomain", domain: host });
		}
	}
	if (a.ip && a.type !== "ip") specs.push({ type: "ip", ip: a.ip });
	if (a.type === "subdomain" && ["A", "AAAA"].includes(a.record_type))
		for (const ip of a.record_value ?? [])
			for (const part of ip.split(","))
				specs.push({ type: "ip", ip: part.trim() });
	for (const spec of specs) {
		const match = await db.query(
			`SELECT 1 FROM assets a JOIN task_asset_links l ON l.asset_id=a.id AND l.task_id=$1 WHERE a.type=$2 AND ($3::text IS NULL OR a.domain=$3) AND ($4::text IS NULL OR a.ip=$4)`,
			[task, spec.type, spec.domain ?? null, spec.ip ?? null],
		);
		if (!match.rowCount) return true;
	}
	return false;
}
export async function repairAssetGraph(database: Database, apply = false) {
	const client = await database.pool.connect(),
		db = new Database(database.pool, client);
	const changes: AssetRow[] = [],
		unresolved: AssetRow[] = [];
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock(7337741003)");
		await client.query("SELECT set_config('series.asset_repair','on',true)");
		const before = (
			await db.query(
				"SELECT type,count(*)::int n FROM assets GROUP BY type ORDER BY type",
			)
		).rows;
		const all = (await db.query("SELECT * FROM assets ORDER BY id")).rows;
		const groups = new Map<string, { raw: AssetRow; input: AssetRow }[]>();
		for (const raw of all) {
			try {
				const input = normalizeAssetInput(assetDTO({ ...raw })),
					key = JSON.stringify(identity(input)),
					group = groups.get(key) ?? [];
				group.push({ raw, input });
				groups.set(key, group);
			} catch (e) {
				unresolved.push({
					asset_id: Number(raw.id),
					reason: String(e instanceof Error ? e.message : e),
				});
			}
		}
		for (const group of groups.values()) {
			const companies = new Set(
				group
					.filter((x) => x.raw.company_source === "explicit")
					.map((x) => String(x.raw.company_id)),
			);
			if (companies.size > 1) {
				for (const x of group)
					unresolved.push({
						asset_id: Number(x.raw.id),
						reason: "重复身份具有冲突的显式企业归属",
					});
				continue;
			}
			const keep = Number(group[0]!.raw.id);
			for (const { raw, input } of group.slice(1)) {
				const old = Number(raw.id);
				if (
					raw.company_source === "explicit" &&
					group[0]!.raw.company_source === "explicit" &&
					raw.company_id !== group[0]!.raw.company_id
				) {
					unresolved.push({
						asset_id: old,
						reason: "重复身份具有冲突的显式企业归属",
					});
					continue;
				}
				await db.query(
					"INSERT INTO asset_id_aliases(old_id,asset_id,original) VALUES($1,$2,$3) ON CONFLICT(old_id) DO NOTHING",
					[old, keep, raw],
				);
				await db.query(
					`UPDATE assets k SET
    page_title=COALESCE(NULLIF(k.page_title,''),o.page_title),status_code=COALESCE(k.status_code,o.status_code),content_length=COALESCE(k.content_length,o.content_length),
    favicon_mmh3=COALESCE(NULLIF(k.favicon_mmh3,''),o.favicon_mmh3),icp=COALESCE(NULLIF(k.icp,''),o.icp),app_icp=COALESCE(NULLIF(k.app_icp,''),o.app_icp),
    app_description=COALESCE(NULLIF(k.app_description,''),o.app_description),company_id=COALESCE(k.company_id,o.company_id),
    task_ids=ARRAY(SELECT DISTINCT unnest(k.task_ids||o.task_ids)),
    technologies=ARRAY(SELECT DISTINCT unnest(k.technologies||o.technologies)),bound_domains=ARRAY(SELECT DISTINCT unnest(k.bound_domains||o.bound_domains)),record_value=ARRAY(SELECT DISTINCT unnest(k.record_value||o.record_value)),
    params=ARRAY(SELECT DISTINCT ON(v->>'location',v->>'name') v FROM unnest(k.params||o.params)v ORDER BY v->>'location',v->>'name',v::text DESC),
    auth=ARRAY(SELECT DISTINCT v FROM unnest(k.auth||o.auth)v),open_ports=ARRAY(SELECT DISTINCT ON(v->>'port')v FROM unnest(k.open_ports||o.open_ports)v ORDER BY v->>'port',v::text DESC),extra=o.extra||k.extra
    FROM assets o WHERE k.id=$1 AND o.id=$2`,
					[keep, old],
				);
				await db.query(
					`INSERT INTO task_asset_links(task_id,asset_id,source,source_summary,source_node_id,source_origin,tested,tested_at,tested_by)
    SELECT task_id,$1,source,source_summary,source_node_id,source_origin,tested,tested_at,tested_by FROM task_asset_links WHERE asset_id=$2
    ON CONFLICT(task_id,asset_id) DO UPDATE SET tested=task_asset_links.tested OR EXCLUDED.tested,tested_at=COALESCE(task_asset_links.tested_at,EXCLUDED.tested_at),tested_by=COALESCE(task_asset_links.tested_by,EXCLUDED.tested_by)`,
					[keep, old],
				);
				await db.query(
					"INSERT INTO exploration_anchors(node_id,asset_id) SELECT node_id,$1 FROM exploration_anchors WHERE asset_id=$2 ON CONFLICT DO NOTHING",
					[keep, old],
				);
				for (const table of [
					"findings",
					"worker_observations",
					"worker_observation_revisions",
				])
					await db.query(
						`UPDATE ${table} SET asset_ids=(SELECT jsonb_agg(DISTINCT CASE WHEN v=$2::jsonb THEN $1::jsonb ELSE v END) FROM jsonb_array_elements(asset_ids)v) WHERE asset_ids @> jsonb_build_array($2::jsonb)`,
						[JSON.stringify(keep), JSON.stringify(old)],
					);
				await db.query(
					`UPDATE exploration_nodes SET payload=jsonb_set(payload,'{asset_ids}',(SELECT jsonb_agg(DISTINCT CASE WHEN v=$2::jsonb THEN $1::jsonb ELSE v END) FROM jsonb_array_elements(payload->'asset_ids')v)) WHERE jsonb_typeof(payload->'asset_ids')='array' AND payload->'asset_ids' @> jsonb_build_array($2::jsonb)`,
					[JSON.stringify(keep), JSON.stringify(old)],
				);
				await db.query(
					"UPDATE asset_tool_writes SET asset_id=$1,result=jsonb_set(result,'{id}',to_jsonb($1::bigint)) WHERE asset_id=$2",
					[keep, old],
				);
				await db.query(
					"UPDATE asset_id_aliases SET asset_id=$1 WHERE asset_id=$2",
					[keep, old],
				);
				await db.query("DELETE FROM assets WHERE id=$1", [old]);
				changes.push({ kind: "merge", old_id: old, asset_id: keep });
			}
			const { raw, input } = group[0]!;
			const normalized: AssetRow = {};
			for (const k of [
				"domain",
				"ip",
				"url",
				"method",
				"record_type",
				"service_name",
			])
				if (input[k] != null && input[k] !== raw[k]) normalized[k] = input[k];
			if (
				["root_domain", "subdomain", "service", "endpoint"].includes(raw.type)
			) {
				const host = input.url ? parseURL(input.url).domain : input.domain;
				if (host) {
					const root =
						raw.type === "root_domain" ? host : rootDomain(host).root;
					if (root !== raw.root_domain) normalized.root_domain = root;
				}
			}
			if (Object.keys(normalized).length) {
				const keys = Object.keys(normalized);
				await db.query(
					`UPDATE assets SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(",")} WHERE id=$1`,
					[keep, ...keys.map((k) => normalized[k])],
				);
				changes.push({ kind: "normalize", asset_id: keep, fields: keys });
			}
		}
		// Only successful explicit tool results establish discovery anchors. Failed inputs never create assets.
		const successes = (
			await db.query(`SELECT a.id,a.node_id,a.detail,a.tool_use_id,t.id task_id FROM activity a JOIN tasks t ON t.exploration_id=a.exploration_id
 JOIN exploration_nodes n ON n.id=a.node_id AND n.kind='intent' WHERE a.kind='tool_result' AND a.tool='insert_assets' AND NOT a.is_error ORDER BY a.id`)
		).rows;
		for (const a of successes) {
			let out: AssetRow;
			try {
				out = JSON.parse(a.detail as string);
			} catch {
				continue;
			}
			if (out.error) continue;
			for (const item of Array.isArray(out.results)
				? out.results
				: Array.isArray(out.assets)
					? out.assets
					: []) {
				const rawID = Number(item.id ?? item.asset_id);
				if (!Number.isSafeInteger(rawID) || rawID <= 0) continue;
				const id = Number(
					(
						await db.query(
							"SELECT COALESCE((SELECT asset_id FROM asset_id_aliases WHERE old_id=$1),$1) id",
							[rawID],
						)
					).rows[0]!.id,
				);
				const linked = await db.query(
					"SELECT 1 FROM task_asset_links WHERE task_id=$1 AND asset_id=$2",
					[a.task_id, id],
				);
				if (!linked.rowCount) continue;
				const r = await db.query(
					"INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING asset_id",
					[a.node_id, id],
				);
				if (r.rowCount)
					changes.push({
						kind: "explicit_anchor",
						asset_id: id,
						intent_id: Number(a.node_id),
						activity_id: Number(a.id),
					});
			}
		}
		// Reuse observed, persisted fields only. Derived parents retain task provenance;
		// no old model prompt or failed tool call is executed.
		const live = (
			await db.query(
				`SELECT a.*,ARRAY(SELECT l.task_id FROM task_asset_links l JOIN tasks t ON t.id=l.task_id AND t.deleted_at IS NULL WHERE l.asset_id=a.id) live_tasks FROM assets a WHERE EXISTS(SELECT 1 FROM task_asset_links l JOIN tasks t ON t.id=l.task_id AND t.deleted_at IS NULL WHERE l.asset_id=a.id)`,
			)
		).rows;
		for (const row of live) {
			try {
				const input = normalizeAssetInput(assetDTO({ ...row }));
				for (const tid of row.live_tasks as string[]) {
					if (!(await needsParents(db, input, Number(tid)))) continue;
					await db.query("SAVEPOINT asset_parent_repair");
					try {
						const beforeIDs = (
							await db.query(
								"SELECT asset_id FROM task_asset_links WHERE task_id=$1",
								[tid],
							)
						).rows.map((r) => Number(r.asset_id));
						await upsertAsset(db.assets(), input, Number(tid));
						const added = (
							await db.query(
								"SELECT asset_id FROM task_asset_links WHERE task_id=$1 AND NOT(asset_id=ANY($2::bigint[]))",
								[tid, beforeIDs],
							)
						).rows.map((r) => Number(r.asset_id));
						if (added.length)
							changes.push({
								kind: "derived_parents",
								asset_id: Number(row.id),
								task_id: Number(tid),
								added,
							});
						await db.query("RELEASE SAVEPOINT asset_parent_repair");
					} catch (e) {
						await db.query("ROLLBACK TO SAVEPOINT asset_parent_repair");
						unresolved.push({
							asset_id: Number(row.id),
							reason: String(e instanceof Error ? e.message : e),
						});
					}
				}
			} catch {
				/* Invalid identities were recorded above. */
			}
		}
		const after = (
			await db.query(
				"SELECT type,count(*)::int n FROM assets GROUP BY type ORDER BY type",
			)
		).rows;
		for (const change of changes)
			await db.query(
				"INSERT INTO asset_graph_repairs(repair_key,before_data,after_data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
				[
					JSON.stringify(change),
					all.find(
						(a) => Number(a.id) === Number(change.old_id ?? change.asset_id),
					) ?? {},
					change,
				],
			);
		await client.query(apply ? "COMMIT" : "ROLLBACK");
		return { apply, before, after, changes, unresolved };
	} catch (e) {
		await client.query("ROLLBACK");
		throw e;
	} finally {
		client.release();
	}
}
