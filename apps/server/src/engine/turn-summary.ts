import {projectPlannerDisplay} from '../db/planner-rounds.js';
import {turnProjectionSQL,turnUsageRefreshSQL,turnReferenceRefreshSQL,TURN_MODEL_PAGE_SIZE} from '../db/turn-projection.js';
import {readTurnRevisions} from '../db/turn-read-versions.js';
import {getTurnProjection,putTurnProjection,forgetTurnProjection,recordTurnProjectionRead} from '../db/turn-projection-cache.js';
import {turnDeltaSQL,turnControlDeltaSQL,retainTurnControls} from '../db/turn-projection-delta.js';
import {prepareUsageRollups} from '../db/usage-rollups.js';
import {turnModelPageSQL} from '../db/turn-models.js';
import {prepareActivityRollups,turnIndexedActivitySQL} from '../db/activity-rollups.js';
import {prepareNativeRollups,turnNativeProjectionSQL} from '../db/native-response-rollups.js';
import {prepareNativeRanges,advancePendingNativeRanges} from '../db/native-range-rollups.js';
import {turnMixedProjectionSQL} from '../db/mixed-turn-rollups.js';
import type {Database} from '../db/index.js';
import {activityDTO,type StreamScope} from './live-stream.js';

type Row = Record<string,any>;
export type TurnProjectionFacts={response?:Row;steps:number;toolCalls:number;failedToolCalls:number;models:string[];usage:Row|null;attemptUpdatedAt?:string|null;observedAt:string};
const iso=(value:unknown)=>value?new Date(value as string).toISOString():null;
const tokenTotal=(u:Row)=>['input','output','cacheRead','cacheWrite'].reduce((n,k)=>n+(Number(u?.[k])||0),0);

/** Read model, never execution authority. All counts come from full durable turns,
 * not the current UI page. Native message IDs and call IDs are idempotency keys. */
