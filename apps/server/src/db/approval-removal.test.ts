import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {openDatabase,type Database} from './index.js';
import {Engine,defaultEngineConfig} from '../engine/engine.js';
import {buildApp} from '../http/app.js';
import {signJWT} from '../http/auth.js';
import {runContext} from '../tools/context.js';
import {insertAssetsTool} from '../tools/assets.js';
import {recordFactTool} from '../tools/graph.js';
import {addIntentTool} from '../tools/intents.js';
import {resolveGraphNode} from './graph_view.js';
import {authorizeTaskRequest} from '../egress/gateway.js';
import {authorizeEvidence} from '../evidence/authorization.js';
import {createHash} from 'node:crypto';
import {loadToolOutput} from '../evidence/tool-outputs.js';
import {WORKER_PROMPT} from '../agent/prompts.js';
import {TOOL_DESCRIPTIONS,ARTEX_PREVIOUS_TOOL_DESCRIPTIONS} from '../agent/tool-descriptions.js';

const name=`fate_retire_approvals_${process.pid}`;
const dir=mkdtempSync(path.join(tmpdir(),'fate-retire-'));
let db:Database,engine:Engine,app:ReturnType<typeof buildApp>,task:number,exp:number,asset:number;
const key='local-removal-regression',headers={'x-series-token':signJWT(key)};
async function call(tool:any,args:any,id='local-'+Math.random()){
 const result=await tool.execute(id,args,undefined,undefined,{});
 if(result.isError)throw new Error(result.content[0].text);
 return JSON.parse(result.content[0].text);
}
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;
 db=await openDatabase();
 const t=await db.tasks().createTaskWithOptions('LOCAL approval retirement','',{executionMode:'managed'});
 task=t.id;exp=t.exploration_id;
 asset=await db.assets().upsertSubdomain({domain:'local.retirement.invalid',taskID:task});
 // Reconstruct the relevant old schema and a pending manual approval. The old
 // trigger deliberately fails if migration forgets to remove it before writes.
 await db.query(`DELETE FROM retired_feature_data WHERE feature='approvals';
 ALTER TABLE tasks ADD COLUMN asset_approval_template TEXT DEFAULT 'explicit_targets';
 ALTER TABLE task_asset_links ADD COLUMN approval_state TEXT DEFAULT 'blocked', ADD COLUMN approved_at TIMESTAMPTZ,
 ADD COLUMN approved_by TEXT, ADD COLUMN approval_reason TEXT DEFAULT 'legacy block';
 CREATE TABLE task_asset_blocks(task_id BIGINT,asset_key TEXT,reason TEXT,host_key TEXT,block_kind TEXT);
 CREATE TABLE intercept_rules(id BIGINT,name TEXT);
 CREATE TABLE intercept_pending(id BIGINT,status TEXT,task_id BIGINT);
 CREATE FUNCTION apply_task_asset_template() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'old approval trigger still active'; END $$;
 CREATE TRIGGER trg_apply_asset_template BEFORE INSERT OR UPDATE ON task_asset_links FOR EACH ROW EXECUTE FUNCTION apply_task_asset_template();
 CREATE FUNCTION task_asset_effective_approval_state(BIGINT,BIGINT) RETURNS TEXT LANGUAGE sql AS $$ SELECT 'blocked'::text $$;
 INSERT INTO task_asset_blocks VALUES(${task},'old-host','blocked','old-host','explicit');
 INSERT INTO intercept_rules VALUES(1,'deny every command');
 INSERT INTO intercept_pending VALUES(1,'pending',${task});
 INSERT INTO settings(key,value) VALUES('intercept_enabled_tools','["bash"]'),('llm_judge_enabled','true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;`);
 const tasks=(await db.query('SELECT id,deleted_at,asset_approval_template FROM tasks WHERE id=$1 ORDER BY id',[task])).rows;
 const assets=(await db.query('SELECT task_id,asset_id,task_asset_effective_approval_state(task_id,asset_id) state FROM task_asset_links WHERE task_id=$1 ORDER BY task_id,asset_id',[task])).rows;
 const blocks=(await db.query('SELECT task_id,asset_key,host_key,block_kind FROM task_asset_blocks WHERE task_id=$1 ORDER BY task_id,asset_key',[task])).rows;
 const hash=createHash('sha256').update(JSON.stringify([tasks,assets,blocks])).digest('hex');
 await db.query(`INSERT INTO tool_output_artifacts(id,task_id,tool,tool_call_id,body,authorization_hash)
  VALUES('readable-old',$1,'context_search','old-1','old readable output',$2),('stale-old',$1,'context_search','old-2','old stale output','expired-scope')`,[task,hash]);
 await db.query("DELETE FROM settings WHERE key='pi_no_approvals_v1'");
 await db.platform().savePrompt((await db.platform().getAgentByKey('worker'))!.id,"你是 Worker，只执行领到的当前意图，在授权、约束和预算内完成它，然后停止。受阻时如实说明原因，不转向其他意图。\n边发现边写回，不必等到结束：新资产用 insert_assets 登记；新的探索结论用 record_fact 直接写入探索图；亲自验证且可复现的漏洞用 report_finding，报洞前 context_search(types=[\"finding\"]) 查重。记录提交成功后立即可见，已保存内容不重复写。把同一结论的观察合并为 summary、detail 和真实 evidence，不把每个属性拆成节点；独立的新结论可继续写回。推测与实测、负面观察要区分，不编造证据。\n按需 context_search/context_get 读取上下文；来源任务只读。新资产获准后才能访问，中间文件写当前工作目录，不向其他 Agent 发消息。\n结束前补齐已识别但未写回的结果，再简洁总结执行情况、关键结论、已写回的事实或漏洞 ID 与未完成原因。无新增事实可以直接总结，不为结束而制造记录。",'old builtin','test');
 await db.platform().savePrompt((await db.platform().getAgentByKey('mainagent'))!.id,'LOCAL customized Main prompt','custom','test');
 await db.query("UPDATE tools SET description=$1,enabled=false WHERE key='insert_assets'",[ARTEX_PREVIOUS_TOOL_DESCRIPTIONS.insert_assets]);
 await db.query("UPDATE tools SET description='LOCAL custom dispatch description' WHERE key='dispatch_intents'");
 await db.close();db=await openDatabase();
 engine=new Engine(db,defaultEngineConfig(),async()=>null,dir);
 app=buildApp({db,engine,version:'retirement-test',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});
});
afterAll(async()=>{
 await engine?.shutdown();await app?.close();await db?.close();
 const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});
 await admin.connect();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();
 rmSync(dir,{recursive:true,force:true});
});
it('archives legacy decisions once and removes active tables, columns, triggers and judge settings',async()=>{
 const archived=(await db.query("SELECT data FROM retired_feature_data WHERE feature='approvals' AND source='intercept_pending'")).rows[0]!.data;
 expect(archived).toEqual([{id:1,status:'pending',task_id:task}]);
 expect((await db.query("SELECT to_regclass('intercept_rules') rules,to_regclass('task_asset_blocks') blocks")).rows[0]).toEqual({rules:null,blocks:null});
 expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='task_asset_links' AND column_name='approval_state'")).rowCount).toBe(0);
 expect(await db.platform().getSetting('llm_judge_enabled')).toBeNull();
 await db.query("UPDATE task_asset_links SET source_summary='after upgrade' WHERE task_id=$1",[task]);
 const again=await openDatabase();
 try{expect((await again.query("SELECT data FROM retired_feature_data WHERE feature='approvals' AND source='intercept_pending'")).rows[0]!.data).toEqual(archived);}
 finally{await again.close();}
 expect(await db.assets().getByIDs([asset])).toHaveLength(1);
});
it('upgrades exact defaults and readable outputs while preserving custom configuration and stale-access rejection',async()=>{
 expect(await loadToolOutput(db,'readable-old',{taskID:task})).toBe('old readable output');
 await expect(loadToolOutput(db,'stale-old',{taskID:task})).rejects.toThrow('授权范围已变化');
 const worker=(await db.platform().getAgentByKey('worker'))!,main=(await db.platform().getAgentByKey('mainagent'))!;
 expect(await db.platform().currentPrompt(worker.id)).toBe(WORKER_PROMPT);
 expect(await db.platform().currentPrompt(main.id)).toBe('LOCAL customized Main prompt');
 expect((await db.query("SELECT 1 FROM agent_prompts WHERE agent_id=$1 AND template_text LIKE '%新资产获准后才能访问%'",[worker.id])).rowCount).toBe(1);
 expect((await db.query("SELECT description,enabled FROM tools WHERE key='insert_assets'")).rows[0]).toEqual({description:TOOL_DESCRIPTIONS.insert_assets,enabled:false});
 expect((await db.query("SELECT description FROM tools WHERE key='dispatch_intents'")).rows[0]!.description).toBe('LOCAL custom dispatch description');
});
it('removes approval APIs while preserving authenticated asset management',async()=>{
 for(const url of ['/api/intercept/rules','/api/intercept/pending',`/api/tasks/${task}/asset-approvals`,`/api/tasks/${task}/asset-approval-template`]){
  expect((await app.inject({url,headers})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(404);
 }
 const response=await app.inject({url:`/api/assets?task_id=${task}`,headers});
 expect(response.statusCode).toBe(200);expect(response.json().assets[0]).not.toHaveProperty('approval_state');
 await db.assets().upsertRootDomain({domain:'unrelated-count.invalid'});
 const counts=(await app.inject({url:`/api/assets/counts?task_id=${task}`,headers})).json() as Record<string,number>;
 expect(Object.values(counts).reduce((a,b)=>a+b,0)).toBe(response.json().total);
 expect((await app.inject({url:'/api/assets/counts?task_id=invalid',headers})).statusCode).toBe(400);
 expect((await app.inject({url:`/api/assets?task_id=${task}`})).statusCode).toBe(401);
});
it('Planner can dispatch discovered assets and Worker writes are immediately visible and idempotent',async()=>{
 const main=runContext(db,task,exp,'mainagent',{mainSegment:0,hooks:{assertOwnership:async()=>{}}});
 const saved=await call(insertAssetsTool(main),{items:[{type:'subdomain',domain:'new.retirement.invalid'}]});
 const id=saved.assets[0].asset_id;
 const planner=runContext(db,task,exp,'planner');
 const order=await call(addIntentTool(planner),{intents:[{summary:'LOCAL discovered host',asset_ids:[id]}]});
 const intent=order.intents[0].intent_id;
 await db.query("UPDATE tasks SET status='running' WHERE id=$1",[task]);
 await db.query("UPDATE exploration_nodes SET payload=payload||'{\"dispatch_requested\":true}' WHERE id=$1",[intent]);
 expect((await db.exploration(exp).claimNextWorker('work#removal'))?.id).toBe(intent);
 const worker=runContext(db,task,exp,'worker',{intentID:intent,workerName:'work#removal'});
 const observation={summary:'LOCAL observation',evidence:'local deterministic fixture',confidence:'high',asset_ids:[id]};
 const a=await call(recordFactTool(worker),observation,'same-call');
 const b=await call(recordFactTool(worker),observation,'same-call');expect(b).toEqual(a);
 const facts=await db.exploration(exp).listByKind('fact');
 const fact=facts.find(n=>n.payload.summary==='LOCAL observation')!;
 expect((await resolveGraphNode(db,task,exp,fact.id)).node.state).toBe('confirmed');
 expect((await db.exploration(exp).getNode(intent))?.state).toBe('running');
 await expect(authorizeTaskRequest(db,task,'previously-unlisted.invalid',9001,`worker:${intent}`)).resolves.toBeUndefined();
 await expect(authorizeEvidence(db,{task_id:task,intent_id:intent,url:'https://previously-unlisted.invalid'},task)).resolves.toBeUndefined();
 const other=await db.tasks().createTaskWithOptions('LOCAL unrelated','',{});
 await expect(db.taskScope().validateTaskAssets(other.id,[id])).rejects.toThrow('不属于');
 await expect(resolveGraphNode(db,other.id,other.exploration_id,fact.id)).rejects.toThrow('不属于');
 await expect(authorizeTaskRequest(db,task,'any.invalid',80,`worker:${intent}:expired-token`)).rejects.toThrow('租约');
 await db.query('UPDATE tasks SET paused=true WHERE id=$1',[task]);
 await expect(authorizeTaskRequest(db,task,'any.invalid',80,`worker:${intent}`)).rejects.toThrow('暂停');
});
it('detaching and rediscovering an asset does not create a blocking tombstone',async()=>{
 expect((await app.inject({method:'DELETE',url:`/api/tasks/${task}/assets/${asset}`,headers})).statusCode).toBe(200);
 await db.assets().upsertSubdomain({domain:'local.retirement.invalid',taskID:task});
 await expect(db.taskScope().validateTaskAssets(task,[asset])).resolves.toBeUndefined();
});
