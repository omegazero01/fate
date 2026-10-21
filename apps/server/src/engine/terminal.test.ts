import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,type Database} from '../db/index.js';
import {Engine,defaultEngineConfig} from './engine.js';
import {Coordinator} from './coordinator.js';
import {proveGoalTool} from '../tools/findings.js';
import {runContext} from '../tools/context.js';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';

const name=`fate_terminal_test_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-terminal-test-'));
let db:Database;const engines:Engine[]=[];
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;db=await openDatabase();await db.platform().setSetting('workers','1');});
afterAll(async()=>{for(const e of engines)await e.shutdown();await db.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(mode:'manual'|'managed'='manual'){
 const task=await db.tasks().createTaskWithOptions('LOCAL terminal fixture','',{executionMode:mode});
 let calls=0;const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>{calls++;throw new Error('no model should be needed');},dir);engines.push(e);
 return {task,e,s:db.exploration(task.exploration_id),calls:()=>calls};
}
async function until(fn:()=>Promise<boolean>,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('terminal condition timed out');}

it('does not use the task description or a retracted observation as proof of completion',async()=>{
 const {task,s}=await fixture(),goal=await s.addGoal({text:'requires observed evidence'},'user');
 const tool=proveGoalTool(runContext(db,task.id,task.exploration_id,'planner'));
 for(const id of [await s.originFactID(),await s.addNode('fact',{summary:'retracted',evidence:'stale'},0,'dismissed','worker',[]),
   await s.addNode('fact',{summary:'claim without evidence'},0,'confirmed','worker',[]),
   await s.addNode('fact',{summary:'hypothesis',evidence:'a conjecture',observation_type:'inferred'},0,'confirmed','worker',[])]){
  const result=await tool.execute('proof',{goal_id:goal,evidence_node_id:id},undefined,undefined,{} as never);
  expect(result.isError).toBe(true);expect((await s.getNode(goal))?.state).toBe('open');
 }
 const fact=await s.addNode('fact',{summary:'observed',evidence:'LOCAL observed evidence'},0,'confirmed','worker',[]);
 expect((await tool.execute('proof-valid',{goal_id:goal,evidence_node_id:fact},undefined,undefined,{} as never)).isError).not.toBe(true);
 expect((await s.getNode(goal))?.state).toBe('met');
});

it('recovers durable completed goals without another Planner model request',async()=>{
 const {task,e,s,calls}=await fixture('managed');const goal=await s.addGoal({text:'already proven before restart'},'user');
 const fact=await s.addNode('fact',{summary:'LOCAL evidence'},0,'confirmed','worker',[]);await s.link(fact,'proves',goal);await s.setNodeState(goal,'met');
 await e.run(task.id);await until(async()=>(await db.tasks().getTask(task.id))?.status==='done');
 expect(calls()).toBe(0);expect((await db.tasks().getTask(task.id))?.completed_at).toBeTruthy();
 await e.stop(task.id);
});

it('allows Planner to prove a goal from committed facts while Worker is still running',async()=>{
 const {task,s}=await fixture();const intent=await s.addIntent({summary:'LOCAL work',dispatch_requested:true},5,[],'user');
 await s.claimNextWorker('work#1');const fact=await s.addNode('fact',{summary:'observed',evidence:'LOCAL evidence',from_intent:intent},0,'confirmed','work#1',[]);
 const goal=await s.addGoal({text:'finish the assigned work'},'user'),tool=proveGoalTool(runContext(db,task.id,task.exploration_id,'planner'));
 expect((await tool.execute('early',{goal_id:goal,evidence_node_id:fact},undefined,undefined,{} as never)).isError).not.toBe(true);
 expect((await s.getNode(goal))?.state).toBe('met');expect((await s.getNode(intent))?.state).toBe('running');
 await s.setIntentState(intent,'done');
 expect((await tool.execute('settled',{goal_id:goal,evidence_node_id:fact},undefined,undefined,{} as never)).isError).not.toBe(true);
});

it('a failed terminal commit leaves the executor retryable and does not publish success',async()=>{
 const {task,e}=await fixture();await e.run(task.id);const rt=(e as any).rt(task.id);
 const transaction=db.transaction.bind(db);
 db.transaction=(async(fn:any)=>transaction(async tx=>{
  const query=tx.query.bind(tx);tx.query=((sql:string,values?:unknown[])=>{
   if(/UPDATE tasks/.test(sql)&&values?.includes('done'))throw new Error('injected terminal write failure');
   return query(sql,values);
  }) as typeof tx.query;return fn(tx);
 })) as typeof db.transaction;
 try{await expect((e as any).finishTask(rt,'done','LOCAL completion')).rejects.toThrow('injected terminal write failure');}
 finally{db.transaction=transaction;}
 expect(rt.stopped).toBe(false);expect((await db.tasks().getTask(task.id))?.status).toBe('running');
 expect((await db.query("SELECT 1 FROM activity WHERE exploration_id=$1 AND summary='LOCAL completion'",[task.exploration_id])).rowCount).toBe(0);
 await (e as any).finishTask(rt,'done','LOCAL completion');expect((await db.tasks().getTask(task.id))?.status).toBe('done');await e.stop(task.id);
});

it('a stale executor cannot finish a task after another owner acquired its lease',async()=>{
 const {task,e}=await fixture();await e.run(task.id);const rt=(e as any).rt(task.id);
 await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[task.id]);
 const remote=new Coordinator(db,1),token=await remote.acquire(task.id);expect(token).toBeTruthy();
 await expect((e as any).finishTask(rt,'done','stale completion')).rejects.toThrow(/租约/);
 expect((await db.tasks().getTask(task.id))?.status).toBe('running');await e.stop(task.id);await remote.release(task.id,token!);
});

it('a persisted pause wins against terminal publication from an in-flight Planner',async()=>{
 const {task,e}=await fixture();await e.run(task.id);const rt=(e as any).rt(task.id);await db.tasks().applyTaskPause(task.id);
 await (e as any).finishTask(rt,'done','must not finish while paused');
 const saved=await db.tasks().getTask(task.id);expect(saved?.paused).toBe(true);expect(saved?.status).not.toBe('done');expect(saved?.completed_at).toBeNull();await e.stop(task.id);
});

it.each(['stop','pause'] as const)('preserves a completed Worker receipt when %s arrives after execution ends',async action=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL completed-result race','',{executionMode:'manual'}),s=db.exploration(task.exploration_id);
 const id=await s.addIntent({summary:'LOCAL evidence',dispatch_requested:true},5,[],'user');
 const faux=fauxProvider({provider:`terminal-${action}`}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
 let finalText=false;
 faux.setResponses([
  fauxAssistantMessage([fauxToolCall('record_fact',{summary:'LOCAL observed',evidence:'LOCAL synthetic evidence',confidence:'high'})]),
  fauxAssistantMessage('LOCAL observations saved; execution finished.'),
  async(_context,options)=>{finalText=true;await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener('abort',()=>resolve(),{once:true});});return fauxAssistantMessage('',{stopReason:'aborted'});},
 ]);
 const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:2},async()=>({modelRuntime:runtime,model:faux.getModel() as never}),dir);engines.push(e);
 await e.run(task.id);await until(async()=>!!(await s.getNode(id))?.payload.execution_stop);expect(finalText).toBe(false);expect(faux.state.callCount).toBe(2);expect((await s.getNode(id))?.payload.execution_result).toBeUndefined();
 if(action==='stop')await e.stop(task.id);else{await db.tasks().applyTaskPause(task.id);await e.pause(task.id);}
 expect((await s.getNode(id))?.state).toBe('done');
 expect((await db.query("SELECT 1 FROM activity WHERE exploration_id=$1 AND node_id=$2 AND kind='result' AND worker='work#1'",[task.exploration_id,id])).rowCount).toBe(1);
 await e.stop(task.id);
});

it('bounds a Planner-only task by its deadline without falsely completing unmet goals',async()=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL insufficient evidence','need unavailable evidence',{executionMode:'managed',timeoutSeconds:60});
 const s=db.exploration(task.exploration_id);await s.addGoal({text:'requires missing evidence'},'user');
 const faux=fauxProvider({provider:'terminal-no-work'}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
 faux.setResponses(Array.from({length:3},()=>[
  fauxAssistantMessage('LOCAL planning complete'),
 ]).flat());
 const roles:string[]=[];const e=new Engine(db,{...defaultEngineConfig(),debounceMs:2,workers:1},async(_id,role)=>{roles.push(role);return {modelRuntime:runtime,model:faux.getModel() as never};},dir);engines.push(e);
 await e.run(task.id);
 // Start the deadline after one normal round, rather than racing slow test-machine startup.
 await until(async()=>!!(await db.query("SELECT 1 FROM runtime_role_configs WHERE task_id=$1 AND role='planner' AND finished_at IS NOT NULL",[task.id])).rowCount);
 await db.query("UPDATE tasks SET deadline_at=now()-interval '1 second' WHERE id=$1",[task.id]);
 await until(async()=>(await db.tasks().getTask(task.id))?.status==='timeout',8000);
 const saved=await db.tasks().getTask(task.id);expect(saved?.first_run_at).toBeTruthy();expect(saved?.completed_at).toBeTruthy();expect((await s.listByKind('goal'))[0]?.state).toBe('open');
 expect(roles).not.toContain('worker');expect(faux.state.callCount).toBe(2);await e.stop(task.id);
});
