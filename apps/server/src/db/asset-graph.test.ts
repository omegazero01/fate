import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { normalizeURL, parseURL } from "./assets.js";
import Fastify from "fastify";
import {registerCompatRoutes} from "../http/routes/compat.js";
import { registerAssetRoutes } from "../http/routes/assets.js";
import { openDatabase, type Database } from "./index.js";
import { writeAssets, normalizeAssetInput, assetURL } from "./asset-write.js";
import {
	queryAssets,
	assetCounts,
	assetCoverage,
	coverageGraph,
} from "./asset-query.js";
import { compileAssetDSL } from "./asset-dsl.js";
import {
	assetSearchTool,
	assetGetTool,
	insertAssetsTool,
} from "../tools/assets.js";
import { runContext } from "../tools/context.js";
import { mergedAssetSearchTool } from "../tools/asset-search-compat.js";
import { applyToolBindings } from "../agent/tool-bindings.js";
import { buildGraphOverview } from "../tools/overview.js";
import { randomUUID } from "node:crypto";
let db: Database,
	task: number,
	source: number,
	third: number,
	exp: number,
	intent: number;
const databaseName = `fate_asset_graph_test_${process.pid}`;
const root = `graph-${randomUUID().slice(0, 8)}.example`;
const origin = () => ({ taskID: task, intentID: intent, agent: "work#1" });
beforeAll(async () => {
	process.env.SERIES_PG_DSN = `postgres://series:series@127.0.0.1:5433/${databaseName}`;
	db = await openDatabase();
	const t = await db
		.tasks()
		.createTaskWithOptions("LOCAL SERIES assets", "", {
			executionMode: "manual",
		});
	task = t.id;
	exp = t.exploration_id;
	intent = Number(
		(
			await db.query(
				"INSERT INTO exploration_nodes(exploration_id,kind,state,payload) VALUES($1,'intent','running','{\"summary\":\"asset fixture\"}') RETURNING id",
				[exp],
			)
		).rows[0]!.id,
	);
	source = (
		await db
			.tasks()
			.createTaskWithOptions("LOCAL source", "", { executionMode: "manual" })
	).id;
	third = (
		await db
			.tasks()
			.createTaskWithOptions("LOCAL third", "", { executionMode: "manual" })
	).id;
});
afterAll(async () => {
	await db?.close();
	const admin = new pg.Client({
		connectionString: "postgres://series:series@127.0.0.1:5433/postgres",
	});
	await admin.connect();
	await admin.query(`DROP DATABASE ${databaseName}`);
	await admin.end();
});
async function call(tool: any, args: any, id = randomUUID()) {
	const r = await tool.execute(id, args);
	if (r.isError) throw new Error(r.content[0].text);
	return JSON.parse(r.content[0].text);
}
it("SERIES identity: preserve explicit ports, URL path/query and IP types", () => {
	expect(assetURL("HTTPS://Example.ORG:443/A/../B?q=1")).toBe(
		"https://example.org:443/A/../B?q=1",
	);
	expect(assetURL("http://[2001:0db8::1]:8080/")).toBe(
		"http://[2001:db8::1]:8080",
	);
	expect(() =>
		normalizeAssetInput({ type: "ip", ip: "example.org" }),
	).toThrow();
	expect(() =>
		normalizeAssetInput({ type: "subdomain", domain: "192.0.2.1" }),
	).toThrow();
	expect(() =>
		normalizeAssetInput({ type: "endpoint", url: "https://example.org/a" }),
	).toThrow("method");
	const args: unknown[] = [];
	expect(
		compileAssetDSL("port==443 AND (technology=nginx OR status>=400)", args),
	).toContain("OR");
	expect(args).toEqual([443, "%nginx%", 400]);
	expect(() => compileAssetDSL("port==abc", [])).toThrow();
	expect(() => compileAssetDSL("(domain=x", [])).toThrow();
});
it("Planner DSL type and top-level type return identical scoped, paginated assets through tools and HTTP", async () => {
	const target = await db.tasks().createTaskWithOptions("LOCAL DSL target", "", { executionMode: "manual" });
	const direct = await db.tasks().createTaskWithOptions("LOCAL DSL source", "", { executionMode: "manual" });
	const unrelated = await db.tasks().createTaskWithOptions("LOCAL DSL unrelated", "", { executionMode: "manual" });
	await db.query("INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)", [target.id, direct.id]);
	for (const t of [target, direct, unrelated]) {
		const result = await writeAssets(db, [
			{ type: "endpoint", url: `http://dsl-${t.id}.${root}:5200/entry`, method: "GET" },
			{ type: "endpoint", url: `http://dsl-${t.id}.${root}:5201/other`, method: "GET" },
			{ type: "service", url: `http://dsl-${t.id}.${root}:5200` },
		], { taskID: t.id, agent: "fixture" });
		expect(result.errors).toEqual([]);
	}
	const ctx = runContext(db, target.id, target.exploration_id, "planner");
	const [tool] = await applyToolBindings(db, "planner", [mergedAssetSearchTool(ctx)]);
	expect((tool!.parameters as any).properties.dsl.description).toContain("type==endpoint");
	const dsl = "port==5200 AND type==endpoint";
	const complete = await call(tool!, { dsl, limit: 50 });
	expect(complete).toEqual(await call(tool!, { dsl: "port==5200", type: "endpoint", limit: 50 }));
	expect(complete.total).toBe(2);
	expect(complete.assets.every((a: any) => a.port === 5200 && a.type === "endpoint")).toBe(true);
	expect(complete.assets.find((a: any) => a.source_task_id === direct.id)).toMatchObject({ inherited: true, read_only: true });
	const first = await call(tool!, { dsl, limit: 1 });
	expect(first).toMatchObject({ total: 2, count: 1, has_more: true, next_offset: 1 });
	const last = await call(tool!, { dsl, limit: 1, offset: first.next_offset });
	expect(last).toMatchObject({ total: 2, count: 1, has_more: false });
	expect([...first.assets, ...last.assets]).toEqual(complete.assets);
	expect((await call(tool!, { dsl, type: "service" })).total).toBe(0);
	await db.query("UPDATE tools SET enabled=false WHERE key='asset_search'");
	try { expect((await tool!.execute("disabled", { dsl } as never)).isError).toBe(true); }
	finally { await db.query("UPDATE tools SET enabled=true WHERE key='asset_search'"); }
	const app = Fastify();
	app.decorate("db", db);
	registerAssetRoutes(app);
	try {
		const response = await app.inject({ url: `/api/assets?task_id=${target.id}&dsl=${encodeURIComponent(dsl)}` });
		expect(response.statusCode).toBe(200);
		expect(response.json().assets.map((a: any) => a.id)).toEqual(complete.assets.map((a: any) => a.id));
		const invalid = await app.inject({ url: `/api/assets?dsl=${encodeURIComponent("constructor==1")}` });
		expect(invalid.statusCode).toBe(400);
	} finally { await app.close(); }
});
it("real regression: string DNS, multiple IPs, partial errors, append merges and intent anchors", async () => {
	const r = await writeAssets(
		db,
		[
			{
				type: "subdomain",
				domain: `www.${root}`,
				record_type: "A",
				record_value: "192.0.2.81,192.0.2.82",
			},
			{ type: "ip", ip: "this-is-not-an-ip" },
			{
				type: "service",
				url: `https://www.${root}`,
				service_name: "HTTPS",
				technologies: ["nginx"],
				status_code: 200,
			},
			{
				type: "endpoint",
				url: `https://www.${root}/api`,
				method: "GET",
				params: [{ location: "query", name: "id", value: "1" }],
			},
			{
				type: "endpoint",
				url: `https://www.${root}/api`,
				method: "POST",
				params: [{ location: "body", name: "name", value: "中文😀" }],
			},
		],
		{ ...origin(), callID: "initial" },
	);
	expect(r.results).toHaveLength(4);
	expect(r.errors).toEqual([
		{ index: 1, error: expect.stringContaining("IPv4") },
	]);
	expect((await assetCounts(db, task)).ip).toBe(2);
	const ids = r.results.map((r) => r.id);
	expect(
		(
			await db.query(
				"SELECT asset_id FROM exploration_anchors WHERE node_id=$1 AND asset_id=ANY($2)",
				[intent, ids],
			)
		).rowCount,
	).toBe(4);
	const again = await writeAssets(
		db,
		[
			{
				type: "subdomain",
				domain: `www.${root}`,
				record_type: "A",
				record_value: "192.0.2.81,192.0.2.82",
			},
		],
		{ ...origin(), callID: "initial" },
	);
	expect(again.results[0]!.id).toBe(ids[0]);
	const added = await writeAssets(
		db,
		[
			{
				type: "endpoint",
				url: `https://www.${root}/api`,
				method: "GET",
				params: [
					{ location: "query", name: "id", value: "2" },
					{ location: "query", name: "next", value: "3" },
				],
			},
		],
		origin(),
	);
	expect(added.results[0]!.id).toBe(ids[2]);
	const page = await queryAssets(db, {
		taskID: task,
		type: "endpoint",
		dsl: "method==GET AND url=/api",
	});
	expect(page.total).toBe(1);
	expect(page.assets[0]!.params).toHaveLength(2);
	expect(page.assets[0]!.method).toBe("GET");
});
it("DNS TXT/SRV metadata, IP literal service and unrelated/disabled scope", async () => {
	const before = (
		await db.query("SELECT count(*) FROM task_scope WHERE task_id=$1", [task])
	).rows[0]!.count;
	const r = await writeAssets(
		db,
		[
			{
				type: "subdomain",
				domain: `_dmarc.${root}`,
				record_type: "TXT",
				record_value: "v=DMARC1; p=none",
				related: false,
			},
		],
		origin(),
	);
	expect(r.errors).toEqual([]);
	const row = (await queryAssets(db, { taskID: task, ids: [r.results[0]!.id] }))
		.assets[0]!;
	expect(row.domain).toBe(root);
	expect(row.extra.dns_records[0].values).toEqual(["v=DMARC1; p=none"]);
	expect(
		(await db.query("SELECT count(*) FROM task_scope WHERE task_id=$1", [task]))
			.rows[0]!.count,
	).toBe(before);
	const ip = await writeAssets(
		db,
		[{ type: "service", url: "http://[2001:db8::81]:8080" }],
		origin(),
	);
	expect(ip.errors).toEqual([]);
	expect((await assetCounts(db, task)).ip).toBe(3);
	await db.query("UPDATE tasks SET coverage_enabled=false WHERE id=$1", [task]);
	const disabledBefore = (
		await db.query("SELECT count(*) FROM task_scope WHERE task_id=$1", [task])
	).rows[0]!.count;
	await writeAssets(
		db,
		[{ type: "root_domain", domain: `disabled.${root}` }],
		origin(),
	);
	expect(
		(await db.query("SELECT count(*) FROM task_scope WHERE task_id=$1", [task]))
			.rows[0]!.count,
	).toBe(disabledBefore);
	expect((await assetCoverage(db, task)).denominator).toBe(0);
	await db.query("UPDATE tasks SET coverage_enabled=true WHERE id=$1", [task]);
});
it("direct-source union, no recursive inheritance and source tested evidence", async () => {
	const a = await writeAssets(
		db,
		[{ type: "endpoint", url: `https://source.${root}/api`, method: "GET" }],
		{ taskID: source, agent: "main" },
	);
	await writeAssets(db, [{ type: "root_domain", domain: `third.${root}` }], {
		taskID: third,
		agent: "main",
	});
	await db.query(
		"INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2),($2,$3)",
		[task, source, third],
	);
	await db.query(
		"UPDATE task_asset_links SET tested=true WHERE task_id=$1 AND asset_id=$2",
		[source, a.results[0]!.id],
	);
	const visible = await queryAssets(db, {
		taskID: task,
		dsl: `url==https://source.${root}/api`,
	});
 expect((await assetCoverage(db, task)).legacy_unverified).toBeGreaterThanOrEqual(1);
 const sourceExp=(await db.tasks().getTask(source))!.exploration_id;
 await db.exploration(sourceExp).addNode('fact',{summary:'LOCAL source test',observation_type:'observed',evidence:'LOCAL proof',scope:{tested:'one entry'},writeback:{coverage_eligible:true}},0,'confirmed','fixture',[a.results[0]!.id]);
	expect(visible.assets[0]!.inherited).toBe(true);
	expect(visible.assets[0]!.source_task_id).toBe(source);
	expect(
		(await queryAssets(db, { taskID: task, dsl: `domain==third.${root}` }))
			.total,
	).toBe(0);
	expect(
		(
			await queryAssets(db, {
				taskID: task,
				untested: true,
				ids: [a.results[0]!.id],
			})
		).total,
	).toBe(0);
	expect((await assetCoverage(db, task)).tested).toBeGreaterThanOrEqual(1);
});
it("asset_get preserves methods/params and paginates Unicode; default omits auth", async () => {
	const ctx = runContext(db, task, exp, "planner");
	const search = await call(assetSearchTool(ctx), {
		dsl: `url=https://www.${root}/api`,
		limit: 1,
	});
	expect(search.has_more).toBe(true);
	expect(search.assets[0].method).toBeTruthy();
	expect(search.assets[0].url).toContain("/api");
	const id = search.assets[0].id;
	await db.query(
		'UPDATE assets SET extra=$2,auth=ARRAY[\'{"password":"fixture-secret"}\'::jsonb] WHERE id=$1',
		[id, { note: "中文😀后续" }],
	);
	const basic = await call(assetGetTool(ctx), { ids: [id] });
	expect(JSON.stringify(basic)).not.toContain("fixture-secret");
	const one = await call(assetGetTool(ctx), {
		ids: [id],
		fields: ["extra"],
		field: "/extra/note",
		max_chars: 3,
	});
	expect(one.assets[0].details.value).toBe("中文😀");
	const two = await call(assetGetTool(ctx), one.assets[0].next);
	expect(two.assets[0].details.value).toBe("后续");
	const overview = await buildGraphOverview(ctx);
	expect(overview.asset_counts).toEqual(await assetCounts(db, task));
});
it("item commit rollback and stale ownership cannot leave records or notifications", async () => {
	const mark = Number(
		(
			await db.query(
				"SELECT COALESCE(max(id),0) n FROM blackboard_wakeups WHERE exploration_id=$1",
				[exp],
			)
		).rows[0]!.n,
	);
	let checks = 0;
	const r = await writeAssets(
		db,
		[{ type: "root_domain", domain: `rollback.${root}` }],
		{
			...origin(),
			assertOwnership: async () => {
				if (++checks === 2) throw new Error("lease lost");
			},
		},
	);
	expect(r.errors[0]!.error).toBe("lease lost");
	expect(
		(await queryAssets(db, { taskID: task, dsl: `domain==rollback.${root}` }))
			.total,
	).toBe(0);
	expect(
		(
			await db.query(
				"SELECT id FROM blackboard_wakeups WHERE exploration_id=$1 AND id>$2",
				[exp, mark],
			)
		).rowCount,
	).toBe(0);
});
it("graph contains >500 assets, real root once, URL labels and correct endpoint parents", async () => {
	await db.query(
		`INSERT INTO assets(type,url,method,domain,root_domain,port,task_ids) SELECT 'endpoint','https://www.'||$1||'/bulk/'||g,'GET','www.'||$1,$1,443,ARRAY[$2::bigint] FROM generate_series(1,510)g`,
		[root, task],
	);
	const graph = await coverageGraph(db, task);
	expect(
		graph.nodes.filter((n) => n.kind === "endpoint").length,
	).toBeGreaterThan(500);
	expect(
		graph.nodes.filter((n) => n.kind === "root_domain" && n.domain === root),
	).toHaveLength(1);
	const node = graph.nodes.find((n) => n.url === `https://www.${root}/api`)!;
	const parent = graph.nodes.find((n) => n.url === `https://www.${root}`)!;
	expect(graph.edges).toContainEqual({ src: node.key, dst: parent.key });
	expect(node.label).toBe(`${node.method} ${node.url}`);
});
it("MCP/PI-compatible complete input schema and no old 20-row silent truncation", async () => {
	const ctx = runContext(db, task, exp, "worker", { intentID: intent });
	const r = await call(insertAssetsTool(ctx), {
		assets: Array.from({ length: 21 }, (_, i) => ({
			type: "endpoint",
			url: `https://www.${root}/batch/${i}`,
			method: "GET",
		})),
	});
	expect(r.results).toHaveLength(21);
});

