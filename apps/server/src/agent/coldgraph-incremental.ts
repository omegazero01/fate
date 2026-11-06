import {createHash} from 'node:crypto';
import type pg from 'pg';
import type {Database} from '../db/index.js';
import type {ColdGraphResult} from './coldgraph.js';

const empty=(status:ColdGraphResult['status'],pending=false):ColdGraphResult=>({status,pending,scanned_nodes:0,changed_nodes:0,created_digests:0});
const live="n.kind='intent' AND n.state IN ('open','running','paused')";
// Non-materialized point lookups: recursion never loads evidence or whole node
// records. Overrides represent the consistent snapshot being prepared.
// A scalar, correlated lookup prevents PostgreSQL from expanding a full graph
// hash join for every recursive vertex. The LIMIT is a planning fence, not a
// semantic truncation: node_id is a primary key in all three relations.
const eligible=(id:string)=>`COALESCE((SELECT COALESCE(probe_hot.eligible,probe_state.eligible,false)
 FROM exploration_nodes probe_node LEFT JOIN cold_plan_hot probe_hot ON probe_hot.node_id=probe_node.id
 LEFT JOIN cold_node_state probe_state ON probe_state.node_id=probe_node.id
 WHERE probe_node.id=${id} AND probe_node.exploration_id=$1 AND probe_node.kind<>'digest' LIMIT 1),false)`;
// Keep each direction as a point lookup. Combining endpoints with OR can make
// PostgreSQL choose a correlated full edge scan for every singleton when many
// historical leaves share one parent. The two exclusions have identical
// singleton semantics, including self-edge exclusion and both directions.
const isolated=(id:string)=>`(NOT EXISTS(SELECT 1 FROM exploration_edges a
 WHERE a.exploration_id=$1 AND a.rel<>'covers' AND a.src_id=${id} AND a.dst_id<>${id} AND ${eligible('a.dst_id')})
 AND NOT EXISTS(SELECT 1 FROM exploration_edges a
 WHERE a.exploration_id=$1 AND a.rel<>'covers' AND a.dst_id=${id} AND a.src_id<>${id} AND ${eligible('a.src_id')}))`;
