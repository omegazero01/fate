import {authorizeEvidence,authorizedEvidenceIDs} from '../../evidence/authorization.js';
import type {FastifyInstance} from 'fastify';
import {bindEvidence,evidenceBody,findingEvidence} from '../../evidence/store.js';
import {readBlob,blobContains} from '../../evidence/blobs.js';
import {resolveGraphNode} from '../../db/graph_view.js';
import type {Node} from '../../db/exploration.js';
import {loadToolOutput,outputPage} from '../../evidence/tool-outputs.js';
export function registerEvidenceRoutes(app:FastifyInstance){
 const db=app.db;
 app.get('/api/tool-outputs/:id',async(req,reply)=>{
  const id=(req.params as {id:string}).id,q=req.query as {offset?:string;download?:string};
  const body=await loadToolOutput(db,id);
  if(q.download==='1')return reply.type('application/json; charset=utf-8').header('content-disposition','attachment; filename="tool-output.json"').send(body);
  return outputPage(id,body,Number(q.offset)||0);
 });
 const finding=async(id:number,context?:number,write=false)=>{
  const f=(await db.query('SELECT * FROM findings WHERE id=$1',[id])).rows[0];
  if(!f)throw Object.assign(new Error('finding not found'),{statusCode:404});
  const ownerTask=Number(f.task_id),projectionTask=Number.isSafeInteger(context)&&Number(context)>0?Number(context):ownerTask;
  if(projectionTask!==ownerTask){
   const source=await db.query('SELECT 1 FROM task_relations WHERE task_id=$1 AND source_task_id=$2',[projectionTask,ownerTask]);
   if(write||!source.rowCount)throw Object.assign(new Error('来源任务证据只读或不可访问'),{statusCode:403});
  }
  try{
   if(f.node_id!==null){
    const task=(await db.query<{exploration_id:string}>('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[projectionTask])).rows[0];
    if(!task)throw new Error('task not found');
    await resolveGraphNode(db,projectionTask,Number(task.exploration_id),Number(f.node_id));
   }else{
   }
  }catch{throw Object.assign(new Error('漏洞不属于有效任务'),{statusCode:403});}
  return f;
 };
 const snapshot=async(id:number,bid:string)=>{const r=await db.query('SELECT snapshot_id FROM finding_traffic_bindings WHERE finding_id=$1 AND id=$2',[id,bid]);if(!r.rowCount)throw Object.assign(new Error('binding not found'),{statusCode:404});return String(r.rows[0]!.snapshot_id);};
 const authorizeBinding=async(f:Record<string,unknown>,snapshotID:string)=>{
  const traffic=(await db.query<{task_id:string;url:string;intent_id:string|null}>('SELECT task_id,url,intent_id FROM traffic_evidence_snapshots WHERE id=$1',[snapshotID])).rows[0];
  if(!traffic||Number(traffic.task_id)!==Number(f.task_id))throw Object.assign(new Error('证据不属于漏洞任务'),{statusCode:403});
  await authorizeEvidence(db,traffic,Number(f.task_id));
 };
 app.get('/api/traffic',async req=>{
  const q=req.query as Record<string,string>;const page=Math.max(0,Number(q.page)||0),size=Math.min(500,Math.max(1,Number(q.size)||100));
  const args:unknown[]=[];const where:string[]=[];
  for(const [key,col] of [['task','e.task_id::text'],['host','e.host'],['method','s.method'],['status','s.status::text']] as const)if(q[key]){args.push(q[key]);where.push(`${col}=$${args.length}`);}
  for(const key of ['q','path'])if(q[key]){args.push('%'+q[key]+'%');where.push(`${key==='body'?"encode(b.bytes,'escape')":'s.url'} ILIKE $${args.length}`);}
  for(const [key,op] of [['resp_min','>='],['resp_max','<=']] as const)if(Number(q[key])>=0){args.push(Number(q[key]));where.push(`s.resp_len${op}$${args.length}`);}
  if(q.status_class){if(!/^[1-5]$/.test(q.status_class))throw Object.assign(new Error('无效状态码分组'),{statusCode:400});args.push(Number(q.status_class)*100);where.push(`s.status >= $${args.length} AND s.status < $${args.length}+100`);}
  if(q.path_exact){args.push(q.path_exact);where.push(`COALESCE(NULLIF(split_part(split_part(regexp_replace(s.url,'^https?://[^/?#]+','','i'),'?',1),'#',1),''),'/')=$${args.length}`);}
  const from=`FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id `;
  const candidates=await db.query(`SELECT s.id,s.task_id,s.intent_id,s.url,s.resp_hash ${from}${where.length?' WHERE '+where.join(' AND '):''}`,args);
  let allowed=await authorizedEvidenceIDs(db,candidates.rows as never[]);
  if(q.body){const ids=new Set(allowed),matches:string[]=[];for(const row of candidates.rows){if(ids.has(String(row.id))&&await blobContains(db,String(row.resp_hash),q.body))matches.push(String(row.id));}allowed=matches;}
  args.push(allowed);where.push(`s.id=ANY($${args.length}::text[])`);
  const filter=' WHERE '+where.join(' AND ');
  const count=await db.query(`SELECT count(*) n ${from}${filter}`,args);
  const order=q.order==='asc'?'ASC':'DESC',sort=q.sort==='resp_len'?'s.resp_len':q.sort==='status'?'s.status':'s.captured_at';
  const rows=await db.query(`SELECT s.id,s.captured_at AS ts,e.host,s.method,s.url,s.status,s.content_type,s.resp_len,e.task_id,s.intent_id,e.truncated ${from}${filter} ORDER BY ${sort} ${order},s.id LIMIT ${size} OFFSET ${page*size}`,args);
  return {enabled:true,capture_mode:'HTTP/HTTPS traffic routed through the recording proxy',page,size,total:Number(count.rows[0]?.n),exchanges:rows.rows.map(r=>({...r,ts:new Date(Number(r.ts)).toISOString(),resp_len:Number(r.resp_len)}))};
 });
 app.get('/api/traffic/exchange',async req=>{
  const id=String((req.query as {id:string}).id);const row=(await db.query('SELECT s.* FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id WHERE e.id=$1',[id])).rows[0];
  if(!row)throw Object.assign(new Error('traffic not found'),{statusCode:404});
  await authorizeEvidence(db,row as never,(req.query as {task?:string}).task===undefined?undefined:Number((req.query as {task:string}).task));
  const request=await evidenceBody(db,id,'request'),response=await evidenceBody(db,id,'response');
  return {req:row.req_head+'\r\n\r\n'+request.content,resp:row.resp_head+'\r\n\r\n'+response.content,request,response};
 });
 app.get('/api/traffic/exchange/:id/body',async(req,reply)=>{
  const id=(req.params as {id:string}).id,q=req.query as Record<string,string>;
  if(!['request','response'].includes(q.side??''))throw Object.assign(new Error('无效正文方向'),{statusCode:400});
  const row=(await db.query('SELECT s.* FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id WHERE e.id=$1',[id])).rows[0];
  if(!row)throw Object.assign(new Error('流量不存在'),{statusCode:404});
  await authorizeEvidence(db,row as never,q.task===undefined?undefined:Number(q.task));
  const offset=Number(q.offset??0);if(!Number.isSafeInteger(offset)||offset<0)throw Object.assign(new Error('无效读取位置'),{statusCode:400});
  if(q.download==='1')return reply.type('application/octet-stream').header('X-Content-Type-Options','nosniff').header('content-disposition',`attachment; filename="${q.side}.bin"`).send(await readBlob(db,String(row[q.side==='request'?'req_hash':'resp_hash'])));
  return evidenceBody(db,id,q.side!,offset);
 });
 // Navigation counts use the same authorization projection as the request list.
 app.get('/api/traffic/hosts',async req=>{
  const q=req.query as {task?:string};
  if(q.task!==undefined&&(!/^[1-9]\d*$/.test(q.task)))throw Object.assign(new Error('无效任务'),{statusCode:400});
  const rows=(await db.query('SELECT s.id,s.task_id,s.intent_id,s.url FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id'+(q.task?' WHERE e.task_id=$1':''),q.task?[Number(q.task)]:[])).rows;
  const ids=await authorizedEvidenceIDs(db,rows as never[]);
  return {hosts:(await db.query('SELECT host,count(*)::int count FROM traffic_exchanges WHERE id=ANY($1::text[]) GROUP BY host ORDER BY count(*) DESC,host',[ids])).rows};
 });
 app.get('/api/traffic/paths',async req=>{
  const q=req.query as Record<string,string>;
  if(!/^[1-9]\d*$/.test(q.task??'')||!q.host)throw Object.assign(new Error('必须指定任务及主机'),{statusCode:400});
  const page=Math.max(0,Math.floor(Number(q.page)||0)),size=100;
  const rows=(await db.query('SELECT s.id,s.task_id,s.intent_id,s.url FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id WHERE e.task_id=$1 AND e.host=$2',[Number(q.task),q.host])).rows;
  const ids=new Set(await authorizedEvidenceIDs(db,rows as never[])),counts=new Map<string,number>();
  for(const row of rows){if(!ids.has(String(row.id)))continue;try{const path=new URL(String(row.url)).pathname;counts.set(path,(counts.get(path)??0)+1);}catch{/* Invalid historical URLs remain available in the host list. */}}
  const all=[...counts].sort(([a],[b])=>a.localeCompare(b));return {paths:all.slice(page*size,(page+1)*size).map(([path,count])=>({path,count})),total:all.length,page,size};
 });
 app.delete('/api/traffic',async req=>({deleted:(await db.query('DELETE FROM traffic_exchanges WHERE host=$1',[(req.query as {host:string}).host])).rowCount}));
 app.delete('/api/traffic/hosts',async req=>({deleted:(await db.query('DELETE FROM traffic_exchanges WHERE host=ANY($1::text[])',[(req.body as {hosts:string[]}).hosts])).rowCount}));
 app.delete('/api/traffic/all',async()=>({deleted:(await db.query('DELETE FROM traffic_exchanges')).rowCount,reclaimed:0}));
 const base='/api/exploration/findings/:id/traffic';
 app.get(base,async req=>{const id=Number((req.params as {id:string}).id),f=await finding(id,Number((req.query as {context_task?:string}).context_task));const result=await findingEvidence(db,id);const allowed=[];for(const binding of result.bindings){try{await authorizeBinding(f,String(binding.snapshot_id));allowed.push(binding);}catch{/* revoked target evidence is omitted from this projection */}}return {...result,bindings:allowed};});
 app.post(base,async req=>{
  const id=Number((req.params as {id:string}).id),f=await finding(id,Number((req.query as {context_task?:string}).context_task),true);
  const refs=(req.body as {traffic_refs?:Array<{traffic_id:string;role?:string;note?:string}>}).traffic_refs;
  if(!Array.isArray(refs)||refs.length>100)throw Object.assign(new Error('traffic_refs 必须为不超过 100 项的数组'),{statusCode:400});
  for(const ref of refs)await authorizeBinding(f,ref.traffic_id);
  return db.transaction(tx=>bindEvidence(tx,id,refs,Number(f.task_id)));
 });
 for(const method of ['PATCH','DELETE','PUT'] as const)app.route({method,url:base+(method==='PUT'?'/order':'/:bid'),handler:async req=>{
  const p=req.params as {id:string;bid?:string},id=Number(p.id),body=req.body as {version:number;role?:string;note?:string;binding_ids?:string[]};
  await finding(id,Number((req.query as {context_task?:string}).context_task),true);
  return db.transaction(async tx=>{
   const f=(await tx.query('SELECT evidence_version FROM findings WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(Number(f?.evidence_version)!==Number(body.version))throw Object.assign(new Error('证据版本已变化，请刷新'),{statusCode:409});
   if(method==='PUT'){
    const ids=(await tx.query('SELECT id::text FROM finding_traffic_bindings WHERE finding_id=$1',[id])).rows.map(r=>String(r.id));
    if(!body.binding_ids||ids.length!==body.binding_ids.length||new Set(body.binding_ids).size!==ids.length||body.binding_ids.some(v=>!ids.includes(v)))throw Object.assign(new Error('必须提交完整绑定顺序'),{statusCode:400});
    for(const [position,bid] of body.binding_ids.entries())await tx.query('UPDATE finding_traffic_bindings SET position=$3 WHERE id=$1 AND finding_id=$2',[bid,id,position]);
   }else{
    await snapshot(id,p.bid!);
    if(method==='DELETE')await tx.query('DELETE FROM finding_traffic_bindings WHERE id=$1 AND finding_id=$2',[p.bid,id]);
    else{if(!['baseline','proof','verification','supporting'].includes(body.role??''))throw Object.assign(new Error('无效证据角色'),{statusCode:400});await tx.query('UPDATE finding_traffic_bindings SET role=$3,note=$4 WHERE id=$1 AND finding_id=$2',[p.bid,id,body.role,body.note??'']);}
   }
   await tx.query('UPDATE findings SET evidence_version=evidence_version+1 WHERE id=$1',[id]);return findingEvidence(tx,id);
  });
 }});
 app.get(base+'/:bid',async req=>{
  const p=req.params as {id:string;bid:string},f=await finding(Number(p.id),Number((req.query as {context_task?:string}).context_task));
  const sid=await snapshot(Number(p.id),p.bid);await authorizeBinding(f,sid);const all=await findingEvidence(db,Number(p.id));
  return {binding:all.bindings.find(b=>String(b.id)===p.bid),request:await evidenceBody(db,sid,'request'),response:await evidenceBody(db,sid,'response')};
 });
 app.get(base+'/:bid/body',async(req,reply)=>{
  const p=req.params as {id:string;bid:string},q=req.query as Record<string,string>,f=await finding(Number(p.id),Number(q.context_task));
  const sid=await snapshot(Number(p.id),p.bid);await authorizeBinding(f,sid);
  if(q.download==='1'){const r=await db.query(`SELECT s.${q.side==='request'?'req_hash':'resp_hash'} AS hash FROM traffic_evidence_snapshots s WHERE s.id=$1`,[sid]);if(!r.rowCount)throw Object.assign(new Error('evidence body not found'),{statusCode:404});return reply.type('application/octet-stream').send(await readBlob(db,String(r.rows[0]!.hash)));}
  return evidenceBody(db,sid,q.side??'response',Number(q.offset)||0);
 });
}
