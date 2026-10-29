import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import http from 'node:http';
import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Database } from '../db/index.js';
import { configureEvidenceStore } from './blobs.js';
import { runContext, type ToolRunContext } from '../tools/context.js';
import { httpRequestTool } from '../tools/evidence.js';
import { ToolResultError } from '../tools/errors.js';
import { evidenceRequest } from './http.js';
import * as transport from './target-transport.js';

const name = `fate_http_diagnostics_${process.pid}`;
let db: Database, dir: string, ctx: ToolRunContext;
let source: http.Server, destination: http.Server, base: string, next: string;
const seen: { path: string; headers: http.IncomingHttpHeaders }[] = [];
const listen = async (server: http.Server) => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
beforeAll(async () => {
  process.env.SERIES_PG_DSN = `postgres://series:series@127.0.0.1:5433/${name}`;
  db = await openDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'fate-http-diagnostics-'));
  configureEvidenceStore(db, dir);
  const task = await db.tasks().createTaskWithOptions('LOCAL HTTP fixture', '', { executionMode: 'manual' });
  ctx = runContext(db, task.id, task.exploration_id, 'worker');
  destination = http.createServer((req, res) => {
    seen.push({ path: req.url!, headers: req.headers });
    if (req.url === '/broken-body') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 100 });
      res.flushHeaders(); res.write('partial');
      setTimeout(() => res.destroy(), 50);
    } else if (req.url === '/waiting') { res.writeHead(200); res.flushHeaders(); }
    else { res.end('LOCAL success'); }
  });
  next = await listen(destination);
  source = http.createServer((req, res) => {
    seen.push({ path: req.url!, headers: req.headers });
    res.writeHead(302, { Location: next + req.url }); res.end('LOCAL redirect');
  });
  base = await listen(source);
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const server of [source, destination]) if (server) {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  }
  await db?.close();
  const p = new pg.Client({ connectionString: 'postgres://series:series@127.0.0.1:5433/postgres' });
  await p.connect(); await p.query(`DROP DATABASE IF EXISTS ${name}`); await p.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('returns the failed redirect hop and saved 302 evidence to the Worker without leaking causes or retrying', async () => {
  const nativeFetch = transport.targetFetch;
  const mock = vi.spyOn(transport, 'targetFetch').mockImplementation(async (url, init) => {
    if (url.startsWith(next)) throw new transport.TargetTransportError('ETIMEDOUT', new Error('SECRET raw socket diagnostics'));
    return nativeFetch(url, init);
  });
  try {
    const tool = httpRequestTool(ctx);
    const result = await tool.execute(randomUUID(), { method: 'GET', url: base + '/login;jsessionid=SECRET?token=SECRET' });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    const data = JSON.parse(text);
    expect(data).toMatchObject({ error_code: 'ETIMEDOUT', failure_phase: 'request', request_hop: 2,
      failed_origin: next, failed_port: Number(new URL(next).port), last_response: { status: 302, origin: base } });
    expect(text).not.toContain('SECRET');
    expect(data.error).toContain('此前已收到 HTTP 302');
    expect(data.redirect_traffic_ids).toEqual([data.last_response.traffic_id]);
    const saved = await db.query('SELECT task_id,status FROM traffic_evidence_snapshots WHERE id=$1', [data.last_response.traffic_id]);
    expect(saved.rows[0]).toMatchObject({ task_id: String(ctx.taskID), status: 302 });
    expect(mock).toHaveBeenCalledTimes(2);
  } finally { mock.mockRestore(); }
});

it('follow_redirects=false records the first response without accessing the Location', async () => {
  const before = seen.length;
  const result = await httpRequestTool(ctx).execute(randomUUID(), { url: base + '/first-only', follow_redirects: false });
  expect(result.isError).not.toBe(true);
  const data = JSON.parse(result.content[0]!.text);
  expect(data).toMatchObject({ status: 302, redirect_location: next + '/first-only', redirect_traffic_ids: [] });
  expect(data.traffic_id).toBeTruthy();
  expect(seen.slice(before)).toHaveLength(1);
});

it('still follows redirects by default and strips cross-origin credentials', async () => {
  const result = await evidenceRequest(ctx, { url: base + '/success', headers: { Authorization: 'SECRET', Cookie: 'sid=SECRET' } });
  expect(result).toMatchObject({ status: 200, body: 'LOCAL success' });
  expect(result.redirect_traffic_ids).toHaveLength(1);
  const headers = seen.at(-1)!.headers;
  expect(headers.authorization).toBeUndefined(); expect(headers.cookie).toBeUndefined();
});

it('distinguishes incomplete response bodies from missing response headers', async () => {
  const result = await httpRequestTool(ctx).execute(randomUUID(), { url: base + '/broken-body' });
  expect(result.isError).toBe(true);
  const data = JSON.parse(result.content[0]!.text);
  expect(data).toMatchObject({ failure_phase: 'response_body', request_hop: 2, response_status: 200,
    last_response: { status: 302 }, failed_origin: next });
  expect(data.redirect_traffic_ids).toHaveLength(1);
  expect(data.error_code).toBe('UND_ERR_SOCKET');
});

it('keeps host cancellation distinct and does not retry or fabricate a completed response', async () => {
  const controller = new AbortController();
  const reason = new Error('LOCAL user paused');
  const request = evidenceRequest(ctx, { url: next + '/waiting' }, controller.signal);
  const assertion = expect(request).rejects.toBe(reason);
  const timer = setTimeout(() => controller.abort(reason), 50);
  try { await assertion; } finally { clearTimeout(timer); }
});

it('classifies a request deadline during body reading as a timeout, not a user pause', async () => {
  await expect(evidenceRequest(ctx, { url: next + '/waiting' }, AbortSignal.timeout(100)))
    .rejects.toMatchObject({ details: { error_code: 'ETIMEDOUT', failure_phase: 'response_body',
      response_status: 200, request_hop: 1, redirect_traffic_ids: [] } });
});

it('reports zero saved responses honestly for a first-hop timeout', async () => {
  const mock = vi.spyOn(transport, 'targetFetch').mockRejectedValue(new transport.TargetTransportError('ETIMEDOUT', undefined));
  try {
    await expect(evidenceRequest(ctx, { url: base + '/initial' })).rejects.toMatchObject({
      details: { request_hop: 1, failed_origin: base, redirect_traffic_ids: [] },
    });
    expect(mock).toHaveBeenCalledTimes(1);
  } finally { mock.mockRestore(); }
});

it('does not turn a revoked execution lease into a network error', async () => {
  const reason = new Error('LOCAL lease revoked');
  const locked = { ...ctx, hooks: { assertOwnership: async () => { throw reason; } } };
  const before = seen.length;
  await expect(evidenceRequest(locked, { url: base + '/revoked' })).rejects.toBe(reason);
  expect(reason).not.toBeInstanceOf(ToolResultError);
  expect(seen).toHaveLength(before);
});
