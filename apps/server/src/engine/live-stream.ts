import {utf8Clean} from '../db/exploration.js';
import {appendStreamChunk,lockStream,streamOriginalSQL,streamParams,finalStreamSQL,STREAM_CHUNK_UNITS} from '../db/stream-storage.js';
import {activityControlFields} from './activity-presentation.js';
import {streamChanges} from './stream-changes.js';
import {lockActivityScope} from '../db/activity-projection.js';
import type { Database } from '../db/index.js';
import type { RunnerActivity } from '../pi/runner.js';

export type StreamScope = 'task' | 'conversation';
export type StreamIdentity = { worker: string; node_id?: number; main_seg?: number; turn_id: string };

/** Native message metadata is durable even when a response contains only tools. */
export function runnerActivityMetadata(a: RunnerActivity) {
  const native=a.native_event?{native_event:a.native_event}:{};
  if(a.kind==='host_status')return {event_type:a.phase==='resource_wait'?'resource_wait':'goals_phase',phase:a.phase,...(a.phase==='resource_wait'?{status:'waiting'}:{})};
  if(a.kind==='settled')return {event_type:'runner_settled',stop_reason:a.stopReason};
  if(a.kind==='run_metadata')return {event_type:'turn_start',runtime_id:a.runtimeID,role:a.role,mode:a.mode,started_at:a.startedAt};
  if(a.kind==='assistant_message_end')return {...native,final_answer:a.final,stream_id:a.streamID,channel:a.isThinking?'thinking':'text',...(a.response?{response:a.response}:{})};
  return native;
}

/** Shared snapshots are presentation state. Acknowledged originals live in
 * immutable DB chunks; memory retains only deltas not yet acknowledged. Native
 * PI still owns the in-progress response and the final original transcript. */
