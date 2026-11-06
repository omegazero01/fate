import type {StreamScope} from '../engine/live-stream.js';
import {legacyPlannerNumber} from './planner-rounds.js';
import {activityMetadataSQL} from './activity-content.js';
import {TURN_REVISIONS_CTE} from './turn-read-versions.js';

type Row=Record<string,any>;
export const TURN_DELTA_ROWS=64;
/** Cached control rows are a lossless sufficient set for projectTurn, not a
 * transcript. New plain activity can change only the last row/tool counts.
 * Always keep original first, control, response and Planner witness rows. */
export function retainTurnControls(rows:Row[],response?:Row){
 const kept=new Set<Row|undefined>([rows[0],rows.at(-1),
  rows.find(r=>r.metadata?.event_type==='turn_start'),
  rows.findLast(r=>['lifecycle','outcome'].includes(r.metadata?.event_type)),
  rows.findLast(r=>r.metadata?.event_type==='runner_settled'),
  rows.findLast(r=>r.metadata?.final_answer&&!r.metadata?.raw_source_only&&r.metadata?.event_type!=='steering'),
  rows.find(r=>r.kind==='user'&&r.metadata?.event_type!=='steering'),
  rows.findLast(r=>['planner_round_start','planner_round_title'].includes(r.metadata?.event_type)),
  rows.find(r=>r.worker==='planner'),rows.find(r=>legacyPlannerNumber(r)!==null),
  rows.find(r=>response&&String(r.id)===String(response.id)),
 ]);
 return rows.filter(r=>kept.has(r));
}

/** Shared bounded current controls. Input relation supplies turn_id and response_id;
 * IDs are selected from current authorized originals, not cached transcripts. */
export function turnControlReadCTEs(scope:StreamScope,indexedBounds=false){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=(alias:string)=>scope==='task'?`AND exploration_activity_readable($4,${alias}.node_id,${alias}.metadata)`:'';
 const meta=activityMetadataSQL('a.metadata');
 const truthy=(value:string)=>`${value} IS NOT NULL AND ${value} NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)`;
 // Same field retention as activityMetadataSQL, without expanding its entire
 // projection repeatedly into the first/last selectors. Fixed event names are
 // always retained; oversized unknown event names cannot equal those names.
 const field=(key:string)=>`(CASE WHEN octet_length(a.metadata::text)<=8192 OR octet_length((a.metadata->'${key}')::text)<=2048 THEN a.metadata->'${key}' END)`;
 const point=(where:string,order='ASC')=>`(SELECT a.id FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id ${allowed('a')} ${where?'AND '+where:''} ORDER BY a.id ${order} LIMIT 1)`;
 const event=(name:string,order='DESC')=>point(`a.metadata ? 'event_type' AND left(a.metadata->>'event_type',64)='${name}' AND a.metadata->>'event_type'='${name}'`,order);
 const legacy=`a.worker='planner' AND a.kind='round' AND left(a.summary,4000) ~ '^第\\s*[1-9][0-9]*\\s*轮规划(\\s|$|[·：:—-])'
  AND length(substring(left(a.summary,4000) FROM '^第\\s*([1-9][0-9]*)'))<=16
  AND CASE WHEN length(substring(left(a.summary,4000) FROM '^第\\s*([1-9][0-9]*)'))<=16
   THEN substring(left(a.summary,4000) FROM '^第\\s*([1-9][0-9]*)')::numeric<=9007199254740991 ELSE false END`;
 return `selected AS MATERIALIZED (
  SELECT e.turn_id,unnest(ARRAY[${indexedBounds?'e.first_activity_id':point('')},${indexedBounds?'e.last_activity_id':point('','DESC')},${event('turn_start','ASC')},${event('lifecycle')},${event('outcome')},${event('runner_settled')},
   ${point(`a.metadata ? 'final_answer' AND ${truthy(field('final_answer'))} AND NOT (${truthy(field('raw_source_only'))}) AND a.metadata->>'event_type' IS DISTINCT FROM 'steering'`,'DESC')},
   ${point("a.kind='user' AND a.metadata->>'event_type' IS DISTINCT FROM 'steering'")},${event('planner_round_start')},${event('planner_round_title')},
   ${point("a.worker='planner'")},${point(legacy)},e.response_id]) id FROM verified e
 ), fresh_controls AS (
  SELECT DISTINCT ON(a.id) s.turn_id,a.id,a.worker,a.kind,a.tool_use_id,a.is_error,left(a.summary,4000) summary,
   ${meta} metadata,octet_length(a.metadata::text)>8192 metadata_truncated,a.created_at,
   ${scope==='task'?'a.node_id,a.main_seg':'NULL::bigint node_id,NULL::int main_seg'}
  FROM selected s CROSS JOIN LATERAL (
   SELECT a.* FROM ${table} a WHERE a.id=s.id AND a.${column}=$4 AND a.metadata->>'turn_id'=s.turn_id ${allowed('a')} LIMIT 1
  ) a ORDER BY a.id
 ), fresh_rows AS (SELECT turn_id,min(id) first_id,jsonb_agg(to_jsonb(c) ORDER BY id) rows FROM fresh_controls c GROUP BY turn_id)`;
}

