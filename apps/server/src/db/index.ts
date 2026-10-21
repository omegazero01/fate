// PostgreSQL 数据源：连接、幂等 schema 迁移（advisory lock 钉专用连接）、简单查询协议多语句执行。
// 平移自 Go 版 db/db.go 的 Open/withSchemaMigrationLock/applySchemaWithRetry；
// seedBuiltins/backfillToolUsage 在 store 层（M1）引入。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { postgresDSN, redactDSN } from "../config/index.js";
import { ExplorationStore } from "./exploration.js";
import { AssetStore } from "./assets.js";
import { TaskStore } from "./tasks.js";
import { TaskScopeStore } from "./task_scope.js";
import { PlatformStore, seedBuiltins } from "./platform.js";
import { prepareToolOutputAccessMigration } from "../evidence/tool-outputs.js";
import {migrateOperationJournal} from './operation-journal.js';
import {retireRetester} from './retire-retester.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 以本目录为 schema 与兼容迁移的唯一数据源。
const schemaSQL = readFileSync(path.join(__dirname, "sql", "schema.sql"), "utf8");
const retirementSQL = readFileSync(path.join(__dirname, 'sql', 'retire-approvals.sql'), 'utf8');

const SCHEMA_MIGRATION_LOCK_KEY = 7337741001;
const DEADLOCK_RETRY_DELAYS_MS = [100, 250, 500, 1000];

export class Database {
  readonly pool: pg.Pool;

  constructor(pool: pg.Pool, readonly transactionClient?: pg.PoolClient) {
    this.pool = pool;
  }

  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) {
    return (this.transactionClient ?? this.pool).query<T>(text, values);
  }

  /** Domain operations share one connection; nested stores must not commit independently. */
  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    if (this.transactionClient) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new Database(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** 建一个新探索图根并返回 id（Go: CreateExploration）。 */
  async createExploration(description: string, goal: string): Promise<number> {
    const res = await this.query<{ id: string }>(
      `INSERT INTO explorations(description, goal) VALUES ($1, $2) RETURNING id`,
      [description, goal],
    );
    return Number(res.rows[0]!.id);
  }

  /** 绑定某个探索 id 的 store 句柄（Go: Exploration）。 */
  exploration(id: number): ExplorationStore {
    return new ExplorationStore(this, id);
  }

  /** 全局资产图 store（Go: AssetStore）。 */
  assets(): AssetStore {
    return new AssetStore(this, this.transactionClient ?? null);
  }

  /** 任务注册表 store（Go: TaskStore）。 */
  tasks(): TaskStore {
    return new TaskStore(this);
  }

  /** 任务侧范围、资产关联与覆盖度 store。 */
  taskScope(): TaskScopeStore {
    return new TaskScopeStore(this, this.transactionClient);
  }

  /** 设置/提示词/工具目录/MCP/LLM profile store（Go: PlatformStore）。 */
  platform(): PlatformStore {
    return new PlatformStore(this);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function isDeadlock(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "40P01";
}

/** 目标库不存在时先连 postgres 维护库创建（best-effort，失败交给正常 Open 报错）。 */
async function ensureDatabase(dsn: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return;
  }
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName || dbName === "postgres") return;
  const admin = new URL(dsn);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const exists = await client.query<{ ok: boolean }>("SELECT true AS ok FROM pg_database WHERE datname=$1", [dbName]);
    if (exists.rowCount === 0) {
      const ident = /^[A-Za-z0-9_]+$/.test(dbName) ? dbName : `"${dbName.replace(/"/g, '""')}"`;
      await client.query(`CREATE DATABASE ${ident}`);
    }
  } catch {
    // best-effort
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 打开连接池并应用 schema（幂等，重启即迁移）。
 * 迁移锁：从池中取出专用 client 执行 pg_advisory_lock 并持有到 DDL 结束——
 * 经池执行 advisory lock 是错误的（后续语句可能换连接），与 Go 版同构。
 */
export async function openDatabase(): Promise<Database> {
  const { dsn } = postgresDSN();
  await ensureDatabase(dsn);

  const pool = new pg.Pool({
    connectionString: dsn,
    max: 20,
    idleTimeoutMillis: 5 * 60_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
    // advisory lock 等待无死锁检测：锁等待 15s 转错误（引擎调度继续），避免无限挂起。
    // 经连接参数下发，随握手生效（避免 client 上 SET 与首个查询竞争的 pg 弃用警告）。
    options: "-c lock_timeout=15s",
  });

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw new Error(`连接 PostgreSQL 失败 (${redactDSN(dsn)}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_MIGRATION_LOCK_KEY]);
    try {
      await prepareToolOutputAccessMigration(client);
      // 无参数的 query 走简单查询协议，支持单次执行整份多语句 schema。
      const ddl = retirementSQL + "\n" + schemaSQL;
      for (let attempt = 0; ; attempt++) {
        try {
          await client.query(ddl);
          break;
        } catch (err) {
          if (!isDeadlock(err) || attempt >= DEADLOCK_RETRY_DELAYS_MS.length) throw err;
          await new Promise((r) => setTimeout(r, DEADLOCK_RETRY_DELAYS_MS[attempt]));
        }
      }
      const db = new Database(pool);
      await migrateOperationJournal(db);
      // 内置种子（agents/规则/MCP/技能可见性）在迁移锁内执行，与 Go 同构。
      await seedBuiltins(db);
      await retireRetester(db);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } catch (err) {
    client.release();
    await pool.end().catch(() => undefined);
    throw err;
  }
  client.release();

  return new Database(pool);
}
