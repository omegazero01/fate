import type {Database} from './index.js';

export type UsageScope={taskIDs?:number[];taskID?:number;conversationID?:number;intentID?:number;mainSegment?:number;runtimeID?:string;turnID?:string};
export const USAGE_VERSION='usage-v2';

/** One-way import. No business record is rewritten; reruns and deleted logs cannot remove receipts. */
export async function backfillUsageLedger(db:Database){
 await db.query(`INSERT INTO llm_usage_ledger(request_id,audit_id,task_id,conversation_id,intent_id,main_seg,runtime_id,turn_id,scope_key,worker_name,role,purpose,profile_id,model,status,usage,quality,source,created_at,finished_at)
 SELECT COALESCE(a.request_id,'audit:'||a.id),a.id,a.task_id,a.conversation_id,(s.metadata->>'node_id')::bigint,s.main_seg,a.runtime_id,s.metadata->>'turn_id',COALESCE(a.runtime_id,s.metadata->>'turn_id','audit:'||a.id),s.worker,a.role,a.purpose,a.profile_id,a.model,a.status,a.usage,
 CASE WHEN a.status='running' OR COALESCE((a.usage->>'unavailable')::boolean,false) THEN 'unknown'
 WHEN a.usage ?& ARRAY['input','output','cacheRead','cacheWrite'] AND COALESCE((a.usage->>'totalTokens')::numeric,0)>0 THEN 'complete'
 WHEN a.usage ?| ARRAY['input','output','cacheRead','cacheWrite'] THEN 'partial' ELSE 'unknown' END,'request_audit',a.created_at,a.finished_at
 FROM llm_request_attempts a LEFT JOIN LATERAL (
  SELECT x.metadata||jsonb_build_object('node_id',x.node_id) metadata,x.main_seg,x.worker FROM activity x
   WHERE x.metadata->>'runtime_id'=a.runtime_id AND x.metadata->>'event_type'='turn_start' LIMIT 1
 ) s ON true ON CONFLICT(request_id) DO NOTHING`);
 for(const conversation of [false,true]){
  const table=conversation?'conversation_activities':'activity';
  await db.query(`INSERT INTO llm_usage_ledger(request_id,task_id,conversation_id,intent_id,main_seg,runtime_id,turn_id,scope_key,worker_name,role,model,status,usage,quality,input_semantics,source,created_at,finished_at)
   SELECT CASE WHEN a.kind='result' THEN 'legacy:' ELSE 'native:' END||'${conversation?'conversation':'task'}:'||${conversation?'a.conversation_id':'COALESCE(t.id,a.exploration_id)'}||':'||CASE WHEN a.kind='result' THEN a.id::text ELSE a.metadata->>'stream_id' END,
    t.id,${conversation?'a.conversation_id':'NULL::bigint'},${conversation?'NULL::bigint':'a.node_id'},${conversation?'NULL::int':'a.main_seg'},s.metadata->>'runtime_id',a.metadata->>'turn_id',COALESCE(s.metadata->>'runtime_id',a.metadata->>'turn_id','legacy:${table}:'||a.id),a.worker,
    COALESCE(s.metadata->>'role',CASE WHEN a.worker='main' THEN 'mainagent' WHEN a.worker LIKE 'work#%' THEN 'worker' ELSE a.worker END,'unknown'),
    COALESCE(a.metadata->'response'->>'model','未记录模型'),'completed',
    CASE WHEN a.kind='result' THEN jsonb_build_object('input',a.input_tokens,'output',COALESCE(a.output_tokens,0),'cacheRead',COALESCE(a.cache_read_tokens,0),'cacheWrite',COALESCE(a.cache_write_tokens,0)) ELSE a.metadata->'response'->'usage' END,
    CASE WHEN a.kind='result' AND s.metadata->>'runtime_id' IS NULL THEN 'legacy_unknown' ELSE 'complete' END,
    CASE WHEN a.kind='result' AND s.metadata->>'runtime_id' IS NULL THEN 'unknown' ELSE 'exclusive_cache' END,
    CASE WHEN a.kind='result' THEN 'legacy_results' ELSE 'native_response' END,a.created_at,a.created_at
   FROM ${table} a ${conversation?'JOIN conversations c ON c.id=a.conversation_id LEFT JOIN tasks t ON t.id=c.task_id':'LEFT JOIN tasks t ON t.exploration_id=a.exploration_id'}
   LEFT JOIN LATERAL (SELECT x.metadata FROM ${table} x WHERE x.${conversation?'conversation_id':'exploration_id'}=a.${conversation?'conversation_id':'exploration_id'}
    AND x.metadata->>'turn_id'=a.metadata->>'turn_id' AND x.metadata->>'event_type'='turn_start' AND x.created_at<=a.created_at ORDER BY x.id DESC LIMIT 1) s ON true
   WHERE a.kind='result' AND a.input_tokens IS NOT NULL OR (a.metadata ? 'response' AND a.metadata ? 'stream_id' AND COALESCE((a.metadata->'response'->'usage'->>'totalTokens')::numeric,0)>0)
   ON CONFLICT(request_id) DO NOTHING`);
 }
}

