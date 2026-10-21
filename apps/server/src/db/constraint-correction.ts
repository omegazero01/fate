import type {Database} from './index.js';
import {constraintSourceHash,groundConstraint,type ConstraintInput} from '../agent/constraint-policy.js';

export interface ConstraintCorrection {
  key:string; taskID:number; sourceHash:string; reason:string;
  constraints:{id:number;kind:string;text:string;origin:string}[];
  replacements:ConstraintInput[];
  nodes:{id:number;version:number;state:string;summary:string;nextSummary:string;dismiss?:boolean}[];
}
export const correctionTaskHash=(task:{description:string;goal:string})=>constraintSourceHash(JSON.stringify([task.description,task.goal]));

/** Explicitly reviewed correction only; never infer policy from arbitrary graph prose.
 * Requires a quiescent task and exact before-values; leaves task and intents stopped. */
export async function applyConstraintCorrection(db:Database,plan:ConstraintCorrection) {
  return db.transaction(async tx=>{
    if(!plan.key.trim()||!plan.reason.trim())throw new Error('修正必须有唯一编号及审查原因');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`constraint-correction:${plan.key}`]);
    const old=(await tx.query('SELECT task_id FROM constraint_correction_audit WHERE key=$1',[plan.key])).rows[0];
    if(old){if(Number(old.task_id)!==plan.taskID)throw new Error('修正编号所属任务不匹配');return {applied:false,already_applied:true};}
    const task=(await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[plan.taskID])).rows[0];
    if(!task)throw new Error('任务不存在');
    if(correctionTaskHash({description:String(task.description),goal:String(task.goal)})!==plan.sourceHash)throw new Error('用户原文已变化，请重新审查');
    if(task.status==='running'&&!task.paused)throw new Error('修正要求任务暂停或已结束，不会自动暂停或重启执行');
    if((await tx.query(`SELECT 1 FROM runtime_role_configs WHERE task_id=$1 AND finished_at IS NULL AND expires_at>now()
      UNION ALL SELECT 1 FROM engine_worker_slots WHERE task_id=$1 LIMIT 1`,[plan.taskID])).rowCount)throw new Error('任务仍有活跃执行器，等待退出后重试');
    const expID=Number(task.exploration_id);
    await tx.query('SELECT pg_advisory_xact_lock($1)',[expID]);
    const rows=(await tx.query('SELECT * FROM task_constraints WHERE exploration_id=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE',[expID,plan.constraints.map(c=>c.id)])).rows;
    if(rows.length!==plan.constraints.length)throw new Error('约束已变化，请重新审查');
    for(const item of plan.constraints){
      const row=rows.find(r=>Number(r.id)===item.id);
      if(!row||row.kind!==item.kind||row.text!==item.text||row.origin!==item.origin)throw new Error('约束内容已变化，请重新审查');
    }
    const grounded=plan.replacements.map(c=>groundConstraint(c,{description:String(task.description),goal:String(task.goal)}));
    const nodes=(await tx.query('SELECT * FROM exploration_nodes WHERE exploration_id=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE',[expID,plan.nodes.map(n=>n.id)])).rows;
    if(nodes.length!==plan.nodes.length)throw new Error('节点已变化，请重新审查');
    for(const item of plan.nodes){
      const row=nodes.find(n=>Number(n.id)===item.id),payload=row?.payload as Record<string,unknown>|undefined;
      if(!row||row.kind!=='fact'||Number(row.content_version)!==item.version||row.state!==item.state||payload?.summary!==item.summary)
        throw new Error('事实版本已变化，请重新审查');
    }
    await tx.query('INSERT INTO constraint_correction_audit(key,task_id,before_snapshot,correction) VALUES($1,$2,$3::jsonb,$4::jsonb)',
      [plan.key,plan.taskID,JSON.stringify({constraints:rows,nodes}),JSON.stringify(plan)]);
    await tx.query('DELETE FROM task_constraints WHERE exploration_id=$1 AND id=ANY($2::bigint[])',[expID,plan.constraints.map(c=>c.id)]);
    for(const c of grounded)await tx.query(`INSERT INTO task_constraints(exploration_id,kind,text,origin,source) VALUES($1,$2,$3,'review',$4::jsonb)`,
      [expID,c.kind,c.text,JSON.stringify(c.source)]);
    for(const n of plan.nodes)await tx.query(`UPDATE exploration_nodes SET state=$2,payload=payload||$3::jsonb,updated_at=now() WHERE id=$1 AND exploration_id=$4`,
      [n.id,n.dismiss?'dismissed':n.state,JSON.stringify({summary:n.nextSummary,policy_correction:{key:plan.key,reason:plan.reason,original_summary:n.summary,original_state:n.state,constraint_ids:plan.constraints.map(c=>c.id),untested_is_unknown:true}}),expID]);
    // Existing graph/control triggers invalidate stale context; historical raw activities stay intact.
    return {applied:true,already_applied:false,constraints_replaced:rows.length,nodes_corrected:nodes.length};
  });
}
