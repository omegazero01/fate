// 把非 TS 资产（schema SQL）从 src 拷进 dist，保证编译产物可独立运行。
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const src = path.resolve("src/db/sql");
const dest = path.resolve(process.env.SERIES_BUILD_DIR ?? "dist", "db/sql");
if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-assets] ${src} -> ${dest}`);
} else {
  console.warn(`[copy-assets] 缺少 ${src}，跳过`);
}
