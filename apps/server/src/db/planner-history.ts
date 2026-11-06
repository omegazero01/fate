import {createHash,randomUUID} from 'node:crypto';
import {open,stat,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import type {Database} from './index.js';
import {plannerHistoryEntry,plannerHistoryParts,plannerHistoryPartsAsync,plannerTextCacheable,sessionRuntimeMeta} from '../agent/planner-history-entry.js';
import {indexPlannerHostEntries,PLANNER_HOST_INDEX_VERSION} from './planner-host-state.js';
import {indexPlannerReceiptEntries,PLANNER_RECEIPT_INDEX_VERSION} from './planner-receipts.js';
import {unicodeLength,unicodeSlice} from '../unicode.js';
import {textHashAsync} from '../async-text.js';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export interface PlannerHistorySnapshot {
 taskID:number;expID:number;sessionID:string;generation:string;file:string;device:string;inode:string;
 bytes:number;count:number;mtime:string;scannedBytes:number;indexedEntries:number;
}
export type PlannerHistoryHit=Omit<NonNullable<ReturnType<typeof plannerHistoryEntry>>,'content'>&{index:number;summary:string;match_offset:number;total_chars:number;content?:string};
const snapshot=(r:Record<string,unknown>,scannedBytes=0,indexedEntries=0):PlannerHistorySnapshot=>({
 taskID:Number(r.task_id),expID:Number(r.exploration_id),sessionID:String(r.session_id),generation:String(r.generation),
 file:String(r.source_path),device:String(r.device),inode:String(r.inode),bytes:Number(r.indexed_bytes),count:Number(r.entry_count),mtime:String(r.source_mtime),scannedBytes,indexedEntries,
});

/** Byte offsets survive Unicode, CRLF, blank lines and records spanning chunks.
 * Memory scales with one original record plus the bounded index batch. */
export async function* plannerHistoryLines(file:FileHandle,start:number,end:number){
 if(start>=end)return;
 let pieces:Buffer[]=[],length=0,offset=start;
 for(let position=start;position<end;){
  const buffer=Buffer.allocUnsafe(Math.min(64*1024,end-position)),r=await file.read(buffer,0,buffer.length,position);
  if(!r.bytesRead)throw new Error('Planner 历史原文被截断');position+=r.bytesRead;
  const data=buffer.subarray(0,r.bytesRead);let begin=0,at:number;
  while((at=data.indexOf(10,begin))>=0){
   const last=data.subarray(begin,at),raw=pieces.length?Buffer.concat([...pieces,last],length+last.length):last;
   yield {raw,offset,end:offset+raw.length+1};offset+=raw.length+1;pieces=[];length=0;begin=at+1;
  }
  if(begin<data.length){const part=data.subarray(begin);pieces.push(part);length+=part.length;}
 }
 if(length)yield {raw:Buffer.concat(pieces,length),offset,end:offset+length};
}
export async function readPlannerBytes(file:FileHandle,offset:number,length:number){
 const buffer=Buffer.alloc(length);let read=0;
 while(read<length){const r=await file.read(buffer,read,length-read,offset+read);if(!r.bytesRead)throw new Error('Planner 历史原文被截断');read+=r.bytesRead;}
 return buffer;
}
const readBytes=readPlannerBytes;
async function tailHash(file:FileHandle,end:number){const length=Math.min(end,64*1024);return hash(await readBytes(file,end-length,length));}

/** Called under the existing Planner session ownership lock. A separate try-lock
 * also protects rebuilds invoked by diagnostics/tests; it never waits in the pool. */
export async function syncPlannerHistory(db:Database,taskID:number,expID:number,filename:string,signal?:AbortSignal):Promise<PlannerHistorySnapshot|undefined>{
 signal?.throwIfAborted();const filePath=path.resolve(filename),client=await db.pool.connect(),lock=`fate:planner-history:${expID}`;
 let locked=false,file:FileHandle|undefined,inTransaction=false;
 try{
  locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked',[lock])).rows[0].locked;
  if(!locked)throw new Error('Planner 历史索引正在更新，请稍后重试');
  const owner=(await client.query('SELECT 1 FROM tasks WHERE id=$1 AND exploration_id=$2 AND deleted_at IS NULL',[taskID,expID])).rowCount;
  if(!owner)throw new Error('Planner 历史任务不存在或归属已变化');
  let previous=(await client.query('SELECT * FROM planner_history_sources WHERE exploration_id=$1',[expID])).rows[0];
  try{file=await open(filePath,'r');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&!previous)return;throw error;}
  const info=await file.stat({bigint:true}),size=Number(info.size),mtime=String(info.mtimeNs),device=String(info.dev),inode=String(info.ino);
  if(!Number.isSafeInteger(size)||!size)throw new Error('Planner 会话文件为空或大小无效；保留原文，不创建替代会话');
  if(previous&&(Number(previous.host_index_version)!==PLANNER_HOST_INDEX_VERSION||Number(previous.receipt_index_version)!==PLANNER_RECEIPT_INDEX_VERSION||Number(previous.task_id)!==taskID||previous.source_path!==filePath||previous.device!==device||previous.inode!==inode||
    Number(previous.indexed_bytes)>size||Number(previous.source_size)===size&&previous.source_mtime!==mtime||
    await tailHash(file,Number(previous.indexed_bytes))!==previous.tail_hash)){
   // Delete only the rebuildable projection, never the native transcript.
   await client.query('DELETE FROM planner_history_sources WHERE exploration_id=$1',[expID]);previous=undefined;
  }
  if(previous&&Number(previous.indexed_bytes)===size&&previous.source_mtime===mtime)return snapshot(previous);
  const start=Number(previous?.indexed_bytes??0),generation=String(previous?.generation??randomUUID());
  let count=Number(previous?.entry_count??0),end=start,header=previous?.header,added=0,batchBytes=0;
  let entries:Record<string,unknown>[]=[],parts:Record<string,unknown>[]=[],hostEntries:{ordinal:number;entry:SessionEntry}[]=[];
  const flush=async()=>{
   signal?.throwIfAborted();if(!header)return;
   const tail=await tailHash(file!,end);
   await client.query('BEGIN');inTransaction=true;
   await client.query(`INSERT INTO planner_history_sources(exploration_id,task_id,generation,session_id,source_path,device,inode,indexed_bytes,source_size,source_mtime,tail_hash,entry_count,header)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT(exploration_id) DO UPDATE SET indexed_bytes=EXCLUDED.indexed_bytes,source_size=EXCLUDED.source_size,
     source_mtime=EXCLUDED.source_mtime,tail_hash=EXCLUDED.tail_hash,entry_count=EXCLUDED.entry_count,updated_at=now()`,
    [expID,taskID,generation,header.id,filePath,device,inode,end,size,mtime,tail,count,JSON.stringify(header)]);
   if(entries.length){
    // One oversized entry already exceeds the batch budget. Send its text as
    // a parameter instead of serializing a second huge JSON object around it.
    if(entries.length===1&&batchBytes>=512*1024){
     const e=entries[0]!;
     await client.query(`INSERT INTO planner_history_entries(exploration_id,ordinal,entry_id,parent_id,entry_type,byte_offset,byte_length,raw_hash,metadata,content,content_chars,content_hash,runtime_meta)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb)`,[expID,e.ordinal,e.entry_id,e.parent_id,e.entry_type,e.byte_offset,e.byte_length,e.raw_hash,JSON.stringify(e.metadata),e.content,e.content_chars,e.content_hash,JSON.stringify(e.runtime_meta)]);
     for(const p of parts){signal?.throwIfAborted();await client.query(`INSERT INTO planner_history_parts(exploration_id,ordinal,part_no,start_char,folded,expansions) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[expID,p.ordinal,p.part_no,p.start_char,p.folded,JSON.stringify(p.expansions)]);}
    }else{
     await client.query(`INSERT INTO planner_history_entries(exploration_id,ordinal,entry_id,parent_id,entry_type,byte_offset,byte_length,raw_hash,metadata,content,content_chars,content_hash,runtime_meta)
      SELECT $1,x.* FROM jsonb_to_recordset($2::jsonb) x(ordinal bigint,entry_id text,parent_id text,entry_type text,byte_offset bigint,byte_length bigint,raw_hash text,metadata jsonb,content text,content_chars bigint,content_hash text,runtime_meta jsonb)`,[expID,JSON.stringify(entries)]);
     await client.query(`INSERT INTO planner_history_parts(exploration_id,ordinal,part_no,start_char,folded,expansions)
      SELECT $1,x.* FROM jsonb_to_recordset($2::jsonb) x(ordinal bigint,part_no int,start_char bigint,folded text,expansions jsonb)`,[expID,JSON.stringify(parts)]);
    }
    await indexPlannerHostEntries(client,expID,hostEntries);
    await indexPlannerReceiptEntries(client,taskID,expID,hostEntries);
   }
   await client.query('UPDATE planner_history_sources SET host_index_version=$2,receipt_index_version=$3 WHERE exploration_id=$1',[expID,PLANNER_HOST_INDEX_VERSION,PLANNER_RECEIPT_INDEX_VERSION]);
   await client.query('COMMIT');inTransaction=false;entries=[];parts=[];hostEntries=[];batchBytes=0;
  };
  for await(const line of plannerHistoryLines(file,start,size)){
   signal?.throwIfAborted();const large=line.raw.length>=512*1024;
   if(large&&entries.length)await flush();
   end=line.end;
   const text=line.raw.toString('utf8');if(!text.trim())continue;
   if(large){await yieldLoop();signal?.throwIfAborted();}
   let value:SessionEntry;
   try{value=JSON.parse(text);}catch{throw new Error('Planner 会话文件损坏，已保留原文；修复后可继续建立索引');}
   if(large){await yieldLoop();signal?.throwIfAborted();}
   if(!header){if((value as unknown as {type:string}).type!=='session'||!value.id)throw new Error('Planner 会话缺少有效原始头部');header=value;continue;}
   if(!value.id||!value.type||(value as unknown as {type:string}).type==='session')throw new Error('Planner 会话条目无效');
   const projected=plannerHistoryEntry(value),ordinal=count++;
   hostEntries.push({ordinal,entry:value});
   const content=projected?.content??null,metadata=projected?Object.fromEntries(Object.entries(projected).filter(([key])=>key!=='content')):null;
   const cacheable=content===null||plannerTextCacheable(content);
   if(large){await yieldLoop();signal?.throwIfAborted();}
   const contentChars=content===null?null:unicodeLength(content);
   if(large){await yieldLoop();signal?.throwIfAborted();}
   const contentHash=content===null?null:large?await textHashAsync(content,signal):hash(content);
   if(large){await yieldLoop();signal?.throwIfAborted();}
   entries.push({ordinal,entry_id:value.id,parent_id:value.parentId,entry_type:value.type,byte_offset:line.offset,byte_length:line.raw.length,raw_hash:hash(line.raw),metadata,content:cacheable?content:null,
    content_chars:contentChars,content_hash:contentHash,
    runtime_meta:sessionRuntimeMeta(value)});
   if(large){await yieldLoop();signal?.throwIfAborted();}
   const projectedParts=large?await plannerHistoryPartsAsync(value,content??'',signal):plannerHistoryParts(value,content??'');
   for(const [part_no,part] of projectedParts.entries())parts.push({ordinal,part_no,start_char:part.start,folded:part.folded,expansions:part.expansions});
   added++;batchBytes+=line.raw.length;
   if(entries.length>=64||batchBytes>=512*1024)await flush();
  }
  if(!header)throw new Error('Planner 会话文件无有效条目');
  const current=await stat(filePath,{bigint:true});
  if(String(current.dev)!==device||String(current.ino)!==inode||current.size<info.size)throw new Error('Planner 原始会话在索引期间被替换或截断');
  await flush();
  if(added>=1000){await client.query('ANALYZE planner_history_parts');await client.query('ANALYZE planner_host_state');}
  return {taskID,expID,sessionID:String(header.id),generation,file:filePath,device,inode,bytes:end,count,mtime,scannedBytes:size-start,indexedEntries:added};
 }catch(error){if(inTransaction)await client.query('ROLLBACK');throw error;}
 finally{await file?.close();try{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}finally{client.release();}}
}

export async function assertPlannerHistorySnapshot(db:Database,s:PlannerHistorySnapshot){
 const row=(await db.query('SELECT generation FROM planner_history_sources WHERE exploration_id=$1 AND task_id=$2',[s.expID,s.taskID])).rows[0];
 if(row?.generation!==s.generation)throw new Error('Planner 历史索引已重建，请重新检索');
 const info=await stat(s.file,{bigint:true});
 if(String(info.dev)!==s.device||String(info.ino)!==s.inode||Number(info.size)<s.bytes||Number(info.size)===s.bytes&&String(info.mtimeNs)!==s.mtime)
  throw new Error('Planner 原始会话已变化，请重新检索');
}
const assertSnapshot=assertPlannerHistorySnapshot;

export async function searchIndexedPlannerHistory(db:Database,s:PlannerHistorySnapshot,q:string,before:number,limit:number,roles?:readonly string[]):Promise<PlannerHistoryHit[]>{
 await assertSnapshot(db,s);
 if(!plannerTextCacheable(q))throw new Error('历史关键词不能包含 NUL 或孤立代理字符；可按已有引用读取原文');
 const folded=q.toLocaleLowerCase(),pattern='%'+folded.replace(/[\\%_]/g,'\\$&')+'%';
 const rows=(await db.query(`WITH matched_parts AS MATERIALIZED (
  SELECT DISTINCT ON(p.ordinal) p.ordinal,p.start_char,p.expansions,greatest(0,strpos(p.folded,$4)-1) folded_offset
  FROM planner_history_parts p WHERE p.exploration_id=$1 AND p.ordinal<$2 AND p.ordinal<$3 AND ($4='' OR p.folded LIKE $5)
   ${roles?.length?"AND EXISTS(SELECT 1 FROM planner_history_entries selected WHERE selected.exploration_id=p.exploration_id AND selected.ordinal=p.ordinal AND selected.metadata->>'role'=ANY($7::text[]))":''}
  ORDER BY p.ordinal DESC,p.part_no LIMIT $6
 ), matches AS (
  SELECT p.ordinal,p.start_char+p.folded_offset-CASE WHEN p.folded_offset=0 THEN 0 ELSE COALESCE((
   SELECT sum(full_count*e.by+CASE WHEN full_count<e.n THEN least(e.by,greatest(0,p.folded_offset-e.at-full_count*e.step)) ELSE 0 END)
   FROM jsonb_array_elements(p.expansions) x CROSS JOIN LATERAL (SELECT (x->>'at')::bigint at,(x->>'by')::bigint by,
    COALESCE((x->>'count')::bigint,1) n,COALESCE((x->>'step')::bigint,1) step OFFSET 0) e
   CROSS JOIN LATERAL (SELECT least(e.n,greatest(0,floor((p.folded_offset-e.at-e.by)::numeric/e.step)+1)) full_count OFFSET 0) f
  ),0) END match_offset FROM matched_parts p
 ) SELECT m.ordinal,m.match_offset,e.metadata,e.content_chars,
  substring(e.content FROM greatest(0,m.match_offset-60)::int+1 FOR (m.match_offset+240-greatest(0,m.match_offset-60))::int) summary
 FROM matches m JOIN planner_history_entries e ON e.exploration_id=$1 AND e.ordinal=m.ordinal ORDER BY m.ordinal DESC`,
 [s.expID,before,s.count,folded,pattern,limit,...(roles?.length?[roles]:[])])).rows;
 const hits:PlannerHistoryHit[]=[];
 for(const r of rows){
  const metadata=r.metadata as Omit<PlannerHistoryHit,'index'|'summary'|'match_offset'>,offset=Number(r.match_offset);
  const summary=r.summary===null?unicodeSlice(plannerHistoryEntry(await getIndexedPlannerEntry(db,s,metadata.ref.slice(8)))!.content,Math.max(0,offset-60),offset+240):String(r.summary);
  hits.push({index:Number(r.ordinal),...metadata,summary,match_offset:offset,total_chars:Number(r.content_chars)});
 }
 return hits;
}

export async function readIndexedPlannerContent(db:Database,s:PlannerHistorySnapshot,id:string,offset:number,limit:number){
 await assertSnapshot(db,s);
 const r=(await db.query(`SELECT substring(content FROM $4::int+1 FOR $5::int) content,content_chars,content_hash
  FROM planner_history_entries WHERE exploration_id=$1 AND entry_id=$2 AND ordinal<$3 AND metadata IS NOT NULL`,[s.expID,id,s.count,offset,limit])).rows[0];
 if(!r)throw new Error('当前 Planner 会话中不存在该条目');
 if(r.content===null)return undefined;
 return {content:String(r.content),total:Number(r.content_chars),source_hash:String(r.content_hash)};
}

export async function getIndexedPlannerEntry(db:Database,s:PlannerHistorySnapshot,id:string):Promise<SessionEntry>{
 await assertSnapshot(db,s);
 const r=(await db.query('SELECT byte_offset,byte_length,raw_hash FROM planner_history_entries WHERE exploration_id=$1 AND entry_id=$2 AND ordinal<$3',[s.expID,id,s.count])).rows[0];
 if(!r)throw new Error('当前 Planner 会话中不存在该条目');
 const file=await open(s.file,'r');try{const raw=await readBytes(file,Number(r.byte_offset),Number(r.byte_length));
  if(hash(raw)!==r.raw_hash)throw new Error('Planner 历史原文与索引不一致，请重新检索');return JSON.parse(raw.toString('utf8'));
 }finally{await file.close();}
}
