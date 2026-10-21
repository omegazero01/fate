import {contextEvidence} from './context-evidence.js';
import {contextNeeds} from '../agent/context-needs.js';
import {readOperations} from '../db/operation-journal.js';
import {boundedContextPage,contextNode,contextRelations} from './context-pages.js';
import {ownObservations} from '../db/worker-drafts.js';
import {createHash} from 'node:crypto';
import type {ToolRunContext} from './context.js';
import {domainTool} from './define.js';
import {graphSources,resolveGraphNode,authorizedNodes} from '../db/graph_view.js';
import {nodeDetailTool} from './graph.js';
import {progressSummary,resultSummary,stopSummary} from '../agent/context-projection.js';
import {searchPlannerHistory,getPlannerHistory} from './planner-history.js';

interface Search {source?:'graph'|'planner_session'|'operations'|'needs';q?:string;types?:string[];state?:string;asset_id?:number;intent_id?:number;task_id?:number;limit?:number;cursor?:string;}
export async function searchContext(c:ToolRunContext,args:Search) {
  await recallPermission(c,'context_search');
  if(args.source==='needs'){
    if(args.task_id&&args.task_id!==c.taskID)throw new Error('上下文清单仅限当前任务');
    const page=await contextNeeds(c,{intent_id:args.intent_id,limit:args.limit,cursor:args.cursor});
    return {...page,has_more:page.next_cursor!==null};
  }
  if(args.source==='operations'){
    if(args.task_id&&args.task_id!==c.taskID)throw new Error('操作记录仅限当前任务');
    const page=await readOperations(c,{intent_id:args.intent_id,after:args.cursor?Number(args.cursor):undefined,limit:args.limit});
    return {...page,has_more:page.next_cursor!==null,next_cursor:page.next_cursor===null?null:String(page.next_cursor),detail_tool:'context_get'};
  }
  if(args.source==='planner_session')return searchPlannerHistory(c,args);
  if(args.source!==undefined&&args.source!=='graph')throw new Error('未知上下文来源');
  args={...args,q:args.q?.trim()};
  if(Array.from(args.q??'').length>200)throw new Error('q 最多 200 字符');
  const source=args.task_id&&args.task_id!==c.taskID?(await graphSources(c.db,c.taskID)).find(s=>s.taskID===args.task_id):{taskID:c.taskID,expID:c.expID};
  if(!source)throw new Error('仅可检索本任务及直接来源任务');
  if(args.types?.includes('activity'))return searchActivitiesAndNodes(c,args);
  let types=[...new Set(args.types??['fact','finding','intent'])].sort();
  if(types.some(t=>!['fact','finding','intent','goal','hint','digest'].includes(t)))throw new Error('未知上下文类型');
  const limit=Math.min(50,Math.max(1,args.limit??10));
  const sign=(kinds:string[])=>createHash('sha256').update(JSON.stringify([c.taskID,c.role,source.taskID,kinds,args.q??'',args.state??'',args.asset_id??0,args.intent_id??0,limit])).digest('hex');
  let signature=sign(types);
  let after=0,order:'asc'|'desc'='desc',upper=Number((await c.db.query('SELECT COALESCE(max(id),0) n FROM exploration_nodes WHERE exploration_id=$1',[source.expID])).rows[0]!.n);
  if(args.cursor){
    let parsed:{signature:string;after:number;upper:number;order?:'desc'};
    try{parsed=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));}catch{throw new Error('无效上下文游标');}
    const legacyTypes=['fact','finding','intent','goal','hint','digest'].sort();
    if(!args.types&&!parsed.order&&parsed.signature===sign(legacyTypes)){types=legacyTypes;signature=parsed.signature;}
    if(parsed.signature!==signature||![parsed.after,parsed.upper].every(n=>Number.isSafeInteger(n)&&n>=0)||parsed.after>parsed.upper)throw new Error('游标不属于当前查询');
    // Pre-upgrade cursors keep their original direction until that snapshot ends.
    if(parsed.order!==undefined&&parsed.order!=='desc')throw new Error('无效上下文游标');
    after=parsed.after;upper=parsed.upper;order=parsed.order??'asc';
  }
  const result=await c.db.query(`SELECT n.id,n.kind,n.state,left(COALESCE(n.payload->>'summary',n.payload->>'text',''),300) summary,n.content_version,n.owner,n.payload->>'observation_type' observation_type,n.payload->'writeback' writeback,
      hit.field,hit.snippet,hit.match_offset
    FROM exploration_nodes n
    LEFT JOIN LATERAL (
      SELECT field,substring(body FROM greatest(1,position(lower($5) in lower(body))-60) FOR 180) snippet,
        position(lower($5) in lower(body))-1 match_offset FROM (
          SELECT '/payload/'||replace(replace(key,'~','~0'),'/','~1') field,value#>>'{}' body
            FROM jsonb_each(n.payload) WHERE jsonb_typeof(value)='string'
          UNION ALL SELECT '/finding_detail/evidence',f.evidence FROM findings f WHERE f.node_id=n.id
          UNION ALL SELECT '/finding_detail/report',f.report FROM findings f WHERE f.node_id=n.id
        ) fields WHERE $5<>'' AND position(lower($5) in lower(body))>0
        ORDER BY CASE field WHEN '/payload/summary' THEN 0 WHEN '/payload/detail' THEN 1 WHEN '/payload/evidence' THEN 2 ELSE 3 END,field LIMIT 1
    ) hit ON true
    WHERE n.exploration_id=$1 AND ${order==='desc'?'($2::bigint=0 OR n.id<$2)':'n.id>$2'} AND n.id<=$3 AND n.kind=ANY($4::text[])
      AND ($5='' OR position(lower($5) in lower(n.payload::text))>0 OR EXISTS(
        SELECT 1 FROM findings f WHERE f.node_id=n.id AND position(lower($5) in lower(f.evidence||' '||f.report))>0))
      AND ($6='' OR n.state=$6)
      AND ($7::bigint=0 OR EXISTS(SELECT 1 FROM exploration_anchors a WHERE a.node_id=n.id AND a.asset_id=$7))
      AND ($8::bigint=0 OR n.id=$8 OR EXISTS(SELECT 1 FROM exploration_edges e WHERE e.exploration_id=$1 AND e.src_id=$8 AND e.dst_id=n.id AND e.rel='yields'))
      AND exploration_node_readable($1,n.id) ORDER BY n.id ${order==='desc'?'DESC':'ASC'} LIMIT $9`,[source.expID,after,upper,types,args.q??'',args.state??'',args.asset_id??0,args.intent_id??0,limit+1]);
  const items=boundedContextPage(result.rows.slice(0,limit).map(n=>({ref:`node:${n.id}`,node_id:Number(n.id),version:Number(n.content_version),kind:n.kind,state:n.state,summary:n.summary,owner:String(n.owner??'').slice(0,100),...(['fact','finding'].includes(String(n.kind))?{observation_type:n.observation_type??'unknown',writeback:n.writeback??{scope_status:'legacy_unspecified'}}:{}),
    ...(n.field?{field:n.field,snippet:n.snippet,match_offset:Number(n.match_offset),read:{ref:`node:${n.id}`,view:'detail',field:n.field,version:Number(n.content_version),offset:Math.max(0,Number(n.match_offset)-60)}}:{})})));
  const more=result.rows.length>items.length;
  return {source_task_id:source.taskID,inherited:source.taskID!==c.taskID,read_only:true,items,
    has_more:more,order:order==='desc'?'newest_first':'oldest_first',
    next_cursor:more&&items.length?Buffer.from(JSON.stringify({signature,upper,after:items.at(-1)!.node_id,...(order==='desc'?{order}: {})})).toString('base64url'):null,
    detail_tool:'context_get'};
}

