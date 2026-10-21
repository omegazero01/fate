import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {ModelRuntime,type SessionEntry} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {openDatabase,type Database} from '../db/index.js';
import {runContext} from '../tools/context.js';
import {contextGetTool,contextSearchTool,searchContext} from '../tools/context-read.js';
import {contextNeeds,contextNeedBoundary,contextContinuations,CONTEXT_RETENTION_RULES} from './context-needs.js';
import {WorkerOperationJournal} from '../db/operation-journal.js';
import {AgentRunner} from '../pi/runner.js';

const name=`fate_context_needs_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-context-needs-'));let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(count=1){
  const task=await db.tasks().createTaskWithOptions('LOCAL needs','LOCAL',{executionMode:'manual'}),s=db.exploration(task.exploration_id);
  const ids:number[]=[];for(let i=0;i<count;i++)ids.push(await s.addNode('fact',{summary:`basis ${i}`,evidence:'原始证据😀'.repeat(2000)},0,'confirmed','test',[]));
  const id=await s.addIntent({summary:'LOCAL dependent',dispatch_requested:true,contract:{objective:'LOCAL',acceptance:['LOCAL'],basis:ids.map(node_id=>({node_id,version:0}))}},5,[],'user');
  await s.claimNextWorker('work#1');
  let entries:readonly SessionEntry[]=[];
  const ctx=runContext(db,task.id,task.exploration_id,'worker',{intentID:id,workerName:'work#1',sessionEntries:()=>entries});
  return {task,s,id,ids,ctx,setEntries:(e:readonly SessionEntry[])=>{entries=e;}};
}
async function read(x:Awaited<ReturnType<typeof fixture>>,ref:string,offset=0,field='/payload/evidence'){
  const out=await contextGetTool(x.ctx).execute('read',{items:[{ref,field,offset}],max_chars:500},undefined,undefined,{} as never);
  return {type:'message',id:'receipt',parentId:null,timestamp:new Date().toISOString(),message:{role:'toolResult',toolCallId:'read',toolName:'context_get',content:out.content,isError:false,timestamp:Date.now()}} as SessionEntry;
}
it('pins dependencies as references without injecting full evidence or pretending a summary was read',async()=>{
  const x=await fixture();const m=await contextNeeds(x.ctx);
  expect(m.items).toContainEqual(expect.objectContaining({ref:`node:${x.ids[0]}`,reason:'dependency_detail_unread'}));
  expect(JSON.stringify(m)).not.toContain('原始证据');
  expect(Buffer.byteLength(await contextNeedBoundary(x.ctx))).toBeLessThan(6000);
});
it('derives missing ranges from actual receipts and returns directly reusable continuation arguments',async()=>{
  const x=await fixture(),entry=await read(x,`node:${x.ids[0]}`,700);x.setEntries([entry]);
  const m=await contextNeeds(x.ctx),gap=m.items.find(i=>i.reason==='unread_range')!;
  expect(gap.read).toMatchObject({tool:'context_get',args:{items:[{ref:`node:${x.ids[0]}`,offset:0,field:'/payload/evidence'}]}});
  const out=await contextGetTool(x.ctx).execute('continue',gap.read.args,undefined,undefined,{} as never);
  expect(out.isError).not.toBe(true);expect(JSON.parse((out.content[0] as {text:string}).text).items[0].content).toContain('原始证据');
});
it('prioritizes changed or deleted dependencies and invalidates old read coverage',async()=>{
  const x=await fixture(2);x.setEntries([await read(x,`node:${x.ids[0]}`)]);
  await db.query("UPDATE exploration_nodes SET content_version=content_version+1 WHERE id=$1",[x.ids[0]]);
  await db.query("DELETE FROM exploration_nodes WHERE id=$1",[x.ids[1]]);
  const m=await contextNeeds(x.ctx);
  expect(m.items[0]).toMatchObject({reason:'dependency_unavailable'});
  expect(m.items).toContainEqual(expect.objectContaining({ref:`node:${x.ids[0]}`,reason:'dependency_changed',version:1,expected_version:0}));
  expect(m.items.some(n=>n.reason==='unread_range')).toBe(false);
});
it('keeps every manifest entry reachable by pagination and rejects outdated cursors',async()=>{
  const x=await fixture(20),all=await contextNeeds(x.ctx,{limit:20});const keys=new Set<string>();
  let cursor:string|undefined;
  do{const p=await searchContext(x.ctx,{source:'needs',limit:3,cursor});for(const i of p.items)keys.add(JSON.stringify(i));cursor=p.next_cursor??undefined;}while(cursor);
  expect(keys.size).toBe(all.total);
  const first=await contextNeeds(x.ctx,{limit:2});await db.query("UPDATE exploration_nodes SET content_version=content_version+1 WHERE id=$1",[x.ids[0]]);
  await expect(contextNeeds(x.ctx,{limit:2,cursor:first.next_cursor!})).rejects.toThrow('状态已变化');
});
it('retains unconsumed search and relation cursors without requiring full graph retrieval',()=>{
  const entries:SessionEntry[]=[];let n=0;
  const add=(name:string,args:unknown,result:unknown,error=false)=>{
    const id=String(++n);entries.push({type:'message',id:'call'+id,parentId:null,timestamp:'LOCAL',message:fauxAssistantMessage([{type:'toolCall',id,name,arguments:args} as never])} as SessionEntry);
    entries.push({type:'message',id:'result'+id,parentId:null,timestamp:'LOCAL',message:{role:'toolResult',toolName:name,toolCallId:id,isError:error,timestamp:Date.now(),content:[{type:'text',text:JSON.stringify(result)}]}} as SessionEntry);
  };
  add('context_search',{asset_id:7},{items:[],has_more:true,next_cursor:'next'});
  add('context_search',{asset_id:7,cursor:'next'},{error:'temporary'},true);
  expect(contextContinuations(entries)[0]!.read.args).toEqual({asset_id:7,cursor:'next'});
  add('context_get',{items:[{ref:'node:10',view:'members'}]},{items:[{ref:'node:10',view:'members',version:1,next_offset:null,next_cursor:'page2',next_item:{ref:'node:10',view:'members',version:1,cursor:'page2'}}]});
  expect(contextContinuations(entries)).toHaveLength(2);
  add('context_search',{asset_id:7,cursor:'next'},{items:[],has_more:false,next_cursor:null});
  expect(contextContinuations(entries)).toHaveLength(1);
  add('context_get',{items:[{ref:'node:10',view:'members',cursor:'page2'}]},{items:[{ref:'node:10',view:'members',version:1,next_offset:null,next_cursor:null}]});
  expect(contextContinuations(entries)).toEqual([]);
});
it('makes unknown effects the first recovery need without exposing another task or Worker',async()=>{
  const x=await fixture(),journal=new WorkerOperationJournal(x.ctx);await journal.start();await journal.begin('bash','a',{command:'LOCAL'});
  await new WorkerOperationJournal(x.ctx).start();
  expect((await contextNeeds(x.ctx)).items[0]).toMatchObject({reason:'operation_uncertain',priority:110});
  const other=await fixture();
  await expect(contextNeeds(other.ctx,{intent_id:x.id})).rejects.toThrow('仅限');
  expect(JSON.stringify(await contextNeeds(other.ctx))).not.toContain('operation:');
  await expect(searchContext(x.ctx,{source:'needs',task_id:other.task.id})).rejects.toThrow('当前任务');
});
it('keeps cold and source-task evidence reachable; query windows do not claim whole-graph completeness',async()=>{
  const x=await fixture(),source=await fixture();
  await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[x.task.id,source.task.id]);
  const old=await x.s.getNode(x.id);const contract=old!.payload.contract as any;
  contract.basis.push({node_id:source.ids[0],version:0});
  await db.query('UPDATE exploration_nodes SET payload=payload||jsonb_build_object(\'contract\',$2::jsonb) WHERE id=$1',[x.id,JSON.stringify(contract)]);
  const m=await contextNeeds(x.ctx);
  expect(m.items).toContainEqual(expect.objectContaining({ref:`node:${source.ids[0]}`,reason:'dependency_detail_unread'}));
  expect(m.completeness).toContain('不证明');
});
it('rebuilds missing reads after native compaction and restart without relying on summary accuracy',async()=>{
  const x=await fixture(),f=fauxProvider(),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(f.provider);
  const file=path.join(dir,`session-${x.id}.jsonl`);
  const opts={cwd:dir,agentDir:path.join(dir,'agent'),resumeSessionPath:file,systemPrompt:'LOCAL '+CONTEXT_RETENTION_RULES,
    modelRuntime:runtime,model:f.getModel() as never,toolAllowlist:['context_get','context_search'],customTools:[contextGetTool(x.ctx),contextSearchTool(x.ctx)],
    platform:{role:'worker',taskID:x.task.id,policy:{version:'domain-v1' as const,compaction:'domain' as const,mcpLoading:'direct' as const}},
    compactionSettings:{keepRecentTokens:32,reserveTokens:1024},loadDomainState:async()=>({needs:await contextNeeds(x.ctx)}),
    boundaryContext:()=>contextNeedBoundary(x.ctx)};
  let runner=await AgentRunner.create(opts);x.ctx.sessionEntries=()=>runner.sessionEntries;
  f.setResponses([fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:`node:${x.ids[0]}`,field:'/payload/evidence',offset:700}],max_chars:500})]),fauxAssistantMessage('LOCAL '+'history '.repeat(3000))]);
  try{await runner.prompt('read local fixture');f.setResponses([fauxAssistantMessage('Summary deliberately omits read offsets.')]);await runner.compact();}
  finally{await runner.dispose();}
  runner=await AgentRunner.create(opts);x.ctx.sessionEntries=()=>runner.sessionEntries;
  try{
    f.setResponses([context=>{expect(JSON.stringify(context.messages)).toContain('unread_range');expect(JSON.stringify(context.messages)).toContain('dependency_detail_unread');return fauxAssistantMessage('Read the missing range before using it.');}]);
    await runner.prompt('resume');expect((await contextNeeds(x.ctx)).items.some(i=>i.reason==='unread_range')).toBe(true);
  }finally{await runner.dispose();}
});
