import {randomUUID,createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {cleanupOrphanBlobs,putBlob,readBlob} from '../../evidence/blobs.js';
import {archiveReport,normalizeReproduction,prepareReproduction,attachStepTraffic,assembleReport,reportSections,stepSource} from '../../evidence/reproduction.js';
const error=(m:string,statusCode=400)=>Object.assign(new Error(m),{statusCode});
export function registerFindingReproductionRoutes(app:FastifyInstance){
 const db=app.db,base='/api/exploration/findings/:id';
 const owner=async(id:string,context?:string,write=false)=>{
  const f=(await db.query('SELECT * FROM findings WHERE id=$1 AND finding_readable(id)',[Number(id)])).rows[0];if(!f)throw error('漏洞不存在或不可访问',404);
  if(context&&Number(context)!==Number(f.task_id)){
   if(write||!(await db.query('SELECT 1 FROM task_relations WHERE task_id=$1 AND source_task_id=$2',[Number(context),f.task_id])).rowCount)throw error('来源任务漏洞只读或不可访问',403);
  }return f;
 };
 app.get(base+'/reproduction',async req=>{
  const f=await owner((req.params as {id:string}).id,(req.query as {context_task?:string}).context_task);
  const images=(await db.query('SELECT id,step_id,mime,caption,position FROM finding_step_images WHERE finding_id=$1 ORDER BY position,id',[f.id])).rows;
  const job=(await db.query(`SELECT j.id,j.conversation_id,j.created_at,CASE WHEN r.status='completed' AND f.report_revision<=j.report_revision THEN 'failed' ELSE r.status END AS status,r.error FROM finding_report_jobs j LEFT JOIN conversation_runs r ON r.id=j.run_id JOIN findings f ON f.id=j.finding_id WHERE j.finding_id=$1 ORDER BY j.id DESC LIMIT 1`,[f.id])).rows[0];
  const versions=(await db.query('SELECT revision,evidence_version,created_at FROM finding_report_versions WHERE finding_id=$1 ORDER BY revision DESC LIMIT 50',[f.id])).rows;
  return {reproduction:f.reproduction,report_sections:f.report_sections,report_revision:Number(f.report_revision),evidence_version:Number(f.evidence_version),images,job,versions,markdown:assembleReport(f,images as never)};
 });
 app.get(base+'/steps/:step/source',async req=>{
  const p=req.params as {id:string;step:string},q=req.query as {context_task?:string;offset?:string};const f=await owner(p.id,q.context_task);
  const step=normalizeReproduction(f.reproduction)?.steps.find(s=>s.id===p.step);if(!step)throw error('步骤不存在',404);
  const raw=Array.from(await stepSource(db,{taskID:Number(f.task_id),evidence:String(f.evidence)},step)),offset=Number(q.offset??0);
  if(!Number.isSafeInteger(offset)||offset<0)throw error('无效续读位置');
  return {content:raw.slice(offset,offset+8000).join(''),total:raw.length,next_offset:Math.min(offset+8000,raw.length)};
 });
 app.get(base+'/report-versions/:revision',async req=>{
  const p=req.params as {id:string;revision:string};await owner(p.id,(req.query as {context_task?:string}).context_task);
  const v=(await db.query('SELECT * FROM finding_report_versions WHERE finding_id=$1 AND revision=$2',[p.id,Number(p.revision)])).rows[0];if(!v)throw error('版本不存在',404);return v;
 });
 app.patch(base+'/reproduction',async req=>{
  const p=req.params as {id:string},b=req.body as {report_revision:number;evidence_version:number;reproduction:unknown;report_sections?:unknown};await owner(p.id,(req.query as {context_task?:string}).context_task,true);
  return db.transaction(async tx=>{
   const f=(await tx.query('SELECT * FROM findings WHERE id=$1 FOR UPDATE',[p.id])).rows[0]!;
   if(Number(f.report_revision)!==b.report_revision||Number(f.evidence_version)!==b.evidence_version)throw error('版本已变化，请刷新',409);
   const repro=normalizeReproduction(b.reproduction),old=normalizeReproduction(f.reproduction);
   for(const step of repro?.steps??[]){const before=old?.steps.find(s=>s.id===step.id);if(before&&before.request===step.request&&before.response===step.response&&before.traffic_id===step.traffic_id&&before.source===step.source&&before.source_ref===step.source_ref){step.verified=(f.reproduction as {steps:Array<{id:string;verified?:boolean}>})?.steps.find(s=>s.id===step.id)?.verified;continue;}
    const checked=await prepareReproduction(tx,{...repro,steps:[step]},{taskID:Number(f.task_id),evidence:String(f.evidence),findingNodeID:Number(f.node_id)},true);Object.assign(step,checked!.steps[0]);}
   await archiveReport(tx,f);await attachStepTraffic(tx,Number(f.id),Number(f.task_id),repro);
   await tx.query('UPDATE findings SET reproduction=$2,report_revision=report_revision+1,evidence_version=evidence_version+1 WHERE id=$1',[f.id,repro]);
   if(b.report_sections){const sections=reportSections(b.report_sections);const current=(await tx.query('SELECT * FROM findings WHERE id=$1',[f.id])).rows[0]!;await tx.query('UPDATE findings SET report_sections=$2,report=$3,report_evidence_version=evidence_version WHERE id=$1',[f.id,sections,assembleReport({...current,report_sections:sections,report_evidence_version:current.evidence_version})]);}
   await tx.query('UPDATE finding_step_images SET step_id=NULL WHERE finding_id=$1 AND NOT(step_id=ANY($2::text[]))',[f.id,repro?.steps.map(s=>s.id)??[]]);return {saved:true};
  });
 });
 app.post(base+'/analyze',async(req,reply)=>{
  const p=req.params as {id:string};await owner(p.id,(req.query as {context_task?:string}).context_task,true);
  const job=await db.transaction(async tx=>{
   const f=(await tx.query('SELECT * FROM findings WHERE id=$1 FOR UPDATE',[p.id])).rows[0]!;
   const active=(await tx.query(`SELECT j.* FROM finding_report_jobs j LEFT JOIN conversation_runs r ON r.id=j.run_id WHERE j.finding_id=$1 AND (r.status IN ('queued','running') OR (j.run_id IS NULL AND j.created_at>now()-interval '1 minute')) ORDER BY j.id DESC LIMIT 1`,[f.id])).rows[0];if(active)return active;
   const triggered=(await tx.query(`SELECT r.id,r.conversation_id FROM conversation_runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.agent_key='reporter' AND r.status IN ('queued','running') AND EXISTS(SELECT 1 FROM agent_trigger_events e WHERE e.event_key=ANY(r.event_keys) AND e.kind='finding' AND (e.payload->>'finding_id')::bigint=$1) ORDER BY r.id LIMIT 1`,[f.id])).rows[0];
   if(triggered)return (await tx.query('INSERT INTO finding_report_jobs(finding_id,conversation_id,run_id,evidence_version,report_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(finding_id,run_id) DO UPDATE SET finding_id=EXCLUDED.finding_id RETURNING *',[f.id,triggered.conversation_id,triggered.id,f.evidence_version,f.report_revision])).rows[0]!;
   const c=await app.engine.conversations.create('reporter',`整理漏洞 #${f.id}`,null,Number(f.task_id),tx);
   const run=await app.engine.conversations.enqueue(Number(c.id),`请读取漏洞 #${f.id}，按已有真实证据整理分步骤报告。使用 report_sections 提交说明、影响和修复建议。历史过程只能使用 source=evidence 的原文摘录或真实 traffic_id 补全，缺失材料如实说明。保持已提交步骤 ID，不修改报文原文。`,[],randomUUID(),tx);
   return (await tx.query('INSERT INTO finding_report_jobs(finding_id,conversation_id,run_id,evidence_version,report_revision) VALUES($1,$2,$3,$4,$5) RETURNING *',[f.id,c.id,run.run_id,f.evidence_version,f.report_revision])).rows[0]!;
  });if(typeof app.engine.conversations.pump==='function')void app.engine.conversations.pump().catch(()=>{});return reply.code(202).send(job);
 });
 app.post(base+'/images',async(req,reply)=>{
  const p=req.params as {id:string},q=req.query as {context_task?:string;step_id?:string};await owner(p.id,q.context_task,true);
  const file=await req.file({limits:{fileSize:10*1024*1024,files:1}});if(!file)throw error('需要图片');
  const bytes=await file.toBuffer();
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':/^GIF8[79]a/.test(bytes.subarray(0,6).toString())?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
  if(!mime||bytes.length<20||(mime==='image/png'&&(!bytes.subarray(12,16).equals(Buffer.from('IHDR'))||!bytes.subarray(-8,-4).equals(Buffer.from('IEND'))))||(mime==='image/jpeg'&&(bytes.at(-2)!==255||bytes.at(-1)!==217))||(mime==='image/webp'&&bytes.readUInt32LE(4)+8!==bytes.length))throw error('仅接受完整 PNG/JPEG/GIF/WebP 图片');
  if(mime==='image/png'&&bytes.length>=24&&(bytes.readUInt32BE(16)*bytes.readUInt32BE(20)>64000000))throw error('图片尺寸过大');
  const hash=createHash('sha256').update(bytes).digest('hex');
  try{const saved=await db.transaction(async tx=>{
   const f=(await tx.query('SELECT reproduction FROM findings WHERE id=$1 AND finding_readable(id) FOR UPDATE',[p.id])).rows[0];if(!f)throw error('漏洞不可访问',404);
   if(q.step_id&&!(f.reproduction as {steps?:Array<{id:string}>})?.steps?.some(s=>s.id===q.step_id))throw error('步骤不存在');
   await putBlob(tx,bytes);
   return (await tx.query(`INSERT INTO finding_step_images(id,finding_id,step_id,blob_hash,mime,position) VALUES($1,$2,$3,$4,$5,COALESCE((SELECT max(position)+1 FROM finding_step_images WHERE finding_id=$2),0)) RETURNING id,step_id,mime,caption,position`,[randomUUID(),p.id,q.step_id??null,hash,mime])).rows[0];});return reply.code(201).send(saved);
  }catch(e){await cleanupOrphanBlobs(db,[hash]);throw e;}
 });
 app.get(base+'/images/:image',async(req,reply)=>{
  const p=req.params as {id:string;image:string};await owner(p.id,(req.query as {context_task?:string}).context_task);
  const img=(await db.query('SELECT * FROM finding_step_images WHERE finding_id=$1 AND id=$2',[p.id,p.image])).rows[0];if(!img)throw error('图片不存在',404);
  return reply.type(String(img.mime)).header('X-Content-Type-Options','nosniff').header('Cache-Control','private, no-store').send(await readBlob(db,String(img.blob_hash)));
 });
 for(const method of ['PATCH','DELETE'] as const)app.route({method,url:base+'/images/:image',handler:async req=>{
  const p=req.params as {id:string;image:string};const f=await owner(p.id,(req.query as {context_task?:string}).context_task,true),b=(req.body??{}) as {caption?:string;step_id?:string|null;position?:number};
  if(b.step_id&&!(f.reproduction as {steps?:Array<{id:string}>})?.steps?.some(s=>s.id===b.step_id))throw error('步骤不存在');
  if(b.caption!==undefined&&(typeof b.caption!=='string'||b.caption.length>2000))throw error('图注过长');if(b.position!==undefined&&(!Number.isSafeInteger(b.position)||b.position<0))throw error('无效排序');
  return db.transaction(async tx=>{
   await tx.query('SELECT id FROM findings WHERE id=$1 FOR UPDATE',[p.id]);
   if(b.position!==undefined){const ids=(await tx.query('SELECT id FROM finding_step_images WHERE finding_id=$1 ORDER BY position,id',[p.id])).rows.map(r=>String(r.id));if(!ids.includes(p.image))throw error('图片不存在',404);ids.splice(ids.indexOf(p.image),1);ids.splice(Math.min(b.position,ids.length),0,p.image);for(const [position,id] of ids.entries())await tx.query('UPDATE finding_step_images SET position=$2 WHERE id=$1',[id,position]);}
   const result=method==='DELETE'?await tx.query('DELETE FROM finding_step_images WHERE finding_id=$1 AND id=$2 RETURNING id',[p.id,p.image]):await tx.query('UPDATE finding_step_images SET caption=COALESCE($3,caption),step_id=CASE WHEN $4 THEN $5 ELSE step_id END WHERE finding_id=$1 AND id=$2 RETURNING id',[p.id,p.image,b.caption??null,'step_id' in b,b.step_id??null]);if(!result.rowCount)throw error('图片不存在',404);return {saved:true};
  });
 }});
}