export function projectTurn(rows:Row[],attempts:Row[],runtime?:Row,facts?:TurnProjectionFacts) {
 const start=rows.find(r=>r.metadata?.event_type==='turn_start');
 const terminal=rows.findLast(r=>['lifecycle','outcome'].includes(r.metadata?.event_type));
 const first=rows[0]!,last=rows.at(-1)!;
 const responseRows=[...new Map(rows.filter(r=>r.metadata?.response&&r.metadata.stream_id).map(r=>[r.metadata.stream_id,r])).values()];
 const tools=new Set(rows.filter(r=>r.kind==='tool_use'&&r.tool_use_id).map(r=>r.tool_use_id));
 const errors=new Set(rows.filter(r=>r.kind==='tool_result'&&r.is_error&&r.tool_use_id).map(r=>r.tool_use_id));
 const response=facts?facts.response:responseRows.at(-1);
 const nativeEnd=rows.findLast(r=>r.metadata?.event_type==='runner_settled');
 const statusOverride=terminal?.metadata.event_type!=='outcome'&&nativeEnd?.metadata.stop_reason==='budget'&&['completed','stopped'].includes(terminal?.metadata.status)?'exhausted':undefined;
 const completed=terminal&&!statusOverride&&['completed','done'].includes(terminal.metadata.status);
 // A native stop without tool calls is only final after the HOST accepts completion.
 const explicit=rows.findLast(r=>r.metadata?.final_answer&&!r.metadata?.raw_source_only&&r.metadata?.event_type!=='steering');
 const final=terminal?.metadata.event_type==='outcome'?terminal:completed&&explicit?explicit:completed&&!response?.metadata.raw_source_only&&response?.metadata.response.stop_reason==='stop'&&!response.metadata.response.has_tools&&response.kind!=='status'&&response.summary?response:undefined;
 const now=facts?Date.parse(facts.observedAt):Date.now();
 const expired=runtime&&(runtime.stop_reason==='executor_expired'||!runtime.finished_at&&new Date(runtime.expires_at).getTime()<=now||runtime.finished_at&&now-new Date(runtime.finished_at).getTime()>12000);
 const status=statusOverride??terminal?.metadata.status??(expired?'interrupted':runtime?.finished_at?'awaiting_confirmation':start?'running':'unknown');
 const models=attempts.length?attempts.map(a=>a.model):responseRows.map(r=>r.metadata.response).filter(r=>r.provider!=='series-router').map(r=>r.model);
 const modelSequence=models.filter((m,i)=>m&&m!==models[i-1]);
 const nativeUsage=responseRows.map(r=>r.metadata.response.usage).filter(Boolean);
 const covered=new Set(attempts.map(a=>a.runtime_id).filter(Boolean));
 // Activity rows arrive in durable ID order. Track execution boundaries once;
 // rescanning the whole turn for every response made long tool loops quadratic.
 const fallback:Row[]=[];
 if(covered.size){let runtimeID:unknown;for(const r of rows){
  if(r.metadata?.event_type==='turn_start')runtimeID=r.metadata.runtime_id;
  if(r.metadata?.response&&r.metadata.stream_id&&!covered.has(runtimeID))fallback.push(r);
 }}
 const usageRows=attempts.length?[...attempts.map(a=>a.usage??{}),...fallback.map(r=>r.metadata.response.usage).filter(Boolean)]:nativeUsage;
 const usageKnown=usageRows.length>0&&usageRows.some(u=>Object.keys(u).some(k=>['input','output','cacheRead','cacheWrite'].includes(k)));
 const sum=(kind:string)=>usageRows.reduce((n,u)=>n+(Number(u[kind])||0),0);
 const auditKnown=attempts.length>0;
 const startedAt=iso(start?.metadata.started_at);
 const requested=rows.find(r=>r.kind==='user'&&r.metadata?.event_type!=='steering');
 const attemptUpdatedAt=facts?new Date(facts.attemptUpdatedAt??0).getTime():attempts.reduce((latest,a)=>Math.max(latest,new Date(a.finished_at??0).getTime()),0);
 return {planner_round:projectPlannerDisplay(rows),version:1,turn_id:String(first.metadata.turn_id),revision:Number(last.id),updated_at:new Date(Math.max(new Date(last.created_at).getTime(),attemptUpdatedAt,new Date(runtime?.finished_at??0).getTime(),expired?new Date(runtime?.expires_at??0).getTime():0)).toISOString(),
  worker:first.worker,role:start?.metadata.role??runtime?.role??null,intent_id:first.node_id==null?null:String(first.node_id),main_seg:first.main_seg??null,
  status,started_at:startedAt,finished_at:iso(terminal?.created_at??(expired?runtime?.finished_at??runtime?.expires_at:null)),
  queue_ms:startedAt&&requested?Math.max(0,Date.parse(startedAt)-new Date(requested.created_at).getTime()):null,
  mode:start?.metadata.mode??null,steps:start?facts?.steps??responseRows.length:null,tool_calls:start?facts?.toolCalls??tools.size:null,failed_tool_calls:start?facts?.failedToolCalls??errors.size:null,
  models:facts?.models??modelSequence,usage:facts?facts.usage:usageKnown?{input:sum('input')+sum('cacheRead')+sum('cacheWrite'),uncached_input:sum('input'),output:sum('output'),cache_read:sum('cacheRead'),cache_write:sum('cacheWrite'),
   total:usageRows.reduce((n,u)=>n+tokenTotal(u),0),incomplete:attempts.some(a=>a.status==='running'||a.quality&&!['complete','not_sent'].includes(a.quality)||a.usage?.unavailable||!Object.keys(a.usage??{}).length||['failed','aborted'].includes(String(a.status))&&tokenTotal(a.usage)===0),
   source:auditKnown?'provider_audit':'native_response',compaction_requests:auditKnown?attempts.filter(a=>a.purpose==='compaction').length:null,
   compaction_tokens:auditKnown?attempts.filter(a=>a.purpose==='compaction').reduce((n,a)=>n+tokenTotal(a.usage),0):null,
   failed_requests:auditKnown?attempts.filter(a=>['failed','aborted'].includes(String(a.status))).length:null,
   failed_request_tokens:auditKnown?attempts.filter(a=>['failed','aborted'].includes(String(a.status))).reduce((n,a)=>n+tokenTotal(a.usage),0):null}:null,
  final_activity:final?activityDTO(final):null,
  error:terminal&&(terminal.is_error||['failed','blocked','exhausted','stopped','paused'].includes(status))?statusOverride?'模型请求预算耗尽；本轮未自然完成':String(terminal.summary??''):null};
}

