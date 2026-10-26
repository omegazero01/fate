// API 补齐批次 A 集成测试：主对话链（/api/chat 别名 + engine 桩）、SSE task→expID
// 换算（真监听口读流，断言回放行来自任务的 exploration）、mentions/asset-refs/
// intent-assets、PUT /tasks/:id/llm、/api/assets 任务过滤、activity/search、
// main-sessions、tokens 形状，以及 /api/llm/models（deepseek 真打一次）与
// /api/llm/test 的 profile_id 字段形状。DB 共享开发库（series-ts-pg）。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../db/index.js";
import { Engine, defaultEngineConfig, type ModelResolver } from "../engine/engine.js";
import { buildApp } from "./app.js";
import { AUTH_PASSWORD_KEY, hashPassword } from "./auth.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";
const JWT_KEY = "unit-test-hmac-key-0123456789abcdef0123456789";
const PASSWORD = "test-pass-1234";

let haveDB = true;
let db: Database | null = null;
let app: FastifyInstance;
let engine: Engine;
let dataDir: string;
let skillsRoot: string;
let token = "";
let taskID = 0;
let expID = 0;
let intentID = 0;
let assetID = 0;
let runStampDomain = "";
const createdTaskIDs: number[] = [];
const createdExpIDs: number[] = [];
const createdAssetIDs: number[] = [];
const createdProfileIDs: number[] = [];
let savedPasswordHash: string | null = null;
let deepseekProfile: { id: number } | null = null;

/** 抛错的模型解析器：本批测试全部走 engine 桩，不触发真实 LLM。 */
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

  dataDir = mkdtempSync(path.join(tmpdir(), "series-batch-a-test-"));
  skillsRoot = path.join(dataDir, "skills");
  mkdirSync(path.join(skillsRoot, "demo-skill"), { recursive: true });
  writeFileSync(path.join(skillsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 测试用技能\n---\n# demo\n");

  savedPasswordHash = await db!.platform().getSetting(AUTH_PASSWORD_KEY);
  await db!.platform().setSetting(AUTH_PASSWORD_KEY, hashPassword(PASSWORD));

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

  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "SERIES", password: PASSWORD } });
  token = (login.json() as { token: string }).token;

  // 共享夹具：一个任务 + open 意图 + 锚定资产 + 任务资产链接（mentions/asset-refs/
  // intent-assets/assets 过滤共用）。
  const task = await db!.tasks().createTask("批次A测试任务", "验证主对话链与任务总览数据");
  taskID = task.id;
  expID = task.exploration_id;
  createdTaskIDs.push(taskID);
  createdExpIDs.push(expID);
  intentID = await db!.exploration(expID).addIntent({ summary: "SQL 注入探测 mention" }, 5, [], "planner");
  // 域名带运行级随机后缀：多批 vitest 共享开发库并发跑时避免 subdomain 唯一索引冲突。
  const runStamp = `${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
  const fixtureDomain = `batch-a-${runStamp}.example.com`;
  runStampDomain = fixtureDomain;
  const assetRes = await db!.query<{ id: string }>(
    `INSERT INTO assets(type, domain, root_domain) VALUES ('subdomain',$1,'example.com') RETURNING id`,
    [fixtureDomain],
  );
  assetID = Number(assetRes.rows[0]!.id);
  createdAssetIDs.push(assetID);
  await db!.query(`INSERT INTO exploration_anchors(node_id, asset_id) VALUES ($1,$2)`, [intentID, assetID]);
  await db!.query(
    `INSERT INTO task_asset_links(task_id, asset_id, source, source_summary, tested)
     VALUES ($1,$2,'manual','批次A单测',false)`,
    [taskID, assetID],
  );
  // token 总览用：mainagent/planner/work 各一条 result 行（不同用量便于断言分组）。
  const s = db!.exploration(expID);
  await s.appendActivity({ worker: "mainagent", kind: "result", summary: "main", input_tokens: 100, output_tokens: 10, cache_read_tokens: 1, cache_write_tokens: 2 });
  await s.appendActivity({ worker: "planner", kind: "result", summary: "plan", input_tokens: 200, output_tokens: 20, cache_read_tokens: 2, cache_write_tokens: 4 });
  await s.appendActivity({ worker: "work#1", kind: "result", summary: "work", node_id: intentID, input_tokens: 300, output_tokens: 30, cache_read_tokens: 3, cache_write_tokens: 6 });
  await s.appendActivity({ worker: "mainagent", kind: "text", summary: "会话搜索命中：SQL 注入关键词" });

  // deepseek 真打素材：库存 profile（base_url=api.deepseek.com 且有 Key）。
  const dp = await db!.query<{ id: string }>(
    `SELECT id FROM llm_profiles WHERE base_url ILIKE '%deepseek%' AND COALESCE(api_key,'')<>'' ORDER BY id LIMIT 1`,
  );
  deepseekProfile = dp.rows[0] ? { id: Number(dp.rows[0]!.id) } : null;
});

afterAll(async () => {
  if (!haveDB) return;
  for (const id of createdTaskIDs) await engine.stop(id).catch(() => undefined);
  for (const id of createdTaskIDs) await db!.query(`DELETE FROM tasks WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of createdAssetIDs) await db!.query(`DELETE FROM assets WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of createdProfileIDs) await db!.query(`DELETE FROM llm_profiles WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of createdExpIDs) await db!.query(`DELETE FROM explorations WHERE id=$1`, [id]).catch(() => undefined);
  if (savedPasswordHash === null) {
    await db!.query(`DELETE FROM settings WHERE key=$1`, [AUTH_PASSWORD_KEY]).catch(() => undefined);
  } else {
    await db!.platform().setSetting(AUTH_PASSWORD_KEY, savedPasswordHash);
  }
  await db?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

