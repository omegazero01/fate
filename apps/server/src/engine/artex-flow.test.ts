import {workerCapabilities,validateWorkerToolNames} from '../agent/worker-capabilities.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';import {seedBuiltins} from '../db/platform.js';import {migrateArtex} from '../db/artex-migration.js';import {insertAssetsTool} from '../tools/assets.js';import {authorizeEvidence} from '../evidence/authorization.js';
import {runContext,TodoStore} from '../tools/context.js';import {addIntentTool} from '../tools/intents.js';import {recordFactTool} from '../tools/graph.js';import {contextGetTool,searchContext} from '../tools/context-read.js';
import {runPlannerRound,runMainChat} from '../agent/roles.js';import {Engine,defaultEngineConfig} from './engine.js';import {Coordinator,executionSnapshot} from './coordinator.js';
const name=`fate_artex_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-artex-'));let db:Database;const engines:Engine[]=[];
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;db=await openDatabase();});
afterAll(async()=>{for(const e of engines)await e.shutdown();await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});});
async function call(tool:any,args:any,id='call-'+Math.random()){const r=await tool.execute(id,args,undefined,undefined,{});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
async function fixture(mode:'manual'|'managed'='manual'){const task=await db.tasks().createTaskWithOptions('LOCAL ARTEX fixture','Keep testing LOCAL fixture',{executionMode:mode});const s=db.exploration(task.exploration_id);return {task,s,c:runContext(db,task.id,task.exploration_id,'planner')};}
async function model(key:string){const f=fauxProvider({provider:key}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(f.provider);return {f,source:{modelRuntime:runtime,model:f.getModel() as never}};}
async function until(fn:()=>Promise<boolean>,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('ARTEX fixture timeout');}
it('submits lightweight intents despite full capacity and unrelated new facts',async()=>{
 const {task,s,c}=await fixture('managed');await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);await db.platform().setSetting('workers','1');
 const coordinator=new Coordinator(db,1),token=(await coordinator.acquire(task.id))!;const slot=(await coordinator.workerSlot(task.id,token))!;
 try{
  const parent=await s.addNode('fact',{summary:'LOCAL parent',evidence:'local'},0,'confirmed','test',[]);
  const saved=await call(addIntentTool(c),{intents:[{summary:'LOCAL follow up',parent_ids:[parent],asset_ids:[],priority:6}]});
  await s.addNode('fact',{summary:'Unrelated concurrent evidence'},0,'confirmed','test',[]);
  expect((await s.getNode(saved.intents[0].intent_id))?.payload.dispatch_requested).toBe(true);
  expect(await coordinator.workerSlot(task.id,token)).toBeUndefined();
  await coordinator.releaseSlot(slot);expect((await s.claimNextWorker('work#test'))?.id).toBe(saved.intents[0].intent_id);
 }finally{await coordinator.release(task.id,token);}
});
it('Planner ends on one normal response without a decision tool or an extra model request',async()=>{
 const {task}=await fixture('managed'),{f,source}=await model('artex-normal-planner');
 f.setResponses([ctx=>{expect(ctx.messages.flatMap(m=>m.role==='system'?m.toolsAdded?.map(t=>t.name)??[]:[])).not.toContain('record_plan_decision');return fauxAssistantMessage('No additional work required.');}]);
 const r=await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal:task.goal,model:source,dataDir:dir,todos:new TodoStore(db),hooks:{},triggersText:'LOCAL',maxTurns:4,onActivity:()=>{}});
 expect(r.stopReason).toBe('completed');expect(f.state.callCount).toBe(1);
});
it('Main receives a host dispatch receipt with one model request and keeps the real source on writes',async()=>{
 const {task,s}=await fixture(),{f,source}=await model('artex-main-receipt');
 f.setResponses([ctx=>{expect(ctx.messages.flatMap(m=>m.role==='system'?m.toolsAdded?.map(t=>t.name)??[]:[])).toEqual(expect.arrayContaining(['bash','write','edit','record_fact','tool_search']));return fauxAssistantMessage([fauxToolCall('record_fact',{summary:'Main LOCAL evidence',evidence:'fixture',confidence:'high'}),fauxToolCall('add_intent',{intents:[{summary:'Main explicit LOCAL work'}]})]);}]);
 const r=await runMainChat({db,taskID:task.id,expID:task.exploration_id,goal:task.goal,model:source,dataDir:dir,segment:7,message:'LOCAL request',maxTurns:5,hooks:{assertOwnership:async()=>{},dispatchIntent:async(_,id)=>({intent_id:id,status:'waiting_for_worker'})},onActivity:()=>{}});
 expect(f.state.callCount).toBe(1);expect(r.lastAssistantText).toContain('waiting_for_worker');
 const fact=(await s.listByKind('fact')).find(n=>n.payload.summary==='Main LOCAL evidence')!;expect(fact.payload).toMatchObject({source_main_segment:7,source_task_id:task.id});expect(fact.payload.from_intent).toBeUndefined();
});
it('batch facts have independent transactions, stable per-item retry IDs and no private drafts',async()=>{
 const {task,s}=await fixture();const id=await s.addIntent({summary:'LOCAL batch',dispatch_requested:true},5,[],'user');await s.claimNextWorker('w');const c=runContext(db,task.id,task.exploration_id,'worker',{intentID:id,workerName:'w'});
 const args={facts:[{summary:'first',evidence:'one'},{summary:'missing evidence'},{summary:'third',evidence:'three'}]};
 const first=await call(recordFactTool(c),args,'batch-retry'),again=await call(recordFactTool(c),args,'batch-retry');
 expect(first.fact_ids[0]).toBeGreaterThan(0);expect(first.fact_ids[1]).toBe(0);expect(first.results[1].error).toContain('证据');expect(again.fact_ids).toEqual(first.fact_ids);
 expect((await searchContext(c,{types:['fact'],intent_id:id})).items).toHaveLength(2);
});
it('recalls activity and complete Unicode fields with bounded snapshots and live permissions',async()=>{
 const {task,s,c}=await fixture();const id=await s.addIntent({summary:'LOCAL recall'},5,[],'user');const content='中文😀证据'.repeat(1200);
 const fact=await s.addNode('fact',{summary:'LOCAL detail',evidence:content},0,'confirmed','test',[]);await s.link(id,'yields',fact);
 const activity=await s.appendActivity({node_id:id,worker:'w',kind:'result',summary:'Final LOCAL',detail:content,metadata:{event_type:'outcome'}});
 const search=await searchContext(c,{types:['activity'],intent_id:id});expect(search.items[0]?.ref).toBe(`activity:${activity}`);
 let result='',offset=0;do{const page=await call(contextGetTool(c),{items:[{ref:`node:${fact}`,field:'/payload/evidence',offset}],max_chars:1000});expect(page.items[0].error).toBeUndefined();result+=page.items[0].content;offset=page.items[0].next_offset;}while(offset!==null);
 expect(result).toBe(content);expect(result).not.toContain('\ufffd');
 await db.query("UPDATE tools SET enabled=false WHERE key='get_worker_trace'");
 try{const blocked=await call(contextGetTool(c),{items:[{ref:`activity:${activity}`}]});expect(blocked.items[0].error).toContain('权限');}finally{await db.query("UPDATE tools SET enabled=true WHERE key='get_worker_trace'");}
});
it('resumes a paused Worker once using its own task capacity despite another full task',async()=>{
 const other=await fixture();await db.query("UPDATE tasks SET status='running' WHERE id=$1",[other.task.id]);await db.platform().setSetting('workers','1');
 const capacity=new Coordinator(db,1),capacityToken=(await capacity.acquire(other.task.id))!,capacitySlot=(await capacity.workerSlot(other.task.id,capacityToken))!;
 const {task,s}=await fixture();const id=await s.addIntent({summary:'LOCAL manual resume'},5,[],'user');await s.setIntentState(id,'paused');
 const waiting=await s.addIntent({summary:'LOCAL second manual resume'},5,[],'user');await s.setIntentState(waiting,'paused');
 const {f,source}=await model('artex-human-resume');let release!:()=>void,entered=false;const held=new Promise<void>(r=>release=r);
 f.setResponses([async ctx=>{entered=true;expect(JSON.stringify(ctx.messages)).not.toContain('human-intervention');await held;return fauxAssistantMessage('LOCAL resumed and done');}]);
 const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(e);await e.run(task.id);
 try{
  expect((await executionSnapshot(db,task.id)).available).toBe(1);
  const first=await e.controlIntent(task.id,id,'resume');expect(first.state).toBe('running');
  await until(async()=>entered);const repeated=await e.controlIntent(task.id,id,'resume');expect(repeated.duplicate).toBe(true);
  expect(await executionSnapshot(db,task.id)).toMatchObject({limit_scope:'task',global_active:2,task_active:1,available:0});
  await expect(e.controlIntent(task.id,waiting,'resume')).rejects.toMatchObject({statusCode:409,code:'TASK_WORKER_CAPACITY_FULL'});
  expect((await s.getNode(waiting))?.state).toBe('paused');
  expect(f.state.callCount).toBe(1);
  release();await until(async()=>(await s.getNode(id))?.state==='done');expect(f.state.callCount).toBe(1);
 }finally{release();await e.stop(task.id);await capacity.releaseSlot(capacitySlot);await capacity.release(other.task.id,capacityToken);}
});
it('migration is idempotent and preserves disabled/custom tool configuration',async()=>{
 await db.query("UPDATE tools SET enabled=false,description='CUSTOM DESCRIPTION' WHERE key='bash'");
 await seedBuiltins(db);await seedBuiltins(db);
 expect(await db.platform().getTool('bash')).toMatchObject({enabled:false,description:'CUSTOM DESCRIPTION'});expect(await db.platform().getTool('record_plan_decision')).toBeNull();
 await db.query("UPDATE tools SET enabled=true WHERE key='bash'");
});

it('limits concurrent Planner probes to three and stops probing once Worker evidence exists',async()=>{
 const {task,s}=await fixture('managed');await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const {f,source}=await model('artex-planner-probes');const activities:any[]=[];
 f.setResponses([fauxAssistantMessage(Array.from({length:4},(_,i)=>fauxToolCall('bash',{command:`printf 'LOCAL probe ${i}'`}))),fauxAssistantMessage('LOCAL probes finished')]);
 await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal:task.goal,model:source,dataDir:dir,todos:new TodoStore(db),hooks:{},triggersText:'LOCAL',maxTurns:4,onActivity:a=>{activities.push(a);}});
 expect(activities.filter(a=>a.kind==='tool_end'&&String(a.text).includes('每轮最多三次'))).toHaveLength(1);
 const id=await s.addIntent({summary:'LOCAL Worker evidence'},5,[],'user');await s.addNode('fact',{summary:'Worker has explored',evidence:'LOCAL',from_intent:id},0,'confirmed','worker',[]);
 const second=await model('artex-planner-after-worker');second.f.setResponses([fauxAssistantMessage([fauxToolCall('bash',{command:"printf 'SHOULD_NOT_EXECUTE'"})]),fauxAssistantMessage('Dispatched to Worker instead')]);
 await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal:task.goal,model:second.source,dataDir:dir,todos:new TodoStore(db),hooks:{},triggersText:'LOCAL new fact',maxTurns:4,onActivity:a=>{activities.push(a);}});
 expect(activities.some(a=>a.kind==='tool_end'&&String(a.text).includes('开局探测已结束'))).toBe(true);
});

it('Main goal editing does not start a Worker pool',async()=>{
 const {task,s}=await fixture('managed'),{f,source}=await model('artex-main-goal');
 f.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'set_goals'})]),fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:'LOCAL deliverable'}]})]),fauxAssistantMessage('Goal saved')]);
 const e=new Engine(db,defaultEngineConfig(),async()=>source,dir);engines.push(e);await e.mainChat(task.id,'Save this LOCAL goal only');
 expect((await s.listByKind('goal')).length).toBe(1);
 expect((await db.query('SELECT 1 FROM engine_task_leases WHERE task_id=$1',[task.id])).rowCount).toBe(0);
 await db.query("UPDATE tasks SET execution_mode='manual' WHERE id=$1",[task.id]);await e.run(task.id);await db.tasks().applyTaskPause(task.id);await e.pause(task.id);
 f.setResponses([async()=>{
  // Force a heartbeat during the new chat, after the pause was acknowledged.
  await (e as any).maintainRuntime((e as any).rt(task.id));
  return fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:'LOCAL paused edit'}]})]);
 },fauxAssistantMessage('Paused goal saved')]);
 await e.mainChat(task.id,'Only update this paused task goal');expect((await db.tasks().getTask(task.id))?.paused).toBe(true);
});
it('Main and Planner can immediately reread discovered asset evidence',async()=>{
 const {task}=await fixture();const c=runContext(db,task.id,task.exploration_id,'mainagent',{mainSegment:2,hooks:{assertOwnership:async()=>{}}});
 const saved=await call(insertAssetsTool(c),{items:[{type:'root_domain',domain:'artex-fixture.invalid'}]});
 const owner={task_id:task.id,intent_id:null,url:'https://artex-fixture.invalid/'};
 await expect(authorizeEvidence(db,owner,task.id)).resolves.toBeUndefined();
 await db.taskScope().validateTaskAssets(task.id,[saved.assets[0].asset_id]);
 await expect(authorizeEvidence(db,owner,task.id+99999)).rejects.toThrow('不属于');
});
it('upgrades recognized legacy configuration once and quarantines inactive proposals',async()=>{
 const {task,s}=await fixture('managed'),old=await s.addIntent({summary:'LOCAL legacy proposal',planning_round:'old',dispatch_requested:false},5,[],'planner');
 await db.query("DELETE FROM settings WHERE key='pi_artex_alignment_v1'");
 await db.query("UPDATE agents SET wrapup_prompt='本轮预算将尽，不再查找新方向。保存已有规划决策后结束；没有新工作可以等待。' WHERE key='planner'");
 await db.query(`INSERT INTO tools(key,kind,system,description,schema,agents,enabled,executable) VALUES
  ('legacy_callable','shell',false,'LOCAL','{"type":"object","properties":{"args":{"type":"string"}}}','["worker"]',false,'printf'),
  ('shell_environment','shell',false,'LOCAL installed command','{}','["worker"]',true,'fixture')`);
 await migrateArtex(db);const before=await db.platform().getSetting('pi_artex_previous_tools');await migrateArtex(db);
 expect(await db.platform().getSetting('pi_artex_previous_tools')).toBe(before);
 expect(await db.platform().getTool('legacy_callable')).toMatchObject({kind:'command',enabled:false,exec:{legacy_shell_args:true}});
 expect(await db.platform().getTool('shell_environment')).toMatchObject({kind:'shell'});
 expect((await s.getNode(old))?.payload).toMatchObject({needs_replanning:true,dispatch_requested:false});
 expect(await s.claimNextWorker('must-not-run')).toBeNull();
 expect((await db.platform().getAgentByKey('planner'))?.wrapupPrompt).not.toContain('规划决策');
});

it('continues the original session through repeated button pause/resume cycles',async()=>{
 const {task,s}=await fixture();const id=await s.addIntent({summary:'LOCAL repeated human resume'},5,[],'user');await s.setIntentState(id,'paused');
 const {f,source}=await model('artex-multiple-interventions');let entered=false;
 f.setResponses([async(_ctx,options)=>{entered=true;await new Promise<void>(r=>{if(options?.signal?.aborted)r();else options?.signal?.addEventListener('abort',()=>r(),{once:true});});return fauxAssistantMessage('Paused first continuation');},ctx=>{
  const text=JSON.stringify(ctx.messages);expect(text).toContain('LOCAL repeated human resume');expect(text).not.toContain('human-intervention');return fauxAssistantMessage('Original intent continued');
 }]);
 const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>source,dir);engines.push(e);await e.run(task.id);
 try{
  await e.controlIntent(task.id,id,'resume');await until(async()=>entered);
  await e.controlIntent(task.id,id,'pause','LOCAL pause');await until(async()=>!(await db.query('SELECT 1 FROM engine_worker_slots WHERE intent_id=$1',[id])).rowCount);
  await e.controlIntent(task.id,id,'resume');await until(async()=>(await s.getNode(id))?.state==='done');
  expect(f.state.callCount).toBe(2);expect((await db.query('SELECT 1 FROM worker_interventions WHERE intent_id=$1 AND completed_at IS NULL',[id])).rowCount).toBe(0);
 }finally{await e.stop(task.id);}
},30000);
it('deduplicates simplified submissions against historical work identity and preserves it on revalidation',async()=>{
 const {s,c}=await fixture('managed');const work={resource:'LOCAL',question_key:'observe',method_class:'local',identity:'default'};
 const old=await s.addPlannerIntentDeduplicated({summary:'LOCAL stable work',needs_replanning:true,dispatch_requested:false,contract:{objective:'LOCAL stable work',acceptance:['LOCAL observed'],work}},5,[],'planner');
 const result=await call(addIntentTool(c),{intents:[{summary:'LOCAL stable work'}]});
 expect(result.intents[0]).toMatchObject({intent_id:old.id,created:false});expect((await s.getNode(old.id))?.payload).toMatchObject({needs_replanning:false,dispatch_requested:true,contract:{work}});
});

it('button resume cannot admit a paused task or replay legacy human messages',async()=>{
 const {task,s}=await fixture(),{source}=await model('button-task-boundary');
 const id=await s.addIntent({summary:'LOCAL paused'},5,[],'user');await s.setIntentState(id,'paused');
 const e=new Engine(db,defaultEngineConfig(),async()=>source,dir);engines.push(e);await e.run(task.id);
 await db.tasks().applyTaskPause(task.id);await e.pause(task.id);
 await expect(e.controlIntent(task.id,id,'resume')).rejects.toThrow('任务暂停');
 expect((await db.tasks().getTask(task.id))?.paused).toBe(true);expect((await s.getNode(id))?.state).toBe('paused');
 await e.stop(task.id);
});
it('subscribes to a running Planner intent without redispatch and publishes only after slot release',async()=>{
 const {task,s}=await fixture('managed');await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const id=await s.addIntent({summary:'LOCAL selected running intent',dispatch_requested:true},5,[],'planner');await s.claimNextWorker('original-owner');
 await db.query('INSERT INTO main_sessions(exploration_id,seq) VALUES($1,1),($1,2)',[task.exploration_id]);
 const coordinator=new Coordinator(db,1),token=(await coordinator.acquire(task.id))!,slot=(await coordinator.workerSlot(task.id,token))!;
 await db.query('UPDATE engine_worker_slots SET intent_id=$2 WHERE id=$1',[slot,id]);
 const {source}=await model('button-feedback'),e=new Engine(db,defaultEngineConfig(),async()=>source,dir);engines.push(e);
 const deliveries:any[]=[];e.bus.on('activity',a=>deliveries.push(a));
 try{
  const before=await s.getNode(id);expect(await e.dispatchIntent(task.id,id,1)).toMatchObject({already_running:true});
  await e.dispatchIntent(task.id,id,1);expect((await s.getNode(id))?.owner).toBe(before?.owner);
  expect((await db.query('SELECT 1 FROM worker_feedback WHERE intent_id=$1',[id])).rowCount).toBe(1);
  await s.appendActivity({node_id:id,worker:'original-owner',kind:'result',summary:'LOCAL result evidence'});await s.setIntentState(id,'done');
  await (e as any).publishFeedback(task.id);expect(deliveries).toHaveLength(0);
  await coordinator.releaseSlot(slot);await (e as any).publishFeedback(task.id);await (e as any).publishFeedback(task.id);
  expect(deliveries).toHaveLength(1);expect(deliveries[0].mainSeg).toBe(1);expect(deliveries[0].detail).toContain('LOCAL result evidence');
  expect((await db.query("SELECT 1 FROM activity WHERE exploration_id=$1 AND main_seg=2 AND metadata ? 'worker_feedback'",[task.exploration_id])).rowCount).toBe(0);
 }finally{await coordinator.release(task.id,token);}
});

it('exposes discovered MCP names to Planner and rejects invented contract aliases',async()=>{
 const {c}=await fixture();
 const mid=await db.platform().saveMCP({name:'catalog-fixture',transport:'http',url:'https://fixture.invalid/mcp',enabled:true,insecure:false,command:'',args:[],env:{}});
 try{
  await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,mcp_tool_name,enabled) SELECT id,'mcp',$1,'',true FROM agents WHERE key='worker'",[mid]);
  await db.query("INSERT INTO mcp_tools_cache(server_id,tool_name,description,schema) VALUES($1,'ask_wiki_question','fixture','{}'),($1,'hidden_tool','fixture','{}')",[mid]);
  await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,mcp_tool_name,enabled) SELECT id,'mcp',$1,'hidden_tool',false FROM agents WHERE key='worker'",[mid]);
  const catalog=await workerCapabilities(c);
  expect(catalog.tools).toContain('mcp__catalog_fixture__ask_wiki_question');expect(catalog.tools).not.toContain('mcp__catalog_fixture__hidden_tool');
  expect(()=>validateWorkerToolNames(['mcp__catalog_fixture__ask_question'],catalog)).toThrow('不存在');
  expect(()=>validateWorkerToolNames(['mcp__catalog_fixture__ask_wiki_question'],catalog)).not.toThrow();
 }finally{await db.platform().deleteMCP(mid);}
});

it('accepts SERIES single and batch forms, retains all factual parents and rejects mixed input before writing',async()=>{
 const {task,s,c}=await fixture('managed');await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const a=await s.addNode('fact',{summary:'LOCAL first parent'},0,'confirmed','test',[]);
 const b=await s.addNode('fact',{summary:'LOCAL second parent'},0,'confirmed','test',[]);
 const one=await call(addIntentTool(c),{summary:'LOCAL single series direction',parent_ids:[String(a),b],priority:0});
 expect(one.ids).toEqual([one.intents[0].intent_id]);
 const node=(await s.getNode(one.ids[0]))!;
 expect(node.priority).toBe(5);expect(node.payload.parent_ids).toEqual([a,b]);
 expect((node.payload.contract as any).basis.map((r:any)=>r.node_id)).toEqual([a,b]);
 await expect(call(addIntentTool(c),{summary:'outer',parent_ids:[a,b],intents:[{summary:'LOCAL mixed must not exist'}]})).rejects.toThrow('不能混合');
 expect(await s.listByKind('intent')).toHaveLength(1);
 const batch=await call(addIntentTool(c),{intents:[{summary:'LOCAL batch first',parent_ids:[a]},{summary:'LOCAL batch second',parent_id:b}]});
 expect(batch.ids).toHaveLength(2);
 expect((await s.getNode(batch.ids[0]))?.payload.parent_ids).toEqual([a]);
 expect((await s.getNode(batch.ids[1]))?.payload.parent_ids).toEqual([b]);
});
