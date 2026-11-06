import type {SessionEntry} from '@earendil-works/pi-coding-agent';
import {unicodeLength} from '../unicode.js';
import {setImmediate as yieldLoop} from 'node:timers/promises';

const unsupportedText=/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const plannerTextCacheable=(value:string)=>!unsupportedText.test(value);

/** Native PI derives its effective model from both model_change and assistant
 * entries. Keep that setting without retaining an old assistant's whole body. */
export function sessionRuntimeMeta(e:SessionEntry){
 if(e.type==='compaction')return {firstKeptEntryId:e.firstKeptEntryId};
 if(e.type==='custom'||e.type==='custom_message')return {customType:e.customType};
 if(e.type==='model_change')return {model:{provider:e.provider,modelId:e.modelId}};
 if(e.type==='message'&&e.message.role==='assistant')return {model:{provider:e.message.provider,modelId:e.message.model}};
 return null;
}

function isHistoryCall(b:{type:string;name?:string;arguments?:Record<string,unknown>}){
  if(b.type!=='toolCall')return false;
  if(b.name==='context_search')return b.arguments?.source==='planner_session';
  const items=b.arguments?.items;
  return b.name==='context_get'&&Array.isArray(items)&&items.length>0&&
    items.every((item:unknown)=>!!item&&typeof item==='object'&&String((item as {ref?:unknown}).ref).startsWith('session:'));
}

function textContent(content:unknown):string{
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  return content.flatMap(block=>{
    if(block.type==='text')return [String(block.text??'')];
    if(block.type==='toolCall')return [JSON.stringify({tool:block.name,arguments:block.arguments})];
    // Match existing activity recall: hidden thinking and image data are not expanded.
    if(block.type==='image')return ['[image retained in original session]'];
    return [];
  }).join('\n');
}
export function plannerHistoryEntry(entry:SessionEntry){
  if(entry.type==='message'){
    const message=entry.message;
    const extra=message.role==='toolResult'?{tool:message.toolName,tool_call_id:message.toolCallId,is_error:message.isError}:{};
    return {ref:`session:${entry.id}`,timestamp:entry.timestamp,role:message.role,...extra,content:'content' in message?textContent(message.content):JSON.stringify(message)};
  }
  if(entry.type==='compaction')return {ref:`session:${entry.id}`,timestamp:entry.timestamp,role:'compaction',content:entry.summary};
  if(entry.type==='custom_message'&&entry.customType==='fate_context')return {ref:`session:${entry.id}`,timestamp:entry.timestamp,role:'host_delivery',content:textContent(entry.content)};
  if(entry.type==='custom'&&entry.customType==='planner_delivery'){
    const data=entry.data as {currentState?:unknown};
    return {ref:`session:${entry.id}`,timestamp:entry.timestamp,role:'host_snapshot',content:JSON.stringify(data.currentState??{})};
  }
  return undefined;
}

/** Retrieval is an index into originals, not a new independent observation.
 * Keep every entry directly readable, but do not let a query match itself or
 * let successive recalled copies displace the original planning evidence. */
export function isRecallEcho(entry:SessionEntry){
  if(entry.type!=='message')return false;
  const m=entry.message;
  if(m.role==='assistant'){
    const visible=m.content.filter(b=>b.type!=='thinking'&&(b.type!=='text'||b.text.trim()));
    return visible.length>0&&visible.every(isHistoryCall);
  }
  if(m.role==='toolResult'&&['context_search','context_get'].includes(m.toolName)){
    try{
      const data=JSON.parse(textContent(m.content));
      if(m.toolName==='context_search')return data.source==='planner_session';
      return Array.isArray(data.items)&&data.items.length>0&&data.items.every((item:{ref?:string})=>item.ref?.startsWith('session:'));
    }catch{/* A non-JSON or mixed result remains searchable. */}
  }
  return false;
}

/** Skip only the retrieval call in mixed assistant messages; retain real text
 * and other tool calls, with offsets into the unchanged original content. */
