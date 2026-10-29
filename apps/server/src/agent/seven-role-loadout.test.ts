import {afterAll,beforeAll,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {runWorkerIntent,runPlannerRound,runMainChat,runGoalsDecompose} from './roles.js';
import {previewRoleTools,roleDefinitions} from './tool-catalog.js';
import {legacyReadCandidates} from '../tools/legacy-reads.js';
import {createTrackedRunner,runtimeConfiguration} from '../engine/runtime-config.js';
import {workerCapabilities} from './worker-capabilities.js';
import {ACTIVE_ROLES} from './tool-registry.js';
import {runContext,TodoStore} from '../tools/context.js';
import {reportFindingTool} from '../tools/findings.js';
import {ConversationService} from '../engine/conversations.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';

const dir=mkdtempSync(path.join(tmpdir(),'fate-seven-roles-'));
const name=`fate_seven_roles_${process.pid}`;
let db:Database;
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;
 db=await openDatabase();
});
afterAll(async()=>{
 await db.close();
 const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});
 await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();
 rmSync(dir,{recursive:true,force:true});
});
async function fixture(role:string){
 const task=await db.tasks().createTaskWithOptions('LOCAL synthetic fixture','Observe LOCAL evidence',{executionMode:'managed'});
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const faux=fauxProvider({provider:`seven-${role}-${task.id}`});
 const runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
 const model={modelRuntime:runtime,model:faux.getModel() as never};
 return {task,faux,model,s:db.exploration(task.exploration_id)};
}
it('Worker context changes wait for the next execution, including native session recovery',async()=>{
 const f=await fixture('worker'),previous=await db.platform().getSetting('worker_context_budget_tokens');
 try{
  await db.platform().setSetting('worker_context_budget_tokens','64000');
  const id=await f.s.addIntent({summary:'LOCAL context recovery',dispatch_requested:true,contract:{objective:'LOCAL context recovery',acceptance:['Save LOCAL observation']}},5,[],'user');
  const intent=(await f.s.claimNextWorker('context-worker'))!;
  const input={db,taskID:f.task.id,expID:f.task.exploration_id,intent,workerName:'context-worker',model:f.model,dataDir:dir,hooks:{},onActivity:()=>{}};
  f.faux.setResponses([
   async()=>{
    const running=await runtimeConfiguration(db,{taskID:f.task.id});
    expect(running.active[0].effective.context_policy).toMatchObject({mode:'working_set',thresholdTokens:64000});
    await db.platform().setSetting('worker_context_budget_tokens','0');
    const updated=await runtimeConfiguration(db,{taskID:f.task.id});
    expect(updated.active[0].effective.context_policy).toMatchObject({thresholdTokens:64000});
    expect(updated.active[0].pending?.changed_fields).toContain('worker_context_budget_tokens');
    return fauxAssistantMessage([fauxToolCall('record_fact',{summary:'LOCAL_CONTEXT_SAVED',evidence:'Synthetic only',confidence:'high'})]);
   },fauxAssistantMessage('LOCAL work paused at saved observation')
  ]);
  expect(await runWorkerIntent(input)).toMatchObject({stopReason:'completed'});
  f.faux.setResponses([async context=>{
   expect(JSON.stringify(context.messages)).toContain('LOCAL_CONTEXT_SAVED');
   const resumed=await runtimeConfiguration(db,{taskID:f.task.id});
   expect(resumed.active[0].effective.context_policy).toMatchObject({mode:'capacity',version:'worker-context-v1'});
   return fauxAssistantMessage('LOCAL prior record reused; no repeated write');
  }]);
  expect(await runWorkerIntent(input)).toMatchObject({stopReason:'completed'});
  expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===id)).toHaveLength(1);
 }finally{await db.platform().setSetting('worker_context_budget_tokens',previous??'0');}
});

