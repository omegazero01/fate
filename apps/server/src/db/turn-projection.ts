import type {StreamScope} from '../engine/live-stream.js';
import {activityMetadataSQL} from './activity-content.js';
import {selectedUsageCTE,USAGE_SUM_SQL} from './usage-ledger.js';
import {TURN_REVISIONS_CTE} from './turn-read-versions.js';
import {turnResponseAppendCTEs} from './turn-response-append.js';
import {incrementalReceiptCTEs} from './usage-rollups.js';

export const TURN_MODEL_PAGE_SIZE=64;
const number=(u:string,key:string)=>`COALESCE((${u}->>'${key}')::numeric,0)`;
const total=(u:string)=>['input','output','cacheRead','cacheWrite'].map(k=>number(u,k)).join('+');

/** Revalidate a complete cached page while its derived indexes catch up.
 * Heartbeat renewals intentionally do not change data revisions, so runtime
 * expiry/finish fields and observation time must still come from this snapshot. */
export function turnReferenceRefreshSQL(){return `WITH ${TURN_REVISIONS_CTE},
 previous AS (SELECT * FROM jsonb_to_recordset($5::jsonb) p(turn_id text,projection_revision text,runtime_id text))
 SELECT p.turn_id,statement_timestamp() observed_at,
  CASE WHEN rt.id IS NOT NULL THEN jsonb_build_object('id',rt.id,'role',rt.role,'finished_at',rt.finished_at,'expires_at',rt.expires_at,'stop_reason',rt.effective->>'stop_reason') END runtime
 FROM previous p JOIN static_versions v USING(turn_id) LEFT JOIN boundaries b USING(turn_id)
 LEFT JOIN runtime_role_configs rt ON rt.id=p.runtime_id
 WHERE p.projection_revision=v.fingerprint||':'||COALESCE(b.boundary::text,'')
  AND ($1<>'task' OR EXISTS(SELECT 1 FROM tasks WHERE id=$2 AND exploration_id=$4 AND deleted_at IS NULL))`;}

// Shared by the complete projection and receipt-only refresh. Canonical source
// priority, ambiguous legacy intervals and model order must use one definition.
function receiptProjectionCTEs(identity:string,seed:string){return `${selectedUsageCTE(identity,seed)},
 attempts AS MATERIALIZED (
  SELECT r.turn_id owner_turn,c.* FROM canonical c JOIN turn_runtimes r ON r.runtime_id=c.runtime_id
 ), attempt_stats AS (
  SELECT owner_turn,count(*) n,max(finished_at) updated_at,
   count(*) FILTER(WHERE purpose='compaction') compaction_requests,
   COALESCE(sum(${total('usage')}) FILTER(WHERE purpose='compaction'),0) compaction_tokens,
   count(*) FILTER(WHERE status IN ('failed','aborted')) failed_requests,
   COALESCE(sum(${total('usage')}) FILTER(WHERE status IN ('failed','aborted')),0) failed_tokens,
   bool_or(status='running' OR quality NOT IN ('complete','not_sent') OR COALESCE((usage->>'unavailable')::boolean,false)
    OR usage='{}'::jsonb OR status IN ('failed','aborted') AND (${total('usage')})=0) incomplete
  FROM attempts GROUP BY owner_turn
 ), covered_runtimes AS MATERIALIZED (SELECT DISTINCT owner_turn,runtime_id FROM attempts WHERE runtime_id IS NOT NULL),
 turn_usage AS (SELECT turn_id,${USAGE_SUM_SQL} FROM measured WHERE turn_id=ANY($3::text[]) GROUP BY turn_id)`;}
