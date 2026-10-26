import type {Database} from '../db/index.js';
import type {Node} from '../db/exploration.js';

export type WorkerStopReason = 'completed'|'partial'|'blocked'|'missing_result'|'invalid_result'
  |'turn_limit'|'duration_limit'|'task_timeout'|'planner_terminated'|'main_terminated'|'user_cancelled'
  |'task_paused'|'intent_paused'|'task_completed'|'task_ended'|'service_shutdown'|'executor_stopped'
  |'lease_lost'|'executor_recovered'|'model_connection_error'|'model_error'|'aborted'|'operation_uncertain'|'basis_changed'|'basis_unavailable';

const labels:Record<WorkerStopReason,string> = {
  completed:'当前意图执行结束',partial:'已提交部分结果',blocked:'已提交阻塞结果',missing_result:'会话结束但未提交可验收结果',invalid_result:'结果验收失败',
  turn_limit:'模型请求轮数预算耗尽',duration_limit:'Worker 执行时间预算耗尽',task_timeout:'任务时间上限已到',
  planner_terminated:'Planner 终止当前意图',main_terminated:'Main 终止当前意图',user_cancelled:'用户取消当前意图',
  task_paused:'任务已暂停',intent_paused:'当前意图已暂停',task_completed:'任务目标已达成',task_ended:'任务已结束或删除',
  service_shutdown:'服务关闭',executor_stopped:'执行器已停止',lease_lost:'执行租约失效',executor_recovered:'原执行器不可用，由新租约恢复',
  model_connection_error:'模型连接失败',model_error:'模型或会话执行失败',aborted:'会话被中断（未提供原因）',
  operation_uncertain:'存在未核对的工具执行结果，已停止自动重放',
  basis_changed:'当前意图依据已变化，已停止新探测并结束收尾，待 Planner 重新评估',
  basis_unavailable:'当前意图依据已撤销或不可读，已停止新探测并结束收尾，待 Planner 重新评估',
};

export function failureReason(message:string):WorkerStopReason {
  return /connection error|fetch failed|ECONN|ETIMEDOUT|socket|network error/i.test(message)?'model_connection_error':'model_error';
}

/** A host receipt is not model evidence or an accepted execution_result. */
export async function workerStopReceipt(db:Database,expID:number,node:Node,reason:WorkerStopReason,attemptID:string,detail='') {
  const result=node.payload.execution_result as Record<string,unknown>|undefined;
  const finalIDs=result?(Array.isArray(result.publish_ids)?result.publish_ids:
    (Array.isArray(result.criteria)?result.criteria as {fact_ids:number[]}[]:[]).flatMap(c=>c.fact_ids)):null;
  const refs=await db.query(`SELECT DISTINCT n.id,n.content_version FROM exploration_edges e JOIN exploration_nodes n ON n.id=e.dst_id
    WHERE e.exploration_id=$1 AND e.src_id=$2 AND e.rel='yields' AND n.kind IN ('fact','finding')
    AND ($3::bigint[] IS NULL OR n.id=ANY($3))
    AND n.state='confirmed' AND exploration_node_readable($1,n.id) ORDER BY n.id LIMIT 40`,[expID,node.id,finalIDs]);
  const saved=(await db.query('SELECT progress FROM worker_checkpoints WHERE intent_id=$1',[node.id])).rows[0]?.progress;
  const progress=(saved??node.payload.progress) as Record<string,unknown>|undefined;
  const operations=(await db.query(`SELECT id,tool_name,status FROM worker_operations WHERE intent_id=$1
    AND status IN ('running','uncertain') ORDER BY id LIMIT 20`,[node.id])).rows.map(r=>({ref:`operation:${r.id}`,tool:r.tool_name,status:r.status}));
  const error=detail.replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]').slice(0,2000);
  const changedBasis=reason==='basis_changed'||reason==='basis_unavailable';
  const basis=(node.payload.contract as {basis?:{node_id:number}[]}|undefined)?.basis??[];
  const recovery=reason==='completed'?'':changedBasis
    ?`由 Planner 重新读取当前意图、依据 ${basis.map(b=>`node:${b.node_id}`).join(', ')||'引用'} 和已保存事实，核对最新版本及剩余条件后重新评估；Worker 不自行恢复探测。`
    :String(result?.remaining||('先读取当前意图、最新已保存观察及工具结果，核对未完成条件，不重复已完成操作。'+(progress?.next_step?' 较早检查点（可能已完成）：'+progress.next_step:progress?.blocker?' 阻塞：'+progress.blocker:''))).slice(0,2000);
  return {version:1,attempt_id:attemptID,reason,summary:labels[reason]+(error?`：${error}`:''),
    recorded_at:new Date().toISOString(),progress_at:progress?.updated_at??null,
    fact_refs:refs.rows.map(r=>({node_id:Number(r.id),version:Number(r.content_version)})),
    recovery:operations.length?'先用 context_get 读取未知操作 '+operations.map(o=>o.ref).join(', ')+'；核对实际结果后再恢复，不能盲目重做。':recovery,
    operations,accepted_result:false};
}
