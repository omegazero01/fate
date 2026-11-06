import type {Database} from './index.js';
import type {StreamScope} from '../engine/live-stream.js';
import {selectedUsageCTE} from './usage-ledger.js';
import {activityMetadataSQL} from './activity-content.js';

/** Initialize boundary references separately from execution-group locks. Live
 * writers hold usage/group locks before the legacy guard; this transaction
 * never takes those locks in reverse. Busy scopes keep the canonical fallback. */
export async function prepareLegacyIntervals(db:Database,scope:StreamScope,scopeID:number){
 await db.transaction(async tx=>{
  if((await tx.query('SELECT ready FROM usage_legacy_initialized WHERE scope=$1 AND scope_id=$2',[scope,scopeID])).rows[0]?.ready)return;
  if(!(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('usage-legacy-init:'||$1::text||':'||$2::text,0)) ok",[scope,scopeID])).rows[0]?.ok)return;
  await tx.query('INSERT INTO usage_legacy_initialized VALUES($1,$2,false) ON CONFLICT DO NOTHING',[scope,scopeID]);
  const guard=(await tx.query('SELECT ready FROM usage_legacy_initialized WHERE scope=$1 AND scope_id=$2 FOR UPDATE SKIP LOCKED',[scope,scopeID])).rows[0];
  if(!guard||guard.ready)return;
  await tx.query('DELETE FROM usage_legacy_intervals WHERE scope=$1 AND scope_id=$2',[scope,scopeID]);
  await tx.query(`INSERT INTO usage_legacy_intervals(scope,scope_id,domain_key,role,segment,request_id,created_at,previous_end,unbound)
   SELECT $1,$2,domain_key,role,COALESCE(main_seg::text,'null'),request_id,created_at,
    COALESCE(lag(created_at) OVER(PARTITION BY domain_key,role,main_seg ORDER BY created_at,request_id),'-infinity'::timestamptz),
    runtime_id IS NULL AND turn_id IS NULL FROM (
     SELECT *,COALESCE('conversation:'||conversation_id,'task:'||task_id,'platform') domain_key FROM llm_usage_ledger
     WHERE ${scope==='task'?'task_id':'conversation_id'}=$2 AND source='legacy_results'
    ) originals`,[scope,scopeID]);
  await tx.query('UPDATE usage_legacy_initialized SET ready=true WHERE scope=$1 AND scope_id=$2',[scope,scopeID]);
 });
}

/** Lazy read-model bootstrap, never a rewrite of receipts. Live writers take
 * the same group row lock after the existing usage-version locks; readers do
 * not acquire those version locks. Busy initialization is skipped, not queued.
 * Each pass initializes at most eight groups; incomplete groups use the full
 * reader until a later pass. */
export async function prepareUsageRollups(db:Database,scope:StreamScope,scopeID:number,turns:string[]):Promise<boolean>{
 await prepareLegacyIntervals(db,scope,scopeID);
 const identity=`${scope==='task'?'task_id':'conversation_id'}=$2`;
 const seed=`turn_id=ANY($3::text[]) OR runtime_id IN (SELECT target_key FROM turn_read_links WHERE scope=$1 AND scope_id=$2 AND relation='activity_runtime' AND source_key=ANY($3::text[]))`;
 return db.transaction(async tx=>{
  const lock=(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('usage-rollup-init:'||$1::text||':'||$2::text,0)) ok",[scope,scopeID])).rows[0]?.ok;
  if(!lock)return false;
  const missing=(await tx.query('SELECT t FROM unnest($3::text[]) t WHERE NOT EXISTS(SELECT 1 FROM turn_usage_rollup_initialized WHERE scope=$1 AND scope_id=$2 AND turn_id=t)',[scope,scopeID,turns])).rows.map(r=>String(r.t));
  if(missing.length){
   await tx.query(`WITH ${selectedUsageCTE(identity,seed)} INSERT INTO usage_execution_rollups(identity,task_id,conversation_id,scope_key,source_class,turn_id,runtime_id)
    SELECT DISTINCT usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id),task_id,conversation_id,scope_key,
     CASE WHEN source IN('provider','request_audit') THEN 'physical' ELSE source END,turn_id,runtime_id FROM selected_usage
    ORDER BY 1 ON CONFLICT DO NOTHING`,[scope,scopeID,missing]);
   await tx.query('INSERT INTO turn_usage_rollup_initialized SELECT $1::text,$2::bigint,t FROM unnest($3::text[]) t ON CONFLICT DO NOTHING',[scope,scopeID,missing]);
  }
  const pending=(await tx.query(`WITH keys AS MATERIALIZED (SELECT DISTINCT conversation_id,scope_key FROM usage_execution_rollups WHERE (${identity}) AND (${seed}))
   SELECT identity,ready,roles_ready,attempts_ready FROM usage_execution_rollups r WHERE (NOT ready OR NOT roles_ready OR NOT attempts_ready) AND (${identity}) AND EXISTS(SELECT 1 FROM keys k
    WHERE k.scope_key=r.scope_key AND k.conversation_id IS NOT DISTINCT FROM r.conversation_id)
   ORDER BY identity LIMIT 8 FOR UPDATE OF r SKIP LOCKED`,[scope,scopeID,turns])).rows;
  for(const {identity:rawKey,ready,roles_ready,attempts_ready} of pending){
   const key=JSON.stringify(rawKey); // pg otherwise encodes JS arrays as SQL arrays.
   if(!ready){
   await tx.query(`WITH receipts AS MATERIALIZED (SELECT *,usage_rollup_values(l) values FROM llm_usage_ledger l
     WHERE usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=$1::jsonb),
    vector AS (SELECT i,sum(v) n FROM receipts CROSS JOIN LATERAL unnest(values) WITH ORDINALITY u(v,i) GROUP BY i)
    UPDATE usage_execution_rollups SET totals=COALESCE((SELECT array_agg(n ORDER BY i) FROM vector),ARRAY[0,0,0,0,0,0,0,0,0,0,0]::numeric[]),
     finished_at=(SELECT max(finished_at) FROM receipts) WHERE identity=$1::jsonb`,[key]);
   await tx.query('DELETE FROM usage_model_transitions WHERE identity=$1::jsonb',[key]);
   await tx.query(`INSERT INTO usage_model_transitions SELECT $1::jsonb,request_id,created_at FROM (
    SELECT request_id,created_at,model,lag(model) OVER(ORDER BY created_at,request_id) previous FROM llm_usage_ledger
    WHERE usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=$1::jsonb) r
    WHERE model<>'' AND model IS DISTINCT FROM previous`,[key]);
   await tx.query('UPDATE usage_execution_rollups SET models=(SELECT count(*) FROM usage_model_transitions WHERE identity=$1::jsonb) WHERE identity=$1::jsonb',[key]);
   }
   if(!roles_ready){
    await tx.query('DELETE FROM usage_rollup_roles WHERE identity=$1::jsonb',[key]);
    await tx.query(`INSERT INTO usage_rollup_roles SELECT $1::jsonb,role,count(*) FROM llm_usage_ledger
     WHERE usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=$1::jsonb GROUP BY role`,[key]);
   }
   if(!attempts_ready){
    await tx.query(`WITH receipts AS MATERIALIZED (SELECT usage_attempt_values(l) values FROM llm_usage_ledger l
     WHERE usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=$1::jsonb),
     vector AS (SELECT i,sum(v) n FROM receipts CROSS JOIN LATERAL unnest(values) WITH ORDINALITY x(v,i) GROUP BY i)
     UPDATE usage_execution_rollups SET attempt_totals=COALESCE((SELECT array_agg(n ORDER BY i) FROM vector),ARRAY[0,0,0,0,0,0]::numeric[]),
      attempts_ready=NOT EXISTS(SELECT 1 FROM receipts WHERE values IS NULL) WHERE identity=$1::jsonb`,[key]);
   }
   await tx.query('UPDATE usage_execution_rollups SET ready=true,roles_ready=true WHERE identity=$1::jsonb',[key]);
  }
  // No dependent count/model/range index can qualify while a selected group is
  // still partial. Avoid repeatedly traversing the full execution dependency
  // graph only to discover that downstream initialization cannot begin yet.
  const pendingMore=(await tx.query(`WITH keys AS MATERIALIZED (SELECT DISTINCT conversation_id,scope_key FROM usage_execution_rollups WHERE (${identity}) AND (${seed}))
   SELECT 1 FROM usage_execution_rollups r WHERE (NOT ready OR NOT roles_ready OR NOT attempts_ready) AND (${identity}) AND EXISTS(SELECT 1 FROM keys k
    WHERE k.scope_key=r.scope_key AND k.conversation_id IS NOT DISTINCT FROM r.conversation_id) LIMIT 1`,[scope,scopeID,turns])).rowCount;
  if(pendingMore)return false;
  await prepareTurnModelViews(tx,scope,scopeID,turns);return true;
 });
}

/** Canonical group selection is shared by bootstrap and live reads. Legacy
 * interval references preserve uncertainty without recounting raw history. */
export function canonicalRollupCTEs(scope:StreamScope,includeHistoryGap=true,strictOwnership=true){
 const identity=`${scope==='task'?'task_id':'conversation_id'}=$2`;
 return `rollup_keys AS MATERIALIZED (
  SELECT DISTINCT conversation_id,scope_key FROM usage_execution_rollups WHERE (${identity}) AND
   (turn_id IN(SELECT turn_id FROM usage_eligible) OR runtime_id IN(SELECT runtime_id FROM turn_runtimes))
 ), selected_rollups AS MATERIALIZED (
  SELECT r.* FROM usage_execution_rollups r WHERE (${identity}) AND EXISTS(SELECT 1 FROM rollup_keys k
   WHERE k.scope_key=r.scope_key AND k.conversation_id IS NOT DISTINCT FROM r.conversation_id)
 ), rollup_scopes AS MATERIALIZED (
  SELECT conversation_id,scope_key,bool_and(ready AND roles_ready) ready,
   COALESCE(sum(totals[1]) FILTER(WHERE source_class='physical'),0) physicals,
   COALESCE(sum(totals[1]) FILTER(WHERE source_class='native_response'),0) natives,
   COALESCE(sum(totals[1]) FILTER(WHERE source_class='legacy_results'),0) legacies,
   ${includeHistoryGap?`bool_or(CASE WHEN source_class='physical' AND roles_ready AND totals[1]>0 THEN
    usage_rollup_legacy_overlap(identity,$1,$2,COALESCE('conversation:'||conversation_id,'task:'||task_id,'platform')) ELSE false END)`:'false'} legacy_gap
  FROM selected_rollups GROUP BY conversation_id,scope_key
 ), canonical_rollups AS MATERIALIZED (
  SELECT r.*,(s.natives>s.physicals OR s.legacy_gap) AND s.physicals>0 history_gap FROM selected_rollups r JOIN rollup_scopes s
   ON s.scope_key=r.scope_key AND s.conversation_id IS NOT DISTINCT FROM r.conversation_id
  WHERE s.ready AND r.totals[1]>0 AND r.source_class=CASE WHEN s.physicals>0 THEN 'physical'
   WHEN s.legacies>0 THEN 'legacy_results' ELSE 'native_response' END
 ), rollup_owners AS MATERIALIZED (
  SELECT t.turn_id owner_turn,r.* FROM canonical_rollups r JOIN turn_runtimes t USING(runtime_id)
 ), qualified_turns AS MATERIALIZED (
  SELECT e.turn_id FROM usage_eligible e WHERE
   ${strictOwnership?`EXISTS(SELECT 1 FROM rollup_owners o WHERE o.owner_turn=e.turn_id)
   AND NOT EXISTS(SELECT 1 FROM rollup_owners o WHERE o.owner_turn=e.turn_id AND o.turn_id IS DISTINCT FROM o.owner_turn)
   AND NOT EXISTS(SELECT 1 FROM canonical_rollups r WHERE r.turn_id=e.turn_id AND NOT EXISTS(
    SELECT 1 FROM rollup_owners o WHERE o.owner_turn=e.turn_id AND o.identity=r.identity)) AND`:''}
   NOT EXISTS(SELECT 1 FROM rollup_scopes s WHERE NOT s.ready)
   AND EXISTS(SELECT 1 FROM usage_legacy_initialized WHERE scope=$1 AND scope_id=$2 AND ready)
   AND EXISTS(SELECT 1 FROM turn_usage_rollup_initialized WHERE scope=$1 AND scope_id=$2 AND turn_id=e.turn_id)
 ), exact_rollups AS MATERIALIZED (
  SELECT o.* FROM rollup_owners o JOIN qualified_turns q ON q.turn_id=o.owner_turn
 )`;
}

async function prepareTurnModelViews(tx:Database,scope:StreamScope,scopeID:number,turns:string[]){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const activityID=scope==='task'?Number((await tx.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[scopeID])).rows[0]?.exploration_id):scopeID;
 if(!Number.isSafeInteger(activityID))return;
 const selections=(await tx.query(`WITH usage_eligible AS (SELECT unnest($3::text[]) turn_id),turn_runtimes AS MATERIALIZED (
  SELECT DISTINCT e.turn_id,m->>'runtime_id' runtime_id FROM usage_eligible e CROSS JOIN LATERAL (
   SELECT metadata FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id AND a.metadata->>'event_type'='turn_start'
    ${scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':''}
  ) a CROSS JOIN LATERAL (SELECT ${activityMetadataSQL('a.metadata')} m OFFSET 0) projected WHERE m->>'runtime_id' IS NOT NULL
 ),${canonicalRollupCTEs(scope,true,false)}, selections AS (
  SELECT owner_turn turn_id,jsonb_agg(identity ORDER BY identity) selection FROM exact_rollups GROUP BY owner_turn
 ) SELECT s.* FROM selections s LEFT JOIN usage_turn_model_views v ON v.scope=$1 AND v.scope_id=$2 AND v.turn_id=s.turn_id
 WHERE (jsonb_array_length(s.selection)>1 AND v.selection IS DISTINCT FROM s.selection) OR (jsonb_array_length(s.selection)=1 AND v.turn_id IS NOT NULL)
 ORDER BY s.turn_id LIMIT 8`,[scope,scopeID,turns,activityID])).rows;
 for(const row of selections){
  const selection=row.selection as unknown[],serialized=JSON.stringify(selection),turn=String(row.turn_id);
  // Match live writer lock order, without holding a connection in a lock queue.
  const locked=await tx.query('SELECT identity FROM usage_execution_rollups WHERE identity IN(SELECT value FROM jsonb_array_elements($1::jsonb)) ORDER BY identity FOR UPDATE SKIP LOCKED',[serialized]);
  if(locked.rowCount!==selection.length)continue;
  const exists=(await tx.query('SELECT 1 FROM usage_turn_model_views WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',[scope,scopeID,turn])).rowCount;
  if(exists&&!(await tx.query('SELECT 1 FROM usage_turn_model_views WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 FOR UPDATE SKIP LOCKED',[scope,scopeID,turn])).rowCount)continue;
  if(selection.length===1){
   await tx.query('DELETE FROM usage_turn_model_members WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',[scope,scopeID,turn]);
   await tx.query('DELETE FROM usage_turn_model_transitions WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',[scope,scopeID,turn]);
   await tx.query('DELETE FROM usage_turn_model_views WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',[scope,scopeID,turn]);continue;
  }
  await tx.query(`INSERT INTO usage_turn_model_views(scope,scope_id,turn_id,selection) VALUES($1,$2,$3,$4)
   ON CONFLICT(scope,scope_id,turn_id) DO UPDATE SET selection=EXCLUDED.selection`,[scope,scopeID,turn,serialized]);
  await tx.query('DELETE FROM usage_turn_model_members WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',[scope,scopeID,turn]);
  await tx.query('INSERT INTO usage_turn_model_members SELECT $1::text,$2::bigint,$3::text,value FROM jsonb_array_elements($4::jsonb)',[scope,scopeID,turn,serialized]);
  await tx.query('DELETE FROM usage_turn_model_transitions WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',[scope,scopeID,turn]);
  await tx.query(`INSERT INTO usage_turn_model_transitions SELECT $1::text,$2::bigint,$3::text,request_id,created_at FROM (
   SELECT l.request_id,l.created_at,l.model,lag(l.model) OVER(ORDER BY l.created_at,l.request_id) previous
   FROM usage_turn_model_members m JOIN llm_usage_ledger l ON usage_rollup_key(l.task_id,l.conversation_id,l.scope_key,l.source,l.turn_id,l.runtime_id)=m.identity
   WHERE m.scope=$1 AND m.scope_id=$2 AND m.turn_id=$3) changes WHERE model<>'' AND model IS DISTINCT FROM previous`,[scope,scopeID,turn]);
  await tx.query(`UPDATE usage_turn_model_views SET models=(SELECT count(*) FROM usage_turn_model_transitions WHERE scope=$1 AND scope_id=$2 AND turn_id=$3)
   WHERE scope=$1 AND scope_id=$2 AND turn_id=$3`,[scope,scopeID,turn]);
 }
}