it("concurrent item retries return one record; stale ownership cannot replay a cached result", async () => {
	const input = [
		{ type: "endpoint", url: `https://retry.${root}/x`, method: "GET" },
	];
	const writes = await Promise.all(
		Array.from({ length: 8 }, () =>
			writeAssets(db, input, { ...origin(), callID: "concurrent" }),
		),
	);
	expect(new Set(writes.map((w) => w.results[0]!.id)).size).toBe(1);
	expect(
		(
			await db.query(
				"SELECT 1 FROM asset_tool_writes WHERE call_id='concurrent'",
			)
		).rowCount,
	).toBe(1);
	const stale = await writeAssets(db, input, {
		...origin(),
		callID: "concurrent",
		assertOwnership: async () => {
			throw new Error("lease lost");
		},
	});
	expect(stale.results).toEqual([]);
	expect(stale.errors[0]!.error).toBe("lease lost");
});
it("field updates notify direct consumers only; rollback does not notify and source removal removes visibility", async () => {
	const r = await queryAssets(db, {
		taskID: source,
		dsl: `url==https://source.${root}/api`,
	});
	const id = r.assets[0]!.id;
	const max = Number(
		(await db.query("SELECT COALESCE(max(id),0) id FROM blackboard_wakeups"))
			.rows[0]!.id,
	);
	await db.query(
		"UPDATE assets SET page_title='changed observation' WHERE id=$1",
		[id],
	);
	const affected = (
		await db.query(
			"SELECT DISTINCT t.id FROM blackboard_wakeups w JOIN tasks t ON t.exploration_id=w.exploration_id WHERE w.id>$1",
			[max],
		)
	).rows.map((r) => Number(r.id));
	expect(affected.sort()).toEqual([task, source].sort());
	await db.query(
		"DELETE FROM task_relations WHERE task_id=$1 AND source_task_id=$2",
		[task, source],
	);
	expect((await queryAssets(db, { taskID: task, ids: [id] })).total).toBe(0);
});
it("REST batch registration and DSL share DTO, totals and error semantics", async () => {
	const app = Fastify();
	app.decorate("db", db);
	registerAssetRoutes(app);
 registerCompatRoutes(app);
	try {
		const res = await app.inject({
			method: "POST",
			url: "/api/assets",
			payload: {
				task_id: task,
				assets: [
					{
						type: "endpoint",
						url: `https://rest.${root}/v1`,
						method: "POST",
						params: [{ location: "body", name: "value" }],
					},
					{ type: "ip", ip: "bad" },
				],
			},
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().results).toHaveLength(1);
		expect(res.json().errors).toHaveLength(1);
 await db.query('INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2)',[intent,res.json().results[0].id]);
 const detail=await app.inject({url:`/api/exploration/nodes/${intent}?task=${task}`});
 expect(detail.statusCode).toBe(200);expect(detail.json().assets.some((a:any)=>a.id===res.json().results[0].id)).toBe(true);
 expect(detail.json().assets_total).toBeGreaterThan(0);
		const url =
			"/api/assets?task_id=" +
			task +
			"&dsl=" +
			encodeURIComponent(`url==https://rest.${root}/v1 AND method==POST`);
		const found = await app.inject({ url });
		expect(found.json()).toMatchObject({
			total: 1,
			assets: [
				{ method: "POST", params: [{ location: "body", name: "value" }] },
			],
		});
		expect(
			(
				await app.inject({
					url: "/api/assets?dsl=" + encodeURIComponent("port>abc"),
				})
			).statusCode,
		).toBe(400);
		expect(
			(await app.inject({ url: "/api/assets/counts?task_id=" + task })).json(),
		).toEqual(await assetCounts(db, task));
	} finally {
		await app.close();
	}
});

it("same fixtures match pinned SERIES Go normalization and DSL query results", async () => {
	const golden = JSON.parse(
		readFileSync(
			new URL("./fixtures/series-78ab23f-assets.json", import.meta.url),
			"utf8",
		),
	);
	for (const x of golden.urls) {
		expect(normalizeURL(x.input)).toBe(x.normalized);
		expect(parseURL(x.input)).toEqual({
			domain: x.domain,
			port: x.port,
			serviceName: x.serviceName,
		});
	}
	for (const x of golden.dsl) {
		const args: unknown[] = [];
		if (x.error) {
			expect(() => compileAssetDSL(x.input, args)).toThrow();
			continue;
		}
		const sql = compileAssetDSL(x.input, args);
		expect(args).toEqual(x.args);
		const reference = (
			await db.query(
				"SELECT id FROM assets WHERE " + x.sql + " ORDER BY id",
				x.args,
			)
		).rows;
		const actual = (
			await db.query(
				"SELECT id FROM assets a WHERE " + sql + " ORDER BY id",
				args,
			)
		).rows;
		expect(actual).toEqual(reference);
	}
});

it('soft-deleted direct sources disappear and wake their consumers',async()=>{
 await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[task,third]);
 expect((await queryAssets(db,{taskID:task,dsl:`domain==third.${root}`})).total).toBe(1);
 const max=(await db.query('SELECT COALESCE(max(id),0) id FROM blackboard_wakeups')).rows[0]!.id;
 await db.query('UPDATE tasks SET deleted_at=now() WHERE id=$1',[third]);
 expect((await queryAssets(db,{taskID:task,dsl:`domain==third.${root}`})).total).toBe(0);
 expect((await db.query('SELECT 1 FROM blackboard_wakeups WHERE id>$1 AND exploration_id=$2',[max,exp])).rowCount).toBeGreaterThan(0);
});
