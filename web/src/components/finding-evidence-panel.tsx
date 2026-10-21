"use client";
import * as React from "react";
import {toast} from "sonner";
import {api} from "@/lib/api";
import type {Finding,FindingTraffic,FindingRetest,TrafficExchange} from "@/lib/types";
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from "@/components/ui/card";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
import {Field,FieldGroup,FieldLabel} from "@/components/ui/field";
import {Select,SelectContent,SelectGroup,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
import {Alert,AlertDescription} from "@/components/ui/alert";
import {Markdown} from "@/components/markdown";
import {useConversationActivity} from "@/hooks/use-conversation-activity";
import {MessageScrollerProvider,MessageScroller,MessageScrollerViewport,MessageScrollerContent,MessageScrollerButton} from "@/components/ui/message-scroller";
import {Transcript} from "@/components/transcript";

export function FindingEvidencePanel({finding,contextTask,readOnly}:{finding:Finding;contextTask?:string;readOnly:boolean}){
 const id=finding.finding_id!;
 const [evidence,setEvidence]=React.useState<FindingTraffic>();
 const [traffic,setTraffic]=React.useState<TrafficExchange[]>([]),[selected,setSelected]=React.useState("");
 const [retests,setRetests]=React.useState<FindingRetest[]>([]);
 const [busy,setBusy]=React.useState(false),[error,setError]=React.useState("");
 const [body,setBody]=React.useState<{bid:string;side:"request"|"response";content:string;next:number;total:number}>();
 const [process,setProcess]=React.useState<number>();
 const refresh=React.useCallback(async()=>{const [e,r]=await Promise.all([api.findingTraffic(id,contextTask),api.findingRetests(id)]);setEvidence(e);setRetests(r);},[id,contextTask]);
 React.useEffect(()=>{let active=true;Promise.all([api.findingTraffic(id,contextTask),api.findingRetests(id)]).then(([e,r])=>{if(active){setEvidence(e);setRetests(r);}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[id,contextTask]);
 async function act(fn:()=>Promise<unknown>){setBusy(true);try{await fn();await refresh();setError("");}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
 async function readBody(bid:string,side:"request"|"response",append=false){try{const value=await api.findingTrafficBody(id,bid,side,append?body?.next??0:0,contextTask);setBody({bid,side,content:(append?body?.content??"":"")+value.content,next:value.next_offset,total:value.total});}catch(e){toast.error((e as Error).message);}}
 return <>
  {error&&<Alert><AlertDescription>{error}</AlertDescription></Alert>}
  <Card><CardHeader><CardTitle>流量证据</CardTitle><CardDescription>绑定的请求和响应独立保存，删除流量索引后仍可查看。</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">
   {evidence?.bindings.map(binding=><div key={binding.id} className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{binding.role}</Badge><span className="min-w-0 flex-1 truncate">{binding.snapshot.method} {binding.snapshot.url}</span><Button variant="outline" size="sm" onClick={()=>void readBody(binding.id,"request")}>请求正文</Button><Button variant="outline" size="sm" onClick={()=>void readBody(binding.id,"response")}>响应正文</Button>{!readOnly&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void act(()=>api.removeFindingTraffic(id,binding.id,evidence.version,contextTask))}>解绑</Button>}</div>)}
   {evidence&&!evidence.bindings.length&&<p className="text-muted-foreground text-sm">尚未绑定流量证据。</p>}
   {!readOnly&&<FieldGroup><Field><FieldLabel>本任务流量</FieldLabel><div className="flex gap-2"><Select value={selected} onValueChange={setSelected}><SelectTrigger><SelectValue placeholder="选择已录制流量" /></SelectTrigger><SelectContent><SelectGroup>{traffic.map(t=><SelectItem key={t.id} value={t.id}>{t.method} {t.url}</SelectItem>)}</SelectGroup></SelectContent></Select><Button variant="outline" disabled={busy} onClick={()=>void act(async()=>{const result=await api.trafficForTask(finding.task_id??contextTask??"");setTraffic(result.exchanges??[]);})}>加载流量</Button><Button disabled={!selected||busy} onClick={()=>void act(()=>api.bindFindingTraffic(id,[{traffic_id:selected,role:"supporting"}],contextTask))}>绑定</Button></div></Field></FieldGroup>}
   {body&&<div className="flex flex-col gap-2"><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{body.content}</pre>{body.next<body.total&&<Button variant="outline" onClick={()=>void readBody(body.bid,body.side,true)}>继续读取</Button>}<Button variant="ghost" onClick={()=>setBody(undefined)}>收起正文</Button></div>}
  </CardContent></Card>
  <>{retests.length>0&&<Card><CardHeader><CardTitle>历史复测记录</CardTitle><CardDescription>Retester 已移除；历史结论、证据和执行过程仅供读取。</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">
   {retests.map(r=><div key={r.id} className="flex flex-col gap-2"><div className="flex items-center gap-2"><Badge variant="secondary">{{pending:"排队中",running:"执行中",completed:"已完成",failed:"失败",stopped:"已停止"}[r.status]}</Badge>{r.verdict&&<Badge variant="outline">{{reproduced:"仍可复现",fixed:"已修复",inconclusive:"证据不足"}[r.verdict]}</Badge>}{r.conversation_id&&<Button variant="ghost" size="sm" onClick={()=>setProcess(r.conversation_id!)}>查看过程</Button>}</div><Markdown text={r.summary||r.error||r.notes} />{r.evidence&&<Markdown text={r.evidence} />}</div>)}
   {process&&<div className="flex flex-col gap-2"><ConversationProcess key={process} id={process} /><Button variant="ghost" onClick={()=>setProcess(undefined)}>收起过程</Button></div>}
  </CardContent></Card>}</>
 </>;
}

function ConversationProcess({id}:{id:number}){
 const conversation=useConversationActivity(id);
 return <div className="flex h-[480px] min-h-0 flex-col">
  <MessageScrollerProvider autoScroll><MessageScroller><MessageScrollerViewport preserveScrollOnPrepend><MessageScrollerContent className="gap-3 p-2">
   {conversation.hasMore&&<Button variant="ghost" onClick={event=>void conversation.loadEarlier(event.currentTarget.closest<HTMLElement>('[data-slot="message-scroller-viewport"]'))}>加载更早记录</Button>}
   <Transcript conversationId={id} activity={conversation.items} live={conversation.running} scrollItems fetchDetail={seq=>api.conversationMsgDetail(id,seq)}/>
  </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton/></MessageScroller></MessageScrollerProvider>
  {!conversation.connected&&!conversation.loading&&<p role="status" className="text-xs text-muted-foreground">实时连接恢复中，已有内容已保留</p>}
  {conversation.error&&<p role="alert" className="text-destructive">{conversation.error}</p>}
 </div>;
}
