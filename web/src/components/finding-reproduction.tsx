"use client";
import * as React from "react";
import {toast} from "sonner";
import {http} from "@/lib/api";
import type {Finding,FindingReproduction,FindingReproductionDetail,FindingStepImage} from "@/lib/types";
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from "@/components/ui/card";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
import {Alert,AlertDescription} from "@/components/ui/alert";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {Field,FieldGroup,FieldLabel} from "@/components/ui/field";
import {Markdown} from "@/components/markdown";

export function FindingReproductionPanel({finding,contextTask,readOnly,onChanged}:{finding:Finding;contextTask?:string;readOnly:boolean;onChanged:()=>void}){
 const base=`/exploration/findings/${finding.finding_id}`,q=contextTask?`?context_task=${encodeURIComponent(contextTask)}`:"";
 const [data,setData]=React.useState<FindingReproductionDetail>(),[error,setError]=React.useState("");
 const [busy,setBusy]=React.useState(false),[editing,setEditing]=React.useState(false);
 const [draft,setDraft]=React.useState<FindingReproduction>(),[description,setDescription]=React.useState(""),[impact,setImpact]=React.useState(""),[remediation,setRemediation]=React.useState("");
 const load=React.useCallback(async()=>{const value=await http<FindingReproductionDetail>(base+"/reproduction"+q);setData(value);return value;},[base,q]);
 React.useEffect(()=>{let active=true;http<FindingReproductionDetail>(base+"/reproduction"+q).then(v=>{if(active)setData(v);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[base,q,finding.report_evidence_version,finding.evidence_version]);
 const running=data?.job?.status==="running"||data?.job?.status==="queued";
 React.useEffect(()=>{if(!running)return;let active=true;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const v=await http<FindingReproductionDetail>(base+"/reproduction"+q);if(active){setData(v);if(v.job?.status==="running"||v.job?.status==="queued")timer=setTimeout(poll,1500);else onChanged();}}catch(e){if(active)setError((e as Error).message);}};timer=setTimeout(poll,1500);return()=>{active=false;clearTimeout(timer);};},[running,base,q,onChanged]);
 async function act(fn:()=>Promise<unknown>){setBusy(true);try{await fn();await load();setError("");onChanged();}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
 async function upload(file:File,step?:string){await act(async()=>{const form=new FormData();form.set("file",file);const url=`/api${base}/images${q}${step?`${q?"&":"?"}step_id=${encodeURIComponent(step)}`:""}`;const r=await fetch(url,{method:"POST",headers:{"X-Series-Token":localStorage.getItem("series_token")??""},body:form});if(!r.ok)throw new Error((await r.json()).error??"图片上传失败");});}
 const [source,setSource]=React.useState<{id:string;content:string;next_offset:number;total:number}>();
 async function readSource(id:string,append=false){await act(async()=>{const value=await http<{content:string;next_offset:number;total:number}>(base+`/steps/${encodeURIComponent(id)}/source${q}${q?"&":"?"}offset=${append?source?.next_offset??0:0}`);setSource({id,...value,content:(append?source?.content??"":"")+value.content});});}
 const repro=data?.reproduction;
 const jobStatus=data?.job?.status;
 return <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>分步骤漏洞报告</CardTitle>{!readOnly&&<div className="flex gap-2"><Button variant="outline" disabled={busy||running} onClick={()=>void act(()=>http(base+"/analyze"+q,{method:"POST"}))}>重新分析</Button><Button variant="outline" disabled={busy||running||!data} onClick={()=>{setDraft(structuredClone(repro??{entry_point:"",prerequisites:[],steps:[],provenance:""}));setDescription(data?.report_sections?.description??finding.summary);setImpact(data?.report_sections?.impact.join("\n")??"");setRemediation(data?.report_sections?.remediation.join("\n")??"");setEditing(true);}}>编辑过程与说明</Button></div>}</div><CardDescription>每一步说明操作、实际结果和证明内容，报文与命令原文单独保留。</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-4">
 {error&&<Alert><AlertDescription>{error}<Button variant="ghost" onClick={()=>void act(load)}>重试</Button></AlertDescription></Alert>}
 {data?.job&&<Alert><AlertDescription>{({queued:"排队等待 Reporter",running:"Reporter 正在读取证据、整理报告并保存",completed:"本次整理已结束",failed:"报告整理失败，原报告仍保留",stopped:"报告整理已停止"} as Record<string,string>)[jobStatus??""]??"正在准备报告"}{data.job.error&&`：${data.job.error}`}</AlertDescription></Alert>}
 {editing&&draft&&<FieldGroup><Field><FieldLabel>漏洞说明</FieldLabel><Textarea value={description} onChange={e=>setDescription(e.target.value)}/></Field><Field><FieldLabel>入口</FieldLabel><Input value={draft.entry_point} onChange={e=>setDraft({...draft,entry_point:e.target.value})}/></Field><Field><FieldLabel>前置条件（每行一项）</FieldLabel><Textarea value={draft.prerequisites.join("\n")} onChange={e=>setDraft({...draft,prerequisites:e.target.value.split("\n")})}/></Field>
 {draft.steps.map((step,i)=><FieldGroup key={step.id}><Badge variant="secondary">步骤 {i+1}</Badge>{([['action','做了什么'],['expected','实际结果说明'],['proves','证明什么'],['traffic_id','关联真实流量 ID']] as const).map(([key,label])=><Field key={key}><FieldLabel>{label}</FieldLabel><Textarea value={step[key]??""} onChange={e=>setDraft({...draft,steps:draft.steps.map(s=>s.id===step.id?{...s,[key]:e.target.value}:s)})}/></Field>)}<div className="flex gap-2"><Button variant="outline" disabled={i===0} onClick={()=>{const steps=[...draft.steps];[steps[i-1],steps[i]]=[steps[i]!,steps[i-1]!];setDraft({...draft,steps});}}>上移步骤</Button><Button variant="outline" onClick={()=>setDraft({...draft,steps:draft.steps.filter(s=>s.id!==step.id)})}>删除步骤</Button></div></FieldGroup>)}
 <Field><FieldLabel>具体影响（每行一项）</FieldLabel><Textarea value={impact} onChange={e=>setImpact(e.target.value)}/></Field><Field><FieldLabel>修复建议（每行一项）</FieldLabel><Textarea value={remediation} onChange={e=>setRemediation(e.target.value)}/></Field><div className="flex gap-2"><Button disabled={busy} onClick={()=>void act(async()=>{await http(base+"/reproduction"+q,{method:"PATCH",body:JSON.stringify({report_revision:data!.report_revision,evidence_version:data!.evidence_version,reproduction:draft,report_sections:{description,impact:impact.split("\n").filter(Boolean),remediation:remediation.split("\n").filter(Boolean)}})});setEditing(false);})}>保存</Button><Button variant="ghost" onClick={()=>setEditing(false)}>取消</Button></div></FieldGroup>}
 <Markdown text={data?.report_sections?.description??finding.summary}/>
 {repro?<><p>入口：{repro.entry_point||"未记录"}</p>{repro.prerequisites.length>0&&<ul className="list-inside list-disc">{repro.prerequisites.map((p,i)=><li key={i}>{p}</li>)}</ul>}
 {repro.steps.map((step,i)=><Card key={step.id}><CardHeader><CardTitle>步骤 {i+1} · {step.action||"验证"}</CardTitle><CardDescription>{step.expected}{step.expected&&step.proves?"；":""}{step.proves}</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-3">
 {!step.verified&&<Badge variant="outline">Worker 提交，待关联原始证据</Badge>}{step.truncated&&<Alert><AlertDescription>当前为关键片段，完整内容请查看证据来源。</AlertDescription></Alert>}
 <Packet label="请求 / 命令" value={step.request}/><Packet label="响应 / 输出" value={step.response}/>
 {step.traffic_id&&<Button asChild variant="outline"><a href={`/function/traffic?exchange=${encodeURIComponent(step.traffic_id)}`} target="_blank" rel="noreferrer">查看完整流量包</a></Button>}
 {(step.source||step.source_ref)&&<Button variant="outline" onClick={()=>void readSource(step.id)}>查看完整证据来源</Button>}
 {source?.id===step.id&&<div><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{source.content}</pre>{source.next_offset<source.total&&<Button variant="outline" onClick={()=>void readSource(step.id,true)}>继续读取</Button>}</div>}
 <Images images={data?.images.filter(im=>im.step_id===step.id)??[]} base={base} q={q} disabled={busy||readOnly} upload={f=>upload(f,step.id)} mutate={fn=>act(fn)}/>
 </CardContent></Card>)}{repro.provenance&&<p>发现来源：{repro.provenance}</p>}</>:<Alert><AlertDescription>尚未整理分步骤过程。原始证据完整保留，可选择重新分析；缺失材料不会补造成已验证步骤。</AlertDescription></Alert>}
 <Images images={data?.images.filter(im=>!im.step_id||!repro?.steps.some(s=>s.id===im.step_id))??[]} base={base} q={q} disabled={busy||readOnly} upload={upload} mutate={fn=>act(fn)}/>
 {data?.report_sections&&<><h3>具体影响</h3><ul className="list-inside list-disc">{data.report_sections.impact.map((s,i)=><li key={i}>{s}</li>)}</ul><h3>修复建议</h3><ul className="list-inside list-disc">{data.report_sections.remediation.map((s,i)=><li key={i}>{s}</li>)}</ul></>}
 {data?.versions.length? <details><summary>历史报告版本</summary>{data.versions.map(v=><Button key={v.revision} variant="link" onClick={()=>void act(async()=>{const value=await http<{report:string}>(base+`/report-versions/${v.revision}`+q);await navigator.clipboard.writeText(value.report);toast.success("历史版本已复制");})}>版本 {v.revision} · 证据 {v.evidence_version} · 复制原文</Button>)}</details>:null}
 </CardContent></Card>;
}
function Packet({label,value}:{label:string;value:string}){return <details open><summary>{label}{!value&&"（缺失）"}</summary>{value&&<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{value}</pre>}</details>;}
function Images({images,base,q,disabled,upload,mutate}:{images:FindingStepImage[];base:string;q:string;disabled:boolean;upload:(file:File)=>Promise<void>;mutate:(fn:()=>Promise<unknown>)=>Promise<void>}){
 return <div className="flex flex-col gap-2" onDragOver={e=>{if(!disabled)e.preventDefault();}} onDrop={e=>{if(disabled)return;e.preventDefault();const file=e.dataTransfer.files[0];if(file)void upload(file);}} onPaste={e=>{if(disabled)return;const file=Array.from(e.clipboardData.items).find(i=>i.type.startsWith("image/"))?.getAsFile();if(file){e.preventDefault();void upload(file);}}}>
 {images.map(image=><figure className="flex flex-col gap-2" key={image.id}><EvidenceImage src={`/api${base}/images/${image.id}${q}`} caption={image.caption}/><Input aria-label="证据图注" disabled={disabled} defaultValue={image.caption} onBlur={e=>{if(e.target.value!==image.caption)void mutate(()=>http(base+`/images/${image.id}`+q,{method:"PATCH",body:JSON.stringify({caption:e.target.value})}));}}/>{!disabled&&<div className="flex gap-2"><Button variant="ghost" onClick={()=>void mutate(()=>http(base+`/images/${image.id}`+q,{method:"DELETE"}))}>删除截图</Button><Button variant="ghost" onClick={()=>void mutate(()=>http(base+`/images/${image.id}`+q,{method:"PATCH",body:JSON.stringify({position:Math.max(0,image.position-1)})}))}>前移截图</Button></div>}</figure>)}
 {!disabled&&<Field><FieldLabel>粘贴、拖拽或选择证据截图</FieldLabel><Input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value="";}}/></Field>}
 </div>;
}
function EvidenceImage({src,caption}:{src:string;caption:string}){
 const [url,setURL]=React.useState("");React.useEffect(()=>{const controller=new AbortController();let object="";fetch(src,{headers:{"X-Series-Token":localStorage.getItem("series_token")??""},signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error("图片不可用");return r.blob();}).then(blob=>{if(controller.signal.aborted)return;object=URL.createObjectURL(blob);setURL(object);}).catch(()=>{});return()=>{controller.abort();if(object)URL.revokeObjectURL(object);};},[src]);
 return url?<img className="max-h-96 max-w-full self-start object-contain" src={url} alt={caption||"漏洞证据截图"}/>:<p>截图加载中或不可用</p>;
}
