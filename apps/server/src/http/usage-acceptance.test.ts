import {beforeAll,afterAll,it,expect} from 'vitest';import pg from 'pg';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {openDatabase,type Database} from '../db/index.js';import {aggregateUsage,backfillUsageLedger} from '../db/usage-ledger.js';import {Engine,defaultEngineConfig} from '../engine/engine.js';import {buildApp} from './app.js';import {signJWT} from './auth.js';import {readTurnSummaries} from '../engine/turn-summary.js';
const name=`fate_usage_accept_${process.pid}`;let db:Database,engine:Engine,app:ReturnType<typeof buildApp>,dir:string,task:number,exp:number,profile:number;const key='LOCAL-usage-api-fixture',headers={'x-series-token':signJWT(key)};
const usage={input:20,output:10,cacheRead:80,cacheWrite:0,totalTokens:110,_quality:'complete'};
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();dir=await mkdtemp(path.join(tmpdir(),'usage-api-'));engine=new Engine(db,defaultEngineConfig(),async()=>null,dir);app=buildApp({db,engine,jwtKey:key,dataDir:dir,skillsRoot:dir,version:'LOCAL',startedAt:Date.now()});
 const t=await db.tasks().createTaskWithOptions('LOCAL multi-agent and human chat','',{executionMode:'manual'});task=t.id;exp=t.exploration_id;
 profile=Number((await db.query("INSERT INTO llm_profiles(name,model,format) VALUES('LOCAL historical name','LOCAL model','openai') RETURNING id")).rows[0]!.id);
 let seq=0;
 for(const role of ['goals','planner','worker','worker','mainagent','mainagent','mainagent','auto','pentest','reporter']){
  seq++;const bound=role!=='auto',conversation=['auto','pentest','reporter'].includes(role)?Number((await db.query('INSERT INTO conversations(agent_key,title,task_id) VALUES($1,$2,$3) RETURNING id',[role,'LOCAL conversation',bound?task:null])).rows[0]!.id):null;
  const turn=`LOCAL-turn-${seq}`,runtime=`LOCAL-runtime-${seq}`,seg=role==='mainagent'?(seq===7?1:0):null;
  if(!conversation)await db.exploration(exp).appendActivity({worker:role,kind:'status',main_seg:seg,metadata:{turn_id:turn,runtime_id:runtime,event_type:'turn_start',role}});
  const audit=await db.query('INSERT INTO llm_request_attempts(task_id,conversation_id,role,profile_id,model,runtime_id,status,usage) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[bound?task:null,conversation,role,profile,'LOCAL model',runtime,'completed',JSON.stringify(usage)]);
  await db.query('UPDATE llm_usage_ledger SET turn_id=$2,main_seg=$3 WHERE audit_id=$1',[audit.rows[0]!.id,turn,seg]);
 }
});
afterAll(async()=>{await engine.shutdown();await app.close();await db.close();const p=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await p.connect();await p.query(`DROP DATABASE ${name}`);await p.end();await rm(dir,{recursive:true,force:true});});
const read=async(url:string)=>{const r=await app.inject({url,headers});expect(r.statusCode,r.body).toBe(200);return r.json();};
it('unifies task, global, profile, conversation, live turn and human segment scopes without double addition',async()=>{
 const global=await read('/api/tokens/usage'),scope=await read(`/api/exploration/tokens?task=${task}`),models=await read(`/api/llm/records/by-model?task=${task}`),tasks=await read('/api/tasks'),conversations=await read('/api/tokens/conversations');
 expect(global.total).toMatchObject({calls:10,input_tokens:1000,output_tokens:100,usage_complete:true});expect(scope.total).toMatchObject({calls:9,input_tokens:900,output_tokens:90});expect(models.models[0]).toMatchObject({calls:9,input_tokens:900,output_tokens:90});expect(tasks.tasks[0].tokens).toMatchObject({calls:9,input_tokens:900,output_tokens:90});
 expect(scope.sessions.find((r:any)=>r.session==='main:0')).toMatchObject({calls:2,input_tokens:200,output_tokens:20});expect(scope.sessions.find((r:any)=>r.session==='main:1')).toMatchObject({calls:1,input_tokens:100});expect(scope.sessions.some((r:any)=>r.session==='main')).toBe(false);expect(scope.session_aliases.main).toMatchObject({is_alias:true,alias_of:['main:0','main:1'],input_tokens:300,output_tokens:30});
 expect(conversations).toHaveLength(3);expect(conversations.reduce((n:number,r:any)=>n+r.input_tokens+r.output_tokens,0)).toBe(330);expect(global.total.input_tokens+global.total.output_tokens).toBe(scope.total.input_tokens+scope.total.output_tokens+110);
 expect((await readTurnSummaries(db,'task',exp,['LOCAL-turn-5']))[0]?.usage).toMatchObject({input:100,uncached_input:20,output:10,total:110,incomplete:false,source:'usage_ledger'});
});
it('uses Shanghai actual request date and preserves profile snapshots through rename, deletion and detail clearing',async()=>{
 await db.query("UPDATE llm_request_attempts SET created_at='2026-10-25T16:00:00Z' WHERE role='goals'");
 // created_at is immutable once captured; real historical fixtures use insert-time snapshots.
 await db.query("INSERT INTO llm_request_attempts(role,model,status,usage,created_at) VALUES('system','LOCAL zero','completed',$1,'2026-10-25T15:59:59Z')",[JSON.stringify({...usage,input:0,output:0,cacheRead:0,totalTokens:0})]);
 const daily=await read('/api/tokens/daily?days=3650');expect(daily.some((r:any)=>r.day==='2026-10-25')).toBe(true);
 await db.query("UPDATE llm_profiles SET name='LOCAL renamed' WHERE id=$1",[profile]);expect((await read('/api/tokens/usage')).by_profile.find((r:any)=>Number(r.profile_id)===profile).profile_name).toBe('LOCAL historical name');
 const before=(await read('/api/tokens/usage')).total;
 await app.inject({method:'DELETE',url:`/api/llm/records?task=${task}`,headers});await db.query('DELETE FROM conversations');await db.query('DELETE FROM llm_profiles WHERE id=$1',[profile]);await db.query('DELETE FROM tasks WHERE id=$1',[task]);await backfillUsageLedger(db);
 expect((await read('/api/tokens/usage')).total).toEqual(before);expect((await read('/api/tokens/conversations')).every((c:any)=>c.deleted&&c.title==='已删除')).toBe(true);
 expect((await app.inject({url:`/api/llm/records/by-model?task=${task}`,headers})).statusCode).toBe(404);
});
