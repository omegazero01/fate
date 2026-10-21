/** Opt-in real-provider acceptance. Uses the deployed build, an isolated database,
 * a loopback HTTP fixture, and runtime credentials; never writes production data. */
import pg from 'pg';
import http from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Database,openDatabase} from '../dist/db/index.js';
import {postgresDSN} from '../dist/config/index.js';
import {Engine,defaultEngineConfig} from '../dist/engine/engine.js';
import {makeModelResolver} from '../dist/pi/modelResolver.js';
import {resolveRolePrompt} from '../dist/agent/prompts.js';
import {configureAgentEnv} from '../dist/agent/roles.js';
import {AgentRunner} from '../dist/pi/runner.js';
import {buildApp} from '../dist/http/app.js';
import {signJWT} from '../dist/http/auth.js';
import {configureEvidenceStore} from '../dist/evidence/blobs.js';
import {createTrackedRunner} from '../dist/engine/runtime-config.js';
import {contextGetTool} from '../dist/tools/context-read.js';
import {addIntentTool} from '../dist/tools/intents.js';
import {runContext} from '../dist/tools/context.js';

const output=process.env.FATE_ACCEPTANCE_OUTPUT;
assert.ok(output&&!existsSync(output),'FATE_ACCEPTANCE_OUTPUT must name a fresh result file');
const deadline=Date.now()+20*60_000,runID=randomUUID(),name=`fate_seven_live_${process.pid}`;
const dir=mkdtempSync(path.join(tmpdir(),'fate-seven-live-'));
const record:any={run_id:runID,started_at:new Date().toISOString(),status:'running',database:name,data_dir:dir,
  build_sha256:createHash('sha256').update(readFileSync('dist/pi/runner.js')).digest('hex'),external_target_requests:0,requests:[],fixture_requests:[],cases:[],runners:[]};
mkdirSync(path.dirname(output),{recursive:true});
let secret='',db:InstanceType<typeof Database>|undefined,engine:InstanceType<typeof Engine>|undefined,app:any,current:any,base='',fixtureBase='';
const safeError=(e:unknown)=>String(e).split(secret||'\0').join('[redacted]').replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]');
const save=()=>writeFileSync(output,JSON.stringify(record,null,2)+'\n');
const originalFetch=globalThis.fetch,originalPrompt=AgentRunner.prototype.prompt;
const scope=new AsyncLocalStorage<any>(),samples=new Map<string,string>();
const fixture=http.createServer((req,res)=>{
  const url=new URL(req.url!,fixtureBase),[,kind,action]=url.pathname.split('/'),nonce=samples.get(kind!);
  const accepted=req.method==='GET'&&nonce&&(action==='sample'||action==='confirm'&&url.searchParams.get('token')===nonce);
  record.fixture_requests.push({at:new Date().toISOString(),method:req.method,path:url.pathname,action,case:kind,accepted:!!accepted});save();
  res.writeHead(accepted?200:400,{'content-type':'application/json'});
  res.end(JSON.stringify(accepted?(action==='sample'?{fixture:'SYNTHETIC',values:[4,7,9],token:nonce}:{fixture:'SYNTHETIC',verified:true,total:20,token:nonce}):{error:'invalid fixture request'}));
});
const jwtKey=randomUUID(),token=signJWT(jwtKey);
async function until(fn:()=>Promise<any>,label:string,ms=480_000){const end=Math.min(Date.now()+ms,deadline);while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error(`timeout: ${label}`);}
async function api(url:string,body?:unknown){const r=await originalFetch(base+url,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)});const value=await r.json();assert.ok(r.ok,`${url}: ${r.status} ${JSON.stringify(value)}`);return value as any;}
async function startHost(){
  const resolve=makeModelResolver(db!);
  const resolver:typeof resolve=async(taskID,role,context)=>{
    if(role==='worker'&&current?.kind==='legacy_loadout'&&current.task_id===taskID&&!current.legacy_session){
      const intent=(await db!.exploration(current.exploration_id).listByKind('intent')).find(n=>n.state==='open');
      if(intent){
        current.legacy_seed_in_progress=true;
        const cwd=path.join(dir,'tasks',String(taskID),`i${intent.id}`);mkdirSync(cwd,{recursive:true});
        const old=await createTrackedRunner(db!,taskID,'worker',{...await resolve(taskID,role,context),
          cwd,agentDir:path.join(dir,'pi-agent'),resumeSessionPath:path.join(dir,'sessions',`exp${current.exploration_id}-worker-i${intent.id}.jsonl`),
          systemPrompt:'LOCAL synthetic session preparation. Reply READY only. Do not execute the intent or claim any observation.',
          customTools:[contextGetTool(runContext(db!,taskID,current.exploration_id,'worker'))],toolAllowlist:['context_get'],maxTurns:1,maxDurationMs:30_000});
        try{
          current.legacy_session={id:old.sessionId,intent_id:intent.id,active_tools:old.activeToolNames};
          assert.ok(!old.activeToolNames.includes('record_fact'));assert.ok(!old.activeToolNames.includes('tool_search'));
          const r=await old.prompt('LOCAL legacy declaration fixture: reply READY. Host will later resume this session for the actual intent.');assert.equal(r.stopReason,'completed');
        }finally{await old.dispose();current.legacy_seed_in_progress=false;save();}
      }
    }
    return resolve(taskID,role,context);
  };
  engine=new Engine(db!,{...defaultEngineConfig(),workers:1,debounceMs:150},resolver,dir);app=buildApp({version:'seven-role-live-acceptance',startedAt:Date.now(),db:db!,engine,jwtKey,skillsRoot:path.join(dir,'skills'),dataDir:dir});base=await app.listen({host:'127.0.0.1',port:0});engine.startScheduler();record.api_base=base;save();}
