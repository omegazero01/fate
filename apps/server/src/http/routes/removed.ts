// 已删除模块的显式 404：前端仍在调用、但模块已随重构移除的端点统一回应
// {error:"模块已在重构中移除"}，供前端 M7 剪除调用点时识别。
// 未在此列且未实现的端点走 app 级 notFound（{error:"not found"}）。

import type { FastifyInstance } from "fastify";

const REMOVED_MODULE = { error: "模块已在重构中移除" };

const REMOVED_PATHS = [
  // traffic（流量证据库）
  // ScopeSentry 资产同步
  "/api/sync/*",
  // 一键自更新
  "/api/update",
  "/api/update/*",
  // 任务归档 / 任务模板
  "/api/task-archives",
  "/api/task-archives/*",
  "/api/task-templates",
  "/api/task-templates/*",
  // 侧问（side questions）
  "/api/side-questions",
  "/api/side-questions/*",
  // findings 复测（retests）
  // 任务通知聚合
  "/api/tasks/notifications",
];

export function registerRemovedRoutes(app: FastifyInstance): void {
  for (const p of REMOVED_PATHS) {
    app.all(p, async (_req, reply) => {
      return reply.code(404).send(REMOVED_MODULE);
    });
  }
}
