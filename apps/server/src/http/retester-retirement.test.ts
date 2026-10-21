import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,type Database} from '../db/index.js';
import {retireRetester} from '../db/retire-retester.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';
import {buildApp} from './app.js';
import {signJWT} from './auth.js';
import {TriggerScheduler} from '../engine/triggers.js';

const name=`fate_retirement_${process.pid}`,dsn=`postgres://series:series@127.0.0.1:5433/${name}`;
const dir=mkdtempSync(path.join(tmpdir(),'fate-retirement-'));
let db:Database,engine:Engine,app:ReturnType<typeof buildApp>,finding:number,conversation:number,calls=0;
const key='LOCAL retirement',headers={'x-series-token':signJWT(key)};
beforeAll(async()=>{
  process.env.SERIES_PG_DSN=dsn;db=await openDatabase();
  engine=new Engine(db,defaultEngineConfig(),async()=>{calls++;throw new Error('must not run');},dir);
  app=buildApp({db,engine,version:'LOCAL',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});
  const t=await db.tasks().createTaskWithOptions('LOCAL historical finding','',{executionMode:'manual'});
  finding=Number((await db.query("INSERT INTO findings(task_id,name,status) VALUES($1,'LOCAL','confirmed') RETURNING id",[t.id])).rows[0]!.id);
  conversation=Number((await db.query("INSERT INTO conversations(agent_key,title) VALUES('retester','LOCAL historical retest') RETURNING id")).rows[0]!.id);
  await db.query("INSERT INTO finding_retests(finding_id,conversation_id,status,verdict,snapshot,summary,evidence) VALUES($1,$2,'completed','inconclusive','{}','LOCAL conclusion','LOCAL evidence')",[finding,conversation]);
  await db.query("INSERT INTO conversation_activities(conversation_id,worker,kind,summary,detail) VALUES($1,'worker','assistant','LOCAL history','LOCAL full history')",[conversation]);
});
afterAll(async()=>{
  await engine?.shutdown();await app?.close();await db?.close();
  const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});
});
it('retains history and exposes retired sessions as read-only',async()=>{
  const r=await app.inject({url:`/api/exploration/findings/${finding}/retests`,headers});
  expect(r.statusCode).toBe(200);expect(r.json().retests[0]).toMatchObject({status:'completed',verdict:'inconclusive',evidence:'LOCAL evidence'});
  const list=(await app.inject({url:'/api/conversations',headers})).json();
  expect(list.conversations.find((c:any)=>c.id===conversation)).toMatchObject({read_only:true,retired:true});
  expect((await app.inject({url:`/api/conversations/${conversation}/messages`,headers})).json().items[0].detail).toBe('LOCAL full history');
  expect((await app.inject({url:'/api/agents',headers})).json().agents.some((a:any)=>a.key==='retester')).toBe(false);
});
it('blocks new runs, messages, resume-like controls and configuration bypasses',async()=>{
  for(const [method,url,payload] of [
    ['POST',`/api/exploration/findings/${finding}/retests`,{}],
    ['POST','/api/conversations',{agent_key:'retester'}],
    ['POST',`/api/conversations/${conversation}/messages`,{message:'LOCAL'}],
    ['PATCH',`/api/conversations/${conversation}/profile`,{llm_profile_id:null}],
    ['PATCH',`/api/conversations/${conversation}`,{title:'must not rewrite history'}],
    ['DELETE',`/api/conversations/${conversation}`,undefined],
    ['POST',`/api/conversations/${conversation}/stop`,{}],
    ['PUT','/api/agents/retester/config',{enabled:true}],
    ['POST','/api/agents/retester/triggers',{on_finding:true}],
    ['POST','/api/agents',{key:'Retester',name:'Retester'}],
  ] as const){
    const r=await app.inject({method,url,headers,payload});expect(r.statusCode,`${method} ${url}: ${r.body}`).toBe(410);
  }
  expect(calls).toBe(0);
  const batch=(await app.inject({method:'POST',url:'/api/conversations/delete/batch',headers,payload:{ids:[conversation]}})).json();
  expect(batch.items[0]).toMatchObject({id:conversation,ok:false});
  expect((await db.query('SELECT 1 FROM conversation_activities WHERE conversation_id=$1',[conversation])).rowCount).toBe(1);
});
it('cannot resurrect a retired role through seeded configuration or queued triggers',async()=>{
  await db.query("INSERT INTO agents(key,name,role,enabled) VALUES('retester','Retester','assistant',true) ON CONFLICT(key) DO UPDATE SET enabled=true");
  await db.query("INSERT INTO agent_triggers(agent_key,enabled,interval_sec) VALUES('retester',true,1)");
  await db.query("INSERT INTO conversation_runs(conversation_id,message,status) VALUES($1,'LOCAL','queued')",[conversation]);
  await new TriggerScheduler(db).tick();await new TriggerScheduler(db).tick();await engine.conversations.pump();
  expect(calls).toBe(0);
  await retireRetester(db);await retireRetester(db);
  expect((await db.query("SELECT enabled FROM agents WHERE key='retester'")).rows[0]?.enabled).toBe(false);
  expect((await db.query('SELECT status FROM conversation_runs WHERE conversation_id=$1',[conversation])).rows[0]?.status).toBe('stopped');
  expect((await db.query('SELECT status FROM findings WHERE id=$1',[finding])).rows[0]?.status).toBe('confirmed');
  expect((await db.query('SELECT status,summary FROM finding_retests WHERE conversation_id=$1',[conversation])).rows[0]).toEqual({status:'completed',summary:'LOCAL conclusion'});
});
