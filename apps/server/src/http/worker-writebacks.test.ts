import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {postgresDSN} from '../config/index.js';
import {openDatabase,type Database} from '../db/index.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';
import {buildApp} from './app.js';
import {signJWT} from './auth.js';
import {runContext} from '../tools/context.js';
import {recordFactTool} from '../tools/graph.js';
import {reportFindingTool} from '../tools/findings.js';
import {insertAssetsTool} from '../tools/assets.js';
import {migrateWorkerWritebackPrompt,WORKER_WRITEBACK_GUIDANCE} from '../agent/worker-writeback-prompt.js';
import {WORKER_PROMPT,composeRolePrompt,hostProtocol,promptHash,resolveRolePrompt} from '../agent/prompts.js';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';

const name=`fate_writebacks_${process.pid}`,connection=new URL(postgresDSN().dsn);
connection.pathname=`/${name}`;const dsn=connection.toString();connection.pathname='/postgres';const adminDSN=connection.toString();
const previousDSN=process.env.SERIES_PG_DSN,key='local-writeback-fixture',headers={'x-series-token':signJWT(key)};
let db:Database,engine:Engine,app:ReturnType<typeof buildApp>,dir:string;
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=dsn;db=await openDatabase();dir=await mkdtemp(path.join(tmpdir(),'worker-writebacks-'));
 engine=new Engine(db,defaultEngineConfig(),async()=>null,dir);
 app=buildApp({db,engine,version:'writebacks-test',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});
});
afterAll(async()=>{await engine?.shutdown();await app?.close();await db?.close();const c=new pg.Client({connectionString:adminDSN});await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name}`);await c.end();if(dir)await rm(dir,{recursive:true,force:true});if(previousDSN===undefined)delete process.env.SERIES_PG_DSN;else process.env.SERIES_PG_DSN=previousDSN;});
async function fixture(){
 const task=await db.tasks().createTaskWithOptions('LOCAL 写回表格','',{executionMode:'manual'}),store=db.exploration(task.exploration_id);
 const intent=await store.addIntent({summary:'仅整理本地合成资料'},1,[],'user');
 await db.query("UPDATE exploration_nodes SET state='running',owner='work#1' WHERE id=$1",[intent]);
 const ctx={...runContext(db,task.id,task.exploration_id,'worker'),intentID:intent,workerName:'work#1'};
 const activity=(turn:string,kind:string,extra:Record<string,unknown>={})=>store.appendActivity({worker:'work#1',node_id:intent,kind,...extra,metadata:{turn_id:turn,...extra.metadata as object}});
 const start=(turn:string)=>activity(turn,'status',{metadata:{event_type:'turn_start',role:'worker'}});
 const end=(turn:string,status='done')=>activity(turn,'result',{summary:'合成结论',metadata:{event_type:'outcome',status}});
 async function call(turn:string,id:string,tool:ToolDefinition,args:unknown){
   await activity(turn,'tool_use',{tool_use_id:id,tool:tool.name});
   const r=await tool.execute(id,args as never,undefined,undefined,{} as never);
   await activity(turn,'tool_result',{tool_use_id:id,tool:tool.name,is_error:r.isError===true});
   return JSON.parse((r.content[0] as {text:string}).text);
 }
 const get=(turn:string,query='')=>app.inject({url:`/api/tasks/${task.id}/turns/${turn}/writebacks${query}`,headers});
 return {task,store,intent,ctx,activity,start,end,call,get};
}
it('projects committed assets, batch partial facts and findings; neither anchor nor prose is a write receipt',async()=>{
 const f=await fixture();await f.start('one');
 const anchor=await db.assets().upsertHTTPService({url:'http://127.0.0.1:18899',taskID:f.task.id});
 await db.query('INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2)',[f.intent,anchor]);
 const assets=await f.call('one','assets',insertAssetsTool(f.ctx),{assets:[{type:'endpoint',url:'http://127.0.0.1:18899/forum',method:'GET'},{type:'invalid'}]});
 const facts=await f.call('one','facts',recordFactTool(f.ctx),{facts:[{summary:'在本次测试中未发现注入',evidence:'LOCAL',detail:'匿名写入线索待核实；测试副作用为两条合成数据。',observation_type:'negative',confidence:'high'},{summary:'缺失证据'}]});
 const finding=await f.call('one','finding',reportFindingTool(f.ctx),{summary:'LOCAL confirmed',evidence:'LOCAL proof',severity:'low',vulnclass:'fixture'});
 await f.activity('one','text',{summary:'模型声称写回了资产999999，此文字不能进入表格。'});await f.end('one');
 const r=await f.get('one');expect(r.statusCode,r.body).toBe(200);const data=r.json();
 expect(data).toMatchObject({complete:true,counts:{current:{asset:1,fact:1,finding:1,total:3}}});
 expect(data.items.map((x:any)=>x.record_id)).toEqual(expect.arrayContaining([String(assets.results[0].id),String(facts.fact_ids[0]),String(finding.finding_id)]));
 expect(data.items.find((x:any)=>x.kind==='fact')).toMatchObject({observation_type:'negative',confidence:'high'});
 expect(data.items.find((x:any)=>x.kind==='finding').detail_ref).toBe(`finding:${finding.finding_id}`);
 const summary=await app.inject({url:`/api/tasks/${f.task.id}/turns?ids=one`,headers});expect(summary.json().items[0].writebacks).toMatchObject({available:true,intent_id:String(f.intent)});
});
it('recovery separates previous writes, idempotent replay and genuinely new records',async()=>{
 const f=await fixture();await f.start('old');const a={summary:'此前结果',evidence:'LOCAL'};
 await f.call('old','stable-call',recordFactTool(f.ctx),a);await f.end('old','paused');await f.start('resumed');
 await f.call('resumed','stable-call',recordFactTool(f.ctx),a);await f.call('resumed','new-call',recordFactTool(f.ctx),{summary:'新结果',evidence:'LOCAL'});await f.end('resumed');
 const current=(await f.get('resumed')).json(),previous=(await f.get('resumed','?bucket=previous')).json();
 expect(current.counts).toMatchObject({current:{fact:1,total:1},previous:{fact:1,total:1}});
 expect(previous.items[0].summary).toBe('此前结果');expect(current.items[0].summary).toBe('新结果');
 expect((await f.get('old')).json().items).toHaveLength(1);
});
it('later recovery assets cannot make an earlier empty turn incomplete',async()=>{
 const f=await fixture();await f.start('before-assets');await f.end('before-assets','paused');
 await f.start('after-assets');await f.call('after-assets','later-assets',insertAssetsTool(f.ctx),{assets:[{type:'endpoint',url:'http://127.0.0.1:18899/later',method:'GET'}]});await f.end('after-assets');
 expect((await f.get('before-assets')).json()).toMatchObject({complete:true,counts:{current:{total:0}},items:[]});
 expect((await f.get('after-assets')).json()).toMatchObject({complete:true,counts:{current:{asset:1,total:1}}});
});
it('counts more than forty writes and pages without duplicate or omitted records',async()=>{
 const f=await fixture();await f.start('many');
 for(let batch=0;batch<3;batch++)await f.call('many',`batch-${batch}`,recordFactTool(f.ctx),{facts:Array.from({length:20},(_,i)=>({summary:`事实 ${batch*20+i}`,evidence:'LOCAL'}))});
 await f.end('many');let cursor:string|null=null;const ids=new Set();
 do{const r=(await f.get('many',`?limit=7${cursor?`&cursor=${cursor}`:''}`)).json();expect(r.counts.current.fact).toBe(60);for(const row of r.items){expect(ids.has(row.key)).toBe(false);ids.add(row.key);}cursor=r.next_cursor;}while(cursor);
 expect(ids.size).toBe(60);
});
it('unknown historical attribution is not represented as a precise empty result',async()=>{
 const f=await fixture();await f.start('legacy');
 const node=await f.store.addNode('fact',{summary:'旧记录',from_intent:f.intent},0,'confirmed','work#1',[]);await f.store.link(f.intent,'yields',node);await f.end('legacy');
 const r=(await f.get('legacy')).json();expect(r.complete).toBe(false);expect(r.notice).toContain('历史');expect(r.items).toEqual([]);
});
it('empty writes are explicit only when provenance is complete, including stopped runs',async()=>{
 const f=await fixture();await f.start('empty');await f.end('empty','exhausted');
 expect((await f.get('empty')).json()).toMatchObject({complete:true,counts:{current:{total:0}},items:[]});
});
it('rejects foreign task/turns, deleted tasks, authentication and forged pagination scopes',async()=>{
 const f=await fixture(),other=await fixture();await f.start('secure');
 await f.call('secure','two',recordFactTool(f.ctx),{facts:[{summary:'a',evidence:'LOCAL'},{summary:'b',evidence:'LOCAL'}]});await f.end('secure');
 expect((await other.get('secure')).statusCode).toBe(404);
 expect((await app.inject({url:`/api/tasks/${f.task.id}/turns/secure/writebacks`})).statusCode).toBe(401);
 for(const q of ['?bucket=unknown','?limit=0','?cursor=invalid'])expect((await f.get('secure',q)).statusCode).toBe(400);
 const cursor=(await f.get('secure','?limit=1')).json().next_cursor;
 expect((await f.get('secure',`?bucket=previous&cursor=${cursor}`)).statusCode).toBe(400);
 await db.query('UPDATE tasks SET deleted_at=now() WHERE id=$1',[f.task.id]);expect((await f.get('secure')).statusCode).toBe(404);
});
it('exact built-in upgrade preserves history, custom prompts, explicit rollback and one host copy',async()=>{
 const agent=await db.platform().getAgentByKey('worker');expect(agent).toBeTruthy();
 const old='LOCAL previous built-in';
 async function select(text:string){const row=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text) SELECT $1,COALESCE(max(version),0)+1,$2 FROM agent_prompts WHERE agent_id=$1 RETURNING id",[agent!.id,text])).rows[0]!;await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent!.id,row.id]);return row.id;}
 const oldID=await select(old);await db.query("DELETE FROM settings WHERE key='worker_writeback_summary_v1'");
 await migrateWorkerWritebackPrompt(db,WORKER_PROMPT,[promptHash(old)]);
 expect(await db.platform().currentPrompt(agent!.id)).toBe(WORKER_PROMPT);
 expect((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[oldID])).rows[0]!.template_text).toBe(old);
 await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent!.id,oldID]);await migrateWorkerWritebackPrompt(db,WORKER_PROMPT,[promptHash(old)]);
 expect(await db.platform().currentPrompt(agent!.id)).toBe(old);
 const custom='LOCAL 自定义提示词';await select(custom);await db.query("DELETE FROM settings WHERE key='worker_writeback_summary_v1'");
 await migrateWorkerWritebackPrompt(db,WORKER_PROMPT,[promptHash(old)]);
 expect(await resolveRolePrompt(db,'worker')).toMatchObject({template:custom,source:'custom',candidate:WORKER_PROMPT});
 for(const body of [WORKER_PROMPT,custom])expect(composeRolePrompt(body,hostProtocol('worker')).split(WORKER_WRITEBACK_GUIDANCE).length-1).toBe(1);
});
