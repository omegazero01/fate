import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime,defineTool} from '@earendil-works/pi-coding-agent';
import {AgentRunner} from '../pi/runner.js';
import {openDatabase,Database} from '../db/index.js';
import {runContext} from '../tools/context.js';
import {recordFactTool} from '../tools/graph.js';
import {reportFindingTool} from '../tools/findings.js';
import {contextGetTool,searchContext} from '../tools/context-read.js';
import {Engine,defaultEngineConfig} from './engine.js';
import {makeModelResolver} from '../pi/modelResolver.js';
import {Coordinator,executionSnapshot} from './coordinator.js';
import {addIntentTool} from '../tools/intents.js';
import {markWorkerReleased,recoverWorkerSettlements} from '../db/worker-drafts.js';
import {plannerTools,mainTools,workerTools} from '../tools/index.js';
import {insertAssetsTool} from '../tools/assets.js';

// Lifecycle assertions test ordering and durability, not a latency SLO.
// Leave headroom for native pi startup in the full integration suite.
const lifecycleWaitMs=30_000;
const name=`fate_blackboard_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-blackboard-'));
let db:Database;const engines:Engine[]=[];
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;db=await openDatabase();await db.platform().setSetting('workers','3');});
afterAll(async()=>{for(const e of engines)await e.shutdown();await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});});
async function until(fn:()=>Promise<boolean>,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('blackboard timeout');}
async function fixture(claim=true){const task=await db.tasks().createTaskWithOptions('LOCAL blackboard','',{executionMode:'manual'});const s=db.exploration(task.exploration_id);const id=await s.addIntent({summary:'Verify LOCAL sample',dispatch_requested:true,collaboration_policy:'blackboard-v1'},5,[],'user');if(claim)await s.claimNextWorker('work#1');return {task,s,id,c:runContext(db,task.id,task.exploration_id,'worker',{intentID:id,workerName:'work#1',collaborationPolicy:'blackboard-v1'})};}
async function call(tool:any,args:any,key=randomUUID()){const out=await tool.execute(key,args,undefined,undefined,{});if(out.isError)throw new Error(out.content[0].text);return JSON.parse(out.content[0].text);}
const observation={observation_type:'observed' as const,scope:{tested:'LOCAL fixture observation'},summary:'LOCAL observed',evidence:'Synthetic sample observed once',confidence:'high'};
const result=(id:number)=>({outcome:'complete',summary:'LOCAL done',criteria:[{index:0,outcome:'supported',fact_ids:[id]}]});

it('publishes facts during execution and returns the same node on a retried tool call',async()=>{
 const f=await fixture(),first=await call(recordFactTool(f.c),observation,'fact-retry');
 expect(first.staged).toBeUndefined();expect((await f.s.getNode(first.fact_id))?.payload).toMatchObject(observation);
 expect((await f.s.getNode(f.id))?.state).toBe('running');
 const planner=runContext(db,f.task.id,f.task.exploration_id,'planner');
 expect((await searchContext(planner,{types:['fact'],intent_id:f.id})).items.map(n=>n.node_id)).toEqual([first.fact_id]);
 expect((await call(contextGetTool(planner),{ref:`node:${first.fact_id}`})).node.payload).toMatchObject(observation);
 expect((await call(recordFactTool(f.c),observation,'fact-retry')).fact_id).toBe(first.fact_id);
 expect((await db.query('SELECT 1 FROM worker_observations WHERE intent_id=$1',[f.id])).rowCount).toBe(0);
 expect((await db.query('SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1',[f.task.exploration_id])).rowCount).toBe(0);
 expect(((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id))).toHaveLength(1);
});

it('rejects missing evidence, deprecated draft edits and writes by a stale Worker',async()=>{
 const f=await fixture();
 await expect(call(recordFactTool(f.c),{summary:'unsupported'})).rejects.toThrow('证据');
 await expect(call(recordFactTool(f.c),{...observation,replace_node_id:123})).rejects.toThrow('已停用');
 await expect(call(reportFindingTool(f.c),{vulnclass:'LOCAL',severity:'low',summary:'LOCAL',evidence:'LOCAL',replace_node_id:123})).rejects.toThrow('已停用');
 await expect(call(recordFactTool({...f.c,workerName:'other'}),observation)).rejects.toThrow('归属');
 await f.s.setIntentState(f.id,'paused');
 await expect(call(recordFactTool(f.c),observation)).rejects.toThrow('归属');
 expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).toHaveLength(0);
 expect(workerTools(f.c).map(t=>t.name)).not.toContain('checkpoint_intent');
 expect(workerTools(f.c).map(t=>t.name)).not.toContain('complete_intent');
 expect(await db.platform().getTool('checkpoint_intent')).toBeNull();
 expect(await db.platform().getTool('complete_intent')).toBeNull();
});

it('publishes a finding and durable wakeup once, notifying only after commit',async()=>{
 const f=await fixture();let notifications=0;
 const c={...f.c,hooks:{notifyFinding:()=>{notifications++;}}};
 const args={vulnclass:'LOCAL fixture',severity:'low',summary:'synthetic fixture only',evidence:'LOCAL proof'};
 const saved=await call(reportFindingTool(c),args,'finding-retry');
 expect((await db.query('SELECT evidence FROM findings WHERE id=$1',[saved.finding_id])).rows[0]!.evidence).toBe('LOCAL proof');
 expect((await f.s.getNode(f.id))?.state).toBe('running');expect(notifications).toBe(1);
 expect(await call(reportFindingTool(c),args,'finding-retry')).toEqual(saved);expect(notifications).toBe(1);
 expect((await db.query("SELECT 1 FROM exploration_edges WHERE src_id=$1 AND dst_id=$2 AND rel='yields'",[f.id,saved.finding_node_id])).rowCount).toBe(1);
 expect((await db.query("SELECT 1 FROM blackboard_wakeups WHERE node_id=$1 AND kind='finding_published'",[saved.finding_node_id])).rowCount).toBe(1);
 await expect(call(reportFindingTool(c),{...args,traffic_refs:[{traffic_id:'missing-local-traffic'}]},'failed-evidence')).rejects.toThrow();
 expect(notifications).toBe(1);expect(await f.s.listByKind('finding')).toHaveLength(1);
 expect((await db.query('SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1',[f.task.exploration_id])).rowCount).toBe(1);
});

it('rolls back a nested finding without notifying Planner',async()=>{
 const f=await fixture();let notifications=0;
 await expect(db.transaction(async tx=>{
   await call(reportFindingTool({...f.c,db:tx,hooks:{notifyFinding:()=>{notifications++;}}}),{vulnclass:'LOCAL',severity:'low',summary:'LOCAL rollback',evidence:'LOCAL'});
   expect(notifications).toBe(0);throw new Error('outer rollback');
 })).rejects.toThrow('outer rollback');
 expect(notifications).toBe(0);expect(await f.s.listByKind('finding')).toHaveLength(0);
 expect((await db.query('SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1',[f.task.exploration_id])).rowCount).toBe(0);
});

it('fences new writes and idempotent retries from a superseded executor',async()=>{
 const f=await fixture(),old=new Coordinator(db,1),token=(await old.acquire(f.task.id))!;
 const c={...f.c,hooks:{assertOwnership:async(tx:Database)=>{await old.assert(f.task.id,token,tx);}}};
 const saved=await call(recordFactTool(c),observation,'fenced-fact');
 await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[f.task.id]);
 const next=new Coordinator(db,1),current=(await next.acquire(f.task.id))!;
 try{
  await expect(call(recordFactTool(c),observation,'fenced-fact')).rejects.toThrow('租约');
  await expect(call(reportFindingTool(c),{vulnclass:'LOCAL',severity:'low',summary:'stale',evidence:'LOCAL'})).rejects.toThrow('租约');
  await f.s.resetRunningIntents();await markWorkerReleased(db,f.task.exploration_id,f.id);
  expect((await db.query("SELECT 1 FROM blackboard_wakeups WHERE node_id=$1 AND kind='worker_settled'",[f.id])).rowCount).toBe(0);
  expect((await f.s.getNode(saved.fact_id))?.payload).toMatchObject(observation);
  expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).toHaveLength(1);expect(await f.s.listByKind('finding')).toHaveLength(0);
 }finally{await next.release(f.task.id,current);}
});

it('ends on the final summary without a completion tool or extra model request',async()=>{
 await db.platform().setSetting('workers','1');const f=await fixture(false),faux=fauxProvider({provider:'bb-stop'}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage([fauxToolCall('record_fact',observation)]),fauxAssistantMessage('LOCAL observation saved; done'),()=>{throw new Error('must not call model after final summary');}]);
 const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5},async()=>({modelRuntime,model:faux.getModel() as never}),dir);engines.push(e);
 await e.run(f.task.id);await until(async()=>!!(await db.query("SELECT 1 FROM blackboard_wakeups WHERE node_id=$1 AND kind='worker_settled'",[f.id])).rowCount);
 expect(faux.state.callCount).toBe(2);expect((await f.s.getNode(f.id))?.state).toBe('done');
 expect((await f.s.getNode(f.id))?.payload.execution_result).toBeUndefined();
 expect((await f.s.getNode(f.id))?.payload.execution_stop).toMatchObject({reason:'completed',accepted_result:false,summary:'LOCAL observation saved; done'});
 expect((await db.query('SELECT 1 FROM engine_worker_slots WHERE task_id=$1',[f.task.id])).rowCount).toBe(0);await e.stop(f.task.id);
});

it('isolates execution capacity between task owners without limiting planning submissions',async()=>{
 await db.platform().setSetting('workers','3');const f=await fixture(false),other=await fixture(false);
 await db.query("UPDATE tasks SET status='running',execution_mode='managed' WHERE id=ANY($1::bigint[])",[[f.task.id,other.task.id]]);
 const a=new Coordinator(db,3),b=new Coordinator(db,3),ta=(await a.acquire(f.task.id))!,tb=(await b.acquire(other.task.id))!;
 try{
  for(let i=0;i<3;i++)expect(await a.workerSlot(f.task.id,ta)).toBeTruthy();
  for(let i=0;i<3;i++)expect(await b.workerSlot(other.task.id,tb)).toBeTruthy();
  expect(await a.workerSlot(f.task.id,ta)).toBeUndefined();
  expect(await b.workerSlot(other.task.id,tb)).toBeUndefined();
  const intents=Array.from({length:4},(_,i)=>({summary:`LOCAL question ${i}`}));
  expect((await call(addIntentTool(runContext(db,f.task.id,f.task.exploration_id,'planner')),{intents})).submitted).toBe(4);
 }finally{await a.release(f.task.id,ta);await b.release(other.task.id,tb);}
});

it('exposes scoped steering and unified recall without legacy trace tools',async()=>{
 const f=await fixture();for(const role of ['planner','mainagent'] as const){const c=runContext(db,f.task.id,f.task.exploration_id,role);const names=(role==='planner'?plannerTools(c):mainTools(c)).map(t=>t.name);expect(names).toContain('steer_work');expect(names).not.toContain('get_worker_trace');}
});

it('refills one released slot from final graph results while the other two workers keep their intents',async()=>{
 await db.platform().setSetting('workers','3');
 const task=await db.tasks().createTaskWithOptions('LOCAL four observations','Observe four independent LOCAL samples',{executionMode:'managed'}),s=db.exploration(task.exploration_id);
 const goal=await s.addGoal({text:'Four local observations accepted'},'user');
 const worker=fauxProvider({provider:'bb-refill-worker'}),planner=fauxProvider({provider:'bb-refill-planner'}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(worker.provider);await runtime.registerNativeProvider(planner.provider);
 let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let peak=0,refillObserved=false;
 const proposal=(i:number)=>({summary:`Observe LOCAL sample ${i}`,contract:{objective:`Observe LOCAL sample ${i}`,acceptance:['Save the local observation'],work:{resource:`sample-${i}`,question_key:'observation',method_class:'local',identity:'fixture'}}});
 planner.setResponses(Array.from({length:12},()=>async()=>{
  const intents=await s.listByKind('intent'),done=intents.filter(n=>n.state==='done');
  const decision={type:'text' as const,text:'LOCAL planning summary'};
  if(!intents.length)return fauxAssistantMessage([fauxToolCall('add_intent',{intents:[1,2,3].map(proposal)}),decision]);
  if(intents.length===3&&done.length){expect(done).toHaveLength(1);expect(intents.filter(n=>n.state==='running')).toHaveLength(2);refillObserved=true;return fauxAssistantMessage([fauxToolCall('add_intent',{intents:[proposal(4)]}),decision]);}
  if(done.length===4){const evidence=(await s.listByKind('fact')).find(n=>n.payload.from_intent===done[0]!.id)!;return fauxAssistantMessage([fauxToolCall('prove_goal',{goal_id:goal,evidence_node_id:evidence.id,note:'four LOCAL results accepted'}),decision]);}
  return fauxAssistantMessage([decision]);
 }));
 worker.setResponses(Array.from({length:16},()=>async(context,options)=>{
  const id=Number(JSON.stringify(context).match(/当前意图 #(\d+)/)?.[1]);expect(id).toBeGreaterThan(0);
  const intent=(await s.getNode(id))!,sample=String(intent.payload.summary).split(' ').at(-1);
  const draft=(await db.query("SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='fact' AND payload->>'from_intent'=$2",[task.exploration_id,String(id)])).rows[0];
  peak=Math.max(peak,Number((await db.query("SELECT count(*) n FROM engine_worker_slots WHERE task_id=$1 AND phase='running'",[task.id])).rows[0]?.n));
  if(!draft)return fauxAssistantMessage([fauxToolCall('record_fact',{...observation,summary:`LOCAL ${sample}`})]);
  // The refill fixture needs a stable planning basis while the two peers stay active.
  // Direct writes can otherwise invalidate the fourth proposal before admission.
  if(sample==='1')await until(async()=>(await s.listByKind('fact')).filter(n=>n.payload.from_intent).length===3);
  if(sample==='2'||sample==='3')await Promise.race([held,new Promise<void>(r=>options?.signal?.addEventListener('abort',()=>r(),{once:true}))]);
  return fauxAssistantMessage(`LOCAL sample ${sample} saved as node:${draft.id}`);
 }));
 const e=new Engine(db,{...defaultEngineConfig(),workers:3,debounceMs:5},async(_id,role)=>({modelRuntime:runtime,model:(role==='planner'?planner:worker).getModel() as never}),dir);engines.push(e);
 try{
  await e.run(task.id);await until(async()=>{const nodes=await s.listByKind('intent');const failed=nodes.find(n=>n.state==='blocked');if(failed)throw new Error(JSON.stringify(failed.payload.execution_stop));return refillObserved&&nodes.filter(n=>n.state==='done').length===2;},lifecycleWaitMs);
  expect((await db.tasks().getTask(task.id))?.status).toBe('running');expect((await s.listByKind('intent')).filter(n=>n.state==='running')).toHaveLength(2);
  release();await until(async()=>(await db.tasks().getTask(task.id))?.status==='done',lifecycleWaitMs);
  expect(peak).toBe(3);expect((await s.listByKind('intent')).every(n=>n.state==='done')).toBe(true);expect(worker.state.callCount).toBe(8);
 }finally{release();await e.stop(task.id);}
});


it('recovers a legacy committed-but-unreleased result without a model or duplicate feedback',async()=>{
 const f=await fixture(),saved=await call(recordFactTool(f.c),observation);
 await db.query("UPDATE exploration_nodes SET state='done',payload=payload||jsonb_build_object('execution_result',$2::jsonb) WHERE id=$1",[f.id,JSON.stringify(result(saved.fact_id))]);
 await db.query('INSERT INTO worker_settlements(id,intent_id,exploration_id,task_id,worker) VALUES($1,$2,$3,$4,$5)',[randomUUID(),f.id,f.task.exploration_id,f.task.id,'work#1']);
 await recoverWorkerSettlements(db,f.task.exploration_id);await recoverWorkerSettlements(db,f.task.exploration_id);await markWorkerReleased(db,f.task.exploration_id,f.id);
 expect((await db.query("SELECT 1 FROM activity WHERE node_id=$1 AND kind='result'",[f.id])).rowCount).toBe(1);
 expect((await db.query("SELECT 1 FROM blackboard_wakeups WHERE node_id=$1 AND kind='worker_settled'",[f.id])).rowCount).toBe(1);
 expect((await f.s.getNode(f.id))?.payload.execution_stop).toMatchObject({accepted_result:true,reason:'completed'});
});

it.each([1,2,3])('enforces an independent per-task quota of %i across concurrent reservations',async limit=>{
 await db.platform().setSetting('workers',String(limit));const f=await fixture(false),other=await fixture(false);
 const a=new Coordinator(db,3),b=new Coordinator(db,3),ta=(await a.acquire(f.task.id))!,tb=(await b.acquire(other.task.id))!;
 try{
  await db.query("UPDATE tasks SET status='running' WHERE id=ANY($1::bigint[])",[[f.task.id,other.task.id]]);
  const as:string[]=[],bs:string[]=[];
  // Nonblocking lock contention may defer a reservation; retry without releasing any winners.
  await until(async()=>{
   const [first,second]=await Promise.all([
    Promise.all(Array.from({length:limit+2},()=>a.workerSlot(f.task.id,ta))),
    Promise.all(Array.from({length:limit+2},()=>b.workerSlot(other.task.id,tb))),
   ]);
   as.push(...first.filter((v):v is string=>!!v));bs.push(...second.filter((v):v is string=>!!v));
   expect(as.length).toBeLessThanOrEqual(limit);expect(bs.length).toBeLessThanOrEqual(limit);
   return as.length===limit&&bs.length===limit;
  });
  expect(await executionSnapshot(db,f.task.id)).toMatchObject({limit_scope:'task',limit,task_active:limit,global_active:limit*2,available:0});
  await a.releaseSlot(as.find(Boolean)!);
  expect((await executionSnapshot(db,f.task.id)).available).toBe(1);
  expect((await executionSnapshot(db,other.task.id)).available).toBe(0);
  expect(await a.workerSlot(f.task.id,ta)).toBeTruthy();
 }finally{await a.release(f.task.id,ta);await b.release(other.task.id,tb);}
});

it('applies lower limits on the next claim, counts manual and exiting Workers, and ignores planning slots',async()=>{
 await db.platform().setSetting('workers','3');const f=await fixture(false),a=new Coordinator(db,3),token=(await a.acquire(f.task.id))!;
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[f.task.id]);
 try{
  const manual=(await db.transaction(tx=>a.reserveWorkerSlot(tx,f.task.id,token,true,f.id)))!;
  const second=(await a.workerSlot(f.task.id,token))!,third=(await a.workerSlot(f.task.id,token))!;
  await db.query("UPDATE exploration_nodes SET payload=payload||'{\"execution_result\":{}}'::jsonb WHERE id=$1",[f.id]);
  await db.platform().setSetting('workers','1');
  expect(await executionSnapshot(db,f.task.id)).toMatchObject({limit:1,task_active:3,exiting:1,available:0});
  expect(await a.workerSlot(f.task.id,token)).toBeUndefined();
  await a.releaseSlot(second);await a.releaseSlot(third);
  expect(await a.workerSlot(f.task.id,token)).toBeUndefined(); // A committed manual Worker still owns its slot until exit.
  await a.releaseSlot(manual);
  await db.query("INSERT INTO engine_worker_slots(id,task_id,token,phase) VALUES($1,$2,$3,'planning'),($4,$2,$3,'ready')",[randomUUID(),f.task.id,token,randomUUID()]);
  expect((await executionSnapshot(db,f.task.id)).available).toBe(1);
  expect(await a.workerSlot(f.task.id,token)).toBeTruthy();
  expect(await a.workerSlot(f.task.id,token)).toBeUndefined();
 }finally{await a.release(f.task.id,token);}
});

it('fences old task owners and leaves paused, queued and finished tasks without reservations',async()=>{
 await db.platform().setSetting('workers','1');const f=await fixture(false),a=new Coordinator(db,1),b=new Coordinator(db,1),token=(await a.acquire(f.task.id))!;
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[f.task.id]);
 expect(await a.workerSlot(f.task.id,token)).toBeTruthy();
 await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[f.task.id]);
 const replacement=(await b.acquire(f.task.id))!;
 try{
  await expect(a.workerSlot(f.task.id,token)).rejects.toThrow('租约');
  expect((await executionSnapshot(db,f.task.id)).available).toBe(1);
  const slot=(await b.workerSlot(f.task.id,replacement))!;expect(slot).toBeTruthy();await b.releaseSlot(slot);
  for(const [status,paused,queued] of [['running',true,false],['running',false,true],['done',false,false]]){
   await db.query('UPDATE tasks SET status=$2,paused=$3,queued=$4 WHERE id=$1',[f.task.id,status,paused,queued]);
   expect(await b.workerSlot(f.task.id,replacement)).toBeUndefined();
  }
 }finally{await b.release(f.task.id,replacement);}
});

it('reserves capacity without borrowing another connection while holding the transaction lock',async()=>{
 await db.platform().setSetting('workers','2');const f=await fixture(false),other=await fixture(false);
 await db.query("UPDATE tasks SET status='running' WHERE id=ANY($1::bigint[])",[[f.task.id,other.task.id]]);
 // A saturated pool previously deadlocked: the lock owner borrowed another connection for settings.
 const pool=new pg.Pool({connectionString:process.env.SERIES_PG_DSN,max:1,connectionTimeoutMillis:1000});
 const small=new Database(pool),a=new Coordinator(small,2),b=new Coordinator(small,2);
 const ta=(await a.acquire(f.task.id))!,tb=(await b.acquire(other.task.id))!;
 try{
  const requests=await Promise.all(Array.from({length:3},()=>Promise.all([a.workerSlot(f.task.id,ta),b.workerSlot(other.task.id,tb)])));
  expect(requests.flat().filter(Boolean)).toHaveLength(4);
  expect((await executionSnapshot(small,f.task.id)).task_active).toBe(2);
  expect((await executionSnapshot(small,other.task.id)).task_active).toBe(2);
 }finally{await a.release(f.task.id,ta);await b.release(other.task.id,tb);await small.close();}
});

it('does not queue a second owner on capacity locks and renews leases outside a saturated business pool',async()=>{
 const f=await fixture(false);await db.query("UPDATE tasks SET status='running' WHERE id=$1",[f.task.id]);
 const aDB=new Database(new pg.Pool({connectionString:process.env.SERIES_PG_DSN,max:1,connectionTimeoutMillis:1000}));
 const bDB=new Database(new pg.Pool({connectionString:process.env.SERIES_PG_DSN,max:1,connectionTimeoutMillis:1000}));
 const a=new Coordinator(aDB,2),b=new Coordinator(bDB,2),token=(await a.acquire(f.task.id))!;
 try{
  await aDB.transaction(async tx=>{
   expect(await a.lockWorkerCapacity(tx)).toBe(true);
   const started=Date.now();
   expect(await b.workerSlot(f.task.id,token)).toBeUndefined();
   expect(Date.now()-started).toBeLessThan(500);
   await a.renew(f.task.id,token); // The only business connection remains held by tx.
   expect(aDB.control().runtimeMetrics().pools.primary.waiting).toBe(0);
   expect(tx.control()).toBe(tx);
  });
 }finally{await a.release(f.task.id,token);await aDB.close();await bDB.close();}
});

it('keeps a submitted intent executable after unrelated graph changes',async()=>{
 await db.platform().setSetting('workers','1');const f=await fixture(false),a=new Coordinator(db,1),token=(await a.acquire(f.task.id))!;
 await db.query("UPDATE tasks SET status='running',execution_mode='managed' WHERE id=$1",[f.task.id]);
 const c=runContext(db,f.task.id,f.task.exploration_id,'planner',{planningRoundID:'stale'});
 const proposed=await call(addIntentTool(c),{intents:[{summary:'LOCAL proposal',contract:{objective:'LOCAL proposal',acceptance:['Observe LOCAL'],work:{resource:'LOCAL stale',question_key:'q',method_class:'fixture',identity:'x'}}}]});
 await f.s.addNode('fact',{summary:'new final result',evidence:'LOCAL'},0,'confirmed','worker',[]);
 expect((await f.s.getNode(proposed.intents[0].intent_id))?.payload).toMatchObject({dispatch_requested:true});
 expect(await a.workerSlot(f.task.id,token)).toBeTruthy(); // Only explicit user intent remains eligible.
 await a.release(f.task.id,token);
});

it('reads legacy private observations and checkpoints without automatically publishing them',async()=>{
 await db.platform().setSetting('workers','1');const f=await fixture();
 const draft=Number((await db.query(`INSERT INTO worker_observations(intent_id,exploration_id,node_id,kind,payload,dedup_key)
 VALUES($1,$2,nextval(pg_get_serial_sequence('exploration_nodes','id')),'fact',$3::jsonb,'legacy') RETURNING node_id`,[f.id,f.task.exploration_id,JSON.stringify(observation)])).rows[0]!.node_id);
 await db.query('INSERT INTO worker_checkpoints(intent_id,progress) VALUES($1,$2::jsonb)',[f.id,JSON.stringify({summary:'LOCAL legacy checkpoint',phase:'verifying',attempted:['observed once']})]);
 const faux=fauxProvider({provider:'bb-resume-private'}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
 const sessionPath=path.join(dir,'sessions',`exp${f.task.exploration_id}-worker-i${f.id}.jsonl`);
 const checkpoint=defineTool({name:'checkpoint_intent',label:'Historical checkpoint',description:'Old protocol fixture',parameters:{type:'object',properties:{}} as never,
  async execute(){return {content:[{type:'text',text:'LOCAL legacy checkpoint'}],details:undefined};}});
 faux.setResponses([fauxAssistantMessage([fauxToolCall('checkpoint_intent',{})]),fauxAssistantMessage('历史协议要求：下次先 checkpoint_intent，最后 complete_intent 集中发布。')]);
 const history=await AgentRunner.create({cwd:dir,agentDir:path.join(dir,'legacy-agent'),modelRuntime:runtime,model:faux.getModel() as never,toolAllowlist:['checkpoint_intent'],customTools:[checkpoint],resumeSessionPath:sessionPath});
 try{await history.prompt('LOCAL legacy execution');}finally{await history.dispose();}
 faux.setResponses([context=>{const text=JSON.stringify(context.messages);expect(text).toContain('LOCAL observed');expect(text).toContain('LOCAL legacy checkpoint');expect(text).toContain('历史协议要求');expect(text).toContain('历史会话中的这些要求已失效');return fauxAssistantMessage('No new verified observation; legacy material remains private.');}]);
 const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5},async()=>({modelRuntime:runtime,model:faux.getModel() as never}),dir);engines.push(e);
 await e.run(f.task.id);await until(async()=>{const node=await f.s.getNode(f.id);if(node?.state==='blocked')throw new Error(JSON.stringify(node.payload.execution_stop));return node?.state==='done';});await e.stop(f.task.id);
 expect(faux.state.callCount).toBe(3);expect(await f.s.getNode(draft)).toBeNull();
 expect((await call(contextGetTool(f.c),{ref:`node:${draft}`})).staged).toBe(true);
 expect((await db.query('SELECT published_at FROM worker_observations WHERE node_id=$1',[draft])).rows[0]?.published_at).toBeNull();
});

it('does not audit a synthetic aborted pi continuation as another provider request',async()=>{
 await db.platform().setSetting('workers','1');const f=await fixture(false);
 const faux=fauxProvider({provider:'bb-meter'}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
 const profile=await db.platform().saveProfile({name:'LOCAL audit',format:'openai',model:'fixture',baseURL:'http://127.0.0.1:1',apiKey:'local-only',isDefault:true});
 await db.query('UPDATE tasks SET llm_profile_id=$2,active_llm_profile_id=$2 WHERE id=$1',[f.task.id,profile]);
 faux.setResponses([fauxAssistantMessage([fauxToolCall('record_fact',observation)]),fauxAssistantMessage('LOCAL done')]);
 const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5},makeModelResolver(db,async()=>({modelRuntime:runtime,model:faux.getModel() as never})),dir);engines.push(e);
 await e.run(f.task.id);await until(async()=>!!(await db.query("SELECT 1 FROM blackboard_wakeups WHERE node_id=$1 AND kind='worker_settled'",[f.id])).rowCount);await e.stop(f.task.id);
 const audit=(await db.query('SELECT status FROM llm_request_attempts WHERE task_id=$1',[f.task.id])).rows;
 expect(faux.state.callCount).toBe(2);expect(audit).toEqual([{status:'completed'},{status:'completed'}]);
});

it('keeps already written facts when execution later fails',async()=>{
 const f=await fixture(),saved=await call(recordFactTool(f.c),observation);
 await f.s.setIntentState(f.id,'blocked');
 expect((await f.s.getNode(saved.fact_id))?.state).toBe('confirmed');
 await f.s.reopenIntent(f.id);await f.s.claimNextWorker('work#1');
 const planner=runContext(db,f.task.id,f.task.exploration_id,'planner');
 expect((await searchContext(planner,{types:['fact'],intent_id:f.id})).items.map(n=>n.node_id)).toEqual([saved.fact_id]);
});

it('serializes a final goal proof against automatic claims while retaining explicit user dispatch',async()=>{
 const f=await fixture(false);await db.query("UPDATE tasks SET execution_mode='managed' WHERE id=$1",[f.task.id]);
 const goal=await f.s.addGoal({text:'LOCAL goal'},'user');await f.s.setNodeState(goal,'met');
 const auto=await f.s.addIntent({summary:'automatic pending'},1,[],'planner');
 expect(await f.s.claimNextWorker('work#1',n=>n.id===auto)).toBeNull();
 expect((await f.s.claimNextWorker('work#1',n=>n.id===f.id))?.id).toBe(f.id);
});

it('allows independent incremental observations while refusing draft-style overwrites',async()=>{
 const f=await fixture(),first=await call(recordFactTool(f.c),observation);
 const second=await call(recordFactTool(f.c),{...observation,summary:'Independent new LOCAL observation'});
 expect(first.fact_id).not.toBe(second.fact_id);
 await expect(call(recordFactTool(f.c),{...observation,replace_node_id:first.fact_id})).rejects.toThrow('已停用');
 expect(((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).map(n=>n.id).sort((a,b)=>a-b)).toEqual([first.fact_id,second.fact_id]);
});

it('coalesces a live Worker finding, keeps it readable immediately and wakes again after Worker release',async()=>{
 await db.platform().setSetting('workers','3');
 const task=await db.tasks().createTaskWithOptions('LOCAL live writeback','Observe LOCAL fixture',{executionMode:'managed'}),s=db.exploration(task.exploration_id);
 const goal=await s.addGoal({text:task.goal},'user');
 const worker=fauxProvider({provider:'bb-live-worker'}),planner=fauxProvider({provider:'bb-live-planner'}),runtime=await ModelRuntime.create({refreshOnCreate:false});
 await runtime.registerNativeProvider(worker.provider);await runtime.registerNativeProvider(planner.provider);
 let release!:()=>void,holding=false,liveObserved=false;const held=new Promise<void>(r=>release=r);
 const decision={type:'text' as const,text:'LOCAL planning summary'};
 planner.setResponses([
 fauxAssistantMessage([fauxToolCall('add_intent',{intents:[{summary:'Verify one LOCAL sample',contract:{objective:'Verify one LOCAL sample',acceptance:['Save observations'],work:{resource:'local:live',question_key:'sample',method_class:'fixture',identity:'test'}}}]}),decision]),
 ...Array.from({length:8},()=>async()=>{const facts=(await s.listByKind('fact')).filter(n=>n.state==='confirmed'),findings=await s.listByKind('finding'),intent=(await s.listByKind('intent'))[0]!;
  if(intent.state!=='done'){if(intent.state==='running'&&facts.length===1&&findings.length===1)liveObserved=true;return fauxAssistantMessage([decision]);}
  return fauxAssistantMessage([fauxToolCall('prove_goal',{goal_id:goal,evidence_node_id:facts[0]!.id}),decision]);})]);
 worker.setResponses([fauxAssistantMessage([fauxToolCall('record_fact',observation),fauxToolCall('report_finding',{vulnclass:'LOCAL fixture',severity:'low',summary:'LOCAL finding',evidence:'Synthetic evidence only'})]),
 async(_context,options)=>{holding=true;await Promise.race([held,new Promise<void>(r=>options?.signal?.addEventListener('abort',()=>r(),{once:true}))]);return fauxAssistantMessage('LOCAL observations saved.');}]);
 const e=new Engine(db,{...defaultEngineConfig(),workers:3,debounceMs:5},async(_id,role)=>({modelRuntime:runtime,model:(role==='planner'?planner:worker).getModel() as never}),dir);engines.push(e);
 try{
  await e.run(task.id);await until(async()=>holding,lifecycleWaitMs);
  expect(await s.listByKind('finding')).toHaveLength(1); // publication itself is never delayed
  const calls=planner.state.callCount;e.notify(task.id);await new Promise(r=>setTimeout(r,100));
  expect(planner.state.callCount).toBe(calls);expect(liveObserved).toBe(false);
  expect((await db.query("SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1 AND kind='control_changed'",[task.exploration_id])).rowCount).toBe(0);
  // Advance only this synthetic event's durable age, without a 30-second test sleep.
  await db.query("UPDATE blackboard_wakeups SET created_at=now()-interval '31 seconds' WHERE exploration_id=$1 AND kind='finding_published'",[task.exploration_id]);
  e.notify(task.id);await until(async()=>liveObserved,lifecycleWaitMs);release();
  await until(async()=>(await db.tasks().getTask(task.id))?.status==='done',lifecycleWaitMs);expect(worker.state.callCount).toBe(2);
 }
 finally{release();await e.stop(task.id);}
});

it('coalesces Worker asset registration and wakes on explicit association removal',async()=>{
 const f=await fixture();const saved=await call(insertAssetsTool(f.c),{items:[{type:'service',url:'http://local-approval.test:9080'}]});
 expect((await db.query("SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1",[f.task.exploration_id])).rowCount).toBe(1);
 await db.query("DELETE FROM task_asset_links WHERE task_id=$1 AND asset_id=$2",[f.task.id,saved.assets[0].asset_id]);
 expect((await db.query("SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1 AND kind='assets_changed'",[f.task.exploration_id])).rowCount).toBe(2);
});

it('keeps anchored facts immediately visible without treating tested metadata as asset discovery',async()=>{
 const f=await fixture(),saved=await call(insertAssetsTool(f.c),{assets:[{type:'service',url:'http://fact-wakeup.invalid'}]});
 const asset=saved.results[0].id;
 await db.query('DELETE FROM blackboard_wakeups WHERE exploration_id=$1',[f.task.exploration_id]);
 const first=await call(recordFactTool(f.c),{...observation,asset_ids:[asset]});
 await db.taskScope().markTaskAssetsTested(f.task.id,[asset],'different-worker');
 const second=await call(recordFactTool(f.c),{...observation,summary:'second independent observation',asset_ids:[asset]});
 expect((await db.query('SELECT tested,tested_by FROM task_asset_links WHERE task_id=$1 AND asset_id=$2',[f.task.id,asset])).rows[0]).toMatchObject({tested:true,tested_by:'different-worker'});
 expect((await (await import('../db/asset-query.js')).queryAssets(db,{taskID:f.task.id,ids:[asset]})).assets[0]).toMatchObject({tested:true,tested_by:'work#1'});
 expect((await db.query('SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1',[f.task.exploration_id])).rowCount).toBe(0);
 const planner=runContext(db,f.task.id,f.task.exploration_id,'planner');
 expect((await searchContext(planner,{asset_id:asset,types:['fact']})).items.map(n=>n.node_id)).toEqual([second.fact_id,first.fact_id]);
 await db.query("UPDATE assets SET page_title='new observed title' WHERE id=$1",[asset]);
 expect((await db.query("SELECT 1 FROM blackboard_wakeups WHERE exploration_id=$1 AND kind='assets_changed'",[f.task.exploration_id])).rowCount).toBe(1);
});

it('rolls back a fact and its context events together if the enclosing write fails',async()=>{
 const f=await fixture();
 await expect(db.transaction(async tx=>{await call(recordFactTool({...f.c,db:tx}),observation);throw new Error('LOCAL rollback');})).rejects.toThrow('rollback');
 expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).toHaveLength(0);
 expect((await db.query("SELECT 1 FROM exploration_context_events WHERE exploration_id=$1 AND kind='fact' AND node_id<> (SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND state='origin' LIMIT 1)",[f.task.exploration_id])).rowCount).toBe(0);
});
