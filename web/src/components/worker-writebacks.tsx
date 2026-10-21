"use client";

import * as React from 'react';
import {ChevronDown,ChevronRight,CopyIcon,ExternalLinkIcon} from 'lucide-react';
import {toast} from 'sonner';
import {api} from '@/lib/api';
import {appendWritebackPage,writebackLabel,writebackLink,writebackSummary,type WorkerWritebackPage,type WritebackItem} from '@/lib/worker-writebacks';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {Alert,AlertDescription} from '@/components/ui/alert';
import {Collapsible,CollapsibleTrigger,CollapsibleContent} from '@/components/ui/collapsible';
import {Table,TableHeader,TableRow,TableHead,TableBody,TableCell} from '@/components/ui/table';
import {Skeleton} from '@/components/ui/skeleton';

function WritebackRow({task,item}:{task:string;item:WritebackItem}){
  const [open,setOpen]=React.useState(false),[body,setBody]=React.useState<string|null>(null);
  const [offset,setOffset]=React.useState(-1),[error,setError]=React.useState(false),[busy,setBusy]=React.useState(false);
  const href=writebackLink(task,item);
  async function load(at=0){
    setBusy(true);setError(false);
    try{
      if(item.kind==='asset'){
        const asset=await api.assetDetail(Number(item.record_id),task);
        if(!asset)throw new Error('资产不可读取');
        setBody(JSON.stringify(asset,null,2));
      }else{
        const detail=await api.explorationNodeDetail(task,item.node_id!,at);
        setBody(old=>at?(old??'')+detail.payload:detail.payload);setOffset(detail.payload_next_offset);
      }
    }catch{setError(true);}finally{setBusy(false);}
  }
  function toggle(){if(!open&&body===null&&!busy)void load();setOpen(!open);}
  return <React.Fragment>
    <TableRow>
      <TableCell className="w-14 align-top">{item.kind==='asset'?'资产':item.kind==='fact'?'事实':'漏洞'}</TableCell>
      <TableCell className="min-w-0 whitespace-normal align-top">
        <div className="flex flex-col gap-1"><span title={item.summary??undefined} className="line-clamp-3 [overflow-wrap:anywhere]">{writebackSummary(item)}</span><span className="text-xs text-muted-foreground">{writebackLabel(item)}</span></div>
      </TableCell>
      <TableCell className="w-20 align-top"><Button variant="link" size="sm" onClick={toggle} aria-expanded={open} aria-label={`查看${item.kind==='asset'?'资产':item.kind==='fact'?'事实':'漏洞'} #${item.record_id}`} className="h-auto p-0">#{item.record_id}</Button></TableCell>
    </TableRow>
    {open&&<TableRow><TableCell colSpan={3} className="whitespace-normal">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">已保存记录 · 当前详情</Badge>
          {href&&<Button variant="ghost" size="sm" asChild><a href={href} target="_blank" rel="noreferrer"><ExternalLinkIcon data-icon="inline-start"/>打开详情</a></Button>}
          {body!==null&&<Button variant="ghost" size="icon-sm" aria-label="复制已加载详情" onClick={()=>void navigator.clipboard.writeText(body).then(()=>toast.success('已复制已加载详情'),()=>toast.error('复制失败'))}><CopyIcon/></Button>}
        </div>
        {body!==null&&<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{body}</pre>}
        {busy&&<span role="status">正在读取…</span>}
        {error&&<Button variant="outline" size="sm" onClick={()=>void load(body===null?0:offset)}>详情读取失败，重试</Button>}
        {!error&&offset>0&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void load(offset)}>继续读取完整记录</Button>}
      </div>
    </TableCell></TableRow>}
  </React.Fragment>;
}

function WritebackTable({task,page}:{task:string;page:WorkerWritebackPage}){
  const count=page.counts[page.bucket];
  return <Table className="table-fixed"><TableHeader><TableRow><TableHead className="w-14">类型</TableHead><TableHead>写回内容</TableHead><TableHead className="w-20">记录</TableHead></TableRow></TableHeader><TableBody>
    {page.items.map(item=><WritebackRow key={item.key} task={task} item={item}/>)}
    {page.complete&&count.total===0&&<TableRow><TableCell colSpan={3} className="whitespace-normal">{page.bucket==='current'?'本轮':'此前执行'}未保存资产、事实或漏洞。</TableCell></TableRow>}
    {page.complete&&count.total>0&&count.finding===0&&<TableRow><TableCell className="align-top">漏洞</TableCell><TableCell className="whitespace-normal">{page.bucket==='current'?'本轮未提交漏洞报告':'此前未提交漏洞报告'}</TableCell><TableCell>—</TableCell></TableRow>}
    {!page.complete&&!page.items.length&&<TableRow><TableCell colSpan={3} className="whitespace-normal">暂未找到可准确关联的记录，请查看原始总结。</TableCell></TableRow>}
  </TableBody></Table>;
}

