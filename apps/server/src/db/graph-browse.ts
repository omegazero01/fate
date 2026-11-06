import type {Database} from './index.js';
import {graphProjection,graphProjectionRevision} from './graph-projection.js';

export const GRAPH_PAGE_SIZE=50,GRAPH_EDGE_PAGE_SIZE=200,GRAPH_BODY_CHARS=8192;
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const kinds=new Set(['goal','intent','fact','finding','hint','digest']);
const integer=(value:unknown,fallback=0)=>{
 if(value===undefined||value==='')return fallback;
 if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw fail('无效分页位置或节点 ID');
 return Number(value);
};
const stamp=(value:unknown)=>{
 if(value===undefined||value==='')return undefined;
 if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw fail('无效图谱版本');return value;
};
/** Direct owners only. Never materialize payloads for every visible node. */
const OWNERS=`owners AS MATERIALIZED (
 SELECT id task_id,exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL
 UNION SELECT s.id,s.exploration_id FROM task_relations r JOIN tasks c ON c.id=r.task_id JOIN tasks s ON s.id=r.source_task_id
 WHERE r.task_id=$1 AND c.deleted_at IS NULL AND s.deleted_at IS NULL
), visible AS NOT MATERIALIZED (
 SELECT n.id,n.exploration_id,n.kind,n.state FROM exploration_nodes n JOIN owners o USING(exploration_id)
 WHERE exploration_node_readable(n.exploration_id,n.id)
)`;
const title=`COALESCE(NULLIF(n.payload->>'name',''),NULLIF(n.payload->>'summary',''),NULLIF(n.payload->>'text',''),n.payload->>'body','')`;
const NODE=`n.id::text,n.kind type,n.state,n.priority,left(COALESCE(n.origin,''),256) origin,n.created_at ts,
 o.task_id::text source_task_id,o.task_id<>$1 inherited,n.content_version::text version,
 left(${title},768) summary,char_length(${title})>768 summary_truncated`;
function node(row:Record<string,any>):Record<string,any>&{id:string}{return {...row,id:String(row.id),payload:JSON.stringify({summary:row.summary}),payload_preview:true};}
function edge(row:Record<string,any>){return {id:String(row.id),src:String(row.src_id),dst:String(row.dst_id),rel:String(row.rel)};}
async function taskScope(db:Database,taskID:number){
 const r=(await db.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskID])).rows[0];
 if(!r)throw fail('任务不存在',404);return Number(r.exploration_id);
}
const memberCTE=`members AS (
 SELECT e.dst_id id FROM exploration_edges e WHERE e.src_id=$2 AND e.rel='covers'
 UNION SELECT value::bigint FROM exploration_nodes n CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(n.payload->'member_ids')='array' THEN n.payload->'member_ids'
   ELSE (CASE WHEN jsonb_typeof(n.payload#>'{member_ids,facts}')='array' THEN n.payload#>'{member_ids,facts}' ELSE '[]'::jsonb END)
    ||(CASE WHEN jsonb_typeof(n.payload#>'{member_ids,intents}')='array' THEN n.payload#>'{member_ids,intents}' ELSE '[]'::jsonb END) END
 ) v(value) WHERE n.id=$2 AND value~'^[0-9]{1,18}$'
)`;

