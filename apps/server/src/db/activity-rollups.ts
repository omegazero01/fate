import type {Database} from './index.js';
import type {StreamScope} from '../engine/live-stream.js';
import {activityMetadataSQL} from './activity-content.js';
import {TURN_REVISIONS_CTE} from './turn-read-versions.js';
import {turnControlReadCTEs} from './turn-projection-delta.js';
import {canonicalRollupCTEs,incrementalReceiptCTEs} from './usage-rollups.js';

/** Rebuildable references and distinct counts, never evidence authority. Live
 * writers take their revision locks before this guard. Initializers only try
 * the guard, never lock revisions afterwards, and publish an access fence.
 * At most eight historical turns are initialized per pass, after usage rollups
 * have been prepared. Native-only and mixed histories share these counts;
 * canonical usage qualification is independent of activity grouping. */
export async function prepareActivityRollups(db:Database,scope:StreamScope,scopeID:number,activityID:number,turns:string[]){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const pending=(await db.query(`WITH usage_eligible AS (SELECT unnest($3::text[]) turn_id),turn_runtimes AS MATERIALIZED (
  SELECT DISTINCT e.turn_id,m->>'runtime_id' runtime_id FROM usage_eligible e CROSS JOIN LATERAL (
   SELECT metadata FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id AND a.metadata->>'event_type'='turn_start'
    ${scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':''} OFFSET 0
  ) a CROSS JOIN LATERAL (SELECT activity_presentation_metadata(a.metadata) m OFFSET 0) projected WHERE m->>'runtime_id' IS NOT NULL
 ),${canonicalRollupCTEs(scope,false,false)}
 SELECT t FROM (SELECT turn_id t FROM qualified_turns) eligible LEFT JOIN turn_activity_rollups r
  ON r.scope=$1 AND r.scope_id=$2 AND r.turn_id=t WHERE r.turn_id IS NULL OR NOT r.ready OR r.format_version<>2 OR r.activity_id<>$4
   OR r.activity_version<>COALESCE((SELECT version FROM turn_read_versions WHERE scope=$1 AND scope_id=$2 AND kind='activity' AND entity=t),0)
   OR r.access_version<>COALESCE((SELECT version FROM turn_read_versions WHERE scope=$1 AND scope_id=$2 AND kind='access' AND entity='all'),0)
  ORDER BY t LIMIT 8`,[scope,scopeID,turns,activityID])).rows;
 for(const {t:turn} of pending)await db.transaction(async tx=>{
  const args=[scope,scopeID,turn,activityID];
  if(!(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('activity-rollup:'||$1::text||':'||$2::text||':'||$3::text,0)) ok",args.slice(0,3))).rows[0]?.ok)return;
  await tx.query('INSERT INTO turn_activity_rollups(scope,scope_id,turn_id,activity_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',args);
  const guard=(await tx.query('SELECT * FROM turn_activity_rollups WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 FOR UPDATE SKIP LOCKED',args.slice(0,3))).rows[0];
  if(!guard)return;
  const versions=async()=>(await tx.query(`SELECT
   COALESCE((SELECT version FROM turn_read_versions WHERE scope=$1 AND scope_id=$2 AND kind='activity' AND entity=$3),0) activity_version,
   COALESCE((SELECT version FROM turn_read_versions WHERE scope=$1 AND scope_id=$2 AND kind='access' AND entity='all'),0) access_version`,args.slice(0,3))).rows[0]!;
  const before=await versions();
  if(guard.ready&&guard.format_version===2&&String(guard.activity_id)===String(activityID)&&guard.activity_version===before.activity_version&&guard.access_version===before.access_version)return;
  // A count-index rebuild can repair source refs without changing originals.
  // Dependent native summaries must be rebuilt from those repaired refs too.
  await tx.query('UPDATE turn_native_rollups SET ready=false WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',args.slice(0,3));
  await tx.query('UPDATE turn_native_range_state SET ready=false WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',args.slice(0,3));
  await tx.query('DELETE FROM turn_activity_groups WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',args.slice(0,3));
  await tx.query(`INSERT INTO turn_activity_groups(scope,scope_id,turn_id,category,key_hash,key_text,members,first_id,last_id)
   SELECT $1::text,$2::bigint,$3::text,k.category,md5(k.key_text),k.key_text,count(*),min(a.id),max(a.id)
   FROM ${table} a CROSS JOIN LATERAL activity_rollup_keys(a.kind,a.tool_use_id,a.is_error,a.metadata) k
   WHERE a.${column}=$4 AND a.metadata->>'turn_id'=$3
    ${scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':''}
   GROUP BY k.category,k.key_text`,args);
  const after=await versions();
  await tx.query(`UPDATE turn_activity_rollups SET activity_id=$4,activity_version=$5,access_version=$6,ready=$7,format_version=2,
   steps=(SELECT count(*) FROM turn_activity_groups WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 AND category='response'),
   tools=(SELECT count(*) FROM turn_activity_groups WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 AND category='tool'),
   errors=(SELECT count(*) FROM turn_activity_groups WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 AND category='error')
   WHERE scope=$1 AND scope_id=$2 AND turn_id=$3`,[...args,before.activity_version,before.access_version,
    before.activity_version===after.activity_version&&before.access_version===after.access_version]);
 });
}

/** Same snapshot for current visibility, counts, response refs and controls.
 * Usage readers select explicit turn attribution separately from live runtime
 * ownership; the count index never guesses receipt attribution. */
export function activityCurrentCTEs(scope:StreamScope){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':'';
 return ` ${TURN_REVISIONS_CTE}, verified AS MATERIALIZED (
  SELECT v.*,r.steps,r.tools,r.errors,r.access_version,g.first_id response_first_id,g.last_id response_id,
   b.first_id first_activity_id,b.last_id last_activity_id FROM static_versions v
  JOIN turn_activity_rollups r ON r.scope=$1 AND r.scope_id=$2 AND r.turn_id=v.turn_id
  JOIN turn_activity_groups b ON b.scope=$1 AND b.scope_id=$2 AND b.turn_id=v.turn_id AND b.category='row' AND b.key_hash=md5('all') AND b.key_text='all'
  LEFT JOIN LATERAL (SELECT first_id,last_id FROM turn_activity_groups WHERE scope=$1 AND scope_id=$2 AND turn_id=v.turn_id
   AND category='response' ORDER BY first_id DESC LIMIT 1) g ON true
  WHERE r.ready AND r.format_version=2 AND r.activity_id=$4 AND r.activity_version=v.activity_version::bigint
   AND r.access_version=COALESCE((SELECT version FROM turn_read_versions WHERE scope=$1 AND scope_id=$2 AND kind='access' AND entity='all'),0)
 ), usage_eligible AS (SELECT turn_id FROM verified), start_markers AS MATERIALIZED (
  SELECT e.turn_id,a.id,m->>'runtime_id' runtime_id FROM verified e CROSS JOIN LATERAL (
   SELECT a.id,a.metadata FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=e.turn_id
    AND a.metadata->>'event_type'='turn_start' ${allowed} OFFSET 0
  ) a CROSS JOIN LATERAL (SELECT ${activityMetadataSQL('a.metadata')} m OFFSET 0) projected
 ), turn_runtimes AS MATERIALIZED (SELECT DISTINCT turn_id,runtime_id FROM start_markers WHERE runtime_id IS NOT NULL),
 last_start AS (SELECT DISTINCT ON(turn_id) turn_id,runtime_id FROM start_markers ORDER BY turn_id,id DESC)`;
}
export function turnIndexedActivitySQL(scope:StreamScope){
 return `WITH ${activityCurrentCTEs(scope)},
 ${incrementalReceiptCTEs(scope)},${turnControlReadCTEs(scope,true)}, indexed_activity_result AS (
  SELECT e.turn_id,c.first_id,c.rows,e.tools,e.errors,e.steps,e.response_first_id,
   (SELECT to_jsonb(x) FROM fresh_controls x WHERE x.turn_id=e.turn_id AND x.id=e.response_id) response,
   r.models,r.model_name_lengths,r.model_names_truncated,r.models_total,r.usage,r.attempt_updated_at,
   e.data_revision,e.activity_version,e.rewrite_version,e.control_fingerprint,e.activity_fingerprint,e.stable_fingerprint,e.append_fingerprint,
   ls.runtime_id,statement_timestamp() observed_at,
   CASE WHEN rt.id IS NOT NULL THEN jsonb_build_object('id',rt.id,'role',rt.role,'finished_at',rt.finished_at,'expires_at',rt.expires_at,'stop_reason',rt.effective->>'stop_reason') END runtime
  FROM verified e JOIN fresh_rows c USING(turn_id) JOIN incremental_receipts r USING(turn_id)
  LEFT JOIN last_start ls USING(turn_id) LEFT JOIN runtime_role_configs rt ON rt.id=ls.runtime_id
 ) SELECT * FROM indexed_activity_result ORDER BY first_id`;
}
