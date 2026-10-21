import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {openDatabase,type Database} from './index.js';
import {applyConstraintCorrection,correctionTaskHash,type ConstraintCorrection} from './constraint-correction.js';
const name=`fate_constraint_correction_${process.pid}`;let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db?.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name}`);await c.end();});
async function fixture(){
  const task=await db.tasks().createTaskWithOptions('目标：http://fixture.invalid/\n\n禁止爆破。','发现问题',{executionMode:'manual'});
  const row=(await db.query(`INSERT INTO task_constraints(exploration_id,kind,text,origin) VALUES($1,'allow','仅允许 fixture.invalid:80','goals') RETURNING id`,[task.exploration_id])).rows[0]!;
  await db.query(`INSERT INTO task_constraints(exploration_id,kind,text,origin) VALUES($1,'deny','用户手动要求','user')`,[task.exploration_id]);
  const id=await db.exploration(task.exploration_id).addNode('fact',{summary:'越界，未执行',evidence:'原始证据'},0,'confirmed','work#1',[]);
  const node=(await db.exploration(task.exploration_id).getNode(id))!;
  const plan:ConstraintCorrection={key:`fixture-${task.id}`,taskID:task.id,sourceHash:correctionTaskHash(task),reason:'已审查：模型自行添加限制',
    constraints:[{id:Number(row.id),kind:'allow',text:'仅允许 fixture.invalid:80',origin:'goals'}],
    replacements:[{kind:'deny',text:'禁止爆破。'}],
    nodes:[{id,version:node.content_version??0,state:'confirmed',summary:'越界，未执行',nextSummary:'旧越界判断无原文依据，未执行，结果未知',dismiss:true}]};
  return {task,plan,id};
}
it('corrects only reviewed records atomically, preserves raw evidence and does not resume work',async()=>{
  const {task,plan,id}=await fixture();await db.query("UPDATE tasks SET status='running',paused=true WHERE id=$1",[task.id]);
  expect(await applyConstraintCorrection(db,plan)).toMatchObject({applied:true,nodes_corrected:1});
  expect(await applyConstraintCorrection(db,plan)).toMatchObject({already_applied:true});
  expect((await db.tasks().getTask(task.id))?.paused).toBe(true);
  expect((await db.exploration(task.exploration_id).getNode(id))).toMatchObject({state:'dismissed',payload:{evidence:'原始证据',policy_correction:{original_summary:'越界，未执行'}}});
  expect((await db.query('SELECT text FROM task_constraints WHERE exploration_id=$1 ORDER BY id',[task.exploration_id])).rows.map(r=>r.text)).toEqual(['用户手动要求','禁止爆破。']);
  const snapshot=(await db.query('SELECT before_snapshot FROM constraint_correction_audit WHERE key=$1',[plan.key])).rows[0]!.before_snapshot as {nodes:unknown[]};
  expect(snapshot.nodes).toHaveLength(1);
});
it('rejects active tasks and stale reviews without partial deletion',async()=>{
  const {task,plan,id}=await fixture();await db.query("UPDATE tasks SET status='running',paused=false WHERE id=$1",[task.id]);
  await expect(applyConstraintCorrection(db,plan)).rejects.toThrow('暂停');
  await db.query('UPDATE tasks SET paused=true WHERE id=$1',[task.id]);
  await db.query(`UPDATE exploration_nodes SET payload=payload||'{"summary":"人工新结论"}'::jsonb WHERE id=$1`,[id]);
  await expect(applyConstraintCorrection(db,plan)).rejects.toThrow('事实版本');
  expect((await db.query('SELECT 1 FROM task_constraints WHERE id=$1',[plan.constraints[0]!.id])).rowCount).toBe(1);
  expect((await db.query('SELECT 1 FROM constraint_correction_audit WHERE key=$1',[plan.key])).rowCount).toBe(0);
});
