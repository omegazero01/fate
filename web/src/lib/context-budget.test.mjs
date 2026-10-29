import test from 'node:test';
import assert from 'node:assert/strict';
import {contextBudgetFromK,readContextBudgets} from './context-budget.ts';

test('K conversion is exact at boundaries and rejects invalid or blank configuration',()=>{
  for(const [input,tokens] of [['48',48000],['64',64000],['0',0],['8.192',8192],['8.193',8193],['1000',1000000],['48.001',48001]])
    assert.equal(contextBudgetFromK(input),tokens);
  for(const input of ['', ' ', '-1','8.191','1','1000.001','NaN','Infinity','48.0001','1e3'])assert.equal(contextBudgetFromK(input),null);
});
test('an old or partially updated server cannot be mistaken for confirmed settings',()=>{
  const pair={planner_context_budget_tokens:48000,worker_context_budget_tokens:0};
  assert.deepEqual(readContextBudgets(pair),pair);
  for(const input of [{},{planner_context_budget_tokens:48000},{...pair,worker_context_budget_tokens:null},{...pair,worker_context_budget_tokens:'64000'}])
    assert.throws(()=>readContextBudgets(input),/有效的上下文配置/);
});
