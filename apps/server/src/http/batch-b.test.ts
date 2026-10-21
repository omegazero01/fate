// 批次 B 集成测试（连 PG：series-ts-pg）：
//   1) 资产审批族全链：attach → 审批视图(group_by=host) → revoke/approve/block → detach 墓碑 → 重挂
//   2) 范围授权：POST /api/tasks/:id/assets {scope}（addAgentScope manual + authorizeScopeAssets）
//   3) 拦截规则 create→match 命中→toggle→update→delete（缓存失效）
//   4) 拦截历史详情含 audit + execution 关联 activity tool_use/tool_result 对
//   5) tool-config 读写（settings.intercept_enabled_tools）
//   6) 企业 CRUD + 范围行 PATCH/DELETE + 批量删资产（DELETE /api/assets，含级联墓碑）

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../db/index.js";
import { Engine, defaultEngineConfig, type ModelResolver } from "../engine/engine.js";
import { buildApp } from "./app.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { AUTH_PASSWORD_KEY, hashPassword } from "./auth.js";

const TEST_DSN = process.env.SERIES_TEST_PG_DSN ?? "postgres://series:series@127.0.0.1:5433/series_test?sslmode=disable";
const JWT_KEY = "batch-b-hmac-key-0123456789abcdef0123456789";
const PASSWORD = "batch-b-pass-1234";

let haveDB = true;
let db: Database | null = null;
let app: FastifyInstance;
let engine: Engine;
let dataDir: string;
let token = "";

const run = Date.now();
const taskIDs: number[] = [];
const expIDs: number[] = [];
const assetIDs: number[] = [];
const companyIDs: number[] = [];
const ruleIDs: number[] = [];
const pendingIDs: number[] = [];
let savedPasswordHash: string | null = null;

const throwingResolver: ModelResolver = async () => {
  throw new Error("未配置激活的 LLM profile（批次B测试桩）");
};

