import type {Database} from './index.js';
import type {StreamScope} from '../engine/live-stream.js';
import {activityCurrentCTEs} from './activity-rollups.js';
import {canonicalRollupCTEs} from './usage-rollups.js';
import {turnControlReadCTEs} from './turn-projection-delta.js';

function nativeCandidates(scope:StreamScope){return `${activityCurrentCTEs(scope)},${canonicalRollupCTEs(scope,false)},
 native_candidates AS MATERIALIZED (
  SELECT e.* FROM verified e WHERE NOT EXISTS(SELECT 1 FROM rollup_owners o WHERE o.owner_turn=e.turn_id)
   AND NOT EXISTS(SELECT 1 FROM rollup_scopes WHERE NOT ready)
   AND EXISTS(SELECT 1 FROM turn_usage_rollup_initialized WHERE scope=$1 AND scope_id=$2 AND turn_id=e.turn_id)
 )`;}

/** The same activity guard orders bootstrap with original activity writers.
 * No original response or model name is stored twice. Failed/obsolete index
 * publication remains unreadable and leaves the canonical reader available. */
export async function prepareNativeRollups(db:Database,scope:StreamScope,scopeID:number,activityID:number,turns:string[]){
 const table=scope==='task'?'activity':'conversation_activities';
 const pending=(await db.query(`WITH ${nativeCandidates(scope)} SELECT e.turn_id FROM native_candidates e
  LEFT JOIN turn_native_rollups n ON n.scope=$1 AND n.scope_id=$2 AND n.turn_id=e.turn_id
  WHERE n.turn_id IS NULL OR NOT n.ready OR n.activity_version<>e.activity_version::bigint OR n.access_version<>e.access_version
  ORDER BY e.turn_id LIMIT 8`,[scope,scopeID,turns,activityID])).rows;
 for(const {turn_id:turn} of pending)await db.transaction(async tx=>{
  const args=[scope,scopeID,turn],params=[scope,scopeID,[turn],activityID];
  if(!(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('activity-rollup:'||$1::text||':'||$2::text||':'||$3::text,0)) ok",args)).rows[0]?.ok)return;
  const base=(await tx.query(`WITH ${nativeCandidates(scope)} SELECT * FROM native_candidates`,params)).rows[0];if(!base)return;
  await tx.query('INSERT INTO turn_native_rollups(scope,scope_id,turn_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',args);
  const guard=(await tx.query('SELECT * FROM turn_native_rollups WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 FOR UPDATE SKIP LOCKED',args)).rows[0];
  if(!guard||guard.ready&&String(guard.activity_version)===String(base.activity_version)&&guard.access_version===base.access_version)return;
  await tx.query('DELETE FROM turn_native_responses WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',args);
  await tx.query(`WITH originals AS MATERIALIZED (
   SELECT g.*,native_response_values(m) values,(m#>>'{response,provider}') IS DISTINCT FROM 'series-router' visible,
    a.metadata#>>'{response,model}' model FROM turn_activity_groups g JOIN ${table} a ON a.id=g.last_id
    CROSS JOIN LATERAL (SELECT activity_presentation_metadata(a.metadata) m OFFSET 0) projected
    WHERE g.scope=$1 AND g.scope_id=$2 AND g.turn_id=$3 AND g.category='response'
   ), neighbors AS (SELECT id,lag(model) OVER(ORDER BY first_id) previous FROM originals WHERE visible)
   INSERT INTO turn_native_responses(group_id,scope,scope_id,turn_id,key_hash,key_text,first_id,last_id,totals,model_visible,transition)
   SELECT o.id,o.scope,o.scope_id,o.turn_id,o.key_hash,o.key_text,o.first_id,o.last_id,o.values,o.visible,
    o.visible AND o.model IS NOT NULL AND o.model<>'' AND o.model IS DISTINCT FROM n.previous
   FROM originals o LEFT JOIN neighbors n USING(id) WHERE o.values IS NOT NULL`,args);
  await tx.query(`WITH sums AS (SELECT i,sum(v) v FROM turn_native_responses CROSS JOIN LATERAL unnest(totals) WITH ORDINALITY x(v,i)
   WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 GROUP BY i)
   UPDATE turn_native_rollups SET totals=COALESCE((SELECT array_agg(v ORDER BY i) FROM sums),ARRAY[0,0,0,0,0]::numeric[]),
    models=(SELECT count(*) FROM turn_native_responses WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 AND transition),
    activity_version=$4,access_version=$5,
    ready=($6::bigint=(SELECT count(*) FROM turn_native_responses WHERE scope=$1 AND scope_id=$2 AND turn_id=$3)
     AND $5::bigint=COALESCE((SELECT version FROM turn_read_versions WHERE scope=$1 AND scope_id=$2 AND kind='access' AND entity='all'),0))
   WHERE scope=$1 AND scope_id=$2 AND turn_id=$3`,[...args,base.activity_version,base.access_version,base.steps]);
 });
}

/** Summary usage requires no selected canonical receipt. Model-only reads can
 * also serve explicitly billed turns without any runtime-owned attempts. */
export function turnNativeProjectionSQL(scope:StreamScope,view:'summary'|'page'|'name'='summary'){
 const table=scope==='task'?'activity':'conversation_activities';
 const common=`WITH ${nativeCandidates(scope)},native_current AS MATERIALIZED (
  SELECT e.*,n.models models_total,n.totals FROM native_candidates e JOIN turn_native_rollups n ON n.scope=$1 AND n.scope_id=$2 AND n.turn_id=e.turn_id
  WHERE n.ready AND n.activity_version=e.activity_version::bigint AND n.access_version=e.access_version
   ${view==='summary'?'AND NOT EXISTS(SELECT 1 FROM canonical_rollups r WHERE r.turn_id=e.turn_id)':''}
 ),native_page_refs AS MATERIALIZED (
  SELECT e.turn_id,p.first_id,p.last_id FROM native_current e CROSS JOIN LATERAL (
   SELECT first_id,last_id FROM turn_native_responses WHERE scope=$1 AND scope_id=$2 AND turn_id=e.turn_id AND transition
    ORDER BY first_id LIMIT $6 OFFSET $5
  ) p
 )`;
 if(view==='name')return `${common} SELECT e.turn_id,e.data_revision,a.id IS NOT NULL has_model,
  substring(a.metadata#>>'{response,model}' FROM $7::int+1 FOR 8192) content,char_length(a.metadata#>>'{response,model}') total_chars
  FROM native_current e LEFT JOIN native_page_refs p USING(turn_id) LEFT JOIN ${table} a ON a.id=p.last_id`;
 const pages=`native_page AS (
  SELECT p.turn_id,jsonb_agg(left(a.metadata#>>'{response,model}',256) ORDER BY p.first_id) models,
   jsonb_agg(char_length(a.metadata#>>'{response,model}') ORDER BY p.first_id) model_name_lengths,
   bool_or(char_length(a.metadata#>>'{response,model}')>256) model_names_truncated
  FROM native_page_refs p JOIN ${table} a ON a.id=p.last_id GROUP BY p.turn_id
 ), native_models AS (SELECT e.turn_id,e.data_revision,e.models_total,COALESCE(p.models,'[]') models,
  COALESCE(p.model_name_lengths,'[]') model_name_lengths,COALESCE(p.model_names_truncated,false) model_names_truncated
  FROM native_current e LEFT JOIN native_page p USING(turn_id))`;
 if(view==='page')return `${common},${pages} SELECT * FROM native_models`;
 return `${common},${pages},${turnControlReadCTEs(scope,true)},native_activity_result AS (
  SELECT e.turn_id,'native' projection_source,c.first_id,c.rows,e.tools,e.errors,e.steps,e.response_first_id,
   (SELECT to_jsonb(x) FROM fresh_controls x WHERE x.turn_id=e.turn_id AND x.id=e.response_id) response,
   p.models,p.model_name_lengths,p.model_names_truncated,p.models_total,NULL::timestamptz attempt_updated_at,
   CASE WHEN e.totals[1]>0 THEN jsonb_build_object('input',e.totals[2]+e.totals[4]+e.totals[5],'uncached_input',e.totals[2],'output',e.totals[3],
    'cache_read',e.totals[4],'cache_write',e.totals[5],'total',e.totals[2]+e.totals[3]+e.totals[4]+e.totals[5],'incomplete',false,'source','native_response',
    'compaction_requests',NULL,'compaction_tokens',NULL,'failed_requests',NULL,'failed_request_tokens',NULL) END usage,
   e.data_revision,e.activity_version,e.rewrite_version,e.control_fingerprint,e.activity_fingerprint,e.stable_fingerprint,e.append_fingerprint,
   ls.runtime_id,statement_timestamp() observed_at,
   CASE WHEN rt.id IS NOT NULL THEN jsonb_build_object('id',rt.id,'role',rt.role,'finished_at',rt.finished_at,'expires_at',rt.expires_at,'stop_reason',rt.effective->>'stop_reason') END runtime
  FROM native_current e JOIN fresh_rows c USING(turn_id) JOIN native_models p USING(turn_id)
  LEFT JOIN last_start ls USING(turn_id) LEFT JOIN runtime_role_configs rt ON rt.id=ls.runtime_id
 ) SELECT * FROM native_activity_result ORDER BY first_id`;
}
