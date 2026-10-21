import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '../db/index.js';
import type {PoolClient} from 'pg';

export function outputPage(id:string,body:string,offset=0){
 const start=Math.min(body.length,Math.max(0,Math.floor(Number.isFinite(offset)?offset:0))),end=Math.min(body.length,start+2000);
 return {ref:`output:${id}`,read:{items:[{ref:`output:${id}`,offset:start}]},output_ref:id,format:'json',content:body.slice(start,end),offset:start,total:body.length,next_offset:end<body.length?end:null,
  hint:'content 是完整工具 JSON 的一段；用 context_get(items=[{ref:"output:"+output_ref,offset:next_offset}]) 续读（UTF-16 偏移），不会省略数组成员。'};
}
async function authorizationFingerprint(db:Database,taskID:number){
 const owners=[taskID,...(await db.query('SELECT source_task_id FROM task_relations WHERE task_id=$1 ORDER BY source_task_id',[taskID])).rows.map(r=>Number(r.source_task_id))];
 const tasks=(await db.query('SELECT id,deleted_at FROM tasks WHERE id=ANY($1::bigint[]) ORDER BY id',[owners])).rows;
 return createHash('sha256').update(JSON.stringify([tasks])).digest('hex');
}
export async function saveToolOutput(db:Database,scope:{taskID:number;conversationID?:number;intentID?:number},tool:string,callID:string,body:string){
 const id=randomUUID();
 await db.query('INSERT INTO tool_output_artifacts(id,task_id,conversation_id,node_id,tool,tool_call_id,body,authorization_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,scope.taskID||null,scope.conversationID??null,scope.intentID??null,tool,callID,body,scope.taskID?await authorizationFingerprint(db,scope.taskID):null]);
 return outputPage(id,body);
}
export async function loadToolOutput(db:Database,id:string,scope?:{taskID:number;conversationID?:number;worker?:boolean;agent?:boolean;intentID?:number}){
 const row=(await db.query('SELECT * FROM tool_output_artifacts WHERE id=$1',[id])).rows[0];
 if(!row)throw Object.assign(new Error('工具原文不存在'),{statusCode:404});
 if(scope&&(scope.conversationID?Number(row.conversation_id)!==scope.conversationID:row.conversation_id!==null||Number(row.task_id)!==scope.taskID))throw Object.assign(new Error('工具原文不属于当前会话'),{statusCode:403});
 if(scope?.agent&&row.node_id&&Number(row.node_id)!==scope.intentID)throw Object.assign(new Error('其他意图的私有工具原文不能作为协同来源；请读取已发布探索图'),{statusCode:403});
 if(row.task_id){
  if(row.authorization_hash!==await authorizationFingerprint(db,Number(row.task_id)))throw Object.assign(new Error('授权范围已变化，请重新执行原查询'),{statusCode:403});
  const task=await db.tasks().getTask(Number(row.task_id));
  if(!task||row.node_id&&!(await db.query('SELECT 1 WHERE exploration_node_readable($1,$2)',[task.exploration_id,Number(row.node_id)])).rowCount)throw Object.assign(new Error('工具原文授权已撤销'),{statusCode:403});
 }
 return String(row.body);
}

/** Snapshot readable legacy outputs before dropping the old schema. Stale source-task access stays stale. */
export async function prepareToolOutputAccessMigration(client: PoolClient) {
 const legacy = (await client.query(`SELECT to_regclass('tool_output_artifacts') IS NOT NULL
   AND to_regprocedure('task_asset_effective_approval_state(bigint,bigint)') IS NOT NULL AS present`)).rows[0]?.present;
 if (!legacy) return;
 const ids: string[] = [];
 for (const row of (await client.query('SELECT DISTINCT task_id FROM tool_output_artifacts WHERE task_id IS NOT NULL')).rows) {
  const taskID = Number(row.task_id);
  const owners = [taskID, ...(await client.query('SELECT source_task_id FROM task_relations WHERE task_id=$1 ORDER BY source_task_id', [taskID])).rows.map(r => Number(r.source_task_id))];
  const tasks = (await client.query('SELECT id,deleted_at,asset_approval_template FROM tasks WHERE id=ANY($1::bigint[]) ORDER BY id', [owners])).rows;
  const assets = (await client.query('SELECT task_id,asset_id,task_asset_effective_approval_state(task_id,asset_id) state FROM task_asset_links WHERE task_id=ANY($1::bigint[]) ORDER BY task_id,asset_id', [owners])).rows;
  const blocks = (await client.query('SELECT task_id,asset_key,host_key,block_kind FROM task_asset_blocks WHERE task_id=ANY($1::bigint[]) ORDER BY task_id,asset_key', [owners])).rows;
  const hash = createHash('sha256').update(JSON.stringify([tasks,assets,blocks])).digest('hex');
  ids.push(...(await client.query('SELECT id FROM tool_output_artifacts WHERE task_id=$1 AND authorization_hash=$2', [taskID,hash])).rows.map(r => String(r.id)));
 }
 await client.query(`CREATE TABLE IF NOT EXISTS retired_feature_data (
  feature TEXT NOT NULL, source TEXT NOT NULL, data JSONB NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(feature,source))`);
 await client.query(`INSERT INTO retired_feature_data(feature,source,data) VALUES('approvals','readable_tool_outputs',$1::jsonb)
  ON CONFLICT(feature,source) DO UPDATE SET data=EXCLUDED.data`, [JSON.stringify(ids)]);
}

/** Preserve readable output references without reviving outputs invalidated before the upgrade. */
export async function rebaseToolOutputAccess(db:Database){
 const ids = (await db.query("SELECT data FROM retired_feature_data WHERE feature='approvals' AND source='readable_tool_outputs'")).rows[0]?.data;
 if (!Array.isArray(ids) || !ids.length) return;
 for(const row of (await db.query('SELECT DISTINCT task_id FROM tool_output_artifacts WHERE task_id IS NOT NULL AND id::text=ANY($1::text[])',[ids])).rows){
  await db.query('UPDATE tool_output_artifacts SET authorization_hash=$2 WHERE task_id=$1 AND id::text=ANY($3::text[])',[Number(row.task_id),await authorizationFingerprint(db,Number(row.task_id)),ids]);
 }
}
