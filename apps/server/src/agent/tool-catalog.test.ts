import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {openDatabase,type Database} from '../db/index.js';
import {catalogTools,previewRoleTools,builtinDefinitions} from './tool-catalog.js';
import {toolIdentity,ACTIVE_ROLES} from './tool-registry.js';
import {prepareToolLoading} from './tool-loading.js';
import {workerTools} from '../tools/index.js';
import {legacyReadCandidates} from '../tools/legacy-reads.js';
import {runContext} from '../tools/context.js';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
let db:Database;const name=`fate_catalog_${process.pid}`;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();await db.query("INSERT INTO tools(key,system,kind) VALUES('create_mcp',true,'builtin') ON CONFLICT DO NOTHING");});
afterAll(async()=>{await db?.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name}`);await c.end();});
it('all seven previews use real schemas and never include Retester capabilities',async()=>{
 const catalog=await catalogTools(db);expect(catalog.roles.map(r=>r.role)).toEqual([...ACTIVE_ROLES]);
 for(const role of catalog.roles){expect(role.resident).not.toContain('record_finding_retest_result');expect(role.mcp.schema_counted).toBe(false);}
 expect(catalog.tools.find(t=>t.key==='create_mcp')).toMatchObject({implementation_status:'unsupported',schema_source:'unavailable'});
 expect(catalog.tools.find(t=>t.key==='insert_assets')!.schema.properties).not.toHaveProperty('items');
 expect(catalog.tools.find(t=>t.key==='insert_assets')!.schema.properties).toHaveProperty('assets');
 for(const [key] of builtinDefinitions(db))expect(toolIdentity(key).implementation_status,key).not.toBe('unsupported');
 console.log('LOADOUT_BUDGET',JSON.stringify(catalog.roles.map(({role,resident,deferred,schema_bytes})=>({role,resident,deferred,schema_bytes}))));
 const w=catalog.roles.find(r=>r.role==='worker')!;expect(w.resident).toHaveLength(11);
 const planner=catalog.roles.find(r=>r.role==='planner')!;
 expect(planner.resident).toContain('asset_search');expect(planner.resident).toContain('asset_get');
 expect((planner.schemas.add_intent as any).properties.contract.properties.basis.description).toContain('不可引用 goal/intent');
 // Explicit role requirements (Planner asset reads, Main goal/constraints)
 // are resident; explicitly budget their Schema
 // rather than forcing a failed call before every planned lookup.
 for(const role of ['worker','planner','mainagent']){const r=catalog.roles.find(r=>r.role===role)!;expect(r.schema_bytes.resident/r.schema_bytes.before).toBeLessThanOrEqual(role==='planner'?0.8:role==='mainagent'?0.75:0.7);}
});
it('activates explicitly required intent tools within current bindings while unrelated tools remain deferred',async()=>{
 const ctx=runContext(db,1,1,'worker'),tools=workerTools(ctx);
 const options={customTools:tools,toolAllowlist:tools.map(t=>t.name),systemPrompt:'LOCAL role',taskContext:'Current intent needs asset_get for its bound asset'};
 const loaded=await prepareToolLoading(db,'worker',options,false);
 expect(loaded.toolLoading.initialActive).toContain('asset_get');expect(loaded.toolLoading.referencedActive).toContain('asset_get');expect(loaded.toolLoading.deferred).toContain('asset_search');
 await db.query("UPDATE tools SET enabled=false WHERE key='asset_get'");
 try{const revoked=await prepareToolLoading(db,'worker',options,false);expect(revoked.toolAllowlist).not.toContain('asset_get');expect(revoked.toolLoading.initialActive).not.toContain('asset_get');}finally{await db.query("UPDATE tools SET enabled=true WHERE key='asset_get'");}
 const unbound=await prepareToolLoading(db,'worker',{customTools:[],toolAllowlist:[],systemPrompt:'Call asset_get and shell_open',taskContext:'asset_get'},false);
 expect(unbound.toolAllowlist).toEqual([]);
});
it('disabled search uses direct fallback without re-enabling retired aliases',async()=>{
 await db.query("UPDATE tools SET enabled=false WHERE key='tool_search'");
 const p=await previewRoleTools(db,'worker');expect(p.deferred).toEqual([]);expect(p.resident).not.toContain('tool_search');expect(p.fallback).toContain('禁用');
 await db.query("UPDATE tools SET enabled=true WHERE key='tool_search'");
 await db.query("UPDATE tools SET enabled=false WHERE key='context_get'");
 const denied=await previewRoleTools(db,'worker');expect([...denied.resident,...denied.deferred]).not.toContain('read_tool_output');expect([...denied.resident,...denied.deferred]).not.toContain('context_get');
 await db.query("UPDATE tools SET enabled=true WHERE key='context_get'");
});
it('restores referenced legacy reads and parameters without expanding a new role or bypassing switches',async()=>{
 const ctx=runContext(db,1,1,'worker'),tools=workerTools(ctx);
 const options={customTools:tools,toolAllowlist:tools.map(t=>t.name),legacyTools:legacyReadCandidates(ctx),systemPrompt:'Use node_detail. Call insert_assets with items.'} as never;
 let loaded=await prepareToolLoading(db,'worker',options,false);
 expect(loaded.toolLoading.compatibility).toContain('node_detail');
 expect((loaded.customTools.find(t=>t.name==='insert_assets')!.parameters as any).properties.items).toBeDefined();
 await db.query("UPDATE tools SET enabled=false WHERE key='node_detail'");
 loaded=await prepareToolLoading(db,'worker',options,false);expect(loaded.toolAllowlist).not.toContain('node_detail');
 await db.query("UPDATE tools SET enabled=true WHERE key='node_detail'");
 const root=mkdtempSync(path.join(tmpdir(),'fate-legacy-tools-'));
 try{
  const session=path.join(root,'session.jsonl');writeFileSync(session,JSON.stringify({type:'message',message:{role:'assistant',content:[]}})+'\n');
  loaded=await prepareToolLoading(db,'worker',{...(options as any),systemPrompt:'LOCAL',resumeSessionPath:session},false);
  expect(loaded.toolLoading.compatibility).toContain('node_detail');expect(loaded.toolLoading.fallback).toContain('旧会话');
  mkdirSync(path.join(root,'fixture'));writeFileSync(path.join(root,'fixture','SKILL.md'),'Read node_detail; insert_assets uses items.');
  loaded=await prepareToolLoading(db,'worker',{...(options as any),systemPrompt:'LOCAL',skillsDir:root,allowedSkills:['fixture']},false);
  expect(loaded.toolLoading.compatibility).toContain('node_detail');
  loaded=await prepareToolLoading(db,'worker',{...(options as any),systemPrompt:'LOCAL'},false);
  expect(loaded.toolAllowlist).not.toContain('node_detail');
  expect((loaded.customTools.find(t=>t.name==='insert_assets')!.parameters as any).properties.items).toBeUndefined();
 }finally{rmSync(root,{recursive:true,force:true});}
});
