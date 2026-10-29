"use client";
import {useEffect,useRef} from 'react';
/** One in-flight read, including filter changes; hidden tabs do not poll. */
export function useVisiblePoll(read:(signal:AbortSignal)=>Promise<unknown>,interval:number){
 const pending=useRef<Promise<unknown>|null>(null);
 useEffect(()=>{
  const controller=new AbortController();let running=false;let timer:ReturnType<typeof setTimeout>;
  const run=async()=>{
   if(running)return;
   clearTimeout(timer);
   if(controller.signal.aborted||document.hidden)return;
   running=true;
   if(pending.current)await pending.current.catch(()=>{});
   if(controller.signal.aborted||document.hidden){running=false;return;}
   const promise=read(controller.signal);pending.current=promise;
   try{await promise;}catch{/* the view owns error presentation */}finally{
    running=false;
    if(pending.current===promise)pending.current=null;
    if(!controller.signal.aborted)timer=setTimeout(run,interval);
   }
  };
  const visible=()=>{if(!document.hidden)void run();};document.addEventListener('visibilitychange',visible);void run();
  return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[read,interval]);
}
