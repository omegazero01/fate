import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {postgresDSN} from '../config/index.js';
import {openDatabase,Database} from '../db/index.js';
import {LiveStreamWriter} from '../engine/live-stream.js';
import {readTurnSummaries} from '../engine/turn-summary.js';
import {beginPlannerDisplayRound,finishPlannerDisplayRound} from '../db/planner-rounds.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';
import {buildApp} from './app.js';
import {signJWT} from './auth.js';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';

const name=`fate_chat_stream_${process.pid}`,connection=new URL(postgresDSN().dsn);
connection.pathname=`/${name}`;const dsn=connection.toString();
connection.pathname='/postgres';const adminDSN=connection.toString();
const dir=mkdtempSync(path.join(tmpdir(),'chat-stream-')),key='chat-stream-regression-secret';
let db:Database,other:Database,engine:Engine,app:ReturnType<typeof buildApp>,origin:string,token:string;
const aborts:AbortController[]=[];
const faux=fauxProvider({provider:'chat-stream-regression'});
let runtime:ModelRuntime;
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=dsn;db=await openDatabase();other=new Database(new pg.Pool({connectionString:dsn}));
 runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
 engine=new Engine(db,{...defaultEngineConfig(),workers:1},async()=>({model:faux.getModel() as never,modelRuntime:runtime}),dir);
 app=buildApp({db:other,engine,version:'chat-test',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});
 await app.listen({host:'127.0.0.1',port:0});origin=`http://127.0.0.1:${(app.server.address() as any).port}`;token=signJWT(key);
});
afterAll(async()=>{for(const a of aborts)a.abort();await engine.shutdown();await app.close();await other.close();await db.close();const c=new pg.Client({connectionString:adminDSN});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});});
async function wait(fn:()=>boolean|Promise<boolean>){const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('SSE condition timed out');}
async function stream(url:string){
 const ac=new AbortController();aborts.push(ac);const frames:{event:string;data:any;id:number}[]=[];
 const response=await fetch(`${origin}${url}${url.includes('?')?'&':'?'}token=${token}`,{signal:ac.signal});expect(response.status).toBe(200);
 const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
 void(async()=>{for(;;){const r=await reader.read();if(r.done)break;buffer+=decoder.decode(r.value,{stream:true});let index;while((index=buffer.indexOf('\n\n'))>=0){const raw=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=raw.split('\n').find(s=>s.startsWith('data: '));if(data)frames.push({event:raw.split('\n').find(s=>s.startsWith('event: '))?.slice(7)??'message',data:JSON.parse(data.slice(6)),id:Number(raw.match(/^id: (\d+)/)?.[1])||0});}}})().catch(()=>{});
 return {frames,close:()=>ac.abort()};
}
it('shared snapshots stream both channels before completion and reconnect on another DB connection',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL stream','',{executionMode:'manual'});
 const writer=new LiveStreamWriter(db,'task',task.exploration_id,{worker:'main',main_seg:2,turn_id:'turn-a'});
 const a=await stream(`/api/exploration/activity/stream?task=${task.id}`);
 writer.push({kind:'assistant_delta',streamID:'message-a',text:'思考',isThinking:true});writer.push({kind:'assistant_delta',streamID:'message-a',text:'中文'});
 await wait(()=>a.frames.some(f=>f.event==='streams'&&f.data.items.length===2));
 expect((await db.query('SELECT id FROM activity WHERE exploration_id=$1',[task.exploration_id])).rowCount).toBe(0);
 a.close();const b=await stream(`/api/exploration/activity/stream?task=${task.id}`);
 await wait(()=>b.frames.some(f=>f.event==='streams'&&f.data.items.some((s:any)=>s.text==='中文')));
 writer.push({kind:'assistant_delta',streamID:'message-a',text:'内容'});
 await wait(()=>b.frames.some(f=>f.event==='delta'&&f.data.text==='内容'&&f.data.offset===2));
 const seq=await db.exploration(task.exploration_id).appendActivity({worker:'main',main_seg:2,kind:'text',detail:'中文内容',metadata:{turn_id:'turn-a',stream_id:'message-a',channel:'text'}});
 await writer.committed('message-a','text');
 await wait(()=>b.frames.some(f=>f.event==='message'&&f.id===seq&&f.data.stream_id==='message-a'));
 expect((await other.query("SELECT 1 FROM agent_stream_snapshots WHERE stream_id='message-a' AND channel='text'")).rowCount).toBe(0);
 await writer.close();b.close();
});
it('aborted provider output remains visible and is explicitly non-live',async()=>{
 const conv=await engine.conversations.create('auto','LOCAL interrupted');const id=Number(conv.id);
 const writer=new LiveStreamWriter(db,'conversation',id,{worker:'assistant',turn_id:'interrupted'});
 writer.push({kind:'assistant_delta',streamID:'partial',text:'未完成'});await writer.close();
 const s=await stream(`/api/conversations/${id}/messages/stream`);
 await wait(()=>s.frames.some(f=>f.event==='message'&&f.data.detail==='未完成'&&f.data.interrupted===true));
 expect((await db.query("SELECT 1 FROM agent_stream_snapshots WHERE scope='conversation' AND scope_id=$1",[id])).rowCount).toBe(0);s.close();
});
it('native Main messages/tools and final lifecycle share one identity; request replay never calls the model twice',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL main','',{executionMode:'manual'});
 faux.setResponses([fauxAssistantMessage([fauxToolCall('list_findings',{})]),fauxAssistantMessage('LOCAL 完整回复')]);
 await engine.mainChat(task.id,'你好',0,undefined,'main-request');
 const rows=(await db.query("SELECT kind,metadata FROM activity WHERE exploration_id=$1 ORDER BY id",[task.exploration_id])).rows;
 expect(rows.some(r=>r.kind==='tool_use')).toBe(true);expect(rows.filter(r=>['user','tool_use','tool_result','text','result'].includes(String(r.kind))).every(r=>(r.metadata as any).turn_id==='main-request')).toBe(true);
 expect(rows.findLast(r=>r.kind==='result')?.metadata).toMatchObject({event_type:'lifecycle',status:'completed'});
 const detail=await app.inject({url:`/api/tasks/${task.id}/turns?ids=main-request`,headers:{authorization:`Bearer ${token}`}});
 expect(detail.statusCode).toBe(200);expect(detail.json().items[0]).toMatchObject({steps:2,tool_calls:1,status:'completed',role:'mainagent'});
 expect(detail.json().items[0].final_activity.summary).toBe('LOCAL 完整回复');
 const foreign=await db.tasks().createTaskWithOptions('LOCAL other','',{executionMode:'manual'});
 expect((await app.inject({url:`/api/tasks/${foreign.id}/turns?ids=main-request`,headers:{authorization:`Bearer ${token}`}})).json().items).toEqual([]);
 const before=rows.length;await engine.mainChat(task.id,'你好',0,undefined,'main-request');expect((await db.query('SELECT id FROM activity WHERE exploration_id=$1',[task.exploration_id])).rows).toHaveLength(before);
 expect((await db.query('SELECT 1 FROM agent_stream_snapshots WHERE scope=\'task\' AND scope_id=$1',[task.exploration_id])).rowCount).toBe(0);
});
it('independent conversation preserves turn and stream identity with terminal SSE status',async()=>{
 const conv=await engine.conversations.create('auto','LOCAL auto');const id=Number(conv.id);
 faux.setResponses([fauxAssistantMessage('LOCAL Auto 回复')]);
 const s=await stream(`/api/conversations/${id}/messages/stream`);
 const first=await engine.conversations.enqueue(id,'hello',[],'auto-request');
 await wait(async()=>!!(await db.query("SELECT id FROM conversation_runs WHERE id=$1 AND status='completed'",[first.run_id])).rowCount);
 const again=await engine.conversations.enqueue(id,'hello',[],'auto-request');expect(again.run_id).toBe(first.run_id);
 await wait(()=>s.frames.some(f=>f.event==='message'&&f.data.metadata?.event_type==='lifecycle'));
 const rows=(await db.query('SELECT kind,metadata FROM conversation_activities WHERE conversation_id=$1 ORDER BY id',[id])).rows;
 expect(rows.every(r=>(r.metadata as any).turn_id==='auto-request')).toBe(true);
 expect(rows.find(r=>r.kind==='assistant')?.metadata).toMatchObject({stream_id:expect.any(String)});
 await wait(()=>s.frames.some(f=>f.event==='turn_summary'&&f.data.items.some((v:any)=>v.status==='completed'&&v.steps===1)));
 const detail=await app.inject({url:`/api/conversations/${id}/turns?ids=auto-request`,headers:{authorization:`Bearer ${token}`}});expect(detail.json().items[0]).toMatchObject({steps:1,tool_calls:0,role:'auto',status:'completed'});s.close();
});
it('SSE requires authentication and stops when the task is removed',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL revoke','',{executionMode:'manual'});
 const noAuth=await fetch(`${origin}/api/exploration/activity/stream?task=${task.id}`);expect(noAuth.status).toBe(401);
 const s=await stream(`/api/exploration/activity/stream?task=${task.id}`);await db.query('UPDATE tasks SET deleted_at=now() WHERE id=$1',[task.id]);await wait(()=>s.frames.some(f=>f.event==='access_revoked'));s.close();
});
it('final commit between poll queries never removes the partial body before its durable replacement',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL atomic replacement','',{executionMode:'manual'});
 const writer=new LiveStreamWriter(db,'task',task.exploration_id,{worker:'main',turn_id:'atomic-turn'});
 writer.push({kind:'assistant_delta',streamID:'atomic-stream',text:'保持可见'});
 await wait(async()=>!!(await db.query("SELECT 1 FROM agent_stream_snapshots WHERE stream_id='atomic-stream'")).rowCount);
 const original=other.query.bind(other);let armed=true,finalID=0;
 // Inject a commit immediately after one activity read. Snapshot reads must
 // precede it, otherwise this poll publishes [] while the final row is absent.
 other.query=(async(sql:string,args?:unknown[])=>{
  const rows=await original(sql,args);
  if(armed&&(sql.startsWith('SELECT * FROM activity')||sql.startsWith('WITH page AS MATERIALIZED'))&&args?.[0]===task.exploration_id){
   armed=false;
   finalID=await db.exploration(task.exploration_id).appendActivity({worker:'main',kind:'text',detail:'保持可见完成',metadata:{turn_id:'atomic-turn',stream_id:'atomic-stream',channel:'text'}});
   await writer.committed('atomic-stream','text');
  }
  return rows;
 }) as typeof other.query;
 try{
  const s=await stream(`/api/exploration/activity/stream?task=${task.id}`);
  await wait(()=>s.frames.some(f=>f.event==='message'&&f.id===finalID)&&s.frames.some(f=>f.event==='streams'&&!f.data.items.length));
  const finalAt=s.frames.findIndex(f=>f.event==='message'&&f.id===finalID);
  const removedAt=s.frames.findIndex(f=>f.event==='streams'&&!f.data.items.length);
  expect(finalAt).toBeLessThan(removedAt);
  expect(s.frames.slice(finalAt+1).some(f=>f.event==='delta'&&f.data.stream_id==='atomic-stream')).toBe(false);s.close();
 }finally{other.query=original;await writer.close();}
});
it('graceful HTTP shutdown closes SSE without waiting for the browser to disconnect',async()=>{
 const server=buildApp({db:other,engine,version:'shutdown-test',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});
 await server.listen({host:'127.0.0.1',port:0});
 const task=await db.tasks().createTaskWithOptions('LOCAL shutdown','',{executionMode:'manual'});
 const ac=new AbortController();
 try{
  const response=await fetch(`http://127.0.0.1:${(server.server.address() as any).port}/api/exploration/activity/stream?task=${task.id}&token=${token}`,{signal:ac.signal});
  const drain=(async()=>{for await(const _ of response.body!){};})();
  await Promise.race([server.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('SSE prevented graceful shutdown')),1500))]);
  await drain;
 }finally{ac.abort();await server.close();}
});
it('recovered turns include all runtime attempts and only use the latest executor liveness',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL recovered summary','',{executionMode:'manual'});
 for(const [id,model] of [['summary-old','old-model'],['summary-new','new-model']]){
  await db.query(`INSERT INTO runtime_role_configs(id,task_id,role,configured,effective,expires_at,finished_at)
   VALUES($1,$2,'worker','{}','{}',now()+interval '20 seconds',CASE WHEN $1='summary-old' THEN now() ELSE NULL END)`,[id,task.id]);
  await db.exploration(task.exploration_id).appendActivity({worker:'work#1',kind:'status',metadata:{turn_id:'recovered',event_type:'turn_start',runtime_id:id,role:'worker',started_at:new Date().toISOString()}});
  await db.query(`INSERT INTO llm_request_attempts(task_id,role,model,status,purpose,runtime_id,usage,finished_at)
   VALUES($1,'worker',$2,'completed','conversation',$3,'{"input":10,"output":5}',now())`,[task.id,model,id]);
 }
 const [summary]=await readTurnSummaries(db,'task',task.exploration_id,['recovered']);
 expect(summary).toMatchObject({status:'running',models:['old-model','new-model'],usage:{total:30}});
});
it('summary batches retain authentication, task isolation, and revoked node visibility',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL summary access','',{executionMode:'manual'});
 const asset=await db.assets().upsertHTTPService({url:'http://summary.local.invalid',taskID:task.id});
 const intent=await db.exploration(task.exploration_id).addIntent({summary:'LOCAL only'},1,[asset],'user');
 await db.exploration(task.exploration_id).appendActivity({node_id:intent,worker:'work#1',kind:'text',summary:'private',metadata:{turn_id:'protected'}});
 const url=`/api/tasks/${task.id}/turns?ids=protected`,headers={authorization:`Bearer ${token}`};
 expect((await app.inject({url})).statusCode).toBe(401);
 expect((await app.inject({url,headers})).json().items).toHaveLength(1);
 const parent=Number((await db.query("SELECT a.id FROM assets a JOIN task_asset_links l ON l.asset_id=a.id WHERE l.task_id=$1 AND a.type IN ('root_domain','subdomain') AND a.domain='summary.local.invalid'",[task.id])).rows[0]!.id);
 await db.query('UPDATE tasks SET deleted_at=now() WHERE id=$1',[task.id]);
 expect((await app.inject({url,headers})).statusCode).toBe(404);

});

