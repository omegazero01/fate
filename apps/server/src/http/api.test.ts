import {LiveStreamWriter} from '../engine/live-stream.js';
// M5 HTTP API 集成测试：fastify inject（登录/me、建任务容错、拦截 decide 幂等、
// 已删模块 404）+ 真实监听口的活动 SSE（inject 只在流结束时 resolve，无法观测
// 长连 SSE，故该用例起 :0 端口用 fetch 读流）。DB 使用独立测试库，禁止连接生产 series 库。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../db/index.js";
import { Engine, defaultEngineConfig, type ModelResolver } from "../engine/engine.js";
import { buildApp } from "./app.js";
import { AUTH_PASSWORD_KEY, hashPassword, signJWT, verifyJWT } from "./auth.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";
if (!/(?:test|fixture)/i.test(new URL(TEST_DSN).pathname)) throw new Error('API tests require an isolated test/fixture database');
const JWT_KEY = "unit-test-hmac-key-0123456789abcdef0123456789";
const PASSWORD = "test-pass-1234";

let haveDB = true;
let db: Database | null = null;
let app: FastifyInstance;
let engine: Engine;
let dataDir: string;
let skillsRoot: string;
let token = "";
const createdTaskIDs: number[] = [];
const createdExpIDs: number[] = [];
let savedPasswordHash: string | null = null;
let savedPlannerPrompt: unknown;
let savedWorkers: string | null = null;

/** 抛错的模型解析器：验证建任务/启动路径在无 LLM 配置时的容错（decompose 失败不 5xx）。 */
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

  dataDir = mkdtempSync(path.join(tmpdir(), "series-api-test-"));
  skillsRoot = path.join(dataDir, "skills");
  mkdirSync(path.join(skillsRoot, "demo-skill"), { recursive: true });
  writeFileSync(path.join(skillsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 测试用技能\n---\n# demo\n");

  savedPlannerPrompt = (await db!.query("SELECT current_prompt_id FROM agents WHERE key='planner'")).rows[0]?.current_prompt_id;
  savedWorkers = await db!.platform().getSetting('workers');
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
});

