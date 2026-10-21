import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {openDatabase,type Database} from '../db/index.js';
import {normalizeContract} from './intent-contract.js';
import {canonicalWorkResource,workIdentity,directionIdentity,overlappingWork,storedWorkIdentity,type WorkAsset} from './work-identity.js';
import {addIntentTool} from '../tools/intents.js';
import {runContext} from '../tools/context.js';

const name=`fate_work_identity_${process.pid}`;let db:Database;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;db=await openDatabase();});
afterAll(async()=>{await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE ${name}`);await c.end();});
const contract=(resource='http://local.invalid/',identity='anonymous')=>normalizeContract({objective:'LOCAL bounded check',acceptance:['LOCAL evidence'],work:{resource,question_key:'headers',method_class:'http_get',identity}},'LOCAL');
async function fixture(){const task=await db.tasks().createTaskWithOptions('LOCAL work identity','',{executionMode:'managed'});return {task,s:db.exploration(task.exploration_id)};}
const payload=(resource:string,summary='LOCAL same direction',identity='anonymous')=>({summary,contract:contract(resource,identity)});
it('canonicalizes host/default port while retaining path/query/hash/identity distinctions',()=>{
  expect(canonicalWorkResource('HTTP://Local.Invalid:80')).toBe('http://local.invalid/');
  const variants=['http://local.invalid/a','http://local.invalid/A','http://local.invalid:8080/a','https://local.invalid/a',
    'http://local.invalid/a?x=1','http://local.invalid/a?x=2','http://local.invalid/#/a','http://local.invalid/#/A'];
  expect(new Set(variants.map(v=>workIdentity(contract(v),'LOCAL',[],new Map()).key)).size).toBe(variants.length);
  expect(workIdentity(contract(variants[0],'Admin'),'LOCAL',[],new Map()).key).not.toBe(workIdentity(contract(variants[0],'admin'),'LOCAL',[],new Map()).key);
  expect(directionIdentity('检查 http://LOCAL.invalid/Admin')).not.toBe(directionIdentity('检查 http://local.invalid/admin'));
});
it('maps an explicit asset reference to its URL, without inferring IP/host equivalence',()=>{
  const assets=new Map<number,WorkAsset>([[1,{id:1,type:'service',url:'HTTP://Local.Invalid:80'}],[2,{id:2,type:'service',url:'http://127.0.0.1/'}]]);
  expect(workIdentity(contract('asset:1'),'LOCAL',[1],assets).key).toBe(workIdentity(contract('http://local.invalid/'),'LOCAL',[1],assets).key);
  expect(workIdentity(contract('asset:1'),'LOCAL',[1],assets).key).not.toBe(workIdentity(contract('asset:2'),'LOCAL',[2],assets).key);
});
it('does not merge different endpoint methods or resource paths, but parameter discoveries keep the direction anchored to one host',()=>{
  const assets=new Map<number,WorkAsset>([[1,{id:1,type:'endpoint',url:'http://local.invalid/x',method:'GET',params:[]}],[2,{id:2,type:'endpoint',url:'http://local.invalid/x',method:'POST',params:[]}],[3,{id:3,type:'endpoint',url:'http://local.invalid/x',method:'GET',params:[{name:'a'}]}]]);
  const keys=[1,2,3].map(id=>workIdentity(contract('http://local.invalid/x'),'LOCAL',[id],assets));
  expect(new Set(keys.map(k=>k.key)).size).toBe(2);
  expect(overlappingWork(workIdentity(contract('http://local.invalid/a'),'LOCAL',[1],assets),workIdentity(contract('http://local.invalid/b'),'LOCAL',[1],assets))).toBe(false);
});
it('serializes concurrent equivalent proposals, including asset aliases and different prose',async()=>{
  const {task,s}=await fixture();
  const asset=await db.assets().upsertHTTPService({url:'http://local.invalid:80',taskID:task.id});
  const submissions=await Promise.all(Array.from({length:12},(_,i)=>s.addPlannerIntentDeduplicated(payload(i%2?`asset:${asset}`:'http://LOCAL.invalid/',`description ${i}`),5,[asset],'planner')));
  expect(submissions.filter(r=>r.created)).toHaveLength(1);expect(new Set(submissions.map(r=>r.id)).size).toBe(1);
  expect(submissions.find(r=>!r.created)!.dedup).toMatchObject({version:3,strength:'structured',match:'equivalent_work'});
  await s.setIntentState(submissions[0]!.id,'done');
  expect((await s.addPlannerIntentDeduplicated(payload(`asset:${asset}`,'new description'),5,[asset],'planner')).created).toBe(false);
});
it('detects active partial target overlap, while accepting disjoint work',async()=>{
  const {task,s}=await fixture();
  const a=await db.assets().upsertHTTPService({url:'http://a.local.invalid',taskID:task.id});
  const b=await db.assets().upsertHTTPService({url:'http://b.local.invalid',taskID:task.id});
  const first=await s.addPlannerIntentDeduplicated(payload('selected assets'),5,[a],'planner');
  const overlap=await s.addPlannerIntentDeduplicated(payload('selected assets'),5,[a,b],'planner');
  expect(overlap.created).toBe(true);expect(overlap.dedup?.related_intent_ids).toContain(first.id);
  expect((await s.addPlannerIntentDeduplicated(payload('selected assets'),5,[b],'planner')).created).toBe(true);
});
it('keeps lightweight interfaces compatible and reports their weaker deduplication',async()=>{
  const {task,s}=await fixture();
  const tool=addIntentTool(runContext(db,task.id,task.exploration_id,'planner'));
  const out=await tool.execute('light',{summary:'LOCAL simple direction'},undefined,undefined,{} as never);
  expect(out.isError).not.toBe(true);expect(JSON.parse((out.content[0] as {text:string}).text).intents[0].dedup.strength).toBe('legacy_text');
  const a=await s.addIntent({summary:'检查 http://local.invalid/Admin'},5,[],'planner');
  const b=await s.addIntent({summary:'检查 http://local.invalid/admin'},5,[],'planner');expect(a).not.toBe(b);
});
it('a failed overlapping item rolls back its complete proposal batch',async()=>{
  const {task,s}=await fixture(),a=await db.assets().upsertHTTPService({url:'http://batch-a.invalid',taskID:task.id}),
    b=await db.assets().upsertHTTPService({url:'http://batch-b.invalid',taskID:task.id});
  const paused=await s.addIntent(payload('selected'),5,[a],'planner');await s.setIntentState(paused,'paused');
  const tool=addIntentTool(runContext(db,task.id,task.exploration_id,'planner'));
  const out=await tool.execute('batch',{intents:[{...payload('http://unique.invalid/'),asset_ids:[]},{...payload('selected'),asset_ids:[a,b]}]},undefined,undefined,{} as never);
  expect(out.isError).toBe(true);expect(await s.listByKind('intent')).toHaveLength(1);
});
it('keeps explicit retry requirements and rejects stale evidence even for an equivalent work key',async()=>{
  const {s}=await fixture(),a=await s.addIntent(payload('http://local.invalid/'),5,[],'planner');await s.setIntentState(a,'done');
  await expect(s.addIntentDeduplicated({...payload('HTTP://LOCAL.invalid:80/'),retry_of:a,retry_kind:'transient_failure',retry_reason:'retry'},5,[],'planner')).rejects.toThrow('新的有效');
  const fact=await s.addNode('fact',{summary:'LOCAL new evidence'},0,'confirmed','test',[]);
  const c=contract();c.basis=[{node_id:fact,version:0}];
  const r=await s.addIntentDeduplicated({summary:'retry',contract:c,retry_of:a,retry_kind:'new_evidence',retry_reason:'changed evidence'},5,[],'planner');
  expect(r.created).toBe(true);
  await db.query('UPDATE exploration_nodes SET content_version=content_version+1 WHERE id=$1',[fact]);
  await expect(s.addIntentDeduplicated({summary:'retry again',contract:c},5,[],'planner')).rejects.toThrow('已变化');
});
it('never uses new evidence or partial overlap to resume user-cancelled work',async()=>{
 const {task,s}=await fixture(),a=await db.assets().upsertHTTPService({url:'http://cancel-a.invalid',taskID:task.id}),
   b=await db.assets().upsertHTTPService({url:'http://cancel-b.invalid',taskID:task.id});
 const previous=await s.addIntent(payload('selected'),5,[a],'planner');
 await db.query("UPDATE exploration_nodes SET state='stopped',payload=payload||'{\"cancelled_by_user\":true}'::jsonb WHERE id=$1",[previous]);
 const fact=await s.addNode('fact',{summary:'LOCAL new evidence'},0,'confirmed','test',[]),c=contract('selected');c.basis=[{node_id:fact,version:0}];
 await expect(s.addIntentDeduplicated({summary:'retry',contract:c,retry_of:previous,retry_kind:'new_evidence',retry_reason:'new finding'},5,[a],'planner')).rejects.toThrow('取消');
 await expect(s.addIntentDeduplicated(payload('selected'),5,[a,b],'planner')).rejects.toThrow('取消');
 expect(await s.listByKind('intent')).toHaveLength(1);
});

it('keeps the dispatch snapshot after discoveries and reads legacy snapshots without rewriting them',async()=>{
 const {task,s}=await fixture();const a=await db.assets().upsertHTTPService({url:'http://snapshot.invalid',taskID:task.id});
 const first=await s.addPlannerIntentDeduplicated(payload('snapshot'),5,[a],'planner');
 const b=await db.assets().upsertHTTPService({url:'http://discovered.invalid',taskID:task.id});
 await db.query('INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2)',[first.id,b]);
 expect((await s.addPlannerIntentDeduplicated(payload('snapshot'),5,[a],'planner')).id).toBe(first.id);
 expect((await s.getNode(first.id))!.payload.dispatch_asset_ids).toEqual([a]);
 const current=workIdentity(contract('http://snapshot.invalid/'),'LOCAL',[a],new Map([[a,{id:a,type:'endpoint',url:'http://snapshot.invalid/api',method:'GET',params:[]}]]));
 const legacy={...current,version:2,key:'historical',targets:[JSON.stringify(['endpoint','http://snapshot.invalid/api','GET',[{name:'p'}]])]};
 expect(storedWorkIdentity(legacy)).toEqual(current);expect(legacy.key).toBe('historical');
});