/** Re-select presentation controls after an edit/delete or terminal transition.
 * The data fence excludes only runtime/presentation changes: native responses,
 * tool identity edits, access changes and billing still invalidate this path.
 * Counts and model/usage aggregates therefore stay authoritative without a
 * scan of the whole turn. Each control is an indexed first/last selection.
 * The insert counter check also detects commits below the old ID cursor.
 */
export function turnControlDeltaSQL(scope:StreamScope){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=(alias:string)=>scope==='task'?`AND exploration_activity_readable($4,${alias}.node_id,${alias}.metadata)`:'';
 const toolProbe=(kind:string,error=false)=>`SELECT count(*) FROM (SELECT DISTINCT d.tool_use_id FROM changed_rows d WHERE d.turn_id=e.turn_id AND d.kind='${kind}' ${error?'AND d.is_error':''} AND d.tool_use_id IS NOT NULL AND d.tool_use_id<>'') calls
  LEFT JOIN LATERAL (SELECT true found FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id AND a.kind='${kind}' ${error?'AND a.is_error':''}
   AND md5(a.tool_use_id)=md5(calls.tool_use_id) AND a.tool_use_id=calls.tool_use_id AND a.id<=e.last_id ${allowed('a')} LIMIT 1) prior ON true WHERE prior.found IS NULL`;
 return `WITH ${TURN_REVISIONS_CTE},
 previous AS (SELECT * FROM jsonb_to_recordset($5::jsonb) AS p(turn_id text,last_id bigint,activity_version bigint,rewrite_version bigint,control_fingerprint text,runtime_id text,response_id bigint)),
 eligible AS MATERIALIZED (
  SELECT p.*,v.data_revision,v.activity_version current_activity_version,v.rewrite_version current_rewrite_version,v.stable_fingerprint,v.activity_fingerprint,v.append_fingerprint,
   (v.activity_version::bigint-p.activity_version)-(v.rewrite_version::bigint-p.rewrite_version) added
  FROM previous p JOIN static_versions v USING(turn_id) WHERE v.control_fingerprint=p.control_fingerprint
   AND v.activity_version::bigint>=p.activity_version AND v.rewrite_version::bigint>=p.rewrite_version
   AND (v.activity_version::bigint-p.activity_version)-(v.rewrite_version::bigint-p.rewrite_version) BETWEEN 0 AND ${TURN_DELTA_ROWS}
 ), changed_rows AS MATERIALIZED (
  SELECT e.turn_id,a.* FROM eligible e CROSS JOIN LATERAL (
   SELECT a.id,a.kind,a.tool_use_id,a.is_error FROM ${table} a
   WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id AND a.id>e.last_id ${allowed('a')} ORDER BY a.id LIMIT ${TURN_DELTA_ROWS+1}
  ) a
 ), verified AS MATERIALIZED (
  SELECT e.* FROM eligible e WHERE (SELECT count(*) FROM changed_rows d WHERE d.turn_id=e.turn_id)=e.added
 ), ${turnControlReadCTEs(scope)}
 SELECT e.turn_id,c.first_id,c.rows,e.data_revision,e.current_activity_version activity_version,e.current_rewrite_version rewrite_version,e.control_fingerprint,e.activity_fingerprint,e.stable_fingerprint,e.append_fingerprint,
  statement_timestamp() observed_at,(${toolProbe('tool_use')}) tools_added,(${toolProbe('tool_result',true)}) errors_added,
  CASE WHEN rt.id IS NOT NULL THEN jsonb_build_object('id',rt.id,'role',rt.role,'finished_at',rt.finished_at,'expires_at',rt.expires_at,'stop_reason',rt.effective->>'stop_reason') END runtime
 FROM verified e JOIN fresh_rows c USING(turn_id) LEFT JOIN runtime_role_configs rt ON rt.id=e.runtime_id`;
}

