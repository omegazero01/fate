import type {StreamScope} from '../engine/live-stream.js';
import {activityCurrentCTEs} from './activity-rollups.js';
import {canonicalRollupCTEs,rollupModelSelectionCTEs,rollupModelPageCTEs} from './usage-rollups.js';
import {turnControlReadCTEs} from './turn-projection-delta.js';

/** Explicit turn attribution and runtime ownership are independent historical
 * contracts. Neither a NULL nor a mismatched turn ID is repaired/inferred here.
 * All receipt sources, model refs, range sums and current controls are selected
 * in one MVCC snapshot. Missing/stale derived data returns no row. */
export function turnMixedProjectionSQL(scope:StreamScope){
 const table=scope==='task'?'activity':'conversation_activities';
 return `WITH ${activityCurrentCTEs(scope)},${canonicalRollupCTEs(scope,true,false)},
 ${rollupModelSelectionCTEs()},${rollupModelPageCTEs()},
 billed_elements AS (SELECT turn_id,i,sum(v) v FROM canonical_rollups CROSS JOIN LATERAL unnest(totals) WITH ORDINALITY x(v,i)
  WHERE turn_id IN(SELECT turn_id FROM qualified_turns) GROUP BY turn_id,i),
 billed_vectors AS (SELECT turn_id,array_agg(v ORDER BY i) totals FROM billed_elements GROUP BY turn_id),
 billed AS (SELECT b.*,EXISTS(SELECT 1 FROM canonical_rollups c WHERE c.turn_id=b.turn_id AND c.history_gap) history_gap FROM billed_vectors b),
 attempt_elements AS (SELECT owner_turn turn_id,i,sum(v) v FROM exact_rollups CROSS JOIN LATERAL unnest(attempt_totals) WITH ORDINALITY x(v,i) GROUP BY owner_turn,i),
 attempt_vectors AS (SELECT turn_id,array_agg(v ORDER BY i) totals FROM attempt_elements GROUP BY turn_id),
 attempts AS (SELECT owner_turn turn_id,bool_and(attempts_ready) ready,sum(totals[1]) n,max(finished_at) updated_at,
  sum(totals[8]) compaction_requests,sum(totals[9]) compaction_tokens,sum(totals[10]) failed_requests,sum(totals[11]) failed_tokens
  FROM exact_rollups GROUP BY owner_turn),
 uncovered AS MATERIALIZED (
  SELECT r.* FROM verified e JOIN turn_native_range_state s ON s.scope=$1 AND s.scope_id=$2 AND s.turn_id=e.turn_id
  JOIN turn_native_ranges r ON r.scope=s.scope AND r.scope_id=s.scope_id AND r.turn_id=s.turn_id
  WHERE s.ready AND s.activity_version=e.activity_version::bigint AND s.access_version=e.access_version
   AND NOT EXISTS(SELECT 1 FROM exact_rollups a WHERE a.owner_turn=e.turn_id AND a.runtime_id=r.runtime_id)
 ), range_elements AS (SELECT u.turn_id,i,sum(v) v FROM uncovered u CROSS JOIN LATERAL unnest(u.totals) WITH ORDINALITY x(v,i) GROUP BY u.turn_id,i),
 range_vectors AS (SELECT turn_id,array_agg(v ORDER BY i) totals FROM range_elements GROUP BY turn_id),
 native_current AS MATERIALIZED (
  SELECT e.turn_id,n.totals,n.models FROM verified e JOIN turn_native_rollups n ON n.scope=$1 AND n.scope_id=$2 AND n.turn_id=e.turn_id
   AND n.ready AND n.activity_version=e.activity_version::bigint AND n.access_version=e.access_version
  WHERE NOT EXISTS(SELECT 1 FROM attempts a WHERE a.turn_id=e.turn_id)
 ), native_models AS (
  SELECT n.turn_id,n.models models_total,COALESCE(p.models,'[]') models,COALESCE(p.lengths,'[]') lengths,COALESCE(p.truncated,false) truncated
  FROM native_current n LEFT JOIN LATERAL (
   SELECT jsonb_agg(left(a.metadata#>>'{response,model}',256) ORDER BY p.first_id) models,
    jsonb_agg(char_length(a.metadata#>>'{response,model}') ORDER BY p.first_id) lengths,
    bool_or(char_length(a.metadata#>>'{response,model}')>256) truncated FROM (
     SELECT first_id,last_id FROM turn_native_responses WHERE scope=$1 AND scope_id=$2 AND turn_id=n.turn_id AND transition ORDER BY first_id LIMIT $6 OFFSET $5
    ) p JOIN ${table} a ON a.id=p.last_id
  ) p ON true
 ), valid AS MATERIALIZED (
  SELECT e.*,b.totals billed,b.history_gap,a.n,a.updated_at,a.compaction_requests,a.compaction_tokens,a.failed_requests,a.failed_tokens,
   av.totals[6]>0 incomplete,
   CASE WHEN a.n>0 THEN native_values_add(av.totals,rv.totals,1) ELSE nc.totals END raw,
   COALESCE(m.models_total,nm.models_total) models_total,
   CASE WHEN a.n>0 THEN COALESCE(mp.models,'[]') ELSE nm.models END models,
   CASE WHEN a.n>0 THEN COALESCE(mp.model_name_lengths,'[]') ELSE nm.lengths END model_name_lengths,
   CASE WHEN a.n>0 THEN COALESCE(mp.truncated,false) ELSE nm.truncated END model_names_truncated
  FROM verified e JOIN qualified_turns q USING(turn_id)
  LEFT JOIN billed b USING(turn_id) LEFT JOIN attempts a USING(turn_id) LEFT JOIN attempt_vectors av USING(turn_id)
  LEFT JOIN range_vectors rv USING(turn_id) LEFT JOIN native_current nc USING(turn_id)
  LEFT JOIN selected_model_views m USING(turn_id) LEFT JOIN model_page_values mp USING(turn_id) LEFT JOIN native_models nm USING(turn_id)
  WHERE (a.n IS NULL AND nm.turn_id IS NOT NULL OR a.ready AND m.turn_id IS NOT NULL)
   AND (b.totals[1]>0 OR a.n IS NULL OR EXISTS(SELECT 1 FROM turn_native_range_state s WHERE s.scope=$1 AND s.scope_id=$2 AND s.turn_id=e.turn_id
    AND s.ready AND s.activity_version=e.activity_version::bigint AND s.access_version=e.access_version)
    AND NOT EXISTS(SELECT 1 FROM uncovered r WHERE r.turn_id=e.turn_id AND (r.dirty OR r.invalid>0)))
 ),${turnControlReadCTEs(scope,true)}, mixed_result AS (
  SELECT e.turn_id,'mixed' projection_source,c.first_id,c.rows,e.tools,e.errors,e.steps,e.response_first_id,
   (SELECT to_jsonb(x) FROM fresh_controls x WHERE x.turn_id=e.turn_id AND x.id=e.response_id) response,
   e.models,e.model_name_lengths,e.model_names_truncated,e.models_total,e.updated_at attempt_updated_at,
   CASE WHEN e.billed[1]>0 THEN jsonb_build_object('input',e.billed[2],'uncached_input',e.billed[3],'output',e.billed[4],
    'cache_read',e.billed[5],'cache_write',e.billed[6],'total',e.billed[2]+e.billed[4],'incomplete',e.billed[7]>0 OR e.history_gap,'source','usage_ledger',
    'compaction_requests',e.billed[8],'compaction_tokens',COALESCE(e.compaction_tokens,0),'failed_requests',e.billed[10],'failed_request_tokens',COALESCE(e.failed_tokens,0))
   WHEN e.raw[1]>0 THEN jsonb_build_object('input',e.raw[2]+e.raw[4]+e.raw[5],'uncached_input',e.raw[2],'output',e.raw[3],
    'cache_read',e.raw[4],'cache_write',e.raw[5],'total',e.raw[2]+e.raw[3]+e.raw[4]+e.raw[5],'incomplete',COALESCE(e.incomplete,false),
    'source',CASE WHEN e.n>0 THEN 'provider_audit' ELSE 'native_response' END,'compaction_requests',e.compaction_requests,'compaction_tokens',e.compaction_tokens,
    'failed_requests',e.failed_requests,'failed_request_tokens',e.failed_tokens) END usage,
   e.data_revision,e.activity_version,e.rewrite_version,e.control_fingerprint,e.activity_fingerprint,e.stable_fingerprint,e.append_fingerprint,
   ls.runtime_id,statement_timestamp() observed_at,
   CASE WHEN rt.id IS NOT NULL THEN jsonb_build_object('id',rt.id,'role',rt.role,'finished_at',rt.finished_at,'expires_at',rt.expires_at,'stop_reason',rt.effective->>'stop_reason') END runtime
  FROM valid e JOIN fresh_rows c USING(turn_id) LEFT JOIN last_start ls USING(turn_id) LEFT JOIN runtime_role_configs rt ON rt.id=ls.runtime_id
 ) SELECT * FROM mixed_result ORDER BY first_id`;
}