function modelProjectionCTEs(table:string,native:boolean){return `model_rows AS (
  SELECT owner_turn turn_id,model,row_number() OVER(PARTITION BY owner_turn ORDER BY created_at,request_id) position FROM attempts
  ${native?`  UNION ALL
  SELECT r.turn_id,a.metadata#>>'{response,model}',row_number() OVER(PARTITION BY r.turn_id ORDER BY first_id)
  FROM responses r JOIN ${table} a ON a.id=r.id WHERE r.metadata->'response'->>'provider' IS DISTINCT FROM 'series-router'
   AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.owner_turn=r.turn_id)`:""}
 ), model_changes AS (
  SELECT *,lag(model) OVER(PARTITION BY turn_id ORDER BY position) previous FROM model_rows
 ), model_sequence AS MATERIALIZED (
  SELECT turn_id,model,row_number() OVER(PARTITION BY turn_id ORDER BY position)-1 ordinal
  FROM model_changes WHERE model IS NOT NULL AND model<>'' AND model IS DISTINCT FROM previous
 ), model_page AS (
  SELECT turn_id,count(*) total,
   COALESCE(jsonb_agg(left(model,256) ORDER BY ordinal) FILTER(WHERE ordinal>=$5 AND ordinal<$5+$6),'[]') models,
   COALESCE(jsonb_agg(char_length(model) ORDER BY ordinal) FILTER(WHERE ordinal>=$5 AND ordinal<$5+$6),'[]') model_name_lengths,
   COALESCE(bool_or(char_length(model)>256) FILTER(WHERE ordinal>=$5 AND ordinal<$5+$6),false) names_truncated
  FROM model_sequence GROUP BY turn_id
 )`;}
const ledgerUsageProjection=`jsonb_build_object(
   'input',tu.input_tokens,'uncached_input',tu.uncached_input_tokens,'output',tu.output_tokens,'cache_read',tu.cache_read_tokens,'cache_write',tu.cache_write_tokens,
   'total',tu.input_tokens+tu.output_tokens,'incomplete',NOT tu.usage_complete,'source','usage_ledger','compaction_requests',tu.compaction_calls,
   'compaction_tokens',COALESCE(ast.compaction_tokens,0),'failed_requests',tu.failed_calls,'failed_request_tokens',COALESCE(ast.failed_tokens,0))`;

/** Recompute receipt-dependent fields, retaining unchanged activity aggregates
 * or applying a fenced append delta. Only new native response/tool metadata and
 * indexed original identities are read. Unbound fallback cases return no row.
 * This is component reuse, not constant-cost receipt aggregation: canonical
 * receipt selection still scans the relevant execution/legacy boundaries. */
export function turnUsageRefreshSQL(scope:StreamScope,incremental=false){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':'';
 const identity=`${scope==='task'?'task_id':'conversation_id'}=$2`;
 const seed='turn_id IN (SELECT turn_id FROM usage_eligible) OR runtime_id IN (SELECT runtime_id FROM turn_runtimes)';
 return `WITH ${TURN_REVISIONS_CTE},
 ${turnResponseAppendCTEs(scope)}, turn_runtimes AS MATERIALIZED (
  SELECT DISTINCT e.turn_id,m->>'runtime_id' runtime_id FROM usage_eligible e CROSS JOIN LATERAL (
   SELECT a.metadata FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id
    AND a.metadata->>'event_type'='turn_start' ${allowed} OFFSET 0
  ) a CROSS JOIN LATERAL (SELECT ${activityMetadataSQL('a.metadata')} m OFFSET 0) projected
  WHERE m->>'runtime_id' IS NOT NULL
 ), ${incremental?incrementalReceiptCTEs(scope):`${receiptProjectionCTEs(identity,seed)}, ${modelProjectionCTEs(table,false)}`},
 receipt_refresh AS (
  SELECT e.turn_id,e.data_revision,e.activity_version,e.rewrite_version,e.activity_fingerprint,e.control_fingerprint,e.stable_fingerprint,e.append_fingerprint,
   ap.append_rows,ap.steps_added,ap.tools_added,ap.errors_added,ap.append_response,ap.response_first_id,
   statement_timestamp() observed_at,${incremental?'ir.attempt_updated_at':'ast.updated_at attempt_updated_at'},
   CASE WHEN rt.id IS NOT NULL THEN jsonb_build_object('id',rt.id,'role',rt.role,'finished_at',rt.finished_at,'expires_at',rt.expires_at,'stop_reason',rt.effective->>'stop_reason') END runtime,
   ${incremental?'ir.models,ir.model_name_lengths,ir.models_total,ir.model_names_truncated,ir.usage':`COALESCE(mp.models,'[]') models,COALESCE(mp.model_name_lengths,'[]') model_name_lengths,COALESCE(mp.total,0) models_total,COALESCE(mp.names_truncated,false) model_names_truncated,${ledgerUsageProjection} usage`}
  FROM usage_eligible e ${incremental?'JOIN incremental_receipts ir USING(turn_id)':'JOIN attempt_stats ast ON ast.owner_turn=e.turn_id JOIN turn_usage tu USING(turn_id)'}
  JOIN append_projection ap USING(turn_id)
  ${incremental?'':'LEFT JOIN model_page mp USING(turn_id)'} LEFT JOIN runtime_role_configs rt ON rt.id=e.runtime_id
  ${incremental?'':'WHERE tu.calls+tu.legacy_records>0'}
 ) SELECT * FROM receipt_refresh`;
}

