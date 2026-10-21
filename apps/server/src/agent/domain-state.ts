import type {Database} from '../db/index.js';
import {resolveGraphNode} from '../db/graph_view.js';
import {searchContext,workerLaunchContext} from '../tools/context-read.js';
import {runContext,type AgentRole} from '../tools/context.js';
import {progressSummary,resultSummary,stopSummary} from './context-projection.js';

/** Read-only, currently authorized projection; never derive domain writes from a summary. */
export async function domainState(db:Database,role:string,taskID:number,intentID?:number) {
  const base={role,task_id:taskID||null,reads:'context_search/context_get',authorization:'重新执行前检查实时授权；此快照不授予权限'};
  if(!taskID)return base;
  const task=await db.tasks().getTask(taskID);
  if(!task)throw new Error('任务不存在，无法生成领域检查点');
  const ctx=runContext(db,taskID,task.exploration_id,role as AgentRole,{intentID});
  const status={...base,task_status:task.status};
  // These roles supply their pending reports/fixed finding snapshot through the caller.
  if(role==='reporter'||role==='retester')return status;
  if(role==='worker'){
    if(!intentID)throw new Error('Worker 缺少当前意图');
    const {node}=await resolveGraphNode(db,taskID,task.exploration_id,intentID);
    return {...status,intent:{ref:`node:${node.id}`,version:node.content_version,state:node.state,owner:node.owner,
      contract:'当前系统消息中的执行约定；详情按当前意图引用读取',
      progress:progressSummary(node.payload.progress),result:resultSummary(node.payload.execution_result),execution_stop:stopSummary(node.payload.execution_stop)},
      related:await workerLaunchContext(ctx,intentID)};
  }
  return {...status,context:await searchContext(ctx,{types:['goal','intent'],limit:8})};
}
