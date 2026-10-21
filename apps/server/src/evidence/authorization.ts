import type {Database} from '../db/index.js';
import {resolveGraphNode} from '../db/graph_view.js';

export type EvidenceOwner={task_id:unknown;intent_id:unknown;url:unknown};
/** Authorization comes from the immutable snapshot, never its removable inbox entry. */
export async function authorizeEvidence(db:Database,owner:EvidenceOwner,taskID?:number){
 const ownerID=Number(owner.task_id);
 if(!ownerID||(taskID!==undefined&&ownerID!==taskID))throw Object.assign(new Error('证据不属于当前任务'),{statusCode:403});
 const task=await db.tasks().getTask(ownerID);
 if(!task)throw Object.assign(new Error('证据来源任务已不可用'),{statusCode:403});
 try{
  const intent=owner.intent_id==null?null:(await resolveGraphNode(db,ownerID,task.exploration_id,Number(owner.intent_id))).node;
 }catch{throw Object.assign(new Error('证据目标不属于有效任务'),{statusCode:403});}
}

export async function authorizedEvidenceIDs(db:Database,rows:Array<EvidenceOwner&{id:unknown}>){
 const decisions=new Map<string,boolean>(),ids:string[]=[];
 for(const row of rows){
  let origin:string;try{origin=new URL(String(row.url)).origin;}catch{continue;}
  const key=JSON.stringify([row.task_id,row.intent_id,origin]);
  let allowed=decisions.get(key);
  if(allowed===undefined){try{await authorizeEvidence(db,row);allowed=true;}catch{allowed=false;}decisions.set(key,allowed);}
  if(allowed)ids.push(String(row.id));
 }
 return ids;
}
