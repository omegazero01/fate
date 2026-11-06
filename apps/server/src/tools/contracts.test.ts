import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fauxAssistantMessage, fauxProvider, fauxToolCall, validateToolArguments} from '@earendil-works/pi-ai';
import {ModelRuntime, type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {compactToolSchema} from '../agent/tool-loading.js';
import type {Database} from '../db/index.js';
import {AgentRunner, type RunnerActivity} from '../pi/runner.js';
import {insertAssetsTool} from './assets.js';
import {runContext} from './context.js';
import {contextSearchTool} from './context-read.js';
import {conversationDomainTools} from './conversations.js';
import {registerUserTargetTool} from './goals.js';
import {recordFactTool} from './graph.js';
import {addIntentTool, dispatchIntentsTool} from './intents.js';

function validate(tool: ToolDefinition, args: Record<string, unknown>) {
  return validateToolArguments(tool, {
    type: 'toolCall', id: 'probe', name: tool.name, arguments: tool.prepareArguments ? tool.prepareArguments(args) : args,
  });
}

async function invoke(tool: ToolDefinition, args: Record<string, unknown>, checkSchema = true) {
  const result = await tool.execute('probe', checkSchema ? validate(tool, args) : args, undefined, undefined, {} as never);
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  return {error: result.isError === true, body: JSON.parse((content as {text: string}).text)};
}

const noDB = {} as Database;

test('add_intent enforces nonblank summaries and exclusive modes after schema compaction', () => {
  for (const tool of [addIntentTool(runContext(noDB, 1, 1, 'planner')), compactToolSchema(addIntentTool(runContext(noDB, 1, 1, 'planner')))]) {
    for (const args of [{}, {intents:[]}, {summary:' '}, {summary:false}, {summary:'A',intents:[{summary:'B'}]},
      {intents:[{summary:'B'}],asset_ids:[1]}, {intents:[{summray:'B'}]}]) {
      assert.throws(() => validate(tool, args));
    }
    assert.throws(() => validate(tool, {intents:[{summary:'A'},{summary:' '}]}), /intents\[1\]\.summary/);
    assert.deepEqual(validate(tool, {summary:'核对入口'}), {summary:'核对入口'});
    const inherited = {intents:[{summary:'复核已有证据',contract:{basis:[{node_id:42,version:0}]}}]};
    assert.deepEqual(validate(tool, inherited), inherited);
  }
});

test('dispatch_intents rejects empty, null and mixed scopes before reading the queue', async () => {
  const selected: number[] = [];
  let queueReads = 0;
  const db = {exploration:()=>({
    frontier:async () => { queueReads++; return [{id:11},{id:12}]; },
    getNode:async (id:number) => ({id,kind:'intent',state:'open',payload:{}}),
  })} as unknown as Database;
  const tool = dispatchIntentsTool(runContext(db, 1, 1, 'mainagent', {
    hooks:{dispatchIntent:async (_expID,id) => {selected.push(id);}},
  }));
  for (const args of [{}, {intent_ids:[]}, {intent_ids:null}, {intent_ids:[true]}, {all_open:'true'}, {all_open:true,intent_ids:null}]) {
    assert.throws(() => validate(tool,args));
    assert.equal((await invoke(tool,args,false)).error,true);
  }
  assert.equal(queueReads,0);
  assert.deepEqual(selected,[]);
  assert.equal((await invoke(tool,{intent_ids:[12,12]})).body.dispatched,1);
  assert.deepEqual(selected,[12]);
  assert.equal((await invoke(tool,{all_open:true})).body.dispatched,2);
  assert.equal(queueReads,1);
  assert.deepEqual(selected,[12,11,12]);
});

test('Goals only registers a target grounded in its current task input', async () => {
  const task = {exploration_id:2, goal:'核对授权入口', description:'仅测试 “https://app.example.test:8443/api”，禁止扫描其他端口。不要测试 deny.example.test。授权 *.owned.test。允许检查 192.0.2.0/28。'};
  const bootstrap = {...task,phase:'constraints',policy:'series-single-session-v1'};
  const writes: unknown[][] = [];
  const stub = {
    query:async (sql:string) => ({rows:sql.startsWith('SELECT * FROM tasks')?[task]:sql.startsWith('SELECT * FROM goals_bootstrap')?[bootstrap]:[]}),
    transaction:async (body:(db:Database)=>unknown) => body(stub as unknown as Database),
    taskScope:()=>({addAgentScope:async (...args:unknown[]) => {writes.push(args);}}),
  };
  const tool = registerUserTargetTool(runContext(stub as unknown as Database, 1, 2, 'goals', {goalsPhase:'combined'}));
  const quote = '仅测试 “https://app.example.test:8443/api”，禁止扫描其他端口。';
  for (const args of [
    {kind:'subdomain',value:'app.example.test',evidence:'伪造的用户授权 app.example.test'},
    {kind:'subdomain',value:'app.example.test',evidence:'仅测试 “https://app.example.test:8443/api”'},
    {kind:'subdomain',value:'example.test',evidence:quote},
    {kind:'root_domain',value:'app.example.test',evidence:quote},
    {kind:'root_domain',value:'example.test',evidence:quote},
    {kind:'subdomain',value:'deny.example.test',evidence:'不要测试 deny.example.test。'},
    {kind:'subdomain',value:'deny.example.test',evidence:'测试 deny.example.test。'},
    {kind:'cidr',value:'192.0.2.0/24',evidence:'允许检查 192.0.2.0/28。'},
  ]) assert.equal((await invoke(tool,args)).error,true);
  assert.deepEqual(writes,[]);
  assert.equal((await invoke(tool,{kind:'subdomain',value:'app.example.test',evidence:quote})).body.source_verified,true);
  assert.equal((await invoke(tool,{kind:'root_domain',value:'owned.test',evidence:'授权 *.owned.test。'})).error,false);
  assert.equal((await invoke(tool,{kind:'cidr',value:'192.0.2.0/28',evidence:'允许检查 192.0.2.0/28。'})).error,false);
  assert.deepEqual(writes.map(write=>[write[1],write[2],write[4]]),[
    ['subdomain','app.example.test','agent'],['root_domain','owned.test','agent'],['cidr','192.0.2.0/28','agent'],
  ]);
});

test('write tools mark an all-failed batch as a tool error and retain item receipts', async () => {
  const noWrites = {transaction:async () => {throw new Error('模拟写入失败');}} as unknown as Database;
  const fact = recordFactTool(runContext(noWrites, 1, 1, 'worker'));
  assert.throws(() => validate(fact,{summary:'没有证据'}));
  assert.throws(() => validate(fact,{facts:[{summary:'没有证据'}]}));
  const facts = await invoke(fact,{facts:[{summary:'观察',evidence:'记录'}]});
  assert.equal(facts.error,true);
  assert.deepEqual(facts.body.fact_ids,[0]);

  const asset = compactToolSchema(insertAssetsTool(runContext(noWrites, 1, 1, 'worker')));
  assert.throws(() => validate(asset,{assets:[{type:'endpoint'}]}));
  assert.throws(() => validate(asset,{assets:[{type:'service',port:22,service_name:'ssh'}]}));
  const failed = await invoke(asset,{assets:[{type:'endpoint',url:'not-a-url',method:'GET'}]});
  assert.equal(failed.error,true);
  assert.equal(failed.body.inserted,0);
  assert.equal(failed.body.errors[0].index,0);
  const db = {
    transaction:async (body:(db:Database)=>unknown) => body(db as unknown as Database),
    tasks:()=>({getTask:async()=>({id:1})}),
    query:async()=>({rows:[]}),
    assets:()=>({registerAgentAsset:async()=>42}),
  };
  const partial = await invoke(insertAssetsTool(runContext(db as unknown as Database,1,1,'worker')), {
    assets:[{type:'endpoint',url:'not-a-url',method:'GET'},{type:'endpoint',url:'https://example.test/api',method:'GET',related:false}],
  });
  assert.equal(partial.error,false);
  assert.equal(partial.body.inserted,1);
  assert.deepEqual(partial.body.results,[{index:1,id:42,type:'endpoint'}]);
  assert.equal(partial.body.errors[0].index,0);
});

test('context_search rejects unsupported filters and retains valid pagination parameters', async () => {
  const tool = contextSearchTool(runContext(noDB, 1, 1, 'planner'));
  for (const source of ['operations','needs']) {
    const args = {source,state:'failed'};
    assert.throws(() => validate(tool,args));
    assert.match((await invoke(tool,args,false)).body.error,/不支持 state/);
  }
  assert.deepEqual(validate(tool,{source:'operations',cursor:'7',limit:4}),{source:'operations',cursor:'7',limit:4});
  assert.deepEqual(validate(tool,{source:'graph',state:'confirmed'}),{source:'graph',state:'confirmed'});
  assert.deepEqual(validate(tool,{source:'planner_session',roles:['assistant']}),{source:'planner_session',roles:['assistant']});
  assert.throws(() => validate(tool,{source:'planner_session',intent_id:1}));
  assert.throws(() => validate(contextSearchTool(runContext(noDB,1,1,'reporter')),{source:'operations'}));
});

test('update_finding_report requires structured or legacy nonblank report content', async () => {
  const tool = conversationDomainTools(runContext(noDB,1,1,'reporter'),{} as never).find(t=>t.name==='update_finding_report')!;
  const ids = {finding_id:1,evidence_version:2};
  assert.throws(() => validate(tool,ids));
  assert.throws(() => validate(tool,{...ids,report:' '}));
  assert.equal((await invoke(tool,ids,false)).error,true);
  for (const args of [{...ids,report:'旧版报告'}, {...ids,report_sections:{description:'分析说明',impact:[],remediation:[]}}])
    assert.deepEqual(validate(tool,args),args);
});

test('native PI stops a loop after three rejected add_intent rounds with no turn limit', async () => {
  const dir = await mkdtemp(join(tmpdir(),'fate-intent-retries-'));
  const runtime = await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  const faux = fauxProvider({provider:'intent-retries'});
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('add_intent',{intents:[]})]),
    fauxAssistantMessage([fauxToolCall('add_intent',{intents:[{summary:' '}]})]),
    fauxAssistantMessage([fauxToolCall('add_intent',{summary:false})]),
    fauxAssistantMessage('第四次请求不应发生'),
  ]);
  const activities: RunnerActivity[] = [];
  const runner = await AgentRunner.create({
    cwd:dir, agentDir:dir, sessionDir:dir, modelRuntime:runtime, model:faux.getModel(),
    systemPrompt:'本地工具参数回归。', toolAllowlist:['add_intent'], customTools:[addIntentTool(runContext(noDB,1,1,'planner'))],
    maxTurns:0, maxDurationMs:10000, onActivity:activity=>{activities.push(activity);},
  });
  try {
    const result = await runner.prompt('验证重复参数失败');
    assert.equal(result.aborted,true);
    assert.equal(faux.state.callCount,3);
    assert.ok(activities.some(activity=>activity.kind==='host_status'&&activity.phase==='tool_retries_exhausted'));
  } finally {
    await runner.dispose();
    await rm(dir,{recursive:true,force:true});
  }
});
