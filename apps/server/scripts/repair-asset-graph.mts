import pg from "pg";
import { writeFileSync } from "node:fs";
import { Database } from "../src/db/index.js";
import { repairAssetGraph } from "../src/db/asset-repair.js";
const dsn = process.env.SERIES_PG_DSN;
if (!dsn) throw new Error("明确指定 SERIES_PG_DSN；先在副本预演并备份");
const db = new Database(new pg.Pool({ connectionString: dsn }));
try {
	const result = await repairAssetGraph(db, process.argv.includes("--apply"));
	const file = process.argv.find((a) => a.startsWith("--report="))?.slice(9);
	if (file)
		writeFileSync(file, JSON.stringify(result, null, 2) + "\n", {
			mode: 0o600,
		});
	console.log(
		JSON.stringify({
			apply: result.apply,
			before: result.before,
			after: result.after,
			changes: result.changes.length,
			unresolved: result.unresolved.length,
			report: file,
		}),
	);
} finally {
	await db.close();
}
