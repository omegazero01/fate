import {PLANNER_PROMPT} from '../agent/prompts.js';
// 批次 C 集成测试：分类 CRUD+批量、skills 文件写读删+路径穿越拒绝+zip 上传、
// agents config 读写闭环、custom tool CRUD+测试执行、asset-tree 真形状、export/deepen。
// DB 共享开发库（series-ts-pg），与 api.test.ts 同构；vitest fileParallelism=false 串行。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../db/index.js";
import { Engine, defaultEngineConfig, type ModelResolver } from "../engine/engine.js";
import { buildApp } from "./app.js";
import { AUTH_PASSWORD_KEY, hashPassword } from "./auth.js";
import { registerCategoryRoutes } from "./routes/categories.js";
import { registerSkillMgmtRoutes } from "./routes/skills-mgmt.js";
import { registerAgentConfigRoutes } from "./routes/agents-config.js";
import { registerMcpMgmtRoutes } from "./routes/mcp-mgmt.js";
import { registerCustomToolRoutes } from "./routes/custom-tools.js";
import { makeFindingsAssetTreeHandler, makeFindingsExportHandler, registerFindingsExtraRoutes } from "./routes/findings-extra.js";
import { RelDerivedFrom } from "../db/exploration.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";
const JWT_KEY = "batch-c-hmac-key-0123456789abcdef012345";
const PASSWORD = "batch-c-pass-1234";

let haveDB = true;
let db: Database | null = null;
let app: FastifyInstance;
let probe: FastifyInstance;
let engine: Engine;
let dataDir: string;
let skillsRoot: string;
let token = "";
let savedPasswordHash: string | null = null;
let savedPlanner: Record<string, unknown> | null = null;

const taskIDs: number[] = [];
const expIDs: number[] = [];
const categoryIDs: number[] = [];
const companyIDs: number[] = [];
const assetIDs: number[] = [];
const findingIDs: number[] = [];
const skillUsageSkills = ["c-skill", "c-missing-skill"];
const customAgentKeys = ["batchc_agent"];

/** 抛错的模型解析器：引擎循环静默待命（与 api.test.ts 相同策略）。 */
const throwingResolver: ModelResolver = async () => {
  throw new Error("未配置激活的 LLM profile（测试桩）");
};

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
  }
  if (!haveDB) return;

  dataDir = mkdtempSync(path.join(tmpdir(), "series-batch-c-"));
  skillsRoot = path.join(dataDir, "skills");
  mkdirSync(path.join(skillsRoot, "demo-skill"), { recursive: true });
  writeFileSync(path.join(skillsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 测试用技能\n---\n# demo\n");

  savedPasswordHash = await db!.platform().getSetting(AUTH_PASSWORD_KEY);
  await db!.platform().setSetting(AUTH_PASSWORD_KEY, hashPassword(PASSWORD));
  const plannerRow = await db!.query(`SELECT * FROM agents WHERE key='planner'`);
  savedPlanner = plannerRow.rows[0] ?? null;

  engine = new Engine(db!, { ...defaultEngineConfig(), workers: 1, heartbeatMs: 60_000 }, throwingResolver, dataDir);
  app = buildApp({
    version: "test",
    startedAt: Date.now(),
    db: db!,
    engine,
    jwtKey: JWT_KEY,
    skillsRoot,
    dataDir,
  });
  // app.ts 尚未接线：本批次路由在测试里手工注册（注册必须在首次 inject/ready 之前）。

  // asset-tree/export 的处理器工厂挂到独立 probe 实例（真实路径被 compat.ts 桩占用）。
  probe = Fastify();
  probe.decorate("db", db!);
  probe.get("/api/exploration/findings/asset-tree", makeFindingsAssetTreeHandler(probe));
  probe.get("/api/exploration/findings/export", makeFindingsExportHandler(probe));

  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "SERIES", password: PASSWORD } });
  token = (login.json() as { token: string }).token;
});

