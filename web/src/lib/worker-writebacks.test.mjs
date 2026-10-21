import test from 'node:test';
import assert from 'node:assert/strict';
import {appendWritebackPage,writebackLabel,writebackLink,writebackSummary} from './worker-writebacks.ts';
const page=(extra={})=>({task_id:'1',turn_id:'a',bucket:'current',revision:5,items:[{key:'fact:2'}],...extra});
test('repeated pages deduplicate identities but cross-task, turn, bucket and revision never merge',()=>{
 assert.equal(appendWritebackPage(page(),page()).items.length,1);
 for(const extra of [{task_id:'2'},{turn_id:'b'},{bucket:'previous'},{revision:6}])assert.deepEqual(appendWritebackPage(page(),page({...extra,items:[{key:'asset:3'}]})).items,[{key:'asset:3'}]);
 assert.equal(appendWritebackPage(page(),page({items:[{key:'fact:4'}]})).items.length,2);
});
test('negative and inferred observations do not become confirmed vulnerabilities',()=>{
 assert.equal(writebackLabel({kind:'fact',state:'confirmed',observation_type:'inferred'}),'推断，待验证');
 assert.equal(writebackLabel({kind:'fact',state:'confirmed',observation_type:'negative'}),'未发现／排除结果');
 assert.equal(writebackLabel({kind:'asset'}),'已登记');
 assert.equal(writebackLabel({kind:'fact',state:'dismissed'}),'已撤销');
});
test('record and graph IDs remain distinct even when numbers collide',()=>{
 assert.equal(writebackLink('1',{kind:'finding',finding_id:'7',node_id:'7'}),'/function/findings/detail?id=7&context_task=1');
 assert.equal(writebackLink('1',{kind:'finding',finding_id:null,node_id:'7'}),'/function/tasks/detail?id=1&tab=graph&node=7');
 assert.equal(writebackLink('1',{kind:'asset'}),null);
});
test('endpoint display shortens only a valid asset URL and never rewrites fact conclusions',()=>{
 assert.equal(writebackSummary({kind:'asset',summary:'GET http://127.0.0.1:18899/forum?page=2'}),'GET /forum?page=2');
 assert.equal(writebackSummary({kind:'fact',summary:'GET http://127.0.0.1:18899/forum'}),'GET http://127.0.0.1:18899/forum');
});
