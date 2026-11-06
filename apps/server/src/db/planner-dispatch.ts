import {createHash} from 'node:crypto';
import type {ToolRunContext} from '../tools/context.js';
import type {Database} from './index.js';

export interface SubmittedIntent {summary:string;intent_id:number;created:boolean;duplicate_of?:number;dedup?:{version:3;strength:string;match?:string;related_intent_ids?:number[]}}
/** Called only inside the intent transaction, after ownership validation. The
 * host supplies session/delivery IDs; neither is accepted in model arguments. */
export async function priorPlannerDispatch(db:Database,c:ToolRunContext,args:unknown){
 if(c.role!=='planner'||!c.plannerDelivery)return;
 if(!c.toolCallID)throw new Error('Planner 派单缺少宿主调用标识');
 const {sessionID,deliveryID}=c.plannerDelivery;
 const hash=createHash('sha256').update(JSON.stringify(args)).digest('hex');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['planner-dispatch',c.expID,sessionID,deliveryID,c.toolCallID])]);
 const row=(await db.query('SELECT delivery_id,arguments_hash,result_text FROM planner_dispatch_calls WHERE exploration_id=$1 AND session_id=$2 AND tool_call_id=$3 AND delivery_id=$4',[c.expID,sessionID,c.toolCallID,deliveryID])).rows[0];
 if(row&&(row.delivery_id!==deliveryID||row.arguments_hash!==hash))throw new Error('同一 Planner 工具调用的参数或交付身份已变化');
 return {sessionID,deliveryID,callID:c.toolCallID,hash,prior:row?JSON.parse(String(row.result_text)) as SubmittedIntent[]:undefined};
}
export async function savePlannerDispatch(db:Database,expID:number,receipt:NonNullable<Awaited<ReturnType<typeof priorPlannerDispatch>>>,results:SubmittedIntent[]){
 await db.query(`INSERT INTO planner_dispatch_calls(exploration_id,session_id,delivery_id,tool_call_id,arguments_hash,result_text)
  VALUES($1,$2,$3,$4,$5,$6)`,[expID,receipt.sessionID,receipt.deliveryID,receipt.callID,receipt.hash,JSON.stringify(results)]);
 await db.query(`INSERT INTO planner_dispatch_items(exploration_id,session_id,tool_call_id,item_no,delivery_id,intent_id,created)
  SELECT $1,$2,$3,x.item_no,$4,x.intent_id,x.created FROM jsonb_to_recordset($5::jsonb) x(item_no int,intent_id bigint,created boolean)`,
 [expID,receipt.sessionID,receipt.callID,receipt.deliveryID,JSON.stringify(results.map((r,item_no)=>({item_no,intent_id:r.intent_id,created:r.created})))]);
}
