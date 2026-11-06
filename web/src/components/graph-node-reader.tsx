"use client";
import * as React from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {api} from '@/lib/api';
import type {GraphNodePage} from '@/lib/graph-browse';

/** Retain only the current raw/asset page. A copy is explicitly a fragment
 * when any part of the original JSON is outside the current window. */
export function GraphNodeReader({taskID,nodeID,kind,onExplore}:{taskID:string;nodeID:string;kind:string;onExplore?:(id:string,mode:'relations'|'members')=>void}){
 const [page,setPage]=React.useState<GraphNodePage>(),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[copied,setCopied]=React.useState(false);
 const controller=React.useRef<AbortController|null>(null);
 const load=React.useCallback(async(offset=0,version?:string,assetOffset=0,revision?:string)=>{
  controller.current?.abort();const c=new AbortController();controller.current=c;setBusy(true);setError('');setCopied(false);
  try{const r=await api.graphNodePage(taskID,nodeID,offset,version,assetOffset,c.signal,revision);if(!c.signal.aborted)setPage(r);}
  catch(e){if(!c.signal.aborted){setPage(undefined);setError(e instanceof Error?e.message:'原文读取失败');}}
  finally{if(!c.signal.aborted)setBusy(false);}
 },[taskID,nodeID]);
 React.useEffect(()=>{setPage(undefined);void load();return()=>controller.current?.abort();},[load]);
 const c=page?.content,partial=!!c&&(c.offset>0||c.has_more);
 return <div className="flex flex-col gap-3">
  {onExplore&&<div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={()=>onExplore(nodeID,'relations')}>浏览关联关系</Button>{kind==='digest'&&<Button size="sm" variant="outline" onClick={()=>onExplore(nodeID,'members')}>浏览摘要成员</Button>}</div>}
  {page&&<section className="flex flex-col gap-2"><h4 className="text-sm">关联资产：本页 {page.assets.length} / 共 {page.assets_total}</h4>
   {page.assets.map(a=><Link key={a.id} className="text-sm break-all underline" href={`/function/tasks/detail?${new URLSearchParams({id:taskID,tab:'graph',explore:'coverage',asset:String(a.id)})}`}>#{a.id} {a.method} {a.url||a.domain||a.ip||a.app_name}</Link>)}
   <div className="flex gap-2">{page.asset_offset>0&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(c!.offset,c!.version,Math.max(0,page.asset_offset-20),page.revision)}>上一页资产</Button>}{page.assets_next_offset!==null&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(c!.offset,c!.version,page.assets_next_offset!,page.revision)}>下一页资产</Button>}</div>
  </section>}
  {c&&<section className="flex min-w-0 flex-col gap-2">
   <h4 className="text-sm">原始数据</h4><p className="text-xs text-muted-foreground">字符 {c.total_chars?c.offset+1:0}–{c.next_offset} / {c.total_chars}{partial?'（未显示全文）':''}</p>
   <pre className="bg-muted max-h-80 max-w-full overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">{c.detail}</pre>
   <div className="flex flex-wrap gap-2">
    {c.offset>0&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(Math.max(0,c.offset-8192),c.version,page!.asset_offset,page!.revision)}>上一段原文</Button>}
    {c.has_more&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load(c.next_offset,c.version,page!.asset_offset,page!.revision)}>下一段原文</Button>}
    <Button size="sm" variant="ghost" onClick={()=>void navigator.clipboard.writeText(c.detail).then(()=>setCopied(true)).catch(()=>setError('复制失败'))}>{copied?'已复制':partial?'复制当前片段':'复制原文'}</Button>
   </div>
  </section>}
  {error&&<p className="text-destructive text-sm" role="alert">{error}</p>}
  {error&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void load()}>重新读取第一页</Button>}
  {busy&&<p className="text-muted-foreground text-sm" role="status">读取中…</p>}
 </div>;
}
