import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';import http from 'node:http';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase} from '../src/db/index.js';import {Engine,defaultEngineConfig} from '../src/engine/engine.js';import {buildApp} from '../src/http/app.js';import {signJWT,hashPassword,AUTH_PASSWORD_KEY} from '../src/http/auth.js';
const duration=Number(process.env.PERF_SECONDS??1800),name=`fate_performance_${Date.now()}`;
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;process.env.SERIES_LOG_LEVEL='error';
const dir=mkdtempSync(path.join(tmpdir(),'fate-perf-')),evidence=path.resolve('../../docs/reviews/evidence/performance-20261026',name);mkdirSync(evidence,{recursive:true});
const db=await openDatabase();await db.platform().setSetting('workers','10');await db.platform().setSetting('task_concurrency_enabled','false');await db.platform().setSetting(AUTH_PASSWORD_KEY,hashPassword('LocalPerfFixture2026!'));
await db.query("UPDATE agents SET max_turns=0,run_seconds=0 WHERE key IN ('planner','worker')").catch(()=>{});
await db.query(`WITH e AS (INSERT INTO explorations(description,goal) SELECT 'LOCAL history '||g,'history' FROM generate_series(1,10000) g RETURNING id)
 INSERT INTO tasks(description,goal,exploration_id,status,completed_at) SELECT 'LOCAL history '||id,'history',id,'done',now() FROM e`);