const tables=['cold_plan_dirty','cold_plan_hot','cold_plan_seeds','cold_plan_components','cold_plan_walk'];
async function createPlan(tx:pg.PoolClient,expID:number,round:number){
  await tx.query(`CREATE TEMP TABLE cold_plan_dirty (LIKE cold_dirty_nodes INCLUDING ALL) ON COMMIT PRESERVE ROWS;
   CREATE TEMP TABLE cold_plan_hot(node_id BIGINT PRIMARY KEY,ancestor_hot BOOLEAN NOT NULL DEFAULT false,cold_since_round BIGINT,eligible BOOLEAN NOT NULL DEFAULT false) ON COMMIT PRESERVE ROWS;
   CREATE TEMP TABLE cold_plan_seeds(id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS;
   CREATE TEMP TABLE cold_plan_components(id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS;
   CREATE TEMP TABLE cold_plan_walk(id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS;`);
  await tx.query('INSERT INTO cold_plan_dirty SELECT * FROM cold_dirty_nodes WHERE exploration_id=$1',[expID]);
  await tx.query('ANALYZE cold_plan_dirty');
  const structural=!!(await tx.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM cold_plan_dirty WHERE reclassify OR regroup)
   OR EXISTS(SELECT 1 FROM cold_node_state WHERE exploration_id=$1 AND NOT eligible AND cold_since_round<=$2-6)`,[expID,round])).rowCount;
  if(!structural)return {members:[] as Array<{id:number;component:number;chunk:number|null}>,chunks:[] as Array<{chunk:number;component:number;ids:number[]}>,classified:0,scanned:0,edges:0,regroup:false};
  // A change can only change ancestor reachability upstream of its endpoints.
  // Outside this closed region, persisted ancestor_hot is still valid. Cycles
  // are handled by UNION, not recursive JS or self-sustaining reference counts.
  await tx.query(`WITH RECURSIVE affected(id) AS (
   SELECT node_id FROM cold_plan_dirty WHERE reclassify
   UNION SELECT e.src_id FROM exploration_edges e JOIN affected a ON a.id=e.dst_id
    JOIN exploration_nodes n ON n.id=e.src_id AND n.exploration_id=$1 AND n.kind<>'digest'
    WHERE e.exploration_id=$1 AND e.rel<>'covers'
  ) INSERT INTO cold_plan_hot(node_id) SELECT n.id FROM affected a JOIN exploration_nodes n ON n.id=a.id
    WHERE n.exploration_id=$1 AND n.kind<>'digest'`,[expID]);
  await tx.query('ANALYZE cold_plan_hot');
  await tx.query(`WITH RECURSIVE hot(id) AS (
   SELECT h.node_id FROM cold_plan_hot h JOIN exploration_nodes n ON n.id=h.node_id WHERE ${live}
    OR EXISTS(SELECT 1 FROM exploration_edges e JOIN cold_node_state child ON child.node_id=e.dst_id AND child.exploration_id=$1 AND child.ancestor_hot
     JOIN exploration_nodes child_node ON child_node.id=child.node_id AND child_node.kind<>'digest'
     WHERE e.exploration_id=$1 AND e.src_id=n.id AND e.rel<>'covers' AND NOT EXISTS(SELECT 1 FROM cold_plan_hot inside WHERE inside.node_id=e.dst_id))
   UNION SELECT e.src_id FROM exploration_edges e JOIN hot h ON e.dst_id=h.id JOIN cold_plan_hot inside ON inside.node_id=e.src_id
    WHERE e.exploration_id=$1 AND e.rel<>'covers'
  ) UPDATE cold_plan_hot SET ancestor_hot=true WHERE node_id IN(SELECT id FROM hot)`,[expID]);
  await tx.query(`UPDATE cold_plan_hot h SET cold_since_round=CASE WHEN n.kind IN ('intent','fact') AND n.state<>'origin' AND NOT h.ancestor_hot
   AND NOT EXISTS(SELECT 1 FROM exploration_edges e JOIN exploration_nodes parent ON parent.id=e.src_id
    WHERE e.exploration_id=$1 AND e.dst_id=n.id AND e.rel<>'covers' AND parent.exploration_id=$1
     AND parent.kind='intent' AND parent.state IN ('open','running','paused'))
   THEN CASE WHEN s.node_id IS NULL THEN COALESCE(n.cold_since_round,$2) ELSE COALESCE(s.cold_since_round,$2) END ELSE NULL END
   FROM exploration_nodes n LEFT JOIN cold_node_state s ON s.node_id=n.id WHERE h.node_id=n.id`,[expID,round]);
  await tx.query('UPDATE cold_plan_hot SET eligible=cold_since_round IS NOT NULL AND cold_since_round<=$1-6',[round]);
  // A due index replaces scanning all nodes every sixth planning round.
  await tx.query(`INSERT INTO cold_plan_hot(node_id,ancestor_hot,cold_since_round,eligible)
   SELECT node_id,ancestor_hot,cold_since_round,true FROM cold_node_state
    WHERE exploration_id=$1 AND NOT eligible AND cold_since_round<=$2-6 ON CONFLICT DO NOTHING`,[expID,round]);
  await tx.query('ANALYZE cold_plan_hot');
  await tx.query(`INSERT INTO cold_plan_seeds
   SELECT node_id FROM cold_plan_dirty WHERE regroup
   UNION SELECT h.node_id FROM cold_plan_hot h LEFT JOIN cold_node_state s ON s.node_id=h.node_id
    WHERE h.eligible IS DISTINCT FROM COALESCE(s.eligible,false)`,[]);
  await tx.query(`INSERT INTO cold_plan_components
   SELECT old_component FROM cold_plan_dirty WHERE regroup AND old_component IS NOT NULL
   UNION SELECT s.component_id FROM cold_node_state s JOIN cold_plan_seeds a ON a.id=s.node_id WHERE s.component_id IS NOT NULL`,[]);
  // Include every old component before recomputing: both sides of a split must
  // survive, even after the bridge node/edge has already been deleted.
  await tx.query(`INSERT INTO cold_plan_seeds SELECT node_id FROM cold_node_state s JOIN cold_plan_components c ON c.id=s.component_id
   WHERE s.exploration_id=$1 ON CONFLICT DO NOTHING`,[expID]);
  await tx.query('ANALYZE cold_plan_seeds');
  await tx.query('ANALYZE cold_plan_components');
  const regroup=Number((await tx.query('SELECT count(*) n FROM cold_plan_seeds')).rows[0].n)>0;
  if(regroup){
    // Negative IDs are virtual shared-parent hubs. Only isolated eligible nodes
    // use them, exactly matching singleton-sibling rescue without an O(N²) clique.
    await tx.query(`WITH RECURSIVE walk(id) AS (
     SELECT s.id FROM cold_plan_seeds s WHERE ${eligible('s.id')}
     UNION SELECT neighbor.id FROM walk w CROSS JOIN LATERAL(
      SELECT e.dst_id id FROM exploration_edges e
       WHERE w.id>0 AND e.exploration_id=$1 AND e.src_id=w.id AND e.rel<>'covers' AND ${eligible('e.dst_id')}
      UNION SELECT e.src_id FROM exploration_edges e
       WHERE w.id>0 AND e.exploration_id=$1 AND e.dst_id=w.id AND e.rel<>'covers' AND ${eligible('e.src_id')}
      UNION SELECT -e.src_id FROM exploration_edges e JOIN exploration_nodes parent ON parent.id=e.src_id AND parent.exploration_id=$1 AND parent.kind<>'digest'
       WHERE w.id>0 AND e.exploration_id=$1 AND e.dst_id=w.id AND e.rel<>'covers' AND ${isolated('w.id')}
      UNION SELECT e.dst_id FROM exploration_edges e
       WHERE w.id<0 AND e.exploration_id=$1 AND e.src_id=-w.id AND e.rel<>'covers' AND ${eligible('e.dst_id')} AND ${isolated('e.dst_id')}
     ) neighbor
    ) INSERT INTO cold_plan_walk SELECT id FROM walk`,[expID]);
    await tx.query('ANALYZE cold_plan_walk');
    await tx.query(`INSERT INTO cold_plan_components SELECT DISTINCT s.component_id FROM cold_node_state s JOIN cold_plan_walk w ON w.id=s.node_id
     WHERE s.component_id IS NOT NULL ON CONFLICT DO NOTHING`);
  }
  const raw=(await tx.query('SELECT id FROM cold_plan_walk ORDER BY id')).rows;
  const edges=raw.length?(await tx.query(`SELECT e.src_id src,e.dst_id dst FROM exploration_edges e JOIN cold_plan_walk a ON a.id=e.src_id JOIN cold_plan_walk b ON b.id=e.dst_id
    WHERE e.exploration_id=$1 AND e.rel<>'covers'
   UNION SELECT -e.src_id,e.dst_id FROM exploration_edges e JOIN cold_plan_walk a ON a.id=-e.src_id JOIN cold_plan_walk b ON b.id=e.dst_id
    WHERE e.exploration_id=$1 AND e.rel<>'covers' AND ${isolated('e.dst_id')}`,[expID])).rows:[];
  const parents=new Map(raw.map(r=>[Number(r.id),Number(r.id)]));
  const root=(id:number)=>{let r=id;while(parents.get(r)!==r)r=parents.get(r)!;while(id!==r){const next=parents.get(id)!;parents.set(id,r);id=next;}return r;};
  for(const e of edges){const a=root(Number(e.src)),b=root(Number(e.dst));if(a!==b)parents.set(a,b);}
  const grouped=new Map<number,number[]>();for(const [id] of parents)if(id>0){const key=root(id),group=grouped.get(key)??[];group.push(id);grouped.set(key,group);}
  const members:Array<{id:number;component:number;chunk:number|null}>=[],chunks:Array<{chunk:number;component:number;ids:number[]}>=[];
  for(const ids of grouped.values()){
    ids.sort((a,b)=>a-b);const component=ids[0]!;
    for(let start=0;start<ids.length;start+=256){const part=ids.slice(start,start+256),chunk=ids.length>1?part[0]!:null;
      for(const id of part)members.push({id,component,chunk});if(chunk!==null)chunks.push({chunk,component,ids:part});
    }
  }
  const classified=Number((await tx.query('SELECT count(*) n FROM cold_plan_hot')).rows[0].n);
  return {members,chunks,classified,scanned:raw.filter(r=>Number(r.id)>0).length,edges:edges.length,regroup};
}

async function publishPlan(tx:pg.PoolClient,expID:number,round:number,plan:Awaited<ReturnType<typeof createPlan>>){
  // Short row fences cover FK checks and derived metadata publication. An
  // executor holding a node lock wins; maintenance rolls back instead of waiting.
  if(plan.classified){
  await tx.query(`SELECT n.id FROM exploration_nodes n JOIN cold_plan_hot h ON h.node_id=n.id ORDER BY n.id FOR KEY SHARE OF n NOWAIT`);
  await tx.query(`DELETE FROM cold_node_state s WHERE s.exploration_id=$1 AND EXISTS(SELECT 1 FROM exploration_nodes n WHERE n.id=s.node_id AND n.kind='digest')`,[expID]);
  await tx.query(`INSERT INTO cold_node_state(node_id,exploration_id,ancestor_hot,cold_since_round,eligible,sync_needed)
   SELECT h.node_id,$1,h.ancestor_hot,h.cold_since_round,h.eligible,n.cold_since_round IS DISTINCT FROM h.cold_since_round
   FROM cold_plan_hot h JOIN exploration_nodes n ON n.id=h.node_id
   ON CONFLICT(node_id) DO UPDATE SET ancestor_hot=EXCLUDED.ancestor_hot,cold_since_round=EXCLUDED.cold_since_round,
    eligible=EXCLUDED.eligible,sync_needed=EXCLUDED.sync_needed
    WHERE (cold_node_state.ancestor_hot,cold_node_state.cold_since_round,cold_node_state.eligible,cold_node_state.sync_needed)
      IS DISTINCT FROM (EXCLUDED.ancestor_hot,EXCLUDED.cold_since_round,EXCLUDED.eligible,EXCLUDED.sync_needed)`,[expID]);
  }
  await tx.query(`UPDATE cold_digest_chunks SET dirty=true WHERE exploration_id=$1 AND chunk_id IN (
   SELECT old_chunk FROM cold_plan_dirty UNION SELECT s.chunk_id FROM cold_node_state s JOIN cold_plan_dirty d ON d.node_id=s.node_id
   UNION SELECT s.chunk_id FROM cold_node_state s JOIN cold_plan_hot h ON h.node_id=s.node_id)`,[expID]);
  const chunks=JSON.stringify(plan.chunks),members=JSON.stringify(plan.members);
  if(plan.regroup){
  await tx.query(`INSERT INTO cold_digest_retire(exploration_id,digest_id)
   SELECT $1,c.digest_id FROM cold_digest_chunks c JOIN cold_plan_components p ON p.id=c.component_id
   WHERE c.exploration_id=$1 AND c.digest_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_to_recordset($2::jsonb) x(chunk bigint,ids bigint[]) WHERE x.chunk=c.chunk_id AND x.ids=c.member_ids)
   ON CONFLICT DO NOTHING`,[expID,chunks]);
  await tx.query(`DELETE FROM cold_digest_chunks c USING cold_plan_components p WHERE c.exploration_id=$1 AND c.component_id=p.id
   AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) x(chunk bigint) WHERE x.chunk=c.chunk_id)`,[expID,chunks]);
  await tx.query(`UPDATE cold_node_state s SET component_id=NULL,chunk_id=NULL WHERE s.exploration_id=$1
   AND (s.component_id IN(SELECT id FROM cold_plan_components) OR s.node_id IN(SELECT id FROM cold_plan_seeds))`,[expID]);
  await tx.query(`UPDATE cold_node_state s SET component_id=x.component,chunk_id=x.chunk
   FROM jsonb_to_recordset($1::jsonb) x(id bigint,component bigint,chunk bigint) WHERE s.node_id=x.id`,[members]);
  await tx.query(`INSERT INTO cold_digest_chunks(exploration_id,chunk_id,component_id,member_ids)
   SELECT $1,chunk,component,ids FROM jsonb_to_recordset($2::jsonb) x(chunk bigint,component bigint,ids bigint[])
   ON CONFLICT(exploration_id,chunk_id) DO UPDATE SET component_id=EXCLUDED.component_id,member_ids=EXCLUDED.member_ids,dirty=true,
    digest_id=CASE WHEN cold_digest_chunks.member_ids=EXCLUDED.member_ids THEN cold_digest_chunks.digest_id ELSE NULL END`,[expID,chunks]);
  }
  await tx.query(`DELETE FROM cold_dirty_nodes d USING cold_plan_dirty p
   WHERE d.exploration_id=p.exploration_id AND d.node_id=p.node_id AND d.generation=p.generation`);
  const syncing=(await tx.query(`SELECT n.id FROM cold_node_state s JOIN exploration_nodes n ON n.id=s.node_id
   WHERE s.exploration_id=$1 AND s.sync_needed ORDER BY n.id LIMIT 512 FOR UPDATE OF n NOWAIT`,[expID])).rows.map(r=>Number(r.id));
  if(syncing.length){
    await tx.query('UPDATE exploration_nodes n SET cold_since_round=s.cold_since_round FROM cold_node_state s WHERE n.id=s.node_id AND n.id=ANY($1::bigint[])',[syncing]);
    await tx.query('UPDATE cold_node_state SET sync_needed=false WHERE node_id=ANY($1::bigint[])',[syncing]);
  }
  const retiring=(await tx.query('SELECT digest_id FROM cold_digest_retire WHERE exploration_id=$1 ORDER BY digest_id LIMIT 64',[expID])).rows.map(r=>Number(r.digest_id));
  if(retiring.length){
    await tx.query('SELECT id FROM exploration_nodes WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT',[retiring]);
    await tx.query("UPDATE exploration_nodes SET state='superseded' WHERE id=ANY($1::bigint[]) AND kind='digest' AND state='active'",[retiring]);
    await tx.query('DELETE FROM cold_digest_retire WHERE digest_id=ANY($1::bigint[])',[retiring]);
  }
  const jobs=(await tx.query(`SELECT chunk_id,member_ids FROM (
   SELECT chunk_id,member_ids,sum(cardinality(member_ids)) OVER(ORDER BY chunk_id) member_total FROM (
    SELECT chunk_id,member_ids FROM cold_digest_chunks WHERE exploration_id=$1 AND dirty ORDER BY chunk_id LIMIT 64
   ) candidates
  ) bounded WHERE member_total<=512 ORDER BY chunk_id`,[expID])).rows;
  let created=0,read=0;
  if(jobs.length){
    // A batch contains at most 64 chunks / 512 members. Fetch and publish it in
    // sets, rather than seven database round trips for each two-node branch.
    const allIDs=jobs.flatMap(job=>(job.member_ids as string[]).map(Number));
    const rows=(await tx.query(`SELECT id,kind,state,content_version,left(COALESCE(payload->>'summary',payload->>'text',''),240) summary
      FROM exploration_nodes WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT`,[allIDs])).rows;
    const byID=new Map(rows.map(n=>[Number(n.id),n]));read=rows.length;
    const prepared=jobs.map(job=>{
      const ids=(job.member_ids as string[]).map(Number),members=ids.map(id=>byID.get(id));
      if(members.some(n=>!n))throw new Error('Cold graph member disappeared from a fenced snapshot');
      const fingerprint=createHash('sha256').update(JSON.stringify(members.map(n=>[Number(n!.id),n!.content_version]))).digest('hex');
      const summary=Array.from(members.map(n=>`#${n!.id} ${n!.kind}/${n!.state}: ${n!.summary}`).join('\n')).slice(0,6000).join('');
      return {chunk:Number(job.chunk_id),ids,fingerprint,payload:{summary,member_ids:ids,fingerprint,mode:'extractive',round}};
    });
    const existing=(await tx.query(`SELECT DISTINCT ON(payload->>'fingerprint') id,payload->>'fingerprint' fingerprint
      FROM exploration_nodes WHERE exploration_id=$1 AND kind='digest' AND state='active' AND payload->>'fingerprint'=ANY($2::text[])
      ORDER BY payload->>'fingerprint',id`,[expID,prepared.map(p=>p.fingerprint)])).rows;
    const digestIDs=new Map(existing.map(n=>[String(n.fingerprint),Number(n.id)]));
    const missing=prepared.filter(p=>!digestIDs.has(p.fingerprint));
    if(missing.length){
      const inserted=(await tx.query(`INSERT INTO exploration_nodes(exploration_id,kind,state,payload,origin)
        SELECT $1,'digest','active',x.payload,'system' FROM jsonb_to_recordset($2::jsonb) x(payload jsonb)
        RETURNING id,payload->>'fingerprint' fingerprint`,[expID,JSON.stringify(missing.map(p=>({payload:p.payload})))])).rows;
      for(const n of inserted)digestIDs.set(String(n.fingerprint),Number(n.id));created=inserted.length;
      const links=JSON.stringify(missing.map(p=>({id:digestIDs.get(p.fingerprint),ids:p.ids})));
      await tx.query(`INSERT INTO exploration_edges(exploration_id,src_id,rel,dst_id)
        SELECT $1,x.id,'covers',m.id FROM jsonb_to_recordset($2::jsonb) x(id bigint,ids bigint[])
        CROSS JOIN LATERAL unnest(x.ids) m(id) ON CONFLICT DO NOTHING`,[expID,links]);
      await tx.query(`INSERT INTO exploration_anchors(node_id,asset_id)
        SELECT DISTINCT x.id,a.asset_id FROM jsonb_to_recordset($1::jsonb) x(id bigint,ids bigint[])
        JOIN exploration_anchors a ON a.node_id=ANY(x.ids) ON CONFLICT DO NOTHING`,[links]);
    }
    await tx.query(`UPDATE cold_digest_chunks c SET digest_id=x.id,dirty=false
      FROM jsonb_to_recordset($2::jsonb) x(chunk bigint,id bigint) WHERE c.exploration_id=$1 AND c.chunk_id=x.chunk`,
      [expID,JSON.stringify(prepared.map(p=>({chunk:p.chunk,id:digestIDs.get(p.fingerprint)})))]);
  }
  // Adopt matching historical summaries before retiring untracked obsolete ones.
  // The anti-join visits summary IDs, never all original evidence or graph edges.
  if(!(await tx.query('SELECT 1 FROM cold_digest_chunks WHERE exploration_id=$1 AND dirty LIMIT 1',[expID])).rowCount)
    await tx.query(`INSERT INTO cold_digest_retire(exploration_id,digest_id)
     SELECT $1,n.id FROM exploration_nodes n WHERE n.exploration_id=$1 AND n.kind='digest' AND n.state='active'
      AND NOT EXISTS(SELECT 1 FROM cold_digest_chunks c WHERE c.digest_id=n.id) ON CONFLICT DO NOTHING`,[expID]);
  const pending=!!(await tx.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM cold_dirty_nodes WHERE exploration_id=$1)
   OR EXISTS(SELECT 1 FROM cold_digest_chunks WHERE exploration_id=$1 AND dirty)
   OR EXISTS(SELECT 1 FROM cold_node_state WHERE exploration_id=$1 AND sync_needed)
   OR EXISTS(SELECT 1 FROM cold_digest_retire WHERE exploration_id=$1)`,[expID])).rowCount;
  const due=(await tx.query('SELECT min(cold_since_round)+6 due FROM cold_node_state WHERE exploration_id=$1 AND NOT eligible AND cold_since_round IS NOT NULL',[expID])).rows[0]?.due;
  return {pending,created,read,changed:syncing.length,next:pending?round:due??null};
}

export async function incrementalColdGraph(db:Database,expID:number,options:{advanceRound?:boolean;signal?:AbortSignal}={}):Promise<ColdGraphResult>{
  options.signal?.throwIfAborted();if(options.advanceRound!==false)await db.query('UPDATE explorations SET round_no=round_no+1 WHERE id=$1',[expID]);
  const tx=await db.pool.connect(),key=`fate:cold-maintenance:${expID}`;let locked=false,inTransaction=false;
  try{
    locked=(await tx.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked',[key])).rows[0]?.locked===true;if(!locked)return empty('busy',true);
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');inTransaction=true;await tx.query("SET LOCAL statement_timeout='5s'");await tx.query('SET LOCAL jit=off');
    const meta=(await tx.query(`SELECT round_no,cold_revision,cold_structure_revision,cold_processed_revision,cold_next_round,
     EXISTS(SELECT 1 FROM cold_dirty_nodes WHERE exploration_id=$1) dirty FROM explorations WHERE id=$1`,[expID])).rows[0];
    if(!meta||!meta.dirty&&String(meta.cold_revision)===String(meta.cold_processed_revision)&&(meta.cold_next_round===null||Number(meta.cold_next_round)>Number(meta.round_no))){
      await tx.query('COMMIT');inTransaction=false;return empty('unchanged');
    }
    const round=Number(meta.round_no),plan=await createPlan(tx,expID,round);await tx.query('COMMIT');inTransaction=false;
    options.signal?.throwIfAborted();await new Promise<void>(resolve=>setImmediate(resolve));
    await tx.query('BEGIN');inTransaction=true;await tx.query("SET LOCAL lock_timeout='100ms'");await tx.query("SET LOCAL statement_timeout='5s'");await tx.query('SET LOCAL jit=off');
    if(!(await tx.query('SELECT pg_try_advisory_xact_lock($1) locked',[-expID])).rows[0]?.locked){await tx.query('ROLLBACK');inTransaction=false;return empty('busy',true);}
    const latest=(await tx.query('SELECT cold_structure_revision FROM explorations WHERE id=$1 FOR UPDATE NOWAIT',[expID])).rows[0];
    // Membership/hotness must match the snapshot. Content-only edits do not
    // invalidate that plan: summaries read the latest originals below and the
    // dirty-generation CAS retains edits which arrived after the snapshot.
    if(!latest||String(latest.cold_structure_revision)!==String(meta.cold_structure_revision)){await tx.query('ROLLBACK');inTransaction=false;return empty('stale',true);}
    const r=await publishPlan(tx,expID,round,plan);
    await tx.query('UPDATE explorations SET cold_processed_revision=$2,cold_next_round=$3 WHERE id=$1',[expID,meta.cold_revision,r.next]);
    await tx.query('COMMIT');inTransaction=false;
    return {status:'updated',pending:r.pending,scanned_nodes:plan.scanned+r.read,changed_nodes:r.changed,created_digests:r.created,
      classified_nodes:plan.classified,regrouped_nodes:plan.scanned,scanned_edges:plan.edges};
  }catch(error){if(inTransaction){await tx.query('ROLLBACK');inTransaction=false;}
    const code=String((error as {code?:string}).code);
    if(['55P03','57014','40P01'].includes(code))return {...empty('busy',true),retry_reason:code==='57014'?'timeout':code==='40P01'?'deadlock':'lock'};throw error;
  }finally{
    try{await tx.query(tables.map(t=>`DROP TABLE IF EXISTS pg_temp.${t}`).join(';'));}
    finally{try{if(locked)await tx.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}finally{tx.release();}}
  }
}
