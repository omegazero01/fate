import {streamChanges} from './stream-changes.js';
import {pendingPlannerWakeups,plannerWakeupReady} from './planner-wakeup.js';
import {goalsBootstrap} from '../db/goals-bootstrap.js';
import {blackboardRevision,markWorkerReleased,recoverWorkerSettlements} from '../db/worker-drafts.js';
import {LiveStreamWriter,runnerActivityMetadata} from './live-stream.js';
import {recoverExpiredRuntimes} from './runtime-config.js';
import {workerStopReceipt,failureReason,type WorkerStopReason} from './worker-outcome.js';
import {ConversationService} from './conversations.js';
import {normalizeContract,validateResult,type IntentResult} from '../agent/intent-contract.js';
import {validateResultEvidence} from '../tools/coordination.js';
import {randomUUID} from 'node:crypto';
import {pendingPlannerContext,acknowledgePlannerContext} from '../db/planner-context.js';
import {TriggerScheduler} from './triggers.js';
import {acquireSessionLease} from './session-lease.js';
import {leaseWatchdog} from './lease-watchdog.js';

import type {ChatImage} from "../evidence/attachments.js";
import { Coordinator } from "./coordinator.js";
import { compactColdGraph } from "../agent/coldgraph.js";
// Event-driven task scheduler. Database intents own dispatch and claim state;
// pi sessions own model/tool execution. Chat sessions never implicitly start worker pools.

import { EventEmitter } from "node:events";
import type { Database } from "../db/index.js";
import type { RunnerActivity } from "../pi/runner.js";
import type { ModelSource } from "../agent/roles.js";
import {
  runPlannerRound, runWorkerIntent, runMainChat, runGoalsDecompose,
  type WorkerRunResult,
} from "../agent/roles.js";
import { TodoStore } from "../tools/context.js";
import { PLANNER_TASK_TIMEOUT_WRAPUP } from "../agent/prompts.js";

export interface EngineConfig {
  workers: number;
  debounceMs: number;
  heartbeatMs: number;
  workerMaxTurns: number;
  workerMaxDurationMs: number;
  plannerMaxTurns: number;
  mainMaxTurns: number;
}

export function defaultEngineConfig(): EngineConfig {
  return {
    workers: 3,
    debounceMs: 800,
    heartbeatMs: 600_000,
    workerMaxTurns: 30,
    workerMaxDurationMs: 20 * 60_000,
    plannerMaxTurns: 4,
    mainMaxTurns: 15,
  };
}

/** worker 被中断的原因（终态映射依据，对齐 Go cancelcause）。 */
export type AbortCause = "pause" | "cancel" | "kill" | "task-timeout" | "stop" | "lease-lost" | "task-completed" | "task-ended" | "shutdown";

interface WorkHandle {
  turnID: string;
  abort: (cause: AbortCause, detail?:string) => Promise<void>;
  runner:Promise<{steer(message:string):Promise<void>}>;
  settled?: boolean;
  done: Promise<void>;
  cause?: AbortCause;
}

interface TaskRuntime {
  lease?: string;
  workerCount: number;
  workerNames:Set<string>;
  executions: Set<Promise<void>>;
  plannerReserved: boolean;
  ready: boolean;
  taskID: number;
  expID: number;
  triggers: string[];
  work: Map<number, WorkHandle>;
  plannerBusy: Promise<unknown> | null;
  stopped: boolean;
  paused: boolean;
  settling: boolean;
  loops: Promise<void>[];
  todos: TodoStore;
  /** 单槽唤醒信号量：notify() 置位并唤醒；waitNotify 先消费再等待——防"waiter 注册前 notify 被丢"竞态。 */
  notifyPending: boolean;
  notifyWaiters: Array<() => void>;
  workerWaiters: Array<() => void>;
  started: boolean;
  workerRevision: number;
  plannerAbort?: AbortController;
  activityTail: Promise<unknown>;
}

