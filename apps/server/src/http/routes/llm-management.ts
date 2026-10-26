import type {FastifyInstance} from 'fastify';

type RetryRule={attempts:number;interval_ms:number};
type RetryPolicy={connect:RetryRule;empty:RetryRule;stream:RetryRule;breaker:RetryRule;intent:RetryRule};
const rule=():RetryRule=>({attempts:0,interval_ms:0});
const emptyPolicy=():RetryPolicy=>({connect:rule(),empty:rule(),stream:rule(),breaker:rule(),intent:rule()});
function normalizeRule(value:unknown){
 const raw=(value&&typeof value==='object'?value:{}) as Record<string,unknown>;
 const attempts=Number(raw.attempts),interval=Number(raw.interval_ms);
 return {attempts:Number.isFinite(attempts)?Math.max(-1,Math.min(20,Math.trunc(attempts))):0,
   interval_ms:Number.isFinite(interval)?Math.max(0,Math.min(3_600_000,Math.trunc(interval))):0};
}
function normalizePolicy(value:unknown):RetryPolicy{
 const raw=(value&&typeof value==='object'?value:{}) as Record<string,unknown>;
 return {connect:normalizeRule(raw.connect),empty:normalizeRule(raw.empty),stream:normalizeRule(raw.stream),breaker:normalizeRule(raw.breaker),intent:normalizeRule(raw.intent)};
}
function record(row:Record<string,unknown>){
 const usage=(row.usage&&typeof row.usage==='object'?row.usage:{}) as Record<string,unknown>;
 return {id:Number(row.id),ts:row.created_at,model:String(row.model??''),profile_name:String(row.profile_name??''),
  purpose:String(row.purpose??'conversation'),session_id:String(row.conversation_id??''),task_id:row.task_id==null?'':String(row.task_id),worker:String(row.role??''),
  latency_ms:Math.max(0,Number(row.latency_ms)||0),version:'usage-v2',input_semantics:'inclusive_cache',usage_complete:['complete','not_sent'].includes(String(row.quality)),quality:row.quality,
  uncached_input_tokens:Number(usage.input??usage.inputTokens??0),input_tokens:Number(usage.inputTotal??(Number(usage.input??0)+Number(usage.cacheRead??0)+Number(usage.cacheWrite??0))),
  output_tokens:Number(usage.output??usage.outputTokens??0),cache_read:Number(usage.cacheRead??usage.cache_read??0),
  cache_write:Number(usage.cacheWrite??usage.cache_write??0),status:String(row.status??''),error:String(row.error??'')};
}
const RECORD_SELECT=`SELECT a.id,a.purpose,a.created_at,a.task_id,a.conversation_id,a.role,a.model,a.status,a.error,a.usage,
  l.profile_name,l.quality,EXTRACT(EPOCH FROM (COALESCE(a.finished_at,now())-a.created_at))*1000 AS latency_ms
 FROM llm_request_attempts a LEFT JOIN llm_usage_ledger l ON l.audit_id=a.id`;

export function registerLLMManagementRoutes(app:FastifyInstance){
 const db=app.db;
 const poolStatus=async()=>{
  const enabled=await db.platform().getBool('llm_pool_enabled',false),bindFallback=await db.platform().getBool('llm_pool_bind_fallback',false);
  const rows=await db.query(`SELECT p.id,p.name,p.model,p.format,p.priority,p.is_default,p.pool_exclude,
    h.fails,h.trips,h.open_until,h.last_error,h.last_at
   FROM llm_profiles p LEFT JOIN llm_profile_health h ON h.profile_id=p.id ORDER BY p.is_default DESC,p.priority DESC,p.id`);
  const now=Date.now();
  return {enabled,bind_fallback:bindFallback,chain:rows.rows.map(r=>{
   const remaining=r.open_until?Math.max(0,Math.ceil((new Date(String(r.open_until)).getTime()-now)/1000)):0;
   const fails=Number(r.fails??0);
   return {profile_id:String(r.id),name:r.name,model:r.model,format:r.format,priority:Number(r.priority),active:r.is_default===true,
    excluded:r.pool_exclude===true,state:remaining?'tripped':fails?'degraded':'ok',fails,trips:Number(r.trips??0),cooldown_secs:remaining,
    ...(r.last_error?{last_error:r.last_error}:{}),...(r.last_at?{last_at:r.last_at}:{})};
  })};
 };
 app.get('/api/llm/records',async req=>{
  const q=req.query as Record<string,string|undefined>,page=Math.max(0,Math.trunc(Number(q.page)||0)),size=Math.min(200,Math.max(1,Math.trunc(Number(q.size)||50)));
  const where:string[]=[],args:unknown[]=[];
  for(const [key,sql] of [['model','a.model'],['session','a.conversation_id::text'],['task','a.task_id::text']] as const){
   if(q[key]){args.push(q[key]);where.push(`${sql}=$${args.length}`);}
  }
  const filter=where.length?` WHERE ${where.join(' AND ')}`:'';
  const count=await db.query(`SELECT count(*)::bigint AS total FROM llm_request_attempts a${filter}`,args);
  const rows=await db.query(`${RECORD_SELECT}${filter} ORDER BY a.id DESC LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,size,page*size]);
  return {records:rows.rows.map(record),total:Number(count.rows[0]?.total??0)};
 });
 app.get('/api/llm/records/tasks',async()=>({tasks:(await db.query(`SELECT task_id::text AS task_id,count(*)::int AS count
  FROM llm_request_attempts WHERE task_id IS NOT NULL GROUP BY task_id ORDER BY max(id) DESC`)).rows}));
 app.delete('/api/llm/records',async(req,reply)=>{
  const task=String((req.query as {task?:string}).task??'').trim();
  if(!task||!/^\d+$/.test(task))return reply.code(400).send({error:'task must be a numeric task id'});
  return {deleted:(await db.query('DELETE FROM llm_request_attempts WHERE task_id=$1',[task])).rowCount??0,metering_retained:true};
 });
 app.get('/api/llm/records/:id',async(req,reply)=>{
  const id=Number((req.params as {id:string}).id);
  if(!Number.isSafeInteger(id)||id<1)return reply.code(400).send({error:'invalid id'});
  const row=(await db.query(`${RECORD_SELECT} WHERE a.id=$1`,[id])).rows[0];
  if(!row)return reply.code(404).send({error:'not found'});
  const item=record(row);
  // pi currently exposes normalized messages and usage, not raw HTTP frames. Keep the
  // legacy detail contract explicit without claiming provider-wire capture.
  return {...item,request_body:'',response_body:JSON.stringify({status:item.status,error:item.error,usage:row.usage??{}}),raw_request:'',raw_response:''};
 });
 app.get('/api/llm/pool',async()=>poolStatus());
 app.post('/api/llm/pool/reset',async req=>{
  const id=Number((req.body as {id?:unknown}|null)?.id??0);
  if(!Number.isSafeInteger(id)||id<0)throw Object.assign(new Error('id must be a non-negative integer'),{statusCode:400});
  if(id)await db.query('DELETE FROM llm_profile_health WHERE profile_id=$1',[id]);
  else await db.query('DELETE FROM llm_profile_health');
  return poolStatus();
 });
 app.get('/api/llm/retry-policy',async()=>{
  const raw=await db.platform().getSetting('llm_retry_policy');
  try{return normalizePolicy(raw?JSON.parse(raw):{});}catch{return emptyPolicy();}
 });
 app.post('/api/llm/retry-policy',async req=>{
  const policy=normalizePolicy(req.body);
  await db.platform().setSetting('llm_retry_policy',JSON.stringify(policy));
  return policy;
 });
}
