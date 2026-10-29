/** Paired DeepSeek acceptance: selectable compiled runtime, same prompts and local HTTP fixture.
 * Only disposable loopback evidence is executed; command, file and MCP tools are unavailable. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
const runtimeRoot=path.resolve(process.env.FATE_RUNTIME_ROOT??'dist');
const runtime=async(file:string)=>import('file://'+path.join(runtimeRoot,file+'.js'));
const {Database,openDatabase}=await runtime('db/index');
const {postgresDSN}=await runtime('config/index');
const {Engine,defaultEngineConfig}=await runtime('engine/engine');
const {configureAgentEnv}=await runtime('agent/roles');
const {resolveRolePrompt}=await runtime('agent/prompts');
const {makeModelResolver}=await runtime('pi/modelResolver');
const {AgentRunner}=await runtime('pi/runner');
const {configureEvidenceStore}=await runtime('evidence/blobs');
const {buildApp}=await runtime('http/app');
const {signJWT}=await runtime('http/auth');

const output=process.env.FATE_ACCEPTANCE_OUTPUT;
assert(output&&!existsSync(output),'FATE_ACCEPTANCE_OUTPUT must name a new evidence file');
const runID=randomUUID(),name=`fate_context_auto_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-goals-auto-'));
const deadline=Date.now()+20*60_000;
const record:any={run_id:runID,database:name,data_dir:dir,status:'running',started_at:new Date().toISOString(),
 runtime:runtimeRoot,variant:process.env.FATE_VARIANT??'after',component_sha256:Object.fromEntries(['agent/roles','agent/tool-registry','agent/tool-loading','agent/planner-memory','db/exploration','pi/platform-mcp','pi/runner'].map(f=>[f,createHash('sha256').update(readFileSync(path.join(runtimeRoot,f+'.js'))).digest('hex')])),requests:[],runners:[],fixture_requests:[],observations:[],external_target_requests:0};
mkdirSync(path.dirname(output),{recursive:true});
let secret='',db:any,engine:any,app:any,base='',fixtureBase='',automaticTaskID=0,expID=0;
const nonce=randomUUID(),jwtKey=randomUUID(),jwt=signJWT(jwtKey),scope=new AsyncLocalStorage<any>();
const originalFetch=globalThis.fetch,originalPrompt=AgentRunner.prototype.prompt,originalCreate=AgentRunner.create;
AgentRunner.create=async function(opts:any){const guard=opts.guard;return originalCreate.call(this,{...opts,guard:async(g:any)=>{if(g.toolName==='http_request'&&new URL(String(g.args.url)).origin!==fixtureBase) return {block:true,reason:'Acceptance allows loopback fixture only'};return guard?.(g);}});};
const redact=(e:unknown)=>String(e).split(secret||'\0').join('[redacted]').replace(/Bearer\s+[\w.-]+/gi,'Bearer [redacted]');
const save=()=>{const text=JSON.stringify(record,null,2);assert(!secret||!text.includes(secret),'Credential must not enter report');writeFileSync(output,text+'\n',{mode:0o600});};
const fixture=http.createServer((req,res)=>{
 const u=new URL(req.url!,fixtureBase),accepted=req.method==='GET'&&(u.pathname==='/sample'||u.pathname==='/confirm'&&u.searchParams.get('token')===nonce);
 record.fixture_requests.push({at:new Date().toISOString(),method:req.method,path:u.pathname,accepted});save();
 res.writeHead(accepted?200:400,{'content-type':'application/json'});
 res.end(JSON.stringify(!accepted?{error:'invalid synthetic request'}:u.pathname==='/sample'?{fixture:'LOCAL_SYNTHETIC',values:[4,7,9],token:nonce}:{fixture:'LOCAL_SYNTHETIC',verified:true,total:20,token:nonce}));
});
async function until(fn:()=>Promise<unknown>,label:string,ms=600_000){const end=Math.min(Date.now()+ms,deadline);while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,100));}throw Error(`timeout: ${label}`);}
async function api(route:string,body?:unknown){const r=await originalFetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Series-Token':jwt,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)});const v=await r.json();assert(r.ok,`${route}: ${r.status} ${JSON.stringify(v)}`);return v as any;}
try{
 const source=new Database(new pg.Pool({connectionString:postgresDSN().dsn,options:'-c default_transaction_read_only=on'}));
 const profile=await source.platform().profileByID(Number(process.env.FATE_ACCEPTANCE_PROFILE_ID??541));
 const prompts=await Promise.all(['goals','planner','worker'].map(async role=>({role,...await resolveRolePrompt(source,role)})));
 const configs=(await source.query("SELECT key,max_turns,run_seconds,wrapup_max_turns,wrapup_prompt FROM agents WHERE key IN ('goals','planner','worker')")).rows;
 const bindings=(await source.query("SELECT key,enabled,agents,description FROM tools WHERE kind='builtin'")).rows;
 const sourceDSN=postgresDSN().dsn;await source.close();assert(profile?.apiKey&&profile.model==='deepseek-flash','Configured DeepSeek profile required');secret=profile.apiKey;
 const modelOrigin=new URL(profile.baseURL).origin;
 const isolated=new URL(sourceDSN);isolated.pathname='/'+name;process.env.SERIES_PG_DSN=isolated.href;process.env.SERIES_LOG_LEVEL='silent';
 db=await openDatabase();(await runtime('pi/usage-meter')).configureUsageOutbox(db,dir);configureEvidenceStore(db,dir);mkdirSync(path.join(dir,'skills'));configureAgentEnv({skillsDir:path.join(dir,'skills')});
 await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));fixtureBase=`http://127.0.0.1:${(fixture.address() as any).port}`;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(u.origin===fixtureBase)return originalFetch(input,init);
  assert.equal(u.origin,modelOrigin,'Fixture allows model and local evidence only');assert(Date.now()<deadline,'Acceptance deadline');
  const context=scope.getStore()??{},body=typeof init?.body==='string'?JSON.parse(init.body):{},messages=JSON.stringify(body.messages??[]);
  const row:any={number:record.requests.length+1,at:new Date().toISOString(),role:context.role,phase:context.phase,task_id:context.taskID,
   bytes:Buffer.byteLength(JSON.stringify(body)),tools:(body.tools??[]).map((t:any)=>t.function?.name??t.name),background_present:messages.includes('BACKGROUND_ONLY_MARKER'),discovery_guidance_present:messages.includes('<tool_loading>')};
  record.requests.push(row);save();
  if(context.role==='goals'&&context.phase==='objectives')assert(!row.background_present,'Description leaked into goal-only input');
  if(context.role==='worker'&&context.taskID===automaticTaskID){
   const s=db!.exploration(expID),intent=(await s.listByKind('intent')).find(n=>n.state==='running'),facts=(await s.listByKind('fact')).filter(n=>n.payload.from_intent===intent?.id);
   if(facts.length&&!record.incremental_visibility){record.incremental_visibility={at:new Date().toISOString(),intent_id:intent!.id,intent_state:intent!.state,fact_ids:facts.map(n=>n.id)};save();}
  }
  try{const response=await originalFetch(input,init);row.status=response.status;return response;}catch(e){row.error=redact(e);throw e;}finally{save();}
 };
 AgentRunner.prototype.prompt=async function(...args:Parameters<typeof originalPrompt>){
  const opts=(this as any).opts,p=opts.platform??{},context={...p,phase:opts.goalsPhase};
  const entry:any={...context,intent_id:opts.intentID,session_id:this.sessionId,initial_tools:this.activeToolNames,started_at:new Date().toISOString()};record.runners.push(entry);save();
  return scope.run(context,async()=>{try{const result=await originalPrompt.apply(this,args);Object.assign(entry,{result,final_tools:this.activeToolNames});return result;}catch(e){entry.error=redact(e);throw e;}finally{entry.finished_at=new Date().toISOString();save();}});
 };
 const profileID=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL Goals full-chain DeepSeek',isDefault:true,poolExclude:true,proxy:'',streaming:true});
 for(const p of prompts){const a=(await db.platform().getAgentByKey(p.role))!;await db.platform().savePrompt(a.id,p.template,'Current deployed prompt copied for isolated acceptance','acceptance');}
 for(const c of configs)await db.query('UPDATE agents SET max_turns=$2,run_seconds=$3,wrapup_max_turns=$4,wrapup_prompt=$5 WHERE key=$1',[c.key,c.max_turns,c.run_seconds,c.wrapup_max_turns,c.wrapup_prompt]);
 for(const b of bindings)await db.query('UPDATE tools SET enabled=$2,agents=$3::jsonb,description=$4 WHERE key=$1',[b.key,b.enabled,JSON.stringify(b.agents),b.description]);
 await db.query("UPDATE tools SET enabled=false WHERE key IN ('read','bash','write','edit','shell_open','shell_send','shell_read','shell_close','shell_list')");
 await db.platform().setSetting('workers','2');
 await db.platform().setSetting('planner_context_budget_tokens',process.env.FATE_VARIANT==='before'?'0':'48000');
 await db.platform().setSetting('worker_context_budget_tokens',process.env.FATE_VARIANT==='before'?'0':'64000');
 record.prompt_versions=prompts.map(p=>({role:p.role,source:p.source,version:p.version}));record.budgets=configs.map(({wrapup_prompt,...c})=>c);
 record.fixture_configuration='Only HTTP execution enabled in automatic fixture; native file/command/PTY tools verified separately with local sandbox guards. Runtime prompts, model chain and native loops are unchanged.';
 engine=new Engine(db,{...defaultEngineConfig(),workers:2,debounceMs:150},makeModelResolver(db),dir);
 app=buildApp({version:'goals-auto-live-acceptance',startedAt:Date.now(),db,engine,jwtKey,dataDir:dir,skillsRoot:path.join(dir,'skills')});base=await app.listen({host:'127.0.0.1',port:0});engine.startScheduler();record.api_base=base;
 const assetTitle='LOCAL-'+randomUUID(),asset=await db.assets().upsertHTTPService({url:fixtureBase+'/sample',pageTitle:assetTitle});
 const goal='证明本地合成样本总和与独立核对值一致，形成有证据的核验结论。';
 const constraints=`操作约束：只允许 GET ${fixtureBase}/sample 和 ${fixtureBase}/confirm?token=<样本中的token>。禁止访问外部网络、扫描、修改数据、执行命令、读写文件和 MCP。`;
 const target=`明确授权本次测试资产 127.0.0.1，测试服务为 ${fixtureBase}，这是已授权的一次性本地合成服务。`;
 const phases=`执行阶段约束：必须由两条串行意图完成。意图 A 只读取 sample、计算总和、读取资产详情并及时写事实，然后结束，不得访问 confirm。只有 A 已结束且事实已发布后，Planner 才能下发 B；B 只依据 A 的事实及 token 读取 confirm，比对结果后写回，不重复请求 sample。`;
 const description=`BACKGROUND_ONLY_MARKER：架构分析、接口梳理、漏洞挖掘仅为背景，不是额外交付要求。\n\n${constraints}\n\n${target}\n\n${phases}\n\nPlanner 背景方法：共两条串行意图，A 读取 sample 并计算 values 总和，asset_get 未在本轮声明中时先用 tool_search 加载，已声明则直接用 asset_get 的 ids/fields 读取资产 #${asset} 的 fingerprint，将实际 page_title、values、总和、token、traffic_id 及时 record_fact 保存；写回后简短总结退出。B 只有 A done 后才能派发，读取 A 的 fact，以其为 parent_ids，复用 token 请求 confirm，检查 verified=true 及 total 等于样本总和，将对应 traffic_id 和比对结论 record_fact 后总结退出。不要重复成功的请求或事实。不将这两个执行步骤拆成额外目标。每条意图只含自己的终点；锚定资产 #${asset}，允许 http_request、asset_get、tool_search，禁止 Planner 直接请求。两条意图完成后根据最新实测证据 prove_goal，让任务自然结束；没有漏洞则不需要 report_finding。`;
 const task=await api('/api/tasks',{name:`LOCAL-GOALS-AUTO-${runID.slice(0,8)}`,description,goal,execution_mode:'managed',llm_profile_ids:[profileID],asset_ids:[asset],coverage_enabled:false,seed_first_intent:false,timeout_seconds:720,plan_heartbeat_seconds:60});
 automaticTaskID=Number(task.id);expID=Number(task.exploration_id);record.task_id=automaticTaskID;record.exploration_id=expID;record.inputs={goal,description};save();
 let peak=0;
 await until(async()=>{const t=await db!.tasks().getTask(automaticTaskID);const count=Number((await db!.query('SELECT count(*) n FROM engine_worker_slots WHERE task_id=$1',[automaticTaskID])).rows[0].n);peak=Math.max(peak,count);if(t?.paused||t&&['timeout','failed'].includes(t.status))throw Error('Unexpected lifecycle: '+JSON.stringify({status:t.status,paused:t.paused}));return t?.status==='done';},'automatic natural completion');
 await until(async()=>!(await db!.query('SELECT 1 FROM runtime_role_configs WHERE task_id=$1 AND finished_at IS NULL',[automaticTaskID])).rowCount,'runner cleanup',30_000);
 const calls=record.requests.length;await new Promise(r=>setTimeout(r,2000));assert.equal(record.requests.length,calls,'No extra model requests after natural completion');
 const s=db.exploration(expID),goals=await s.listByKind('goal'),intents=await s.listByKind('intent'),facts=(await s.listByKind('fact')).filter(n=>n.payload.from_intent);
 const bootstrap=(await db.query('SELECT phase,fallback,goal_ids FROM goals_bootstrap WHERE task_id=$1',[automaticTaskID])).rows[0];
 const rules=(await db.query('SELECT kind,text,source FROM task_constraints WHERE exploration_id=$1',[expID])).rows;
 const stages=record.runners.filter((r:any)=>r.taskID===automaticTaskID&&r.role==='goals');
 const goalRequests=record.requests.filter((r:any)=>r.task_id===automaticTaskID&&r.role==='goals');
 record.automatic={task:await db.tasks().getTask(automaticTaskID),bootstrap,goals,intents,facts,constraints:rules,
  scope:await db.taskScope().listTaskScope(automaticTaskID),edges:(await db.query('SELECT * FROM exploration_edges WHERE exploration_id=$1 ORDER BY id',[expID])).rows,
  anchors:(await db.query('SELECT a.* FROM exploration_anchors a JOIN exploration_nodes n ON n.id=a.node_id WHERE n.exploration_id=$1',[expID])).rows,peak_workers:peak};
 assert.equal(bootstrap.phase,'completed');assert.equal(bootstrap.fallback,false);assert.equal(goals.length,1);assert.equal(goals[0]!.state,'met');assert.equal(goals[0]!.payload.source.field,'goal');assert(goal.includes(goals[0]!.payload.source.quote));
 assert.deepEqual(stages.map((r:any)=>r.phase),['constraints','objectives']);assert(goalRequests.filter((r:any)=>r.phase==='objectives').every((r:any)=>!r.background_present&&r.tools.join(',')==='set_goals'));
 assert(rules.some(r=>r.text===constraints));assert(record.automatic.scope.some((r:any)=>r.kind==='ip'&&r.net==='127.0.0.1/32'));assert.equal(intents.length,2);assert(intents.every(n=>n.state==='done'));assert.equal(facts.length,2);assert(JSON.stringify(facts).includes(assetTitle));assert.equal(record.incremental_visibility?.intent_state,'running');assert(peak<=2);
 for(const action of ['/sample','/confirm'])assert.equal(record.fixture_requests.filter((r:any)=>r.path===action&&r.accepted).length,1,'Successful requests must not repeat');
 const [first,second]=intents.toSorted((a,b)=>a.id-b.id),firstFact=facts.find(n=>Number(n.payload.from_intent)===first!.id)!;
 const workers=record.runners.filter((r:any)=>r.taskID===automaticTaskID&&r.role==='worker'),firstWorker=workers.find((r:any)=>r.intent_id===first!.id)!;
 assert(firstWorker&&Date.parse(firstWorker.finished_at)<=new Date(second!.created_at).getTime(),'Dependent direction starts only after original Worker exits');
 assert(new Date(firstFact.created_at).getTime()<=Date.parse(firstWorker.finished_at),'Fact visible before Worker returns');
 assert(record.automatic.edges.some((e:any)=>Number(e.src_id)===firstFact.id&&Number(e.dst_id)===second!.id&&e.rel==='derived_from'),'Planner derives next intent from published fact');
 assert(Date.parse(stages.at(-1).finished_at)<=Date.parse(record.runners.find((r:any)=>r.taskID===automaticTaskID&&r.role==='planner').started_at),'Planner starts after both Goals phases');
 for(const fact of facts)assert(record.automatic.anchors.some((a:any)=>Number(a.node_id)===fact.id&&Number(a.asset_id)===asset),'Actual evidence is anchored to the asset graph');
 const realToolRows=(await db.query("SELECT worker,tool,is_error FROM activity WHERE exploration_id=$1 AND kind='tool_result'",[expID])).rows;
 for(const tool of ['asset_get','http_request','record_fact'])assert(realToolRows.some((a:any)=>String(a.worker).startsWith('work#')&&a.tool===tool&&!a.is_error),'Worker uses actual tool '+tool);
 record.automatic.causality={goals_completed_before_planning:true,dependent_intent_after_worker_exit:true,fact_published_before_worker_return:true,published_fact_drives_next_intent:true,all_facts_anchored:true};
 console.log(JSON.stringify({phase:'automatic',status:'passed',task_id:automaticTaskID,requests:record.requests.length,peak_workers:peak}));save();

 record.status='passed';
}catch(e){record.status='failed';record.error=redact(e);console.error(record.error);}
finally{
 await engine?.shutdown().catch(e=>record.shutdown_error=redact(e));await app?.close();fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));
 AgentRunner.prototype.prompt=originalPrompt;AgentRunner.create=originalCreate;globalThis.fetch=originalFetch;
 if(db){try{record.audit=(await db.query('SELECT id,task_id,role,purpose,status,error,usage,runtime_id FROM llm_request_attempts ORDER BY id')).rows;
  record.activities=(await db.query("SELECT id,worker,kind,tool,is_error,summary,detail,metadata,created_at FROM activity WHERE kind NOT IN ('thinking','usage') ORDER BY id")).rows;
  record.nodes=(await db.query('SELECT * FROM exploration_nodes ORDER BY id')).rows;
  record.traffic=(await db.query('SELECT id,task_id,intent_id,host FROM traffic_exchanges ORDER BY id')).rows;record.external_target_requests=record.traffic.filter((r:any)=>!/^127\.0\.0\.1(?::[0-9]+)?$/.test(r.host)).length;
  if(record.external_target_requests){record.status='failed';record.error='Recorded non-fixture target traffic';}
  record.tool_errors=record.activities.filter((a:any)=>a.kind==='tool_result'&&a.is_error);
  // Invalid model arguments are expected guard rejections, not successful calls.
  // Keep their cost/errors visible; accept only if the same tool later succeeds
  // AND the complete factual/lifecycle assertions above have already passed.
  record.validation_rejections=record.tool_errors.filter((e:any)=>
    (e.tool==='set_constraints'&&e.detail.includes('原文依据')||e.tool==='add_intent'&&/依据.*(fact\/finding|已变化)/.test(e.detail))&&
    record.activities.some((a:any)=>Number(a.id)>Number(e.id)&&a.kind==='tool_result'&&a.tool===e.tool&&!a.is_error));
  record.unexpected_tool_errors=record.tool_errors.filter((e:any)=>!record.validation_rejections.includes(e));
  if(record.status==='passed'&&record.unexpected_tool_errors.length){record.status='failed';record.error='Unexpected execution tool errors';}
  record.ledger=(await db.query(`SELECT request_id,task_id,role,purpose,quality,usage FROM llm_usage_ledger WHERE source IN ('provider','request_audit') ORDER BY created_at,request_id`)).rows;
  record.usage=record.ledger.reduce((sum:any,a:any)=>{for(const k of ['input','inputTotal','output','cacheRead','cacheWrite','totalTokens'])sum[k]=(sum[k]??0)+Number(a.usage?.[k]??0);return sum;},{});
  record.cache_hit_rate=record.ledger.every((r:any)=>r.quality==='complete')&&record.usage.inputTotal?record.usage.cacheRead/record.usage.inputTotal:null;
  const totals=(await (await runtime('db/usage-ledger')).aggregateUsage(db))[0];
  record.platform_usage=totals;
  assert.equal(totals.calls,record.requests.length);assert.equal(totals.input_tokens,record.usage.inputTotal);assert.equal(totals.output_tokens,record.usage.output);assert.equal(totals.cache_read_tokens,record.usage.cacheRead);assert.equal(totals.usage_complete,true);
  record.runtime_diagnostics=(await db.query('SELECT role,effective FROM runtime_role_configs ORDER BY started_at')).rows;
  await db.query("UPDATE tasks SET paused=true WHERE status NOT IN ('done','failed','timeout')");}
  catch(e){record.status='failed';record.error=redact(e);}
  finally{try{await db.query("UPDATE llm_profiles SET api_key=''");}finally{await db.close();}}}
 record.finished_at=new Date().toISOString();save();console.log(JSON.stringify({status:record.status,requests:record.requests.length,error:record.error,output}));
}
process.exitCode=record.status==='passed'?0:1;
