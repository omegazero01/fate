import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {setConstraintsTool,loadConstraints} from './goals.js';
import {runContext} from './context.js';
import {runGoalsDecompose,runMainChat} from '../agent/roles.js';
import {constraintBlock,GOALS_PROMPT,systemRolePrompt,promptHash} from '../agent/prompts.js';
import {migrateConstraintPrompts,CONSTRAINT_MIGRATION_KEY,SERIES_GOALS_HASH} from '../agent/constraint-migration.js';

const name=`fate_constraint_grounding_${process.pid}`,dir=mkdtempSync(path.join(os.tmpdir(),'fate-constraints-'));
let db:Database;
beforeAll(async()=>{
  process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;
  db=await openDatabase();
});
afterAll(async()=>{
  await db?.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});
  await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name}`);await c.end();rmSync(dir,{recursive:true,force:true});
});
async function fixture(description='测试目标：\nhttp://fixture.invalid/\n\n禁止爆破。'){
  return db.tasks().createTaskWithOptions(description,'分析系统架构', {executionMode:'manual',initializeGoals:true});
}
async function call(tool:ReturnType<typeof setConstraintsTool>,args:unknown){
  const out=await tool.execute('constraint-call',args as never);
  if(out.isError)throw new Error((out.content[0] as {text:string}).text);
  return JSON.parse((out.content[0] as {text:string}).text);
}
it('rejects invented boundaries atomically, stores provenance, and deduplicates',async()=>{
  const t=await fixture(),ctx={...runContext(db,t.id,t.exploration_id,'goals'),goalsPhase:'constraints' as const};
  let notified=0;ctx.hooks.constraintsChanged=()=>{notified++;};
  await expect(call(setConstraintsTool(ctx),{constraints:[{kind:'deny',text:'禁止爆破。'},{kind:'allow',text:'仅允许 fixture.invalid:80'}]})).rejects.toThrow('原文依据');
  expect(await loadConstraints(db,t.exploration_id)).toEqual([]);
  expect(await call(setConstraintsTool(ctx),{constraints:[{kind:'deny',text:'禁止爆破。'}]})).toMatchObject({saved:1,source_verified:true});
  expect(await call(setConstraintsTool(ctx),{constraints:[{kind:'deny',text:'禁止爆破。'}]})).toMatchObject({saved:0});
  expect(notified).toBe(1);
  const row=(await db.query('SELECT origin,source FROM task_constraints WHERE exploration_id=$1',[t.exploration_id])).rows[0]!;
  expect(row).toMatchObject({origin:'goals',source:{field:'description',quote:'禁止爆破。'}});
  await expect(call(setConstraintsTool({...ctx,role:'worker'}),{constraints:[]})).rejects.toThrow('只有 Goals');
  const other=await fixture();
  await expect(call(setConstraintsTool({...ctx,taskID:other.id}),{constraints:[]})).rejects.toThrow('所属任务');
});
it('rejects joined paragraphs and literal newline escapes without weakening the original constraints',async()=>{
  const first='只允许读取本地合成样本。',second='禁止重复请求；失败时保留原始证据。';
  const t=await fixture(`${first}\n\n${second}`),ctx={...runContext(db,t.id,t.exploration_id,'goals'),goalsPhase:'constraints' as const};
  for(const text of [`${first}\n\n${second}`,`${first}\\n\\n${second}`]){
    await expect(call(setConstraintsTool(ctx),{constraints:[{kind:'allow',text}]})).rejects.toThrow('原文依据');
    expect(await loadConstraints(db,t.exploration_id)).toEqual([]);
  }
  expect(await call(setConstraintsTool(ctx),{constraints:[{kind:'allow',text:first},{kind:'deny',text:second}]})).toMatchObject({saved:2});
  expect(await loadConstraints(db,t.exploration_id)).toEqual([{kind:'allow',text:first},{kind:'deny',text:second}]);
});
it('Main accepts only its actual current human request and failed replacement preserves rules',async()=>{
  const t=await fixture(),text='只允许被动侦察。',ctx=runContext(db,t.id,t.exploration_id,'mainagent',{userMessage:text});
  await call(setConstraintsTool(ctx),{constraints:[{kind:'allow',text}]});
  await expect(call(setConstraintsTool(ctx),{replace:true,constraints:[{kind:'allow',text:'禁止爆破。'}]})).rejects.toThrow('原文依据');
  await expect(call(setConstraintsTool({...ctx,userMessage:undefined}),{constraints:[{kind:'allow',text}]})).rejects.toThrow('原文依据');
  expect(await loadConstraints(db,t.exploration_id)).toEqual([{kind:'allow',text}]);
});
it('preserves user/legacy constraints and exact qualifiers in Planner/Worker assembly',async()=>{
  const t=await fixture();
  await db.query("INSERT INTO task_constraints(exploration_id,kind,text,origin) VALUES($1,'allow','允许测试 API。','user'),($1,'deny','禁止爆破。','goals')",[t.exploration_id]);
  const block=constraintBlock(await loadConstraints(db,t.exploration_id));
  expect(block).toContain('允许测试 API。');expect(block).not.toContain('仅允许：');
  for(const role of ['planner','worker','mainagent','goals'])
    expect(await systemRolePrompt(db,role)).toContain('仅有目标 URL 不代表');
});
it('native pi Goals can recover from a rejected invented rule and save the real request',async()=>{
  const t=await fixture(),faux=fauxProvider({provider:'constraints-goals'}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});
  await modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'allow',text:'仅允许 fixture.invalid:80'}]})]),
    fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'deny',text:'禁止爆破。',source_quote:'禁止爆破。'}]})]),
    fauxAssistantMessage('原文约束已保存'),
    fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:'分析系统架构',source_quote:'分析系统架构'}]})]),
  ]);
  await runGoalsDecompose({db,taskID:t.id,expID:t.exploration_id,description:t.description,model:{modelRuntime,model:faux.getModel() as never},dataDir:dir});
  expect(await loadConstraints(db,t.exploration_id)).toEqual([{kind:'deny',text:'禁止爆破。'}]);
  expect(faux.state.callCount).toBe(4);
});
it('native Main binds the current request without treating task facts as new instructions',async()=>{
  const t=await fixture(),faux=fauxProvider({provider:'constraints-main'}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});
  await modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('tool_search',{query:'set_constraints'})]),
    fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'allow',text:'仅允许被动侦察。'}]})]),
    fauxAssistantMessage('已保存本轮用户限制。'),
  ]);
  await runMainChat({db,taskID:t.id,expID:t.exploration_id,goal:t.goal,message:'仅允许被动侦察。',model:{modelRuntime,model:faux.getModel() as never},dataDir:dir,hooks:{},maxTurns:3,onActivity:()=>{}});
  expect(await loadConstraints(db,t.exploration_id)).toEqual([{kind:'allow',text:'仅允许被动侦察。'}]);
});
it('upgrades the exact SERIES default once, keeps custom versions and permits explicit rollback',async()=>{
  const old=readFileSync(new URL('../../test-fixtures/series-goals-78ab23f.txt',import.meta.url),'utf8');
  expect(promptHash(old)).toBe(SERIES_GOALS_HASH);
  const goals=(await db.platform().getAgentByKey('goals'))!,worker=(await db.platform().getAgentByKey('worker'))!;
  await db.platform().savePrompt(goals.id,old,'内置默认','fixture');
  const prior=(await db.query('SELECT current_prompt_id FROM agents WHERE id=$1',[goals.id])).rows[0]!.current_prompt_id;
  const custom='保留工单号。待审批 pending 的旧说明。';
  await db.platform().savePrompt(worker.id,custom,'user','fixture');
  await db.platform().setSetting(CONSTRAINT_MIGRATION_KEY,'');
  await migrateConstraintPrompts(db);
  expect(await db.platform().currentPrompt(goals.id)).toBe(GOALS_PROMPT);
  expect(await db.platform().currentPrompt(worker.id)).toBe(custom);
  expect((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[prior])).rows[0]!.template_text).toBe(old);
  const count=(await db.query('SELECT count(*) FROM agent_prompts')).rows[0]!.count;
  await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[goals.id,prior]);
  await migrateConstraintPrompts(db);
  expect(await db.platform().currentPrompt(goals.id)).toBe(old);
  expect((await db.query('SELECT count(*) FROM agent_prompts')).rows[0]!.count).toBe(count);
  await db.platform().savePrompt(goals.id,'用户自定义业务目标要求','user','fixture');
  await db.platform().setSetting(CONSTRAINT_MIGRATION_KEY,'');await migrateConstraintPrompts(db);
  expect(await db.platform().currentPrompt(goals.id)).toBe('用户自定义业务目标要求');
});
