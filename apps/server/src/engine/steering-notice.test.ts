import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {Engine,defaultEngineConfig} from './engine.js';
import {activityDTO} from './live-stream.js';
import {projectTurn} from './turn-summary.js';

const name=`fate_steering_notice_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-steering-notice-'));
let db:Database;const engines:Engine[]=[];
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;
 db=await openDatabase();await db.platform().setSetting('workers','1');
});
afterAll(async()=>{
 for(const e of engines)await e.shutdown();await db.close();
 const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});
 await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});
});
async function until(fn:()=>Promise<boolean>){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('steering condition timed out');}

it.each(['planner','mainagent'])('stores %s native steering as a control in the current worker turn, preserves tool/writeback boundaries',async source=>{
 const task=await db.tasks().createTaskWithOptions('LOCAL steering notice','',{executionMode:'manual'}),s=db.exploration(task.exploration_id);
 const id=await s.addIntent({summary:'LOCAL read a fixture and save an observation',dispatch_requested:true},5,[],'user');
 const faux=fauxProvider({provider:`notice-${source}`}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
 const e=new Engine(db,{...defaultEngineConfig(),workers:1,debounceMs:5},async()=>({modelRuntime,model:faux.getModel() as never}),dir);engines.push(e);
 let received=false;
 faux.setResponses([
  fauxAssistantMessage([fauxToolCall('bash',{command:'sleep 0.6; echo LOCAL_TOOL_FINISHED'})]),
  context=>{
   const messages=context.messages as unknown as {role:string;content:unknown}[];
   const tool=messages.findIndex(m=>m.role==='toolResult'&&JSON.stringify(m.content).includes('LOCAL_TOOL_FINISHED'));
   const steering=messages.findIndex(m=>JSON.stringify(m.content).includes('LOCAL correct the current method'));
   expect(tool).toBeGreaterThanOrEqual(0);expect(steering).toBeGreaterThan(tool);received=true;
   return fauxAssistantMessage([fauxToolCall('record_fact',{summary:'LOCAL observation preserved',evidence:'LOCAL synthetic evidence',confidence:'high'})]);
  },
  async()=>{expect((await s.listByKind('fact')).some(n=>n.payload.from_intent===id)).toBe(true);return fauxAssistantMessage('LOCAL observations saved; finished.');},
 ]);
 await e.run(task.id);
 await until(async()=>!!(await db.query("SELECT 1 FROM activity WHERE node_id=$1 AND kind='tool_use' AND tool='bash'",[id])).rowCount);
 await e.steerWork(task.id,id,'LOCAL correct the current method',source);
 await until(async()=>(await s.getNode(id))?.state==='done');
 const rows=(await db.query('SELECT * FROM activity WHERE node_id=$1 ORDER BY id',[id])).rows;
 const control=rows.filter(r=>r.metadata?.event_type==='steering');expect(control).toHaveLength(1);
 const turn=rows.find(r=>r.metadata?.event_type==='turn_start')!.metadata.turn_id;
 expect(control[0]).toMatchObject({kind:'status',tool:'steer_work',worker:expect.stringMatching(/^work#/),metadata:{turn_id:turn,source,steering:{id:expect.any(String),source,intent_id:id,target_turn_id:turn,status:'submitted'}}});
 expect(received).toBe(true);expect(rows.filter(r=>r.kind==='tool_result'&&r.is_error)).toHaveLength(0);
 const projected=projectTurn(rows,[]);expect(projected).toMatchObject({steps:3,tool_calls:2,queue_ms:null});
 expect(projected.final_activity?.seq).not.toBe(control[0]!.id);
 await expect(e.steerWork(task.id,id,'LOCAL too late',source)).rejects.toThrow();
 expect((await db.query("SELECT 1 FROM activity WHERE node_id=$1 AND metadata->>'event_type'='steering'",[id])).rowCount).toBe(1);
 await e.stop(task.id);
});

it('legacy read compatibility does not mutate bodies or claim delivery; a real user remains a user',()=>{
 const row={id:5,kind:'user',summary:'ORIGINAL',detail:'ORIGINAL FULL',worker:'work#1',metadata:{event_type:'steering',source:'planner'}};
 expect(activityDTO(row)).toMatchObject({kind:'status',tool:'steer_work',summary:'ORIGINAL',detail:'ORIGINAL FULL',metadata:row.metadata});expect(row.kind).toBe('user');
 expect(activityDTO({...row,metadata:{}}).kind).toBe('user');
 expect(activityDTO({...row,kind:'tool_use',tool:'steer_work'}).kind).toBe('tool_use');
 const rows=[{...row,created_at:new Date(),metadata:{...row.metadata,turn_id:'t',final_answer:true}},
  {id:6,worker:'work#1',kind:'status',created_at:new Date(),metadata:{turn_id:'t',event_type:'turn_start',started_at:new Date().toISOString()}},
  {id:7,worker:'work#1',kind:'result',created_at:new Date(),metadata:{turn_id:'t',event_type:'lifecycle',status:'completed'}}];
 expect(projectTurn(rows,[])).toMatchObject({steps:0,tool_calls:0,queue_ms:null,final_activity:null});
});