const tasks=[];
for(let i=0;i<50;i++){const t=await db.tasks().createTaskWithOptions(`LOCAL performance ${i}`,'Retain LOCAL fixture observations',{executionMode:'managed',coverageEnabled:false});tasks.push(t);await db.exploration(t.exploration_id).addGoal({text:'LOCAL ongoing fixture'},'test');for(let j=0;j<10;j++)await db.exploration(t.exploration_id).addIntent({summary:`LOCAL fixture ${i}/${j}`,dispatch_requested:true},5,[],'user');}
let models=0,modelCalls=0,workerModels=0,plannerModelCalls=0,workerModelCalls=0,runStarted=0;
const engine=new Engine(db,{...defaultEngineConfig(),workers:10,debounceMs:50,plannerMaxTurns:0,workerMaxTurns:0,workerMaxDurationMs:0},async(_taskID,role)=>{
 const serial=++models,workerSerial=role==='worker'?++workerModels:0,f=fauxProvider({provider:`perf-${serial}`}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(f.provider);
 let wrote=false;
 // Replenish the provider fixture after every call, including native compaction.
 // This is an unlimited deterministic responder, not a model request budget.
 const respond:Parameters<typeof f.setResponses>[0][number]=async(ctx,options)=>{
   f.appendResponses([respond]);modelCalls++;
   if(role==='worker'){
     workerModelCalls++;
     const alreadySaved=ctx.messages.some(m=>m.role==='toolResult'&&m.toolName==='record_fact'&&!m.isError);
     if(!wrote&&!alreadySaved){
       await sleep(workerSerial<=500?Math.max(2000,runStarted+90000-Date.now()):2000,undefined,{signal:options?.signal});wrote=true;
       return fauxAssistantMessage([fauxToolCall('record_fact',{summary:`LOCAL observed ${serial}`,evidence:'Deterministic local fixture; no network',confidence:'high'})]);
     }
     await sleep(1000,undefined,{signal:options?.signal});return fauxAssistantMessage('LOCAL observation saved; normal completion.');
   }
   plannerModelCalls++;await sleep(500,undefined,{signal:options?.signal});
   return fauxAssistantMessage('LOCAL ongoing work is sufficient; no duplicate dispatch. Preserve current task goals, open intents and recorded LOCAL facts. No goal has been proved.');
 };
 f.setResponses([respond]);return {model:f.getModel() as never,modelRuntime:runtime};},dir);
const key='isolated-performance-only',token=signJWT(key),headers={authorization:`Bearer ${token}`};
const app=buildApp({db,engine,version:'performance-isolated',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});await app.listen({host:'127.0.0.1',port:18787});
const origin='http://127.0.0.1:18787';const get=async(url:string)=>{const r=await fetch(origin+url,{headers});if(!r.ok)throw new Error(`${url}: ${r.status} ${await r.text()}`);return r.json();};
const clients:AbortController[]=[],seen=new Set<number>();let duplicated=0;
for(let i=0;i<20;i++){const ac=new AbortController();clients.push(ac);const r=await fetch(`${origin}/api/exploration/activity/stream?task=${tasks[0]!.id}`,{headers,signal:ac.signal});void(async()=>{const reader=r.body!.getReader(),decode=new TextDecoder();let buffer='';for(;;){const x=await reader.read();if(x.done)break;if(i!==0)continue;buffer+=decode.decode(x.value,{stream:true});let k;while((k=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,k);buffer=buffer.slice(k+2);const id=Number(frame.match(/^id: (\d+)/m)?.[1]);if(id){if(seen.has(id))duplicated++;seen.add(id);}}}})().catch(()=>{});}
global.gc?.();const baseline=process.memoryUsage(),loop=monitorEventLoopDelay({resolution:20});loop.enable();
writeFileSync(path.join(evidence,'setup.json'),JSON.stringify({database:name,dir,duration,active_tasks:50,historical_tasks:10000,worker_limit_per_task:10,planner_limit:10,origin,baseline},null,2));
runStarted=Date.now();engine.startScheduler();await db.query("UPDATE tasks SET status='running' WHERE id=ANY($1::bigint[])",[tasks.map(t=>t.id)]);
const samples:{kind:string;ms:number}[]=[],failures:string[]=[];const record=(kind:string,start:number)=>{const sample={at:new Date().toISOString(),kind,ms:performance.now()-start};samples.push(sample);appendFileSync(path.join(evidence,'requests.jsonl'),JSON.stringify(sample)+'\n');};let peakWorkers=0,peakPlanners=0,maxWaiting=0,active=true;
const polling=(async()=>{while(active){for(const [kind,url] of [['list','/api/tasks?page=1&page_size=20'],['detail',`/api/tasks/${tasks[0]!.id}`]]){const start=performance.now();try{await get(url!);record(kind!,start);}catch(e){failures.push(String(e));}}await sleep(500);}})();
const started=Date.now();let nextWave=Date.now()+30000,nextPause=Date.now()+60000,wave=0;
// A separate history-only scope supplies a real stalled socket without holding Agent work.
await db.query("INSERT INTO activity(exploration_id,worker,kind,summary,detail) SELECT 1,'main','text','LOCAL slow reader',repeat('x',65536) FROM generate_series(1,180)");
const slow=http.get(origin+'/api/exploration/activity/stream?task=1',{headers},response=>response.pause());slow.on('error',()=>{});
try{while(Date.now()-started<duration*1000){await sleep(1000);const m=await get('/api/runtime/metrics');peakWorkers=Math.max(peakWorkers,m.scheduler.worker_executions);peakPlanners=Math.max(peakPlanners,m.scheduler.planners);maxWaiting=Math.max(maxWaiting,m.database.pools.primary.waiting);appendFileSync(path.join(evidence,'samples.jsonl'),JSON.stringify({elapsed_ms:Date.now()-started,models,modelCalls,...m})+'\n');
if(Date.now()>=nextPause){nextPause=Date.now()+60000;const task=tasks[wave%tasks.length]!;const start=performance.now();const r=await fetch(`${origin}/api/tasks/${task.id}/pause`,{method:'POST',headers});record('pause',start);if(!r.ok)failures.push(`pause:${r.status}`);else{while((await get(`/api/tasks/${task.id}`)).pause_pending)await sleep(100);const resumed=await fetch(`${origin}/api/tasks/${task.id}/resume`,{method:'POST',headers});if(!resumed.ok)failures.push(`resume:${resumed.status}`);}}
if(Date.now()>=nextWave){nextWave=Date.now()+30000;wave++;for(const t of tasks){const count=Number((await db.query("SELECT count(*) n FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND state IN ('open','running')",[t.exploration_id])).rows[0]?.n);if(count<2){await db.exploration(t.exploration_id).addIntent({summary:`LOCAL subsequent ${wave}`,dispatch_requested:true},5,[],'user');engine.notify(t.id);}}}
}}finally{slow.destroy();active=false;await polling;for(const ac of clients)ac.abort();await engine.shutdown();await app.close();loop.disable();global.gc?.();await sleep(1000);global.gc?.();}
const errors=(await db.query("SELECT summary FROM activity WHERE is_error OR summary LIKE '%租约失%' OR summary LIKE '%lock timeout%' LIMIT 100")).rows;
const p=(kind:string,q:number)=>{const values=samples.filter(r=>r.kind===kind).map(r=>r.ms).sort((a,b)=>a-b);return values[Math.min(values.length-1,Math.floor(values.length*q))]??0;};
const finalMetrics=db.runtimeMetrics();const final=process.memoryUsage(),result={elapsed_seconds:(Date.now()-started)/1000,peakWorkers,peakPlanners,maxWaiting,modelCalls,plannerModelCalls,workerModelCalls,models,p95:{list:p('list',.95),detail:p('detail',.95),pause:p('pause',.95)},loop_p99_ms:loop.percentile(99)/1e6,baseline,final,heap_growth:final.heapUsed-baseline.heapUsed,database:finalMetrics,errors,failures,sse_unique:seen.size,sse_duplicates:duplicated};
const checks={latency:result.p95.list<=500&&result.p95.detail<=500&&result.p95.pause<=500,event_loop:result.loop_p99_ms<=100,heap:result.heap_growth<=Math.max(result.baseline.heapUsed*.2,32*1024*1024),integrity:!errors.length&&!failures.length&&!duplicated&&!finalMetrics.query_errors,capacity:peakWorkers===500&&peakPlanners<=10};
writeFileSync(path.join(evidence,'result.json'),JSON.stringify({...result,checks},null,2));console.log(JSON.stringify({evidence,...result,checks}));await db.close();if(Object.values(checks).some(ok=>!ok))process.exitCode=1;