export async function readTurnSummaries(db:Database,scope:StreamScope,id:number,ids:string[],modelOffset=0) {
 if(!ids.length)return [];
 // Initialize conservative historical dependencies before taking the data snapshot.
 const hints=new Map<string,Row>();
 const revisions=await readTurnRevisions(db,scope,id,ids,hints);
 const scopeID=scope==='task'?Number((await db.query('SELECT id FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL',[id])).rows[0]?.id):id;
 if(!Number.isSafeInteger(scopeID)||scopeID<1)return [];
 const found=new Map<string,Row>(),referenceCached=new Map<string,Row>(),cacheID=`${scopeID}:${id}`,nativeCached=new Set<string>(),mixedCached=new Set<string>();
 // Refresh the bounded first-page projection independently of requested model
 // pages. Later pages never replace that cache or retain full model histories.
 {
  const candidates=ids.flatMap(turn=>{const row=revisions.has(turn)?getTurnProjection(db,scope,cacheID,turn):undefined;return row?[row]:[];});
  for(const r of candidates)if(r.projection_source==='native')nativeCached.add(r.turn_id);
  for(const r of candidates)if(r.projection_source==='mixed')mixedCached.add(r.turn_id);
  for(const r of candidates)if(r.projection_source==='reference'&&r.projection_revision===revisions.get(r.turn_id))referenceCached.set(r.turn_id,r);
  if(candidates.length){
   // A complete fallback can be correct while a lazy index is busy/partial.
   // Do not let that cached result permanently suppress the remaining batches.
   const descriptors=candidates.filter(r=>r.projection_source!=='reference').map(r=>({turn_id:r.turn_id,last_id:r.rows.at(-1).id,activity_version:r.activity_version,stable_fingerprint:r.stable_fingerprint,runtime_id:r.runtime_id,
    rewrite_version:r.rewrite_version,control_fingerprint:r.control_fingerprint,activity_fingerprint:r.activity_fingerprint,append_fingerprint:r.append_fingerprint,
    response_id:r.response?.id,response_first_id:r.response_first_id}));
   const plain=descriptors.filter(r=>hints.get(r.turn_id)?.stable_fingerprint===r.stable_fingerprint);
   const deltas:Row[]=plain.length?(await db.query(turnDeltaSQL(scope),[scope,scopeID,plain.map(r=>r.turn_id),id,JSON.stringify(plain)])).rows:[];
   const previous=new Map(candidates.map(r=>[r.turn_id,r]));
   for(const d of deltas){const old=previous.get(d.turn_id)!;
    found.set(d.turn_id,{...old,...d,rows:retainTurnControls([...old.rows,...d.rows],old.response),tools:Number(old.tools)+Number(d.tools_added),errors:Number(old.errors)+Number(d.errors_added)});
   }
   recordTurnProjectionRead(db,'delta_reads',deltas.length);
   const controls=descriptors.filter(r=>!found.has(r.turn_id)&&hints.get(r.turn_id)?.control_fingerprint===r.control_fingerprint);
   if(controls.length){
    const refreshed:Row[]=(await db.query(turnControlDeltaSQL(scope),[scope,scopeID,controls.map(r=>r.turn_id),id,JSON.stringify(controls)])).rows;
    for(const d of refreshed){const old=previous.get(d.turn_id)!;
     const response=old.response?d.rows.find((r:Row)=>String(r.id)===String(old.response.id)):undefined;
     found.set(d.turn_id,{...old,...d,response,rows:retainTurnControls(d.rows,response),tools:Number(old.tools)+Number(d.tools_added),errors:Number(old.errors)+Number(d.errors_added)});
    }
    recordTurnProjectionRead(db,'control_reads',refreshed.length);
   }
   const receipts=descriptors.filter(r=>!found.has(r.turn_id)&&hints.get(r.turn_id)?.append_fingerprint===r.append_fingerprint);
   if(receipts.length){
    await prepareUsageRollups(db,scope,scopeID,receipts.map(r=>r.turn_id));
    const params=[scope,scopeID,receipts.map(r=>r.turn_id),id,0,TURN_MODEL_PAGE_SIZE,JSON.stringify(receipts)];
    const refreshed:Row[]=(await db.query(turnUsageRefreshSQL(scope,true),params)).rows;
    for(const r of refreshed){
     const old=previous.get(r.turn_id)!,{append_rows,append_response,steps_added,tools_added,errors_added,...next}=r;
     const response=append_response??undefined;
     // A newer version of the same response replaces its prior control row.
     const rows=[...new Map([...old.rows,...append_rows,...(response?[response]:[])].map(a=>[String(a.id),a])).values()]
      .sort((a,b)=>Number(a.id)-Number(b.id));
     found.set(r.turn_id,{...old,...next,response,rows:retainTurnControls(rows,response),
      steps:Number(old.steps)+Number(steps_added),tools:Number(old.tools)+Number(tools_added),errors:Number(old.errors)+Number(errors_added)});
    }
    recordTurnProjectionRead(db,'receipt_reads',refreshed.length);
   }
  }
 }
 const nativeReady=ids.filter(turn=>!found.has(turn)&&nativeCached.has(turn));
 if(nativeReady.length){
  const rows:Row[]=(await db.query(turnNativeProjectionSQL(scope),[scope,scopeID,nativeReady,id,0,TURN_MODEL_PAGE_SIZE])).rows;
  for(const r of rows)found.set(r.turn_id,r);
  recordTurnProjectionRead(db,'indexed_reads',rows.length);
 }
 const mixedReady=ids.filter(turn=>!found.has(turn)&&mixedCached.has(turn));
 if(mixedReady.length){
  const rows:Row[]=(await db.query(turnMixedProjectionSQL(scope),[scope,scopeID,mixedReady,id,0,TURN_MODEL_PAGE_SIZE])).rows;
  for(const r of rows)found.set(r.turn_id,r);
  recordTurnProjectionRead(db,'indexed_reads',rows.length);
 }
 const advancing=await advancePendingNativeRanges(db,scope,scopeID,id,ids.filter(turn=>!found.has(turn)&&referenceCached.has(turn)));
 if(advancing.ready.size){
  const rows:Row[]=(await db.query(turnMixedProjectionSQL(scope),[scope,scopeID,[...advancing.ready],id,0,TURN_MODEL_PAGE_SIZE])).rows;
  for(const r of rows)found.set(r.turn_id,r);recordTurnProjectionRead(db,'indexed_reads',rows.length);
 }
 const changed=ids.filter(turn=>!found.has(turn)&&!advancing.handled.has(turn));
 if(changed.length){
  const usageReady=await prepareUsageRollups(db,scope,scopeID,changed);
  if(usageReady){
  await prepareActivityRollups(db,scope,scopeID,id,changed);
  const indexed:Row[]=(await db.query(turnIndexedActivitySQL(scope),[scope,scopeID,changed,id,0,TURN_MODEL_PAGE_SIZE])).rows;
  for(const r of indexed)found.set(r.turn_id,r);
  recordTurnProjectionRead(db,'indexed_reads',indexed.length);
  const native=changed.filter(turn=>!found.has(turn));
  if(native.length){
   await prepareNativeRollups(db,scope,scopeID,id,native);
   const rows:Row[]=(await db.query(turnNativeProjectionSQL(scope),[scope,scopeID,native,id,0,TURN_MODEL_PAGE_SIZE])).rows;
   for(const r of rows)found.set(r.turn_id,r);
   recordTurnProjectionRead(db,'indexed_reads',rows.length);
  }
  const mixed=changed.filter(turn=>!found.has(turn));
  if(mixed.length){
   await prepareNativeRanges(db,scope,scopeID,id,mixed);
   const rows:Row[]=(await db.query(turnMixedProjectionSQL(scope),[scope,scopeID,mixed,id,0,TURN_MODEL_PAGE_SIZE])).rows;
   for(const r of rows)found.set(r.turn_id,r);
   recordTurnProjectionRead(db,'indexed_reads',rows.length);
  }
  }
 }
 if(modelOffset>0&&found.size){
  const candidates=[...found.keys()];
  // Cache only the first-page snapshots; the model-only query below checks the
  // same data revision before combining its page with these control/counts.
  for(const turn of candidates)if(revisions.has(turn))putTurnProjection(db,scope,cacheID,found.get(turn)!);
  await prepareUsageRollups(db,scope,scopeID,candidates);
  const pages:Row[]=(await db.query(turnModelPageSQL(scope),[scope,scopeID,candidates,id,modelOffset,TURN_MODEL_PAGE_SIZE])).rows;
  const native=candidates.filter(turn=>!pages.some(p=>p.turn_id===turn));
  if(native.length)pages.push(...(await db.query(turnNativeProjectionSQL(scope,'page'),[scope,scopeID,native,id,modelOffset,TURN_MODEL_PAGE_SIZE])).rows);
  const byTurn=new Map(pages.map(p=>[p.turn_id,p]));
  for(const turn of candidates){const old=found.get(turn)!,page=byTurn.get(turn);
   if(page&&String(page.data_revision)===String(old.data_revision))found.set(turn,{...old,...page});
   else found.delete(turn); // Concurrent edit/withdrawal or unknown ownership: one complete current snapshot.
  }
 }
 // Keep progressing the lazy indexes above. Until they are ready, an unchanged
 // complete first page remains correct; rebuilding that same full history on
 // every poll makes a many-execution bootstrap quadratic. Revalidate AFTER
 // preparation, including visibility, receipt ownership and runtime deadlines.
 // Later model pages are never substituted with the cached first page.
 if(modelOffset===0){
  const candidates=ids.filter(turn=>!found.has(turn)&&referenceCached.has(turn));
  if(candidates.length){
   const descriptors=candidates.map(turn=>{const r=referenceCached.get(turn)!;return {turn_id:turn,projection_revision:r.projection_revision,runtime_id:r.runtime_id};});
   const current:Row[]=(await db.query(turnReferenceRefreshSQL(),[scope,scopeID,candidates,id,JSON.stringify(descriptors)])).rows;
   for(const r of current)found.set(r.turn_id,{...referenceCached.get(r.turn_id)!,...r});
   recordTurnProjectionRead(db,'reference_hits',current.length);
  }
 }
 const missing=ids.filter(turn=>!found.has(turn));
 if(missing.length){
  const full:Row[]=(await db.query(turnProjectionSQL(scope),[scope,scopeID,missing,id,modelOffset,TURN_MODEL_PAGE_SIZE])).rows;
  recordTurnProjectionRead(db,'full_reads',missing.length);
  for(const r of full){r.projection_source='reference';found.set(r.turn_id,r);}
  if(modelOffset>0){
   // A direct link to a later page still warms the bounded first-page cache.
   // Reuse this complete count/control snapshot, not a second aggregation.
   const candidates=full.filter(r=>revisions.has(r.turn_id)&&r.usage?.source==='usage_ledger');
   if(candidates.length){
    await prepareUsageRollups(db,scope,scopeID,candidates.map(r=>r.turn_id));
    const pages:Row[]=(await db.query(turnModelPageSQL(scope),[scope,scopeID,candidates.map(r=>r.turn_id),id,0,TURN_MODEL_PAGE_SIZE])).rows;
    for(const r of candidates){const page=pages.find(p=>p.turn_id===r.turn_id&&String(p.data_revision)===String(r.data_revision));
     if(page)putTurnProjection(db,scope,cacheID,{...r,...page});
    }
   }
  }
 }
 if(modelOffset===0)for(const turn of ids){const r=found.get(turn);if(r&&revisions.has(turn))putTurnProjection(db,scope,cacheID,r);else forgetTurnProjection(db,scope,cacheID,turn);}
 const rows=[...found.values()].sort((a,b)=>Number(a.first_id)-Number(b.first_id));
 return rows.map(r=>({...projectTurn(r.rows.map((a:Row)=>({...a,created_at:new Date(a.created_at)})),[],r.runtime??undefined,{
  response:r.response?{...r.response,created_at:new Date(r.response.created_at)}:undefined,steps:Number(r.steps),toolCalls:Number(r.tools),failedToolCalls:Number(r.errors),
  models:r.models,usage:r.usage,attemptUpdatedAt:r.attempt_updated_at,observedAt:iso(r.observed_at)!,
 }),data_revision:revisions.has(r.turn_id)?String(r.data_revision):undefined,observed_at:iso(r.observed_at),
  models_total:Number(r.models_total),models_offset:modelOffset,
  models_next_offset:modelOffset+r.models.length<Number(r.models_total)?modelOffset+r.models.length:null,
  model_names_truncated:r.model_names_truncated,model_name_lengths:r.model_name_lengths}));
}

