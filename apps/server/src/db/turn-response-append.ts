import type {StreamScope} from '../engine/live-stream.js';
import {activityMetadataSQL} from './activity-content.js';
import {TURN_DELTA_ROWS} from './turn-projection-delta.js';

/** Receipt refresh can reuse activity counts even when a native response was
 * appended. No prior response body/set is loaded: probe each new stream's first
 * visible row and retain its latest version. The first appearance, not the last
 * update, orders responses, exactly like the complete reader.
 *
 * Edits, deletes, source revocation, resumed turn boundaries, lower-ID late
 * commits and oversized bursts fail the fence and use authoritative rebuilding.
 * This is an activity component delta; canonical receipt accounting remains in
 * the caller's SAME snapshot and is never inferred from these response rows.
 */
export function turnResponseAppendCTEs(scope:StreamScope){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=(a:string)=>scope==='task'?`AND exploration_activity_readable($4,${a}.node_id,${a}.metadata)`:'';
 const response=(m:string)=>`${m}->>'stream_id' IS NOT NULL AND ${m}->>'stream_id'<>'' AND ${m}->'response' IS NOT NULL
  AND ${m}->'response' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)`;
 const toolProbe=(kind:string,error=false)=>`SELECT count(*) FROM (SELECT DISTINCT tool_use_id FROM receipt_append_rows d
  WHERE d.turn_id=e.turn_id AND d.kind='${kind}' ${error?'AND d.is_error':''} AND d.tool_use_id IS NOT NULL AND d.tool_use_id<>'') calls
  LEFT JOIN LATERAL (SELECT true found FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id
   AND a.kind='${kind}' ${error?'AND a.is_error':''} AND md5(a.tool_use_id)=md5(calls.tool_use_id) AND a.tool_use_id=calls.tool_use_id
   AND a.id<=e.last_id ${allowed('a')} LIMIT 1) prior ON true WHERE prior.found IS NULL`;
 const fields=`a.id,a.worker,a.kind,a.tool_use_id,a.is_error,left(a.summary,4000) summary,${activityMetadataSQL('a.metadata')} metadata,
  octet_length(a.metadata::text)>8192 metadata_truncated,a.created_at,
  ${scope==='task'?'a.node_id,a.main_seg':'NULL::bigint node_id,NULL::int main_seg'}`;
 return `previous AS (SELECT * FROM jsonb_to_recordset($7::jsonb) AS p(turn_id text,activity_fingerprint text,append_fingerprint text,
  activity_version bigint,rewrite_version bigint,last_id bigint,runtime_id text,response_id bigint,response_first_id bigint)),
 append_candidates AS MATERIALIZED (
  SELECT v.*,p.runtime_id,p.last_id,p.response_id,p.response_first_id,v.activity_version::bigint-p.activity_version added
  FROM previous p JOIN static_versions v USING(turn_id) WHERE p.activity_fingerprint=v.activity_fingerprint OR
   (p.append_fingerprint=v.append_fingerprint AND p.rewrite_version=v.rewrite_version::bigint
    AND v.activity_version::bigint-p.activity_version BETWEEN 0 AND ${TURN_DELTA_ROWS}
    AND (p.response_id IS NULL OR p.response_first_id IS NOT NULL))
 ), receipt_append_rows AS MATERIALIZED (
  SELECT e.turn_id,a.* FROM append_candidates e CROSS JOIN LATERAL (
   SELECT ${fields},a.metadata->>'event_type'='turn_start' OR a.metadata ? 'worker_feedback' boundary
   FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id AND a.id>e.last_id ${allowed('a')}
   ORDER BY a.id LIMIT ${TURN_DELTA_ROWS+1}
  ) a
 ), usage_eligible AS MATERIALIZED (
  SELECT e.* FROM append_candidates e WHERE (SELECT count(*) FROM receipt_append_rows d WHERE d.turn_id=e.turn_id)=e.added
   AND NOT EXISTS(SELECT 1 FROM receipt_append_rows d WHERE d.turn_id=e.turn_id AND d.boundary)
 ), appended_streams AS MATERIALIZED (
  SELECT d.turn_id,d.metadata->>'stream_id' stream,min(d.id) first_new_id,max(d.id) last_new_id
  FROM receipt_append_rows d JOIN usage_eligible e USING(turn_id) WHERE ${response('d.metadata')}
  GROUP BY d.turn_id,d.metadata->>'stream_id'
 ), stream_origins AS MATERIALIZED (
  SELECT s.*,COALESCE(prior.id,s.first_new_id) first_id FROM appended_streams s JOIN usage_eligible e USING(turn_id)
  LEFT JOIN LATERAL (
   SELECT a.id FROM ${table} a CROSS JOIN LATERAL (SELECT ${activityMetadataSQL('a.metadata')} m OFFSET 0) projected
   WHERE a.${column}=$4 AND a.metadata->>'turn_id'=s.turn_id AND a.metadata ? 'stream_id' AND a.metadata ? 'response'
    AND md5(a.metadata->>'stream_id')=md5(s.stream) AND a.metadata->>'stream_id'=s.stream AND a.id<=e.last_id
    AND ${response('m')} ${allowed('a')} ORDER BY a.id LIMIT 1
  ) prior ON true
 ), newest_response AS (
  SELECT DISTINCT ON(turn_id) turn_id,id,first_id FROM (
   SELECT turn_id,last_new_id id,first_id FROM stream_origins
   UNION ALL SELECT turn_id,response_id,response_first_id FROM usage_eligible WHERE response_id IS NOT NULL
  ) versions ORDER BY turn_id,first_id DESC NULLS LAST,id DESC
 ), append_projection AS (
  SELECT e.turn_id,COALESCE((SELECT jsonb_agg(to_jsonb(d)-'boundary' ORDER BY d.id) FROM receipt_append_rows d WHERE d.turn_id=e.turn_id),'[]') append_rows,
   (SELECT count(*) FROM stream_origins s WHERE s.turn_id=e.turn_id AND s.first_id>e.last_id) steps_added,
   (${toolProbe('tool_use')}) tools_added,(${toolProbe('tool_result',true)}) errors_added,
   (SELECT to_jsonb(r) FROM newest_response n CROSS JOIN LATERAL (
    SELECT ${fields} FROM ${table} a WHERE a.id=n.id AND a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id ${allowed('a')} LIMIT 1
   ) r WHERE n.turn_id=e.turn_id) append_response,
   (SELECT first_id FROM newest_response n WHERE n.turn_id=e.turn_id) response_first_id
  FROM usage_eligible e
 )`;
}
