import {describe,it,expect,afterEach} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {AgentRunner,type AgentRunnerOptions} from './runner.js';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(transport:'stdio'|'http'|'sse',count=1,failList=false,resourceOnly=false){
  const cwd=mkdtempSync(path.join(tmpdir(),'fate-discovery-'));cleanups.push(async()=>rmSync(cwd,{recursive:true,force:true}));
  const calls:string[]=[],tools=[...Array.from({length:count},(_,i)=>({name:i?'extra_'+i:'allowed_echo',description:'LOCAL echo '+('metadata '.repeat(30)),inputSchema:{type:'object',properties:{text:{type:'string',description:'LOCAL text value'}},required:['text']}})),{name:'secret_echo',description:'never disclose',inputSchema:{type:'object'}}];
  let config:Record<string,unknown>;
  if(transport==='stdio'){
    const script=path.join(cwd,'fixture.cjs');
    writeFileSync(script,`const tools=${JSON.stringify(tools)};require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}};if(m.method==='tools/list')result={tools};if(m.method==='tools/call')result={content:[{type:'text',text:'LOCAL echo:'+m.params.arguments.text}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
    config={command:process.execPath,args:[script]};
  }else{
    let stream:http.ServerResponse|undefined;
    const server=http.createServer(async(req,res)=>{
      if(req.method==='DELETE'){res.writeHead(204).end();return;}
      if(req.method==='GET'){if(transport==='http'){res.writeHead(405).end();return;}stream=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: endpoint\ndata: /messages\n\n');return;}
      let text='';for await(const c of req)text+=c;const m=JSON.parse(text);
      if(m.id==null){res.writeHead(202).end();return;}
      let result:unknown={};
      if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:resourceOnly?{resources:{}}:{tools:{}},serverInfo:{name:'local',version:'1'}};
      if(m.method==='tools/list')result={tools};
      if(m.method==='tools/call'){calls.push(m.params.name);result={content:[{type:'text',text:'LOCAL echo:'+m.params.arguments.text}]};}
      const body=JSON.stringify({jsonrpc:'2.0',id:m.id,...(failList&&m.method==='tools/list'?{error:{code:-32000,message:'local unavailable'}}:{result})});
      if(transport==='sse'){stream!.write(`event: message\ndata: ${body}\n\n`);res.writeHead(202).end();}else res.writeHead(200,{'Content-Type':'application/json'}).end(body);
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    cleanups.push(async()=>{stream?.end();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
    config={transport,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`};
  }
  const faux=fauxProvider({provider:path.basename(cwd)}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
  const options:AgentRunnerOptions={cwd,agentDir:path.join(cwd,'pi'),modelRuntime,model:faux.getModel() as never,systemPrompt:'LOCAL fixture, no target access',toolAllowlist:['mcp__*'],inMemory:true,
    mcpEntries:[{name:'fixture',config:{...config,exposure:'deferred',toolExposure:{secret_echo:'hidden'}}}]};
  return {faux,options,calls,cwd};
}
describe('native deferred MCP',()=>{
  it('does not misreport a resource-only server as unavailable',async()=>{
    const f=await fixture('http',1,false,true);
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'list resources'})]),ctx=>{const text=JSON.stringify(ctx.messages);expect(text).not.toContain('MCP 发现未完成');expect(text).toContain('list_mcp_resources');return fauxAssistantMessage('done');}]);
    const runner=await AgentRunner.create(f.options);try{await runner.prompt('LOCAL resources');}finally{await runner.dispose();}
  });

  it.each(['stdio','http','sse'] as const)('%s discovers and invokes only authorized tools',async transport=>{
    const f=await fixture(transport);
    f.faux.setResponses([ctx=>{expect(JSON.stringify(ctx.messages)).not.toContain('mcp__fixture__allowed_echo');return fauxAssistantMessage([fauxToolCall('tool_search',{query:'allowed_echo'})]);},
      ctx=>{const s=JSON.stringify(ctx.messages);expect(s).toContain('mcp__fixture__allowed_echo');expect(s).not.toContain('secret_echo');return fauxAssistantMessage([fauxToolCall('mcp__fixture__allowed_echo',{text:'ok'})]);},
      ctx=>{expect(JSON.stringify(ctx.messages)).toContain('LOCAL echo:ok');return fauxAssistantMessage('done');}]);
    const runner=await AgentRunner.create(f.options);try{await runner.prompt('LOCAL echo requested');expect(f.faux.state.callCount).toBe(3);}finally{await runner.dispose();}
  });
  it('rejects revoked calls after discovery and after session recovery',async()=>{
    const f=await fixture('http');let allowed=true;
    f.options.inMemory=false;f.options.resumeSessionPath=path.join(f.cwd,'recovery.jsonl');
    f.options.mcpGuard=async(_s,method)=>{if(method==='tools/call'&&!allowed)throw new Error('LOCAL revoked');};
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'allowed_echo'})]),()=>{allowed=false;return fauxAssistantMessage([fauxToolCall('mcp__fixture__allowed_echo',{text:'denied'})]);},fauxAssistantMessage('stopped')]);
    let runner=await AgentRunner.create(f.options);try{await runner.prompt('LOCAL');expect(f.calls).toEqual([]);}finally{await runner.dispose();}
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'allowed_echo'})]),ctx=>{const messages=ctx.messages as unknown as {role:string;content:unknown}[];const latest=messages.filter(m=>m.role==='toolResult').at(-1);expect(JSON.stringify(latest)).not.toContain('mcp__fixture__allowed_echo');return fauxAssistantMessage('revoked');}]);
    runner=await AgentRunner.create(f.options);try{await runner.prompt('LOCAL resume');expect(f.calls).toEqual([]);}finally{await runner.dispose();}
  });
  it('reports unavailable servers instead of successful empty search',async()=>{
    const f=await fixture('http',1,true);
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'allowed_echo'})]),ctx=>{expect(JSON.stringify(ctx.messages)).toContain('MCP 发现未完成');return fauxAssistantMessage('blocked');}]);
    const runner=await AgentRunner.create(f.options);try{await runner.prompt('LOCAL');expect(f.calls).toEqual([]);}finally{await runner.dispose();}
  });
  it('reduces first-request schemas for large servers and records the discovery request cost separately',async()=>{
    const sizes:Record<string,number[]>={direct:[],deferred:[]};
    for(const mode of ['direct','deferred'] as const){
      const f=await fixture('http',60);f.options.mcpEntries![0]!.config.exposure=mode;
      const save=(ctx:{messages:unknown})=>{sizes[mode]!.push(Buffer.byteLength(JSON.stringify(ctx.messages)));};
      f.faux.setResponses(mode==='direct'?[ctx=>{save(ctx);return fauxAssistantMessage('done');}]:[
        ctx=>{save(ctx);return fauxAssistantMessage([fauxToolCall('tool_search',{query:'allowed_echo',limit:1})]);},ctx=>{save(ctx);return fauxAssistantMessage('done');}]);
      const runner=await AgentRunner.create(f.options);try{await runner.prompt('LOCAL cost fixture');}finally{await runner.dispose();}
    }
    expect(sizes.deferred![0]!).toBeLessThan(sizes.direct![0]!*0.5);
    console.log('MCP_BUDGET',JSON.stringify(sizes));
  });
});
