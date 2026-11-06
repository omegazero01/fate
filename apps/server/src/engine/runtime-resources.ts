import {createHash,randomUUID} from 'node:crypto';
import {getHeapStatistics} from 'node:v8';
import {totalmem} from 'node:os';
import type {Pool} from 'pg';
import type {Database} from '../db/index.js';

const MiB=1024*1024;
export type RuntimeResourcePolicy={memory_mb:number;session_reserve_mb:number;initializing:number};
export const DEFAULT_RUNTIME_RESOURCES:RuntimeResourcePolicy={memory_mb:0,session_reserve_mb:64,initializing:2};
export function resourcePolicy(value:unknown):RuntimeResourcePolicy{
  if(value===undefined||value===null||value==='')return {...DEFAULT_RUNTIME_RESOURCES};
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new Error('runtime_resource_policy 必须是 JSON 对象');}}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('runtime_resource_policy 必须是对象');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(k=>!Object.hasOwn(DEFAULT_RUNTIME_RESOURCES,k)))throw new Error('runtime_resource_policy 含未知字段');
  const policy={...DEFAULT_RUNTIME_RESOURCES,...input} as RuntimeResourcePolicy;
  for(const key of ['memory_mb','session_reserve_mb','initializing'] as const)
    if(!Number.isSafeInteger(policy[key]))throw new Error(`${key} 必须为整数`);
  if(policy.memory_mb<0||policy.memory_mb>1_048_576||policy.session_reserve_mb<16||policy.session_reserve_mb>8192||policy.initializing<1||policy.initializing>32)
    throw new Error('执行资源配置超出有效范围');
  if(policy.memory_mb&&policy.memory_mb<3*policy.session_reserve_mb)throw new Error('执行内存预留至少需要容纳 Worker、Planner 和人工入口各一个会话');
  return policy;
}

export type ResourceScope={database:string;taskID:number;role:string;intentID?:number;conversationID?:number;mainSegment?:number};
type Lane='execution'|'planner'|'interactive';
export type ResourceEnvelope={capacity:number;reservation:number;initializing:number};
type Request={scope:ResourceScope;envelope:ResourceEnvelope;lane:Lane;group:string;order:number;resolve:(lease:RuntimeResourceLease)=>void;
  reject:(reason:unknown)=>void;signal?:AbortSignal;abort:()=>void;granted?:RuntimeResourceLease};
const laneFor=(role:string):Lane=>role==='planner'?'planner':['main','mainagent','goals'].includes(role)?'interactive':'execution';
const sameScope=(a:ResourceScope,b:ResourceScope)=>a.database===b.database&&a.taskID===b.taskID&&a.role===b.role&&a.intentID===b.intentID&&a.conversationID===b.conversationID&&a.mainSegment===b.mainSegment;

/** A host resource reservation, not a model budget or a worker quota. */
export class RuntimeResourceLease {
  readonly id=randomUUID();
  released=false;
  initializing=true;
  constructor(readonly scope:ResourceScope,readonly bytes:number,readonly lane:Lane,private pool:RuntimeResourcePool){}
  assert(scope:ResourceScope){if(this.released||!sameScope(this.scope,scope))throw new Error('执行资源预留不属于当前会话或已经释放');}
  beginInitialization(signal?:AbortSignal){return this.pool.beginInitialization(this,signal);}
  ready(){if(!this.released&&this.initializing){this.initializing=false;this.pool.changed();}}
  release(){if(this.released)return;this.released=true;this.pool.release(this);}
}

/** One process-wide pool, shared by every Engine and role. Queue entries contain
 * identity/cancellation only; callers do not open PI/MCP/session resources until
 * granted. Round-robin groups are tasks (or independent conversations), not the
 * number of Workers a task happens to enqueue. Active executions are not preempted. */
