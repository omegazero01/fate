import type {Database} from '../db/index.js';

export type WritebackBucket = 'current' | 'previous';
type Counts = {asset:number;fact:number;finding:number;total:number};
type WritebackRow = {key:string;kind:string;record_id:string;node_id:string|null;finding_id:string|null;summary:string;state:string;source_turn_id:string|null};
type Scope = {taskID:number;expID:number;intentID:number;turnID:string;first:number;last:number;endedAt:string;complete:boolean};
const badRequest = () => Object.assign(new Error('写回分页参数无效'), {statusCode:400});

/** This is a read projection, never an execution receipt or evidence of completion. */
async function turnScope(db:Database, taskID:number, turnID:string):Promise<Scope> {
  const result = await db.query(`SELECT t.exploration_id,a.node_id,
    min(a.id) first,max(a.id) last,max(a.created_at)::text ended_at,
    bool_or(a.metadata->>'event_type'='turn_start') has_start
    FROM tasks t JOIN activity a ON a.exploration_id=t.exploration_id
    JOIN exploration_nodes n ON n.id=a.node_id AND n.exploration_id=t.exploration_id AND n.kind='intent'
    WHERE t.id=$1 AND t.deleted_at IS NULL AND a.metadata->>'turn_id'=$2
      AND (a.worker LIKE 'work#%' OR a.metadata->>'role'='worker')
      AND exploration_activity_readable(t.exploration_id,a.node_id,a.metadata)
    GROUP BY t.exploration_id,a.node_id`, [taskID,turnID]);
  if(result.rows.length!==1)throw Object.assign(new Error('Worker 执行记录不存在或不可读取'),{statusCode:404});
  const r=result.rows[0]!;
  return {taskID,expID:Number(r.exploration_id),intentID:Number(r.node_id),turnID,
    first:Number(r.first),last:Number(r.last),endedAt:String(r.ended_at),complete:r.has_start===true};
}

// Attribute a replayed call to its FIRST durable occurrence, not the recovery turn.
// A batch record_fact uses the native call ID plus :item:<index>.
const writesCTE = `WITH calls AS MATERIALIZED (
  SELECT DISTINCT ON (tool_use_id) tool_use_id,metadata->>'turn_id' turn_id,id,created_at
  FROM activity WHERE exploration_id=$1 AND node_id=$2 AND kind='tool_use'
    AND tool_use_id<>'' AND id<=$3 ORDER BY tool_use_id,id
), writes AS MATERIALIZED (
  SELECT 'asset' kind,w.asset_id::text record_id,NULL::text node_id,NULL::text finding_id,
    concat_ws(' ',NULLIF(a.method,''),NULLIF(a.url,''),CASE WHEN COALESCE(a.url,'')='' THEN COALESCE(NULLIF(a.domain,''),NULLIF(a.ip,''),NULLIF(a.app_name,''),a.type) END) summary,
    'registered' state,NULL::text observation_type,NULL::text confidence,NULL::int version,
    c.turn_id source_turn_id,c.id call_seq,c.created_at recorded_at
  FROM asset_tool_writes w JOIN assets a ON a.id=w.asset_id
  JOIN task_asset_links l ON l.asset_id=a.id AND l.task_id=$4
  LEFT JOIN calls c ON c.tool_use_id=w.call_id
  WHERE split_part(w.execution,':',1)=$4::text AND split_part(w.execution,':',2)=$2::text
    AND (c.id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM activity later
      WHERE later.exploration_id=$1 AND later.node_id=$2 AND later.kind='tool_use'
        AND later.tool_use_id=w.call_id AND later.id>$3))
  UNION ALL
  SELECT n.kind,COALESCE(f.id,n.id)::text,n.id::text,f.id::text,n.payload->>'summary',n.state,
    n.payload->>'observation_type',n.payload->>'confidence',n.content_version,
    c.turn_id,c.id,n.created_at
  FROM exploration_nodes n
  LEFT JOIN findings f ON f.node_id=n.id AND f.task_id=$4
  LEFT JOIN LATERAL (SELECT * FROM calls c WHERE COALESCE(f.tool_call_id,n.tool_call_id)=c.tool_use_id
    OR (n.kind='fact' AND n.tool_call_id ~ ':item:[0-9]+$'
      AND regexp_replace(n.tool_call_id,':item:[0-9]+$','')=c.tool_use_id)
    ORDER BY c.id LIMIT 1) c ON true
  WHERE n.exploration_id=$1 AND n.kind IN ('fact','finding')
    AND n.payload->>'from_intent'=$2::text AND n.created_at<=$5
    AND EXISTS(SELECT 1 FROM exploration_edges e WHERE e.exploration_id=$1 AND e.src_id=$2 AND e.dst_id=n.id AND e.rel='yields')
    AND exploration_node_readable($1,n.id)
), classified AS MATERIALIZED (
  SELECT *,CASE WHEN source_turn_id=$6 THEN 'current'
    WHEN source_turn_id IS NOT NULL AND call_seq<$7 THEN 'previous' ELSE 'unknown' END bucket,
    kind||':'||record_id key
  FROM writes
), unique_writes AS MATERIALIZED (
  SELECT DISTINCT ON (bucket,key) * FROM classified ORDER BY bucket,key,call_seq
), totals AS (
  SELECT bucket,jsonb_build_object('asset',count(*) FILTER(WHERE kind='asset'),
    'fact',count(*) FILTER(WHERE kind='fact'),'finding',count(*) FILTER(WHERE kind='finding'),
    'total',count(*)) counts FROM unique_writes GROUP BY bucket
)`;

