import {afterAll,beforeAll,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {runGoalsDecompose} from './roles.js';
import {goalsBootstrap,saveBootstrapGoals,goalHash} from '../db/goals-bootstrap.js';
import {runContext} from '../tools/context.js';
import {setGoalsTool,setConstraintsTool} from '../tools/goals.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';
const dir=mkdtempSync(path.join(tmpdir(),'fate-goals-isolation-')),name=`fate_goals_isolation_${process.pid}`;
let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});});
const description='LOCAL_BACKGROUND_SECRET 架构分析、接口梳理、漏洞挖掘并提交额外报告。\n\n禁止写入生产数据；仅本地合成资料。';
async function fixture(goal='资产测试覆盖度100%'){
 const task=await db.tasks().createTaskWithOptions(description,goal,{seedFirstIntent:true,initializeGoals:true});await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const faux=fauxProvider({provider:`goals-${task.id}`});const modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
 const activities:any[]=[];const input={db,taskID:task.id,expID:task.exploration_id,model:{modelRuntime,model:faux.getModel() as never},dataDir:dir,description,onActivity:(a:unknown)=>activities.push(a),maxTurns:5};
 return {task,faux,input,activities,ctx:runContext(db,task.id,task.exploration_id,'goals')};
}
it('isolates native messages/tools and persists one sourced goal; committed recovery makes no request',async()=>{
 const f=await fixture();let first:any,last:any;
 f.faux.setResponses([ctx=>{first=ctx;return fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'deny',text:'禁止写入生产数据；仅本地合成资料。'}]})]);},fauxAssistantMessage('原文约束已保存'),ctx=>{last=ctx;return fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:'资产测试覆盖度100%',source_quote:'资产测试覆盖度100%'}]})]);}]);
 expect((await runGoalsDecompose(f.input)).stopReason).toBe('completed');
 expect(JSON.stringify(first.messages)).toContain('LOCAL_BACKGROUND_SECRET');expect(JSON.stringify(last.messages)).not.toContain('LOCAL_BACKGROUND_SECRET');expect(JSON.stringify(last.messages)).not.toContain('原文约束已保存');

 const goals=await db.exploration(f.task.exploration_id).listByKind('goal');expect(goals).toHaveLength(1);expect(goals[0]!.payload.source).toMatchObject({field:'goal',quote:f.task.goal,source_hash:goalHash(f.task.goal),fallback:false});
 expect((await db.query('SELECT * FROM task_constraints WHERE exploration_id=$1',[f.task.exploration_id])).rows).toHaveLength(1);
 expect(f.activities.filter(a=>a.kind==='assistant_message_end'&&a.response)).toHaveLength(3);
 expect(f.faux.state.callCount).toBe(3);await runGoalsDecompose(f.input);expect(f.faux.state.callCount).toBe(3);
 const runtimes=(await db.query("SELECT effective FROM runtime_role_configs WHERE task_id=$1 ORDER BY started_at",[f.task.id])).rows;
 expect(runtimes.map(r=>r.effective.active_tools.slice().sort())).toEqual([['register_user_target','set_constraints'],['set_goals']]);
 expect(runtimes.map(r=>r.effective.goals_phase)).toEqual(['constraints','objectives']);expect(runtimes.every(r=>r.effective.mcp.length===0&&r.effective.skills.length===0)).toBe(true);
});
it('multiple explicit results retain independent source quotes',async()=>{
 const f=await fixture('交付覆盖清单；交付修复建议');f.faux.setResponses([fauxAssistantMessage('约束已检查，无需登记新资产'),fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:'交付覆盖清单',source_quote:'交付覆盖清单'},{text:'交付修复建议',source_quote:'交付修复建议'}]})])]);
 await runGoalsDecompose(f.input);expect((await db.exploration(f.task.exploration_id).listByKind('goal'))).toHaveLength(2);
});
it('rejects wrong stage and description quotes without deleting manual goals',async()=>{
 const f=await fixture();const manual=await db.exploration(f.task.exploration_id).addGoal({text:'用户后来添加的目标'},'user');
 const invoke=(t:any,a:any)=>t.execute('local',a,undefined,undefined,{});
 expect((await invoke(setGoalsTool({...f.ctx,goalsPhase:'constraints'}),{goals:[{text:'bad',source_quote:f.task.goal}]})).isError).toBe(true);
 await db.query("UPDATE goals_bootstrap SET phase='objectives' WHERE task_id=$1",[f.task.id]);
 expect((await invoke(setGoalsTool({...f.ctx,goalsPhase:'objectives'}),{goals:[{text:'bad',source_quote:description}]})).isError).toBe(true);
 expect((await invoke(setConstraintsTool({...f.ctx,goalsPhase:'objectives'}),{constraints:[{kind:'deny',text:'禁止写入生产数据；仅本地合成资料。'}]})).isError).toBe(true);
 const ctx={...f.ctx,goalsPhase:'objectives' as const};const results=await Promise.all([saveBootstrapGoals(ctx,[{text:f.task.goal,source_quote:f.task.goal}]),saveBootstrapGoals(ctx,[{text:f.task.goal,source_quote:f.task.goal}])]);expect(results[0]).toEqual(results[1]);expect((await db.exploration(f.task.exploration_id).listByKind('goal')).map(g=>g.id)).toContain(manual);
});
it('resumes stage two without replaying constraints and falls back only to raw goal on no output',async()=>{
 const f=await fixture();await db.query("UPDATE goals_bootstrap SET phase='objectives' WHERE task_id=$1",[f.task.id]);f.faux.setResponses([ctx=>{expect(JSON.stringify(ctx.messages)).not.toContain('LOCAL_BACKGROUND_SECRET');return fauxAssistantMessage('无有效提交');}]);
 await runGoalsDecompose(f.input);expect((await goalsBootstrap(db,f.task.id))?.fallback).toBe(true);expect((await db.exploration(f.task.exploration_id).listByKind('goal'))[0]?.payload.text).toBe(f.task.goal);
});
it('disabled writer prevents both stages, fallback and model requests',async()=>{
 const f=await fixture();await db.query("UPDATE tools SET enabled=false WHERE key='set_goals'");try{await expect(runGoalsDecompose(f.input)).rejects.toThrow('禁用');expect(f.faux.state.callCount).toBe(0);}finally{await db.query("UPDATE tools SET enabled=true WHERE key='set_goals'");}
});
it('cancellation after stage one does not save goals or progress stage',async()=>{
 const f=await fixture(),controller=new AbortController();f.faux.setResponses([()=>{controller.abort();return fauxAssistantMessage('取消');}]);await expect(runGoalsDecompose({...f.input,signal:controller.signal})).rejects.toThrow();expect((await goalsBootstrap(db,f.task.id))?.phase).toBe('constraints');expect(await db.exploration(f.task.exploration_id).listByKind('goal')).toHaveLength(0);
});
it('constraint failure pauses engine before planner/seed Worker and retains bootstrap on resume',async()=>{
 const f=await fixture();const roles:string[]=[];
 f.faux.setResponses([()=>{throw new Error('LOCAL extraction failure');}]);
 const engine=new Engine(db,defaultEngineConfig(),async(_id,role)=>{roles.push(String(role));return f.input.model;},dir);
 try{await engine.run(f.task.id,{decompose:{description}});expect((await db.tasks().getTask(f.task.id))?.paused).toBe(true);expect(roles).toEqual(['goals']);expect((await goalsBootstrap(db,f.task.id))?.phase).toBe('constraints');expect((await db.query('SELECT * FROM engine_worker_slots WHERE task_id=$1',[f.task.id])).rowCount).toBe(0);}finally{await engine.shutdown();}
});
it('missing historical enrollment does not backfill or rewrite historical goals',async()=>{const f=await fixture();await db.query('DELETE FROM goals_bootstrap WHERE task_id=$1',[f.task.id]);const id=await db.exploration(f.task.exploration_id).addGoal({text:'历史目标'},'user');expect(await goalsBootstrap(db,f.task.id)).toBeUndefined();expect((await db.exploration(f.task.exploration_id).listByKind('goal'))[0]?.id).toBe(id);});
it.each(['cancel','pause','lease'])('stage-two %s never falls back or starts execution',async kind=>{
 const f=await fixture(),controller=new AbortController();let lost=false;
 await db.query("UPDATE goals_bootstrap SET phase='objectives' WHERE task_id=$1",[f.task.id]);
 f.faux.setResponses([async()=>{if(kind==='cancel')controller.abort();if(kind==='pause')await db.tasks().applyTaskPause(f.task.id);if(kind==='lease')lost=true;return fauxAssistantMessage('未保存');}]);
 await expect(runGoalsDecompose({...f.input,signal:controller.signal,hooks:{assertOwnership:async()=>{if(lost)throw new Error('lease lost');}}})).rejects.toThrow();
 expect(await db.exploration(f.task.exploration_id).listByKind('goal')).toHaveLength(0);expect((await goalsBootstrap(db,f.task.id))?.phase).toBe('objectives');
});
it('disabling the writer during a no-output response cannot be bypassed by fallback',async()=>{
 const f=await fixture();await db.query("UPDATE goals_bootstrap SET phase='objectives' WHERE task_id=$1",[f.task.id]);
 f.faux.setResponses([async()=>{await db.query("UPDATE tools SET enabled=false WHERE key='set_goals'");return fauxAssistantMessage('未保存');}]);
 try{await expect(runGoalsDecompose(f.input)).rejects.toThrow('禁用');expect(await db.exploration(f.task.exploration_id).listByKind('goal')).toHaveLength(0);}finally{await db.query("UPDATE tools SET enabled=true WHERE key='set_goals'");}
});
it('phase-two model failure falls back to sourced raw goal, not background',async()=>{
 const f=await fixture();await db.query("UPDATE goals_bootstrap SET phase='objectives' WHERE task_id=$1",[f.task.id]);f.faux.setResponses([()=>{throw new Error('LOCAL model failure');}]);
 await runGoalsDecompose(f.input);const goal=(await db.exploration(f.task.exploration_id).listByKind('goal'))[0]!;expect(goal.payload).toMatchObject({text:f.task.goal,source:{fallback:true,field:'goal'}});
});
it('custom prompt remains selected, stage preview restricts capabilities and exact-default migration is reversible',async()=>{
 const {previewRoleTools}=await import('./tool-catalog.js');const {migrateIsolatedGoalsPrompt,GOALS_MIGRATION_KEY,PREVIOUS_GOALS_DEFAULTS}=await import('./goals-migration.js');const {GOALS_PROMPT}=await import('./prompts.js');
 const agent=(await db.platform().getAgentByKey('goals'))!;
 await db.platform().savePrompt(agent.id,PREVIOUS_GOALS_DEFAULTS[0]!,'fixture','test');const old=(await db.query('SELECT current_prompt_id FROM agents WHERE id=$1',[agent.id])).rows[0].current_prompt_id;
 await db.platform().setSetting(GOALS_MIGRATION_KEY,'');await migrateIsolatedGoalsPrompt(db);expect(await db.platform().currentPrompt(agent.id)).toBe(GOALS_PROMPT);
 await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent.id,old]);await migrateIsolatedGoalsPrompt(db);expect(await db.platform().currentPrompt(agent.id)).toBe(PREVIOUS_GOALS_DEFAULTS[0]);
 const custom='自定义标记 {{Goal}}；背景变量={{Description}} {{.EngagementDescription}}。';await db.platform().savePrompt(agent.id,custom,'custom','test');await db.platform().setSetting(GOALS_MIGRATION_KEY,'');await migrateIsolatedGoalsPrompt(db);expect(await db.platform().currentPrompt(agent.id)).toBe(custom);
 const f=await fixture();let body='';f.faux.setResponses([fauxAssistantMessage('无新约束'),c=>{body=JSON.stringify(c);return fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:f.task.goal,source_quote:f.task.goal}]})]);}]);await runGoalsDecompose(f.input);expect(body).toContain('自定义标记');expect(body).not.toContain('LOCAL_BACKGROUND_SECRET');
 const preview=await previewRoleTools(db,'goals');expect(preview.stages?.map(s=>s.resident.sort())).toEqual([['register_user_target','set_constraints'],['set_goals']]);expect(preview.deferred).toEqual([]);
 await db.platform().savePrompt(agent.id,GOALS_PROMPT,'restore','test');
});
it('initialization completes before a seeded Worker can obtain its model',async()=>{
 const f=await fixture();let workerStarted=false;
 const engine=new Engine(db,{...defaultEngineConfig(),workers:1},async(_id,role)=>{
  if(role==='goals'){f.faux.setResponses([fauxAssistantMessage('约束已检查'),fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:f.task.goal,source_quote:f.task.goal}]})])]);}
  if(role==='worker'){expect((await goalsBootstrap(db,f.task.id))?.phase).toBe('completed');workerStarted=true;f.faux.setResponses([fauxAssistantMessage('LOCAL seed finished')]);}
  return f.input.model;
 },dir);
 await db.tasks().setExecutionMode(f.task.exploration_id,'manual');
 try{await engine.run(f.task.id);expect(workerStarted).toBe(false);const seed=(await db.exploration(f.task.exploration_id).listByKind('intent'))[0]!;await engine.dispatchIntent(f.task.id,seed.id);for(let i=0;i<100&&!workerStarted;i++)await new Promise(r=>setTimeout(r,30));expect(workerStarted).toBe(true);}finally{await engine.shutdown();}
});
it('SIGKILL after durable constraints restarts without duplicate constraints or committed goal replay',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const f=await fixture();
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../../test-fixtures/goals-crash-child.mts',import.meta.url)),String(f.task.id),dir],{env:{...process.env},stdio:['ignore','ignore','pipe','ipc']});
 let errors='';child.stderr!.on('data',chunk=>errors+=chunk);
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child checkpoint timeout '+errors)),15000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(new Error('child exited '+code+' '+errors));});});
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  expect((await goalsBootstrap(db,f.task.id))?.phase).toBe('constraints');
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('set_constraints',{constraints:[{kind:'deny',text:'禁止写入生产数据；仅本地合成资料。'}]})]),fauxAssistantMessage('约束恢复完成'),fauxAssistantMessage([fauxToolCall('set_goals',{goals:[{text:f.task.goal,source_quote:f.task.goal}]})])]);
  await runGoalsDecompose(f.input);expect((await db.query('SELECT id FROM task_constraints WHERE exploration_id=$1',[f.task.exploration_id])).rowCount).toBe(1);
  const calls=f.faux.state.callCount;await runGoalsDecompose(f.input);expect(f.faux.state.callCount).toBe(calls);expect(await db.exploration(f.task.exploration_id).listByKind('goal')).toHaveLength(1);
 }finally{if(child.exitCode===null)child.kill('SIGKILL');}
});