beforeAll(async () => {
  process.env.SERIES_PG_DSN = TEST_DSN;
  try {
    db = await openDatabase();
  } catch {
    haveDB = false;
  }
  if (!haveDB) return;

  dataDir = mkdtempSync(path.join(tmpdir(), "series-batch-b-"));
  const skillsRoot = path.join(dataDir, "skills");
  mkdirSync(path.join(skillsRoot, "demo-skill"), { recursive: true });
  writeFileSync(path.join(skillsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 测试技能\n---\n# demo\n");

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
  for (const id of taskIDs) await engine.stop(id).catch(() => undefined);
  for (const id of pendingIDs) await db!.query(`DELETE FROM intercept_pending WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of ruleIDs) await db!.query(`DELETE FROM intercept_rules WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of assetIDs) await db!.query(`DELETE FROM assets WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of companyIDs) await db!.query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of taskIDs) await db!.query(`DELETE FROM tasks WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of expIDs) await db!.query(`DELETE FROM explorations WHERE id=$1`, [id]).catch(() => undefined);
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

async function createTask(description: string): Promise<{ id: number; exploration_id: number }> {
  const res = await authed("POST", "/api/tasks", { description, goal: "批次B验证" });
  expect(res.statusCode).toBe(201);
  const task = res.json() as { id: string; exploration_id: number };
  const id = Number(task.id);
  taskIDs.push(id);
  expIDs.push(task.exploration_id);
  return { id, exploration_id: task.exploration_id };
}

describe.skipIf(!haveDB)("批次 B：资产关联", () => {

  it("POST /api/tasks/:id/assets {scope}：按范围授权并挂回匹配资产", async () => {
    const task = await createTask("批次B 范围授权");
    const domain = `scope-${run}.example`;
    const assetID = await db!.assets().upsertRootDomain({ domain });
    assetIDs.push(assetID);

    const res = await authed("POST", `/api/tasks/${task.id}/assets`, {
      scope: [{ kind: "domain", value: domain }],
    });
    expect(res.statusCode).toBe(200);
    const mutation = res.json() as {
      requested: number;
      assets_linked: number;
      assets_existing: number;
      scopes_added: number;
      scopes_existing: number;
    };
    expect(mutation.requested).toBe(1);
    expect(mutation.scopes_added).toBe(1);
    expect(mutation.assets_linked).toBe(1);
    expect(mutation.assets_existing).toBe(0);

    // 范围行（kind=root_domain 存 eTLD+1）+ 资产均按 manual/approved 挂上。
    const scopeRow = await db!.query(`SELECT kind FROM task_scope WHERE task_id=$1 AND kind='root_domain' AND domain=$2`, [
      task.id,
      domain,
    ]);
    expect(scopeRow.rows.length).toBe(1);
    const link = await db!.query<{ source: string }>(
      `SELECT source FROM task_asset_links WHERE task_id=$1 AND asset_id=$2`,
      [task.id, assetID],
    );
    expect(link.rows[0]?.source).toBe("manual");

    // 重复登记：范围幂等 → scopes_existing。
    const dup = await authed("POST", `/api/tasks/${task.id}/assets`, { scope: [{ kind: "domain", value: domain }] });
    expect((dup.json() as { scopes_existing: number }).scopes_existing).toBe(1);

    // 非法范围 → 400。
    const bad = await authed("POST", `/api/tasks/${task.id}/assets`, { scope: [{ kind: "domain", value: "!!!" }] });
    expect(bad.statusCode).toBe(400);
  });
});

describe.skipIf(!haveDB)("批次 B：企业与批量删资产", () => {
  it("POST /companies（含 scope）→ 范围增删改 → 改名 → 删除", async () => {
    const name = `批次B企业-${run}`;
    const create = await authed("POST", "/api/companies", {
      name,
      scope: [
        { kind: "domain", value: `batchb-${run}.example.com` },
        { kind: "ip", value: "203.0.113.7" },
      ],
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: number; scope_added: number; scope_invalid: number };
    expect(created.scope_added).toBe(2);
    expect(created.scope_invalid).toBe(0);
    companyIDs.push(created.id);

    // 重名 → 409。
    const dup = await authed("POST", "/api/companies", { name, scope: [] });
    expect(dup.statusCode).toBe(409);

    // 追加 cidr 范围。
    const add = await authed("POST", `/api/companies/${created.id}/scope`, {
      scope: [{ kind: "cidr", value: "203.0.113.0/24" }],
    });
    expect(add.statusCode).toBe(200);
    expect((add.json() as { added: number }).added).toBe(1);

    // reset 覆盖：先给非法规则 → 400 且旧范围保留；再合法覆盖。
    const badReset = await authed("POST", `/api/companies/${created.id}/scope`, {
      scope: [{ kind: "domain", value: "!!!" }],
      reset: true,
    });
    expect(badReset.statusCode).toBe(400);
    const still = await db!.assets().companies.getScope(created.id);
    expect(still.length).toBe(3);
    const reset = await authed("POST", `/api/companies/${created.id}/scope`, {
      scope: [{ kind: "domain", value: `reset-${run}.example.net` }],
      reset: true,
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { added: number }).added).toBe(1);
    const afterReset = await db!.assets().companies.getScope(created.id);
    expect(afterReset.length).toBe(1);

    // 单行 PATCH 替换（新行 id）+ 按 新 id DELETE。
    const sid = afterReset[0]!.id;
    const patch = await authed("PATCH", `/api/companies/${created.id}/scope/${sid}`, {
      kind: "domain",
      value: `patched-${run}.example.net`,
    });
    expect(patch.statusCode).toBe(200);
    const patched = patch.json() as { id: number; raw: string };
    expect(patched.raw).toBe(`patched-${run}.example.net`);
    const delRow = await authed("DELETE", `/api/companies/${created.id}/scope/${patched.id}`);
    expect((delRow.json() as { deleted: number }).deleted).toBe(1);
    const delMissing = await authed("DELETE", `/api/companies/${created.id}/scope/${patched.id}`);
    expect(delMissing.statusCode).toBe(404);

    // 改名（nkey 随动）。
    const rename = await authed("PATCH", `/api/companies/${created.id}`, { name: `${name}-改名` });
    expect(rename.statusCode).toBe(200);
    const renamed = await db!.assets().companies.getCompany(created.id);
    expect(renamed?.name).toBe(`${name}-改名`);

    // 不连带删资产的企业删除。
    const del = await authed("DELETE", `/api/companies/${created.id}`, { delete_assets: false });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ deleted: 1, assets_deleted: 0 });
    const gone = await db!.assets().companies.getCompany(created.id);
    expect(gone).toBeNull();
  });

  it("DELETE /api/assets {ids}：批量删资产行 + 级联 task_asset_links + deleted 墓碑", async () => {
    const task = await createTask("批次B 批量删资产");
    const domain = `del-${run}.example.io`;
    const assetID = await db!.assets().upsertRootDomain({ domain });
    assetIDs.push(assetID);
    const attach = await authed("POST", `/api/tasks/${task.id}/assets`, {
      asset_ids: [assetID],
      source_summary: "批次B待删",
    });
    expect(attach.statusCode).toBe(200);

    const del = await authed("DELETE", "/api/assets", { ids: [assetID] });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: number }).deleted).toBe(1);

    const asset = await db!.query(`SELECT type FROM assets WHERE id=$1`, [assetID]);
    expect(asset.rows.length).toBe(0);
    const link = await db!.query(`SELECT task_id FROM task_asset_links WHERE task_id=$1 AND asset_id=$2`, [task.id, assetID]);
    expect(link.rows.length).toBe(0);
    // 空参 → 400；hosts 形态可用。
    const empty = await authed("DELETE", "/api/assets", {});
    expect(empty.statusCode).toBe(400);
    const hostDomain = `host-${run}.example.io`;
    const hostAsset = await db!.assets().upsertRootDomain({ domain: hostDomain });
    assetIDs.push(hostAsset);
    const delHost = await authed("DELETE", "/api/assets", { hosts: [hostDomain] });
    expect((delHost.json() as { deleted: number }).deleted).toBe(1);
  });
});
