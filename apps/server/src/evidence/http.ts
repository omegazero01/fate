import type {ToolRunContext} from '../tools/context.js';
import {recordExchange} from './store.js';
import {targetFetch,targetErrorCode} from './target-transport.js';
import {ToolResultError} from '../tools/errors.js';
export interface EvidenceRequestInput {url:string;method?:string;headers?:Record<string,string>;body?:string;follow_redirects?:boolean;}
export async function evidenceRequest(ctx:ToolRunContext,input:EvidenceRequestInput,signal?:AbortSignal,check?:(input:Record<string,unknown>)=>Promise<void>){
 let url=input.url,method=input.method??'GET',body=input.body;
 const headers={...input.headers};
 const trafficIDs:string[]=[];
 let lastResponse:{status:number;traffic_id:string;origin:string}|undefined;
 for(let redirect=0;redirect<6;redirect++){
  signal?.throwIfAborted();
  const target=new URL(url);if(!['http:','https:'].includes(target.protocol))throw new Error('仅支持 HTTP/HTTPS');
  const host=target.hostname.replace(/^\[|\]$/g,''),port=Number(target.port)||(target.protocol==='https:'?443:80);
  if(ctx.networkTargets!==undefined&&!ctx.networkTargets.some(t=>t.host.replace(/^\[|\]$/g,'')===host.toLowerCase()&&(t.port===null||t.port===port)))throw new Error('请求或重定向超出本次定向复测范围');
  await ctx.hooks.assertOwnership?.(ctx.db);
  await check?.({url,method,body});
  let response:Awaited<ReturnType<typeof targetFetch>>|undefined;
  const chunks:Buffer[]=[];let length=0,truncated=false;
  try {
   response=await targetFetch(url,{method,headers,body,signal,redirect:'manual'});
   const reader=response.body?.getReader();
   try{while(reader){const next=await reader.read();if(next.done)break;const remaining=8*1024*1024-length;if(next.value.length>remaining){chunks.push(Buffer.from(next.value.subarray(0,remaining)));truncated=true;break;}chunks.push(Buffer.from(next.value));length+=next.value.length;}}finally{await reader?.cancel().catch(()=>{});}
  } catch(error) {
   // Keep pause/ownership cancellation distinct from network failure. Never replay a request here.
   if(signal?.aborted && !(signal.reason instanceof Error && signal.reason.name==='TimeoutError'))signal.throwIfAborted();
   const code=targetErrorCode(error),phase=response?'response_body':'request';
   const prior=lastResponse?`此前已收到 HTTP ${lastResponse.status}，${trafficIDs.length} 条流量已保存；`:'当前跳尚未保存完整响应；';
   throw new ToolResultError(`目标 HTTP 第 ${redirect+1} 跳（${target.origin}，端口 ${port}）${response?'读取响应正文':'请求'}失败 (${code})；${prior}这是传输错误，不能据此认定原始目标不存在或端口关闭`,{
    error_code:code,failure_phase:phase,request_hop:redirect+1,failed_origin:target.origin,failed_port:port,
    redirect_traffic_ids:[...trafficIDs],...(lastResponse?{last_response:lastResponse}:{}),
    ...(response?{response_status:response.status}:{}),
   },{cause:error});
  }
  const bytes=Buffer.concat(chunks);
  const trafficID=await ctx.db.transaction(async tx=>{await ctx.hooks.assertOwnership?.(tx);return recordExchange(tx,{taskID:ctx.taskID,intentID:ctx.intentID,url,method,status:response.status,contentType:response.headers.get('content-type')??'',request:Buffer.from(body??''),response:bytes,truncated,
   reqHead:`${method} ${url} HTTP/1.1\r\n`+Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join('\r\n'),respHead:`HTTP/1.1 ${response.status}\r\n`+[...response.headers].map(([k,v])=>`${k}: ${v}`).join('\r\n')});});
  trafficIDs.push(trafficID);
  lastResponse={status:response.status,traffic_id:trafficID,origin:target.origin};
  const location=response.headers.get('location');
  if(input.follow_redirects!==false&&[301,302,303,307,308].includes(response.status)&&location){
   const next=new URL(location,url);if(next.origin!==target.origin)for(const key of Object.keys(headers))if(['authorization','cookie','proxy-authorization'].includes(key.toLowerCase()))delete headers[key];
   if(response.status===303||([301,302].includes(response.status)&&method==='POST')){method='GET';body=undefined;}
   url=next.href;continue;
  }
  return {status:response.status,traffic_id:trafficID,redirect_traffic_ids:trafficIDs.slice(0,-1),...(location?{redirect_location:location}:{}),body:bytes.toString('utf8').slice(0,16000),total_bytes:bytes.length,truncated:truncated||bytes.length>16000,stored_body_truncated:truncated};
 }
 throw new Error('HTTP 重定向次数超限');
}
