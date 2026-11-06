import type {Database} from '../db/index.js';
import {constraintSourceHash,renderConstraints} from './constraint-policy.js';

/** A native pi request snapshots constraints. Older generated batches cannot start
 * new target actions. Local reads and already-observed evidence remain usable. */
const SAFE_LOCAL = new Set(['tool_search','context_search','context_get','asset_search','asset_get','list_assets','list_untested_assets','list_findings','list_facts','graph_overview','node_detail','search_worker_traces','get_worker_trace','read','read_tool_output','read_attachment','traffic_body','expand_index','expand_digest','shell_read','shell_list','shell_close','insert_assets','record_fact','report_finding','todo_write','kill_work']);
export class ConstraintBoundary {
 private observed?:string;
 private announced?:string;
 constructor(private db:Database,private expID:number,private audit:(text:string)=>unknown=()=>{}){}
 private async snapshot(){
  const rows=(await this.db.query<{id:string;kind:string;text:string;source?:{context_quote?:string;quote?:string}}>(`SELECT id::text,kind,text,source FROM task_constraints WHERE exploration_id=$1 ORDER BY id`,[this.expID])).rows;
  return {rows,version:constraintSourceHash(JSON.stringify(rows))};
 }
 async context(){
  const current=await this.snapshot();
  this.observed=current.version;
  if(this.announced!==current.version){this.announced=current.version;await this.audit(`本次模型上下文采用操作约束版本 ${current.version}`);}
  return `【操作约束版本 ${current.version}】`+renderConstraints(current.rows);
 }
 async guard(toolName:string){
  if(SAFE_LOCAL.has(toolName))return undefined;
  const current=await this.snapshot();
  if(this.observed===current.version)return undefined;
  return {block:true,reason:'操作约束已变化，本次调用在执行前被拒绝，未启动目标操作。请依据下一次模型请求中的最新约束重新判断当前意图；已有观察仍可写回，不要扩展其他方向。'};
 }
}
