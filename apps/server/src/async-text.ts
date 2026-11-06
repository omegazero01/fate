import {createHash} from 'node:crypto';
import {setImmediate as yieldLoop} from 'node:timers/promises';

/** Hash the unchanged UTF-8 original in small chunks. Never split a valid
 * surrogate pair: doing so would change its bytes to replacement characters. */
export async function textHashAsync(text:string,signal?:AbortSignal){
 const hash=createHash('sha256');let last=performance.now();
 for(let from=0;from<text.length;){
  signal?.throwIfAborted();let end=Math.min(text.length,from+32768);
  if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;
  hash.update(text.slice(from,end));from=end;
  if(performance.now()-last>=8){await yieldLoop();signal?.throwIfAborted();last=performance.now();}
 }
 signal?.throwIfAborted();return hash.digest('hex');
}
