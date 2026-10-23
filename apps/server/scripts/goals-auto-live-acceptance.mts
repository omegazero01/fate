/** Real DeepSeek, public task API and the current native pi runtime.
 * Only disposable loopback evidence and private synthetic files are executed. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {createReadToolDefinition,createBashToolDefinition,createWriteToolDefinition,createEditToolDefinition} from '@earendil-works/pi-coding-agent';
import {Database,openDatabase} from '../dist/db/index.js';
import {postgresDSN} from '../dist/config/index.js';
import {Engine,defaultEngineConfig} from '../dist/engine/engine.js';
import {configureAgentEnv} from '../dist/agent/roles.js';
import {resolveRolePrompt} from '../dist/agent/prompts.js';
import {makeModelResolver} from '../dist/pi/modelResolver.js';
import {AgentRunner} from '../dist/pi/runner.js';
import {terminalExtension,TERMINAL_TOOLS} from '../dist/pi/terminal.js';
import {createTrackedRunner} from '../dist/engine/runtime-config.js';
import {runContext} from '../dist/tools/context.js';
import {mergedAssetSearchTool} from '../dist/tools/asset-search-compat.js';
import {configureEvidenceStore} from '../dist/evidence/blobs.js';
import {buildApp} from '../dist/http/app.js';
import {signJWT} from '../dist/http/auth.js';

const output=process.env.FATE_ACCEPTANCE_OUTPUT;
assert(output&&!existsSync(output),'FATE_ACCEPTANCE_OUTPUT must name a new evidence file');
const runID=randomUUID(),name=`fate_goals_auto_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-goals-auto-'));
const deadline=Date.now()+20*60_000;
const record:any={run_id:runID,database:name,data_dir:dir,status:'running',started_at:new Date().toISOString(),
 runtime:'compiled-dist',component_sha256:Object.fromEntries(['agent/roles','agent/tool-registry','agent/tool-loading','agent/planner-memory','db/exploration','pi/platform-mcp','pi/runner'].map(f=>[f,createHash('sha256').update(readFileSync('dist/'+f+'.js')).digest('hex')])),requests:[],runners:[],fixture_requests:[],observations:[],external_target_requests:0};
mkdirSync(path.dirname(output),{recursive:true});
let secret='',db:Database|undefined,engine:Engine|undefined,app:any,base='',fixtureBase='',automaticTaskID=0,expID=0;
const nonce=randomUUID(),jwtKey=randomUUID(),jwt=signJWT(jwtKey),scope=new AsyncLocalStorage<any>();
const originalFetch=globalThis.fetch,originalPrompt=AgentRunner.prototype.prompt;
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
 const source=new Database(new pg.Pool({connectionString:postgresDSN().dsn}));
 const profile=await source.platform().profileByID(Number(process.env.FATE_ACCEPTANCE_PROFILE_ID??453));
 const prompts=await Promise.all(['goals','planner','worker'].map(async role=>({role,...await resolveRolePrompt(source,role)})));
 const configs=(await source.query("SELECT key,max_turns,run_seconds,wrapup_max_turns,wrapup_prompt FROM agents WHERE key IN ('goals','planner','worker')")).rows;
 const bindings=(await source.query("SELECT key,enabled,agents,description FROM tools WHERE kind='builtin'")).rows;
 const sourceDSN=postgresDSN().dsn;await source.close();assert(profile?.apiKey&&profile.model==='deepseek-flash','Configured DeepSeek profile required');secret=profile.apiKey;
 const modelOrigin=new URL(profile.baseURL).origin;
 const isolated=new URL(sourceDSN);isolated.pathname='/'+name;process.env.SERIES_PG_DSN=isolated.href;process.env.SERIES_LOG_LEVEL='silent';
 db=await openDatabase();configureEvidenceStore(db,dir);mkdirSync(path.join(dir,'skills'));configureAgentEnv({skillsDir:path.join(dir,'skills')});
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
 record.prompt_versions=prompts.map(p=>({role:p.role,source:p.source,version:p.version}));record.budgets=configs.map(({wrapup_prompt,...c})=>c);
 record.fixture_configuration='Only HTTP execution enabled in automatic fixture; native file/command/PTY tools verified separately with local sandbox guards. Runtime prompts, model chain and native loops are unchanged.';
 engine=new Engine(db,{...defaultEngineConfig(),workers:2,debounceMs:150},makeModelResolver(db),dir);
 app=buildApp({version:'goals-auto-live-acceptance',startedAt:Date.now(),db,engine,jwtKey,dataDir:dir,skillsRoot:path.join(dir,'skills')});base=await app.listen({host:'127.0.0.1',port:0});engine.startScheduler();record.api_base=base;
 if(process.env.FATE_ACCEPTANCE_CASES!=='tools'){
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

 }
 // Same tracked pi runtime; actual SDK file tools and platform PTY implementation.
 const fileTask=await db.tasks().createTaskWithOptions('LOCAL file/command/PTY fixture','确认本地工具真实执行结果',{executionMode:'manual'});
 const cwd=path.join(dir,'tool-probe');mkdirSync(cwd);await db.query("UPDATE tasks SET status='running' WHERE id=$1",[fileTask.id]);
 const discoveryTools=[mergedAssetSearchTool(runContext(db,fileTask.id,fileTask.exploration_id,'worker'))],discoveryEvents:any[]=[];
 const discovery=await createTrackedRunner(db,fileTask.id,'worker',{...await makeModelResolver(db)(fileTask.id,'worker',{profileID}),cwd,agentDir:path.join(dir,'pi-agent'),inMemory:true,
  systemPrompt:'本地工具发现验收。必须先调用 tool_search，用英文关键词 asset search 搜索。等待搜索结果及下一轮工具声明后，调用搜索返回的资产摘要工具一次，dsl=port==80，然后结束；不要在搜索之前直接猜测调用。',
  customTools:discoveryTools,toolAllowlist:discoveryTools.map(t=>t.name),maxTurns:5,maxDurationMs:60_000,onActivity:a=>{if(['tool_start','tool_end'].includes(a.kind))discoveryEvents.push(a);}});
 const initial=discovery.activeToolNames;
 try{record.discovery_probe={task_id:fileTask.id,initial_tools:initial,result:await discovery.prompt('搜索后读取本任务的资产摘要；空结果也是实际结果，不得执行其他操作。'),final_tools:discovery.activeToolNames,activities:discoveryEvents};}finally{await discovery.dispose();}
 assert(!initial.includes('asset_search'));assert(record.discovery_probe.final_tools.includes('asset_search'));assert(discoveryEvents.some(a=>a.kind==='tool_end'&&a.toolName==='asset_search'&&!a.isError));assert(!discoveryEvents.some(a=>a.kind==='tool_end'&&a.isError));
 await db.query("UPDATE tools SET enabled=true WHERE key IN ('read','bash','write','edit','shell_open','shell_send','shell_read','shell_close','shell_list')");await db.query("UPDATE agents SET interactive_shell=true WHERE key='worker'");await db.platform().setSetting('pi_builtin_loading','direct');
 const env={PATH:'/usr/bin:/bin',HOME:cwd,SHELL:'/bin/sh',LANG:'en_US.UTF-8'};
 const tools=[createReadToolDefinition(cwd),createWriteToolDefinition(cwd),createEditToolDefinition(cwd),createBashToolDefinition(cwd,{spawnHook:c=>({...c,env})})];
 const command=`read x; printf 'terminal:%s\\n' "$x"`,activities:any[]=[];
 const runner=await createTrackedRunner(db,fileTask.id,'worker',{...await makeModelResolver(db)(fileTask.id,'worker',{profileID}),cwd,agentDir:path.join(dir,'pi-agent'),inMemory:true,
  systemPrompt:'你是本地工具验收助手。只执行用户指定的合成文件和终端检查，不能访问网络或其他目录。每项验证成功即继续下一项，全部成功后简短结束。',
  customTools:tools as any,toolAllowlist:[...tools.map(t=>t.name),...TERMINAL_TOOLS],extensionFactories:[terminalExtension(cwd,env)],maxTurns:16,maxDurationMs:180_000,
  guard:async g=>{if(['read','write','edit'].includes(g.toolName)&&path.resolve(cwd,String(g.args.path))!==path.join(cwd,'sample.txt'))return {block:true,reason:'Only the synthetic sample file is allowed'};if(g.toolName==='bash'&&!['wc -c sample.txt','cat sample.txt'].includes(String(g.args.command).trim()))return {block:true,reason:'Only literal local fixture commands are allowed'};if(g.toolName==='shell_open'&&g.args.command!==command)return {block:true,reason:'Only fixture terminal command is allowed'};if(g.toolName==='shell_send'&&g.args.text!=='LOCAL')return {block:true,reason:'Only LOCAL fixture text is allowed'};return undefined;},
  onActivity:a=>{if(['tool_start','tool_end'].includes(a.kind)){activities.push(a);record.tool_probe={task_id:fileTask.id,activities};save();}},
 });
 try{record.tool_probe={task_id:fileTask.id,activities,result:await runner.prompt(`依次使用实际工具验证：1 write 将 sample.txt 写成 alpha 加换行；2 read 读取确认；3 edit 精确把 alpha 改成 beta，保留换行；4 bash 执行且仅执行 wc -c sample.txt，预期5字节；5 shell_open 的 command 必须为 ${JSON.stringify(command)}，mode=handsfree；6 shell_list 确认句柄；7 shell_send 对该句柄 text=LOCAL、submit=true、quiet_ms=100、timeout_ms=5000；8 shell_read 读取已有输出（since_cursor=0），确认 terminal:LOCAL；9 shell_close 关闭该句柄。所有工具都必须真实调用，不能仅描述。成功后结束。`)};}finally{await runner.dispose();}
 assert.equal(record.tool_probe.result.stopReason,'completed');assert.equal(readFileSync(path.join(cwd,'sample.txt'),'utf8'),'beta\n');
 for(const name of [...tools.map(t=>t.name),...TERMINAL_TOOLS])assert(activities.some(a=>a.kind==='tool_end'&&a.toolName===name&&!a.isError),'Missing successful actual tool '+name);
 assert(!activities.some(a=>a.kind==='tool_end'&&a.isError),'Native execution tool errors');
 assert(activities.some(a=>a.kind==='tool_end'&&a.toolName==='bash'&&/\b5\b/.test(a.text??'')));assert(JSON.stringify(activities).includes('terminal:LOCAL'));
 await db.query("UPDATE tasks SET status='done',completed_at=now() WHERE id=$1",[fileTask.id]);
 record.status='passed';
}catch(e){record.status='failed';record.error=redact(e);console.error(record.error);}
finally{
 await engine?.shutdown().catch(e=>record.shutdown_error=redact(e));await app?.close();fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));
 AgentRunner.prototype.prompt=originalPrompt;globalThis.fetch=originalFetch;
 if(db){record.audit=(await db.query('SELECT id,task_id,role,purpose,status,error,usage,runtime_id FROM llm_request_attempts ORDER BY id')).rows;
  record.activities=(await db.query("SELECT id,worker,kind,tool,is_error,summary,detail,metadata,created_at FROM activity WHERE kind NOT IN ('thinking','usage') ORDER BY id")).rows;
  record.nodes=(await db.query('SELECT * FROM exploration_nodes ORDER BY id')).rows;
  record.traffic=(await db.query('SELECT id,task_id,intent_id,host FROM traffic_exchanges ORDER BY id')).rows;record.external_target_requests=record.traffic.filter((r:any)=>!/^127\.0\.0\.1(?::[0-9]+)?$/.test(r.host)).length;
  if(record.external_target_requests){record.status='failed';record.error='Recorded non-fixture target traffic';}
  record.tool_errors=record.activities.filter((a:any)=>a.kind==='tool_result'&&a.is_error);record.tool_probe_errors=record.tool_probe?.activities.filter((a:any)=>a.kind==='tool_end'&&a.isError)??[];record.discovery_probe_errors=record.discovery_probe?.activities.filter((a:any)=>a.kind==='tool_end'&&a.isError)??[];
  if(record.status==='passed'&&record.tool_errors.length){record.status='failed';record.error='Automatic task had tool errors; inspect and fix before acceptance';}
  record.usage=record.audit.reduce((sum:any,a:any)=>{for(const k of ['input','output','cacheRead','cacheWrite','totalTokens'])sum[k]=(sum[k]??0)+Number(a.usage?.[k]??0);return sum;},{});
  await db.query("UPDATE tasks SET paused=true WHERE status NOT IN ('done','failed','timeout')");await db.query("UPDATE llm_profiles SET api_key=''");await db.close();}
 record.finished_at=new Date().toISOString();save();console.log(JSON.stringify({status:record.status,requests:record.requests.length,error:record.error,output}));
}
process.exitCode=record.status==='passed'?0:1;
