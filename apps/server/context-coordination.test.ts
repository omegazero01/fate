import {randomUUID} from 'node:crypto';
import {validateResultEvidence} from './src/tools/coordination.js';
import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime,createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from './src/db/index.js';
import {normalizeContract,validateResult} from './src/agent/intent-contract.js';
import {runContext} from './src/tools/context.js';
import {workerTools,plannerTools} from './src/tools/index.js';
import {searchContext,contextGetTool,workerLaunchContext} from './src/tools/context-read.js';
import {pendingPlannerContext,acknowledgePlannerContext} from './src/db/planner-context.js';
import {Engine,defaultEngineConfig} from './src/engine/engine.js';
import {runWorkerIntent} from './src/agent/roles.js';
import {buildApp} from './src/http/app.js';
import {signJWT} from './src/http/auth.js';
import {rolePrompt} from './src/agent/prompts.js';
import {workerCapabilities} from './src/agent/worker-capabilities.js';
import {buildGraphOverview} from './src/tools/overview.js';

let db:Database;
const name=`series_context_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-context-'));
const engines:Engine[]=[];
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;process.env.SERIES_LOG_LEVEL='silent';db=await openDatabase();});
afterAll(async()=>{for(const e of engines)await e.shutdown();await db?.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});await admin.connect();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(){const task=await db.tasks().createTaskWithOptions('LOCAL context fixture','',{});const s=db.exploration(task.exploration_id);return {task,s,ctx:runContext(db,task.id,task.exploration_id,'planner')};}
const contract=()=>({version:1 as const,objective:'检查指定页面是否存在登录入口',acceptance:['确认登录入口是否存在'],out_of_scope:['其他页面'],basis:[],work:{resource:'https://fixture.invalid/login',question_key:'login_presence',method_class:'read_page',identity:'anonymous'}});
async function execute(tool:ToolDefinition,args:unknown){const r=await tool.execute(randomUUID(),args as never,undefined,undefined,{} as never);return {error:r.isError===true,value:JSON.parse((r.content[0] as {text:string}).text)};}
async function claimed(){const f=await fixture();const id=await f.s.addIntent({summary:'LOCAL intent',contract:contract()},5,[],'planner');await f.s.claimNextWorker('work#1');const ctx=runContext(db,f.task.id,f.task.exploration_id,'worker',{intentID:id,workerName:'work#1'});const tools=Object.fromEntries(workerTools(ctx).map(t=>[t.name,t]));return {...f,id,ctx,tools};}
async function fact(f:Awaited<ReturnType<typeof claimed>>,summary='fixture observed'){const r=await execute(f.tools.record_fact!,{summary,evidence:'LOCAL fixture response, no network',confidence:'high'});expect(r.error).toBe(false);return Number(r.value.fact_id);}
function completion(id:number){return {outcome:'complete',summary:'指定问题已回答，未观察到登录入口',criteria:[{index:0,outcome:'not_supported',fact_ids:[id]}],remaining:''};}
async function legacyResult(f:Awaited<ReturnType<typeof claimed>>,id:number){
 const result=completion(id),basis=await validateResultEvidence(f.ctx,f.id,result as never);
 await db.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('execution_result',$2::jsonb,'execution_result_basis',$3::jsonb) WHERE id=$1",[f.id,JSON.stringify(result),JSON.stringify(basis)]);
}
async function legacyProgress(f:Awaited<ReturnType<typeof claimed>>,progress:object){
 await db.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('progress',$2::jsonb) WHERE id=$1",[f.id,JSON.stringify(progress)]);
}

async function until(fn:()=>Promise<boolean>,ms=10_000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,40));}throw new Error('condition timeout');}
async function model(label:string){const faux=fauxProvider({provider:label});const modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);return {faux,source:{modelRuntime,model:faux.getModel() as never}};}

describe('context coordination',()=>{
 it('rejects unknown execution tool names before any intent in the batch is committed',async()=>{
  const {ctx,s}=await fixture(),tool=plannerTools(ctx).find(t=>t.name==='add_intent')!;
  const result=await execute(tool,{intents:[
   {summary:'valid stage',contract:{...contract(),allowed_tools:['http_request']}},
   {summary:'invalid stage',contract:{...contract(),allowed_tools:['http_get']}},
  ]});
  expect(result.error).toBe(true);expect(JSON.stringify(result.value)).toContain('http_get');
  expect(await s.listByKind('intent')).toHaveLength(0);
  expect((await execute(tool,{intents:[{summary:'corrected stage',contract:{...contract(),allowed_tools:['http_request']}}]})).error).toBe(false);
  expect(await s.listByKind('intent')).toHaveLength(1);
 });
 it('projects actual Worker tools and honors changed bindings instead of stale builtin rows',async()=>{
  const {ctx}=await fixture(),tool=plannerTools(ctx).find(t=>t.name==='add_intent')!;
  const before=(await db.query("SELECT enabled,agents FROM tools WHERE key='http_request'")).rows[0]!;
  try{
   await db.query("INSERT INTO tools(key,agents) VALUES('obsolete_worker_alias','[\"worker\"]')");
   expect((await workerCapabilities(ctx)).tools).toContain('http_request');
   expect((await workerCapabilities(ctx)).tools).not.toContain('obsolete_worker_alias');
   await db.query("UPDATE tools SET agents='[\"pentest\"]' WHERE key='http_request'");
   const overview=await buildGraphOverview(ctx);
   expect((overview.worker_capabilities as any).tools).not.toContain('http_request');
   expect((await execute(tool,{intents:[{summary:'unbound',contract:{...contract(),allowed_tools:['http_request']}}]})).error).toBe(true);
   await db.query("UPDATE tools SET agents=$1,enabled=false WHERE key='http_request'",[JSON.stringify(before.agents)]);
   expect((await workerCapabilities(ctx)).tools).not.toContain('http_request');
  }finally{await db.query("UPDATE tools SET enabled=$1,agents=$2 WHERE key='http_request'",[before.enabled,JSON.stringify(before.agents)]);await db.query("DELETE FROM tools WHERE key='obsolete_worker_alias'");}
 });
 it('accepts enabled custom tools but not disabled ones without running them',async()=>{
  const {ctx}=await fixture(),tool=plannerTools(ctx).find(t=>t.name==='add_intent')!;
  try{
   await db.query("INSERT INTO tools(key,system,kind,agents,exec) VALUES('fixture_custom',false,'http','[\"worker\"]','{\"url\":\"http://fixture.invalid\"}')");
   expect((await workerCapabilities(ctx)).tools).toContain('fixture_custom');
   expect((await execute(tool,{intents:[{summary:'custom',contract:{...contract(),allowed_tools:['fixture_custom']}}]})).error).toBe(false);
   await db.query("UPDATE tools SET enabled=false WHERE key='fixture_custom'");
   expect((await execute(tool,{intents:[{summary:'disabled',contract:{...contract(),allowed_tools:['fixture_custom']}}]})).error).toBe(true);
  }finally{await db.query("DELETE FROM tools WHERE key='fixture_custom'");}
 });
 it('keeps MCP schemas deferred and rejects unbound namespaces without launching services',async()=>{
  const {ctx}=await fixture(),tool=plannerTools(ctx).find(t=>t.name==='add_intent')!;
  const server=(await db.query("INSERT INTO mcp_servers(name,transport,command) VALUES('fixture-mcp','stdio','must-never-start') RETURNING id")).rows[0]!.id;
  try{
   await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id) SELECT id,'mcp',$1 FROM agents WHERE key='worker'",[server]);
   expect((await workerCapabilities(ctx)).mcp).toEqual([expect.objectContaining({namespace:'mcp__fixture_mcp__',validation:'live_discovery_required'})]);
   expect((await workerCapabilities(ctx)).tools).toContain('tool_search');
   expect((await execute(tool,{intents:[{summary:'deferred',contract:{...contract(),allowed_tools:['mcp__fixture_mcp__probe']}}]})).error).toBe(false);
   await db.query("UPDATE agent_visibility SET enabled=false WHERE resource_kind='mcp' AND resource_id=$1",[server]);
   expect((await execute(tool,{intents:[{summary:'revoked',contract:{...contract(),allowed_tools:['mcp__fixture_mcp__probe']}}]})).error).toBe(true);
  }finally{await db.query("DELETE FROM agent_visibility WHERE resource_kind='mcp' AND resource_id=$1",[server]);await db.query('DELETE FROM mcp_servers WHERE id=$1',[server]);}
 });
 it('renders both Planner goal placeholder forms without interpreting user dollar sequences',async()=>{
  const value='LOCAL goal $& $$ $`';
  const stub={platform:()=>({getAgentByKey:async()=>null})} as unknown as Database;
  expect(await rolePrompt(stub,'planner','{{Goal}} / {{.Goal}}',{Goal:value})).toBe(`${value} / ${value}`);
 });
 it('accepts lightweight Planner directions and optional contracts',async()=>{
  const {ctx}=await fixture();const planner=plannerTools(ctx).find(t=>t.name==='add_intent')!;
  expect((await execute(planner,{intents:[{summary:'vague direction'}]})).error).toBe(false);
  expect((await execute(planner,{intents:[{summary:'bounded direction',contract:contract()}]})).error).toBe(false);
 });
 it('normalizes legacy contracts and rejects incomplete completion manifests',()=>{
  const c=normalizeContract(undefined,'check');expect(c.acceptance).toEqual(['check']);
  expect(()=>validateResult({outcome:'complete',summary:'done',criteria:[],remaining:''},c)).toThrow('未回答');
  expect(()=>validateResult({outcome:'blocked',summary:'blocked',criteria:[],remaining:''},c)).toThrow('remaining');
 });
 it('deduplicates paraphrased structured work under concurrent submission and retains completed work',async()=>{
  const {s}=await fixture();const out=await Promise.all(['检查登录页','确认有无登录入口','查看入口'].map(summary=>s.addIntentDeduplicated({summary,contract:contract()},5,[],'planner')));
  expect(out.filter(r=>r.created)).toHaveLength(1);expect(new Set(out.map(r=>r.id)).size).toBe(1);
  await s.setIntentState(out[0]!.id,'done');expect((await s.addIntentDeduplicated({summary:'再次换措辞',contract:contract()},5,[],'planner')).created).toBe(false);
 });
 it('allows an explicit new-evidence retry, rejects stale basis and keeps active retries unique',async()=>{
  const {s,task}=await fixture();const first=await s.addIntent({summary:'original',contract:contract()},1,[],'planner');await s.setIntentState(first,'done');
  const evidence=await s.addNode('fact',{summary:'new fixture observation',evidence:'fixture'},0,'confirmed','test',[]);
  const c={...contract(),basis:[{node_id:evidence,version:0}]};
  const p={summary:'retry',contract:c,retry_of:first,retry_kind:'new_evidence',retry_reason:'new condition observed'};
  const retry=await s.addIntentDeduplicated(p,1,[],'planner');expect(retry.created).toBe(true);
  expect((await s.addIntentDeduplicated(p,1,[],'planner')).id).toBe(retry.id);
  await db.query("UPDATE exploration_nodes SET payload=payload||'{\"detail\":\"changed\"}' WHERE exploration_id=$1 AND id=$2",[task.exploration_id,evidence]);
  await expect(s.addIntentDeduplicated(p,1,[],'planner')).rejects.toThrow('已变化');
 });
 it('rejects a completed-work retry without new evidence and preserves distinct identity contexts',async()=>{
  const {s}=await fixture();const first=await s.addIntent({summary:'original',contract:contract()},1,[],'planner');await s.setIntentState(first,'done');
  await expect(s.addIntentDeduplicated({summary:'retry',contract:contract(),retry_of:first,retry_kind:'transient_failure',retry_reason:'try again'},1,[],'planner')).rejects.toThrow('新的有效');
  const other={...contract(),work:{...contract().work,identity:'authorized-user'}};
  expect((await s.addIntentDeduplicated({summary:'different identity',contract:other},1,[],'planner')).created).toBe(true);
 });
 it('preserves distinct SPA routes and case-sensitive identities in work keys',async()=>{
  const {s}=await fixture();
  for(const [resource,identity] of [['https://fixture.invalid/#/login','Admin'],['https://fixture.invalid/#/settings','Admin'],['https://fixture.invalid/#/login','admin']]){
    expect((await s.addIntentDeduplicated({summary:'same question',contract:{...contract(),work:{...contract().work,resource,identity}}},1,[],'planner')).created).toBe(true);
  }
 });
 it('rejects a stale writer and retains legacy checkpoints across restart',async()=>{
  const f=await claimed(),wrong=workerTools({...f.ctx,workerName:'other'}).find(t=>t.name==='record_fact')!;
  expect((await execute(wrong,{summary:'x',evidence:'LOCAL'})).error).toBe(true);
  await legacyProgress(f,{phase:'blocked',summary:'waiting fixture',attempted:['read page'],blocker:'missing prerequisite',next_step:'resume read'});
  await f.s.resetRunningIntents();expect((await f.s.getNode(f.id))?.payload.progress).toMatchObject({blocker:'missing prerequisite'});
  const start=await workerLaunchContext(f.ctx,f.id);expect(start.progress).toMatchObject({next_step:'resume read'});
 });
 it('validates owned legacy evidence and preserves new negative observations immediately',async()=>{
  const f=await claimed(),other=await claimed();const foreign=await fact(other);
  await expect(validateResultEvidence(f.ctx,f.id,completion(foreign) as never)).rejects.toThrow('不属于');
  const id=await fact(f);expect(await validateResultEvidence(f.ctx,f.id,completion(id) as never)).toHaveLength(1);
  expect((await execute(f.tools.record_fact!,{summary:'new observation',evidence:'LOCAL second observation'})).error).toBe(false);
  expect((await f.s.getNode(f.id))?.state).toBe('running');
 });
 it('rejects unsupported facts and reopens legacy blocked results without reacceptance',async()=>{
  const f=await claimed();expect((await execute(f.tools.record_fact!,{summary:'unsupported claim'})).error).toBe(true);
  const save=()=>db.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('execution_result',$2::jsonb) WHERE id=$1",[f.id,JSON.stringify({outcome:'blocked',summary:'missing prerequisite',criteria:[],remaining:'obtain authorized prerequisite'})]);
  await save();await f.s.setIntentState(f.id,'blocked');await f.s.reopenIntent(f.id);
  expect((await f.s.getNode(f.id))?.payload.execution_result).toBeUndefined();expect((await f.s.getNode(f.id))?.payload.previous_result).toMatchObject({outcome:'blocked'});
  await f.s.claimNextWorker('work#1');await save();await f.s.setIntentState(f.id,'blocked');await f.s.reopenBlockedIntents();expect((await f.s.getNode(f.id))?.payload.execution_result).toBeUndefined();
 });
 it('searches detailed and cold facts with query-bound pagination and stable references',async()=>{
  const {s,ctx}=await fixture();const ids=[];
  for(let i=0;i<7;i++)ids.push(await s.addNode('fact',{summary:`brief ${i}`,detail:'needle in detailed evidence',evidence:'fixture'},0,'confirmed','test',[]));
  const digest=await s.addNode('digest',{summary:'cold summary',member_ids:ids},0,'active','system',[]);for(const id of ids)await s.link(digest,'covers',id);
  const first=await searchContext(ctx,{q:'needle',types:['fact'],limit:3});expect(first.items).toHaveLength(3);
  const second=await searchContext(ctx,{q:'needle',types:['fact'],limit:3,cursor:first.next_cursor!});
  const third=await searchContext(ctx,{q:'needle',types:['fact'],limit:3,cursor:second.next_cursor!});
  expect([...first.items,...second.items,...third.items].map(n=>n.node_id)).toEqual([...ids].reverse());
  await expect(searchContext(ctx,{q:'changed',types:['fact'],limit:3,cursor:first.next_cursor!})).rejects.toThrow('不属于');
  const detail=await execute(contextGetTool(ctx),{ref:first.items[0]!.ref,version:0});expect(detail.value.node.payload.detail).toContain('needle');
  await db.query("UPDATE exploration_nodes SET payload=payload||'{\"summary\":\"changed\"}' WHERE id=$1",[first.items[0]!.node_id]);
  expect((await execute(contextGetTool(ctx),{ref:first.items[0]!.ref,version:0})).error).toBe(true);
 });
 it('exposes only direct read-only sources and retains anchored facts',async()=>{
  const a=await fixture(),b=await fixture(),c=await fixture();
  await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2),($2,$3)',[a.task.id,b.task.id,c.task.id]);
  await b.s.addNode('fact',{summary:'source fact'},0,'confirmed','test',[]);
  expect((await searchContext(a.ctx,{task_id:b.task.id,types:['fact']})).inherited).toBe(true);
  await expect(searchContext(a.ctx,{task_id:c.task.id})).rejects.toThrow('直接来源');
  const asset=await db.assets().upsertSubdomain({domain:'denied.context.invalid',taskID:a.task.id});
  await a.s.addNode('fact',{summary:'hidden-marker'},0,'confirmed','test',[asset]);
  expect((await searchContext(a.ctx,{q:'hidden-marker'})).items).toHaveLength(1);
 });
 it('does not acknowledge late-committing lower event IDs and retries failed planning rounds',async()=>{
  const {task,s,ctx}=await fixture();const n=await s.addNode('fact',{summary:'fixture'},0,'confirmed','test',[]);
  const client=await db.pool.connect();await client.query('BEGIN');
  try{
    const late=Number((await client.query("INSERT INTO exploration_context_events(exploration_id,node_id,kind) VALUES($1,$2,'fact') RETURNING id",[task.exploration_id,n])).rows[0].id);
    await db.query("INSERT INTO exploration_context_events(exploration_id,node_id,kind) VALUES($1,$2,'fact')",[task.exploration_id,n]);
    const batch=await pendingPlannerContext(db,task.id,task.exploration_id);expect(batch.ids).not.toContain(late);
    const round='round-'+task.id;
    expect(await acknowledgePlannerContext(db,task.exploration_id,round,batch.ids)).toBe(true);
    await client.query('COMMIT');
    expect((await pendingPlannerContext(db,task.id,task.exploration_id)).ids).toEqual([late]);
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('keeps budget-omitted context changes pending for the next planning round',async()=>{
  const {task,s,ctx}=await fixture();const ids=[];
  for(let i=0;i<60;i++)ids.push(await s.addNode('fact',{summary:`${i} 重要事实`.repeat(80)},0,'confirmed','test',[]));
  const seen=new Set<number>();let round=0;
  for(;;){
    const batch=await pendingPlannerContext(db,task.id,task.exploration_id);if(!batch.ids.length)break;
    expect(Buffer.byteLength(JSON.stringify(batch.changes))).toBeLessThanOrEqual(12*1024);
    for(const change of batch.changes)seen.add(Number(change.ref.slice(5)));
    const roundID=`budget-${task.id}-${round++}`;
    await acknowledgePlannerContext(db,task.exploration_id,roundID,batch.ids);
  }
  expect(round).toBeGreaterThan(1);expect([...seen].filter(id=>ids.includes(id)).sort((a,b)=>a-b)).toEqual(ids);
 });
 it('runs native pi incremental writeback and ends on a final summary',async()=>{
  const {task,s}=await fixture();const intent=await s.addIntent({summary:'LOCAL complete flow',dispatch_requested:true,contract:contract()},1,[],'planner');
  const {faux,source}=await model('context-native-success');
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('record_fact',{summary:'no login entry',evidence:'LOCAL deterministic fixture, no network',confidence:'high'})]),
    fauxAssistantMessage('result submitted'),
  ]);
  const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(e);await db.query("UPDATE tasks SET execution_mode='manual' WHERE id=$1",[task.id]);await e.run(task.id);
  await until(async()=>(await s.getNode(intent))?.state==='done');
  expect(faux.state.callCount).toBe(2);expect((await s.getNode(intent))?.payload.execution_result).toBeUndefined();
  await e.stop(task.id);
 });
 it('allows a native pi Worker to end with no new facts or completion manifest',async()=>{
  const {task,s}=await fixture();const intent=await s.addIntent({summary:'LOCAL missing result',dispatch_requested:true},1,[],'planner');const {faux,source}=await model('context-native-missing');
  faux.setResponses(Array.from({length:5},()=>fauxAssistantMessage('I am done')));
  const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(e);await db.query("UPDATE tasks SET execution_mode='manual' WHERE id=$1",[task.id]);await e.run(task.id);
  await until(async()=>(await s.getNode(intent))?.state==='done');expect((await s.getNode(intent))?.payload.execution_result).toBeUndefined();expect(faux.state.callCount).toBe(1);await e.stop(task.id);
 });
 it('does not replay target tools when a process restarts after result submission',async()=>{
  const f=await claimed();const id=await fact(f);await legacyResult(f,id);const {faux,source}=await model('context-native-resume');
  const result=await runWorkerIntent({db,taskID:f.task.id,expID:f.task.exploration_id,intent:(await f.s.getNode(f.id))!,workerName:'work#1',model:source,dataDir:dir,maxTurns:5,maxDurationMs:5000,hooks:{},takeSteer:()=>[],onActivity:()=>{}});
  expect(result.stopReason).toBe('completed');expect(faux.state.callCount).toBe(0);
 });
 it('keeps a waiting planner idle until a durable graph change arrives',async()=>{
  const {task,s}=await fixture();await s.addGoal({text:'LOCAL waiting fixture'},'user');await db.query('UPDATE tasks SET plan_heartbeat_seconds=1 WHERE id=$1',[task.id]);const {faux,source}=await model('context-native-wait');
  const waiting=()=>fauxAssistantMessage('Waiting for authorized prerequisite evidence');
  faux.setResponses([waiting()]);
  const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2,heartbeatMs:1000},async()=>source,dir);engines.push(e);await e.run(task.id);
  await until(async()=>faux.state.callCount===1);await until(async()=>(await db.query('SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1 AND acknowledged_at IS NULL',[task.exploration_id])).rowCount===0);
  await new Promise(r=>setTimeout(r,2200));expect(faux.state.callCount).toBe(1);expect(await s.listByKind('intent')).toHaveLength(0);
  faux.appendResponses([waiting()]);
  await s.addNode('fact',{summary:'new prerequisite',evidence:'LOCAL'},0,'confirmed','test',[]);
  await until(async()=>faux.state.callCount===2);faux.appendResponses([waiting()]);
  e.notify(task.id,'user requested re-evaluation of blackboard');
  await until(async()=>faux.state.callCount===3);
  expect(await s.listByKind('intent')).toHaveLength(0);await e.stop(task.id);
 });
 it('rejects stale completion evidence when recovering an already submitted result',async()=>{
  const f=await claimed();const id=await fact(f);await legacyResult(f,id);
  await db.query("UPDATE exploration_nodes SET payload=payload||'{\"evidence\":\"replaced evidence\"}' WHERE id=$1",[id]);
  const {faux,source}=await model('context-stale-result');
  const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(e);await e.run(f.task.id);
  await until(async()=>(await f.s.getNode(f.id))?.state==='blocked');expect(faux.state.callCount).toBe(0);await e.stop(f.task.id);
 });
 it('propagates source changes and pins inherited evidence without writing cross-graph edges',async()=>{
  const a=await fixture(),b=await fixture();await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[a.task.id,b.task.id]);
  const id=await b.s.addNode('fact',{summary:'inherited evidence',evidence:'LOCAL'},0,'confirmed','test',[]);
  expect((await pendingPlannerContext(db,a.task.id,a.task.exploration_id)).changes).toContainEqual(expect.objectContaining({ref:`node:${id}`,source_task_id:b.task.id}));
  const tool=plannerTools(a.ctx).find(t=>t.name==='add_intent')!;
  const created=await execute(tool,{intents:[{summary:'based on source',contract:{...contract(),basis:[{node_id:id,version:0}]}}]});expect(created.error).toBe(false);
  const intent=created.value.intents[0].intent_id;
  expect((await workerLaunchContext(runContext(db,a.task.id,a.task.exploration_id,'worker'),intent)).upstream).toContainEqual(expect.objectContaining({ref:`node:${id}`}));
  expect((await db.query('SELECT 1 FROM exploration_edges WHERE exploration_id=$1 AND src_id=$2',[a.task.exploration_id,id])).rowCount).toBe(0);
 });
 it('keeps complete evidence pageable beyond the tool response budget',async()=>{
  const {s,ctx}=await fixture();const detail='详细证据😀'.repeat(6000);const id=await s.addNode('fact',{summary:'large fixture',detail,evidence:'LOCAL'},0,'confirmed','test',[]);
  let offset=0,text='';const tool=contextGetTool(ctx);
  for(;;){const page=await execute(tool,{ref:`node:${id}`,version:0,offset});expect(page.error).toBe(false);text+=page.value.payload_json;if(page.value.next_offset===null)break;expect(page.value.next_offset).toBeGreaterThan(offset);offset=page.value.next_offset;}
  expect(JSON.parse(text).detail).toBe(detail);
 });
 it('rolls back graph facts and their wake events together',async()=>{
  const {task,s}=await fixture();const before=(await pendingPlannerContext(db,task.id,task.exploration_id)).ids;
  await expect(db.transaction(async tx=>{await tx.exploration(task.exploration_id).addNode('fact',{summary:'rolled back'},0,'confirmed','test',[]);throw new Error('rollback fixture');})).rejects.toThrow('rollback');
  expect((await pendingPlannerContext(db,task.id,task.exploration_id)).ids).toEqual(before);
  expect((await s.listByKind('fact')).some(n=>n.payload.summary==='rolled back')).toBe(false);
 });
 it('retrieves finding reports and invalidates old context versions on report changes',async()=>{
  const {s,ctx,task}=await fixture();const node=await s.addNode('finding',{summary:'LOCAL finding fixture'},0,'confirmed','test',[]);
  await db.query('INSERT INTO findings(task_id,node_id,summary,evidence,report) VALUES($1,$2,$3,$4,$5)',[task.id,node,'fixture','LOCAL evidence','report-only-marker']);
  expect((await searchContext(ctx,{q:'report-only-marker'})).items.map(n=>n.node_id)).toContain(node);
  const detail=await execute(contextGetTool(ctx),{ref:`node:${node}`,version:0});expect(detail.value.node.payload.finding_detail.report).toBe('report-only-marker');
  await db.query("UPDATE findings SET report='updated report' WHERE node_id=$1",[node]);
  expect((await execute(contextGetTool(ctx),{ref:`node:${node}`,version:0})).error).toBe(true);
 });
 it('retains authoritative graph references after native pi compaction',async()=>{
  const {s,ctx}=await fixture();const node=await s.addNode('fact',{summary:'durable fixture',detail:'authoritative-detail-after-compaction',evidence:'LOCAL'},0,'confirmed','test',[]);
  const {faux,source}=await model('context-native-compaction');
  const agentDir=path.join(dir,'compact-agent');
  const loader=new DefaultResourceLoader({cwd:dir,agentDir,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:`当前意图仅查询事实 node:${node}。`});await loader.reload();
    const {session}=await createAgentSession({cwd:dir,agentDir,...source,sessionManager:SessionManager.inMemory(dir),settingsManager:SettingsManager.inMemory({compaction:{enabled:true,keepRecentTokens:500,reserveTokens:4096}}),resourceLoader:loader,tools:['context_get'],customTools:[contextGetTool(ctx)]});
  try{
    faux.setResponses([fauxAssistantMessage('first observation'),fauxAssistantMessage('second observation')]);
    await session.prompt('LOCAL transcript '.repeat(3000));await session.prompt('retain current intent '.repeat(300));
    faux.setResponses([fauxAssistantMessage(`已压缩旧会话；当前意图读取 node:${node}。`)]);
    await session.compact('保留当前意图边界与节点引用');
    let retrieved=false;
    faux.setResponses([fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:`node:${node}`,version:0}]})]),context=>{retrieved=JSON.stringify(context.messages).includes('authoritative-detail-after-compaction');return fauxAssistantMessage('evidence recovered');}]);
    await session.prompt('读取当前意图所需的详细事实');expect(retrieved).toBe(true);
    expect((await s.getNode(node))?.payload.detail).toBe('authoritative-detail-after-compaction');
  }finally{session.dispose();}
 });
 it('preserves committed facts and records blocked when the final model response fails',async()=>{
  const {task,s}=await fixture();const intent=await s.addIntent({summary:'LOCAL result then provider failure',dispatch_requested:true},1,[],'planner');const {faux,source}=await model('context-provider-after-result');
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('record_fact',{summary:'LOCAL observation',evidence:'fixture'})]),
    fauxAssistantMessage('',{stopReason:'error',errorMessage:'fixture provider interruption'}),
  ]);
  const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(e);await db.query("UPDATE tasks SET execution_mode='manual' WHERE id=$1",[task.id]);await e.run(task.id);
  await until(async()=>(await s.getNode(intent))?.state==='blocked');expect(faux.state.callCount).toBe(2);expect((await s.listByKind('fact')).filter(n=>n.payload.from_intent===intent)).toHaveLength(1);await e.stop(task.id);
 });
 it('serves the authorized context projection through the real HTTP route',async()=>{
  const f=await claimed();await legacyProgress(f,{phase:'verifying',summary:'HTTP fixture progress',attempted:['fixture']});
  const e=new Engine(db,defaultEngineConfig(),async()=>{throw new Error('no LLM in HTTP fixture');},dir);engines.push(e);
  const key='local-context-test-key';const app=buildApp({db,engine:e,version:'context-fixture',startedAt:Date.now(),jwtKey:key,skillsRoot:dir,dataDir:dir});
  try{
    const response=await app.inject({method:'GET',url:`/api/exploration/${f.task.exploration_id}/context`,headers:{'X-Series-Token':signJWT(key)}});
    expect(response.statusCode).toBe(200);expect(response.json().running_intents).toContainEqual(expect.objectContaining({id:f.id,progress:expect.objectContaining({summary:'HTTP fixture progress'})}));
  }finally{await app.close();}
 });
});
