import type {StreamScope} from '../engine/live-stream.js';
import {activityMetadataSQL} from './activity-content.js';
import {TURN_REVISIONS_CTE} from './turn-read-versions.js';
import {canonicalRollupCTEs,rollupModelSelectionCTEs,rollupModelPageCTEs} from './usage-rollups.js';

/** Read only current authorized execution markers, selected transition refs and
 * the requested originals. No activity counts, receipt reaggregation or full
 * model names cross the connection. An unqualified turn returns no row so the
 * caller can retain the native or not-yet-indexed reference-compatible fallback.
 * Params match turnProjectionSQL: scope, scopeID, turns, activityID, model
 * offset, page size; name reads additionally take a Unicode character offset.
 */
export function turnModelPageSQL(scope:StreamScope,view:'page'|'name'='page'){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':'';
 return `WITH ${TURN_REVISIONS_CTE},usage_eligible AS MATERIALIZED (
  SELECT i.turn_id FROM ids i WHERE EXISTS(SELECT 1 FROM turn_read_initialized WHERE scope=$1 AND scope_id=$2 AND turn_id=i.turn_id)
 ),turn_runtimes AS MATERIALIZED (
  SELECT DISTINCT e.turn_id,m->>'runtime_id' runtime_id FROM usage_eligible e CROSS JOIN LATERAL (
   SELECT a.metadata FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id
    AND a.metadata->>'event_type'='turn_start' ${allowed} OFFSET 0
  ) a CROSS JOIN LATERAL (SELECT ${activityMetadataSQL('a.metadata')} m OFFSET 0) projected WHERE m->>'runtime_id' IS NOT NULL
 ),${canonicalRollupCTEs(scope,false,false)},${rollupModelSelectionCTEs()},${rollupModelPageCTEs(view==='page')},
 rollup_model_read AS (
  SELECT m.turn_id,v.data_revision,m.models_total,
  ${view==='page'?`COALESCE(p.models,'[]') models,COALESCE(p.model_name_lengths,'[]') model_name_lengths,COALESCE(p.truncated,false) model_names_truncated`:
   `l.request_id IS NOT NULL has_model,substring(l.model FROM $7::int+1 FOR 8192) content,char_length(l.model) total_chars`}
  FROM selected_model_views m JOIN static_versions v USING(turn_id)
  ${view==='page'?'LEFT JOIN model_page_values p USING(turn_id)':'LEFT JOIN model_page_refs p USING(turn_id) LEFT JOIN llm_usage_ledger l USING(request_id)'}
 ) SELECT * FROM rollup_model_read`;
}