const authed = (method: string, url: string, payload?: unknown) =>
  app.inject({ method, url: url as `/api/${string}`, payload, headers: { "X-Series-Token": token } });

describe.skipIf(!haveDB)("批次A：主对话链", () => {
  it("POST /api/chat 别名：engine 桩直答 + 附件提示 + 装载重试", async () => {
    // 无 task 参数 / 不存在的任务。
    expect((await authed("POST", "/api/chat", { message: "hi" })).statusCode).toBe(400);
    expect((await authed("POST", "/api/chat?task=99999999", { message: "hi" })).statusCode).toBe(404);
    expect((await authed("POST", `/api/chat?task=${String(taskID)}`, { message: "  " })).statusCode).toBe(400);

    const calls: Array<[number, string]> = [];
    const origMainChat = Engine.prototype.mainChat;
    const origRun = Engine.prototype.run;
    let runCalls = 0;
    engine.mainChat = async (id, message) => {
      calls.push([id, message]);

      return "这是主对话回复";
    };
    engine.run = async () => {
      runCalls += 1;
    };
    try {
      // 对话不得隐式启动调度。
      const r1 = await authed("POST", `/api/chat?task=${String(taskID)}`, { message: "进展如何？" });
      expect(r1.statusCode).toBe(200);
      expect(r1.json()).toEqual({ reply: "这是主对话回复", mode: "main" });
      expect(calls).toEqual([[taskID, "进展如何？"]]);
      expect(runCalls).toBe(0);

      // 附件非空：reply 前附忽略提示。
      const r2 = await authed("POST", `/api/chat?task=${String(taskID)}`, {
        message: "看下这个文件",
        seg: 0,
        attachments: [{ name: "poc.py", path: "uploads/poc.py", size: 12 }],
      });
      expect(r2.statusCode).toBe(404);
      expect(r2.json().error).toContain("附件不存在或不属于本任务");
      expect(calls).toHaveLength(1);

      // 非"不在引擎"的真实错误（如模型缺失）不触发装载重试，按 500 透出。
      engine.mainChat = async () => {
        throw new Error("LLM profile 未配置（桩）");
      };
      const r3 = await authed("POST", `/api/chat?task=${String(taskID)}`, { message: "再问一次" });
      expect(r3.statusCode).toBe(500);
      expect((r3.json() as { error: string }).error).toContain("LLM profile");
      expect(runCalls).toBe(0);
    } finally {
      delete (engine as unknown as Record<string, unknown>)["mainChat"];
      delete (engine as unknown as Record<string, unknown>)["run"];
      void origMainChat;
      void origRun;
    }
  });

  it("history main:N keeps conversation segments separate", async () => {
    await db!.exploration(expID).appendActivity({ worker: "main", kind: "text", summary: "segment-one", main_seg: 1 });
    await db!.exploration(expID).appendActivity({ worker: "main", kind: "text", summary: "segment-two", main_seg: 2 });
    const result = await authed("GET", `/api/exploration/activity/history?task=${taskID}&session=main:1`);
    expect(result.statusCode).toBe(200);
    expect(result.json().items.map((r: { summary: string }) => r.summary)).toEqual(["segment-one"]);
    expect(result.json().items[0].worker).toBe("mainagent");
  });

  it("chat/stop 真正结束回合 + chat/status 真实状态", async () => {
    const before = await authed("GET", `/api/exploration/activity?task=${String(taskID)}&limit=1000`);
    const cursorBefore = (before.json() as { cursor: number }).cursor;
    const stop = await authed("POST", `/api/tasks/${String(taskID)}/chat/stop`, {});
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ ok: true, status: "stopped" });
    const status = await authed("GET", `/api/tasks/${String(taskID)}/chat/status`);
    expect(status.statusCode).toBe(200);
    expect((status.json() as { running: boolean }).running).toBe(false);
  });

  it("GET /api/chat/mentions：意图 + 锚定资产候选", async () => {
    const r = await authed("GET", `/api/chat/mentions?task=${String(taskID)}&kind=&q=`);
    expect(r.statusCode).toBe(200);
    const page = r.json() as { items: { kind: string; id: number; label: string; description: string }[]; next_cursor: string };
    const intent = page.items.find((i) => i.kind === "intent");
    expect(intent).toMatchObject({ id: intentID, label: "SQL 注入探测 mention" });
    const asset = page.items.find((i) => i.kind === "subdomain" && i.id === assetID);
    expect(asset).toMatchObject({ kind: "subdomain", label: runStampDomain });

    // q 过滤：关键词只命中意图。
    const r2 = await authed("GET", `/api/chat/mentions?task=${String(taskID)}&q=${encodeURIComponent("注入")}`);
    const page2 = (r2.json() as { items: { kind: string; id: number }[] }).items;
    expect(page2.some((i) => i.kind === "intent" && i.id === intentID)).toBe(true);
    expect(page2.some((i) => i.kind === "subdomain" && i.id === assetID)).toBe(false);

    expect((await authed("GET", "/api/chat/mentions")).statusCode).toBe(400);
  });

  it("SSE task→expID 换算：?task= 回放该任务 exploration 的活动行；expID 优先", { timeout: 30_000 }, async () => {
    // 干扰项：另一个 exploration 各带一条活动——若 task 值被误当 expID/错库，回放会串台。
    const decoyTask=await db!.tasks().createTaskWithOptions("批次A干扰探索", "decoy", {});
    const decoyExpID = decoyTask.exploration_id;
    createdTaskIDs.push(decoyTask.id);
    createdExpIDs.push(decoyExpID);
    const decoySeq = await db!.exploration(decoyExpID).appendActivity({ worker: "planner", kind: "text", summary: "干扰帧（不应出现）" });
    const ownSeq = await db!.exploration(expID).appendActivity({ worker: "mainagent", kind: "text", summary: "任务侧回放帧" });

    const sseApp = buildApp({
      version: "test",
      startedAt: Date.now(),
      db: db!,
      engine,
      jwtKey: JWT_KEY,
      skillsRoot,
      dataDir,
    });
    await sseApp.listen({ host: "127.0.0.1", port: 0 });
    const addr = sseApp.server.address();
    const origin = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

    const readFrames = async (url: string, want: number): Promise<string[]> => {
      const ac = new AbortController();
      const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
      expect(res.status).toBe(200);
      const frames: string[] = [];
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (frames.length < want) {
          const { done, value } = await reader.read();
          if (done) throw new Error("SSE 提前结束");
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            if(!buf.slice(0,idx).startsWith("retry:")&&!buf.slice(0,idx).startsWith("event: streams"))frames.push(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
          }
        }
      } finally {
        ac.abort();
      }
      return frames;
    };

    try {
      // ?task=<taskID>：回放包含任务侧新帧，且绝不包含干扰帧。
      const frames = await readFrames(
        `${origin}/api/exploration/activity/stream?task=${String(taskID)}&since=0&token=${encodeURIComponent(token)}`,
        6, // :connected + 4 条夹具活动 + 1 条任务侧新帧
      );
      const dataLines = frames.filter((f) => f.startsWith("id: ")).map((f) => f.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
      const summaries = dataLines.map((d) => (JSON.parse(d) as { summary: string; id: number }).summary);
      expect(summaries).toContain("任务侧回放帧");
      expect(summaries).not.toContain("干扰帧（不应出现）");
      expect(dataLines.some((d) => (JSON.parse(d) as { id: number }).id === ownSeq)).toBe(true);

      // expID 与 task 同时给：expID 优先（回放干扰探索的帧）。
      const frames2 = await readFrames(
        `${origin}/api/exploration/activity/stream?expID=${String(decoyExpID)}&task=${String(taskID)}&since=0&token=${encodeURIComponent(token)}`,
        2,
      );
      const data2 = frames2.filter((f) => f.startsWith("id: ")).map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as { id: number });
      expect(data2).toHaveLength(1);
      expect(data2[0]!.id).toBe(decoySeq);

      // 不存在的任务 → 404（而非 400/空流）。
      const bad = await fetch(`${origin}/api/exploration/activity/stream?task=99999999&token=${encodeURIComponent(token)}`);
      expect(bad.status).toBe(404);
      await bad.body?.cancel().catch(() => undefined);
    } finally {
      await sseApp.close().catch(() => undefined);
    }
  });
});

