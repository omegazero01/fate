import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename,readFile,readdir,unlink,open} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createAssistantMessageEventStream,type Provider,type AssistantMessage,type Model,type SimpleStreamOptions} from '@earendil-works/pi-ai';
import type {Database} from '../db/index.js';
import type {UsageScope} from '../db/usage-ledger.js';

const fields=['input','output','cacheRead','cacheWrite'] as const;
type Field=typeof fields[number];
type Counts=Partial<Record<Field,number>>;
const number=(v:unknown):number|undefined=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:undefined;
export class UsageObservation {
 readonly counts:Counts={};seen=false;finalUsage=false;inputTotal:number|undefined;
 observe(data:unknown,api:string){
  const d=data as any;
  const u=api==='anthropic-messages'?(d?.message?.usage??d?.usage):(d?.response?.usage??d?.usage??d?.choices?.[0]?.usage);
  if(!u||typeof u!=='object')return;this.seen=true;
  if(api==='anthropic-messages'?!!d?.delta?.stop_reason:api==='openai-completions'?Array.isArray(d?.choices)&&(d.choices.length===0||d.choices.some((c:any)=>!!c.finish_reason)):['response.completed','response.incomplete','response.failed'].includes(d?.type))this.finalUsage=true;
  const put=(key:Field,value:unknown)=>{const n=number(value);if(n!==undefined)this.counts[key]=n;};
  if(api==='anthropic-messages'){
   if(number(u.input_tokens)!==undefined){put('input',u.input_tokens);put('cacheRead',u.cache_read_input_tokens??0);put('cacheWrite',u.cache_creation_input_tokens??0);}
   else{put('cacheRead',u.cache_read_input_tokens);put('cacheWrite',u.cache_creation_input_tokens);}
   put('output',u.output_tokens);if(this.counts.input!==undefined&&this.counts.cacheRead!==undefined&&this.counts.cacheWrite!==undefined)this.inputTotal=this.counts.input+this.counts.cacheRead+this.counts.cacheWrite;
  }else{
   const prompt=number(api==='openai-completions'?u.prompt_tokens:u.input_tokens);
   const read=number(api==='openai-completions'?(u.prompt_tokens_details?.cached_tokens??u.prompt_cache_hit_tokens??u.cached_tokens):(u.input_tokens_details?.cached_tokens));
   const write=number((api==='openai-completions'?u.prompt_tokens_details:u.input_tokens_details)?.cache_write_tokens??0);
   if(prompt!==undefined)this.inputTotal=prompt;
   if(read!==undefined&&(prompt===undefined||read<=prompt))put('cacheRead',read);if(write!==undefined&&(prompt===undefined||write<=prompt))put('cacheWrite',write);
   if(prompt!==undefined&&read!==undefined&&write!==undefined&&read+write<=prompt){put('input',prompt-read-write);put('cacheRead',read);put('cacheWrite',write);}
   put('output',api==='openai-completions'?u.completion_tokens:u.output_tokens);
  }
 }
 result(native:unknown,notSent=false,interrupted=false){
  const n=native as any;const c={...this.counts};
  // Unsupported native adapters may provide real positive normalized usage. A zero SDK placeholder is never proof.
  if(!this.seen&&fields.every(k=>number(n?.[k])!==undefined)&&fields.some(k=>n[k]>0))for(const k of fields)c[k]=n[k];
  const known=fields.filter(k=>c[k]!==undefined);
  const inputTotal=this.inputTotal??(known.length===4?c.input!+c.cacheRead!+c.cacheWrite!:undefined);
  const consistent=inputTotal===undefined||(c.cacheRead??0)+(c.cacheWrite??0)<=inputTotal;
  const quality=known.length===4&&consistent?(interrupted&&!this.finalUsage?'partial':'complete'):notSent&&!known.length?'not_sent':known.length?'partial':'unknown';
  return {input:c.input??0,output:c.output??0,cacheRead:c.cacheRead??0,cacheWrite:c.cacheWrite??0,
   inputTotal:inputTotal??0,totalTokens:(inputTotal??((c.input??0)+(c.cacheRead??0)+(c.cacheWrite??0)))+(c.output??0),_input_total_known:inputTotal!==undefined||notSent,_cache_read_known:(c.cacheRead!==undefined||notSent)&&consistent,_quality:quality,_known_fields:quality==='not_sent'?[...fields]:known,_source:'provider',_receipt_seq:1};
 }
}
type Receipt={requestID:string;auditID:number;status:string;usage:ReturnType<UsageObservation['result']>;finishedAt:string|null};
const receiptFile=(r:Receipt)=>`${r.requestID}.${r.usage._receipt_seq}.json`;
const directories=new WeakMap<Database,string>(),memory=new WeakMap<Database,Map<string,Receipt>>();
export function configureUsageOutbox(db:Database,dataDir:string){directories.set(db,path.resolve(dataDir,'usage-outbox'));}
function directory(db:Database){
 const identity=String(db.pool?.options?.connectionString??'local-fixture');
 return directories.get(db)??path.join(tmpdir(),'fate-usage-outbox',createHash('sha256').update(identity).digest('hex').slice(0,20));
}
async function persistFile(db:Database,r:Receipt){
 const dir=directory(db);await mkdir(dir,{recursive:true,mode:0o700});
 // Each revision has its own immutable file. A replaying consumer may only
 // remove that revision, never a newer snapshot from a still-running request.
 const dest=path.join(dir,receiptFile(r)),tmp=dest+'.'+randomUUID()+'.tmp';
 await writeFile(tmp,JSON.stringify(r),{mode:0o600});const handle=await open(tmp,'r');try{await handle.sync();}finally{await handle.close();}
 await rename(tmp,dest);
}
async function commitReceipt(db:Database,r:Receipt){
 await db.transaction(async tx=>{
  const updated=await tx.query(`UPDATE llm_usage_ledger SET status=CASE WHEN status='aborted' THEN status ELSE $2 END,usage=$3::jsonb,quality=$4,source='provider',receipt_seq=$6,finished_at=COALESCE(finished_at,$5::timestamptz)
    WHERE request_id=$1 AND receipt_seq<=$6`,[r.requestID,r.status,JSON.stringify(r.usage),r.usage._quality,r.finishedAt,r.usage._receipt_seq]);
  if(!updated.rowCount&&!(await tx.query('SELECT 1 FROM llm_usage_ledger WHERE request_id=$1',[r.requestID])).rowCount)throw new Error('Metering request identity missing');
  // Do not recreate a detail log which the user deliberately deleted during the request.
  await tx.query(`UPDATE llm_request_attempts SET status=CASE WHEN status='aborted' THEN status ELSE $2 END,
    usage=$3::jsonb,finished_at=COALESCE(finished_at,$4::timestamptz) WHERE id=$1 AND request_id=$5 AND COALESCE((usage->>'_receipt_seq')::bigint,0)<=$6`,[r.auditID,r.status,JSON.stringify(r.usage),r.finishedAt,r.requestID,r.usage._receipt_seq]);
 });
}
async function saveReceipt(db:Database,r:Receipt){
 const queued=memory.get(db)??new Map<string,Receipt>();memory.set(db,queued);const file=receiptFile(r);queued.set(file,r);
 try{await persistFile(db,r);}catch{console.warn('[usage] durable receipt unavailable',r.requestID);}
 try{await commitReceipt(db,r);queued.delete(file);await unlink(path.join(directory(db),file)).catch(()=>{});}
 catch{console.warn('[usage] receipt queued for persistence',r.requestID);}
}
export async function replayUsageOutbox(db:Database){
 const queued=memory.get(db)??new Map<string,Receipt>();memory.set(db,queued);
 for(const file of await readdir(directory(db)).catch(()=>[])){
  if(!/^[a-f0-9-]{36}(?:\.\d+)?\.json$/.test(file))continue;
  try{const r=JSON.parse(await readFile(path.join(directory(db),file),'utf8')) as Receipt;
   if(!r.usage||!Number.isSafeInteger(r.usage._receipt_seq)||r.usage._receipt_seq<1
    ||file!==r.requestID+'.json'&&file!==receiptFile(r))continue;queued.set(file,r);
  }catch{console.warn('[usage] invalid receipt retained for inspection');}
 }
 for(const [file,r] of [...queued]){
  try{
   await persistFile(db,r);await commitReceipt(db,r);queued.delete(file);
   await unlink(path.join(directory(db),receiptFile(r))).catch(()=>{});
   // Import receipts created by the previous release without replaying models.
   if(file!==receiptFile(r))await unlink(path.join(directory(db),file)).catch(()=>{});
  }catch{/* Next bounded background pass retries only metering. */}
 }
 return queued.size;
}
export type MeterContext=UsageScope&{role:string;purpose:string};
export function meterProvider(db:Database,provider:Provider,profile:{id:number;name:string;model:string;apiKey?:string},context:()=>MeterContext):Provider {
 return new Proxy(provider,{get(target,key){
  if(key!=='stream'&&key!=='streamSimple'){
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }
  return (model:Model<any>,messages:any,options:SimpleStreamOptions={})=>{
   const stream=createAssistantMessageEventStream(),scope={...context()},requestID=randomUUID(),observation=new UsageObservation();
   let auditID=0,attempted=false,saved=false,sequence=0;
   const snapshot=()=>{const value=observation.result(undefined);return {...value,_quality:value._quality==='complete'?'partial':value._quality,_receipt_seq:++sequence};};
   const record=async(message:AssistantMessage)=>{
    if(saved)return;saved=true;
    const status=message.stopReason==='error'?'failed':message.stopReason==='aborted'?'aborted':'completed';
    await saveReceipt(db,{requestID,auditID,status,finishedAt:new Date().toISOString(),usage:{...observation.result(message.usage,!attempted,['error','aborted'].includes(message.stopReason)),_receipt_seq:++sequence}});
    if(message.errorMessage)await db.query('UPDATE llm_request_attempts SET error=$2 WHERE request_id=$1',[requestID,String(message.errorMessage).replaceAll(profile.apiKey||'\0','[redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@').replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,1000)]).catch(()=>undefined);
   };
   void(async()=>{
    try{
     const row=await db.transaction(async tx=>{
      if(scope.runtimeID&&!(await tx.query('SELECT id FROM runtime_role_configs WHERE id=$1 AND finished_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',[scope.runtimeID])).rowCount)throw new Error('模型执行器已过期');
      const audit=await tx.query(`INSERT INTO llm_request_attempts(request_id,task_id,conversation_id,role,profile_id,model,status,purpose,runtime_id)
       VALUES($1,$2,$3,$4,$5,$6,'running',$7,$8) RETURNING id`,[requestID,scope.taskID||null,scope.conversationID??null,scope.role,profile.id>0?profile.id:null,model.id,scope.purpose,scope.runtimeID??null]);
      await tx.query(`UPDATE llm_usage_ledger SET profile_name=$2,intent_id=$3,main_seg=$4,turn_id=$5,scope_key=COALESCE(runtime_id,$5,request_id) WHERE request_id=$1`,
       [requestID,profile.name,scope.intentID??null,scope.mainSegment??null,scope.turnID??null]);return audit;
     });
     auditID=Number(row.rows[0]!.id);
     const inner=(target[key] as any).call(target,model,messages,{...options,
      onPayload:async(payload:unknown,m:Model<any>)=>{const result=await options.onPayload?.(payload,m);attempted=true;return result;},
      onResponse:async(r:any,m:Model<any>)=>{attempted=true;await options.onResponse?.(r,m);},
      onProviderStreamEvent:async(event:unknown,m:Model<any>)=>{const before=JSON.stringify(observation.counts);observation.observe(event,String(model.api));if(observation.seen&&JSON.stringify(observation.counts)!==before)await saveReceipt(db,{requestID,auditID,status:'running',finishedAt:null,usage:snapshot()});await options.onProviderStreamEvent?.(event,m);}});
     for await(const event of inner){if(event.type==='done'||event.type==='error')await record(event.type==='done'?event.message:event.error);stream.push(event);}
     const message=await inner.result();await record(message);stream.end(message);
    }catch(error){
     const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],timestamp:Date.now(),stopReason:options.signal?.aborted?'aborted':'error',errorMessage:error instanceof Error?error.message:'模型调用失败',
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}} as AssistantMessage;
     if(auditID)await record(message);stream.push({type:'error',reason:message.stopReason as 'error'|'aborted',error:message});
    }
   })();return stream;
  };
 }});
}
