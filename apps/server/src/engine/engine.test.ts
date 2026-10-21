// 引擎端到端集成测试：faux 模型确定性驱动「goals 分解 → planner 派意图 → worker 领取执行写回
// → 证明目标 → 任务完成」的完整闭环。验证 M0-M4 全栈（无 API key、无网络）。
// faux 是单队列 FIFO：按确定性执行顺序预置全部响应（单 worker、各轮串行）。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openDatabase, type Database } from "../db/index.js";
import { Engine, defaultEngineConfig } from "./engine.js";
import type { ModelSource } from "../agent/roles.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";

let haveDB = true;
let db: Database | null = null;
let dataDir: string;
let faux: ReturnType<typeof fauxProvider>; // worker 队列
let fauxP: ReturnType<typeof fauxProvider>; // planner/goals 队列
let runtime: ModelRuntime;
let runtimeP: ModelRuntime;
let model: ModelSource["model"];
let modelP: ModelSource["model"];
const engines: Engine[] = [];
const ownedTasks: Array<{ taskID: number; expID: number }> = [];

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
  }
  dataDir = mkdtempSync(path.join(tmpdir(), "series-engine-test-"));
  // 并发唤醒语义下 worker 与 planner 并发消费——各用独立 faux 队列保证确定性。
  faux = fauxProvider({ provider: "fauxtest-w", models: [{ id: "faux-w", contextWindow: 200_000, maxTokens: 4096 }] });
  fauxP = fauxProvider({ provider: "fauxtest-p", models: [{ id: "faux-p", contextWindow: 200_000, maxTokens: 4096 }] });
  runtime = await ModelRuntime.create({ refreshOnCreate: false });
  await runtime.registerNativeProvider(faux.provider as never);
  runtimeP = await ModelRuntime.create({ refreshOnCreate: false });
  await runtimeP.registerNativeProvider(fauxP.provider as never);
  model = faux.getModel() as never;
  modelP = fauxP.getModel() as never;
});

afterAll(async () => {
  for (const engine of engines) await engine.shutdown();
  if (db) for (const task of ownedTasks) await cleanupTask(db, task.taskID, task.expID);
  await db?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});


/** 手动轮询（探针模式）：expect.poll 的异步实现在长驻引擎下偶发悬死，改为朴素循环。 */
async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`等待超时（${timeoutMs}ms）: ${what}`);
}

async function seedRunningTask(db: Database, description: string): Promise<{ taskID: number; expID: number }> {
  const expID = await db.createExploration(description, description);
  const s = db.exploration(expID);
  await s.addNode("fact", { summary: "任务根" }, 0, "origin", "system", []);
  const res = await db.query<{ id: string }>(
    `INSERT INTO tasks(exploration_id, name, description, goal, status, timeout_seconds)
     VALUES ($1,$2,$3,$4,'running',3600) RETURNING id`,
    [expID, description, description, description],
  );
  const task = { taskID: Number(res.rows[0]!.id), expID };
  ownedTasks.push(task);
  return task;
}

async function cleanupTask(db: Database, taskID: number, expID: number): Promise<void> {
  await db.query(`DELETE FROM findings WHERE task_id=$1`, [taskID]);
  await db.query(`DELETE FROM tasks WHERE id=$1`, [taskID]);
  await db.query(`DELETE FROM explorations WHERE id=$1`, [expID]);
}

