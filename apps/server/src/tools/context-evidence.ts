import {createHash} from 'node:crypto';
import {assertToolBinding} from '../agent/tool-registry.js';
import {loadToolOutput} from '../evidence/tool-outputs.js';
import {readBlob} from '../evidence/blobs.js';
import {evidenceBody} from '../evidence/store.js';
import {authorizeEvidence} from '../evidence/authorization.js';
import type {ToolRunContext} from './context.js';

/** Evidence references reuse the original access checks and offset units. Never arbitrary filesystem reads. */
export async function contextEvidence(c:ToolRunContext,item:{ref:string;offset?:number;field?:string;view?:string;cursor?:string;version?:number}) {
 const match=/^(output|attachment|traffic):(.+)$/.exec(item.ref);if(!match)return;
 if(item.field||item.cursor||item.version!==undefined||item.view&&item.view!=='detail')throw new Error('证据引用仅支持 detail 与 offset');
 const offset=item.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error('无效证据偏移');
 let body:string,hash:string;
 if(match[1]==='traffic'){
  await assertToolBinding(c.db,c.role,'traffic_body');
  const parts=/^([0-9a-f-]{36}):(request|response)$/.exec(match[2]!);if(!parts)throw new Error('流量引用格式为 traffic:UUID:request|response');
  const exchange=(await c.db.query('SELECT task_id,intent_id,url FROM traffic_evidence_snapshots WHERE id=$1 AND task_id=$2',[parts[1],c.taskID])).rows[0];
  if(!exchange)throw new Error('证据不属于本任务');await authorizeEvidence(c.db,exchange as never,c.taskID);
  const page=await evidenceBody(c.db,parts[1]!,parts[2]!,offset,400);
  return {...page,ref:item.ref,view:'detail',offset_unit:'byte',next_offset:page.truncated?page.next_offset:null,
   ...(page.truncated?{next_item:{ref:item.ref,offset:page.next_offset}}:{})};
 }
 if(match[1]==='output'){
  await assertToolBinding(c.db,c.role,'read_tool_output');
  if(!/^[0-9a-f-]{36}$/.test(match[2]!))throw new Error('无效工具原文引用');
  body=await loadToolOutput(c.db,match[2]!,{taskID:c.taskID,conversationID:c.conversationID,agent:true,intentID:c.intentID});
  hash=createHash('sha256').update(body).digest('hex');
 }else{
  await assertToolBinding(c.db,c.role,'read_attachment');
  let path:string;try{path=decodeURIComponent(match[2]!);}catch{throw new Error('无效附件引用');}
  const r=(await c.db.query(`SELECT sha256 FROM chat_artifacts WHERE path=$1 AND ${c.conversationID?'conversation_id':'task_id'}=$2`,[path,c.conversationID??c.taskID])).rows[0];
  if(!r)throw new Error('附件不存在或不属于本任务');hash=String(r.sha256);
  const bytes=await readBlob(c.db,hash);if(bytes.includes(0))throw new Error('二进制附件需要由相应解析器处理');body=bytes.toString('utf8');
 }
 const start=Math.min(offset,body.length),end=Math.min(body.length,start+400),content=body.slice(start,end),next=end<body.length?end:null;
 return {ref:item.ref,view:'detail',content,offset:start,total:body.length,offset_unit:'utf16',source_hash:hash,next_offset:next,
  ...(next!==null?{next_item:{ref:item.ref,offset:next}}:{})};
}
