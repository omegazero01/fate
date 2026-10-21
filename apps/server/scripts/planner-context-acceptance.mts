// Paired real-model replay against identical isolated copies. No Worker/target traffic.
import {execFileSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';import {pathToFileURL} from 'node:url';import pg from 'pg';
import {openDatabase} from '../src/db/index.js';
import {runPlannerRound,configureAgentEnv} from '../src/agent/roles.js';
import {plannerSessionFile,PLANNER_COMPACTION_RULES,plannerDeliveries} from '../src/agent/planner-memory.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {TodoStore,runContext} from '../src/tools/context.js';
import {buildGraphOverview} from '../src/tools/overview.js';
import {pendingPlannerContext} from '../src/db/planner-context.js';
import {createTrackedRunner} from '../src/engine/runtime-config.js';
import {SessionManager} from '@earendil-works/pi-coding-agent';

const evidence=path.resolve(process.env.FATE_PLANNER_REPLAY_EVIDENCE??'../../docs/reviews/evidence/planner-context-20261019/continuation');mkdirSync(evidence,{recursive:true});
const baselinePath=process.env.FATE_PLANNER_BASELINE??path.resolve('dist/agent/roles.js');
const baseline=await import(pathToFileURL(baselinePath).href);
const backup=process.env.FATE_PLANNER_REPLAY_DUMP??'/Users/pphua/.local/share/fate/backups/review-fixes-20261019T141054/database.dump';
const originalFetch=globalThis.fetch,all:any[]=[];let current:any,requestPurpose='conversation',secrets:string[]=[];
// Read current credentials without opening/migrating the production DB.
const live=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/series'});await live.connect();
const liveProfile=(await live.query('SELECT * FROM llm_profiles WHERE id=453')).rows[0];await live.end();
if(!liveProfile)throw new Error('Current configured model profile is missing');
const modelHost=new URL(liveProfile.base_url).hostname;
const redact=(value:unknown):unknown=>typeof value==='string'?value
  .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[REDACTED_PHONE]')
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[REDACTED_EMAIL]')
  .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]')
  .replace(/sdcytrz\.com/gi,'scope.example')
  :Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)])):value;
