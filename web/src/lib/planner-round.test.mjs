import test from 'node:test';
import assert from 'node:assert/strict';
import {plannerRoundView,isPlannerBoundary} from './planner-round.ts';
import {conversationTurns,mergeConversationActivities} from './conversation-turns.ts';
const row=(seq,kind='round',metadata={},extra={})=>({seq,kind,worker:'planner',ts:'2026-10-26T00:00:00Z',summary:'',turn_id:'t1',metadata,...extra});
const start=row(1,'round',{event_type:'planner_round_start',planner_round:{number:258,title:null}});
const title=row(4,'status',{event_type:'planner_round_title',planner_round:{number:258,title:'文件上传全面探测'}});
test('running header becomes a durable direction without adding another turn',()=>{
 assert.equal(plannerRoundView([start],undefined,true,false).title,'正在分析');
 const merged=mergeConversationActivities([start,title],[start,title]);
 assert.equal(conversationTurns(merged).length,1);
 assert.deepEqual(plannerRoundView(merged,undefined,false,true),{number:258,label:'第 258 轮规划',title:'文件上传全面探测',boundaryIDs:[1,4]});
});
test('pagination uses complete turn summary, never local item counts; new events supersede stale summaries',()=>{
 const text=row(3,'text',{}, {summary:'old receipt'});
 const summary={revision:4,role:'planner',planner_round:{number:258,title:'文件上传全面探测'}};
 assert.equal(plannerRoundView([text],summary).number,258);
 assert.equal(plannerRoundView([title],{...summary,revision:1,planner_round:{number:258,title:null}}).title,'文件上传全面探测');
});
test('old explicit numbers survive; unknown historical headings and missing titles stay honest',()=>{
 assert.equal(plannerRoundView([row(1,'round',{}, {summary:'第 258 轮规划'})]).number,258);
 assert.equal(plannerRoundView([row(1,'text')]).label,'历史规划');
 assert.equal(plannerRoundView([start],undefined,false,true).title,'方向未记录');
 assert.equal(plannerRoundView([row(4,'status',{event_type:'planner_round_title',planner_round:{number:1,title:null}})],undefined,true,false).title,'方向未记录');
});
test('Goals, Worker, Main, and independent steering records never get planning separators',()=>{
 for(const worker of ['goals','work#1','main'])assert.equal(plannerRoundView([row(1,'round',{}, {worker})]),null);
 assert.equal(plannerRoundView([start],{role:'goals'}),null);
 assert.equal(plannerRoundView([row(1,'round',{}, {summary:'第 0 轮 · 目标拆解'})]),null);
 assert.equal(plannerRoundView([row(1,'status',{event_type:'steering'})]),null);
});
test('only planner boundary records move outside process; tools and real final text stay in order',()=>{
 const steps=[start,row(2,'thinking'),row(3,'tool_use'),title,row(5,'text')];
 assert.deepEqual(steps.filter(s=>!isPlannerBoundary(s)).map(s=>s.seq),[2,3,5]);
 assert.equal(isPlannerBoundary(row(1,'round',{}, {worker:'work#1'})),false);
});
