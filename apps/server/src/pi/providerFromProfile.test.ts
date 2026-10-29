import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { buildModelSource, testProfileConnection } from './providerFromProfile.js';

async function body(req: IncomingMessage) { const chunks: Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString()); }
const replies: Record<string, object> = {
 openai: { id:'chat-test',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'pong',reasoning_content:'checked',tool_calls:[{id:'call_1',type:'function',function:{name:'echo',arguments:'{"text":"汉字\\nvalue"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18} },
 anthropic: { id:'msg-test',type:'message',model:'fixture',role:'assistant',content:[{type:'text',text:'pong'},{type:'thinking',thinking:'checked',signature:'signed'},{type:'tool_use',id:'call_1',name:'echo',input:{text:'汉字\nvalue'}}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:11,output_tokens:7} },
 'openai-responses': { id:'resp-test',object:'response',model:'fixture',status:'completed',output:[{id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'pong',annotations:[]}]},{id:'rs_1',type:'reasoning',summary:[{type:'summary_text',text:'checked'}]},{id:'fc_1',type:'function_call',call_id:'call_1',name:'echo',arguments:'{"text":"汉字\\nvalue"}',status:'completed'}],usage:{input_tokens:11,output_tokens:7,total_tokens:18} },
};
describe('native provider transport configuration',()=>{
 it.each(['openai','anthropic','openai-responses'])('honors non-stream %s and preserves native tool parsing, reasoning and usage',async format=>{
  let received:any,headers:any,calls=0;
  const server=createServer(async(req,res)=>{calls++;received=await body(req);headers=req.headers;res.setHeader('content-type','application/json');res.end(JSON.stringify(replies[format]));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const address=server.address() as {port:number};
   const source=await buildModelSource({id:901,name:'test',model:'fixture',baseURL:`http://127.0.0.1:${address.port}/v1`,apiKey:'fixture-key',contextWindowK:128,maxTokens:1234,maxTokensField:'max_tokens',format,streaming:false,sessionHeaderKey:'x-test-session',sessionHeaderValue:'task:fixture'});
   const result=await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'ping',timestamp:Date.now()}]});
   expect(result.errorMessage).toBeUndefined();expect(result.stopReason).toBe('toolUse');
   expect(result.content.find(b=>b.type==='text')).toMatchObject({text:'pong'});
   expect(result.content.find(b=>b.type==='toolCall')).toMatchObject({name:'echo',arguments:{text:'汉字\nvalue'}});
   expect(result.content.find(b=>b.type==='thinking')).toMatchObject({thinking:'checked'});
   expect(result.usage).toMatchObject({input:11,output:7});
   expect(received.stream).toBe(false);expect(received.stream_options).toBeUndefined();
   expect(received.max_tokens).toBe(1234);expect(received.max_completion_tokens).toBeUndefined();expect(received.max_output_tokens).toBeUndefined();
   expect(headers['x-test-session']).toBe('task:fixture');expect(calls).toBe(1);
   await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'summary',timestamp:Date.now()}]},{maxTokens:128});
   expect(received.max_tokens).toBe(128);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('keeps streaming on the wire and native HTTP errors visible to the connection probe',async()=>{
  let received:any,calls=0;
  const server=createServer(async(req,res)=>{received=await body(req);calls++;res.statusCode=401;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{message:'fixture authentication failure'}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const address=server.address() as {port:number};
   const profile={id:902,name:'test',model:'fixture',baseURL:`http://127.0.0.1:${address.port}/v1`,apiKey:'fixture-key',contextWindowK:128,maxTokens:100,format:'openai'};
   const result=await testProfileConnection(profile);expect(result.ok).toBe(false);expect(result.error).toContain('401');expect(received.stream).toBe(true);
   const nonstream=await testProfileConnection({...profile,streaming:false});expect(nonstream.ok).toBe(false);expect(nonstream.error).toContain('401');expect(received.stream).toBe(false);expect(calls).toBe(2);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});

it.each(['openai','openai-responses'])('omits implicit output limits for an unlimited %s profile',async format=>{
 let received:any;
 const server=createServer(async(req,res)=>{received=await body(req);res.setHeader('content-type','application/json');res.end(JSON.stringify(replies[format]));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const source=await buildModelSource({id:903,name:'unlimited',model:'fixture',baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'fixture',contextWindowK:128,maxTokens:0,format,streaming:false});
  const result=await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'ping',timestamp:Date.now()}]});
  expect(result.errorMessage).toBeUndefined();
  for(const key of ['max_tokens','max_completion_tokens','max_output_tokens'])expect(received).not.toHaveProperty(key);
  await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'LOCAL bounded summary',timestamp:Date.now()}]},{maxTokens:128});
  expect(received[format==='openai-responses'?'max_output_tokens':'max_completion_tokens']).toBe(128);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.each([0,4096])('preserves native DeepSeek output-limit field for profile maxTokens=%s',async maxTokens=>{
 let received:any;
 const server=createServer(async(req,res)=>{received=await body(req);res.setHeader('content-type','application/json');res.end(JSON.stringify(replies.openai));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  // Local-only URL exercises pi's URL compatibility detection, without making
  // any request to DeepSeek or depending on a real key/model response.
  const source=await buildModelSource({id:904,name:'local compatibility',model:'fixture',baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/deepseek.com/v1`,apiKey:'fixture',contextWindowK:128,maxTokens,format:'openai',streaming:false});
  const result=await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'LOCAL bounded summary',timestamp:Date.now()}]},{maxTokens:128});
  expect(result.errorMessage).toBeUndefined();
  expect(received.max_tokens).toBe(128);
  expect(received).not.toHaveProperty('max_completion_tokens');
  expect(received).not.toHaveProperty('max_output_tokens');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
