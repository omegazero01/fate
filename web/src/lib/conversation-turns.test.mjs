import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationTurns,withLiveStreams,mergeConversationActivities,isLifecycle} from './conversation-turns.ts';
const a=(seq,kind,extra={})=>({seq,kind,worker:'mainagent',main_seg:0,summary:`${seq}`,ts:`2026-10-18T08:00:${String(seq).padStart(2,'0')}Z`,...extra});
test('one host reply contains multiple pi texts and parallel tools',()=>{
 const rows=[a(1,'user'),...['thinking','text','tool_use','tool_use','tool_result','tool_result','text','result'].map((k,i)=>a(i+2,k,{metadata:{turn_id:'one'}}))];
 assert.equal(conversationTurns(rows).length,2);assert.equal(conversationTurns(rows)[1].steps.length,8);
});
test('worker feedback stays independent without splitting the active explicit turn',()=>{
 const rows=[a(1,'text',{turn_id:'a'}),a(2,'result',{metadata:{worker_feedback:{id:1,intent_id:3,state:'done'}}}),a(3,'text',{turn_id:'a'})];
 const turns=conversationTurns(rows);assert.equal(turns.length,2);assert.deepEqual(turns[0].steps.map(s=>s.seq),[1,3]);
});
test('legacy main turns and planner round boundaries are conservative',()=>{
 assert.equal(conversationTurns([a(1,'user'),a(2,'text'),a(3,'tool_use'),a(4,'text'),a(5,'result'),a(6,'user'),a(7,'text')]).length,4);
 assert.equal(conversationTurns([a(1,'round'),a(2,'text'),a(3,'round'),a(4,'text')]).length,2);
});
test('a stream is replaced by its durable message, including late snapshots',()=>{
 const stream={worker:'mainagent',main_seg:0,stream_id:'s',turn_id:'t',channel:'text',text:'中文流式',offset:4,ts:a(1,'text').ts,active:true};
 const final=a(2,'text',{detail:'中文流式完成',metadata:{stream_id:'s',channel:'text',turn_id:'t'}});
 assert.equal(withLiveStreams([], [stream])[0].detail,'中文流式');
 assert.deepEqual(withLiveStreams([final],[stream]),[final]);
});
test('thinking and text streams do not overwrite each other',()=>{
 const base={worker:'mainagent',main_seg:0,stream_id:'same',turn_id:'t',offset:1,ts:a(1,'text').ts,active:true};
 const rows=withLiveStreams([], [{...base,channel:'thinking',text:'想'},{...base,channel:'text',text:'答'}]);
 assert.equal(rows.length,2);assert.equal(conversationTurns(rows).length,1);
});
test('concurrent workers and segments never merge',()=>{
 const rows=[a(1,'text',{turn_id:'t'}),a(2,'text',{turn_id:'t',main_seg:2}),a(3,'text',{turn_id:'t',worker:'work#1',intent_id:'3'})];assert.equal(conversationTurns(rows).length,3);
});
test('optimistic echo is confirmed exactly once, replay does not duplicate it',()=>{
 const pending=a(-1,'user',{turn_id:'request'}),saved=a(2,'user',{metadata:{turn_id:'request'}});
 const rows=mergeConversationActivities([pending],[saved]);assert.deepEqual(rows,[saved]);assert.deepEqual(mergeConversationActivities(rows,[saved]),[saved]);
});
test('only lifecycle markers are hidden; real worker outcomes and feedback remain',()=>{
 assert.equal(isLifecycle(a(1,'result',{summary:'回复完成'})),true);
 assert.equal(isLifecycle(a(2,'result',{summary:'验证了三个条件'})),false);
 assert.equal(isLifecycle(a(3,'result',{summary:'回复完成',metadata:{worker_feedback:{id:1,intent_id:1,state:'done'}}})),false);
});
test('interrupted snapshots preserve partial content without a live indicator',()=>{
 const rows=withLiveStreams([],[{worker:'mainagent',stream_id:'s',turn_id:'t',channel:'text',text:'未完',offset:2,ts:a(1,'text').ts,active:false}]);assert.equal(rows[0].streaming,false);assert.equal(rows[0].interrupted,true);
});

test('late history and pending echoes merge in either argument order without duplicate React keys',()=>{
 const pending=a(-1,'user',{turn_id:'request'}),saved=a(2,'user',{metadata:{turn_id:'request'}});
 assert.deepEqual(mergeConversationActivities([saved],[pending]),[saved]);
 assert.deepEqual(mergeConversationActivities([],[pending,saved]),[saved]);
});

test('new and legacy steering are controls, with explicit turns only, never human echoes',()=>{
 const control=(seq,kind,metadata={})=>a(seq,kind,{worker:'work#1',intent_id:'9',tool:'steer_work',metadata:{event_type:'steering',...metadata}});
 const turns=conversationTurns([a(1,'text',{worker:'work#1',intent_id:'9',turn_id:'worker'}),control(2,'status',{steering:{target_turn_id:'worker',source:'planner'}}),control(3,'user',{source:'mainagent'}),a(4,'text',{worker:'work#1',intent_id:'9',turn_id:'worker'}),a(5,'user')]);
 assert.deepEqual(turns.map(t=>({user:t.user,seq:t.steps.map(s=>s.seq)})),[{user:false,seq:[1,2,4]},{user:false,seq:[3]},{user:true,seq:[5]}]);
 const pending=a(-1,'user',{turn_id:'request'}),legacy=control(6,'user',{turn_id:'request'});
 assert.equal(mergeConversationActivities([pending],[legacy]).length,2);
 assert.equal(mergeConversationActivities([legacy],[legacy]).length,1);
 assert.deepEqual(conversationTurns([control(2,'status',{steering:{target_turn_id:'worker'}})])[0].steps.map(s=>s.seq),[2]);
});

test('steering cannot merge concurrent workers, task sources or old unbound history',()=>{
 const base=a(1,'status',{worker:'work#1',intent_id:'9',metadata:{event_type:'steering',steering:{target_turn_id:'t'}}});
 assert.equal(conversationTurns([base,{...base,seq:2,intent_id:'10'},{...base,seq:3,source_task_id:'other'},{...base,seq:4,metadata:{event_type:'steering'}}]).length,4);
});
