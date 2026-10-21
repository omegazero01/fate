import type { Database } from './index.js';
import type { Node } from './exploration.js';

/** UI projection uses the same owning-task authorization as agent reads. */
export const TASK_GRAPH_CTE = `visible AS (
 SELECT n.*,t.id AS source_task_id,t.id<>$1 AS inherited
 FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
 WHERE t.deleted_at IS NULL AND (t.id=$1 OR t.id IN (SELECT source_task_id FROM task_relations WHERE task_id=$1))
 AND exploration_node_readable(n.exploration_id,n.id)
)`;

/** One-level, read-only inheritance. The owning task remains the authorization authority. */
export async function graphSources(db: Database, taskID: number): Promise<Array<{ taskID: number; expID: number }>> {
  const r = await db.query(`SELECT t.id,t.exploration_id FROM task_relations r JOIN tasks t ON t.id=r.source_task_id
    WHERE r.task_id=$1 AND t.deleted_at IS NULL ORDER BY t.id`, [taskID]);
  return r.rows.map(r => ({ taskID: Number(r.id), expID: Number(r.exploration_id) }));
}
export async function authorizedNodes(db: Database, taskID: number, expID: number, nodes: Node[]): Promise<Node[]> {
  if(!nodes.length)return [];
  const result=await db.query('SELECT n.id FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id WHERE t.id=$1 AND n.exploration_id=$2 AND n.id=ANY($3::bigint[]) AND exploration_node_readable($2,n.id)',[taskID,expID,nodes.map(n=>n.id)]);
  const allowed=new Set(result.rows.map(r=>Number(r.id)));
  return nodes.filter(n=>allowed.has(n.id));
}
export async function resolveGraphNode(db: Database, taskID: number, expID: number, nodeID: number) {
  for (const owner of [{ taskID, expID }, ...await graphSources(db, taskID)]) {
    const node = await db.exploration(owner.expID).getNode(nodeID);
    if (!node) continue;
    if (!(await authorizedNodes(db, owner.taskID, owner.expID, [node])).length) throw new Error('节点不属于有效任务');
    return { node, ...owner, inherited: owner.taskID !== taskID };
  }
  throw new Error(`节点 #${nodeID} 不存在或不属于本任务及直接来源任务`);
}