afterAll(async () => {
  if (!haveDB) return;
  for (const id of taskIDs) await engine.stop(id).catch(() => undefined);
  await db!.query(`DELETE FROM findings WHERE id=ANY($1::bigint[])`, [findingIDs]).catch(() => undefined);
  for (const id of taskIDs) await db!.query(`DELETE FROM tasks WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of expIDs) await db!.query(`DELETE FROM explorations WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of categoryIDs) await db!.query(`DELETE FROM task_categories WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of companyIDs) await db!.query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => undefined);
  await db!.query(`DELETE FROM skill_usage WHERE skill=ANY($1::text[])`, [skillUsageSkills]).catch(() => undefined);
  await db!.query(`DELETE FROM agent_triggers WHERE agent_key=ANY($1::text[])`, [customAgentKeys]).catch(() => undefined);
  for (const key of customAgentKeys) await db!.query(`DELETE FROM agents WHERE key=$1`, [key]).catch(() => undefined);
  await db!.query(`DELETE FROM tools WHERE key IN ('c_echo', 'c_bad', 'c_http_probe')`).catch(() => undefined);
  await db!.query(`DELETE FROM mcp_servers WHERE name LIKE 'batch-c-placeholder-%'`).catch(() => undefined);
  if (assetIDs.length > 0) await db!.query(`DELETE FROM assets WHERE id=ANY($1::bigint[])`, [assetIDs]).catch(() => undefined);
  await db!.query(
    `DELETE FROM agent_visibility WHERE agent_id=(SELECT id FROM agents WHERE key='planner');
     DELETE FROM agent_skill_visibility WHERE agent_id=(SELECT id FROM agents WHERE key='planner')`,
  ).catch(() => undefined);
  if (savedPlanner) {
    await db!.query(
      `UPDATE agents SET max_turns=$2, run_seconds=$3, web_search=$4, llm_profile_id=$5,
         wrapup_prompt=$6, wrapup_max_turns=$7, task_timeout_wrapup_prompt=$8, task_timeout_wrapup_max_turns=$9
       WHERE key='planner'`,
      [
        savedPlanner["max_turns"], savedPlanner["run_seconds"], savedPlanner["web_search"], savedPlanner["llm_profile_id"],
        savedPlanner["wrapup_prompt"], savedPlanner["wrapup_max_turns"],
        savedPlanner["task_timeout_wrapup_prompt"], savedPlanner["task_timeout_wrapup_max_turns"],
      ],
    ).catch(() => undefined);
  }
  if (savedPasswordHash === null) {
    await db!.query(`DELETE FROM settings WHERE key=$1`, [AUTH_PASSWORD_KEY]).catch(() => undefined);
  } else {
    await db!.platform().setSetting(AUTH_PASSWORD_KEY, savedPasswordHash);
  }
  await app.close().catch(() => undefined);
  await probe.close().catch(() => undefined);
  await db?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

const authed = (method: string, url: string, payload?: Record<string, unknown> | Buffer, headers?: Record<string, string>) =>
  app.inject({
    method,
    url: url as `/api/${string}`,
    ...(payload !== undefined ? { payload } : {}),
    headers: { "X-Series-Token": token, ...headers },
  });

// ─── 测试工具：最小 zip 写入器（stored，无压缩）──────────────────────────────

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    locals.push(local, e.data);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function multipart(filename: string, data: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----batchc" + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  };
}

// ─── C1：分类 CRUD + 批量 ─────────────────────────────────────────────────────

describe.skipIf(!haveDB)("批次C：分类与批量控制", () => {
  it("CRUD + 批量移动分类 + 批量 pause/resume", async () => {
    const created = await authed("POST", "/api/task-categories", { name: "批次C分类" });
    expect(created.statusCode).toBe(201);
    const cat = created.json() as { id: number; name: string; task_count: number };
    expect(cat.name).toBe("批次C分类");
    expect(cat.task_count).toBe(0);
    categoryIDs.push(cat.id);

    const dup = await authed("POST", "/api/task-categories", { name: "批次C分类" });
    expect(dup.statusCode).toBe(409);

    const renamed = await authed("PATCH", `/api/task-categories/${cat.id}`, { name: "批次C分类-改" });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { name: string }).name).toBe("批次C分类-改");

    const list = await authed("GET", "/api/task-categories");
    const cats = (list.json() as { categories: { id: number; task_count: number }[] }).categories;
    expect(cats.some((c) => c.id === cat.id)).toBe(true);

    const taskRes = await authed("POST", "/api/tasks", { description: "批次C 分类批量测试", goal: "验证分类批量" });
    expect(taskRes.statusCode).toBe(201);
    const task = taskRes.json() as { id: string; exploration_id: number };
    taskIDs.push(Number(task.id));
    expIDs.push(task.exploration_id);

    // 批量移动进分类。
    const move = await authed("POST", "/api/tasks/category/batch", { task_ids: [task.id], category_id: cat.id });
    expect(move.statusCode).toBe(200);
    const moved = move.json() as { items: { id: string; ok: boolean }[]; category: { id: number } | null };
    expect(moved.items).toHaveLength(1);
    expect(moved.items[0]!.ok).toBe(true);
    expect(moved.category?.id).toBe(cat.id);
    const tasksList = await authed("GET", "/api/tasks");
    const row = (tasksList.json() as { tasks: { id: string; category_id?: number | null }[] }).tasks.find((t) => t.id === task.id);
    expect(row?.category_id).toBe(cat.id);

    // 批量移出分类（null）。
    const moveOut = await authed("POST", "/api/tasks/category/batch", { task_ids: [task.id], category_id: null });
    const movedOut = moveOut.json() as { items: { ok: boolean }[]; category: unknown };
    expect(movedOut.items[0]!.ok).toBe(true);
    expect(movedOut.category).toBeNull();

    // 不存在的任务 → item 级失败。
    const miss = await authed("POST", "/api/tasks/category/batch", { task_ids: ["999999999"], category_id: cat.id });
    expect((miss.json() as { items: { ok: boolean; error?: string }[] }).items[0]!.ok).toBe(false);

    // 初始化故意使用失败模型，任务已暂停；重置夹具标志以独立验证批量 pause。
    for(let i=0;i<100&&!(await db!.tasks().getTask(Number(task.id)))?.paused;i++)await new Promise(r=>setTimeout(r,20));
    expect((await db!.tasks().getTask(Number(task.id)))?.paused).toBe(true);
    await db!.query("UPDATE tasks SET paused=false WHERE id=$1",[Number(task.id)]);
    // 批量控制：pause → resume。
    const pause = await authed("POST", "/api/tasks/control/batch", { task_ids: [task.id], action: "pause" });
    expect(pause.statusCode).toBe(200);
    const pauseBody = pause.json() as { items: { id: string; ok: boolean; status?: string }[] };
    expect(pauseBody.items[0]!.ok).toBe(true);
    expect(["paused","waiting_for_executor"]).toContain(pauseBody.items[0]!.status);

    const bad = await authed("POST", "/api/tasks/control/batch", { task_ids: [task.id], action: "explode" });
    expect(bad.statusCode).toBe(400);

    const resume = await authed("POST", "/api/tasks/control/batch", { task_ids: [task.id], action: "resume" });
    const resumeBody = resume.json() as { items: { ok: boolean; status?: string }[] };
    expect(resumeBody.items[0]!.ok).toBe(true);
    // This suite deliberately has no model: failed Goals initialization must remain paused.
    expect(resumeBody.items[0]!.status).toBe("paused");

    const del = await authed("DELETE", `/api/task-categories/${cat.id}`);
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: number }).deleted).toBe(1);
    const gone = await authed("GET", "/api/task-categories");
    expect((gone.json() as { categories: { id: number }[] }).categories.some((c) => c.id === cat.id)).toBe(false);
  });
});

// ─── C2：skills 文件树 / 上传 / 用量 / 可见性 ─────────────────────────────────

describe.skipIf(!haveDB)("批次C：skills 管理", () => {
  it("创建/写读删/目录/路径穿越拒绝", async () => {
    const created = await authed("POST", "/api/skills", { name: "c-skill", description: "批次C测试技能", instructions: "# 用法\n测试" });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { name: string }).name).toBe("c-skill");

    const write = await authed("PUT", "/api/skills/c-skill/files/notes/x.md", { content: "hello batch-c" });
    expect(write.statusCode).toBe(200);
    expect((write.json() as { ok: boolean }).ok).toBe(true);

    const read = await authed("GET", "/api/skills/c-skill/files/notes/x.md");
    expect(read.statusCode).toBe(200);
    expect((read.json() as { content: string }).content).toBe("hello batch-c");

    const files = await authed("GET", "/api/skills/c-skill/files");
    expect((files.json() as { files: string[] }).files).toContain("notes/x.md");

    // 路径穿越（编码后的 ../../）必须被拒绝。
    const escape = await authed("PUT", "/api/skills/c-skill/files/..%2F..%2Fescape.txt", { content: "nope" });
    expect(escape.statusCode).toBe(400);
    const escape2 = await authed("GET", "/api/skills/c-skill/files/..%2F..%2F..%2Fetc%2Fpasswd");
    expect(escape2.statusCode).toBe(400);

    const dir = await authed("POST", "/api/skills/c-skill/dirs", { path: "assets" });
    expect(dir.statusCode).toBe(200);
    expect((dir.json() as { dir: string }).dir).toBe("assets");

    const del = await authed("DELETE", "/api/skills/c-skill/files/notes");
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: string }).deleted).toBe("notes");
    const gone = await authed("GET", "/api/skills/c-skill/files/notes/x.md");
    expect(gone.statusCode).toBe(404);
  });

  it("zip 上传安装（含穿越条目拒绝与覆盖）", async () => {
    const zip = buildZip([
      { name: "zipskill/SKILL.md", data: Buffer.from("---\nname: zipskill\ndescription: zip 安装测试\n---\n# zipskill\n") },
      { name: "zipskill/scripts/run.sh", data: Buffer.from("#!/bin/sh\necho zipskill\n") },
    ]);
    const up = await authed("POST", "/api/skills/upload", ...((() => {
      const { payload, headers } = multipart("zipskill.zip", zip);
      return [payload, headers] as const;
    })()));
    expect(up.statusCode).toBe(200);
    const body = up.json() as { name: string; files: number };
    expect(body.name).toBe("zipskill");
    expect(body.files).toBe(2);

    const files = await authed("GET", "/api/skills/zipskill/files");
    const list = (files.json() as { files: string[] }).files;
    expect(list).toContain("SKILL.md");
    expect(list).toContain("scripts/run.sh");
    const readBack = await authed("GET", "/api/skills/zipskill/files/SKILL.md");
    expect((readBack.json() as { content: string }).content).toContain("zip 安装测试");

    // 已存在且未 overwrite → 409；overwrite → 重新写入。
    const again = await authed("POST", "/api/skills/upload", ...((() => {
      const { payload, headers } = multipart("zipskill.zip", zip);
      return [payload, headers] as const;
    })()));
    expect(again.statusCode).toBe(409);
    const overwrite = await authed("POST", "/api/skills/upload?overwrite=true", ...((() => {
      const { payload, headers } = multipart("zipskill.zip", zip);
      return [payload, headers] as const;
    })()));
    expect(overwrite.statusCode).toBe(200);

    // 条目路径穿越 → 400。
    const evil = buildZip([
      { name: "evilskill/SKILL.md", data: Buffer.from("---\nname: evilskill\n---\n") },
      { name: "evilskill/../../escape.txt", data: Buffer.from("nope") },
    ]);
    const upEvil = await authed("POST", "/api/skills/upload", ...((() => {
      const { payload, headers } = multipart("evilskill.zip", evil);
      return [payload, headers] as const;
    })()));
    expect(upEvil.statusCode).toBe(400);
    expect((upEvil.json() as { error: string }).error).toContain("路径非法");

    // 根级 SKILL.md（无顶层目录）：skill 名取 zip 文件名。
    const flat = buildZip([{ name: "SKILL.md", data: Buffer.from("---\nname: flatskill\n---\n") }]);
    const upFlat = await authed("POST", "/api/skills/upload", ...((() => {
      const { payload, headers } = multipart("flatskill.zip", flat);
      return [payload, headers] as const;
    })()));
    expect(upFlat.statusCode).toBe(200);
    expect((upFlat.json() as { name: string }).name).toBe("flatskill");

    // meta 更新。
    const meta = await authed("PUT", "/api/skills/zipskill/meta", { description: "改过的描述" });
    expect(meta.statusCode).toBe(200);
    const md = await authed("GET", "/api/skills/zipskill/files/SKILL.md");
    expect((md.json() as { content: string }).content).toContain("改过的描述");
  });

  it("用量 / 缺口 / 可见性", async () => {
    await db!.query(
      `INSERT INTO skill_usage(skill, agent_key, task_id, session_id, args_len, found) VALUES
         ('c-skill','worker',NULL,'s1',10,true),
         ('c-skill','planner',NULL,'s2',20,true),
         ('c-missing-skill','worker',NULL,'s3',5,false)`,
    );
    const usage = await authed("GET", "/api/skills/c-skill/usage?limit=10");
    expect(usage.statusCode).toBe(200);
    const calls = (usage.json() as { calls: { agent_key: string; task_id: number }[] }).calls;
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.agent_key === "worker")).toBe(true);

    const missing = await authed("GET", "/api/skills/missing");
    const missList = (missing.json() as { missing: { skill: string; calls: number; agents: string[] }[] }).missing;
    const miss = missList.find((m) => m.skill === "c-missing-skill");
    expect(miss).toBeDefined();
    expect(miss!.calls).toBe(1);
    expect(miss!.agents).toContain("worker");
    // 已存在的 skill 不算缺口。
    expect(missList.some((m) => m.skill === "c-skill")).toBe(false);

    // 可见性：skill 按名 + agent 视角整组替换 + mcp 资源 toggle。
    const mcpRow = await db!.query<{ id: string }>(`SELECT id FROM mcp_servers ORDER BY id LIMIT 1`);
    const mcpID = Number(mcpRow.rows[0]!.id);

    const visPut = await authed("PUT", "/api/agents/planner/visibility", { mcp: [mcpID], skill: ["c-skill"] });
    expect(visPut.statusCode).toBe(200);
    const visGet = await authed("GET", "/api/agents/planner/visibility");
    const vis = visGet.json() as { mcp: number[]; skill: string[] };
    expect(vis.mcp).toContain(mcpID);
    expect(vis.skill).toContain("c-skill");

    const bySkill = await authed("GET", "/api/visibility/skill/c-skill");
    expect((bySkill.json() as { agents: string[] }).agents).toContain("planner");
    const byRes = await authed("GET", `/api/visibility/mcp/${mcpID}`);
    expect((byRes.json() as { agents: string[] }).agents).toContain("planner");

    const toggle = await authed("POST", "/api/visibility/toggle", { agent_id: "planner", kind: "mcp", resource_id: mcpID, visible: false });
    expect(toggle.statusCode).toBe(200);
    const byRes2 = await authed("GET", `/api/visibility/mcp/${mcpID}`);
    expect((byRes2.json() as { agents: string[] }).agents).not.toContain("planner");

    const unknown = await authed("GET", "/api/agents/no_such_agent/visibility");
    expect(unknown.statusCode).toBe(404);
  });
});

// ─── C3：agent 配置读写闭环 ───────────────────────────────────────────────────

describe.skipIf(!haveDB)("批次C：agent 配置", () => {
  it("config/wrapup/task-timeout 写读闭环", async () => {
    const cfg = await authed("PUT", "/api/agents/planner/config", { max_turns: 12, run_seconds: 300, web_search: true, llm_profile_id: null });
    expect(cfg.statusCode).toBe(200);
    expect((cfg.json() as { ok: boolean }).ok).toBe(true);
    const row = await db!.query(`SELECT max_turns, run_seconds, web_search FROM agents WHERE key='planner'`);
    expect(Number(row.rows[0]!["max_turns"])).toBe(12);
    expect(Number(row.rows[0]!["run_seconds"])).toBe(300);
    expect(row.rows[0]!["web_search"]).toBe(true);

    const badProfile = await authed("PUT", "/api/agents/planner/config", { llm_profile_id: 99999999 });
    expect(badProfile.statusCode).toBe(400);
    const badMode = await authed("PUT", "/api/agents/planner/config", { trigger_run_mode: "fast" });
    expect(badMode.statusCode).toBe(400);
    const missing = await authed("PUT", "/api/agents/no_such_agent/config", { max_turns: 1 });
    expect(missing.statusCode).toBe(404);

    const wrap = await authed("PUT", "/api/agents/planner/wrapup", { prompt: "收尾词测试", max_turns: 2 });
    expect(wrap.statusCode).toBe(200);
    const wrow = await db!.query(`SELECT wrapup_prompt, wrapup_max_turns FROM agents WHERE key='planner'`);
    expect(String(wrow.rows[0]!["wrapup_prompt"])).toBe("收尾词测试");
    expect(Number(wrow.rows[0]!["wrapup_max_turns"])).toBe(2);
    const wrapReset = await authed("POST", "/api/agents/planner/wrapup/reset", {});
    expect(wrapReset.statusCode).toBe(200);
    const resetBody = wrapReset.json() as { ok: boolean; wrapup_default: string; wrapup_max_turns_default: number };
    expect(resetBody.ok).toBe(true);
    expect(resetBody.wrapup_default.length).toBeGreaterThan(0);
    const wrow2 = await db!.query(`SELECT wrapup_prompt FROM agents WHERE key='planner'`);
    expect(String(wrow2.rows[0]!["wrapup_prompt"])).toBe("");

    const tt = await authed("PUT", "/api/agents/planner/wrapup/task-timeout", { prompt: "超时收尾", max_turns: 3 });
    expect(tt.statusCode).toBe(200);
    const trow = await db!.query(`SELECT task_timeout_wrapup_prompt FROM agents WHERE key='planner'`);
    expect(String(trow.rows[0]!["task_timeout_wrapup_prompt"])).toBe("超时收尾");
    const ttReset = await authed("POST", "/api/agents/planner/wrapup/task-timeout/reset", {});
    const ttBody = ttReset.json() as { task_timeout_wrapup_default: string };
    expect(ttBody.task_timeout_wrapup_default.length).toBeGreaterThan(0);
  });

  it("prompt reset / preview / triggers", async () => {
    const reset = await authed("POST", "/api/agents/planner/prompt/reset", {});
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { version: number }).version).toBeGreaterThan(0);
    const current = await db!.query<{ template_text: string }>(
      `SELECT p.template_text FROM agents a JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='planner'`,
    );
    expect(current.rows[0]!.template_text).toBe(PLANNER_PROMPT);

    const preview = await authed("POST", "/api/agents/planner/prompt/preview", {
      template: "目标：{{Goal}} / {{.Goal}}；时间 {{Now}}；未知 {{Unknown}}",
      sample: { Goal: "拿下 example.com" },
    });
    expect(preview.statusCode).toBe(200);
    const rendered = (preview.json() as { rendered: string }).rendered;
    expect(rendered).toContain("拿下 example.com");
    expect(rendered).not.toContain("{{Goal}}");
    expect(rendered).not.toContain("{{Now}}");
    expect(rendered).toContain("{{Unknown}}"); // 未知变量保留

    // 触发器（用自定义 agent）。
    const agent = await authed("POST", "/api/agents", { key: customAgentKeys[0], name: "批次C触发器" });
    expect(agent.statusCode).toBe(201);
    const created = await authed("POST", `/api/agents/${customAgentKeys[0]}/triggers`, {
      interval_sec: 60,
      interval_message: "定时消息",
      on_finding: true,
      finding_message: "发现消息",
      tool_names: ["bash", "read"],
    });
    expect(created.statusCode).toBe(201);
    const trig = created.json() as { id: number; tool_names: string[]; interval_sec: number };
    expect(trig.tool_names).toEqual(["bash", "read"]);
    expect(trig.interval_sec).toBe(60);

    const list = await authed("GET", `/api/agents/${customAgentKeys[0]}/triggers`);
    expect((list.json() as { triggers: { id: number }[] }).triggers.some((t) => t.id === trig.id)).toBe(true);

    const patched = await authed("PATCH", `/api/triggers/${trig.id}`, { enabled: false, tool_names: ["bash"] });
    expect(patched.statusCode).toBe(200);
    const prow = await db!.query(`SELECT enabled, tool_names FROM agent_triggers WHERE id=$1`, [trig.id]);
    expect(prow.rows[0]!["enabled"]).toBe(false);
    expect(String(prow.rows[0]!["tool_names"])).toBe("bash");

    const removed = await authed("DELETE", `/api/triggers/${trig.id}`);
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { deleted: number }).deleted).toBe(trig.id);
    const del404 = await authed("DELETE", `/api/triggers/${trig.id}`);
    expect(del404.statusCode).toBe(404);
  });
});

// ─── C4：MCP 缓存读取（refresh 连接失败容错）────────────────────────────────

describe.skipIf(!haveDB)("批次C：MCP 管理面", () => {
  it("tools 缓存读取 + refresh 失败返回 200 {tools:[],error}", async () => {
    const mcpRow = await db!.query<{ id: string }>(`SELECT id FROM mcp_servers ORDER BY id LIMIT 1`);
    const id = Number(mcpRow.rows[0]!.id);

    await db!.query(`DELETE FROM mcp_tools_cache WHERE server_id=$1`, [id]);
    const empty = await authed("GET", `/api/mcp/${id}/tools`);
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { tools: unknown[] }).tools).toEqual([]);

    await db!.query(
      `INSERT INTO mcp_tools_cache(server_id, tool_name, description) VALUES ($1,'probe_tool','探测工具') ON CONFLICT DO NOTHING`,
      [id],
    );
    const cached = await authed("GET", `/api/mcp/${id}/tools`);
    const tools = (cached.json() as { tools: { name: string; description: string }[] }).tools;
    expect(tools.some((t) => t.name === "probe_tool")).toBe(true);
    await db!.query(`DELETE FROM mcp_tools_cache WHERE server_id=$1 AND tool_name='probe_tool'`, [id]);

    // 对不存在的 server → 404；refresh 连接失败（无 url/command 的占位行）→ 200 + error。
    const missing = await authed("GET", "/api/mcp/999999999/tools");
    expect(missing.statusCode).toBe(404);
    const placeholder = await db!.query<{ id: string }>(
      `INSERT INTO mcp_servers(name, transport, url, enabled) VALUES ($1,'http',NULL,false) RETURNING id`,
      [`batch-c-placeholder-${Date.now().toString(36)}`],
    );
    const phID = Number(placeholder.rows[0]!.id);
    try {
      const refresh = await authed("POST", `/api/mcp/${phID}/refresh`, {});
      expect(refresh.statusCode).toBe(200);
      const refreshBody = refresh.json() as { tools: unknown[]; error?: string };
      expect(refreshBody.tools).toEqual([]);
      expect(typeof refreshBody.error).toBe("string");
      expect(refreshBody.error!.length).toBeGreaterThan(0);

      const test = await authed("GET", `/api/mcp/${phID}/test`);
      expect(test.statusCode).toBe(200);
      const testBody = test.json() as { ok: boolean; error?: string; latency_ms?: number };
      expect(testBody.ok).toBe(false);
      expect(testBody.error).toContain("url");

      const usage = await authed("GET", `/api/mcp/${phID}/usage`);
      expect(usage.statusCode).toBe(200);
      expect((usage.json() as { stats: unknown[]; calls: unknown[] }).stats).toEqual([]);
    } finally {
      await db!.query(`DELETE FROM mcp_tools_cache WHERE server_id=$1`, [phID]);
      await db!.query(`DELETE FROM mcp_servers WHERE id=$1`, [phID]);
    }
  });
});

// ─── C5：自定义工具 ───────────────────────────────────────────────────────────

describe.skipIf(!haveDB)("批次C：自定义工具", () => {
  it("CRUD + 测试执行", async () => {
    const created = await authed("POST", "/api/tools/custom", {
      key: "c_echo",
      description: "批次C回显工具",
      kind: "command",
      exec: { command: "echo" },
      agents: ["worker"],
      enabled: true,
      schema: { type: "object", properties: {} },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { key: string }).key).toBe("c_echo");

    const dup = await authed("POST", "/api/tools/custom", { key: "c_echo", kind: "command" });
    expect(dup.statusCode).toBe(409);
    const badKind = await authed("POST", "/api/tools/custom", { key: "c_bad", kind: "builtin" });
    expect(badKind.statusCode).toBe(400);

    const updated = await authed("PUT", "/api/tools/custom/c_echo", { description: "批次C回显v2", kind: "command", exec: { command: "echo" }, agents: ["worker"], enabled: false });
    expect(updated.statusCode).toBe(200);
    const row = await db!.query(`SELECT system, kind, exec, description, enabled FROM tools WHERE key='c_echo'`);
    expect(row.rows[0]!["system"]).toBe(false);
    expect(String(row.rows[0]!["kind"])).toBe("command");
    expect(String(row.rows[0]!["description"])).toBe("批次C回显v2");
    expect(row.rows[0]!["enabled"]).toBe(false);
    expect((row.rows[0]!["exec"] as Record<string, unknown>)["command"]).toBe("echo");

    const builtinGuard = await authed("PUT", "/api/tools/custom/bash", { kind: "command" });
    expect(builtinGuard.statusCode).toBe(400);

    const run = await authed("POST", "/api/tools/custom/test", { kind: "command", exec: { command: "echo", args: ["batch-c-工具测试"] }, action: "run" });
    expect(run.statusCode).toBe(200);
    const runBody = run.json() as { output: string; is_error: boolean; duration_ms?: number };
    expect(runBody.is_error).toBe(false);
    expect(runBody.output).toContain("batch-c-工具测试");
    expect(typeof runBody.duration_ms).toBe("number");

    const check = await authed("POST", "/api/tools/custom/test", { kind: "command", exec: { command: "echo hi" }, action: "check" });
    expect((check.json() as { is_error: boolean; output: string }).is_error).toBe(false);
    expect((check.json() as { output: string }).output).toContain("echo hi");

    const deferredKind = await authed("POST", "/api/tools/custom/test", { kind: "script", exec: {} });
    const dBody = deferredKind.json() as { output: string; is_error: boolean };
    expect(dBody.is_error).toBe(false);
    expect(dBody.output).toContain("执行侧延后");

    const removed = await authed("DELETE", "/api/tools/custom/c_echo");
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { deleted: string }).deleted).toBe("c_echo");
    const gone = await authed("DELETE", "/api/tools/custom/c_echo");
    expect(gone.statusCode).toBe(404);
  });
});

// ─── C6：asset-tree 真形状 + export + deepen ─────────────────────────────────

describe.skipIf(!haveDB)("批次C：发现页增强", () => {
  let taskID = 0;
  let expID = 0;
  let companyID = 0;
  let rootAssetID = 0;
  let subAssetID = 0;
  let findingHighNode = 0;
  let findingLowNode = 0;
  let findingNoneNode = 0;
  let findingHighID = 0;
  let findingLowID = 0;
  let findingNoneID = 0;
  let synthDomain = "";

  beforeAll(async () => {
    const runTag = Date.now().toString(36);
    const baseDomain = `batchc-${runTag}.test`;
    const company = await db!.query<{ id: string }>(
      `INSERT INTO companies(name, nkey) VALUES ($1,$2) RETURNING id`,
      [`批次C公司-${runTag}`, `batchc-co-${runTag}`],
    );
    companyID = Number(company.rows[0]!.id);
    companyIDs.push(companyID);

    const taskRes = await authed("POST", "/api/tasks", { description: "批次C发现页测试", goal: "asset-tree" });
    const task = taskRes.json() as { id: string; exploration_id: number };
    taskID = Number(task.id);
    expID = task.exploration_id;
    taskIDs.push(taskID);
    expIDs.push(expID);
    synthDomain = `batchc2-${runTag}.test`;

    const rootAsset = await db!.query<{ id: string }>(
      `INSERT INTO assets(type, company_id, domain) VALUES ('root_domain', $1, $2) RETURNING id`,
      [companyID, baseDomain],
    );
    rootAssetID = Number(rootAsset.rows[0]!.id);
    const subAsset = await db!.query<{ id: string }>(
      `INSERT INTO assets(type, company_id, domain, root_domain) VALUES ('subdomain', $1, $2, $3) RETURNING id`,
      [companyID, `app.${baseDomain}`, baseDomain],
    );
    subAssetID = Number(subAsset.rows[0]!.id);
    assetIDs.push(rootAssetID, subAssetID);

    const mkNode = async (): Promise<number> => {
      const n = await db!.query<{ id: string }>(
        `INSERT INTO exploration_nodes(exploration_id, kind, payload, state) VALUES ($1,'finding','{}','confirmed') RETURNING id`,
        [expID],
      );
      return Number(n.rows[0]!.id);
    };
    findingHighNode = await mkNode();
    findingLowNode = await mkNode();
    findingNoneNode = await mkNode();

    const mkFinding = async (nodeID: number, severity: string, assetIDs_: number[], summary: string): Promise<number> => {
      const f = await db!.query<{ id: string }>(
        `INSERT INTO findings(task_id, node_id, vulnclass, name, severity, summary, asset_ids)
         VALUES ($1,$2,'rce','RCE 漏洞',$3,$4,$5::jsonb) RETURNING id`,
        [taskID, nodeID, severity, summary, JSON.stringify(assetIDs_)],
      );
      const id = Number(f.rows[0]!.id);
      findingIDs.push(id);
      return id;
    };
    findingHighID = await mkFinding(findingHighNode, "high", [subAssetID], "子域上的 RCE");
    findingLowID = await mkFinding(findingLowNode, "low", [rootAssetID, subAssetID], "根域与子域同时命中, 含逗号");
    findingNoneID = await mkFinding(findingNoneNode, "medium", [], "无资产关联");
  });

  it("asset-tree：公司→根域→资产 + __none__，聚合去重", async () => {
    const res = await probe.inject({ method: "GET", url: `/api/exploration/findings/asset-tree?task_id=${taskID}` });
    expect(res.statusCode).toBe(200);
    const tree = res.json() as {
      nodes: {
        key: string; parent?: string; kind: string; label: string; asset_id?: number; company_id?: number;
        self: number; total: number; critical: number; high: number; medium: number; low: number; last_found_at: string;
      }[];
      finding_total: number; truncated: boolean;
    };
    expect(tree.truncated).toBe(false);
    expect(tree.finding_total).toBeGreaterThanOrEqual(3);

    const byKey = new Map(tree.nodes.map((n) => [n.key, n]));
    const companyNode = byKey.get(`c:${companyID}`);
    expect(companyNode).toBeDefined();
    expect(companyNode!.kind).toBe("company");
    expect(companyNode!.total).toBe(2); // 两条有资产 finding（去重后）

    // 根域资产被 finding 引用 → 根节点就是 a:<rootAssetID>。
    const rootNode = byKey.get(`a:${rootAssetID}`);
    expect(rootNode).toBeDefined();
    expect(rootNode!.kind).toBe("root_domain");
    expect(rootNode!.self).toBe(1); // 直接挂根域的 finding（low）
    expect(rootNode!.total).toBe(2); // + 子域 high（low 同时挂两资产不重复计）
    expect(rootNode!.low).toBe(1);
    expect(rootNode!.high).toBe(1);
    expect(rootNode!.parent).toBe(`c:${companyID}`);

    const subNode = byKey.get(`a:${subAssetID}`);
    expect(subNode).toBeDefined();
    expect(subNode!.kind).toBe("subdomain");
    expect(subNode!.self).toBe(2); // high + low 都列了子域
    expect(subNode!.total).toBe(2);
    expect(subNode!.parent).toBe(`a:${rootAssetID}`);

    const noneNode = byKey.get("__none__");
    expect(noneNode).toBeDefined();
    expect(noneNode!.kind).toBe("none");
    expect(noneNode!.self).toBe(1);
    expect(noneNode!.medium).toBe(1);
  });

  it("asset-tree：severity 筛选 + 未引用根域的合成节点", async () => {
    // 只看 high：树只剩子域 + 根域 + 公司（self 计数相应变化）。
    const res = await probe.inject({ method: "GET", url: `/api/exploration/findings/asset-tree?severity=high&task_id=${taskID}` });
    const tree = res.json() as { nodes: { key: string; total: number; self: number }[]; finding_total: number };
    const byKey = new Map(tree.nodes.map((n) => [n.key, n]));
    expect(tree.finding_total).toBeGreaterThanOrEqual(1);
    const subHi = byKey.get(`a:${subAssetID}`)!;
    expect(subHi).toBeDefined();
    expect(subHi.self).toBe(1);
    // high 过滤下根域资产未被引用 → 父节点是合成的 r:<domain>（kind 仍是 root_domain，self=0）。
    const subHiParent = byKey.get(subHi.parent ?? "")!;
    expect(subHiParent).toBeDefined();
    expect(subHiParent.kind).toBe("root_domain");
    expect(subHiParent.self).toBe(0);

    // 合成根域节点：subdomain 的 root_domain 无资产行时 → r:<domain>。
    const synth = await db!.query<{ id: string }>(
      `INSERT INTO assets(type, domain, root_domain) VALUES ('subdomain', $1, $2) RETURNING id`,
      [`orphan.${synthDomain}`, synthDomain],
    );
    const synthID = Number(synth.rows[0]!.id);
    assetIDs.push(synthID);
    const node = await db!.query<{ id: string }>(
      `INSERT INTO exploration_nodes(exploration_id, kind, payload, state) VALUES ($1,'finding','{}','confirmed') RETURNING id`,
      [expID],
    );
    const f = await db!.query<{ id: string }>(
      `INSERT INTO findings(task_id, node_id, vulnclass, severity, summary, asset_ids)
       VALUES ($1,$2,'info','low','孤立子域',$3::jsonb) RETURNING id`,
      [taskID, Number(node.rows[0]!.id), JSON.stringify([synthID])],
    );
    findingIDs.push(Number(f.rows[0]!.id));
    const res2 = await probe.inject({ method: "GET", url: `/api/exploration/findings/asset-tree?q=孤立子域&task_id=${taskID}` });
    const tree2 = res2.json() as { nodes: { key: string; kind: string; parent?: string }[] };
    const byKey2 = new Map(tree2.nodes.map((n) => [n.key, n]));
    expect(byKey2.get(`r:${synthDomain}`)).toBeDefined();
    expect(byKey2.get(`r:${synthDomain}`)!.kind).toBe("root_domain");
    expect(byKey2.get(`a:${synthID}`)!.parent).toBe(`r:${synthDomain}`);
  });

  it("export：md/csv + 筛选 + selected", async () => {
    const csv = await probe.inject({ method: "GET", url: "/api/exploration/findings/export?format=csv&scope=all" });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("findings-export-");
    const csvText = csv.body as string;
    expect(csvText.split(/\r?\n/)[0]).toBe("id,name,vulnclass,severity,status,task_id,created_at,summary");
    expect(csvText).toContain('"根域与子域同时命中, 含逗号"'); // 逗号转义

    const md = await probe.inject({ method: "GET", url: `/api/exploration/findings/export?format=md&scope=filtered&severity=high` });
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body as string).toContain("子域上的 RCE");
    expect(md.body as string).not.toContain("根域与子域同时命中");

    const selected = await probe.inject({
      method: "GET",
      url: `/api/exploration/findings/export?format=csv&scope=selected&ids=${findingNoneID}`,
    });
    expect(selected.statusCode).toBe(200);
    const selText = selected.body as string;
    expect(selText).toContain("无资产关联");
    expect(selText).not.toContain("子域上的 RCE");

    const badScope = await probe.inject({ method: "GET", url: "/api/exploration/findings/export?format=csv&scope=selected" });
    expect(badScope.statusCode).toBe(400);
    const badFormat = await probe.inject({ method: "GET", url: "/api/exploration/findings/export?format=pdf" });
    expect(badFormat.statusCode).toBe(400);
  });

  it("deepen：以 finding 为 parent 派高优意图并连边", async () => {
    const res = await authed("POST", `/api/exploration/findings/${findingHighNode}/deepen`, { description: "验证 RCE 利用链" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task_id: string; intent_id: string; state: string; queued: boolean };
    expect(body.task_id).toBe(String(taskID));
    const intentID = Number(body.intent_id);
    expect(Number.isInteger(intentID)).toBe(true);
    expect(["open", "running", "paused"]).toContain(body.state);

    const node = await db!.query(`SELECT kind, priority, state, payload FROM exploration_nodes WHERE id=$1`, [intentID]);
    expect(node.rows[0]!["kind"]).toBe("intent");
    expect(Number(node.rows[0]!["priority"])).toBe(8);
    const payload = node.rows[0]!["payload"] as Record<string, unknown>;
    expect(String(payload["summary"])).toContain("验证 RCE 利用链");
    expect(String(payload["summary"])).toContain(`finding #${findingHighID}`);
    expect(Number(payload["parent_id"])).toBe(findingHighNode);

    const edge = await db!.query(
      `SELECT 1 FROM exploration_edges WHERE exploration_id=$1 AND src_id=$2 AND rel=$3 AND dst_id=$4`,
      [expID, findingHighNode, RelDerivedFrom, intentID],
    );
    expect(edge.rows).toHaveLength(1);

    const empty = await authed("POST", `/api/exploration/findings/${findingHighNode}/deepen`, { description: "  " });
    expect(empty.statusCode).toBe(400);
    const missing = await authed("POST", "/api/exploration/findings/999999999/deepen", { description: "x" });
    expect(missing.statusCode).toBe(404);
  });
});