export function contextSearchTool(c:ToolRunContext){return domainTool<Search>({name:'context_search',description:'按全文、类型、资产、意图和状态检索授权探索图，包含冷图原始节点。节点按新到旧返回；默认 fact/finding/intent。返回命中片段、Unicode match_offset 和可直接交给 context_get 的 read。has_more=true 时保留查询参数用 next_cursor 续页；第一页无结果不能证明方向未测试，优先按 asset_id 核对。来源任务只读。',readOnly:true,
  parameters:{type:'object',properties:{source:{type:'string',enum:c.role==='planner'?['graph','planner_session','operations','needs']:['graph','operations','needs'],description:'默认 graph；needs 返回按优先级排序的依赖缺口、未读区间和直接读取参数；operations 查询本任务工具执行记录，Worker 仅能读取自己的记录；planner_session 召回规划历史'},q:{type:'string',maxLength:200,description:'不区分大小写的字面关键词；多个词按完整短语匹配，不是语义搜索。空值按筛选条件列出。'},types:{type:'array',items:{type:'string',enum:['fact','finding','intent','goal','hint','digest','activity']}},state:{type:'string'},asset_id:{type:'integer',minimum:1},intent_id:{type:'integer',minimum:1},task_id:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:50},cursor:{type:'string'}}},run:(args,ctx)=>searchContext(ctx,args)},c);}

