import type {Database} from '../db/index.js';
import {activityDTO,type StreamScope} from './live-stream.js';

type Row = Record<string,any>;
const iso=(value:unknown)=>value?new Date(value as string).toISOString():null;
const tokenTotal=(u:Row)=>['input','output','cacheRead','cacheWrite'].reduce((n,k)=>n+(Number(u?.[k])||0),0);

/** Read model, never execution authority. All counts come from full durable turns,
 * not the current UI page. Native message IDs and call IDs are idempotency keys. */
export function projectTurn(rows:Row[],attempts:Row[],runtime?:Row) {
 const start=rows.find(r=>r.metadata?.event_type==='turn_start');
 const terminal=rows.findLast(r=>['lifecycle','outcome'].includes(r.metadata?.event_type));
 const first=rows[0]!,last=rows.at(-1)!;
 const responseRows=[...new Map(rows.filter(r=>r.metadata?.response&&r.metadata.stream_id).map(r=>[r.metadata.stream_id,r])).values()];
 const tools=new Set(rows.filter(r=>r.kind==='tool_use'&&r.tool_use_id).map(r=>r.tool_use_id));
 const errors=new Set(rows.filter(r=>r.kind==='tool_result'&&r.is_error&&r.tool_use_id).map(r=>r.tool_use_id));
 const response=responseRows.at(-1);
 const nativeEnd=rows.findLast(r=>r.metadata?.event_type==='runner_settled');
 const statusOverride=terminal?.metadata.event_type!=='outcome'&&nativeEnd?.metadata.stop_reason==='budget'&&['completed','stopped'].includes(terminal?.metadata.status)?'exhausted':undefined;
 const completed=terminal&&!statusOverride&&['completed','done'].includes(terminal.metadata.status);
 // A native stop without tool calls is only final after the HOST accepts completion.
 const explicit=rows.findLast(r=>r.metadata?.final_answer);
 const final=terminal?.metadata.event_type==='outcome'?terminal:completed&&explicit?explicit:completed&&response?.metadata.response.stop_reason==='stop'&&!response.metadata.response.has_tools&&response.kind!=='status'&&response.summary?response:undefined;
 const expired=runtime&&(runtime.stop_reason==='executor_expired'||!runtime.finished_at&&new Date(runtime.expires_at).getTime()<=Date.now()||runtime.finished_at&&Date.now()-new Date(runtime.finished_at).getTime()>12000);
 const status=statusOverride??terminal?.metadata.status??(expired?'interrupted':runtime?.finished_at?'awaiting_confirmation':start?'running':'unknown');
 const models=attempts.length?attempts.map(a=>a.model):responseRows.map(r=>r.metadata.response).filter(r=>r.provider!=='series-router').map(r=>r.model);
 const modelSequence=models.filter((m,i)=>m&&m!==models[i-1]);
 const nativeUsage=responseRows.map(r=>r.metadata.response.usage).filter(Boolean);
 const usageRows=attempts.length?attempts.map(a=>a.usage??{}):nativeUsage;
 const usageKnown=usageRows.length>0&&usageRows.some(u=>Object.keys(u).some(k=>['input','output','cacheRead','cacheWrite'].includes(k)));
 const sum=(kind:string)=>usageRows.reduce((n,u)=>n+(Number(u[kind])||0),0);
 const auditKnown=attempts.length>0;
 const startedAt=iso(start?.metadata.started_at);
 const requested=rows.find(r=>r.kind==='user');
 return {version:1,turn_id:String(first.metadata.turn_id),revision:Number(last.id),updated_at:new Date(Math.max(new Date(last.created_at).getTime(),...attempts.map(a=>new Date(a.finished_at??0).getTime()),new Date(runtime?.finished_at??0).getTime(),expired?new Date(runtime?.expires_at??0).getTime():0)).toISOString(),
  worker:first.worker,role:start?.metadata.role??runtime?.role??null,intent_id:first.node_id==null?null:String(first.node_id),main_seg:first.main_seg??null,
  status,started_at:startedAt,finished_at:iso(terminal?.created_at??(expired?runtime?.finished_at??runtime?.expires_at:null)),
  queue_ms:startedAt&&requested?Math.max(0,Date.parse(startedAt)-new Date(requested.created_at).getTime()):null,
  mode:start?.metadata.mode??null,steps:start?responseRows.length:null,tool_calls:start?tools.size:null,failed_tool_calls:start?errors.size:null,
  models:modelSequence,usage:usageKnown?{input:sum('input'),output:sum('output'),cache_read:sum('cacheRead'),cache_write:sum('cacheWrite'),
   total:usageRows.reduce((n,u)=>n+tokenTotal(u),0),incomplete:attempts.some(a=>a.status==='running'||a.usage?.unavailable||!Object.keys(a.usage??{}).length||['failed','aborted'].includes(a.status)&&tokenTotal(a.usage)===0),
   source:auditKnown?'provider_audit':'native_response',compaction_requests:auditKnown?attempts.filter(a=>a.purpose==='compaction').length:null,
   compaction_tokens:auditKnown?attempts.filter(a=>a.purpose==='compaction').reduce((n,a)=>n+tokenTotal(a.usage),0):null,
   failed_requests:auditKnown?attempts.filter(a=>['failed','aborted'].includes(a.status)).length:null,
   failed_request_tokens:auditKnown?attempts.filter(a=>['failed','aborted'].includes(a.status)).reduce((n,a)=>n+tokenTotal(a.usage),0):null}:null,
  final_activity:final?activityDTO(final):null,
  writebacks:first.node_id&&(start?.metadata.role==='worker'||String(first.worker).startsWith('work#'))
    ?{version:1,intent_id:String(first.node_id),available:!!terminal||status==='interrupted'}:undefined,
  error:terminal&&(terminal.is_error||['failed','blocked','exhausted','stopped','paused'].includes(status))?statusOverride?'模型请求预算耗尽；本轮未自然完成':String(terminal.summary??''):null};
}

