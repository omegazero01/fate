import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { openDatabase, type Database } from "./index.js";
import { repairAssetGraph } from "./asset-repair.js";
import { writeAssets } from "./asset-write.js";
import { assetGetTool } from "../tools/assets.js";
import { runContext } from "../tools/context.js";
let db: Database,
	task: number,
	exp: number,
	intent: number,
	id: number,
	duplicate: number;
const name = `fate_asset_repair_test_${process.pid}`;
beforeAll(async () => {
	process.env.SERIES_PG_DSN = `postgres://series:series@127.0.0.1:5433/${name}`;
	db = await openDatabase();
	const t = await db
		.tasks()
		.createTaskWithOptions("LOCAL repair", "", { executionMode: "manual" });
	task = t.id;
	exp = t.exploration_id;
	intent = await db
		.exploration(exp)
		.addIntent({ summary: "LOCAL historical discovery" }, 5, [], "user");
	const r = await writeAssets(
		db,
		[{ type: "endpoint", url: "https://repair.example/api", method: "GET" }],
		{ taskID: task, agent: "user", user: true },
	);
	id = r.results[0]!.id;
	duplicate = Number(
		(
			await db.query(
				"INSERT INTO assets(type,url,method,domain,root_domain,params,task_ids) VALUES('endpoint','https://REPAIR.example/api','get','REPAIR.example','repair.example',ARRAY['{\"location\":\"query\",\"name\":\"id\",\"value\":\"1\"}'::jsonb],ARRAY[$1::bigint]) RETURNING id",
				[task],
			)
		).rows[0]!.id,
	);
	await db.query(
		"INSERT INTO task_asset_links(task_id,asset_id,source,tested) VALUES($1,$2,'agent',true) ON CONFLICT(task_id,asset_id) DO UPDATE SET tested=true",
		[task, duplicate],
	);
	await db.query(
		"INSERT INTO activity(exploration_id,node_id,kind,tool,detail) VALUES($1,$2,'tool_result','insert_assets',$3)",
		[exp, intent, JSON.stringify({ assets: [{ asset_id: duplicate }] })],
	);
	await db.query(
		"INSERT INTO activity(exploration_id,node_id,kind,tool,detail,is_error) VALUES($1,$2,'tool_result','insert_assets',$3,true)",
		[
			exp,
			intent,
			JSON.stringify({ assets: [{ type: "ip", ip: "192.0.2.200" }] }),
		],
	);
});
afterAll(async () => {
	await db?.close();
	const admin = new pg.Client({
		connectionString: "postgres://series:series@127.0.0.1:5433/postgres",
	});
	await admin.connect();
	await admin.query(`DROP DATABASE ${name}`);
	await admin.end();
});
it("preview rolls back; apply preserves minimum IDs, fields, tested links and explicit provenance; retry is a no-op", async () => {
	const snapshot = async () =>
		JSON.stringify((await db.query("SELECT * FROM assets ORDER BY id")).rows);
	const before = await snapshot(),
		preview = await repairAssetGraph(db);
	expect(preview.changes).toContainEqual({
		kind: "merge",
		old_id: duplicate,
		asset_id: id,
	});
	expect(await snapshot()).toBe(before);
	const applied = await repairAssetGraph(db, true);
	expect(applied.changes).toEqual(preview.changes);
	expect(
		(await db.query("SELECT 1 FROM assets WHERE id=$1", [duplicate])).rowCount,
	).toBe(0);
	expect(
		(await db.query("SELECT params FROM assets WHERE id=$1", [id])).rows[0]!
			.params,
	).toHaveLength(1);
	expect(
		(
			await db.query(
				"SELECT tested FROM task_asset_links WHERE task_id=$1 AND asset_id=$2",
				[task, id],
			)
		).rows[0]!.tested,
	).toBe(true);
	expect(
		(
			await db.query(
				"SELECT 1 FROM exploration_anchors WHERE node_id=$1 AND asset_id=$2",
				[intent, id],
			)
		).rowCount,
	).toBe(1);
	expect(
		(await db.query("SELECT 1 FROM assets WHERE ip='192.0.2.200'")).rowCount,
	).toBe(0);
	const after = await snapshot();
	expect((await repairAssetGraph(db, true)).changes).toEqual([]);
	expect(await snapshot()).toBe(after);
	const old = await assetGetTool(runContext(db, task, exp, "planner")).execute(
		"alias-read",
		{ ids: [duplicate] },
	);
	expect(old.isError).not.toBe(true);
	expect(JSON.parse((old.content[0] as any).text).assets[0]).toMatchObject({
		asset_id: id,
		requested_id: duplicate,
	});
});
