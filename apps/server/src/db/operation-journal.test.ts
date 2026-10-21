import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime,defineTool} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from './index.js';
import {WorkerOperationJournal,readOperations,resolveOperation,operationFingerprint} from './operation-journal.js';
import {runContext} from '../tools/context.js';
import {journalTools} from '../pi/operation-tools.js';
import {AgentRunner} from '../pi/runner.js';
import {contextGetTool,searchContext} from '../tools/context-read.js';
import {buildApp} from '../http/app.js';
import {signJWT} from '../http/auth.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';
import {Coordinator} from '../engine/coordinator.js';

const name=`fate_operations_${process.pid}`,dsn=`postgres://series:series@127.0.0.1:5433/${name}`;
const dir=mkdtempSync(path.join(tmpdir(),'fate-operation-'));let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=dsn;db=await openDatabase();});
afterAll(async()=>{await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(){
  const task=await db.tasks().createTaskWithOptions('LOCAL operation receipt','',{executionMode:'manual'});
  const store=db.exploration(task.exploration_id),id=await store.addIntent({summary:'LOCAL receipt',dispatch_requested:true},5,[],'user');
  await store.claimNextWorker('work#1');
  const ctx=runContext(db,task.id,task.exploration_id,'worker',{intentID:id,workerName:'work#1'});
  const journal=new WorkerOperationJournal(ctx);await journal.start();
  return {task,store,id,ctx,journal};
}
const output={content:[{type:'text' as const,text:'LOCAL successful effect'}]};

it('normalizes object property order without collapsing arrays, values or case',()=>{
  expect(operationFingerprint('x',{a:1,b:2})).toBe(operationFingerprint('x',{b:2,a:1}));
  expect(operationFingerprint('x',{a:['a','b']})).not.toBe(operationFingerprint('x',{a:['b','a']}));
  expect(operationFingerprint('x',{a:'A'})).not.toBe(operationFingerprint('x',{a:'a'}));
});
it('reuses returned results across executions, but allows live repeated observations',async()=>{
  const x=await fixture(),a=await x.journal.begin('http_request','a',{url:'LOCAL'});await x.journal.finish(a.id,output,false);
  expect((await x.journal.begin('http_request','a',{url:'LOCAL'})).replay).toEqual(output);
  const live=await x.journal.begin('http_request','b',{url:'LOCAL'});expect(live.replay).toBeUndefined();await x.journal.finish(live.id,output,false);
  const next=new WorkerOperationJournal(x.ctx);await next.start();
  expect((await next.begin('http_request','c',{url:'LOCAL'})).replay).toEqual(output);
  await expect(next.begin('http_request','c',{url:'OTHER'})).rejects.toThrow('参数已变化');
  await expect(x.journal.begin('http_request','old',{url:'OTHER'})).rejects.toThrow('代次');
});
it('blocks all new external operations after an unconfirmed effect, while graph reads remain available',async()=>{
  const x=await fixture();await x.journal.begin('bash','a',{command:'LOCAL effect'});
  const next=new WorkerOperationJournal(x.ctx);await next.start();
  await expect(next.begin('bash','b',{command:'changed spelling'})).rejects.toThrow('结果未知');
  const page=await searchContext(x.ctx,{source:'operations'});
  expect(page.items[0]).toMatchObject({status:'uncertain'});
  const out=await contextGetTool(x.ctx).execute('read',{items:[{ref:page.items[0]!.ref}]},undefined,undefined,{} as never);
  expect(JSON.stringify(out)).toContain('uncertain');
  expect((await readOperations({...x.ctx,role:'planner'})).items).toHaveLength(1);
  const other=await fixture();
  expect((await readOperations(other.ctx,{id:Number(page.items[0]!.id)})).items).toHaveLength(0);
  await expect(readOperations({...x.ctx,intentID:undefined})).rejects.toThrow('缺少');
});
it('never overwrites a successor or fabricates a successful receipt after loss of ownership',async()=>{
  const x=await fixture(),started=await x.journal.begin('bash','a',{command:'LOCAL'});
  const next=new WorkerOperationJournal(x.ctx);await next.start();
  await expect(x.journal.finish(started.id,output,false)).rejects.toThrow('代次');
  expect((await readOperations(x.ctx)).items[0]!.status).toBe('uncertain');
  await x.store.setIntentState(x.id,'paused');
  await expect(next.begin('bash','x',{})).rejects.toThrow('状态');
});
it('keeps unknown operations unresolved until a paused quiescent operator decision, recording the retry chain',async()=>{
  const x=await fixture(),a=await x.journal.begin('bash','a',{command:'LOCAL'});
  await expect(resolveOperation(db,x.task.id,a.id,'retry_allowed','verified no effect','operator')).rejects.toThrow('暂停');
  await db.query('UPDATE tasks SET paused=true WHERE id=$1',[x.task.id]);
  const coordinator=new Coordinator(db,1),lease=await coordinator.acquire(x.task.id);
  await expect(resolveOperation(db,x.task.id,a.id,'retry_allowed','verified no effect','operator')).rejects.toThrow('退出');
  await coordinator.release(x.task.id,lease!);
  const other=await fixture();
  await db.query('UPDATE tasks SET paused=true WHERE id=$1',[other.task.id]);
  await expect(resolveOperation(db,other.task.id,a.id,'confirmed','wrong task','operator')).rejects.toThrow('没有');
  await resolveOperation(db,x.task.id,a.id,'retry_allowed','verified no effect','operator');
  expect((await resolveOperation(db,x.task.id,a.id,'retry_allowed','same','operator')).changed).toBe(false);
  await db.query('UPDATE tasks SET paused=false WHERE id=$1',[x.task.id]);
  const next=new WorkerOperationJournal(x.ctx);await next.start();
  const retry=await next.begin('bash','a',{command:'LOCAL'});await next.finish(retry.id,output,false);
  expect((await db.query('SELECT previous_id FROM worker_operations WHERE id=$1',[retry.id])).rows[0]?.previous_id).toBe(String(a.id));
  expect((await db.query('SELECT 1 FROM worker_operation_resolutions WHERE operation_id=$1',[a.id])).rowCount).toBe(1);
});
it('wraps native pi and dynamically registered tools; recovery does not execute the operation again',async()=>{
  const x=await fixture(),f=fauxProvider(),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(f.provider);
  let effects=0;
  const tool=defineTool({name:'mcp__local__effect',label:'local',description:'LOCAL synthetic effect',parameters:{type:'object',properties:{},required:[]} as never,
    execute:async()=>{effects++;return output;}});
  const file=path.join(dir,`native-${x.id}.jsonl`);
  for(let attempt=0;attempt<2;attempt++){
    const journal=attempt?new WorkerOperationJournal(x.ctx):x.journal;if(attempt)await journal.start();
    f.setResponses([fauxAssistantMessage([fauxToolCall(tool.name,{})]),context=>{
      expect(JSON.stringify(context.messages)).toContain('LOCAL successful effect');return fauxAssistantMessage('done');
    }]);
    const runner=await AgentRunner.create({cwd:dir,agentDir:path.join(dir,'agent'),resumeSessionPath:file,systemPrompt:'LOCAL synthetic worker',modelRuntime:runtime,model:f.getModel() as never,
      toolAllowlist:[tool.name],extensionFactories:[api=>{api.registerTool(tool);}],
      wrapExecutionTool:journalTools(journal,x.ctx,new Set()),guard:()=>undefined});
    try{await runner.prompt('run LOCAL effect');}finally{await runner.dispose();}
  }
  expect(effects).toBe(1);expect((await readOperations(x.ctx)).items.map(r=>r.replayed)).toEqual([false,true]);
});
it('preserves tool disable checks before replaying an already returned result',async()=>{
  const x=await fixture(),f=fauxProvider(),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(f.provider);
  const a=await x.journal.begin('bash','old',{command:'LOCAL'});await x.journal.finish(a.id,output,false);
  const next=new WorkerOperationJournal(x.ctx);await next.start();let effects=0,denied=false;
  f.setResponses([fauxAssistantMessage([fauxToolCall('bash',{command:'LOCAL'})]),fauxAssistantMessage('blocked')]);
  const runner=await AgentRunner.create({cwd:dir,agentDir:path.join(dir,'agent'),inMemory:true,systemPrompt:'LOCAL',modelRuntime:runtime,model:f.getModel() as never,
    toolAllowlist:['bash'],customTools:[defineTool({name:'bash',label:'bash',description:'LOCAL',parameters:{type:'object',properties:{command:{type:'string'}}} as never,execute:async()=>{effects++;return output;}})],
    wrapExecutionTool:journalTools(next,x.ctx,new Set(['bash'])),guard:()=>({block:true,reason:'disabled'}),
    onActivity:a=>{if(a.kind==='tool_end')denied=a.isError&&!!a.text?.includes('disabled');}});
  try{await runner.prompt('LOCAL');}finally{await runner.dispose();}
  expect(effects).toBe(0);expect(denied).toBe(true);
});
it('ends at the native batch boundary on an unknown effect without asking the model to retry indefinitely',async()=>{
  const x=await fixture(),f=fauxProvider(),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(f.provider);
  let effects=0;f.setResponses([fauxAssistantMessage([fauxToolCall('bash',{command:'LOCAL'})]),()=>{throw new Error('unexpected extra model request');}]);
  const runner=await AgentRunner.create({cwd:dir,agentDir:path.join(dir,'agent'),inMemory:true,systemPrompt:'LOCAL',modelRuntime:runtime,model:f.getModel() as never,
    toolAllowlist:['bash'],customTools:[defineTool({name:'bash',label:'bash',description:'LOCAL',parameters:{type:'object',properties:{command:{type:'string'}}} as never,
      execute:async()=>{effects++;throw new Error('LOCAL interrupted after effect');}})],
    wrapExecutionTool:journalTools(x.journal,x.ctx,new Set(['bash'])),stopOnRecoveryBlock:()=>x.journal.recoveryBlocked});
  try{expect((await runner.prompt('LOCAL')).aborted).toBe(true);}finally{await runner.dispose();}
  expect(effects).toBe(1);expect(f.state.callCount).toBe(1);expect((await readOperations(x.ctx)).items[0]!.status).toBe('uncertain');
});
it('treats an unfinished terminal as unknown; confirmed terminal closure never revives an old handle',async()=>{
  const x=await fixture(),a=await x.journal.begin('shell_open','old',{command:'LOCAL'});
  await x.journal.finish(a.id,{content:[{type:'text',text:JSON.stringify({session_id:'expired',running:true})}]},false);
  const next=new WorkerOperationJournal(x.ctx);await next.start();let effects=0;
  const tool=journalTools(next,x.ctx,new Set(['shell_open']))(defineTool({name:'shell_open',label:'shell',description:'LOCAL',parameters:{type:'object'} as never,
    execute:async()=>{effects++;return output;}}));
  await expect(tool.execute('new',{command:'LOCAL'},undefined,undefined,{} as never)).rejects.toThrow('未知');
  expect(effects).toBe(0);
  const y=await fixture(),start=await y.journal.begin('shell_open','old',{command:'LOCAL'});
  await y.journal.finish(start.id,{content:[{type:'text',text:JSON.stringify({session_id:'finished',running:true})}]},false);
  await y.journal.observeTerminal({content:[{type:'text',text:JSON.stringify({session_id:'finished',running:false})}]});
  const resumed=new WorkerOperationJournal(y.ctx);await resumed.start();
  const wrapped=journalTools(resumed,y.ctx,new Set(['shell_open']))(defineTool({name:'shell_open',label:'shell',description:'LOCAL',parameters:{type:'object'} as never,
    execute:async()=>{effects++;return output;}}));
  const r=await wrapped.execute('new',{command:'LOCAL'},undefined,undefined,{} as never);
  expect(effects).toBe(0);expect(r.isError).toBe(true);expect(JSON.stringify(r)).toContain('原终端句柄');expect(JSON.stringify(r)).not.toContain('"running":true');
});
it('exposes authenticated read/reconcile routes without starting or resuming a task',async()=>{
  const x=await fixture(),a=await x.journal.begin('bash','a',{command:'LOCAL'}),key='LOCAL-operation-test';
  const engine=new Engine(db,defaultEngineConfig(),async()=>null,dir);
  const app=buildApp({db,engine,version:'LOCAL',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});
  const headers={'x-series-token':signJWT(key)},url=`/api/tasks/${x.task.id}/operations`;
  try{
    expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({url,headers})).json().items[0].id).toBe(a.id);
    expect((await app.inject({method:'POST',url:`${url}/${a.id}/resolve`,headers,payload:{outcome:'confirmed',reason:'LOCAL checked'}})).statusCode).toBe(409);
    await db.query('UPDATE tasks SET paused=true WHERE id=$1',[x.task.id]);
    expect((await app.inject({method:'POST',url:`${url}/${a.id}/resolve`,headers,payload:{outcome:'confirmed',reason:'LOCAL checked'}})).json()).toMatchObject({resumed:false,status:'confirmed'});
    expect((await db.tasks().getTask(x.task.id))!.paused).toBe(true);
  }finally{await engine.shutdown();await app.close();}
});
it.each(['before_return','after_return'])('recovers a real SIGKILL at %s without replaying the effect',async mode=>{
  const x=await fixture(),file=path.join(dir,`effect-${x.id}`);
  const child=fork(path.resolve('scripts/operation-crash-host.mts'),[],{execArgv:['--import','tsx'],env:{...process.env,SERIES_PG_DSN:dsn,FATE_OPERATION_FIXTURE:JSON.stringify({task:x.task.id,exp:x.task.exploration_id,intent:x.id,file,mode})},stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr?.on('data',d=>{errors+=String(d);});
  try{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('crash fixture timeout '+errors)),15000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(new Error(errors));});});
    child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    const next=new WorkerOperationJournal(x.ctx);await next.start();
    if(mode==='before_return')await expect(next.begin('bash','resumed',{command:'LOCAL append'})).rejects.toThrow('结果未知');
    else expect((await next.begin('bash','resumed',{command:'LOCAL append'})).replay).toEqual(output);
    expect(readFileSync(file,'utf8')).toBe('once\n');
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