type PendingStream={pending:string;channel:string;stream:string;no:number;start:number;retry?:{rawUnits:number;text:string}};
const writers=new Set<LiveStreamWriter>();
let activeFlushes=0;
const flushQueue:Array<()=>void>=[];
function pumpFlushes(){while(activeFlushes<2&&flushQueue.length){activeFlushes++;flushQueue.shift()!();}}
function withFlushSlot(work:()=>Promise<void>){
 return new Promise<void>((resolve,reject)=>{
  // At most one small job per active writer, never a DB connection or one job
  // per delta. FIFO admission also serves writers with aligned timer phases.
  flushQueue.push(()=>{void(async()=>{try{await work();resolve();}catch(error){reject(error);}finally{activeFlushes--;pumpFlushes();}})();});
  pumpFlushes();
 });
}
export function liveStreamMetrics(){
 let pending=0,streams=0;for(const writer of writers){pending+=writer.bufferedBytes;streams+=writer.streamCount;}
 return {writers:writers.size,streams,pending_bytes:pending,active_flushes:activeFlushes,queued_flushes:flushQueue.length};
}
export class LiveStreamWriter {
 private messages=new Map<string,PendingStream>();
 private tail:Promise<unknown>=Promise.resolve();
 private timer:ReturnType<typeof setInterval>;
 private heartbeat=0;
 private flushing=false;
 private closing=false;
 private closeJob?:Promise<void>;
 private failure:unknown;
 private durableFinals=new Set<string>();
 constructor(private db:Database,private scope:StreamScope,private id:number,readonly identity:StreamIdentity){
  writers.add(this);this.timer=setInterval(()=>this.flush(),250);this.timer.unref();
 }
 get bufferedBytes(){let n=0;for(const m of this.messages.values())n+=Buffer.byteLength(m.pending)+Buffer.byteLength(m.retry?.text??'');return n;}
 get streamCount(){return this.messages.size;}
 push(a:RunnerActivity){
  if(a.kind!=='assistant_delta')return;if(this.closing)throw new Error('Live stream is closing');
  const channel=a.isThinking?'thinking':'text',key=`${a.streamID}:${channel}`;
  if(this.durableFinals.has(key))return;
  const m=this.messages.get(key)??{pending:'',channel,stream:a.streamID,no:0,start:0};
  m.pending+=a.text;this.messages.set(key,m);
 }
 private ref(m:{stream:string;channel:string}){return {scope:this.scope,id:this.id,stream:m.stream,channel:m.channel};}
 private flush(){
  // Queued writers hold no pool clients, and repeated ticks do not add jobs.
  if(this.flushing)return;
  const heartbeat=Date.now()-this.heartbeat>3000;if(heartbeat)this.heartbeat=Date.now();
  if(!this.messages.size||!heartbeat&&![...this.messages.values()].some(m=>m.pending||m.retry))return;
  this.flushing=true;
  this.tail=withFlushSlot(async()=>{
   this.failure=undefined;
   // A newly started native message waits for the next batch instead of
   // extending this slot's work while other writers are waiting.
   const batch=[...this.messages];
   for(const [key,m] of batch){
    if(this.messages.get(key)!==m)continue;
    if(this.durableFinals.has(key))continue;
    if(!m.retry&&m.pending){
     let size=Math.min(STREAM_CHUNK_UNITS,m.pending.length);
     // Provider events may split a surrogate pair. Wait for the low half, or
     // let final close apply the same UTF-8 replacement as PostgreSQL's driver.
     if(!this.closing&&size&&/[\uD800-\uDBFF]/.test(m.pending[size-1]!))size--;
     if(size)m.retry={rawUnits:size,text:Buffer.from(utf8Clean(m.pending.slice(0,size))).toString('utf8')};
    }
    if(m.retry){
     const part=m.retry;
     if(part.text&&!await appendStreamChunk(this.db,this.ref(m),this.identity,{no:m.no,start:m.start,text:part.text})){
      m.pending='';m.retry=undefined;this.messages.delete(key);continue;
     }
     // Do not resurrect a stream removed while its transaction was in flight.
     if(this.messages.get(key)!==m)continue;
     m.pending=m.pending.slice(part.rawUnits);m.retry=undefined;
     if(part.text){m.no++;m.start+=Array.from(part.text).length;}
    }else if(heartbeat){
     await this.db.query(`UPDATE agent_stream_snapshots SET expires_at=now()+interval '12 seconds'
      WHERE scope=$1 AND scope_id=$2 AND stream_id=$3 AND channel=$4 AND turn_id=$5`,[...streamParams(this.ref(m)),this.identity.turn_id]);
    }
   }
   streamChanges.emit('change',this.scope,this.id);
  }).catch(error=>{this.failure=error;}).finally(()=>{this.flushing=false;});
 }
 /** Explicit boundary only: no per-token promises or per-token DB clients. */
 async drain(){
  await this.tail;
  while([...this.messages.values()].some(m=>m.pending||m.retry)){
   this.flush();
   await this.tail;if(this.failure)throw this.failure;
   // A lone high surrogate is not a complete Unicode character yet.
   if(!this.closing&&[...this.messages.values()].every(m=>!m.retry&&(!m.pending||/^[\uD800-\uDBFF]$/.test(m.pending))))break;
  }
 }
 /** Called after the original final commits. */
 async committed(stream:string,channel:string){
  const key=`${stream}:${channel}`,m=this.messages.get(key);if(m){m.pending='';m.retry=undefined;}
  this.messages.delete(key);this.durableFinals.delete(key);await this.tail;
  await this.db.transaction(async tx=>{const ref=this.ref({stream,channel});await lockStream(tx,ref);
   await tx.query('DELETE FROM agent_stream_snapshots WHERE scope=$1 AND scope_id=$2 AND stream_id=$3 AND channel=$4 AND turn_id=$5',[...streamParams(ref),this.identity.turn_id]);});
  streamChanges.emit('change',this.scope,this.id);
 }
 /** The fsynced final journal already owns the complete original. Release its
  * live producer buffers even if the database cannot deliver that final yet. */
 deferFinal(stream:string,channel:string){
  const key=`${stream}:${channel}`;this.durableFinals.add(key);const m=this.messages.get(key);
  if(m){m.pending='';m.retry=undefined;this.messages.delete(key);}
 }
 close(){
  if(this.closeJob)return this.closeJob;this.closing=true;clearInterval(this.timer);
  this.closeJob=this.finish().finally(()=>{writers.delete(this);});return this.closeJob;
 }
 private async finish(){
  await this.drain();
  // Identity fields only cross the driver. PostgreSQL assembles an interrupted
  // original once, atomically with final-history insertion and chunk deletion.
  const partials=await this.db.query(`SELECT stream_id,channel FROM agent_stream_snapshots WHERE scope=$1 AND scope_id=$2 AND turn_id=$3`,[this.scope,this.id,this.identity.turn_id]);
  for(const row of partials.rows){
   if(this.durableFinals.has(`${row.stream_id}:${row.channel}`))continue;
   await this.db.transaction(async tx=>{
    await lockActivityScope(tx,this.scope,this.id);
    const ref=this.ref({stream:String(row.stream_id),channel:String(row.channel)});await lockStream(tx,ref);
    const table=this.scope==='task'?'activity':'conversation_activities',scopeColumn=this.scope==='task'?'exploration_id':'conversation_id';
    const kind=this.scope==='task'?'text':'assistant',summaryLimit=this.scope==='task'?4000:1000;
    await tx.query(`WITH source AS MATERIALIZED (SELECT s.*,${streamOriginalSQL('s')} original FROM agent_stream_snapshots s
      WHERE scope=$1 AND scope_id=$2 AND stream_id=$3 AND channel=$4 AND turn_id=$5)
     INSERT INTO ${table}(${scopeColumn},worker,${this.scope==='task'?'node_id,main_seg,':''}kind,summary,detail,metadata,created_at)
     SELECT scope_id,worker,${this.scope==='task'?'node_id,main_seg,':''}CASE WHEN channel='thinking' THEN 'thinking' ELSE '${kind}' END,
      left(original,${summaryLimit}),original,jsonb_build_object('turn_id',turn_id,'stream_id',stream_id,'channel',channel,'interrupted',true),created_at
     FROM source WHERE NOT EXISTS(${finalStreamSQL(this.scope)})`,[...streamParams(ref),this.identity.turn_id]);
    await tx.query('DELETE FROM agent_stream_snapshots WHERE scope=$1 AND scope_id=$2 AND stream_id=$3 AND channel=$4 AND turn_id=$5',[...streamParams(ref),this.identity.turn_id]);
   });
  }
  this.messages.clear();this.durableFinals.clear();streamChanges.emit('change',this.scope,this.id);
 }
}

export function activityDTO(row: Record<string, unknown>) {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return { ...row, ...activityControlFields(row), id: Number(row.id), seq: Number(row.id), ts: row.created_at,
    worker: row.worker === 'main' ? 'mainagent' : row.worker,
    intent_id: row.node_id == null ? undefined : String(row.node_id),
    main_seg: row.main_seg == null ? undefined : Number(row.main_seg),
    turn_id: metadata.turn_id, stream_id: metadata.stream_id, channel: metadata.channel, interrupted: metadata.interrupted === true, metadata };
}
