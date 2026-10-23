import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import type {Database} from '../db/index.js';
import type {AgentRunner,RunResult} from '../pi/runner.js';

export const PLANNER_READING_RULES = `本任务使用持续规划会话。历史对话和压缩摘要用于追溯判断，不代表当前图状态或执行授权。
资产图记录身份、接口方法、参数和指纹；探索图记录目标、意图、事实、漏洞及证据。派单前使用 asset_search/asset_get 核实相关资产，用 context_search 按 asset_id 查询既有意图及结果（含冷图），context_get 读取影响决策的正反证据。关键词是字面短语；空结果、摘要截断或节点退出近期索引不能证明“从未测试”或“已删除”。有续页时继续读取或缩小筛选。
目标节点供 prove_goal 判定，不作为派单证据；add_intent 的 parent_ids/contract.basis 只能引用 fact/finding，初始派单可省略，由宿主连接任务根事实。
负面结论只覆盖实际测试过的资产、端口、协议、方法和参数，不能将部分端口的响应推广到未测端口或将代理返回当成所有后端协议的响应。未测方向可因约束或缺少前置而暂缓，但仍应标为未知，不能称为已测、关闭或已被证伪。
分段读取只证明已返回区间的内容；next_offset/next_cursor 非空时，不能断言全文已读、剩余部分无结论或无证据。读取相关片段足够作本轮判断时可以结束，但应保留未读范围，不补造全文结论。
历史规划原文可通过 context_search(source=planner_session) 检索，再用 context_get 读取 session: 引用；历史不是新的事实，引用图节点时重新核对版本。覆盖度只代表接触记录，不证明测试完毕。保持现有直接派单语义，不等待额外完成协议。`;

export const PLANNER_COMPACTION_RULES = `这是同一任务的持续 Planner 会话。保留任务目标、未完成待办及依赖、已派意图与派单理由、决定不再尝试的方向及其负面证据、阻塞和未解决问题。
保留相关 asset ID、node ID、证据版本、会话条目引用与读取入口；区分实测、推断、否定和未知，不把旧状态或摘要当成当前事实。负面结论保留实际验证范围；未读区间及续读位置保留为未完成事项，不能摘要为已经读完。不要重复长工具输出；原文通过 context_search(source=planner_session)/context_get(session:...) 召回，图与资产详情用现有查询工具核实。不要遗漏否定结果而把已测方向当成未测试。`;

export function plannerSessionFile(dataDir:string,expID:number){
  return path.resolve(dataDir,'sessions',`exp${expID}-planner.jsonl`);
}

/** The SDK silently starts over on an invalid file. A Planner must fail recoverably instead. */
export function validatePlannerSession(file:string){
  if(!existsSync(file))return;
  const lines=readFileSync(file,'utf8').split('\n').filter(l=>l.trim());
  try{
    if(!lines.length)throw new Error('empty');
    const entries=lines.map(l=>JSON.parse(l));
    if(entries[0].type!=='session'||!entries[0].id)throw new Error('header');
    if(entries.slice(1).some(e=>!e.id||!e.type))throw new Error('entry');
  }catch{throw new Error('Planner 会话文件损坏，已保留原文；请恢复文件后重试，不会创建空会话覆盖历史');}
}

