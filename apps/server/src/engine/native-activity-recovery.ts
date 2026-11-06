import {createHash} from 'node:crypto';
import {open,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import type {Database} from '../db/index.js';
import type {Activity} from '../db/exploration.js';
import {projectActivity} from '../db/activity-projection.js';
import {plannerHistoryLines,readPlannerBytes} from '../db/planner-history.js';
import {acquireNativeWriter} from '../agent/native-run-session.js';
import {recoverPlannerActiveSession} from '../agent/planner-active-session.js';
import {NATIVE_ACTIVITY_MARKER,nativeMessageActivities,nativeToolActivities,type NativeActivityIdentity} from '../pi/native-activity.js';
import type {AgentRunner,RunnerActivity} from '../pi/runner.js';
import {runnerActivityMetadata} from './live-stream.js';
import {streamChanges} from './stream-changes.js';

const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
async function tail(file:FileHandle,end:number){return hash(await readPlannerBytes(file,Math.max(0,end-65536),Math.min(end,65536)));}
type Scan={bound:boolean;sequence:number;assistant?:{offset:number;length:number;hash:string}};

/** Register before any model/tool execution. The marker is host metadata in PI,
 * not a model-authored checkpoint or completion protocol. */
export async function registerNativeActivityRun(db:Database,id:string,runner:AgentRunner,identity:NativeActivityIdentity,flush?:()=>Promise<void>){
 const canonical=runner.sessionFile;if(!canonical)throw new Error('Native activity recovery requires a persistent PI session');
 const runtime=(await db.query('SELECT task_id,conversation_id FROM runtime_role_configs WHERE id=$1',[id])).rows[0];
 if(!runtime||!identity.turn_id||!identity.worker)throw new Error('Missing native activity execution identity');
 if(identity.source.scope==='task'){
  if(Number(runtime.task_id)!==identity.source.taskID||runtime.conversation_id||!(await db.query('SELECT 1 FROM tasks WHERE id=$1 AND exploration_id=$2 AND deleted_at IS NULL',[identity.source.taskID,identity.source.scopeID])).rowCount)throw new Error('Native activity task ownership mismatch');
 }else if(Number(runtime.conversation_id)!==identity.source.scopeID||identity.source.turnID!==identity.turn_id||!(await db.query('SELECT 1 FROM conversation_runs WHERE id=$1 AND conversation_id=$2 AND token=$3 AND COALESCE(NULLIF(turn_id,\'\'),\'conversation:\'||id::text)=$4',[identity.source.runID,identity.source.scopeID,identity.source.token,identity.turn_id])).rowCount)throw new Error('Native activity conversation ownership mismatch');
 await flush?.();let offset=0,tailHash=hash('');
 try{const f=await open(canonical,'r');try{offset=(await f.stat()).size;tailHash=await tail(f,offset);}finally{await f.close();}}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const marker=runner.appendSessionEntry(NATIVE_ACTIVITY_MARKER,{runtime_id:id,session_id:runner.sessionId});
 await flush?.();
 await db.query(`INSERT INTO native_activity_runs(runtime_id,namespace,canonical_file,session_id,marker_id,identity,byte_offset,tail_hash)
  SELECT $1,identity,$2,$3,$4,$5::jsonb,$6,$7 FROM activity_outbox_identity WHERE singleton`,[id,path.resolve(canonical),runner.sessionId,marker,JSON.stringify(identity),offset,tailHash]);
}

function recoveredActivity(a:RunnerActivity,identity:NativeActivityIdentity,created:string):Activity|undefined{
 if(a.kind==='usage'&&identity.source.scope==='task')return;
 if(!['assistant_message_end','usage','tool_start','tool_end'].includes(a.kind))return;
 const detail=a.kind==='tool_start'?JSON.stringify(a.args):'text' in a?a.text??'':'';
 const kind=a.kind==='tool_start'?'tool_use':a.kind==='tool_end'?'tool_result':a.kind==='usage'?'usage':a.kind==='assistant_message_end'&&a.isThinking?'thinking':identity.source.scope==='conversation'?'assistant':detail?'text':'status';
 return {worker:identity.worker,node_id:identity.node_id,main_seg:identity.main_seg,kind,detail,summary:detail?'恢复的原始记录（非最终结论）：'+detail.slice(0,960):'',created_at:created,
  tool:'toolName' in a?a.toolName:undefined,tool_use_id:'toolCallId' in a?a.toolCallId:undefined,is_error:'isError' in a?a.isError:false,
  input_tokens:a.kind==='usage'?a.input:0,output_tokens:a.kind==='usage'?a.output:0,cache_read_tokens:a.kind==='usage'?a.cacheRead:0,cache_write_tokens:a.kind==='usage'?a.cacheWrite:0,
  metadata:{turn_id:identity.turn_id,...runnerActivityMetadata(a),native_recovered:true,raw_source_only:true,final_answer:false}};
}

/** One bounded native-file pass. Only activity projection is permitted; no
 * model, tool execution, graph writes, task state changes or completion events. */
export class NativeActivityRecovery {
 private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private stopped=false;
 private stats={passes:0,entries:0,projected:0,failures:0};
 constructor(private db:Database,private dataDir:string){}
 metrics(){return {...this.stats,busy:!!this.work};}
 start(){if(this.timer)return;this.timer=setInterval(()=>void this.tick().catch(()=>{}),1000);this.timer.unref();}
 tick(){if(this.stopped)return Promise.resolve();if(this.work)return this.work;const work=this.page().finally(()=>{if(this.work===work)this.work=undefined;});this.work=work;return work;}
 private async page(){
  const row=(await this.db.query(`SELECT n.runtime_id FROM native_activity_runs n JOIN runtime_role_configs r ON r.id=n.runtime_id
   WHERE NOT n.completed AND n.next_attempt_at<=clock_timestamp() AND (r.finished_at IS NOT NULL OR r.expires_at<=clock_timestamp())
   AND n.namespace=(SELECT identity FROM activity_outbox_identity WHERE singleton) ORDER BY n.next_attempt_at,n.runtime_id LIMIT 1`)).rows[0];
  if(!row)return;
  try{await this.recover(String(row.runtime_id));}
  catch(error){this.stats.failures++;await this.db.query("UPDATE native_activity_runs SET next_attempt_at=now()+interval '5 seconds',last_error=$2 WHERE runtime_id=$1",[row.runtime_id,String(error).slice(0,1000)]);}
 }
 async recover(id:string){
  const row=(await this.db.query(`SELECT n.* FROM native_activity_runs n JOIN runtime_role_configs r ON r.id=n.runtime_id
   WHERE n.runtime_id=$1 AND NOT n.completed AND (r.finished_at IS NOT NULL OR r.expires_at<=clock_timestamp())
   AND n.namespace=(SELECT identity FROM activity_outbox_identity WHERE singleton)`,[id])).rows[0];
  if(!row)return;
  const file=path.resolve(String(row.canonical_file)),relative=path.relative(path.resolve(this.dataDir),file);
  if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw new Error('Native recovery source is outside this instance data directory');
  const release=await acquireNativeWriter(this.db,file,undefined,{recovery:true});
  try{
   await recoverPlannerActiveSession(file);const handle=await open(file,'r');
   try{
    const size=(await handle.stat()).size;let offset=Number(row.byte_offset),state=row.scan_state as Scan,seen=0,bytes=0,done=false;
    if(!Number.isSafeInteger(offset)||offset<0||offset>size||await tail(handle,offset)!==row.tail_hash)throw new Error('Native recovery cursor/prefix changed; original retained');
    let header:any;for await(const line of plannerHistoryLines(handle,0,size)){header=JSON.parse(line.raw.toString());break;}
    if(header?.type!=='session'||header.id!==row.session_id)throw new Error('Native recovery session identity changed');
    const identity=row.identity as NativeActivityIdentity;
    for await(const line of plannerHistoryLines(handle,offset,size)){
     if(!(await readPlannerBytes(handle,line.end-1,1)).equals(Buffer.from('\n')))throw new Error('Incomplete native tail retained for recovery');
     const text=line.raw.toString('utf8'),entry=text.trim()?JSON.parse(text):undefined;
     if(entry?.type==='custom'&&entry.customType===NATIVE_ACTIVITY_MARKER){
      if(state.bound){done=true;break;}
      if(entry.id!==row.marker_id||entry.data?.runtime_id!==id||entry.data?.session_id!==row.session_id)throw new Error('Native recovery marker mismatch');
      state={bound:true,sequence:0};
     }
     let activities:RunnerActivity[]=[];
     if(state.bound&&entry?.type==='message'){
      if(entry.message.role==='assistant'){
       state={...state,sequence:state.sequence+1,assistant:{offset:line.offset,length:line.raw.length,hash:hash(line.raw)}};
       activities=nativeMessageActivities(entry.message,id,state.sequence);
      }else if(entry.message.role==='toolResult'){
       if(!state.assistant)throw new Error('Native result lacks an original assistant');
       const raw=await readPlannerBytes(handle,state.assistant.offset,state.assistant.length);
       if(hash(raw)!==state.assistant.hash)throw new Error('Native call source changed');
       activities=nativeToolActivities(entry.message,JSON.parse(raw.toString()).message,id,state.sequence);
      }
     }
     const nextHash=await tail(handle,line.end),created=entry?.timestamp??new Date().toISOString();
     await this.db.transaction(async tx=>{
      const locked=(await tx.query('SELECT byte_offset,completed FROM native_activity_runs WHERE runtime_id=$1 FOR UPDATE',[id])).rows[0];
      if(!locked||locked.completed||Number(locked.byte_offset)!==offset)throw new Error('Native recovery cursor advanced concurrently');
      for(const a of activities){const projected=recoveredActivity(a,identity,created);if(projected){await projectActivity(tx,identity.source,projected,true);}}
      await tx.query('UPDATE native_activity_runs SET byte_offset=$2,tail_hash=$3,scan_state=$4::jsonb,last_error=NULL,updated_at=now(),next_attempt_at=now() WHERE runtime_id=$1',[id,line.end,nextHash,JSON.stringify(state)]);
     });
     this.stats.projected+=activities.filter(a=>recoveredActivity(a,identity,created)).length;
     offset=line.end;seen++;bytes+=line.raw.length;this.stats.entries++;
     if(seen>=64||bytes>=512*1024)break;
    }
    if(done||offset===size){
     if(!state.bound)throw new Error('Native activity binding marker was not persisted');
     await this.db.query('UPDATE native_activity_runs SET completed=true,last_error=NULL,updated_at=now() WHERE runtime_id=$1 AND byte_offset=$2',[id,offset]);
    }
    this.stats.passes++;streamChanges.emit('change',identity.source.scope,identity.source.scopeID);
   }finally{await handle.close();}
  }finally{await release();}
 }
 async close(){this.stopped=true;clearInterval(this.timer);await this.work?.catch(()=>{});}
}
