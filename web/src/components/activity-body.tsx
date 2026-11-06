"use client";
import * as React from 'react';
import {CopyIcon} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {api} from '@/lib/api';
import {activityPreview,isPartialPage,ACTIVITY_PAGE_SIZE,type ActivityContentOptions,type ActivityContentPage} from '@/lib/activity-content';
import type {Activity} from '@/lib/types';

type Read=(step:Activity,options:ActivityContentOptions)=>Promise<ActivityContentPage>;
const Reader=React.createContext<Read>((step,options)=>api.activityContent(step.seq,options));
export function ActivityContentProvider({taskId,conversationId,children}:{taskId?:string;conversationId?:number;children:React.ReactNode}){
 const read=React.useCallback<Read>((step,options)=>step.seq>0
  ?conversationId?api.conversationContent(conversationId,step.seq,options):api.activityContent(step.seq,options,taskId)
  :step.stream_id?api.streamContent(step.stream_id,step.channel??'text',options,taskId,conversationId):Promise.reject(new Error('消息尚未保存')),[taskId,conversationId]);
 return <Reader.Provider value={read}>{children}</Reader.Provider>;
}

/** One page only: advancing replaces, rather than appends to, the previous page.
 * The displayed range is never interpreted as reading or copying the full body. */
export function ActivityBody({step,enabled=true,render,onReady,copy=false,copyText}:{step:Activity;enabled?:boolean;render?:(text:string,complete:boolean)=>React.ReactNode;onReady?:()=>void;copy?:boolean;copyText?:(text:string,complete:boolean)=>string}){
 const read=React.useContext(Reader),preview=activityPreview(step);
 const [page,setPage]=React.useState<ActivityContentPage>(),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
 const [unavailable,setUnavailable]=React.useState(false);
 const controller=React.useRef<AbortController|null>(null),ready=React.useRef(onReady);ready.current=onReady;
 const identity=`${step.seq}:${step.stream_id??''}:${step.detail_version??''}`;
 const load=React.useCallback(async(offset:number,version?:string,field:'detail'|'metadata'='detail')=>{
  controller.current?.abort();const c=new AbortController();controller.current=c;setBusy(true);setError('');
  try{const result=await read(step,{offset,version,field,signal:c.signal});if(!c.signal.aborted){setPage(result);setUnavailable(false);}}
  catch(e){if(!c.signal.aborted){
   setError(e instanceof Error?e.message:'原文加载失败');
   const status=e&&typeof e==='object'&&'status' in e?e.status:undefined;
   if(status===401||status===403||status===404){setPage(undefined);setUnavailable(true);}
  }}
  finally{if(!c.signal.aborted){setBusy(false);ready.current?.();}}
 },[read,step.seq,step.stream_id,step.channel]);
 React.useEffect(()=>{setPage(undefined);setError('');setBusy(false);setUnavailable(false);
  return()=>controller.current?.abort();
 },[identity,load]);
 // Entering the viewport enables the initial fetch, but must not discard a
 // manually selected page if the visibility observer arrives after a click.
 React.useEffect(()=>{if(enabled&&step.detail===undefined&&step.seq>0)void load(0);else ready.current?.();},[identity,enabled,load]);
 const shown=unavailable?undefined:page??preview,partial=!!shown&&isPartialPage(shown),live=step.seq<0&&!!step.stream_id;
 const summaryOnly=shown?.field!=='metadata'&&shown?.total_chars===0&&!!step.summary;
 const text=unavailable?'':summaryOnly?step.summary:shown?.detail??step.summary,complete=!!shown&&!partial;
 async function copyPage(){try{await navigator.clipboard.writeText(copyText&&shown?.field!=='metadata'?copyText(text,complete):text);toast.success(partial?'已复制当前片段':'已复制');}catch{toast.error('复制失败');}}
 return <div className="flex min-w-0 flex-col gap-2" data-activity-content={step.seq}>
  {!unavailable&&(shown?.field==='metadata'?<pre className="whitespace-pre-wrap break-words">{text}</pre>:render?render(text,complete):<span className="whitespace-pre-wrap break-words">{text}</span>)}
  {summaryOnly&&<p className="text-xs text-muted-foreground">原文为空，当前显示活动摘要。</p>}
  {!unavailable&&(partial||step.detail_truncated||page?.field==='metadata')&&<p className="text-xs text-muted-foreground" role="status">{live&&!page?'实时输出片段 · ':''}原文 {shown?.total_chars?`${(shown.offset+1).toLocaleString()}–${shown.next_offset.toLocaleString()} / ${shown.total_chars.toLocaleString()} 字符`:'当前片段'}{partial?'（未显示全文）':''}</p>}
  {error&&<p className="text-sm text-destructive" role="alert">{error}</p>}
  {(partial||error||copy||step.metadata_truncated||page?.field==='metadata'||live&&page)&&<div className="flex flex-wrap items-center gap-2">
   {live&&!page&&step.detail_truncated&&!unavailable?<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(0)}>分页读取原文</Button>:<>
    {shown&&shown.offset>0&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(Math.max(0,shown.offset-ACTIVITY_PAGE_SIZE),shown.version,shown.field==='metadata'?'metadata':'detail')}>上一页</Button>}
    {shown?.has_more&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(shown.next_offset,shown.version,shown.field==='metadata'?'metadata':'detail')}>下一页</Button>}
   </>}
   {error&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(0)}>重新读取第一页</Button>}
   {copy&&!unavailable&&<Button size="sm" variant="ghost" onClick={()=>void copyPage()}><CopyIcon data-icon="inline-start"/>{partial?'复制当前片段':'复制'}</Button>}
   {step.metadata_truncated&&!live&&page?.field!=='metadata'&&!unavailable&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void load(0,undefined,'metadata')}>读取附加信息</Button>}
   {page?.field==='metadata'&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void load(0)}>返回正文</Button>}
   {live&&page&&<Button size="sm" variant="ghost" onClick={()=>{controller.current?.abort();setBusy(false);setPage(undefined);setError('');}}>返回实时输出</Button>}
  </div>}
  {busy&&<span className="text-xs text-muted-foreground" role="status">读取中…</span>}
 </div>;
}
