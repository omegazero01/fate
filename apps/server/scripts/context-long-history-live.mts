/** Real-provider controlled context comparison. Only persisted synthetic graph reads are executable.
 * Seed history uses pi's deterministic provider; seed calls are NOT reported as real usage.
 * A fresh runner is opened for each continuation to exercise JSONL restoration. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime,SessionManager} from '@earendil-works/pi-coding-agent';
const root=path.resolve(process.env.FATE_RUNTIME_ROOT??'dist'),load=(f:string)=>import('file://'+path.join(root,f+'.js'));
const {Database,openDatabase}=await load('db/index'),{postgresDSN}=await load('config/index');
const {AgentRunner}=await load('pi/runner'),{createTrackedRunner}=await load('engine/runtime-config');
const {makeModelResolver}=await load('pi/modelResolver'),{configureUsageOutbox}=await load('pi/usage-meter');
const {contextGetTool}=await load('tools/context-read'),{runContext}=await load('tools/context');
const {PLANNER_COMPACTION_RULES}=await load('agent/planner-memory');
const variant=process.env.FATE_VARIANT??'after',output=process.env.FATE_ACCEPTANCE_OUTPUT;
assert(output&&!existsSync(output),'Use a fresh output path');
const dir=mkdtempSync(path.join(tmpdir(),'fate-context-long-')),database=`fate_context_long_${process.pid}`;
const record:any={variant,runtime:root,database,data_dir:dir,started_at:new Date().toISOString(),status:'running',roles:[],requests:[],external_target_requests:0};
const originalFetch=globalThis.fetch;let secret='',db:any;
const save=()=>{const text=JSON.stringify(record,null,2);assert(!secret||!text.includes(secret));writeFileSync(output,text+'\n',{mode:0o600});};
const deadline=AbortSignal.timeout(20*60_000);
try{
 const dsn=postgresDSN().dsn,source=new Database(new pg.Pool({connectionString:dsn,options:'-c default_transaction_read_only=on'}));
 const profile=await source.platform().profileByID(Number(process.env.FATE_ACCEPTANCE_PROFILE_ID??541));await source.close();assert(profile?.apiKey&&profile.model==='deepseek-flash');secret=profile.apiKey;
 const isolated=new URL(dsn);isolated.pathname='/'+database;process.env.SERIES_PG_DSN=isolated.href;process.env.SERIES_LOG_LEVEL='silent';db=await openDatabase();configureUsageOutbox(db,dir);
 const profileID=await db.platform().saveProfile({...profile,id:undefined,name:'LOCAL controlled context comparison',isDefault:true,poolExclude:true,proxy:'',streaming:true});
 globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);assert.equal(url.origin,new URL(profile.baseURL).origin,'No target network traffic');deadline.throwIfAborted();
  const body=typeof init?.body==='string'?JSON.parse(init.body):{},r:any={at:new Date().toISOString(),bytes:Buffer.byteLength(JSON.stringify(body)),max_tokens:body.max_tokens,max_completion_tokens:body.max_completion_tokens};record.requests.push(r);save();const response=await originalFetch(input,init);r.status=response.status;save();return response;};
 const resolver=makeModelResolver(db);
 for(const role of ['planner','worker']){
  const task=await db.tasks().createTaskWithOptions('LOCAL synthetic historical evidence only','核对已保存的本地合成反证，不新增探索',{executionMode:'manual',llmProfileIDs:[profileID]});
  const s=db.exploration(task.exploration_id),intentID=await s.addIntent({summary:'复核唯一的本地合成反证，不新增测试'},5,[],'user');
  const fact=await s.addNode('fact',{summary:'LOCAL_NEGATIVE: synthetic values [4,7,9] total=20; scope=fixture only.',detail:'RECALL_SENTINEL=amber-cedar-27; confirmed negative result, never an untested direction. No external target was visited.',evidence:'Synthetic fixture v1',from_intent:intentID},0,'confirmed','fixture',[]);
  await s.link(intentID,'yields',fact);await s.setIntentState(intentID,'running');
  const nodesBefore=JSON.stringify((await db.query('SELECT id,kind,payload,state FROM exploration_nodes WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows);
  const cwd=path.join(dir,role);mkdirSync(cwd);const file=path.join(cwd,'session.jsonl');
  const evidence=`LOCAL_NEGATIVE node:${fact} version=0; RECALL_SENTINEL=amber-cedar-27; values [4,7,9], total20; scope fixture only.\n`+' synthetic observation: previously checked fixture records; no new finding or authorization.\n'.repeat(4200);
  const f=fauxProvider({provider:'local-history-seed',models:[{id:'synthetic',contextWindow:258000,maxTokens:8192}]}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(f.provider);
  const seed=await AgentRunner.create({modelRuntime,model:f.getModel(),cwd,agentDir:path.join(cwd,'agent'),resumeSessionPath:file,systemPrompt:'Synthetic historical fixture.',toolAllowlist:['local_fixture'],customTools:[{name:'local_fixture',label:'Local fixture',description:'Local text only',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:evidence}],details:{}};}}]});
  f.setResponses([fauxAssistantMessage([fauxToolCall('local_fixture',{})]),fauxAssistantMessage(`Historical negative fact node:${fact}; do not repeat. Remaining: read original graph evidence to confirm.`)]);
  try{await seed.prompt('Read synthetic historical evidence once.');}finally{await seed.dispose();}
  const original=readFileSync(file,'utf8'),sessionID=SessionManager.open(file).getSessionId();
  const entry:any={role,task_id:task.id,intent_id:intentID,fact_id:fact,seed_bytes:Buffer.byteLength(original),seed_sha256:createHash('sha256').update(original).digest('hex'),rounds:[]};record.roles.push(entry);save();
  for(let round=1;round<=3;round++){
   const model=await resolver(task.id,role,{profileID}),policy=variant==='after'?(await load('agent/context-policy')).roleContextPolicy(role,model.model.contextWindow,role==='planner'?'48000':'64000'):undefined;
   const tool=contextGetTool(runContext(db,task.id,task.exploration_id,role,{intentID})),events:any[]=[];
   const runner=await createTrackedRunner(db,task.id,role,{...model,cwd,agentDir:path.join(cwd,'agent'),resumeSessionPath:file,intentID,turnID:`local-${role}-${round}`,signal:deadline,maxTurns:5,maxDurationMs:120_000,
    contextPolicy:policy,compactionSettings:policy?.compactionSettings,summaryMaxTokens:policy?.summaryMaxTokens,compactionInstructions:PLANNER_COMPACTION_RULES,
    systemPrompt:`你是本地合成资料复核助手，角色 ${role}。只用 context_get 读取指定原始图节点一次，然后简短输出其中的 RECALL_SENTINEL、总和、否定结论和已有记录编号。历史已经执行的方向不能再次执行。本轮无需新增事实、派单或工具操作。`,
    toolAllowlist:[tool.name],customTools:[tool],onActivity:(a:any)=>{if(a.kind==='tool_end'||a.kind==='assistant_message_end')events.push(a);}});
   const r:any={round,policy,started_at:new Date().toISOString()};entry.rounds.push(r);save();
   try{r.result=await runner.prompt(`第 ${round} 次复核：读取 node:${fact} 的 detail，确认原始已保存结论及 RECALL_SENTINEL，简短返回，不重做任何探索。`);r.compaction=runner.compactionDiagnostics;r.events=events;}
   finally{await runner.dispose();r.finished_at=new Date().toISOString();save();}
   assert.equal(r.result.stopReason,'completed');if(round===1)assert(events.some(e=>e.kind==='tool_end'&&e.toolName==='context_get'&&!e.isError));assert(!events.some(e=>e.kind==='tool_end'&&e.isError));
   assert(events.some(e=>e.kind==='assistant_message_end'&&!e.isThinking&&e.text.includes('amber-cedar-27')),'Original graph fact must be recalled');
   assert(readFileSync(file,'utf8').startsWith(original));assert.equal(SessionManager.open(file).getSessionId(),sessionID);
  }
  entry.compactions=SessionManager.open(file).getEntries().filter((e:any)=>e.type==='compaction').length;
  assert.equal(entry.compactions>0,variant==='after');
  assert.equal(JSON.stringify((await db.query('SELECT id,kind,payload,state FROM exploration_nodes WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows),nodesBefore,'Reads must not lose facts or dispatch work');
  entry.original_preserved=true;entry.graph_unchanged=true;entry.session_restored=true;
  console.log(JSON.stringify({role,variant,status:'passed',compactions:entry.compactions,requests:record.requests.length}));save();
 }
 record.status='passed';
}catch(e){record.status='failed';record.error=String(e).split(secret||'\0').join('[redacted]');console.error(record.error);}
finally{
 globalThis.fetch=originalFetch;
 if(db){try{record.ledger=(await db.query(`SELECT request_id,task_id,role,purpose,quality,status,usage FROM llm_usage_ledger WHERE source IN ('provider','request_audit') ORDER BY created_at,request_id`)).rows;
  record.usage=record.ledger.reduce((sum:any,r:any)=>{for(const k of ['input','inputTotal','cacheRead','cacheWrite','output','totalTokens'])sum[k]=(sum[k]??0)+Number(r.usage[k]??0);return sum;},{});
  record.cache_hit_rate=record.ledger.every((r:any)=>r.quality==='complete')&&record.usage.inputTotal?record.usage.cacheRead/record.usage.inputTotal:null;
  const totals=(await (await load('db/usage-ledger')).aggregateUsage(db))[0];record.platform_usage=totals;
  assert.equal(totals.calls,record.requests.length);assert.equal(totals.input_tokens,record.usage.inputTotal);assert.equal(totals.output_tokens,record.usage.output);assert.equal(totals.cache_read_tokens,record.usage.cacheRead);assert.equal(totals.usage_complete,true);
  }catch(e){record.status='failed';record.error=String(e).split(secret||'\0').join('[redacted]');}
  finally{try{await db.query("UPDATE llm_profiles SET api_key=''");}finally{await db.close();}}}
 record.finished_at=new Date().toISOString();save();console.log(JSON.stringify({status:record.status,requests:record.requests.length,output,error:record.error}));
}
process.exitCode=record.status==='passed'?0:1;
