import {it,expect} from 'vitest';
import {plannerContextPolicy,mergePlannerChanges} from './planner-context-policy.js';
import {preparePlannerDelivery} from './planner-memory.js';

it('keeps a separate working-set threshold, native retention and explicit capacity rollback',()=>{
  expect(plannerContextPolicy(258000)).toMatchObject({thresholdTokens:48000,summaryMaxTokens:2048,
    compactionSettings:{reserveTokens:210000,keepRecentTokens:12000}});
  expect(plannerContextPolicy(8000)).toMatchObject({thresholdTokens:6000,compactionSettings:{keepRecentTokens:1500,reserveTokens:2000}});
  expect(plannerContextPolicy(258000,'0')).toEqual({version:'planner-context-v2',mode:'capacity'});
  for(const value of ['NaN','-1','1.5','1','8191','1000001'])expect(()=>plannerContextPolicy(258000,value)).toThrow();
});
it('merges identical fields without losing projection-specific evidence, conflicts or source isolation',()=>{
  const rows=[{section:'recent_facts:7',id:7,version:2,summary:'Same conclusion, full scope',confidence:'high'},
    {section:'change:1:node:7',ref:'node:7',source_task_id:1,version:2,summary:'Same conclusion',kind:'fact',scope_read:{ref:'node:7',field:'/payload/scope'}},
    {section:'conflict',ref:'node:7',source_task_id:1,version:2,summary:'Different claim'},
    {section:'source',ref:'node:7',source_task_id:2,version:2,summary:'Other source'},
    {section:'new',ref:'node:7',version:3,summary:'New version'},
    {section:'old',ref:'node:7',summary:'Unknown version'}];
  const original=JSON.stringify(rows),merged=mergePlannerChanges(rows,1);
  expect(merged).toHaveLength(4);expect(merged[0]).toMatchObject({summary:'Same conclusion, full scope',confidence:'high',kind:'fact',scope_read:{ref:'node:7'},
    projections:[{section:'conflict',summary:'Different claim'}]});
  expect(JSON.stringify(rows)).toBe(original);
});
it('delivers each fact once, keeps event acknowledgement IDs and does not redeliver unchanged fields',()=>{
  const summary='LOCAL negative observation; only the tested scope. '.repeat(4);
  const args={taskID:1,expID:2,overview:{recent_facts:[{id:7,version:1,summary,confidence:'high'}]},todos:[],
    changes:[{ref:'node:7',version:1,summary,kind:'fact',source_task_id:1}],events:[{id:5,kind:'worker_settled'}],contextIDs:[11],triggers:'wake'};
  const first=preparePlannerDelivery(args),payload=JSON.parse(first.input);
  expect(payload.changes).toHaveLength(1);expect(payload.changes[0]).toMatchObject({ref:'node:7',kind:'fact',confidence:'high'});
  expect(first.contextIDs).toEqual([11]);expect(first.wakeupIDs).toEqual([5]);
  expect(JSON.parse(preparePlannerDelivery({...args,previous:first}).input).changes).toEqual([]);
});
