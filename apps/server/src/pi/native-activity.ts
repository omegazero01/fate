import {createHash} from 'node:crypto';
import type {ActivitySource} from '../db/activity-projection.js';
import type {RunnerActivity} from './runner.js';

export const NATIVE_ACTIVITY_MARKER='fate_native_activity_run_v1';
export interface NativeActivityIdentity {
 source:ActivitySource;worker:string;turn_id:string;node_id?:number;main_seg?:number;
}
export interface NativeActivityReference {runtime_id:string;key:string;source_hash:string;}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const nativeStreamID=(runtime:string,sequence:number)=>hash([runtime,sequence,'stream']);

/** Keys describe original native events, not delivery attempts. Presentation
 * changes (e.g. Planner's checked final summary) keep the original reference. */
export function withNativeActivity(a:RunnerActivity,runtime:string,sequence:number):RunnerActivity {
 if(a.native_event)return a;
 let part:string,value:unknown;
 switch(a.kind){
  case 'assistant_message_end':part=a.isThinking?'thinking':'text';value=[!!a.isThinking,a.text,a.response??null];break;
  case 'usage':part='usage';value=[a.input,a.output,a.cacheRead,a.cacheWrite];break;
  case 'tool_start':part='tool-start:'+a.toolCallId;value=[a.toolName,a.args];break;
  case 'tool_end':part='tool-result:'+a.toolCallId;value=[a.toolName,a.isError,a.text??null];break;
  default:return a;
 }
 return {...a,native_event:{runtime_id:runtime,key:hash([sequence,part]),source_hash:hash(value)}};
}

/** Same visible text conventions as the runner; images/structured metadata
 * remain in the original native file. No execution or success is inferred. */
export function nativeMessageActivities(message:any,runtime:string,sequence:number):RunnerActivity[]{
 if(message.role!=='assistant')return [];
 const content=Array.isArray(message.content)?message.content:[],streamID=nativeStreamID(runtime,sequence),out:RunnerActivity[]=[];
 const thinking=content.filter((b:any)=>b.type==='thinking'&&typeof b.thinking==='string'&&b.thinking.trim()).map((b:any)=>b.thinking).join('\n');
 if(thinking)out.push({kind:'assistant_message_end',isThinking:true,text:thinking,streamID});
 out.push({kind:'assistant_message_end',text:content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(''),streamID,
  response:{stop_reason:message.stopReason,has_tools:content.some((b:any)=>b.type==='toolCall'),model:message.model,provider:message.provider,usage:message.usage}});
 if(message.usage){const u=message.usage;out.push({kind:'usage',input:u.input,output:u.output,cacheRead:u.cacheRead,cacheWrite:u.cacheWrite});}
 return out.map(a=>withNativeActivity(a,runtime,sequence));
}
export function nativeToolActivities(message:any,assistant:any,runtime:string,sequence:number):RunnerActivity[]{
 if(message.role!=='toolResult')return [];
 const call=assistant?.content?.find((b:any)=>b.type==='toolCall'&&b.id===message.toolCallId&&b.name===message.toolName);
 if(!call)throw new Error('Native tool result has no matching original call; source retained');
 const texts=(message.content??[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text);
 return [withNativeActivity({kind:'tool_start',toolCallId:call.id,toolName:call.name,args:call.arguments},runtime,sequence),
  withNativeActivity({kind:'tool_end',toolCallId:call.id,toolName:call.name,isError:!!message.isError,text:texts.length?texts.join('\n'):undefined},runtime,sequence)];
}
