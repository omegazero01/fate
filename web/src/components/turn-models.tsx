"use client";
import * as React from 'react';
import {Button} from '@/components/ui/button';
import {api} from '@/lib/api';
import type {TurnSummary} from '@/lib/turn-summary';

type Props={summary:TurnSummary;taskId?:string;conversationId?:number};
function ModelName({summary,taskId,conversationId,index,name,length}:Props&{index:number;name:string;length:number}){
 const [page,setPage]=React.useState<{content:string;offset:number;next_offset:number;total_chars:number;has_more:boolean}>();
 const [busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
 async function read(offset:number){if(!summary.data_revision)return;setBusy(true);setError('');try{setPage((await api.turnModelName(taskId,conversationId,summary.turn_id,index,offset,summary.data_revision)).name);}catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}}
 return <span className="flex min-w-0 flex-col gap-1"><span className="whitespace-pre-wrap break-all">{page?.content??name}{!page&&length>256?'…':''}</span>
  {length>256&&<span className="flex flex-wrap justify-end gap-1">{page?<><span>名称 {page.offset+1}–{page.next_offset} / {page.total_chars} 字符</span><Button variant="ghost" size="xs" disabled={busy||page.offset===0} onClick={()=>void read(Math.max(0,page.offset-8192))}>上一段</Button><Button variant="ghost" size="xs" disabled={busy||!page.has_more} onClick={()=>void read(page.next_offset)}>下一段</Button></>:<Button variant="ghost" size="xs" disabled={busy||!summary.data_revision} onClick={()=>void read(0)}>读取完整名称</Button>}</span>}
  {error&&<span role="alert">{error}</span>}
 </span>;
}
/** Only the displayed page is retained; changing the evidence revision remounts it. */
export function TurnModels({summary,taskId,conversationId}:Props){
 const [page,setPage]=React.useState(summary),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
 const offset=page.models_offset??0,total=page.models_total??page.models.length;
 async function read(at:number){if(!summary.data_revision)return;setBusy(true);setError('');try{const item=(await api.turnModels(taskId,conversationId,summary.turn_id,at,summary.data_revision)).items[0];if(!item)throw new Error('本轮记录已不可读');setPage(item);}catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}}
 return <div className="flex min-w-0 flex-col gap-2">
  {page.models.length?page.models.map((name,i)=><React.Fragment key={offset+i}>{i>0&&<span aria-hidden="true">↓</span>}<ModelName summary={page} taskId={taskId} conversationId={conversationId} index={offset+i} name={name} length={page.model_name_lengths?.[i]??Array.from(name).length}/></React.Fragment>):'未记录'}
  {total>64&&<><span>模型序列 {offset+1}–{offset+page.models.length} / {total}</span><span className="flex justify-end gap-1"><Button variant="outline" size="xs" disabled={busy||offset===0||!summary.data_revision} onClick={()=>void read(Math.max(0,offset-64))}>上一页</Button><Button variant="outline" size="xs" disabled={busy||page.models_next_offset==null||!summary.data_revision} onClick={()=>void read(page.models_next_offset!)}>下一页</Button></span></>}
  {busy&&<span role="status">正在读取…</span>}{error&&<span role="alert">{error}</span>}
 </div>;
}
