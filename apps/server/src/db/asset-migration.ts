import type { Database } from "./index.js";
/** Exact default migration; disabled/custom bindings remain intentional. */
export async function migrateAssetTools(db: Database) {
	await db.transaction(async (tx) => {
		if (
			(await tx.platform().getSetting("series_asset_tools_78ab23f_v1")) ===
			"done"
		)
			return;
		const old = (
			await tx.query(
				"SELECT * FROM tools WHERE key='list_assets' AND kind='builtin'",
			)
		).rows[0];
		const agents = old?.agents ?? ["planner", "worker", "mainagent"];
		for (const [key, description] of [
			["asset_search", "检索任务资产摘要，按 DSL 或未测条件分页"],
			["asset_get", "按资产 ID 和字段组读取详情"],
		])
			await tx.query(
				`INSERT INTO tools(key,system,description,schema,agents,enabled,kind) VALUES($1,true,$2,'{}',$3,$4,'builtin') ON CONFLICT(key) DO NOTHING`,
				[key, description, JSON.stringify(agents), old?.enabled !== false],
			);
		const before = (
			await tx.query(
				"SELECT * FROM tools WHERE key IN('list_assets','list_untested_assets')",
			)
		).rows;
		await tx
			.platform()
			.setSetting("series_asset_tools_previous", JSON.stringify(before));
		for (const r of before) {
			const expected =
				r.key === "list_assets" ? "查询资产库" : "列出范围内未测资产";
			const defaults =
				r.key === "list_assets"
					? [
							["planner", "worker", "mainagent"],
							["planner", "worker", "mainagent", "pentest", "retester", "auto"],
						]
					: [["planner", "mainagent"]];
			if (
				r.system &&
				r.description === expected &&
				defaults.some((a) => JSON.stringify(a) === JSON.stringify(r.agents))
			)
				await tx.query("UPDATE tools SET agents='[]' WHERE key=$1", [r.key]);
		}
		await tx.platform().setSetting("series_asset_tools_78ab23f_v1", "done");
	});
}
