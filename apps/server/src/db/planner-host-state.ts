import {HOST_STORES,sessionHostStore,isAgentHistory,type HostSnapshot} from './session-host-store.js';
import type {PoolClient} from 'pg';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import type {Database} from './index.js';
import type {PlannerHistorySnapshot} from './planner-history.js';
import {readCoverageEntry,type ReadCoverage} from '../agent/planner-grounding.js';
import {continuationEntry,type ContextNeed} from '../agent/context-needs.js';
import {TASK_GRAPH_CTE} from './graph_view.js';
import {createHash} from 'node:crypto';

/** Metadata is a rebuildable projection of host-generated native entries/tool
 * results. Model prose is never interpreted as a delivery or read receipt. */
export const PLANNER_HOST_INDEX_VERSION=6;
type Change={namespace:string;key:string;data:string;ordinal:number;subject_ref:string|null;content_version:number|null;incomplete:boolean|null;context_ids:number[]|null;wakeup_ids:number[]|null;need_data:string|null;need_key:string|null;need_hash:string|null;need_priority:number|null};
export const plannerNeedKey=(n:ContextNeed)=>createHash('sha256').update(JSON.stringify([n.ref,n.reason,n.intent_id,n.read])).digest('hex');
export function unreadNeed(r:ReadCoverage):ContextNeed{
 return {ref:r.ref,priority:70,reason:'unread_range',version:r.version,read:{tool:'context_get',args:{items:[{
  ref:r.ref,view:r.view,field:r.field,version:r.version,offset:r.missing[0]![0],...(r.page_cursor?{cursor:r.page_cursor}:{})
 }]}}};
}
class Changes<T> extends Map<string,T>{
 readonly touched=new Map<string,T|undefined>();
 override set(key:string,value:T){super.set(key,value);this.touched?.set(key,value);return this;}
 override delete(key:string){this.touched.set(key,undefined);return super.delete(key);}
}

/** Uses the same transaction/client as history indexing; no second connection,
 * and the byte cursor cannot commit ahead of its metadata. */