export async function readGraphPage(db:Database,taskID:number,query:Record<string,unknown>){
 const expID=await taskScope(db,taskID),focus=integer(query.focus),before=integer(query.before),edgeBefore=integer(query.edge_before);
 const mode=query.mode??(focus?'relations':'nodes'),direction=query.direction??'all',kind=query.kind??'';
 const search=typeof query.q==='string'?query.q.trim():'';
 if(!['nodes','relations','members'].includes(String(mode))||!['all','in','out'].includes(String(direction))||kind&&!kinds.has(String(kind))||Array.from(search).length>256)throw fail('无效图谱查询');
 if(mode!=='nodes'&&!focus)throw fail('请选择节点');
 const expected=stamp(query.revision),known=stamp(query.known_revision);
 const current=await graphProjectionRevision(db,taskID,expID);
 if(expected&&expected!==current)throw fail('图谱已变化，请刷新当前视图后继续',409);
 if(known===current)return {unchanged:true as const,revision:current};
 const key=JSON.stringify(['ui-graph',mode,focus,before,edgeBefore,direction,kind,search]);
 const result=await graphProjection(db,taskID,expID,key,async tx=>{
  const revision=await graphProjectionRevision(tx,taskID,expID);
  const counts=(await tx.query(`WITH ${OWNERS} SELECT c.kind,sum(c.n) n FROM exploration_node_counts c JOIN owners o USING(exploration_id) GROUP BY c.kind`,[taskID])).rows;
  const count=counts.reduce((n,r)=>n+Number(r.n),0);
  let selected:string[]=[],edges:Record<string,any>[]=[],total=0,next:string|null=null,edgeTotal=0,nextEdge:string|null=null;
  if(focus){
   const f=(await tx.query(`WITH ${OWNERS} SELECT kind FROM visible WHERE id=$2`,[taskID,focus])).rows[0];
   if(!f)throw fail('节点不存在或未获授权',404);
   if(mode==='members'&&f.kind!=='digest')throw fail('该节点不是摘要');
  }
  if(mode==='relations'){
   const relation=direction==='in'?'e.dst_id=$2':direction==='out'?'e.src_id=$2':'(e.src_id=$2 OR e.dst_id=$2)';
   const base=`WITH ${OWNERS} SELECT e.* FROM exploration_edges e JOIN visible s ON s.id=e.src_id JOIN visible d ON d.id=e.dst_id WHERE ${relation}`;
   const rows=(await tx.query(`${base} AND ($3::bigint=0 OR e.id<$3) ORDER BY e.id DESC LIMIT ${GRAPH_PAGE_SIZE+1}`,[taskID,focus,before])).rows;
   total=Number((await tx.query(`SELECT count(*) n FROM (${base}) matched`,[taskID,focus])).rows[0]!.n);
   edges=rows.slice(0,GRAPH_PAGE_SIZE);next=rows.length>GRAPH_PAGE_SIZE?String(edges.at(-1)!.id):null;
   selected=[...new Set([String(focus),...edges.flatMap(e=>[String(e.src_id),String(e.dst_id)])])];edgeTotal=total;
  }else{
   const params=mode==='members'?[taskID,focus,before]:[taskID,String(kind),`%${search.replace(/[\\%_]/g,'\\$&')}%`,before];
   const cte=mode==='members'?`${OWNERS},${memberCTE}`:OWNERS;
   const match=mode==='members'?'v.id IN(SELECT id FROM members)':`($2::text='' OR v.kind=$2) AND ($3::text='%%' OR ${title} ILIKE $3)`;
   const base=`WITH ${cte} SELECT v.id FROM visible v JOIN exploration_nodes n ON n.id=v.id WHERE ${match}`;
   const pos=mode==='members'?3:4;
   const rows=(await tx.query(`${base} AND ($${pos}::bigint=0 OR v.id<$${pos}) ORDER BY v.id DESC LIMIT ${GRAPH_PAGE_SIZE+1}`,params)).rows;
   total=mode==='nodes'&&!search?kind?Number(counts.find(r=>r.kind===kind)?.n??0):count:Number((await tx.query(`SELECT count(*) n FROM (${base}) matched`,params.slice(0,-1))).rows[0]!.n);
   selected=rows.slice(0,GRAPH_PAGE_SIZE).map(r=>String(r.id));next=rows.length>GRAPH_PAGE_SIZE?selected.at(-1)!:null;
   if(mode==='members')selected=[String(focus),...selected.filter(id=>id!==String(focus))];
   const baseEdges=`SELECT e.* FROM exploration_edges e WHERE e.src_id=ANY($1::bigint[]) AND e.dst_id=ANY($1::bigint[])`;
   const er=(await tx.query(`${baseEdges} AND ($2::bigint=0 OR e.id<$2) ORDER BY e.id DESC LIMIT ${GRAPH_EDGE_PAGE_SIZE+1}`,[selected,edgeBefore])).rows;
   edges=er.slice(0,GRAPH_EDGE_PAGE_SIZE);nextEdge=er.length>GRAPH_EDGE_PAGE_SIZE?String(edges.at(-1)!.id):null;
   edgeTotal=Number((await tx.query(`SELECT count(*) n FROM (${baseEdges}) matched`,[selected])).rows[0]!.n);
  }
  const nodes=(await tx.query(`WITH ${OWNERS} SELECT ${NODE} FROM exploration_nodes n JOIN owners o USING(exploration_id) WHERE n.id=ANY($2::bigint[]) ORDER BY n.id DESC`,[taskID,selected])).rows.map(node);
  return {unchanged:false as const,revision,mode,focus:focus?String(focus):null,nodes,edges:edges.map(edge),total_nodes:count,total,edge_total:edgeTotal,
   before:before?String(before):null,next_before:next,edge_before:edgeBefore?String(edgeBefore):null,next_edge_before:nextEdge,
   has_more:next!==null,edges_has_more:nextEdge!==null,complete:mode==='nodes'&&nodes.length===count&&edges.length===edgeTotal};
 });
 if(expected&&result.revision!==expected)throw fail('图谱已变化，请刷新当前视图后继续',409);
 return result;
}

