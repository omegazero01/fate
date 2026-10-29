// 批次 C1：任务分类 CRUD + 批量移动分类 + 批量生命周期控制。
// 对齐前端 web/src/lib/api.ts 的 taskCategories/createTaskCategory/renameTaskCategory/
// deleteTaskCategory/updateTasksCategory/controlTasksBatch 方法族。
// 单任务 PATCH /api/tasks/:id/category 已由 routes/compat.ts 提供，此处不重复注册。
// 生命周期写法参照 routes/tasks.ts（DB 先落库 → 引擎调用 no-op 容错），但不改那个文件。

import type { FastifyInstance } from "fastify";

interface CategoryRow {
  id: number;
  name: string;
  task_count: number;
  created_at: string;
  updated_at: string;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? "");
}

/** nkey 归一化：去空白 + 小写（schema.sql task_categories.nkey UNIQUE）。 */
function nkeyOf(name: string): string {
  return name.trim().toLowerCase();
}

export function registerCategoryRoutes(app: FastifyInstance): void {
  const db = () => app.db;

  const listCategories = async (): Promise<CategoryRow[]> => {
    const res = await db().query(
      `SELECT c.id, c.name, c.created_at, c.updated_at,
              (SELECT count(*) FROM tasks t WHERE t.category_id=c.id AND t.deleted_at IS NULL) AS task_count
       FROM task_categories c ORDER BY c.id`,
    );
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      name: String(r["name"]),
      task_count: Number(r["task_count"] ?? 0),
      created_at: iso(r["created_at"]),
      updated_at: iso(r["updated_at"]),
    }));
  };

  async function categoryByID(id: number): Promise<CategoryRow | null> {
    const res = await db().query(
      `SELECT c.id, c.name, c.created_at, c.updated_at,
              (SELECT count(*) FROM tasks t WHERE t.category_id=c.id AND t.deleted_at IS NULL) AS task_count
       FROM task_categories c WHERE c.id=$1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: Number(r["id"]),
      name: String(r["name"]),
      task_count: Number(r["task_count"] ?? 0),
      created_at: iso(r["created_at"]),
      updated_at: iso(r["updated_at"]),
    };
  }

  // ─── 分类 CRUD ─────────────────────────────────────────────────────────────

  app.get("/api/task-categories", async () => ({ categories: await listCategories() }));

  app.post("/api/task-categories", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b["name"] === "string" ? b["name"].trim() : "";
    if (name === "") return reply.code(400).send({ error: "name 不能为空" });
    const dup = await db().query<{ id: string }>(`SELECT id FROM task_categories WHERE nkey=$1`, [nkeyOf(name)]);
    if (dup.rows.length > 0) return reply.code(409).send({ error: `分类「${name}」已存在` });
    const res = await db().query<{ id: string }>(
      `INSERT INTO task_categories(name, nkey) VALUES ($1, $2) RETURNING id`,
      [name, nkeyOf(name)],
    );
    const row = await categoryByID(Number(res.rows[0]!.id));
    return reply.code(201).send(row);
  });

  app.patch("/api/task-categories/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b["name"] === "string" ? b["name"].trim() : "";
    if (name === "") return reply.code(400).send({ error: "name 不能为空" });
    const dup = await db().query<{ id: string }>(
      `SELECT id FROM task_categories WHERE nkey=$1 AND id<>$2`,
      [nkeyOf(name), id],
    );
    if (dup.rows.length > 0) return reply.code(409).send({ error: `分类「${name}」已存在` });
    const res = await db().query(`UPDATE task_categories SET name=$2 WHERE id=$1`, [id, name]);
    if ((res.rowCount ?? 0) === 0) return reply.code(404).send({ error: "分类不存在" });
    return categoryByID(id);
  });

  app.delete("/api/task-categories/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    // tasks.category_id ON DELETE SET NULL：任务自动回到未分类桶。
    const res = await db().query(`DELETE FROM task_categories WHERE id=$1`, [id]);
    if ((res.rowCount ?? 0) === 0) return reply.code(404).send({ error: "分类不存在" });
    return { deleted: Number(res.rowCount ?? 0) };
  });

  // ─── 批量移动任务分类 ───────────────────────────────────────────────────────

  app.post("/api/tasks/category/batch", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const taskIDs = Array.isArray(b["task_ids"]) ? [...new Set(b["task_ids"].map((v) => Number(v)))] : [];
    if (taskIDs.length === 0) return reply.code(400).send({ error: "task_ids 不能为空" });
    if (taskIDs.some((n) => !Number.isInteger(n) || n <= 0)) return reply.code(400).send({ error: "task_ids 含非法 id" });
    const rawCategory = b["category_id"];
    const categoryID = rawCategory === null || rawCategory === undefined || rawCategory === "" ? null : Number(rawCategory);
    if (categoryID !== null && (!Number.isInteger(categoryID) || categoryID <= 0)) {
      return reply.code(400).send({ error: "category_id 非法" });
    }
    let category: CategoryRow | null = null;
    if (categoryID !== null) {
      category = await categoryByID(categoryID);
      if (!category) return reply.code(404).send({ error: "分类不存在" });
    }
    const items: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of taskIDs) {
      const res = await db().query(`UPDATE tasks SET category_id=$2 WHERE id=$1 AND deleted_at IS NULL`, [id, categoryID]);
      if ((res.rowCount ?? 0) > 0) items.push({ id: String(id), ok: true });
      else items.push({ id: String(id), ok: false, error: "任务不存在" });
    }
    return { items, category };
  });

  // ─── 批量生命周期控制（pause/resume/stop|finish）───────────────────────────

  /** 引擎调用容错：任务不在引擎运行时（mustRt 抛错）→ no-op，DB 状态仍是唯一真源。 */
  async function engineNoop(p: Promise<unknown>): Promise<void> {
    await p.catch(() => undefined);
  }

  async function controlOne(id: number, action: string): Promise<{ ok: boolean; status?: string; queued?: boolean; command_id?: number; error?: string }> {
    try {
      if (action === "pause") {
        await app.db.control().tasks().applyTaskPause(id); // 终态/已暂停 → 409 语义错误
        const pause=await app.engine.pause(id);
        return { ok: true, status: pause.status, command_id: pause.command_id };
      }
      if (action === "resume") {
        const res = await app.db.query<{ status: string }>(
          `UPDATE tasks SET paused=false,
             status=CASE WHEN status IN ('done','failed','timeout') THEN status ELSE 'running' END
           WHERE id=$1 AND deleted_at IS NULL RETURNING status`,
          [id],
        );
        if (res.rows.length === 0) return { ok: false, error: "任务不存在" };
        // 引擎未装载该任务时 resume 内部会先 run（重新装载），与 tasks.ts 的单任务语义一致。
        await engineNoop(app.engine.resume(id));
        const after=await app.db.tasks().getTask(id);
        return { ok: true, status: after?.paused?"paused":after?.queued?"queued":after?.status,queued:after?.queued===true };
      }
      // stop / finish：停引擎 + 手动收官（全部目标已证明 → done，否则 failed）。
      const task = await app.db.tasks().getTask(id);
      if (!task) return { ok: false, error: "任务不存在" };
      await engineNoop(app.engine.stop(id));
      const counts = await app.db.exploration(task.exploration_id).executionCounts().catch(() => ({ running: 0, goals: 0, met: 0 }));
      const status = counts.goals > 0 && counts.met >= counts.goals ? "done" : "failed";
      await app.db.tasks().setTaskStatusGuarded(id, status);
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  app.post("/api/tasks/control/batch", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const action = String(b["action"] ?? "");
    if (action !== "pause" && action !== "resume" && action !== "stop" && action !== "finish") {
      return reply.code(400).send({ error: "action must be pause|resume|stop|finish" });
    }
    const taskIDs = Array.isArray(b["task_ids"]) ? [...new Set(b["task_ids"].map((v) => Number(v)))] : [];
    if (taskIDs.length === 0) return reply.code(400).send({ error: "task_ids 不能为空" });
    if (taskIDs.some((n) => !Number.isInteger(n) || n <= 0)) return reply.code(400).send({ error: "task_ids 含非法 id" });
    const items = [];
    for (const id of taskIDs) {
      const r = await controlOne(id, action === "finish" ? "stop" : action);
      items.push({ id: String(id), ...r });
    }
    return { items };
  });
}