it('steering history/list/search and replay normalize legacy activity without mutating stored users',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL steering history','',{executionMode:'manual'}),store=db.exploration(task.exploration_id);
 const intent=await store.addIntent({summary:'LOCAL read-only fixture'},1,[],'user');
 const seq=await store.appendActivity({node_id:intent,worker:'work#1',kind:'user',summary:'LOCAL steering history',detail:'LOCAL full original',metadata:{event_type:'steering',source:'planner'}});
 const current=await store.appendActivity({node_id:intent,worker:'work#1',kind:'status',tool:'steer_work',summary:'LOCAL Main notice',metadata:{event_type:'steering',turn_id:'notice-turn',steering:{id:'local-id',source:'mainagent',target_turn_id:'notice-turn',intent_id:intent,status:'submitted'}}});
 for(const url of [`/api/exploration/activity?task=${task.id}`,`/api/exploration/activity/history?task=${task.id}&session=intent:${intent}`]){
  const r=await app.inject({url,headers:{authorization:`Bearer ${token}`}});expect(r.statusCode).toBe(200);
  expect(r.json().items.find((a:any)=>a.seq===seq)).toMatchObject({kind:'status',tool:'steer_work',summary:'LOCAL steering history',metadata:{source:'planner'}});
  expect(r.json().items.find((a:any)=>a.seq===current)).toMatchObject({turn_id:'notice-turn',metadata:{steering:{source:'mainagent',status:'submitted'}}});
 }
 const search=await app.inject({url:`/api/exploration/activity/search?task=${task.id}&session=intent:${intent}&q=steering`,headers:{authorization:`Bearer ${token}`}});
 expect(search.json().items).toContainEqual(expect.objectContaining({id:seq,kind:'status'}));
 const s=await stream(`/api/exploration/activity/stream?task=${task.id}`);await wait(()=>s.frames.some(f=>f.id===current));
 expect(s.frames.find(f=>f.id===seq)?.data).toMatchObject({kind:'status',tool:'steer_work',metadata:{source:'planner'}});s.close();
 expect((await db.query('SELECT kind,detail,metadata FROM activity WHERE id=$1',[seq])).rows[0]).toEqual({kind:'user',detail:'LOCAL full original',metadata:{event_type:'steering',source:'planner'}});
});

