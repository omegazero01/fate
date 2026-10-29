import {randomUUID} from 'node:crypto';
import type {Database} from '../db/index.js';
import {leaseWatchdog} from './lease-watchdog.js';
/** Exclusive ownership of a native pi JSONL session, including cross-process stop. */
export async function acquireSessionLease(db:Database,key:string,controller:AbortController){
 const token=randomUUID();
 const r=await db.query(`INSERT INTO runtime_session_leases(key,token,expires_at) VALUES($1,$2,now()+interval '15 seconds')
 ON CONFLICT(key) DO UPDATE SET token=$2,expires_at=now()+interval '15 seconds',stop_requested=false WHERE runtime_session_leases.expires_at<now() RETURNING token`,[key,token]);
 if(!r.rowCount)throw Object.assign(new Error('该会话正在回复，请等待或停止当前回复'),{statusCode:409});
 const assert=async(tx=db)=>{
  controller.signal.throwIfAborted();
  if(!(await tx.query(`SELECT key FROM runtime_session_leases WHERE key=$1 AND token=$2 AND expires_at>clock_timestamp() AND NOT stop_requested FOR SHARE`,[key,token])).rowCount)throw new Error('会话已停止或租约失效');
 };
 const stop=leaseWatchdog(async()=>{
  const r=await db.control().query(`UPDATE runtime_session_leases SET expires_at=now()+interval '15 seconds' WHERE key=$1 AND token=$2 AND expires_at>now() AND NOT stop_requested RETURNING key`,[key,token]);
  if(!r.rowCount)throw new Error('lease lost');
 },()=>controller.abort('会话已停止或租约失效'));
 return {token,assert,async release(){stop();await db.query('DELETE FROM runtime_session_leases WHERE key=$1 AND token=$2',[key,token]);}};
}
