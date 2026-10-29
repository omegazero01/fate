import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Database } from '../db/index.js';
import { activityDTO, type StreamScope } from '../engine/live-stream.js';
import {readTurnSummaries} from '../engine/turn-summary.js';
import {streamChanges} from '../engine/stream-changes.js';

type Row=Record<string,any>;
const MAX_BUFFER=1024*1024,MAX_CACHE=32*1024*1024;
const hubs=new WeakMap<Database,Map<string,ActivityHub>>();
const liveHubs=new Set<ActivityHub>();
let cacheBytes=0;
const cache=new Map<string,{value:Awaited<ReturnType<typeof readTurnSummaries>>;bytes:number}>();
function cached(key:string,value?:Awaited<ReturnType<typeof readTurnSummaries>>){
  if(value){const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>MAX_CACHE)return value;
    const old=cache.get(key);if(old)cacheBytes-=old.bytes;cache.delete(key);cache.set(key,{value,bytes});cacheBytes+=bytes;
    while(cacheBytes>MAX_CACHE){const first=cache.keys().next().value!;cacheBytes-=cache.get(first)!.bytes;cache.delete(first);}return value;
  }
  const entry=cache.get(key);if(entry){cache.delete(key);cache.set(key,entry);}return entry?.value;
}
export function activityStreamMetrics(){return {sources:liveHubs.size,clients:[...liveHubs].reduce((n,h)=>n+h.clients.size,0),cache_bytes:cacheBytes,
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
 finalized=new Set<string>();delivered=new Map<string,string>();
 constructor(readonly raw:ServerResponse,public cursor:number,readonly taskID:number){}
 async write(text:string){
   // Chunk large durable records. Backpressure never discards a persisted row;
   // disconnect leaves the last completed SSE id available for replay.
   const bytes=Buffer.from(text);
   for(let offset=0;offset<bytes.length;offset+=16384){
     if(this.closed)throw new Error('closed');
     if(this.raw.writableLength>MAX_BUFFER){this.raw.destroy();throw new Error('slow stream');}
     if(!this.raw.write(bytes.subarray(offset,offset+16384)))await new Promise<void>((resolve,reject)=>{
       const done=(error?:Error)=>{clearTimeout(timer);this.raw.off('drain',drain);this.raw.off('close',close);error?reject(error):resolve();};
       const drain=()=>done(),close=()=>done(new Error('closed'));
       const timer=setTimeout(()=>{done(new Error('slow stream'));this.raw.destroy();},5000);timer.unref();
       this.raw.once('drain',drain);this.raw.once('close',close);
     });
   }
 }
 event(name:string,value:unknown){return this.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);}
}
let sourceSequence=0;
class ActivityHub {
 clients=new Set<StreamClient>();private timer?:ReturnType<typeof setTimeout>;private busy=false;private lastPoll=0;
 private groupOffset=0;private sequence=++sourceSequence;private lastPing=Date.now();private revision='';private cacheKeys=new Set<string>();
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
     const snapshots=(await this.db.query(`SELECT *,expires_at>now() active FROM agent_stream_snapshots WHERE scope=$1 AND scope_id=$2
       ${scope==='task'?"AND exploration_activity_readable(scope_id,node_id,jsonb_build_object('turn_id',turn_id))":''} ORDER BY created_at,stream_id,channel`,[scope,id])).rows;
     active=snapshots.some(row=>row.active);
     const table=scope==='task'?'activity':'conversation_activities',column=scope==='task'?'exploration_id':'conversation_id';
     const allowed=scope==='task'?'AND exploration_activity_readable($1,node_id,metadata)':'';
     const versions=(await this.db.query(`SELECT
       (SELECT max(id) FROM ${table} WHERE ${column}=$1) activity,
       (SELECT version FROM stream_usage_versions WHERE scope='${scope}' AND scope_id=${scope==='task'?'(SELECT id FROM tasks WHERE exploration_id=$1)':'$1'}) usage,
       (SELECT count(*) FROM runtime_role_configs WHERE ${scope==='task'?'task_id=(SELECT id FROM tasks WHERE exploration_id=$1)':'conversation_id=$1'} AND (finished_at IS NULL AND expires_at<=now() OR finished_at>now()-interval '12 seconds')) runtime`,[id])).rows[0];
     const revision=JSON.stringify(versions);
     if(revision!==this.revision){for(const key of this.cacheKeys){const entry=cache.get(key);if(entry){cacheBytes-=entry.bytes;cache.delete(key);}}this.cacheKeys.clear();this.revision=revision;}
     let recent:string[]=[];
     if(available.some(c=>c.initial||c.previousRevision!==revision)){
       recent=[...new Set((await this.db.query(`SELECT metadata->>'turn_id' turn_id FROM ${table} WHERE ${column}=$1 AND metadata ? 'turn_id' ${allowed} ORDER BY id DESC LIMIT 500`,[id])).rows.map(r=>String(r.turn_id)))].slice(0,100);
     }
     const status=scope==='conversation'?JSON.stringify((await this.db.query(`SELECT status,error FROM (SELECT status,error,created_at FROM conversation_runs WHERE conversation_id=$1 UNION ALL SELECT status,error,created_at FROM finding_retests WHERE conversation_id=$1) r ORDER BY created_at DESC LIMIT 1`,[id])).rows[0]??{status:'idle'}):'';
     // Group equal cursors so 20 readers of one task issue one history query.
     const groups=new Map<number,StreamClient[]>();for(const c of available){const group=groups.get(c.cursor)??[];group.push(c);groups.set(c.cursor,group);}
     let batches=0;
     const entries=[...groups];const start=entries.length?this.groupOffset%entries.length:0;this.groupOffset+=4;
     for(let i=0;i<entries.length;i++){const [cursor,clients]=entries[(start+i)%entries.length]!;
       if(batches++>=4){active=true;break;}
       const rows=(await this.db.query(`WITH page AS MATERIALIZED (SELECT id,COALESCE(octet_length(detail),0)+COALESCE(octet_length(summary),0)+pg_column_size(metadata)+512 bytes FROM ${table} WHERE ${column}=$1 AND id>$2 ${allowed} ORDER BY id LIMIT 500), bounded AS (SELECT id,sum(bytes) OVER(ORDER BY id) bytes,row_number() OVER(ORDER BY id) n FROM page) SELECT a.* FROM ${table} a JOIN bounded b ON b.id=a.id WHERE b.bytes<=1048576 OR b.n=1 ORDER BY a.id`,[id,cursor])).rows;
       active ||=rows.length>0;
       const turns=[...new Set([...rows.map(r=>String((r.metadata as Row)?.turn_id??'')).filter(Boolean),...recent])];
       const summaries=[];
       for(let offset=0;offset<turns.length;offset+=100){const ids=turns.slice(offset,offset+100),key=`${this.sequence}:${ids.join(',')}`;
         let items=cached(key);if(!items){items=await readTurnSummaries(this.db,scope,id,ids);cached(key,items);this.cacheKeys.add(key);
           // Bound key metadata too, including entries evicted by the global byte LRU.
           while(this.cacheKeys.size>1024){const first=this.cacheKeys.values().next().value!;this.cacheKeys.delete(first);const entry=cache.get(first);if(entry){cacheBytes-=entry.bytes;cache.delete(first);}}
         }summaries.push({items,requested_ids:ids});}
       const ping=Date.now()-this.lastPing>=15000;
       for(const client of clients){client.busy=true;void this.deliver(client,rows,snapshots,summaries,status,revision,ping).catch(()=>client.raw.destroy()).finally(()=>{client.busy=false;});}
     }
     if(Date.now()-this.lastPing>=15000)this.lastPing=Date.now();
   }catch{for(const c of this.clients)c.raw.destroy();}
   finally{this.busy=false;this.schedule(active?250:1000);}
 }
 private async deliver(c:StreamClient,rows:Row[],snapshots:Row[],summaries:unknown[],status:string,revision:string,ping:boolean){
   for(const row of rows){const m=row.metadata??{};if(m.stream_id)c.finalized.add(`${m.stream_id}:${m.channel??(row.kind==='thinking'?'thinking':'text')}`);
     await c.write(`id: ${row.id}\ndata: ${JSON.stringify({...activityDTO(row),...(this.scope==='task'?{exp_id:this.id,task_id:c.taskID}:{})})}\n\n`);c.cursor=Number(row.id);}
   for(const summary of summaries)await c.event('turn_summary',summary);
   const keys=new Set(snapshots.map(r=>`${r.stream_id}:${r.channel}`));for(const k of c.finalized)if(!keys.has(k))c.finalized.delete(k);
   const items=snapshots.filter(r=>!c.finalized.has(`${r.stream_id}:${r.channel}`)).map(r=>({worker:r.worker==='main'?'mainagent':r.worker,intent_id:r.node_id==null?undefined:String(r.node_id),main_seg:r.main_seg,turn_id:r.turn_id,stream_id:r.stream_id,channel:r.channel,text:r.body,offset:String(r.body).length,ts:r.created_at,active:r.active}));
   const current=new Set(items.map(r=>String(r.stream_id)));for(const key of c.delivered.keys())if(!current.has(key))c.delivered.delete(key);
   for(const item of items){if(item.channel!=='text')continue;const before=c.delivered.get(String(item.stream_id))??'';if(String(item.text).startsWith(before)&&String(item.text).length>before.length)await c.event('delta',{...item,text:String(item.text).slice(before.length),offset:before.length});c.delivered.set(String(item.stream_id),String(item.text));}
   const serialized=JSON.stringify(items);if(serialized!==c.previousSnapshots){await c.event('streams',{items});c.previousSnapshots=serialized;}
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
