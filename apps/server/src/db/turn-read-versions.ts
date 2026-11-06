import type {Database} from './index.js';
import type {StreamScope} from '../engine/live-stream.js';
import {selectedUsageCTE} from './usage-ledger.js';

/** One lazy historical bootstrap per requested turn. New rows/edits are captured
 * transactionally by triggers, so no startup scan of every historical message is
 * needed. Competing readers skip this lock; they may read an uncached summary. */
async function initialize(db:Database,scope:StreamScope,scopeID:number,activityID:number,ids:string[]){
 await db.transaction(async tx=>{
  const lock=(await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended('turn-read:'||$1::text||':'||$2::text,0)) ok",[scope,scopeID])).rows[0]?.ok;
  if(!lock)return;
  const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
  const missing=(await tx.query(`SELECT q.id FROM unnest($3::text[]) AS q(id) WHERE NOT EXISTS(SELECT 1 FROM turn_read_initialized WHERE scope=$1 AND scope_id=$2 AND turn_id=q.id)
   AND EXISTS(SELECT 1 FROM ${table} a WHERE a.${column}=$4 AND a.metadata->>'turn_id'=q.id)`,[scope,scopeID,ids,activityID])).rows.map(r=>String(r.id));
  if(!missing.length)return;
  // Match the live writer's lock order: activity revision before dependency
  // links. No version row is acquired after inserting conflicting links.
  await tx.query("INSERT INTO turn_read_versions(scope,scope_id,kind,entity) SELECT $1::text,$2::bigint,'activity',id FROM unnest($3::text[]) id ORDER BY id ON CONFLICT DO NOTHING",[scope,scopeID,missing]);
  await tx.query(`INSERT INTO turn_read_links(scope,scope_id,relation,source_key,target_key)
   SELECT DISTINCT $1::text,$2::bigint,'activity_runtime',metadata->>'turn_id',metadata->>'runtime_id' FROM ${table}
   WHERE ${column}=$4 AND metadata->>'event_type'='turn_start' AND metadata->>'turn_id'=ANY($3::text[])
    AND metadata->>'runtime_id' IS NOT NULL ORDER BY 3,4,5 ON CONFLICT DO NOTHING`,[scope,scopeID,missing,activityID]);
  const identity=`${scope==='task'?'task_id':'conversation_id'}=$2`;
  const selection=`turn_id=ANY($3::text[]) OR runtime_id IN (SELECT target_key FROM turn_read_links WHERE scope=$1 AND scope_id=$2 AND relation='activity_runtime' AND source_key=ANY($3::text[]))`;
  await tx.query(`WITH ${selectedUsageCTE(identity,selection)} INSERT INTO turn_read_links(scope,scope_id,relation,source_key,target_key)
   SELECT DISTINCT $1::text,$2::bigint,l.relation,l.source_key,l.target_key FROM selected_usage u CROSS JOIN LATERAL (VALUES
    ('usage_turn',u.turn_id,jsonb_build_array(u.conversation_id,u.scope_key)::text),
    ('usage_runtime',u.runtime_id,jsonb_build_array(u.conversation_id,u.scope_key)::text),
    ('usage_role',jsonb_build_array(u.conversation_id,u.scope_key)::text,jsonb_build_array(u.conversation_id,u.role)::text)
   ) l(relation,source_key,target_key) WHERE l.source_key IS NOT NULL ORDER BY 3,4,5 ON CONFLICT DO NOTHING`,[scope,scopeID,missing]);
  await tx.query('INSERT INTO turn_read_initialized SELECT $1::text,$2::bigint,id FROM unnest($3::text[]) id ON CONFLICT DO NOTHING',[scope,scopeID,missing]);
 });
}

/** Hash the relevant revision tuples, not max(revision): a small counter on one
 * dependency can change while another counter is larger. Per-row increments
 * also remain correct when concurrent transactions commit out of order. */