export async function readTurnSummaries(db:Database,scope:StreamScope,id:number,ids:string[]) {
 if(!ids.length)return [];
 const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
 const rows:Row[]=(await db.query(`SELECT id,worker,kind,tool_use_id,is_error,left(summary,4000) AS summary,metadata,created_at,
  ${scope==='task'?'node_id,main_seg':'NULL::bigint AS node_id,NULL::int AS main_seg'} FROM ${table}
  WHERE ${column}=$1 AND metadata->>'turn_id'=ANY($2::text[])
  ${scope==='task'?'AND exploration_activity_readable($1,node_id,metadata)':''} ORDER BY id`,[id,ids])).rows;
 const runtimeIDs=rows.filter(r=>r.metadata?.event_type==='turn_start').map(r=>r.metadata.runtime_id).filter(Boolean);
 const runtimes=runtimeIDs.length?(await db.query("SELECT id,role,finished_at,expires_at,effective->>'stop_reason' AS stop_reason FROM runtime_role_configs WHERE id=ANY($1::text[])",[runtimeIDs])).rows:[];
 const attempts=runtimeIDs.length?(await db.query('SELECT runtime_id,model,purpose,status,usage,finished_at FROM llm_request_attempts WHERE runtime_id=ANY($1::text[]) ORDER BY id',[runtimeIDs])).rows:[];
 const groups=new Map<string,Row[]>();
 for(const row of rows){const key=String(row.metadata.turn_id);const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 return [...groups.values()].map(group=>{
  // A recovered conversation keeps its request/turn identity but gets a new
  // fenced runtime. Include every attempt, use only the latest runtime's liveness.
  const runtimeIDs=group.filter(r=>r.metadata?.event_type==='turn_start').map(r=>r.metadata.runtime_id);
  return projectTurn(group,attempts.filter(a=>runtimeIDs.includes(a.runtime_id)),runtimes.find(r=>r.id===runtimeIDs.at(-1)));
 });
}
