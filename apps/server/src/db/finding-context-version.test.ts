import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {openDatabase,type Database} from './index.js';
import {contextGetTool} from '../tools/context-read.js';
import {runContext} from '../tools/context.js';
import {contextNeeds} from '../agent/context-needs.js';

const name=`fate_finding_versions_${process.pid}`;let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();});
async function fixture(){
  const task=await db.tasks().createTaskWithOptions('LOCAL report version','',{executionMode:'manual'}),store=db.exploration(task.exploration_id);
  const node=await store.addNode('finding',{summary:'LOCAL finding'},0,'confirmed','fixture',[]);
  const row=(await db.query('INSERT INTO findings(task_id,node_id,name,evidence) VALUES($1,$2,$3,$4) RETURNING id',[task.id,node,'LOCAL finding','LOCAL evidence'])).rows[0]!;
  return {task,store,node,finding:row.id};
}
it('keeps dispatched evidence valid when Reporter saves or revises only report prose',async()=>{
  const x=await fixture(),version=(await x.store.getNode(x.node))!.content_version;
  const intent=await x.store.addIntent({summary:'LOCAL use existing evidence',dispatch_requested:true,contract:{basis:[{node_id:x.node,version}]}},1,[],'user');
  const hashes=new Set<string>();
  for(const report of ['LOCAL report first draft','LOCAL report edited']){
    await db.query('UPDATE findings SET report=$2,report_evidence_version=evidence_version WHERE id=$1',[x.finding,report]);
    const current=(await x.store.getNode(x.node))!;
    expect(current.content_version).toBeGreaterThan(version!);
    expect(current.content_version!-(current.report_revision??0)).toBe(version);
    const result=await contextGetTool(runContext(db,x.task.id,x.task.exploration_id,'planner')).execute('read',{items:[{ref:`node:${x.node}`,view:'detail',field:'/finding_detail/report',version:current.content_version}]},undefined,undefined,{} as never);
    const item=JSON.parse(result.content[0]!.text!).items[0];
    expect(item.content).toBe(report);hashes.add(item.read_receipt.source_hash);
    const needs=await contextNeeds(runContext(db,x.task.id,x.task.exploration_id,'planner'),{intent_id:intent});
    expect(needs.items.find(n=>n.ref===`node:${x.node}`)?.reason).toBe('dependency_detail_unread');
  }
  expect(hashes.size).toBe(2);
  expect((await x.store.claimNextWorker('work#1'))?.id).toBe(intent);
  const current=(await x.store.getNode(x.node))!;
  const second=await x.store.addIntent({summary:'LOCAL freshly read report',dispatch_requested:true,contract:{basis:[{node_id:x.node,version:current.content_version,report_revision:999}]}},1,[],'user');
  expect(((await x.store.getNode(second))!.payload.contract as any).basis[0].report_revision).toBe(2);
  await db.query("UPDATE findings SET report='LOCAL third revision' WHERE id=$1",[x.finding]);
  expect((await x.store.claimNextWorker('work#2'))?.id).toBe(second);
});
it('does not treat a rewritten report as new evidence for retrying completed work',async()=>{
  const x=await fixture(),summary='LOCAL fixed direction';
  const first=await x.store.addIntentDeduplicated({summary,contract:{basis:[{node_id:x.node,version:0}]}},1,[],'user');
  await x.store.setIntentState(first.id,'done');
  await db.query("UPDATE findings SET report='LOCAL rewritten report' WHERE id=$1",[x.finding]);
  const retry=async()=>x.store.addIntentDeduplicated({summary,contract:{basis:[{node_id:x.node,version:(await x.store.getNode(x.node))!.content_version}]},retry_of:first.id,retry_kind:'new_evidence',retry_reason:'LOCAL updated source'},1,[],'user');
  await expect(retry()).rejects.toThrow('新的有效事实依据');
  await db.query("UPDATE findings SET evidence='LOCAL genuinely new observation' WHERE id=$1",[x.finding]);
  expect((await retry()).created).toBe(true);
});
it.each(['evidence','status','summary','name','severity'])('still invalidates dispatched work when finding %s changes',async field=>{
  const x=await fixture();await db.query("UPDATE findings SET report='LOCAL presentation' WHERE id=$1",[x.finding]);
  const version=(await x.store.getNode(x.node))!.content_version;
  const intent=await x.store.addIntent({summary:'LOCAL use original evidence',dispatch_requested:true,contract:{basis:[{node_id:x.node,version}]}},1,[],'user');
  await db.query(`UPDATE findings SET ${field}=$2 WHERE id=$1`,[x.finding,'LOCAL changed']);
  expect((await x.store.getNode(x.node))!.content_version).toBeGreaterThan(version!);
  expect(await x.store.claimNextWorker('work#1')).toBeNull();
  expect((await x.store.getNode(intent))!.payload.needs_replanning).toBe(true);
});
