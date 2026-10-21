import {workerStopReceipt} from '../engine/worker-outcome.js';
import type {Database} from './index.js';
import type {ToolRunContext} from '../tools/context.js';

/** Read-only compatibility for observations saved by the old private-draft workflow. */
export async function ownObservations(c:Pick<ToolRunContext,'db'|'role'|'intentID'|'expID'|'taskID'>,id?:number) {
  if(c.role!=='worker'||!c.intentID)return [];
  const intent=await c.db.exploration(c.expID).getNode(c.intentID);
  if(!intent)return [];
  const rows=(await c.db.query(`SELECT * FROM worker_observations WHERE exploration_id=$1 AND intent_id=$2 AND published_at IS NULL
    AND ($3::bigint IS NULL OR node_id=$3) ORDER BY node_id`,[c.expID,c.intentID,id??null])).rows;
  const visible=[];
  for(const row of rows){try{await c.db.taskScope().validateTaskAssets(c.taskID,row.asset_ids as number[]);visible.push(row);}catch{/* Revoked observations stay durable, but are not injected. */}}
  return visible;
}

/** Persist notification inside the finding transaction; readers wake only after commit. */
export async function findingPublished(db:Database,expID:number,nodeID:number) {
  await db.query(`INSERT INTO blackboard_wakeups(exploration_id,event_key,kind,node_id)
    VALUES($1,$2,'finding_published',$3) ON CONFLICT(exploration_id,event_key) DO NOTHING`,[expID,`finding:${nodeID}`,nodeID]);
  await db.query(`WITH saved AS (
    INSERT INTO blackboard_wakeups(exploration_id,event_key,kind,node_id)
    SELECT child.exploration_id,$2,'source_finding',$3 FROM task_relations r
    JOIN tasks source ON source.id=r.source_task_id JOIN tasks child ON child.id=r.task_id
    WHERE source.exploration_id=$1 AND child.deleted_at IS NULL
    ON CONFLICT(exploration_id,event_key) DO NOTHING RETURNING exploration_id
  ) UPDATE explorations SET published_revision=published_revision+1 WHERE id IN (SELECT exploration_id FROM saved)`,[expID,`finding:${nodeID}`,nodeID]);
}

export async function blackboardRevision(db:Database,expID:number) {
  // A per-graph counter serializes commits; sequence IDs alone are not commit order.
  return Number((await db.query('SELECT published_revision FROM explorations WHERE id=$1',[expID])).rows[0]?.published_revision??0);
}

/** Only release a durable event after the native session and its slot have exited. */
export async function markWorkerReleased(db:Database,expID:number,intentID:number) {
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock($1)',[-expID]);
    const active=await tx.query(`SELECT 1 FROM engine_worker_slots s JOIN engine_task_leases l
      ON l.task_id=s.task_id AND l.token=s.token AND l.expires_at>clock_timestamp() WHERE s.intent_id=$1 AND s.phase='running'`,[intentID]);
    if(active.rowCount)return;
    const node=await tx.exploration(expID).getNode(intentID);if(!node||node.state==='running')return;
    const pending=(await tx.query('SELECT * FROM worker_settlements WHERE intent_id=$1 AND released_at IS NULL ORDER BY created_at FOR UPDATE',[intentID])).rows;
    for(const settlement of pending){
      if(!settlement.activity_id){
        // Publication was already accepted in its atomic transaction. Recovery
        // records that historical decision; it never invokes the model again.
        const result=node.payload.execution_result as {outcome:'complete'|'partial'|'blocked';summary:string;remaining?:string};
        if(!result)throw new Error('已提交结算缺少原始结果');
        const receipt=await workerStopReceipt(tx,expID,node,result.outcome==='complete'?'completed':result.outcome,String(settlement.id));
        receipt.accepted_result=true;
        await tx.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('execution_stop',$2::jsonb) WHERE id=$1",[intentID,JSON.stringify(receipt)]);
        const id=await tx.exploration(expID).appendActivity({node_id:intentID,worker:String(settlement.worker),kind:'result',summary:result.summary,detail:result.summary,
          metadata:{turn_id:settlement.id,event_type:'outcome',status:node.state,execution_stop:receipt,recovered_settlement:true}});
        await tx.query('UPDATE worker_settlements SET activity_id=$2 WHERE id=$1',[settlement.id,id]);
      }
      await tx.query('UPDATE worker_settlements SET released_at=now() WHERE id=$1',[settlement.id]);
    }
    const receipt=node.payload.execution_stop as {attempt_id?:string;reason?:string}|undefined;
    if(receipt?.reason==='executor_recovered'||receipt?.reason==='lease_lost')return;
    const committedID=node.payload.execution_result?(await tx.query('SELECT id FROM worker_settlements WHERE intent_id=$1 ORDER BY created_at DESC LIMIT 1',[intentID])).rows[0]?.id:undefined;
    const eventID=committedID??receipt?.attempt_id;
    if(!eventID)return; // A failed claim or a recovered running intent is not a result.
    const inserted=await tx.query(`INSERT INTO blackboard_wakeups(exploration_id,event_key,kind,node_id) VALUES($1,$2,'worker_settled',$3)
      ON CONFLICT(exploration_id,event_key) DO NOTHING RETURNING id`,[expID,`worker:${intentID}:${eventID}`,intentID]);
    if(inserted.rowCount){
      await tx.query('UPDATE explorations SET published_revision=published_revision+1 WHERE id=$1',[expID]);
      // Direct linked tasks observe final source publication, never private work.
      await tx.query(`INSERT INTO blackboard_wakeups(exploration_id,event_key,kind,node_id)
        SELECT child.exploration_id,$2,'source_settled',$3 FROM task_relations r JOIN tasks source ON source.id=r.source_task_id JOIN tasks child ON child.id=r.task_id
        WHERE source.exploration_id=$1 AND child.deleted_at IS NULL ON CONFLICT(exploration_id,event_key) DO NOTHING`,[expID,`source:${expID}:${eventID}`,intentID]);
    }
  });
}

export async function recoverWorkerSettlements(db:Database,expID:number) {
  const rows=(await db.query(`SELECT DISTINCT intent_id FROM worker_settlements WHERE exploration_id=$1 AND released_at IS NULL
    UNION SELECT id AS intent_id FROM exploration_nodes n WHERE exploration_id=$1 AND kind='intent'
      AND state<>'running' AND payload->'execution_stop'->>'attempt_id' IS NOT NULL
      AND payload->'execution_stop'->>'reason' NOT IN ('executor_recovered','lease_lost')
      AND NOT EXISTS (SELECT 1 FROM blackboard_wakeups w WHERE w.exploration_id=$1
        AND w.event_key='worker:'||n.id||':'||(n.payload->'execution_stop'->>'attempt_id'))`,[expID])).rows;
  for(const row of rows)await markWorkerReleased(db,expID,Number(row.intent_id));
}
