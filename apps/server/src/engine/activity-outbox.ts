import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,opendir,unlink,type FileHandle} from 'node:fs/promises';
import type {Dir} from 'node:fs';
import {hostname} from 'node:os';
import path from 'node:path';
import type {Database} from '../db/index.js';
import type {Activity} from '../db/exploration.js';
import {projectActivity,type ActivitySource} from '../db/activity-projection.js';
import {streamChanges} from './stream-changes.js';

const PROCESS_ID=randomUUID(),HOST=hostname();
const PROCESS_ACTIVE=new Set<string>();
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const segmentBytes=1024*1024,segmentRecords=64;
type Header={version:1;id:string;namespace:string;source:ActivitySource;pid:number;host:string;process:string;previous_segment?:string};
type RecordData={seq:number;previous:string;activity:Activity};
type Line={record:RecordData;hash:string}|{closed:true;seq:number;previous:string};
type Ref={file:string;end:number};
type Segment={file:string;handle:FileHandle;header:Header;offset:number;seq:number;previous:string};
type Progress={byte_offset:string;next_seq:string;last_hash:string|null;header_hash:string;closed:boolean;discarded:boolean};
type Commit=(source:ActivitySource,activity:Activity,id:number)=>void;

/** Reads one complete JSONL record, never an entire journal/directory. A single
 * oversized activity remains intact; the next record waits for another pass. */
async function readLine(file:FileHandle,offset:number,maxBytes=Infinity):Promise<{text:string;end:number}|null>{
  const chunks:Buffer[]=[];let length=0;
  for(;;){
    const buffer=Buffer.allocUnsafe(Math.min(64*1024,maxBytes-length+1));
    const {bytesRead}=await file.read(buffer,0,buffer.length,offset+length);
    if(!bytesRead){if(length)throw new Error('Incomplete activity journal tail; original file retained');return null;}
    const newline=buffer.subarray(0,bytesRead).indexOf(10),n=newline<0?bytesRead:newline;
    chunks.push(buffer.subarray(0,n));length+=n;
    if(length>maxBytes)throw new Error('Invalid activity journal header');
    if(newline>=0)return {text:Buffer.concat(chunks,length).toString('utf8'),end:offset+length+1};
  }
}

