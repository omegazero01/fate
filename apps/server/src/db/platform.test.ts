// 平台 store 集成测试：seedBuiltins 幂等（跑两遍行数不变）、拦截规则 Match
// （优先级降序首命中即停 / (?i) 正则 / 坏正则跳过）、Decide 原子结算（两次 decide
// 第二次拒绝、超时不覆盖人工）、settings 类型化访问器、ToolResolve 过滤+覆盖、
// LLM profile CRUD。
// 依赖本地开发库 (127.0.0.1:5433)，无库时跳过。
// 运行：cd apps/server && npx vitest run src/db/platform.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDatabase, type Database } from "./index.js";
import {
  PlatformStore,
  seedBuiltins,
  ActiveLLMProfileDeleteError,
  LLMProfileNotFoundError,
} from "./platform.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";

let haveDB = true;
let db: Database | null = null;
let platform: PlatformStore;

const cleanupSQL: string[] = []; // 测试自建行的收尾 DDL

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
    return;
  }
  platform = new PlatformStore(db);
});

afterAll(async () => {
  if (db) {
    for (const sql of cleanupSQL) {
      await db.query(sql).catch(() => undefined);
    }
  }
  await db?.close().catch(() => undefined);
});

async function count(sql: string): Promise<number> {
  const res = await db!.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) t`);
  return Number(res.rows[0]!.n);
}

describe.skipIf(!haveDB)("seedBuiltins", () => {
  it("两遍运行幂等：行数不变，六角色 + 规则 v1/v2/v3 + 内置 MCP 就位", async () => {
    await seedBuiltins(db!);
    const snap1 = {
      agents: await count(`SELECT 1 FROM agents WHERE builtin`),
      goalsVars: await count(`SELECT 1 FROM agent_prompt_vars`),
      mcp: await count(`SELECT 1 FROM mcp_servers`),
      skills: await count(`SELECT 1 FROM agent_skill_visibility WHERE skill_name='api-recon'`),
    };
    await seedBuiltins(db!);
    const snap2 = {
      agents: await count(`SELECT 1 FROM agents WHERE builtin`),
      goalsVars: await count(`SELECT 1 FROM agent_prompt_vars`),
      mcp: await count(`SELECT 1 FROM mcp_servers`),
      skills: await count(`SELECT 1 FROM agent_skill_visibility WHERE skill_name='api-recon'`),
    };
    expect(snap2).toEqual(snap1); // 幂等：第二遍零新增

    // 六个内置角色（key 集合精确匹配）
    const keys = (await platform.listAgents()).filter((a) => a.builtin).map((a) => a.key).sort();
    expect(keys).toEqual(["auto", "goals", "mainagent", "pentest", "planner", "worker"]);

    // 变量目录：Goals 的 Goal 与背景分离，2 / planner 2 / mainagent 3 / worker 2 = 9 条。
    expect(snap1.agents).toBe(6);
    expect(snap1.goalsVars).toBe(9);
    expect(snap1.mcp).toBeGreaterThanOrEqual(4); // ScopeSentry(schema 播) + playwright/web_search/chrome-devtools
    const mcpNames = (await platform.listMCP()).map((m) => m.name);
    for (const n of ["playwright", "web_search", "chrome-devtools", "ScopeSentry"]) expect(mcpNames).toContain(n);
    const seeded = (await platform.listMCP()).filter((m) => ["playwright", "web_search", "chrome-devtools"].includes(m.name));
    expect(seeded.every((m) => !m.enabled)).toBe(true); // 预设默认 disabled

    // agent 细节：pentest 默认开交互 shell 且不限时；goals 默认关
    const pentest = await platform.getAgentByKey("pentest");
    expect(pentest!.interactiveShell).toBe(true);
    expect(pentest!.runSeconds).toBe(0);
    const goals = await platform.getAgentByKey("goals");
    expect(goals!.interactiveShell).toBe(false);
    expect(goals!.runSeconds).toBe(1200);
    expect((await platform.promptVars(goals!.id)).map(v=>v.name).sort()).toEqual(['EngagementDescription','Goal']);
    const plannerVars = await platform.promptVars((await platform.getAgentByKey("planner"))!.id);
    expect(plannerVars.map((v) => v.name)).toEqual(["AssetSummary", "Goal"]);
  });
});

describe.skipIf(!haveDB)("settings 类型化访问器", () => {
  it("workers 默认 3 / setWorkers / getBool", async () => {
    await db!.query(`DELETE FROM settings WHERE key='workers'`);
    expect(await platform.workers()).toBe(3);
    await platform.setSetting("workers", "0");
    expect(await platform.workers()).toBe(3); // 非法回退默认
    await platform.setWorkers(5);
    expect(await platform.workers()).toBe(5);
    await expect(platform.setWorkers(0)).rejects.toThrow();
    await db!.query(`DELETE FROM settings WHERE key='workers'`);

    expect(await platform.getBool("__no_such_key__", true)).toBe(true);
    expect(await platform.insertSettingIfAbsent("__once__", "v1")).toBe(true);
    expect(await platform.insertSettingIfAbsent("__once__", "v2")).toBe(false); // 已存在不覆盖
    expect(await platform.getSetting("__once__")).toBe("v1");
    await db!.query(`DELETE FROM settings WHERE key='__once__'`);
  });
});

describe.skipIf(!haveDB)("ToolResolve 核心", () => {
  it("按 agent 过滤 + 描述覆盖 + schema 元数据合并；无行工具放行；seed 首插 only", async () => {
    const key = "test_tool_resolve_demo";
    const schema = {
      type: "object",
      properties: {
        limit: { type: "number", description: "代码版", default: 10 },
        verbose: { type: "boolean" },
      },
    };
    await platform.seedTool(key, "DB 覆盖描述", schema, ["worker"]);
    // 首插 only：再 seed 不同描述不覆盖
    await platform.seedTool(key, "第二版描述", schema, ["worker"]);
    const row = await platform.getTool(key)!;
    expect(row!.description).toBe("DB 覆盖描述");

    const codeTools = [
      {
        name: key,
        description: "代码内置描述",
        schema: {
          type: "object",
          properties: { limit: { type: "number" }, verbose: { type: "boolean", description: "代码版" } },
        },
      },
      { name: "mcp_unknown_tool", description: "MCP 工具", schema: { type: "object" } },
    ];
    const forWorker = await platform.resolveToolsForAgent("worker", codeTools);
    expect(forWorker.map((t) => t.name).sort()).toEqual(["mcp_unknown_tool", key]); // worker 绑定保留 + 无行放行
    const resolved = forWorker.find((t) => t.name === key)!;
    expect(resolved.description).toBe("DB 覆盖描述");
    expect((resolved.schema.properties as Record<string, Record<string, unknown>>).limit!["default"]).toBe(10);
    expect((resolved.schema.properties as Record<string, Record<string, unknown>>).limit!["description"]).toBe("代码版");
    // 未绑定 agent → 丢弃
    const forPlanner = await platform.resolveToolsForAgent("planner", codeTools);
    expect(forPlanner.map((t) => t.name)).toEqual(["mcp_unknown_tool"]);
    // 禁用 → 丢弃
    await platform.updateTool(key, "DB 覆盖描述", schema, ["worker"], false);
    const afterDisable = await platform.resolveToolsForAgent("worker", codeTools);
    expect(afterDisable.map((t) => t.name)).toEqual(["mcp_unknown_tool"]);
    cleanupSQL.push(`DELETE FROM tools WHERE key='${key}'`);
  });
});

describe.skipIf(!haveDB)("提示词版本", () => {
  it("SeedPromptIfEmpty 首插 only + savePrompt 追加版本 + promptOverride", async () => {
    // 用一次性自定义 agent，避免与其它并发迁移/种子写入 goals 的提示词互相干扰
    await db!.query(
      `INSERT INTO agents(key, name, description, role, builtin, enabled) VALUES ('test_prompt_agent','测试','','assistant',false,true)
       ON CONFLICT (key) DO NOTHING`,
    );
    cleanupSQL.push(`DELETE FROM agents WHERE key='test_prompt_agent'`); // 级联清 agent_prompts
    const a = (await platform.getAgentByKey("test_prompt_agent"))!;

    await platform.seedPromptIfEmpty(a.id, "v1 模板 {{EngagementDescription}}");
    await platform.seedPromptIfEmpty(a.id, "v2 模板"); // 已有版本 → no-op
    expect(await platform.currentPrompt(a.id)).toBe("v1 模板 {{EngagementDescription}}");
    expect(await platform.promptOverride("test_prompt_agent")).toBe("v1 模板 {{EngagementDescription}}");
    expect(await platform.promptOverride("__no_agent__")).toBeNull();

    const v2 = await platform.savePrompt(a.id, "用户编辑版", "页面编辑", "user");
    expect(v2).toBe(2);
    expect(await platform.currentPrompt(a.id)).toBe("用户编辑版");
    const versions = await platform.listPromptVersions(a.id);
    expect(versions.map((x) => x.version)).toEqual([2, 1]);
    expect(versions[0]!.note).toBe("页面编辑");
  });
});

describe.skipIf(!haveDB)("LLM profile CRUD", () => {
  it("保存/激活/池链/删除（激活中不可删）", async () => {
    const nameA = `测试profile-A-${Date.now()}`;
    const nameB = `测试profile-B-${Date.now()}`;
    cleanupSQL.push(`DELETE FROM llm_profiles WHERE name IN ('${nameA}','${nameB}')`);

    const idA = await platform.saveProfile({
      name: nameA, format: "openai", model: "gpt-test", apiKey: "sk-test-abcd1234",
      baseURL: "https://gw.example/v1", priority: 10,
      retry: { connect: { attempts: 99, interval_ms: -5 } },
    });
    expect(idA).toBeGreaterThan(0);
    // hint 尾 4 位 + retry clamp（attempts 99→20，interval -5→0）
    const listA = (await platform.listProfiles()).find((p) => p.id === idA)!;
    expect(listA.apiKey).toBe(""); // 列表不带 key
    expect(listA.apiKeyHint).toBe("…1234");
    expect(listA.retry.connect.attempts).toBe(20);
    expect(listA.retry.connect.interval_ms).toBe(0);

    // 更新留空 key = 保留
    await platform.saveProfile({ id: idA, name: nameA, format: "openai", model: "gpt-test-2" });
    const reloaded = await platform.profileByID(idA);
    expect(reloaded!.model).toBe("gpt-test-2");
    expect(reloaded!.apiKey).toBe("sk-test-abcd1234");

    await platform.setActiveProfile(idA);
    const active = await platform.activeProfile();
    expect(active!.id).toBe(idA);
    expect(active!.isDefault).toBe(true);

    const idB = await platform.saveProfile({
      name: nameB, format: "anthropic", model: "claude-test", apiKey: "sk-ant-5678", priority: 5,
    });
    const pool = await platform.poolProfiles();
    expect(pool[0]!.id).toBe(idA); // 激活 profile 领头
    expect(pool.map((p) => p.id)).toContain(idB);

    // 激活中不可删；切激活后可删
    await expect(platform.deleteProfile(idA)).rejects.toThrow(ActiveLLMProfileDeleteError);
    await platform.setActiveProfile(idB);
    await platform.deleteProfile(idA);
    expect(await platform.profileByID(idA)).toBeNull();
    await expect(platform.setActiveProfile(987654321)).rejects.toThrow(LLMProfileNotFoundError);
    // 单默认不变式
    expect((await platform.activeProfile())!.id).toBe(idB);
  });
});