/** Priority is per execution, never per task. Ambiguous overlaps remain explicitly visible. */
export const CANONICAL_USAGE_CTE=`ledger AS MATERIALIZED (
 SELECT *,COALESCE('conversation:'||conversation_id,'task:'||task_id,'platform') domain_key FROM llm_usage_ledger /* usage_scope */
), physical AS MATERIALIZED (
 SELECT * FROM ledger WHERE source IN ('provider','request_audit')
), scope_counts AS MATERIALIZED (
 SELECT domain_key,scope_key,count(*) FILTER(WHERE source IN ('provider','request_audit')) physicals,
  count(*) FILTER(WHERE source='native_response') natives,count(*) FILTER(WHERE source='legacy_results') legacies
 FROM ledger GROUP BY domain_key,scope_key
), legacy_intervals AS MATERIALIZED (
 SELECT *,COALESCE(lag(created_at) OVER(PARTITION BY domain_key,role,main_seg ORDER BY created_at,request_id),'-infinity'::timestamptz) previous_end
 FROM ledger WHERE source='legacy_results'
), legacy_coverage AS MATERIALIZED (
 SELECT l.request_id,bool_or(p.request_id IS NOT NULL) covered
 FROM legacy_intervals l LEFT JOIN physical p ON p.domain_key=l.domain_key AND (
  p.scope_key=l.scope_key OR (l.runtime_id IS NULL AND l.turn_id IS NULL AND p.role=l.role
    AND p.created_at<=l.created_at AND p.created_at>l.previous_end)) GROUP BY l.request_id
), ambiguous_scopes AS MATERIALIZED (
 SELECT DISTINCT p.domain_key,p.scope_key FROM physical p JOIN legacy_intervals l ON p.domain_key=l.domain_key AND p.role=l.role
  AND l.runtime_id IS NULL AND l.turn_id IS NULL AND p.created_at<=l.created_at AND p.created_at>l.previous_end
), canonical AS (
 SELECT l.*, (s.natives>s.physicals OR a.scope_key IS NOT NULL) history_gap FROM physical l
 JOIN scope_counts s USING(domain_key,scope_key) LEFT JOIN ambiguous_scopes a USING(domain_key,scope_key)
 UNION ALL
 SELECT l.*,false history_gap FROM ledger l JOIN legacy_coverage c USING(request_id) WHERE l.source='legacy_results' AND NOT c.covered
 UNION ALL
 SELECT l.*,false history_gap FROM ledger l JOIN scope_counts s USING(domain_key,scope_key)
 WHERE l.source='native_response' AND s.physicals=0 AND s.legacies=0
), measured AS (
 SELECT *,GREATEST(0,COALESCE((usage->>'input')::bigint,0)) i,GREATEST(0,COALESCE((usage->>'output')::bigint,0)) o,
  GREATEST(0,COALESCE((usage->>'cacheRead')::bigint,0)) cr,GREATEST(0,COALESCE((usage->>'cacheWrite')::bigint,0)) cw FROM canonical
)`;

