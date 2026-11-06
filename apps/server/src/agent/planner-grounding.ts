import {plannerTitle} from './planner-title.js';
import {createHash} from 'node:crypto';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import type {ToolRunContext} from '../tools/context.js';
import {TASK_GRAPH_CTE} from '../db/graph_view.js';
import {SessionIndex,sessionEntryIDs} from './session-index.js';
import {plannerHostReadWindow} from '../db/planner-host-state.js';
import {readPlannerDispatchPage} from '../db/planner-receipts.js';
import type {ReadCoordinate} from '../tools/read-coordinate.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type Interval=[number,number];
export interface ReadCoverage {
  ref:string;view:string;field:string;version?:number;source_hash:string;page_cursor?:string;
  total_chars:number;delivered:Interval[];missing:Interval[];fully_delivered:boolean;
  // Completing one field/page never establishes completeness of its containing node/query.
  scope:'field_or_page';
  coordinate?:ReadCoordinate;
}
function merge(ranges:Interval[]):Interval[]{
  const out:Interval[]=[];
  for(const [start,end] of ranges.sort((a,b)=>a[0]-b[0])){
    const last=out.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else out.push([start,end]);
  }
  return out;
}
/** Receipts are read from actual successful native tool results, not model claims.
 * Older outputs without a host receipt cannot establish complete delivery. */
export function readCoverageEntry(reads:Map<string,ReadCoverage>,entry:SessionEntry){
    if(entry.type!=='message'||entry.message.role!=='toolResult'||!['context_get','context_search'].includes(entry.message.toolName)||entry.message.isError)return;
    try{
      const result=JSON.parse(entry.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));
      const search=entry.message.toolName==='context_search';
      if(search&&result.source!=='planner_session')return;
      for(const item of result.items??[]){
        const r=item.read_receipt;
        if(item.error||!r||r.version!==1||typeof item.ref!=='string'||!(/^(node:[1-9][0-9]*|session:[a-zA-Z0-9_-]+)$/.test(item.ref))||typeof item.view!=='string'||item.field!==undefined&&typeof item.field!=='string'||!(/^([a-f0-9]{64})$/.test(r.source_hash))||typeof item.content!=='string')continue;
        if(r.coordinate&&(r.coordinate.ref!==item.ref||r.coordinate.view!==item.view||r.coordinate.field!==(item.field??'')||r.coordinate.version!==item.version||r.coordinate.cursor!==item.page_cursor||r.coordinate.unit!=='unicode_codepoints'||!['text','json'].includes(r.coordinate.format)))continue;
        const {start,end,total}=r;
        if(![start,end,total].every(Number.isSafeInteger)||start<0||end<start||end>total||end-start!==Array.from(item.content).length)continue;
        if(search&&(item.original!==true||!item.ref.startsWith('session:')||item.view!=='detail'||item.field!=='/content'||start!==0||end!==total||createHash('sha256').update(item.content).digest('hex')!==r.source_hash))continue;
        const key=JSON.stringify([item.ref,item.view,item.field??'',item.page_cursor??'']);
        let row=reads.get(key);
        if(!row||row.source_hash!==r.source_hash||row.version!==item.version||row.total_chars!==total){
          row={ref:item.ref,view:item.view,field:item.field??'',version:item.version,source_hash:r.source_hash,page_cursor:item.page_cursor,total_chars:total,delivered:[],missing:[],fully_delivered:false,scope:'field_or_page',...(r.coordinate?{coordinate:r.coordinate}:{})};
        }else row={...row,delivered:row.delivered.map(([a,b])=>[a,b]),missing:[]};
        // Previously returned rows may already belong to an append-only native
        // host receipt. Copy on update so incremental indexing cannot mutate a
        // historical snapshot in memory (the JSONL remains authoritative).
        if(end>start)row.delivered.push([start,end]);
        row.delivered=merge(row.delivered);row.missing=[];let cursor=0;
        for(const range of row.delivered){if(range[0]>cursor)row.missing.push([cursor,range[0]]);cursor=range[1];}
        if(cursor<total)row.missing.push([cursor,total]);row.fully_delivered=row.missing.length===0;
        reads.delete(key);reads.set(key,row); // Keep bounded projections ordered by the latest delivery.
      }
    }catch{/* Malformed, spilled or legacy responses are not delivery receipts. */}
}
export function plannerReadCoverage(entries:readonly SessionEntry[]):ReadCoverage[]{
  const index=new SessionIndex(()=>new Map<string,ReadCoverage>(),readCoverageEntry);
  return [...index.update(entries).values()];
}
const readIndexes=new WeakMap<NonNullable<ToolRunContext['sessionEntries']>,SessionIndex<Map<string,ReadCoverage>>>();
export function indexedReadCoverage(ctx:ToolRunContext,entries:readonly SessionEntry[]):ReadCoverage[]{
  if(!ctx.sessionEntries)return plannerReadCoverage(entries);
  let index=readIndexes.get(ctx.sessionEntries);
  if(!index){index=new SessionIndex(()=>new Map<string,ReadCoverage>(),readCoverageEntry);readIndexes.set(ctx.sessionEntries,index);}
  return [...index.update(entries).values()];
}
export async function plannerGrounding(ctx:ToolRunContext,entries:readonly SessionEntry[]){
  await ctx.hooks.assertOwnership?.(ctx.db);
  const task=await ctx.db.tasks().getTask(ctx.taskID);
  if(!task||task.exploration_id!==ctx.expID)throw new Error('Planner 证据归属已变化');
  const reported=(await ctx.db.query(`WITH ${TASK_GRAPH_CTE}
    SELECT id,content_version,payload->>'observation_type' observation_type,count(*) OVER() total
    FROM visible WHERE kind='fact' AND payload->>'observation_type'='negative' ORDER BY id DESC LIMIT 100`,[ctx.taskID])).rows;
  const durable=ctx.role==='planner'?await ctx.plannerState?.():undefined;
  let readWindow:{reads:ReadCoverage[];total:number;incomplete:number};
  if(durable)readWindow=await plannerHostReadWindow(ctx.db,durable);
  else{
  const candidates=indexedReadCoverage(ctx,entries),entryIDs=sessionEntryIDs(ctx.sessionEntries,entries);
  const nodeIDs=[...new Set(candidates.filter(r=>/^node:[1-9][0-9]*$/.test(r.ref)).map(r=>Number(r.ref.slice(5))))];
  const current=nodeIDs.length?(await ctx.db.query(`WITH ${TASK_GRAPH_CTE}
    SELECT id,content_version FROM visible WHERE id=ANY($2::bigint[])`,[ctx.taskID,nodeIDs])).rows:[];
  const versions=new Map(current.map(r=>[Number(r.id),Number(r.content_version)]));
  const reads=candidates.filter(read=>read.ref.startsWith('session:')?entryIDs.has(read.ref.slice(8)):
    read.ref.startsWith('node:')&&versions.get(Number(read.ref.slice(5)))===read.version&&versions.has(Number(read.ref.slice(5))));
  readWindow={reads:reads.slice(-20),total:reads.length,incomplete:reads.filter(r=>!r.fully_delivered).length};
  }
  return {
    version:1,negative_scope:{status:'not_verified' as const,
      // No existing model-authored field constitutes a host-verified test matrix.
      // In particular anchors, confidence, confirmed and tested coverage do not.
      direction_exclusions:[] as never[],outside_reported_observations:'unknown' as const,
      reported_facts:reported.map(r=>({ref:`node:${r.id}`,version:Number(r.content_version),claim:'reported_negative',scope_verified:false})),
      reported_total:Number(reported[0]?.total??0),has_more:Number(reported[0]?.total??0)>reported.length},
    reads:readWindow.reads,read_total:readWindow.total,incomplete_total:readWindow.incomplete,reads_truncated:readWindow.total>readWindow.reads.length,meaning:'fully_delivered 仅表示该版本字段/关系页已全部由工具返回，不表示结论正确、整节点或整图已读。历史负面报告没有可核验测试范围，不能自动排除未测方向。'
  };
}
export type PlannerGrounding=Awaited<ReturnType<typeof plannerGrounding>>;
/** Prompt-only projection. Exact hashes/intervals remain, but the coordinate
 * already repeated by each read row is represented once, not twice. The full
 * checked receipt is still stored in the native session and durable index. */
