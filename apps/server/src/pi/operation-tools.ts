import type {ExtensionAPI,ExtensionFactory,ToolDefinition} from '@earendil-works/pi-coding-agent';
import {WorkerOperationJournal} from '../db/operation-journal.js';
import type {ToolRunContext} from '../tools/context.js';
import {saveToolOutput} from '../evidence/tool-outputs.js';

/** Wrap execution only; native pi validation, guards, batches, messages and cancellation stay intact. */
export function journalTools(journal:WorkerOperationJournal,ctx:ToolRunContext,effectful:ReadonlySet<string>){
  return (tool:ToolDefinition):ToolDefinition=>{
    if(['shell_read','shell_close'].includes(tool.name))return {...tool,async execute(...args){
      const result=await tool.execute(...args);await journal.observeTerminal(result);return result;
    }};
    if(!effectful.has(tool.name)&&!tool.name.startsWith('mcp__'))return tool;
    return {...tool,async execute(...args){
      args[2]?.throwIfAborted();
      const receipt=await journal.begin(tool.name,args[0],args[1]);
      if(receipt.replay!==undefined){
        const original=receipt.replay as Awaited<ReturnType<ToolDefinition['execute']>>;
        if(['shell_open','shell_send'].includes(tool.name))return {isError:true,content:[{type:'text',text:`operation:${receipt.id} 已有返回，但原终端句柄随旧执行器退出而失效；未重新执行命令。通过 context_get 读取历史输出，不可沿用旧 session_id。`}],details:undefined};
        return {...original,content:[{type:'text',text:`【复用 operation:${receipt.id} 的已保存返回；本次没有执行工具，不代表外部当前状态已重新验证】`},...original.content]};
      }
      try{
        const result=await tool.execute(...args);
        const raw=JSON.stringify(result);
        const saved=Buffer.byteLength(raw)>64*1024
          ? {...result,content:[{type:'text',text:JSON.stringify(await saveToolOutput(ctx.db,ctx,tool.name,args[0],raw))}],details:undefined}
          :result;
        await journal.finish(receipt.id,saved,result.isError===true);
        return result;
      }catch(error){
        await journal.uncertain(receipt.id);
        throw error;
      }
    }};
  };
}

/** Also covers dynamically registered MCP tools and native interactive shell tools. */
export function wrapRegisteredTools(factory:ExtensionFactory,wrap:(tool:ToolDefinition)=>ToolDefinition):ExtensionFactory{
  return pi=>factory(new Proxy(pi,{get(target,key){
    if(key==='registerTool')return (tool:Parameters<ExtensionAPI['registerTool']>[0])=>target.registerTool(wrap(tool as ToolDefinition) as Parameters<ExtensionAPI['registerTool']>[0]);
    return Reflect.get(target,key);
  }}));
}

/** The default-loadout SDK mode restores native declarations; registration still obeys the host allowlist. */
export function restrictRegisteredTools(factory:ExtensionFactory,permitted:(name:string)=>boolean):ExtensionFactory{
 return pi=>factory(new Proxy(pi,{get(target,key){
  if(key==='registerTool')return (tool:Parameters<ExtensionAPI['registerTool']>[0])=>{if(permitted(tool.name))target.registerTool(tool);};
  return Reflect.get(target,key);
 }}));
}