export const USAGE_SUM_SQL=`count(DISTINCT task_id) tasks,count(*) FILTER(WHERE source<>'legacy_results') calls,
 COALESCE(sum(CASE WHEN usage->>'_input_total_known'='true' THEN (usage->>'inputTotal')::bigint ELSE i+CASE WHEN input_semantics='exclusive_cache' THEN cr+cw ELSE 0 END END),0) input_tokens,
 COALESCE(sum(i) FILTER(WHERE input_semantics='exclusive_cache'),0) uncached_input_tokens,COALESCE(sum(o),0) output_tokens,
 COALESCE(sum(cr),0) cache_read_tokens,COALESCE(sum(cw),0) cache_write_tokens,
 count(*) FILTER(WHERE source<>'legacy_results' AND quality NOT IN ('complete','not_sent')) unknown_usage_calls,
 count(*) FILTER(WHERE history_gap) history_gap_requests,
 count(*) FILTER(WHERE source NOT IN ('provider','request_audit')) time_unknown_records,
 count(*) FILTER(WHERE source='legacy_results') legacy_records,
 count(*) FILTER(WHERE status='running') pending_calls,
 count(*) FILTER(WHERE status IN ('failed','aborted')) failed_calls,
 count(*) FILTER(WHERE purpose='compaction') compaction_calls,
 bool_and(quality IN ('complete','not_sent') AND NOT history_gap) usage_complete,
 bool_and(source<>'legacy_results') calls_complete,
 bool_and(input_semantics='exclusive_cache' AND (quality IN ('complete','not_sent') OR COALESCE(usage->>'_input_total_known'='true' AND usage->>'_cache_read_known'='true',false)) AND NOT history_gap) input_complete`;

export function usageDTO(row:Record<string,unknown>={}){
 const keys=['calls','input_tokens','uncached_input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','unknown_usage_calls','legacy_records','pending_calls','failed_calls','compaction_calls','history_gap_requests','tasks','time_unknown_records'] as const;
 const counts=Object.fromEntries(keys.map(k=>[k,Number(row[k]??0)])) as Record<typeof keys[number],number>;
 return {...counts,version:USAGE_VERSION,input_semantics:row.input_complete===false?'unknown':'inclusive_cache',
   usage_complete:row.usage_complete!==false,calls_complete:row.calls_complete!==false,input_complete:row.input_complete!==false,source:'usage_ledger'};
}