export class RuntimeResourcePool {
  private pending:Request[]=[];
  private active=new Map<string,{lease:RuntimeResourceLease;envelope:ResourceEnvelope;group:string}>();
  private initWaiting=new Map<string,{resolve:()=>void;reject:(reason:unknown)=>void;signal?:AbortSignal;abort:()=>void}>();
  private served=new Map<string,number>();
  private order=0;private grants=0;private draining=false;
  private timer?:ReturnType<typeof setInterval>;
  private peakQueued=0;private peakActive=0;private peakInitializing=0;private pressure=false;
  constructor(private heap:()=>{used:number;limit:number}=()=>({used:process.memoryUsage().heapUsed,limit:getHeapStatistics().heap_size_limit})){}
  request(scope:ResourceScope,envelope:ResourceEnvelope,signal?:AbortSignal){
    signal?.throwIfAborted();
    this.validateConfiguration(scope.database,envelope);
    let request!:Request;
    const promise=new Promise<RuntimeResourceLease>((resolve,reject)=>{
      const lane=laneFor(scope.role),group=`${scope.database}:${scope.taskID?`task:${scope.taskID}`:`conversation:${scope.conversationID??0}`}:${lane}`;
      request={scope,envelope,lane,group,order:this.order++,resolve,reject,signal,abort:()=>{
        const index=this.pending.indexOf(request);if(index<0)return;
        this.pending.splice(index,1);request.signal?.removeEventListener('abort',request.abort);
        reject(signal?.reason??new Error('执行资源等待已取消'));this.cleanupGroup(group);this.changed();
      }};
      this.pending.push(request);signal?.addEventListener('abort',request.abort,{once:true});
    });
    this.peakQueued=Math.max(this.peakQueued,this.pending.length);this.drain();
    return {promise,waiting:!request.granted};
  }
  validateConfiguration(database:string,envelope:ResourceEnvelope){
    if(!Number.isFinite(envelope.capacity)||!Number.isFinite(envelope.reservation)||envelope.reservation<=0||envelope.initializing<1||envelope.capacity<3*envelope.reservation)
      throw new Error('执行资源容量不足，无法保留执行、规划和人工入口');
    let capacity=envelope.capacity,reserve=envelope.reservation;
    for(const r of this.pending)if(r.scope.database!==database){capacity=Math.min(capacity,r.envelope.capacity);reserve=Math.max(reserve,r.envelope.reservation);}
    for(const r of this.active.values())if(r.lease.scope.database!==database){capacity=Math.min(capacity,r.envelope.capacity);reserve=Math.max(reserve,r.envelope.reservation);}
    if(capacity<3*reserve)throw new Error('同一进程中不同数据库的资源配置不兼容，无法为各角色保留会话空间');
  }
  configure(database:string,envelope:ResourceEnvelope){
    this.validateConfiguration(database,envelope);
    for(const r of this.pending)if(r.scope.database===database)r.envelope=envelope;
    for(const r of this.active.values())if(r.lease.scope.database===database)r.envelope=envelope;
    this.drain();
  }
  beginInitialization(lease:RuntimeResourceLease,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();
    if(lease.released||!this.active.has(lease.id))throw new Error('执行资源预留已经释放');
    if(lease.initializing)return Promise.resolve();
    if(this.initWaiting.has(lease.id))throw new Error('同一会话不能并发初始化多个运行器');
    const promise=new Promise<void>((resolve,reject)=>{
      const abort=()=>{this.initWaiting.delete(lease.id);signal?.removeEventListener('abort',abort);reject(signal?.reason??new Error('初始化等待已取消'));this.drain();};
      this.initWaiting.set(lease.id,{resolve,reject,signal,abort});signal?.addEventListener('abort',abort,{once:true});
    });
    this.drain();return promise;
  }
  changed(){this.drain();}
  release(lease:RuntimeResourceLease){const row=this.active.get(lease.id);if(!row)return;this.active.delete(lease.id);
    const waiting=this.initWaiting.get(lease.id);if(waiting){this.initWaiting.delete(lease.id);waiting.signal?.removeEventListener('abort',waiting.abort);waiting.reject(new Error('执行资源预留已经释放'));}
    this.cleanupGroup(row.group);this.drain();}
  private cleanupGroup(group:string){if(!this.pending.some(r=>r.group===group)&&![...this.active.values()].some(r=>r.group===group))this.served.delete(group);}
  private drain(){
    if(this.draining)return;this.draining=true;
    try{
      while(this.pending.length||this.initWaiting.size){
        const all=[...this.active.values()].map(x=>x.envelope).concat(this.pending.map(x=>x.envelope));
        // Multiple database connections in this process share the stricter
        // participating envelope, never independent copies of physical capacity.
        const capacity=all.reduce((n,x)=>Math.min(n,x.capacity),Infinity),reserve=all.reduce((n,x)=>Math.max(n,x.reservation),0),initMax=all.reduce((n,x)=>Math.min(n,x.initializing),Infinity);
        const active=[...this.active.values()],initializing=active.filter(x=>x.lease.initializing).length;
        if(initializing>=initMax)break;
        const init=this.initWaiting.entries().next().value;
        if(init){
          const [id,waiting]=init;this.initWaiting.delete(id);waiting.signal?.removeEventListener('abort',waiting.abort);
          if(waiting.signal?.aborted){waiting.reject(waiting.signal.reason);continue;}
          this.active.get(id)!.lease.initializing=true;this.peakInitializing=Math.max(this.peakInitializing,initializing+1);waiting.resolve();continue;
        }
        const used=active.reduce((n,x)=>n+x.lease.bytes,0),heap=this.heap();
        this.pressure=heap.used+reserve>heap.limit*0.9;
        if(this.pressure)break;
        const byLane={execution:0,planner:0,interactive:0};for(const x of active)byLane[x.lease.lane]+=x.lease.bytes;
        const eligible=this.pending.filter(r=>{
          const remaining=capacity-used-r.envelope.reservation;
          if(remaining<0)return false;
          // Keep one reservation for each other lane even when its queue is
          // currently empty: a busy Worker fleet cannot exclude Main/Planner.
          let protectedBytes=0;
          for(const lane of ['execution','planner','interactive'] as const)if(lane!==r.lane)protectedBytes+=Math.max(0,reserve-byLane[lane]);
          return remaining>=protectedBytes;
        });
        const next=eligible.reduce<Request|undefined>((a,b)=>!a||(this.served.get(b.group)??0)<(this.served.get(a.group)??0)||((this.served.get(b.group)??0)===(this.served.get(a.group)??0)&&b.order<a.order)?b:a,undefined);if(!next)break;
        this.pending.splice(this.pending.indexOf(next),1);next.signal?.removeEventListener('abort',next.abort);
        if(next.signal?.aborted){next.reject(next.signal.reason);this.cleanupGroup(next.group);continue;}
        const lease=new RuntimeResourceLease(next.scope,next.envelope.reservation,next.lane,this);
        next.granted=lease;this.active.set(lease.id,{lease,envelope:next.envelope,group:next.group});this.served.set(next.group,++this.grants);
        this.peakActive=Math.max(this.peakActive,this.active.size);this.peakInitializing=Math.max(this.peakInitializing,initializing+1);
        next.resolve(lease);
      }
      if(this.pending.length&&!this.timer){this.timer=setInterval(()=>this.drain(),1000);this.timer.unref();}
      if(!this.pending.length&&this.timer){clearInterval(this.timer);this.timer=undefined;this.pressure=false;}
    }finally{this.draining=false;}
  }
  metrics(){
    const active=[...this.active.values()],lanes={execution:{active:0,queued:0},planner:{active:0,queued:0},interactive:{active:0,queued:0}};
    for(const x of active)lanes[x.lease.lane].active++;for(const x of this.pending)lanes[x.lane].queued++;
    return {active:active.length,queued:this.pending.length,initialization_queue:this.initWaiting.size,initializing:active.filter(x=>x.lease.initializing).length,reserved_bytes:active.reduce((n,x)=>n+x.lease.bytes,0),
      peak_active:this.peakActive,peak_queued:this.peakQueued,peak_initializing:this.peakInitializing,groups:this.served.size,heap_pressure:this.pressure,lanes};
  }
}

