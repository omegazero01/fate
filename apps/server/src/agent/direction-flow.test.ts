import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {openDatabase,type Database} from '../db/index.js';
import {runContext} from '../tools/context.js';
import {addIntentTool} from '../tools/intents.js';
import {recordFactTool} from '../tools/graph.js';
import {reportFindingTool} from '../tools/findings.js';
import {assetCoverage,queryAssets,coverageGraph} from '../db/asset-query.js';
import {migrateDirectionWriteback} from './direction-migration.js';
import {DIRECTION_PREVIOUS_TOOL_DESCRIPTIONS,TOOL_DESCRIPTIONS} from './tool-descriptions.js';
import {readFileSync} from 'node:fs';
import {PLANNER_PROMPT,WORKER_PROMPT} from './prompts.js';

const name=`fate_direction_${process.pid}`;let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();});
async function call(tool:any,args:any,id=crypto.randomUUID()){const r=await tool.execute(id,args,undefined,undefined,{});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
async function fixture(){
 const task=await db.tasks().createTaskWithOptions('LOCAL direction fixture','',{executionMode:'managed'}),s=db.exploration(task.exploration_id);
 const assets=await Promise.all(['entry','users','billing'].map(h=>db.assets().upsertHTTPService({url:`http://${h}.direction.invalid`,taskID:task.id})));
 const planned=await call(addIntentTool(runContext(db,task.id,task.exploration_id,'planner')),{summary:'探索用户服务的身份边界',asset_ids:assets,contract:{out_of_scope:['不修改数据']}});
 const id=planned.intents[0].intent_id;await s.claimNextWorker('w');
 return {task,s,assets,id,c:runContext(db,task.id,task.exploration_id,'worker',{intentID:id,workerName:'w'})};
}
it('accepts a direction plus boundary and groups related observations with precise writeback',async()=>{
 const {task,s,assets,id,c}=await fixture();
 const intent=(await s.getNode(id))!;expect(intent.payload.contract).toMatchObject({objective:'探索用户服务的身份边界',acceptance:['探索用户服务的身份边界'],out_of_scope:['不修改数据']});
 const args={summary:'两条只读用户查询均拒绝匿名访问',evidence:'GET /me: 401; GET /users: 401',observation_type:'negative',asset_ids:[assets[1]],scope:{tested:'匿名请求 /me、/users 两个只读入口',not_tested:'登录后的跨用户访问；其他入口',limitations:'仅匿名身份及两个样本'}};
 const saved=await call(recordFactTool(c),args,'grouped'),retry=await call(recordFactTool(c),args,'grouped');
 expect(retry).toEqual(saved);expect(saved.asset_ids).toEqual([assets[1]]);expect(saved.writeback.coverage_eligible).toBe(true);
 expect((await s.listByKind('fact')).filter(n=>n.payload.from_intent===id)).toHaveLength(1);expect(await s.anchorAssetIDs(saved.fact_id)).toEqual([assets[1]]);
 expect((await s.getNode(saved.fact_id))!.payload).toMatchObject({from_intent:id,scope:args.scope});
 expect((await assetCoverage(db,task.id)).tested).toBe(1);
 expect((await queryAssets(db,{taskID:task.id,tested:true})).assets.map(a=>a.id)).toEqual([assets[1]]);
 expect((await coverageGraph(db,task.id)).nodes.filter(n=>n.tested).map(n=>n.asset_id)).toEqual([assets[1]]);
 // Withdrawing the actual report removes the projection; no stale tested boolean survives.
 await db.query("UPDATE exploration_nodes SET state='dismissed' WHERE id=$1",[saved.fact_id]);
 expect((await assetCoverage(db,task.id)).tested).toBe(0);
});
it('preserves unspecified scope/assets and inferred observations without turning them into coverage',async()=>{
 const {task,s,assets,id,c}=await fixture();
 const absent=await call(recordFactTool(c),{summary:'有待核实的发现',evidence:'LOCAL hint',confidence:'high'});
 expect(absent.asset_ids).toEqual([]);expect(absent.writeback.gaps).toEqual(['asset_ids','scope','observation_type']);
 expect((await s.getNode(absent.fact_id))!.payload.observation_type).toBe('unknown');
 const partial=await call(recordFactTool(c),{summary:'范围未说明',evidence:'LOCAL 200',asset_ids:[assets[0]],observation_type:'observed'});
 expect(partial.writeback.gaps).toEqual(['scope']);
 const inferred=await call(recordFactTool(c),{summary:'推断',evidence:'LOCAL hint',asset_ids:[assets[0]],scope:{tested:'入口页面'},observation_type:'inferred'});
 expect(inferred.writeback.coverage_eligible).toBe(false);expect((await assetCoverage(db,task.id)).tested).toBe(0);
 await expect(call(recordFactTool(c),{summary:'invalid',evidence:'local',scope:{tested:' '}})).rejects.toThrow('不能为空');
 expect((await s.listByKind('fact')).filter(n=>n.payload.from_intent===id)).toHaveLength(3);
});
it('reports only explicitly affected finding assets, retaining intent provenance and retry identity',async()=>{
 const {task,s,assets,id,c}=await fixture();let notices=0;c.hooks.notifyFinding=()=>{notices++;};
 const args={summary:'LOCAL synthetic finding',vulnclass:'fixture',severity:'low',evidence:'LOCAL proof',asset_ids:[assets[2],assets[1],assets[2]],scope:{tested:'两个同源入口在本地夹具中复现',not_tested:'其他入口'}};
 const saved=await call(reportFindingTool(c),args,'finding'),retry=await call(reportFindingTool(c),args,'finding');
 expect(retry).toEqual(saved);expect(notices).toBe(1);expect(saved.asset_ids).toEqual([assets[1],assets[2]]);
 expect((await s.getNode(saved.finding_node_id))!.payload.from_intent).toBe(id);
 expect((await assetCoverage(db,task.id)).tested).toBe(2);
 await db.query("UPDATE findings SET status='false_positive' WHERE id=$1",[saved.finding_id]);
 expect((await assetCoverage(db,task.id)).tested).toBe(0);
 const unbound=await call(reportFindingTool(c),{...args,asset_ids:undefined});expect(unbound.asset_ids).toEqual([]);
});
it('keeps legacy links and reports their uncertain scope, including inherited evidence',async()=>{
 const {task,s,assets,c}=await fixture();
 const historical=await s.addNode('fact',{summary:'Old result',evidence:'Original content'},0,'confirmed','legacy',[assets[0]!]);
 await db.query('UPDATE task_asset_links SET tested=true WHERE task_id=$1 AND asset_id=$2',[task.id,assets[0]]);
 const child=await db.tasks().createTaskWithOptions('LOCAL child','',{executionMode:'managed'});
 await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[child.id,task.id]);
 expect(await assetCoverage(db,child.id)).toMatchObject({tested:0,legacy_unverified:1});
 expect((await queryAssets(db,{taskID:child.id,ids:[assets[0]!]})).assets[0]).toMatchObject({tested:false,legacy_tested:true,inherited:true});
 await call(recordFactTool(c),{summary:'Rechecked local evidence',evidence:'LOCAL result',asset_ids:[assets[0]],observation_type:'observed',scope:{tested:'Rechecked one entry',not_tested:'Other directions'}});
 expect(await assetCoverage(db,child.id)).toMatchObject({tested:1,legacy_unverified:0});
 expect((await s.getNode(historical))!.payload.evidence).toBe('Original content');
});
it('upgrades descriptions once, preserving custom descriptions, disabled tools and original prompt versions',async()=>{
 await db.query("DELETE FROM settings WHERE key='direction_writeback_v1'");
 await db.query("UPDATE tools SET description=$1,enabled=false WHERE key='record_fact'",[DIRECTION_PREVIOUS_TOOL_DESCRIPTIONS.record_fact]);
 await db.query("UPDATE tools SET description='CUSTOM direction' WHERE key='add_intent'");
 const before=(await db.query('SELECT count(*) n FROM agent_prompts')).rows[0]!.n;
 await migrateDirectionWriteback(db);await migrateDirectionWriteback(db);
 expect((await db.platform().getTool('record_fact'))).toMatchObject({enabled:false,description:TOOL_DESCRIPTIONS.record_fact});
 expect((await db.platform().getTool('add_intent'))).toMatchObject({description:'CUSTOM direction'});
 expect((await db.query('SELECT count(*) n FROM agent_prompts')).rows[0]!.n).toBe(before);
});
it('appends exact default upgrades once and preserves a later explicit rollback and custom prompt',async()=>{
 const previous=JSON.parse(readFileSync(new URL('../../test-fixtures/direction-previous-prompts.json',import.meta.url),'utf8')) as Record<string,string>;
 const selected:Record<string,number>={};
 for(const role of ['planner','worker']){
  const agent=(await db.platform().getAgentByKey(role))!;
  const row=(await db.query(`INSERT INTO agent_prompts(agent_id,version,template_text,updated_by)
   SELECT $1,COALESCE(max(version),0)+1,$2,'test' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[agent.id,previous[role]])).rows[0]!;
  selected[role]=Number(row.id);await db.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[agent.id,row.id]);
 }
 await db.query("DELETE FROM settings WHERE key='direction_writeback_v1'");
 await migrateDirectionWriteback(db);
 for(const [role,text] of [['planner',PLANNER_PROMPT],['worker',WORKER_PROMPT]]){
  const agent=(await db.platform().getAgentByKey(role!))!;
  expect(await db.platform().currentPrompt(agent.id)).toBe(text);
  expect((await db.query('SELECT template_text FROM agent_prompts WHERE id=$1',[selected[role!]])).rows[0]!.template_text).toBe(previous[role!]);
 }
 const count=(await db.query('SELECT count(*) n FROM agent_prompts')).rows[0]!.n;
 await db.query("UPDATE agents SET current_prompt_id=$1 WHERE key='planner'",[selected.planner]);
 await migrateDirectionWriteback(db);
 expect((await db.query('SELECT count(*) n FROM agent_prompts')).rows[0]!.n).toBe(count);
 expect(await db.platform().currentPrompt((await db.platform().getAgentByKey('planner'))!.id)).toBe(previous.planner);
 // Even a one-character customization is not an exact built-in match.
 await db.query("UPDATE agent_prompts SET template_text=template_text||'!' WHERE id=$1",[selected.planner]);
 await db.query("DELETE FROM settings WHERE key='direction_writeback_v1'");
 await migrateDirectionWriteback(db);
 expect(await db.platform().currentPrompt((await db.platform().getAgentByKey('planner'))!.id)).toBe(previous.planner+'!');
});