function legacyContextGetTool(c:ToolRunContext){return domainTool<{ref:string;version?:number;offset?:number;after_edge?:number;anchor_offset?:number}>({name:'context_get',description:'读取 node:ID 的详情、证据和图关系。超过单页时继续 offset/after_edge/anchor_offset；version 可拒绝读取过程中被修改的节点。',readOnly:true,
  parameters:{type:'object',properties:{ref:{type:'string',pattern:'^node:[1-9][0-9]*$'},version:{type:'integer',minimum:0},offset:{type:'integer',minimum:0},after_edge:{type:'integer',minimum:0},anchor_offset:{type:'integer',minimum:0}},required:['ref']},
  async run(args,c){return c.db.transaction(async db=>{
    const ctx={...c,db};
    if(!/^node:[1-9][0-9]*$/.test(args.ref))throw new Error('无效节点引用');
    const id=Number(args.ref.slice(5));
    const draft=(await ownObservations(ctx,id))[0];
    if(draft){if(args.version!==undefined&&args.version!==Number(draft.draft_version))throw new Error('私有记录版本已变化，请重新读取');const body=JSON.stringify(draft.payload),offset=args.offset??0;return {ref:args.ref,version:Number(draft.draft_version),staged:true,published:false,node:{id,kind:draft.kind,payload:body.length<6000?draft.payload:undefined},payload_json:body.length<6000?undefined:body.slice(offset,offset+1000),next_offset:body.length<6000||offset+1000>=body.length?null:offset+1000};}
    await db.query('SELECT id FROM exploration_nodes WHERE id=$1 FOR SHARE',[id]);
    const resolved=await resolveGraphNode(ctx.db,ctx.taskID,ctx.expID,id);
    if(args.version!==undefined&&args.version!==resolved.node.content_version)throw new Error('节点版本已变化，请重新检索');
    const result=await nodeDetailTool(ctx).execute(ctx.toolCallID??'context-get',{node_id:id,offset:args.offset,after_edge:args.after_edge,anchor_offset:args.anchor_offset} as never,ctx.signal,undefined,{} as never);
    if(result.isError)throw new Error((result.content[0] as {text:string}).text);
    const detail=JSON.parse((result.content[0] as {text:string}).text);
    if(resolved.node.kind==='finding'){
      const finding=(await db.query('SELECT id,name,severity,summary,evidence,report,status,evidence_version,report_evidence_version FROM findings WHERE node_id=$1',[id])).rows[0];
      const payload={...resolved.node.payload,finding_detail:finding??null},serialized=JSON.stringify(payload),offset=args.offset??0;
      const small=Buffer.byteLength(serialized)<8000;
      detail.node.payload=small?payload:undefined;
      detail.payload_json=small?undefined:serialized.slice(offset,offset+1000);
      detail.next_offset=small||offset+1000>=serialized.length?null:offset+1000;
    }
    return {...detail,ref:args.ref,version:resolved.node.content_version};
  });}},c);}


