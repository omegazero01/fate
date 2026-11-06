import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Database } from '../db/index.js';
import { activityDTO, type StreamScope } from '../engine/live-stream.js';
import {readTurnSummaries} from '../engine/turn-summary.js';
import {streamChanges} from '../engine/stream-changes.js';
import {createHash} from 'node:crypto';
import {readActivityPage,ACTIVITY_PREVIEW_CHARS} from '../db/activity-content.js';
import {readTurnRevisions} from '../db/turn-read-versions.js';

type Row=Record<string,any>;
type SummaryBatch={items:Awaited<ReturnType<typeof readTurnSummaries>>;requested_ids:string[];versions:Map<string,string>};
const fingerprint=(text:string)=>createHash('sha256').update(text).digest('hex');
const MAX_BUFFER=1024*1024,MAX_CACHE=32*1024*1024,MAX_CACHE_ENTRIES=4096;
const hubs=new WeakMap<Database,Map<string,ActivityHub>>();
const liveHubs=new Set<ActivityHub>();
let cacheBytes=0;
let slowDisconnects=0;
let summaryHits=0,summaryBuilds=0;
const cache=new Map<string,{value:Awaited<ReturnType<typeof readTurnSummaries>>;bytes:number;revision:string}>();
function cached(key:string,revision:string,value?:Awaited<ReturnType<typeof readTurnSummaries>>){
  if(value){const bytes=Buffer.byteLength(JSON.stringify(value))+Buffer.byteLength(key)+Buffer.byteLength(revision)+128;if(bytes>MAX_CACHE)return value;
    const old=cache.get(key);if(old)cacheBytes-=old.bytes;cache.delete(key);cache.set(key,{value,bytes,revision});cacheBytes+=bytes;
    while(cacheBytes>MAX_CACHE||cache.size>MAX_CACHE_ENTRIES){const first=cache.keys().next().value!;cacheBytes-=cache.get(first)!.bytes;cache.delete(first);}return value;
  }
  const entry=cache.get(key);if(entry&&entry.revision===revision){cache.delete(key);cache.set(key,entry);summaryHits++;return entry.value;}
  if(entry){cacheBytes-=entry.bytes;cache.delete(key);}return undefined;
}
export function activityStreamMetrics(){return {sources:liveHubs.size,clients:[...liveHubs].reduce((n,h)=>n+h.clients.size,0),cache_bytes:cacheBytes,
  slow_disconnects:slowDisconnects,summary_cache_entries:cache.size,summary_cache_hits:summaryHits,summary_builds:summaryBuilds,
  buffered_bytes:[...liveHubs].reduce((n,h)=>n+[...h.clients].reduce((m,c)=>m+c.raw.writableLength,0),0),blocked_clients:[...liveHubs].reduce((n,h)=>n+[...h.clients].filter(c=>c.busy).length,0)};}
