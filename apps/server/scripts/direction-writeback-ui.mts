// Local-only, persisted UI acceptance fixture. No model or target requests.
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {postgresDSN} from '../src/config/index.js';
import {openDatabase} from '../src/db/index.js';
import {Engine,defaultEngineConfig} from '../src/engine/engine.js';
import {buildApp} from '../src/http/app.js';
import {signJWT} from '../src/http/auth.js';
import {runContext} from '../src/tools/context.js';
import {recordFactTool} from '../src/tools/graph.js';
import {insertAssetsTool} from '../src/tools/assets.js';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';

const connection=new URL(postgresDSN().dsn);connection.pathname=`/fate_direction_ui_${process.pid}`;
process.env.SERIES_PG_DSN=connection.toString();process.env.SERIES_LOG_LEVEL='silent';
const db=await openDatabase(),dir='/tmp/fate-direction-ui';mkdirSync(dir,{recursive:true});
const task=await db.tasks().createTaskWithOptions('本地验收：方向派单与结论写回','仅验证写回展示，不访问任何目标',{executionMode:'manual'});
const store=db.exploration(task.exploration_id),intent=await store.addIntent({summary:'整理本地论坛接口合成资料并保存测试结论'},1,[],'user');
await db.query("UPDATE exploration_nodes SET state='running',owner='work#1' WHERE id=$1",[intent]);
const ctx={...runContext(db,task.id,task.exploration_id,'worker'),intentID:intent,workerName:'work#1'};
const turn='writeback-ui-complete';
const activity=(kind:string,extra:Record<string,unknown>={})=>store.appendActivity({worker:'work#1',node_id:intent,kind,...extra,metadata:{turn_id:turn,...extra.metadata as object}});
await activity('status',{metadata:{event_type:'turn_start',role:'worker',started_at:new Date(Date.now()-45000).toISOString(),mode:'manual'}});
async function call(id:string,tool:ToolDefinition,args:unknown){
 await activity('tool_use',{tool:tool.name,tool_use_id:id,summary:JSON.stringify(args),detail:JSON.stringify(args)});
 const r=await tool.execute(id,args as never,undefined,undefined,{} as never),text=(r.content[0] as {text:string}).text;
 if(r.isError)throw Error(text);
 await activity('tool_result',{tool:tool.name,tool_use_id:id,summary:text,detail:text});return JSON.parse(text);
}
const assets=await call('ui-assets',insertAssetsTool(ctx),{assets:[
 {type:'endpoint',url:'http://127.0.0.1:18899/forumProblemListPage',method:'GET',params:[{name:'page',location:'query'}]},
 {type:'endpoint',url:'http://127.0.0.1:18899/saveProblem',method:'POST',params:[{name:'content',location:'body'}]},
]});
if(assets.errors?.length)throw Error(JSON.stringify(assets.errors));
const fact=await call('ui-fact',recordFactTool(ctx),{asset_ids:[assets.results[0].id],scope:{tested:'仅 GET 入口的本地合成观察',not_tested:'POST 写接口未测试'},summary:'在本次合成测试范围内，未发现可利用的 SQL 注入。',evidence:'LOCAL synthetic evidence，未发送目标请求。',observation_type:'negative',confidence:'high',detail:'待核实线索：匿名论坛提问写入尚未验证，不能作为漏洞报告。测试影响：两条合成测试记录，清理建议仅为展示夹具；未对真实系统执行写入。'});
await store.addNode('fact',{summary:'旧记录，测试范围未说明',evidence:'Original LOCAL evidence'},0,'confirmed','legacy',[assets.results[1].id]);
const prose='本次结论：在已测试的合成资料范围内，未发现可利用的 SQL 注入。匿名写入仅为待验证线索。\n\n原始测试说明：\n'+('仅使用本地合成资料；方法、证据与参数保留在已保存记录中。\n'.repeat(12))+'\n测试影响：合成记录用于验证界面，没有目标请求。';
await activity('result',{summary:prose,detail:prose,metadata:{event_type:'outcome',status:'done'}});
await db.query("UPDATE exploration_nodes SET state='done',completed_at=now(),owner=NULL WHERE id=$1",[intent]);
await db.query("UPDATE tasks SET status='done' WHERE id=$1",[task.id]);
const engine=new Engine(db,defaultEngineConfig(),async()=>null,dir),jwt=randomUUID();
const app=buildApp({db,engine,jwtKey:jwt,dataDir:dir,skillsRoot:dir,version:'direction-isolated-ui',startedAt:Date.now()});
await app.listen({host:'127.0.0.1',port:19087});
writeFileSync(`${dir}/token`,signJWT(jwt),{mode:0o600});
writeFileSync(`${dir}/state.json`,JSON.stringify({task_id:task.id,intent_id:intent,turn_id:turn,assets:assets.results,fact_id:fact.fact_id,database:connection.pathname.slice(1)}));
console.log(JSON.stringify({task_id:task.id,intent_id:intent,port:19087}));
process.on('SIGTERM',async()=>{await engine.shutdown();await app.close();await db.close();process.exit(0);});