/** Raw JSON is read in Unicode pages inside PostgreSQL; never load it whole
 * merely to cut a preview. Every page rechecks current source membership. */
export async function readGraphNodePage(db:Database,taskID:number,id:number,query:Record<string,unknown>):Promise<any>{
 await taskScope(db,taskID);const offset=integer(query.offset),assetOffset=integer(query.asset_offset);
 if(!Number.isSafeInteger(id)||id<1||offset>2147483646||assetOffset>2147483646)throw fail('无效节点或读取位置');
 const version=query.version;if(version!==undefined&&(typeof version!=='string'||!/^\d{1,20}$/.test(version)))throw fail('无效原文版本');
 if(!db.transactionClient)return db.transaction(async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  return readGraphNodePage(tx,taskID,id,query);
 });
 const tx=db;
 const expID=await taskScope(tx,taskID),revision=await graphProjectionRevision(tx,taskID,expID);
 const expected=stamp(query.revision);if(expected&&expected!==revision)throw fail('图谱已变化，请重新读取',409);
 const assetSize=query.legacy_assets===true?50:20,assetOrder=query.legacy_assets===true?'a.last_seen DESC NULLS LAST,a.id DESC':'a.id';
  const r=(await tx.query(`WITH ${OWNERS} SELECT ${NODE},n.xmin::text body_version,
   substring(n.payload::text FROM $3::int+1 FOR ${GRAPH_BODY_CHARS}) content,char_length(n.payload::text) total_chars
   FROM exploration_nodes n JOIN owners o USING(exploration_id) WHERE n.id=$2 AND exploration_node_readable(n.exploration_id,n.id)`,[taskID,id,offset])).rows[0];
  if(!r)throw fail('节点不存在或未获授权',404);
  if(version!==undefined&&version!==r.body_version)throw fail('原文已变化，请从第一页重新读取',409);
  const total=Number(r.total_chars);if(offset>total)throw fail('读取位置超出原文范围');
  const assetsWhere=`FROM assets a JOIN exploration_anchors an ON an.asset_id=a.id WHERE an.node_id=$2 AND EXISTS(
   SELECT 1 FROM task_asset_links l JOIN owners o ON o.task_id=l.task_id WHERE l.asset_id=a.id)`;
  const assets=(await tx.query(`WITH ${OWNERS} SELECT a.id::text,a.type,left(a.domain,512) domain,left(a.url,512) url,left(a.method,32) method,
   left(a.ip,128) ip,a.port,left(a.app_name,512) app_name ${assetsWhere} ORDER BY ${assetOrder} LIMIT ${assetSize} OFFSET $3`,[taskID,id,assetOffset])).rows;
  const assetsTotal=Number((await tx.query(`WITH ${OWNERS} SELECT count(*) n ${assetsWhere}`,[taskID,id])).rows[0]!.n);
  const {content,total_chars,body_version,...preview}=r;
  return {revision,node:node(preview),content:{detail:String(content),offset,next_offset:Math.min(total,offset+GRAPH_BODY_CHARS),total_chars:total,has_more:offset+GRAPH_BODY_CHARS<total,version:body_version,offset_unit:'unicode_codepoints'},
   assets,assets_total:assetsTotal,asset_offset:assetOffset,assets_next_offset:assetOffset+assets.length<assetsTotal?assetOffset+assets.length:null};
}

