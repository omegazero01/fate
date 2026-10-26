import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTokenStats, modelTokenTotals, cacheHitRate } from './model-token-stats.ts';

const row = { model: 'local-fixture', calls: 2, input_tokens: 15, output_tokens: 8, cache_read_tokens: 4, cache_write_tokens: 0 };
test('overview accepts both the canonical response and the older server array without losing usage', () => {
  for (const response of [{ models: [row] }, [row]]) {
    const { models } = modelTokenStats(response);
    assert.deepEqual(models, [row]);
    assert.equal(models.reduce((total, item) => total + item.calls, 0), 2);
  }
});
test('pi input excludes caches; overview uses audited prompt totals rather than clamping an invalid percentage', () => {
  const total = modelTokenTotals([{...row, calls:254, input_semantics:'inclusive_cache', input_tokens:8022477, uncached_input_tokens:562125, cache_read_tokens:7460352, output_tokens:211487}]);
  assert.equal(total.calls,254);
  assert.equal(total.input,8022477);
  assert.equal(cacheHitRate(total.cacheRead,total.input,total.knownInput),'93.0%');
  assert.equal(cacheHitRate(7460352,562125,true),'—');
});
test('cache writes and fully cached prompts have valid rates, and missing history stays unknown', () => {
  assert.equal(cacheHitRate(180,230,true),'78.3%');
  assert.equal(cacheHitRate(100,100,true),'100.0%');
  assert.equal(cacheHitRate(0,0,true),'—');
  assert.equal(cacheHitRate(0,10,true),'0.0%');
  const total=modelTokenTotals([{...row,calls:null,input_semantics:'unknown'}]);
  assert.equal(total.knownCalls,false);assert.equal(total.knownInput,false);
  assert.equal(cacheHitRate(total.cacheRead,total.input,total.knownInput),'—');
});
test('empty and incomplete token responses keep the overview renderable', () => {
  for (const response of [null, undefined, {}, [], { models: null }, { models: [] }, { models: {} }]) {
    const { models } = modelTokenStats(response);
    assert.deepEqual(models, []);
    assert.equal(models.reduce((total, item) => total + item.calls, 0), 0);
  }
});
test('ledger request counts remain known while incomplete input suppresses a cache rate',()=>{
 const total=modelTokenTotals([{...row,source:'usage_ledger',version:'usage-v2',calls_complete:true,input_semantics:'unknown',input_complete:false,usage_complete:false,unknown_usage_calls:1}]);
 assert.equal(total.knownCalls,true);assert.equal(total.knownInput,false);assert.equal(total.unknown,1);assert.equal(cacheHitRate(total.cacheRead,total.input,total.knownInput),'—');
});
test('partial historical request coverage is disclosed rather than advertised as an exact total',()=>{
 const total=modelTokenTotals([{...row,source:'usage_ledger',calls_complete:false,input_semantics:'unknown',input_complete:false,history_gap_requests:2}]);
 assert.equal(total.knownCalls,false);assert.equal(total.historyGaps,2);assert.equal(total.knownInput,false);
});
