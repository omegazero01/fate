import {createHash,randomUUID} from 'node:crypto';
import {open,stat,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import type {Database} from './index.js';
import {plannerHistoryLines,readPlannerBytes} from './planner-history.js';
import {indexPlannerHostEntries,PLANNER_HOST_INDEX_VERSION} from './planner-host-state.js';
import {sessionRuntimeMeta} from '../agent/planner-history-entry.js';

export interface AgentSessionScope {taskID:number;expID:number;role:string;intentID?:number;mainSeg?:number;conversationID?:number;}
export interface AgentHistorySnapshot {
 kind:'agent';key:string;scope:AgentSessionScope;taskID:number;expID:number;sessionID:string;generation:string;
 file:string;device:string;inode:string;bytes:number;count:number;mtime:string;scannedBytes:number;indexedEntries:number;
}
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const normalized=(s:AgentSessionScope):AgentSessionScope=>({taskID:s.taskID||0,expID:s.expID||0,role:s.role,
 ...(s.intentID?{intentID:s.intentID}:{}),...(s.role==='mainagent'?{mainSeg:s.mainSeg??0}:{}),...(s.conversationID?{conversationID:s.conversationID}:{})});
const snapshot=(r:Record<string,any>,scannedBytes=0,indexedEntries=0):AgentHistorySnapshot=>({kind:'agent',key:r.session_key,scope:r.scope,
 taskID:Number(r.task_id)||0,expID:Number(r.exploration_id)||0,sessionID:r.session_id,generation:r.generation,file:r.source_path,
 device:r.device,inode:r.inode,bytes:Number(r.indexed_bytes),count:Number(r.entry_count),mtime:r.source_mtime,scannedBytes,indexedEntries});
async function tail(file:FileHandle,end:number){return sha(await readPlannerBytes(file,Math.max(0,end-65536),Math.min(end,65536)));}
export async function assertAgentSessionScope(db:Database,scope:AgentSessionScope){
 if(scope.taskID){
  if(!(await db.query('SELECT 1 FROM tasks WHERE id=$1 AND exploration_id=$2 AND deleted_at IS NULL',[scope.taskID,scope.expID])).rowCount)throw new Error('会话任务不存在或归属已变化');
 }else if(scope.expID||scope.intentID)throw new Error('会话缺少所属任务');
 if(scope.conversationID){
  if(!(await db.query('SELECT 1 FROM conversations WHERE id=$1 AND agent_key=$2 AND COALESCE(task_id,0)=$3',[scope.conversationID,scope.role,scope.taskID])).rowCount)throw new Error('会话归属已变化');
 }else if(scope.role==='worker'){
  if(!scope.intentID||!(await db.query("SELECT 1 FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='intent'",[scope.intentID,scope.expID])).rowCount)throw new Error('Worker 历史仅限当前意图');
 }else if(scope.role!=='mainagent'||!scope.taskID||!Number.isSafeInteger(scope.mainSeg)||(scope.mainSeg??-1)<0)throw new Error('无效的 Agent 会话范围');
}
const active=new WeakMap<object,Map<string,Promise<AgentHistorySnapshot|undefined>>>();
/** Same-session callers share only an in-flight synchronization, never a stale
 * host snapshot. No connection is held while reading/parsing the original. */
export async function syncAgentHistory(db:Database,input:AgentSessionScope,filename:string,signal?:AbortSignal):Promise<AgentHistorySnapshot|undefined>{
 const scope=normalized(input),file=path.resolve(filename),key=sha(file),identity=key+sha(JSON.stringify(scope));
 let pending=active.get(db.pool);if(!pending){pending=new Map();active.set(db.pool,pending);}
 const existing=pending.get(identity);if(existing)return existing;
 const work=sync(db,scope,file,key,signal);pending.set(identity,work);
 try{return await work;}finally{if(pending.get(identity)===work)pending.delete(identity);}
}
async function sync(db:Database,scope:AgentSessionScope,filePath:string,key:string,signal?:AbortSignal):Promise<AgentHistorySnapshot|undefined>{
 signal?.throwIfAborted();await assertAgentSessionScope(db,scope);
 const previous=(await db.query('SELECT * FROM agent_session_sources WHERE session_key=$1',[key])).rows[0];
 if(previous&&(previous.source_path!==filePath||JSON.stringify(normalized(previous.scope as AgentSessionScope))!==JSON.stringify(scope)))throw new Error('原始会话已绑定其他执行范围，不能复用历史');
 let file:FileHandle;
 try{file=await open(filePath,'r');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'&&!previous)return;throw e;}
 try{
  const info=await file.stat({bigint:true}),size=Number(info.size),mtime=String(info.mtimeNs),device=String(info.dev),inode=String(info.ino);
  if(!size||!Number.isSafeInteger(size))throw new Error('会话原文为空或大小无效；保留文件，不能创建替代会话');
  if(!(await readPlannerBytes(file,size-1,1)).equals(Buffer.from('\n')))throw new Error('会话原文尾部未写完整；保留文件等待恢复');
  const rebuild=!!previous&&(previous.host_index_version!==PLANNER_HOST_INDEX_VERSION||previous.device!==device||previous.inode!==inode||Number(previous.indexed_bytes)>size||
    Number(previous.source_size)===size&&previous.source_mtime!==mtime||await tail(file,Number(previous.indexed_bytes))!==previous.tail_hash);
  if(previous&&!rebuild&&Number(previous.indexed_bytes)===size&&previous.source_mtime===mtime)return snapshot(previous);
  const prior=rebuild?undefined:previous,start=Number(prior?.indexed_bytes??0),generation=String(prior?.generation??randomUUID());
  let count=Number(prior?.entry_count??0),end=start,added=0,batchBytes=0,expected=previous;
  let header=prior?.header as {id:string;version:number;type:string}|undefined;
  let entries:Record<string,unknown>[]=[],host:{ordinal:number;entry:SessionEntry}[]=[];
  const flush=async()=>{
   signal?.throwIfAborted();if(!header)return;
   const tailHash=await tail(file,end);
   await db.transaction(async tx=>{
    if(!(await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',['fate:agent-history:'+key])).rows[0]?.locked)throw new Error('会话历史索引正在更新，稍后重试');
    const current=(await tx.query('SELECT * FROM agent_session_sources WHERE session_key=$1 FOR UPDATE',[key])).rows[0];
    if(current?.generation!==expected?.generation||Number(current?.indexed_bytes??0)!==Number(expected?.indexed_bytes??0))throw new Error('会话历史索引已变化，请重新读取');
    if(current&&current.generation!==generation)await tx.query('DELETE FROM agent_session_sources WHERE session_key=$1',[key]);
    await tx.query(`INSERT INTO agent_session_sources(session_key,task_id,exploration_id,intent_id,conversation_id,role,main_seg,scope,
     generation,session_id,source_path,device,inode,indexed_bytes,source_size,source_mtime,tail_hash,entry_count,header,host_index_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)
     ON CONFLICT(session_key) DO UPDATE SET indexed_bytes=EXCLUDED.indexed_bytes,source_size=EXCLUDED.source_size,
      source_mtime=EXCLUDED.source_mtime,tail_hash=EXCLUDED.tail_hash,entry_count=EXCLUDED.entry_count,updated_at=now()`,
     [key,scope.taskID||null,scope.expID||null,scope.intentID??null,scope.conversationID??null,scope.role,scope.mainSeg??null,JSON.stringify(scope),
      generation,header!.id,filePath,device,inode,end,size,mtime,tailHash,count,JSON.stringify(header),PLANNER_HOST_INDEX_VERSION]);
    if(entries.length){
     await tx.query(`INSERT INTO agent_session_entries(session_key,ordinal,entry_id,parent_id,entry_type,byte_offset,byte_length,raw_hash,runtime_meta)
      SELECT $1,x.* FROM jsonb_to_recordset($2::jsonb) x(ordinal bigint,entry_id text,parent_id text,entry_type text,byte_offset bigint,byte_length bigint,raw_hash text,runtime_meta jsonb)`,[key,JSON.stringify(entries)]);
     await indexPlannerHostEntries(tx,key,host,'agent');
    }
   });
   expected={generation,indexed_bytes:end};entries=[];host=[];batchBytes=0;
  };
  for await(const line of plannerHistoryLines(file,start,size)){
   signal?.throwIfAborted();end=line.end;
   if(!line.raw.toString('utf8').trim())continue;
   let e:any;try{e=JSON.parse(line.raw.toString('utf8'));}catch{throw new Error('会话条目损坏，原文已保留；不能从空会话继续');}
   if(!header){if(e.type!=='session'||e.version!==3||typeof e.id!=='string')throw new Error('原始会话头部无效；请先由 PI 完成原生格式迁移');header=e;continue;}
   if(typeof e.id!=='string'||typeof e.type!=='string'||e.type==='session')throw new Error('会话条目无效，已保留原文');
   const ordinal=count++;entries.push({ordinal,entry_id:e.id,parent_id:e.parentId??null,entry_type:e.type,byte_offset:line.offset,byte_length:line.raw.length,raw_hash:sha(line.raw),
    runtime_meta:sessionRuntimeMeta(e)});
   host.push({ordinal,entry:e});batchBytes+=line.raw.length;added++;
   if(entries.length>=64||batchBytes>=512*1024)await flush();
  }
  const current=await stat(filePath,{bigint:true});
  if(String(current.dev)!==device||String(current.ino)!==inode||current.size<info.size)throw new Error('原始会话被替换或截断；请重新读取');
  if(!header)throw new Error('会话文件缺少原始头部');
  await flush();
  await assertAgentSessionScope(db,scope);
  return {kind:'agent',key,scope,taskID:scope.taskID,expID:scope.expID,sessionID:header.id,generation,file:filePath,device,inode,bytes:end,count,mtime,scannedBytes:size-start,indexedEntries:added};
 }finally{await file.close();}
}
