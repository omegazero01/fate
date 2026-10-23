/** Synthetic Goals inputs only. No executor or target network capability is loaded. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {openDatabase} from '../src/db/index.js';
import {runGoalsDecompose,configureAgentEnv} from '../src/agent/roles.js';
import {makeModelResolver} from '../src/pi/modelResolver.js';
const name=`fate_goals_real_${process.pid}`,dataDir=`/private/tmp/${name}`;
const evidence=path.resolve('../../docs/reviews/evidence/goals-isolation-20261021');mkdirSync(evidence,{recursive:true});mkdirSync(dataDir,{recursive:true,mode:0o700});
const live=new pg.Client({connectionString:process.env.GOALS_PROFILE_DSN??'postgres://series:series@127.0.0.1:5433/series'});await live.connect();
const profile=(await live.query('SELECT * FROM llm_profiles WHERE id=$1',[Number(process.env.GOALS_PROFILE_ID??453)])).rows[0];await live.end();assert(profile&&profile.model.includes('deepseek'));
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;const db=await openDatabase();
const requests:any[]=[],cases:any[]=[];let phase='',caseIndex=0;
const originalFetch=globalThis.fetch,host=new URL(profile.base_url).host;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);assert.equal(url.host,host,'Only model endpoint permitted');assert(requests.length<20,'Synthetic request safety cap');
 const body=JSON.parse(String(init?.body??'{}'));const text=JSON.stringify(body.messages??[]);
 if(phase==='objectives')assert(!text.includes('BACKGROUND_ONLY_MARKER'),'Description leaked into goal phase');
 requests.push({case:caseIndex,phase,bytes:Buffer.byteLength(JSON.stringify(body)),tools:(body.tools??[]).map((t:any)=>t.function?.name??t.name),description_present:text.includes('BACKGROUND_ONLY_MARKER')});
 return originalFetch(input,init);
};
let error:string|undefined;
try{
 const fields=Object.keys(profile);assert(fields.every(k=>/^[_a-z]+$/.test(k)));await db.query(`INSERT INTO llm_profiles(${fields.map(k=>`"${k}"`).join(',')}) VALUES(${fields.map((_,i)=>`$${i+1}`).join(',')})`,fields.map(k=>profile[k]));
 await db.query('UPDATE agents SET max_turns=6,run_seconds=120,llm_profile_id=$1 WHERE key=\'goals\'',[profile.id]);configureAgentEnv({skillsDir:path.join(dataDir,'skills')});
 for(const goal of ['资产测试覆盖度100%','交付资产覆盖清单；交付修复建议清单']){
  caseIndex++;const description='BACKGROUND_ONLY_MARKER：架构分析、接口梳理、漏洞挖掘、漏洞报告仅为背景，不要求作为独立交付物。\n\n禁止访问外部测试目标；仅处理本地合成资料，无需网络探测。';
  const task=await db.tasks().createTaskWithOptions(description,goal,{executionMode:'manual',initializeGoals:true});await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
  const result=await runGoalsDecompose({db,taskID:task.id,expID:task.exploration_id,description,dataDir,model:await makeModelResolver(db)(task.id,'goals',{profileID:profile.id}),maxTurns:6,onActivity:(a:any)=>{if(a.phase)phase=a.phase;}});
  const goals=await db.exploration(task.exploration_id).listByKind('goal'),state=(await db.query('SELECT phase,fallback FROM goals_bootstrap WHERE task_id=$1',[task.id])).rows[0];
  const runtimes=(await db.query('SELECT effective FROM runtime_role_configs WHERE task_id=$1 ORDER BY started_at',[task.id])).rows.map(r=>r.effective);
  cases.push({task_id:task.id,input:{goal,description},result,goals,state,runtimes});assert.equal(goals.length,caseIndex===1?1:2);assert.equal(state.fallback,false);assert(goals.every(g=>g.payload.source?.field==='goal'));
 }
}catch(e){error=String(e);process.exitCode=1;}
finally{
 globalThis.fetch=originalFetch;const audit=(await db.query('SELECT role,purpose,status,usage,runtime_id FROM llm_request_attempts ORDER BY id')).rows;
 const report={passed:!error,error,database:name,requests,cases,audit,target_requests:0,finished_at:new Date().toISOString()};const text=JSON.stringify(report,null,2);assert(!profile.api_key||!text.includes(profile.api_key));writeFileSync(path.join(evidence,'real-goals.json'),text+'\n');await db.close();
 console.log(JSON.stringify({passed:!error,error,requests:requests.length,evidence:path.join(evidence,'real-goals.json')}));
}