it('Planner boundaries survive list/history pagination and SSE reconnect, with replayable title updates',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL planner headers','LOCAL synthetic',{executionMode:'manual'}),store=db.exploration(task.exploration_id);
 const old=await store.appendActivity({worker:'planner',kind:'round',summary:'第 258 轮规划'});
 const ignored=await store.appendActivity({worker:'work#1',kind:'round',summary:'old worker marker'});
 await beginPlannerDisplayRound(db,task.exploration_id,'round-header');
 const start=Number((await db.query("SELECT id FROM activity WHERE exploration_id=$1 AND metadata->>'event_type'='planner_round_start'",[task.exploration_id])).rows[0]!.id);
 for(const url of [`/api/exploration/activity?task=${task.id}`,`/api/exploration/activity/history?task=${task.id}&session=plan&limit=1&before=${start+1}`]){
  const r=await app.inject({url,headers:{authorization:`Bearer ${token}`}});expect(r.statusCode).toBe(200);
  expect(r.json().items.find((a:any)=>a.seq===start)).toMatchObject({kind:'round',metadata:{planner_round:{number:259,title:null}}});
  expect(r.json().items.some((a:any)=>a.seq===ignored)).toBe(false);
 }
 const history=await app.inject({url:`/api/exploration/activity/history?task=${task.id}&session=plan&before=${start}`,headers:{authorization:`Bearer ${token}`}});
 expect(history.json().items.find((a:any)=>a.seq===old)?.summary).toBe('第 258 轮规划');
 const a=await stream(`/api/exploration/activity/stream?task=${task.id}`);
 await wait(()=>a.frames.some(f=>f.id===start));
 await finishPlannerDisplayRound(db,task.exploration_id,'round-header','文件上传全面探测');
 await wait(()=>a.frames.some(f=>f.event==='turn_summary'&&f.data.items.some((v:any)=>v.planner_round?.title==='文件上传全面探测')));
 a.close();const b=await stream(`/api/exploration/activity/stream?task=${task.id}`);
 await wait(()=>b.frames.some(f=>f.event==='turn_summary'&&f.data.items.some((v:any)=>v.planner_round?.number===259&&v.planner_round.title==='文件上传全面探测')));b.close();
});
