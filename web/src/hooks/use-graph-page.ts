"use client";
import * as React from 'react';
import {api} from '@/lib/api';
import {startPolling} from '@/lib/polling';
import type {GraphSelection,GraphPage} from '@/lib/graph-browse';

/** Retain one page; reuse the shared non-overlapping/visibility-aware poller.
 * Unchanged versions do not resend node payloads or rebuild the canvas. */
export function useGraphPage(taskID:string,selection:GraphSelection,active:boolean,refresh=0){
 const [page,setPage]=React.useState<GraphPage>(),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
 const signature=JSON.stringify(selection);
 React.useEffect(()=>{
  let disposed=false,current:GraphPage|undefined;
  setPage(undefined);setError('');setBusy(false);
  if(!active)return;
  const poller=startPolling(async signal=>{
   setBusy(true);
   try{const reply=await api.graphPage(taskID,JSON.parse(signature),current?.revision,signal);
    if(!disposed&&!signal.aborted){if(!reply.unchanged){current=reply;setPage(reply);}setError('');}
   }catch(e){if(!disposed&&(!signal.aborted||signal.reason?.message?.includes('超时'))){setError(e instanceof Error?e.message:'探索图读取失败');current=undefined;setPage(undefined);}}
   finally{if(!disposed)setBusy(false);}
  },20000);
  return()=>{disposed=true;poller.stop();};
 },[taskID,signature,active,refresh]);
 return {page,error,busy};
}
