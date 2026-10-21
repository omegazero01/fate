import {seedBuiltins} from './src/db/platform.js';
import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from './src/db/index.js';
import {ROLE_PROMPTS,hostProtocol,systemRolePrompt,renderPrompt,resolveRolePrompt,migrateBuiltinPrompts,WORKER_WRAPUP,WORKER_TASK_TIMEOUT_WRAPUP} from './src/agent/prompts.js';
import {effectiveToolDescription} from './src/agent/tool-descriptions.js';
import {LEGACY_TOOL_DESCRIPTIONS} from './src/agent/prompt-legacy.js';
import {compactPlannerChanges} from './src/agent/prompt-context.js';
import {requestSize} from './src/agent/prompt-diagnostics.js';
import {AgentRunner} from './src/pi/runner.js';
import {runPlannerRound,runGoalsDecompose,runMainChat,applyToolBindings,agentBudgets,agentRunConfig} from './src/agent/roles.js';
import {TodoStore} from './src/tools/context.js';
import {Engine,defaultEngineConfig} from './src/engine/engine.js';
import {buildApp} from './src/http/app.js';
import {signJWT} from './src/http/auth.js';

const baseline=JSON.parse(readFileSync(new URL('./test-fixtures/prompt-baseline.json',import.meta.url),'utf8')) as Record<string,string>;
const name=`fate_prompt_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-prompts-')),key='prompt-regression-only';
let db:Database;const engines:Engine[]=[],apps:ReturnType<typeof buildApp>[]=[];
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;process.env.SERIES_LOG_LEVEL='silent';db=await openDatabase();await db.query('UPDATE agents SET max_turns=0,run_seconds=0 WHERE key=ANY($1::text[])',[Object.keys(ROLE_PROMPTS)]);});
afterAll(async()=>{for(const e of engines)await e.shutdown();for(const a of apps)await a.close();await db?.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});await admin.connect();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(){
 const task=await db.tasks().createTaskWithOptions('LOCAL prompt fixture','LOCAL goal',{});
 const faux=fauxProvider({provider:`prompt-${task.id}`}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
 const source={modelRuntime,model:faux.getModel() as never};
 const engine=new Engine(db,{...defaultEngineConfig(),workers:1},async()=>source,dir);engines.push(engine);
 const app=buildApp({db,engine,version:'prompt-test',startedAt:Date.now(),jwtKey:key,skillsRoot:dir,dataDir:dir});apps.push(app);
 const request=(method:'GET'|'POST'|'PUT',url:string,payload?:unknown)=>app.inject({method,url,payload,headers:{'X-Series-Token':signJWT(key)}});
 return {task,source,faux,engine,app,request};
}
async function until(fn:()=>Promise<boolean>){for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('timeout');}

describe('lightweight role prompts',()=>{
 it('distinguishes explicit zero/positive budgets from a missing configuration',async()=>{
  const defaults={maxTurns:30,maxDurationMs:1200_000};
  expect(agentBudgets({maxTurns:0,runSeconds:0},defaults)).toEqual({maxTurns:0,maxDurationMs:0});
  expect(agentBudgets({maxTurns:5,runSeconds:9},defaults)).toEqual({maxTurns:5,maxDurationMs:9000});
  expect(agentBudgets(await agentRunConfig(db,'missing-local-role'),defaults)).toEqual(defaults);
 });
 it('validates platform rollback settings and exposes the next-session application boundary',async()=>{
  const {request,faux}=await fixture();
  expect((await request('PUT','/api/settings',{pi_context_policy:'typo',pi_mcp_loading:'direct'})).statusCode).toBe(400);
  expect((await request('GET','/api/settings')).json().pi_mcp_loading).toBe('deferred');
  try{
   expect((await request('PUT','/api/settings',{pi_context_policy:'native',pi_mcp_loading:'direct'})).json()).toMatchObject({pi_context_policy:'native',pi_mcp_loading:'direct',applies:'next_session'});
   expect((await request('POST','/api/agents/worker/prompt/preview',{template:'LOCAL'})).json().platform_policy).toMatchObject({compaction:'native',mcpLoading:'direct'});
   expect(faux.state.callCount).toBe(0);
  }finally{await request('PUT','/api/settings',{pi_context_policy:'domain',pi_mcp_loading:'deferred'});}
 });

 it('cuts the four long role bodies by at least half without counting tokens as bytes',()=>{
  const roles=['planner','worker','mainagent','goals'] as const;
  expect(roles.reduce((n,k)=>n+Buffer.byteLength(ROLE_PROMPTS[k]),0)).toBeLessThanOrEqual(roles.reduce((n,k)=>n+Buffer.byteLength(baseline[k]!),0)/2);
 });
 it('renders variables literally once, preserving dollar sequences and embedded placeholders',()=>{
  expect(renderPrompt('{{Goal}} / {{.Goal}} / {{Other}}',{Goal:'$& $$ {{Other}}',Other:'X'})).toBe('$& $$ {{Other}} / $& $$ {{Other}} / X');
 });
 it('upgrades only exact shipped defaults once, preserves history/custom text and allows rollback',async()=>{
  const planner=(await db.platform().getAgentByKey('planner'))!,worker=(await db.platform().getAgentByKey('worker'))!;
  await db.platform().savePrompt(planner.id,baseline.planner!,'old default','fixture');
  const old=(await db.query('SELECT current_prompt_id FROM agents WHERE id=$1',[planner.id])).rows[0]!.current_prompt_id;
  await db.platform().savePrompt(worker.id,'用户业务规则：必须记录工单号','custom','fixture');
  await db.platform().setSetting('pi_prompt_blackboard_final_v1','');await migrateBuiltinPrompts(db);
  expect(await db.platform().currentPrompt(planner.id)).toBe(ROLE_PROMPTS.planner);
  expect(await db.platform().currentPrompt(worker.id)).toContain('工单号');
  expect((await resolveRolePrompt(db,'worker')).candidate).toBe(ROLE_PROMPTS.worker);
  await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[planner.id,old]);await migrateBuiltinPrompts(db);
  expect((await resolveRolePrompt(db,'planner')).template).toBe(baseline.planner);
  await db.query('UPDATE agents SET current_prompt_id=NULL WHERE id=ANY($1::bigint[])',[[planner.id,worker.id]]);
 });
 it('migrates private Worker defaults once, retaining exact history and customizations',async()=>{
  const old=JSON.parse(readFileSync(new URL('./test-fixtures/worker-private-defaults.json',import.meta.url),'utf8'));
  const worker=(await db.platform().getAgentByKey('worker'))!;
  await db.platform().savePrompt(worker.id,old.worker,'old private default','fixture');
  const previous=(await db.query('SELECT current_prompt_id FROM agents WHERE id=$1',[worker.id])).rows[0]!.current_prompt_id;
  await db.query('UPDATE agents SET wrapup_prompt=$2,task_timeout_wrapup_prompt=$3 WHERE id=$1',[worker.id,old.wrapup,old.timeout]);
  await db.query('UPDATE tools SET description=$2 WHERE key=$1',['record_fact','结束前汇总本意图最新结论：summary 简述，detail 写细节，evidence 保留真实证据。Worker 先存私有稿，replace_node_id 可修订；complete_intent 最终选定后才发布，暂存不唤醒 Planner。']);
  await db.query("UPDATE tools SET description='用户自定义漏洞写回要求' WHERE key='report_finding'");
  await db.platform().setSetting('pi_worker_direct_write_v1','');await migrateBuiltinPrompts(db);
  expect(await db.platform().currentPrompt(worker.id)).toBe(ROLE_PROMPTS.worker);
  expect((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[previous])).rows[0]!.template_text).toBe(old.worker);
  expect((await db.query('SELECT wrapup_prompt,task_timeout_wrapup_prompt FROM agents WHERE id=$1',[worker.id])).rows[0]).toEqual({wrapup_prompt:WORKER_WRAPUP,task_timeout_wrapup_prompt:WORKER_TASK_TIMEOUT_WRAPUP});
  expect((await db.platform().getTool('record_fact'))?.description).toContain('立即入图');
  expect((await db.platform().getTool('report_finding'))?.description).toBe('用户自定义漏洞写回要求');
  const count=Number((await db.query('SELECT count(*) FROM agent_prompts WHERE agent_id=$1',[worker.id])).rows[0]!.count);
  await migrateBuiltinPrompts(db);expect(Number((await db.query('SELECT count(*) FROM agent_prompts WHERE agent_id=$1',[worker.id])).rows[0]!.count)).toBe(count);
  await db.platform().savePrompt(worker.id,'用户自定义 Worker 文本','custom','fixture');
  await db.query("UPDATE agents SET wrapup_prompt='自定义收尾',task_timeout_wrapup_prompt='自定义超时' WHERE id=$1",[worker.id]);
  await db.platform().setSetting('pi_worker_direct_write_v1','');await migrateBuiltinPrompts(db);
  expect(await db.platform().currentPrompt(worker.id)).toBe('用户自定义 Worker 文本');
  expect((await db.query('SELECT wrapup_prompt FROM agents WHERE id=$1',[worker.id])).rows[0]!.wrapup_prompt).toBe('自定义收尾');
  await db.query('UPDATE agents SET current_prompt_id=NULL,wrapup_prompt=$2,task_timeout_wrapup_prompt=$3 WHERE id=$1',[worker.id,WORKER_WRAPUP,WORKER_TASK_TIMEOUT_WRAPUP]);
  await db.query("UPDATE tools SET description='' WHERE key='report_finding'");
 });
 it('retires legacy tool bindings while retaining customized metadata exactly once',async()=>{
  await db.query("INSERT INTO tools(key,description,kind,system,agents) VALUES('checkpoint_intent','用户自定义旧检查点','builtin',true,'[\"worker\"]'),('complete_intent','旧结束说明','builtin',true,'[\"worker\"]')");
  await seedBuiltins(db);
  expect(await db.platform().getTool('checkpoint_intent')).toBeNull();expect(await db.platform().getTool('complete_intent')).toBeNull();
  const backup=await db.platform().getSetting('pi_worker_removed_tools_previous');
  expect(JSON.parse(backup!)).toContainEqual(expect.objectContaining({key:'checkpoint_intent',description:'用户自定义旧检查点'}));
  await seedBuiltins(db);expect(await db.platform().getSetting('pi_worker_removed_tools_previous')).toBe(backup);
 });
 it('uses canonical tool semantics for untouched seeds and preserves custom descriptions/disabled bindings',async()=>{
  const canonical=effectiveToolDescription('record_fact','code',LEGACY_TOOL_DESCRIPTIONS.record_fact);
  expect(canonical.description).toContain('立即入图');
  expect(effectiveToolDescription('record_fact','code','用户说明').description).toBe('用户说明');
  await db.query("UPDATE tools SET enabled=false WHERE key='record_fact'");
  expect(await applyToolBindings(db,'worker',[{name:'record_fact',description:'code'}])).toHaveLength(0);
  await db.query("UPDATE tools SET enabled=true WHERE key='record_fact'");
 });
 it('deduplicates matching local observations without discarding different/newer or source-task data',()=>{
  const changes=[{ref:'node:1',source_task_id:7,version:2,summary:'same',result:{outcome:'complete'}},{ref:'node:2',source_task_id:7,summary:'old'},{ref:'node:1',source_task_id:8,summary:'same'}];
  const out=compactPlannerChanges(changes,{recent_done:[{id:1,summary:'same',result:{outcome:'complete'}},{id:2,summary:'new'}]},7) as Record<string,unknown>[];
  expect(out[0]).toEqual({ref:'node:1',source_task_id:7,version:2,details_in:'recent_done:node:1'});expect(out[1]).toEqual(changes[1]);expect(out[2]).toEqual(changes[2]);
 });
 it('records only size/hash metadata, never payload content',()=>{
  const size=requestSize({messages:[{content:'secret-fixture-value'}],tools:[]});expect(JSON.stringify(size)).not.toContain('secret-fixture-value');expect(size.messages.utf8_bytes).toBeGreaterThan(0);
 });
 it.each(Object.keys(ROLE_PROMPTS))('provides reset, effective default and literal preview for %s without starting a model',async role=>{
  const {request,faux}=await fixture();
  const preview=await request('POST',`/api/agents/${role}/prompt/preview`,{template:'{{Goal}} {{.Goal}}',sample:{Goal:'$& {{Other}}'}});
  expect(preview.statusCode).toBe(200);expect(preview.json().platform_policy).toMatchObject({version:'domain-v1',compaction:'domain',mcpLoading:'deferred'});expect(preview.json().rendered).toBe('$& {{Other}} $& {{Other}}');expect(preview.json().candidate).toBeTruthy();expect(preview.json().diagnostics.mcp_schemas.status).toBe('not_loaded');
  expect((await request('POST',`/api/agents/${role}/prompt/reset`,{})).statusCode).toBe(200);
  expect((await request('GET',`/api/agents/${role}`)).json().effective_prompt).toBe(ROLE_PROMPTS[role as keyof typeof ROLE_PROMPTS]);expect(faux.state.callCount).toBe(0);
 });
 it('persists feedback once in the native session across restarts, while retaining query references',async()=>{
  const {source,faux}=await fixture();const opts={...source,cwd:dir,agentDir:path.join(dir,'agent'),resumeSessionPath:path.join(dir,'feedback.jsonl'),toolAllowlist:[],systemPrompt:ROLE_PROMPTS.mainagent};
  faux.setResponses([fauxAssistantMessage('received')]);let runner=await AgentRunner.create(opts);
  expect(await runner.appendContextOnce('feedback:7','local-feedback-marker; intent #7')).toBe(true);await runner.prompt('read feedback');await runner.dispose();
  faux.setResponses([context=>{const text=JSON.stringify(context.messages);expect(text.match(/local-feedback-marker/g)).toHaveLength(1);return fauxAssistantMessage('retained');}]);
  runner=await AgentRunner.create(opts);try{expect(await runner.appendContextOnce('feedback:7','local-feedback-marker')).toBe(false);await runner.prompt('continue');}finally{await runner.dispose();}
 });
 it('assembles a Planner round with one todo copy and ends on its normal summary',async()=>{
  const {task,faux,source}=await fixture();const todos=new TodoStore(db);await todos.set(task.exploration_id,[{id:'one',content:'unique-todo-marker',status:'pending'}] as never);
  faux.setResponses([context=>{const text=JSON.stringify(context.messages);expect(text.match(/unique-todo-marker/g)).toHaveLength(1);expect(text).not.toContain('expert coding assistant');return fauxAssistantMessage('waiting for an authorized target');},fauxAssistantMessage('waiting')]);
  await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal:'no authorized target',model:source,dataDir:dir,todos,hooks:{},triggersText:'LOCAL',maxTurns:4,onActivity:()=>{}});expect(faux.state.callCount).toBe(1);
 });
 it('does not spend a wrapup turn after Goals commits',async()=>{
  const {task,faux,source}=await fixture();faux.setResponses([fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:'LOCAL deliverable'}]})]),fauxAssistantMessage('saved')]);
  await runGoalsDecompose({db,taskID:task.id,expID:task.exploration_id,description:'LOCAL deliverable',model:source,dataDir:dir,maxTurns:5,hooks:{}});expect(faux.state.callCount).toBe(1);
 });
 it('rejects Retester prompt/configuration changes and independent session creation',async()=>{
  const {request,faux}=await fixture();
  for(const [method,url,body] of [
   ['PUT','/api/agents/retester/prompt',{template:'CUSTOM-RETEST'}],
   ['PUT','/api/agents/retester/config',{enabled:true}],
   ['POST','/api/agents/retester/prompt/reset',{}],
   ['POST','/api/agents',{key:'retester',name:'Retester'}],
   ['POST','/api/conversations',{agent_key:'retester'}],
  ] as const)expect((await request(method,url,body)).statusCode,url).toBe(410);
  expect(faux.state.callCount).toBe(0);
 });
 it('recalls Worker feedback once in its original Main segment across session recovery',async()=>{
  const {task,faux,source}=await fixture();
  for(let i=0;i<12;i++){
   const node=await db.exploration(task.exploration_id).addIntent({summary:'LOCAL feedback'},1,[],'user');
   await db.query(`INSERT INTO activity(exploration_id,node_id,worker,kind,summary,detail,main_seg,metadata)
    VALUES($1,$2,'main','assistant',$3,$3,0,'{"worker_feedback":true}')`,[task.exploration_id,node,`feedback-marker-${i}-end`]);
  }
  const input={db,taskID:task.id,expID:task.exploration_id,goal:'LOCAL',model:source,dataDir:dir,hooks:{},message:'查询进度',maxTurns:4,onActivity:()=>{}};
  for(const expected of [12,12,12]){
   faux.setResponses([context=>{const markers=JSON.stringify(context.messages).match(/feedback-marker-\d+-end/g)||[];expect(markers).toHaveLength(expected);expect(new Set(markers).size).toBe(expected);return fauxAssistantMessage('已收到');}]);
   await runMainChat(input);
  }
 });
 it('does not insert a budget reminder when a required result is already saved',async()=>{
  const {source,faux}=await fixture();
  faux.setResponses([context=>{expect(JSON.stringify(context.messages)).not.toContain('server_budget');return fauxAssistantMessage('saved');}]);
  const runner=await AgentRunner.create({...source,cwd:dir,agentDir:dir,toolAllowlist:[],inMemory:true,maxTurns:1,maxWrapupTurns:1,wrapup:()=>undefined});
  try{await runner.prompt('LOCAL');expect(faux.state.callCount).toBe(1);}finally{await runner.dispose();}
 });
 it('nudges Reporter to save a versioned report instead of accepting an unsaved answer',async()=>{
  const {task,request,faux}=await fixture();
  const fid=Number((await db.query("INSERT INTO findings(task_id,name,summary,evidence,status) VALUES($1,'LOCAL','synthetic','LOCAL','confirmed') RETURNING id",[task.id])).rows[0]!.id);
  const version=Number((await db.query('SELECT evidence_version FROM findings WHERE id=$1',[fid])).rows[0]!.evidence_version);
  faux.setResponses([fauxAssistantMessage([fauxToolCall('get_finding',{finding_id:fid})]),fauxAssistantMessage('draft only'),fauxAssistantMessage([fauxToolCall('update_finding_report',{finding_id:fid,evidence_version:version,report:'LOCAL synthetic report'})]),fauxAssistantMessage('saved')]);
  const created=await request('POST','/api/conversations',{agent_key:'reporter',task_id:task.id});expect(created.statusCode).toBe(201);
  const run=await request('POST',`/api/conversations/${created.json().id}/messages`,{message:`LOCAL report #${fid}`});expect(run.statusCode).toBe(202);
  const id=run.json().run_id;await until(async()=>!(await db.query("SELECT 1 FROM conversation_runs WHERE id=$1 AND status IN ('queued','running')",[id])).rowCount);
  expect((await db.query('SELECT status,error FROM conversation_runs WHERE id=$1',[id])).rows[0]).toMatchObject({status:'completed'});
  expect((await db.query('SELECT report,report_evidence_version FROM findings WHERE id=$1',[fid])).rows[0]).toMatchObject({report:'LOCAL synthetic report',report_evidence_version:String(version)});expect(faux.state.callCount).toBe(3);
 });

 it.each(['auto','pentest'])('uses the unified %s prompt in an actual independent conversation',async role=>{
  const {task,request,faux}=await fixture();
  faux.setResponses([context=>{expect(JSON.stringify(context.messages)).toContain(JSON.stringify(ROLE_PROMPTS[role as keyof typeof ROLE_PROMPTS]).slice(1,-1));return fauxAssistantMessage('LOCAL acknowledged');}]);
  const created=await request('POST','/api/conversations',{agent_key:role,task_id:task.id});
  const run=await request('POST',`/api/conversations/${created.json().id}/messages`,{message:'LOCAL acknowledge only'});expect(run.statusCode).toBe(202);
  const id=run.json().run_id;await until(async()=>!(await db.query("SELECT 1 FROM conversation_runs WHERE id=$1 AND status IN ('queued','running')",[id])).rowCount);
  expect((await db.query('SELECT status,error FROM conversation_runs WHERE id=$1',[id])).rows[0]).toMatchObject({status:'completed'});
 });
 it('keeps only the allowed Skill index, leaving full instructions to native read',async()=>{
  const {source}=await fixture();const skills=path.join(dir,'test-skills');mkdirSync(path.join(skills,'fixture'),{recursive:true});
  writeFileSync(path.join(skills,'fixture','SKILL.md'),'---\nname: fixture\ndescription: index-description-marker\n---\nfull-skill-body-marker');
  const runner=await AgentRunner.create({...source,cwd:dir,agentDir:dir,skillsDir:skills,allowedSkills:['fixture'],toolAllowlist:['read'],inMemory:true,systemPrompt:await systemRolePrompt(db,'mainagent',{Goal:'LOCAL'})});
  try{
   expect(runner.promptDiagnostics.skill_index.utf8_bytes).toBeGreaterThan(0);
   // No model call or reading of SKILL.md is needed to construct the session.
   expect(runner.promptDiagnostics.role_body.utf8_bytes).toBeGreaterThan(0);
  }finally{await runner.dispose();}
 });

 it('preserves a terminal Planner override and ends without an extra decision tool',async()=>{
  const {task,source,faux}=await fixture();
  faux.setResponses([context=>{const text=JSON.stringify(context.messages);expect(text).toContain('CUSTOM-TIMEOUT-MARKER');expect(context.tools?.map(t=>t.name)||[]).not.toContain('add_intent');return fauxAssistantMessage('not yet saved');},fauxAssistantMessage([fauxToolCall('record_plan_decision',{status:'exhausted',reason:'LOCAL timeout',basis_ids:[],resume_when:'new explicit task'})]),fauxAssistantMessage('saved')]);
  await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal:'LOCAL',model:source,dataDir:dir,todos:new TodoStore(db),hooks:{},terminalOnly:true,wrapupPromptOverride:'CUSTOM-TIMEOUT-MARKER',triggersText:'timeout',maxTurns:5,onActivity:()=>{}});
  expect(faux.state.callCount).toBe(1);expect((await db.query('SELECT 1 FROM planner_decisions WHERE exploration_id=$1',[task.exploration_id])).rowCount).toBe(0);
  expect((await db.query("SELECT effective FROM runtime_role_configs WHERE task_id=$1 AND role='planner'",[task.id])).rows[0]!.effective).toMatchObject({max_turns:5,max_duration_ms:120_000});
 });

 it('actual role assembly preserves configured unlimited budgets outside terminal task settlement',async()=>{
  const rows=(await db.query('SELECT role,effective FROM runtime_role_configs ORDER BY started_at')).rows;
  for(const role of ['goals','planner','mainagent','auto','pentest','reporter'])
   expect(rows.find(r=>r.role===role)?.effective,role).toMatchObject({max_turns:0,max_duration_ms:0});
 });

});
