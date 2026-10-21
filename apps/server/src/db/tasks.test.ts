// 任务 store + 任务侧资产授权/范围/覆盖度：纯单测（无 PG）+ PG 集成。
// 集成链路：建任务 → 种 scope → AddAgentScope 授权 → 覆盖度计数 → Validate 通过/拒绝。
// 依赖本地开发库 series (127.0.0.1:5433)，无库时跳过集成部分。
// 运行：cd apps/server && npx vitest run src/db/tasks.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { openDatabase, type Database } from "./index.js";
import { TaskStore, isTerminalTaskStatus, normalizeHeartbeat, MIN_PLAN_HEARTBEAT_SECONDS } from "./tasks.js";
import { EXECUTION_MANAGED, EXECUTION_MANUAL } from "./exploration.js";
import {
  TaskScopeStore,
  domainKey,
  ipToHostCIDR,
  normalizeAgentHost,
  normalizeTaskAssetIDs,
  normalizeURL,
  parseURL,
  rootDomain,
  stripHostPort,
  TaskAssetInvalidError,
} from "./task_scope.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";

// 与 Go 侧 db/agent/server 测试包共用同一把跨套件锁（db/testmain_test.go）：
// 共享开发库上并行套件会互相清对方的资产行 / 产生 DDL 死锁。
const CROSS_SUITE_TEST_LOCK = 7337741002;

let haveDB = true;
let db: Database | null = null;
let suiteLock: pg.Client | null = null;

// 测试自建行清理登记（tasks 级联清 task_scope/task_asset_links/task_asset_blocks/
// task_asset_grants/task_asset_skips/task_relations；explorations/assets 单独删）。
const cleanup = { taskIDs: [] as number[], expIDs: [] as number[], assetIDs: [] as number[] };

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
    return;
  }
  // 专用连接持会话级套件锁（经池执行 session 级 advisory lock 是错误的——
  // 后续语句可能换连接），与 Go TestMain 同构。
  const lock = new pg.Client({ connectionString: TEST_DSN });
  try {
    await lock.connect();
    await lock.query(`SELECT pg_advisory_lock($1)`, [CROSS_SUITE_TEST_LOCK]);
    suiteLock = lock;
  } catch {
    await lock.end().catch(() => undefined);
  }
}, 300_000);

afterAll(async () => {
  if (db) {
    for (const id of cleanup.taskIDs) await db.query(`DELETE FROM tasks WHERE id=$1`, [id]).catch(() => undefined);
    for (const id of cleanup.expIDs) await db.query(`DELETE FROM explorations WHERE id=$1`, [id]).catch(() => undefined);
    for (const id of cleanup.assetIDs) await db.query(`DELETE FROM assets WHERE id=$1`, [id]).catch(() => undefined);
  }
  if (suiteLock) {
    await suiteLock.query(`SELECT pg_advisory_unlock($1)`, [CROSS_SUITE_TEST_LOCK]).catch(() => undefined);
    await suiteLock.end().catch(() => undefined);
  }
  await db?.close().catch(() => undefined);
});

// ─── 纯单测（无 PG）──────────────────────────────────────────────────────────

