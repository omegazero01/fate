import test from 'node:test';
import assert from 'node:assert/strict';
import {isSteering,steeringSource,steeringStatus} from './steering.ts';
import {turnParts} from './turn-summary.ts';
const a=(kind='status',metadata={})=>({seq:2,kind,worker:'work#1',summary:'LOCAL',metadata:{event_type:'steering',...metadata}});
test('source is explicit host metadata, never inferred from prose or the receiving worker',()=>{
 assert.equal(steeringSource(a('status',{steering:{source:'planner',status:'submitted'}})),'Planner');
 assert.equal(steeringSource(a('user',{source:'mainagent'})),'Main');
 assert.equal(steeringSource({...a(),summary:'Planner says hello'}),'来源未记录');
 assert.equal(steeringStatus(a()),'状态未记录');
 assert.equal(steeringStatus(a('status',{steering:{status:'submitted'}})),'已提交');
 assert.equal(steeringStatus(a('status',{steering:{status:'queued'}})),'已提交');
 assert.notEqual(steeringStatus(a('status',{steering:{status:'delivered'}})),'已生效');
});
test('control detection cannot swallow real users or source tool calls, or promote controls to a final answer',()=>{
 assert.equal(isSteering(a('user')),true);assert.equal(isSteering(a()),true);
 assert.equal(isSteering(a('tool_use')),false);assert.equal(isSteering(a('tool_result')),false);
 assert.equal(isSteering({...a('user'),metadata:{},tool:'steer_work'}),false);
 const control=a('user');const parts=turnParts([control],{final_activity:control});
 assert.equal(parts.final,undefined);assert.deepEqual(parts.process,[control]);
});
