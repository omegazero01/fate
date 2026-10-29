import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import http from 'node:http';
import {openDatabase,type Database} from '../db/index.js';import {Engine,defaultEngineConfig} from '../engine/engine.js';import {buildApp} from './app.js';import {signJWT} from './auth.js';import {activityStreamMetrics} from './activity-stream.js';
const name=`fate_perf_tests_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-perf-tests-'));let db:Database,engine:Engine,app:ReturnType<typeof buildApp>,origin:string;
const token=signJWT('perf-test-key'),headers={authorization:`Bearer ${token}`},clients:AbortController[]=[];
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();engine=new Engine(db,defaultEngineConfig(),async()=>{throw new Error('No model should load');},dir);app=buildApp({db,engine,version:'perf-test',startedAt:Date.now(),jwtKey:'perf-test-key',dataDir:dir,skillsRoot:dir});await app.listen({host:'127.0.0.1',port:0});origin=`http://127.0.0.1:${(app.server.address() as any).port}`;});
afterAll(async()=>{for(const c of clients)c.abort();await engine.shutdown();await app.close();await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});});
const wait=async(fn:()=>boolean|Promise<boolean>,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error('condition timed out');};
const request=async(url:string)=>{const r=await app.inject({url,headers});expect(r.statusCode).toBe(200);return r.json();};
it('paginates 10,000 rows with stable filters, exact totals and a bounded query count',async()=>{
 await db.query(`WITH e AS (INSERT INTO explorations(description,goal) SELECT 'LOCAL history '||g,'history' FROM generate_series(1,10000) g RETURNING id)
 INSERT INTO tasks(name,description,goal,exploration_id,status,completed_at) SELECT 'item '||id,'LOCAL history','history',id,'done',now() FROM e`);
 const start=db.runtimeMetrics().queries;const first=await request('/api/tasks?page=1&page_size=20&sort=id&direction=asc');
 expect(first.total).toBe(10000);expect(first.tasks).toHaveLength(20);expect(db.runtimeMetrics().queries-start).toBeLessThan(15);
 const second=await request('/api/tasks?page=2&page_size=20&sort=id&direction=asc');expect(Number(second.tasks[0].id)).toBeGreaterThan(Number(first.tasks.at(-1).id));
 const exact=await request('/api/tasks?page=1&q=item%209999');expect(exact.total).toBe(1);expect(exact.tasks[0].name).toBe('item 9999');
 const empty=await request('/api/tasks?page=20&status=running');expect(empty).toMatchObject({total:0,page:1,tasks:[]});
 expect((await request('/api/tasks/summary')).by_status.done).toBe(10000);
 expect((await request('/api/tasks?page=1&page_size=999')).tasks).toHaveLength(100);
 for(const query of ['page=Infinity','page=1.5','category=nope'])expect((await app.inject({url:`/api/tasks?${query}`,headers})).statusCode).toBe(400);
});
it('shares one idle source for 20 clients and rejects unauthenticated metrics',async()=>{
 const t=await db.tasks().createTaskWithOptions('LOCAL shared','',{executionMode:'manual'});
 for(let i=0;i<20;i++){const ac=new AbortController();clients.push(ac);const r=await fetch(`${origin}/api/exploration/activity/stream?task=${t.id}`,{headers,signal:ac.signal});void(async()=>{for await(const _ of r.body as any){}})().catch(()=>{});}
 await wait(()=>activityStreamMetrics().clients===20);await new Promise(r=>setTimeout(r,300));const before=db.runtimeMetrics().queries;
 await new Promise(r=>setTimeout(r,2100));expect(db.runtimeMetrics().queries-before).toBeLessThan(30);expect(activityStreamMetrics().sources).toBe(1);
 expect((await app.inject({url:'/api/runtime/metrics'})).statusCode).toBe(401);
 const m=await request('/api/runtime/metrics');expect(m.streams.clients).toBe(20);expect(JSON.stringify(m)).not.toMatch(/api_key|systemPrompt|evidence/);
 for(const ac of clients)ac.abort();await wait(()=>activityStreamMetrics().clients===0);
});
it('bounds a stalled reader, disconnects it, and replays every durable row from its cursor',async()=>{
 const t=await db.tasks().createTaskWithOptions('LOCAL slow','',{executionMode:'manual'});
 const rows=(await db.query(`INSERT INTO activity(exploration_id,worker,kind,summary,detail) SELECT $1,'main','text','LOCAL long',repeat('x',65536) FROM generate_series(1,180) RETURNING id`,[t.exploration_id])).rows;
 const stalled=http.get(`${origin}/api/exploration/activity/stream?task=${t.id}`,{headers},response=>response.pause());stalled.on('error',()=>{});
 try{await wait(()=>activityStreamMetrics().clients===1);await wait(()=>activityStreamMetrics().blocked_clients===1);expect(activityStreamMetrics().buffered_bytes).toBeLessThanOrEqual(1024*1024);await wait(()=>activityStreamMetrics().clients===0,12000);
 const since=Number(rows[89]!.id),ac=new AbortController();clients.push(ac);const r=await fetch(`${origin}/api/exploration/activity/stream?task=${t.id}&since=${since}`,{headers,signal:ac.signal});const ids:number[]=[];
 void(async()=>{const reader=r.body!.getReader(),d=new TextDecoder();let text='';for(;;){const v=await reader.read();if(v.done)break;text+=d.decode(v.value,{stream:true});let k;while((k=text.indexOf('\n\n'))>=0){const frame=text.slice(0,k);text=text.slice(k+2);const id=Number(frame.match(/^id: (\d+)/m)?.[1]);if(id)ids.push(id);}}})().catch(()=>{});
 await wait(()=>ids.length===90);expect(ids).toEqual(rows.slice(90).map(r=>Number(r.id)));ac.abort();
 }finally{stalled.destroy();}
});
