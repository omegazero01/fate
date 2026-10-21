import {domainState} from './src/agent/domain-state.js';
import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from './src/db/index.js';
import {makeModelResolver} from './src/pi/modelResolver.js';
import {createTrackedRunner,runtimeConfiguration,recoverExpiredRuntimes} from './src/engine/runtime-config.js';
import {roleResources} from './src/agent/resources.js';

const name=`fate_platform_${process.pid}`,dir=mkdtempSync(path.join(tmpdir(),'fate-platform-'));
let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;process.env.SERIES_LOG_LEVEL='silent';db=await openDatabase();});
afterAll(async()=>{await db?.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});await admin.connect();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();rmSync(dir,{recursive:true,force:true});});

describe('platform adaptation integration',()=>{
  it('recovers only the expired runtime and its in-flight model attempts, preserving concurrent Workers',async()=>{
    const task=await db.tasks().createTaskWithOptions('LOCAL crash audit','LOCAL',{});
    const profile=await db.platform().saveProfile({name:'LOCAL crash audit',model:'fixture',apiKey:'fixture',format:'openai'});
    await db.query('INSERT INTO task_llm_profiles(task_id,profile_id,position) VALUES($1,$2,0)',[task.id,profile]);
    const faux=fauxProvider({provider:'runtime-audit'}),modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
    const resolver=makeModelResolver(db,async()=>({modelRuntime,model:faux.getModel() as never}));
    const a=await resolver(task.id,'worker'),b=await resolver(task.id,'worker');
    const options={cwd:dir,agentDir:path.join(dir,'pi'),inMemory:true,systemPrompt:'LOCAL bounded Worker',toolAllowlist:[]};
    const ra=await createTrackedRunner(db,task.id,'worker',{...a,...options});
    const rb=await createTrackedRunner(db,task.id,'worker',{...b,...options});
    try{
      await a.modelRuntime.resolveModel(a.model,[],{reason:'continuation'});
      await b.modelRuntime.resolveModel(b.model,[],{reason:'continuation'});
      const rows=(await db.query('SELECT id,runtime_id FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[task.id])).rows;
      expect(rows).toHaveLength(2);expect(rows[0]!.runtime_id).toBeTruthy();expect(rows[0]!.runtime_id).not.toBe(rows[1]!.runtime_id);
      await db.query("UPDATE runtime_role_configs SET expires_at=now()-interval '1 second' WHERE id=$1",[rows[0]!.runtime_id]);
      expect(await recoverExpiredRuntimes(db)).toEqual({runtimes:1,requests:1});
      expect(await recoverExpiredRuntimes(db)).toEqual({runtimes:0,requests:0});
      const states=(await db.query('SELECT id,status,usage FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[task.id])).rows;
      expect(states[0]).toMatchObject({status:'aborted',usage:{unavailable:true}});expect(states[1]!.status).toBe('running');
      await expect(a.modelRuntime.resolveModel(a.model,[],{reason:'continuation'})).rejects.toThrow('执行器已过期');
      // A delayed reply can supply real usage, but cannot turn a reconciled
      // interrupted attempt back into success or overwrite its stop reason.
      const late=fauxAssistantMessage('late');late.usage={...late.usage,input:9,totalTokens:9};
      await a.modelPolicy!.onResponse(late);
      expect((await db.query('SELECT status,usage,error FROM llm_request_attempts WHERE id=$1',[rows[0]!.id])).rows[0]).toMatchObject({status:'aborted',usage:{input:9,totalTokens:9},error:expect.stringContaining('执行器失联')});
      expect((await runtimeConfiguration(db,{taskID:task.id})).active).toHaveLength(1);
    }finally{await ra.dispose();await rb.dispose();}
  });
  it.each(['domain','native'])('audits %s summary failover per request and exposes policy boundaries',async mode=>{
    await db.platform().setSetting('pi_context_policy',mode);
    const task=await db.tasks().createTaskWithOptions('LOCAL platform','LOCAL synthetic',{});
    const a=await db.platform().saveProfile({name:'LOCAL primary '+mode,model:'synthetic-a',apiKey:'fixture',format:'openai'});
    const b=await db.platform().saveProfile({name:'LOCAL fallback '+mode,model:'synthetic-b',apiKey:'fixture',format:'openai'});
    await db.query('INSERT INTO task_llm_profiles(task_id,profile_id,position) VALUES($1,$2,0),($1,$3,1)',[task.id,a,b]);
    const providers=new Map<number,ReturnType<typeof fauxProvider>>();
    const resolver=makeModelResolver(db,async profile=>{
      const faux=fauxProvider({provider:`platform-${profile.id}`,api:`platform-${profile.id}`});providers.set(profile.id,faux);
      const modelRuntime=await ModelRuntime.create({refreshOnCreate:false});await modelRuntime.registerNativeProvider(faux.provider);
      return {modelRuntime,model:faux.getModel() as never};
    });
    const source=await resolver(task.id,'mainagent');
    providers.get(a)!.setResponses([fauxAssistantMessage('LOCAL progress '.repeat(200)),fauxAssistantMessage('LOCAL pending'),fauxAssistantMessage('',{stopReason:'error',errorMessage:'401 invalid api key'})]);
    providers.get(b)!.setResponses([fauxAssistantMessage('LOCAL summary: pending intent, no authorized target.'),fauxAssistantMessage('LOCAL turn prefix summary.')]);
    const usage:unknown[]=[];
    const runner=await createTrackedRunner(db,task.id,'mainagent',{...source,cwd:dir,agentDir:path.join(dir,'pi'),inMemory:true,systemPrompt:'LOCAL Main only',toolAllowlist:[],compactionSettings:{keepRecentTokens:32},onActivity:e=>{if(e.kind==='usage')usage.push(e);}});
    try{
      await runner.prompt('LOCAL history '.repeat(200));await runner.prompt('continue');await runner.compact();
      const rows=(await db.query('SELECT purpose,status,profile_id,usage FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[task.id])).rows;
      expect(rows.slice(0,3).map(r=>[r.purpose,r.status])).toEqual([['conversation','completed'],['conversation','completed'],['compaction','failed']]);
      expect(rows.slice(3).every(r=>r.purpose==='compaction'&&r.status==='completed')).toBe(true);
      expect(Number(rows.at(-1)!.profile_id)).toBe(b);expect(usage).toHaveLength(rows.length);
      expect((await runtimeConfiguration(db,{taskID:task.id})).active[0].effective).toMatchObject({platform_policy:{compaction:mode,mcpLoading:'deferred'}});
      await db.platform().setSetting('pi_context_policy',mode==='domain'?'native':'domain');
      const config=await runtimeConfiguration(db,{taskID:task.id});expect(config.active[0].pending?.changed_fields).toContain('platform_policy');
      expect(config.active[0].effective).toMatchObject({platform_policy:{compaction:mode}});
    }finally{await runner.dispose();await db.platform().setSetting('pi_context_policy','domain');}
    expect((await db.query('SELECT effective FROM runtime_role_configs WHERE task_id=$1',[task.id])).rows[0].effective.compaction).toMatchObject({requests:expect.any(Number),completed:1,failed:0});
  });
  it('reads policy without connecting MCP, and keeps non-execution roles free of MCP',async()=>{
    for(const role of ['goals','reporter','retester'])expect((await roleResources(db,role)).mcpEntries).toBeUndefined();
    const task=await db.tasks().createTaskWithOptions('LOCAL targeted state','LOCAL',{});
    for(const role of ['reporter','retester'])expect(await domainState(db,role,task.id)).not.toHaveProperty('context');
  });
  it('keeps an already routed conversation attempt separate from an intervening compaction request',async()=>{
    const task=await db.tasks().createTaskWithOptions('LOCAL routing overlap','LOCAL',{});
    const profile=await db.platform().saveProfile({name:'LOCAL routing overlap',model:'fixture',apiKey:'fixture',format:'openai'});
    await db.query('INSERT INTO task_llm_profiles(task_id,profile_id,position) VALUES($1,$2,0)',[task.id,profile]);
    const faux=fauxProvider({provider:'overlap'}),runtime=await ModelRuntime.create({refreshOnCreate:false});await runtime.registerNativeProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('SUMMARY'),fauxAssistantMessage('CONVERSATION')]);
    const source=await makeModelResolver(db,async()=>({modelRuntime:runtime,model:faux.getModel() as never}))(task.id,'mainagent');
    // SDK can route the upcoming conversation before discovering it needs compaction.
    const routed=await source.modelRuntime.resolveModel(source.model,[],{reason:'continuation'});
    source.modelPolicy!.setPurpose!('compaction');
    const summary=await source.modelRuntime.completeSimple(source.model,{messages:[{role:'user',content:'summary',timestamp:Date.now()}]});
    await source.modelPolicy!.onResponse(summary);source.modelPolicy!.setPurpose!('conversation');
    const reply=await source.modelRuntime.completeSimple(routed.model,{messages:[{role:'user',content:'continue conversation',timestamp:Date.now()}]});
    await source.modelPolicy!.onResponse(reply);await source.modelPolicy!.finish!();
    const rows=(await db.query('SELECT purpose,status,usage FROM llm_request_attempts WHERE task_id=$1 ORDER BY id',[task.id])).rows;
    expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({purpose:'conversation',status:'completed',usage:reply.usage});
    expect(rows[1]).toMatchObject({purpose:'compaction',status:'completed',usage:summary.usage});
  });
  it('preserves denied MCP tools and falls back to direct exposure when search is explicitly disabled',async()=>{
    const server=await db.platform().saveMCP({name:'LOCAL resource policy',transport:'stdio',command:process.execPath,args:[],env:{},url:'',enabled:true,insecure:false});
    const agent=(await db.platform().getAgentByKey('worker'))!;
    await db.query("INSERT INTO agent_visibility(agent_id,resource_kind,resource_id,mcp_tool_name,enabled) VALUES($1,'mcp',$2,'',true),($1,'mcp',$2,'denied',false)",[agent.id,server]);
    expect((await roleResources(db,'worker')).mcpEntries?.find(e=>e.name==='LOCAL resource policy')?.config).toMatchObject({exposure:'deferred',toolExposure:{denied:'hidden'}});
    await db.query("INSERT INTO tools(key,enabled,agents) VALUES('tool_search',false,'[\"worker\"]') ON CONFLICT(key) DO UPDATE SET enabled=false");
    try{
      expect((await roleResources(db,'worker')).mcpEntries?.find(e=>e.name==='LOCAL resource policy')?.config).toMatchObject({exposure:'direct',toolExposure:{denied:'hidden'}});
      await db.query('UPDATE mcp_servers SET enabled=false WHERE id=$1',[server]);
      expect((await roleResources(db,'worker')).mcpEntries).toEqual([]);
    }finally{await db.query("DELETE FROM tools WHERE key='tool_search'");}
  });
});
