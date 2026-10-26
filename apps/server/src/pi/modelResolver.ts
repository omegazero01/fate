import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Database } from '../db/index.js';
import type { LLMProfile } from '../db/platform.js';
import type { ModelResolver } from '../engine/engine.js';
import type { ModelSource } from '../agent/roles.js';
import { buildModelSource } from './providerFromProfile.js';
import {meterProvider,replayUsageOutbox} from './usage-meter.js';
import type {UsageScope} from '../db/usage-ledger.js';

/** The management DTO and all role sessions use this same precedence and ordered chain. */
export async function resolveModelProfiles(db:Database,taskID:number,role:string,context?:{conversationID?:number;profileID?:number}) {
  const task=await db.tasks().getTask(taskID);
  if(taskID&&!task)throw new Error(`任务 #${taskID} 不存在`);
  const chain=await db.query(`SELECT profile_id,status,position,last_error FROM task_llm_profiles WHERE task_id=$1 ORDER BY position`,[taskID]);
  const agent=await db.query(`SELECT llm_profile_id AS id,enabled FROM agents WHERE key=$1`,[role]);
  let ids=chain.rows.filter(r=>r.status==='ready').map(r=>Number(r.profile_id));
  const active=Number(context?.profileID??task?.active_llm_profile_id ?? task?.llm_profile_id ?? 0);
  if(ids.includes(active))ids=[active,...ids.filter(id=>id!==active)];
  let source='task_chain';
  if(context?.profileID){ids=[context.profileID];source='conversation';}
  if(!chain.rows.length&&!context?.profileID){
    const bound=Number(task?.active_llm_profile_id??task?.llm_profile_id??agent.rows[0]?.id??0);
    const primary=bound||Number((await db.platform().activeProfile())?.id??0);
    source=task?.active_llm_profile_id||task?.llm_profile_id?'task_chain':Number(agent.rows[0]?.id)?'agent_binding':'global_profile';
    if(primary)ids=[primary];
    const poolEnabled=await db.platform().getBool('llm_pool_enabled',false);
    const bindFallback=await db.platform().getBool('llm_pool_bind_fallback',false);
    const explicitlyBound=!!bound;
    if(poolEnabled&&(!explicitlyBound||bindFallback)&&primary){
      const all=await db.platform().listProfiles();
      const candidates=all.filter(p=>p.id===primary||!p.poolExclude).sort((a,b)=>Number(b.id===primary)-Number(a.id)||Number(b.isDefault)-Number(a.isDefault)||b.priority-a.priority||a.id-b.id);
      ids=candidates.map(p=>p.id);
    }
  }
  const profiles:LLMProfile[]=[];
  for(const id of ids){ const p=await db.platform().profileByID(id);if(p)profiles.push(p); }
  if(profiles.length>1){
    const health=await db.query(`SELECT profile_id FROM llm_profile_health WHERE profile_id=ANY($1::bigint[]) AND open_until>now()`,[profiles.map(p=>p.id)]);
    const cooling=new Set(health.rows.map(r=>Number(r.profile_id)));
    const available=profiles.filter(p=>!cooling.has(p.id));
    if(available.length)profiles.splice(0,profiles.length,...available);
  }
  const p=profiles[0];
  return {profiles,chain:chain.rows,source,resolution:{profile_id:p?.id,name:p?.name??'',model:p?.model??'',format:p?.format??'',source,
    available:!!p && agent.rows[0]?.enabled!==false,
    ...(!p?{reason:chain.rows.length?'任务模型候补链已耗尽':'未配置 LLM'}:agent.rows[0]?.enabled===false?{reason:'角色已禁用'}:{})}};
}

function cleanError(error:string,profiles:LLMProfile[]){
  for(const p of profiles)if(p.apiKey)error=error.split(p.apiKey).join('[redacted]');
  return error.replace(/(?:Bearer\s+|\bsk-)[\w.-]+/gi,'[redacted]').slice(0,2000);
}

