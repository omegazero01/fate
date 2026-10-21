import {mkdir,chmod} from 'node:fs/promises';
import {Proxy} from 'http-mitm-proxy';
import type {IContext} from 'http-mitm-proxy/dist/lib/types.js';
import type {IncomingHttpHeaders} from 'node:http';
import path from 'node:path';
import type {Database} from '../db/index.js';
import {authorizeTaskRequest} from './gateway.js';
import {parseAndVerify} from './credentials.js';
import {recordExchange} from '../evidence/store.js';
import type {EgressGateway} from './index.js';
import {TARGET_TLS_OPTIONS} from '../evidence/target-transport.js';
const CAP=8*1024*1024;
function clean(headers:IncomingHttpHeaders){
 const result={...headers};
 for(const name of ['proxy-authorization','proxy-authenticate','proxy-connection'])delete result[name];
 return result;
}
function headerText(headers:IncomingHttpHeaders){return Object.entries(clean(headers)).map(([k,v])=>`${k}: ${v}`).join('\r\n');}
export async function startRecordingGateway(db:Database,host:string,port:number,dataDir:string):Promise<EgressGateway>{
 const proxy=new Proxy(),caDir=path.join(dataDir,'proxy-ca');
 await mkdir(caDir,{recursive:true,mode:0o700});await chmod(caDir,0o700);
 const pending=new Set<Promise<unknown>>();
 proxy.onError((_ctx,_error)=>{}); // Never log request headers or proxy credentials.
 proxy.onConnect((req,socket,_head,callback)=>{
  void (async()=>{
   const scope=parseAndVerify(req.headers['proxy-authorization']);
   const target=new URL(`https://${req.url}`);
   if(scope.tagged)await authorizeTaskRequest(db,scope.taskID,target.hostname,Number(target.port)||443,scope.scope);
   callback();
  })().catch(()=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n目标未获授权'));
 });
 proxy.onRequest((ctx,callback)=>{
  void (async()=>{
   const req=ctx.clientToProxyRequest;
   const scope=parseAndVerify(req.headers['proxy-authorization']??ctx.connectRequest?.headers['proxy-authorization']);
   const url=new URL(req.url??'/',`${ctx.isSSL?'https':'http'}://${req.headers.host}`);
   if(!['http:','https:'].includes(url.protocol))throw new Error('unsupported protocol');
   if(scope.tagged)await authorizeTaskRequest(db,scope.taskID,url.hostname,Number(url.port)||(url.protocol==='https:'?443:80),scope.scope);
   if(ctx.proxyToServerRequestOptions){
    Object.assign(ctx.proxyToServerRequestOptions,TARGET_TLS_OPTIONS);
    ctx.proxyToServerRequestOptions.headers=Object.fromEntries(Object.entries(clean(req.headers)).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):String(v)]));
   }
   // Only tagged traffic has a trustworthy task attribution. Read recording switch per request.
   if(scope.tagged&&await db.platform().getSetting('traffic_capture')!=='false'){
    const request:Buffer[]=[],response:Buffer[]=[];let reqLength=0,respLength=0,truncated=false;
    const collect=(parts:Buffer[],chunk:Buffer,size:number)=>{const left=Math.max(0,CAP-size);if(chunk.length>left)truncated=true;if(left)parts.push(Buffer.from(chunk.subarray(0,left)));};
    ctx.onRequestData((_c,chunk,next)=>{collect(request,chunk,reqLength);reqLength+=chunk.length;next(null,chunk);});
    ctx.onResponseData((_c,chunk,next)=>{collect(response,chunk,respLength);respLength+=chunk.length;next(null,chunk);});
    ctx.onResponseEnd((c:IContext,next)=>{
     const intent=/^worker:(\d+)(?::.+)?$/.exec(scope.scope);
     const work=(async()=>{
      // Retest/chat proxy scopes deliberately carry no exploration intent ID.
      const intentID=intent?Number(intent[1]):undefined;
      await recordExchange(db,{taskID:scope.taskID,intentID,url:url.toString(),method:req.method??'GET',status:c.serverToProxyResponse?.statusCode??0,
       reqHead:`${req.method??'GET'} ${url.pathname}${url.search}\r\n${headerText(req.headers)}`,respHead:headerText(c.serverToProxyResponse?.headers??{}),
       contentType:String(c.serverToProxyResponse?.headers['content-type']??''),request:Buffer.concat(request),response:Buffer.concat(response),truncated});
     })();
     pending.add(work);void work.catch(()=>{}).finally(()=>pending.delete(work));
     void work.then(()=>next()).catch(()=>next(new Error('流量证据保存失败')));
    });
   }
   callback();
  })().catch(()=>{ctx.proxyToClientResponse.writeHead(403,{'content-type':'text/plain; charset=utf-8'});ctx.proxyToClientResponse.end('请求未获授权或无法记录');});
 });
 await new Promise<void>((resolve,reject)=>proxy.listen({host,port,sslCaDir:caDir,keepAlive:false,timeout:60000},e=>e?reject(e):resolve()));
 await chmod(path.join(caDir,'keys','ca.private.key'),0o600);
 const server=proxy.httpServer!;const address=server.address();
 const actualPort=typeof address==='object'&&address?address.port:port;
 const clientHost=host==='0.0.0.0'||host==='::'?'127.0.0.1':host;
 return {server,addr:`${clientHost}:${actualPort}`,caFile:path.join(caDir,'certs','ca.pem'),proxyURL:()=>`http://${clientHost}:${actualPort}/`,
  async close(){server.closeAllConnections();proxy.close();await Promise.allSettled([...pending]);}};
}
