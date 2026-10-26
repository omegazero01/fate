import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {openDatabase,type Database} from './index.js';
import {aggregateUsage,backfillUsageLedger} from './usage-ledger.js';
const name=`fate_usage_ledger_${process.pid}`;let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db.close();const p=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await p.connect();await p.query(`DROP DATABASE ${name}`);await p.end();});
const usage=(input=50,output=10,cacheRead=150)=>({input,output,cacheRead,cacheWrite:0,totalTokens:input+output+cacheRead});
async function fixture(){return db.tasks().createTaskWithOptions('LOCAL usage fixture','',{executionMode:'manual'});}
async function audit(task:number,runtime='local',u=usage(),extra:Record<string,unknown>={}){
 return (await db.query(`INSERT INTO llm_request_attempts(task_id,role,model,runtime_id,status,usage,profile_id,created_at) VALUES($1,'worker','LOCAL-model',$2,'completed',$3,$4,COALESCE($5::timestamptz,now())) RETURNING id`,[task,runtime,JSON.stringify(u),extra.profile??null,extra.at??null])).rows[0]!.id;
}
it('retains normalized totals after audit, configuration and task deletion, with idempotent import',async()=>{
 const t=await fixture(),p=(await db.query("INSERT INTO llm_profiles(name,model,base_url,format) VALUES('LOCAL original profile','LOCAL-model','http://local.invalid','openai') RETURNING id")).rows[0]!.id;
 const id=await audit(t.id,'local',usage(),{profile:p});
 expect((await aggregateUsage(db,{taskID:t.id}))[0]).toMatchObject({calls:1,input_tokens:200,output_tokens:10,cache_read_tokens:150,usage_complete:true});
 await backfillUsageLedger(db);await backfillUsageLedger(db);
 await db.query("UPDATE llm_profiles SET name='LOCAL renamed' WHERE id=$1",[p]);
 expect((await aggregateUsage(db,{taskID:t.id},'profile'))[0]?.profile_name).toBe('LOCAL original profile');
 await db.query('DELETE FROM llm_request_attempts WHERE id=$1',[id]);await db.query('DELETE FROM llm_profiles WHERE id=$1',[p]);await db.query('DELETE FROM tasks WHERE id=$1',[t.id]);
 expect((await aggregateUsage(db,{taskID:t.id}))[0]).toMatchObject({calls:1,input_tokens:200,output_tokens:10});
});
it('counts every role and a task-bound conversation only once globally',async()=>{
 const t=await fixture();
 for(const role of ['goals','planner','mainagent','worker','auto','pentest','reporter'])await db.query("INSERT INTO llm_request_attempts(task_id,role,model,status,usage) VALUES($1,$2,'LOCAL','completed',$3)",[t.id,role,JSON.stringify(usage(1,2,3))]);
 expect((await aggregateUsage(db,{taskID:t.id}))[0]).toMatchObject({calls:7,input_tokens:28,output_tokens:14});
 expect(await aggregateUsage(db,{taskID:t.id},'role')).toHaveLength(7);
});
it('recovers 132 known tokens across old native and new audited executions of the same turn',async()=>{
 const t=await fixture(),s=db.exploration(t.exploration_id),turn='LOCAL recovered turn';
 await s.appendActivity({worker:'main',kind:'status',main_seg:2,metadata:{turn_id:turn,event_type:'turn_start',runtime_id:'old-runtime',role:'mainagent'}});
 await s.appendActivity({worker:'main',kind:'text',main_seg:2,summary:'LOCAL response',metadata:{turn_id:turn,stream_id:'old-response',response:{model:'LOCAL-model',stop_reason:'stop',usage:usage(100,10,0)}}});
 await audit(t.id,'new-runtime',usage(20,2,0));
 const total=(await aggregateUsage(db,{taskID:t.id}))[0]!;
 expect(total).toMatchObject({calls:2,input_tokens:120,output_tokens:12,usage_complete:true,time_unknown_records:1});
 expect((await aggregateUsage(db,{taskID:t.id},'day')).reduce((n,r)=>n+r.input_tokens+r.output_tokens,0)).toBe(22);
 expect((await aggregateUsage(db,{taskID:t.id,timeKnown:false}))[0]).toMatchObject({input_tokens:100,output_tokens:10});
});
it('never adds native and final run aggregates on top of audited usage',async()=>{
 const t=await fixture(),s=db.exploration(t.exploration_id),runtime='complete-runtime';
 await s.appendActivity({worker:'planner',kind:'status',metadata:{turn_id:'t',event_type:'turn_start',runtime_id:runtime,role:'planner'}});
 await s.appendActivity({worker:'planner',kind:'text',summary:'LOCAL',metadata:{turn_id:'t',stream_id:'native',response:{model:'LOCAL',stop_reason:'stop',usage:usage()}}});
 await s.appendActivity({worker:'planner',kind:'result',metadata:{turn_id:'t'},input_tokens:50,output_tokens:10,cache_read_tokens:150});
 await audit(t.id,runtime);
 expect((await aggregateUsage(db,{taskID:t.id}))[0]).toMatchObject({calls:1,input_tokens:200,output_tokens:10});
});
it('marks unknown old semantics and groups actual request times in Shanghai',async()=>{
 const t=await fixture();
 await audit(t.id,'day1',usage(),{at:'2026-10-25T15:59:59Z'});await audit(t.id,'day2',usage(),{at:'2026-10-25T16:00:00Z'});
 expect((await aggregateUsage(db,{taskID:t.id},'day')).map(r=>r.bucket)).toEqual(['2026-10-25','2026-10-26']);
 const old=await fixture();await db.exploration(old.exploration_id).appendActivity({worker:'main',kind:'result',input_tokens:10,output_tokens:5,cache_read_tokens:50});
 expect((await aggregateUsage(db,{taskID:old.id}))[0]).toMatchObject({calls:0,input_tokens:10,output_tokens:5,input_semantics:'unknown',usage_complete:false,legacy_records:1,unknown_usage_calls:0,calls_complete:false});
});
it('discloses ambiguous overlapping legacy totals and never calls them complete',async()=>{
 const t=await fixture();await audit(t.id,'unmapped-runtime',usage(20,2,0));
 await db.exploration(t.exploration_id).appendActivity({worker:'work#legacy',kind:'result',input_tokens:100,output_tokens:10});
 const total=(await aggregateUsage(db,{taskID:t.id}))[0]!;
 expect(total).toMatchObject({calls:1,input_tokens:20,output_tokens:2,usage_complete:false,history_gap_requests:1});
 const {unverifiedUsageHistory}=await import('./usage-ledger.js');expect(await unverifiedUsageHistory(db,{taskID:t.id})).toMatchObject([{input_tokens:100,output_tokens:10}]);
});
it('keeps partial input totals while suppressing cache rates when cached input is unknown',async()=>{
 const t=await fixture();await db.query("INSERT INTO llm_request_attempts(task_id,role,model,status,usage) VALUES($1,'worker','LOCAL','completed',$2)",[t.id,JSON.stringify({input:0,output:4,cacheRead:0,cacheWrite:0,inputTotal:100,_input_total_known:true,_cache_read_known:false,_quality:'partial'})]);
 expect((await aggregateUsage(db,{taskID:t.id}))[0]).toMatchObject({calls:1,input_tokens:100,output_tokens:4,unknown_usage_calls:1,usage_complete:false,input_complete:false});
});
it('does not assign a multi-profile conversation to one arbitrary profile or model',async()=>{
 const t=await fixture(),c=Number((await db.query("INSERT INTO conversations(agent_key,title,task_id) VALUES('pentest','LOCAL fallback conversation',$1) RETURNING id",[t.id])).rows[0]!.id);
 const profiles=[];
 for(const model of ['LOCAL alpha','LOCAL beta']){
  const p=Number((await db.query("INSERT INTO llm_profiles(name,model,format) VALUES($1,$1,'openai') RETURNING id",[model])).rows[0]!.id);profiles.push(p);
  await db.query("INSERT INTO llm_request_attempts(task_id,conversation_id,role,profile_id,model,status,usage) VALUES($1,$2,'pentest',$3,$4,'completed',$5)",[t.id,c,p,model,JSON.stringify(usage(1,2,3))]);
 }
 const [conversation]=await aggregateUsage(db,{conversationID:c},'conversation');expect(conversation).toMatchObject({calls:2,input_tokens:8,output_tokens:4,profile_id:null,model:null});expect(conversation.models).toEqual(['LOCAL alpha','LOCAL beta']);expect(conversation.profile_ids.map(Number).sort()).toEqual(profiles.sort());
 expect((await aggregateUsage(db,{conversationID:c},'profile')).map(r=>r.calls)).toEqual([1,1]);
});
