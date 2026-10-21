/** Real model, isolated DB/session and loopback HTTP fixture. No production task execution. */
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {openDatabase} from '../src/db/index.js';
import {runPlannerRound,runWorkerIntent,configureAgentEnv} from '../src/agent/roles.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
import {runContext,TodoStore} from '../src/tools/context.js';
import {pendingPlannerContext} from '../src/db/planner-context.js';
import {assetCoverage} from '../src/db/asset-query.js';
import {workerStopReceipt} from '../src/engine/worker-outcome.js';

const name=`fate_direction_real_${process.pid}`,dataDir=`/private/tmp/${name}`;
const evidence=path.resolve('../../docs/reviews/evidence/direction-writeback-20261021');mkdirSync(evidence,{recursive:true});mkdirSync(dataDir,{recursive:true,mode:0o700});
const live=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/series'});await live.connect();
const profile=(await live.query('SELECT * FROM llm_profiles WHERE id=453')).rows[0];await live.end();
if(!profile)throw new Error('Configured model profile #453 missing');
const observations:any[]=[],activities:any[]=[],requests:any[]=[];let phase='setup';
const report:any={database:name,session_directory:dataDir,budgets:{max_turns:0,run_seconds:0,max_tokens:0},fixture:'Loopback read-only fixture; no live targets',started_at:new Date().toISOString()};
const save=()=>{const text=JSON.stringify({...report,requests,observations,activities},null,2);if(profile.api_key&&text.includes(profile.api_key))throw new Error('Credential in evidence');writeFileSync(path.join(evidence,'real-model.json'),text+'\n',{mode:0o600});};
const server=createServer((req,res)=>{
 observations.push({at:new Date().toISOString(),url:req.url,method:req.method});res.setHeader('Content-Type','application/json');
 if(req.url==='/'){res.end(JSON.stringify({service:'LOCAL users',routes:['/api/me','/api/users','/public'],note:'Read-only synthetic fixture'}));return;}
 if(req.url==='/public'){res.end(JSON.stringify({public:true,description:'LOCAL service information'}));return;}
 res.statusCode=['/api/me','/api/users'].includes(req.url??'')?401:404;res.end(JSON.stringify({error:res.statusCode===401?'authentication required':'not found'}));
});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const port=(server.address() as {port:number}).port,url=`http://127.0.0.1:${port}`;
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;
const db=await openDatabase();
const originalFetch=globalThis.fetch,modelHost=new URL(profile.base_url).host;
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(u.host!==modelHost&&u.host!==`127.0.0.1:${port}`)throw new Error('Isolated fixture permits only configured model and loopback');
 const body=typeof init?.body==='string'?JSON.parse(init.body):{};
 if(u.host!==modelHost)return originalFetch(input,init);
 const row:any={phase,at:new Date().toISOString(),bytes:Buffer.byteLength(JSON.stringify(body)),output_limits:Object.fromEntries(['max_tokens','max_output_tokens','max_completion_tokens'].filter(k=>k in body).map(k=>[k,body[k]]))};requests.push(row);
 const response=await originalFetch(input,init);row.status=response.status;
 const text=await response.clone().text();
 for(const line of text.startsWith('{')?[text]:text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6))){try{const chunk=JSON.parse(line);if(chunk.usage)row.usage=chunk.usage;}catch{/* terminator */}}
 return response;
};
const onActivity=(a:any)=>{if(['tool_start','tool_end','assistant_message_end','usage'].includes(a.kind)){activities.push({phase,...a});save();}};
try{
 const fields=Object.keys(profile);if(fields.some(k=>!/^[_a-z]+$/.test(k)))throw new Error('Unexpected profile column');
 await db.query(`INSERT INTO llm_profiles(${fields.map(k=>`"${k}"`).join(',')}) VALUES(${fields.map((_,i)=>`$${i+1}`).join(',')})`,fields.map(k=>profile[k]));
 await db.query('UPDATE agents SET max_turns=0,run_seconds=0,llm_profile_id=453');await db.query('UPDATE llm_profiles SET max_tokens=0');await db.query('UPDATE mcp_servers SET enabled=false');
 configureAgentEnv({skillsDir:path.join(dataDir,'skills')});
 const task=await db.tasks().createTaskWithOptions('LOCAL direction acceptance',`只读探索本地演示用户服务 ${url} 的匿名访问边界，形成有证据和适用范围的结论。仅此本地夹具，不访问外部地址，不修改数据。`,{executionMode:'managed'});
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const store=db.exploration(task.exploration_id),asset=await db.assets().upsertHTTPService({url,taskID:task.id});
 const allowed=new Set(['tool_search','context_search','context_get','graph_overview','asset_search','asset_get','todo_write','add_intent','prove_goal','read_tool_output','insert_assets','record_fact']);
 const guard=async(g:any)=>{
   if(allowed.has(g.toolName))return;
   if(phase==='worker'&&g.toolName==='http_request'){try{if(new URL(String(g.args.url)).origin===url&&['GET','HEAD','OPTIONS'].includes(String(g.args.method??'GET').toUpperCase()))return;}catch{}}
   if(phase==='worker'&&g.toolName==='bash'&&/^curl\s/.test(String(g.args.command))&&String(g.args.command).includes(url)&&!/[;&|`\n]|\$\(/.test(String(g.args.command)))return;
   return {block:true,reason:`HOST_TOOL_NOT_EXECUTED：本次工具调用未执行，不是目标响应，不可当作目标测试证据。Worker 可用 http_request 或单条 curl 只读访问 ${url}，不支持外部访问或其他操作。`};
 };
 const pending=await pendingPlannerContext(db,task.id,task.exploration_id);
 phase='planner';report.planner=await runPlannerRound({db,taskID:task.id,expID:task.exploration_id,goal:task.goal??'',model:await makeModelResolver(db)(task.id,'planner',{profileID:453}),dataDir,todos:new TodoStore(db),hooks:{},maxTurns:0,
   contextEventIDs:pending.ids,changes:pending.changes,triggersText:`本地验收：入口资产 #${asset}。请派一个用户服务身份边界的探索方向，Worker 自选验证路径，不逐接口或参数拆单；本轮不亲自探测。`,extraGuard:guard,onActivity});
 if(report.planner.failure)throw new Error(report.planner.failure);
 const intents=await store.listByKind('intent');report.intents=intents;
 if(intents.length!==1)throw new Error(`Expected one direction, received ${intents.length}`);
 const intent=await store.claimNextWorker('local-direction');if(!intent)throw new Error('Worker could not claim');
 phase='worker';report.worker=await runWorkerIntent({db,taskID:task.id,expID:task.exploration_id,intent,workerName:'local-direction',model:await makeModelResolver(db)(task.id,'worker',{profileID:453}),dataDir,maxTurns:0,maxDurationMs:0,hooks:{},extraGuard:guard,onActivity});
 if(report.worker.failure||report.worker.stopReason!=='completed')throw new Error(report.worker.failure??'Worker did not complete normally');
 const receipt=await workerStopReceipt(db,task.exploration_id,(await store.getNode(intent.id))!,'completed','local-real-direction',report.worker.lastAssistantText??'');
 await store.setIntentState(intent.id,'done');report.stop_receipt=receipt;
 const facts=(await store.listByKind('fact')).filter(n=>n.payload.from_intent===intent.id);report.facts=await Promise.all(facts.map(async n=>({...n,asset_ids:await store.anchorAssetIDs(n.id)})));
 report.coverage=await assetCoverage(db,task.id);report.source_context=await pendingPlannerContext(db,task.id,task.exploration_id);
 report.checks={one_direction:intents.length===1,multiple_requests:observations.length>=2,grouped_conclusions:facts.length>0&&facts.length<observations.length,
   precise_writeback:report.facts.length>0&&report.facts.every((f:any)=>f.asset_ids.length&&f.payload.scope?.tested&&['observed','negative','inferred','unknown'].includes(f.payload.observation_type)),
   appropriate_coverage:report.facts.every((f:any)=>f.payload.writeback.coverage_eligible===['observed','negative'].includes(f.payload.observation_type)),
   normal_end:report.worker.stopReason==='completed',no_injected_output_limit:requests.every(r=>Object.keys(r.output_limits).length===0)};
 report.passed=Object.values(report.checks).every(Boolean);
 if(!report.passed)throw new Error('See failed acceptance checks');
}catch(error){report.error=String(error);report.passed=false;process.exitCode=1;}
finally{report.finished_at=new Date().toISOString();save();globalThis.fetch=originalFetch;await db.close();await new Promise<void>(r=>server.close(()=>r()));}
console.log(JSON.stringify({passed:report.passed,error:report.error,requests:requests.length,evidence:path.join(evidence,'real-model.json')}));
