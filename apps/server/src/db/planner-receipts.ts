import {createHash} from 'node:crypto';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {textHashAsync} from '../async-text.js';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import type {Database} from './index.js';
import {plannerTitle} from '../agent/planner-title.js';
import {plannerTextCacheable} from '../agent/planner-history-entry.js';
import {assertPlannerHostState} from './planner-host-state.js';
import type {PlannerHistorySnapshot} from './planner-history.js';

export const PLANNER_RECEIPT_INDEX_VERSION=1;
type Client={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,any>[]}>};
type Meta={kind:'delivery';delivery_id:string}|{kind:'assistant';message_hash:string;title:string|null}|
 {kind:'dispatch';ids:number[];unresolved:boolean;call_id:string};
const digest=async(v:unknown)=>{
 const text=JSON.stringify(v);
 if(text.length>=256*1024){await yieldLoop();return textHashAsync(text);}
 return createHash('sha256').update(text).digest('hex');
};

/** Indexed in the same transaction as the byte cursor. Membership follows
 * parent IDs, including across batches/forks, never append order alone. */
export async function indexPlannerReceiptEntries(client:Client,taskID:number,expID:number,batch:{ordinal:number;entry:SessionEntry}[]){
 if(!batch.length)return;
 const local=new Set(batch.map(v=>v.entry.id)),parents=[...new Set(batch.flatMap(v=>v.entry.parentId&&!local.has(v.entry.parentId)?[v.entry.parentId]:[]))];
 const lineage=new Map<string,string|null>((await client.query('SELECT entry_id,delivery_entry_id FROM planner_history_entries WHERE exploration_id=$1 AND entry_id=ANY($2::text[])',[expID,parents])).rows.map(r=>[String(r.entry_id),r.delivery_entry_id as string|null]));
 const updates=[];
 for(const {entry:e} of batch){
  if(e.parentId&&!lineage.has(e.parentId))throw new Error('Planner 会话缺少原始父条目；保留原文，不能猜测派单归属');
  let delivery=e.parentId?lineage.get(e.parentId)!:null,meta:Meta|null=null;
  if(e.type==='custom'&&e.customType==='planner_delivery'){
   const d=e.data as {id?:unknown;taskID?:number;expID?:number};
   if(typeof d?.id!=='string'||d.taskID!==taskID||d.expID!==expID)throw new Error('Planner 交付记录任务归属不一致');
   delivery=e.id;meta={kind:'delivery',delivery_id:d.id};
  }else if(e.type==='message'&&e.message.role==='assistant'){
   const title=plannerTitle(e.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));
   meta={kind:'assistant',message_hash:await digest(e.message),title:title&&plannerTextCacheable(title)?title:null};
  }else if(e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='add_intent'&&!e.message.isError){
   const m=e.message;let ids:number[]=[],unresolved=false;
   try{
    let out=JSON.parse(m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));
    if(typeof out?.output_ref==='string'){
     // This is a host effect receipt, not a grant to read arbitrary artifacts.
     // Require the exact task, tool and call; never accept an unverified preview.
     const row=(await client.query(`SELECT body FROM tool_output_artifacts WHERE id::text=$1 AND task_id=$2
      AND tool='add_intent' AND tool_call_id=$3 AND conversation_id IS NULL AND node_id IS NULL`,[out.output_ref,taskID,m.toolCallId])).rows[0];
     if(!row)throw new Error('missing output');out=JSON.parse(String(row.body));
    }
    if(!Array.isArray(out?.intents))throw new Error('invalid receipt');
    for(const item of out.intents){
     if(!item||typeof item.created!=='boolean'||!Number.isSafeInteger(item.intent_id)||item.intent_id<=0){unresolved=true;continue;}
     if(item.created)ids.push(item.intent_id);
    }
   }catch{unresolved=true;}
   meta={kind:'dispatch',ids:[...new Set(ids)],unresolved,call_id:plannerTextCacheable(m.toolCallId)?m.toolCallId:''};
  }
  lineage.set(e.id,delivery);updates.push({entry_id:e.id,delivery_entry_id:delivery,receipt_meta:meta?JSON.stringify(meta):null});
 }
 await client.query(`UPDATE planner_history_entries e SET delivery_entry_id=x.delivery_entry_id,receipt_meta=x.receipt_meta
  FROM jsonb_to_recordset($2::jsonb) x(entry_id text,delivery_entry_id text,receipt_meta text) WHERE e.exploration_id=$1 AND e.entry_id=x.entry_id`,[expID,JSON.stringify(updates)]);
}

/** Only compact scalar metadata enters JS. The current native branch and host
 * committed effects survive compaction; original messages are still recallable. */