describe.skipIf(!haveDB)("engine 端到端（faux 模型）", () => {
  it("完整闭环：goals→planner→worker→prove_goal→done", { timeout: 120_000 }, async () => {
    const { taskID, expID } = await seedRunningTask(db!, "对 example.com 做授权渗透，证明一个高危漏洞");
    const s = db!.exploration(expID);

    const engine = new Engine(
      db!,
      { ...defaultEngineConfig(), debounceMs: 100, heartbeatMs: 60_000, workers: 1 },
      async (_t, role) => (role === "worker" ? { modelRuntime: runtime, model } : { modelRuntime: runtimeP, model: modelP }),
      dataDir,
    );
    engines.push(engine);

    // 双队列：planner/goals 消费 fauxP，worker 消费 faux——并发唤醒下时序确定。
    fauxP.setResponses([
      fauxAssistantMessage([fauxToolCall("set_goals", { goals: [{ text: "证明 example.com 存在高危漏洞", vulnclass: "SQL注入" }] })]),
      fauxAssistantMessage([fauxToolCall("add_intent", { intents: [{ summary: "对 example.com 登录口做注入探测", priority: 7,contract:{objective:'LOCAL fixture 验证',acceptance:['保存本地夹具结论'],work:{resource:'local:example-fixture',question_key:'fixture_result',method_class:'fixture',identity:'fixture'}} }] })]),
      fauxAssistantMessage('LOCAL planning complete'),
      // Queue the next round before Worker settlement can wake Planner. Resolve
      // graph identities lazily from the committed blackboard at consumption.
      async () => {
        const goal = (await s.listByKind("goal", 10))[0]!;
        const fact = (await s.listByKind("fact", 50)).find(n => n.state === "confirmed")!;
        return fauxAssistantMessage([fauxToolCall("prove_goal", { goal_id: goal.id, evidence_node_id: fact.id })]);
      },
      fauxAssistantMessage('LOCAL planning complete'),
    ]);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("record_fact", { summary: "登录口存在注入", observation_type: "observed", evidence: "curl ' OR 1=1 -- → 200", confidence: "high" })]),
      fauxAssistantMessage('LOCAL observations saved; execution finished.'),
      fauxAssistantMessage("意图执行完成：发现注入并已写回 fact。"),
    ]);

    await engine.run(taskID, { decompose: { description: "对 example.com 做授权渗透，证明一个高危漏洞" } });

    // 1) 目标已登记
    await waitUntil(async () => (await s.listByKind("goal", 10)).length === 1, 20_000, "goals 分解");
    // 2) planner 派出意图（worker 可能已秒领并完成——按存在性而非活跃态判断）
    await waitUntil(async () => (await s.listByKind("intent", 50)).length >= 1, 30_000, "planner 派意图");
    // 3) worker 写回 fact
    await waitUntil(
      async () => (await s.listByKind("fact", 50)).filter((n) => n.state === "confirmed").length >= 1,
      30_000,
      "worker 写回 fact",
    );

    await waitUntil(async()=>(await s.listByKind("intent",50)).some(n=>n.state==="done"),20_000,"worker 结果通过验收");
    // 4) Worker settlement triggers the already queued terminal round.
    const goals = await s.listByKind("goal", 10);
    await waitUntil(
      async () => (await db!.query<{ status: string }>(`SELECT status FROM tasks WHERE id=$1`, [taskID])).rows[0]?.["status"] === "done",
      60_000,
      "任务完成",
    );

    // 意图终态 done；goal met；活动流有 worker 的 tool_use 与 result
    const intents = await s.listByKind("intent", 50);
    expect(intents.some((n) => n.state === "done")).toBe(true);
    expect((await s.getNode(goals[0]!.id))!.state).toBe("met");
    const acts = await db!.query<{ kind: string; worker: string }>(
      `SELECT kind, worker FROM activity WHERE exploration_id=$1 AND node_id IS NOT NULL ORDER BY id`,
      [expID],
    );
    expect(acts.rows.some((r) => r.kind === "tool_use" && (r.worker ?? "").startsWith("work#"))).toBe(true);
    expect(acts.rows.some((r) => r.kind === "result")).toBe(true);

    await engine.stop(taskID).catch((e) => console.log("[T]stop err", e)); await cleanupTask(db!, taskID, expID); });

  it("旧 steering 不注入意图，恢复后保留每次已写回的结果", { timeout: 90_000 }, async () => {
    const { runWorkerIntent } = await import("../agent/roles.js");
    const { taskDB, seedIntent } = { taskDB: db!, seedIntent: async () => 0 };
    const expID = await db!.createExploration("steer 直测", "steer 直测");
    const s = db!.exploration(expID);
    await s.addNode("fact", { summary: "任务根" }, 0, "origin", "system", []);
    await db!.query(
      `INSERT INTO tasks(exploration_id, name, description, goal, status, timeout_seconds) VALUES ($1,'s','s','s','running',3600) RETURNING id`,
      [expID],
    );
    const tr = await db!.query<{ id: string }>(`SELECT id FROM tasks WHERE exploration_id=$1`, [expID]);
    const taskID = Number(tr.rows[0]!.id);
    ownedTasks.push({ taskID, expID });
    const intent = await s.addIntent({ summary: "方向 A" }, 5, [], "planner");
    await s.claimNextWorker("work#1");
    const node = (await s.getNode(intent))!;

    const steerQueue = new Map<number, string[]>();
    const acts: string[] = [];
    let factWritten = false;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1 && echo ready" })]),
      fauxAssistantMessage([fauxToolCall("record_fact", { summary: "初次", evidence: "x" })]),
      fauxAssistantMessage('first pass saved'),
      fauxAssistantMessage("done"),
    ]);
    const res = await runWorkerIntent({
      db: db!, taskID, expID, intent: node as never, workerName: "work#1",
      model: { modelRuntime: runtime, model },
      dataDir, maxTurns: 10, maxDurationMs: 120_000,
      hooks: {},
      takeSteer: (id) => {
        const msgs = steerQueue.get(id) ?? [];
        steerQueue.delete(id);
        return msgs;
      },
      onActivity: (a, meta) => {
        if (a.kind === "tool_start") acts.push(a.toolName);
        if (a.kind === "tool_end" && a.toolName === "record_fact" && !a.isError) factWritten = true;
      },
    });
    void res; void acts; void seedIntent; void taskDB;
    // 第一轮观察已立即写回。
    expect(factWritten).toBe(true);
    expect((await s.listByKind("fact")).filter(n=>n.payload.from_intent===intent)).toHaveLength(1);

    // 第二轮恢复同一意图；旧 steering 不进入模型上下文。
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })]),
      context=>{expect(JSON.stringify(context.messages)).not.toContain("聚焦登录接口");return fauxAssistantMessage([fauxToolCall("record_fact", { summary: "阶段草稿", evidence: "x" })]);},
      fauxAssistantMessage([fauxToolCall("record_fact", { summary: "最终验证结论", evidence: "ok" })]),
      fauxAssistantMessage('LOCAL observations saved; execution finished.'),
      fauxAssistantMessage("完成"),
    ]);
    steerQueue.set(intent, ["聚焦登录接口"]);
    factWritten = false;
    const intent2 = await s.getNode(intent);
    await s.setIntentState(intent,"exhausted");
    await s.reopenIntent(intent);
    await s.claimNextWorker("work#1");
    const res2 = await runWorkerIntent({
      db: db!, taskID, expID, intent: intent2 as never, workerName: "work#1",
      model: { modelRuntime: runtime, model },
      dataDir, maxTurns: 10, maxDurationMs: 120_000,
      hooks: {},
      takeSteer: (id: number) => {
        const msgs = steerQueue.get(id) ?? [];
        steerQueue.delete(id);
        return msgs;
      },
      onActivity: (a) => {
        if (a.kind === "tool_end" && a.toolName === "record_fact" && !a.isError) factWritten = true;
      },
    });
    void res2;
    expect(factWritten).toBe(true);
    expect((await s.listByKind("fact")).filter(n=>n.payload.from_intent===intent).map(n=>n.payload.summary)).toEqual(["最终验证结论","阶段草稿","初次"]);
    expect(steerQueue.get(intent)).toEqual(["聚焦登录接口"]);
    await db!.query(`DELETE FROM tasks WHERE id=$1`, [taskID]);
    await db!.query(`DELETE FROM explorations WHERE id=$1`, [expID]);
  });
});
