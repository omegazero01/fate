import type {Database} from './index.js';
import type {StreamScope} from '../engine/live-stream.js';

export const ACTIVITY_PREVIEW_CHARS=8192;
export const ACTIVITY_PAGE_BYTES=1024*1024;
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});

/** Project before crossing the DB connection. Originals and authorization always
 * use the stored columns, never this presentation projection. */
export function activityMetadataSQL(column='metadata'){
 const keys=['turn_id','stream_id','channel','event_type','status','role','runtime_id','mode','started_at','stop_reason','final_answer','interrupted','source','phase','planner_round','steering','worker_feedback','response','llm_transition','attachments','raw_source_only','native_recovered','native_recovery_reconciled','native_event'];
 const usage=['input','output','cacheRead','cacheWrite','totalTokens'].map(key=>{
  const value=`${column}#>'{response,usage,${key}}'`;return `'${key}',CASE WHEN jsonb_typeof(${value})='number' AND octet_length((${value})::text)<64 THEN ${value} END`;
 }).join(',');
 const response=`CASE WHEN ${column} ? 'response' THEN jsonb_strip_nulls(jsonb_build_object(
  'model',left(${column}#>>'{response,model}',256),'provider',left(${column}#>>'{response,provider}',256),
  'stop_reason',left(${column}#>>'{response,stop_reason}',64),'has_tools',CASE WHEN jsonb_typeof(${column}#>'{response,has_tools}')='boolean' THEN ${column}#>'{response,has_tools}' END,
  'usage',jsonb_strip_nulls(jsonb_build_object(${usage})))) END`;
 const controls=keys.map(key=>`'${key}',CASE WHEN octet_length((${column}->'${key}')::text)<=2048 THEN ${column}->'${key}' ${key==='response'?`ELSE ${response}`:''} END`).join(',');
 return `CASE WHEN octet_length(${column}::text)<=8192 THEN ${column} ELSE jsonb_strip_nulls(jsonb_build_object(${controls})) END`;
}
export function activityColumns(scope:StreamScope){
 return `id,${scope==='task'?'node_id,main_seg':'NULL::bigint AS node_id,NULL::int AS main_seg'},
 left(worker,256) worker,left(kind,64) kind,left(tool,256) tool,left(tool_use_id,256) tool_use_id,is_error,
 left(summary,4000) summary,char_length(summary)>4000 summary_truncated,
 left(detail,${ACTIVITY_PREVIEW_CHARS}) detail,char_length(COALESCE(detail,'')) detail_total_chars,
 char_length(COALESCE(detail,''))>${ACTIVITY_PREVIEW_CHARS} detail_truncated,xmin::text detail_version,
 ${activityMetadataSQL()} metadata,octet_length(metadata::text)>8192 metadata_truncated,
 created_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens`;
}

/** A contiguous page in the requested order. A large row cannot bypass the byte
 * bound: its fields have already been projected. No cursor is advanced past an
 * omitted row. Callers must use hasMore, not rows.length === requested limit. */
export async function readActivityPage(db:Database,scope:StreamScope,where:string,params:unknown[],order:'ASC'|'DESC',limit:number){
 const table=scope==='task'?'activity':'conversation_activities';
 limit=Math.min(1000,Math.max(1,Math.floor(limit)||200));
 const values=[...params,limit+1];
 const result=await db.query(`WITH page AS MATERIALIZED (
  SELECT ${activityColumns(scope)} FROM ${table} WHERE ${where} ORDER BY id ${order} LIMIT $${values.length}
 ), sized AS (SELECT page.*,sum(octet_length(row_to_json(page)::text)+128) OVER(ORDER BY id ${order}) page_bytes,
  row_number() OVER(ORDER BY id ${order}) page_index,count(*) OVER() page_total FROM page)
 SELECT * FROM sized WHERE page_index<=${limit} AND page_bytes<=${ACTIVITY_PAGE_BYTES} ORDER BY id ${order}`,values);
 const total=Number(result.rows[0]?.page_total??0);
 return {rows:result.rows.map(({page_bytes,page_index,page_total,...row})=>row),hasMore:total>result.rows.length};
}

export function contentQuery(query:Record<string,unknown>){
 if(query.offset===undefined&&query.limit===undefined&&query.page===undefined&&query.field===undefined&&query.version===undefined)return undefined;
 const integer=(key:string,fallback:number)=>{
  if(query[key]===undefined)return fallback;
  if(typeof query[key]!=='string'||!/^\d+$/.test(query[key] as string))throw fail(`${key} 必须是非负整数`);
  const n=Number(query[key]);if(!Number.isSafeInteger(n)||n>2147483646)throw fail(`${key} 超出范围`);return n;
 };
 const offset=integer('offset',0),limit=integer('limit',ACTIVITY_PREVIEW_CHARS);
 if(limit<1||limit>ACTIVITY_PREVIEW_CHARS)throw fail(`limit 必须为 1–${ACTIVITY_PREVIEW_CHARS}`);
 const field=query.field??'detail';if(!['detail','summary','metadata'].includes(String(field)))throw fail('无效活动字段');
 const version=query.version;if(version!==undefined&&(typeof version!=='string'||!/^\d{1,20}$/.test(version)))throw fail('无效原文版本');
 return {offset,limit,field:field as 'detail'|'summary'|'metadata',version:version as string|undefined};
}

