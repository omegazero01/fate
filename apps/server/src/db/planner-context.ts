import type {Database} from './index.js';
import {progressSummary,resultSummary,stopSummary} from '../agent/context-projection.js';

export async function pendingPlannerContext(db:Database,taskID:number,expID:number) {
  const fetched=(await db.query(`SELECT id,node_id,kind,subject_type,subject_id,subject_version,source_task_id,changed_fields
    FROM exploration_context_events WHERE exploration_id=$1 AND acknowledged_at IS NULL ORDER BY id LIMIT 201`,[expID])).rows;
  const events=fetched.slice(0,200);
  const ids=[...new Set(events.flatMap(e=>e.node_id===null?[]:[Number(e.node_id)]))];
  // The old path loaded full evidence/results for every pending node and again
  // for each source task. Project only bounded fields inside PostgreSQL.
  // One record extraction reuses the detoasted JSON. Independent -> lookups
  // repeatedly decompressed a giant evidence field even for tiny summaries.
  const nodes=ids.length?(await db.query(`SELECT n.id,n.kind,n.state,n.content_version,t.id source_task_id,
    left(COALESCE(p.summary,p.text,''),160) summary,
    length(COALESCE(p.summary,p.text,''))>160 summary_truncated,
    left(p.observation_type,40) observation_type,n.payload->'scope' IS NOT NULL has_scope,
    CASE WHEN jsonb_typeof(p.writeback)='object' THEN jsonb_strip_nulls(jsonb_build_object(
     'version',p.writeback->'version','asset_binding',left(p.writeback->>'asset_binding',40),
     'scope_status',left(p.writeback->>'scope_status',40),'coverage_eligible',p.writeback->'coverage_eligible',
     'gaps',(SELECT jsonb_agg(left(v #>> '{}',80)) FROM (SELECT value v FROM jsonb_array_elements(
       CASE WHEN jsonb_typeof(p.writeback->'gaps')='array' THEN p.writeback->'gaps' ELSE '[]'::jsonb END) LIMIT 8) g))) END writeback,
    CASE WHEN jsonb_typeof(p.progress)='object' THEN jsonb_strip_nulls(jsonb_build_object(
     'phase',left(p.progress->>'phase',40),'summary',left(p.progress->>'summary',200),
     'blocker',left(p.progress->>'blocker',160),'next_step',left(p.progress->>'next_step',160),
     'updated_at',left(p.progress->>'updated_at',64))) END progress,
    CASE WHEN jsonb_typeof(p.progress->'attempted')='array' THEN jsonb_array_length(p.progress->'attempted') ELSE 0 END attempted_count,
    CASE WHEN jsonb_typeof(p.execution_result)='object' THEN jsonb_strip_nulls(jsonb_build_object(
     'outcome',left(p.execution_result->>'outcome',40),'summary',left(p.execution_result->>'summary',240),
     'remaining',left(p.execution_result->>'remaining',160),
     'criteria',(SELECT jsonb_agg(jsonb_build_object('fact_ids',(SELECT jsonb_agg(v) FROM (
       SELECT value v FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c->'fact_ids')='array' THEN c->'fact_ids' ELSE '[]'::jsonb END) LIMIT 20) f)))
       FROM (SELECT value c FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.execution_result->'criteria')='array' THEN p.execution_result->'criteria' ELSE '[]'::jsonb END) LIMIT 10) cs))) END result,
    CASE WHEN jsonb_typeof(p.execution_stop)='object' THEN jsonb_strip_nulls(jsonb_build_object(
     'reason',left(p.execution_stop->>'reason',64),'summary',left(p.execution_stop->>'summary',240),
     'recovery',left(p.execution_stop->>'recovery',240),'accepted_result',p.execution_stop->'accepted_result',
     'recorded_at',left(p.execution_stop->>'recorded_at',64))) END execution_stop
    FROM exploration_nodes n
    CROSS JOIN LATERAL jsonb_to_record(CASE WHEN jsonb_typeof(n.payload)='object' THEN n.payload ELSE '{}'::jsonb END)
      p(summary text,text text,observation_type text,writeback jsonb,progress jsonb,execution_result jsonb,execution_stop jsonb)
    JOIN tasks t ON t.exploration_id=n.exploration_id
    JOIN tasks current ON current.id=$1 AND current.exploration_id=$2 AND current.deleted_at IS NULL
    WHERE n.id=ANY($3::bigint[]) AND t.deleted_at IS NULL
      AND (t.id=$1 OR t.id IN(SELECT source_task_id FROM task_relations WHERE task_id=$1))
      AND exploration_node_readable(n.exploration_id,n.id)`,[taskID,expID,ids])).rows:[];
  const byID=new Map(nodes.map(n=>[Number(n.id),n])),groups=new Map<string,{events:typeof events;change:Record<string,unknown>|null}>();
  for(const event of events){
    const n=byID.get(Number(event.node_id));
    const key=event.node_id!==null?`node:${event.node_id}`:event.subject_type?`${event.source_task_id}:${event.subject_type}:${event.subject_id}`:`legacy:${event.kind}`;
    const prior=groups.get(key);if(prior){prior.events.push(event);if(event.kind==='node_deleted'&&prior.change)prior.change.kind='node_deleted';continue;}
    let change:Record<string,unknown>|null=null;
    if(n){
      const progress=progressSummary(n.progress);if(progress)progress.attempted_count=Number(n.attempted_count);
      change={ref:`node:${n.id}`,source_task_id:Number(n.source_task_id),version:Number(n.content_version),kind:n.kind,state:n.state,
       summary:n.summary,...(n.summary_truncated?{summary_truncated:true}:{}),
       ...(['fact','finding'].includes(String(n.kind))?{observation_type:n.observation_type??'unknown',writeback:n.writeback??{scope_status:'legacy_unspecified'},
        ...(n.has_scope?{scope_read:{ref:`node:${n.id}`,field:'/payload/scope',version:Number(n.content_version)}}:{})}:{}),
       progress,result:resultSummary(n.result),execution_stop:stopSummary(n.execution_stop)};
    }else if(event.subject_type){
      const type=String(event.subject_type),id=Number(event.subject_id);
      change={ref:`${type}:${id}`,kind:event.kind,source_task_id:event.source_task_id===null?taskID:Number(event.source_task_id),requires_read:true,
        ...(type==='asset'?{read:{tool:'asset_get',ids:[id]},note:'资产或任务关联已变化，通知未读取资产详情。'}:
          type==='node'?{unavailable:true,note:'节点已删除或不在当前可读范围，历史引用不能作为当前依据。'}:
          type==='index'?{read:{tool:'context_search',types:['digest']},note:'冷图摘要索引已变化；摘要是已有记录的派生视图，不是新增事实，也不表示已读取摘要或原文。'}:
          {read:{tool:'asset_search'},note:'任务来源、范围或可见性已变化，重新核实两图。'})};
    }
    groups.set(key,{events:[event],change});
  }
  const changes:Record<string,unknown>[]=[],delivered:number[]=[];let bytes=2;
  for(const {events:group,change} of groups.values()){
    if(change){
      // Invalidation notices are not content snapshots. A new source/link or
      // scope change can have the same fields and asset version as a prior one.
      // Keep exact committed event identity so delivery dedup never hides it.
      if(change.requires_read===true)change.event_ids=group.map(e=>Number(e.id));
      if(group[0]?.subject_type&&group[0].subject_type!=='node'){
        change.changed_fields=[...new Set(group.flatMap(e=>(e.changed_fields??[]) as string[]))];
        const versions=group.filter(e=>e.subject_version!==null).map(e=>Number(e.subject_version));
        if(versions.length)change.change_version=Math.max(...versions);
      }
      const size=Buffer.byteLength(JSON.stringify(change))+1;if(bytes+size>12*1024)continue;
      bytes+=size;changes.push(change);
    }
    delivered.push(...group.map(e=>Number(e.id)));
  }
  // Truncated changes stay pending. Exact IDs, never a max cursor, also retain
  // transactions whose smaller sequence number commits after this snapshot.
  return {more:fetched.length>200||delivered.length<events.length,ids:delivered.sort((a,b)=>a-b),changes};
}

export async function acknowledgePlannerContext(db:Database,expID:number,roundID:string,ids:number[]) {
  await db.query('UPDATE exploration_context_events SET acknowledged_at=now() WHERE exploration_id=$1 AND id=ANY($2::bigint[]) AND acknowledged_at IS NULL',[expID,ids]);
  return true;
}
