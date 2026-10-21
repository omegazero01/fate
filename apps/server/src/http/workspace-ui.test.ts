import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {postgresDSN} from '../config/index.js';import {openDatabase,type Database} from '../db/index.js';import {Engine,defaultEngineConfig} from '../engine/engine.js';import {buildApp} from './app.js';import {signJWT} from './auth.js';import {fileParts} from './routes/task-files.js';import {recordExchange} from '../evidence/store.js';import {putBlob,blobContains,readBlobRange} from '../evidence/blobs.js';
const name=`fate_workspace_ui_${process.pid}`,connection=new URL(postgresDSN().dsn);connection.pathname=`/${name}`;const dsn=connection.toString();connection.pathname='/postgres';const adminDSN=connection.toString();const previousDSN=process.env.SERIES_PG_DSN;
let dir:string,db:Database,engine:Engine,app:ReturnType<typeof buildApp>,task:number,other:number,intent:number,asset:number,traffic:string,attachment:string;
const key='synthetic-workspace-regression',headers={'x-series-token':signJWT(key)},body='中文证据🙂\n'.repeat(14000);
const url=(suffix:string)=>`/api/tasks/${task}/files${suffix}`;
beforeAll(async()=>{
 process.env.SERIES_PG_DSN=dsn;db=await openDatabase();dir=await mkdtemp(path.join(tmpdir(),'workspace-ui-'));engine=new Engine(db,defaultEngineConfig(),async()=>null,dir);app=buildApp({db,engine,version:'workspace-test',startedAt:Date.now(),jwtKey:key,dataDir:dir,skillsRoot:dir});
 const t=await db.tasks().createTaskWithOptions('LOCAL workspace','',{executionMode:'manual'});task=t.id;other=(await db.tasks().createTaskWithOptions('LOCAL other','',{executionMode:'manual'})).id;
 asset=await db.assets().upsertHTTPService({url:'http://127.0.0.1:18899',taskID:task});intent=await db.exploration(t.exploration_id).addIntent({summary:'LOCAL file fixture'},1,[asset],'user');
 const root=path.join(dir,'tasks',String(task),`i${intent}`);await mkdir(path.join(root,'nested'),{recursive:true});await writeFile(path.join(root,'report.txt'),body);await writeFile(path.join(root,'nested','html.html'),'<script>alert("synthetic")</script>');await writeFile(path.join(root,'binary.bin'),Buffer.from([0,1,255,0]));await writeFile(path.join(dir,'private'),'OUTSIDE');await symlink(path.join(dir,'private'),path.join(root,'escape.txt'));await symlink(dir,path.join(root,'escape-dir'));
 attachment=randomUUID();const relative=`artifacts/${attachment}/upload.txt`;await mkdir(path.dirname(path.join(dir,relative)),{recursive:true});await writeFile(path.join(dir,relative),'LOCAL attachment');const hash=await putBlob(db,Buffer.from('LOCAL attachment'));await db.query('INSERT INTO chat_artifacts(id,task_id,name,path,mime,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[attachment,task,'upload.txt',relative,'text/plain',16,hash]);
 traffic=await recordExchange(db,{taskID:task,intentID:intent,url:'http://127.0.0.1:18899/synthetic',method:'GET',status:200,reqHead:'GET /synthetic HTTP/1.1',respHead:'HTTP/1.1 200 OK',request:Buffer.from(''),response:Buffer.from(body)});
});
afterAll(async()=>{await engine?.shutdown();await app?.close();await db?.close();const c=new pg.Client({connectionString:adminDSN});await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name}`);await c.end();if(dir)await rm(dir,{recursive:true,force:true});if(previousDSN===undefined)delete process.env.SERIES_PG_DSN;else process.env.SERIES_PG_DSN=previousDSN;});
it('lists authorized files with stable pagination and no absolute paths',async()=>{
 const r=await app.inject({url:url(''),headers});expect(r.statusCode).toBe(200);expect(r.json().items.map((x:any)=>x.ref).sort()).toEqual([`attachment:${attachment}`,`work:i${intent}`].sort());expect(r.body).not.toContain(dir);
 const page=(await app.inject({url:url(`?ref=work:i${intent}&limit=1`),headers})).json();expect(page.items).toHaveLength(1);expect(page.next_cursor).toBeTruthy();const all=(await app.inject({url:url(`?ref=work:i${intent}`),headers})).json();expect(all.items.some((x:any)=>x.name.startsWith('escape'))).toBe(false);
});
it('rejects traversal, cross-task references and symbolic links',async()=>{
 for(const ref of ['/etc/passwd','work:i1/../private',`work:i${intent}/escape.txt`,`work:i${intent}/escape-dir/private`,`work:i${intent}\\report.txt`])expect((await app.inject({url:url(`/content?ref=${encodeURIComponent(ref)}`),headers})).statusCode).toBeGreaterThanOrEqual(400);
 for(const ref of [`attachment:${attachment}`,`work:i${intent}/report.txt`])expect((await app.inject({url:`/api/tasks/${other}/files/content?ref=${encodeURIComponent(ref)}`,headers})).statusCode).toBeGreaterThanOrEqual(400);
 expect(()=>fileParts('i1/../../private')).toThrow();expect(()=>fileParts('i1//file')).toThrow();
});
it('long UTF-8 pagination is lossless and rejects changed versions',async()=>{
 let offset=0,text='',version='';for(;;){const r=await app.inject({url:url(`/content?${new URLSearchParams({ref:`work:i${intent}/report.txt`,offset:String(offset),version})}`),headers});expect(r.statusCode).toBe(200);const p=r.json();text+=p.content;version=p.version;if(!p.has_more)break;expect(p.next_offset).toBeGreaterThan(offset);offset=p.next_offset;}expect(text).toBe(body);
 await writeFile(path.join(dir,'tasks',String(task),`i${intent}`,'report.txt'),body+'changed');expect((await app.inject({url:url(`/content?${new URLSearchParams({ref:`work:i${intent}/report.txt`,version})}`),headers})).statusCode).toBe(409);
});
it('binary and HTML files remain inert with exact download bytes',async()=>{
 expect((await app.inject({url:url(`/content?ref=work:i${intent}/binary.bin`),headers})).json()).toMatchObject({binary:true,content:''});const html=await app.inject({url:url(`/content?ref=work:i${intent}/nested/html.html&download=1`),headers});expect(html.statusCode).toBe(200);expect(html.headers['content-type']).toContain('application/octet-stream');expect(html.headers['content-disposition']).toContain('attachment;');expect(html.headers['x-content-type-options']).toBe('nosniff');expect(html.body).toContain('<script>');
});
it('file-backed traffic search and body paging preserve original bytes',async()=>{
 const filtered=await app.inject({url:`/api/traffic?task=${task}&body=${encodeURIComponent('中文证据')}`,headers});expect(filtered.statusCode).toBe(200);expect(filtered.json().total).toBe(1);
 let offset=0;const chunks:Buffer[]=[];for(;;){const r=await app.inject({url:`/api/traffic/exchange/${traffic}/body?task=${task}&side=response&offset=${offset}`,headers});expect(r.statusCode).toBe(200);const p=r.json();chunks.push(Buffer.from(p.content,p.encoding==='base64'?'base64':'utf8'));if(!p.truncated)break;expect(p.next_offset).toBeGreaterThan(offset);offset=p.next_offset;}expect(Buffer.concat(chunks).toString()).toBe(body);
 expect((await app.inject({url:`/api/traffic/exchange/${traffic}/body?task=${other}&side=response`,headers})).statusCode).toBe(403);const download=await app.inject({url:`/api/traffic/exchange/${traffic}/body?task=${task}&side=response&download=1`,headers});expect(download.rawPayload.equals(Buffer.from(body))).toBe(true);
});
it('bounded evidence reads support legacy blobs and search across UTF-8 window boundaries',async()=>{
 const text='x'.repeat(65534)+'中文边界🙂'+'y'.repeat(90000),hash=await putBlob(db,Buffer.from(text));
 expect(await blobContains(db,hash,'中文边界🙂')).toBe(true);expect(await blobContains(db,hash,'z')).toBe(false);
 const bytes=Buffer.from('legacy中文🙂'),legacy='a'.repeat(64);await db.query('INSERT INTO evidence_blobs(hash,bytes) VALUES($1,$2)',[legacy,bytes]);
 const page=await readBlobRange(db,legacy,4,5);expect(page.total).toBe(bytes.length);expect(page.bytes.equals(bytes.subarray(4,9))).toBe(true);
});
it('missing files return a safe 404 without host paths',async()=>{
 const r=await app.inject({url:url(`/content?ref=work:i${intent}/missing.txt`),headers});expect(r.statusCode).toBe(404);expect(r.body).not.toContain(dir);
});
it('task finding filters and totals share the authorized projection',async()=>{
 const t=await db.tasks().getTask(task);const s=db.exploration(t!.exploration_id);
 for(const severity of ['low','high']){const n=await s.addNode('finding',{summary:'LOCAL filter',severity},0,'confirmed','work#1',[asset]);await db.query(`INSERT INTO findings(task_id,node_id,name,vulnclass,severity,summary,evidence,asset_ids,status) VALUES($1,$2,$3,'fixture',$4,'LOCAL filter','LOCAL evidence',$5::jsonb,'pending')`,[task,n,`LOCAL ${severity}`,severity,JSON.stringify([asset])]);}
 const r=await app.inject({url:`/api/exploration/findings?task_id=${task}&severity=high&status=pending&q=LOCAL&page=1&limit=1`,headers});expect(r.statusCode).toBe(200);expect(r.json().total).toBe(1);expect(JSON.stringify(r.json())).toContain('LOCAL high');expect(JSON.stringify(r.json())).not.toContain('LOCAL low');
});
it('legacy findings and inherited detail preserve read-only identity and counts',async()=>{
 const t=await db.tasks().getTask(task);const s=db.exploration(t!.exploration_id);
 const legacy=await s.addNode('finding',{name:'LOCAL legacy',summary:'LOCAL legacy detail',severity:'low',evidence:'LOCAL proof'},0,'confirmed','fixture',[asset]);
 await db.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[other,task]);
 const result=(await app.inject({url:`/api/exploration/findings?context_task=${other}&q=LOCAL&limit=100`,headers})).json();expect(result.total).toBe(3);expect(result.items.every((r:any)=>r.inherited&&r.source_task_id===String(task))).toBe(true);const item=result.items.find((r:any)=>r.id===String(legacy));expect(item.finding_id).toBeUndefined();expect(item.assets[0].id).toBe(String(asset));
 const old=await app.inject({url:`/api/exploration/findings?context_task=${other}&legacy_node=${legacy}`,headers});expect(old.statusCode).toBe(200);expect(old.json()).toMatchObject({id:String(legacy),inherited:true,evidence:'LOCAL proof'});
 const first=result.items.find((r:any)=>r.finding_id);const detail=await app.inject({url:`/api/exploration/findings/${first.finding_id}?id_kind=record&context_task=${other}`,headers});expect(detail.json()).toMatchObject({finding_id:first.finding_id,inherited:true});
});
it('exports readable legacy records without graph nodes',async()=>{
 const r=await db.query(`INSERT INTO findings(task_id,name,vulnclass,severity,summary,evidence,asset_ids,status) VALUES($1,'LOCAL record only','fixture','low','LOCAL legacy record','LOCAL',$2::jsonb,'pending') RETURNING id`,[task,JSON.stringify([asset])]);
 try{const out=await app.inject({url:'/api/exploration/findings/export?scope=all&format=json',headers});expect(out.statusCode).toBe(200);expect(out.body).toContain('LOCAL record only');}finally{await db.query('DELETE FROM findings WHERE id=$1',[r.rows[0].id]);}
});
it('explicit finding record IDs cannot be confused with colliding graph node IDs',async()=>{
 const t=await db.tasks().getTask(task);const s=db.exploration(t!.exploration_id);const original=(await db.query('SELECT * FROM findings WHERE task_id=$1 ORDER BY id LIMIT 1',[task])).rows[0];
 const collisionNode=await s.addNode('finding',{summary:'LOCAL collision'},0,'confirmed','fixture',[asset]);
 await db.query(`INSERT INTO findings(id,task_id,node_id,name,vulnclass,severity,summary,evidence,asset_ids,status) VALUES($1,$2,$3,'LOCAL collision','fixture','low','LOCAL collision','LOCAL',$4::jsonb,'pending')`,[Number(original.node_id),task,collisionNode,JSON.stringify([asset])]);
 const r=await app.inject({url:`/api/exploration/findings/${original.node_id}?id_kind=record`,headers});expect(r.json().name).toBe('LOCAL collision');
 const changed=await app.inject({method:'PATCH',url:`/api/exploration/findings/${original.node_id}?id_kind=record`,headers,payload:{status:'confirmed'}});expect(changed.statusCode).toBe(200);expect((await db.query('SELECT status FROM findings WHERE id=$1',[original.id])).rows[0].status).toBe('pending');
});
it('task conversations include retests linked through the original finding',async()=>{
 const finding=(await db.query('SELECT * FROM findings WHERE task_id=$1 ORDER BY id LIMIT 1',[task])).rows[0];
 const conversation=Number((await db.query("INSERT INTO conversations(agent_key,title) VALUES('retester','LOCAL retest') RETURNING id")).rows[0].id);
 await db.query("INSERT INTO finding_retests(finding_id,conversation_id,status,verdict,snapshot) VALUES($1,$2,'completed','inconclusive',$3::jsonb)",[finding.id,conversation,JSON.stringify(finding)]);
 const result=await app.inject({url:`/api/conversations?task=${task}`,headers});expect(result.statusCode).toBe(200);expect(result.json().conversations).toEqual(expect.arrayContaining([expect.objectContaining({id:conversation,task_id:task,running:false})]));
 const unrelated=await app.inject({url:`/api/conversations?task=${other}`,headers});expect(unrelated.json().conversations.some((r:any)=>r.id===conversation)).toBe(false);
});
it('network navigation is task scoped and exact paths include query variants',async()=>{
 const input={taskID:task,url:'http://127.0.0.1:18899/synthetic?query=2',method:'POST',status:404,reqHead:'POST /synthetic HTTP/1.1',respHead:'HTTP/1.1 404',request:Buffer.alloc(0),response:Buffer.from('LOCAL')};
 await recordExchange(db,input);await recordExchange(db,{...input,url:'http://127.0.0.1:18899',status:204});
 const hosts=await app.inject({url:`/api/traffic/hosts?task=${task}`,headers});expect(hosts.json().hosts).toEqual([{host:'127.0.0.1',count:3}]);
 expect((await app.inject({url:`/api/traffic/hosts?task=${other}`,headers})).json().hosts).toEqual([]);
 const paths=(await app.inject({url:`/api/traffic/paths?task=${task}&host=127.0.0.1`,headers})).json();expect(paths.total).toBe(2);expect(paths.paths).toEqual([{path:'/',count:1},{path:'/synthetic',count:2}]);
 expect((await app.inject({url:`/api/traffic?task=${task}&path_exact=/synthetic`,headers})).json().total).toBe(2);
 expect((await app.inject({url:`/api/traffic?task=${task}&path_exact=/`,headers})).json().total).toBe(1);
 expect((await app.inject({url:`/api/traffic?task=${task}&status_class=4`,headers})).json().total).toBe(1);
 expect((await app.inject({url:`/api/traffic?task=${task}&status_class=2`,headers})).json().total).toBe(2);
 expect((await app.inject({url:`/api/traffic?task=${task}&status_class=invalid`,headers})).statusCode).toBe(400);
 expect((await app.inject({url:'/api/traffic/hosts?task=invalid',headers})).statusCode).toBe(400);
 expect((await app.inject({url:'/api/traffic/paths?host=127.0.0.1',headers})).statusCode).toBe(400);
 expect((await app.inject({url:`/api/traffic/paths?task=${task}&host=127.0.0.1`})).statusCode).toBe(401);
});
it('authentication and existing task evidence remain available without asset approval',async()=>{
 expect((await app.inject({url:url('')})).statusCode).toBe(401);const parent=Number((await db.query("SELECT a.id FROM assets a JOIN task_asset_links l ON l.asset_id=a.id WHERE l.task_id=$1 AND a.type='ip' AND a.ip='127.0.0.1'",[task])).rows[0]!.id);expect((await app.inject({url:url(`/content?ref=work:i${intent}/report.txt`),headers})).statusCode).toBe(200);expect((await app.inject({url:`/api/traffic/exchange/${traffic}/body?task=${task}&side=response`,headers})).statusCode).toBe(200);expect((await app.inject({url:`/api/traffic?task=${task}`,headers})).json().total).toBeGreaterThan(0);
});