export async function readActivityContent(db:Database,scope:StreamScope,where:string,params:unknown[],query:Record<string,unknown>){
 const page=contentQuery(query),table=scope==='task'?'activity':'conversation_activities';
 // Explicit compatibility entry point. First-party views use bounded pages.
 if(!page){const r=await db.query(`SELECT detail FROM ${table} WHERE ${where}`,params);if(!r.rowCount)throw fail('活动不存在或未获授权',404);return {detail:String(r.rows[0]!.detail??'')};}
 const field=page.field==='metadata'?'metadata::text':page.field;
 const values=[...params,page.offset+1,page.limit];
 const r=await db.query(`SELECT substring(COALESCE(${field},'') FROM $${values.length-1}::int FOR $${values.length}::int) detail,
  char_length(COALESCE(${field},'')) total_chars,xmin::text version FROM ${table} WHERE ${where}`,values);
 if(!r.rowCount)throw fail('活动不存在或未获授权',404);
 const row=r.rows[0]!;if(page.version!==undefined&&page.version!==row.version)throw fail('原文版本已变化，请从第一页重新读取',409);
 const total=Number(row.total_chars),next=Math.min(total,page.offset+page.limit);
 if(page.offset>total)throw fail('读取位置超出原文范围');
 return {detail:String(row.detail),field:page.field,offset:page.offset,next_offset:next,total_chars:total,has_more:next<total,version:String(row.version),offset_unit:'unicode_codepoints'};
}

/** New snapshots page indexed immutable chunks with a cheap append version.
 * Legacy full bodies retain their original digest-based compatibility path. */
export async function readSnapshotContent(db:Database,scope:StreamScope,id:number,stream:string,query:Record<string,unknown>){
 const channel=query.channel??'text';if(!['text','thinking'].includes(String(channel)))throw fail('无效输出通道');
 const page=contentQuery({...query,page:'1',version:undefined})!;
 if(page.field!=='detail')throw fail('流式快照只提供正文');
 const r=await db.query(`WITH snapshot AS MATERIALIZED (SELECT * FROM agent_stream_snapshots
  WHERE scope=$1 AND scope_id=$2 AND stream_id=$3 AND channel=$4
  ${scope==='task'?"AND exploration_activity_readable(scope_id,node_id,jsonb_build_object('turn_id',turn_id))":''})
  SELECT CASE WHEN s.storage_version=1 THEN COALESCE((SELECT string_agg(
    substring(c.body FROM greatest(0,($5::bigint-1)-c.start_char)::int+1
      FOR (least(c.end_char,($5::bigint-1)+$6::int)-greatest(c.start_char,$5::bigint-1))::int) ,'' ORDER BY c.chunk_no)
   FROM agent_stream_chunks c WHERE c.scope=s.scope AND c.scope_id=s.scope_id AND c.stream_id=s.stream_id AND c.channel=s.channel
    AND c.start_char>=COALESCE((SELECT start_char FROM agent_stream_chunks a WHERE a.scope=s.scope AND a.scope_id=s.scope_id
      AND a.stream_id=s.stream_id AND a.channel=s.channel AND a.start_char<=$5::bigint-1 ORDER BY a.start_char DESC LIMIT 1),0)
    AND c.start_char<($5::bigint-1)+$6::int AND c.end_char>$5::bigint-1),'')
   ELSE substring(s.body FROM $5::int FOR $6::int) END detail,
   CASE WHEN s.storage_version=1 THEN s.total_chars ELSE char_length(s.body) END total_chars,
   CASE WHEN s.storage_version=1 THEN 'chunks:'||s.next_chunk::text ELSE md5(s.body) END version FROM snapshot s`,
 [scope,id,stream,channel,page.offset+1,page.limit]);
 if(!r.rowCount)throw fail('输出已结束或不可读取，请查看已保存的消息',404);
 const row=r.rows[0]!;if(query.version!==undefined&&query.version!==row.version)throw fail('输出已更新，请从第一页重新读取',409);
 const total=Number(row.total_chars),next=Math.min(total,page.offset+page.limit);if(page.offset>total)throw fail('读取位置超出原文范围');
 return {detail:String(row.detail),field:'detail',offset:page.offset,next_offset:next,total_chars:total,has_more:next<total,version:String(row.version),offset_unit:'unicode_codepoints'};
}
