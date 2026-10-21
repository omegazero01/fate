import {createHash} from 'node:crypto';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import type {ToolRunContext} from '../tools/context.js';
import {TASK_GRAPH_CTE} from '../db/graph_view.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type Interval=[number,number];
export interface ReadCoverage {
  ref:string;view:string;field:string;version?:number;source_hash:string;page_cursor?:string;
  total_chars:number;delivered:Interval[];missing:Interval[];fully_delivered:boolean;
  // Completing one field/page never establishes completeness of its containing node/query.
  scope:'field_or_page';
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
export function plannerReadCoverage(entries:readonly SessionEntry[]):ReadCoverage[]{
  const reads=new Map<string,ReadCoverage>();
  for(const entry of entries){
    if(entry.type!=='message'||entry.message.role!=='toolResult'||entry.message.toolName!=='context_get'||entry.message.isError)continue;
    try{
      const result=JSON.parse(entry.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));
      for(const item of result.items??[]){
        const r=item.read_receipt;
        if(item.error||!r||r.version!==1||typeof item.ref!=='string'||!(/^(node:[1-9][0-9]*|session:[a-zA-Z0-9_-]+)$/.test(item.ref))||typeof item.view!=='string'||item.field!==undefined&&typeof item.field!=='string'||!(/^([a-f0-9]{64})$/.test(r.source_hash))||typeof item.content!=='string')continue;
        const {start,end,total}=r;
        if(![start,end,total].every(Number.isSafeInteger)||start<0||end<start||end>total||end-start!==Array.from(item.content).length)continue;
        const key=JSON.stringify([item.ref,item.view,item.field??'',item.page_cursor??'']);
        let row=reads.get(key);
        if(!row||row.source_hash!==r.source_hash||row.version!==item.version||row.total_chars!==total){
          row={ref:item.ref,view:item.view,field:item.field??'',version:item.version,source_hash:r.source_hash,page_cursor:item.page_cursor,total_chars:total,delivered:[],missing:[],fully_delivered:false,scope:'field_or_page'};
          reads.set(key,row);
        }
        if(end>start)row.delivered.push([start,end]);
        row.delivered=merge(row.delivered);row.missing=[];let cursor=0;
        for(const range of row.delivered){if(range[0]>cursor)row.missing.push([cursor,range[0]]);cursor=range[1];}
        if(cursor<total)row.missing.push([cursor,total]);row.fully_delivered=row.missing.length===0;
        reads.delete(key);reads.set(key,row); // Keep bounded projections ordered by the latest delivery.
      }
    }catch{/* Malformed, spilled or legacy responses are not delivery receipts. */}
  }
  return [...reads.values()];
}
export async function plannerGrounding(ctx:ToolRunContext,entries:readonly SessionEntry[]){
  await ctx.hooks.assertOwnership?.(ctx.db);
  const task=await ctx.db.tasks().getTask(ctx.taskID);
  if(!task||task.exploration_id!==ctx.expID)throw new Error('Planner 证据归属已变化');
  const reported=(await ctx.db.query(`WITH ${TASK_GRAPH_CTE}
    SELECT id,content_version,payload->>'observation_type' observation_type,count(*) OVER() total
    FROM visible WHERE kind='fact' AND payload->>'observation_type'='negative' ORDER BY id DESC LIMIT 100`,[ctx.taskID])).rows;
  const candidates=plannerReadCoverage(entries),entryIDs=new Set(entries.map(e=>e.id));
  const nodeIDs=[...new Set(candidates.filter(r=>/^node:[1-9][0-9]*$/.test(r.ref)).map(r=>Number(r.ref.slice(5))))];
  const current=nodeIDs.length?(await ctx.db.query(`WITH ${TASK_GRAPH_CTE}
    SELECT id,content_version FROM visible WHERE id=ANY($2::bigint[])`,[ctx.taskID,nodeIDs])).rows:[];
  const versions=new Map(current.map(r=>[Number(r.id),Number(r.content_version)]));
  const reads=candidates.filter(read=>read.ref.startsWith('session:')?entryIDs.has(read.ref.slice(8)):
    read.ref.startsWith('node:')&&versions.get(Number(read.ref.slice(5)))===read.version&&versions.has(Number(read.ref.slice(5))));
  return {
    version:1,negative_scope:{status:'not_verified' as const,
      // No existing model-authored field constitutes a host-verified test matrix.
      // In particular anchors, confidence, confirmed and tested coverage do not.
      direction_exclusions:[] as never[],outside_reported_observations:'unknown' as const,
      reported_facts:reported.map(r=>({ref:`node:${r.id}`,version:Number(r.content_version),claim:'reported_negative',scope_verified:false})),
      reported_total:Number(reported[0]?.total??0),has_more:Number(reported[0]?.total??0)>reported.length},
    reads:reads.slice(-20),read_total:reads.length,incomplete_total:reads.filter(r=>!r.fully_delivered).length,reads_truncated:reads.length>20,meaning:'fully_delivered 仅表示该版本字段/关系页已全部由工具返回，不表示结论正确、整节点或整图已读。历史负面报告没有可核验测试范围，不能自动排除未测方向。'
  };
}
export type PlannerGrounding=Awaited<ReturnType<typeof plannerGrounding>>;
export interface PlannerReceipt {
  version:1;delivery_id:string;raw_ref?:string;raw_message_hash?:string;summary:string;grounding:PlannerGrounding;
  submitted_intent_ids:number[];goals:Array<{id:number;state:string}>;
}
export async function plannerReceipt(ctx:ToolRunContext,entries:readonly SessionEntry[],deliveryID:string,status:string):Promise<PlannerReceipt>{
  const grounding=await plannerGrounding(ctx,entries);
  const s=ctx.db.exploration(ctx.expID);
  const begin=entries.findIndex(e=>e.type==='custom'&&e.customType==='planner_delivery'&&(e.data as {id:string}).id===deliveryID);
  const next=entries.findIndex((e,i)=>i>begin&&e.type==='custom'&&e.customType==='planner_delivery');
  const delivered=begin<0?[]:entries.slice(begin,next<0?undefined:next);
  const ids=new Set<number>();
  for(const e of delivered)if(e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='add_intent'&&!e.message.isError){
    try{const result=JSON.parse(e.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));
      for(const item of result.intents??[])if(item.created&&Number.isSafeInteger(item.intent_id))ids.add(item.intent_id);
    }catch{/* An ambiguous result never becomes a successful host dispatch receipt. */}
  }
  const intents=(await s.nodesByIDs([...ids])).filter(n=>n.kind==='intent');
  const goals=(await s.listByKind('goal',10000)).map(n=>({id:n.id,state:n.state}));
  const raw=delivered.findLast(e=>e.type==='message'&&e.message.role==='assistant');
  const partial=grounding.reads.filter(r=>!r.fully_delivered);
  const text=[`本轮规划${status==='completed'?'正常结束':status==='budget'?'因现有预算结束':'已停止'}；宿主确认提交意图 ${intents.length} 条${intents.length?`（${intents.map(n=>'#'+n.id).join('、')}）`:''}。`,
    `目标当前记录：${goals.map(g=>`#${g.id} ${g.state}`).join('、')||'无'}。`,
    '方向核验：未测方向保持未知。历史负面报告的测试范围未由宿主核验，本轮未将它们自动认定为方向已否定；覆盖率、未测资产数和 Worker 完成都不能代替方向验证。',
    grounding.incomplete_total?`原文读取：${grounding.incomplete_total} 个字段/页仍未完整返回；不能认定全文已读。\n${partial.slice(0,8).map(r=>`${r.ref} ${r.field||r.view}：已返回 ${r.delivered.map(x=>`[${x[0]},${x[1]})`).join('、')||'无'} / ${r.total_chars} 字符；未读 ${r.missing.map(x=>`[${x[0]},${x[1]})`).join('、')}`).join('\n')}`:
      `原文读取：${grounding.read_total} 个字段/页有可核验的返回记录；不据此声称历史全文或整图已读。`,
    `模型原始总结保留${raw?`于 session:${raw.id}`:''}，供追溯；此回执只确认宿主记录，不为模型自由文本作语义背书。`].join('\n');
  return {version:1,delivery_id:deliveryID,raw_ref:raw?`session:${raw.id}`:undefined,raw_message_hash:raw?.type==='message'?hash(raw.message):undefined,
    summary:text,grounding,submitted_intent_ids:intents.map(n=>n.id),goals};
}
/** Project checked host receipts for subsequent requests. Never rewrite the JSONL.
 * Tool calls/results remain paired and untouched; originals stay recallable. */
export function projectPlannerReceipts<T extends {role:string}>(messages:T[],entries:readonly SessionEntry[]):T[]{
  const checked=new Map(entries.filter(e=>e.type==='custom'&&e.customType==='planner_grounded_result').map(e=>{
    const r=(e as SessionEntry&{data:PlannerReceipt}).data;return [r.raw_message_hash,r] as const;
  }));
  return messages.map(m=>{
    const r=m.role==='assistant'?checked.get(hash(m)):undefined;
    if(!r)return m;
    // A completed tool round still needs all its original toolCall blocks.
    const content=(m as T&{content?:Array<{type:string}>}).content;
    if(content?.some(b=>b.type==='toolCall'))return m;
    return {...m,content:[{type:'text',text:r.summary}]};
  });
}
