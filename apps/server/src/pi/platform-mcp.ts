import {createMcpExtension,createToolSearchExtension,type ExtensionAPI,type ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {createServerTransport} from './mcpTransport.js';
import type {AgentRunnerOptions} from './runner.js';

export const MCP_RESOURCE_TOOLS=['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'];
export const TOOL_SEARCH_HINT=' 未出现在本轮工具声明中的能力，必须先用此工具按精确英文工具名或关键词检索，成功加载后再调用；仅在提示词中出现不代表已激活。只有获授权的工具会被加载。';

/** Stable per-session instructions for custom system prompts, which bypass pi's
 * default tool guidance. Names come only from the permitted registration set. */
export function toolDiscoveryInstructions(opts:Pick<AgentRunnerOptions,'toolLoading'|'mcpEntries'>){
  if(!opts.toolLoading?.deferred.length&&!hasDeferredMcp(opts))return '';
  const names=[...opts.toolLoading?.deferred??[]].sort();
  return '\n<tool_loading>\n以本轮工具声明为当前可调用集合；提示词、黑板或旧会话提及的工具名不代表已激活。未在声明中的能力先用 tool_search 的 query=精确英文工具名检索，成功加载后再调用，不直接试调用。禁用或撤销的能力不能恢复。'+(names.length?' 本会话获准的内部按需工具：'+names.join(', ')+'。':'')+'\n</tool_loading>';
}

export function hasDeferredMcp(opts:Pick<AgentRunnerOptions,'mcpEntries'>) {
  return opts.mcpEntries?.some(e=>e.config.exposure==='deferred'||Object.values(e.config.toolExposure??{}).includes('deferred'))??false;
}

/** Adapt native registration/discovery; pi retains connections, ranking, loading and tool execution. */
export function platformMcpExtension(opts:AgentRunnerOptions):ExtensionFactory {
  return async pi=>{
    const states=new Map<string,string>((opts.mcpEntries??[]).map(e=>[e.name,'connecting']));
    const owners=new Map<string,{server:string;tool:string}>();
    const native=createMcpExtension({
      createTransport:(entry,cwd,auth)=>{
        const transport=createServerTransport(entry.config as unknown as Record<string,unknown>,cwd,auth);
        const pending=new Map<string,string>(),send=transport.send.bind(transport),start=transport.start.bind(transport);
        states.set(entry.name,'connecting');
        transport.start=async()=>{try{await start();}catch(error){states.set(entry.name,'failed');throw error;}};
        transport.onError(()=>states.set(entry.name,'failed'));
        transport.onClose(()=>states.set(entry.name,'disconnected'));
        transport.onMessage(message=>{
          if(!('id' in message)||message.id==null)return;
          const method=pending.get(String(message.id));pending.delete(String(message.id));
          if(method==='tools/list')states.set(entry.name,'error' in message?'failed':'ready');
          if(method==='initialize'){
            if('error' in message)states.set(entry.name,'failed');
            else if('result' in message){
              const result=message.result as {capabilities?:{tools?:unknown}};
              // Resource-only MCP servers never send tools/list; initialization completes readiness.
              if(!result?.capabilities?.tools)states.set(entry.name,'ready');
            }
          }
        });
        transport.send=async(message,options)=>{
          if('method' in message){
            const m=message as {method:string;params?:{name?:string};id?:unknown};
            await opts.mcpGuard?.(entry.name,m.method,m.params?.name);
            if(m.id!=null)pending.set(String(m.id),m.method);
          }
          try{return await send(message,options);}catch(error){states.set(entry.name,'failed');throw error;}
        };
        return transport;
      },
      loadConfig:()=>({servers:(opts.mcpEntries??[]).map(e=>({name:e.name,config:e.config as never,source:'series-db',scope:'extension' as const})),errors:[]}),
    });
    await native(new Proxy(pi,{
      get(target,key){
        if(key==='on')return (event:string,handler:(...a:any[])=>unknown)=>{
          if(event==='tool_call')return target.on(event,((...a:any[])=>a[0].toolName==='tool_search'&&opts.toolLoading?.deferred.length?undefined:handler(...a)) as never);
          return target.on(event as never,handler as never);
        };
        if(key==='registerTool')return ((definition:Parameters<ExtensionAPI['registerTool']>[0])=>{
          const server=definition.namespace?.aliases?.[0];
          if(server&&definition.name.startsWith('mcp__')&&definition.label.startsWith(server+'/'))
            owners.set(definition.name,{server,tool:definition.label.slice(server.length+1)});
          target.registerTool(definition);
        });
        return Reflect.get(target,key);
      },
    }));
    pi.on('tool_call',async event=>{
      const owner=owners.get(event.toolName);
      if(owner)await opts.mcpGuard?.(owner.server,'tools/call',owner.tool);
    });
    if(!hasDeferredMcp(opts)&&!opts.toolLoading?.deferred.length)return;
    let permitted=new Set<string>();
    await createToolSearchExtension()(new Proxy(pi,{
      get(target,key){
        if(key==='getAllTools')return ()=>target.getAllTools().filter(t=>permitted.has(t.name));
        if(key==='registerTool')return ((definition:Parameters<ExtensionAPI['registerTool']>[0])=>{
          const execute=definition.execute;
          target.registerTool({...definition,description:definition.description+TOOL_SEARCH_HINT,
            execute:async(...args)=>{
              args[2]?.throwIfAborted();
              // The native MCP tool_call readiness hook has run before execute.
              const unavailable=[...states].filter(([,state])=>state!=='ready').map(([name])=>name);
              const query=String((args[1] as {query?:string}).query??'');
              if(!/[a-z0-9]/i.test(query))throw new Error('原生搜索暂不支持中文分词；请用英文工具名或关键词重试，例如 asset search、shell terminal、traffic。');
              const next=new Set<string>();
              for(const t of target.getAllTools()){
                const owner=owners.get(t.name);
                try{
                  if(owner){if(states.get(owner.server)!=='ready')continue;await opts.mcpGuard?.(owner.server,'tools/call',owner.tool);}
                  else await opts.discoveryGuard?.(t.name);
                  next.add(t.name);
                }catch{/* omit revoked bindings */}
              }
              permitted=next;
              // Loaded tools can outlive their binding in the transcript; remove current declarations too.
              target.setActiveTools(target.getActiveTools().filter(name=>next.has(name)));
              const result=await execute(...args);
              return unavailable.length?{...result,content:[...result.content,{type:'text' as const,text:`MCP 发现未完成（服务不可用或仍连接中）：${unavailable.join(', ')}。以上匹配仅涵盖当前可用工具，不能据此认定这些 MCP 没有工具；稍后重试。`}]}:result;
            },
          });
        });
        return Reflect.get(target,key);
      },
    }));
  };
}