async function recallPermission(c:ToolRunContext,key:string){
  const row=(await c.db.query('SELECT enabled,agents FROM tools WHERE key=$1',[key])).rows[0];
  if(row&&(row.enabled===false||!Array.isArray(row.agents)||!row.agents.includes(c.role)))throw new Error(`当前角色无 ${key} 读取权限`);
}
async function searchActivitiesAndNodes(c:ToolRunContext,args:Search){
  await recallPermission(c,'search_worker_traces');
  // The old trace search is local-only. Merging tools must not add cross-task search.
  if(args.task_id&&args.task_id!==c.taskID)throw new Error('活动检索仅限本任务');
  const types=[...new Set(args.types??[])].sort(),limit=Math.min(50,Math.max(1,args.limit??10));
  if(types.some(t=>!['fact','finding','intent','goal','hint','digest','activity'].includes(t)))throw new Error('未知上下文类型');
  const signature=createHash('sha256').update(JSON.stringify([c.taskID,c.role,types,args.q??'',args.state??'',args.asset_id??0,args.intent_id??0,limit])).digest('hex');
  let cursor:{signature:string;after:number;kind:string;nodes:number;activities:number;order?:'desc';time?:string}={signature,after:0,kind:'',nodes:0,activities:0,order:'desc'};
  if(args.cursor){
    try{cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());}catch{throw new Error('无效上下文游标');}
    if(cursor.signature!==signature||![cursor.after,cursor.nodes,cursor.activities].every(n=>Number.isSafeInteger(n)&&n>=0)||!['','node','activity'].includes(cursor.kind))throw new Error('游标不属于当前查询');
    if(cursor.order!==undefined&&cursor.order!=='desc'||cursor.time!==undefined&&!Number.isFinite(Date.parse(cursor.time)))throw new Error('无效上下文游标');
  }else{
    const r=(await c.db.query('SELECT (SELECT COALESCE(max(id),0) FROM exploration_nodes WHERE exploration_id=$1) nodes,(SELECT COALESCE(max(id),0) FROM activity WHERE exploration_id=$1) activities',[c.expID])).rows[0]!;
    cursor.nodes=Number(r.nodes);cursor.activities=Number(r.activities);
  }
  const rows=(await c.db.query(`WITH candidates AS (
    SELECT n.id,'node'::text category,n.kind,n.state,n.payload->>'summary' summary,(n.payload::text||COALESCE((SELECT f.evidence||f.report FROM findings f WHERE f.node_id=n.id),'')) body,n.id node_id,n.content_version version,n.owner worker,false is_error,n.created_at
      FROM exploration_nodes n WHERE n.exploration_id=$1 AND n.id<=$2 AND n.kind=ANY($4::text[])
    UNION ALL
    SELECT a.id,'activity',a.kind,n.state,a.summary,COALESCE(a.detail,a.summary),a.node_id,n.content_version,a.worker,a.is_error,a.created_at
      FROM activity a JOIN exploration_nodes n ON n.id=a.node_id AND n.exploration_id=a.exploration_id
      WHERE a.exploration_id=$1 AND a.id<=$3 AND n.kind='intent' AND a.kind NOT IN ('usage','round','thinking')
  ) SELECT c.id,c.category,c.kind,c.state,left(c.summary,300) summary,c.node_id,c.version,left(c.worker,100) worker,c.is_error,c.created_at::text created_at FROM candidates c
    WHERE ${cursor.order==='desc'?'($12::timestamptz IS NULL OR (c.created_at,c.id,c.category)<($12::timestamptz,$5::bigint,$6::text))':'(c.id,c.category)>($5::bigint,$6::text) AND $12::timestamptz IS NULL'}
    AND ($7='' OR position(lower($7) in lower(COALESCE(c.body,'')||COALESCE(c.summary,'')))>0)
    AND ($8='' OR c.state=$8) AND ($9::bigint=0 OR c.node_id=$9 OR c.category='node' AND EXISTS(
      SELECT 1 FROM exploration_edges e WHERE e.exploration_id=$1 AND e.src_id=$9 AND e.dst_id=c.node_id AND e.rel='yields'))
    AND ($10::bigint=0 OR EXISTS(SELECT 1 FROM exploration_anchors a WHERE a.node_id=c.node_id AND a.asset_id=$10))
    AND exploration_node_readable($1,c.node_id) ORDER BY ${cursor.order==='desc'?'c.created_at DESC,c.id DESC,c.category DESC':'c.id,c.category'} LIMIT $11`,
    [c.expID,cursor.nodes,cursor.activities,types,cursor.after,cursor.kind,args.q??'',args.state??'',args.intent_id??0,args.asset_id??0,limit+1,cursor.time??null])).rows;
  const page=boundedContextPage(rows.slice(0,limit)),last=page.at(-1);
  return {source_task_id:c.taskID,read_only:true,items:page.map(r=>({ref:`${r.category}:${r.id}`,kind:r.category==='activity'?'activity':r.kind,activity_kind:r.category==='activity'?r.kind:undefined,intent_id:r.category==='activity'?Number(r.node_id):undefined,state:r.state,version:Number(r.version),summary:Array.from(String(r.summary??'')).slice(0,300).join(''),is_error:r.is_error,worker:r.worker})),
    has_more:rows.length>page.length,order:cursor.order==='desc'?'newest_first':'oldest_first',
    next_cursor:rows.length>page.length&&last?Buffer.from(JSON.stringify({...cursor,after:Number(last.id),kind:last.category,...(cursor.order==='desc'?{time:String(last.created_at)}:{})})).toString('base64url'):null};
}
interface RecallItem {ref:string;view?:'summary'|'detail'|'output'|'parents'|'members';field?:string;offset?:number;version?:number;cursor?:string;}
interface RecallArgs {items?:RecallItem[];max_chars?:number;ref?:string;version?:number;offset?:number;after_edge?:number;anchor_offset?:number;}
function pointer(value:unknown,field?:string):unknown{
  if(!field)return value;
  if(!field.startsWith('/'))throw new Error('field 必须是 JSON Pointer');
  for(const token of field.slice(1).split('/').map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'))){
    if(!value||typeof value!=='object'||!Object.hasOwn(value,token))throw new Error('field 不存在');
    value=(value as Record<string,unknown>)[token];
  }
  return value;
}
export function contextGetTool(c:ToolRunContext){return domainTool<RecallArgs>({name:'context_get',readOnly:true,
  description:'批量读取 node:ID、activity:ID、operation:ID、output:UUID、attachment:URL编码路径、traffic:UUID:request|response；证据引用按返回 offset_unit/next_item 续读；detail 为完整证据，output 为最终输出，parents 为上游，members 为冷图成员。field 使用 JSON Pointer；offset 按 Unicode 字符续读，沿用返回的 next_offset。来源任务只读。',
  parameters:{type:'object',properties:{items:{type:'array',minItems:1,maxItems:5,items:{type:'object',properties:{ref:{type:'string',pattern:'^((node|activity|operation):[1-9][0-9]*|session:[a-zA-Z0-9_-]+|(output|attachment|traffic):.+)$'},view:{type:'string',enum:['summary','detail','output','parents','members']},field:{type:'string'},offset:{type:'integer',minimum:0},version:{type:'integer',minimum:0},cursor:{type:'string',description:'parents/members 关系页游标；按 next_cursor 续读，页内先读完 next_offset'}},required:['ref']}},max_chars:{type:'integer',minimum:256,maximum:24000}},required:['items']},
  async run(args,ctx){
    if(!args.items&&args.ref){const result=await legacyContextGetTool(ctx).execute(ctx.toolCallID??'legacy-read',args as never,ctx.signal,undefined,{} as never);if(result.isError)throw new Error((result.content[0] as {text:string}).text);return JSON.parse((result.content[0] as {text:string}).text);}
    if(!args.items?.length||args.items.length>5)throw new Error('items 需要 1–5 个引用');
    let budget=Math.min(24000,Math.max(256,args.max_chars??8000)),bytes=18000;
    const items=[];
    for(let i=0;i<args.items.length;i++){
      const item=args.items[i]!,view=item.view??'detail';
      try{
        await recallPermission(ctx,'context_get');
        const evidence=await contextEvidence(ctx,item);
        if(evidence){items.push(evidence);bytes-=Buffer.byteLength(JSON.stringify(evidence));budget-=400;continue;}
        if((view==='parents'||view==='members')&&(item.offset??0)>0&&!item.cursor)
          throw new Error('关系分页请从 offset 0 重新读取，再沿用 page_cursor 和 next_offset 续读');
        const match=/^(node|activity|operation|session):([a-zA-Z0-9_-]+)$/.exec(item.ref);if(!match)throw new Error('无效引用');
        const id=Number(match[2]);let evidenceScope:unknown;let data:unknown,version:number|undefined,sourceTask=ctx.taskID,nextCursor:string|null=null,pageCursor:string|undefined;
        if(match[1]==='session'){
          if(!['summary','detail','output'].includes(view)||item.cursor)throw new Error('历史会话不支持关系视图或关系游标');
          data=await getPlannerHistory(ctx,item.ref);
        }else if(!Number.isSafeInteger(id)||id<=0){throw new Error('无效节点或活动引用');
        }else if(match[1]==='operation'){
          const page=await readOperations(ctx,{id});
          if(!page.items[0])throw new Error('当前任务或意图没有该操作记录');
          if(!['summary','detail','output'].includes(view))throw new Error('操作记录不支持关系视图');
          data=page.items[0];
          if(view==='summary'){const {result,...meta}=data as Record<string,unknown>;data=meta;}
        }else if(match[1]==='activity'){
          await recallPermission(ctx,'get_worker_trace');
          const a=(await ctx.db.query("SELECT * FROM activity WHERE id=$1 AND node_id IS NOT NULL AND kind NOT IN ('thinking','usage','round')",[id])).rows[0];
          if(!a)throw new Error('活动不存在');
          const resolved=await resolveGraphNode(ctx.db,ctx.taskID,ctx.expID,Number(a.node_id));
          if(resolved.node.kind!=='intent')throw new Error('仅支持 Worker 活动');
          if(!['detail','output'].includes(view))throw new Error('活动不支持该视图');
          sourceTask=resolved.taskID;version=resolved.node.content_version;
          data={ref:item.ref,intent_id:Number(a.node_id),kind:a.kind,is_error:a.is_error,summary:a.summary,detail:a.detail,output_type:a.is_error?'error':(a.metadata as Record<string,unknown>|undefined)?.event_type==='outcome'?'final':'progress'};
        }else{
          const draft=(await ownObservations(ctx,id))[0];
          if(draft){data={staged:true,published:false,payload:draft.payload};version=Number(draft.draft_version);}
          else{
            const meta=await contextNode(ctx,id);
            sourceTask=meta.taskID;version=meta.version;
            if(item.version!==undefined&&item.version!==version)throw new Error('节点版本已变化，请重新检索');
            if(view==='summary'){
              data={ref:item.ref,kind:meta.kind,state:meta.state,summary:meta.summary,version};
            }else if(view==='parents'||view==='members'){
              await recallPermission(ctx,view==='members'?'expand_digest':'node_detail');
              const page=await contextRelations(ctx,meta,view,item.cursor);data=page.items;nextCursor=page.next_cursor;pageCursor=page.page_cursor;
            }else {
            const r=await resolveGraphNode(ctx.db,ctx.taskID,ctx.expID,id);
            version=r.node.content_version;
            if(r.node.kind==='fact'&&r.node.payload.observation_type==='negative')evidenceScope={claim:'reported_negative',scope_verified:false,unmeasured_directions:'unknown',direction_exclusions:[]};
            if(view==='output'){
              await recallPermission(ctx,'get_worker_trace');
              if(r.node.kind!=='intent')throw new Error('output 仅支持意图');
              data={execution_stop:r.node.payload.execution_stop,execution_result:r.node.payload.execution_result,
                activity:(await ctx.db.query("SELECT id,kind,summary,detail,is_error,metadata FROM activity WHERE exploration_id=$1 AND node_id=$2 AND kind='result' AND (metadata->>'event_type'='outcome' OR metadata->>'event_type' IS NULL) ORDER BY id DESC LIMIT 1",[r.expID,id])).rows[0]??null};
            }else if(view==='detail'){
              data={...r.node,anchors:await ctx.db.exploration(r.expID).anchorAssetIDs(id),...(r.node.kind==='finding'?{finding_detail:(await ctx.db.query('SELECT id,name,severity,summary,evidence,report,status,evidence_version,report_evidence_version FROM findings WHERE node_id=$1',[id])).rows[0]??null}:{})};
            }else throw new Error('未知视图');
            }
          }
        }
        if(item.version!==undefined&&item.version!==version)throw new Error('节点版本已变化，请重新检索');
        const value=pointer(data,item.field),chars=Array.from(typeof value==='string'?value:JSON.stringify(value??null));
        const offset=Math.max(0,item.offset??0),remaining=args.items.length-i;
        const take=Math.min(Math.floor(budget/remaining),Math.floor(bytes/remaining/6));
        const content=chars.slice(offset,offset+take).join('');budget-=Array.from(content).length;bytes-=Buffer.byteLength(JSON.stringify(content));
        const nextOffset=offset+take<chars.length?offset+take:null;
        const nextItem=nextOffset!==null?{ref:item.ref,view,field:item.field,version,offset:nextOffset,...(pageCursor?{cursor:pageCursor}:{})}
          :nextCursor?{ref:item.ref,view,field:item.field,version,offset:0,cursor:nextCursor}:undefined;
        const readReceipt={version:1,source_hash:createHash('sha256').update(chars.join('')).digest('hex'),start:Math.min(offset,chars.length),end:Math.min(offset,chars.length)+Array.from(content).length,total:chars.length};
        const historySegment=match[1]==='session'?{segment:{start:offset,end:offset+Array.from(content).length,total:chars.length,complete:offset===0&&nextOffset===null},
          ...(offset>0||nextOffset!==null?{note:'仅当前分段；未返回区间不能视为已读或无证据。'}:{})}:{};
        items.push({ref:item.ref,view,field:item.field,version,source_task_id:sourceTask,inherited:sourceTask!==ctx.taskID,content,total_chars:chars.length,next_offset:nextOffset,read_receipt:readReceipt,...(evidenceScope?{evidence_scope:evidenceScope}:{}),...historySegment,...(nextItem?{next_item:nextItem}:{}),...(view==='parents'||view==='members'?{page_cursor:pageCursor,next_cursor:nextOffset!==null?null:nextCursor}:{} )});
      }catch(error){items.push({ref:item.ref,error:error instanceof Error?error.message:String(error)});}
    }
    return {items};
  }},c);}

