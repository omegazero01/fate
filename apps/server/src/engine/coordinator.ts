import {randomUUID} from 'node:crypto';
import type {Database} from '../db/index.js';
const ADMISSION_LOCK=4_200_000_001, WORKER_LOCK=4_200_000_002;
export async function executionSnapshot(db:Database,taskID:number) {
  const limit=Math.min(128,Math.max(1,Number(await db.platform().getSetting('workers'))||3));
  const rows=(await db.query(`SELECT s.task_id,s.phase,s.manual,n.payload ? 'execution_result' committed FROM engine_worker_slots s
    JOIN engine_task_leases l ON l.task_id=s.task_id AND l.token=s.token AND l.expires_at>clock_timestamp()
    LEFT JOIN exploration_nodes n ON n.id=s.intent_id`)).rows;
  const own=rows.filter(r=>Number(r.task_id)===taskID);
  return {policy:'blackboard-v1',limit_scope:'task' as const,limit,global_active:rows.filter(r=>r.phase==='running').length,
    task_active:own.filter(r=>r.phase==='running').length,exiting:own.filter(r=>r.phase==='running'&&r.committed).length,
    ready:own.filter(r=>r.phase==='ready').length,planning:own.filter(r=>r.phase==='planning').length,
    available:Math.max(0,limit-own.filter(r=>r.phase==='running').length)};
}
export class Coordinator {
  readonly owner=randomUUID();
  constructor(private db:Database,private defaultWorkers:number){}
  async workers(db=this.db){const value=await db.platform().getSetting('workers');return Math.min(128,Math.max(1,Number(value)||this.defaultWorkers));}
  /** Caller holds the global admission lock before task/node locks. */
  async admit(tx:Database,taskID:number,bootstrap=false){
    await tx.query('SELECT pg_advisory_xact_lock($1)',[ADMISSION_LOCK]);
    const task=(await tx.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskID])).rows[0];
    if(!task)throw Object.assign(new Error('task not found'),{statusCode:404});
    const settings=await tx.query(`SELECT key,value FROM settings WHERE key IN ('task_concurrency_enabled','task_concurrency_limit')`);
    const values=Object.fromEntries(settings.rows.map(r=>[r.key,r.value]));
    const limit=values.task_concurrency_enabled==='true'?Math.max(1,Number(values.task_concurrency_limit)||5):Infinity;
    const active=await tx.query(`SELECT count(*) n FROM tasks WHERE id<>$1 AND status='running' AND NOT paused AND NOT queued AND deleted_at IS NULL`,[taskID]);
    const older=await tx.query(`SELECT id FROM tasks WHERE queued AND NOT paused AND deleted_at IS NULL AND id<>$1 AND (queued_at,id)<(COALESCE($2::timestamptz,now()),$1::bigint) LIMIT 1`,[taskID,task.queued_at]);
    const alreadyActive=task.status==='running'&&!task.paused&&!task.queued;
    const queued=!alreadyActive&&(Number(active.rows[0]?.n)>=limit||(limit!==Infinity&&older.rows.length>0));
    await tx.query(`UPDATE tasks SET status='running',paused=false,queued=$2,queued_at=CASE WHEN $2 THEN COALESCE(queued_at,now()) ELSE NULL END,
      queue_mode=CASE WHEN $3 THEN 'bootstrap' ELSE queue_mode END,completed_at=NULL,
      first_run_at=CASE WHEN status='timeout' THEN NULL ELSE first_run_at END,
      deadline_at=CASE WHEN status='timeout' THEN NULL WHEN NOT $2 AND paused_at IS NOT NULL THEN deadline_at+(now()-paused_at) ELSE deadline_at END,paused_at=CASE WHEN $2 THEN COALESCE(paused_at,now()) ELSE NULL END WHERE id=$1`,[taskID,queued,bootstrap]);
    // An explicit resume supersedes a pause that has not yet been acknowledged by
    // its executor. Leaving it pending lets a later scheduler pass stop a session
    // after the task has already resumed.
    if(task.paused===true)await tx.query(`UPDATE runtime_task_commands SET status='acknowledged',acknowledged_at=now(),detail='superseded by explicit task resume'
      WHERE task_id=$1 AND command='pause' AND status='pending'`,[taskID]);
    return !queued;
  }
  async promote(){
    return this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock($1)',[ADMISSION_LOCK]);
      const settings=await tx.query(`SELECT key,value FROM settings WHERE key IN ('task_concurrency_enabled','task_concurrency_limit')`);
      const values=Object.fromEntries(settings.rows.map(r=>[r.key,r.value]));
      const limit=values.task_concurrency_enabled==='true'?Math.max(1,Number(values.task_concurrency_limit)||5):10000;
      const active=await tx.query(`SELECT count(*) n FROM tasks WHERE status='running' AND NOT paused AND NOT queued AND deleted_at IS NULL`);
      const count=Math.max(0,limit-Number(active.rows[0]?.n));
      const rows=await tx.query(`UPDATE tasks SET queued=false,queued_at=NULL,deadline_at=CASE WHEN paused_at IS NOT NULL THEN deadline_at+(now()-paused_at) ELSE deadline_at END,paused_at=NULL WHERE id IN (SELECT id FROM tasks WHERE queued AND NOT paused AND deleted_at IS NULL ORDER BY queued_at,id LIMIT $1 FOR UPDATE) RETURNING id`,[count]);
      return rows.rows.map(r=>Number(r.id));
    });
  }
  async acquire(taskID:number){
    const token=randomUUID();
    const r=await this.db.query(`INSERT INTO engine_task_leases(task_id,owner,token,expires_at) VALUES($1,$2,$3,now()+interval '15 seconds')
      ON CONFLICT(task_id) DO UPDATE SET owner=$2,token=$3,expires_at=now()+interval '15 seconds'
      WHERE engine_task_leases.expires_at<now() RETURNING token`,[taskID,this.owner,token]);
    return r.rows[0]?.token as string|undefined;
  }
  async renew(taskID:number,token:string){
    const r=await this.db.query(`UPDATE engine_task_leases SET expires_at=now()+interval '15 seconds' WHERE task_id=$1 AND owner=$2 AND token=$3 AND expires_at>now() RETURNING token`,[taskID,this.owner,token]);
    if(!r.rowCount)throw new Error('任务执行租约已失效');
  }
  async assert(taskID:number,token:string,tx=this.db){
    const r=await tx.query(`SELECT token FROM engine_task_leases WHERE task_id=$1 AND owner=$2 AND token=$3 AND expires_at>clock_timestamp() FOR SHARE`,[taskID,this.owner,token]);
    if(!r.rowCount)throw new Error('任务执行租约已失效');
  }
  async release(taskID:number,token:string){await this.db.query('DELETE FROM engine_worker_slots WHERE task_id=$1 AND token=$2',[taskID,token]);await this.db.query('DELETE FROM engine_task_leases WHERE task_id=$1 AND owner=$2 AND token=$3',[taskID,this.owner,token]);}
  /** Serialize reservations across instances, including explicit resumes. Acquire before graph locks. */
  async lockWorkerCapacity(tx:Database){await tx.query('SELECT pg_advisory_xact_lock($1)',[WORKER_LOCK]);}
  /** Only this task's actual executions consume its capacity. Planning never reserves slots. */
  async workerSlot(taskID:number,token:string){
    return this.db.transaction(tx=>this.reserveWorkerSlot(tx,taskID,token));
  }
  /** Also used in the manual-resume transaction so state and occupancy commit together. */
  async reserveWorkerSlot(tx:Database,taskID:number,token:string,manual=false,intentID?:number){
    await this.lockWorkerCapacity(tx);
    await this.assert(taskID,token,tx);
    const task=await tx.tasks().getTask(taskID);
    if(!task||task.status!=='running'||task.paused||task.queued)return undefined;
    await tx.query(`DELETE FROM engine_worker_slots s WHERE NOT EXISTS(SELECT 1 FROM engine_task_leases l WHERE l.task_id=s.task_id AND l.token=s.token AND l.expires_at>now())`);
    const active=Number((await tx.query("SELECT count(*) n FROM engine_worker_slots WHERE task_id=$1 AND phase='running'",[taskID])).rows[0]?.n);
    if(active>=await this.workers(tx))return undefined;
    const id=randomUUID();
    await tx.query("INSERT INTO engine_worker_slots(id,task_id,token,phase,manual,intent_id) VALUES($1,$2,$3,'running',$4,$5)",[id,taskID,token,manual,intentID??null]);
    return id;
  }
  async releaseSlot(id:string){await this.db.query('DELETE FROM engine_worker_slots WHERE id=$1',[id]);}

}