/** Legacy broadcast API, now bounded independently of evidence size and degree. */
export async function readBroadcastPage(db:Database,taskID:number,q:Record<string,unknown>){
 const expID=await taskScope(db,taskID),page=Math.max(1,integer(q.page,1)),size=Math.min(100,Math.max(1,integer(q.size,20)));
 const offset=(page-1)*size;if(offset>2147483646)throw fail('页码超出范围');
 const selectedKinds=typeof q.kind==='string'&&q.kind?q.kind.split(','):[],states=typeof q.state==='string'&&q.state?q.state.split(','):[];
 if(selectedKinds.some(k=>!kinds.has(k))||states.length>20||states.some(s=>s.length>64))throw fail('无效节点筛选');
 const search=typeof q.q==='string'?q.q.trim():'';if(Array.from(search).length>256)throw fail('搜索内容过长');
 const order=q.order==='asc'?'ASC':'DESC',countOnly=q.count_only==='1'||q.count_only==='true',edgeOffset=integer(q.edge_offset);
 if(edgeOffset>2147483646)throw fail('关联分页位置超出范围');
 const expected=stamp(q.revision);
 const result=await graphProjection(db,taskID,expID,JSON.stringify(['broadcast',page,size,selectedKinds,states,search,order,countOnly,q.edges==='none',edgeOffset]),async tx=>{
  const revision=await graphProjectionRevision(tx,taskID,expID);
  if(expected&&expected!==revision)throw fail('图谱已变化，请刷新第一页',409);
  const params:unknown[]=[taskID,selectedKinds,states,`%${search.replace(/[\\%_]/g,'\\$&')}%`];
  const filter=`(cardinality($2::text[])=0 OR n.kind=ANY($2)) AND (cardinality($3::text[])=0 OR n.state=ANY($3))
   AND ($4::text='%%' OR n.payload::text ILIKE $4 OR n.origin ILIKE $4 OR n.id::text ILIKE $4)`;
  const total=Number((await tx.query(`WITH ${OWNERS} SELECT count(*) n FROM exploration_nodes n JOIN owners o USING(exploration_id)
   WHERE exploration_node_readable(n.exploration_id,n.id) AND ${filter}`,params)).rows[0]!.n);
  const items=countOnly?[]:(await tx.query(`WITH ${OWNERS} SELECT ${NODE} FROM exploration_nodes n JOIN owners o USING(exploration_id)
   WHERE exploration_node_readable(n.exploration_id,n.id) AND ${filter} ORDER BY n.id ${order} LIMIT $5 OFFSET $6`,[...params,size,offset])).rows.map(node);
  const relations=countOnly||q.edges==='none'?{edges:[],refs:{},edge_total:0,edges_next_offset:null}:await incidentEdges(tx,taskID,items.map(n=>String(n.id)),edgeOffset);
  return {items,total,page,size,revision,payload_preview:true,...relations,has_more:offset+items.length<total};
 });
 if(expected&&result.revision!==expected)throw fail('图谱已变化，请刷新第一页',409);
 return result;
}

