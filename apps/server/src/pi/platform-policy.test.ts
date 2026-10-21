import {describe,it,expect} from 'vitest';
import {PLATFORM_ROLES,platformPolicy,validatePlatformRunner} from './platform-policy.js';

describe('platform role policy',()=>{
  it.each(PLATFORM_ROLES)('%s requires explicit role and tools, including when resuming',role=>{
    expect(()=>validatePlatformRunner(role,{cwd:'/tmp/session',toolAllowlist:[]},1)).toThrow('提示词');
    expect(()=>validatePlatformRunner(role,{cwd:'/tmp/session',systemPrompt:'CUSTOM'},1)).toThrow('工具集合');
    expect(()=>validatePlatformRunner(role,{cwd:'/tmp/session',systemPrompt:'CUSTOM',toolAllowlist:['read']},1)).not.toThrow();
  });
  it('enforces execution boundaries without removing explicitly bound Auto integrations',()=>{
    for(const role of ['goals','reporter'])
      expect(()=>validatePlatformRunner(role,{cwd:'/tmp/session',systemPrompt:'CUSTOM',toolAllowlist:['mcp__server__exec']},1)).toThrow('边界');
    expect(()=>validatePlatformRunner('pentest',{cwd:'/tmp/session',systemPrompt:'CUSTOM',toolAllowlist:['bash']},0)).toThrow('边界');
    expect(()=>validatePlatformRunner('auto',{cwd:'/tmp/session',systemPrompt:'CUSTOM',toolAllowlist:['mcp__*']},0)).not.toThrow();
  });
  it('never restores the retired role',()=>{expect(()=>validatePlatformRunner('retester',{cwd:'/tmp/history',systemPrompt:'old',toolAllowlist:[]},1)).toThrow('已移除');});
  it('defaults to native/deferred, preserves rollback and respects disabled search',async()=>{
    const settings:Record<string,string>={},rows:unknown[]=[];
    const db={platform:()=>({getSetting:async(k:string)=>settings[k]}),query:async()=>({rows})} as never;
    expect(await platformPolicy(db,'worker')).toMatchObject({version:'domain-v1',compaction:'native',mcpLoading:'deferred'});
    settings.pi_context_policy='native';settings.pi_mcp_loading='direct';
    expect(await platformPolicy(db,'worker')).toMatchObject({compaction:'native',mcpLoading:'direct'});
    delete settings.pi_mcp_loading;rows.push({enabled:false,agents:['worker']});
    expect(await platformPolicy(db,'worker')).toMatchObject({mcpLoading:'direct',fallback:expect.any(String)});
    settings.pi_context_policy='typo';await expect(platformPolicy(db,'worker')).rejects.toThrow('无效');
  });
});