/** A session-level advisory lock prevents a stale executor from writing the same file. */
export async function lockPlannerSession(db:Database,expID:number,signal?:AbortSignal){
  const client=await db.pool.connect(),key=`fate:planner-session:${expID}`;
  const controller=new AbortController();let lost:Error|undefined;
  const onError=(error:Error)=>{lost=error;controller.abort(error);};
  client.on('error',onError);
  try{
    signal?.throwIfAborted();
    const r=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked',[key]);
    if(!r.rows[0].locked)throw new Error('Planner 会话已有运行者，等待原执行器退出后重试');
    const release=async()=>{
      try{if(!lost)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
      finally{client.off('error',onError);client.release(lost);}
    };
    return Object.assign(release,{signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
  }catch(error){client.off('error',onError);client.release(lost);throw error;}
}

type ObjectValue=Record<string,unknown>;
const object=(v:unknown):ObjectValue=>v&&typeof v==='object'&&!Array.isArray(v)?v as ObjectValue:{};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface PlannerDelivery {
  version:1;id:string;taskID:number;expID:number;input:string;contextIDs:number[];wakeupIDs:number[];
  seen:Record<string,string>;currentState:ObjectValue;
}
interface Completion {deliveryID:string;result:Pick<RunResult,'aborted'|'stopReason'|'lastAssistantText'>;}
export function plannerDeliveries(entries:readonly SessionEntry[]){
  const deliveries:PlannerDelivery[]=[],completed=new Map<string,Completion>();
  for(const e of entries)if(e.type==='custom'){
    if(e.customType==='planner_delivery')deliveries.push(e.data as PlannerDelivery);
    if(e.customType==='planner_delivery_completed'){
      const c=e.data as Completion;completed.set(c.deliveryID,c);
    }
  }
  return {deliveries,completed};
}

/** Only current state is replaced at request boundaries; transcript entries remain untouched. */
export function plannerCurrentState(overview:ObjectValue,todos:unknown):ObjectValue{
  const active=(key:string)=>((overview[key]??[]) as ObjectValue[]).map(n=>({
    id:n.id,ref:n.ref,version:n.version,state:n.state,priority:n.priority,summary:n.summary,asset_ids:n.asset_ids,parents:n.parents,yields:n.yields,
    ...(n.relations_truncated?{relations_truncated:true,read:n.read}:{}),
    ...(n.owner?{owner:n.owner}:{}),...(n.execution_stop?{execution_stop:n.execution_stop}:{}),
  }));
  return {goals:overview.goals,open_intents:active('open_intents'),running_intents:active('running_intents'),
    frontier_open:overview.frontier_open,done_intents_total:overview.done_intents_total,
    facts_total:overview.facts_total,findings_total:overview.findings_total,asset_counts:overview.asset_counts,
    coverage:overview.coverage,scheduling:overview.scheduling,active_hints:overview.active_hints,todos,
    related_tasks:((overview.related_tasks??[]) as ObjectValue[]).map(s=>({source_task_id:s.source_task_id,read_only:true})),
    bounded:true,read:'摘要未展示不代表不存在；完整状态通过 graph_overview/context_search/context_get 查询'};
}

/** Null-node events are invalidations, not an empty graph delta. Keep their existing IDs. */
export async function plannerInvalidations(db:Database,expID:number,ids:number[],changes:unknown[]){
  if(!ids.length)return [];
  const visible=new Set(changes.map(c=>object(c).ref));
  const rows=(await db.query('SELECT id,node_id,kind FROM exploration_context_events WHERE exploration_id=$1 AND id=ANY($2::bigint[]) ORDER BY id',[expID,ids])).rows;
  const groups=new Map<string,{event_ids:number[];unavailable_refs:string[]}>();
  for(const row of rows){
    const ref=row.node_id===null?undefined:`node:${row.node_id}`;
    if(ref&&visible.has(ref))continue;
    const kind=String(row.kind),group=groups.get(kind)??{event_ids:[],unavailable_refs:[]};
    group.event_ids.push(Number(row.id));if(ref&&!group.unavailable_refs.includes(ref))group.unavailable_refs.push(ref);
    groups.set(kind,group);
  }
  return [...groups].map(([kind,group])=>({ref:`context:${kind}`,kind,...group,requires_read:true,
    note:kind==='assets'?'资产身份、字段、关联或范围已变化；此通知不等于已读详情，规划相关方向前重新查询资产图。'
      :'图节点删除、来源或可读性已变化；历史内容可能已失效，使用前重新检索和读取当前图，不能将历史引用直接当作有效依据。'}));
}

export function preparePlannerDelivery(args:{taskID:number;expID:number;overview:ObjectValue;todos:unknown;changes:unknown[];events:unknown[];contextIDs:number[];triggers:string;previous?:PlannerDelivery}):PlannerDelivery{
  const seen={...args.previous?.seen},increment:ObjectValue[]=[];
  // Per-section hashes preserve different projections/evidence of the same node.
  const emit=(key:string,value:unknown)=>{
    const fingerprint=hash(value);if(seen[key]===fingerprint)return;
    seen[key]=fingerprint;increment.push({section:key,...object(value)});
  };
  for(const key of ['worker_capabilities','asset_readers','cold_digests_index','node_index'])
    if(args.overview[key]!==undefined)emit(key,{value:args.overview[key]});
  for(const section of ['recent_facts','recent_done_intents','cold_digests'])
    for(const row of (args.overview[section]??[]) as ObjectValue[])emit(`${section}:${row.id}`,row);
  for(const source of (args.overview.related_tasks??[]) as ObjectValue[])
    for(const section of ['goals','recent_facts','cold_digests'])
      for(const row of (source[section]??[]) as ObjectValue[])emit(`source:${source.source_task_id}:${section}:${row.id}`,{...row,source_task_id:source.source_task_id,read_only:true});
  for(const raw of args.changes){const c=object(raw);emit(`change:${c.source_task_id}:${c.ref??hash(c)}`,c);}
  const events=args.events.map(object),wakeupIDs=events.map(e=>Number(e.id)).filter(Number.isSafeInteger);
  const currentState=plannerCurrentState(args.overview,args.todos);
  const payload={initial:!args.previous,changes:increment,notifications:events,trigger:args.triggers,
    ...(args.contextIDs.length?{context_event_ids:args.contextIDs}:{}),
    historical_recall:{source:'planner_session',note:'当前状态见宿主实时投影；新增内容不等于整图，资产字段变化需要实时查询。'}};
  return {version:1,id:randomUUID(),taskID:args.taskID,expID:args.expID,input:JSON.stringify(payload),
    contextIDs:args.contextIDs,wakeupIDs,seen,currentState};
}

export function selectPlannerDelivery(runner:AgentRunner,args:Parameters<typeof preparePlannerDelivery>[0]){
  const {deliveries,completed}=plannerDeliveries(runner.sessionEntries);
  if(deliveries.some(d=>d.taskID!==args.taskID||d.expID!==args.expID))throw new Error('Planner 会话归属不匹配');
  const eventIDs=args.events.map(e=>Number(object(e).id));
  // A completion marker saved before a crash repairs DB acknowledgements without another model request.
  const recover=deliveries.find(d=>completed.has(d.id)&&
    (d.contextIDs.some(id=>args.contextIDs.includes(id))||d.wakeupIDs.some(id=>eventIDs.includes(id))));
  if(recover)return {delivery:recover,recovered:completed.get(recover.id)!.result};
  const pending=deliveries.find(d=>!completed.has(d.id));
  if(pending)return {delivery:pending};
  const delivery=preparePlannerDelivery({...args,previous:deliveries.at(-1)});
  runner.appendSessionEntry('planner_delivery',delivery);
  return {delivery};
}