export async function indexPlannerHostEntries(client:{query(text:string,values?:unknown[]):Promise<{rows:Record<string,any>[]}>},expID:number|string,batch:{ordinal:number;entry:SessionEntry}[],store:keyof typeof HOST_STORES='planner'){
 const {table,column}=HOST_STORES[store];
 if(!batch.some(({entry:e})=>e.type==='custom'&&['planner_delivery','planner_delivery_completed','planner_grounded_result'].includes(e.customType)||
   e.type==='custom_message'&&e.customType==='fate_context'||
   e.type==='message'&&(e.message.role==='toolResult'&&['context_get','context_search'].includes(e.message.toolName)||
     e.message.role==='assistant'&&e.message.content.some(b=>b.type==='toolCall'&&['context_get','context_search'].includes(b.name)))))return;
 const readKeys=new Map<string,ReadCoverage>(),callIDs=new Set<string>();
 for(const {entry} of batch){
  readCoverageEntry(readKeys,entry);
  if(entry.type==='message'&&entry.message.role==='toolResult'&&['context_search','context_get'].includes(entry.message.toolName))callIDs.add(entry.message.toolCallId);
 }
 const prior=(await client.query(`SELECT namespace,key,data FROM ${table} WHERE ${column}=$1
  AND ((namespace='read' AND key=ANY($2::text[])) OR (namespace='call' AND key=ANY($3::text[])))`,[expID,[...readKeys.keys()],[...callIDs]])).rows;
 const reads=new Changes<ReadCoverage>(),calls=new Changes<Record<string,unknown>>(),pending=new Changes<ContextNeed>();
 for(const row of prior)(row.namespace==='read'?reads:calls).set(row.key,JSON.parse(row.data));
 reads.touched.clear();calls.touched.clear();
 const changed=new Map<string,Change>(),deleted=new Map<string,{namespace:string;key:string}>(),deliveryIDs=new Set<string>();
 const put=(namespace:string,key:string,data:unknown,ordinal:number)=>{
  const d=data as Record<string,unknown>,id=JSON.stringify([namespace,key]);deleted.delete(id);
  const need=namespace==='continuation'?data as ContextNeed:namespace==='read'&&!(data as ReadCoverage).fully_delivered?unreadNeed(data as ReadCoverage):undefined;
  const need_data=need?JSON.stringify(need):null;
  changed.set(id,{namespace,key,data:JSON.stringify(data),ordinal,
   subject_ref:namespace==='read'||namespace==='continuation'?String(d.ref):namespace==='result'?String(d.raw_message_hash??''):namespace==='context'?String(d.key):null,
   content_version:['read','continuation'].includes(namespace)&&Number.isSafeInteger(d.version)?Number(d.version):null,
   incomplete:namespace==='read'?d.fully_delivered!==true:namespace==='delivery'?true:null,
   context_ids:namespace==='delivery'?d.contextIDs as number[]:null,wakeup_ids:namespace==='delivery'?d.wakeupIDs as number[]:null,
   need_data,need_key:need?plannerNeedKey(need):null,need_hash:need_data?createHash('sha256').update(need_data).digest('hex'):null,need_priority:need?.priority??null});
 };
 const drain=(namespace:string,map:Changes<unknown>,ordinal:number)=>{
  for(const [key,value] of map.touched)if(value===undefined){const id=JSON.stringify([namespace,key]);changed.delete(id);deleted.set(id,{namespace,key});}else put(namespace,key,value,ordinal);
  map.touched.clear();
 };
 for(const {ordinal,entry} of batch){
  readCoverageEntry(reads,entry);continuationEntry({calls,pending},entry);
  drain('read',reads,ordinal);drain('call',calls,ordinal);drain('continuation',pending,ordinal);
  if(entry.type==='custom_message'&&entry.customType==='fate_context'){
   const key=(entry.details as {key?:unknown}|undefined)?.key;
   if(typeof key==='string'&&key.length<=512)put('context',entry.id,{key,entry_id:entry.id},ordinal);
  }
  if(entry.type!=='custom')continue;
  const d=entry.data as Record<string,unknown>|undefined;if(!d)continue;
  if(entry.customType==='planner_delivery'){
   if(typeof d.id!=='string'||!Array.isArray(d.contextIDs)||!Array.isArray(d.wakeupIDs))throw new Error('Planner 历史交付记录损坏，已保留原文');
   put('delivery',d.id,d,ordinal);
   deliveryIDs.add(d.id);
   for(const [key,value] of Object.entries(d.seen??{}))put('seen',key,value,ordinal);
  }else if(entry.customType==='planner_delivery_completed'&&typeof d.deliveryID==='string'){put('completion',d.deliveryID,d,ordinal);deliveryIDs.add(d.deliveryID);}
  else if(entry.customType==='planner_grounded_result'&&typeof d.delivery_id==='string')put('result',d.delivery_id,d,ordinal);
 }
 if(deleted.size)await client.query(`DELETE FROM ${table} s USING jsonb_to_recordset($2::jsonb) x(namespace text,key text)
  WHERE s.${column}=$1 AND s.namespace=x.namespace AND s.key=x.key`,[expID,JSON.stringify([...deleted.values()])]);
 if(changed.size)await client.query(`INSERT INTO ${table}(${column},namespace,key,data,ordinal,subject_ref,content_version,incomplete,context_ids,wakeup_ids,need_data,need_key,need_hash,need_priority)
  SELECT $1,x.* FROM jsonb_to_recordset($2::jsonb) x(namespace text,key text,data text,ordinal bigint,subject_ref text,content_version bigint,incomplete boolean,context_ids bigint[],wakeup_ids bigint[],need_data text,need_key text,need_hash text,need_priority int)
  ON CONFLICT(${column},namespace,key) DO UPDATE SET data=EXCLUDED.data,ordinal=EXCLUDED.ordinal,subject_ref=EXCLUDED.subject_ref,
   content_version=EXCLUDED.content_version,incomplete=EXCLUDED.incomplete,context_ids=EXCLUDED.context_ids,wakeup_ids=EXCLUDED.wakeup_ids,
   need_data=EXCLUDED.need_data,need_key=EXCLUDED.need_key,need_hash=EXCLUDED.need_hash,need_priority=EXCLUDED.need_priority`,[expID,JSON.stringify([...changed.values()])]);
 // A partial index of unfinished deliveries avoids an ordered anti-join over
 // the entire history merely to discover that no delivery needs recovery.
 if(deliveryIDs.size)await client.query(`UPDATE ${table} d SET incomplete=false
  WHERE d.${column}=$1 AND d.namespace='delivery' AND d.key=ANY($2::text[]) AND d.incomplete
   AND EXISTS(SELECT 1 FROM ${table} c WHERE c.${column}=d.${column} AND c.namespace='completion' AND c.key=d.key)`,[expID,[...deliveryIDs]]);
}