export const TURN_REVISIONS_CTE=`ids AS (SELECT DISTINCT unnest($3::text[]) turn_id),
 runtimes AS MATERIALIZED (
  SELECT i.turn_id,l.target_key runtime_id FROM ids i JOIN turn_read_links l ON l.scope=$1 AND l.scope_id=$2 AND l.relation='activity_runtime' AND l.source_key=i.turn_id
 ), executions AS MATERIALIZED (
  SELECT i.turn_id,l.target_key entity FROM ids i JOIN turn_read_links l ON l.scope=$1 AND l.scope_id=$2 AND l.relation='usage_turn' AND l.source_key=i.turn_id
  UNION SELECT r.turn_id,l.target_key FROM runtimes r JOIN turn_read_links l ON l.scope=$1 AND l.scope_id=$2 AND l.relation='usage_runtime' AND l.source_key=r.runtime_id
 ), dependencies AS (
  SELECT turn_id,'activity' kind,turn_id entity FROM ids
  UNION SELECT turn_id,'activity_rewrite',turn_id FROM ids
  UNION SELECT turn_id,'activity_data_rewrite',turn_id FROM ids
  UNION SELECT turn_id,'access','all' FROM ids
  UNION SELECT turn_id,'runtime',runtime_id FROM runtimes
  UNION SELECT turn_id,'usage',entity FROM executions
  UNION SELECT e.turn_id,'legacy',l.target_key FROM executions e JOIN turn_read_links l ON l.scope=$1 AND l.scope_id=$2 AND l.relation='usage_role' AND l.source_key=e.entity
 ), static_versions AS (
  SELECT d.turn_id,md5(jsonb_agg(jsonb_build_array(d.kind,d.entity,COALESCE(v.version,0)) ORDER BY d.kind,d.entity)::text) fingerprint,
   sum(COALESCE(v.version,0))::text data_revision,
   max(COALESCE(v.version,0)) FILTER(WHERE d.kind='activity')::text activity_version,
   max(COALESCE(v.version,0)) FILTER(WHERE d.kind='activity_rewrite')::text rewrite_version,
   md5(jsonb_agg(jsonb_build_array(d.kind,d.entity,COALESCE(v.version,0)) ORDER BY d.kind,d.entity) FILTER(WHERE d.kind IN('activity_rewrite','access'))::text) append_fingerprint,
   md5(jsonb_agg(jsonb_build_array(d.kind,d.entity,COALESCE(v.version,0)) ORDER BY d.kind,d.entity) FILTER(WHERE d.kind IN('activity','activity_rewrite','activity_data_rewrite','access'))::text) activity_fingerprint,
   md5(jsonb_agg(jsonb_build_array(d.kind,d.entity,COALESCE(v.version,0)) ORDER BY d.kind,d.entity) FILTER(WHERE d.kind NOT IN('activity','activity_rewrite','runtime'))::text) control_fingerprint,
   md5(jsonb_agg(jsonb_build_array(d.kind,d.entity,COALESCE(v.version,0)) ORDER BY d.kind,d.entity) FILTER(WHERE d.kind NOT IN('activity','activity_data_rewrite'))::text) stable_fingerprint
  FROM dependencies d LEFT JOIN turn_read_versions v ON v.scope=$1 AND v.scope_id=$2 AND v.kind=d.kind AND v.entity=d.entity GROUP BY d.turn_id
 ), boundaries AS (
  SELECT r.turn_id,max(CASE WHEN c.finished_at IS NULL THEN c.expires_at ELSE c.finished_at+interval '12 seconds' END) FILTER(
   WHERE CASE WHEN c.finished_at IS NULL THEN c.expires_at ELSE c.finished_at+interval '12 seconds' END<=now()) boundary
  FROM runtimes r JOIN runtime_role_configs c ON c.id=r.runtime_id GROUP BY r.turn_id
 )`;
const revisionsSQL=`WITH ${TURN_REVISIONS_CTE} SELECT i.turn_id,v.stable_fingerprint,v.control_fingerprint,v.append_fingerprint,
 v.fingerprint||':'||COALESCE(b.boundary::text,'') revision,init.turn_id IS NOT NULL initialized
 FROM ids i JOIN static_versions v USING(turn_id) LEFT JOIN boundaries b USING(turn_id)
 LEFT JOIN turn_read_initialized init ON init.scope=$1 AND init.scope_id=$2 AND init.turn_id=i.turn_id`;

export async function readTurnRevisions(db:Database,scope:StreamScope,activityID:number,ids:string[],hints?:Map<string,Record<string,any>>):Promise<Map<string,string>>{
 if(!ids.length)return new Map();
 const scopeID=scope==='task'?Number((await db.query('SELECT id FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL',[activityID])).rows[0]?.id):activityID;
 if(!Number.isSafeInteger(scopeID)||scopeID<=0)return new Map();
 const read=async()=>(await db.query(revisionsSQL,[scope,scopeID,ids])).rows;
 let rows=await read();const missing=rows.filter(r=>!r.initialized).map(r=>String(r.turn_id));
 if(missing.length){await initialize(db,scope,scopeID,activityID,missing);rows=await read();}
 // Hints only avoid known-inapplicable query paths. Every selected reader
 // still validates the authoritative versions in its own data snapshot.
 for(const r of rows)if(r.initialized)hints?.set(String(r.turn_id),r);
 return new Map(rows.filter(r=>r.initialized).map(r=>[String(r.turn_id),String(r.revision)]));
}