/** One snapshot validates dependencies, reads at most 65 new rows per turn and
 * probes indexed tool identities. Counter difference must equal visible new
 * rows: a late commit below the old ID cursor therefore forces a full rebuild.
 * Parameters: scope, domain ID, turn IDs, activity scope ID, cached descriptors. */
export function turnDeltaSQL(scope:StreamScope){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=(alias:string)=>scope==='task'?`AND exploration_activity_readable($4,${alias}.node_id,${alias}.metadata)`:'';
 // LIMIT keeps this a parameterized point probe. A NOT EXISTS anti-join may
 // choose to scan all historical call IDs even when just one call was added.
 const probe=(kind:string,error=false)=>`SELECT count(*) FROM (SELECT DISTINCT d.tool_use_id FROM delta_rows d WHERE d.turn_id=e.turn_id AND d.kind='${kind}' ${error?'AND d.is_error':''} AND d.tool_use_id IS NOT NULL AND d.tool_use_id<>'') calls
  LEFT JOIN LATERAL (SELECT true found FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id AND a.kind='${kind}' ${error?'AND a.is_error':''}
   AND md5(a.tool_use_id)=md5(calls.tool_use_id) AND a.tool_use_id=calls.tool_use_id AND a.id<=e.last_id ${allowed('a')} LIMIT 1) prior ON true
  WHERE prior.found IS NULL`;
 return `WITH ${TURN_REVISIONS_CTE},
 previous AS (SELECT * FROM jsonb_to_recordset($5::jsonb) AS p(turn_id text,last_id bigint,activity_version bigint,stable_fingerprint text,runtime_id text)),
 eligible AS MATERIALIZED (
  SELECT p.*,v.data_revision,v.activity_version::bigint-p.activity_version added,v.activity_version current_activity_version,v.rewrite_version,v.control_fingerprint,v.activity_fingerprint,v.append_fingerprint
  FROM previous p JOIN static_versions v USING(turn_id) WHERE v.stable_fingerprint=p.stable_fingerprint
   AND v.activity_version::bigint-p.activity_version BETWEEN 0 AND ${TURN_DELTA_ROWS}
 ), delta_rows AS MATERIALIZED (
  SELECT e.turn_id,a.* FROM eligible e CROSS JOIN LATERAL (
   SELECT a.id,a.worker,a.kind,a.tool_use_id,a.is_error,left(a.summary,4000) summary,${activityMetadataSQL('a.metadata')} metadata,
    a.kind IN ('tool_use','tool_result','thinking','text','assistant') AND NOT(a.metadata ?| ARRAY['event_type','response','final_answer','worker_feedback']) is_plain,
    octet_length(a.metadata::text)>8192 metadata_truncated,a.created_at,
    ${scope==='task'?'a.node_id,a.main_seg':'NULL::bigint node_id,NULL::int main_seg'}
   FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id AND a.id>e.last_id ${allowed('a')}
   ORDER BY id LIMIT ${TURN_DELTA_ROWS+1}
  ) a
 ), appended AS (
  SELECT turn_id,count(*) n,bool_and(is_plain) plain,
   max(id) last_id,min(id) FILTER(WHERE worker='planner') planner_id FROM delta_rows d GROUP BY turn_id
 ), controls AS (
  SELECT d.turn_id,jsonb_agg(to_jsonb(d) ORDER BY d.id) rows FROM delta_rows d JOIN appended a USING(turn_id)
  WHERE d.id=a.last_id OR d.id=a.planner_id GROUP BY d.turn_id
 )
 SELECT e.turn_id,e.data_revision,e.current_activity_version activity_version,e.stable_fingerprint,e.rewrite_version,e.control_fingerprint,e.activity_fingerprint,e.append_fingerprint,statement_timestamp() observed_at,
  COALESCE(c.rows,'[]') rows,(${probe('tool_use')}) tools_added,(${probe('tool_result',true)}) errors_added,
  CASE WHEN rt.id IS NOT NULL THEN jsonb_build_object('id',rt.id,'role',rt.role,'finished_at',rt.finished_at,'expires_at',rt.expires_at,'stop_reason',rt.effective->>'stop_reason') END runtime
 FROM eligible e LEFT JOIN appended a USING(turn_id) LEFT JOIN controls c USING(turn_id) LEFT JOIN runtime_role_configs rt ON rt.id=e.runtime_id
 WHERE COALESCE(a.n,0)=e.added AND COALESCE(a.plain,true)`;
}