export function WorkerWritebacks({task,turn,status,revision}:{task:string;turn:string;status?:string;revision:number}){
  const [current,setCurrent]=React.useState<WorkerWritebackPage>(),[previous,setPrevious]=React.useState<WorkerWritebackPage>();
  const [error,setError]=React.useState<'current'|'previous'|null>(null),[busy,setBusy]=React.useState(false),[previousOpen,setPreviousOpen]=React.useState(false);
  const generation=React.useRef(0);
  React.useEffect(()=>{
    const id=++generation.current;setCurrent(undefined);setPrevious(undefined);setError(null);setPreviousOpen(false);setBusy(true);
    void api.workerWritebacks(task,turn).then(page=>{if(id===generation.current)setCurrent(page);}).catch(()=>{if(id===generation.current)setError('current');}).finally(()=>{if(id===generation.current)setBusy(false);});
    return()=>{generation.current++;};
  },[task,turn,revision]);
  async function load(bucket:'current'|'previous',cursor?:string){
    const id=generation.current;setBusy(true);setError(null);
    try{const page=await api.workerWritebacks(task,turn,bucket,cursor);if(id!==generation.current)return;
      const update=bucket==='current'?setCurrent:setPrevious;update(old=>cursor?appendWritebackPage(old,page):page);
    }catch{if(id===generation.current)setError(bucket);}finally{if(id===generation.current)setBusy(false);}
  }
  const partial=!['done','completed'].includes(status??'');
  return <section aria-label="Worker 写回结果" className="flex min-w-0 flex-col gap-3" data-worker-writebacks="true">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{partial?'已保存的部分结果':'本轮写回'}</h4>{current&&<span className="text-xs text-muted-foreground">{current.complete?'':'已核对：'}资产 {current.counts.current.asset} · 事实 {current.counts.current.fact} · 漏洞 {current.counts.current.finding}</span>}</div>
    {!current&&!error&&<Skeleton className="h-24 w-full"/>}
    {current?.notice&&<Alert><AlertDescription>{current.notice}</AlertDescription></Alert>}
    {current&&<><WritebackTable task={task} page={current}/>{current.next_cursor&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void load('current',current.next_cursor!)}>加载更多写回记录</Button>}</>}
    {error&&<Alert variant="destructive"><AlertDescription><span>写回记录读取失败，原始总结仍可查看。</span><Button variant="outline" size="sm" disabled={busy} onClick={()=>void load(error,error==='current'?current?.next_cursor??undefined:previous?.next_cursor??undefined)}>重试</Button></AlertDescription></Alert>}
    {current&&current.counts.previous.total>0&&<Collapsible open={previousOpen} onOpenChange={open=>{setPreviousOpen(open);if(open&&!previous&&!busy)void load('previous');}}>
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm" disabled={busy} className="h-auto whitespace-normal text-left"><ChevronRight data-icon="inline-start" className={previousOpen?'rotate-90':undefined}/>此前执行已保存（{current.counts.previous.total}）</Button></CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 pt-2">{previous?<WritebackTable task={task} page={previous}/>:!error&&<Skeleton className="h-20 w-full"/>}{previous?.next_cursor&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void load('previous',previous.next_cursor!)}>加载更多此前记录</Button>}</CollapsibleContent>
    </Collapsible>}
  </section>;
}

/** A visual preview, not an extracted or rewritten conclusion. Full original stays intact. */
export function WorkerConclusion({children,focused}:{children:React.ReactNode;focused:boolean}){
  const [expanded,setExpanded]=React.useState(focused);
  React.useEffect(()=>{if(focused)setExpanded(true);},[focused]);
  return <div className="flex min-w-0 flex-col gap-2">
    <div className={!expanded?'max-h-28 overflow-hidden':'min-w-0'}>{children}</div>
    <Button variant="ghost" size="sm" className="h-auto justify-start whitespace-normal text-left" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>
      {expanded?<ChevronDown data-icon="inline-start"/>:<ChevronRight data-icon="inline-start"/>}{expanded?'收起完整总结':'展开完整总结（含线索与测试影响）'}
    </Button>
  </div>;
}