export type EngineActivity = {
  metadata?: Record<string,unknown>;
  taskID: number;
  expID: number;
  nodeID?: number | null;
  worker?: string;
  kind: string;
  tool?: string;
  isError?: boolean;
  summary?: string;
  detail?: string;
  toolCallId?: string;
  mainSeg?: number;
  streamID?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** 模型来源解析（引擎不感知 provider 细节；测试注入 faux）。 */
export type ModelResolver = (taskID: number, role: string, context?: {conversationID?:number;profileID?:number}) => Promise<ModelSource>;

export class Engine {

  readonly conversations:ConversationService;
  private triggerScheduler:TriggerScheduler;
  readonly bus = new EventEmitter(); // activity 广播（M5 SSE 接这里）
  private tasks = new Map<number, TaskRuntime>();
  private loading = new Map<number, Promise<TaskRuntime>>();
  private starting = new Map<number, Promise<void>>();
  private coordinator: Coordinator;
  private scheduler?: ReturnType<typeof setInterval>;
  private pumping = false;
  private closing = false;
  private dispatching = false;
  private dispatchWatchdog?:ReturnType<typeof setInterval>;
  private dispatchTimer?: ReturnType<typeof setTimeout>;
  private dispatchCursor = 0;
  private plannerQueue = new Map<number,{rt:TaskRuntime;resolve:(granted:boolean)=>void;terminal:boolean}>();
  private plannerPumping = false;

  runtimeMetrics(){return {tasks:this.tasks.size,worker_executions:[...this.tasks.values()].reduce((n,r)=>n+r.executions.size,0),
    planners:[...this.tasks.values()].filter(r=>r.plannerReserved).length,planner_queue:this.plannerQueue.size,claim_dispatchers:Number(this.dispatching),...this.coordinator.metrics()};}
  private ensureDispatchWatchdog(){
    if(this.dispatchWatchdog)return;
    this.dispatchWatchdog=setInterval(()=>{
      if(![...this.tasks.values()].some(rt=>rt.started&&!rt.stopped)&&!this.plannerQueue.size){clearInterval(this.dispatchWatchdog);this.dispatchWatchdog=undefined;return;}
      this.scheduleDispatch();
    },1000);this.dispatchWatchdog.unref();
  }
  private scheduleDispatch(){
    if(this.closing||this.dispatchTimer)return;
    this.dispatchTimer=setTimeout(()=>{this.dispatchTimer=undefined;void this.dispatchWorkers().catch(()=>{});void this.pumpPlanners().catch(()=>{});},25);
    this.dispatchTimer.unref();
  }
  private trackExecution(rt:TaskRuntime,run:Promise<void>){
    rt.executions.add(run);
    void run.finally(()=>{rt.executions.delete(run);this.scheduleDispatch();}).catch(()=>{});
  }
  private acquirePlanner(rt:TaskRuntime,terminal=false):Promise<boolean>{
    return new Promise(resolve=>{this.plannerQueue.set(rt.taskID,{rt,resolve,terminal});this.scheduleDispatch();});
  }
  private async pumpPlanners(){
    if(this.plannerPumping||this.closing)return;this.plannerPumping=true;
    try{for(const [id,item] of this.plannerQueue){
      const {rt,resolve,terminal}=item;
      if(rt.stopped||rt.paused||(!terminal&&rt.settling)){this.plannerQueue.delete(id);resolve(false);continue;}
      if(rt.plannerReserved)continue;
      if(!rt.lease||!await this.coordinator.plannerSlot(id,rt.lease))break;
      this.plannerQueue.delete(id);rt.plannerReserved=true;resolve(true);
    }}finally{this.plannerPumping=false;}
  }
  private async releasePlanner(rt:TaskRuntime){
    try{if(rt.lease)await this.coordinator.releasePlanner(rt.taskID,rt.lease);}finally{rt.plannerReserved=false;this.scheduleDispatch();}
  }
  private trackLoop(rt:TaskRuntime,loop:Promise<void>){
    rt.loops.push(loop);void loop.finally(()=>{rt.loops=rt.loops.filter(p=>p!==loop);}).catch(()=>{});
  }
  private async evictIdleRuntimes(){
    for(const [id,rt] of this.tasks){
      if((rt.started&&!rt.stopped)||rt.loops.length||rt.executions.size||rt.plannerReserved||this.starting.has(id)||[...this.chats.keys()].some(k=>k.startsWith(`${id}:`)))continue;
      const tail=rt.activityTail;await tail.catch(()=>{});
      if(tail===rt.activityTail&&!rt.started&&!rt.executions.size&&!this.starting.has(id)&&![...this.chats.keys()].some(k=>k.startsWith(`${id}:`)))this.tasks.delete(id);
    }
  }
  private chats = new Map<string, { controller: AbortController; done: Promise<string> }>();

  private async loadRuntime(taskID: number): Promise<TaskRuntime> {
    const current = this.tasks.get(taskID);
    if (current) return current;
    const loading = this.loading.get(taskID);
    if (loading) return loading;
    const promise = (async () => {
      const task = await this.db.tasks().getTask(taskID);
      if (!task) throw new Error(`任务 #${taskID} 不存在`);
      const rt: TaskRuntime = {
        taskID, ready: false, workerCount: 0, workerNames:new Set(), executions:new Set(), plannerReserved:false, expID: task.exploration_id, triggers: [], work: new Map(),
        plannerBusy: null, stopped: false, paused: task.paused === true || task.status === "paused",
        settling: false, loops: [], todos: new TodoStore(this.db), notifyPending: false,
        notifyWaiters: [], workerWaiters: [], started: false, workerRevision: 0, activityTail: Promise.resolve(),
      };
      await rt.todos.load(rt.expID);
      this.tasks.set(taskID, rt);
      return rt;
    })();
    this.loading.set(taskID, promise);
    try { return await promise; } finally { this.loading.delete(taskID); }
  }

  constructor(
    private db: Database,
    private cfg: EngineConfig,
    private modelResolver: ModelResolver,
    private dataDir: string,
    /** 出口网关地址（如 127.0.0.1:8788）；worker 的 bash 经它做任务级出口授权。 */
    private egressAddr?: string,
  ) {
    this.bus.setMaxListeners(100);
    this.coordinator = new Coordinator(db,cfg.workers);
    this.conversations=new ConversationService(db,modelResolver,dataDir,this,egressAddr);
    this.triggerScheduler=new TriggerScheduler(db);

  }

  // ─── 任务运行时 ───────────────────────────────────────────────────────────

  private rt(taskID: number): TaskRuntime | undefined {
    return this.tasks.get(taskID);
  }

  private mustRt(taskID: number): TaskRuntime {
    const t = this.tasks.get(taskID);
    if (!t) throw new Error(`任务 #${taskID} 未在引擎中运行`);
    return t;
  }

  /** 启动任务：goals 分解（可选）→ plannerLoop + worker 池。幂等（重复 Run 只踢一轮规划）。 */
  async run(taskID: number, opts: { decompose?: { description: string } } = {}): Promise<void> {
    const pending = this.starting.get(taskID);
    if (pending) return pending;
    const start = this.startTask(taskID, opts);
    this.starting.set(taskID, start);
    try { await start; } finally { this.starting.delete(taskID); }
  }

  private async startTask(taskID: number, opts: { decompose?: { description: string } }): Promise<void> {
    const rt = await this.loadRuntime(taskID);
    let persisted = await this.db.tasks().getTask(taskID);
    if(persisted?.status==='created'){await this.db.transaction(tx=>this.coordinator.admit(tx,taskID,!!opts.decompose));persisted=await this.db.tasks().getTask(taskID);}
    if (!persisted || persisted.paused || persisted.queued || ['done','failed','timeout'].includes(persisted.status)) return;
    if(!opts.decompose && (persisted.queue_mode==='bootstrap'||['constraints','objectives'].includes((await goalsBootstrap(this.db,taskID))?.phase??'')))opts={decompose:{description:persisted.description}};
    if (rt.started && !rt.stopped) { this.notify(taskID); return; }
    if (rt.stopped) await Promise.allSettled(rt.loops);
    rt.lease = await this.coordinator.acquire(taskID);
    if (!rt.lease) return;
    rt.stopped = false;
    rt.settling = false;
    rt.started = true;
    rt.paused = false;
    rt.loops = [];
    rt.workerCount = 0; rt.ready=false;
    const stopLeaseWatchdog=leaseWatchdog(
      ()=>this.coordinator.renew(rt.taskID,rt.lease!),
      ()=>{rt.stopped=true;rt.plannerAbort?.abort("lease-expired");void this.cancelAllWorks(rt,"lease-lost");},
    );
    this.trackLoop(rt,(async()=>{while(!rt.stopped)await this.waitWorker(rt,1000,rt.workerRevision);stopLeaseWatchdog();})());
    try {
    // Recover durable completion notifications, then replan unclaimed automatic work.
    await recoverWorkerSettlements(this.db,rt.expID);
    await this.db.query("INSERT INTO blackboard_wakeups(exploration_id,event_key,kind) VALUES($1,$2,'bootstrap') ON CONFLICT DO NOTHING",[rt.expID,`bootstrap:${rt.lease}`]);
    // 重启恢复：running 意图回 open（无在跑 worker 的僵尸态）。
    await this.db.transaction(async db=>{
      await this.coordinator.assert(rt.taskID,rt.lease!,db);
      await db.exploration(rt.expID).resetRunningIntents();
    });

    if (opts.decompose) {
      rt.plannerAbort = new AbortController();
      await (async () => {
      const model = await this.modelFor(rt, "goals");
      if(!model){if(await goalsBootstrap(this.db,taskID))throw new Error("未配置 Goals 模型");return;}
      const turn=this.beginActivityTurn(rt,{worker:"goals"});
      return runGoalsDecompose({
        turnID:turn.turnID,
        db: this.db, taskID, expID: rt.expID, model, dataDir: this.dataDir,
        description: opts.decompose!.description, signal: rt.plannerAbort!.signal, hooks:this.engineHooks(rt),onActivity:turn.onActivity,
      }).then(result=>{this.emitActivity(taskID,{worker:'goals',kind:'result',metadata:{...turn.metadata,event_type:'lifecycle',status:result.aborted?'stopped':'completed'},summary:result.aborted?'目标分解已停止':'目标分解完成'});return result;})
      .catch(error=>{this.emitActivity(taskID,{worker:'goals',kind:'result',metadata:{...turn.metadata,event_type:'lifecycle',status:'failed'},isError:true,summary:String(error)});throw error;})
      .finally(()=>turn.finish());
      })().catch(async (err) => {
        this.emitActivity(taskID, { kind: "result", worker: "system", summary: `目标分解失败：${err instanceof Error ? err.message : String(err)}` });
        if(await goalsBootstrap(this.db,taskID)){
          if(!rt.stopped&&!rt.plannerAbort?.signal.aborted)await this.db.tasks().applyTaskPause(taskID);
          rt.paused=true;
        }
      });
      if(rt.stopped||rt.paused||rt.plannerAbort?.signal.aborted){rt.started=false;rt.stopped=true;stopLeaseWatchdog();if(rt.lease)await this.coordinator.release(taskID,rt.lease);return;}
      // ARTEX 同款兜底：分解失败/空产出时规则拆分——goal 节点必须存在，
      // 否则 goalless 判定会把任务立即误判为「frontier 已抽干」而结束。
      const s = this.db.exploration(rt.expID);
      const goalCount = (await s.listByKind("goal", 5)).length;
      if (goalCount === 0 && !(await goalsBootstrap(this.db,taskID))) {
        const fallbackGoal = await s.addGoal({ text: (await this.db.tasks().getTask(taskID))?.goal ?? opts.decompose.description }, "system");
        const origin = await s.originFactID();
        if (origin > 0) await s.link(origin, "spawns", fallbackGoal);
        this.emitActivity(taskID, { kind: "result", worker: "system", summary: "目标分解未产出，已回退规则拆分（整体目标兜底）" });
      }
    }

    await this.db.query("UPDATE tasks SET queue_mode='' WHERE id=$1",[taskID]);
    if (rt.stopped) return;
    const supervise = (name: string, loop: () => Promise<void>) => (async () => {
      while (!rt.stopped) {
        try { await loop(); return; }
        catch (err) {
          this.emitActivity(taskID, { kind: "result", worker: "system", isError: true, summary: `${name}异常：${String(err)}` });
          await this.waitWorker(rt, 1000, rt.workerRevision);
        }
      }
    })();
    rt.ready=true;this.ensureDispatchWatchdog();
    this.trackLoop(rt,supervise("planner", () => this.plannerLoop(rt)));
    this.trackLoop(rt,supervise("deadline", () => this.deadlineLoop(rt)));
    this.trackLoop(rt,supervise("state",async()=>{while(!rt.stopped){await this.maintainRuntime(rt);await new Promise(resolve=>setTimeout(resolve,1000));}}));
    this.notify(taskID);
    } catch (err) {
      rt.started = false; rt.stopped = true;
      if(rt.lease)await this.coordinator.release(taskID,rt.lease);
      this.emitActivity(taskID, { kind: "result", worker: "system", isError: true, summary: `任务启动失败：${String(err)}` });
      throw err;
    }
  }

  /** Startup recovery and FIFO promotion are idempotent across server instances. */
  startScheduler():void {
    if(this.scheduler)return;
    this.scheduler=setInterval(()=>void this.pumpScheduler().catch(()=>{}),1000);this.scheduler.unref();
    void this.pumpScheduler().catch(()=>{});
  }
  private async pumpScheduler(){
    if(this.pumping||this.closing)return;this.pumping=true;
    try{
      this.scheduleDispatch();
      await this.evictIdleRuntimes();
      await recoverExpiredRuntimes(this.db);
      await this.coordinator.promote();
      await this.triggerScheduler.tick();

      await this.conversations.pump();
      const rows=await this.db.query(`SELECT id,description,queue_mode FROM tasks WHERE status='running' AND NOT paused AND NOT queued AND deleted_at IS NULL ORDER BY created_at,id`);
      for(const row of rows.rows){
        const id=Number(row.id);
        if(this.starting.size<4&&(!this.rt(id)?.started||this.rt(id)?.stopped)&&!this.starting.has(id))void this.run(id,row.queue_mode==='bootstrap'?{decompose:{description:String(row.description??'')}}:{}).catch(()=>{});
      }
      const pending=await this.db.query('SELECT DISTINCT task_id FROM worker_feedback_delivery WHERE NOT published');
      for(const row of pending.rows)await this.publishFeedback(Number(row.task_id));
      const pauses=await this.db.query(`SELECT DISTINCT task_id FROM runtime_task_commands WHERE command='pause' AND status='pending' ORDER BY task_id`);
      for(const row of pauses.rows)await this.reconcilePauseWithoutOwner(Number(row.task_id));
    }finally{this.pumping=false;}
  }
  private async hasActiveTaskLease(taskID:number){
    return !!(await this.db.control().query('SELECT 1 FROM engine_task_leases WHERE task_id=$1 AND expires_at>now()',[taskID])).rowCount;
  }
  private async hasActiveMainSession(taskID:number){
    return !!(await this.db.control().query("SELECT 1 FROM runtime_session_leases WHERE key LIKE $1 AND expires_at>now() LIMIT 1",[`main:${taskID}:%`])).rowCount;
  }
  private async acknowledgePendingPauses(taskID:number,owner:string|null,detail:string){
    await this.db.control().query(`UPDATE runtime_task_commands SET status='acknowledged',acknowledged_at=now(),executor_owner=$2,detail=$3
      WHERE task_id=$1 AND command='pause' AND status='pending'`,[taskID,owner,detail]);
  }
  private async reconcilePauseWithoutOwner(taskID:number){
    if(await this.hasActiveTaskLease(taskID))return;
    await this.stopMainChat(taskID);
    if(!(await this.hasActiveMainSession(taskID)))await this.acknowledgePendingPauses(taskID,null,'no active task executor; session stop confirmed');
  }
  private maintaining=new Set<number>();
  private async maintainRuntime(rt:TaskRuntime){
    if(rt.stopped||!rt.lease||this.maintaining.has(rt.taskID))return;
    this.maintaining.add(rt.taskID);
    try{
      const task=await this.db.tasks().getTask(rt.taskID);
      if(!task||['done','failed','timeout'].includes(task.status)){
        rt.stopped=true;rt.plannerAbort?.abort('stop');await this.cancelAllWorks(rt,task?.status==='done'?'task-completed':task?.status==='timeout'?'task-timeout':'task-ended');
        await this.coordinator.release(rt.taskID,rt.lease);return;
      }
      if(task.paused||task.queued){
        const enteringPause=!rt.paused;
        rt.paused=true;rt.plannerAbort?.abort('pause');
        // The pause transition cancels existing chats. Later user-driven Main
        // reads/edits on an already paused task must survive the lease heartbeat.
        if(enteringPause)await this.stopMainChat(rt.taskID);
        await this.cancelAllWorks(rt,'pause');await this.starting.get(rt.taskID)?.catch(()=>undefined);
        while(rt.plannerReserved)await new Promise(resolve=>setTimeout(resolve,25));
        const live=(await this.db.control().query('SELECT paused,queued FROM tasks WHERE id=$1',[rt.taskID])).rows[0];
        if(live&&!live.paused&&!live.queued){rt.paused=false;return;}
        if(!(await this.hasActiveMainSession(rt.taskID))){await this.acknowledgePendingPauses(rt.taskID,this.coordinator.owner,'task workers and sessions stopped');rt.started=false;rt.stopped=true;await this.coordinator.release(rt.taskID,rt.lease);this.notify(rt.taskID);return;}
      }
      else if(rt.paused){rt.paused=false;this.notify(rt.taskID);}
      for(const [id,handle] of rt.work){
        const node=await this.db.exploration(rt.expID).getNode(id);
        if(node?.state!=='running'&&!node?.payload.execution_result)await handle.abort(node?.state==='paused'?'cancel':'kill');
      }

    }catch(error){
      // Metadata query failures do not imply lease loss. The isolated watchdog
      // fences the executor only when renewal actually fails or expires.
      this.emitActivity(rt.taskID,{worker:'system',kind:'result',isError:true,summary:`运行状态检查失败，将重试：${String(error)}`});
    }finally{this.maintaining.delete(rt.taskID);}
  }

  // ─── 唤醒原语 ─────────────────────────────────────────────────────────────

  notify(taskID: number, trigger?: string): void {
    const rt = this.rt(taskID);
    if (!rt) return;
    if (trigger){rt.triggers.push('黑板控制状态已变化');void this.db.query("WITH saved AS (INSERT INTO blackboard_wakeups(exploration_id,event_key,kind) VALUES($1,$2,'control_changed') ON CONFLICT DO NOTHING RETURNING id) UPDATE explorations SET published_revision=published_revision+1 WHERE id=$1 AND EXISTS(SELECT 1 FROM saved)",[rt.expID,`control:${randomUUID()}`]).catch(()=>{});}
    rt.notifyPending = true;
    // Local wakeup is only a hint; durable admission and blackboard events decide execution.
    this.wakeWorkers(rt);
    const waiters = rt.notifyWaiters.splice(0);
    for (const w of waiters) w();
  }

  private wakeWorkers(rt: TaskRuntime): void {
    this.scheduleDispatch();
    rt.workerRevision++;
    const waiters = rt.workerWaiters.splice(0);
    for (const w of waiters) w();
  }

  private waitNotify(rt: TaskRuntime, ms: number): Promise<void> {
    if (rt.notifyPending) {
      rt.notifyPending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        rt.notifyWaiters = rt.notifyWaiters.filter((w) => w !== wake);
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        rt.notifyPending = false;
        resolve();
      };
      rt.notifyWaiters.push(wake);
    });
  }

  private waitWorker(rt: TaskRuntime, ms: number, revision: number): Promise<void> {
    if (rt.stopped || revision !== rt.workerRevision) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        rt.workerWaiters = rt.workerWaiters.filter((w) => w !== wake);
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      rt.workerWaiters.push(wake);
    });
  }

  // ─── plannerLoop ──────────────────────────────────────────────────────────

  private async plannerLoop(rt: TaskRuntime): Promise<void> {
    let retryAfter=0,lastPlannedAt=0,lastRevision=-1;
    while (!rt.stopped) {
      // 停滞看门狗：目标未达成且无活跃意图（frontier 空且无在跑）→ 心跳不跳过、缩短重试间隔，
      // 否则一次"空产出轮"会让任务永久停滞（真实验证发现的缺陷：模型违反硬底线时无兜底）。
      let stalled = false;
      {
        const s0 = this.db.exploration(rt.expID);
        const c0 = await s0.executionCounts().catch(() => ({ running: 0, goals: 0, met: 0 }));
        stalled = c0.goals > 0 && c0.met < c0.goals && !(await s0.hasActiveIntent().catch(() => true));
      }
      const settings = await this.db.tasks().getTask(rt.taskID);
      // Poll the durable inbox without invoking an LLM on each poll. Cross-instance
      // facts/checkpoints become visible even if a process-local notification is lost.
      await this.waitNotify(rt, Math.min(5000,stalled ? 120_000 : (settings?.plan_heartbeat_seconds ? settings.plan_heartbeat_seconds * 1000 : this.cfg.heartbeatMs)));
      if (rt.stopped) break;
      // debounce：吸收 800ms 内的突发变更。
      await new Promise((r) => setTimeout(r, this.cfg.debounceMs));
      if (rt.stopped || rt.paused || rt.settling) continue;

      const s = this.db.exploration(rt.expID);
      if (await this.db.tasks().executionMode(rt.expID) === 'manual') continue;
      const counts = await s.executionCounts();

      // Proofs are durable. A crash after prove_goal must not require another
      // model response (or an available model profile) just to commit task done.
      if (counts.goals > 0 && counts.met >= counts.goals) {
        // Preserve B's direct-dispatch semantics: work explicitly queued after
        // proof (or still being recovered) drains before the task closes.
        if (await this.finishTask(rt, "done", "全部目标已证明达成")) break;
        continue;
      }

      // goalless 任务：无开放目标 → planner 不进模型，frontier 抽干即完成。
      if (counts.goals === 0) {
        if (!(await s.hasActiveIntent())) {
          if (await this.finishTask(rt, "done", "无目标任务的 frontier 已抽干")) break;
        }
        continue;
      }
      if(Date.now()<retryAfter)continue;
      const wakeups=await pendingPlannerWakeups(this.db,rt.expID);
      const revision=await blackboardRevision(this.db,rt.expID);
      const heartbeat=Math.max(1,settings?.plan_heartbeat_seconds?settings.plan_heartbeat_seconds*1000:this.cfg.heartbeatMs);
      const inspect=Date.now()-lastPlannedAt>=heartbeat&&(counts.running>0||revision!==lastRevision);
      if(!plannerWakeupReady(wakeups,{now:Date.now(),running:counts.running,hasControl:rt.triggers.length>0,heartbeatDue:inspect}))continue;
      if(!await this.acquirePlanner(rt))continue;
      try{
      if(rt.stopped||rt.paused||rt.settling)continue;
      // Refresh after waiting for capacity; queued rounds acknowledge nothing.
      const wakeups=(await this.db.query('SELECT id,node_id,kind FROM blackboard_wakeups WHERE exploration_id=$1 AND acknowledged_at IS NULL ORDER BY id LIMIT 50',[rt.expID])).rows;
      const revision=await blackboardRevision(this.db,rt.expID);
      // Durable settlement/control events are the wakeup authority, including
      // events whose result contains no new fact. Never discard one by a hash.
      await rt.todos.load(rt.expID);

      const task = await this.db.tasks().getTask(rt.taskID);
      const goal = task?.goal ?? task?.description ?? "";

      await compactColdGraph(this.db, rt.expID);
      if (rt.stopped || rt.paused || rt.settling) continue;
      // Compaction creates graph events too. Snapshot after it so the digest
      // shown in this round is acknowledged with this round's actual delivery.
      const pending=await pendingPlannerContext(this.db,rt.taskID,rt.expID);
      const reasons=[...rt.triggers,
        ...(wakeups.length?[`持久化通知：${wakeups.map(w=>`${w.kind} (#${w.id})`).join('、')}`]:[]),
        ...(pending.ids.length?[`待交付领域变化：${pending.ids.length} 条${pending.more?'（后续仍有分页）':''}`]:[])];
      const triggersText=`【本轮触发】\n${reasons.length?reasons.join('\n'):'心跳巡检（本轮无待交付通知）'}`;
      const model = await this.modelFor(rt, "planner");
      if (!model) continue;
      // Planning itself uses an execution lease and model resources. A Planner
      // that cannot dispatch any work must still be bounded by task timeout.
      if (task) await this.db.tasks().stampFirstRun(rt.taskID, task.timeout_seconds);
      rt.plannerAbort = new AbortController();
      const planningRoundID=randomUUID();
      const triggerCount=rt.triggers.length;
      const turn=this.beginActivityTurn(rt,{worker:"planner"},planningRoundID);
      try {
      let planningSucceeded=false;
      let deliveredContextIDs=pending.ids,deliveredWakeupIDs=wakeups.map(w=>w.id),moreContext=pending.more;
      const round = runPlannerRound({
        planningRoundID,contextEventIDs:pending.ids,changes:pending.changes,events:wakeups.map(w=>({id:Number(w.id),kind:w.kind,ref:w.node_id?`node:${w.node_id}`:null})),egressAddr:this.egressAddr,egressScope:`planner:${rt.lease}`,
        db: this.db, taskID: rt.taskID, expID: rt.expID, goal, model,
        dataDir: this.dataDir, todos: rt.todos, hooks: this.engineHooks(rt),
        triggersText, maxTurns: this.cfg.plannerMaxTurns, signal: rt.plannerAbort.signal,
        onActivity: turn.onActivity,
      });
      rt.plannerBusy = round;
      await round.then(async (r) => {
        const u = r.usage;
        this.emitActivity(rt.taskID, {
          kind: "result", worker: "planner", metadata:{...turn.metadata,event_type:"lifecycle",status:r.aborted?"stopped":"completed"},
          summary: (r.lastAssistantText ?? "规划轮完成").slice(0, 2000),
          ...(u ? { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite } : {}),
        });
        if(!r.aborted && r.stopReason==='completed'){
          planningSucceeded=true;
          deliveredContextIDs=r.deliveredContextIDs??pending.ids;
          deliveredWakeupIDs=r.deliveredWakeupIDs??wakeups.map(w=>w.id);
          moreContext=moreContext||r.moreContext===true;
        }else retryAfter=Date.now()+60_000;
      }).catch((err) => {
        retryAfter=Date.now()+60_000;
        this.emitActivity(rt.taskID, { kind: "result", worker: "planner", metadata:{...turn.metadata,event_type:"lifecycle",status:"failed"}, isError:true, summary: `规划轮失败：${err instanceof Error ? err.message : String(err)}` });
      });
      if(planningSucceeded){
        await this.db.transaction(async db=>{
          await this.coordinator.assert(rt.taskID,rt.lease!,db);
          await acknowledgePlannerContext(db,rt.expID,planningRoundID,deliveredContextIDs);
          await db.query('UPDATE blackboard_wakeups SET acknowledged_at=now() WHERE exploration_id=$1 AND id=ANY($2::bigint[])',[rt.expID,deliveredWakeupIDs]);
        });
        rt.triggers.splice(0,triggerCount);if(moreContext)this.notify(rt.taskID,"继续读取本轮未交付的领域变化");lastPlannedAt=Date.now();lastRevision=revision;retryAfter=0;
      }
      } finally { await turn.finish(); }
      rt.plannerBusy = null;
      }finally{rt.plannerBusy=null;await this.releasePlanner(rt);}

      this.wakeWorkers(rt);

      if (rt.stopped || rt.paused || rt.settling) continue;
      // 收官检查：全部目标 met → done 并取消在跑。
      const after = await s.executionCounts();
      if (after.goals > 0 && after.met >= after.goals) {
        if (await this.finishTask(rt, "done", "全部目标已证明达成")) break;
      }
    }
  }

  // ─── workerLoop ───────────────────────────────────────────────────────────

  private async modelFor(rt: TaskRuntime, role: string): Promise<ModelSource | null> {
    try {
      const enabled = await this.db.query('SELECT enabled FROM agents WHERE key=$1', [role]);
      if (enabled.rows[0]?.enabled === false) return null;
      const model = await this.modelResolver(rt.taskID, role);
      return model;
    }
    catch (err) {
      this.emitActivity(rt.taskID, { kind: "result", worker: role, isError: true, summary: `模型配置不可用：${String(err)}` });
      return null;
    }
  }

  /** One process dispatcher: one claim per task per pass, with no waiting DB locks. */
  private async dispatchWorkers():Promise<void>{
    if(this.dispatching||this.closing)return;this.dispatching=true;
    let claimed=false;
    try{
      const tasks=[...this.tasks.values()].filter(rt=>rt.ready&&rt.started&&!rt.stopped&&!rt.paused&&!rt.settling);
      const limit=await this.coordinator.workers();
      const offset=tasks.length?this.dispatchCursor++%tasks.length:0;
      for(let i=0;i<tasks.length;i++){
        const rt=tasks[(i+offset)%tasks.length]!;
        if(rt.executions.size>=limit||!rt.lease)continue;
        let index=1;while(rt.workerNames.has(`work#${index}`))index++;const name=`work#${index}`;
        try{
          const claim=await this.db.transaction(async db=>{
            // Fast empty check avoids capacity locks and expensive queue snapshots.
            if(!await db.exploration(rt.expID).hasOpenIntent())return null;
            const slot=await this.coordinator.reserveWorkerSlot(db,rt.taskID,rt.lease!);
            if(!slot)return null;
            const locked=(await db.query('SELECT pg_try_advisory_xact_lock($1) locked',[-rt.expID])).rows[0]?.locked;
            const intent=locked?await db.exploration(rt.expID).claimNextWorker(name,n=>n.payload.needs_replanning!==true):null;
            if(!intent){await db.query('DELETE FROM engine_worker_slots WHERE id=$1',[slot]);return null;}
            await db.query('UPDATE engine_worker_slots SET intent_id=$2 WHERE id=$1',[slot,intent.id]);
            return {slot,intent};
          });
          if(!claim)continue;
          claimed=true;rt.workerNames.add(name);
          const execution=(async()=>{
            try{
              if(rt.stopped||rt.paused||rt.settling){await this.db.exploration(rt.expID).compareAndSetIntentState(claim.intent.id,'running','open');return;}
              await this.runOneIntent(rt,claim.intent,name);
            }finally{
              rt.workerNames.delete(name);
              await this.coordinator.releaseSlot(claim.slot);
              await markWorkerReleased(this.db,rt.expID,claim.intent.id);
              await this.publishFeedback(rt.taskID);this.notify(rt.taskID);
            }
          })().catch(error=>{this.emitActivity(rt.taskID,{worker:name,kind:'result',isError:true,summary:String(error)});});
          this.trackExecution(rt,execution);
        }catch(error){this.emitActivity(rt.taskID,{worker:'system',kind:'result',isError:true,summary:`领取失败：${String(error)}`});}
      }
    }finally{this.dispatching=false;if(claimed)this.scheduleDispatch();}
  }

  private async runOneIntent(rt: TaskRuntime, intent: { id: number }, name: string, model?: ModelSource): Promise<void> {
    const s = this.db.exploration(rt.expID);
    const turn=this.beginActivityTurn(rt,{worker:name,intentID:intent.id});
    this.emitActivity(rt.taskID, {
      metadata:turn.metadata, nodeID: intent.id, worker: name, kind: "round",
      summary: `Worker ${name} 领取意图 #${intent.id}`,
    });

    let cause: AbortCause | undefined;
    let stopDetail = '';
    const controller = new AbortController();
    let complete!: () => void;
    let ready!: (runner:{steer(message:string):Promise<void>})=>void;
    const handle: WorkHandle = {
      turnID: turn.turnID,
      runner:new Promise(resolve=>{ready=resolve;}),
      abort: async (c, detail='') => {
        if(controller.signal.aborted)return; // Keep the first actual cancellation cause.
        cause = c;
        stopDetail = detail;
        handle.cause = c;
        controller.abort(c);
      },
      done: new Promise<void>((resolve) => { complete = resolve; }),
    };
    rt.work.set(intent.id, handle);

    let result: WorkerRunResult | null = null;
    let failure: unknown = null;
    try {
      model??=await this.modelFor(rt,'worker')??undefined;
      if(!model)throw new Error('Worker 模型配置不可用');
      const task=await this.db.tasks().getTask(rt.taskID);
      if(task)await this.db.tasks().stampFirstRun(rt.taskID,task.timeout_seconds);
      result = await runWorkerIntent({
        turnID:turn.turnID,
        onRunner:ready,
        db: this.db, taskID: rt.taskID, expID: rt.expID,
        intent: intent as never, workerName: name, model,
        dataDir: this.dataDir,
        maxTurns: this.cfg.workerMaxTurns,
        maxDurationMs: this.cfg.workerMaxDurationMs,
        egressAddr: this.egressAddr,
        egressScope:`worker:${intent.id}:${rt.lease}`,
        hooks: this.engineHooks(rt),
        extraGuard: async g => {
          try { await this.coordinator.assert(rt.taskID,rt.lease!); } catch { return {block:true,reason:"执行租约已失效"}; }
          return;
        },
        onActivity: turn.onActivity,
        signal: controller.signal,
      });
      if(result.failure)failure=new Error(result.failure);
    } catch (err) {
      failure = err;
    }
    handle.settled=true;

    try {
    // 终态映射（对齐 Go runIntent 分类）。
    let terminal = "done";
    let summary = result?.lastAssistantText ?? "";
    const causeReason:Record<AbortCause,WorkerStopReason>={pause:'task_paused',cancel:'intent_paused',kill:'planner_terminated',
      'task-timeout':'task_timeout',stop:'executor_stopped','lease-lost':'lease_lost','task-completed':'task_completed','task-ended':'task_ended',shutdown:'service_shutdown'};
    let reason:WorkerStopReason = cause?causeReason[cause]:failure?failureReason(String(failure)):result?.stopReason==='budget'?(result.budgetReason??'turn_limit'):result?.aborted?'aborted':'completed';
    if(cause==='kill'&&stopDetail.startsWith('mainagent:'))reason='main_terminated';
    if(cause==='kill'&&stopDetail.startsWith('user:'))reason='user_cancelled';
    if (cause === "cancel") terminal = "paused";
    else if (cause === "kill") terminal = "stopped";
    else if (cause === "task-timeout") terminal = "exhausted";
    else if (cause && cause !== 'pause') terminal = "stopped";
    else if (result?.stopReason === "budget") terminal = "exhausted";
    else if (result?.aborted) terminal = "stopped";
    else if (failure) {
      terminal = "blocked";
      summary = failure instanceof Error ? failure.message : String(failure);
    }
    const u = result?.usage;
    await rt.activityTail;
    const activityID=await this.db.transaction(async db=>{
      await this.coordinator.assert(rt.taskID,rt.lease!,db);
      await db.query('SELECT pg_advisory_xact_lock($1)',[-rt.expID]);
      const store=db.exploration(rt.expID);
      const latest=await store.getNode(intent.id);
      if(!latest||latest.owner!==name)return null;
      const checkpoint=(await db.query('SELECT progress FROM worker_checkpoints WHERE intent_id=$1',[intent.id])).rows[0]?.progress;
      if(checkpoint){latest.payload.progress=checkpoint;await db.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('progress',$2::jsonb) WHERE id=$1",[intent.id,JSON.stringify(checkpoint)]);}
      // A persisted control command wins. Record its receipt without overwriting its state.
      const alreadyCommitted=!!latest.payload.execution_result&&latest.payload.collaboration_policy==='blackboard-v1';
      const externallyStopped=latest.state!=='running'&&!alreadyCommitted;
      if(externallyStopped){
        if(!['paused','stopped'].includes(latest.state))return null;
        reason=latest.state==='paused'?'intent_paused':'user_cancelled';
        terminal=latest.state;
      }
      // The final prose response is not the acceptance boundary. Stop, timeout
      // or pause after complete_intent must preserve its already committed
      // result, subject to the same live evidence/version validation.
      let acceptedResult=false;
      if(!externallyStopped && (alreadyCommitted || cause!=='kill' && cause!=='cancel') && latest.payload.execution_result){
        try {
          const accepted=validateResult(latest.payload.execution_result as IntentResult,normalizeContract(latest.payload.contract,String(latest.payload.summary??'')));
          // blackboard-v1 acceptance was committed with publication. Later
          // authorization/version changes affect reads/proofs, not that history.
          if(!alreadyCommitted){
            const versions=await validateResultEvidence({db,expID:rt.expID},intent.id,accepted);
            const submitted=latest.payload.execution_result_basis as {node_id:number;version:number}[]|undefined;
            if(!submitted||versions.some(ref=>!submitted.some(old=>old.node_id===ref.node_id&&old.version===ref.version)))throw new Error('结果引用的证据版本已变化');
          }
          terminal=accepted.outcome==='complete'?'done':accepted.outcome==='partial'?'exhausted':'blocked';
          acceptedResult=true;
          if(!cause && !failure && result?.stopReason!=='budget')reason=accepted.outcome==='complete'?'completed':accepted.outcome;
          summary=accepted.summary+(accepted.remaining?`\n恢复位置：${accepted.remaining}`:'');
        } catch(error) {terminal='blocked';reason='invalid_result';summary=`结果验收失败：${error instanceof Error?error.message:String(error)}`;}
      }
      if(result?.settlementReason&&!cause&&!externallyStopped&&!alreadyCommitted){
        terminal='blocked';reason=result.settlementReason;acceptedResult=false;
      }
      if(!cause&&!externallyStopped&&(await db.query("SELECT 1 FROM worker_operations WHERE intent_id=$1 AND status IN ('running','uncertain') LIMIT 1",[intent.id])).rowCount){
        terminal='blocked';reason='operation_uncertain';acceptedResult=false;
        summary='工具执行结果尚未核对，当前意图未确认完成；已保存的事实仍然保留。';
      }
      const receipt=await workerStopReceipt(db,rt.expID,latest,reason,String(turn.metadata.turn_id),stopDetail|| (failure?String(failure):reason==='invalid_result'?summary:''));
      receipt.accepted_result=acceptedResult;
      if (!summary.trim()) summary = receipt.summary;
      else if (reason !== 'completed' && reason !== 'partial' && reason !== 'blocked') summary += `\n执行结束原因：${receipt.summary}`;
      if (reason !== 'completed') summary += `\n已保存事实：${receipt.fact_refs.map(r=>`node:${r.node_id}`).join(', ')||'无'}\n恢复位置：${receipt.recovery}`;
      receipt.summary = summary;
      await db.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('execution_stop',$3::jsonb) WHERE exploration_id=$1 AND id=$2",[rt.expID,intent.id,JSON.stringify(receipt)]);
      // Service replacement interrupts an attempt, not the intent. Preserve its
      // identity/session and bypass stale Planner-basis checks on re-claim.
      // A concurrent explicit pause/cancel always wins over shutdown recovery.
      if(!externallyStopped && !acceptedResult && (cause==='pause'||cause==='shutdown'||cause==='lease-lost')){
        terminal='open';
        await db.query("UPDATE exploration_nodes SET owner='',payload=payload||'{\"resume_requested\":true}'::jsonb WHERE id=$1",[intent.id]);
      }
      const id=await store.appendActivity({node_id:intent.id,worker:name,kind:'result',metadata:{...turn.metadata,status:terminal==='open'?'paused':terminal,event_type:'outcome',execution_stop:receipt},summary:summary||`意图 #${intent.id} ${terminal}`,detail:summary,
        ...(u?{input_tokens:u.input,output_tokens:u.output,cache_read_tokens:u.cacheRead,cache_write_tokens:u.cacheWrite}:{})});
      if(alreadyCommitted)await db.query('UPDATE worker_settlements SET activity_id=$2 WHERE intent_id=$1 AND released_at IS NULL',[intent.id,id]);
      if(!externallyStopped&&!alreadyCommitted)await store.compareAndSetIntentState(intent.id,'running',terminal);
      return id;
    });
    if(activityID===null)return;
    streamChanges.emit('change','task',rt.expID);
    this.bus.emit('activity',{id:activityID,taskID:rt.taskID,expID:rt.expID,nodeID:intent.id,worker:name,kind:'result',summary,detail:summary});
    // Completion notification follows slot release; findings may notify earlier.
    } catch(error) {
      // A fenced executor cannot mutate graph state. Keep an append-only attempt
      // receipt for diagnosis; the new lease owner handles recovery and feedback.
      if(cause==='lease-lost' || /租约/.test(String(error))) {
        await s.appendActivity({node_id:intent.id,worker:name,kind:'status',summary:'执行租约失效，旧执行器已停止；由新执行器恢复',metadata:{...turn.metadata,event_type:'lifecycle',status:'stopped',stop_reason:'lease_lost'}});
      } else throw error;
    } finally {
      await turn.finish();
      rt.work.delete(intent.id);
      complete();
    }
  }

  // ─── 控制面 ───────────────────────────────────────────────────────────────

  /** All explicit starts/resumes/dispatches share admission and task-clock semantics. */
  async admitTask(taskID: number, opts: { decompose?: { description: string } } = {}): Promise<boolean> {
    const admitted=await this.db.transaction(tx=>this.coordinator.admit(tx,taskID,!!opts.decompose));
    if(!admitted)return false;
    const rt = this.rt(taskID);
    if (rt?.started && !rt.stopped) { rt.paused = false; this.notify(taskID); this.wakeWorkers(rt); }
    else if(opts.decompose)void this.run(taskID,opts).catch(()=>{});
    else await this.run(taskID, opts);
    return true;
  }

  async controlIntent(taskID: number, intentID: number, action: 'pause'|'resume'|'cancel'|'delete', reason = '') {
    const task = await this.db.tasks().getTask(taskID);
    if (!task) throw Object.assign(new Error('task not found'), { statusCode: 404 });
    if (action === 'resume') return this.resumeWorker(taskID, intentID);
    const state = action === 'pause' ? 'paused' : 'stopped';
    await this.db.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock($1)', [-task.exploration_id]);
      const n = await db.exploration(task.exploration_id).getNode(intentID);
      if (!n || n.kind !== 'intent') throw Object.assign(new Error('intent not found'), { statusCode: 404 });
      if (action === 'pause' && (n.payload.cancelled_by_user === true || n.state === 'done'))
        throw Object.assign(new Error('意图已完成或取消'), { statusCode: 409 });
      {
        const receipt=await workerStopReceipt(db,task.exploration_id,n,action==='pause'?'intent_paused':'user_cancelled',randomUUID(),reason);
        await db.query("UPDATE exploration_nodes SET payload=payload||jsonb_build_object('execution_stop',$3::jsonb) WHERE exploration_id=$1 AND id=$2",[task.exploration_id,intentID,JSON.stringify(receipt)]);
        await db.exploration(task.exploration_id).appendActivity({node_id:intentID,worker:'system',kind:'result',summary:`停止请求已提交：${receipt.summary}`,detail:`停止请求已提交：${receipt.summary}\n恢复位置：${receipt.recovery}`,metadata:{event_type:'lifecycle',status:'stop_requested',execution_stop:receipt}});
      }
      await db.query(`UPDATE exploration_nodes SET state=$3,completed_at=CASE WHEN $4 THEN now() ELSE NULL END,
        content_version=content_version+1,blocked_reason=NULL,
        payload=payload||CASE WHEN $4 THEN jsonb_build_object('cancelled_by_user',true,'cancel_reason',$5::text) ELSE '{}'::jsonb END
        WHERE id=$1 AND exploration_id=$2`, [intentID,task.exploration_id,state,action==='cancel'||action==='delete',reason]);
    });
    const handle = this.rt(taskID)?.work.get(intentID);
    if (handle) await handle.abort(action==='pause' ? 'cancel' : 'kill',`user: ${reason}`);
    this.notify(taskID);
    await this.publishFeedback(taskID);
    const waiting=!!(await this.db.control().query('SELECT 1 FROM engine_worker_slots s JOIN engine_task_leases l ON l.task_id=s.task_id AND l.token=s.token WHERE s.task_id=$1 AND (s.intent_id=$2 OR s.intent_id IS NULL) AND l.expires_at>now()',[taskID,intentID])).rowCount;
    return { id: intentID, state, status: waiting?'waiting_for_executor':state, execution_confirmed:!waiting, cancelled_by_user: action==='cancel'||action==='delete', cancel_reason: reason, deleted: action==='delete' };
  }

  async dispatchIntent(taskID: number, intentID: number, segment?: number): Promise<{status:'dispatched'|'queued'|'waiting_for_worker';intent_id:number;already_running?:boolean}> {
    const task = await this.db.tasks().getTask(taskID);
    if (!task) throw Object.assign(new Error('task not found'), { statusCode: 404 });
    const selectingRunning=(await this.db.exploration(task.exploration_id).getNode(intentID))?.state==='running';
    const alreadyRunning=await this.db.transaction(async db => {
      // Admission locks precede graph locks. Selecting a running intent only
      // subscribes: it must not resume a task or alter its dispatch grant.
      if(!selectingRunning)await this.coordinator.admit(db,taskID);
      await db.query('SELECT pg_advisory_xact_lock($1)', [-task.exploration_id]);
      const n=await db.exploration(task.exploration_id).getNode(intentID);
      if(!n||n.kind!=='intent'||!['open','running'].includes(n.state)||n.payload.cancelled_by_user===true||
        (selectingRunning&&n.state!=='running'))throw Object.assign(new Error(`意图 #${intentID} 不可下发或订阅`),{statusCode:409});
      if(segment!==undefined && (!Number.isSafeInteger(segment)||segment<0||(segment>0&&!(await db.query('SELECT 1 FROM main_sessions WHERE exploration_id=$1 AND seq=$2',[task.exploration_id,segment])).rowCount)))
        throw Object.assign(new Error('主会话不存在'),{statusCode:404});
      if((await db.query('SELECT 1 FROM exploration_anchors WHERE node_id=$1 AND NOT task_asset_linked($2,asset_id)',[intentID,taskID])).rowCount)
        throw Object.assign(new Error('意图资产不属于当前任务'),{statusCode:409});
      if(n.state==='open')await db.query(`UPDATE exploration_nodes SET payload=payload||jsonb_build_object('dispatch_requested',true,
        'dispatch_source','mainagent') WHERE id=$1`,[intentID]);
      if (segment !== undefined) await db.query(`INSERT INTO worker_feedback(exploration_id,task_id,intent_id,main_seg,after_activity)
        VALUES($1,$2,$3,$4,CASE WHEN $5 THEN COALESCE((SELECT after_activity FROM worker_feedback_run WHERE intent_id=$3),
          (SELECT max(id) FROM activity WHERE exploration_id=$1 AND node_id=$3),0)
          ELSE COALESCE((SELECT max(id) FROM activity WHERE exploration_id=$1 AND node_id=$3),0) END)
        ON CONFLICT(exploration_id,intent_id,main_seg) WHERE NOT terminal DO NOTHING`, [task.exploration_id,taskID,intentID,segment,n.state==='running']);
      return n.state==='running';
    });
    if(alreadyRunning)return {status:'dispatched',intent_id:intentID,already_running:true};
    await this.run(taskID);
    const rt=this.rt(taskID);const after=await this.db.tasks().getTask(taskID);
    if(rt && !after?.queued)rt.paused=false;
    this.notify(taskID, `意图 #${intentID} 已下发`);
    if(after?.queued)return {status:'queued',intent_id:intentID};
    const node=await this.db.exploration(task.exploration_id).getNode(intentID);
    return {status:node?.state==='running'?'dispatched':'waiting_for_worker',intent_id:intentID};
  }

  private async publishFeedback(taskID: number): Promise<void> {
    const r = await this.db.query(`SELECT a.* FROM worker_feedback_delivery d JOIN activity a ON a.id=d.activity_id
      WHERE d.task_id=$1 AND NOT d.published AND NOT EXISTS (
        SELECT 1 FROM engine_worker_slots slot JOIN engine_task_leases lease ON lease.task_id=slot.task_id AND lease.token=slot.token
        WHERE slot.task_id=d.task_id AND slot.intent_id=(a.metadata->'worker_feedback'->>'intent_id')::bigint AND lease.expires_at>clock_timestamp()
      ) ORDER BY a.id`, [taskID]);
    for (const a of r.rows) {
      this.bus.emit('activity', { id:Number(a.id),taskID,expID:Number(a.exploration_id),worker:'main',kind:a.kind,
        summary:a.summary,detail:a.detail,mainSeg:a.main_seg,isError:a.is_error,metadata:a.metadata });
      await this.db.query('UPDATE worker_feedback_delivery SET published=true WHERE activity_id=$1', [a.id]);
    }
  }

  async pause(taskID: number): Promise<{status:'paused'|'waiting_for_executor'|'superseded';command_id:number}> {
    await this.db.control().query(`INSERT INTO runtime_task_commands(task_id,command) VALUES($1,'pause') ON CONFLICT(task_id,command) WHERE status='pending' DO NOTHING`,[taskID]);
    const command=await this.db.control().query<{id:string;status:string}>(`SELECT id,status FROM runtime_task_commands WHERE task_id=$1 AND command='pause' ORDER BY id DESC LIMIT 1`,[taskID]);
    const commandID=Number(command.rows[0]?.id);
    const rt = this.rt(taskID);
    let ownsTaskLease=false;
    if(rt?.lease){try{await this.coordinator.assert(taskID,rt.lease,this.db.control());ownsTaskLease=true;}catch{/* a different instance may have taken ownership */}}
    if (rt) { rt.paused = true; rt.plannerAbort?.abort("pause"); }
    // Do not block the control response indefinitely on an uncooperative tool.
    // Acknowledgment is written only after every local executor has settled.
    void (async()=>{
      await this.stopMainChat(taskID);
      if(rt){await this.cancelAllWorks(rt,'pause');await rt.plannerBusy?.catch(()=>undefined);await this.starting.get(taskID)?.catch(()=>undefined);while(rt.plannerReserved)await new Promise(resolve=>setTimeout(resolve,25));}
      if(!(await this.hasActiveMainSession(taskID))&&(ownsTaskLease||!(await this.hasActiveTaskLease(taskID))))
        await this.acknowledgePendingPauses(taskID,ownsTaskLease?this.coordinator.owner:null,'task workers and sessions stopped');
    })().catch(()=>{});
    const state=await this.db.control().query<{status:string;detail:string}>(`SELECT status,detail FROM runtime_task_commands WHERE id=$1`,[commandID]);
    if(state.rows[0]?.detail==='superseded by explicit task resume')return {status:'superseded',command_id:commandID};
    if(state.rows[0]?.status==='acknowledged')return {status:'paused',command_id:commandID};
    return {status:'waiting_for_executor',command_id:commandID};
  }

  async resume(taskID: number): Promise<void> { await this.admitTask(taskID); }

  async stop(taskID: number, cause:AbortCause='stop'): Promise<void> {
    const rt = this.rt(taskID);
    if (!rt) return;
    rt.stopped = true;
    this.plannerQueue.get(taskID)?.resolve(false);this.plannerQueue.delete(taskID);
    rt.plannerAbort?.abort("stop");
    await this.stopMainChat(taskID);
    await this.starting.get(taskID)?.catch(() => undefined);
    await this.cancelAllWorks(rt, cause);
    this.notify(taskID);
    this.wakeWorkers(rt);
    await Promise.allSettled(rt.loops);
    await rt.activityTail;
    if(rt.lease)await this.coordinator.release(taskID,rt.lease);
    this.tasks.delete(taskID);
  }

  async shutdown(): Promise<void> {
    this.closing=true;clearInterval(this.scheduler);clearInterval(this.dispatchWatchdog);clearTimeout(this.dispatchTimer);
    for(const item of this.plannerQueue.values())item.resolve(false);this.plannerQueue.clear();

    await this.conversations.shutdown();
    await Promise.all([...this.tasks.keys()].map((id) => this.stop(id,'shutdown')));
  }

  async killWork(taskID: number, intentID: number, reason: string, source='planner'): Promise<void> {
    const rt = this.mustRt(taskID);
    const handle = rt.work.get(intentID);
    if (!handle) throw new Error(`意图 #${intentID} 不在运行中`);
    await handle.abort("kill",`${source}: ${reason}`);
    await handle.done;
  }

  async steerWork(taskID:number,intentID:number,message:string,source='planner'):Promise<void>{
    if(!message.trim()||Array.from(message).length>4000)throw Object.assign(new Error('纠偏消息需要 1–4000 字符'),{statusCode:400});
    const rt=this.mustRt(taskID),handle=rt.work.get(intentID);
    if(!handle||handle.settled)throw Object.assign(new Error('意图不在当前执行器运行'),{statusCode:409});
    await this.coordinator.assert(taskID,rt.lease!);
    const node=await this.db.exploration(rt.expID).getNode(intentID);
    if(!node||node.state!=='running'||rt.paused||rt.stopped)throw Object.assign(new Error('意图已暂停或结束'),{statusCode:409});
    const runner=await Promise.race([handle.runner,handle.done.then(()=>undefined)]);
    if(!runner||handle.settled)throw Object.assign(new Error('Worker 已退出'),{statusCode:409});
    await runner.steer(`【${source} 对当前意图的纠偏；不扩大授权】\n${message}`);
    // Platform control activity is distinct from pi's internal steering message role.
    // Native enqueue confirms submission only, not delivery or semantic effect.
    await this.db.exploration(rt.expID).appendActivity({
      node_id:intentID,worker:node.owner,kind:'status',tool:'steer_work',summary:message,detail:message,
      metadata:{event_type:'steering',turn_id:handle.turnID,source,
        steering:{id:randomUUID(),source,intent_id:intentID,target_turn_id:handle.turnID,status:'submitted'}},
    });
  }

  /** Explicit button continuation; no chat injection and no task admission. */
  private async resumeWorker(taskID:number,intentID:number){
    const task=await this.db.tasks().getTask(taskID);
    if(!task||task.paused||task.queued||task.status!=='running')throw Object.assign(new Error('任务暂停、排队或结束时不能续跑 Worker'),{statusCode:409});
    const rt=this.rt(taskID);
    if(!rt?.started||!rt.lease||rt.stopped||rt.paused)throw Object.assign(new Error('任务执行器尚未就绪'),{statusCode:409});
    const name=`manual#${intentID}`;
    let slot:string|undefined;
    const inserted=await this.db.transaction(async db=>{
      if(!await this.coordinator.lockWorkerCapacity(db))throw Object.assign(new Error('调度正在处理其他领取，请重试恢复'),{statusCode:409});
      await this.coordinator.assert(taskID,rt.lease!,db);
      await db.query('SELECT pg_advisory_xact_lock($1)',[-rt.expID]);
      const live=await db.tasks().getTask(taskID);
      if(!live||live.paused||live.queued||live.status!=='running'||rt.settling)throw Object.assign(new Error('任务不可续跑'),{statusCode:409});
      const node=await db.exploration(rt.expID).getNode(intentID);
      if(!node||node.kind!=='intent')throw Object.assign(new Error('intent not found'),{statusCode:404});
      const active=!!(await db.query(`SELECT 1 FROM engine_worker_slots s JOIN engine_task_leases l ON l.task_id=s.task_id AND l.token=s.token
        WHERE s.intent_id=$1 AND l.expires_at>clock_timestamp()`,[intentID])).rowCount;
      if(node.state==='running'&&active)return false;
      if(active||rt.work.has(intentID))throw Object.assign(new Error('旧 Worker 尚未退出'),{statusCode:409});
      if(node.state!=='paused'||node.payload.cancelled_by_user===true)throw Object.assign(new Error('仅允许恢复已暂停的 Worker'),{statusCode:409});
      slot=await this.coordinator.reserveWorkerSlot(db,taskID,rt.lease!,true,intentID);
      if(!slot)throw Object.assign(new Error('本任务 Worker 并发名额已满，请等待执行器退出后恢复'),{statusCode:409,code:'TASK_WORKER_CAPACITY_FULL'});
      await db.query(`UPDATE exploration_nodes SET state='running',owner=$3,completed_at=NULL,blocked_reason=NULL,content_version=content_version+1,
        payload=(CASE WHEN payload ? 'execution_result' THEN (payload-'execution_result'-'execution_result_basis')||jsonb_build_object('previous_result',payload->'execution_result') ELSE payload END)
          ||'{"resume_requested":true}'::jsonb WHERE exploration_id=$1 AND id=$2`,[rt.expID,intentID,name]);
      await db.exploration(rt.expID).appendActivity({node_id:intentID,worker:'system',kind:'text',summary:'通过按钮恢复当前 Worker',metadata:{event_type:'lifecycle',status:'resume_requested',source:'user'}});
      return true;
    });
    if(inserted)this.trackExecution(rt,this.runOneIntent(rt,{id:intentID},name).catch(error=>{this.emitActivity(taskID,{nodeID:intentID,worker:name,kind:'result',isError:true,summary:String(error)});}).finally(async()=>{await this.coordinator.releaseSlot(slot!);await markWorkerReleased(this.db,rt.expID,intentID);await this.publishFeedback(taskID);this.notify(taskID);}));
    return {id:intentID,state:'running' as const,status:'running',execution_confirmed:true,cancelled_by_user:false,duplicate:!inserted};
  }

  /** Chat owns a session, not a worker pool. Reading a paused/finished task must not restart it. */
  async mainChat(taskID: number, message: string, segment = 0, attachments?: {images:ChatImage[];refs:unknown[]}, requestID?:string): Promise<string> {
    const key = `${taskID}:${segment}`;
    if (this.chats.has(key)) throw new Error("该会话正在回复，请先停止当前回复");
    const controller = new AbortController();
    const lease=await acquireSessionLease(this.db,`main:${key}`,controller);
    const done = (async () => {
      const rt = await this.loadRuntime(taskID);
      if(requestID){const existing=await this.db.query("SELECT 1 FROM activity WHERE exploration_id=$1 AND worker IN ('main','mainagent') AND kind='user' AND main_seg=$2 AND metadata->>'turn_id'=$3",[rt.expID,segment,requestID]);if(existing.rowCount)return "";}
      const task = await this.db.tasks().getTask(taskID);
      const model = await this.modelResolver(taskID, "mainagent");
      if(attachments?.images.length && !model.model.input.includes("image"))throw Object.assign(new Error("当前模型链未启用图片输入，请在 LLM 配置中启用 supports_images 或选择支持图片的模型"),{statusCode:400});
      controller.signal.throwIfAborted();
      const turn=this.beginActivityTurn(rt,{worker:"main",mainSeg:segment},requestID);
      this.emitActivity(taskID, { kind: "user", worker: "main", mainSeg: segment, summary: message, detail: message, metadata:{...turn.metadata,attachments:attachments?.refs??[]} });
      try {
        const res = await runMainChat({
          turnID:turn.turnID,
          db: this.db, taskID, expID: rt.expID, goal: task?.goal ?? task?.description ?? "",
          model, dataDir: this.dataDir, hooks: {...this.engineHooks(rt, segment),assertOwnership:lease.assert}, message, segment, images:attachments?.images,
          egressAddr:this.egressAddr,egressScope:`main:${taskID}:${segment}:${lease.token}`,
          signal: controller.signal, maxTurns: this.cfg.mainMaxTurns,
          onActivity: turn.onActivity,
        });
        this.emitActivity(taskID, { kind: "result", worker: "main", mainSeg: segment, metadata:{...turn.metadata,event_type:"lifecycle",status:res.aborted?"stopped":"completed"},
          summary: res.aborted ? "回复已停止" : "回复完成", inputTokens: res.usage.input, outputTokens: res.usage.output,
          cacheReadTokens: res.usage.cacheRead, cacheWriteTokens: res.usage.cacheWrite });
        return res.lastAssistantText ?? "";
      } catch (err) {
        this.emitActivity(taskID, { kind: "result", worker: "main", mainSeg: segment, metadata:{...turn.metadata,event_type:"lifecycle",status:"failed"}, isError: true, summary: `回复失败：${String(err)}` });
        throw err;
      } finally { await turn.finish(); }
    })();
    this.chats.set(key, { controller, done });
    try { return await done; } finally { this.chats.delete(key); await lease.release(); }
  }

  mainChatRunning(taskID: number): boolean {
    return [...this.chats.keys()].some((key) => key.startsWith(`${taskID}:`));
  }

  async stopMainChat(taskID: number): Promise<void> {
    await this.db.control().query("UPDATE runtime_session_leases SET stop_requested=true WHERE key LIKE $1",[`main:${taskID}:%`]);
    const chats = [...this.chats].filter(([key]) => key.startsWith(`${taskID}:`)).map(([, chat]) => chat);
    for (const chat of chats) chat.controller.abort("user");
    await Promise.race([Promise.allSettled(chats.map((chat) => chat.done)),new Promise<void>(resolve=>{const timer=setTimeout(resolve,10_000);timer.unref();})]);
  }

  private async cancelAllWorks(rt: TaskRuntime, cause: AbortCause): Promise<void> {
    const works = [...rt.work.values()];
    await Promise.all(works.map((w) => w.abort(cause)));
    await Promise.allSettled(works.map((w) => w.done));
    await Promise.allSettled(rt.executions);
  }

  private async finishTask(rt: TaskRuntime, status: "done" | "timeout", note: string): Promise<boolean> {
    // Commit under the execution lease before publishing success or stopping
    // the runtime. A failed write remains retryable; pause/delete and a newer
    // owner cannot be overwritten by a stale Planner finishing its last turn.
    const committed = await this.db.transaction(async db => {
      await this.coordinator.assert(rt.taskID, rt.lease!, db);
      const task = (await db.query('SELECT status,paused,queued,deleted_at FROM tasks WHERE id=$1 FOR UPDATE', [rt.taskID])).rows[0];
      if (!task || task.deleted_at || task.paused || task.queued) return null;
      if (['done','failed','timeout'].includes(String(task.status))) return {won:false};
      if(status==='done'){
        if(rt.work.size || (await db.query("SELECT 1 FROM engine_worker_slots WHERE task_id=$1 AND phase='running'",[rt.taskID])).rowCount)return null;
        if((await db.query("SELECT 1 FROM exploration_nodes WHERE exploration_id=$1 AND kind='intent' AND state='open' AND payload->>'dispatch_requested'='true' AND origin<>'planner'",[rt.expID])).rowCount)return null;
        await db.query("UPDATE exploration_nodes SET state='stopped',completed_at=now(),payload=payload||'{\"close_reason\":\"goal_satisfied\"}'::jsonb WHERE exploration_id=$1 AND kind='intent' AND state='open'",[rt.expID]);
      }
      return {won:await db.tasks().setTaskStatusGuarded(rt.taskID, status)};
    });
    if (!committed) return false;
    // 注意：本函数可能从 plannerLoop/deadlineLoop 内部调用——绝不能 await rt.loops
    // （自等待死锁）。置停 + 唤醒 + 摘除任务即可，循环见 stopped 自行退出。
    rt.stopped = true;
    if (committed.won) this.emitActivity(rt.taskID, { kind: "result", worker: "system", summary: note });
    await this.cancelAllWorks(rt, status==='done'?'task-completed':'task-timeout');
    this.notify(rt.taskID);
    this.wakeWorkers(rt);
    // Keep chat state available; run() can restart the drained scheduler explicitly.
    rt.started = false;
    if(rt.lease)await this.coordinator.release(rt.taskID,rt.lease);
    return true;
  }

  // ─── 任务级超时（deadline 协调，简化版）───────────────────────────────────

  private async deadlineLoop(rt: TaskRuntime): Promise<void> {
    while (!rt.stopped) {
      await new Promise((r) => setTimeout(r, 2_000));
      if (rt.stopped) return;
      if (rt.settling || rt.paused) continue;
      const row = await this.db
        .query<{ deadline_at: string | null; status: string }>(
          `SELECT deadline_at, status FROM tasks WHERE id=$1`,
          [rt.taskID],
        )
        .catch(() => null);
      const deadline = row?.rows[0]?.deadline_at;
      if (!deadline || row?.rows[0]?.status !== "running") continue;
      if (Date.now() < new Date(deadline).getTime()) continue;
      await this.settleTask(rt);
      if (!rt.stopped) { rt.settling = false; continue; }
      return;
    }
  }

  /** 超时收尾：置 settling → abort 在跑（timeout 收尾词已注入的由 wrapup 兜底）→ 终局 planner 轮 → guarded 终态。 */
  private async settleTask(rt: TaskRuntime): Promise<void> {
    if (rt.settling) return;
    rt.settling = true;
    this.emitActivity(rt.taskID, { kind: "result", worker: "system", summary: "任务到达超时上限，开始收尾" });
    rt.plannerAbort?.abort("task-timeout");
    await rt.plannerBusy?.catch(() => undefined);
    await this.cancelAllWorks(rt, "task-timeout");
    // 等在跑意图落终态。
    for (let i = 0; i < 100 && rt.work.size > 0; i++) await new Promise((r) => setTimeout(r, 200));

    // 终局 planner 轮：只判目标、不派意图（任务超时词注入）。
    const s = this.db.exploration(rt.expID);
    if(!await this.acquirePlanner(rt,true))return;
    try{
    const model = await this.modelFor(rt, "planner");
    if (model && !rt.stopped && !rt.paused) {
      const task = await this.db.tasks().getTask(rt.taskID);
      if (rt.stopped || rt.paused) return;
      const turn=this.beginActivityTurn(rt,{worker:"planner"});
      await runPlannerRound({
        planningRoundID:turn.turnID,
        db: this.db, taskID: rt.taskID, expID: rt.expID,
        goal: task?.goal ?? task?.description ?? "",
        model, dataDir: this.dataDir, todos: rt.todos, hooks: this.engineHooks(rt),
        triggersText: "【本轮触发】任务超时收尾（终局判定：只 prove_goal，不派新意图）",
        maxTurns: 3, signal: (rt.plannerAbort = new AbortController()).signal,
        terminalOnly: true,
        wrapupPromptOverride: PLANNER_TASK_TIMEOUT_WRAPUP,
        onActivity: turn.onActivity,
      }).then(result=>{this.emitActivity(rt.taskID,{worker:'planner',kind:'result',metadata:{...turn.metadata,event_type:'lifecycle',status:result.aborted?'stopped':'completed'},summary:'收尾规划结束'});})
      .catch(error=>{this.emitActivity(rt.taskID,{worker:'planner',kind:'result',metadata:{...turn.metadata,event_type:'lifecycle',status:'failed'},isError:true,summary:String(error)});})
      .finally(()=>turn.finish());
    }
    if (rt.stopped || rt.paused) return;
    }finally{await this.releasePlanner(rt);}
    const counts = await s.executionCounts();
    const status = counts.goals > 0 && counts.met >= counts.goals ? "done" : "timeout";
    try {
      await this.finishTask(rt, status, status === "done" ? "任务超时前全部目标已证明" : "任务超时结束");
    } finally {
      // The supervisor can retry a failed terminal transaction; do not leave
      // deadlineLoop permanently gated behind a failed settlement attempt.
      if (!rt.stopped) rt.settling = false;
    }
  }

  // ─── 杂项 ─────────────────────────────────────────────────────────────────

  private engineHooks(rt: TaskRuntime, segment?: number) {
    const token=rt.lease;
    return {
      assertOwnership: segment===undefined && token ? async(tx:Database)=>{
        await this.coordinator.assert(rt.taskID,token,tx);
        const task=(await tx.query('SELECT paused,queued,status FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[rt.taskID])).rows[0];
        if(rt.stopped||rt.paused||!task||task.paused||task.queued||task.status!=='running')throw new Error('任务已暂停、结束或执行权限已撤销');
      } : undefined,
      notifyFinding: (expID: number, nodeID: number) => {
        void expID;
        // report_finding already committed a durable finding_published event.
        // Do not misclassify it as a second, urgent user control change.
        void nodeID;
        this.notify(rt.taskID);
      },
      notifyGoalMet: (expID: number, goalID: number) => {
        void expID;
        this.notify(rt.taskID);
      },
      goalsChanged: async (_expID: number) => {
        // Goal edits notify an already running scheduler; only explicit dispatch
        // or task resume may admit work or unpause the task.
        this.notify(rt.taskID, "任务目标已更新");
      },
      constraintsChanged: (_expID: number) => this.notify(rt.taskID, "操作约束已更新"),
      notifyIntent: (_expID: number, _intentID: number) => this.wakeWorkers(rt),
      dispatchIntent: async (_expID: number, intentID: number) => this.dispatchIntent(rt.taskID, intentID, segment),
      killWork: async (expID: number, intentID: number, reason: string, source?:string) => {
        void expID;
        await this.killWork(rt.taskID, intentID, reason,source);
      },
      steerWork: async (expID: number, intentID: number, message: string,source?:string) => {
        void expID;
        await this.steerWork(rt.taskID, intentID, message,source);
      },
    };
  }



  private beginActivityTurn(rt: TaskRuntime, identity: {worker: string; intentID?: number; mainSeg?: number}, turnID: string = randomUUID()) {
    const writer = new LiveStreamWriter(this.db,'task',rt.expID,{worker:identity.worker,node_id:identity.intentID,main_seg:identity.mainSeg,turn_id:turnID});
    return {turnID, metadata:{turn_id:turnID},
      onActivity:(a:RunnerActivity,meta:{worker:string;intentID?:number})=>this.mapActivity(rt,a,{...meta,...identity,turnID},writer),
      finish:async()=>{await rt.activityTail;await writer.close().catch(()=>undefined);}};
  }

  private mapActivity(
    rt: TaskRuntime,
    a: RunnerActivity,
    meta: { intentID?: number; worker: string; mainSeg?: number; turnID?: string },
    writer?: LiveStreamWriter,
  ): void {
    switch (a.kind) {
      case "assistant_delta":
        writer?.push(a);
        this.bus.emit("delta", { taskID: rt.taskID, expID: rt.expID, worker: meta.worker, nodeID: meta.intentID, mainSeg: meta.mainSeg, text: a.text, streamID: a.streamID, isThinking: a.isThinking });
        break;
      case "host_status":
        this.emitActivity(rt.taskID,{nodeID:meta.intentID??null,worker:meta.worker,mainSeg:meta.mainSeg,kind:"status",summary:a.text,metadata:{turn_id:meta.turnID,...runnerActivityMetadata(a)}});
        break;
      case "settled":
      case "run_metadata":
        this.emitActivity(rt.taskID,{nodeID:meta.intentID??null,worker:meta.worker,mainSeg:meta.mainSeg,kind:'status',summary:'',metadata:{turn_id:meta.turnID,...runnerActivityMetadata(a)}});
        break;
      case "assistant_message_end":
        if (!a.text && !a.response) break;
        this.emitActivity(rt.taskID, {
          nodeID: meta.intentID ?? null, worker: meta.worker, mainSeg: meta.mainSeg,
          kind: a.isThinking ? "thinking" : a.text ? "text" : "status", streamID: a.streamID,
          metadata:{turn_id:meta.turnID,...runnerActivityMetadata(a)},
          summary: a.text.slice(0, 4000), detail: a.text,
        }, a.streamID && writer ? ()=>writer.committed(a.streamID!,a.isThinking?"thinking":"text") : undefined);
        break;
      case "tool_start":
        this.emitActivity(rt.taskID, {
          nodeID: meta.intentID ?? null, worker: meta.worker, mainSeg: meta.mainSeg, kind: "tool_use", metadata:{turn_id:meta.turnID},
          toolCallId: a.toolCallId, tool: a.toolName, summary: toolCallSummary(a.toolName, a.args),
          detail: JSON.stringify(a.args),
        });
        break;
      case "tool_end":
        this.emitActivity(rt.taskID, {
          nodeID: meta.intentID ?? null, worker: meta.worker, mainSeg: meta.mainSeg, kind: "tool_result", metadata:{turn_id:meta.turnID},
          toolCallId: a.toolCallId, tool: a.toolName, isError: a.isError,
          detail: a.text,
        });
        break;
      default:
        break;
    }
  }

  private emitActivity(taskID: number, a: Omit<EngineActivity, "taskID" | "expID">, committed?:()=>Promise<unknown>): void {
        const rt = this.rt(taskID);
        if (!rt)
            return;
        const act = { taskID, expID: rt.expID, ...a };
        // 持久化（best-effort）+ 进程内广播（M5 SSE 订阅）。
        rt.activityTail = rt.activityTail.then(() => this.db
            .exploration(rt.expID)
            .appendActivity({
            node_id: act.nodeID ?? undefined,
            tool_use_id: act.toolCallId,
            main_seg: act.mainSeg,
            worker: act.worker,
            kind: act.kind,
            tool: act.tool,
            is_error: act.isError,
            summary: act.summary,
            detail: act.detail,
            metadata: act.metadata,
            input_tokens: act.inputTokens,
            output_tokens: act.outputTokens,
            cache_read_tokens: act.cacheReadTokens,
            cache_write_tokens: act.cacheWriteTokens,
        }))
            .then(async (id) => {
            streamChanges.emit('change','task',rt.expID);
            this.bus.emit("activity", { ...act, id });
            await committed?.();
        })
            .catch(() => undefined);
  }
}


/** 工具调用摘要：bash/命令显示原文片段；领域工具取核心参数。 */
function toolCallSummary(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (toolName === "bash" && typeof a["command"] === "string") {
    return a["command"].replace(/\s+/g, " ").slice(0, 120);
  }
  if (typeof a["summary"] === "string") return a["summary"].slice(0, 100);
  if (Array.isArray(a["intents"])) return `提交 ${a["intents"].length} 条意图`;
  if (typeof a["query"] === "string") return String(a["query"]).slice(0, 80);
  if (typeof a["node_id"] === "number") return `节点 #${a["node_id"]}`;
  return toolName;
}
