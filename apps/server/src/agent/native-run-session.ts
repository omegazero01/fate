import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {open,readFile,mkdir,rename,unlink} from 'node:fs/promises';
import {hostname} from 'node:os';import path from 'node:path';
import type {Database} from '../db/index.js';
import type {SessionManager} from '@earendil-works/pi-coding-agent';
import {assertAgentSessionScope,syncAgentHistory,type AgentHistorySnapshot,type AgentSessionScope} from '../db/agent-history.js';
import {assertPlannerHostState} from '../db/planner-host-state.js';
import {prepareNativeActiveSession,recoverPlannerActiveSession,type PlannerActiveSession} from './planner-active-session.js';

type Owner={version:1;host:string;pid:number;token:string;purpose?:'execution'|'recovery'};
class NativeWriterBusy extends Error {constructor(readonly purpose:'claim'|'execution'|'recovery'){super(purpose==='claim'?'原生会话正在领取，稍后恢复':'原生会话原执行器尚未退出，不能重复运行');}}
const live=new Set<string>();
async function readOwner(file:string):Promise<Owner|undefined>{
 let text:string;try{text=await readFile(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 const o=JSON.parse(text) as Owner;
 if(o.version!==1||!Number.isSafeInteger(o.pid)||o.pid<1||typeof o.host!=='string'||typeof o.token!=='string')throw new Error('原生会话执行器记录损坏，已保留原文');
 return o;
}
function running(o:Owner){
 // A different machine's PID is not evidence that its writer has exited.
 if(o.host!==hostname())throw new Error('原生会话属于另一宿主，需先确认原执行器已退出');
 if(o.pid===process.pid)return live.has(o.token);
 try{process.kill(o.pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}
}
/** Short DB serialization protects stale-file replacement from two recoverers.
 * The connection is released before any session index/load/model operation.
 * Physical writer ownership outlives a lost DB lease until actual disposal/exit. */
export async function acquireNativeWriter(db:Database,file:string,signal?:AbortSignal,options:{recovery?:boolean}={}){
 const ownerFile=file+'.owner.json',owner:Owner={version:1,host:hostname(),pid:process.pid,token:randomUUID(),purpose:options.recovery?'recovery':'execution'};
 await mkdir(path.dirname(file),{recursive:true});
 for(;;){try{await db.transaction(async tx=>{
  signal?.throwIfAborted();
  const locked=(await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',['fate:native-writer:'+createHash('sha256').update(file).digest('hex')])).rows[0]?.locked;
  if(!locked)throw new NativeWriterBusy('claim');
  const prior=await readOwner(ownerFile);if(prior&&running(prior))throw new NativeWriterBusy(prior.purpose??'execution');
  const temp=ownerFile+'.'+owner.token+'.tmp',handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(owner)+'\n');await handle.sync();}finally{await handle.close();}
  await rename(temp,ownerFile);live.add(owner.token);
 }).catch(async error=>{
  // Even a COMMIT failure cannot leave a live in-process orphan blocking all
  // retries. No native writer exists until this function returns successfully.
  try{if((await readOwner(ownerFile))?.token===owner.token)await unlink(ownerFile);}finally{live.delete(owner.token);}
  throw error;
 });break;}catch(error){
  if(options.recovery||!(error instanceof NativeWriterBusy)||error.purpose==='execution')throw error;
  // A short read-only recovery owns this file. Wait outside the query pool,
  // cancellably, rather than turning a legitimate resume into a failed intent.
  await delay(25,undefined,{signal});
 }}
 let released=false;
 return async()=>{
  if(released)return;
  try{if((await readOwner(ownerFile))?.token===owner.token)await unlink(ownerFile);released=true;}
  finally{live.delete(owner.token);}
 };
}
export interface NativeRunSession extends PlannerActiveSession {
 canonical:string;
 compact(manager:SessionManager):Promise<boolean>;
 snapshot():Promise<AgentHistorySnapshot|undefined>;
 deliveredContextKeys(keys:string[]):Promise<Set<string>>;
}
/** Uses native SessionManager.open on a successful-compaction projection only.
 * All appended original entries are archived byte-for-byte before host recall.
 * No new model loop, compaction request or resume message is introduced. */
export async function prepareAgentRunSession(db:Database,scope:AgentSessionScope,filename:string,signal?:AbortSignal):Promise<NativeRunSession>{
 const canonical=path.resolve(filename);signal?.throwIfAborted();await assertAgentSessionScope(db,scope);
 const release=await acquireNativeWriter(db,canonical,signal);
 let active:PlannerActiveSession;
 try{
  await recoverPlannerActiveSession(canonical);
  const indexed=await syncAgentHistory(db,scope,canonical,signal);
  active=await prepareNativeActiveSession(db,indexed,canonical);
 }catch(error){await release();throw error;}
 let closing:Promise<void>|undefined;
 const snapshot=async()=>{await active.flush();return syncAgentHistory(db,scope,canonical,signal);};
 return {...active,canonical,snapshot,
  get file(){return active.file;},get projected(){return active.projected;},
  get sourceEntries(){return active.sourceEntries;},get activeEntries(){return active.activeEntries;},
  compact:manager=>active.rebase(manager,()=>syncAgentHistory(db,scope,canonical,signal)),
  deliveredContextKeys:async keys=>{
   if(!keys.length)return new Set();
   if(keys.length>100||keys.some(k=>k.length>512))throw new Error('上下文回执查询窗口过大');
   const s=await snapshot();if(!s)return new Set();await assertPlannerHostState(db,s);
   const result=await db.transaction(async tx=>{
    await tx.query('SET LOCAL jit=off');
    return tx.query(`WITH RECURSIVE branch AS (
     SELECT ordinal,entry_id,parent_id FROM agent_session_entries WHERE session_key=$1 AND ordinal=$2-1
     UNION ALL SELECT p.ordinal,p.entry_id,p.parent_id FROM branch b JOIN agent_session_entries p
      ON p.session_key=$1 AND p.entry_id=b.parent_id AND p.ordinal<b.ordinal
    ) SELECT DISTINCT h.subject_ref FROM agent_session_host_state h WHERE h.session_key=$1
     AND h.namespace='context' AND h.subject_ref=ANY($3::text[]) AND EXISTS(SELECT 1 FROM branch b WHERE b.entry_id=h.key)`,[s.key,s.count,keys]);
   });
   return new Set(result.rows.map(r=>String(r.subject_ref)));
  },
  close:()=>closing??(closing=(async()=>{try{await active.close();}finally{await release();}})()),
 };
}
