import {it,expect} from 'vitest';
import {roleContextPolicy} from './context-policy.js';

it('preserves role defaults and independent overrides',()=>{
  expect(roleContextPolicy('planner',258000)).toMatchObject({thresholdTokens:48000});
  expect(roleContextPolicy('worker',258000)).toEqual({version:'worker-context-v1',mode:'capacity'});
  expect(roleContextPolicy('worker',258000,'64000')).toMatchObject({thresholdTokens:64000,summaryMaxTokens:4096,compactionSettings:{reserveTokens:194000,keepRecentTokens:16000}});
  expect(roleContextPolicy('planner',258000,'0').mode).toBe('capacity');
});
it('clamps to actual model capacity without enlarging a small model',()=>{
  expect(roleContextPolicy('worker',32000,'64000')).toMatchObject({thresholdTokens:24000,compactionSettings:{reserveTokens:8000,keepRecentTokens:6000}});
  for(const role of ['planner','worker'] as const){
    for(const n of ['-1','8191','1000001','NaN','64.5'])expect(()=>roleContextPolicy(role,258000,n)).toThrow();
    expect(roleContextPolicy(role,258000,'8192').mode).toBe('working_set');
  }
});
