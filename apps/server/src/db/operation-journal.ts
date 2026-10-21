import {createHash,randomUUID} from 'node:crypto';
import type {Database} from './index.js';
import type {ToolRunContext} from '../tools/context.js';
import {contextNode} from '../tools/context-pages.js';

export function stableJSON(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined)
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+stableJSON(v)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
export const operationFingerprint=(tool:string,args:unknown)=>createHash('sha256').update(stableJSON([tool,args])).digest('hex');
function terminalResult(result:unknown):{session_id?:string;running?:boolean;closed?:boolean}{
  try{const content=(result as {content?:{type:string;text?:string}[]})?.content;
    return JSON.parse(content?.filter(c=>c.type==='text').map(c=>c.text??'').join('\n')??'{}');
  }catch{return {};}
}

export async function migrateOperationJournal(db:Database){
  await db.query(`CREATE TABLE IF NOT EXISTS worker_operation_epochs (
    intent_id BIGINT PRIMARY KEY REFERENCES exploration_nodes(id) ON DELETE CASCADE,
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    execution_id UUID NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS worker_operations (
    id BIGSERIAL PRIMARY KEY, task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    intent_id BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
    execution_id UUID NOT NULL, tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
    fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','returned','uncertain','confirmed','retry_allowed','superseded')),
    result JSONB, is_error BOOLEAN, replayed BOOLEAN NOT NULL DEFAULT false, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
    previous_id BIGINT REFERENCES worker_operations(id), UNIQUE(execution_id,tool_call_id)
  );
  ALTER TABLE worker_operations ADD COLUMN IF NOT EXISTS replayed BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE worker_operations ADD COLUMN IF NOT EXISTS volatile BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE worker_operations ADD COLUMN IF NOT EXISTS terminal_id TEXT;
  CREATE INDEX IF NOT EXISTS worker_operations_lookup ON worker_operations(intent_id,fingerprint,id DESC);
  CREATE INDEX IF NOT EXISTS worker_operations_task ON worker_operations(task_id,id);
  CREATE TABLE IF NOT EXISTS worker_operation_resolutions (
    id BIGSERIAL PRIMARY KEY, operation_id BIGINT NOT NULL REFERENCES worker_operations(id) ON DELETE CASCADE,
    actor TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL,
    previous_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
}
type Row={id:string;execution_id:string;tool_name:string;fingerprint:string;status:string;result:unknown;is_error:boolean|null;intent_id:string;[key:string]:unknown};
export class OperationUncertainError extends Error {
  constructor(public operationID:number){super(`operation:${operationID} 的实际执行结果未知；不自动重放。先读取操作记录、保存已有事实并结束本意图，待核对后恢复。`);}
}

/** Domain ownership is checked inside the same transaction as every durable transition. */
export class WorkerOperationJournal {
  readonly executionID=randomUUID();
  recoveryBlocked=false;
  constructor(private ctx:ToolRunContext){}
  private async owned(db:Database){
    await this.ctx.hooks.assertOwnership?.(db);
    const node=(await db.query(`SELECT n.state,n.owner,t.paused,t.deleted_at,t.status task_status
      FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
      WHERE n.id=$1 AND t.id=$2 FOR UPDATE OF n`,[this.ctx.intentID,this.ctx.taskID])).rows[0];
    if(!node||node.state!=='running'||node.owner!==this.ctx.workerName||node.paused||node.deleted_at||['done','failed','timeout','stopped'].includes(String(node.task_status)))
      throw new Error('操作记录的意图归属或执行状态已变化');
  }
  private async epoch(db:Database){
    const r=await db.query('SELECT 1 FROM worker_operation_epochs WHERE intent_id=$1 AND execution_id=$2 FOR UPDATE',[this.ctx.intentID,this.executionID]);
    if(!r.rowCount)throw new Error('操作记录的执行代次已失效');
  }
  async start(){
    await this.ctx.db.transaction(async db=>{
      await this.owned(db);
      await db.query(`INSERT INTO worker_operation_epochs(intent_id,task_id,execution_id) VALUES($1,$2,$3)
        ON CONFLICT(intent_id) DO UPDATE SET execution_id=excluded.execution_id,updated_at=now()`,[this.ctx.intentID,this.ctx.taskID,this.executionID]);
      await db.query(`UPDATE worker_operations SET status='uncertain' WHERE intent_id=$1 AND
        (status='running' OR status='returned' AND volatile)`,[this.ctx.intentID]);
    });
  }
  async begin(tool:string,callID:string,args:unknown):Promise<{id:number;replay?:unknown}>{
    const fingerprint=operationFingerprint(tool,args);
    return this.ctx.db.transaction(async db=>{
      await this.owned(db);await this.epoch(db);
      const own=(await db.query<Row>('SELECT * FROM worker_operations WHERE execution_id=$1 AND tool_call_id=$2',[this.executionID,callID])).rows[0];
      if(own){
        if(own.fingerprint!==fingerprint)throw new Error('同一工具调用 ID 的参数已变化');
        if(own.status==='returned')return {id:Number(own.id),replay:own.result};
        this.recoveryBlocked=true;throw new OperationUncertainError(Number(own.id));
      }
      // Only cross-execution equivalence is reused; repeated reads/polls within a live run remain possible.
      const old=(await db.query<Row>(`SELECT * FROM worker_operations WHERE intent_id=$1 AND fingerprint=$2 AND execution_id<>$3 ORDER BY id DESC LIMIT 1`,[this.ctx.intentID,fingerprint,this.executionID])).rows[0];
      if(old?.status==='returned'||old?.status==='confirmed'){
        const replay=old.status==='returned'?old.result:{content:[{type:'text',text:JSON.stringify({operation_ref:`operation:${old.id}`,status:'operator_confirmed',note:'操作已由人工核对完成；原工具返回未记录，不补造输出。'})}]};
        const alias=await db.query(`INSERT INTO worker_operations(task_id,intent_id,execution_id,tool_call_id,tool_name,fingerprint,status,result,is_error,previous_id,replayed,finished_at)
          VALUES($1,$2,$3,$4,$5,$6,'returned',$7::jsonb,$8,$9,true,now()) RETURNING id`,
          [this.ctx.taskID,this.ctx.intentID,this.executionID,callID,tool,fingerprint,JSON.stringify(replay),old.is_error??false,old.id]);
        return {id:Number(alias.rows[0]!.id),replay};
      }
      // Any unresolved external effect in this intent must be reconciled before more effectful operations.
      const unknown=(await db.query<Row>(`SELECT * FROM worker_operations WHERE intent_id=$1 AND status='uncertain' ORDER BY id LIMIT 1`,[this.ctx.intentID])).rows[0];
      if(unknown){this.recoveryBlocked=true;throw new OperationUncertainError(Number(unknown.id));}
      if(old?.status==='retry_allowed')await db.query("UPDATE worker_operations SET status='superseded' WHERE id=$1",[old.id]);
      const r=await db.query(`INSERT INTO worker_operations(task_id,intent_id,execution_id,tool_call_id,tool_name,fingerprint,status,previous_id)
        VALUES($1,$2,$3,$4,$5,$6,'running',$7) RETURNING id`,[this.ctx.taskID,this.ctx.intentID,this.executionID,callID,tool,fingerprint,old?.status==='retry_allowed'?old.id:null]);
      return {id:Number(r.rows[0]!.id)};
    });
  }
  async finish(id:number,result:unknown,isError:boolean){
    await this.ctx.db.transaction(async db=>{
      await this.owned(db);await this.epoch(db);
      const terminal=terminalResult(result);
      const r=await db.query(`UPDATE worker_operations SET status='returned',result=$3::jsonb,is_error=$4,finished_at=now(),
        volatile=(tool_name IN ('shell_open','shell_send') AND $5),terminal_id=$6
        WHERE id=$1 AND execution_id=$2 AND status='running' RETURNING id`,[id,this.executionID,JSON.stringify(result),isError,terminal.running!==false&&terminal.closed!==true,terminal.session_id??null]);
      if(!r.rowCount)throw new Error('操作记录已失效，不能确认结果');
      if(terminal.session_id&&(terminal.running===false||terminal.closed===true))
        await db.query('UPDATE worker_operations SET volatile=false WHERE intent_id=$1 AND terminal_id=$2 AND status=$3',[this.ctx.intentID,terminal.session_id,'returned']);
    });
  }
  async observeTerminal(result:unknown){
    const terminal=terminalResult(result);
    if(!terminal.session_id||terminal.running!==false&&terminal.closed!==true)return;
    await this.ctx.db.transaction(async db=>{
      await this.owned(db);await this.epoch(db);
      await db.query("UPDATE worker_operations SET volatile=false WHERE intent_id=$1 AND terminal_id=$2 AND status='returned'",[this.ctx.intentID,terminal.session_id]);
    });
  }
  async uncertain(id:number){
    this.recoveryBlocked=true;
    // No successor's receipt may be changed by a late executor. This transition only removes certainty.
    await this.ctx.db.query(`UPDATE worker_operations SET status='uncertain',finished_at=now()
      WHERE id=$1 AND execution_id=$2 AND status='running'`,[id,this.executionID]);
  }
}

export async function readOperations(ctx:ToolRunContext,args:{intent_id?:number;after?:number;limit?:number;id?:number}={}){
  if(!['worker','planner','mainagent'].includes(ctx.role))throw new Error('当前角色不能读取 Worker 操作记录');
  const intentID=ctx.role==='worker'?ctx.intentID:args.intent_id;
  if(ctx.role==='worker'&&!intentID)throw new Error('Worker 缺少当前意图');
  for(const n of [args.intent_id,args.limit,args.id])if(n!==undefined&&(!Number.isSafeInteger(n)||n<=0))throw new Error('无效操作查询参数');
  if(ctx.role==='worker'&&args.intent_id!==undefined&&args.intent_id!==ctx.intentID)throw new Error('Worker 只能读取自己的操作记录');
  if(intentID){const n=await contextNode(ctx,intentID);if(n.kind!=='intent'||n.taskID!==ctx.taskID)throw new Error('操作记录只属于当前任务的意图');}
  const limit=Math.min(50,Math.max(1,args.limit??10)),after=args.after??0;
  if(!Number.isSafeInteger(after)||after<0)throw new Error('无效操作游标');
  const rows=(await ctx.db.query(`SELECT id,intent_id,tool_name,status,is_error,replayed,started_at,finished_at,previous_id${args.id?',result':''}
    FROM worker_operations WHERE task_id=$1 AND ($2::bigint IS NULL OR intent_id=$2)
      AND ($3::bigint IS NULL OR id=$3) AND id>$4
      AND EXISTS(SELECT 1 FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
        WHERE n.id=worker_operations.intent_id AND t.id=$1 AND t.deleted_at IS NULL AND exploration_node_readable(n.exploration_id,n.id))
      ORDER BY id LIMIT $5`,
    [ctx.taskID,intentID??null,args.id??null,after,limit+1])).rows;
  const items=rows.slice(0,limit).map(r=>({...r,ref:`operation:${r.id}`,id:Number(r.id),intent_id:Number(r.intent_id)}));
  return {items,next_cursor:rows.length>limit?items.at(-1)!.id:null,
    note:'工具返回与事实发布是不同状态；操作记录不会自动创建事实。uncertain 必须核对后才能继续，不能根据摘要猜测成功。'};
}

/** Explicit operator action, never called by an Agent. Requires a quiescent paused task. */
export async function resolveOperation(db:Database,taskID:number,id:number,outcome:'confirmed'|'retry_allowed',reason:string,actor:string){
  if(!['confirmed','retry_allowed'].includes(outcome)||!reason?.trim()||reason.length>2000)throw new Error('核对需要有效结论及不超过 2000 字的理由');
  return db.transaction(async tx=>{
    const task=(await tx.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskID])).rows[0];
    if(!task?.paused)throw new Error('仅可核对已暂停且执行器退出的任务');
    const active=await tx.query(`SELECT 1 FROM engine_task_leases WHERE task_id=$1 AND expires_at>now()
      UNION ALL SELECT 1 FROM engine_worker_slots WHERE task_id=$1 LIMIT 1`,[taskID]);
    if(active.rowCount)throw new Error('等待执行器退出后再核对');
    const row=(await tx.query<Row>('SELECT * FROM worker_operations WHERE task_id=$1 AND id=$2 FOR UPDATE',[taskID,id])).rows[0];
    if(!row)throw new Error('当前任务没有该操作记录');
    if(row.status===outcome)return {ref:`operation:${id}`,status:outcome,changed:false};
    if(!['running','uncertain','returned'].includes(row.status))throw new Error('操作已核对，不能覆盖后续状态');
    if((await tx.query('SELECT 1 FROM worker_operations WHERE intent_id=$1 AND fingerprint=$2 AND id>$3 LIMIT 1',[row.intent_id,row.fingerprint,id])).rowCount)
      throw new Error('已有更新的操作记录，请读取最新记录后核对');
    await tx.query('INSERT INTO worker_operation_resolutions(operation_id,actor,outcome,reason,previous_status) VALUES($1,$2,$3,$4,$5)',[id,actor,outcome,reason.trim(),row.status]);
    await tx.query('UPDATE worker_operations SET status=$2,finished_at=now() WHERE id=$1',[id,outcome]);
    return {ref:`operation:${id}`,status:outcome,changed:true,resumed:false};
  });
}
