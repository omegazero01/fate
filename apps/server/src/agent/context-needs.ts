import {createHash} from 'node:crypto';
import type {ToolRunContext} from '../tools/context.js';
import {TASK_GRAPH_CTE} from '../db/graph_view.js';
import {plannerReadCoverage} from './planner-grounding.js';
import {boundedContextPage} from '../tools/context-pages.js';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';

export const CONTEXT_RETENTION_RULES = `宿主按当前意图、变化的事实依据、未确认操作、未读区间排序上下文。context_search(source="needs") 给出缺口及可直接使用的读取参数；清单是有界窗口，不是整图，也不要求每轮读完整图。只读取支撑当前决定的相关字段，保留未读范围。原始事实、证据和会话按引用读取，保留版本及续读位置，不因摘要省略而认定不存在。operation:* 仅为工具执行记录，不是已发布事实；uncertain 不得自动重放，写回已有观察并说明阻塞。`;
export interface ContextNeed {
  ref:string;priority:number;reason:string;version?:number;expected_version?:number;intent_id?:number;
  summary?:string;read:{tool:string;args:Record<string,unknown>};
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const nodeRead=(id:number,version?:number,field?:string,offset=0)=>({tool:'context_get',args:{items:[{ref:`node:${id}`,view:'detail',...(version!==undefined?{version}:{}),...(field?{field}:{}),offset}]}});

/** Keep outstanding query/relation cursors across compaction; failed reads do not consume them. */
export function contextContinuations(entries:readonly SessionEntry[]):ContextNeed[]{
  const calls=new Map<string,Record<string,unknown>>(),pending=new Map<string,ContextNeed>();
  for(const entry of entries){
    if(entry.type!=='message')continue;const m=entry.message;
    if(m.role==='assistant')for(const b of m.content)if(b.type==='toolCall')calls.set(b.id,b.arguments as Record<string,unknown>);
    if(m.role!=='toolResult'||m.isError||!['context_search','context_get'].includes(m.toolName))continue;
    const args=calls.get(m.toolCallId);if(!args)continue;
    try{
      const out=JSON.parse(m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));
      if(m.toolName==='context_search'){
        if(args.source==='needs'||!Array.isArray(out.items)||out.has_more===undefined)continue;
        const {cursor,...query}=args,key='query:'+hash(query);
        if(out.has_more&&typeof out.next_cursor==='string')pending.set(key,{ref:key,priority:75,reason:'query_has_more',
          read:{tool:'context_search',args:{...query,cursor:out.next_cursor}}});
        else if(out.has_more===false)pending.delete(key);
      }else for(const item of out.items??[]){
        if(item.error||typeof item.ref!=='string')continue;
        const key=JSON.stringify([item.ref,item.view,item.field??'']);
        // Intra-field gaps are handled by interval receipts. This preserves the next relation page.
        if(item.next_item&&/^(output|attachment|traffic):/.test(item.ref)){pending.set(key,{ref:item.ref,priority:70,reason:'evidence_has_more',read:{tool:'context_get',args:{items:[item.next_item]}}});continue;}
        if(!item.next_item&&/^(output|attachment|traffic):/.test(item.ref)){pending.delete(key);continue;}
        if(item.next_offset===null&&item.next_cursor&&item.next_item)pending.set(key,{ref:item.ref,version:item.version,priority:70,
          reason:'relation_has_more',read:{tool:'context_get',args:{items:[item.next_item]}}});
        else if(item.next_offset===null&&item.next_cursor===null)pending.delete(key);
      }
    }catch{/* Missing/legacy receipts never prove that a cursor was consumed. */}
  }
  return [...pending.values()];
}

