import {createHash} from 'node:crypto';
import type {ToolRunContext} from './context.js';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import {boundedContextPage} from './context-pages.js';

function isHistoryCall(b:{type:string;name?:string;arguments?:Record<string,unknown>}){
  if(b.type!=='toolCall')return false;
  if(b.name==='context_search')return b.arguments?.source==='planner_session';
  const items=b.arguments?.items;
  return b.name==='context_get'&&Array.isArray(items)&&items.length>0&&
    items.every((item:unknown)=>!!item&&typeof item==='object'&&String((item as {ref?:unknown}).ref).startsWith('session:'));
}

function textContent(content:unknown):string{
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  return content.flatMap(block=>{
    if(block.type==='text')return [String(block.text??'')];
    if(block.type==='toolCall')return [JSON.stringify({tool:block.name,arguments:block.arguments})];
    // Match existing activity recall: hidden thinking and image data are not expanded.
    if(block.type==='image')return ['[image retained in original session]'];
    return [];
  }).join('\n');
}
export function plannerHistoryEntry(entry:SessionEntry){
  if(entry.type==='message'){
    const message=entry.message;
    const extra=message.role==='toolResult'?{tool:message.toolName,tool_call_id:message.toolCallId,is_error:message.isError}:{};
    return {ref:`session:${entry.id}`,timestamp:entry.timestamp,role:message.role,...extra,content:'content' in message?textContent(message.content):JSON.stringify(message)};
  }
  if(entry.type==='compaction')return {ref:`session:${entry.id}`,timestamp:entry.timestamp,role:'compaction',content:entry.summary};
  if(entry.type==='custom_message'&&entry.customType==='fate_context')return {ref:`session:${entry.id}`,timestamp:entry.timestamp,role:'host_delivery',content:textContent(entry.content)};
  if(entry.type==='custom'&&entry.customType==='planner_delivery'){
    const data=entry.data as {currentState?:unknown};
    return {ref:`session:${entry.id}`,timestamp:entry.timestamp,role:'host_snapshot',content:JSON.stringify(data.currentState??{})};
  }
  return undefined;
}

/** Retrieval is an index into originals, not a new independent observation.
 * Keep every entry directly readable, but do not let a query match itself or
 * let successive recalled copies displace the original planning evidence. */
function isRecallEcho(entry:SessionEntry){
  if(entry.type!=='message')return false;
  const m=entry.message;
  if(m.role==='assistant'){
    const visible=m.content.filter(b=>b.type!=='thinking'&&(b.type!=='text'||b.text.trim()));
    return visible.length>0&&visible.every(isHistoryCall);
  }
  if(m.role==='toolResult'&&['context_search','context_get'].includes(m.toolName)){
    try{
      const data=JSON.parse(textContent(m.content));
      if(m.toolName==='context_search')return data.source==='planner_session';
      return Array.isArray(data.items)&&data.items.length>0&&data.items.every((item:{ref?:string})=>item.ref?.startsWith('session:'));
    }catch{/* A non-JSON or mixed result remains searchable. */}
  }
  return false;
}

/** Skip only the retrieval call in mixed assistant messages; retain real text
 * and other tool calls, with offsets into the unchanged original content. */
function historyMatch(entry:SessionEntry,content:string,q:string){
  const parts=entry.type==='message'&&entry.message.role==='assistant'
    ?entry.message.content.filter(b=>b.type==='text'||b.type==='toolCall').map(b=>({text:textContent([b]),skip:isHistoryCall(b)}))
    :[{text:content,skip:false}];
  let offset=0;
  for(const part of parts){
    if(!part.skip){
      const match=part.text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
      if(match>=0){
        // Case folding can expand characters (e.g. İ); offsets remain Unicode characters of the original.
        let folded=0,characters=0;
        for(const char of part.text){if(folded>=match)break;folded+=char.toLocaleLowerCase().length;characters++;}
        return offset+characters;
      }
    }
    offset+=Array.from(part.text).length+1;
  }
  return -1;
}
async function ownSession(c:ToolRunContext){
  if(c.role!=='planner'||!c.plannerSession)throw new Error('历史规划会话仅限当前 Planner 读取');
  const task=await c.db.tasks().getTask(c.taskID);
  if(!task||task.exploration_id!==c.expID)throw new Error('Planner 会话任务不存在或归属已变化');
  await c.hooks.assertOwnership?.(c.db);
  return c.plannerSession;
}
export async function searchPlannerHistory(c:ToolRunContext,args:{q?:string;limit?:number;cursor?:string;task_id?:number;types?:string[];state?:string;asset_id?:number;intent_id?:number}){
  const session=await ownSession(c);
  if(args.task_id!==undefined&&args.task_id!==c.taskID)throw new Error('不能跨任务检索 Planner 会话');
  if(args.types||args.state||args.asset_id||args.intent_id)throw new Error('历史会话按 q 检索；图节点筛选请使用 source=graph');
  const q=args.q?.trim()??'',limit=Math.max(1,Math.min(50,args.limit??10));
  if(Array.from(q).length>200)throw new Error('q 最多 200 字符');
  const signature=createHash('sha256').update(JSON.stringify([session.identity(),q,limit])).digest('hex');
  const entries=session.entries();let upper=entries.length,before=upper;
  if(args.cursor){
    try{
      const p=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));
      if(p.signature!==signature||!Number.isSafeInteger(p.before)||!Number.isSafeInteger(p.upper)||p.before<0||p.before>p.upper||p.upper>upper)throw new Error();
      upper=p.upper;before=p.before;
    }catch{throw new Error('历史会话游标无效或不属于当前查询');}
  }
  const found=[];
  for(let i=before-1;i>=0;i--){
    if(isRecallEcho(entries[i]!))continue;
    const entry=plannerHistoryEntry(entries[i]!);
    if(!entry?.content)continue;
    const offset=historyMatch(entries[i]!,entry.content,q);
    if(offset<0)continue;
    found.push({index:i,...entry,summary:Array.from(entry.content).slice(Math.max(0,offset-60),offset+240).join(''),match_offset:offset});
    if(found.length>limit)break;
  }
  const page=boundedContextPage(found.slice(0,limit).map(({content,...item})=>({...item,
    read:{ref:item.ref,field:'/content',offset:Math.max(0,item.match_offset-60)}})));
  const more=found.length>page.length;
  return {source:'planner_session',source_task_id:c.taskID,historical:true,note:'检索原始规划记录，排除纯历史查询及其回显；这些记录仍可按已有引用读取。历史原文不是当前图状态；使用资产与探索工具核实最新记录',
    items:page.map(({index,...item})=>item),
    has_more:more,next_cursor:more?Buffer.from(JSON.stringify({signature,upper,before:page.at(-1)!.index})).toString('base64url'):null};
}
export async function getPlannerHistory(c:ToolRunContext,ref:string){
  const session=await ownSession(c);
  if(!/^session:[a-zA-Z0-9_-]+$/.test(ref))throw new Error('无效历史会话引用');
  const id=ref.slice('session:'.length),entry=session.entries().find(e=>e.id===id);
  const value=entry&&plannerHistoryEntry(entry);
  if(!value)throw new Error('当前 Planner 会话中不存在该条目');
  return {...value,source:'planner_session',historical:true,...(value.role==='assistant'||value.role==='compaction'?{claim_status:'unverified_model_text',note:'模型历史原文；不属于宿主核验的方向排除或完整读取证明。'}:{})};
}
