import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {openDatabase,type Database} from '../db/index.js';
import {contextGetTool} from './context-read.js';
import {contextEvidence} from './context-evidence.js';
import {runContext} from './context.js';
import {saveToolOutput,loadToolOutput} from '../evidence/tool-outputs.js';
import {putBlob} from '../evidence/blobs.js';
import {recordExchange} from '../evidence/store.js';
import {toolOutputTool} from './output.js';
import {listAssetsTool} from './assets.js';
import {mergedAssetSearchTool as assetSearchTool} from './asset-search-compat.js';
let db:Database;const name=`fate_merged_read_${process.pid}`;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db?.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name}`);await c.end();});
async function fixture(){const t=await db.tasks().createTaskWithOptions('LOCAL read fixture','',{});return runContext(db,t.id,t.exploration_id,'worker');}
async function call(tool:ReturnType<typeof contextGetTool>,args:unknown){const r=await tool.execute(randomUUID(),args as never,undefined,undefined,{} as never);const text=(r.content[0] as {text:string}).text;expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20480);return JSON.parse(text);}
it('reads complete output and attachment pages, preserves UTF16 offsets and rejects cross-task access',async()=>{
 const c=await fixture(),other=await fixture(),body='😀合成证据\\"\n'.repeat(300);
 const out=await saveToolOutput(db,c,'test','local',body);
 const hash=await putBlob(db,Buffer.from(body)),path='artifacts/local/中文.txt';
 await db.query('INSERT INTO chat_artifacts(id,task_id,name,path,mime,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),c.taskID,'中文.txt',path,'text/plain',Buffer.byteLength(body),hash]);
 for(const ref of [out.ref,`attachment:${encodeURIComponent(path)}`]){
  let item:any={ref},full='';do{const page=(await call(contextGetTool(c),{items:[item]})).items[0];expect(page.error).toBeUndefined();expect(page.offset_unit).toBe('utf16');full+=page.content;item=page.next_item;}while(item);expect(full).toBe(body);
  expect((await call(contextGetTool(other),{items:[{ref}]})).items[0].error).toBeTruthy();
 }
 const legacy=await call(toolOutputTool(c),{output_ref:out.output_ref,offset:1999});expect(legacy.content).toBe(body.slice(1999,3999));
 expect(await loadToolOutput(db,out.output_ref,c)).toBe(body);
 await db.query("UPDATE tools SET enabled=false WHERE key='read_tool_output'");
 expect((await call(contextGetTool(c),{items:[{ref:out.ref}]})).items[0].error).toContain('权限');
 await db.query("UPDATE tools SET enabled=true WHERE key='read_tool_output'");
});
it('reassembles exact traffic bytes including a UTF8 boundary and preserves ownership',async()=>{
 const c=await fixture(),other=await fixture(),body=Buffer.from('中😀'.repeat(1000));
 const id=await recordExchange(db,{taskID:c.taskID,url:'http://synthetic.invalid/',method:'GET',status:200,reqHead:'',respHead:'',request:Buffer.alloc(0),response:body});
 let item:any={ref:`traffic:${id}:response`};const chunks:Buffer[]=[];
 do{const page=(await call(contextGetTool(c),{items:[item]})).items[0];expect(page.error).toBeUndefined();chunks.push(Buffer.from(page.content,page.encoding==='base64'?'base64':'utf8'));expect(page.offset_unit).toBe('byte');item=page.next_item;}while(item);
 expect(Buffer.concat(chunks)).toEqual(body);await expect(contextEvidence(other,{ref:`traffic:${id}:response`})).rejects.toThrow('本任务');
});
it('bounded batch stays valid JSON and merged list respects the legacy disabled switch',async()=>{
 const c=await fixture(),body='\\"\n😀'.repeat(500),refs=[];
 for(let i=0;i<5;i++)refs.push({ref:(await saveToolOutput(db,c,'test',String(i),body)).ref});
 const batch=await call(contextGetTool(c),{items:refs});expect(batch.items).toHaveLength(5);expect(batch.items.every((r:any)=>r.next_item)).toBe(true);
 await db.assets().upsertRootDomain({domain:'merged.invalid',taskID:c.taskID});
 const merged=await call(assetSearchTool(c),{}),legacy=await call(listAssetsTool(c),{});expect(merged.assets.map((r:any)=>r.id)).toEqual(legacy.assets.map((r:any)=>r.id));
 await db.query("UPDATE tools SET enabled=false WHERE key='list_assets'");expect((await call(assetSearchTool(c),{})).error).toContain('权限');await db.query("UPDATE tools SET enabled=true WHERE key='list_assets'");
});
