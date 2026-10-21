import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import * as pty from 'node-pty';
import {defineTool,type ExtensionFactory} from '@earendil-works/pi-coding-agent';

export const TERMINAL_TOOLS=['shell_open','shell_send','shell_read','shell_close','shell_list'];
const BUFFER_BYTES=256*1024;
const KEYS:Record<string,string>={enter:'\r',return:'\r',tab:'\t',escape:'\x1b',backspace:'\x7f',up:'\x1b[A',down:'\x1b[B',right:'\x1b[C',left:'\x1b[D','ctrl-c':'\x03','ctrl-d':'\x04','ctrl-z':'\x1a','ctrl-l':'\x0c','ctrl-a':'\x01','ctrl-e':'\x05','ctrl-u':'\x15'};
interface Terminal {
  id:string;process:pty.IPty;buffer:string;start:number;cursor:number;lastData:number;lastUse:number;
  exitCode?:number;exitSignal?:number;closed:boolean;done:Promise<void>;
}
interface ReadArgs {session_id:string;since_cursor?:number;max_lines?:number;max_bytes?:number;wait?:boolean;timeout_ms?:number;quiet_ms?:number;}
/** A runner owns this manager. Handles never survive a session execution or pause. */
export class TerminalSessions {
  private sessions=new Map<string,Terminal>();
  private closed=false;
  private cleanup?:Promise<void>;
  private timer:ReturnType<typeof setInterval>;
  private controller=new AbortController();
  constructor(private cwd:string,private env:Record<string,string>,private signal?:AbortSignal){
    this.timer=setInterval(()=>{for(const t of this.sessions.values())if(Date.now()-t.lastUse>(t.closed?300_000:1800_000)){void this.close(t.id);this.sessions.delete(t.id);}},60_000);this.timer.unref();
    signal?.addEventListener('abort',this.onAbort,{once:true});
    if(signal?.aborted)void this.shutdown();
  }
  private onAbort=()=>{void this.shutdown();};
  private owned(id:string){this.signal?.throwIfAborted();if(this.closed)throw new Error('终端会话已结束');const t=this.sessions.get(id);if(!t)throw new Error('终端句柄不存在或属于旧执行会话');t.lastUse=Date.now();return t;}
  async open(args:{command?:string;mode?:string;rows?:number;cols?:number;timeout_ms?:number;quiet_ms?:number},signal?:AbortSignal){
    this.signal?.throwIfAborted();signal?.throwIfAborted();
    if(this.closed)throw new Error('终端会话已结束');
    if([...this.sessions.values()].filter(t=>!t.closed).length>=8)throw new Error('当前会话最多 8 个终端');
    const shell=process.env.SHELL||'/bin/sh';
    const child=pty.spawn(shell,args.command?['-lc',args.command]:['-l'],{cwd:this.cwd,env:this.env,name:'xterm-256color',rows:Math.min(200,Math.max(1,args.rows??24)),cols:Math.min(500,Math.max(1,args.cols??80))});
    let finish!:()=>void;
    const t:Terminal={id:randomUUID(),process:child,buffer:'',start:0,cursor:0,lastData:Date.now(),lastUse:Date.now(),closed:false,done:new Promise<void>(r=>{finish=r;})};
    this.sessions.set(t.id,t);
    child.onData(data=>{
      t.lastData=Date.now();t.buffer+=data;
      if(Buffer.byteLength(t.buffer)>BUFFER_BYTES){const chars=Array.from(t.buffer);let bytes=0,index=chars.length;while(index>0&&bytes+Buffer.byteLength(chars[index-1]!)<=BUFFER_BYTES)bytes+=Buffer.byteLength(chars[--index]!);t.buffer=chars.slice(index).join('');t.start+=index;}
    });
    child.onExit(e=>{t.closed=true;t.exitCode=e.exitCode;t.exitSignal=e.signal;finish();});
    if(args.mode==='interactive')await this.wait(t,args.timeout_ms??15000,args.quiet_ms??8000,signal);
    return this.read({session_id:t.id},signal);
  }
  private async wait(t:Terminal,timeout:number,quiet:number,signal?:AbortSignal){
    const combined=AbortSignal.any([this.controller.signal,...(this.signal?[this.signal]:[]),...(signal?[signal]:[])]);
    const end=Date.now()+Math.min(120_000,Math.max(0,timeout));
    while(!t.closed&&Date.now()<end&&Date.now()-t.lastData<Math.max(0,quiet))await delay(Math.min(50,Math.max(1,end-Date.now())),undefined,{signal:combined});
  }
  async send(args:ReadArgs&{text?:string;submit?:boolean;keys?:string[]},signal?:AbortSignal){
    const t=this.owned(args.session_id);signal?.throwIfAborted();if(t.closed)throw new Error('终端进程已退出');
    const keys=(args.keys??[]).map(key=>{const value=KEYS[key.toLowerCase()];if(value===undefined)throw new Error(`不支持控制键 ${key}`);return value;});
    const input=(args.text??'')+(args.submit?'\r':'')+keys.join('');
    if(Buffer.byteLength(input)>64*1024)throw new Error('输入超过 64 KiB');
    t.lastData=Date.now();t.process.write(input);
    if(args.wait!==false)await this.wait(t,args.timeout_ms??15000,args.quiet_ms??8000,signal);
    return this.read({...args,wait:false},signal);
  }
  async read(args:ReadArgs,signal?:AbortSignal){
    const t=this.owned(args.session_id);signal?.throwIfAborted();
    if(args.wait)await this.wait(t,args.timeout_ms??15000,args.quiet_ms??8000,signal);
    const requested=args.since_cursor??t.cursor,chars=Array.from(t.buffer),end=t.start+chars.length;
    if(!Number.isSafeInteger(requested)||requested<0||requested>end)throw new Error('无效终端游标');
    const start=Math.max(t.start,requested),maxBytes=Math.min(32768,Math.max(1,args.max_bytes??8192)),maxLines=Math.min(1000,Math.max(1,args.max_lines??200));
    let content='',bytes=0,lines=0,count=0;
    for(const char of chars.slice(start-t.start)){const length=Buffer.byteLength(char);if(bytes+length>maxBytes||lines>=maxLines)break;content+=char;bytes+=length;count++;if(char==='\n')lines++;}
    const cursor=start+count;if(args.since_cursor===undefined)t.cursor=cursor;
    return {session_id:t.id,output:content,cursor,next_cursor:cursor,buffer_start:t.start,truncated:requested<t.start,has_more:cursor<end,running:!t.closed,exit_code:t.exitCode,exit_signal:t.exitSignal};
  }
  list(){if(this.closed)return [];return [...this.sessions.values()].map(t=>({session_id:t.id,running:!t.closed,exit_code:t.exitCode,cursor:t.cursor}));}
  async close(id:string){
    const t=this.sessions.get(id);if(!t)return {session_id:id,closed:true};
    if(!t.closed){
      try{process.kill(-t.process.pid,'SIGTERM');}catch{try{t.process.kill();}catch{/* already exited */}}
      await Promise.race([t.done,delay(1000)]);
      if(!t.closed){try{process.kill(-t.process.pid,'SIGKILL');}catch{try{t.process.kill('SIGKILL');}catch{/* already exited */}}await t.done;}
    }
    return {session_id:id,closed:true,exit_code:t.exitCode};
  }
  shutdown(){
    if(this.cleanup)return this.cleanup;
    this.closed=true;this.controller.abort();clearInterval(this.timer);this.signal?.removeEventListener('abort',this.onAbort);
    this.cleanup=Promise.all([...this.sessions.keys()].map(id=>this.close(id))).then(()=>{this.sessions.clear();});return this.cleanup;
  }
}
export function terminalToolDefinitions(manager?:TerminalSessions){
  const readProperties={session_id:{type:'string'},since_cursor:{type:'integer',minimum:0},max_lines:{type:'integer',minimum:1,maximum:1000},max_bytes:{type:'integer',minimum:1,maximum:32768},wait:{type:'boolean'},timeout_ms:{type:'integer',minimum:0,maximum:120000},quiet_ms:{type:'integer',minimum:0,maximum:120000}};
  const definitions=[
   ['shell_open','打开当前执行会话的交互终端；普通命令使用 bash。句柄在本次执行结束或暂停时失效。',{command:{type:'string'},mode:{type:'string',enum:['handsfree','interactive']},rows:{type:'integer'},cols:{type:'integer'},timeout_ms:readProperties.timeout_ms,quiet_ms:readProperties.quiet_ms},[],(a:any,s?:AbortSignal)=>manager!.open(a,s)],
   ['shell_send','发送文本、回车或控制键到当前会话的终端；默认等待安静或退出，最多 120 秒。',{...readProperties,text:{type:'string'},submit:{type:'boolean'},keys:{type:'array',items:{type:'string',enum:Object.keys(KEYS)}}},['session_id'],(a:any,s?:AbortSignal)=>manager!.send(a,s)],
   ['shell_read','按增量游标读取终端输出；默认最多 200 行、8192 字节。',readProperties,['session_id'],(a:any,s?:AbortSignal)=>manager!.read(a,s)],
   ['shell_close','关闭当前会话的终端并等待进程退出。',{session_id:{type:'string'}},['session_id'],(a:any)=>manager!.close(a.session_id)],
   ['shell_list','列出当前执行会话拥有的终端。',{},[],()=>Promise.resolve({sessions:manager!.list()})],
  ] as const;
  return definitions.map(([name,description,properties,required,run])=>defineTool({name,label:name,description,executionMode:'sequential',parameters:{type:'object',properties,required} as never,async execute(_id,args,signal){try{return {content:[{type:'text' as const,text:JSON.stringify(await run(args,signal))}],details:undefined};}catch(e){return {content:[{type:'text' as const,text:JSON.stringify({error:e instanceof Error?e.message:String(e)})}],isError:true,details:undefined};}}}));
}
export function terminalExtension(cwd:string,env:Record<string,string>,signal?:AbortSignal):ExtensionFactory{
 return api=>{const manager=new TerminalSessions(cwd,env,signal);
  for(const tool of terminalToolDefinitions(manager))api.registerTool(tool);
  api.on('session_shutdown',()=>manager.shutdown());
 };
}
