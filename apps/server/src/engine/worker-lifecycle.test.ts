import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,getCurrentTools} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {Engine,defaultEngineConfig,type AbortCause} from './engine.js';
import {pendingPlannerContext} from '../db/planner-context.js';
import {workerLaunchContext} from '../tools/context-read.js';
import {runContext} from '../tools/context.js';
import {Coordinator} from './coordinator.js';

const name=`fate_worker_lifecycle_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-worker-lifecycle-'));
let db:Database;const engines:Engine[]=[];
beforeAll(async()=>{
  process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;
  db=await openDatabase();await db.platform().setSetting('workers','1');
});
afterAll(async()=>{
  for(const e of engines)await e.shutdown();await db.close();
  const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});
  await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});
});
async function until(fn:()=>Promise<boolean>,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('lifecycle condition timed out');}
async function source(suffix:string){const faux=fauxProvider({provider:`lifecycle-${suffix}`}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);return {faux,model:{modelRuntime,model:faux.getModel() as never}};}
async function fixture(maxTurns=30,relativeDataDir=false){
  await db.query("UPDATE agents SET max_turns=$1 WHERE key='worker'",[maxTurns]);
  const task=await db.tasks().createTaskWithOptions('LOCAL lifecycle fixture','',{executionMode:'manual'}),s=db.exploration(task.exploration_id);
  const id=await s.addIntent({summary:'仅验证 LOCAL 夹具并写回',dispatch_requested:true},5,[],'user');
  const m=await source(String(task.id));
  const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5,workerMaxTurns:30},async()=>m.model,relativeDataDir?path.relative(process.cwd(),dir):dir);engines.push(e);
  return {task,s,id,e,...m};
}
const readExisting=()=>fauxAssistantMessage([fauxToolCall('context_search',{query:'LOCAL'})]);
const fact=()=>fauxAssistantMessage([fauxToolCall('record_fact',{observation_type:'observed',summary:'LOCAL observation',evidence:'Synthetic local observation; no external request',confidence:'high'})]);
async function completion(f:Awaited<ReturnType<typeof fixture>>){
  const n=(await f.s.listByKind('fact')).find(n=>n.payload.from_intent===f.id)!;
  return fauxAssistantMessage(`LOCAL saved node:${n.id}; execution finished.`);
}

it('gives PI and Bash the same absolute working directory when dataDir is relative',async()=>{
  const f=await fixture(0,true),cwd=path.join(dir,'tasks',String(f.task.id),`i${f.id}`);
  f.faux.setResponses([
    context=>{expect(JSON.stringify(context.messages)).toContain(cwd);return fauxAssistantMessage([fauxToolCall('bash',{command:`cd '${cwd}' && pwd`})]);},
    context=>{expect(JSON.stringify(context.messages)).not.toContain('No such file or directory');return fauxAssistantMessage('LOCAL cwd checked, no new observation.');},
  ]);
  await f.e.run(f.task.id);await until(async()=>(await f.s.getNode(f.id))?.state==='done');
  expect(f.faux.state.callCount).toBe(2);
  const results=(await db.query("SELECT detail,is_error FROM activity WHERE node_id=$1 AND kind='tool_result' AND tool='bash'",[f.id])).rows;
  expect(results).toHaveLength(1);expect(results[0]!.is_error).toBe(false);expect(results[0]!.detail).toContain(cwd);
  expect((await f.s.listByKind('fact')).filter(n=>n.state==='confirmed')).toHaveLength(0);await f.e.stop(f.task.id);
});

it.each(['summary','revoked'])('closes a Worker on %s basis changes, saves observations and bounds native retries even with unlimited turns',async change=>{
  const f=await fixture(0),sentinel=path.join(dir,`stale-basis-${f.id}`);
  const basis=await f.s.addNode('fact',{summary:'LOCAL original basis'},0,'confirmed','fixture',[]);
  await db.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('contract',$2::jsonb) WHERE id=$1",[f.id,JSON.stringify({version:1,objective:'LOCAL mandate',acceptance:['LOCAL result'],basis:[{node_id:basis,version:0}],out_of_scope:[]})]);
  const probe=()=>fauxAssistantMessage([fauxToolCall('bash',{command:`touch '${sentinel}'`})]);
  f.faux.setResponses([
    async()=>{
      if(change==='summary')await db.query("UPDATE exploration_nodes SET payload=payload||'{\"summary\":\"LOCAL corrected basis\"}'::jsonb WHERE id=$1",[basis]);
      else await db.query("UPDATE exploration_nodes SET state='dismissed' WHERE id=$1",[basis]);
      return probe();
    },
    context=>{
      const tools=getCurrentTools(context.messages);
      expect(tools.some(t=>t.name==='bash'||t.name==='http_request')).toBe(false);
      expect(tools.some(t=>t.name==='record_fact')).toBe(true);
      return fauxAssistantMessage([fauxToolCall('record_fact',{summary:'LOCAL saved before replanning',evidence:'LOCAL known observation, no external request',confidence:'high'}),fauxToolCall('bash',{command:`touch '${sentinel}'`})]);
    },
    probe(),
    ()=>{throw new Error('Worker must not request a third settlement response');},
  ]);
  await f.e.run(f.task.id);await until(async()=>!!(await f.s.getNode(f.id))?.payload.execution_stop);
  const node=(await f.s.getNode(f.id))!;
  expect(node.state).toBe('blocked');
  expect(node.payload.execution_stop,JSON.stringify(node.payload.execution_stop)).toMatchObject({reason:change==='summary'?'basis_changed':'basis_unavailable',accepted_result:false});
  expect((await f.s.listByKind('fact')).some(n=>n.payload.from_intent===f.id&&n.payload.summary==='LOCAL saved before replanning')).toBe(true);
  expect(existsSync(sentinel)).toBe(false);expect(f.faux.state.callCount).toBe(3);
  expect((await db.query('SELECT 1 FROM worker_operations WHERE intent_id=$1',[f.id])).rowCount).toBe(0);
  expect((await db.query("SELECT count(*) FROM activity WHERE node_id=$1 AND kind='status' AND summary LIKE '%收尾%'",[f.id])).rows[0]?.count).toBe('1');
  await f.e.stop(f.task.id);
});

it('delivers native PI steering while preserving incremental writes and final summary',async()=>{
  const f=await fixture();let received=false;
  f.faux.setResponses([
    async()=>{await f.e.steerWork(f.task.id,f.id,'LOCAL steering: stay on this intent');return readExisting();},
    context=>{const messages=JSON.stringify(context.messages);received=messages.includes('LOCAL steering: stay on this intent');return fact();},
    async()=>{await f.e.steerWork(f.task.id,f.id,'LOCAL final steering');return completion(f);},fauxAssistantMessage('saved'),
  ]);
  await f.e.run(f.task.id);await until(async()=>(await f.s.getNode(f.id))?.state==='done');
  expect(received).toBe(true);
  expect((await db.query("SELECT 1 FROM activity WHERE exploration_id=$1 AND node_id=$2 AND kind='tool_result' AND is_error",[f.task.exploration_id,f.id])).rowCount).toBe(0);
  await until(async()=>!!(await f.s.getNode(f.id))?.payload.execution_stop);expect((await f.s.getNode(f.id))?.payload.execution_result).toBeUndefined();await f.e.stop(f.task.id);
});

it('explicitly resumes a legacy partial intent without accepting its old result again',async()=>{
  const f=await fixture();
  await db.query("UPDATE exploration_nodes SET state='paused',payload=payload||jsonb_build_object('execution_result',$2::jsonb) WHERE id=$1",[f.id,JSON.stringify({outcome:'partial',summary:'LOCAL partial',criteria:[],remaining:'verify remaining local criterion'})]);
  f.faux.setResponses([context=>{expect(JSON.stringify(context.messages)).toContain('verify remaining local criterion');return fact();},()=>completion(f)]);
  await f.e.admitTask(f.task.id);await f.e.controlIntent(f.task.id,f.id,'resume');await until(async()=>(await f.s.getNode(f.id))?.state==='done');
  const node=(await f.s.getNode(f.id))!;expect(node.payload.previous_result).toMatchObject({outcome:'partial'});expect(node.payload.execution_result).toBeUndefined();
  expect(await f.s.listByKind('intent')).toHaveLength(1);expect(f.faux.state.callCount).toBe(2);await f.e.stop(f.task.id);
});

it('budget closing refuses further exploration while allowing facts and a summary in the same bounded turn',async()=>{
  const f=await fixture(1),sentinel=path.join(dir,'must-not-execute');
  f.faux.setResponses([
    readExisting(),
    fauxAssistantMessage([fauxToolCall('bash',{command:`touch ${sentinel}`}),fauxToolCall('record_fact',{summary:'LOCAL close observation',evidence:'LOCAL existing evidence',confidence:'high'})]),
    ()=>completion(f),
  ]);
  await f.e.run(f.task.id);await until(async()=>(await f.s.getNode(f.id))?.state==='exhausted');
  expect(existsSync(sentinel)).toBe(false);expect(f.faux.state.callCount).toBe(3);
  await until(async()=>!!(await f.s.getNode(f.id))?.payload.execution_stop);expect((await f.s.getNode(f.id))?.payload.execution_stop).toMatchObject({reason:'turn_limit',accepted_result:false});
  await f.e.stop(f.task.id);
});

it('budget exhaustion preserves a truthful recovery receipt and never invents an accepted result or finding',async()=>{
  const f=await fixture(1);f.faux.setResponses([readExisting(),fact(),readExisting()]);
  await f.e.run(f.task.id);await until(async()=>(await f.s.getNode(f.id))?.state==='exhausted');
  const node=(await f.s.getNode(f.id))!;
  expect(node.payload.execution_result).toBeUndefined();expect(node.payload.execution_stop).toMatchObject({reason:'turn_limit',accepted_result:false,recovery:expect.stringContaining('不重复已完成操作'),fact_refs:[{node_id:expect.any(Number),version:expect.any(Number)}]});
  expect(await f.s.listByKind('finding')).toHaveLength(0);
  const pending=await pendingPlannerContext(db,f.task.id,f.task.exploration_id);
  expect(pending.changes.find(n=>n.ref===`node:${f.id}`)?.execution_stop?.reason).toBe('turn_limit');
  const resumed=await workerLaunchContext(runContext(db,f.task.id,f.task.exploration_id,'worker'),f.id);
  expect(resumed.execution_stop?.recovery).toContain('不重复已完成操作');expect(resumed.own_findings.items).toHaveLength(1);
  await f.e.stop(f.task.id);
});

it('Worker sees the early budget notice, recovers from a stale bash call and publishes partial observations before exit',async()=>{
  const f=await fixture(4),sentinel=path.join(dir,'stale-bash-must-not-execute');
  f.faux.setResponses([
    readExisting(),fauxAssistantMessage([fauxToolCall('bash',{command:'printf "LOCAL existing observation"'})]),
    context=>{const messages=JSON.stringify(context.messages);expect(messages).toContain('预算将尽，停止新探测');expect(messages).toContain('剩余最多 4 次');return fauxAssistantMessage([fauxToolCall('bash',{command:`touch ${sentinel}`})]);},
    context=>{expect(JSON.stringify(context.messages)).toContain('不要重试或排查工具环境');return fact();},
    async()=>{
      expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).toHaveLength(1);
      return fauxAssistantMessage('LOCAL budget partial; unverified condition remains.');
    },
  ]);
  await f.e.run(f.task.id);await until(async()=>!!(await f.s.getNode(f.id))?.payload.execution_stop);
  expect(existsSync(sentinel)).toBe(false);expect(f.faux.state.callCount).toBe(5);
  const n=(await f.s.getNode(f.id))!;expect(n.payload.execution_result).toBeUndefined();expect(n.state).toBe('exhausted');expect(n.payload.execution_stop).toMatchObject({reason:'turn_limit',accepted_result:false});
  expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).toHaveLength(1);
  expect((await db.query("SELECT detail FROM activity WHERE node_id=$1 AND kind='tool_result' AND is_error",[f.id])).rows.some(r=>String(r.detail).includes('不要重试或排查工具环境'))).toBe(true);
  await f.e.stop(f.task.id);
});

it('more than six operations never block further operations or existing evidence reads',async()=>{
  const f=await fixture(8),evidence=path.join(dir,'local-evidence.txt');writeFileSync(evidence,'LOCAL saved proof');
  f.faux.setResponses([
    fauxAssistantMessage(Array.from({length:6},()=>fauxToolCall('bash',{command:'printf "LOCAL observation"'}))),
    fauxAssistantMessage([fauxToolCall('bash',{command:'printf seventh-operation'}),fauxToolCall('read',{path:evidence})]),
    context=>{const message=context.messages.filter(m=>m.role==='toolResult').at(-1);expect(JSON.stringify(message)).toContain('LOCAL saved proof');return fact();},
    ()=>completion(f),
  ]);
  await f.e.run(f.task.id);await until(async()=>!!(await f.s.getNode(f.id))?.payload.execution_stop);
  expect((await f.s.getNode(f.id))?.state).toBe('done');expect(f.faux.state.callCount).toBe(4);
  expect((await db.query("SELECT 1 FROM activity WHERE node_id=$1 AND kind='tool_result' AND is_error",[f.id])).rowCount).toBe(0);
  await f.e.stop(f.task.id);
});

it('closing without verified observations saves an exhaustion receipt without inventing facts',async()=>{
  const f=await fixture(1);
  f.faux.setResponses([readExisting(),fauxAssistantMessage('LOCAL no verified evidence; condition could not be verified within budget')]);
  await f.e.run(f.task.id);await until(async()=>!!(await f.s.getNode(f.id))?.payload.execution_stop);
  const n=(await f.s.getNode(f.id))!;expect(n.payload.execution_stop).toMatchObject({reason:'turn_limit',accepted_result:false,fact_refs:[]});
  expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).toHaveLength(0);expect(f.faux.state.callCount).toBe(2);
  await f.e.stop(f.task.id);
});

it('honors configured zero as unlimited and completes beyond the old 30+2 implicit cap',async()=>{
  const f=await fixture(0);
  f.faux.setResponses([...Array.from({length:34},()=>readExisting()),context=>{expect(JSON.stringify(context.messages)).toContain('不限模型请求轮数');expect(JSON.stringify(context.messages)).not.toContain('server_budget');return fact();},()=>completion(f)]);
  await f.e.run(f.task.id);await until(async()=>!!(await f.s.getNode(f.id))?.payload.execution_stop);
  const n=(await f.s.getNode(f.id))!;expect(n.state).toBe('done');expect(n.payload.execution_stop).toMatchObject({reason:'completed',accepted_result:false});expect(f.faux.state.callCount).toBe(36);
  const effective=(await db.query("SELECT effective FROM runtime_role_configs WHERE task_id=$1 AND role='worker'",[f.task.id])).rows[0]!.effective;
  expect(effective.max_turns).toBe(0);await f.e.stop(f.task.id);
});

it('connection errors preserve facts, progress, token usage and the original Main feedback subscription',async()=>{
  const f=await fixture();
  await db.query('INSERT INTO worker_feedback(exploration_id,task_id,intent_id,main_seg,after_activity) VALUES($1,$2,$3,7,0)',[f.task.exploration_id,f.task.id,f.id]);
  f.faux.setResponses([readExisting(),fact(),fauxAssistantMessage('',{stopReason:'error',errorMessage:'Connection error.'})]);
  await f.e.run(f.task.id);await until(async()=>(await f.s.getNode(f.id))?.state==='blocked');
  const node=(await f.s.getNode(f.id))!;expect(node.payload.execution_result).toBeUndefined();
  expect(node.payload.execution_stop).toMatchObject({reason:'model_connection_error',accepted_result:false});
  const result=(await db.query("SELECT input_tokens,detail,metadata FROM activity WHERE node_id=$1 AND kind='result' ORDER BY id DESC LIMIT 1",[f.id])).rows[0];
  expect(result.detail).toContain('已保存事实：node:');expect(Number(result.input_tokens)).toBeGreaterThan(0);
  const feedback=await db.query("SELECT detail,main_seg FROM activity WHERE exploration_id=$1 AND metadata ? 'worker_feedback'",[f.task.exploration_id]);
  expect(feedback.rows).toHaveLength(1);expect(feedback.rows[0].main_seg).toBe(7);expect(feedback.rows[0].detail).toContain('模型连接失败');await f.e.stop(f.task.id);
});

it.each([
  ['kill','planner_terminated'],['task-timeout','task_timeout'],['task-completed','task_completed'],
  ['shutdown','service_shutdown'],['pause','task_paused'],
] as const)('records %s independently of generic stopped and retains written facts',async(cause,reason)=>{
  const f=await fixture();let waiting=false;
  f.faux.setResponses([readExisting(),fact(),async(_ctx,options)=>{
    waiting=true;await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener('abort',()=>resolve(),{once:true});});
    return fauxAssistantMessage('',{stopReason:'aborted'});
  }]);
  await f.e.run(f.task.id);await until(async()=>waiting);
  if(cause==='kill')await f.e.killWork(f.task.id,f.id,'LOCAL duplicate direction','planner');
  else if(cause==='pause'){await db.tasks().applyTaskPause(f.task.id);const pause=await f.e.pause(f.task.id);await until(async()=>(await db.query('SELECT status FROM runtime_task_commands WHERE id=$1',[pause.command_id])).rows[0]?.status==='acknowledged');}
  else await f.e.stop(f.task.id,cause as AbortCause);
  const node=(await f.s.getNode(f.id))!;
  expect(node.payload.execution_stop).toMatchObject({reason,accepted_result:false});
  expect(node.payload.execution_result).toBeUndefined();expect((node.payload.execution_stop as any).fact_refs).toHaveLength(1);
  if(cause==='kill')expect(JSON.stringify(node.payload.execution_stop)).toContain('LOCAL duplicate direction');
  if(cause==='pause')expect(node.state).toBe('open');await f.e.stop(f.task.id);
});

it('a fenced executor records lease loss without overwriting graph state owned by the next executor',async()=>{
  const f=await fixture();let waiting=false;
  f.faux.setResponses([fact(),async(_ctx,options)=>{waiting=true;await new Promise<void>(resolve=>options?.signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
  await f.e.run(f.task.id);await until(async()=>waiting);
  await db.query("UPDATE engine_task_leases SET expires_at=now()-interval '1 second' WHERE task_id=$1",[f.task.id]);
  const remote=new Coordinator(db,1),lease=await remote.acquire(f.task.id);expect(lease).toBeTruthy();
  await f.e.stop(f.task.id,'lease-lost');
  expect((await f.s.getNode(f.id))?.state).toBe('running');
  expect((await db.query("SELECT 1 FROM activity WHERE node_id=$1 AND metadata->>'stop_reason'='lease_lost'",[f.id])).rowCount).toBe(1);
  await db.transaction(async tx=>{await remote.assert(f.task.id,lease!,tx);await tx.exploration(f.task.exploration_id).resetRunningIntents();});
  expect((await f.s.getNode(f.id))?.payload.execution_stop).toMatchObject({reason:'executor_recovered'});
  expect(((await f.s.getNode(f.id))?.payload.execution_stop as any).recovery).toContain('先核对已保存事实');
  expect(((await f.s.getNode(f.id))?.payload.execution_stop as any).recovery).toContain('不得重复已成功的操作');
  expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).toHaveLength(1);await remote.release(f.task.id,lease!);
});

it('Planner reads changed facts, dispatches a dependent second intent, and naturally completes the task',async()=>{
  const task=await db.tasks().createTaskWithOptions('LOCAL two-step command loop','',{executionMode:'managed'}),s=db.exploration(task.exploration_id);
  const goal=await s.addGoal({text:'LOCAL second observation verified'},'user');
  const w=await source('loop-worker'),p=await source('loop-planner');let contextRead=false;
  const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:30},async(_id,role)=>role==='worker'?w.model:p.model,dir);engines.push(e);
  const done=async(count:number)=>until(async()=>(await s.listByKind('intent')).filter(n=>n.state==='done').length===count);
  const plan=(key:string,basis:unknown[]=[])=>fauxAssistantMessage([fauxToolCall('add_intent',{intents:[{summary:`LOCAL ${key}`,contract:{objective:`LOCAL ${key}`,acceptance:['保存 LOCAL 观察'],basis,work:{resource:'local:fixture',question_key:key,method_class:'fixture',identity:key}}}]})]);
  const decision=()=>fauxAssistantMessage('LOCAL planning complete');
  w.faux.setResponses([0,1].flatMap(()=>[fact(),fauxAssistantMessage('LOCAL observations saved.')]));
  p.faux.setResponses([
    plan('step-one'),decision(),
    async context=>{contextRead=JSON.stringify(context.messages).includes('LOCAL observation');const ref=(await s.listByKind('fact')).find(n=>n.state==='confirmed')!;return plan('step-two',[{node_id:ref.id,version:ref.content_version}]);},
    decision(),
    async()=>{const intents=await s.listByKind('intent'),last=intents.find(n=>n.payload.summary==='LOCAL step-two')!,ref=(await s.listByKind('fact')).find(n=>n.payload.from_intent===last.id)!;return fauxAssistantMessage([fauxToolCall('prove_goal',{goal_id:goal,evidence_node_id:ref.id})]);},
    decision(),fauxAssistantMessage('done'),
  ]);
  await e.run(task.id);await until(async()=>(await db.tasks().getTask(task.id))?.status==='done',15000);
  expect(contextRead).toBe(true);const intents=await s.listByKind('intent');expect(intents).toHaveLength(2);expect(intents.every(n=>n.state==='done')).toBe(true);
  expect((await db.query("SELECT 1 FROM exploration_edges WHERE exploration_id=$1 AND rel='yields'",[task.exploration_id])).rowCount).toBe(2);
  expect(w.faux.state.callCount).toBe(4);await e.stop(task.id);
});

it('graceful shutdown resumes the original PI session and intent without repeating a committed fact',async()=>{
 const f=await fixture(0);let waiting=false;
 const parent=await f.s.addNode('fact',{summary:'LOCAL prerequisite version one'},0,'confirmed','test',[]);
 await db.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('contract',$2::jsonb) WHERE id=$1",[f.id,JSON.stringify({objective:'LOCAL continuation',acceptance:['LOCAL observed'],basis:[{node_id:parent,version:0}]})]);
 f.faux.setResponses([fact(),async(_ctx,options)=>{
  waiting=true;await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener('abort',()=>resolve(),{once:true});});
  return fauxAssistantMessage('',{stopReason:'aborted'});
 }]);
 await f.e.run(f.task.id);await until(async()=>waiting);
 await db.query("UPDATE exploration_nodes SET payload=payload||'{\"detail\":\"Updated observation while Worker was running\"}'::jsonb,content_version=content_version+1 WHERE id=$1",[parent]);
 const file=path.join(dir,'sessions',`exp${f.task.exploration_id}-worker-i${f.id}.jsonl`);
 const {readFileSync}=await import('node:fs');const first=readFileSync(file,'utf8').split('\n')[0];
 await f.e.shutdown();
 const interrupted=(await f.s.getNode(f.id))!;
 expect(interrupted.state).toBe('open');expect((await db.query('SELECT completed_at FROM exploration_nodes WHERE id=$1',[f.id])).rows[0]!.completed_at).toBeNull();
 expect(interrupted.payload).toMatchObject({resume_requested:true,execution_stop:{reason:'service_shutdown'}});
 expect((await db.query('SELECT 1 FROM engine_worker_slots WHERE task_id=$1',[f.task.id])).rowCount).toBe(0);
 let recalled=false;
 f.faux.setResponses([ctx=>{recalled=JSON.stringify(ctx.messages).includes('LOCAL observation');return fauxAssistantMessage('LOCAL saved fact recalled; original intent complete.');}]);
 const resumed=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5},async()=>f.model,dir);engines.push(resumed);
 await resumed.run(f.task.id);await until(async()=>(await f.s.getNode(f.id))?.state==='done');
 expect(recalled).toBe(true);expect(readFileSync(file,'utf8').split('\n')[0]).toBe(first);
 expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===f.id)).toHaveLength(1);
 expect(await f.s.listByKind('intent')).toHaveLength(1);await resumed.stop(f.task.id);
});