function historyParts(entry:SessionEntry,content:string){
  return entry.type==='message'&&entry.message.role==='assistant'
    ?entry.message.content.filter(b=>b.type==='text'||b.type==='toolCall').map(b=>({text:textContent([b]),skip:isHistoryCall(b)}))
    :[{text:content,skip:false}];
}
export function historyMatch(entry:SessionEntry,content:string,q:string){
  const parts=historyParts(entry,content);
  let offset=0;
  for(const part of parts){
    if(!part.skip){
      const foldedText=part.text.toLocaleLowerCase(),match=foldedText.indexOf(q.toLocaleLowerCase());
      if(match>=0){
        // Case folding can expand characters (e.g. İ). Use the same compact
        // coordinates as the durable index, without lowercasing every character.
        const position=unicodeLength(foldedText,0,match);let extra=0;
        if(position)for(const run of historyCaseExpansions(part.text)){
          const count=run.count??1,step=run.step??1,full=Math.min(count,Math.max(0,Math.floor((position-run.at-run.by)/step)+1));
          extra+=full*run.by+(full<count?Math.min(run.by,Math.max(0,position-run.at-full*step)):0);
        }
        return offset+position-extra;
      }
    }
    offset+=unicodeLength(part.text)+1;
  }
  return -1;
}

export function plannerHistoryParts(entry:SessionEntry,content:string){
  if(isRecallEcho(entry))return [];
  const parts=historyParts(entry,content);
  let start=0;const result=[];
  for(const part of parts){
    if(!part.skip&&part.text){
      // PostgreSQL text cannot contain NUL. Index each real text segment with
      // its original offset; such entries are still read from the native file.
      let segmentStart=start;
      for(const segment of part.text.split(unsupportedText)){
      const expansions=historyCaseExpansions(segment);
      if(segment)result.push({start:segmentStart,folded:segment.toLocaleLowerCase(),expansions});
      segmentStart+=unicodeLength(segment)+1;
      }
    }
    start+=unicodeLength(part.text)+1;
  }
  return result;
}

/** Initial indexing may encounter one huge original. Yield between bounded
 * case-coordinate scans without changing the original folded-string semantics. */
export async function plannerHistoryPartsAsync(entry:SessionEntry,content:string,signal?:AbortSignal){
 if(isRecallEcho(entry))return [];
 const parts=historyParts(entry,content);
 let start=0;const result=[];
 for(const part of parts){
  if(!part.skip&&part.text){
   let segmentStart=start;
   for(const segment of part.text.split(unsupportedText)){
    signal?.throwIfAborted();
    const scan=caseExpansionChunks(segment);let next=scan.next(),last=performance.now();
    while(!next.done){if(performance.now()-last>=8){await yieldLoop();signal?.throwIfAborted();last=performance.now();}next=scan.next();}
    if(segment)result.push({start:segmentStart,folded:segment.toLocaleLowerCase(),expansions:next.value});
    await yieldLoop();signal?.throwIfAborted();segmentStart+=unicodeLength(segment)+1;
   }
   start=segmentStart;
  }else start+=unicodeLength(part.text)+1;
 }
 return result;
}

/** Lowercase expansion coordinates in the folded-character domain. ASCII and
 * uncased text cannot expand. Repeated positions use an arithmetic run; legacy
 * {at,by} rows remain readable as a run of one. */
export function historyCaseExpansions(text:string){
 const scan=caseExpansionChunks(text);let next=scan.next();while(!next.done)next=scan.next();return next.value;
}
function* caseExpansionChunks(text:string){
 const result:Array<{at:number;by:number;step?:number;count?:number}>=[],sizes=new Map<string,number>();
 let characters=0,extra=0;
 for(let from=0;from<text.length;){
 let end=Math.min(text.length,from+32768);
 if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;
 const part=text.slice(from,end);let previousUTF=0;
 for(const m of part.matchAll(/(?![\x00-\x7f])[\p{Lu}\p{Lt}]/gu)){
  let size=sizes.get(m[0]);if(size===undefined){size=unicodeLength(m[0].toLocaleLowerCase());if(sizes.size<256)sizes.set(m[0],size);}
  if(size<=1)continue;
  characters+=unicodeLength(part,previousUTF,m.index);previousUTF=m.index;
  const at=characters+extra,by=size-1,last=result.at(-1);
  if(last&&last.by===by&&(!last.count||at===last.at+last.step!*last.count)){
   if(!last.count){last.step=at-last.at;last.count=2;}else last.count++;
  }else result.push({at,by});
  extra+=by;
 }
 characters+=unicodeLength(part,previousUTF);from=end;yield;
 }
 return result;
}