/** A bounded dependency/read manifest. Never materializes evidence bodies or rewrites history. */
export async function contextNeeds(ctx:ToolRunContext,args:{intent_id?:number;limit?:number;cursor?:string}={}){
  if(!['planner','worker','mainagent'].includes(ctx.role))throw new Error('当前角色没有探索上下文清单');
  const task=await ctx.db.tasks().getTask(ctx.taskID);
  if(!task||task.exploration_id!==ctx.expID)throw new Error('当前任务不存在');
  const intentID=ctx.role==='worker'?ctx.intentID:args.intent_id;
  if(ctx.role==='worker'&&(!intentID||args.intent_id!==undefined&&args.intent_id!==intentID))throw new Error('Worker 清单仅限当前意图');
  const limit=Math.min(20,Math.max(1,args.limit??8));
  if(!Number.isSafeInteger(limit)||intentID!==undefined&&(!Number.isSafeInteger(intentID)||intentID<=0))throw new Error('无效清单参数');
  const intents=(await ctx.db.query(`SELECT id,content_version,payload->'contract'->'basis' basis,count(*) OVER() total
    FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND
      (($2::bigint IS NOT NULL AND id=$2) OR ($2::bigint IS NULL AND state IN ('running','open','paused')))
      AND exploration_node_readable($1,id) ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,id DESC LIMIT 16`,
    [ctx.expID,intentID??null])).rows;
  if(intentID&&!intents.length)throw new Error('意图不存在或不属于当前任务');
  const entries=ctx.sessionEntries?.()??[];
  const coverage=plannerReadCoverage(entries);
  const continuations=contextContinuations(entries);
  const basis=intents.flatMap(n=>(Array.isArray(n.basis)?n.basis as {node_id:number;version:number}[]:[]).map(r=>({...r,intent_id:Number(n.id)})));
  const requestedIDs=[...new Set([...basis.map(b=>b.node_id),...[...coverage,...continuations].filter(c=>c.ref.startsWith('node:')).map(c=>Number(c.ref.slice(5)))])];
  const visible=requestedIDs.length?(await ctx.db.query(`WITH ${TASK_GRAPH_CTE}
    SELECT id,kind,state,content_version,left(COALESCE(payload->>'summary',payload->>'text',''),160) summary
    FROM visible WHERE id=ANY($2::bigint[])`,[ctx.taskID,requestedIDs])).rows:[];
  const byID=new Map(visible.map(n=>[Number(n.id),n]));
  const needs:ContextNeed[]=[];
  for(const c of continuations){
    if(c.ref.startsWith('node:')&&Number(byID.get(Number(c.ref.slice(5)))?.content_version)!==c.version)continue;
    needs.push(c);
  }
  for(const b of basis){
    const n=byID.get(b.node_id),version=n?Number(n.content_version):undefined;
    const read=coverage.filter(r=>r.ref===`node:${b.node_id}`&&r.version===version);
    // A summary delivery never establishes that evidence was read.
    const delivered=read.some(r=>r.view==='detail'&&!r.field&&r.fully_delivered);
    if(!n||version!==b.version||!delivered)needs.push({
      ref:`node:${b.node_id}`,priority:!n?100:version!==b.version?95:80,
      reason:!n?'dependency_unavailable':version!==b.version?'dependency_changed':'dependency_detail_unread',
      version,expected_version:b.version,intent_id:b.intent_id,...(n?{summary:String(n.summary)}:{}),
      read:n?nodeRead(b.node_id,version):{tool:'context_search',args:{intent_id:b.intent_id,types:['fact','finding']}},
    });
  }
  const entryIDs=new Set(entries.map(e=>e.id));
  for(const r of coverage){
    const node=r.ref.startsWith('node:')?byID.get(Number(r.ref.slice(5))):undefined;
    const valid=r.ref.startsWith('session:')?entryIDs.has(r.ref.slice(8)):node&&Number(node.content_version)===r.version;
    if(!valid||r.fully_delivered)continue;
    needs.push({ref:r.ref,priority:70,reason:'unread_range',version:r.version,
      read:{tool:'context_get',args:{items:[{ref:r.ref,view:r.view,field:r.field||undefined,version:r.version,
        offset:r.missing[0]![0],...(r.page_cursor?{cursor:r.page_cursor}:{})}]}}});
  }
  const operations=(await ctx.db.query(`SELECT id,intent_id,tool_name,status,count(*) OVER() total FROM worker_operations
    WHERE task_id=$1 AND ($2::bigint IS NULL OR intent_id=$2) AND status='uncertain' ORDER BY id LIMIT 20`,[ctx.taskID,intentID??null])).rows;
  for(const o of operations)needs.push({ref:`operation:${o.id}`,priority:110,reason:'operation_uncertain',intent_id:Number(o.intent_id),
    summary:String(o.tool_name),read:{tool:'context_get',args:{items:[{ref:`operation:${o.id}`}]}}});
  const facts=(await ctx.db.query(`SELECT n.id,n.content_version,left(COALESCE(n.payload->>'summary',''),160) summary,n.payload->>'observation_type' observation_type,count(*) OVER() total
    FROM exploration_nodes n WHERE n.exploration_id=$1 AND n.kind IN ('fact','finding') AND n.state='confirmed'
      AND ($2::bigint IS NULL OR EXISTS(SELECT 1 FROM exploration_edges e WHERE e.src_id=$2 AND e.dst_id=n.id AND e.rel='yields'))
      AND exploration_node_readable($1,n.id) ORDER BY n.id DESC LIMIT 10`,[ctx.expID,intentID??null])).rows;
  for(const n of facts)if(!coverage.some(r=>r.ref===`node:${n.id}`&&r.version===Number(n.content_version)&&r.view==='detail'&&!r.field&&r.fully_delivered))
    needs.push({ref:`node:${n.id}`,priority:n.observation_type==='negative'?65:60,reason:'saved_result_reference',version:Number(n.content_version),
      summary:String(n.summary),read:nodeRead(Number(n.id),Number(n.content_version))});
  const unique=[...new Map(needs.sort((a,b)=>b.priority-a.priority||a.ref.localeCompare(b.ref)).map(n=>[JSON.stringify([n.ref,n.reason,n.intent_id,n.read]),n])).values()];
  const signature=hash([ctx.taskID,ctx.role,intentID,unique]);let after=0;
  if(args.cursor){
    let c:{signature:string;after:number};try{c=JSON.parse(Buffer.from(args.cursor,'base64url').toString());}catch{throw new Error('无效上下文清单游标');}
    if(c.signature!==signature||!Number.isSafeInteger(c.after)||c.after<0||c.after>unique.length)throw new Error('上下文状态已变化，请重新获取清单，不沿用旧版本续页');
    after=c.after;
  }
  const items=boundedContextPage(unique.slice(after,after+limit)),next=after+items.length;
  return {policy:'dependency-first-v1',items,total:unique.length,
    next_cursor:next<unique.length?Buffer.from(JSON.stringify({signature,after:next})).toString('base64url'):null,
    candidate_window:{intents_total:Number(intents[0]?.total??0),intents_returned:intents.length,
      facts_total:Number(facts[0]?.total??0),facts_considered:facts.length,uncertain_total:Number(operations[0]?.total??0),
      bounded:true,read:'按 intent_id 缩小清单；全量事实、冷图和来源任务继续用 context_search(source=graph) 分页读取。'},
    completeness:'仅列出已知依赖和已返回原文的缺口，不证明已找齐所有相关证据。'};
}

export async function contextNeedBoundary(ctx:ToolRunContext){
  const manifest=await contextNeeds(ctx,{limit:6});
  // Keep short per-request state at the tail; full evidence stays out of the prompt.
  return '【上下文保留与恢复清单】\n'+JSON.stringify({...manifest,items:manifest.items.map(({summary,...item})=>item),
    lookup:{tool:'context_search',args:{source:'needs'}}});
}