/** Shared database limiter: reservations are serialized per profile across tasks and processes. */
async function reserveRequest(db:Database,p:LLMProfile,signal?:AbortSignal){
  const spacing=Math.max(p.ratePerSecond>0?1000/p.ratePerSecond:0,p.ratePerMinute>0?60000/p.ratePerMinute:0);
  if(!spacing)return;
  const wait=await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock($1)',[4_000_000_000+p.id]);
    const r=await tx.query(`INSERT INTO llm_request_limits(profile_id,next_at) VALUES($1,clock_timestamp()) ON CONFLICT(profile_id) DO UPDATE SET next_at=GREATEST(llm_request_limits.next_at,clock_timestamp()) RETURNING EXTRACT(EPOCH FROM (next_at-clock_timestamp()))*1000 AS wait`,[p.id]);
    await tx.query(`UPDATE llm_request_limits SET next_at=next_at+($2 * interval '1 millisecond') WHERE profile_id=$1`,[p.id,spacing]);
    return Math.max(0,Number(r.rows[0]?.wait??0));
  });
  if(wait)await delay(wait,undefined,{signal});
  signal?.throwIfAborted();
}

export function makeModelResolver(db:Database,build=buildModelSource):ModelResolver {
  const cache=new Map<string,Promise<ModelSource>>();
  return async(taskID,role,context)=>{
    const resolved=await resolveModelProfiles(db,taskID,role,context);
    if(!resolved.resolution.available)throw new Error(resolved.resolution.reason);
    const profiles=resolved.profiles, sources:ModelSource[]=[];
    for(const profile of profiles){
      const headerSession=context?.conversationID?`conversation:${context.conversationID}`:`task:${taskID||'platform'}:${role}`;
      const scopedProfile={...profile,sessionHeaderValue:profile.sessionHeaderKey?headerSession:undefined};
      const key=createHash('sha256').update(JSON.stringify(scopedProfile)).digest('hex');
      let source=cache.get(key);
      if(!source){if(cache.size>=32)cache.clear();source=build(scopedProfile);cache.set(key,source);source.catch(()=>cache.delete(key));}
      sources.push(await source);
    }
    let index=0,retries=0,lastError='',lastResponseIndex=0,purpose:'conversation'|'compaction'='conversation';
    let runtimeID:string|undefined,scope:UsageScope={};
    const runtime=await ModelRuntime.create({refreshOnCreate:false});
    for(const [i,source] of sources.entries()){
      const provider=source.modelRuntime.getProvider(source.model.provider);if(!provider)throw new Error('模型 provider 未注册');
      await runtime.registerNativeProvider(meterProvider(db,provider,profiles[i]!,()=>({...scope,taskID,conversationID:context?.conversationID,role,purpose,runtimeID})));
    }
    await runtime.refresh({allowNetwork:false});
    const retryRaw=await db.platform().getSetting('llm_retry_policy');
    let retryPolicy:Record<string,{attempts?:number;interval_ms?:number}>={};
    try{retryPolicy=retryRaw?JSON.parse(retryRaw) as typeof retryPolicy:{}}catch{/* invalid saved setting uses sdk defaults */}
    runtime.registerVirtualModel({provider:'series-router',id:`task-${taskID}-${role}`,name:`任务 ${taskID} / ${role}`,input:sources.every(s=>s.model.input.includes('image'))?['text','image']:['text'],
      contextWindow:Math.min(...sources.map(s=>s.model.contextWindow)),maxTokens:Math.min(...sources.map(s=>s.model.maxTokens)),
      route:async request=>{
        request.signal?.throwIfAborted();
        await reserveRequest(db,profiles[index]!,request.signal);
        request.signal?.throwIfAborted();
        const source=sources[index]!;
        return {model:source.model,thinkingLevel:source.thinkingLevel??'off'};
      }});
    return {modelRuntime:runtime,model:runtime.getModel('series-router',`task-${taskID}-${role}`)!,streaming:profiles[0]?.streaming!==false,modelPolicy:{
      setRuntimeID(id){runtimeID=id;},
      setScope(value){scope={...value};},
      setPurpose(value){purpose=value;},
      async finish(){await replayUsageOutbox(db);},
      async onResponse(message){
        const m=message as {provider?:string;stopReason?:string;errorMessage?:string;content?:unknown[];usage?:{totalTokens?:number}};
        // pi may emit an aborted synthetic message after a host-completed tool turn.
        // It has no provider request and must not create failures or alter health.
        if(m.stopReason==='aborted'&&!m.content?.length&&!m.usage?.totalTokens)return;
        const physical=sources.findIndex(s=>s.model.provider===m.provider);
        lastResponseIndex=physical>=0?physical:index;
        lastError=m.stopReason==='error'?cleanError(m.errorMessage??'模型调用失败',profiles):'';
        if(!lastError){
          retries=0;
          await db.query(`INSERT INTO llm_profile_health(profile_id,fails,trips,open_until,last_error,last_at) VALUES($1,0,0,NULL,'',now())
            ON CONFLICT(profile_id) DO UPDATE SET fails=0,open_until=NULL,last_error='',last_at=now()`,[profiles[lastResponseIndex]!.id]);
        }
      },
      async retry(signal){
        signal?.throwIfAborted();
        if(!lastError)return false;
        const p=profiles[lastResponseIndex]!;
        const hard=/401|403|invalid.?api.?key|unauthori|insufficient|quota|credit|balance/i.test(lastError);
        const globalRule=retryPolicy.connect??{};
        const configured=p.retry?.connect?.attempts??0;
        const retryLimit=configured===-1?0:Math.max(0,Math.min(20,configured||Number(globalRule.attempts)||3));
        if(!hard && retries<retryLimit){
          retries++;const fixed=p.retry?.connect?.interval_ms||Number(globalRule.interval_ms)||0;
          await delay(Math.min(fixed||Math.min(250*2**(retries-1),4000),10_000),undefined,{signal});return true;
        }
        const health=await db.query<{fails:number;trips:number}>(`SELECT fails,trips FROM llm_profile_health WHERE profile_id=$1`,[p.id]);
        const fails=Number(health.rows[0]?.fails??0)+1,trips=Number(health.rows[0]?.trips??0);
        const threshold=Number(retryPolicy.breaker?.attempts)||3;
        const trip=hard||(threshold>=0&&fails>=threshold);
        const nextTrips=trip?trips+1:trips;
        const coolMinutes=[1,5,30][Math.min(nextTrips-1,2)]??30;
        const interval=Number(retryPolicy.breaker?.interval_ms)||0;
        const openUntil=trip?new Date(Date.now()+(interval||coolMinutes*60_000)):null;
        await db.query(`INSERT INTO llm_profile_health(profile_id,fails,trips,open_until,last_error,last_at) VALUES($1,$2,$3,$4,$5,now())
          ON CONFLICT(profile_id) DO UPDATE SET fails=$2,trips=$3,open_until=$4,last_error=$5,last_at=now()`,[p.id,fails,nextTrips,openUntil,lastError]);
        await db.query(`UPDATE task_llm_profiles SET last_error=$3,status=CASE WHEN $4 THEN 'quota_exhausted' ELSE status END,exhausted_at=CASE WHEN $4 THEN now() ELSE exhausted_at END WHERE task_id=$1 AND profile_id=$2`,[taskID,p.id,lastError,hard]);
        const next=Math.max(index,lastResponseIndex+1);
        if(next>=sources.length)return false;
        index=next;retries=0;
        if(resolved.source==='task_chain')await db.query('UPDATE tasks SET active_llm_profile_id=$2 WHERE id=$1',[taskID,profiles[index]!.id]);
        return true;
      },
    }};
  };
}