const processPool=new RuntimeResourcePool();
const policies=new WeakMap<Pool,{value:RuntimeResourcePolicy;at:number}>(),loading=new WeakMap<Pool,Promise<RuntimeResourcePolicy>>();
function databaseKey(db:Database){const o=(db.pool as Pool&{options:Record<string,unknown>}).options;return createHash('sha256').update(JSON.stringify([o.host,o.port,o.database,o.user])).digest('hex').slice(0,24);}
export function resourceScope(db:Database,scope:Omit<ResourceScope,'database'>):ResourceScope{return {database:databaseKey(db),...scope};}
export async function configuredRuntimeResources(db:Database){
  const cached=policies.get(db.pool);if(cached&&Date.now()-cached.at<1000)return cached.value;
  let pending=loading.get(db.pool);if(!pending){pending=(async()=>{const value=resourcePolicy(await db.platform().getSetting('runtime_resource_policy'));policies.set(db.pool,{value,at:Date.now()});return value;})().finally(()=>loading.delete(db.pool));loading.set(db.pool,pending);}return pending;
}
export async function invalidateRuntimeResources(db:Database){await loading.get(db.pool);policies.delete(db.pool);const policy=await configuredRuntimeResources(db);processPool.configure(databaseKey(db),envelope(policy));}
export function validateRuntimeResources(db:Database,policy:RuntimeResourcePolicy){processPool.validateConfiguration(databaseKey(db),envelope(policy));}
export function runtimeResourceMetrics(){return {...processPool.metrics(),heap_used_bytes:process.memoryUsage().heapUsed,heap_limit_bytes:getHeapStatistics().heap_size_limit,rss_bytes:process.memoryUsage().rss,scope:'process',reservation_estimate:true};}
function envelope(policy:RuntimeResourcePolicy):ResourceEnvelope{
  const heap=getHeapStatistics().heap_size_limit,constrained=process.constrainedMemory?.()||Infinity;
  // OS free pages are not a reliable application allowance (e.g. macOS caches).
  // This is a conservative reservation envelope, not a claim of exact RSS.
  const safety=Math.floor(Math.min(heap*0.75,totalmem()*0.25,constrained*0.6));
  const capacity=Math.min(policy.memory_mb?policy.memory_mb*MiB:Math.floor(heap*0.6),safety);
  return {capacity,reservation:policy.session_reserve_mb*MiB,initializing:policy.initializing};
}
export async function acquireRuntimeResources(db:Database,scope:Omit<ResourceScope,'database'>,signal?:AbortSignal,onWaiting?:()=>unknown|Promise<unknown>){
  signal?.throwIfAborted();const policy=await configuredRuntimeResources(db);signal?.throwIfAborted();
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const current=envelope(policy);processPool.configure(databaseKey(db),current);
  const pending=processPool.request(resourceScope(db,scope),current,combined);
  // Attach a rejection handler before awaiting optional durable presentation.
  void pending.promise.catch(()=>{});
  try{if(pending.waiting)await onWaiting?.();const lease=await pending.promise;
    if(combined.aborted){lease.release();combined.throwIfAborted();}return lease;
  }catch(error){controller.abort(error);void pending.promise.then(lease=>lease.release(),()=>{});throw error;}
}

export async function withRuntimeResources<T>(db:Database,scope:Omit<ResourceScope,'database'>,signal:AbortSignal|undefined,existing:RuntimeResourceLease|undefined,
  work:(lease:RuntimeResourceLease)=>Promise<T>,onWaiting?:()=>unknown|Promise<unknown>):Promise<T>{
  existing?.assert(resourceScope(db,scope));const lease=existing??await acquireRuntimeResources(db,scope,signal,onWaiting);
  try{signal?.throwIfAborted();return await work(lease);}finally{if(!existing)lease.release();}
}
