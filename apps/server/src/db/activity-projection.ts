import type {Database} from './index.js';
import {jsonbClean,utf8Clean,type Activity} from './exploration.js';
import {lockStream} from './stream-storage.js';
import type {NativeActivityIdentity,NativeActivityReference} from '../pi/native-activity.js';

export type ActivitySource = {scope:'task';scopeID:number;taskID:number} |
  {scope:'conversation';scopeID:number;runID:number;token:string;turnID:string};

/** Same transaction/connection as the receipt cursor and final snapshot handoff. */
export async function lockActivityScope(db:Database,scope:'task'|'conversation',id:number){
  if(scope==='task')await db.query('SELECT pg_advisory_xact_lock($1)',[-id]);
  else await db.query("SELECT pg_advisory_xact_lock(hashtextextended('activity:conversation:'||$1::text,0))",[id]);
}

/** Historical projection is presentation only. It never restores execution
 * ownership, runs tools, updates a domain node or sends Worker completion. */
export async function projectActivity(db:Database,source:ActivitySource,activity:Activity,replay:boolean):Promise<number|null>{
  if(!db.transactionClient)throw new Error('Activity projection requires its receipt transaction');
  if(source.scope==='task'){
    // Protect deletion/identity, without blocking pause/status updates behind
    // a large presentation write. Domain tool ownership locks are unchanged.
    const task=(await db.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR KEY SHARE',[source.taskID])).rows[0];
    if(!task)return null;
    if(Number(task.exploration_id)!==source.scopeID)throw new Error('Activity exploration is outside its task');
    if(activity.node_id&&!(await db.query('SELECT id FROM exploration_nodes WHERE exploration_id=$1 AND id=$2',[source.scopeID,activity.node_id])).rowCount)throw new Error('Activity node is outside its task');
  }else{
    if(!(await db.query('SELECT id FROM conversations WHERE id=$1 FOR KEY SHARE',[source.scopeID])).rowCount)return null;
    const owned=await db.query(`SELECT r.id FROM conversation_runs r WHERE r.id=$1 AND r.conversation_id=$2 AND r.token=$3
      AND COALESCE(NULLIF(r.turn_id,''),'conversation:'||r.id::text)=$4 FOR KEY SHARE`,[source.runID,source.scopeID,source.token,source.turnID]);
    if(!owned.rowCount)throw new Error('Activity does not belong to its original conversation run');
    if(activity.metadata?.turn_id!==source.turnID)throw new Error('Activity turn is outside its conversation run');
    // Live calls keep the original lease check. Offline delivery may only be
    // replayed by the outbox after the producer closes/exits; its original run
    // token still has to match. This does not authorize further execution.
    if(!replay&&!(await db.query('SELECT key FROM runtime_session_leases WHERE key=$1 AND token=$2 AND expires_at>clock_timestamp()',[`conversation:${source.scopeID}`,source.token])).rowCount)
      throw new Error('会话执行租约已失效，活动未写入');
  }
  const metadata:Record<string,unknown>={...activity.metadata,...(replay?{projection_replayed:true}:{})};
  const a={...activity,metadata};
  const native=metadata.native_event as NativeActivityReference|undefined;
  if(native){
    if(typeof native.runtime_id!=='string'||!(/^[a-f0-9]{64}$/.test(native.key))||!(/^[a-f0-9]{64}$/.test(native.source_hash)))throw new Error('Invalid native activity reference');
    const row=(await db.query('SELECT identity FROM native_activity_runs WHERE runtime_id=$1 FOR KEY SHARE',[native.runtime_id])).rows[0];
    const identity=row?.identity as NativeActivityIdentity|undefined;
    const registered=identity?.source;
    const sameSource=registered?.scope===source.scope&&registered.scopeID===source.scopeID&&
      (registered.scope==='task'&&source.scope==='task'?registered.taskID===source.taskID:
       registered.scope==='conversation'&&source.scope==='conversation'&&registered.runID===source.runID&&registered.token===source.token&&registered.turnID===source.turnID);
    if(!identity||!sameSource)throw new Error('Native activity source is outside its registered scope');
    if(identity.worker!==a.worker||identity.turn_id!==a.metadata.turn_id||(identity.node_id??null)!==(a.node_id??null)||(identity.main_seg??null)!==(a.main_seg??null))throw new Error('Native activity identity does not match its registered turn');
    const inserted=await db.query('INSERT INTO native_activity_receipts(runtime_id,event_key,source_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING runtime_id',[native.runtime_id,native.key,native.source_hash]);
    if(!inserted.rowCount){
      const prior=(await db.query('SELECT source_hash,activity_id FROM native_activity_receipts WHERE runtime_id=$1 AND event_key=$2',[native.runtime_id,native.key])).rows[0];
      if(!prior||prior.source_hash!==native.source_hash||prior.activity_id===null)throw new Error('Native activity source changed; both records retained');
      if(!a.metadata.native_recovered){
        // The original journal may arrive after native backfill. Restore its
        // checked presentation in-place, never duplicate it or discard a host
        // acceptance receipt. The native original remains in its JSONL source.
        const table=source.scope==='task'?'activity':'conversation_activities';
        await db.query(`UPDATE ${table} SET kind=$2,summary=$3,detail=$4,is_error=$5,tool=$6,tool_use_id=$7,
          input_tokens=$8,output_tokens=$9,cache_read_tokens=$10,cache_write_tokens=$11,metadata=$12::jsonb,
          created_at=COALESCE($13::timestamptz,created_at)
          WHERE id=$1 AND metadata->>'native_recovered'='true'`,[prior.activity_id,a.kind,utf8Clean(a.summary??'').slice(0,20000),utf8Clean(a.detail??''),a.is_error??false,a.tool,a.tool_use_id,
          a.input_tokens??0,a.output_tokens??0,a.cache_read_tokens??0,a.cache_write_tokens??0,jsonbClean(JSON.stringify({...a.metadata,native_recovery_reconciled:true})),a.created_at??null]);
      }
      await finishSnapshot(db,source,a);return Number(prior.activity_id);
    }
  }
  let id:number;
  if(source.scope==='task')id=await db.exploration(source.scopeID).appendActivity(a);
  else{
    await lockActivityScope(db,source.scope,source.scopeID);
    const r=await db.query(`INSERT INTO conversation_activities(conversation_id,worker,kind,tool,tool_use_id,summary,detail,is_error,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,metadata,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,COALESCE($14::timestamptz,now())) RETURNING id`,
      [source.scopeID,a.worker??'assistant',a.kind,a.tool,a.tool_use_id,utf8Clean(a.summary??'').slice(0,20000),utf8Clean(a.detail??''),a.is_error??false,
        a.input_tokens??0,a.output_tokens??0,a.cache_read_tokens??0,a.cache_write_tokens??0,jsonbClean(JSON.stringify(a.metadata)),a.created_at??null]);
    id=Number(r.rows[0]!.id);
  }
  if(native)await db.query('UPDATE native_activity_receipts SET activity_id=$3 WHERE runtime_id=$1 AND event_key=$2',[native.runtime_id,native.key,id]);
  await finishSnapshot(db,source,a);
  return id;
}
async function finishSnapshot(db:Database,source:ActivitySource,a:Activity){
  if(typeof a.metadata?.stream_id==='string'&&['text','thinking'].includes(String(a.metadata.channel))&&!a.metadata.interrupted){
    await lockStream(db,{scope:source.scope,id:source.scopeID,stream:a.metadata.stream_id,channel:String(a.metadata.channel)});
    await db.query('DELETE FROM agent_stream_snapshots WHERE scope=$1 AND scope_id=$2 AND stream_id=$3 AND channel=$4',[source.scope,source.scopeID,a.metadata.stream_id,a.metadata.channel]);
  }
}
