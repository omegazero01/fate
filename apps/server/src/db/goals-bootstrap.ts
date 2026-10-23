import {createHash} from 'node:crypto';
import type {Database} from './index.js';
import type {ToolRunContext} from '../tools/context.js';
export const GOALS_POLICY='goal-field-isolation-v1';
export type GoalsPhase='constraints'|'objectives';
export interface GoalsBootstrap {task_id:number;goal:string;description:string;phase:GoalsPhase|'completed';goal_ids:number[];fallback:boolean}
export const goalHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export async function goalsBootstrap(db:Database,taskID:number):Promise<GoalsBootstrap|undefined>{return (await db.query('SELECT * FROM goals_bootstrap WHERE task_id=$1',[taskID])).rows[0] as GoalsBootstrap|undefined;}
/** Lock lifecycle first, then bootstrap, matching task control's ownership order. */
export async function activeBootstrap(ctx:ToolRunContext,db:Database){
 ctx.signal?.throwIfAborted();await ctx.hooks.assertOwnership?.(db);
 const task=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[ctx.taskID])).rows[0];
 if(!task||Number(task.exploration_id)!==ctx.expID||task.deleted_at||task.paused||task.queued||['done','failed','timeout'].includes(String(task.status)))throw new Error('目标初始化已停止或任务归属失效');
 const row=(await db.query('SELECT * FROM goals_bootstrap WHERE task_id=$1 FOR UPDATE',[ctx.taskID])).rows[0] as GoalsBootstrap|undefined;
 if(!row||row.goal!==task.goal||row.description!==task.description)throw new Error('目标初始化输入快照已变化');
 return row;
}
export interface GoalSubmission {text:string;vulnclass?:string;source_quote?:string}
export async function saveBootstrapGoals(ctx:ToolRunContext,goals:GoalSubmission[],fallback=false){
 return ctx.db.transaction(async db=>{
  const row=await activeBootstrap(ctx,db);
  if(row.phase==='completed')return row.goal_ids.map(Number);
  if(ctx.goalsPhase!=='objectives'||row.phase!=='objectives')throw new Error('当前阶段不能写入目标');
  if(!goals.length||goals.length>10)throw new Error('目标数量须为 1–10');
  for(const g of goals){if(!g.text?.trim()||!g.source_quote?.trim()||!row.goal.includes(g.source_quote))throw new Error('目标 source_quote 必须逐字引用本次目标栏原文，不能引用描述或背景');}
  const store=db.exploration(ctx.expID),origin=await store.originFactID(),ids:number[]=[];
  // No replacement of manually added or historical goals. This receipt is committed with the nodes.
  for(const g of goals){const id=await store.addGoal({text:g.text.trim(),...(g.vulnclass?{vulnclass:g.vulnclass}:{}),source:{version:GOALS_POLICY,field:'goal',quote:g.source_quote,source_hash:goalHash(row.goal),fallback}},'goals');if(origin)await store.link(origin,'spawns',id);ids.push(id);}
  await db.query("UPDATE goals_bootstrap SET phase='completed',goal_ids=$2,fallback=$3,updated_at=now() WHERE task_id=$1",[ctx.taskID,ids,fallback]);
  ctx.signal?.throwIfAborted();
  return ids;
 });
}