afterAll(async () => {
  if (!haveDB) return;
  for (const id of createdTaskIDs) await engine.stop(id).catch(() => undefined);
  for (const id of createdTaskIDs) await db!.query(`DELETE FROM tasks WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of createdExpIDs) await db!.query(`DELETE FROM explorations WHERE id=$1`, [id]).catch(() => undefined);
  if (savedPasswordHash === null) {
    await db!.query(`DELETE FROM settings WHERE key=$1`, [AUTH_PASSWORD_KEY]).catch(() => undefined);
  } else {
    await db!.platform().setSetting(AUTH_PASSWORD_KEY, savedPasswordHash);
  }
  await db!.query("UPDATE agents SET current_prompt_id=$1 WHERE key='planner'",[savedPlannerPrompt]);
  if(savedWorkers===null)await db!.query("DELETE FROM settings WHERE key='workers'");
  else await db!.platform().setSetting('workers',savedWorkers);
  await db?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

const authed = (method: string, url: string, payload?: unknown) =>
  app.inject({ method, url: url as `/api/${string}`, payload, headers: { "X-Series-Token": token } });

describe.skipIf(!haveDB)("M5 HTTP API", () => {
  it("健康检查与鉴权豁免", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect((health.json() as { status: string }).status).toBe("ok");

    // 未带 token 的受保护端点 → 401。
    const noAuth = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(noAuth.statusCode).toBe(401);
    expect((noAuth.json() as { error: string }).error).toBe("未授权");
  });

  it("login → me：口令校验、token 签发/校验与用户回显", async () => {
    const status = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.statusCode).toBe(200);
    expect((status.json() as { initialized: boolean }).initialized).toBe(true);

    const badUser = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "root", password: PASSWORD } });
    expect(badUser.statusCode).toBe(401);
    const badPw = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "SERIES", password: "wrong-pass-99" } });
    expect(badPw.statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "SERIES", password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const tok = (login.json() as { token: string }).token;
    // HS256 + sub=SERIES + exp（与 Go 版兼容的 claims 结构）。
    const parts = tok.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as { alg: string };
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as { sub: string; exp: number; iat: number };
    expect(header.alg).toBe("HS256");
    expect(claims.sub).toBe("SERIES");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(verifyJWT(tok, JWT_KEY)).toBe(true);
    expect(verifyJWT(signJWT(JWT_KEY), JWT_KEY)).toBe(true);
    expect(verifyJWT(tok, "another-hmac-key-0123456789abcdef0123456")).toBe(false);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { "X-Series-Token": tok } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { username: string } }).user.username).toBe("series");

    const meNoTok = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(meNoTok.statusCode).toBe(401);
  });

  it("创建任务：modelResolver 抛错时 decompose 容错（不 5xx，任务可查询/控制）", async () => {
    const create = await authed("POST", "/api/tasks", {
      description: "对 example.com 做授权渗透",
      goal: "证明一个高危漏洞",
    });
    expect(create.statusCode).toBe(201);
    const task = create.json() as { id: string; exploration_id: number; status: string };
    expect(Number(task.id)).toBeGreaterThan(0);
    createdTaskIDs.push(task.id);
    createdExpIDs.push(task.exploration_id);

    // Goals 初始化失败会暂停新任务，任务和失败活动仍可查询。
    const detail = await authed("GET", `/api/tasks/${task.id}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      goals: unknown[];
      counts: { running: number; goals: number; met: number };
      coverage: { enabled: boolean; by_type: unknown[] };
    };
    expect(body.goals).toEqual([]);
    expect(typeof body.counts.goals).toBe("number");
    expect(typeof body.coverage.enabled).toBe("boolean");

    const list = await authed("GET", "/api/tasks");
    expect(list.statusCode).toBe(200);
    expect((list.json() as { tasks: { id: number }[] }).tasks.some((t) => t.id === task.id)).toBe(true);

    // 生命周期：重试初始化仍失败并保持暂停；不能跳过 Goals 启动执行。
    expect((await authed("POST", `/api/tasks/${task.id}/start`)).statusCode).toBe(200);
    const paused = await authed("POST", `/api/tasks/${task.id}/pause`);
    expect(paused.statusCode).toBe(409); // 初始化失败已经暂停。
    const resumed = await authed("POST", `/api/tasks/${task.id}/resume`);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({status:"paused",paused:true});

    const chat = await authed("POST", `/api/tasks/${task.id}/chat`, { message: "进展如何？" });
    // 无激活 profile：mainChat 报模型缺失（500 + 中文原因），而非挂死/崩溃。
    expect(chat.statusCode).toBe(500);
    expect((chat.json() as { error: string }).error).toContain("LLM profile");

    const del = await authed("DELETE", `/api/tasks/${task.id}`);
    expect(del.statusCode).toBe(200);
    expect((await authed("GET", `/api/tasks/${task.id}`)).statusCode).toBe(404);
  });

  it("LLM 管理兼容 API：审计分页、轮询状态与有界全局重试策略", async () => {
    const prior = await db!.platform().getSetting("llm_retry_policy");
    try {
      const policy = await authed("POST", "/api/llm/retry-policy", {
        connect: { attempts: 99, interval_ms: 9_000_000 },
        breaker: { attempts: 4, interval_ms: 10_000 },
      });
      expect(policy.statusCode).toBe(200);
      expect(policy.json()).toMatchObject({
        connect: { attempts: 20, interval_ms: 3_600_000 },
        empty: { attempts: 0, interval_ms: 0 },
        breaker: { attempts: 4, interval_ms: 10_000 },
      });
      expect((await authed("GET", "/api/llm/retry-policy")).json()).toEqual(policy.json());
      const pool = await authed("GET", "/api/llm/pool");
      expect(pool.statusCode).toBe(200);
      expect(pool.json()).toMatchObject({ enabled: expect.any(Boolean), bind_fallback: expect.any(Boolean), chain: expect.any(Array) });
      const records = await authed("GET", "/api/llm/records?page=0&size=10");
      expect(records.statusCode).toBe(200);
      expect(records.json()).toMatchObject({ records: expect.any(Array), total: expect.any(Number) });
      expect((await authed("GET", "/api/llm/records/tasks")).statusCode).toBe(200);
      expect((await authed("GET", "/api/llm/records/999999999")).statusCode).toBe(404);
    } finally {
      if (prior === null) await db!.query("DELETE FROM settings WHERE key='llm_retry_policy'");
      else await db!.platform().setSetting("llm_retry_policy", prior);
    }
  });

  it("活动 SSE：since 回放 DB + engine.bus 实时帧（data: {json}\\n\\n，id: 行）", { timeout: 30_000 }, async () => {
    const task = await db!.tasks().createTaskWithOptions("sse 测试", "sse", {});
    const expID = task.exploration_id;
    createdTaskIDs.push(task.id);
    createdExpIDs.push(expID);
    const s = db!.exploration(expID);
    const r1 = await s.appendActivity({ worker: "planner", kind: "text", summary: "历史帧1" });
    const r2 = await s.appendActivity({ worker: "planner", kind: "text", summary: "历史帧2" });

    // 独立 app 实例（关闭不影响后续 inject 用例），共享同一 db/engine。
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

    const ac = new AbortController();
    const res = await fetch(`${origin}/api/exploration/activity/stream?expID=${expID}&since=0&token=${encodeURIComponent(token)}`, {
      signal: ac.signal,
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames: string[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const collectUntil = async (pred: () => boolean): Promise<void> => {
      while (!pred()) {
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE 提前结束");
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          if(!buf.slice(0,idx).startsWith("event: streams")&&!buf.slice(0,idx).startsWith("retry:"))frames.push(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
    };

    // 连接注释 + 两帧回放。
    await collectUntil(() => frames.length >= 3);
    expect(frames[0]).toBe(": connected");
    const dataLine = (f: string): string => f.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
    expect(frames[1]!.startsWith(`id: ${r1}\n`)).toBe(true);
    expect(JSON.parse(dataLine(frames[1]!))).toMatchObject({ id: r1, seq: r1, summary: "历史帧1" });
    expect(frames[2]!.startsWith(`id: ${r2}\n`)).toBe(true);
    expect(JSON.parse(dataLine(frames[2]!))).toMatchObject({ id: r2, summary: "历史帧2" });

    // 实时帧：engine.bus 广播（id 递增，防回放重复）。
    const liveNode=await s.addIntent({summary:"SSE live"},1,[],"user");
    const liveID=await s.appendActivity({node_id:liveNode,worker:"work#1",kind:"tool_use",tool:"bash",summary:"实时帧"});
    const live = { taskID: 0, expID, nodeID: liveNode, worker: "work#1", kind: "tool_use", tool: "bash", summary: "实时帧", id: liveID };
    engine.bus.emit("activity", live);
    await collectUntil(() => frames.length >= 4);
    expect(frames[3]!.startsWith(`id: ${liveID}\n`)).toBe(true);
    expect(JSON.parse(dataLine(frames[3]!))).toMatchObject({ id: liveID, seq: liveID, intent_id: String(liveNode), kind: "tool_use", tool: "bash", task_id: 0 });

    // 过滤语义：非本探索的事件不投递。
    engine.bus.emit("activity", { taskID: 1, expID: expID + 999_999, kind: "text", id: r2 + 2 });
    await new Promise((r) => setTimeout(r, 300));
    expect(frames.length).toBe(4);

    const writer=new LiveStreamWriter(db!,'task',expID,{worker:'main',main_seg:2,turn_id:'fixture'});
    writer.push({kind:'assistant_delta',text:'streaming',streamID:'fixture-stream'});
    await collectUntil(() => frames.length >= 5);
    expect(frames[4]).toContain("event: delta");
    expect(JSON.parse(dataLine(frames[4]!))).toMatchObject({ worker: "mainagent", main_seg: 2, text: "streaming" });

    await writer.close();
    ac.abort();
    await sseApp.close().catch(() => undefined);
  });

  it("已删除模块：404 + 统一文案", async () => {
    for (const url of ["/api/update/check", "/api/task-archives", "/api/task-templates", "/api/side-questions/x/events", "/api/tasks/notifications"]) {
      const r = await authed("GET", url);
      expect(r.statusCode, url).toBe(404);
      expect((r.json() as { error: string }).error, url).toBe("模块已在重构中移除");
    }
    // 未实现但未删除的端点：通用 not found（区分文案）。/api/stats 已由兼容层实现（200）。
  });

  it('Planner context budget supports explicit rollback and rejects invalid settings without changing workers',async()=>{
    const before=(await authed('GET','/api/settings')).json();
    try{
      for(const value of [48000,0,8192]){
        const saved=await authed('PUT','/api/settings',{planner_context_budget_tokens:value});
        expect(saved.statusCode).toBe(200);expect(saved.json()).toMatchObject({planner_context_budget_tokens:value,applies:'next_session'});
        expect((await authed('GET','/api/settings')).json()).toMatchObject({planner_context_budget_tokens:value,workers:before.workers});
      }
      for(const value of [-1,1,8191,1000001,1.5,'48000',null]){
        expect((await authed('PUT','/api/settings',{planner_context_budget_tokens:value,workers:before.workers+1})).statusCode).toBe(400);
        expect((await authed('GET','/api/settings')).json()).toMatchObject({planner_context_budget_tokens:8192,workers:before.workers});
      }
    }finally{await authed('PUT','/api/settings',{planner_context_budget_tokens:before.planner_context_budget_tokens});}
  });

  it('Worker context is independent; invalid paired settings cannot partially persist',async()=>{
    const before=(await authed('GET','/api/settings')).json();
    expect(before.worker_context_budget_tokens).toBe(0);
    try{
      for(const value of [64000,0,8192,1000000]){
        const saved=await authed('PUT','/api/settings',{worker_context_budget_tokens:value});
        expect(saved.statusCode).toBe(200);
        expect(saved.json()).toMatchObject({worker_context_budget_tokens:value,applies:'next_session'});
        expect((await authed('GET','/api/settings')).json()).toMatchObject({worker_context_budget_tokens:value,planner_context_budget_tokens:before.planner_context_budget_tokens});
      }
      for(const value of [-1,1,8191,1000001,1.5,'64000',null,true]){
        expect((await authed('PUT','/api/settings',{planner_context_budget_tokens:96000,worker_context_budget_tokens:value})).statusCode).toBe(400);
        expect((await authed('GET','/api/settings')).json()).toMatchObject({worker_context_budget_tokens:1000000,planner_context_budget_tokens:before.planner_context_budget_tokens});
      }
      const pair=await authed('PUT','/api/settings',{planner_context_budget_tokens:48000,worker_context_budget_tokens:64000});
      expect(pair.statusCode).toBe(200);
      expect((await authed('GET','/api/settings')).json()).toMatchObject({planner_context_budget_tokens:48000,worker_context_budget_tokens:64000,effective:{worker_context_budget_tokens:'next worker session'}});
    }finally{await authed('PUT','/api/settings',{planner_context_budget_tokens:before.planner_context_budget_tokens,worker_context_budget_tokens:before.worker_context_budget_tokens});}
  });

  it("系统配置：settings/agents/llm profiles/mcp/skills 最小面", async () => {
    const settings = await authed("GET", "/api/settings");
    expect(settings.statusCode).toBe(200);
    expect(typeof (settings.json() as { workers: number }).workers).toBe("number");

    const saved = await authed("POST", "/api/settings", { workers: 2 });
    expect(saved.statusCode).toBe(200);
    expect((await authed("GET", "/api/settings")).json()).toMatchObject({ workers: 2 });

    const agents = await authed("GET", "/api/agents");
    expect(agents.statusCode).toBe(200);
    const list = (agents.json() as { agents: { key: string }[] }).agents;
    expect(list.some((a) => a.key === "planner")).toBe(true);

    const prompt = await authed("PUT", "/api/agents/planner/prompt", { template: "测试模板 {{Goal}}", note: "单测" });
    expect(prompt.statusCode).toBe(200);
    expect((prompt.json() as { version: number }).version).toBeGreaterThan(0);

    const profiles = await authed("GET", "/api/llm/profiles");
    expect(profiles.statusCode).toBe(200);

    const mcp = await authed("GET", "/api/mcp");
    expect(mcp.statusCode).toBe(200);

    const skills = await authed("GET", "/api/skills");
    expect(skills.statusCode).toBe(200);
    const skillList = (skills.json() as { skills: { name: string; description: string; files: string[] }[] }).skills;
    expect(skillList.some((s) => s.name === "demo-skill" && s.files.includes("SKILL.md"))).toBe(true);

    const readBack = await authed("POST", "/api/skills/file", { name: "demo-skill", file: "SKILL.md" });
    expect(readBack.statusCode).toBe(200);
    expect((readBack.json() as { content: string }).content).toContain("demo-skill");

    const writeBack = await authed("POST", "/api/skills/file", { name: "demo-skill", file: "SKILL.md", content: "# 改写" });
    expect(writeBack.statusCode).toBe(200);

    const traversal = await authed("POST", "/api/skills/file", { name: "../../etc", file: "passwd" });
    expect(traversal.statusCode).toBe(400);
  });

  it("任务范围与覆盖度", async () => {
    const create = await authed("POST", "/api/tasks", { description: "scope 测试", goal: "scope" });
    const taskID = (create.json() as { id: number }).id;
    createdTaskIDs.push(taskID);
    createdExpIDs.push((create.json() as { exploration_id: number }).exploration_id);

    const added = await authed("POST", `/api/tasks/${taskID}/scope`, { kind: "root_domain", value: "example.com", reason: "单测" });
    expect(added.statusCode).toBe(201);
    const scopeRow = added.json() as { kind: string; domain: string; source: string };
    expect(scopeRow.kind).toBe("root_domain");
    expect(scopeRow.domain).toContain("example.com");
    expect(scopeRow.source).toBe("manual");

    const scopeList = await authed("GET", `/api/tasks/${taskID}/scope`);
    expect((scopeList.json() as { scope: unknown[] }).scope.length).toBeGreaterThanOrEqual(1);

    const coverage = await authed("GET", `/api/tasks/${taskID}/coverage`);
    expect(coverage.statusCode).toBe(200);
    const cov = coverage.json() as { enabled: boolean; scope_rows: number };
    expect(cov.enabled).toBe(true);
    expect(cov.scope_rows).toBeGreaterThanOrEqual(1);
  });
});

it('rejects the removed Worker conversation endpoint without persisting messages',async()=>{
 if(!haveDB)return;
 const before=Number((await db!.query('SELECT count(*) n FROM worker_interventions')).rows[0].n);
 const r=await authed('POST','/api/tasks/999999/intents/999999/messages',{message:'must not run',request_id:'removed'});
 expect(r.statusCode).toBe(410);expect(Number((await db!.query('SELECT count(*) n FROM worker_interventions')).rows[0].n)).toBe(before);
});
