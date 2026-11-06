import {open,readFile,writeFile,rename,unlink,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import type {SessionEntry,SessionManager} from '@earendil-works/pi-coding-agent';
import type {Database} from '../db/index.js';
import {sessionHostStore,isAgentHistory,type HostSnapshot} from '../db/session-host-store.js';
import {assertPlannerHostState} from '../db/planner-host-state.js';
import {assertAgentSessionScope} from '../db/agent-history.js';
import {assertPlannerHistorySnapshot,readPlannerBytes,plannerHistoryLines,type PlannerHistorySnapshot} from '../db/planner-history.js';
import {PLANNER_RECEIPT_INDEX_VERSION} from '../db/planner-receipts.js';

interface Journal {version:1;canonical:string;active:string;sessionID:string;ownerPid:number;archiveBytes:number;archiveTail:string;activeBytes:number;activeHash:string;}
export interface NativeArchiveMetrics {rotations:number;skipped:number;peakEntries:number;lastBefore:number;lastAfter:number;}
export interface PlannerActiveSession {file:string;projected:boolean;sourceEntries:number;activeEntries:number;flush():Promise<void>;close():Promise<void>;
 rebase(manager:SessionManager,index:()=>Promise<HostSnapshot|undefined>,hook?:(stage:RotationStage)=>Promise<void>):Promise<boolean>;
 diagnostics():NativeArchiveMetrics;}
export type RotationStage='candidate'|'prepared'|'switched'|'committed';
interface Projection {journal:Journal;sourceEntries:number;activeEntries:number;}
interface Rotation {version:1;canonical:string;previous:Journal|null;next:Journal;}
const rotationPath=(file:string)=>file+'.rotation.json';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const journalPath=(file:string)=>file+'.active.json';
const liveOwners=new Set<string>();
const releasedPath=(j:Journal)=>j.active+'.released';
async function ownerRunning(j:Journal){
 try{await stat(releasedPath(j));return false;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(j.ownerPid===process.pid)return liveOwners.has(j.active);
 if(!Number.isSafeInteger(j.ownerPid)||j.ownerPid<1)return false; // pre-owner experimental journals
 try{process.kill(j.ownerPid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}
}
async function fileHash(file:string,end:number){const handle=await open(file,'r');try{const h=createHash('sha256');for(let at=0;at<end;at+=64*1024)h.update(await readPlannerBytes(handle,at,Math.min(64*1024,end-at)));return h.digest('hex');}finally{await handle.close();}}
async function tail(file:string,end:number){const h=await open(file,'r');try{const n=Math.min(end,64*1024);return sha(await readPlannerBytes(h,end-n,n));}finally{await h.close();}}
async function syncDirectory(dir:string){const h=await open(dir,'r');try{await h.sync();}finally{await h.close();}}
async function saveAtomic(target:string,value:unknown){const temp=target+'.'+randomUUID()+'.tmp';
 const h=await open(temp,'wx',0o600);try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}
 await rename(temp,target);await syncDirectory(path.dirname(target));
}
const saveJournal=(j:Journal)=>saveAtomic(journalPath(j.canonical),j);
async function loadJournal(canonical:string):Promise<Journal|undefined>{
 let text:string;try{text=await readFile(journalPath(canonical),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 return validateJournal(JSON.parse(text),canonical);
}
function validateJournal(value:unknown,canonical:string):Journal{
 const j=value as Journal,dir=path.join(path.dirname(canonical),'.planner-active');
 if(!j||j.version!==1||j.canonical!==canonical||typeof j.active!=='string'||path.dirname(j.active)!==dir||!path.basename(j.active).endsWith('.jsonl')||
  !Number.isSafeInteger(j.archiveBytes)||!Number.isSafeInteger(j.activeBytes)||j.archiveBytes<1||j.activeBytes<1||!j.sessionID||
  !/^[a-f0-9]{64}$/.test(j.archiveTail)||!/^[a-f0-9]{64}$/.test(j.activeHash))
  throw new Error('活动会话日志无效；保留原文和活动文件，不能重建空会话');
 return j;
}
const remove=async(file:string)=>{await unlink(file).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});};
async function loadRotation(canonical:string):Promise<Rotation|undefined>{
 let text:string;try{text=await readFile(rotationPath(canonical),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 const r=JSON.parse(text) as Rotation;
 if(r.version!==1||r.canonical!==canonical)throw new Error('原生会话切换记录无效；已保留全部文件');
 validateJournal(r.next,canonical);if(r.previous)validateJournal(r.previous,canonical);
 if(r.previous&&(r.previous.sessionID!==r.next.sessionID||r.previous.active===r.next.active||r.previous.archiveBytes!==r.next.archiveBytes||r.previous.archiveTail!==r.next.archiveTail))
  throw new Error('原生会话切换前缀不一致；已保留全部文件');
 return r;
}
async function suffixSize(j:Journal){
 const size=(await stat(j.active)).size;
 if(size<j.activeBytes||await fileHash(j.active,j.activeBytes)!==j.activeHash)throw new Error('活动会话前缀已改变；拒绝覆盖原文');
 return size-j.activeBytes;
}
/** Prepared transitions are recoverable on either side of setSessionFile().
 * Never infer that a candidate became active from a metadata flag alone. */
async function recoverRotation(r:Rotation,owned=false){
 const journals=[r.previous,r.next].filter((j):j is Journal=>!!j);
 if(!owned&&await Promise.all(journals.map(ownerRunning)).then(v=>v.some(Boolean)))throw new Error('原执行器尚未退出，不能恢复会话切换');
 const current=await loadJournal(r.canonical);
 if(current&&!journals.some(j=>j.active===current.active))throw new Error('活动会话存在未识别的写入者；保留切换记录');
 const size=(await stat(r.canonical)).size;
 if(size<r.next.archiveBytes||await tail(r.canonical,r.next.archiveBytes)!==r.next.archiveTail)throw new Error('切换期间原文前缀已变化；拒绝覆盖');
 const nextBytes=await suffixSize(r.next),previousBytes=r.previous?await suffixSize(r.previous):0;
 if(previousBytes&&nextBytes)throw new Error('切换两侧均有新增记录，不能自动合并；原文与两侧文件均已保留');
 if(nextBytes)await flushJournal({...r.next});
 else if(r.previous)await flushJournal({...r.previous});
 // In the first direct->active transition, canonical-only appends are already
 // original records. If next has appends, flushJournal verifies exact overlap.
 await remove(journalPath(r.canonical));await remove(rotationPath(r.canonical));await syncDirectory(path.dirname(r.canonical));
 for(const j of journals){await remove(j.active);await remove(releasedPath(j));liveOwners.delete(j.active);}
 await syncDirectory(path.dirname(r.next.active));
}

/** The active JSONL is a native PI append log. The immutable projection prefix
 * is never copied back. New original records are copied byte-for-byte, with
 * overlap verification so a crash between append and manifest commit is safe. */
async function flushJournal(j:Journal){
 const original=await open(j.canonical,'r+'),active=await open(j.active,'r');
 try{
  const os=await original.stat(),as=await active.stat();
  if(os.size<j.archiveBytes||as.size<j.activeBytes||await tail(j.canonical,j.archiveBytes)!==j.archiveTail||await fileHash(j.active,j.activeBytes)!==j.activeHash)
   throw new Error('Planner 会话原文或活动前缀已改变；已保留两个文件，拒绝覆盖');
  const size=as.size-j.activeBytes,existing=os.size-j.archiveBytes;
  if(existing>size)throw new Error('Planner 原文出现活动会话之外的写入；保留文件，需先核对恢复');
  // Only complete native JSONL entries may be archived; incomplete writes are
  // retained for repair, never silently discarded or executed again.
  if(size&&!(await readPlannerBytes(active,as.size-1,1)).equals(Buffer.from('\n')))throw new Error('Planner 活动会话尾部未写完整；保留原文等待恢复');
  for await(const line of plannerHistoryLines(active,j.activeBytes,as.size)){
   try{const e=JSON.parse(line.raw.toString('utf8'));if(!e||typeof e.id!=='string'||typeof e.type!=='string'||e.type==='session')throw new Error();}
   catch{throw new Error('Planner 活动会话新增条目损坏；保留原文和活动文件等待恢复');}
  }
  for(let offset=0;offset<existing;offset+=64*1024){const n=Math.min(64*1024,existing-offset);
   if(!(await readPlannerBytes(original,j.archiveBytes+offset,n)).equals(await readPlannerBytes(active,j.activeBytes+offset,n)))throw new Error('Planner 原文与待归档记录冲突；拒绝重复或覆盖写入');
  }
  for(let offset=existing;offset<size;offset+=64*1024){const data=await readPlannerBytes(active,j.activeBytes+offset,Math.min(64*1024,size-offset));let wrote=0;
   while(wrote<data.length){const r=await original.write(data,wrote,data.length-wrote,j.archiveBytes+offset+wrote);if(!r.bytesWritten)throw new Error('Planner 原文写入未完成');wrote+=r.bytesWritten;}
  }
  if(size){await original.sync();j.archiveBytes+=size;j.activeBytes+=size;j.archiveTail=await tail(j.canonical,j.archiveBytes);j.activeHash=await fileHash(j.active,j.activeBytes);await saveJournal(j);}
 }finally{await active.close();await original.close();}
}
/** Called under the existing single-writer Planner lock, before indexing/open. */
export async function recoverPlannerActiveSession(filename:string){const canonical=path.resolve(filename),rotation=await loadRotation(canonical);
 if(rotation){await recoverRotation(rotation);return;}
 const j=await loadJournal(canonical);if(!j)return;
 // A lost DB connection releases its advisory lock before the old executor has
 // actually exited. Do not race its native file writer merely because a new
 // process acquired that lock. Only an exited/released owner can be recovered.
 if(await ownerRunning(j))throw new Error('Planner 原执行器尚未退出；活动会话保持独占，等待实际退出后恢复');
 await flushJournal(j);await unlink(journalPath(canonical));await syncDirectory(path.dirname(canonical));await unlink(j.active);
 await unlink(releasedPath(j)).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});
}

/** Public SessionManager.open() reads this compaction-aware projection. The
 * canonical file, IDs and evidence remain unchanged; no private SDK mutation. */
async function createProjection(db:Database,s:HostSnapshot|undefined,canonical:string,leafID?:string|null):Promise<Projection|undefined>{
 if(!s||!s.count)return;
 if(path.resolve(s.file)!==canonical)throw new Error('原始会话路径与索引不一致');
 const store=sessionHostStore(s);
 if(isAgentHistory(s)){
  await assertAgentSessionScope(db,s.scope);await assertPlannerHostState(db,s);
  const info=await stat(s.file,{bigint:true});
  if(String(info.dev)!==s.device||String(info.ino)!==s.inode||Number(info.size)<s.bytes||Number(info.size)===s.bytes&&String(info.mtimeNs)!==s.mtime)throw new Error('原始会话已变化，请重新建立活动投影');
 }else {
  await assertPlannerHistorySnapshot(db,s);
  const version=(await db.query('SELECT receipt_index_version FROM planner_history_sources WHERE exploration_id=$1',[s.expID])).rows[0];
  if(Number(version?.receipt_index_version)!==PLANNER_RECEIPT_INDEX_VERSION)throw new Error('Planner 派单索引尚未建立，不能释放本轮原文');
 }
 const result=await db.transaction(async tx=>{
  await tx.query('SET LOCAL jit=off');
  return tx.query(`WITH RECURSIVE branch AS (
   SELECT ordinal,entry_id,parent_id,entry_type,runtime_meta,byte_offset,byte_length,raw_hash FROM ${store.entries}
    WHERE ${store.column}=$1 AND (($3::text IS NULL AND ordinal=$2-1) OR entry_id=$3) AND ordinal<$2
   UNION ALL SELECT p.* FROM branch b JOIN LATERAL (
    SELECT ordinal,entry_id,parent_id,entry_type,runtime_meta,byte_offset,byte_length,raw_hash FROM ${store.entries}
     WHERE ${store.column}=$1 AND entry_id=b.parent_id AND ordinal<b.ordinal OFFSET 0
   ) p ON true
  ), compact AS (SELECT * FROM branch WHERE entry_type='compaction' ORDER BY ordinal DESC LIMIT 1),
  boundary AS (SELECT LEAST(c.ordinal,COALESCE((SELECT ordinal FROM branch WHERE entry_id=c.runtime_meta->>'firstKeptEntryId'),c.ordinal),
    ${isAgentHistory(s)?`COALESCE((SELECT min(ordinal) FROM ${store.table} WHERE ${store.column}=$1 AND namespace='delivery' AND incomplete IS TRUE),c.ordinal)`:'c.ordinal'}) first FROM compact c),
  settings AS (SELECT DISTINCT ON(entry_type) entry_id FROM branch WHERE entry_type IN ('model_change','thinking_level_change','session_info') ORDER BY entry_type,ordinal DESC),
  last_model_before AS (SELECT entry_id,entry_type,runtime_meta->'model' model FROM branch WHERE ordinal<(SELECT first FROM boundary) AND runtime_meta ? 'model' ORDER BY ordinal DESC LIMIT 1),
  previous_model AS (SELECT entry_id,model FROM last_model_before WHERE entry_type='message' AND NOT EXISTS(
   SELECT 1 FROM branch WHERE ordinal>=(SELECT first FROM boundary) AND runtime_meta ? 'model'))
  , selected AS (SELECT b.*,(SELECT first FROM boundary) first,true in_branch FROM branch b WHERE
   b.ordinal>=COALESCE((SELECT first FROM boundary),0) OR b.entry_id IN (SELECT entry_id FROM settings) OR
   (b.entry_type='custom' AND COALESCE(b.runtime_meta->>'customType','') NOT IN ('planner_delivery','planner_delivery_completed','planner_grounded_result','fate_native_activity_run_v1')))
  SELECT *,(SELECT model FROM previous_model) projection_model,(SELECT entry_id FROM previous_model) projection_model_source FROM selected WHERE first IS NOT NULL UNION ALL
  SELECT e.ordinal,e.entry_id,e.parent_id,e.entry_type,e.runtime_meta,e.byte_offset,e.byte_length,e.raw_hash,(SELECT first FROM boundary),false
   ,(SELECT model FROM previous_model),(SELECT entry_id FROM previous_model)
   FROM ${store.entries} e WHERE e.${store.column}=$1 AND e.ordinal<$2 AND e.entry_type='custom' AND EXISTS(SELECT 1 FROM boundary)
    AND COALESCE(e.runtime_meta->>'customType','') NOT IN ('planner_delivery','planner_delivery_completed','planner_grounded_result','fate_native_activity_run_v1')
    -- Both ordinals are NOT NULL and unique within this source. The
    -- uncorrelated membership test avoids a badly estimated nested-loop anti
    -- join over every retained extension entry and the complete native branch.
    AND e.ordinal NOT IN (SELECT b.ordinal FROM branch b)
  ORDER BY ordinal`,[store.key,s.count,leafID??null]);
 });
 // No successful native compaction means there is nothing safe to discard.
 if(!result.rows.length||result.rows[0]!.first===null||result.rows.length>=s.count)return;
 const dir=path.join(path.dirname(canonical),'.planner-active');await mkdir(dir,{recursive:true});
 const active=path.join(dir,`${s.expID}-${randomUUID()}.jsonl`),source=await open(canonical,'r'),dest=await open(active,'wx',0o600);
 let bytes=0,extraEntries=0;const digest=createHash('sha256');
 try{
  const header=(await db.query(`SELECT header FROM ${store.sources} WHERE ${store.column}=$1 AND generation=$2`,[store.key,s.generation])).rows[0]?.header;
  if(!header||(header as {version:number}).version!==3)throw new Error('Planner 活动投影需要 PI v3 会话；原文已保留');
  const write=async(value:unknown)=>{const data=Buffer.from(JSON.stringify(value)+'\n');await dest.writeFile(data);bytes+=data.length;digest.update(data);};
  await write(header);let parentId:string|null=null;
  for(const r of result.rows){const raw=await readPlannerBytes(source,Number(r.byte_offset),Number(r.byte_length));if(sha(raw)!==r.raw_hash)throw new Error('Planner 原文与索引不一致');
   const entry=JSON.parse(raw.toString('utf8')) as SessionEntry;
   if(!extraEntries&&r.in_branch&&Number(r.ordinal)>=Number(r.first)&&r.projection_model){
    // Projection-only native setting: PI otherwise falls back to an earlier
    // model_change when its later assistant was summarized away. This prefix
    // is never archived, never sent as model text, and never replaces evidence.
    const id='projection_model_'+sha(JSON.stringify([s.sessionID,r.projection_model_source,r.first])).slice(0,32);
    await write({type:'model_change',id,parentId,timestamp:entry.timestamp,...r.projection_model});parentId=id;extraEntries++;
   }
   await write(r.in_branch?{...entry,parentId}:entry);if(r.in_branch)parentId=entry.id;
  }
  await dest.sync();
 }catch(error){await dest.close();await source.close();await unlink(active);throw error;}
 await dest.close();await source.close();await syncDirectory(dir);
 const j:Journal={version:1,canonical,active,sessionID:s.sessionID,ownerPid:process.pid,archiveBytes:s.bytes,archiveTail:await tail(canonical,s.bytes),activeBytes:bytes,activeHash:digest.digest('hex')};
 return {journal:j,sourceEntries:s.count,activeEntries:result.rows.length+extraEntries};
}

/** One native writer, with serialized archival and crash-safe compaction rebasing. */
export async function prepareNativeActiveSession(db:Database,s:HostSnapshot|undefined,filename:string):Promise<PlannerActiveSession>{
 const canonical=path.resolve(filename);
 if(await loadJournal(canonical)||await loadRotation(canonical))throw new Error('活动会话尚未恢复，不能覆盖待归档记录');
 let current=await createProjection(db,s,canonical),pending=Promise.resolve(),closing:Promise<void>|undefined,unresolved:Rotation|undefined;
 const metrics:NativeArchiveMetrics={rotations:0,skipped:0,peakEntries:current?.activeEntries??s?.count??0,lastBefore:s?.count??0,lastAfter:current?.activeEntries??s?.count??0};
 if(current){await saveJournal(current.journal);liveOwners.add(current.journal.active);}
 const file=()=>current?.journal.active??canonical;
 const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const result=pending.then(fn);pending=result.then(()=>{},()=>{});return result;};
 const flush=async()=>{if(unresolved)throw new Error('原生会话切换未完成，停止后从保留记录恢复');if(current)await flushJournal(current.journal);};
 return {
  get file(){return file();},get projected(){return !!current;},
  get sourceEntries(){return current?.sourceEntries??s?.count??0;},get activeEntries(){return current?.activeEntries??s?.count??0;},
  diagnostics:()=>({...metrics}),
  flush:()=>closing?Promise.reject(new Error('活动会话已关闭')):serial(flush),
  rebase:(manager,index,hook)=>{
   if(closing)return Promise.reject(new Error('活动会话已关闭'));
   return serial(async()=>{
    if(path.resolve(manager.getSessionFile()??'')!==file())throw new Error('原生会话写入路径已变化，不能切换');
    const count=manager.getEntryCount(),leaf=manager.getLeafId(),identity=manager.getSessionId();metrics.peakEntries=Math.max(metrics.peakEntries,count);
    await flush();const snapshot=await index();
    if(!snapshot||snapshot.sessionID!==identity)throw new Error('原生会话与原文索引身份不一致');
    const candidate=await createProjection(db,snapshot,canonical,leaf);
    if(!candidate){metrics.skipped++;return false;}
    const changed=()=>manager.getEntryCount()!==count||manager.getLeafId()!==leaf||manager.getSessionId()!==identity||path.resolve(manager.getSessionFile()??'')!==file();
    const discard=async()=>{await remove(candidate.journal.active);liveOwners.delete(candidate.journal.active);};
    try{await hook?.('candidate');}catch(error){await discard();throw error;}
    if(candidate.activeEntries>=count||changed()){metrics.skipped++;await discard();return false;}
    const rotation:Rotation={version:1,canonical,previous:current?{...current.journal}:null,next:{...candidate.journal}};
    unresolved=rotation;liveOwners.add(candidate.journal.active);
    // The candidate contains copies only until the public native switch. Record
    // both prefixes durably before that point; no journal cursor is guessed.
    await saveAtomic(rotationPath(canonical),rotation);await hook?.('prepared');
    if(changed()){
     await remove(rotationPath(canonical));await syncDirectory(path.dirname(canonical));unresolved=undefined;metrics.skipped++;await discard();return false;
    }
    const previous=current;
    // No await between final native-state validation and switching its writer.
    manager.setSessionFile(candidate.journal.active);if(leaf)manager.branch(leaf);
    current=candidate;
    await hook?.('switched');await saveJournal(candidate.journal);await hook?.('committed');
    await remove(rotationPath(canonical));await syncDirectory(path.dirname(canonical));unresolved=undefined;
    if(previous){await remove(previous.journal.active);await remove(releasedPath(previous.journal));liveOwners.delete(previous.journal.active);}
    metrics.rotations++;metrics.lastBefore=count;metrics.lastAfter=manager.getEntryCount();
    return true;
   });
  },
  close:()=>closing??(closing=serial(async()=>{
   const journals=[unresolved?.previous,unresolved?.next,current?.journal].filter((j):j is Journal=>!!j);
   try{
    if(unresolved){await recoverRotation(unresolved,true);return;}
    if(current){await flush();await remove(journalPath(canonical));await syncDirectory(path.dirname(canonical));await remove(current.journal.active);}
   }catch(error){
    for(const j of journals)await writeFile(releasedPath(j),'executor exited\n',{mode:0o600});
    throw error;
   }finally{for(const j of journals)liveOwners.delete(j.active);}
  })),
 };
}

/** Compatibility entrypoint; Planner persistence and delivery semantics are unchanged. */
export function preparePlannerActiveSession(db:Database,s:PlannerHistorySnapshot|undefined,filename:string){return prepareNativeActiveSession(db,s,filename);}
