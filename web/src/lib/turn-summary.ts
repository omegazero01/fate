import type {Activity} from './types';
export type TurnSummary={
 version:number;turn_id:string;revision:number;updated_at:string;worker:string;role:string|null;intent_id:string|null;main_seg:number|null;
 status:string;started_at:string|null;finished_at:string|null;queue_ms:number|null;mode:string|null;steps:number|null;tool_calls:number|null;failed_tool_calls:number|null;
 models:string[];usage:null|{input:number;output:number;cache_read:number;cache_write:number;total:number;incomplete:boolean;source:string;compaction_requests:number|null;compaction_tokens:number|null;failed_requests:number|null;failed_request_tokens:number|null};
 final_activity:Activity|null;error:string|null;
 writebacks?:{version:number;intent_id:string;available:boolean};
};
export type TurnSummaryBatch={items:TurnSummary[];requested_ids:string[]};
export function newerSummary(old:TurnSummary|undefined,value:TurnSummary){return !old||value.revision>old.revision||value.revision===old.revision&&Date.parse(value.updated_at)>=Date.parse(old.updated_at);}
export function notifyTurnSummaries(scope:string,batch:TurnSummaryBatch){window.dispatchEvent(new CustomEvent('series:turn-summary',{detail:{scope,...batch}}));}
export function turnParts(steps:Activity[],summary?:TurnSummary){
 const visible=steps.filter(s=>s.kind!=='usage'&&!['turn_start','runner_settled'].includes(s.metadata?.event_type??'')&&!(s.metadata?.response&&!s.summary&&!s.detail));
 const final=summary?.final_activity?steps.find(s=>s.seq===summary.final_activity!.seq)??summary.final_activity:undefined;
 const finalStream=final?.stream_id??final?.metadata?.stream_id;
 const process=visible.filter(s=>s.seq!==final?.seq&&!(finalStream&&(s.stream_id??s.metadata?.stream_id)===finalStream&&['text','assistant'].includes(s.kind))&&s.metadata?.event_type!=='lifecycle'&&!(s.kind==='result'&&/^(回复完成|回复已停止)$/.test(s.summary)&&!s.metadata?.worker_feedback));
 // Outcomes may repeat the last native prose as an acceptance receipt. Keep
 // its original activity accessible via search, but do not print it twice.
 const body=final?.detail||final?.summary;
 return {final,process:final?.metadata?.event_type==='outcome'?process.filter(s=>!['text','assistant'].includes(s.kind)||(s.detail||s.summary)!==body):process};
}
export function durationLabel(start:string|null,end:string|null,now:number){
 if(!start)return '耗时未记录';
 const seconds=Math.max(0,Math.floor(((end?Date.parse(end):now)-Date.parse(start))/1000));
 if(!Number.isFinite(seconds))return '耗时未记录';
 return seconds<60?`${seconds} 秒`:seconds<3600?`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:`${Math.floor(seconds/3600)} 时 ${Math.floor(seconds/60)%60} 分`;
}