/** One MVCC snapshot. Only control rows/scalars and one model page cross the
 * connection; activities, evidence bodies and request receipts stay authoritative.
 * Params: scope, task/conversation ID, turns, exploration/conversation ID,
 * model offset and page size (display pagination, never a model/run budget). */
export function turnProjectionSQL(scope:StreamScope,view:'summary'|'name'='summary'){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':'';
 const identity=`${scope==='task'?'task_id':'conversation_id'}=$2`;
 const seed=`turn_id=ANY($3::text[]) OR runtime_id IN (SELECT runtime_id FROM turn_runtimes)`;
 const m=activityMetadataSQL('a.metadata');
 return `WITH ${TURN_REVISIONS_CTE},
 base AS MATERIALIZED (
  SELECT a.id,a.kind,a.tool_use_id,a.is_error,a.worker,a.created_at,a.metadata->>'turn_id' turn_id,
   jsonb_strip_nulls(jsonb_build_object('event_type',m->'event_type','runtime_id',m->'runtime_id',
    'stream_id',m->'stream_id','final_answer',m->'final_answer','raw_source_only',m->'raw_source_only','response',m->'response')) metadata
  -- Keep the bounded metadata expression evaluated once per row. Inlining it
  -- into every selected key repeatedly serialized the same large JSON value.
  FROM ${table} a CROSS JOIN LATERAL (SELECT ${m} m OFFSET 0) projected
  WHERE a.${column}=$4 AND a.metadata->>'turn_id'=ANY($3::text[]) ${allowed}
 ), ordered AS MATERIALIZED (
  SELECT *,max(id) FILTER(WHERE metadata->>'event_type'='turn_start') OVER(PARTITION BY turn_id ORDER BY id) start_id FROM base
 ), turn_runtimes AS MATERIALIZED (
  SELECT DISTINCT turn_id,metadata->>'runtime_id' runtime_id FROM base WHERE metadata->>'event_type'='turn_start' AND metadata->>'runtime_id' IS NOT NULL
 ), response_versions AS (
  SELECT *,min(id) OVER(PARTITION BY turn_id,metadata->>'stream_id') first_id,
   row_number() OVER(PARTITION BY turn_id,metadata->>'stream_id' ORDER BY id DESC) position
  FROM base WHERE metadata->>'stream_id' IS NOT NULL AND metadata->>'stream_id'<>''
   AND metadata->'response' IS NOT NULL AND metadata->'response' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
 ), responses AS MATERIALIZED (SELECT * FROM response_versions WHERE position=1),
 last_response AS (SELECT DISTINCT ON(turn_id) turn_id,id,first_id FROM responses ORDER BY turn_id,first_id DESC),
 last_start AS (SELECT DISTINCT ON(turn_id) turn_id,metadata->>'runtime_id' runtime_id FROM base WHERE metadata->>'event_type'='turn_start' ORDER BY turn_id,id DESC),
 ${receiptProjectionCTEs(identity,seed)},
 native_fallback AS (
  SELECT o.turn_id,o.metadata->'response'->'usage' usage FROM ordered o JOIN attempt_stats ast ON ast.owner_turn=o.turn_id
  LEFT JOIN ${table} s ON s.id=o.start_id
  LEFT JOIN covered_runtimes cr ON cr.owner_turn=o.turn_id AND cr.runtime_id=(${activityMetadataSQL('s.metadata')})->>'runtime_id'
  WHERE o.metadata->>'stream_id' IS NOT NULL AND o.metadata->>'stream_id'<>'' AND o.metadata->'response' IS NOT NULL
   AND o.metadata->'response' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
   AND cr.runtime_id IS NULL
 ), fallback_usage AS (
  SELECT owner_turn turn_id,usage FROM attempts
  UNION ALL SELECT turn_id,usage FROM native_fallback
  UNION ALL SELECT r.turn_id,r.metadata->'response'->'usage' FROM responses r WHERE NOT EXISTS(SELECT 1 FROM attempts a WHERE a.owner_turn=r.turn_id)
 ), fallback_totals AS (
  SELECT turn_id,bool_or(usage ?| ARRAY['input','output','cacheRead','cacheWrite']) known,
   COALESCE(sum(${number('usage','input')}),0) input,COALESCE(sum(${number('usage','output')}),0) output,
   COALESCE(sum(${number('usage','cacheRead')}),0) cache_read,COALESCE(sum(${number('usage','cacheWrite')}),0) cache_write
  FROM fallback_usage f WHERE NOT EXISTS(SELECT 1 FROM turn_usage t WHERE t.turn_id=f.turn_id AND t.calls+t.legacy_records>0) GROUP BY turn_id
 ), ${modelProjectionCTEs(table,true)}, counts AS (
  SELECT turn_id,count(DISTINCT NULLIF(tool_use_id,'')) FILTER(WHERE kind='tool_use') tools,
   count(DISTINCT NULLIF(tool_use_id,'')) FILTER(WHERE kind='tool_result' AND is_error) errors,
   min(id) first_id,max(id) last_id,min(id) FILTER(WHERE metadata->>'event_type'='turn_start') start_id,
   max(id) FILTER(WHERE metadata->>'event_type' IN ('lifecycle','outcome')) terminal_id,
   max(id) FILTER(WHERE metadata->>'event_type'='runner_settled') native_end_id,
   max(id) FILTER(WHERE metadata->'final_answer' IS NOT NULL AND metadata->'final_answer' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
    AND (metadata->'raw_source_only' IS NULL OR metadata->'raw_source_only' IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb))
    AND metadata->>'event_type' IS DISTINCT FROM 'steering') explicit_id,
   min(id) FILTER(WHERE kind='user' AND metadata->>'event_type' IS DISTINCT FROM 'steering') requested_id,
   max(id) FILTER(WHERE metadata->>'event_type' IN ('planner_round_start','planner_round_title')) planner_id,
   min(id) FILTER(WHERE worker='planner') planner_witness_id
  FROM base GROUP BY turn_id
 ), legacy_round AS (
  SELECT min(a.id) id,b.turn_id FROM base b JOIN ${table} a ON a.id=b.id
  WHERE b.worker='planner' AND b.kind='round' AND left(a.summary,4000) ~ '^第\\s*[1-9][0-9]*\\s*轮规划(\\s|$|[·：:—-])'
   AND length(substring(left(a.summary,4000) FROM '^第\\s*([1-9][0-9]*)'))<=16
   AND CASE WHEN length(substring(left(a.summary,4000) FROM '^第\\s*([1-9][0-9]*)'))<=16
    THEN substring(left(a.summary,4000) FROM '^第\\s*([1-9][0-9]*)')::numeric<=9007199254740991 ELSE false END GROUP BY b.turn_id
 ), control_ids AS (
  SELECT c.turn_id,unnest(ARRAY[c.first_id,c.last_id,c.start_id,c.terminal_id,c.native_end_id,c.explicit_id,c.requested_id,c.planner_id,c.planner_witness_id,l.id,r.id]) id
  FROM counts c LEFT JOIN legacy_round l USING(turn_id) LEFT JOIN last_response r USING(turn_id)
 ), controls AS (
  SELECT DISTINCT ON(a.id) c.turn_id,a.id,a.worker,a.kind,a.tool_use_id,a.is_error,left(a.summary,4000) summary,
   ${activityMetadataSQL('a.metadata')} metadata,octet_length(a.metadata::text)>8192 metadata_truncated,a.created_at,
   ${scope==='task'?'a.node_id,a.main_seg':'NULL::bigint node_id,NULL::int main_seg'}
  FROM control_ids c JOIN ${table} a ON a.id=c.id ORDER BY a.id
 ), control_rows AS (SELECT turn_id,jsonb_agg(to_jsonb(c) ORDER BY id) rows FROM controls c GROUP BY turn_id),
 result AS (
 SELECT c.turn_id,c.first_id,cr.rows,c.tools,c.errors,(SELECT count(*) FROM responses x WHERE x.turn_id=c.turn_id) steps,
  (SELECT to_jsonb(x) FROM controls x JOIN last_response lr ON lr.id=x.id WHERE lr.turn_id=c.turn_id) response,
  (SELECT first_id FROM last_response lr WHERE lr.turn_id=c.turn_id) response_first_id,
  CASE WHEN rt.id IS NOT NULL THEN jsonb_build_object('id',rt.id,'role',rt.role,'finished_at',rt.finished_at,'expires_at',rt.expires_at,'stop_reason',rt.effective->>'stop_reason') END runtime,
  COALESCE(mp.models,'[]') models,COALESCE(mp.model_name_lengths,'[]') model_name_lengths,COALESCE(mp.total,0) models_total,COALESCE(mp.names_truncated,false) model_names_truncated,
  ast.updated_at attempt_updated_at,v.data_revision,v.activity_version,v.rewrite_version,v.control_fingerprint,v.activity_fingerprint,v.stable_fingerprint,v.append_fingerprint,
  v.fingerprint||':'||COALESCE(b.boundary::text,'') projection_revision,ls.runtime_id,statement_timestamp() observed_at,
  CASE WHEN COALESCE(tu.calls,0)+COALESCE(tu.legacy_records,0)>0 THEN ${ledgerUsageProjection}
  WHEN f.known THEN jsonb_build_object('input',f.input+f.cache_read+f.cache_write,'uncached_input',f.input,'output',f.output,'cache_read',f.cache_read,'cache_write',f.cache_write,
   'total',f.input+f.output+f.cache_read+f.cache_write,'incomplete',COALESCE(ast.incomplete,false),'source',CASE WHEN ast.n>0 THEN 'provider_audit' ELSE 'native_response' END,
   'compaction_requests',ast.compaction_requests,'compaction_tokens',ast.compaction_tokens,'failed_requests',ast.failed_requests,'failed_request_tokens',ast.failed_tokens) END usage
 FROM counts c JOIN control_rows cr USING(turn_id) LEFT JOIN last_start ls USING(turn_id)
 LEFT JOIN runtime_role_configs rt ON rt.id=ls.runtime_id LEFT JOIN model_page mp USING(turn_id)
 LEFT JOIN attempt_stats ast ON ast.owner_turn=c.turn_id LEFT JOIN turn_usage tu USING(turn_id)
 LEFT JOIN fallback_totals f USING(turn_id) LEFT JOIN static_versions v USING(turn_id) LEFT JOIN boundaries b USING(turn_id)
 ) ${view==='name'?`SELECT s.turn_id,substring(s.model FROM $7::int+1 FOR 8192) content,char_length(s.model) total_chars,v.data_revision FROM model_sequence s JOIN static_versions v USING(turn_id) WHERE ordinal=$5`:'SELECT * FROM result ORDER BY first_id'}`;
}
