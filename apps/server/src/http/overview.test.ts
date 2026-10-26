import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { postgresDSN } from '../config/index.js';
import { openDatabase, type Database } from '../db/index.js';
import { Engine, defaultEngineConfig } from '../engine/engine.js';
import { buildApp } from './app.js';
import {Coordinator} from '../engine/coordinator.js';
import { signJWT } from './auth.js';

const name = `fate_overview_${process.pid}`;
const connection = new URL(postgresDSN().dsn);
connection.pathname = `/${name}`;
const dsn = connection.toString();
connection.pathname = '/postgres';
const adminDSN = connection.toString();
const previousDSN = process.env.SERIES_PG_DSN;
const dir = mkdtempSync(path.join(tmpdir(), 'overview-'));
const key = 'local-overview-contract-fixture';
const headers = { 'x-series-token': signJWT(key) };
let db: Database, engine: Engine, app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  process.env.SERIES_PG_DSN = dsn;
  db = await openDatabase();
  engine = new Engine(db, defaultEngineConfig(), async () => null, dir);
  app = buildApp({ db, engine, version: 'overview-test', startedAt: Date.now(), jwtKey: key, dataDir: dir, skillsRoot: dir });
});
afterAll(async () => {
  await engine?.shutdown();
  await app?.close();
  await db?.close();
  const client = new pg.Client({ connectionString: adminDSN });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${name}`);
  await client.end();
  rmSync(dir, { recursive: true, force: true });
  if (previousDSN === undefined) delete process.env.SERIES_PG_DSN;
  else process.env.SERIES_PG_DSN = previousDSN;
});

it('legacy overview keeps task-scoped totals without inventing physical request counts', async () => {
  const task = await db.tasks().createTaskWithOptions('LOCAL overview', '', { executionMode: 'manual' });
  const other = await db.tasks().createTaskWithOptions('LOCAL other overview', '', { executionMode: 'manual' });
  for (const [exp, input] of [[task.exploration_id, 12], [task.exploration_id, 8], [other.exploration_id, 999]]) {
    await db.exploration(exp!).appendActivity({ worker: 'main', kind: 'result', input_tokens: input, output_tokens: 3, cache_read_tokens: 2, cache_write_tokens: 0 });
  }
  const response = await app.inject({ url: `/api/llm/records/by-model?task=${task.id}`, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ models: [{ model: expect.any(String), calls: null, source: 'usage_ledger', input_semantics: 'unknown', input_tokens: 20, output_tokens: 6, cache_read_tokens: 4, cache_write_tokens: 0 }] });
});

it('an unused task returns an empty model list instead of a missing field', async () => {
  const task = await db.tasks().createTaskWithOptions('LOCAL empty overview', '', { executionMode: 'manual' });
  const response = await app.inject({ url: `/api/llm/records/by-model?task=${task.id}`, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ models: [] });
});

it('intent lists retain their pagination envelope and task isolation', async () => {
  const task = await db.tasks().createTaskWithOptions('LOCAL intent overview', '', { executionMode: 'manual' });
  const other = await db.tasks().createTaskWithOptions('LOCAL other intent', '', { executionMode: 'manual' });
  const id = await db.exploration(task.exploration_id).addIntent({ summary: 'LOCAL pending work' }, 1, [], 'user');
  await db.exploration(other.exploration_id).addIntent({ summary: 'LOCAL separate task' }, 1, [], 'user');
  for (const suffix of ['', '&page=1&limit=300']) {
    const response = await app.inject({ url: `/api/exploration/intents?task=${task.id}${suffix}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ id: String(id), state: 'open', type: 'intent' }], has_more: false });
    expect(response.json().items).toHaveLength(1);
  }
});

it('missing tasks and unauthenticated calls remain errors', async () => {
  expect((await app.inject({ url: '/api/llm/records/by-model?task=999999999', headers })).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/llm/records/by-model?task=999999999' })).statusCode).toBe(401);
});

it('findings keep a paged items array for the overview list consumer', async () => {
  const task = await db.tasks().createTaskWithOptions('LOCAL empty findings', '', { executionMode: 'manual' });
  const response = await app.inject({ url: `/api/exploration/findings?task=${task.id}`, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ items: [], total: 0, page: 1, page_size: 20 });
});

it('detail and global stats count live slots instead of historical running nodes',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL live occupancy','',{executionMode:'manual'}),s=db.exploration(task.exploration_id);
 for(let i=0;i<5;i++){const id=await s.addIntent({summary:'historical '+i},1,[],'user');await s.setIntentState(id,'running');}
 await db.platform().setSetting('workers','2');await db.platform().setSetting('active_task',String(task.id));
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const coordinator=new Coordinator(db,2),token=(await coordinator.acquire(task.id))!;
 await coordinator.workerSlot(task.id,token);await coordinator.workerSlot(task.id,token);
 try{
  const detail=(await app.inject({url:`/api/tasks/${task.id}`,headers})).json();
  expect(detail).toMatchObject({in_flight:2,engine_mode:'exploring',scheduling:{limit_scope:'task',task_active:2,global_active:2,limit:2,available:0}});
  const stats=(await app.inject({url:'/api/stats',headers})).json();expect(stats.active_task.in_flight).toBe(2);
  const other=await db.tasks().createTaskWithOptions('LOCAL other stats','',{executionMode:'manual'});
  const scoped=(await app.inject({url:`/api/stats?task=${other.id}`,headers})).json();
  expect(scoped.active_task.id).toBe(String(other.id));expect(scoped.active_task.in_flight).toBe(0);
  const otherDetail=(await app.inject({url:`/api/tasks/${other.id}`,headers})).json();
  expect(otherDetail.scheduling).toMatchObject({limit_scope:'task',limit:2,task_active:0,global_active:2,available:2});
 }finally{await coordinator.release(task.id,token);}
});
