// Apply a reviewed JSON plan to an idle/paused task. No model or target requests.
// Usage: pnpm exec tsx scripts/apply-constraint-correction.mts /absolute/plan.json [--apply]
import {readFileSync} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {Database} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {migrateConstraintProvenance} from '../src/db/constraint-provenance.js';
import {applyConstraintCorrection,type ConstraintCorrection} from '../src/db/constraint-correction.js';

const file=process.argv[2];
if(!file||!path.isAbsolute(file))throw new Error('提供已审查修正计划的绝对路径；默认只预览，--apply 才写入');
const plan=JSON.parse(readFileSync(file,'utf8')) as ConstraintCorrection;
const db=new Database(new pg.Pool({connectionString:postgresDSN().dsn}));
try {
  if(process.argv.includes('--apply')){
    await migrateConstraintProvenance(db);
    console.log(JSON.stringify(await applyConstraintCorrection(db,plan)));
  }else{
    const task=await db.tasks().getTask(plan.taskID);
    console.log(JSON.stringify({dry_run:true,key:plan.key,task_id:plan.taskID,status:task?.status,paused:task?.paused,
      constraint_ids:plan.constraints.map(c=>c.id),node_ids:plan.nodes.map(n=>n.id),reason:plan.reason,
      note:'执行前必须暂停/结束任务并等待执行器退出；实际写入重新校验原文、约束及事实版本。'},null,2));
  }
}finally{await db.close();}
