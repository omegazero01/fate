export type WritebackCounts = {asset:number;fact:number;finding:number;total:number};
export type WritebackItem = {
  key:string;kind:'asset'|'fact'|'finding';record_id:string;node_id:string|null;finding_id:string|null;
  summary:string|null;summary_truncated:boolean;state:string;detail_ref:string;
  observation_type:string|null;confidence:string|null;version:number|null;source_turn_id:string|null;
};
export type WorkerWritebackPage = {
  version:number;task_id:string;intent_id:string;turn_id:string;revision:number;bucket:'current'|'previous';
  complete:boolean;notice:string|null;counts:{current:WritebackCounts;previous:WritebackCounts};
  items:WritebackItem[];next_cursor:string|null;
};
export function appendWritebackPage(old:WorkerWritebackPage|undefined,next:WorkerWritebackPage):WorkerWritebackPage {
  if(!old||old.task_id!==next.task_id||old.turn_id!==next.turn_id||old.bucket!==next.bucket||old.revision!==next.revision)return next;
  return {...next,items:[...new Map([...old.items,...next.items].map(item=>[item.key,item])).values()]};
}
export function writebackLabel(item:WritebackItem){
  if(item.kind==='asset')return '已登记';
  if(item.state==='dismissed')return '已撤销';
  if(item.kind==='finding')return '已报告';
  return ({negative:'未发现／排除结果',inferred:'推断，待验证',observed:'实测观察',unknown:'待核实'} as Record<string,string>)[item.observation_type??'']??'已记录';
}
export function writebackSummary(item:WritebackItem){
  const text=item.summary||'摘要未记录';
  // Presentation only: keep the full URL in the durable record and row title.
  const match=item.kind==='asset'?/^([A-Z]+) (https?:\/\/\S+)$/.exec(text):null;
  if(match)try{const url=new URL(match[2]);return `${match[1]} ${url.pathname}${url.search}`;}catch{/* Keep the stored text. */}
  return text;
}
export function writebackLink(task:string,item:WritebackItem){
  if(item.kind==='finding'&&item.finding_id)return `/function/findings/detail?${new URLSearchParams({id:item.finding_id,context_task:task})}`;
  if(item.node_id)return `/function/tasks/detail?${new URLSearchParams({id:task,tab:'graph',node:item.node_id})}`;
  return null;
}
