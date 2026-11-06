import {createHash,randomUUID} from 'node:crypto';
import {constants,type Dir,type Dirent} from 'node:fs';
import {mkdir,open,opendir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {Database} from '../db/index.js';
import type {UsageObservation} from './usage-meter.js';

export type UsageReceipt={requestID:string;auditID:number;status:string;usage:ReturnType<UsageObservation['result']>;finishedAt:string|null};
const MAX_BYTES=16*1024,MAX_ENTRIES=64,MAX_RECEIPTS=16;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const filePattern=new RegExp(`^(${uuid})(?:\\.(\\d+|legacy-${uuid}))?\\.json$`);
const uuidPattern=new RegExp(`^${uuid}$`);
export const USAGE_STORAGE_ERROR='用量保存暂不可用：';
export class UsageStorageUnavailable extends Error {
 constructor(){super(USAGE_STORAGE_ERROR+'计量存储恢复后才能发送新的模型请求；未持久化的已有用量保留在当前进程');}
}
class ReceiptIdentityError extends Error {}
const receiptFile=(r:UsageReceipt)=>`${r.requestID}.${r.usage._receipt_seq}.json`;
const safeInt=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function validateReceipt(value:unknown,file:string,identity:string):UsageReceipt {
 const r=value as UsageReceipt & {_outbox_version?:number;_database_identity?:string};
 const match=file.match(filePattern),u=r?.usage;
 if(!r||!match||match[1]!==r.requestID||!safeInt(r.auditID)||r.auditID<1||!u||
   !safeInt(u._receipt_seq)||u._receipt_seq<1||match[2]&&!match[2].startsWith('legacy-')&&Number(match[2])!==u._receipt_seq||
   !['running','completed','aborted','failed'].includes(r.status)||
   !(r.finishedAt===null||typeof r.finishedAt==='string'&&Number.isFinite(Date.parse(r.finishedAt)))||
   !['input','output','cacheRead','cacheWrite','inputTotal','totalTokens'].every(k=>safeInt(u[k as keyof typeof u]))||
   !['unknown','partial','complete','not_sent'].includes(u._quality)||u._source!=='provider'||
   typeof u._input_total_known!=='boolean'||typeof u._cache_read_known!=='boolean'||
   !Array.isArray(u._known_fields)||!u._known_fields.every(k=>['input','output','cacheRead','cacheWrite'].includes(k)))throw new ReceiptIdentityError('Invalid receipt');
 if(r._outbox_version!==undefined||r._database_identity!==undefined){
  if(r._outbox_version!==1||r._database_identity!==identity)throw new ReceiptIdentityError('Foreign receipt');
 }
 return r;
}

// Limit storage concurrency, not model requests/tokens. Waiters only belong to
// currently executing streams; durable historical receipts never enter this queue.
let operations=0;
const waiters:Array<()=>void>=[];
async function storageOperation<T>(fn:()=>Promise<T>):Promise<T>{
 if(operations>=2)await new Promise<void>(resolve=>waiters.push(resolve));else operations++;
 try{return await fn();}finally{const next=waiters.shift();if(next)next();else operations--;}
}
const managers=new WeakMap<object,UsageOutbox>();
function manager(db:Database){
 const key=db.pool??db;let result=managers.get(key);
 if(!result){const source=String(db.pool?.options?.connectionString??'local-fixture');
  result=new UsageOutbox(db,path.join(tmpdir(),'fate-usage-outbox',createHash('sha256').update(source).digest('hex').slice(0,20)));managers.set(key,result);}
 return result;
}

class UsageOutbox {
 private identity?:Promise<string>;
 private preparingDirectory?:Promise<void>;
 private cursor?:Dir;
 private retryFile?:string;
 private replaying?:Promise<number>;
 // Only simultaneous disk AND database failures require memory. Replace each
 // in-flight request's cumulative snapshot; refuse new requests until durable.
 private volatile=new Map<string,UsageReceipt>();
 private retryAfter=0;
 private cycleRetained=false;
 private lastRetained=false;
 private counters={saved:0,committed:0,invalid:0,storage_failures:0,db_failures:0,replay_passes:0,last_entries:0,last_receipts:0,last_bytes:0};
 constructor(private db:Database,public directory:string){}
 configure(directory:string){
  if(directory===this.directory)return;
  if(this.identity||this.cursor||this.replaying||this.volatile.size)throw new Error('Usage outbox already active; close it before changing directories');
  this.directory=directory;
 }
 private databaseIdentity(){
  return this.identity??=(this.db.query<{identity:string}>('SELECT identity FROM activity_outbox_identity WHERE singleton').then(result=>{
   const identity=result.rows[0]?.identity;if(!identity||!uuidPattern.test(identity))throw new ReceiptIdentityError('Database identity missing');return identity;
  }).catch(error=>{this.identity=undefined;throw error;}));
 }
 async beforeRequest(signal?:AbortSignal){
  signal?.throwIfAborted();try{await this.databaseIdentity();}catch{throw new UsageStorageUnavailable();}
  if(this.volatile.size){await this.replay();if(this.volatile.size)throw new UsageStorageUnavailable();}
  signal?.throwIfAborted();
 }
 private prepareDirectory(){
  if(this.preparingDirectory)return this.preparingDirectory;
  const pending=(async()=>{
   const created=await mkdir(this.directory,{recursive:true,mode:0o700});
   if(created){
    // Concurrent writers await the same first-directory durability boundary.
    const stop=path.dirname(created);let parent=path.dirname(this.directory);
    for(;;){const handle=await open(parent,'r');try{await handle.sync();}finally{await handle.close();}
     if(parent===stop)break;parent=path.dirname(parent);}
   }
  })();this.preparingDirectory=pending;
  void pending.finally(()=>{if(this.preparingDirectory===pending)this.preparingDirectory=undefined;}).catch(()=>undefined);
  return pending;
 }
 private async persist(r:UsageReceipt){
  const identity=await this.databaseIdentity();
  const data=JSON.stringify({...r,_outbox_version:1,_database_identity:identity});
  if(Buffer.byteLength(data)>MAX_BYTES)throw new Error('Receipt exceeds metadata limit');
  await this.prepareDirectory();
  const dest=path.join(this.directory,receiptFile(r)),temp=dest+'.'+randomUUID()+'.tmp';
  try{
   const handle=await open(temp,'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
   await rename(temp,dest);
   const parent=await open(this.directory,'r');try{await parent.sync();}finally{await parent.close();}
  }finally{await unlink(temp).catch(()=>undefined);}
 }
 private async commit(r:UsageReceipt){
  await this.db.transaction(async tx=>{
   // Identity is immutable. Do not lock the ledger first: the audit trigger
   // takes audit -> ledger locks, including cancellation and log updates.
   const identity=await tx.query<{audit_id:string}>('SELECT audit_id FROM llm_usage_ledger WHERE request_id=$1',[r.requestID]);
   if(Number(identity.rows[0]?.audit_id)!==r.auditID)throw new ReceiptIdentityError('Metering request identity mismatch');
   await tx.query(`UPDATE llm_request_attempts SET status=CASE WHEN status='aborted' THEN status ELSE $2 END,
     usage=$3::jsonb,finished_at=COALESCE(finished_at,$4::timestamptz)
     WHERE id=$1 AND request_id=$5 AND COALESCE((usage->>'_receipt_seq')::bigint,0)<$6`,
    [r.auditID,r.status,JSON.stringify(r.usage),r.finishedAt,r.requestID,r.usage._receipt_seq]);
   // Works after deliberate audit-log deletion too; never recreates that log.
   await tx.query(`UPDATE llm_usage_ledger SET status=CASE WHEN status='aborted' THEN status ELSE $2 END,
     usage=$3::jsonb,quality=$4,source='provider',receipt_seq=$6,finished_at=COALESCE(finished_at,$5::timestamptz)
     WHERE request_id=$1 AND audit_id=$7 AND receipt_seq<$6`,
    [r.requestID,r.status,JSON.stringify(r.usage),r.usage._quality,r.finishedAt,r.usage._receipt_seq,r.auditID]);
  });
  this.retryAfter=0;this.counters.committed++;
 }
 private forgetVolatile(r:UsageReceipt){
  if((this.volatile.get(r.requestID)?.usage._receipt_seq??Infinity)<=r.usage._receipt_seq)this.volatile.delete(r.requestID);
 }
 private deferDatabase(){this.retryAfter=Date.now()+1000;this.counters.db_failures++;}
 async save(r:UsageReceipt):Promise<boolean>{
  return storageOperation(async()=>{
   let durable=false,committed=false;
   try{await this.persist(r);durable=true;this.counters.saved++;}catch{this.counters.storage_failures++;}
   if(!durable||Date.now()>=this.retryAfter){
    try{await this.commit(r);committed=true;}
    catch(error){if(!(error instanceof ReceiptIdentityError))this.deferDatabase();}
   }
   if(durable||committed){
    this.forgetVolatile(r);
    if(committed)await unlink(path.join(this.directory,receiptFile(r))).catch(()=>undefined);
    return true;
   }
   const previous=this.volatile.get(r.requestID);
   if(!previous||previous.usage._receipt_seq<r.usage._receipt_seq)this.volatile.set(r.requestID,r);
   return false;
  });
 }
 private async read(file:string,identity:string){
  const handle=await open(path.join(this.directory,file),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_BYTES)throw new ReceiptIdentityError('Oversized receipt');
   // Bound the actual read too, even if a file changes after stat().
   const bytes=Buffer.alloc(MAX_BYTES+1);let length=0;
   while(length<bytes.length){const r=await handle.read(bytes,length,bytes.length-length,null);if(!r.bytesRead)break;length+=r.bytesRead;}
   if(length>MAX_BYTES)throw new ReceiptIdentityError('Oversized receipt');
   this.counters.last_bytes+=length;
   return validateReceipt(JSON.parse(bytes.subarray(0,length).toString('utf8')),file,identity);
  }finally{await handle.close();}
 }
 replay():Promise<number>{
  // Numeric compatibility: 0 means this directory pass reached EOF with no
  // retained failures. Positive means more/retained work, NOT a full file count.
  if(this.replaying)return this.replaying;
  const pending=this.replayPass();this.replaying=pending;
  void pending.finally(()=>{if(this.replaying===pending)this.replaying=undefined;}).catch(()=>undefined);
  return pending;
 }
 private async replayPass(){
  this.counters.replay_passes++;this.counters.last_entries=0;this.counters.last_receipts=0;this.counters.last_bytes=0;
  // No spread/copy of the backlog. This map contains only undurable in-flight
  // requests, and save() removes/replaces entries without growing old versions.
  let flushed=0;
  for(const r of this.volatile.values()){if(flushed++>=MAX_RECEIPTS)break;if(!await this.save(r))break;}
  if(this.volatile.size)return this.volatile.size;
  let identity:string;try{identity=await this.databaseIdentity();}catch{return 1;}
  if(!this.cursor){
   try{this.cursor=await opendir(this.directory,{bufferSize:32});this.cycleRetained=false;}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;this.counters.storage_failures++;return 1;}
  }
  while(this.counters.last_entries<MAX_ENTRIES&&this.counters.last_receipts<MAX_RECEIPTS){
   let file=this.retryFile;this.retryFile=undefined;
   if(!file){
    let entry:Dirent|null;
    try{entry=await this.cursor.read();}catch{
     this.counters.storage_failures++;await this.cursor.close().catch(()=>undefined);this.cursor=undefined;return 1;
    }
    if(!entry){await this.cursor.close();this.cursor=undefined;this.lastRetained=this.cycleRetained;break;}
    this.counters.last_entries++;
    if(!entry.isFile()){if(filePattern.test(entry.name)){this.counters.invalid++;this.cycleRetained=true;}continue;}
    file=entry.name;
   }
   const match=file.match(filePattern);if(!match)continue;
   this.counters.last_receipts++;
   try{
    if(!match[2]){
     // Legacy writers replaced UUID.json in place. Claim it before reading so
     // deleting an old snapshot can never delete their next revision.
     const claimed=`${match[1]}.legacy-${randomUUID()}.json`;
     await rename(path.join(this.directory,file),path.join(this.directory,claimed));file=claimed;
    }
    const receipt=await this.read(file,identity);
    await storageOperation(()=>this.commit(receipt));
    await unlink(path.join(this.directory,file)).catch(error=>{if(error.code!=='ENOENT')throw error;});
   }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')continue;
    if(error instanceof ReceiptIdentityError||error instanceof SyntaxError||['ELOOP','EISDIR','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??'')){
     this.counters.invalid++;this.cycleRetained=true;continue;
    }
    // One unreachable DB/filesystem attempt per pass, not N network timeouts.
    this.retryFile=file;this.deferDatabase();return 1;
   }
  }
  return this.volatile.size+Number(!!this.cursor||!!this.retryFile||this.lastRetained||this.cycleRetained);
 }
 metrics(){return {...this.counters,volatile_requests:this.volatile.size,scan_open:!!this.cursor,replaying:!!this.replaying,
  retained_in_last_scan:this.lastRetained,scan_limits:{entries:MAX_ENTRIES,receipts:MAX_RECEIPTS,receipt_bytes:MAX_BYTES},
  storage_active:operations,storage_waiters:waiters.length};}
 async close(){
  await this.replaying?.catch(()=>undefined);
  if(this.cursor){await this.cursor.close();this.cursor=undefined;}
  // Do not silently throw away the only surviving usage during a double fault.
  if(this.volatile.size)throw new UsageStorageUnavailable();
 }
}
export function configureUsageOutbox(db:Database,dataDir:string){manager(db).configure(path.resolve(dataDir,'usage-outbox'));}
export function assertUsageStorage(db:Database,signal?:AbortSignal){return manager(db).beforeRequest(signal);}
export function saveUsageReceipt(db:Database,receipt:UsageReceipt){return manager(db).save(receipt);}
export function replayUsageOutbox(db:Database){return manager(db).replay();}
export function usageOutboxMetrics(db:Database){return manager(db).metrics();}
export async function closeUsageOutbox(db:Database){const key=db.pool??db,value=managers.get(key);if(value){await value.close();managers.delete(key);}}