export async function aggregateUsage(db:Database,scope:UsageScope&{days?:number;since?:string;until?:string;timeKnown?:boolean}={},group?:'model'|'profile'|'day'|'profile_day'|'worker'|'session'|'conversation'|'role'|'task'|'turn'):Promise<Array<Record<string,any>&ReturnType<typeof usageDTO>>>{
 const params:unknown[]=[];const where:string[]=[];
 for(const [key,col] of [['taskID','task_id'],['conversationID','conversation_id'],['runtimeID','runtime_id'],['turnID','turn_id'],['intentID','intent_id'],['mainSegment','main_seg']] as const)
  if(scope[key]!==undefined){params.push(scope[key]);where.push(`${col}=$${params.length}`);}
 if(scope.taskIDs!==undefined){params.push(scope.taskIDs);where.push(`task_id=ANY($${params.length}::bigint[])`);}
 const identityWhere=where.join(' AND ');
 if(scope.days!==undefined){params.push(scope.days);where.push(`created_at>=((now() AT TIME ZONE 'Asia/Shanghai')::date-($${params.length}::int-1)) AT TIME ZONE 'Asia/Shanghai'`);}
 for(const [key,operator] of [['since','>='],['until','<']] as const)if(scope[key]){params.push(scope[key]);where.push(`created_at${operator}$${params.length}::timestamptz`);}
 if(scope.timeKnown!==undefined)where.push(scope.timeKnown?"source IN ('provider','request_audit')":"source NOT IN ('provider','request_audit')");
 if(group==='day'||group==='profile_day')where.push("source IN ('provider','request_audit')");
 const expression={model:'model',profile:"COALESCE(profile_id::text,'unknown')",day:"to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')",
  profile_day:"COALESCE(profile_id::text,'unknown')||':'||to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')",
  worker:"CASE WHEN role='worker' THEN COALESCE(worker_name,'intent:'||intent_id,'worker') ELSE role END",
  session:"CASE WHEN conversation_id IS NOT NULL THEN 'conversation:'||conversation_id WHEN intent_id IS NOT NULL THEN 'intent:'||intent_id WHEN role='mainagent' THEN 'main:'||COALESCE(main_seg,0) WHEN role IN ('planner','goals') THEN 'plan' ELSE role END",
  conversation:'conversation_id::text',role:'role',task:'task_id::text',turn:'turn_id'};
 if(group==='conversation')where.push('conversation_id IS NOT NULL');
 if(group==='task')where.push('task_id IS NOT NULL');
 const rows=(await db.query(`WITH ${CANONICAL_USAGE_CTE.replace('/* usage_scope */',identityWhere?'WHERE '+identityWhere:'')} SELECT ${group?`${expression[group]} bucket, CASE WHEN count(DISTINCT model)=1 THEN max(model) END model,array_agg(DISTINCT model) models,CASE WHEN count(DISTINCT COALESCE(profile_id::text,'unknown'))=1 THEN max(profile_name) END profile_name,CASE WHEN count(DISTINCT COALESCE(profile_id::text,'unknown'))=1 THEN max(profile_id) END profile_id,array_agg(DISTINCT profile_id) profile_ids,CASE WHEN count(DISTINCT COALESCE(task_id::text,'unknown'))=1 THEN max(task_id) END task_id,CASE WHEN count(DISTINCT role)=1 THEN max(role) END role,min(to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')) date, min(created_at) created_at,`:''}${USAGE_SUM_SQL}
  FROM measured ${where.length?'WHERE '+where.join(' AND '):''} ${group?'GROUP BY 1 ORDER BY 1':''}`,params)).rows;
 return rows.map(r=>({...r,...usageDTO(r)}));
}

/** Uncertain old totals are disclosed separately, never added on top of requests. */
export async function unverifiedUsageHistory(db:Database,scope:UsageScope={}){
 const rows=(await db.query(`WITH ${CANONICAL_USAGE_CTE} SELECT l.request_id,l.task_id,l.conversation_id,l.role,l.source,l.usage,l.input_semantics,l.created_at
  FROM ledger l LEFT JOIN legacy_coverage c USING(request_id) JOIN scope_counts s USING(domain_key,scope_key)
  WHERE ($1::bigint IS NULL OR l.task_id=$1) AND ($2::bigint IS NULL OR l.conversation_id=$2)
   AND (l.source='legacy_results' AND c.covered AND l.runtime_id IS NULL AND l.turn_id IS NULL
      OR l.source='native_response' AND s.physicals>0 AND s.natives>s.physicals)
 ORDER BY l.created_at,l.request_id`,[scope.taskID??null,scope.conversationID??null])).rows;
 return rows.map(r=>({...r,reason:'历史覆盖或重叠范围未核定；未计入请求汇总',usage:undefined,input_tokens:Number((r.usage as any)?.input??0),output_tokens:Number((r.usage as any)?.output??0),cache_read_tokens:Number((r.usage as any)?.cacheRead??0)}));
}
