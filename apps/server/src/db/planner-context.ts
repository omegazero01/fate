import type {Database} from './index.js';
import {authorizedNodes,graphSources} from './graph_view.js';
import {progressSummary,resultSummary,stopSummary} from '../agent/context-projection.js';

export async function pendingPlannerContext(db:Database,taskID:number,expID:number) {
  const events=(await db.query('SELECT id,node_id,kind FROM exploration_context_events WHERE exploration_id=$1 AND acknowledged_at IS NULL ORDER BY id LIMIT 200',[expID])).rows;
  const ids=[...new Set(events.flatMap(e=>e.node_id===null?[]:[Number(e.node_id)]))];
  const nodes=[];
  for(const source of [{taskID,expID},...await graphSources(db,taskID)]){
    const visible=await authorizedNodes(db,source.taskID,source.expID,await db.exploration(source.expID).nodesByIDs(ids));
    nodes.push(...visible.map(n=>({...n,source_task_id:source.taskID})));
  }
  const changes=[];
  const shown=new Set<number>();
  for(const n of nodes){
    const change={ref:`node:${n.id}`,source_task_id:n.source_task_id,version:n.content_version,kind:n.kind,state:n.state,
      summary:String(n.payload.summary??n.payload.text??'').slice(0,160),
      ...(['fact','finding'].includes(n.kind)?{observation_type:n.payload.observation_type??'unknown',writeback:n.payload.writeback??{scope_status:'legacy_unspecified'},scope_read:n.payload.scope?{ref:`node:${n.id}`,field:'/payload/scope',version:n.content_version}:undefined}:{}),progress:progressSummary(n.payload.progress),result:resultSummary(n.payload.execution_result),execution_stop:stopSummary(n.payload.execution_stop)};
    if(Buffer.byteLength(JSON.stringify([...changes,change]))>12*1024)break;
    changes.push(change);shown.add(n.id);
  }
  const visible=new Set(nodes.map(n=>n.id));
  // An omitted visible change stays pending. Never acknowledge a budget-truncated
  // tail merely because the underlying query read it. Unauthorized events carry no text.
  return {more:events.length>=200||nodes.some(n=>!shown.has(n.id)),ids:events.filter(e=>e.node_id===null||!visible.has(Number(e.node_id))||shown.has(Number(e.node_id))).map(e=>Number(e.id)),changes};
}

export async function acknowledgePlannerContext(db:Database,expID:number,roundID:string,ids:number[]) {
  await db.query('UPDATE exploration_context_events SET acknowledged_at=now() WHERE exploration_id=$1 AND id=ANY($2::bigint[]) AND acknowledged_at IS NULL',[expID,ids]);
  return true;
}
