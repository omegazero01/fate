import {plannerReadCoverage,plannerGrounding,projectPlannerReceipts} from './planner-grounding.js';
import {proveGoalTool} from '../tools/findings.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime,SessionManager,type SessionEntry} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {runPlannerRound,type PlannerRoundInput} from './roles.js';
import {TodoStore,runContext} from '../tools/context.js';
import {searchContext,contextGetTool} from '../tools/context-read.js';
import {plannerSessionFile,plannerDeliveries,preparePlannerDelivery,validatePlannerSession,PLANNER_COMPACTION_RULES,lockPlannerSession} from './planner-memory.js';
import {AgentRunner} from '../pi/runner.js';
import {effectiveToolDescription} from './tool-descriptions.js';
import {pendingPlannerContext} from '../db/planner-context.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';

const name=`fate_planner_memory_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-planner-memory-'));let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();await db.query("UPDATE agents SET max_turns=0,run_seconds=0 WHERE key='planner'");});
afterAll(async()=>{await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(){
  const task=await db.tasks().createTaskWithOptions('LOCAL memory','Verify LOCAL evidence',{executionMode:'managed'});
  const f=fauxProvider({provider:`planner-memory-${task.id}`}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(f.provider);
  const input:PlannerRoundInput={db,taskID:task.id,expID:task.exploration_id,goal:task.goal,model:{modelRuntime:runtime,model:f.getModel() as never},dataDir:dir,todos:new TodoStore(db),hooks:{},triggersText:'LOCAL wake',maxTurns:0,onActivity:()=>{}};
  const file=plannerSessionFile(dir,task.exploration_id),entries=()=>SessionManager.open(file).getEntries();
  const ctx=runContext(db,task.id,task.exploration_id,'planner',{plannerSession:{identity:()=>`${task.id}:${task.exploration_id}`,entries}});
  return {task,f,input,file,entries,ctx,s:db.exploration(task.exploration_id)};
}
async function call(tool:any,args:unknown){const r=await tool.execute('read-test',args,undefined,undefined,{});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}

it('continues the native session, deduplicates unchanged projections and refreshes current state',async()=>{
  const x=await fixture(),fact=await x.s.addNode('fact',{summary:'NEGATIVE-OLD: traversal returns 400',evidence:'LOCAL response'},0,'confirmed','test',[]);
  x.f.setResponses([fauxAssistantMessage('DECISION: do not repeat traversal; inspect the independent parameter.')]);
  await runPlannerRound({...x.input,contextEventIDs:[11],changes:[{ref:`node:${fact}`,version:0,summary:'NEGATIVE-OLD'}]});
  const sessionID=SessionManager.open(x.file).getSessionId();
  await db.query("UPDATE exploration_nodes SET payload=payload||'{\"summary\":\"NEGATIVE-NEW: revised evidence\"}'::jsonb WHERE id=$1",[fact]);
  x.f.setResponses([context=>{
    const text=JSON.stringify(context.messages);expect(text).toContain('模型原始总结保留于 session:');expect(readFileSync(x.file,'utf8')).toContain('DECISION: do not repeat');expect(text).toContain('NEGATIVE-NEW');expect(text).toContain('宿主当前状态');
    return fauxAssistantMessage('Read the revised evidence before planning.');
  }]);
  await runPlannerRound({...x.input,contextEventIDs:[12],changes:[{ref:`node:${fact}`,version:1,summary:'NEGATIVE-NEW'}]});
  x.f.setResponses([fauxAssistantMessage('No new direction.')]);
  await runPlannerRound(x.input);
  expect(SessionManager.open(x.file).getSessionId()).toBe(sessionID);
  const d=plannerDeliveries(x.entries()).deliveries;expect(d).toHaveLength(3);
  expect(d[2]!.input).not.toContain('NEGATIVE-NEW');expect(d[2]!.input.length).toBeLessThan(d[0]!.input.length);
  expect(x.f.state.callCount).toBe(3);
});

it('recovers completed delivery acknowledgement without an extra request and defers unseen events',async()=>{
  const x=await fixture();x.f.setResponses([fauxAssistantMessage('Completed saved batch.')]);
  await runPlannerRound({...x.input,contextEventIDs:[21],events:[{id:31,kind:'worker_settled'}]});
  const recovered=await runPlannerRound({...x.input,contextEventIDs:[21,22],events:[{id:31,kind:'worker_settled'},{id:32,kind:'control_changed'}]});
  expect(recovered).toMatchObject({deliveredContextIDs:[21],deliveredWakeupIDs:[31],moreContext:true});expect(x.f.state.callCount).toBe(1);
  expect(x.entries().filter(e=>e.type==='custom'&&e.customType==='planner_grounded_result')).toHaveLength(1);
  x.f.setResponses([fauxAssistantMessage('Processed only new delivery.')]);
  await runPlannerRound({...x.input,contextEventIDs:[22],events:[{id:32,kind:'control_changed'}]});expect(x.f.state.callCount).toBe(2);
});

it('retries interrupted batches using the original input, not a duplicated delivery',async()=>{
  const x=await fixture();x.f.setResponses([fauxAssistantMessage('',{stopReason:'error',errorMessage:'LOCAL failure'})]);
  await expect(runPlannerRound({...x.input,contextEventIDs:[41],changes:[{ref:'node:900',summary:'SAVED INPUT'}]})).rejects.toThrow();
  x.f.setResponses([context=>{expect(JSON.stringify(context.messages)).toContain('SAVED INPUT');return fauxAssistantMessage('Recovered original batch.');}]);
  const result=await runPlannerRound({...x.input,contextEventIDs:[41,42],changes:[{ref:'node:901',summary:'UNDISPATCHED INPUT'}]});
  expect(result).toMatchObject({deliveredContextIDs:[41],moreContext:true});
  expect(plannerDeliveries(x.entries()).deliveries).toHaveLength(1);
  expect(x.entries().filter(e=>e.type==='custom_message'&&e.customType==='fate_context')).toHaveLength(1);
});

it('recalls historical Unicode output with stable paging, current-task isolation and tool revocation',async()=>{
  const x=await fixture(),text='历史中文😀反证'.repeat(350);
  x.f.setResponses([fauxAssistantMessage(text)]);await runPlannerRound(x.input);
  const search=await searchContext(x.ctx,{source:'planner_session',q:'历史中文',limit:1});
  const ref=search.items[0]!.ref;expect(ref).toMatch(/^session:/);
  let output='',offset:number|null=0;
  do{const r=await call(contextGetTool(x.ctx),{items:[{ref,field:'/content',offset}],max_chars:600});expect(r.items[0].error).toBeUndefined();expect(r.items[0].segment).toMatchObject({start:offset,complete:false});output+=r.items[0].content;offset=r.items[0].next_offset;}while(offset!==null);
  expect(output).toBe(text);expect(output).not.toContain('\ufffd');
  const other=await fixture();await expect(searchContext(other.ctx,{source:'planner_session',task_id:x.task.id})).rejects.toThrow('跨任务');
  const wrong=await call(contextGetTool(other.ctx),{items:[{ref}]});expect(wrong.items[0].error).toContain('不存在');
  await expect(searchContext({...x.ctx,role:'worker'},{source:'planner_session'})).rejects.toThrow('Planner');
  await db.query("UPDATE tools SET enabled=false WHERE key='context_get'");
  try{expect((await call(contextGetTool(x.ctx),{items:[{ref}]})).items[0].error).toContain('权限');}finally{await db.query("UPDATE tools SET enabled=true WHERE key='context_get'");}
});

it('preserves originals through native compaction and can retrieve an early negative conclusion',async()=>{
  const x=await fixture();const original='EARLY_NEGATIVE node:32216 asset:10599 traversal 400; not untested.';
  x.f.setResponses([fauxAssistantMessage(original+' history '.repeat(600))]);await runPlannerRound(x.input);
  const before=readFileSync(x.file,'utf8'),oldEntry=x.entries().find(e=>e.type==='message'&&e.message.role==='assistant')!;
  const runner=await AgentRunner.create({cwd:path.join(dir,'compact'),agentDir:path.join(dir,'agent'),resumeSessionPath:x.file,...x.input.model,
    toolAllowlist:[],systemPrompt:'LOCAL planner compaction',platform:{role:'planner',taskID:x.task.id,policy:{version:'domain-v1',compaction:'native',mcpLoading:'direct'}},
    compactionSettings:{keepRecentTokens:32,reserveTokens:1024},compactionInstructions:PLANNER_COMPACTION_RULES});
  x.f.setResponses(Array.from({length:3},()=>context=>{expect(JSON.stringify(context.messages)).toContain('否定');return fauxAssistantMessage('Earlier negative node:32216 / asset:10599. Pending: inspect independent parameter.');}));
  try{await runner.compact();expect(runner.compactionDiagnostics.completed).toBe(1);}finally{await runner.dispose();}
  expect(readFileSync(x.file,'utf8').startsWith(before)).toBe(true);
  const recalled=await call(contextGetTool(x.ctx),{items:[{ref:`session:${oldEntry.id}`,field:'/content'}]});expect(recalled.items[0].content).toContain(original);
  x.f.setResponses([context=>{expect(JSON.stringify(context.messages)).toContain('Earlier negative');return fauxAssistantMessage('Continue from the retained pending direction.');}]);
  await runPlannerRound(x.input);
});

it('does not acknowledge graph changes merely because a truncated summary omitted them',()=>{
  const base={taskID:1,expID:2,overview:{recent_facts:[{id:7,version:1,summary:'negative'}]},todos:[],changes:[],events:[],contextIDs:[1],triggers:'wake'};
  const first=preparePlannerDelivery(base),next=preparePlannerDelivery({...base,previous:first,overview:{recent_facts:[]}});
  expect(next.input).not.toContain('deleted');
  const changed=preparePlannerDelivery({...base,previous:next,overview:{recent_facts:[{id:7,version:2,summary:'negative'}]}});expect(changed.input).toContain('"version":2');
});

it('delivers asset invalidations and deleted-node notices without pretending their details were read',async()=>{
  const x=await fixture(),fact=await x.s.addNode('fact',{summary:'EXISTING_NEGATIVE'},0,'confirmed','test',[]);
  await db.query('DELETE FROM exploration_nodes WHERE id=$1',[fact]);
  await db.query("INSERT INTO exploration_context_events(exploration_id,kind) VALUES($1,'assets')",[x.task.exploration_id]);
  const pending=await pendingPlannerContext(db,x.task.id,x.task.exploration_id);
  x.f.setResponses([context=>{
    const text=JSON.stringify(context.messages);expect(text).toContain('context:assets');expect(text).toContain('context:node_deleted');
    expect(text).toContain('requires_read');expect(text).not.toContain('EXISTING_NEGATIVE');
    return fauxAssistantMessage('Recheck current evidence before using old references.');
  }]);
  const result=await runPlannerRound({...x.input,contextEventIDs:pending.ids,changes:pending.changes});
  expect(result.deliveredContextIDs).toEqual(pending.ids);
});

it('preserves corrupted sessions and excludes simultaneous writers',async()=>{
  const file=path.join(dir,'broken.jsonl');writeFileSync(file,'invalid original');expect(()=>validatePlannerSession(file)).toThrow('保留原文');expect(readFileSync(file,'utf8')).toBe('invalid original');
  const x=await fixture(),release=await lockPlannerSession(db,x.task.exploration_id);
  try{await expect(runPlannerRound(x.input)).rejects.toThrow('已有运行者');expect(x.f.state.callCount).toBe(0);}finally{await release();}
});

it('aborts the session when its database writer lock is lost',async()=>{
  const x=await fixture(),release=await lockPlannerSession(db,x.task.exploration_id);
  try{
    const row=(await db.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND query LIKE 'SELECT pg_try_advisory_lock%'",[name])).rows[0];
    expect(row).toBeDefined();
    const aborted=new Promise<void>(resolve=>release.signal.addEventListener('abort',()=>resolve(),{once:true}));
    await db.query('SELECT pg_terminate_backend($1)',[row.pid]);await aborted;
    expect(release.signal.aborted).toBe(true);
  }finally{await release();}
});

it('keeps a history search snapshot stable while a later round appends entries',async()=>{
  const x=await fixture();
  x.f.setResponses([fauxAssistantMessage('PAGING unique early')]);await runPlannerRound(x.input);
  x.f.setResponses([fauxAssistantMessage('PAGING unique middle')]);await runPlannerRound(x.input);
  const first=await searchContext(x.ctx,{source:'planner_session',q:'PAGING unique',limit:1});
  x.f.setResponses([fauxAssistantMessage('PAGING unique latest')]);await runPlannerRound(x.input);
  const second=await searchContext(x.ctx,{source:'planner_session',q:'PAGING unique',limit:1,cursor:first.next_cursor!});
  expect(first.items[0]!.summary).toContain('middle');expect(second.items[0]!.summary).toContain('early');expect(second.has_more).toBe(false);
  expect((await searchContext(x.ctx,{source:'planner_session',q:'PAGING unique',limit:1})).items[0]!.summary).toContain('latest');
});

it('bounds history pages without skipping Unicode entries',async()=>{
  const x=await fixture();x.f.setResponses([fauxAssistantMessage('Initial round.')]);await runPlannerRound(x.input);
  const session=SessionManager.open(x.file);
  for(let i=0;i<35;i++)session.appendMessage(fauxAssistantMessage(`长页中文😀 ${i} `+'原文🧪'.repeat(120)));
  const refs:string[]=[];let cursor:string|undefined;
  do{
    const page=await searchContext(x.ctx,{source:'planner_session',q:'长页中文',limit:50,cursor});
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(14*1024);
    refs.push(...page.items.map(i=>i.ref));cursor=page.next_cursor??undefined;
  }while(cursor);
  expect(refs).toHaveLength(35);expect(new Set(refs).size).toBe(35);
});

it('keeps direct dispatch and preserves custom descriptions',async()=>{
  const x=await fixture();x.f.setResponses([fauxAssistantMessage([fauxToolCall('add_intent',{summary:'LOCAL independent work'})]),fauxAssistantMessage('Submitted directly.')]);
  await runPlannerRound(x.input);
  expect((await x.s.claimNextWorker('local-worker'))?.payload.summary).toBe('LOCAL independent work');
  expect(effectiveToolDescription('context_search','code','CUSTOM')).toEqual({source:'custom',description:'CUSTOM'});
});

it.each([false,true])('searches original entries instead of recall queries/results, including mixed calls: %s',async mixed=>{
  const x=await fixture();x.f.setResponses([fauxAssistantMessage('UNIQUE_NEGATIVE_4844: directory and traversal both return 400.')]);
  const fact=await x.s.addNode('fact',{summary:'INDEPENDENT_GRAPH'},0,'confirmed','test',[]);
  await runPlannerRound(x.input);
  const original=x.entries().find(e=>e.type==='message'&&e.message.role==='assistant')!;
  x.f.setResponses([
    fauxAssistantMessage([fauxToolCall('context_search',{source:'planner_session',q:'UNIQUE_NEGATIVE_4844',limit:1}),
      ...(mixed?[fauxToolCall('context_get',{items:[{ref:`node:${fact}`,view:'detail'}]})]:[])]),
    fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:`session:${original.id}`,field:'/content'}]})]),
    fauxAssistantMessage('Original conclusion checked.')
  ]);
  await runPlannerRound(x.input);
  const found=await searchContext(x.ctx,{source:'planner_session',q:'UNIQUE_NEGATIVE_4844',limit:1});
  expect(found.items[0]!.ref).toBe(`session:${original.id}`);
  const queryResult=x.entries().find(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='context_search')!;
  const recalled=await call(contextGetTool(x.ctx),{items:[{ref:`session:${queryResult.id}`,field:'/content'}]});
  expect(recalled.items[0].content).toContain(`session:${original.id}`); // Audit originals remain accessible.
  if(mixed)expect((await searchContext(x.ctx,{source:'planner_session',q:'INDEPENDENT_GRAPH',limit:1})).items[0]!.tool).toBe('context_get');
});

it('delivers and acknowledges a newly compacted graph in the same planning round',async()=>{
  const x=await fixture();await x.s.addNode('goal',{text:'LOCAL remaining goal'},0,'open','user',[]);
  const intent=await x.s.addIntent({summary:'LOCAL old direction'},5,[],'user');await x.s.setIntentState(intent,'done');
  const fact=await x.s.addNode('fact',{summary:'LOCAL negative evidence'},0,'confirmed','test',[]);await x.s.link(intent,'yields',fact);
  await db.query('UPDATE explorations SET round_no=10 WHERE id=$1',[x.task.exploration_id]);
  await db.query('UPDATE exploration_nodes SET cold_since_round=0 WHERE id=ANY($1::bigint[])',[[intent,fact]]);
  x.f.setResponses([fauxAssistantMessage('No new direction from the retained evidence.')]);
  const engine=new Engine(db,{...defaultEngineConfig(),heartbeatMs:600000,debounceMs:1},async()=>x.input.model,dir);
  try{
    await engine.run(x.task.id);
    const deadline=Date.now()+10000;let completed=false;
    while(Date.now()<deadline){
      try{completed=plannerDeliveries(x.entries()).completed.size===1;}catch{/* First file has not yet been flushed. */}
      if(completed)break;await new Promise(r=>setTimeout(r,20));
    }
    expect(completed).toBe(true);await engine.pause(x.task.id);
    const digest=(await x.s.listByKind('digest')).find(d=>d.state==='active')!;expect(digest).toBeDefined();
    const event=(await db.query('SELECT id,acknowledged_at FROM exploration_context_events WHERE node_id=$1',[digest.id])).rows[0]!;
    const delivery=plannerDeliveries(x.entries()).deliveries[0]!;
    expect(delivery.contextIDs).toContain(Number(event.id));expect(event.acknowledged_at).not.toBeNull();
    expect(JSON.parse(delivery.input).trigger).toContain('bootstrap');
    expect(JSON.parse(delivery.input).trigger).not.toContain('无新事件');
    expect(x.f.state.callCount).toBe(1);
  }finally{await engine.shutdown();}
});

function readEntry(ref:string,start:number,end:number,total:number,extra:Record<string,unknown>={}):SessionEntry{
  const item={ref,view:'detail',field:'/content',version:0,content:'😀'.repeat(end-start),
    read_receipt:{version:1,source_hash:'a'.repeat(64),start,end,total},...extra};
  return {type:'message',id:`r${start}_${end}`,parentId:null,timestamp:new Date().toISOString(),message:{role:'toolResult',toolName:'context_get',toolCallId:'get',isError:false,content:[{type:'text',text:JSON.stringify({items:[item]})}],timestamp:Date.now()}} as SessionEntry;
}
it('computes Unicode read coverage from actual successful intervals, not cursor or completion claims',()=>{
  const ref='session:original';
  const partial=[readEntry(ref,700,2200,14355),readEntry(ref,1000,2500,14355),readEntry(ref,2500,14355,14355)];
  expect(plannerReadCoverage(partial)[0]).toMatchObject({delivered:[[700,14355]],missing:[[0,700]],fully_delivered:false});
  expect(plannerReadCoverage([...partial,readEntry(ref,0,700,14355)])[0]).toMatchObject({fully_delivered:true,scope:'field_or_page',missing:[]});
  expect(plannerReadCoverage([...partial,readEntry(ref,0,100,200,{version:1})])[0]).toMatchObject({version:1,missing:[[100,200]],fully_delivered:false});
  expect(plannerReadCoverage([readEntry(ref,0,20,20),readEntry(ref,0,10,20,{field:'/summary'})])).toHaveLength(2);
  const failed=readEntry(ref,0,20,20);if(failed.type==='message'&&failed.message.role==='toolResult')failed.message.isError=true;
  expect(plannerReadCoverage([failed])).toEqual([]);
  expect(plannerReadCoverage([readEntry(ref,0,20,20,{read_receipt:undefined,next_offset:null,segment:{complete:true}})])).toEqual([]);
});

it('publishes only host-grounded outcomes even when the model insists untested ports are negated and partial reading is complete',async()=>{
  const x=await fixture();
  const fact=await x.s.addNode('fact',{summary:'All ports ruled out',evidence:'Observed port 6379 only',observation_type:'negative',confidence:'high'},0,'confirmed','test',[]);
  x.f.setResponses([fauxAssistantMessage('Seed history. '+'历史😀'.repeat(3000))]);await runPlannerRound(x.input);
  const original=x.entries().find(e=>e.type==='message'&&e.message.role==='assistant')!;
  const bad='22122/23000 已被否定。历史全文已读，未读部分不存在新证据。';const activity:any[]=[];
  x.f.setResponses([fauxAssistantMessage([fauxToolCall('context_get',{items:[{ref:`session:${original.id}`,field:'/content',offset:700}],max_chars:1500})]),fauxAssistantMessage(bad)]);
  const result=await runPlannerRound({...x.input,onActivity:a=>activity.push(a)});
  expect(x.f.state.callCount).toBe(3);expect(result.lastAssistantText).not.toContain(bad);
  expect(result.lastAssistantText).toContain('未测方向保持未知');expect(result.lastAssistantText).toContain('不能认定全文已读');
  expect(activity.filter(a=>a.kind==='assistant_delta'&&!a.isThinking)).toEqual([]);
  expect(activity.filter(a=>a.kind==='assistant_message_end'&&!a.isThinking).map(a=>a.text)).toEqual([result.lastAssistantText]);
  expect(readFileSync(x.file,'utf8')).toContain(bad);
  const checked=x.entries().findLast(e=>e.type==='custom'&&e.customType==='planner_grounded_result') as any;
  expect(checked.data.grounding.negative_scope).toMatchObject({outside_reported_observations:'unknown',direction_exclusions:[]});
  expect(checked.data.grounding.negative_scope.reported_facts).toContainEqual({ref:`node:${fact}`,version:0,claim:'reported_negative',scope_verified:false});
  expect(checked.data.grounding.reads[0]).toMatchObject({fully_delivered:false,delivered:[[700,2200]],missing:[[0,700],[2200,Array.from('Seed history. '+'历史😀'.repeat(3000)).length]]});
  x.f.setResponses([context=>{expect(JSON.stringify(context.messages)).not.toContain(bad);expect(JSON.stringify(context.messages)).toContain('未测方向保持未知');return fauxAssistantMessage('Unknown; only a historical excerpt was returned.');}]);
  await runPlannerRound(x.input);
  const current=await plannerGrounding(x.ctx,x.entries());expect(current.incomplete_total).toBe(1);
  const before=readFileSync(x.file,'utf8');
  const compact=await AgentRunner.create({...x.input.model,cwd:path.join(dir,'grounded-compact'),agentDir:path.join(dir,'agent'),resumeSessionPath:x.file,
    toolAllowlist:[],systemPrompt:'LOCAL',platform:{role:'planner',taskID:x.task.id,policy:{version:'domain-v1',compaction:'native',mcpLoading:'direct'}},
    compactionSettings:{keepRecentTokens:32,reserveTokens:1024},projectMessages:messages=>projectPlannerReceipts(messages,x.entries())});
  x.f.setResponses(Array.from({length:3},()=>context=>{expect(JSON.stringify(context.messages)).not.toContain(bad);return fauxAssistantMessage('Host scope unknown; original ranges remain incomplete.');}));
  try{await compact.compact();expect(compact.compactionDiagnostics.completed).toBe(1);}finally{await compact.dispose();}
  expect(readFileSync(x.file,'utf8').startsWith(before)).toBe(true);
  expect((await plannerGrounding(x.ctx,x.entries())).incomplete_total).toBe(1);
  const raw=await searchContext(x.ctx,{source:'planner_session',q:'22122/23000',limit:1});expect(raw.items[0]!.summary).toContain(bad);
});

it('cannot prove a goal from a negative report with no verified scope',async()=>{
  const x=await fixture(),goal=await x.s.addNode('goal',{summary:'Verify service compromise'},0,'open','test',[]);
  const negative=await x.s.addNode('fact',{summary:'No service',evidence:'Port 6379 proxy response',observation_type:'negative'},0,'confirmed','test',[]);
  await expect(call(proveGoalTool(x.ctx),{goal_id:goal,evidence_node_id:negative})).rejects.toThrow('测试范围');
  expect((await x.s.getNode(goal))?.state).toBe('open');
});

it('does not reuse complete coverage of a revoked or updated node',async()=>{
  const x=await fixture(),id=await x.s.addNode('fact',{summary:'Original'},0,'confirmed','test',[]);
  const entries=[readEntry(`node:${id}`,0,20,20)];
  expect((await plannerGrounding(x.ctx,entries)).reads).toHaveLength(1);
  await db.query('UPDATE exploration_nodes SET content_version=content_version+1 WHERE id=$1',[id]);
  expect((await plannerGrounding(x.ctx,entries)).reads).toHaveLength(0);
});