export function rollupModelSelectionCTEs(){return `turn_rollup_meta AS MATERIALIZED (
  SELECT owner_turn turn_id,jsonb_agg(identity ORDER BY identity) selection,count(*) groups,sum(models) single_models,
   max(finished_at) attempt_updated_at,bool_or(history_gap) history_gap FROM exact_rollups GROUP BY owner_turn
 ), selected_model_views AS MATERIALIZED (
  SELECT m.*,CASE WHEN m.groups=1 THEN m.single_models ELSE v.models END models_total FROM turn_rollup_meta m
  LEFT JOIN usage_turn_model_views v ON v.scope=$1 AND v.scope_id=$2 AND v.turn_id=m.turn_id AND v.selection=m.selection
  WHERE m.groups=1 OR v.turn_id IS NOT NULL
 )`;}

export function rollupModelPageCTEs(includeValues=true){return `model_page_refs AS MATERIALIZED (
  SELECT r.turn_id,p.* FROM selected_model_views r CROSS JOIN LATERAL (
   SELECT request_id,created_at FROM usage_model_transitions WHERE r.groups=1 AND identity=r.selection->0 ORDER BY created_at,request_id LIMIT $6 OFFSET $5
  ) p
  UNION ALL
  SELECT r.turn_id,p.* FROM selected_model_views r CROSS JOIN LATERAL (
   SELECT request_id,created_at FROM usage_turn_model_transitions WHERE r.groups>1 AND scope=$1 AND scope_id=$2 AND turn_id=r.turn_id ORDER BY created_at,request_id LIMIT $6 OFFSET $5
  ) p
 )${includeValues?`, model_page_values AS (
  SELECT p.turn_id,jsonb_agg(left(l.model,256) ORDER BY p.created_at,p.request_id) models,
   jsonb_agg(char_length(l.model) ORDER BY p.created_at,p.request_id) model_name_lengths,bool_or(char_length(l.model)>256) truncated
  FROM model_page_refs p JOIN llm_usage_ledger l USING(request_id) GROUP BY p.turn_id
 )`:''}`;}

