import {createHash} from 'node:crypto';
import {unicodeLength,unicodeSlice} from '../unicode.js';
import type {ToolRunContext} from './context.js';
import {plannerHistoryEntry,isRecallEcho,historyMatch,plannerTextCacheable} from '../agent/planner-history-entry.js';
export {plannerHistoryEntry} from '../agent/planner-history-entry.js';
import {boundedContextPage,CONTEXT_PAGE_BYTES} from './context-pages.js';
import {assertToolBinding} from '../agent/tool-registry.js';
import {getIndexedPlannerEntry,readIndexedPlannerContent,searchIndexedPlannerHistory,type PlannerHistoryHit} from '../db/planner-history.js';
import {readPlannerDispatchPage} from '../db/planner-receipts.js';
export const PLANNER_HISTORY_ROLES=['assistant','user','toolResult','compaction','host_delivery','host_snapshot'] as const;

async function ownSession(c:ToolRunContext){
  if(c.role!=='planner'||!c.plannerSession)throw new Error('历史规划会话仅限当前 Planner 读取');
  const task=await c.db.tasks().getTask(c.taskID);
  if(!task||task.exploration_id!==c.expID)throw new Error('Planner 会话任务不存在或归属已变化');
  if(c.plannerSession.index&&(c.plannerSession.index.taskID!==c.taskID||c.plannerSession.index.expID!==c.expID))throw new Error('Planner 历史会话归属不匹配');
  await c.hooks.assertOwnership?.(c.db);
  return c.plannerSession;
}
export async function searchPlannerHistory(c:ToolRunContext,args:{q?:string;limit?:number;cursor?:string;task_id?:number;types?:string[];state?:string;asset_id?:number;intent_id?:number;roles?:string[];include_content?:boolean}){
  const session=await ownSession(c);
  if(args.task_id!==undefined&&args.task_id!==c.taskID)throw new Error('不能跨任务检索 Planner 会话');
  if(args.types||args.state||args.asset_id||args.intent_id)throw new Error('历史会话按 q 检索；图节点筛选请使用 source=graph');
  const q=args.q?.trim()??'',limit=Math.max(1,Math.min(50,args.limit??10));
  if(args.roles!==undefined&&(!Array.isArray(args.roles)||!args.roles.length||args.roles.some(role=>!PLANNER_HISTORY_ROLES.includes(role as typeof PLANNER_HISTORY_ROLES[number]))))throw new Error('无效历史角色筛选');
  const roles=args.roles?[...new Set(args.roles)].sort():undefined;
  if(args.include_content!==undefined&&typeof args.include_content!=='boolean')throw new Error('include_content 必须为布尔值');
  if(args.include_content)await assertToolBinding(c.db,c.role,'context_get');
  if(Array.from(q).length>200)throw new Error('q 最多 200 字符');
  // Unfiltered signatures remain byte-identical for existing snapshot cursors.
  const signature=createHash('sha256').update(JSON.stringify([session.identity(),q,limit,...(roles?[roles]:[]),...(args.include_content?[{include_content:true}]:[])])).digest('hex');
  const entries=session.entries?.()??[];let upper=session.index?.count??entries.length,before=upper;
  if(args.cursor){
    try{
      const p=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));
      if(p.signature!==signature||p.generation!==undefined&&p.generation!==session.index?.generation||!Number.isSafeInteger(p.before)||!Number.isSafeInteger(p.upper)||p.before<0||p.before>p.upper||p.upper>upper)throw new Error();
      upper=p.upper;before=p.before;
    }catch{throw new Error('历史会话游标无效或不属于当前查询');}
  }
  const found:PlannerHistoryHit[]=session.index?await searchIndexedPlannerHistory(c.db,session.index,q,before,limit+1,roles):[];
  for(let i=session.index?-1:before-1;i>=0;i--){
    if(isRecallEcho(entries[i]!))continue;
    const entry=plannerHistoryEntry(entries[i]!);
    if(!entry?.content||roles&&!roles.includes(entry.role))continue;
    const offset=historyMatch(entries[i]!,entry.content,q);
    if(offset<0)continue;
    found.push({index:i,...entry,summary:unicodeSlice(entry.content,Math.max(0,offset-60),offset+240),match_offset:offset,total_chars:unicodeLength(entry.content)});
    if(found.length>limit)break;
  }
  const page=boundedContextPage(found.slice(0,limit).map(({content,...item})=>{
    // A short original fits the existing per-item output ceiling. For long
    // entries point at the match, without claiming the rest has been read.
    const offset=item.total_chars<=3000?0:Math.max(0,Number(item.match_offset)-60);
    return {...item,read:{ref:item.ref,field:'/content',offset,max_chars:Math.min(3000,item.total_chars-offset)}};
  }));
  const more=found.length>page.length;
  const items=page.map(({index,...item})=>item);
  if(args.include_content){
    // At most three bounded content reads; no whole native-entry parse for
    // indexed sources. Long/unsupported originals retain their read reference.
    let attempted=0,bytes=Buffer.byteLength(JSON.stringify(items));
    for(let i=0;i<items.length;i++){
      const item=items[i]!;if(item.total_chars>3000||attempted>=3)continue;attempted++;
      const source=session.index?await readIndexedPlannerContent(c.db,session.index,item.ref.slice(8),0,3000):undefined;
      const memory=session.index?undefined:found.find(hit=>hit.ref===item.ref)?.content;
      const content=source?.content??memory;if(content===undefined||!plannerTextCacheable(content))continue;
      if(Array.from(content).length!==item.total_chars)throw new Error('历史原文长度与索引不一致，请重新检索');
      const original={...item,view:'detail',field:'/content',content,original:true,offset_unit:'unicode_codepoints',next_offset:null,
        read_receipt:{version:1,coordinate:{ref:item.ref,view:'detail',field:'/content',unit:'unicode_codepoints',format:'text'},
          source_hash:source?.source_hash??createHash('sha256').update(content).digest('hex'),start:0,end:item.total_chars,total:item.total_chars}};
      const added=Buffer.byteLength(JSON.stringify(original))-Buffer.byteLength(JSON.stringify(item));
      if(bytes+added>CONTEXT_PAGE_BYTES)continue;
      items[i]=original;bytes+=added;
    }
  }
  return {source:'planner_session',source_task_id:c.taskID,historical:true,note:'检索原始规划记录，排除纯历史查询及其回显；这些记录仍可按已有引用读取。历史原文不是当前图状态；使用资产与探索工具核实最新记录',
    items,
    has_more:more,next_cursor:more?Buffer.from(JSON.stringify({signature,upper,before:page.at(-1)!.index,...(session.index?{generation:session.index.generation}:{})})).toString('base64url'):null};
}
export async function getPlannerHistory(c:ToolRunContext,ref:string){
  const session=await ownSession(c);
  if(!/^session:[a-zA-Z0-9_-]+$/.test(ref))throw new Error('无效历史会话引用');
  const id=ref.slice('session:'.length),entry=session.index?await getIndexedPlannerEntry(c.db,session.index,id):session.entries?.().find(e=>e.id===id);
  const value=entry&&plannerHistoryEntry(entry);
  if(!value)throw new Error('当前 Planner 会话中不存在该条目');
  return {...value,source:'planner_session',historical:true,...(value.role==='assistant'||value.role==='compaction'?{claim_status:'unverified_model_text',note:'模型历史原文；不属于宿主核验的方向排除或完整读取证明。'}:{})};
}