const connections=new WeakMap<object,Set<ServerResponse>>();
export function registerActivityStreamShutdown(app:FastifyInstance){
 const streams=new Set<ServerResponse>();connections.set(app.server,streams);
 app.addHook('preClose',async()=>{for(const stream of streams){stream.end();const deadline=setTimeout(()=>stream.destroy(),5000);deadline.unref();stream.once('close',()=>clearTimeout(deadline));}streams.clear();});
}
export async function conversationReadable(db:Database,id:number){
 return !!(await db.query(`SELECT 1 FROM conversations c WHERE c.id=$1
 AND (c.task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=c.task_id AND t.deleted_at IS NULL))
 AND NOT EXISTS(SELECT 1 FROM finding_retests r WHERE r.conversation_id=c.id AND NOT finding_readable(r.finding_id))`,[id])).rowCount;
}
/** A client retains only its cursor and latest projection, never a history queue. */
class StreamClient {
 busy=false;closed=false;initial=true;previousSnapshots='';previousStatus='';previousRevision='';
 finalized=new Set<string>();delivered=new Map<string,{offset:number;hash:string;start:number}>();
 summaryVersions=new Map<string,string>();
 constructor(readonly raw:ServerResponse,public cursor:number,readonly taskID:number){}
 async write(text:string){
   // Chunk large durable records. Backpressure never discards a persisted row;
   // disconnect leaves the last completed SSE id available for replay.
   const bytes=Buffer.from(text);
   for(let offset=0;offset<bytes.length;offset+=16384){
     if(this.closed)throw new Error('closed');
     if(this.raw.writableLength>MAX_BUFFER){slowDisconnects++;this.raw.destroy();throw new Error('slow stream');}
     if(!this.raw.write(bytes.subarray(offset,offset+16384)))await new Promise<void>((resolve,reject)=>{
       const done=(error?:Error)=>{clearTimeout(timer);this.raw.off('drain',drain);this.raw.off('close',close);error?reject(error):resolve();};
       const drain=()=>done(),close=()=>done(new Error('closed'));
       const timer=setTimeout(()=>{slowDisconnects++;done(new Error('slow stream'));this.raw.destroy();},5000);timer.unref();
       this.raw.once('drain',drain);this.raw.once('close',close);
     });
   }
 }
 event(name:string,value:unknown){return this.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);}
}
let sourceSequence=0;
class ActivityHub {
 clients=new Set<StreamClient>();private timer?:ReturnType<typeof setTimeout>;private busy=false;private lastPoll=0;
 private groupOffset=0;private sequence=++sourceSequence;private lastPing=Date.now();private cacheKeys=new Set<string>();
 private recent:string[]=[];private recentRevision='';
 private unsubscribe:()=>void;
 constructor(private db:Database,private scope:StreamScope,private id:number,private remove:()=>void){
   liveHubs.add(this);const wake=(scope:StreamScope,id:number)=>{if(scope===this.scope&&id===this.id)this.schedule(250);};
   streamChanges.on('change',wake);this.unsubscribe=()=>streamChanges.off('change',wake);
 }
 add(client:StreamClient){this.clients.add(client);client.raw.on('close',()=>{client.closed=true;this.clients.delete(client);if(!this.clients.size)this.close();});this.schedule(0);}
 private close(){clearTimeout(this.timer);this.unsubscribe();liveHubs.delete(this);this.remove();for(const key of this.cacheKeys){const entry=cache.get(key);if(entry){cacheBytes-=entry.bytes;cache.delete(key);}}this.cacheKeys.clear();}
 private schedule(delay:number){
   if(!this.clients.size)return;
   clearTimeout(this.timer);
   this.timer=setTimeout(()=>void this.poll(),Math.max(delay,this.lastPoll+250-Date.now()));this.timer.unref();
 }
 private async poll(){
   if(this.busy||!this.clients.size)return;this.busy=true;this.lastPoll=Date.now();let active=false;
   try{
     const readable=this.scope==='conversation'?await conversationReadable(this.db,this.id):!!(await this.db.query('SELECT 1 FROM explorations WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM tasks WHERE exploration_id=$1 AND deleted_at IS NOT NULL)',[this.id])).rowCount;
     if(!readable){for(const c of this.clients){
       // Do not append a revocation frame concurrently with a blocked history write.
       if(c.busy){c.closed=true;c.raw.destroy();}
       else{c.busy=true;void c.event('access_revoked',{}).finally(()=>{c.closed=true;c.raw.end();}).catch(()=>{});}
     }return;}
     const available=[...this.clients].filter(c=>!c.busy&&!c.closed);
     if(!available.length)return;
     const scope=this.scope,id=this.id;
     // Snapshot before final rows, preserving the final-message handoff ordering.
     const snapshots=(await this.db.query(`SELECT worker,node_id,main_seg,turn_id,stream_id,channel,created_at,
       right(body,${ACTIVITY_PREVIEW_CHARS}) body,CASE WHEN storage_version=1 THEN total_chars ELSE char_length(body) END total_chars,
       greatest(0,(CASE WHEN storage_version=1 THEN total_chars ELSE char_length(body) END)-${ACTIVITY_PREVIEW_CHARS}) text_start,expires_at>now() active FROM agent_stream_snapshots WHERE scope=$1 AND scope_id=$2
       ${scope==='task'?"AND exploration_activity_readable(scope_id,node_id,jsonb_build_object('turn_id',turn_id))":''} ORDER BY created_at,stream_id,channel`,[scope,id])).rows;
     active=snapshots.some(row=>row.active);
     const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
     const allowed=scope==='task'?'AND exploration_activity_readable($1,node_id,metadata)':'';
     const versions=(await this.db.query(`SELECT
       (SELECT max(id) FROM ${table} WHERE ${column}=$1) activity,
       (SELECT version FROM stream_usage_versions WHERE scope='${scope}' AND scope_id=${scope==='task'?'(SELECT id FROM tasks WHERE exploration_id=$1)':'$1'}) usage,
       (SELECT count(*) FROM runtime_role_configs WHERE ${scope==='task'?'task_id=(SELECT id FROM tasks WHERE exploration_id=$1)':'conversation_id=$1'} AND (finished_at IS NULL AND expires_at<=now() OR finished_at>now()-interval '12 seconds')) runtime`,[id])).rows[0];
     const revision=JSON.stringify(versions);
     if(this.recentRevision!==revision||available.some(c=>c.initial)){
       this.recent=[...new Set((await this.db.query(`SELECT metadata->>'turn_id' turn_id FROM ${table} WHERE ${column}=$1 AND metadata ? 'turn_id' ${allowed} ORDER BY id DESC LIMIT 500`,[id])).rows.map(r=>String(r.turn_id)))].slice(0,100);this.recentRevision=revision;
     }
     const status=scope==='conversation'?JSON.stringify((await this.db.query(`SELECT status,left(error,4000) error FROM (SELECT status,error,created_at FROM conversation_runs WHERE conversation_id=$1 UNION ALL SELECT status,error,created_at FROM finding_retests WHERE conversation_id=$1) r ORDER BY created_at DESC LIMIT 1`,[id])).rows[0]??{status:'idle'}):'';
     // Group equal cursors so 20 readers of one task issue one history query.
     const groups=new Map<number,StreamClient[]>();for(const c of available){const group=groups.get(c.cursor)??[];group.push(c);groups.set(c.cursor,group);}
     let batches=0;
     const entries=[...groups];const start=entries.length?this.groupOffset%entries.length:0;this.groupOffset+=4;
     for(let i=0;i<entries.length;i++){const [cursor,clients]=entries[(start+i)%entries.length]!;
       if(batches++>=4){active=true;break;}
       const rows=(await readActivityPage(this.db,scope,`${column}=$1 AND id>$2 ${allowed}`,[id,cursor],'ASC',64)).rows;
       active ||=rows.length>0;
       // Also recheck a bounded set already shown to these clients. A revoked
       // turn can disappear from the readable recent query; send its empty
       // replacement instead of leaving a previously cached summary visible.
       const watched=[...new Set(clients.flatMap(c=>[...c.summaryVersions.keys()].slice(-100)))].slice(-100);
       const turns=[...new Set([...rows.map(r=>String((r.metadata as Row)?.turn_id??'')).filter(Boolean),...this.recent,...watched])];
       const summaries:SummaryBatch[]=[];
       for(let offset=0;offset<turns.length;offset+=100){const ids=turns.slice(offset,offset+100),versions=await readTurnRevisions(this.db,scope,id,ids);
         const found=new Map<string,Awaited<ReturnType<typeof readTurnSummaries>>>(),missing:string[]=[];
         for(const turn of ids){const v=versions.get(turn),items=v?cached(`${this.sequence}:${turn}`,v):undefined;
           if(items)found.set(turn,items);else missing.push(turn);}
         if(missing.length){summaryBuilds+=missing.length;const built=await readTurnSummaries(this.db,scope,id,missing);
           for(const turn of missing){const items=built.filter(item=>item.turn_id===turn),v=versions.get(turn),key=`${this.sequence}:${turn}`;found.set(turn,items);
             // Use the PRE-read revision. A concurrent mutation must make this
             // entry stale, never bless a mixed/older read with a newer revision.
             if(v){cached(key,v,items);this.cacheKeys.add(key);}}
           while(this.cacheKeys.size>1024){const first=this.cacheKeys.values().next().value!;this.cacheKeys.delete(first);const entry=cache.get(first);if(entry){cacheBytes-=entry.bytes;cache.delete(first);}}
         }summaries.push({items:ids.flatMap(turn=>found.get(turn)??[]),requested_ids:ids,versions});}
       const ping=Date.now()-this.lastPing>=15000;
       for(const client of clients){client.busy=true;void this.deliver(client,rows,snapshots,summaries,status,revision,ping).catch(()=>client.raw.destroy()).finally(()=>{client.busy=false;});}
     }
     if(Date.now()-this.lastPing>=15000)this.lastPing=Date.now();
   }catch{for(const c of this.clients)c.raw.destroy();}
   finally{this.busy=false;this.schedule(active?250:1000);}
 }
 private async deliver(c:StreamClient,rows:Row[],snapshots:Row[],summaries:SummaryBatch[],status:string,revision:string,ping:boolean){
   for(const row of rows){const m=row.metadata??{};if(m.stream_id)c.finalized.add(`${m.stream_id}:${m.channel??(row.kind==='thinking'?'thinking':'text')}`);
     await c.write(`id: ${row.id}\ndata: ${JSON.stringify({...activityDTO(row),...(this.scope==='task'?{exp_id:this.id,task_id:c.taskID}:{})})}\n\n`);c.cursor=Number(row.id);}
   for(const summary of summaries){const requested=summary.requested_ids.filter(turn=>!summary.versions.has(turn)||c.summaryVersions.get(turn)!==summary.versions.get(turn));
     if(!requested.length)continue;const wanted=new Set(requested);
     await c.event('turn_summary',{items:summary.items.filter(item=>wanted.has(item.turn_id)),requested_ids:requested});
     for(const turn of requested){const v=summary.versions.get(turn);if(v){c.summaryVersions.delete(turn);c.summaryVersions.set(turn,v);}}
     while(c.summaryVersions.size>1024)c.summaryVersions.delete(c.summaryVersions.keys().next().value!);
   }
   const keys=new Set(snapshots.map(r=>`${r.stream_id}:${r.channel}`));for(const k of c.finalized)if(!keys.has(k))c.finalized.delete(k);
   const items=snapshots.filter(r=>!c.finalized.has(`${r.stream_id}:${r.channel}`)).map(r=>({worker:r.worker==='main'?'mainagent':r.worker,intent_id:r.node_id==null?undefined:String(r.node_id),main_seg:r.main_seg,turn_id:r.turn_id,stream_id:r.stream_id,channel:r.channel,text:r.body,offset:String(r.body).length,text_start:Number(r.text_start),total_chars:Number(r.total_chars),truncated:Number(r.text_start)>0,ts:r.created_at,active:r.active}));
   const current=new Set(items.map(r=>String(r.stream_id)));for(const key of c.delivered.keys())if(!current.has(key))c.delivered.delete(key);
   for(const item of items){if(item.channel!=='text')continue;const text=String(item.text),before=c.delivered.get(String(item.stream_id));
     const continuation=!item.text_start&&(!before||!before.start&&text.length>=before.offset&&fingerprint(text.slice(0,before.offset))===before.hash);
     if(continuation&&text.length>(before?.offset??0))await c.event('delta',{...item,text:text.slice(before?.offset??0),offset:before?.offset??0});
     else if(!before||before.start!==item.text_start||before.hash!==fingerprint(text))await c.event('delta',{...item,reset:true});
     c.delivered.set(String(item.stream_id),{offset:text.length,hash:fingerprint(text),start:item.text_start});}
   const serialized=fingerprint(JSON.stringify(items));if(serialized!==c.previousSnapshots){await c.event('streams',{items});c.previousSnapshots=serialized;}
   if(status&&status!==c.previousStatus){await c.event('run_status',JSON.parse(status));c.previousStatus=status;}
   if(ping)await c.write(': ping\n\n');c.initial=false;c.previousRevision=revision;
 }
}
export async function serveActivityStream(db:Database,req:FastifyRequest,reply:FastifyReply,scope:StreamScope,scopeID:number){
 const query=req.query as Record<string,string|undefined>;
 reply.hijack();const raw=reply.raw,streams=connections.get(reply.server.server);streams?.add(raw);raw.on('close',()=>streams?.delete(raw));
 raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});raw.flushHeaders();
 raw.write(': connected\n\nretry: 500\n\n');
 let map=hubs.get(db);if(!map){map=new Map();hubs.set(db,map);}const key=`${scope}:${scopeID}`;
 let hub=map.get(key);if(!hub){hub=new ActivityHub(db,scope,scopeID,()=>map!.delete(key));map.set(key,hub);}
 hub.add(new StreamClient(raw,Math.max(0,Number(query.since)||0,Number(req.headers['last-event-id'])||0),Number(query.task)||0));
}