async function incidentEdges(db:Database,taskID:number,ids:string[],offset:number){
 if(!ids.length)return {edges:[],refs:{},edge_total:0,edges_next_offset:null};
 const base=`WITH ${OWNERS} SELECT e.id,e.src_id,e.dst_id,e.rel FROM exploration_edges e
  JOIN visible s ON s.id=e.src_id JOIN visible d ON d.id=e.dst_id WHERE e.src_id=ANY($2::bigint[]) OR e.dst_id=ANY($2::bigint[])`;
 const total=Number((await db.query(`SELECT count(*) n FROM (${base}) matches`,[taskID,ids])).rows[0]!.n);
 const rows=(await db.query(`${base} ORDER BY e.id LIMIT ${GRAPH_EDGE_PAGE_SIZE} OFFSET $3`,[taskID,ids,offset])).rows;
 const refs=[...new Set(rows.flatMap(r=>[String(r.src_id),String(r.dst_id)]))];
 const summaries=(await db.query(`WITH ${OWNERS} SELECT ${NODE} FROM exploration_nodes n JOIN owners o USING(exploration_id)
  WHERE n.id=ANY($2::bigint[]) ORDER BY n.id`,[taskID,refs])).rows.map(node);
 return {edges:rows.map(edge),refs:Object.fromEntries(summaries.map(n=>[n.id,n])),edge_total:total,edges_next_offset:offset+rows.length<total?offset+rows.length:null};
}

/** Preserve the legacy DTO and explicit offsets, but never embed the entire raw
 * payload a second time inside node. New first-party readers use view=page. */
export async function readLegacyNodePage(db:Database,taskID:number,id:number,q:Record<string,unknown>):Promise<any>{
 if(!db.transactionClient)return db.transaction(async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  return readLegacyNodePage(tx,taskID,id,q);
 });
 const offset=q.body_offset==='-1'?0:integer(q.body_offset),edgeOffset=q.edge_offset==='-1'?0:integer(q.edge_offset);
 if(edgeOffset>2147483646)throw fail('关联分页位置超出范围');
 const body=await readGraphNodePage(db,taskID,id,{offset:String(offset),asset_offset:q.asset_offset,version:q.version,revision:q.revision,legacy_assets:true});
 const expID=await taskScope(db,taskID);
 const expected=stamp(q.revision);
 const relation=await graphProjection(db,taskID,expID,JSON.stringify(['legacy-relations',id,edgeOffset]),async tx=>{
  const revision=await graphProjectionRevision(tx,taskID,expID);
  if(expected&&revision!==expected)throw fail('图谱已变化，请刷新第一页',409);
  if(!(await tx.query(`WITH ${OWNERS} SELECT id FROM visible WHERE id=$2`,[taskID,id])).rowCount)throw fail('节点不存在或未获授权',404);
  return {revision,...await incidentEdges(tx,taskID,[String(id)],edgeOffset)};
 });
 if(expected&&relation.revision!==expected)throw fail('图谱已变化，请刷新第一页',409);
 return {node:body.node,payload:q.body_offset==='-1'?'':body.content.detail,payload_preview:true,
  payload_next_offset:body.content.has_more?body.content.next_offset:0,payload_offset:offset,payload_total_chars:body.content.total_chars,
  payload_version:body.content.version,offset_unit:'unicode_codepoints',...relation,edges_next_offset:relation.edges_next_offset??0,
  assets:body.assets.map((a:Record<string,any>)=>({...a,id:Number(a.id)})),assets_total:body.assets_total,assets_next_offset:body.assets_next_offset??undefined};
}