export async function readPlannerDispatchPage(db:Database,s:PlannerHistorySnapshot,deliveryID:string,options:{leafID?:string|null;after?:number;limit?:number}={}){
 await assertPlannerHostState(db,s);
 const version=(await db.query('SELECT receipt_index_version FROM planner_history_sources WHERE exploration_id=$1',[s.expID])).rows[0];
 if(Number(version?.receipt_index_version)!==PLANNER_RECEIPT_INDEX_VERSION)throw new Error('Planner 派单索引尚未建立');
 const after=options.after??0,limit=options.limit??100;
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('无效派单分页参数');
 const result=await db.transaction(async tx=>{
  await tx.query('SET LOCAL jit=off');
  return tx.query(`WITH RECURSIVE target AS (
   SELECT e.entry_id,e.ordinal FROM planner_host_state h JOIN planner_history_entries e ON e.exploration_id=h.exploration_id AND e.ordinal=h.ordinal
    WHERE h.exploration_id=$1 AND h.namespace='delivery' AND h.key=$3 AND e.ordinal<$2
  ), branch AS (
   SELECT ordinal,entry_id,parent_id,delivery_entry_id,receipt_meta FROM planner_history_entries
    WHERE exploration_id=$1 AND ordinal<$2 AND (($4::text IS NULL AND ordinal=$2-1) OR entry_id=$4)
   UNION ALL SELECT p.* FROM branch b JOIN LATERAL (
    SELECT ordinal,entry_id,parent_id,delivery_entry_id,receipt_meta FROM planner_history_entries
     WHERE exploration_id=$1 AND entry_id=b.parent_id AND ordinal<b.ordinal AND b.ordinal>(SELECT ordinal FROM target) OFFSET 0
   ) p ON true
  ), entries AS (SELECT *,receipt_meta::jsonb meta FROM branch WHERE delivery_entry_id=(SELECT entry_id FROM target)),
  candidates AS (
   SELECT DISTINCT (x.value)::bigint id FROM entries e CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(e.meta->'ids','[]')) x
   UNION SELECT intent_id FROM planner_dispatch_items WHERE exploration_id=$1 AND session_id=$5 AND delivery_id=$3 AND created
  ), intents AS (SELECT c.id FROM candidates c JOIN exploration_nodes n ON n.id=c.id AND n.exploration_id=$1 AND n.kind='intent'),
  page AS (SELECT id FROM intents WHERE id>$6 ORDER BY id LIMIT $7),
  raw AS (SELECT entry_id,meta FROM entries WHERE meta->>'kind'='assistant' ORDER BY ordinal DESC LIMIT 1),
  unknowns AS (SELECT entry_id FROM entries e WHERE meta->>'unresolved'='true' AND NOT EXISTS(
   SELECT 1 FROM planner_dispatch_calls c WHERE c.exploration_id=$1 AND c.session_id=$5 AND c.delivery_id=$3 AND c.tool_call_id=e.meta->>'call_id'))
  SELECT (SELECT entry_id FROM target) delivery_entry_id,
   EXISTS(SELECT 1 FROM branch WHERE entry_id=(SELECT entry_id FROM target)) in_branch,
   EXISTS(SELECT 1 FROM branch b JOIN planner_host_state h ON h.exploration_id=$1 AND h.ordinal=b.ordinal
    WHERE h.namespace='context' AND h.subject_ref='planner:'||$3) input_saved,
   (SELECT count(*) FROM intents) total,COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM page),'[]') ids,
   (SELECT md5(COALESCE(string_agg(id::text,',' ORDER BY id),'')) FROM intents) membership_hash,
   (SELECT count(*) FROM unknowns) unresolved_total,
   COALESCE((SELECT jsonb_agg(entry_id) FROM (SELECT entry_id FROM unknowns ORDER BY entry_id LIMIT 10) u),'[]') unresolved_refs,
   (SELECT entry_id FROM raw) raw_id,(SELECT meta->>'message_hash' FROM raw) raw_hash,(SELECT meta->>'title' FROM raw) title,
   EXISTS(SELECT 1 FROM intents WHERE id>COALESCE((SELECT max(id) FROM page),$6)) has_more`,
   [s.expID,s.count,deliveryID,options.leafID??null,s.sessionID,after,limit]);
 });
 const r=result.rows[0];if(!r?.delivery_entry_id||!r.in_branch)throw new Error('当前 Planner 分支中不存在该交付，不能生成空派单回执');
 return {delivery_ref:`session:${r.delivery_entry_id}`,input_saved:Boolean(r.input_saved),membership_hash:String(r.membership_hash),total:Number(r.total),ids:(r.ids as (string|number)[]).map(Number),has_more:Boolean(r.has_more),
  unresolved_total:Number(r.unresolved_total),unresolved_refs:(r.unresolved_refs as string[]).map(id=>`session:${id}`),
  raw_ref:r.raw_id?`session:${r.raw_id}`:undefined,raw_message_hash:r.raw_hash?String(r.raw_hash):undefined,planning_title:r.title as string|null};
}