/** Host indexes represent the latest synchronized prefix, not a search snapshot.
 * Fail explicitly if a second synchronizer advanced/replaced that prefix. */
export async function assertPlannerHostState(db:Database,s:HostSnapshot){
 const {sources,column,key}=sessionHostStore(s),native=isAgentHistory(s);
 const live=native?` AND scope=$6::jsonb
  AND (s.task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=s.task_id AND t.exploration_id=s.exploration_id AND t.deleted_at IS NULL))
  AND (s.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=s.conversation_id AND c.agent_key=s.role AND COALESCE(c.task_id,0)=COALESCE(s.task_id,0)))`:'';
 const r=(await db.query(`SELECT 1 FROM ${sources} s WHERE ${column}=$1 AND task_id IS NOT DISTINCT FROM $2 AND generation=$3
  AND entry_count=$4 AND host_index_version=$5 ${live}`,[key,s.taskID||null,s.generation,s.count,PLANNER_HOST_INDEX_VERSION,...(native?[JSON.stringify(s.scope)]:[])])).rowCount;
 if(!r)throw new Error('会话宿主历史索引已变化或不可用，请重新加载当前会话');
}
export async function plannerHostValues<T>(db:Database,s:HostSnapshot,namespace:string,keys:string[]):Promise<Map<string,T>>{
 if(!keys.length)return new Map();
 await assertPlannerHostState(db,s);
 const {table,column,key}=sessionHostStore(s);
 const r=await db.query(`SELECT key,data FROM ${table} WHERE ${column}=$1 AND namespace=$2 AND key=ANY($3::text[])`,[key,namespace,keys]);
 return new Map(r.rows.map(r=>[String(r.key),JSON.parse(String(r.data)) as T]));
}

/** Revalidate every referenced graph version and direct-source membership in
 * the database. Return only the latest window, with exact total/gap counts. */
export async function plannerHostReadWindow(db:Database,s:PlannerHistorySnapshot,limit=20){
 await assertPlannerHostState(db,s);
 const r=await db.transaction(async tx=>{
  // This short metadata query can cross PostgreSQL's JIT cost threshold even
  // when it returns twenty rows. Compilation costs exceed its useful work.
  await tx.query('SET LOCAL jit=off');
  return (await tx.query(`WITH ${TASK_GRAPH_CTE}, valid AS MATERIALIZED (
  SELECT h.key,h.ordinal,h.incomplete FROM planner_host_state h WHERE h.exploration_id=$2 AND h.namespace='read' AND (
   (h.subject_ref LIKE 'session:%' AND EXISTS(SELECT 1 FROM planner_history_entries e
     WHERE e.exploration_id=$2 AND e.entry_id=substring(h.subject_ref FROM 9) AND e.ordinal<$3)) OR
   (h.subject_ref LIKE 'node:%' AND EXISTS(SELECT 1 FROM visible n WHERE n.id=CASE WHEN h.subject_ref ~ '^node:[1-9][0-9]*$' THEN substring(h.subject_ref FROM 6)::bigint END AND n.content_version=h.content_version))
  )
 ), latest AS (SELECT key,ordinal FROM valid ORDER BY ordinal DESC,key DESC LIMIT $4)
 SELECT (SELECT count(*) FROM valid) total,(SELECT count(*) FROM valid WHERE incomplete) incomplete,
  COALESCE((SELECT jsonb_agg(h.data ORDER BY l.ordinal,l.key) FROM latest l JOIN planner_host_state h
    ON h.exploration_id=$2 AND h.namespace='read' AND h.key=l.key),'[]'::jsonb) records`,[s.taskID,s.expID,s.count,limit])).rows[0]!;
 });
 return {reads:(r.records as string[]).map(text=>JSON.parse(text) as ReadCoverage),total:Number(r.total),incomplete:Number(r.incomplete)};
}
