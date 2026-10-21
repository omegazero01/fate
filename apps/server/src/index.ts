import { makeModelResolver } from "./pi/modelResolver.js";
// SERIES TS 后端入口：解析启动参数，打开数据库（含幂等迁移），构造引擎（模型源 =
// 激活 llm_profile → pi-ai 自定义 provider），监听 HTTP。
// 出口网关（:8788）随 -proxy 启动；本入口的职责与 Go 版 cmd/series/main.go 对齐（去除 selfupdate）。

import { mkdirSync } from "node:fs";
import { buildModelSource } from "./pi/providerFromProfile.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildApp } from "./http/app.js";
import { loadOrCreateJWTKey } from "./http/auth.js";
import { openDatabase, type Database } from "./db/index.js";
import { startEgressGateway, type EgressGateway } from "./egress/index.js";
import { configureAgentEnv } from "./agent/roles.js";
import { postgresDSN, skillDir, redactDSN } from "./config/index.js";
import { Engine, defaultEngineConfig, type ModelResolver } from "./engine/engine.js";
import type { ModelSource } from "./agent/roles.js";

const VERSION = process.env.SERIES_VERSION ?? "dev-ts";

interface Flags {
  addr: string;
  dataDir: string;
  proxy: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { addr: ":8787", dataDir: "./data", proxy: "127.0.0.1:8788" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "-addr" && next) {
      flags.addr = next;
      i++;
    } else if (a === "-data" && next) {
      flags.dataDir = next;
      i++;
    } else if (a === "-proxy" && next !== undefined) {
      flags.proxy = next;
      i++;
    }
  }
  return flags;
}

function normalizeAddr(addr: string): string {
  return addr.startsWith(":") ? `0.0.0.0${addr}` : addr;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const { dsn, source } = postgresDSN();
  console.log(`[config] 数据库来源: ${source} (${redactDSN(dsn)})`);
  const skillsRoot = skillDir();
  console.log(`[config] skill 目录: ${skillsRoot}`);

  mkdirSync(flags.dataDir, { recursive: true });

  const db = await openDatabase();
  console.log("[db] schema 迁移完成（幂等）");

  // 出口代理：-proxy 非空时启动，验证执行身份和暂停状态并记录流量。
  let gateway: EgressGateway | null = null;
  if (flags.proxy !== "") {
    gateway = await startEgressGateway(db, flags.proxy, flags.dataDir);
    console.log(`[egress] 出口网关 listening on ${gateway.addr}（worker 代理 ${gateway.proxyURL()}）`);
  }

  configureAgentEnv({ skillsDir: skillsRoot, caFile: gateway?.caFile });

  const workers = await db.platform().workers().catch(() => 3);
  const engine = new Engine(
    db,
    { ...defaultEngineConfig(), workers },
    makeModelResolver(db),
    flags.dataDir,
    gateway?.addr,
  );

  // JWT 密钥与 Go 版共用：keyDir=进程基目录（CWD），旧位置 dataDir 内存在则迁移。
  const jwtKey = loadOrCreateJWTKey(process.cwd(), flags.dataDir);
  const app = buildApp({
    version: VERSION,
    startedAt: Date.now(),
    db,
    engine,
    jwtKey,
    skillsRoot,
    dataDir: flags.dataDir,
  });

  const host = normalizeAddr(flags.addr);
  const idx = host.lastIndexOf(":");
  const listenHost = host.slice(0, idx) || "0.0.0.0";
  const listenPort = Number(host.slice(idx + 1)) || 8787;

  await app.listen({ host: listenHost, port: listenPort });
  console.log(
    `SERIES ${VERSION} (pi refactor) listening on ${listenHost}:${listenPort} (data=${flags.dataDir}, workers=${workers}, egress=${flags.proxy || "disabled"})`,
  );

  engine.startScheduler();

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] 收到 ${signal}，正在停止…`);
    await engine.shutdown();
    await gateway?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