/** Names use Unicode offsets; page replacement never requires buffering a whole name. */
export async function readTurnModelName(db:Database,scope:StreamScope,id:number,turn:string,index:number,offset:number,version:string){
 const fail=(text:string,statusCode:number)=>Object.assign(new Error(text),{statusCode});
 const revisions=await readTurnRevisions(db,scope,id,[turn]);
 if(!revisions.has(turn))throw fail('轮次不存在或尚未完成历史索引',404);
 const scopeID=scope==='task'?Number((await db.query('SELECT id FROM tasks WHERE exploration_id=$1 AND deleted_at IS NULL',[id])).rows[0]?.id):id;
 if(!Number.isSafeInteger(scopeID)||scopeID<1)throw fail('轮次不存在或未获授权',404);
 await prepareUsageRollups(db,scope,scopeID,[turn]);
 const params=[scope,scopeID,[turn],id,index,1,offset];
 let indexed=(await db.query(turnModelPageSQL(scope,'name'),params)).rows[0];
 if(!indexed){
  await prepareActivityRollups(db,scope,scopeID,id,[turn]);await prepareNativeRollups(db,scope,scopeID,id,[turn]);
  indexed=(await db.query(turnNativeProjectionSQL(scope,'name'),params)).rows[0];
 }
 const row=indexed??(await db.query(turnProjectionSQL(scope,'name'),params)).rows[0];
 if(!row)throw fail('模型记录不存在或未获授权',404);
 if(indexed&&!indexed.has_model)throw fail('模型记录不存在或未获授权',404);
 if(String(row.data_revision)!==version)throw fail('本轮记录已变化，请重新打开详情',409);
 const total=Number(row.total_chars);if(offset>total)throw fail('读取位置超出名称范围',400);
 return {content:String(row.content),offset,total_chars:total,next_offset:Math.min(total,offset+8192),has_more:offset+8192<total,data_revision:version,offset_unit:'unicode_codepoints'};
}
