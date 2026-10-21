import type {ToolRunContext} from './context.js';
import type {Node} from '../db/exploration.js';

/** Worker writes descend from its intent. An explicitly bound Pentest writes
 * descend from a conversation hint, which can never enter the Worker queue. */
export async function writeOrigin(c:ToolRunContext):Promise<Node>{
 const store=c.db.exploration(c.expID);
 await c.db.query('SELECT pg_advisory_xact_lock($1)',[-c.expID]);
 if(c.intentID){
  await c.db.query('SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND id=$2 FOR UPDATE',[c.expID,c.intentID]);
  const intent=await store.getNode(c.intentID);
  if(!intent||intent.kind!=='intent'||intent.payload.cancelled_by_user===true)throw new Error('执行意图不存在或已取消');
  if(c.role==='worker'&&(intent.state!=='running'||!c.workerName||intent.owner!==c.workerName))throw new Error('意图未在当前 Worker 运行或归属已改变');
  if(intent.payload.execution_result)throw new Error('意图结果已提交，不能追加写回');
  return intent;
 }
 if(c.role==='mainagent'&&c.mainSegment!==undefined&&c.hooks.assertOwnership){
  await c.hooks.assertOwnership(c.db);
  if(!(await c.db.query('SELECT 1 FROM tasks WHERE id=$1 AND exploration_id=$2 AND deleted_at IS NULL',[c.taskID,c.expID])).rowCount)throw new Error('Main 任务上下文失效');
  const previous=(await c.db.query("SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='hint' AND payload->>'source_main_segment'=$2 ORDER BY id LIMIT 1",[c.expID,String(c.mainSegment)])).rows[0];
  const id=previous?Number(previous.id):await store.addNode('hint',{summary:`Main 会话分段 #${c.mainSegment} 的执行记录`,source_main_segment:c.mainSegment,source_task_id:c.taskID},0,'consumed','mainagent',[]);
  return (await store.getNode(id))!;
 }
 if(c.role!=='pentest'||!c.conversationID)throw new Error('图写回需要已领取意图或明确绑定任务的 Pentest 会话');
 const bound=await c.db.query(`SELECT c.id FROM conversations c JOIN tasks t ON t.id=c.task_id
  WHERE c.id=$1 AND c.task_id=$2 AND c.agent_key='pentest' AND t.exploration_id=$3 AND t.deleted_at IS NULL`,[c.conversationID,c.taskID,c.expID]);
 if(!bound.rowCount)throw new Error('Pentest 会话未绑定当前任务');
 const previous=(await c.db.query("SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='hint' AND payload->>'source_conversation_id'=$2 ORDER BY id LIMIT 1",[c.expID,String(c.conversationID)])).rows[0];
 const id=previous?Number(previous.id):await store.addNode('hint',{summary:`Pentest 会话 #${c.conversationID} 的独立执行记录`,source_conversation_id:c.conversationID},0,'consumed',`conversation#${c.conversationID}`,[]);
 return (await store.getNode(id))!;
}

export async function writeAnchors(c:ToolRunContext,origin:Node,explicit?:number[]){
 // A broad mandate is not evidence that every discovered/anchored asset is affected.
 if(explicit!==undefined&&(!Array.isArray(explicit)||explicit.some(id=>!Number.isSafeInteger(id)||id<=0)))throw new Error('asset_ids 需要有效正整数 ID 数组');
 const anchors=[...new Set(explicit??[])].sort((a,b)=>a-b);
 await c.db.taskScope().validateTaskAssets(c.taskID,anchors);
 return anchors;
}

/** Deprecated draft edits must never silently create a new published record. */
export function assertDirectWrite(args: object) {
 if ('replace_node_id' in args) throw new Error('replace_node_id 已停用；记录会直接发布，请复核后提交新的增量结论，不覆盖历史记录');
}

export function sourceFields(c:ToolRunContext,origin:Node){
 return origin.kind==='intent'?{from_intent:origin.id}:c.role==='mainagent'?{source_node_id:origin.id,source_main_segment:c.mainSegment,source_task_id:c.taskID}:{source_conversation_id:c.conversationID};
}
export function sameSource(c:ToolRunContext,origin:Node,p:Record<string,unknown>){
 return origin.kind==='intent'?Number(p.from_intent)===origin.id:c.role==='mainagent'?Number(p.source_node_id)===origin.id:Number(p.source_conversation_id)===c.conversationID;
}
