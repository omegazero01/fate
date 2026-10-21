import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime,defineTool} from '@earendil-works/pi-coding-agent';
import {AgentRunner} from './runner.js';
import {toolLoadout,compactToolSchema} from '../agent/tool-loading.js';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
async function fixture(){const cwd=mkdtempSync(path.join(tmpdir(),'fate-internal-search-'));dirs.push(cwd);const faux=fauxProvider({provider:path.basename(cwd)}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);let reads=0,writes=0;
 const customTools=[defineTool({name:'asset_get',label:'asset_get',description:'Read asset details',parameters:{type:'object',properties:{}} as never,async execute(){reads++;return {content:[{type:'text',text:'LOCAL asset'}],details:undefined};}}),defineTool({name:'record_fact',label:'record_fact',description:'Save a fact',parameters:{type:'object',properties:{}} as never,async execute(){writes++;return {content:[{type:'text',text:'SAVED'}],details:undefined};}})];
 const opts={cwd,agentDir:path.join(cwd,'agent'),modelRuntime,model:faux.getModel() as never,systemPrompt:'LOCAL fixture',resumeSessionPath:path.join(cwd,'session.jsonl'),...toolLoadout('worker',{customTools,toolAllowlist:['asset_get','record_fact']})};return {opts,faux,counts:()=>({reads,writes})};}
it('keeps writeback active, discovers internally without MCP, and restores the native loaded set without replay',async()=>{
 const f=await fixture();let r=await AgentRunner.create(f.opts);expect(r.activeToolNames).toContain('record_fact');expect(r.activeToolNames).not.toContain('asset_get');expect(r.activeToolNames).not.toContain('bash');
 f.faux.setResponses([fauxAssistantMessage([fauxToolCall('record_fact',{}),fauxToolCall('tool_search',{query:'asset details'})]),fauxAssistantMessage([fauxToolCall('asset_get',{})]),fauxAssistantMessage('done')]);await r.prompt('LOCAL');expect(f.counts()).toEqual({reads:1,writes:1});await r.dispose();
 r=await AgentRunner.create(f.opts);try{expect(r.activeToolNames).toContain('asset_get');expect(r.activeToolNames).not.toContain('bash');f.faux.setResponses([fauxAssistantMessage('resumed')]);await r.prompt('resume');expect(f.counts()).toEqual({reads:1,writes:1});}finally{await r.dispose();}
});
it('excludes revoked registrations on recovery and gives a Chinese search retry hint',async()=>{
 const f=await fixture();let r=await AgentRunner.create(f.opts);f.faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'asset'})]),fauxAssistantMessage('done')]);await r.prompt('LOCAL');await r.dispose();
 r=await AgentRunner.create({...f.opts,customTools:f.opts.customTools.filter(t=>t.name!=='asset_get'),toolAllowlist:['record_fact']});
 try{expect(r.activeToolNames).not.toContain('asset_get');f.faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'资产详情'})]),ctx=>{expect(JSON.stringify(ctx.messages)).toContain('英文工具名');return fauxAssistantMessage('done');}]);await r.prompt('LOCAL');expect(f.counts().reads).toBe(0);}finally{await r.dispose();}
});
it('MCP outage cannot block native internal discovery or claim unavailable external tools do not exist',async()=>{
 const f=await fixture();const r=await AgentRunner.create({...f.opts,mcpEntries:[{name:'offline',config:{transport:'http',url:'http://127.0.0.1:1/mcp',exposure:'deferred'}}],toolAllowlist:[...f.opts.toolAllowlist,'mcp__*']});
 try{f.faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'asset'})]),ctx=>{expect(JSON.stringify(ctx.messages)).toContain('MCP 发现未完成');return fauxAssistantMessage([fauxToolCall('asset_get',{})]);},fauxAssistantMessage('done')]);await r.prompt('LOCAL');expect(f.counts().reads).toBe(1);}finally{await r.dispose();}
});
it('preserves explicit legacy references and direct fallback, removes duplicate asset schema only for new sessions',()=>{
 const def={name:'insert_assets',parameters:{type:'object',properties:{assets:{type:'array'},items:{type:'array'}},anyOf:[{required:['assets']},{required:['items']}]}} as never;
 expect(compactToolSchema(def).parameters).toEqual({type:'object',properties:{assets:{type:'array'}},required:['assets']});
 const options={toolAllowlist:['read_tool_output','context_get','asset_get'],customTools:[]};
 expect(toolLoadout('worker',options).toolAllowlist).not.toContain('read_tool_output');
 expect(toolLoadout('worker',options,{referenced:['read_tool_output']}).toolLoading.compatibility).toEqual(['read_tool_output']);
 expect(toolLoadout('worker',options,{direct:true}).toolLoading.deferred).toEqual([]);
 expect(toolLoadout('worker',options,{legacy:true}).toolAllowlist).toContain('read_tool_output');
});
it.each(['record_fact','tool_search'])('restores current resident %s missing from the previous loadout',async missing=>{
 const f=await fixture();
 const oldTools=f.opts.customTools.filter(t=>missing==='record_fact'?t.name!=='record_fact':t.name!=='asset_get');
 let r=await AgentRunner.create({...f.opts,...toolLoadout('worker',{customTools:oldTools,toolAllowlist:oldTools.map(t=>t.name)})});
 try{f.faux.setResponses([fauxAssistantMessage('old session settled')]);await r.prompt('LOCAL old loadout');}finally{await r.dispose();}
 r=await AgentRunner.create(f.opts);
 try{
  expect(r.activeToolNames).toContain(missing);
  expect(r.activeToolNames).not.toContain('asset_get');
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('record_fact',{}),fauxToolCall('tool_search',{query:'asset details'})]),fauxAssistantMessage([fauxToolCall('asset_get',{})]),fauxAssistantMessage('done')]);
  await r.prompt('LOCAL resume');expect(f.counts()).toEqual({reads:1,writes:1});
 }finally{await r.dispose();}
});