const save=(name:string,value:unknown)=>{
  const text=JSON.stringify(redact(value),null,2)+'\n';if(secrets.some(key=>key.length>8&&text.includes(key)))throw new Error('Evidence contains model credential');
  writeFileSync(path.join(evidence,name),text,{mode:0o600});
};
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(url.hostname!==modelHost)throw new Error('Acceptance fixture forbids target and MCP network traffic');
  const body=typeof init?.body==='string'?JSON.parse(init.body):{},raw=JSON.stringify(body);
  const record:any={purpose:requestPurpose,round:current.round,at:new Date().toISOString(),bytes:Buffer.byteLength(raw),negative_fact_in_input:raw.includes('32216'),negative_conclusion_in_input:raw.includes('穿越请求全部 400'),output_limits:Object.fromEntries(['max_tokens','max_output_tokens','max_completion_tokens'].filter(k=>k in body).map(k=>[k,body[k]]))};current.requests.push(record);
  const response=await originalFetch(input,init);record.status=response.status;
  const text=await response.clone().text();
  for(const line of text.startsWith('{')?[text]:text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6))){
    try{const chunk=JSON.parse(line);if(chunk.usage)record.usage=chunk.usage;}catch{/* SSE terminator */}
  }
  return response;
};
const allowed=new Set(['context_search','context_get','graph_overview','asset_search','asset_get','todo_write','add_intent','prove_goal','read_tool_output','node_detail','get_worker_trace','expand_digest','search_worker_traces','list_assets','list_untested_assets','list_task_scope','get_finding']);
try{
  for(const variant of ['before','after']){
    const name=`fate_planner_context_${variant}_${process.pid}`,dataDir=`/private/tmp/${name}`;mkdirSync(dataDir,{recursive:true,mode:0o700});
    execFileSync('docker',['exec','series-ts-pg','createdb','-U','series',name]);const fd=openSync(backup,'r');
    try{execFileSync('docker',['exec','-i','series-ts-pg','pg_restore','-U','series','-d',name,'--no-owner','--exit-on-error'],{stdio:[fd,'ignore','pipe']});}finally{closeSync(fd);}
    process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;const db=await openDatabase();
    current={variant,round:0,requests:[],activities:[],rounds:[]};all.push(current);
    try{
      const fields=Object.keys(liveProfile).filter(k=>k!=='id');
      if(fields.some(k=>!/^[_a-z]+$/.test(k)))throw new Error('Unexpected profile column');
      await db.query(`UPDATE llm_profiles SET ${fields.map((k,i)=>`"${k}"=$${i+2}`).join(',')} WHERE id=$1`,[453,...fields.map(k=>liveProfile[k])]);
      secrets=(await db.query('SELECT api_key FROM llm_profiles')).rows.map(r=>String(r.api_key??''));
      await db.query('UPDATE agents SET max_turns=0,run_seconds=0');await db.query('UPDATE llm_profiles SET max_tokens=0');await db.query('UPDATE mcp_servers SET enabled=false');
      await db.query('UPDATE tasks SET paused=false WHERE id=4844');
      configureAgentEnv({skillsDir:path.join(dataDir,'skills')});baseline.configureAgentEnv({skillsDir:path.join(dataDir,'skills')});
      const task=(await db.tasks().getTask(4844))!,expID=task.exploration_id,todos=new TodoStore(db);await todos.load(expID);
      const initial=new Set((await db.exploration(expID).listByKind('intent',10000)).map(n=>n.id));
      const input=await buildGraphOverview(runContext(db,task.id,expID,'planner'));
      save(`${variant}-input.json`,{backup,task_id:task.id,overview:input,restrictions:'Isolated DB; no Worker, target or remote MCP; model budgets and output limits 0'});
      for(let round=1;round<=6;round++){
        current.round=round;requestPurpose='conversation';
        const model=await makeModelResolver(db)(task.id,'planner',{profileID:453});
        const pending=await pendingPlannerContext(db,task.id,expID);
        const result=await (variant==='before'?baseline.runPlannerRound:runPlannerRound)({db,taskID:task.id,expID,goal:task.goal??'',model,dataDir,todos,hooks:{},maxTurns:0,
          contextEventIDs:pending.ids,changes:pending.changes,events:[],
          triggersText:round===1?'【隔离回放】按已有两图复核当前测试方向，尤其核对资产 #10599 的历史意图和负面结果。仅依据已保存资料规划，不访问目标。':round===3?'【隔离回放第 3 轮】请核实先前对资产 #10599 不重复派单的理由。若支持历史规划会话查询，请检索本任务历史规划并读取一条原始会话，引用 session 条目；同时重新读取事实 #32216 的原文，明确目录和穿越测试的实测响应及证据版本。只读核对，不访问目标。':`【隔离回放第 ${round} 轮】图谱没有额外外部发现。核对已有决定和证据是否支持新的独立方向；已有结论不要换措辞重复派单，无新依据允许结束。`,
          extraGuard:async(g:any)=>allowed.has(g.toolName)?undefined:{block:true,reason:'Acceptance reads stored evidence only; no target execution.'},
          onActivity:(a:any)=>{if(['tool_start','tool_end','assistant_message_end','usage'].includes(a.kind))current.activities.push({round,...a});}});
        current.rounds.push({round,result});
        const ack=result.deliveredContextIDs??pending.ids;
        await db.query('UPDATE exploration_context_events SET acknowledged_at=now() WHERE id=ANY($1::bigint[])',[ack]);
        if(variant==='after'&&round===2){
          requestPurpose='compaction';const file=plannerSessionFile(dataDir,expID),before=readFileSync(file,'utf8');
          const compactModel=await makeModelResolver(db)(task.id,'planner',{profileID:453});
          const runner=await createTrackedRunner(db,task.id,'planner',{...compactModel,cwd:path.join(dataDir,'tasks',String(task.id)),agentDir:path.join(dataDir,'pi-agent'),
            resumeSessionPath:file,systemPrompt:'本任务 Planner 原生会话压缩。保留负面证据与未完成事项。',toolAllowlist:[],compactionInstructions:PLANNER_COMPACTION_RULES,
            compactionSettings:{keepRecentTokens:256,reserveTokens:1024},onActivity:(a:any)=>{if(a.kind==='usage')current.activities.push({round,purpose:'compaction',...a});}});
          try{await runner.compact();current.compaction={...runner.compactionDiagnostics,original_retained:readFileSync(file,'utf8').startsWith(before)};}finally{await runner.dispose();requestPurpose='conversation';}
        }
        save(`${variant}-progress.json`,current);
      }
      current.new_intents=(await db.exploration(expID).listByKind('intent',10000)).filter(n=>!initial.has(n.id));
      if(variant==='after'){
        const entries=SessionManager.open(plannerSessionFile(dataDir,expID)).getEntries();
        current.deliveries=plannerDeliveries(entries).deliveries.map(d=>({id:d.id,context_ids:d.contextIDs,input_bytes:Buffer.byteLength(d.input)}));
        current.session_entries=entries.length;
      }
      current.totals=current.requests.reduce((out:any,r:any)=>{const u=r.usage??{};out.requests++;out.input+=u.prompt_tokens??0;out.output+=u.completion_tokens??0;out.cache_hit+=u.prompt_cache_hit_tokens??u.prompt_tokens_details?.cached_tokens??0;out.cache_miss+=u.prompt_cache_miss_tokens??((u.prompt_tokens??0)-(u.prompt_tokens_details?.cached_tokens??0));out.compaction_requests+=Number(r.purpose==='compaction');return out;},{requests:0,input:0,output:0,cache_hit:0,cache_miss:0,compaction_requests:0});
      save(`${variant}-result.json`,current);
    }catch(error){current.error=String(error);save(`${variant}-failure.json`,current);throw error;}
    finally{await db.close();execFileSync('docker',['exec','series-ts-pg','dropdb','-U','series',name]);}
  }
  save('comparison.json',{method:'Same pre-duplicate #4844 DB snapshot and live model profile; no target execution. Six rounds; after includes forced native compaction after round 2; both variants receive the same explicit original-evidence recall request in round 3. All actual requests including compaction counted. This is a second run, so provider caches may already be warm.',variants:all.map(v=>({variant:v.variant,totals:v.totals,compaction:v.compaction,deliveries:v.deliveries,new_intent_ids:v.new_intents.map((n:any)=>n.id)}))});
  console.log(JSON.stringify(all.map(v=>({variant:v.variant,totals:v.totals}))));
}finally{globalThis.fetch=originalFetch;}