/** The common /content continuation path does not materialize the whole record. */
export async function getPlannerHistoryContent(c:ToolRunContext,ref:string,offset:number,limit:number){
  const session=await ownSession(c);if(!session.index)return undefined;
  if(!/^session:[a-zA-Z0-9_-]+$/.test(ref))throw new Error('无效历史会话引用');
  return readIndexedPlannerContent(c.db,session.index,ref.slice(8),offset,limit);
}

/** A delivery's output is a host receipt, not rewritten historical model text.
 * detail and /content continue to expose the unchanged original snapshot. */
export async function getPlannerDispatchOutput(c:ToolRunContext,ref:string,cursor?:string){
 const session=await ownSession(c),s=await c.plannerState?.()??session.index;
 if(!s)return undefined;
 if(!/^session:[a-zA-Z0-9_-]+$/.test(ref))throw new Error('无效历史会话引用');
 const entry=await getIndexedPlannerEntry(c.db,s,ref.slice(8));
 if(entry.type!=='custom'||entry.customType!=='planner_delivery')return undefined;
 const delivery=entry.data as {id:string};let after=0,leaf=c.plannerLeaf?.()??null,expected:string|undefined;
 const identity=JSON.stringify([c.taskID,c.expID,s.sessionID,s.generation,ref]);
 if(cursor){try{
  const p=JSON.parse(Buffer.from(cursor,'base64url').toString());
  if(p.identity!==identity||!Number.isSafeInteger(p.after)||p.after<0||p.leaf!==null&&typeof p.leaf!=='string'||typeof p.fingerprint!=='string')throw new Error();
  after=p.after;leaf=p.leaf;expected=p.fingerprint;
 }catch{throw new Error('派单回执游标无效或不属于当前会话');}}
 // Freeze the native branch. Further recall tool messages are not new work.
 if(leaf===null){const row=(await c.db.query('SELECT entry_id FROM planner_history_entries WHERE exploration_id=$1 AND ordinal=$2-1',[s.expID,s.count])).rows[0];leaf=row?String(row.entry_id):null;}
 const page=await readPlannerDispatchPage(c.db,s,delivery.id,{after,leafID:leaf,limit:20});
 const fingerprint=createHash('sha256').update(JSON.stringify([page.membership_hash,page.unresolved_total])).digest('hex');
 if(expected&&expected!==fingerprint)throw new Error('派单记录或节点归属已变化，请重新读取');
 const makeCursor=(at:number)=>Buffer.from(JSON.stringify({identity,after:at,leaf,fingerprint})).toString('base64url');
 return {data:{source:'planner_dispatch_receipt',delivery_ref:ref,total:page.total,items:page.ids.map(id=>({ref:`node:${id}`})),
  unresolved_total:page.unresolved_total,unresolved_refs:page.unresolved_refs,note:'宿主提交记录；意图当前状态及证据需通过图谱实时读取。'},
  page_cursor:makeCursor(after),next_cursor:page.has_more?makeCursor(page.ids.at(-1)!):null};
}