async function syncDirectory(dir:string){const h=await open(dir,'r');try{await h.sync();}finally{await h.close();}}
function ownerDead(h:Header){
  if(h.host!==HOST)return false;
  if(h.process===PROCESS_ID)return true; // Caller additionally excludes active local producers.
  try{process.kill(h.pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
}

/** Small disk references wait for two shared DB delivery slots. Model/tool
 * lifecycle still belongs to PI; failed delivery rejects its existing storage
 * boundary, while acknowledged journal bytes survive process termination. */
export class ActivityOutbox {
  private initialized?:Promise<{dir:string;namespace:string}>;
  private active=new Set<string>();
  private registered=new Set<string>();
  private busy=new Map<string,Promise<unknown>>();
  private slots=0;
  private waiters:(()=>void)[]=[];
  private scan?:Dir;
  private replaying?:Promise<unknown>;
  private timer?:ReturnType<typeof setInterval>;
  private stopped=false;
  private stats={spooled:0,projected:0,replayed:0,discarded:0,failures:0,loaded:0,peak_loaded:0,read_bytes:0,segments_created:0};
  constructor(private db:Database,private dataDir:string,private committed?:Commit){}
  metrics(){return {...this.stats,active_segments:this.active.size,delivery_slots:this.slots,delivery_waiters:this.waiters.length,pending_files:this.busy.size};}
  start(){if(this.timer||this.stopped)return;this.timer=setInterval(()=>{void this.replay().catch(()=>{});},1000);this.timer.unref();}
  private init(){
    if(!this.initialized)this.initialized=(async()=>{
      const namespace=String((await this.db.query('SELECT identity FROM activity_outbox_identity WHERE singleton')).rows[0]?.identity??'');
      if(!/^[a-f0-9-]{36}$/.test(namespace))throw new Error('Activity outbox database identity is unavailable');
      const dir=path.resolve(this.dataDir,'activity-outbox',namespace);await mkdir(dir,{recursive:true,mode:0o700});return {dir,namespace};
    })().catch(error=>{this.initialized=undefined;throw error;});
    return this.initialized;
  }
  writer(source:ActivitySource){if(this.stopped)throw new Error('Activity outbox is closed');return new ActivityJournal(this,source);}
  async newSegment(source:ActivitySource,previous?:string):Promise<Segment>{
    const {dir,namespace}=await this.init(),id=randomUUID(),file=path.join(dir,`${id}.jsonl`);
    const header:Header={version:1,id,namespace,source,pid:process.pid,host:HOST,process:PROCESS_ID,...(previous?{previous_segment:previous}:{})};
    const text=JSON.stringify(header)+'\n',handle=await open(file,'wx',0o600);this.active.add(file);PROCESS_ACTIVE.add(file);
    try{await handle.writeFile(text);await handle.sync();await syncDirectory(dir);this.stats.segments_created++;
      return {file,handle,header,offset:Buffer.byteLength(text),seq:0,previous:hash(text.trimEnd())};
    }catch(error){this.active.delete(file);PROCESS_ACTIVE.delete(file);await handle.close();throw error;}
  }
  recordSpooled(){this.stats.spooled++;}
  async release(file:string){this.active.delete(file);this.registered.delete(file);PROCESS_ACTIVE.delete(file);await this.cleanup(file).catch(()=>{});}
  private async cleanup(file:string){
    if(PROCESS_ACTIVE.has(file))return;
    const id=path.basename(file,'.jsonl');
    if((await this.db.query('SELECT 1 FROM activity_outbox_progress WHERE producer_id=$1 AND closed',[id])).rowCount)
      await unlink(file).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
  }
  private async permit<T>(fn:()=>Promise<T>){
    if(this.slots>=2)await new Promise<void>(resolve=>this.waiters.push(resolve));else this.slots++;
    try{return await fn();}finally{const next=this.waiters.shift();if(next)next();else this.slots--;}
  }
  deliver(ref:Ref,replay=false,limit={records:Infinity,bytes:Infinity}):Promise<void>{
    // Same-file work is serialized before occupying a DB slot. Closures retain
    // paths/offsets only, not assistant messages or tool-result bodies.
    const before=this.busy.get(ref.file)??Promise.resolve();
    const job=before.catch(()=>{}).then(()=>this.permit(()=>this.projectFile(ref,replay,limit)));
    this.busy.set(ref.file,job);
    void job.finally(()=>{if(this.busy.get(ref.file)===job)this.busy.delete(ref.file);}).catch(()=>{});
    return job;
  }
  private async projectFile(ref:Ref,replay:boolean,limit:{records:number;bytes:number}){
    const {namespace}=await this.init();
    let handle:FileHandle;
    try{handle=await open(ref.file,'r');}catch(error){if(replay&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    try{
      const first=await readLine(handle,0,16*1024);if(!first)throw new Error('Empty activity journal');
      const h=JSON.parse(first.text) as Header,headerHash=hash(first.text);
      if(h.version!==1||h.namespace!==namespace||h.id!==path.basename(ref.file,'.jsonl')||!['task','conversation'].includes(h.source?.scope)
        ||!Number.isSafeInteger(h.source.scopeID)||h.source.scopeID<=0||!Number.isInteger(h.pid)||h.pid<=0)throw new Error('Invalid activity journal identity');
      if(replay&&(PROCESS_ACTIVE.has(ref.file)||!ownerDead(h)))return;
      if(!this.registered.has(ref.file)&&h.previous_segment){
        const ready=await this.db.query(`SELECT 1 FROM activity_outbox_progress WHERE producer_id=$1 AND namespace=$2 AND scope=$3
          AND scope_id=$4 AND task_id IS NOT DISTINCT FROM $5::bigint AND run_id IS NOT DISTINCT FROM $6::bigint AND closed`,
          [h.previous_segment,namespace,h.source.scope,h.source.scopeID,h.source.scope==='task'?h.source.taskID:null,h.source.scope==='conversation'?h.source.runID:null]);
        if(!ready.rowCount){if(replay)return;throw new Error('Earlier activity journal has not been delivered');}
      }
      if(!this.registered.has(ref.file)){
        await this.db.query(`INSERT INTO activity_outbox_progress(producer_id,namespace,scope,scope_id,task_id,run_id,header_hash,byte_offset,last_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7) ON CONFLICT DO NOTHING`,[h.id,namespace,h.source.scope,h.source.scopeID,
          h.source.scope==='task'?h.source.taskID:null,h.source.scope==='conversation'?h.source.runID:null,headerHash,first.end]);
        // Cache registration only for owned, open segments. Historical replay
        // never creates an in-memory set proportional to the directory size.
        if(this.active.has(ref.file))this.registered.add(ref.file);
      }
      let records=0,bytes=0;
      for(;;){
        const p=(await this.db.query<Progress>('SELECT byte_offset,next_seq,last_hash,header_hash,closed,discarded FROM activity_outbox_progress WHERE producer_id=$1',[h.id])).rows[0]!;
        if(p.header_hash!==headerHash)throw new Error('Activity journal header changed; original retained');
        if(p.closed){await this.cleanup(ref.file);return;}
        const offset=Number(p.byte_offset);
        if(offset>(await handle.stat()).size)throw new Error('Activity journal was truncated; original retained');
        if(offset>=ref.end||records>=limit.records||bytes>=limit.bytes)return;
        const line=await readLine(handle,offset);
        if(!line){
          if(replay)await this.db.query('UPDATE activity_outbox_progress SET closed=true,updated_at=now() WHERE producer_id=$1 AND byte_offset=$2',[h.id,offset]);
          await this.cleanup(ref.file);return;
        }
        const item=JSON.parse(line.text) as Line;
        const footer='closed' in item&&item.closed===true;
        const data=footer?item:('record' in item?item.record:undefined);
        if(!data||data.seq!==Number(p.next_seq)||data.previous!==p.last_hash||(!footer&&(!('hash' in item)||item.hash!==hash(JSON.stringify(data)))))
          throw new Error('Activity journal sequence/checksum changed; original retained');
        this.stats.loaded++;this.stats.peak_loaded=Math.max(this.stats.peak_loaded,this.stats.loaded);
        try{
          const result=await this.db.transaction(async tx=>{
            const current=(await tx.query<Progress>('SELECT * FROM activity_outbox_progress WHERE producer_id=$1 FOR UPDATE',[h.id])).rows[0]!;
            if(current.closed||Number(current.byte_offset)!==offset)return {retry:true};
            let id:number|null=null;
            if(!footer&&!p.discarded)id=await projectActivity(tx,h.source,(data as RecordData).activity,replay);
            await tx.query(`UPDATE activity_outbox_progress SET byte_offset=$2,next_seq=$3,last_hash=$4,closed=$5,discarded=discarded OR $6,updated_at=now() WHERE producer_id=$1`,
              [h.id,line.end,footer?data.seq:data.seq+1,footer?data.previous:(item as {hash:string}).hash,footer,!footer&&id===null]);
            return {id};
          });
          if(result.retry)continue;
          if(!footer){
            if(result.id!=null){this.stats.projected++;if(replay)this.stats.replayed++;
              streamChanges.emit('change',h.source.scope,h.source.scopeID);
              // Observers cannot turn a committed activity into a retry/failure.
              try{this.committed?.(h.source,(data as RecordData).activity,result.id);}catch{}
            }else this.stats.discarded++;
          }
          records++;bytes+=line.end-offset;this.stats.read_bytes+=line.end-offset;
        }finally{this.stats.loaded--;}
        if(footer){await this.cleanup(ref.file);return;}
        if(line.end>=ref.end)return;
      }
    }catch(error){this.stats.failures++;throw error;}finally{await handle.close();}
  }
  replay():Promise<void>{
    if(this.stopped)return Promise.resolve();
    if(this.replaying)return this.replaying as Promise<void>;
    const job=this.replayPage().finally(()=>{if(this.replaying===job)this.replaying=undefined;});this.replaying=job;return job;
  }
  private async replayPage(){
    const {dir}=await this.init();this.scan??=await opendir(dir);
    // Directory cursor persists between ticks. Corrupt/active segments cannot
    // monopolize recovery; each pass reads at most eight small batches.
    for(let n=0;n<8;n++){
      const entry=await this.scan.read();
      if(!entry){await this.scan.close();this.scan=undefined;break;}
      if(!entry.isFile()||!/^[a-f0-9-]{36}\.jsonl$/.test(entry.name))continue;
      const file=path.join(dir,entry.name);if(this.busy.has(file))continue;
      if(PROCESS_ACTIVE.has(file)&&!this.active.has(file))continue;
      // An active local producer can recover a temporary database outage too.
      // Keep its live ownership check; only closed/dead producers use replay.
      await this.deliver({file,end:Infinity},!this.active.has(file),{records:8,bytes:512*1024}).catch(()=>{});
    }
  }
  async close(){
    this.stopped=true;clearInterval(this.timer);await this.replaying?.catch(()=>{});
    await Promise.allSettled(this.busy.values());await this.scan?.close();this.scan=undefined;
  }
}

export class ActivityJournal {
  private segment?:Segment;
  private spoolTail:Promise<unknown>=Promise.resolve();
  private deliveryTail:Promise<unknown>=Promise.resolve();
  private failure?:unknown;
  private closed=false;
  private previous?:string;
  constructor(private outbox:ActivityOutbox,private source:ActivitySource){}
  append(activity:Activity,onSpooled?:()=>void):Promise<void>{
    if(this.closed)return Promise.reject(new Error('Activity journal is closed'));
    return this.enqueueDelivery(this.stage(activity,onSpooled,this.deliveryTail));
  }
  private stage(activity:Activity,onSpooled:(()=>void)|undefined,before:Promise<unknown>):Promise<Ref>{
    const staged=this.spoolTail.then(async()=>{
      if(this.failure)throw this.failure;
      if(this.segment&&(this.segment.seq>=segmentRecords||this.segment.offset>=segmentBytes))await this.seal(before);
      const s=this.segment??=await this.outbox.newSegment(this.source,this.previous);
      const record:RecordData={seq:s.seq,previous:s.previous,activity:{...activity,created_at:activity.created_at??new Date().toISOString()}};
      const checksum=hash(JSON.stringify(record)),text=JSON.stringify({record,hash:checksum})+'\n';
      await s.handle.writeFile(text);await s.handle.sync();s.offset+=Buffer.byteLength(text);s.seq++;s.previous=checksum;
      this.outbox.recordSpooled();onSpooled?.();return {file:s.file,end:s.offset};
    }).catch(error=>{this.failure??=error;throw error;});
    this.spoolTail=staged.catch(()=>{});
    return staged;
  }
  private enqueueDelivery(staged:Promise<Ref>){
    const saved=this.deliveryTail.catch(()=>{}).then(async()=>this.outbox.deliver(await staged));
    this.deliveryTail=saved.catch(()=>{});return saved;
  }
  private async seal(before=this.deliveryTail){
    const s=this.segment;if(!s)return;this.segment=undefined;
    try{const text=JSON.stringify({closed:true,seq:s.seq,previous:s.previous})+'\n';await s.handle.writeFile(text);await s.handle.sync();s.offset+=Buffer.byteLength(text);}
    catch(error){await this.outbox.release(s.file);throw error;}
    finally{await s.handle.close();}
    // `before` was captured before the current append entered the delivery
    // queue. Never wait for a projection that is itself awaiting this spool.
    // Commit the prior segment before creating another, preserving replay order.
    this.previous=s.header.id;
    await before.catch(()=>{}).then(()=>this.outbox.deliver({file:s.file,end:s.offset})).finally(()=>this.outbox.release(s.file));
  }
  async close(){
    if(this.closed)return;this.closed=true;await this.spoolTail;
    if(this.failure){const s=this.segment;this.segment=undefined;if(s){try{await s.handle.close();}finally{await this.outbox.release(s.file);}}throw this.failure;}
    await this.seal();await this.deliveryTail;
  }
}
