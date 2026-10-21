import {randomUUID,createHash} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import pg from 'pg';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {openDatabase,type Database} from '../db/index.js';
import {runContext} from './context.js';
import {contextGetTool,contextSearchTool,searchContext} from './context-read.js';
import {graphOverviewTool,buildGraphOverview} from './overview.js';
import {CONTEXT_PAGE_BYTES} from './context-pages.js';

let db:Database;
const name=`fate_context_pages_${process.pid}`;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;process.env.SERIES_LOG_LEVEL='silent';db=await openDatabase();});
afterAll(async()=>{await db?.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});await admin.connect();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
async function fixture(){const task=await db.tasks().createTaskWithOptions('LOCAL on-demand context','',{});return {task,s:db.exploration(task.exploration_id),c:runContext(db,task.id,task.exploration_id,'planner')};}
async function call(tool:ToolDefinition,args:unknown){const r=await tool.execute(randomUUID(),args as never,undefined,undefined,{} as never);const text=(r.content[0] as {text:string}).text;expect(r.isError,text).not.toBe(true);expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20*1024);return JSON.parse(text);}

describe('on-demand graph reads',()=>{
 it('returns directly reusable field continuation without a relation cursor or repeated first page',async()=>{
  const f=await fixture(),detail='合成😀证据'.repeat(900),id=await f.s.addNode('fact',{summary:'paged field',detail,evidence:'LOCAL'},0,'confirmed','test',[]);
  const tool=contextGetTool(f.c);let item:any={ref:`node:${id}`,field:'/payload/detail'},text='',pages=0;
  while(item){const p=(await call(tool,{items:[item],max_chars:1000})).items[0];expect(p.error).toBeUndefined();text+=p.content;pages++;
   if(p.next_item){expect(p.next_item.offset).toBe(p.next_offset);expect(p.next_item.cursor).toBeUndefined();expect(p.next_item.version).toBe(0);}item=p.next_item;
  }
  expect(pages).toBe(5);expect(text).toBe(detail);
 });
 it('pages long Chinese summaries at item boundaries without loading evidence or skipping IDs',async()=>{
  const f=await fixture(),ids:number[]=[];
  for(let i=0;i<61;i++)ids.push(await f.s.addNode('fact',{summary:`${i}发现`.repeat(200),evidence:'needle '+'PRIVATE BODY '.repeat(5000)},0,'confirmed','test',[]));
  const spy=vi.spyOn(db,'query');const seen:number[]=[];let cursor:string|undefined;
  try{do{const p=await call(contextSearchTool(f.c),{q:'needle',types:['fact'],limit:50,cursor});expect(p.items.length).toBeGreaterThan(0);expect(Buffer.byteLength(JSON.stringify(p.items))).toBeLessThanOrEqual(CONTEXT_PAGE_BYTES);expect(JSON.stringify(p)).not.toContain('PRIVATE BODY '.repeat(30));expect(p.items.every((n:any)=>Array.from(n.snippet).length<=180)).toBe(true);seen.push(...p.items.map((n:any)=>n.node_id));cursor=p.next_cursor??undefined;}while(cursor);
   const projection=spy.mock.calls.find(([sql])=>String(sql).includes('FROM exploration_nodes n')&&String(sql).includes('n.id<$2'));
   expect(String(projection?.[0]).split('FROM exploration_nodes n')[0]).not.toContain('n.payload,');
  }finally{spy.mockRestore();}
  expect(seen).toEqual(ids.reverse());
 });
 it('puts recent negative evidence ahead of ten old broad matches and preserves snapshot cursors',async()=>{
  const f=await fixture();for(let i=0;i<12;i++)await f.s.addNode('fact',{summary:'old 30005 upload observation'},0,'confirmed','test',[]);
  const id=await f.s.addNode('fact',{summary:'30005 directory listing and traversal negative',evidence:'LOCAL checked'},0,'confirmed','test',[]);
  const first=await searchContext(f.c,{q:'30005'});expect(first.items[0]!.node_id).toBe(id);expect(first.has_more).toBe(true);
  const late=await f.s.addNode('fact',{summary:'30005 arrived after query'},0,'confirmed','test',[]);
  const second=await searchContext(f.c,{q:'30005',cursor:first.next_cursor!});expect(second.has_more).toBe(false);
  expect(new Set([...first.items,...second.items].map(n=>n.node_id)).size).toBe(13);expect(second.items.map(n=>n.node_id)).not.toContain(late);
 });
 it('keeps pre-upgrade default-query cursors usable without reversing or skipping their remaining rows',async()=>{
  const f=await fixture(),ids:number[]=[];for(let i=0;i<4;i++)ids.push(await f.s.addNode('fact',{summary:'legacy needle'},0,'confirmed','test',[]));
  const types=['fact','finding','intent','goal','hint','digest'].sort(),signature=createHash('sha256').update(JSON.stringify([f.c.taskID,f.c.role,f.c.taskID,types,'needle','',0,0,2])).digest('hex');
  const cursor=Buffer.from(JSON.stringify({signature,after:ids[1],upper:ids[3]})).toString('base64url');
  const page=await searchContext(f.c,{q:'needle',limit:2,cursor});expect(page.items.map(n=>n.node_id)).toEqual(ids.slice(2));expect(page.order).toBe('oldest_first');
 });
 it('returns a Unicode match offset and a reusable field read instead of only an unrelated summary',async()=>{
  const f=await fixture(),prefix='旧观察😀'.repeat(100),detail=prefix+'Needle_%_穿越 negative evidence';
  const id=await f.s.addNode('fact',{summary:'unrelated title',detail},0,'confirmed','test',[]);
  const hit=(await searchContext(f.c,{q:'needle_%_穿越'})).items[0]! as any;
  expect(hit.node_id).toBe(id);expect(hit.field).toBe('/payload/detail');expect(hit.match_offset).toBe(Array.from(prefix).length);expect(hit.snippet).toContain('Needle_%_穿越');
  const read=(await call(contextGetTool(f.c),{items:[hit.read]})).items[0];expect(read.error).toBeUndefined();expect(read.content).toContain('Needle_%_穿越');
 });
 it('keeps cold negative conclusions and real asset/parent/yield links in Planner overview',async()=>{
  const f=await fixture(),asset=await db.assets().upsertRootDomain({domain:'cold-review.invalid',taskID:f.task.id});
  const parent=await f.s.addNode('fact',{summary:'upload observed',evidence:'LOCAL'},0,'confirmed','test',[asset]);
  const intent=await f.s.addIntent({summary:'storage review'},1,[asset],'planner');await f.s.link(parent,'derived_from',intent);
  const fact=await f.s.addNode('fact',{summary:'directory listing closed and traversal negative',evidence:'LOCAL',from_intent:intent},0,'confirmed','worker',[asset]);await f.s.link(intent,'yields',fact);
  await db.query("UPDATE exploration_nodes SET state='done' WHERE id=$1",[intent]);
  let overview=await buildGraphOverview(f.c);expect((overview.recent_done_intents as any[]).find(n=>n.id===intent)).toMatchObject({state:'done',asset_ids:[asset],parents:[parent],yields:[fact]});
  const summary='#intent '+ 'long initial mandate '.repeat(25)+'\n#fact directory listing closed and traversal negative';
  const digest=await f.s.addNode('digest',{summary,member_ids:[intent,fact]},0,'active','system',[asset]);await f.s.link(digest,'covers',intent);await f.s.link(digest,'covers',fact);
  overview=await buildGraphOverview(f.c);expect((overview.recent_done_intents as any[]).some(n=>n.id===intent)).toBe(false);
  const folded=(overview.cold_digests as any[]).find(n=>n.id===digest);expect(folded.summary).toContain('traversal negative');expect(folded.read).toEqual({ref:`node:${digest}`,view:'members'});
  expect((await searchContext(f.c,{asset_id:asset,types:['fact']})).items.some(n=>n.node_id===fact)).toBe(true);
 });
 it('mixed activity searches preserve intent-related facts and never return full activity bodies',async()=>{
  const f=await fixture(),intent=await f.s.addIntent({summary:'LOCAL intent'},1,[],'planner');
  const fact=await f.s.addNode('fact',{summary:'related fact',evidence:'needle'},0,'confirmed','test',[]);await f.s.link(intent,'yields',fact);
  const a=await f.s.appendActivity({node_id:intent,worker:'w',kind:'result',summary:'needle',detail:'HUGE BODY '.repeat(10000)});
  const p=await searchContext(f.c,{intent_id:intent,types:['fact','activity'],q:'needle'});
  expect(new Set(p.items.map(n=>n.ref))).toEqual(new Set([`activity:${a}`,`node:${fact}`]));
  expect(JSON.stringify(p)).not.toContain('HUGE BODY');
 });
 it('pages mixed node/activity results by time without comparing their unrelated sequence IDs',async()=>{
  const f=await fixture(),intent=await f.s.addIntent({summary:'LOCAL intent'},1,[],'planner');
  const older=await f.s.appendActivity({node_id:intent,worker:'w',kind:'result',summary:'mixed needle',detail:'older'});
  await db.query("UPDATE activity SET created_at='2026-01-01T00:00:00Z' WHERE id=$1",[older]);
  const fact=await f.s.addNode('fact',{summary:'mixed needle newer fact'},0,'confirmed','test',[]);await f.s.link(intent,'yields',fact);
  const args={intent_id:intent,types:['fact','activity'],q:'mixed needle',limit:1};
  const first=await searchContext(f.c,args);expect(first.items[0]!.ref).toBe(`node:${fact}`);expect(first.has_more).toBe(true);
  const late=await f.s.appendActivity({node_id:intent,worker:'w',kind:'result',summary:'mixed needle late',detail:'late'});
  const second=await searchContext(f.c,{...args,cursor:first.next_cursor!});expect(second.items.map(n=>n.ref)).toEqual([`activity:${older}`]);expect(second.items.map(n=>n.ref)).not.toContain(`activity:${late}`);expect(second.has_more).toBe(false);
 });
 it('returns a summary without materializing the complete node',async()=>{
  const f=await fixture(),id=await f.s.addNode('fact',{summary:'brief',evidence:'full evidence '.repeat(10000)},0,'confirmed','test',[]);
  const spy=vi.spyOn(db,'query');
  try{const p=await call(contextGetTool(f.c),{items:[{ref:`node:${id}`,view:'summary'}]});expect(JSON.parse(p.items[0].content)).toMatchObject({summary:'brief',version:0});expect(JSON.stringify(p)).not.toContain('full evidence');expect(spy.mock.calls.some(([sql])=>/SELECT \* FROM exploration_nodes/.test(String(sql)))).toBe(false);}finally{spy.mockRestore();}
 });
 it('pages cold members after authorization, and detects changed references and versions',async()=>{
  const f=await fixture(),ids:number[]=[];
  const asset=await db.assets().upsertSubdomain({domain:'denied.pages.invalid',taskID:f.task.id});
  for(let i=0;i<52;i++)ids.push(await f.s.addNode('fact',{summary:`member ${i}`,evidence:'large '.repeat(5000)},0,'confirmed','test',i<7?[asset]:[]));
  const digest=await f.s.addNode('digest',{summary:'digest',member_ids:ids},0,'active','test',[]),tool=contextGetTool(f.c);
  const seen:string[]=[];let cursor:string|undefined,firstCursor:string|undefined;
  do{const p=(await call(tool,{items:[{ref:`node:${digest}`,view:'members',cursor}],max_chars:24000})).items[0];expect(p.error).toBeUndefined();expect(p.next_offset).toBeNull();const members=JSON.parse(p.content);expect(members.length).toBeLessThanOrEqual(20);seen.push(...members.map((n:any)=>n.ref));cursor=p.next_cursor??undefined;firstCursor??=cursor;}while(cursor);
  expect(seen).toEqual(ids.map(id=>`node:${id}`));
  const other=await f.s.addNode('digest',{summary:'other',member_ids:ids},0,'active','test',[]);
  expect((await call(tool,{items:[{ref:`node:${other}`,view:'members',cursor:firstCursor}]})).items[0].error).toContain('版本');
  await db.query("UPDATE exploration_nodes SET payload=payload||'{\"summary\":\"changed\"}' WHERE id=$1",[digest]);
  expect((await call(tool,{items:[{ref:`node:${digest}`,view:'members',cursor:firstCursor}]})).items[0].error).toContain('版本');
 });
 it('keeps relation page snapshots stable while reading Unicode fragments',async()=>{
  const f=await fixture(),intent=await f.s.addIntent({summary:'LOCAL child'},1,[],'planner'),ids:number[]=[];
  for(let i=0;i<3;i++){const id=await f.s.addNode('fact',{summary:'事实😀'.repeat(90)},0,'confirmed','test',[]);ids.push(id);await f.s.link(id,'derived_from',intent);}
  const tool=contextGetTool(f.c);let p=(await call(tool,{items:[{ref:`node:${intent}`,view:'parents'}],max_chars:256})).items[0];
  expect((await call(tool,{items:[{ref:`node:${intent}`,view:'parents',offset:256}]})).items[0].error).toContain('page_cursor');
  let result=p.content;const version=p.version,cursor=p.page_cursor;
  const late=await f.s.addNode('fact',{summary:'late member'},0,'confirmed','test',[]);await f.s.link(late,'derived_from',intent);
  while(p.next_offset!==null){expect(p.next_item.cursor).toBe(cursor);p=(await call(tool,{items:[p.next_item],max_chars:256})).items[0];expect(p.error).toBeUndefined();result+=p.content;}
  expect(JSON.parse(result).map((n:any)=>n.ref)).toEqual(ids.map(id=>`node:${id}`));expect(p.next_cursor).toBeNull();
  await db.query("UPDATE exploration_nodes SET payload=payload||'{\"summary\":\"changed member\"}' WHERE id=$1",[ids[0]]);
  expect((await call(tool,{items:[{ref:`node:${intent}`,view:'parents',cursor,version,offset:256}],max_chars:256})).items[0].error).toContain('本页成员');
 });
 it('keeps direct-source reads read-only and checks authorization on every page',async()=>{
  const f=await fixture(),source=await fixture();await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[f.task.id,source.task.id]);
  const asset=await db.assets().upsertSubdomain({domain:'source.pages.invalid',taskID:source.task.id});
  const fact=await source.s.addNode('fact',{summary:'source'},0,'confirmed','test',[asset]);
  const tool=contextGetTool(f.c),p=(await call(tool,{items:[{ref:`node:${fact}`,view:'summary'}]})).items[0];expect(p.inherited).toBe(true);expect(p.source_task_id).toBe(source.task.id);
  await db.query('DELETE FROM task_relations WHERE task_id=$1',[f.task.id]);expect((await call(tool,{items:[{ref:`node:${fact}`,view:'summary'}]})).items[0].error).toBeTruthy();
 });
 it('defaults to counts and goal references without retrieving graph payloads',async()=>{
  const f=await fixture();for(let i=0;i<40;i++)await f.s.addNode('fact',{summary:'brief',evidence:'large '.repeat(5000)},0,'confirmed','test',[]);
  await f.s.addGoal({text:'LOCAL goal'},'test');const spy=vi.spyOn(db,'query');
  try{const p=await call(graphOverviewTool(f.c),{});expect(p.facts_total).toBe(40);expect(p.goals).toHaveLength(1);expect(p.recent_facts).toBeUndefined();expect(p.read.search).toBe('context_search');expect(spy.mock.calls.some(([sql])=>/SELECT \* FROM exploration_nodes/.test(String(sql)))).toBe(false);}finally{spy.mockRestore();}
 });
 it('counts legacy findings consistently with anchor authorization',async()=>{
  const f=await fixture(),asset=await db.assets().upsertSubdomain({domain:'legacy.pages.invalid',taskID:f.task.id});
  await db.query('INSERT INTO findings(task_id,summary,asset_ids) VALUES($1,$2,$3),($1,$4,$5)',[f.task.id,'unanchored','[]','anchored',JSON.stringify([asset])]);

  expect((await call(graphOverviewTool(f.c),{})).findings_total).toBe(2);

  expect((await call(graphOverviewTool(f.c),{})).findings_total).toBe(2);
 });
});
