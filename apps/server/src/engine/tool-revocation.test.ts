import {afterAll,beforeAll,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {runWorkerIntent} from '../agent/roles.js';

const dir=mkdtempSync(path.join(tmpdir(),'fate-tool-revocation-'));
const name=`fate_tool_revocation_${process.pid}`;
let db:Database;
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;
 db=await openDatabase();
});
afterAll(async()=>{
 await db.close();
 const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});
 await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();
 rmSync(dir,{recursive:true,force:true});
});
async function fixture(label:string){
 const task=await db.tasks().createTaskWithOptions('LOCAL synthetic fixture','Observe LOCAL evidence',{executionMode:'managed'});
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
 const faux=fauxProvider({provider:`revocation-${label}-${task.id}`});
 const runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
 return {task,faux,model:{modelRuntime:runtime,model:faux.getModel() as never},s:db.exploration(task.exploration_id)};
}
it('revoking interactive shell removes it from discovery and blocks execution without blocking writeback',async()=>{
 const f=await fixture('live-revocation'),activities:any[]=[];
 const previous=(await db.query("SELECT interactive_shell FROM agents WHERE key='worker'")).rows[0].interactive_shell;
 await db.query("UPDATE agents SET interactive_shell=true WHERE key='worker'");
 const id=await f.s.addIntent({summary:'LOCAL writeback after revocation',dispatch_requested:true},5,[],'user');
 const intent=(await f.s.claimNextWorker('revocation-worker'))!;
 f.faux.setResponses([
  async()=>{await db.query("UPDATE agents SET interactive_shell=false WHERE key='worker'");return fauxAssistantMessage([fauxToolCall('tool_search',{query:'shell_open',limit:1})]);},
  ctx=>{
   const latest=ctx.messages.filter(m=>m.role==='toolResult').at(-1);
   expect(latest?.content).not.toEqual(expect.arrayContaining([expect.objectContaining({text:expect.stringContaining('- shell_open:')})]));
   return fauxAssistantMessage([fauxToolCall('shell_open',{command:'printf SHOULD_NOT_RUN'})]);
  },
  fauxAssistantMessage([fauxToolCall('record_fact',{summary:'LOCAL fact after tool revoked',evidence:'LOCAL synthetic evidence',confidence:'high'})]),
  fauxAssistantMessage('Saved local fact'),
 ]);
 try{
  expect(await runWorkerIntent({db,taskID:f.task.id,expID:f.task.exploration_id,intent,workerName:'revocation-worker',model:f.model,dataDir:dir,hooks:{},onActivity:a=>activities.push(a)})).toMatchObject({stopReason:'completed'});
  const search=activities.find(a=>a.kind==='tool_end'&&a.toolName==='tool_search');
  expect(search.text).not.toContain('- shell_open:');
  const execution=activities.find(a=>a.kind==='tool_end'&&a.toolName==='shell_open');
  expect(execution.isError).toBe(true);
  expect((await f.s.listByKind('fact')).filter(n=>n.payload.from_intent===id)).toHaveLength(1);
 }finally{await db.query("UPDATE agents SET interactive_shell=$1 WHERE key='worker'",[previous]);}
});