export async function readWorkerWritebacks(db:Database,taskID:number,turnID:string,
  options:{bucket?:string;cursor?:string;limit?:number}={}) {
  const bucket=options.bucket??'current',limit=options.limit??20;
  if(!['current','previous'].includes(bucket)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw badRequest();
  const scope=await turnScope(db,taskID,turnID);
  let after='';
  if(options.cursor){
    try{
      if(options.cursor.length>1500)throw badRequest();
      const cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'));
      if(cursor.task!==taskID||cursor.turn!==turnID||cursor.bucket!==bucket||cursor.revision!==scope.last
        ||typeof cursor.after!=='string'||!/^(asset|fact|finding):\d+$/.test(cursor.after))throw badRequest();
      after=cursor.after;
    }catch{throw badRequest();}
  }
  const r=(await db.query<{totals:Partial<Record<string,Counts>>;items:WritebackRow[];legacy_assets:boolean}>(`${writesCTE}, page AS (
    SELECT key,kind,record_id,node_id,finding_id,left(summary,600) summary,length(summary)>600 summary_truncated,
      state,observation_type,confidence,version,source_turn_id,recorded_at
    FROM unique_writes WHERE bucket=$8 AND key>$9 ORDER BY key LIMIT $10
  ) SELECT COALESCE((SELECT jsonb_object_agg(bucket,counts) FROM totals),'{}') totals,
    COALESCE((SELECT jsonb_agg(page ORDER BY key) FROM page),'[]') items,
    EXISTS(SELECT 1 FROM task_asset_links l WHERE l.task_id=$4 AND l.source_node_id=$2 AND l.created_at<=$5
      AND NOT EXISTS(SELECT 1 FROM writes w WHERE w.kind='asset' AND w.record_id=l.asset_id::text)) legacy_assets`,
    [scope.expID,scope.intentID,scope.last,taskID,scope.endedAt,turnID,scope.first,bucket,after,limit+1])).rows[0]!;
  const zero={asset:0,fact:0,finding:0,total:0};
  const complete=scope.complete&&!r.legacy_assets&&!((r.totals.unknown?.total??0)>0);
  const hasMore=r.items.length>limit,items=r.items.slice(0,limit).map((item:WritebackRow)=>({...item,
    detail_ref:item.kind==='asset'?`asset:${item.record_id}`:item.kind==='finding'&&item.finding_id?`finding:${item.record_id}`:`node:${item.node_id}`,
  }));
  return {version:1,task_id:String(taskID),intent_id:String(scope.intentID),turn_id:turnID,revision:scope.last,bucket,
    complete,notice:complete?null:'部分历史记录缺少可核对的写入来源，仅列出已核对记录；请同时查看原始总结。',
    counts:{current:r.totals.current??zero,previous:r.totals.previous??zero},
    items,next_cursor:hasMore?Buffer.from(JSON.stringify({task:taskID,turn:turnID,bucket,revision:scope.last,after:items.at(-1)!.key})).toString('base64url'):null};
}
