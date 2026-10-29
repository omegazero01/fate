// Local UI fixture only: no scheduler, real model, or target operation.
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../src/db/index.js';
import {beginPlannerDisplayRound,finishPlannerDisplayRound} from '../src/db/planner-rounds.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {buildApp} from '../src/http/app.js';
import {signJWT,AUTH_PASSWORD_KEY,hashPassword} from '../src/http/auth.js';
process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/fate_planner_ui_${process.pid}`;
process.env.SERIES_LOG_LEVEL='silent';
const db=await openDatabase(),dir='/tmp/fate-planner-round-ui';mkdirSync(dir,{recursive:true});
await db.platform().setSetting(AUTH_PASSWORD_KEY,hashPassword('local-fixture-only'));
const task=await db.tasks().createTaskWithOptions('本地合成：Planner 规划方向','仅验证展示，不执行目标任务',{executionMode:'manual'}),s=db.exploration(task.exploration_id);
const emit=(turn:string,kind:string,summary='',metadata:Record<string,unknown>={})=>s.appendActivity({worker:'planner',kind,summary,detail:summary,metadata:{turn_id:turn,...metadata}});
await s.appendActivity({worker:'planner',kind:'round',summary:'第 258 轮规划'});
await s.appendActivity({worker:'planner',kind:'text',summary:'旧记录没有保存方向，保留原文。'});
await s.appendActivity({worker:'planner',kind:'result',summary:'旧规划记录结束。'});
const boundaries:Record<string,number>={};
for(const [turn,title,state] of [['upload','文件上传全面探测','completed'],['wait','等待已有任务返回','completed'],['missing',null,'failed'],['live',null,'running']] as const){
 const display=await beginPlannerDisplayRound(db,task.exploration_id,turn);
 boundaries[turn]=Number((await db.query("SELECT id FROM activity WHERE exploration_id=$1 AND metadata->>'turn_id'=$2 AND kind='round'",[task.exploration_id,turn])).rows[0]!.id);
 await emit(turn,'status','',{event_type:'turn_start',role:'planner',mode:'managed',started_at:new Date().toISOString()});
 await emit(turn,'thinking','读取本地合成图谱，核对本轮方向。');
 await s.appendActivity({worker:'planner',kind:'tool_use',tool:'context_search',tool_use_id:`read-${turn}`,summary:'{"query":"LOCAL evidence"}',detail:'{"query":"LOCAL evidence"}',metadata:{turn_id:turn}});
 await s.appendActivity({worker:'planner',kind:'tool_result',tool:'context_search',tool_use_id:`read-${turn}`,summary:'本地资料已返回',detail:'{"items":[]}',metadata:{turn_id:turn}});
 if(state==='running')continue;
 await emit(turn,'text',state==='failed'?'本地合成失败场景，未生成规划方向。':'本轮合成规划记录已保存。',{final_answer:state==='completed',stream_id:`response-${turn}`,response:{stop_reason:'stop',has_tools:false,model:'LOCAL fixture',provider:'synthetic',usage:{input:10,output:2}}});
 await finishPlannerDisplayRound(db,task.exploration_id,turn,title);
 await emit(turn,'result',state==='failed'?'本地合成故障':'规划轮完成',{event_type:'lifecycle',status:state});
}
await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task.id]);
const engine=new Engine(db,defaultEngineConfig(),async()=>{throw Error('UI fixture forbids model requests');},dir),jwt=randomUUID();
const app=buildApp({db,engine,jwtKey:jwt,dataDir:dir,skillsRoot:dir,version:'planner-round-isolated',startedAt:Date.now()});
await app.listen({host:'127.0.0.1',port:18989});
writeFileSync(`${dir}/token`,signJWT(jwt),{mode:0o600});
writeFileSync(`${dir}/state.json`,JSON.stringify({task:task.id,boundaries,database:`fate_planner_ui_${process.pid}`}));
console.log(JSON.stringify({task:task.id,boundaries,port:18989}));
let finished=false;
process.stdin.on('data',async data=>{
 if(finished||!String(data).includes('finish'))return;finished=true;
 await emit('live','text','本轮仅复核已有合成结果。',{final_answer:true,stream_id:'live-final',response:{stop_reason:'stop',has_tools:false,model:'LOCAL fixture',provider:'synthetic',usage:{input:10,output:2}}});
 await finishPlannerDisplayRound(db,task.exploration_id,'live','复核本地合成证据并收官');
 await emit('live','result','规划轮完成',{event_type:'lifecycle',status:'completed'});
 await db.query("UPDATE tasks SET status='done' WHERE id=$1",[task.id]);
 console.log('LOCAL title update committed');
});
process.on('SIGTERM',async()=>{await engine.shutdown();await app.close();await db.close();process.exit(0);});