describe.skipIf(!haveDB)("批次A：任务总览数据", () => {
  it("PUT /api/tasks/:id/llm：单绑定存第一项 + 链序表同步", async () => {
    const stamp = String(Date.now());
    const insA = await db!.query<{ id: string }>(
      `INSERT INTO llm_profiles(name, format, base_url, model, api_key) VALUES ($1,'openai','http://127.0.0.1:9/','probe-a','k') RETURNING id`,
      [`batch-a-probe-a-${stamp}`],
    );
    const insB = await db!.query<{ id: string }>(
      `INSERT INTO llm_profiles(name, format, base_url, model, api_key) VALUES ($1,'openai','http://127.0.0.1:9/','probe-b','k') RETURNING id`,
      [`batch-a-probe-b-${stamp}`],
    );
    const pidA = Number(insA.rows[0]!.id);
    const pidB = Number(insB.rows[0]!.id);
    createdProfileIDs.push(pidA, pidB);

    const put = await authed("PUT", `/api/tasks/${String(taskID)}/llm`, { llm_profile_ids: [pidA, pidB], active_llm_profile_id: null });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true });
    const t = (await db!.query(`SELECT llm_profile_id, active_llm_profile_id FROM tasks WHERE id=$1`, [taskID])).rows[0]!;
    expect(Number(t["llm_profile_id"])).toBe(pidA);
    expect(Number(t["active_llm_profile_id"])).toBe(pidA); // active 缺省回落第一项
    const chain = await db!.query<{ profile_id: string; position: number }>(
      `SELECT profile_id, position FROM task_llm_profiles WHERE task_id=$1 ORDER BY position`,
      [taskID],
    );
    expect(chain.rows.map((r) => Number(r.profile_id))).toEqual([pidA, pidB]);
    // Reopening the settings dialog must receive the complete saved chain.
    expect((await authed("GET", `/api/tasks/${taskID}`)).json().llm_profile_ids).toEqual([pidA, pidB]);

    const put2 = await authed("PUT", `/api/tasks/${String(taskID)}/llm`, { llm_profile_ids: [] });
    expect((put2.json() as { ok: boolean }).ok).toBe(true);
    const t2 = (await db!.query(`SELECT llm_profile_id, active_llm_profile_id FROM tasks WHERE id=$1`, [taskID])).rows[0]!;
    expect(t2["llm_profile_id"]).toBeNull();
    expect((await authed("GET", `/api/tasks/${taskID}`)).json().llm_profile_ids).toEqual([]);
    expect((await db!.query(`SELECT count(*) AS n FROM task_llm_profiles WHERE task_id=$1`, [taskID])).rows[0]!["n"]).toBe("0");
  });

  it("asset-refs / intent-assets：锚定关系双向可查", async () => {
    const refs = await authed("GET", `/api/tasks/${String(taskID)}/asset-refs?asset_id=${String(assetID)}`);
    expect(refs.statusCode).toBe(200);
    expect(refs.json()).toMatchObject({
      intents: [{ id: intentID, kind: "intent", summary: "SQL 注入探测 mention" }],
      facts: [],
      findings: [],
    });
    expect((await authed("GET", `/api/tasks/${String(taskID)}/asset-refs`)).statusCode).toBe(400);

    const ia = await authed("GET", `/api/tasks/${String(taskID)}/intent-assets?before=0&limit=300`);
    expect(ia.statusCode).toBe(200);
    const assets = (ia.json() as { assets: { intent_id: number; asset_id: number; type: string; label: string; source: string; source_task_id: number }[] }).assets;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      intent_id: intentID,
      asset_id: assetID,
      type: "subdomain",
      label: runStampDomain,
      source: "manual",
      source_task_id: taskID,
    });
  });

  it("GET /api/assets：task_id/tested/approval_state/dsl 任务过滤", async () => {
    // 任务视图：命中链接资产并带 per-task 列（pg bigint id 回串，Number 归一比较）。
    const r = await authed("GET", `/api/assets?task_id=${String(taskID)}&tested=false&approval_state=approved&limit=50&offset=0`);
    expect(r.statusCode).toBe(200);
    const page = r.json() as { total: number; assets: { id: string | number; tested: boolean; approval_state: string; task_source: string }[] };
    expect(page.assets.some((a) => Number(a.id) === assetID)).toBe(true);
    const hit = page.assets.find((a) => Number(a.id) === assetID)!;
    expect(hit.tested).toBe(false);
    expect(hit).not.toHaveProperty("approval_state");
    expect(hit.task_source).toBe("manual");

    // tested=true 过滤后不再命中（链接行 tested=false）。
    const r2 = await authed("GET", `/api/assets?task_id=${String(taskID)}&tested=true`);
    expect(((r2.json() as { assets: { id: string | number }[] }).assets.some((a) => Number(a.id) === assetID))).toBe(false);

    // dsl 简单 ILIKE：命中 fixture 域名（全局语法，不限任务）。
    const r3 = await authed("GET", `/api/assets?dsl=${encodeURIComponent(runStampDomain)}`);
    expect((r3.json() as { total: number }).total).toBeGreaterThanOrEqual(1);
    // 任务视图 + dsl：仍限定在本任务资产内。
    const r4 = await authed("GET", `/api/assets?task_id=${String(taskID)}&dsl=${encodeURIComponent(runStampDomain)}`);
    const page4 = (r4.json() as { assets: { id: string | number }[] });
    expect(page4.assets.length).toBeGreaterThanOrEqual(1);
    expect(page4.assets.every((a) => Number(a.id) === assetID)).toBe(true);

    // 无任务上下文的全量视图不回归：type 过滤 + total。
    const r5 = await authed("GET", "/api/assets?type=subdomain&limit=1&offset=0");
    expect(r5.statusCode).toBe(200);
    expect((r5.json() as { total: number; count: number }).total).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!haveDB)("批次A：活动与 token 数据面", () => {
  it("activity/search：session 过滤 + ILIKE + 翻页", async () => {
    const r = await authed("GET", `/api/exploration/activity/search?task=${String(taskID)}&session=main&q=${encodeURIComponent("SQL 注入")}`);
    expect(r.statusCode).toBe(200);
    const page = r.json() as { items: { id: number; kind: string; snippet: string }[]; next_cursor: string };
    expect(page.items.length).toBeGreaterThanOrEqual(1);
    expect(page.items[0]!.snippet).toContain("SQL 注入");
    expect(typeof page.items[0]!.id).toBe("number");

    // plan 会话：命中 planner result 行（summary=plan 不含关键词 → 用宽词）。
    const r2 = await authed("GET", `/api/exploration/activity/search?task=${String(taskID)}&session=plan&q=`);
    const items2 = (r2.json() as { items: { snippet: string }[] }).items;
    expect(items2.some((i) => i.snippet === "plan")).toBe(true);
    expect(items2.every((i) => i.snippet !== "main")).toBe(true);

    // intent 会话：node_id 过滤命中 work result 行。
    const r3 = await authed("GET", `/api/exploration/activity/search?task=${String(taskID)}&session=intent:${String(intentID)}&q=work`);
    const items3 = (r3.json() as { items: { snippet: string }[] }).items;
    expect(items3.some((i) => i.snippet === "work")).toBe(true);

    // 空结果：next_cursor 为空串。
    const r4 = await authed("GET", `/api/exploration/activity/search?task=${String(taskID)}&session=main&q=${encodeURIComponent("绝对不存在的关键词xyz")}`);
    expect(r4.json()).toEqual({ items: [], next_cursor: "" });
  });

  it("main-sessions：段 0 隐式 + 新建段递增", async () => {
    const before = await authed("GET", `/api/exploration/main-sessions?task=${String(taskID)}`);
    expect(before.statusCode).toBe(200);
    const b = before.json() as { sessions: { seq: number }[]; current: number };
    expect(b.sessions[0]!.seq).toBe(0);
    expect(b.current).toBe(0);

    const created = await authed("POST", `/api/exploration/main-session/new?task=${String(taskID)}`);
    expect(created.statusCode).toBe(200);
    const c = created.json() as { seq: number; created_at: string; current: number };
    expect(c.seq).toBe(1);
    expect(c.current).toBe(1);
    expect(typeof c.created_at).toBe("string");

    const after = await authed("GET", `/api/exploration/main-sessions?task=${String(taskID)}`);
    const a = after.json() as { sessions: { seq: number }[]; current: number };
    expect(a.sessions.map((s) => s.seq)).toEqual([0, 1]);
    expect(a.current).toBe(1);
    await db!.query(`DELETE FROM main_sessions WHERE exploration_id=$1`, [expID]);
  });

  it("tokens：workers/sessions/total 三段形状", async () => {
    const r = await authed("GET", `/api/exploration/tokens?task=${String(taskID)}`);
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      workers: { worker: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }[];
      sessions: { session: string; input_tokens: number }[];
      total: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
    };
    expect(body.workers.map((w) => w.worker).sort()).toEqual(["mainagent", "planner", "work#1"]);
    const main = body.workers.find((w) => w.worker === "mainagent")!;
    expect(main).toMatchObject({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 1, cache_write_tokens: 2 });
    expect(body.sessions.map((s) => s.session).sort()).toEqual(["intent:" + String(intentID), "main:0", "plan"]);
    expect(body.total).toMatchObject({ input_tokens: 600, output_tokens: 60, cache_read_tokens: 6, cache_write_tokens: 12,usage_complete:false,calls_complete:false });
  });
});