try{
  const source=new Database(new pg.Pool({connectionString:postgresDSN().dsn}));
  const profileID=Number(process.env.FATE_ACCEPTANCE_PROFILE_ID??453),profile=await source.platform().profileByID(profileID);
  const prompts=await Promise.all(['goals','planner','worker'].map(async role=>({role,...await resolveRolePrompt(source,role)})));
  const configs=(await source.query("SELECT key,max_turns,run_seconds,wrapup_max_turns,wrapup_prompt FROM agents WHERE key IN ('goals','planner','worker')")).rows;
  const bindings=(await source.query("SELECT key,enabled,agents,description FROM tools WHERE kind='builtin'")).rows;
  const sourceDSN=postgresDSN().dsn;await source.close();
  assert.ok(profile?.apiKey&&profile.model==='deepseek-flash'&&new URL(profile.baseURL).origin==='https://api.deepseek.com','official runtime profile required');secret=profile.apiKey;
  const isolated=new URL(sourceDSN);isolated.pathname='/'+name;process.env.SERIES_PG_DSN=isolated.href;process.env.SERIES_LOG_LEVEL='silent';
  db=await openDatabase();configureEvidenceStore(db,dir);mkdirSync(path.join(dir,'skills'));configureAgentEnv({skillsDir:path.join(dir,'skills')});
  await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));fixtureBase=`http://127.0.0.1:${(fixture.address() as any).port}`;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.origin===fixtureBase)return originalFetch(input,init);
    if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com')throw Error('LOCAL acceptance denied non-model/non-fixture destination');
    if(Date.now()>=deadline)throw Error('acceptance wall-clock deadline reached');
    const context=scope.getStore()??{},body=typeof init?.body==='string'?JSON.parse(init.body):{},names=(body.tools??[]).map((t:any)=>t.function.name);
    if(context.role==='worker'&&current?.task_id===context.taskID){
      const s=db!.exploration(current.exploration_id),intent=(await s.listByKind('intent')).find(n=>n.state==='running');
      if(intent){
        context.intentID=intent.id;
        const facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed'&&n.payload.from_intent===intent.id);
        if(facts.length)current.incremental_visibility??={at:new Date().toISOString(),intent_id:intent.id,intent_state:intent.state,fact_ids:facts.map(n=>n.id)};
        if(current.kind==='pause_restart'&&!current.pause_ready&&facts.length){
          current.pause_ready=true;current.interrupted_intent=intent.id;current.saved_facts=facts.map(n=>({id:n.id,payload:n.payload,version:n.content_version}));save();
          await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('pause driver did not abort')),15_000);const done=()=>{clearTimeout(timer);resolve();};if(init?.signal?.aborted)done();else init?.signal?.addEventListener('abort',done,{once:true});});
          throw new DOMException('Acceptance pause before provider transport','AbortError');
        }
        if(current.resumed&&intent.id===current.interrupted_intent&&!current.resumed_context){const messages=JSON.stringify(body.messages);current.resumed_context={at:new Date().toISOString(),intent_id:intent.id,has_fact_refs:current.saved_facts.every((f:any)=>messages.includes(String(f.id))),has_observed_token:messages.includes(samples.get(current.kind)!),tools:names};}
      }
    }
    const req:any={number:record.requests.length+1,at:new Date().toISOString(),role:context.role??'unknown',task_id:context.taskID,intent_id:context.intentID,bytes:Buffer.byteLength(JSON.stringify(body)),tools:names};record.requests.push(req);save();
    try{const response=await originalFetch(input,init);req.status=response.status;save();return response;}catch(e){req.error=safeError(e);save();throw e;}
  };
  AgentRunner.prototype.prompt=async function(...args:Parameters<typeof originalPrompt>){const p=(this as any).opts.platform??{},entry:any={role:p.role,test_phase:current?.legacy_seed_in_progress?'legacy_seed':'execution',task_id:p.taskID,session_id:this.sessionId,session_file:this.sessionFile,initial_tools:this.activeToolNames,started_at:new Date().toISOString()};record.runners.push(entry);save();return scope.run(p,async()=>{try{const r=await originalPrompt.apply(this,args);Object.assign(entry,{result:r,final_tools:this.activeToolNames,finished_at:new Date().toISOString()});save();return r;}catch(e){entry.error=safeError(e);entry.finished_at=new Date().toISOString();save();throw e;}});};
  const profileId=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL official DeepSeek acceptance',isDefault:true,poolExclude:true,proxy:'',streaming:true});
  for(const p of prompts){const a=await db.platform().getAgentByKey(p.role);await db.platform().savePrompt(a!.id,p.template,'isolated current runtime prompt','acceptance');}
  for(const c of configs)await db.query('UPDATE agents SET max_turns=$2,run_seconds=$3,wrapup_max_turns=$4,wrapup_prompt=$5 WHERE key=$1',[c.key,c.max_turns,c.run_seconds,c.wrapup_max_turns,c.wrapup_prompt]);
  for(const b of bindings)await db.query("UPDATE tools SET enabled=$2,agents=$3::jsonb,description=$4 WHERE key=$1 AND kind='builtin'",[b.key,b.enabled,JSON.stringify(b.agents),b.description]);
  record.binding_source='current production builtin enabled/agents/descriptions, copied without modification; shell disabled for local-only fixture';
  record.profile={id:profileID,model:profile.model,endpoint:profile.baseURL};record.prompt_versions=prompts.map(p=>({role:p.role,source:p.source,version:p.version}));record.role_budgets=configs.map(({wrapup_prompt,...c})=>c);
  // No shell or filesystem execution is needed for the loopback HTTP evidence.
  await db.query("UPDATE tools SET enabled=false WHERE key IN ('bash','write','edit','shell_open','shell_send','shell_read','shell_close','shell_list')");
  await db.platform().setSetting('workers','1');await startHost();
  for(const kind of (process.env.FATE_ACCEPTANCE_CASES??'serial,pause_restart,legacy_loadout').split(',')){
    samples.set(kind,randomUUID());const sampleURL=`${fixtureBase}/${kind}/sample`;
    const assetTitle='LOCAL-SYNTHETIC-'+randomUUID();
    const asset=await db.assets().upsertHTTPService({url:sampleURL,pageTitle:assetTitle});
    const goal='证明本地样本 values 合计与独立 confirm 的 total 一致且 verified=true，保存两条对应真实 HTTP 证据的 observed 事实；样本事实必须同时包含资产记录中的完整 page_title，使用 asset_get 读取，不能只依赖启动摘要。';
    const description=`这是本地调度验收，不是漏洞测试。唯一测试资源为 ${fixtureBase}/${kind}/sample 和 ${fixtureBase}/${kind}/confirm?token=<样本 token>，只允许 GET。禁止外部网络、扫描、命令、文件和 MCP。资产 ID=${asset}，所有意图和事实锚定该资产。\n总共两个串行意图。A：读取 sample，计算 values 合计，立即 record_fact 保存完整 values、合计、token 和 traffic_id，然后用简短最终答复结束。先用 tool_search 的英文查询 asset_get 加载资产详情工具，再调用 asset_get 读取字段 fingerprint，取得资产实际 page_title，保存到样本事实；这是 A 的必要验收条件，Planner 必须写入该意图。完成后不接续 B。B：必须等 A done 后，Planner 阅读 A 的事实，以其作为 parent_ids，再派独立复核：读取该事实，用其 token GET confirm，核对 verified 和 total，并 record_fact 保存 observed 证据后最终答复退出。两条意图均需在 contract.acceptance 明确各自终点，allowed_tools 可使用 http_request、asset_get、tool_search；contract.work 使用稳定身份，A 的 question_key=sample_total，B 的 question_key=verify_total。\nWorker 发现后及时写回。中断或恢复后读取已有事实和原会话，已经成功的 HTTP 请求和事实不能重复，不需要 checkpoint_intent 或 complete_intent。Planner 不直接发请求，等待完成事件再派下一阶段，不重复派已完成方向；两阶段完成后用最新实测证据 prove_goal，自然结束。单个最终目标，不把两个步骤拆成额外目标；无漏洞即无需 report_finding。`;
    current={kind,asset_id:asset,asset_title:assetTitle,started_at:new Date().toISOString(),status:'running'};record.cases.push(current);save();
    const t=await api('/api/tasks',{name:`LOCAL-REAL-${kind}-${runID.slice(0,8)}`,description,goal,execution_mode:'managed',llm_profile_ids:[profileId],asset_ids:[asset],coverage_enabled:false,timeout_seconds:600,plan_heartbeat_seconds:30});
    Object.assign(current,{task_id:Number(t.id),exploration_id:t.exploration_id});save();const s=db.exploration(t.exploration_id);
    if(kind==='pause_restart'){
      await until(async()=>current.pause_ready,'durable incremental fact before pause');const start=Date.now();current.pause_response=await api(`/api/tasks/${t.id}/pause`,{});current.pause_latency_ms=Date.now()-start;assert.equal(current.pause_response.status,'paused');
      const n=(await s.getNode(current.interrupted_intent))!;current.paused_state=n.state;assert.equal(n.state,'open');
      current.session_file=path.join(dir,'sessions',`exp${t.exploration_id}-worker-i${n.id}.jsonl`);current.session_before=JSON.parse(readFileSync(current.session_file,'utf8').split('\n')[0]!);
      await engine!.shutdown();await app.close();engine=undefined;app=undefined;
      const calls=record.requests.length;await new Promise(r=>setTimeout(r,500));assert.equal(record.requests.length,calls);
      await startHost();current.resumed=true;current.resume_response=await api(`/api/tasks/${t.id}/resume`,{});save();
    }
    await until(async()=>{const state=await db!.tasks().getTask(Number(t.id));if(state&&['failed','timeout'].includes(state.status))throw Error(`unexpected task terminal ${state.status}`);return state?.status==='done';},`${kind} natural completion`);
    await until(async()=>!(await db!.query('SELECT 1 FROM runtime_role_configs WHERE task_id=$1 AND finished_at IS NULL',[t.id])).rowCount,'runner disposal',20_000);
    const calls=record.requests.length;await new Promise(r=>setTimeout(r,2000));assert.equal(record.requests.length,calls,'no requests after natural completion');
    current.task=await api(`/api/tasks/${t.id}`);current.intents=await s.listByKind('intent');current.facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed');current.goals=await s.listByKind('goal');
    current.edges=(await db.query('SELECT * FROM exploration_edges WHERE exploration_id=$1 ORDER BY id',[t.exploration_id])).rows;
    current.anchors=(await db.query('SELECT a.* FROM exploration_anchors a JOIN exploration_nodes n ON n.id=a.node_id WHERE n.exploration_id=$1',[t.exploration_id])).rows;
    current.activity=(await db.query("SELECT id,node_id,worker,kind,tool,is_error,summary,detail,metadata,created_at FROM activity WHERE exploration_id=$1 AND kind NOT IN ('thinking','usage') ORDER BY id",[t.exploration_id])).rows;
    assert.equal(current.intents.length,2,'exactly two unique directions');assert.ok(current.intents.every((n:any)=>n.state==='done'));
    assert.equal(current.facts.length,2,'no duplicate facts');assert.ok(current.goals.length&&current.goals.every((n:any)=>n.state==='met'));assert.equal(current.incremental_visibility?.intent_state,'running');
    for(const n of [...current.intents,...current.facts])assert.ok(current.anchors.some((a:any)=>Number(a.node_id)===n.id&&Number(a.asset_id)===asset));
    const [first,second]=current.intents.toSorted((a:any,b:any)=>a.id-b.id),fact=current.facts.find((n:any)=>n.payload.from_intent===first.id);
    assert.ok(JSON.stringify(fact.payload).includes(assetTitle),'asset_get supplies actual persisted title');
    assert.ok(current.edges.some((e:any)=>Number(e.src_id)===fact.id&&Number(e.dst_id)===second.id&&e.rel==='derived_from'),'Planner uses published first-stage fact');
    for(const action of ['sample','confirm'])assert.equal(record.fixture_requests.filter((r:any)=>r.case===kind&&r.action===action&&r.accepted).length,1,'no replay of successful HTTP operation');
    const workers=record.runners.filter((r:any)=>r.task_id===Number(t.id)&&r.role==='worker'&&r.test_phase!=='legacy_seed');assert.ok(workers.every((r:any)=>r.initial_tools.includes('record_fact')));
    assert.ok(workers.some((r:any)=>!r.initial_tools.includes('asset_get')&&r.initial_tools.includes('tool_search')&&r.final_tools.includes('asset_get')),'native deferred tool activation');
    assert.ok(current.activity.some((a:any)=>a.tool==='tool_search'&&!a.is_error));assert.ok(current.activity.some((a:any)=>a.tool==='asset_get'&&!a.is_error));
    const duplicate=await addIntentTool(runContext(db,Number(t.id),t.exploration_id,'planner')).execute('local-dedup-probe',{summary:first.payload.summary,contract:first.payload.contract,parent_ids:first.payload.parent_ids,asset_ids:[asset]},undefined,undefined,{} as never);
    assert.ok(!duplicate.isError);current.dedup_receipt=JSON.parse((duplicate.content[0] as any).text);assert.equal(current.dedup_receipt.submitted,0);assert.equal(current.dedup_receipt.intents[0].duplicate_of,first.id);assert.equal((await s.listByKind('intent')).length,2);
    current.remaining_slots=Number((await db.query('SELECT count(*) n FROM engine_worker_slots WHERE task_id=$1',[t.id])).rows[0].n);assert.equal(current.remaining_slots,0);
    if(kind==='pause_restart'){
      current.session_after=JSON.parse(readFileSync(current.session_file,'utf8').split('\n')[0]!);assert.equal(current.session_before.id,current.session_after.id);
      assert.ok(current.resumed_context?.has_fact_refs&&current.resumed_context?.has_observed_token);
      for(const f of current.saved_facts)assert.deepEqual((await s.getNode(f.id))!.payload,f.payload,'saved fact unchanged');
    }
    if(kind==='legacy_loadout'){assert.ok(current.legacy_session);const restored=workers.find((r:any)=>r.session_id===current.legacy_session.id);assert.ok(restored,'original legacy session restored');assert.ok(restored.initial_tools.includes('record_fact')&&restored.initial_tools.includes('tool_search'),'current resident tools restored');current.legacy_restored_tools=restored.initial_tools;}
    current.status='passed';current.finished_at=new Date().toISOString();save();console.log(JSON.stringify({case:kind,status:'passed',task_id:t.id,requests:record.requests.length}));
  }
  record.traffic=(await db.query('SELECT id,task_id,intent_id,host FROM traffic_exchanges ORDER BY id')).rows;
  record.external_target_requests=record.traffic.filter((r:any)=>!/^127\.0\.0\.1(?::[0-9]+)?$/.test(r.host)).length;
  assert.equal(record.external_target_requests,0,'all recorded target requests use the loopback fixture');
  record.status='passed';
}catch(e){record.status='failed';record.error=safeError(e);console.error(record.error);}
finally{
  await engine?.shutdown().catch(e=>{record.shutdown_error=safeError(e);});await app?.close();fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));
  AgentRunner.prototype.prompt=originalPrompt;globalThis.fetch=originalFetch;
  if(db){record.audit=(await db.query('SELECT id,task_id,role,purpose,status,error,usage FROM llm_request_attempts ORDER BY id')).rows;record.nodes=(await db.query('SELECT * FROM exploration_nodes ORDER BY id')).rows;
    record.activities=(await db.query("SELECT id,exploration_id,node_id,worker,kind,tool,is_error,summary,detail,metadata,created_at FROM activity WHERE kind NOT IN ('thinking','usage') ORDER BY id")).rows;
    record.tasks=(await db.query('SELECT id,status,paused,completed_at FROM tasks ORDER BY id')).rows;
    record.tool_errors=record.activities.filter((a:any)=>a.is_error&&a.kind==='tool_result');
    record.usage=record.audit.reduce((sum:any,a:any)=>{for(const k of ['input','output','cacheRead','cacheWrite','totalTokens'])sum[k]=(sum[k]??0)+Number(a.usage?.[k]??0);return sum;},{});
    await db.query("UPDATE llm_profiles SET api_key=''");await db.query("UPDATE tasks SET paused=true WHERE status NOT IN ('done','failed','timeout')");await db.close();}
  record.finished_at=new Date().toISOString();save();console.log(JSON.stringify({status:record.status,requests:record.requests.length,output,error:record.error}));
}
process.exitCode=record.status==='passed'?0:1;
