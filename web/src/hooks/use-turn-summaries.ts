"use client";
import * as React from 'react';
import {api} from '@/lib/api';
import {mergeTurnSummaries,type TurnSummary,type TurnSummaryBatch} from '@/lib/turn-summary';

/** Reuses the existing scope SSE; opening a popover never creates a subscription. */
export function useTurnSummaries(taskId:string|undefined,conversationId:number|undefined,ids:string[]){
 const scope=conversationId?`conversation:${conversationId}`:taskId?`task:${taskId}`:'';
 const [state,setState]=React.useState<{scope:string;items:Record<string,TurnSummary>}>({scope,items:{}});
 const key=[...new Set(ids)].sort().join(',');
 React.useEffect(()=>{
  let alive=true;
  setState(old=>old.scope===scope?old:{scope,items:{}});
  const delivered=new Set<string>();
  const merge=(batch:TurnSummaryBatch,rest=false)=>{if(!alive)return;setState(old=>({scope,items:mergeTurnSummaries(old.scope===scope?old.items:{},batch,rest?delivered:undefined)}));};
  const event=(e:Event)=>{const data=(e as CustomEvent<TurnSummaryBatch&{scope:string}>).detail;if(data.scope===scope){for(const id of data.requested_ids)delivered.add(id);for(const item of data.items)delivered.add(item.turn_id);merge(data);}};
  window.addEventListener('series:turn-summary',event);
  const all=key.split(',').filter(Boolean);
  if(scope)for(let at=0;at<all.length;at+=100){const ids=all.slice(at,at+100);void api.turnSummaries(taskId,conversationId,ids).then(r=>merge({...r,requested_ids:ids},true)).catch(()=>{/* Legacy servers keep their ordered transcript; unknown is never zero. */});}
  return()=>{alive=false;window.removeEventListener('series:turn-summary',event);};
 },[scope,key,taskId,conversationId]);
 return state.scope===scope?state.items:{};
}