async function until(fn:()=>Promise<boolean>){
 const end=Date.now()+15000;
 while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}
 throw new Error('LOCAL conversation did not settle');
}
async function runConversation(role:string,f:Awaited<ReturnType<typeof fixture>>,bound=true){
 const engine=new Engine(db,defaultEngineConfig(),async()=>f.model,dir);
 const service=new ConversationService(db,async()=>f.model,dir,engine);
 try{
  const c=await service.create(role,'LOCAL audit',null,bound?f.task.id:undefined);
  const run=await service.enqueue(Number(c.id),'LOCAL synthetic input');
  await until(async()=>!!(await db.query("SELECT 1 FROM conversation_runs WHERE id=$1 AND status IN ('completed','failed','stopped')",[run.run_id])).rowCount);
  const row=(await db.query('SELECT status,error FROM conversation_runs WHERE id=$1',[run.run_id])).rows[0];
  expect(row).toMatchObject({status:'completed'});
  return Number(c.id);
 }finally{await service.shutdown();await engine.shutdown();}
}
it.each(ACTIVE_ROLES)('%s actual entrypoint matches preview and required tools execute',async role=>{
 const f=await fixture(role),activities:any[]=[];
 const base={db,taskID:f.task.id,expID:f.task.exploration_id,goal:f.task.goal,model:f.model,dataDir:dir,hooks:{},onActivity:(a:unknown)=>activities.push(a)};
 let conversationID:number|undefined;
 if(role==='goals'){
  await db.query('INSERT INTO goals_bootstrap(task_id,goal,description) VALUES($1,$2,$3)',[f.task.id,f.task.goal,f.task.description]);
  f.faux.setResponses([fauxAssistantMessage('约束阶段完成'),fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:f.task.goal,source_quote:f.task.goal}]})])]);
  expect(await runGoalsDecompose({...base,description:'LOCAL synthetic fixture'})).toMatchObject({stopReason:'completed'});
  expect((await f.s.listByKind('goal')).length).toBe(1);
 }else if(role==='worker'){
  const id=await f.s.addIntent({summary:'Observe LOCAL fixture',dispatch_requested:true,contract:{objective:'Observe LOCAL fixture',acceptance:['Save observation'],allowed_tools:['read']}},5,[],'user');
  const intent=(await f.s.claimNextWorker('local-worker'))!;
  f.faux.setResponses([
   fauxAssistantMessage([fauxToolCall('record_fact',{summary:'LOCAL incremental fact',evidence:'Synthetic observation',confidence:'high'})]),
   async()=>{expect((await f.s.listByKind('fact')).some(n=>n.payload.from_intent===id)).toBe(true);return fauxAssistantMessage([fauxToolCall('tool_search',{query:'asset_get'})]);},
   fauxAssistantMessage('LOCAL observation saved'),
  ]);
  expect(await runWorkerIntent({...base,intent,workerName:'local-worker'})).toMatchObject({stopReason:'completed'});
  expect(activities.filter(a=>a.kind==='tool_end'&&a.isError)).toEqual([]);
  expect(f.faux.state.callCount).toBe(3);
 }else if(role==='planner'){
  const args={summary:'LOCAL stable direction',contract:{objective:'LOCAL stable direction',acceptance:['LOCAL observation'],work:{resource:'LOCAL',question_key:'observe',method_class:'read',identity:'fixture'}}};
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('add_intent',args)]),fauxAssistantMessage([fauxToolCall('add_intent',args)]),fauxAssistantMessage('LOCAL planning finished')]);
  expect(await runPlannerRound({...base,todos:new TodoStore(db),triggersText:'LOCAL',maxTurns:5})).toMatchObject({stopReason:'completed'});
  expect((await f.s.listByKind('intent')).length).toBe(1);
 }else if(role==='mainagent'){
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('context_search',{types:['fact']})]),fauxAssistantMessage('LOCAL progress')]);
  expect(await runMainChat({...base,message:'Read LOCAL progress',segment:1,maxTurns:4})).toMatchObject({stopReason:'completed'});
 }else{
  if(role==='reporter'){
   const c=await db.query("INSERT INTO conversations(agent_key,title,task_id) VALUES('pentest','LOCAL source',$1) RETURNING id",[f.task.id]);
   const ctx=runContext(db,f.task.id,f.task.exploration_id,'pentest',{conversationID:Number(c.rows[0].id)});
   const result=await reportFindingTool(ctx).execute('local-finding',{vulnclass:'synthetic',severity:'low',summary:'LOCAL synthetic fixture only',evidence:'LOCAL fabricated test evidence, no target'} as never,undefined,undefined,{} as never);
   expect(result.isError).not.toBe(true);
   const findingID=JSON.parse((result.content[0] as {text:string}).text).finding_id;
   f.faux.setResponses([fauxAssistantMessage([fauxToolCall('get_finding',{finding_id:findingID})]),async()=>{
    const version=(await db.query('SELECT evidence_version FROM findings WHERE id=$1',[findingID])).rows[0].evidence_version;
    return fauxAssistantMessage([fauxToolCall('update_finding_report',{finding_id:findingID,evidence_version:Number(version),report:'LOCAL synthetic report'})]);
   }]);
  }else if(role==='pentest'){
   f.faux.setResponses([fauxAssistantMessage([fauxToolCall('record_conversation_fact',{summary:'LOCAL independent observation',evidence:'LOCAL synthetic input',confidence:'high'})]),fauxAssistantMessage('Saved')]);
  }else{
   f.faux.setResponses([fauxAssistantMessage([fauxToolCall('list_tasks',{})]),fauxAssistantMessage('Listed LOCAL tasks')]);
  }
  conversationID=await runConversation(role,f);
 }
 const effective=(await db.query(`SELECT effective FROM runtime_role_configs WHERE role=$1 AND ${conversationID?'conversation_id':'task_id'}=$2 ORDER BY started_at DESC LIMIT 1`,[role,conversationID??f.task.id])).rows[0].effective;
 const catalog=await previewRoleTools(db,role);
 const preview=role==='goals'?catalog.stages!.find(s=>s.phase===effective.goals_phase)!:catalog;
 // effective.tools records the allowed set; initial active_tools is the first-request loadout.
 expect([...effective.tool_loading.initialActive].filter((n:string)=>n!=='mcp__*').sort()).toEqual(preview.resident.filter(n=>n!=='tool_search').sort());
 expect([...effective.tool_loading.deferred].sort()).toEqual([...preview.deferred].sort());
 expect(activities.filter(a=>a.kind==='tool_end'&&a.isError)).toEqual([]);
 if(conversationID)expect((await db.query("SELECT tool,detail FROM conversation_activities WHERE conversation_id=$1 AND is_error",[conversationID])).rows).toEqual([]);
});
it('Worker capability names reflect native internal discovery without MCP',async()=>{
 const f=await fixture('worker-catalog');
 const capabilities=await workerCapabilities(runContext(db,f.task.id,f.task.exploration_id,'planner'));
 expect(capabilities.tools).toContain('tool_search');
 const preview=await previewRoleTools(db,'worker');
 expect(capabilities.tools).toEqual([...preview.resident,...preview.deferred].sort());
});
it.each(ACTIVE_ROLES)('%s recovery rechecks disabled canonical and legacy bindings without replay',async role=>{
 const f=await fixture(`${role}-resume`),tools=roleDefinitions(db,role);
 const options={...f.model,cwd:path.join(dir,`${role}-resume`),agentDir:path.join(dir,`${role}-agent`),
  resumeSessionPath:path.join(dir,`${role}-resume.jsonl`),systemPrompt:'LOCAL fixture: use read_tool_output for old session compatibility',
  customTools:tools,toolAllowlist:tools.map(t=>t.name),
  legacyTools:legacyReadCandidates(runContext(db,f.task.id,f.task.exploration_id,role as never))};
 let r=await createTrackedRunner(db,f.task.id,role,options),sessionID=r.sessionId;
 try{
  expect(r.activeToolNames).toContain('context_get');
  f.faux.setResponses([fauxAssistantMessage('LOCAL saved conversation')]);await r.prompt('LOCAL persisted user input');
 }finally{await r.dispose();}
 await db.query("UPDATE tools SET enabled=false WHERE key='context_get'");
 try{
  r=await createTrackedRunner(db,f.task.id,role,options);
  try{
   expect(r.sessionId).toBe(sessionID);
   expect(r.activeToolNames).not.toContain('context_get');
   expect(r.activeToolNames).not.toContain('read_tool_output');
   f.faux.setResponses([ctx=>{
    expect(JSON.stringify(ctx.messages)).toContain('LOCAL saved conversation');
    return fauxAssistantMessage('LOCAL restored without replay');
   }]);await r.prompt('LOCAL resume');
   expect(f.faux.state.callCount).toBe(2);
  }finally{await r.dispose();}
 }finally{await db.query("UPDATE tools SET enabled=true WHERE key='context_get'");}
});
it('a resumed Worker falls back to direct loading when tool_search is disabled',async()=>{
 const f=await fixture('direct-resume'),tools=roleDefinitions(db,'worker');
 const options={...f.model,cwd:path.join(dir,'direct-resume'),agentDir:path.join(dir,'direct-agent'),
  resumeSessionPath:path.join(dir,'direct.jsonl'),systemPrompt:'LOCAL direct fallback',customTools:tools,toolAllowlist:tools.map(t=>t.name)};
 let r=await createTrackedRunner(db,f.task.id,'worker',options);
 try{
  expect(r.activeToolNames).toContain('tool_search');expect(r.activeToolNames).not.toContain('asset_get');
  f.faux.setResponses([fauxAssistantMessage('LOCAL saved')]);await r.prompt('LOCAL');
 }finally{await r.dispose();}
 await db.query("UPDATE tools SET enabled=false WHERE key='tool_search'");
 try{
  r=await createTrackedRunner(db,f.task.id,'worker',options);
  try{
   expect(r.activeToolNames).not.toContain('tool_search');expect(r.activeToolNames).toContain('asset_get');
   f.faux.setResponses([fauxAssistantMessage('LOCAL direct resume')]);await r.prompt('LOCAL resume');
  }finally{await r.dispose();}
 }finally{await db.query("UPDATE tools SET enabled=true WHERE key='tool_search'");}
});
it('standalone Pentest preview never advertises task-bound custom execution',async()=>{
 await db.query(`INSERT INTO tools(key,system,kind,enabled,agents,description,schema,exec)
 VALUES('local_bound_command',false,'command',true,'["pentest"]','LOCAL command','{"type":"object","properties":{}}','{"command":"printf LOCAL"}')`);
 try{
  const f=await fixture('standalone'),preview=await previewRoleTools(db,'pentest',false);
  f.faux.setResponses([fauxAssistantMessage('LOCAL standalone')]);const id=await runConversation('pentest',f,false);
  const effective=(await db.query('SELECT effective FROM runtime_role_configs WHERE conversation_id=$1',[id])).rows[0].effective;
  expect([...preview.resident,...preview.deferred].sort()).toEqual([...effective.tool_loading.initialActive,...effective.tool_loading.deferred].sort());
 }finally{await db.query("DELETE FROM tools WHERE key='local_bound_command'");}
});