describe("task helpers (unit)", () => {
  it("isTerminalTaskStatus：done/failed/timeout 终态", () => {
    expect(isTerminalTaskStatus("done")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("timeout")).toBe(true);
    expect(isTerminalTaskStatus("created")).toBe(false);
    expect(isTerminalTaskStatus("running")).toBe(false);
  });

  it("normalizeHeartbeat：低于下限一律抬到 600s", () => {
    expect(normalizeHeartbeat(0)).toBe(MIN_PLAN_HEARTBEAT_SECONDS);
    expect(normalizeHeartbeat(-5)).toBe(MIN_PLAN_HEARTBEAT_SECONDS);
    expect(normalizeHeartbeat(300)).toBe(MIN_PLAN_HEARTBEAT_SECONDS);
    expect(normalizeHeartbeat(900)).toBe(900);
  });

  it("domainKey：trim + 小写 + 去尾点", () => {
    expect(domainKey("  EXample.COM. ")).toBe("example.com");
    expect(domainKey("")).toBe("");
  });

  it("rootDomain：eTLD+1 与 apex 判定", () => {
    expect(rootDomain("a.b.example.com")).toEqual({ root: "example.com", isApex: false });
    expect(rootDomain("example.com")).toEqual({ root: "example.com", isApex: true });
    expect(rootDomain("deep.site.example.co.uk")).toEqual({ root: "example.co.uk", isApex: false });
    expect(rootDomain("localhost")).toEqual({ root: "localhost", isApex: true });
    expect(rootDomain("127.0.0.1")).toEqual({ root: "127.0.0.1", isApex: true });
  });

  it("stripHostPort：去端口，裸主机/裸 IPv6 原样", () => {
    expect(stripHostPort("10.0.188.136:3000")).toBe("10.0.188.136");
    expect(stripHostPort("api.example.com:8080")).toBe("api.example.com");
    expect(stripHostPort("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(stripHostPort("example.com")).toBe("example.com");
    expect(stripHostPort("::1")).toBe("::1");
  });

  it("ipToHostCIDR：v4→/32，v6→/128，非法空串", () => {
    expect(ipToHostCIDR("1.2.3.4")).toBe("1.2.3.4/32");
    expect(ipToHostCIDR("2001:db8::1")).toBe("2001:db8::1/128");
    expect(ipToHostCIDR("not-an-ip")).toBe("");
    expect(ipToHostCIDR("")).toBe("");
  });

  it("normalizeAgentHost：IP 规范形、域名校验、拒绝占位符", () => {
    expect(normalizeAgentHost("EXAMPLE.com", true)).toBe("example.com");
    expect(normalizeAgentHost("127.0.0.1", true)).toBe("127.0.0.1");
    expect(() => normalizeAgentHost("bad_host", true)).toThrow(TaskAssetInvalidError);
    expect(() => normalizeAgentHost("${target}.com", true)).toThrow(TaskAssetInvalidError);
    expect(() => normalizeAgentHost("", true)).toThrow(TaskAssetInvalidError);
    expect(() => normalizeAgentHost("single", false)).toThrow(TaskAssetInvalidError);
  });

  it("normalizeURL/parseURL：小写 scheme+host、默认端口与服务名", () => {
    expect(normalizeURL("HTTP://Example.com/")).toBe("http://example.com");
    const p = parseURL("https://Api.Example.com:8443/x");
    expect(p.domain).toBe("api.example.com");
    expect(p.port).toBe(8443);
    expect(p.serviceName).toBe("HTTPS");
    expect(parseURL("http://a.com").port).toBe(80);
  });

  it("normalizeTaskAssetIDs：去重、正数校验、上限", () => {
    expect(normalizeTaskAssetIDs([3, 1, 3, 2])).toEqual([3, 1, 2]);
    expect(() => normalizeTaskAssetIDs([])).toThrow(TaskAssetInvalidError);
    expect(() => normalizeTaskAssetIDs([0])).toThrow(TaskAssetInvalidError);
    expect(() => normalizeTaskAssetIDs([-1])).toThrow(TaskAssetInvalidError);
    expect(() => normalizeTaskAssetIDs(Array.from({ length: 101 }, (_, i) => i + 1))).toThrow(TaskAssetInvalidError);
  });
});

// ─── PG 集成 ─────────────────────────────────────────────────────────────────

describe.skipIf(!haveDB)("task store + scope (integration)", () => {
  const tasks = () => new TaskStore(db!);
  const scope = () => new TaskScopeStore(db!);
  // 用保留 TLD .test：整个域即 eTLD+1，rootDomain(xyz.test)=xyz.test。
  const runTag = `tsk${Date.now().toString(36)}`;
  const rootDomainName = `${runTag}.test`;

  it("CreateTask：exploration + tasks 行 + origin fact 同事务；SourceTaskIDs 只读继承", async () => {
    const store = tasks();
    const t1 = await store.createTaskWithOptions("测试源任务", "验证创建事务", {
      name: "源",
      timeoutSeconds: -1, // 负值归零
      planHeartbeatSeconds: 10, // 低值抬到 600
      coverageEnabled: false,
    });
    cleanup.taskIDs.push(t1.id);
    cleanup.expIDs.push(t1.exploration_id);
    expect(t1.id).toBeGreaterThan(0);
    expect(t1.exploration_id).toBeGreaterThan(0);
    expect(t1.status).toBe("created");
    expect(t1.execution_mode).toBe(EXECUTION_MANAGED);
    expect(t1.timeout_seconds).toBe(0);
    expect(t1.plan_heartbeat_seconds).toBe(600);
    expect(t1.coverage_enabled).toBe(false);
    expect(t1.llm_failover_state).toBe("default");

    // origin fact 已建
    const origin = await db!.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND state='origin'`,
      [t1.exploration_id],
    );
    expect(Number(origin.rows[0]!.cnt)).toBe(1);

    // 数据库行真实存在（防内存假象）
    const got = await store.getTask(t1.id);
    expect(got!.description).toBe("测试源任务");
    expect(got!.coverage_enabled).toBe(false);
    expect(got!.plan_heartbeat_seconds).toBe(600);

    // 继承：task2 直接引用 task1
    const t2 = await store.createTaskWithOptions("测试子任务", "继承来源", { sourceTaskIDs: [t1.id] });
    cleanup.taskIDs.push(t2.id);
    cleanup.expIDs.push(t2.exploration_id);
    expect(await store.sourceTaskIDs(t2.id)).toEqual([t1.id]);
    const hydrated = await store.getTask(t2.id);
    expect(hydrated!.source_task_ids).toEqual([t1.id]);
    expect(hydrated!.timeout_seconds).toBe(0);
    expect(hydrated!.coverage_enabled).toBe(true); // 缺省开

    // 未知来源任务 → 事务回滚（不留 exploration 行）
    const before = await db!.query<{ cnt: string }>(`SELECT count(*) AS cnt FROM explorations`);
    await expect(
      store.createTaskWithOptions("坏来源", "回滚", { sourceTaskIDs: [t2.id, 999999999] }),
    ).rejects.toThrow(/source task .* not found/);
    const after = await db!.query<{ cnt: string }>(`SELECT count(*) AS cnt FROM explorations`);
    expect(Number(after.rows[0]!.cnt)).toBe(Number(before.rows[0]!.cnt));

    // 重复来源 id 拒绝
    await expect(store.createTaskWithOptions("重复来源", "x", { sourceTaskIDs: [t1.id, t1.id] })).rejects.toThrow(
      /invalid or duplicate source task id/,
    );
  });

  it("状态迁移：首终态写者胜、completed_at 稳定、StampFirstRun 幂等", async () => {
    const store = tasks();
    const t = await store.createTask("测试状态", "验证终态语义");
    cleanup.taskIDs.push(t.id);
    cleanup.expIDs.push(t.exploration_id);

    // 非终态迁移清 completed_at；进终态盖一次
    await store.setTaskStatus(t.id, "running");
    await store.setTaskStatus(t.id, "done");
    let got = await store.getTask(t.id);
    expect(got!.completed_at).toBeTruthy();
    // done→timeout 走 SetStatus 允许改写（completed_at 保持首印）
    await store.setTaskStatus(t.id, "timeout");
    got = await store.getTask(t.id);
    expect(got!.status).toBe("timeout");
    expect(got!.completed_at).toBeTruthy();
    // 回到非终态清空
    await store.setTaskStatus(t.id, "running");
    got = await store.getTask(t.id);
    expect(got!.completed_at).toBeNull();

    // 守卫式终态：第一个写者胜
    await store.setTaskStatus(t.id, "running");
    const won1 = await store.setTaskStatusGuarded(t.id, "done");
    const won2 = await store.setTaskStatusGuarded(t.id, "timeout");
    expect(won1).toBe(true);
    expect(won2).toBe(false);
    got = await store.getTask(t.id);
    expect(got!.status).toBe("done");

    // StampFirstRun：盖章 + 幂等
    const d1 = await store.stampFirstRun(t.id, 3600);
    expect(d1).toBeTruthy();
    const d2 = await store.stampFirstRun(t.id, 999);
    expect(d2).toBe(d1); // 已盖章不动
    const d3 = await store.stampFirstRun(t.id, 0);
    expect(d3).toBe(d1); // 不限时不改既有章
  });

  it("准入队列：ApplyTaskAdmission 一条 UPDATE 原子提交；ApplyTaskPause 保留 queue_mode", async () => {
    const store = tasks();
    const t = await store.createTask("测试准入", "FIFO 队列");
    cleanup.taskIDs.push(t.id);
    cleanup.expIDs.push(t.exploration_id);

    // bootstrap 入队
    const c1 = await store.applyTaskAdmission(t.id, "created", "created", true, "bootstrap", false);
    expect(c1.queueMode).toBe("bootstrap");
    expect(c1.queuedAt).toBeTruthy();
    // 重复准入保留 FIFO 位置
    const ts1 = c1.queuedAt!;
    const c2 = await store.applyTaskAdmission(t.id, "created", "created", true, "resume", true);
    expect(c2.queueMode).toBe("bootstrap"); // (preservePosition && queued && bootstrap) || bootstrap
    expect(c2.queuedAt).toBe(ts1);
    // 用户暂停：出队但保留 queue_mode
    const paused = await store.applyTaskPause(t.id);
    expect(paused.queueMode).toBe("bootstrap");
    expect(paused.commandID).toBeGreaterThan(0);
    const command = await db!.query("SELECT status FROM runtime_task_commands WHERE id=$1", [paused.commandID]);
    expect(command.rows[0]?.status).toBe("pending");
    let got = await store.getTask(t.id);
    expect(got!.paused).toBe(true);
    expect(got!.queued).toBe(false);
    expect(got!.queued_at).toBeNull();
    // 已暂停再暂停 → 冲突
    await expect(store.applyTaskPause(t.id)).rejects.toThrow(/unavailable for pause/);
    // 终态任务不可暂停
    await store.setTaskStatus(t.id, "done");
    await expect(store.applyTaskPause(t.id)).rejects.toThrow(/unavailable for pause/);
    // CAS：expectedStatus 不符 → 冲突
    await expect(store.applyTaskAdmission(t.id, "created", "running", false, "", false)).rejects.toThrow(
      /lifecycle changed before admission/,
    );
    // timeout→非终态重跑清空首跑时钟（先进入 timeout 再重准入）
    await store.setTaskStatus(t.id, "running");
    await store.stampFirstRun(t.id, 60);
    await store.setTaskStatus(t.id, "timeout");
    const c3 = await store.applyTaskAdmission(t.id, "timeout", "created", false, "", false);
    expect(c3.firstRunAt).toBeNull();
    expect(c3.deadlineAt).toBeNull();
    got = await store.getTask(t.id);
    expect(got!.status).toBe("created");
    expect(got!.paused).toBe(false);
    // Enqueue/Dequeue 兼容路径
    await store.enqueue(t.id, "resume");
    got = await store.getTask(t.id);
    expect(got!.queued).toBe(true);
    expect(got!.queue_mode).toBe("resume");
    await store.dequeue(t.id, false);
    got = await store.getTask(t.id);
    expect(got!.queued).toBe(false);
    expect(got!.queue_mode).toBe("resume"); // clearMode=false 保留
    await expect(store.enqueue(t.id, "wrong")).rejects.toThrow(/invalid queue mode/);
  });

  it("SetExecutionMode：队列锁内切换，幂等返回 false，manual 盖/摘 dispatch_requested", async () => {
    const store = tasks();
    const t = await store.createTask("测试模式", "managed↔manual");
    cleanup.taskIDs.push(t.id);
    cleanup.expIDs.push(t.exploration_id);
    const exp = db!.exploration(t.exploration_id);

    expect(await store.executionMode(t.exploration_id)).toBe(EXECUTION_MANAGED);
    // running 意图在切 manual 时盖 dispatch_requested
    const intent = await exp.addIntent({ summary: "模式切换意图" }, 5, [], "planner");
    await exp.setIntentState(intent, "running");
    expect(await store.setExecutionMode(t.exploration_id, EXECUTION_MANUAL)).toBe(true);
    expect(await store.executionMode(t.exploration_id)).toBe(EXECUTION_MANUAL);
    let n = await exp.getNode(intent);
    expect(n!.payload["dispatch_requested"]).toBe(true);
    // 幂等：已是 manual → false，无副作用
    expect(await store.setExecutionMode(t.exploration_id, EXECUTION_MANUAL)).toBe(false);
    // manual 模式下新增 open 意图不带 dispatch_requested；切回 managed 后可自动认领
    const open2 = await exp.addIntent({ summary: "manual 期间意图" }, 5, [], "planner");
    n = await exp.getNode(open2);
    expect(n!.payload["dispatch_requested"]).toBeUndefined();
    expect(await store.setExecutionMode(t.exploration_id, EXECUTION_MANAGED)).toBe(true);
    expect(await store.executionMode(t.exploration_id)).toBe(EXECUTION_MANAGED);
    await expect(store.setExecutionMode(t.exploration_id, "bogus")).rejects.toThrow(/managed\|manual/);
  });
});