export function plannerGroundingContext(value:PlannerGrounding){
  return {...value,reads:value.reads.map(({coordinate,...read})=>coordinate?
    {...read,offset_unit:coordinate.unit,format:coordinate.format}:read)};
}
export interface PlannerReceipt {
  version:1;delivery_id:string;raw_ref?:string;raw_message_hash?:string;summary:string;grounding:PlannerGrounding;
  planning_title?:string|null;submitted_intent_ids:number[];goals:Array<{id:number;state:string}>;
  submitted_intent_total?:number;submitted_intents_truncated?:boolean;dispatch_read?:{ref:string;view:'output'};
  goals_total?:number;goals_truncated?:boolean;unresolved_dispatch_total?:number;unresolved_dispatch_refs?:string[];
}
export async function plannerReceipt(ctx:ToolRunContext,entries:readonly SessionEntry[],deliveryID:string,status:string):Promise<PlannerReceipt>{
  const grounding=await plannerGrounding(ctx,entries);
  const durable=ctx.role==='planner'?await ctx.plannerState?.():undefined;
  const indexed=durable?await readPlannerDispatchPage(ctx.db,durable,deliveryID,{leafID:ctx.plannerLeaf?.()}):undefined;
  const begin=entries.findIndex(e=>e.type==='custom'&&e.customType==='planner_delivery'&&(e.data as {id:string}).id===deliveryID);
  const next=entries.findIndex((e,i)=>i>begin&&e.type==='custom'&&e.customType==='planner_delivery');
  const delivered=begin<0?[]:entries.slice(begin,next<0?undefined:next);
  const ids=new Set<number>();
  for(const e of indexed?[]:delivered)if(e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='add_intent'&&!e.message.isError){
    try{const result=JSON.parse(e.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));
      for(const item of result.intents??[])if(item.created===true&&Number.isSafeInteger(item.intent_id)&&item.intent_id>0)ids.add(item.intent_id);
    }catch{/* An ambiguous result never becomes a successful host dispatch receipt. */}
  }
  const intents=indexed?.ids??(ids.size?(await ctx.db.query("SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND id=ANY($2::bigint[]) ORDER BY id",[ctx.expID,[...ids]])).rows.map(n=>Number(n.id)):[]);
  const submittedTotal=indexed?.total??intents.length;
  const goalRows=(await ctx.db.query("SELECT id,state,count(*) OVER() total FROM exploration_nodes WHERE exploration_id=$1 AND kind='goal' ORDER BY id LIMIT 100",[ctx.expID])).rows;
  const goals=goalRows.map(n=>({id:Number(n.id),state:String(n.state)})),goalsTotal=Number(goalRows[0]?.total??0);
  const raw=delivered.findLast(e=>e.type==='message'&&e.message.role==='assistant');
  const partial=grounding.reads.filter(r=>!r.fully_delivered);
  const rawRef=indexed?indexed.raw_ref:raw?`session:${raw.id}`:undefined;
  const text=[`本轮规划${status==='completed'?'正常结束':status==='budget'?'因现有预算结束':'已停止'}；宿主确认提交意图 ${submittedTotal} 条${intents.length?`（${intents.map(id=>'#'+id).join('、')}）`:''}。${indexed?.has_more?'这里只列出前 100 条；通过交付记录的 output 视图分页读取全部派单。':''}`,
    indexed?.unresolved_total?`另有 ${indexed.unresolved_total} 条历史工具返回尚无法核对；不将其算作成功或零派单，可按引用复核：${indexed.unresolved_refs.join('、')}。`:'',
    `目标当前记录：${goals.map(g=>`#${g.id} ${g.state}`).join('、')||'无'}。${goalsTotal>goals.length?`共 ${goalsTotal} 条，此处为前 ${goals.length} 条；其余通过 context_search(types=["goal"]) 分页读取。`:''}`,
    '方向核验：未测方向保持未知。历史负面报告的测试范围未由宿主核验，本轮未将它们自动认定为方向已否定；覆盖率、未测资产数和 Worker 完成都不能代替方向验证。',
    grounding.incomplete_total?`原文读取：${grounding.incomplete_total} 个字段/页仍未完整返回；不能认定全文已读。\n${partial.slice(0,8).map(r=>`${r.ref} ${r.field||r.view}：已返回 ${r.delivered.map(x=>`[${x[0]},${x[1]})`).join('、')||'无'} / ${r.total_chars} 字符；未读 ${r.missing.map(x=>`[${x[0]},${x[1]})`).join('、')}`).join('\n')}`:
      `原文读取：${grounding.read_total} 个字段/页有可核验的返回记录；不据此声称历史全文或整图已读。`,
    `模型原始总结保留${rawRef?`于 ${rawRef}`:''}，供追溯；此回执只确认宿主记录，不为模型自由文本作语义背书。`].filter(Boolean).join('\n');
  return {version:1,delivery_id:deliveryID,raw_ref:rawRef,raw_message_hash:indexed?indexed.raw_message_hash:raw?.type==='message'?hash(raw.message):undefined,
    planning_title:indexed?indexed.planning_title:raw?.type==='message'&&raw.message.role==='assistant'?plannerTitle(raw.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')):null,
    summary:text,grounding,submitted_intent_ids:intents,submitted_intent_total:submittedTotal,submitted_intents_truncated:indexed?.has_more??false,
    ...(indexed?{dispatch_read:{ref:indexed.delivery_ref,view:'output'},unresolved_dispatch_total:indexed.unresolved_total,unresolved_dispatch_refs:indexed.unresolved_refs}:{}),goals,goals_total:goalsTotal,goals_truncated:goalsTotal>goals.length};
}
/** Project checked host receipts for subsequent requests. Never rewrite the JSONL.
 * Tool calls/results remain paired and untouched; originals stay recallable. */
const receiptIndexes=new WeakMap<object,SessionIndex<Map<string|undefined,PlannerReceipt>>>();
export function projectPlannerReceipts<T extends {role:string}>(messages:T[],entries:readonly SessionEntry[],owner?:object):T[]{
  let index=owner?receiptIndexes.get(owner):undefined;
  if(!index){index=new SessionIndex(()=>new Map<string|undefined,PlannerReceipt>(),(checked,e)=>{
    if(e.type==='custom'&&e.customType==='planner_grounded_result'){const r=e.data as PlannerReceipt;checked.set(r.raw_message_hash,r);}
  });if(owner)receiptIndexes.set(owner,index);}
  const checked=index.update(entries);
  return messages.map(m=>{
    const r=m.role==='assistant'?checked.get(hash(m)):undefined;
    if(!r)return m;
    // A completed tool round still needs all its original toolCall blocks.
    const content=(m as T&{content?:Array<{type:string}>}).content;
    if(content?.some(b=>b.type==='toolCall'))return m;
    return {...m,content:[{type:'text',text:r.summary}]};
  });
}
