import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';import {tmpdir} from 'node:os';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelRuntime,SessionManager} from '@earendil-works/pi-coding-agent';
import {AgentRunner,type AgentRunnerOptions} from '../pi/runner.js';
import {plannerContextPolicy} from './planner-context-policy.js';
import {PLANNER_COMPACTION_RULES} from './planner-memory.js';

it('reduces total serialized input across ten resumed rounds including summary requests, retaining originals',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'planner-cost-'));
  const results=[];
  try{for(const mode of ['capacity','working_set'] as const){
    const cwd=path.join(dir,mode),file=path.join(cwd,'session.jsonl');
    const f=fauxProvider({provider:`local-cost-${mode}`,models:[{id:'synthetic',contextWindow:258000,maxTokens:8192}]}),runtime=await ModelRuntime.create({refreshOnCreate:false});
    await runtime.registerNativeProvider(f.provider);
    let executions=0,summaryCalls=0,ordinaryCalls=0,allBytes=0,summaryBytes=0;
    const evidence='LOCAL_NEGATIVE node:7 v2; tested scope=8000 only; pending node:9. '+' synthetic evidence '.repeat(14000);
    const base:AgentRunnerOptions={modelRuntime:runtime,model:f.getModel() as never,cwd,agentDir:path.join(cwd,'agent'),resumeSessionPath:file,
      systemPrompt:'Planner: synthetic evidence only; never repeat completed work.',toolAllowlist:['local_fixture'],
      customTools:[{name:'local_fixture',label:'LOCAL',description:'Local synthetic record',parameters:{type:'object',properties:{}},
        async execute(){executions++;return {content:[{type:'text',text:evidence}],details:{}};}}],
      platform:{role:'planner',taskID:1,policy:{version:'domain-v1',compaction:'native',mcpLoading:'direct'}},compactionInstructions:PLANNER_COMPACTION_RULES};
    const measure=(context:unknown)=>{const bytes=Buffer.byteLength(JSON.stringify(context));allBytes+=bytes;return bytes;};
    const seed=await AgentRunner.create(base);
    f.setResponses([context=>{measure(context);ordinaryCalls++;return fauxAssistantMessage([fauxToolCall('local_fixture',{})]);},
      context=>{measure(context);ordinaryCalls++;return fauxAssistantMessage('LOCAL_NEGATIVE node:7 v2 retained; pending node:9.');}]);
    try{await seed.prompt('Read local evidence once.');}finally{await seed.dispose();}
    const original=readFileSync(file,'utf8'),sessionID=SessionManager.open(file).getSessionId();
    const policy=plannerContextPolicy(258000,mode==='capacity'?'0':undefined);
    for(let round=0;round<10;round++){
      const runner=await AgentRunner.create({...base,contextPolicy:policy,compactionSettings:policy.compactionSettings,summaryMaxTokens:policy.summaryMaxTokens});
      f.setResponses(Array.from({length:5},()=>((context,options)=>{
        const bytes=measure(context);
        if(options?.maxTokens){summaryCalls++;summaryBytes+=bytes;expect(options.maxTokens).toBeLessThanOrEqual(2048);
          return fauxAssistantMessage('LOCAL_NEGATIVE node:7 v2 only port 8000; pending node:9; complete raw evidence remains in original session.');}
        ordinaryCalls++;expect(JSON.stringify(context.messages)).toContain('LOCAL_NEGATIVE');
        return fauxAssistantMessage('Wait for current work; no duplicate dispatch.');
      })));
      try{await runner.prompt(`Round ${round+1}: no new evidence.`);}finally{await runner.dispose();}
    }
    expect(executions).toBe(1);expect(ordinaryCalls).toBe(12);expect(readFileSync(file,'utf8').startsWith(original)).toBe(true);
    expect(SessionManager.open(file).getSessionId()).toBe(sessionID);
    const compactions=SessionManager.open(file).getEntries().filter(e=>e.type==='compaction').length;
    results.push({mode,ordinaryCalls,summaryCalls,compactions,allBytes,summaryBytes,estimatedTokens:Math.ceil(allBytes/3)});
  }
  expect(results[0]!.summaryCalls).toBe(0);expect(results[1]!.summaryCalls).toBeGreaterThan(0);
  expect(results[1]!.allBytes).toBeLessThan(results[0]!.allBytes*0.5);
  console.info('PLANNER_COST_SYNTHETIC',JSON.stringify({measurement:'serialized native model context bytes; estimated tokens=bytes/3; not provider usage or cache billing',results}));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
