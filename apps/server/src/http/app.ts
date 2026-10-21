import {assertActiveRole} from '../agent/retired-roles.js';
import {registerTurnRoutes} from './routes/turns.js';
import {registerTaskFileRoutes} from "./routes/task-files.js";
import {configureEvidenceStore} from '../evidence/blobs.js';
import {registerActivityStreamShutdown} from './activity-stream.js';
import {registerRetestRoutes} from "./routes/retests.js";
import {registerConversationRoutes} from "./routes/conversations.js";
import {registerLLMManagementRoutes} from "./routes/llm-management.js";
import multipart from "@fastify/multipart";
import {registerAttachmentRoutes} from "./routes/attachments.js";
import {registerEvidenceRoutes} from "./routes/evidence.js";
// Fastify 应用：M5 HTTP API + SSE，对齐现有 Next.js 前端契约（保留模块）。
// 路由按模块拆分在 ./routes/ 下；本文件负责骨架、装饰注入、CORS 与 JWT 鉴权钩子。

import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Database } from "../db/index.js";
import type { Engine } from "../engine/engine.js";
import { requireJWT } from "./auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerExplorationRoutes } from "./routes/exploration.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerRemovedRoutes } from "./routes/removed.js";
import { registerCompatRoutes } from "./routes/compat.js";
import { registerAssetManagementRoutes } from "./routes/asset-management.js";
import { registerCategoryRoutes } from "./routes/categories.js";
import { registerSkillMgmtRoutes } from "./routes/skills-mgmt.js";
import { registerAgentConfigRoutes } from "./routes/agents-config.js";
import { registerMcpMgmtRoutes } from "./routes/mcp-mgmt.js";
import { registerCustomToolRoutes } from "./routes/custom-tools.js";
import { registerFindingsExtraRoutes } from "./routes/findings-extra.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    engine: Engine;
    skillsRoot: string;
    dataDir: string;
  }
}

export interface AppDeps {
  version: string;
  startedAt: number;
  db: Database;
  engine: Engine;
  /** HMAC 签名密钥（data/jwt.key 内容，与 Go 版共用）。 */
  jwtKey: string;
  /** skill 根目录（config.skillDir()）。 */
  skillsRoot: string;
  /** 任务数据目录（会话/工件落盘根）。 */
  dataDir: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.SERIES_LOG_LEVEL ?? "info",
      serializers:{req:(req)=>({method:req.method,url:req.url?.replace(/([?&]token=)[^&]*/g,'$1[redacted]'),host:req.headers.host,remoteAddress:req.ip})},
    },
    bodyLimit: 64 * 1024 * 1024,
  });
  registerActivityStreamShutdown(app);
  registerTurnRoutes(app);

  configureEvidenceStore(deps.db,deps.dataDir);
  app.register(multipart);
  app.decorate("db", deps.db);
  app.decorate("engine", deps.engine);
  app.decorate("skillsRoot", deps.skillsRoot);
  app.decorate("dataDir", deps.dataDir);

  // CORS：dev 下 SSE/页面直连 :8787（Go 版同样放开）；生产走同源/反代。
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;
    reply.header("Access-Control-Allow-Origin", (req.headers["origin"] as string | undefined) ?? "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Series-Token, Last-Event-ID");
    if (req.method === "OPTIONS") {
      await reply.code(204).send();
    }
  });

  // JWT 鉴权：/api/auth/*（me 除外）与 /api/health 豁免，其余 /api/* 全部要求 token。
  const guard = requireJWT(deps.jwtKey);
  app.addHook("preHandler", async (req, reply) => {
    const p = req.url.split("?")[0] ?? req.url;
    if (!p.startsWith("/api")) return;
    if (p === "/api/health") return;
    if (p.startsWith("/api/auth/") && p !== "/api/auth/me") return;
    await guard(req, reply);
  });

  app.get("/api/health", async () => ({
    status: "ok",
    version: deps.version,
    runtime: `node/${process.versions.node}`,
    uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
  }));

  // 前端静态托管（替代 Go 版 go:embed）：SERIES_STATIC_DIR 或仓库内 web/out。
  const staticDir =
    process.env.SERIES_STATIC_DIR ??
    [
      path.join(process.cwd(), "web", "out"),
      path.join(process.cwd(), "..", "..", "web", "out"),
    ].find((p) => existsSync(path.join(p, "index.html")));
  if (staticDir) {
    void app.register(fastifyStatic, { root: staticDir, prefix: "/" });
    // Next 静态导出为目录形式（<route>/index.html）：无扩展名的页面路径解析到目录索引。
    app.addHook("onRequest", async (req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api")) return;
      const p = (req.url.split("?")[0] ?? "/").split("#")[0]!;
      if (p === "/" || p.includes(".")) return;
      const rel = p.replace(/^\/+/, "");
      if (existsSync(path.join(staticDir, rel, "index.html"))) {
        return reply.sendFile(path.join(rel, "index.html"));
      }
    });
  }

  // 统一 404：API 走 JSON；页面路径回退到前端 404.html（Next 静态导出）。
  app.setNotFoundHandler((req, reply) => {
    const p = req.url.split("?")[0] ?? req.url;
    if (req.method === "GET" && !p.startsWith("/api") && staticDir) {
      return reply.code(404).sendFile("404.html");
    }
    void reply.code(404).send({ error: "not found" });
  });
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    app.log.warn({ err }, "request failed");
    void reply.code(status).send({ error: err.message });
  });

  registerAuthRoutes(app, { jwtKey: deps.jwtKey });
  registerTaskRoutes(app);
  registerExplorationRoutes(app);
  registerAssetRoutes(app);
  app.addHook('preHandler',async req=>{const key=(req.params as {key?:string})?.key;if(req.url.startsWith('/api/agents/')&&key)assertActiveRole(key);});
  registerConfigRoutes(app);
  registerEvidenceRoutes(app);
  registerRetestRoutes(app);
  registerConversationRoutes(app);
  registerAttachmentRoutes(app);
  registerTaskFileRoutes(app);
  registerLLMManagementRoutes(app);
  registerRemovedRoutes(app);
  registerCompatRoutes(app);
  registerAssetManagementRoutes(app);
  registerCategoryRoutes(app);
  registerSkillMgmtRoutes(app);
  registerAgentConfigRoutes(app);
  registerMcpMgmtRoutes(app);
  registerCustomToolRoutes(app);
  registerFindingsExtraRoutes(app);

  return app;
}
