import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {postgresDSN} from '../config/index.js';import {openDatabase,type Database} from '../db/index.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';import {buildApp} from './app.js';import {signJWT} from './auth.js';
const name=`fate_token_usage_${process.pid}`,connection=new URL(postgresDSN().dsn),previous=process.env.SERIES_PG_DSN;
connection.pathname=`/${name}`;const dsn=connection.toString();connection.pathname='/postgres';const adminDSN=connection.toString();
const dir=mkdtempSync(path.join(tmpdir(),'token-usage-')),key='local-token-usage-fixture',headers={'x-series-token':signJWT(key)};
let db:Database,engine:Engine,app:ReturnType<typeof buildApp>,task:number,legacy:number;
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=dsn;db=await openDatabase();engine=new Engine(db,defaultEngineConfig(),async()=>null,dir);
 app=buildApp({db,engine,jwtKey:key,dataDir:dir,skillsRoot:dir,version:'tokens-local',startedAt:Date.now()});
 const current=await db.tasks().createTaskWithOptions('LOCAL audited task','',{executionMode:'manual'});task=current.id;
 const old=await db.tasks().createTaskWithOptions('LOCAL historical task','',{executionMode:'manual'});legacy=old.id;
 for(const [exp,input,cache] of [[current.exploration_id,999999,999999],[old.exploration_id,10,50]])
  {if(exp===current.exploration_id)await db.exploration(exp!).appendActivity({worker:'main',kind:'status',metadata:{turn_id:'audited',event_type:'turn_start',runtime_id:'audited-runtime',role:'mainagent'}});await db.exploration(exp!).appendActivity({worker:'main',kind:'result',metadata:exp===current.exploration_id?{turn_id:'audited'}:{},input_tokens:input,output_tokens:5,cache_read_tokens:cache});}
 const requests=[['original','completed','conversation',{input:20,output:5,cacheRead:180,cacheWrite:30}],['original','completed','compaction',{input:4,output:2,cacheRead:0,cacheWrite:0}],['fallback','failed','conversation',{}],['fallback','running','conversation',{}],['fallback','completed','conversation',{input:0,output:3,cacheRead:100,cacheWrite:0}]];
 for(const [model,status,purpose,usage] of requests)await db.query("INSERT INTO llm_request_attempts(task_id,role,model,status,purpose,usage,runtime_id) VALUES($1,$2,$3,$4,$5,$6,'audited-runtime')",[task,'mainagent',model,status,purpose,JSON.stringify(usage)]);
});
afterAll(async()=>{await app.close();await engine.shutdown();await db.close();const c=new pg.Client({connectionString:adminDSN});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.SERIES_PG_DSN;else process.env.SERIES_PG_DSN=previous;});
const read=(id:number)=>app.inject({url:`/api/llm/records/by-model?task=${id}`,headers});
it('counts actual requests including retry and compaction, without adding host aggregate result rows',async()=>{
 const result=await read(task);expect(result.statusCode).toBe(200);const rows=result.json().models;
 expect(rows).toHaveLength(2);expect(rows.find((r:any)=>r.model==='original')).toMatchObject({calls:2,input_tokens:234,uncached_input_tokens:24,cache_read_tokens:180,cache_write_tokens:30,output_tokens:7,compaction_calls:1,unknown_usage_calls:0});
 expect(rows.find((r:any)=>r.model==='fallback')).toMatchObject({calls:3,input_tokens:100,output_tokens:3,failed_calls:1,pending_calls:1,unknown_usage_calls:2,input_complete:false,input_semantics:'unknown'});
 expect((await read(task)).json()).toEqual(result.json());
});
it('legacy run totals preserve amounts but never fabricate call count, active model, or cache semantics',async()=>{
 expect((await read(legacy)).json().models).toMatchObject([{model:'未记录模型',source:'usage_ledger',input_semantics:'unknown',calls:null,input_tokens:10,output_tokens:5,cache_read_tokens:50,cache_write_tokens:0}]);
});
it('completed in-flight attempts update once instead of duplicating usage',async()=>{
 await db.query("UPDATE llm_request_attempts SET status='completed',usage=$2 WHERE task_id=$1 AND status='running'",[task,JSON.stringify({input:10,output:2,cacheRead:20,cacheWrite:0})]);
 expect((await read(task)).json().models.find((r:any)=>r.model==='fallback')).toMatchObject({calls:3,input_tokens:130,output_tokens:5,pending_calls:0,unknown_usage_calls:1});
});
it('keeps authentication, task isolation, explicit invalid scopes and deleted task detail private while retaining metering',async()=>{
 expect((await app.inject({url:`/api/llm/records/by-model?task=${task}`})).statusCode).toBe(401);
 for(const id of ['bad','0','-1'])expect((await app.inject({url:`/api/llm/records/by-model?task=${id}`,headers})).statusCode).toBe(400);
 expect((await read(99999999)).statusCode).toBe(404);
 await db.query('UPDATE tasks SET deleted_at=now() WHERE id=$1',[task]);expect((await read(task)).statusCode).toBe(404);
 expect((await app.inject({url:'/api/llm/records/by-model',headers})).json().models).toHaveLength(3);
});
