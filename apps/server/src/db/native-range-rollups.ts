import type {Database} from './index.js';
import type {StreamScope} from '../engine/live-stream.js';
import {activityCurrentCTEs} from './activity-rollups.js';
import {canonicalRollupCTEs} from './usage-rollups.js';

function rangeCandidates(scope:StreamScope){return `${activityCurrentCTEs(scope)},${canonicalRollupCTEs(scope,false,false)},
 range_candidates AS MATERIALIZED (SELECT e.* FROM verified e JOIN qualified_turns q USING(turn_id)
  WHERE EXISTS(SELECT 1 FROM exact_rollups r WHERE r.owner_turn=e.turn_id)
   AND NOT EXISTS(SELECT 1 FROM canonical_rollups r WHERE r.turn_id=e.turn_id))`;}

/** Bootstrap once, then repair only execution intervals whose boundary changed.
 * Original responses remain authoritative; ready/version/access checks fence
 * all derived data. Ordinary response changes update their range in-place. */
export async function prepareNativeRanges(db:Database,scope:StreamScope,scopeID:number,activityID:number,turns:string[]){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':'';
 const pending=(await db.query(`WITH ${rangeCandidates(scope)} SELECT e.turn_id FROM range_candidates e
  LEFT JOIN turn_native_range_state s ON s.scope=$1 AND s.scope_id=$2 AND s.turn_id=e.turn_id
  WHERE s.turn_id IS NULL OR NOT s.ready OR s.activity_version<>e.activity_version::bigint OR s.access_version<>e.access_version
   OR EXISTS(SELECT 1 FROM turn_native_ranges r WHERE r.scope=$1 AND r.scope_id=$2 AND r.turn_id=e.turn_id AND r.dirty)
  ORDER BY e.turn_id LIMIT 8`,[scope,scopeID,turns,activityID])).rows;
 for(const {turn_id:turn} of pending)await db.transaction(async tx=>{
  const args=[scope,scopeID,turn],params=[scope,scopeID,[turn],activityID];
  if(!(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('activity-rollup:'||$1::text||':'||$2::text||':'||$3::text,0)) ok",args)).rows[0]?.ok)return;
  const base=(await tx.query(`WITH ${rangeCandidates(scope)} SELECT * FROM range_candidates`,params)).rows[0];if(!base)return;
  await tx.query('INSERT INTO turn_native_range_state(scope,scope_id,turn_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',args);
  const state=(await tx.query('SELECT * FROM turn_native_range_state WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 FOR UPDATE SKIP LOCKED',args)).rows[0];if(!state)return;
  if(!state.ready||String(state.activity_version)!==String(base.activity_version)||state.access_version!==base.access_version){
   await tx.query('DELETE FROM turn_native_ranges WHERE scope=$1 AND scope_id=$2 AND turn_id=$3',args);
   await tx.query(`WITH starts AS (SELECT 0::bigint id,NULL::text runtime_id UNION ALL
    SELECT id,activity_presentation_metadata(metadata)->>'runtime_id' FROM ${table} a
    WHERE a.${column}=$4 AND a.metadata->>'turn_id'=$3 AND a.metadata->>'event_type'='turn_start' ${allowed})
    INSERT INTO turn_native_ranges(scope,scope_id,turn_id,start_id,next_id,runtime_id)
    SELECT $1,$2,$3,id,lead(id) OVER(ORDER BY id),runtime_id FROM starts`,[...args,activityID]);
  }
  await repairRanges(tx,scope,scopeID,activityID,String(turn),base.activity_version,base.access_version);
 });
}

const currentRangeState=`SELECT s.* FROM turn_native_range_state s
 WHERE s.scope=$1 AND s.scope_id=$2 AND s.turn_id=ANY($3::text[]) AND s.ready
  AND s.activity_version=COALESCE((SELECT version FROM turn_read_versions WHERE scope=$1 AND scope_id=$2 AND kind='activity' AND entity=s.turn_id),0)
  AND s.access_version=COALESCE((SELECT version FROM turn_read_versions WHERE scope=$1 AND scope_id=$2 AND kind='access' AND entity='all'),0)
  AND EXISTS(SELECT 1 FROM turn_native_ranges r WHERE r.scope=$1 AND r.scope_id=$2 AND r.turn_id=s.turn_id AND r.dirty)`;

/** A complete fallback is still fenced separately before it is returned. While
 * its already-created interval index is partial, only advance that index. No
 * dependency-wide qualification or model/count rebuild is needed to sum eight
 * original intervals. Changed activity/access versions take the normal path. */
export async function advancePendingNativeRanges(db:Database,scope:StreamScope,scopeID:number,activityID:number,turns:string[]){
 const handled=new Set<string>(),ready=new Set<string>();if(!turns.length)return {handled,ready};
 const pending=(await db.query(`${currentRangeState} ORDER BY s.turn_id LIMIT 8`,[scope,scopeID,turns])).rows;
 for(const row of pending){const turn=String(row.turn_id);
  const result=await db.transaction(async tx=>{
   if(!(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('activity-rollup:'||$1::text||':'||$2::text||':'||$3::text,0)) ok",[scope,scopeID,turn])).rows[0]?.ok)return;
   const state=(await tx.query(`${currentRangeState} FOR UPDATE OF s SKIP LOCKED`,[scope,scopeID,[turn]])).rows[0];if(!state)return;
   await repairRanges(tx,scope,scopeID,activityID,turn,state.activity_version,state.access_version);
   return !(await tx.query('SELECT 1 FROM turn_native_ranges WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 AND dirty LIMIT 1',[scope,scopeID,turn])).rowCount;
  });
  if(result!==undefined){handled.add(turn);if(result)ready.add(turn);}
 }
 return {handled,ready};
}

async function repairRanges(tx:Database,scope:StreamScope,scopeID:number,activityID:number,turn:string,activityVersion:unknown,accessVersion:unknown){
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const allowed=scope==='task'?'AND exploration_activity_readable($4,a.node_id,a.metadata)':'';
 const args=[scope,scopeID,turn];
 // At most eight intervals per pass. A partially repaired index is never used
 // for an uncovered range; a subsequent read continues instead of restarting.
 await tx.query(`WITH pending AS MATERIALIZED (
   SELECT * FROM turn_native_ranges WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 AND dirty ORDER BY start_id LIMIT 8
  ), originals AS MATERIALIZED (
   SELECT p.start_id,native_response_values(m) values FROM pending p CROSS JOIN LATERAL (
    SELECT a.metadata FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=$3
     AND a.id>=p.start_id AND a.id<=COALESCE(p.next_id-1,9223372036854775807::bigint) ${allowed} OFFSET 0
   ) a CROSS JOIN LATERAL (SELECT activity_presentation_metadata(a.metadata) m OFFSET 0) projected
   WHERE m->>'stream_id' IS NOT NULL AND m->>'stream_id'<>'' AND m->'response' IS NOT NULL
    AND m->'response' NOT IN('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
  ), sums AS (SELECT start_id,i,sum(v) v FROM originals CROSS JOIN LATERAL unnest(values) WITH ORDINALITY x(v,i) GROUP BY start_id,i),
  vectors AS (SELECT start_id,array_agg(v ORDER BY i) totals FROM sums GROUP BY start_id)
  UPDATE turn_native_ranges r SET totals=COALESCE(v.totals,ARRAY[0,0,0,0,0]::numeric[]),
   invalid=(SELECT count(*) FROM originals o WHERE o.start_id=p.start_id AND o.values IS NULL),dirty=false
  FROM pending p LEFT JOIN vectors v USING(start_id) WHERE r.scope=$1 AND r.scope_id=$2 AND r.turn_id=$3 AND r.start_id=p.start_id`,[...args,activityID]);
 await tx.query(`UPDATE turn_native_range_state SET ready=($5::bigint=COALESCE((SELECT version FROM turn_read_versions
   WHERE scope=$1 AND scope_id=$2 AND kind='access' AND entity='all'),0)),activity_version=$4,access_version=$5
   WHERE scope=$1 AND scope_id=$2 AND turn_id=$3`,[...args,activityVersion,accessVersion]);
}