describe.skipIf(!haveDB)("批次A：LLM 页", () => {
  it("POST /api/llm/models：deepseek 真打一次拿回 deepseek-flash", { timeout: 45_000 }, async (ctx) => {
    if (!deepseekProfile) {
      ctx.skip();
      return;
    }
    const r = await authed("POST", "/api/llm/models", { provider: "openai", base_url: "", api_key: "", profile_id: deepseekProfile.id });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { ok: boolean; models?: string[]; error?: string };
    expect(body.ok, body.error ?? "").toBe(true);
    expect(body.models!.length).toBeGreaterThan(0);
    expect(body.models).toContain("deepseek-flash");
  });

  it("POST /api/llm/models：失败回 200 空态（可渲染）", { timeout: 30_000 }, async () => {
    const r = await authed("POST", "/api/llm/models", { base_url: "http://127.0.0.1:9/", api_key: "x" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: false, models: [] });
    const noBase = await authed("POST", "/api/llm/models", {});
    expect(noBase.statusCode).toBe(200);
    expect(noBase.json()).toMatchObject({ ok: false, models: [] });
  });

  it("POST /api/llm/test：profile_id/id 字段名解析库存配置（不再报缺少 model）", { timeout: 30_000 }, async () => {
    const ins = await db!.query<{ id: string }>(
      `INSERT INTO llm_profiles(name, format, base_url, model, api_key) VALUES ($1,'openai','http://127.0.0.1:9/','probe-model','k') RETURNING id`,
      [`batch-a-test-${String(Date.now())}`],
    );
    const pid = Number(ins.rows[0]!.id);
    createdProfileIDs.push(pid);

    // 只给 profile_id（前端编辑已存 profile、Key 框留空的形状）：应解析出库存
    // model/base_url 并真正发起连接（失败也是连接错误，而非"缺少 model"）。
    const r = await authed("POST", "/api/llm/test", { provider: "openai", model: "", base_url: "", api_key: "", profile_id: pid });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { ok: boolean; error?: string; model?: string; latency_ms?: number };
    expect(body.error ?? "").not.toContain("缺少 model");
    expect(body.ok).toBe(false); // 指向不可达端口 → 连接失败
    expect(body.model).toBe("probe-model");
    expect(typeof body.latency_ms).toBe("number");

    // 旧字段名 id 同样生效；直连参数（无 profile）保持原语义。
    const r2 = await authed("POST", "/api/llm/test", { id: pid });
    expect(((r2.json() as { error?: string }).error) ?? "").not.toContain("缺少 model");
    const r3 = await authed("POST", "/api/llm/test", { model: "", base_url: "", api_key: "" });
    expect(r3.json()).toMatchObject({ ok: false, error: "缺少 model 或 base_url" });
  });
});