export function incrementalReceiptCTEs(scope:StreamScope){
 return `${canonicalRollupCTEs(scope)},${rollupModelSelectionCTEs()},vector_elements AS (
  SELECT owner_turn turn_id,i,sum(v) value FROM exact_rollups CROSS JOIN LATERAL unnest(totals) WITH ORDINALITY u(v,i) GROUP BY owner_turn,i
 ), turn_vectors AS (SELECT turn_id,array_agg(value ORDER BY i) totals FROM vector_elements GROUP BY turn_id),
 ${rollupModelPageCTEs()}, incremental_receipts AS (
  SELECT r.turn_id,r.attempt_updated_at,r.models_total,COALESCE(m.models,'[]') models,
   COALESCE(m.model_name_lengths,'[]') model_name_lengths,COALESCE(m.truncated,false) model_names_truncated,
   jsonb_build_object('input',v.totals[2],'uncached_input',v.totals[3],'output',v.totals[4],'cache_read',v.totals[5],'cache_write',v.totals[6],
    'total',v.totals[2]+v.totals[4],'incomplete',v.totals[7]>0 OR r.history_gap,'source','usage_ledger',
    'compaction_requests',v.totals[8],'compaction_tokens',v.totals[9],'failed_requests',v.totals[10],'failed_request_tokens',v.totals[11]) usage
  FROM selected_model_views r JOIN turn_vectors v USING(turn_id) LEFT JOIN model_page_values m USING(turn_id)
 )`;
}