export async function workerLaunchContext(c:ToolRunContext,intentID:number){
  const rows=await c.db.query(`SELECT src_id FROM exploration_edges WHERE exploration_id=$1 AND dst_id=$2 AND rel='derived_from' ORDER BY id LIMIT 21`,[c.expID,intentID]);
  const parents=await authorizedNodes(c.db,c.taskID,c.expID,await c.db.exploration(c.expID).nodesByIDs(rows.rows.slice(0,20).map(r=>Number(r.src_id))));
  const node=await c.db.exploration(c.expID).getNode(intentID);
  const inherited=[];
  const basis=(node?.payload.contract as {basis?:{node_id:number}[]}|undefined)?.basis??[];
  for(const ref of basis){
    if(parents.some(n=>n.id===ref.node_id))continue;
    try{const source=await resolveGraphNode(c.db,c.taskID,c.expID,ref.node_id);inherited.push({ref:`node:${source.node.id}`,version:source.node.content_version,summary:String(source.node.payload.summary??'').slice(0,600),source_task_id:source.taskID});}catch{/* Revoked references are never injected. */}
  }
  const drafts=await ownObservations({...c,intentID});
  return {intent_id:intentID,private_observations:drafts.map(d=>({ref:`node:${d.node_id}`,kind:d.kind,summary:String((d.payload as Record<string,unknown>).summary??'').slice(0,300),staged:true,version:Number(d.draft_version)})),upstream:[...parents.map(n=>({ref:`node:${n.id}`,version:n.content_version,summary:String(n.payload.summary??'').slice(0,600)})),...inherited],more_parents:rows.rows.length>20,
    progress:progressSummary((await c.db.query('SELECT progress FROM worker_checkpoints WHERE intent_id=$1',[intentID])).rows[0]?.progress??node?.payload.progress),previous_result:resultSummary(node?.payload.previous_result),execution_stop:stopSummary(node?.payload.execution_stop),
    own_findings:await searchContext(c,{intent_id:intentID,types:['fact','finding'],limit:10}),
    graph_access:{search:'context_search',detail:'context_get',note:'只执行当前意图；边发现边用 record_fact/report_finding 直接写回，最后简洁总结。private_observations 和 progress 是旧版历史材料，须复核后重新写回，不自动发布。'}};
}
