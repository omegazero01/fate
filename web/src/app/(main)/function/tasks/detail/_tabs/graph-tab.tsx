"use client";
import * as React from 'react';
import {useSearchParams} from 'next/navigation';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Field,FieldGroup,FieldLabel} from '@/components/ui/field';
import {Alert,AlertDescription} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {ExplorationGraph} from '@/components/exploration-graph';
import {useGraphPage} from '@/hooks/use-graph-page';
import type {GraphSelection} from '@/lib/graph-browse';

export function GraphTab({taskId,active=true}:{taskId:string;active?:boolean}){
 const focus=useSearchParams().get('node');
 const [selection,setSelection]=React.useState<GraphSelection>({}),[history,setHistory]=React.useState<GraphSelection[]>([]);
 const [input,setInput]=React.useState(''),[refresh,setRefresh]=React.useState(0);
 React.useEffect(()=>{setSelection(focus?{mode:'relations',focus}:{});setHistory([]);},[taskId,focus]);
 const {page,error,busy}=useGraphPage(taskId,selection,active,refresh);
 const go=(next:GraphSelection)=>{setHistory(h=>[...h,selection]);setSelection(next);};
 const explore=(id:string,mode:'relations'|'members')=>go({mode,focus:id});
 return <Card>
  <CardHeader>
   <CardTitle>探索图</CardTitle>
   <CardDescription>按节点或关联关系分页浏览。点击节点可读取完整原文、关联资产和上游链路。</CardDescription>
   <form onSubmit={e=>{e.preventDefault();const q=input.trim();go(/^#?\d+$/.test(q)?{mode:'relations',focus:q.replace(/^#/,'')}:{q});}}>
    <FieldGroup><Field><FieldLabel htmlFor="graph-search">按摘要搜索，或输入节点 ID</FieldLabel><div className="flex gap-2"><Input id="graph-search" value={input} onChange={e=>setInput(e.target.value)} maxLength={256}/><Button type="submit" disabled={busy}>查找</Button></div></Field></FieldGroup>
   </form>
   <div className="flex flex-wrap items-center gap-2">
    <Button variant="outline" size="sm" disabled={busy||!history.length} onClick={()=>{setSelection(history.at(-1)!);setHistory(h=>h.slice(0,-1));}}>返回上页</Button>
    <Button variant="outline" size="sm" disabled={busy} onClick={()=>{setSelection({});setHistory([]);setInput('');}}>全部节点</Button>
    <Button variant="outline" size="sm" disabled={busy} onClick={()=>{setSelection(s=>({...s,revision:undefined}));setRefresh(n=>n+1);}}>刷新当前视图</Button>
    {page&&<Badge variant="outline">共 {page.total_nodes} 个节点</Badge>}
    {busy&&<span role="status" className="text-sm text-muted-foreground">读取中…</span>}
   </div>
   {page&&<p className="text-sm text-muted-foreground" role="status">
    {page.complete?'当前显示完整探索图':page.mode==='relations'?`节点 #${page.focus} 的关联关系：本页 ${page.edges.length} / 共 ${page.total}`:page.mode==='members'?`摘要 #${page.focus} 的成员：本页 ${Math.max(0,page.nodes.length-1)} / 共 ${page.total}`:`当前节点页：${page.nodes.length} / 匹配 ${page.total}`}
    {!page.complete&&' · 局部视图，未显示的节点与关系仍保留在图中'}
    {page.mode!=='relations'&&` · 当前节点之间的关系：${page.edges.length} / ${page.edge_total}`}
   </p>}
   <div className="flex flex-wrap gap-2">
    {page?.next_before&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>go({...selection,before:page.next_before!,edge_before:undefined,revision:page.revision})}>下一页{page.mode==='relations'?'关系':page.mode==='members'?'成员':'节点'}</Button>}
    {page?.next_edge_before&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>go({...selection,edge_before:page.next_edge_before!,revision:page.revision})}>下一页页内关系</Button>}
   </div>
   {error&&<Alert variant="destructive"><AlertDescription>{error}；请刷新当前视图。</AlertDescription></Alert>}
  </CardHeader>
  <CardContent className="p-0">
   {page&&<ExplorationGraph taskId={taskId} nodes={page.nodes} edges={page.edges} paged readRevision={page.revision} onExplore={explore} className="h-[60vh]"/>}
  </CardContent>
 </Card>;
}
