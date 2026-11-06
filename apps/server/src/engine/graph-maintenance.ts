import { compactColdGraph, type ColdGraphResult } from '../agent/coldgraph.js';
import type { Database } from '../db/index.js';

type Job = { taskID:number; expID:number; due:number };
type Maintain = (expID:number,signal:AbortSignal)=>Promise<ColdGraphResult>;

/** A single low-priority consumer per process. Durable revision/age markers in
 * PostgreSQL are authoritative; losing this queue only postpones derived work.
 * Maintenance never wakes a model or acknowledges Planner events. */
export class GraphMaintenance {
  private queue = new Map<number,Job>();
  private active?:{job:Job;controller:AbortController;done:Promise<void>};
  private timer?:ReturnType<typeof setTimeout>;
  private closed=false;
  private errors=0;
  private completed=0;
  private timeouts=0;
  private conflicts=0;
  private maintain:Maintain;

  constructor(db:Database,private eligible:(taskID:number)=>boolean,maintain?:Maintain){
    this.maintain=maintain??((expID,signal)=>compactColdGraph(db,expID,{advanceRound:false,signal}));
  }
  metrics(){return {queued:this.queue.size,active:Number(!!this.active),errors:this.errors,completed:this.completed,timeouts:this.timeouts,conflicts:this.conflicts};}
  request(taskID:number,expID:number){
    if(this.closed||!this.eligible(taskID))return;
    // Coalesce repeated requests, including requests arriving during a pass.
    if(!this.queue.has(taskID))this.queue.set(taskID,{taskID,expID,due:Date.now()+100});
    this.schedule();
  }
  cancel(taskID:number){
    this.queue.delete(taskID);
    if(this.active?.job.taskID===taskID)this.active.controller.abort();
  }
  async close(){
    this.closed=true;clearTimeout(this.timer);this.timer=undefined;this.queue.clear();
    this.active?.controller.abort();await this.active?.done;
  }
  private schedule(){
    if(this.closed||this.active||!this.queue.size)return;
    clearTimeout(this.timer);
    let due=Infinity;for(const job of this.queue.values())due=Math.min(due,job.due);
    this.timer=setTimeout(()=>{this.timer=undefined;this.start();},Math.max(0,due-Date.now()));
    this.timer.unref();
  }
  private start(){
    if(this.closed||this.active)return;
    const job=[...this.queue.values()].find(job=>job.due<=Date.now());
    if(!job){this.schedule();return;}
    this.queue.delete(job.taskID);
    if(!this.eligible(job.taskID)){this.schedule();return;}
    const controller=new AbortController();
    // Assign active before invoking even a synchronously resolving test adapter.
    const done=Promise.resolve().then(async()=>{
      let pending=false,delay=1000,backoff=false;
      try{
        const result=await this.maintain(job.expID,controller.signal);pending=result.pending;
        if(result.retry_reason==='timeout'){this.timeouts++;this.errors++;delay=5000;backoff=true;}
        else if(result.status==='busy'||result.status==='stale')this.conflicts++;
        else this.completed++;
      }
      catch{if(!controller.signal.aborted){this.errors++;pending=true;delay=5000;backoff=true;}}
      if(pending&&!this.closed&&!controller.signal.aborted&&this.eligible(job.taskID)){
        const queued=this.queue.get(job.taskID),due=Date.now()+delay;
        // New writes may enqueue this task while its SQL is still running.
        // They retain their work, but cannot bypass a failed pass's backoff.
        if(!queued)this.queue.set(job.taskID,{...job,due});
        else if(backoff)queued.due=Math.max(queued.due,due);
      }
    }).finally(()=>{this.active=undefined;this.schedule();});
    this.active={job,controller,done};
  }
}
