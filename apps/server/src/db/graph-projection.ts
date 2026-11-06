import type {Database} from './index.js';

const MAX_BYTES=8*1024*1024,MAX_ENTRY_BYTES=256*1024,MAX_ENTRIES=256;
interface Cache {bytes:number;entries:Map<string,{stamp:string;json:string;bytes:number}>;hits:number;misses:number;}
const caches=new WeakMap<object,Cache>();
function cacheFor(db:Database){let c=caches.get(db.pool);if(!c){c={bytes:0,entries:new Map(),hits:0,misses:0};caches.set(db.pool,c);}return c;}
export function graphProjectionMetrics(db:Database){const c=cacheFor(db);return {entries:c.entries.size,bytes:c.bytes,hits:c.hits,misses:c.misses,max_bytes:MAX_BYTES};}
export function clearGraphProjectionCache(db:Database){caches.delete(db.pool);}

export async function graphProjectionRevision(db:Database,taskID:number,expID:number){
 const row=(await db.query(`SELECT bool_or(t.id=$1 AND t.exploration_id=$2 AND t.deleted_at IS NULL) valid,
  md5(string_agg(jsonb_build_array(t.id,t.exploration_id,t.coverage_enabled,t.deleted_at,e.view_revision,e.worker_queue_manual)::text,',' ORDER BY t.id)) stamp
  FROM tasks t JOIN explorations e ON e.id=t.exploration_id
  WHERE t.id=$1 OR t.id IN(SELECT source_task_id FROM task_relations WHERE task_id=$1)`,[taskID,expID])).rows[0];
 if(row?.valid!==true)throw new Error('任务已删除或探索图归属变化');
 return String(row.stamp);
}

/** Cache only graph data. Caller reads capacity, tool policy, todos and task
 * controls live. All misses run on one consistent DB snapshot; transactions
 * bypass the shared cache so uncommitted data can never escape or be reused. */
export async function graphProjection<T>(db:Database,taskID:number,expID:number,key:string,build:(db:Database)=>Promise<T>):Promise<T>{
 if(db.transactionClient||taskID<=0)return build(db);
 const cache=cacheFor(db),id=`${taskID}:${expID}:${key}`,stamp=await graphProjectionRevision(db,taskID,expID),entry=cache.entries.get(id);
 if(entry?.stamp===stamp){cache.hits++;cache.entries.delete(id);cache.entries.set(id,entry);return JSON.parse(entry.json) as T;}
 cache.misses++;
 const result=await db.transaction(async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  return {stamp:await graphProjectionRevision(tx,taskID,expID),value:await build(tx)};
 });
 const json=JSON.stringify(result.value),bytes=Buffer.byteLength(json)+Buffer.byteLength(result.stamp)+Buffer.byteLength(id);
 const previous=cache.entries.get(id);if(previous){cache.entries.delete(id);cache.bytes-=previous.bytes;}
 if(bytes<=MAX_ENTRY_BYTES){
  // No awaiting between eviction and insertion: concurrent misses cannot make
  // accounting drift, and cached values never expose mutable caller objects.
  while(cache.bytes+bytes>MAX_BYTES||cache.entries.size>=MAX_ENTRIES){const first=cache.entries.keys().next().value!;cache.bytes-=cache.entries.get(first)!.bytes;cache.entries.delete(first);}
  cache.entries.set(id,{stamp:result.stamp,json,bytes});cache.bytes+=bytes;
 }
 return result.value;
}

export async function nodeProjectionCounts(db:Database,taskID:number,expID:number){
 // Visibility is task ownership in this project (approvals were removed).
 // Keep this live join: a soft-deleted task must not return cached counts.
 const r=(await db.query(`SELECT COALESCE(sum(c.n) FILTER(WHERE kind='intent' AND state='open'),0) open,
  COALESCE(sum(c.n) FILTER(WHERE kind='intent' AND state IN('done','exhausted','blocked','stopped')),0) done,
  COALESCE(sum(c.n) FILTER(WHERE kind='fact' AND state='confirmed'),0) facts
  FROM exploration_node_counts c JOIN tasks t ON t.exploration_id=c.exploration_id
  WHERE t.id=$1 AND t.exploration_id=$2 AND t.deleted_at IS NULL`,[taskID,expID])).rows[0]!;
 return {open:Number(r.open),done:Number(r.done),facts:Number(r.facts)};
}
