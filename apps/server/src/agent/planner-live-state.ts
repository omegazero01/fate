import type {PlannerHistorySnapshot} from '../db/planner-history.js';

/** PI may execute read-only tools in parallel. They share one execution-owned
 * refresh rather than racing each other for the cross-process index try-lock.
 * Failed refreshes are never cached. Appends during a refresh require the next
 * reader to refresh again; the captured identity is not advanced speculatively. */
export function createPlannerStateReader(identity:()=>{count:number;leaf:string|null},refresh:()=>Promise<PlannerHistorySnapshot|undefined>){
 let state:PlannerHistorySnapshot|undefined,key:string|undefined,pending:Promise<PlannerHistorySnapshot|undefined>|undefined;
 return async()=>{
  if(pending)return pending;
  const observed=JSON.stringify(identity());if(key===observed)return state;
  pending=(async()=>{const next=await refresh();state=next;key=observed;return next;})().finally(()=>{pending=undefined;});
  return pending;
 };
}
