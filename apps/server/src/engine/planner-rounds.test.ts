import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,Database} from '../db/index.js';
import {beginPlannerDisplayRound,finishPlannerDisplayRound,projectPlannerDisplay,legacyPlannerNumber} from '../db/planner-rounds.js';
import {plannerTitle} from '../agent/planner-title.js';
import {runPlannerRound,type PlannerRoundInput} from '../agent/roles.js';
import {plannerSessionFile} from '../agent/planner-memory.js';
import {TodoStore} from '../tools/context.js';
import {projectTurn,readTurnSummaries} from './turn-summary.js';

const name=`fate_planner_rounds_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-planner-rounds-'));
let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});});
async function fixture(){
 const task=await db.tasks().createTaskWithOptions('LOCAL synthetic planning','Verify local fixture',{executionMode:'managed'});
 const f=fauxProvider({provider:`round-${task.id}`}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(f.provider);
 const input:PlannerRoundInput={db,taskID:task.id,expID:task.exploration_id,goal:task.goal,model:{modelRuntime,model:f.getModel() as never},dataDir:dir,todos:new TodoStore(db),hooks:{},triggersText:'LOCAL synthetic wake',maxTurns:4,onActivity:()=>{}};
 return {task,f,input};
}

it('validates one display-only first-line title and never extracts arbitrary prose',()=>{
 expect(plannerTitle('<planning_title>文件上传全面探测</planning_title>\nActual summary')).toBe('文件上传全面探测');
 expect(plannerTitle(`<planning_title>${'文'.repeat(40)}</planning_title>`)).toHaveLength(40);
 for(const text of ['', '文件上传全面探测', '<planning_title></planning_title>', '<planning_title>bad\nline</planning_title>', `<planning_title>${'文'.repeat(41)}</planning_title>`, '<planning_title>A</planning_title>\n<planning_title>B</planning_title>', 'body\n<planning_title>A</planning_title>', '<planning_title>\u0000bad</planning_title>'])expect(plannerTitle(text)).toBeNull();
});

it('allocates atomically across instances, deduplicates turns and does not touch cold age',async()=>{
 const {task}=await fixture();await db.query('UPDATE explorations SET round_no=72 WHERE id=$1',[task.exploration_id]);
 const other=new Database(db.pool);
 const results=await Promise.all(Array.from({length:12},(_,i)=>beginPlannerDisplayRound(i%2?other:db,task.exploration_id,`turn-${i%4}`)));
 expect(new Set(results.map(r=>r.number)).size).toBe(4);
 expect((await db.query("SELECT * FROM activity WHERE exploration_id=$1 AND metadata->>'event_type'='planner_round_start'",[task.exploration_id])).rows).toHaveLength(4);
 expect(Number((await db.query('SELECT round_no FROM explorations WHERE id=$1',[task.exploration_id])).rows[0]!.round_no)).toBe(72);
 expect((await beginPlannerDisplayRound(new Database(db.pool),task.exploration_id,'after-restart')).number).toBe(5);
 const second=await fixture();expect((await beginPlannerDisplayRound(db,second.task.exploration_id,'turn-0')).number).toBe(1);
});

it('continues explicit historical boundaries without rewriting old prose or inferring Goals rounds',async()=>{
 const {task}=await fixture(),s=db.exploration(task.exploration_id);
 await s.appendActivity({worker:'planner',kind:'round',summary:'第 258 轮规划'});
 await s.appendActivity({worker:'planner',kind:'text',summary:'第 900 轮规划'});
 await s.appendActivity({worker:'goals',kind:'round',summary:'第 999 轮规划'});
 expect((await beginPlannerDisplayRound(db,task.exploration_id,'new')).number).toBe(259);
 expect(legacyPlannerNumber({worker:'planner',kind:'round',summary:'第 0 轮 · 目标拆解'})).toBeNull();
 expect(projectPlannerDisplay([{worker:'planner',kind:'round',summary:'第 258 轮规划'}])).toEqual({number:258,title:null});
 expect(projectPlannerDisplay([{worker:'planner',kind:'text',summary:'旧正文'}])).toBeUndefined();
});

it('commits one title update and recovers the same summary without altering model/tool accounting',async()=>{
 const {task}=await fixture(),s=db.exploration(task.exploration_id),turn='durable';
 await beginPlannerDisplayRound(db,task.exploration_id,turn);
 await s.appendActivity({worker:'planner',kind:'status',metadata:{turn_id:turn,event_type:'turn_start',role:'planner',started_at:new Date().toISOString()}});
 await s.appendActivity({worker:'planner',kind:'text',summary:'Saved final receipt',metadata:{turn_id:turn,final_answer:true,stream_id:'s1',response:{stop_reason:'stop',has_tools:false,usage:{input:10,output:2}}}});
 await finishPlannerDisplayRound(db,task.exploration_id,turn,'文件上传全面探测');
 await finishPlannerDisplayRound(new Database(db.pool),task.exploration_id,turn,'不得覆盖');
 await s.appendActivity({worker:'planner',kind:'result',metadata:{turn_id:turn,event_type:'lifecycle',status:'completed'}});
 const rows=(await db.query('SELECT * FROM activity WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows;
 expect(rows.filter(r=>r.metadata?.event_type==='planner_round_title')).toHaveLength(1);
 expect(projectTurn(rows,[])).toMatchObject({planner_round:{number:1,title:'文件上传全面探测'},steps:1,tool_calls:0,queue_ms:null,usage:{total:12},final_activity:{summary:'Saved final receipt'}});
 expect((await readTurnSummaries(db,'task',task.exploration_id,[turn]))[0]?.planner_round).toEqual({number:1,title:'文件上传全面探测'});
});

it('native pi supplies the title in the same request, preserves custom prompts and raw prose, and restores it without another request',async()=>{
 const {task,f,input}=await fixture();
 const agent=(await db.platform().getAgentByKey('planner'))!;
 const prior=await db.query('SELECT current_prompt_id FROM agents WHERE id=$1',[agent.id]);
 const saved=(await db.query("INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) VALUES($1,10000,'CUSTOM PLANNER BODY','test','test') RETURNING id",[agent.id])).rows[0]!;
 await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent.id,saved.id]);
 try{
  f.setResponses([ctx=>{const content=JSON.stringify(ctx);expect(content).toContain('CUSTOM PLANNER BODY');expect(content).toContain('<planning_title>');return fauxAssistantMessage('<planning_title>等待已有任务返回</planning_title>\nNo additional work needed.');}]);
  const r=await runPlannerRound({...input,planningRoundID:'native',contextEventIDs:[11]});
  expect(r.planningTitle).toBe('等待已有任务返回');expect(f.state.callCount).toBe(1);
  expect(r.lastAssistantText).not.toContain('<planning_title>');
  expect(readFileSync(plannerSessionFile(dir,task.exploration_id),'utf8')).toContain('<planning_title>等待已有任务返回</planning_title>');
  const restored=await runPlannerRound({...input,planningRoundID:'native',contextEventIDs:[11,12]});
  expect(restored.planningTitle).toBe(r.planningTitle);expect(f.state.callCount).toBe(1);
  expect((await db.query('SELECT * FROM planner_display_rounds WHERE exploration_id=$1',[task.exploration_id])).rows).toHaveLength(1);
 }finally{await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent.id,prior.rows[0]!.current_prompt_id]);}
});

it('missing titles and terminal-only rounds finish normally without a repair request or a new tool',async()=>{
 const {task,f,input}=await fixture();
 f.setResponses([fauxAssistantMessage('Normal summary without a title.')]);
 const r=await runPlannerRound({...input,planningRoundID:'missing'});expect(r.planningTitle).toBeNull();expect(r.stopReason).toBe('completed');
 f.setResponses([ctx=>{expect(JSON.stringify(ctx)).toContain('<planning_title>');return fauxAssistantMessage('<planning_title>复核目标完成情况</planning_title>\nLOCAL finish.');}]);
 await runPlannerRound({...input,planningRoundID:'terminal',terminalOnly:true});
 expect(f.state.callCount).toBe(2);
 expect((await db.query('SELECT number,title FROM planner_display_rounds WHERE exploration_id=$1 ORDER BY number',[task.exploration_id])).rows.map(r=>[Number(r.number),r.title])).toEqual([[1,null],[2,'复核目标完成情况']]);
});

it('tool loops remain one round and errors retain a numbered boundary with no invented direction',async()=>{
 const {task,f,input}=await fixture();
 f.setResponses([fauxAssistantMessage([fauxToolCall('context_search',{query:'LOCAL synthetic',limit:1})]),fauxAssistantMessage('<planning_title>复核本地已有证据</planning_title>\nNo new work.')]);
 await runPlannerRound({...input,planningRoundID:'tools'});expect(f.state.callCount).toBe(2);
 f.setResponses([fauxAssistantMessage('',{stopReason:'error',errorMessage:'LOCAL synthetic failure'})]);
 await expect(runPlannerRound({...input,planningRoundID:'failure'})).rejects.toThrow();
 const rows=(await db.query('SELECT number,title,finished_at FROM planner_display_rounds WHERE exploration_id=$1 ORDER BY number',[task.exploration_id])).rows;
 expect(rows.map(r=>Number(r.number))).toEqual([1,2]);expect(rows[1]?.title).toBeNull();expect(rows[1]?.finished_at).toBeTruthy();
});

it('cancelled admission does not allocate a display round or call the model',async()=>{
 const {task,f,input}=await fixture(),controller=new AbortController();controller.abort('LOCAL cancelled');
 await expect(runPlannerRound({...input,planningRoundID:'cancelled-before-start',signal:controller.signal})).rejects.toThrow();
 expect(f.state.callCount).toBe(0);
 expect((await db.query('SELECT * FROM planner_display_rounds WHERE exploration_id=$1',[task.exploration_id])).rows).toHaveLength(0);
});
