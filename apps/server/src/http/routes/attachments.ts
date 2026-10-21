import {putBlob,cleanupOrphanBlobs} from '../../evidence/blobs.js';
import type {FastifyInstance} from 'fastify';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export function registerAttachmentRoutes(app:FastifyInstance){
 app.post('/api/chat/upload',async req=>{
  const q=req.query as {scope:string;id:string};let task:number|null=null,conversation:number|null=null;
  if(q.scope==='task'){task=Number(q.id);if(!await app.db.tasks().getTask(task))throw Object.assign(new Error('task not found'),{statusCode:404});}
  else if(q.scope==='session'){conversation=Number(q.id);await app.engine.conversations.assertWritable(conversation);if(!(await app.db.query('SELECT id FROM conversations WHERE id=$1',[conversation])).rowCount)throw Object.assign(new Error('conversation not found'),{statusCode:404});}
  else if(q.scope!=='staging')throw Object.assign(new Error('无效上传 scope'),{statusCode:400});
  const attachments:unknown[]=[],created:string[]=[],hashes=new Set<string>();
  try{
   const parts:Array<{bytes:Buffer;name:string;mime:string;hash:string}>=[];
   for await(const part of req.files({limits:{files:8,fileSize:10*1024*1024}})){
    const bytes=await part.toBuffer(),provided=path.basename(part.filename).replace(/[\x00-\x1f]/g,'_');
    parts.push({bytes,name:provided&&provided!=='.'&&provided!=='..'?provided:'file',mime:part.mimetype,hash:createHash('sha256').update(bytes).digest('hex')});
   }
   await app.db.transaction(async db=>{
    // Acquire deduplication locks in a stable order across concurrent uploads.
    for(const part of [...parts].sort((a,b)=>a.hash.localeCompare(b.hash))){hashes.add(part.hash);await putBlob(db,part.bytes);}
    for(const part of parts){
     const id=randomUUID(),relative=`artifacts/${id}/${part.name}`,artifactDir=path.join(app.dataDir,'artifacts',id);
     await mkdir(artifactDir,{recursive:true});created.push(artifactDir);
     await writeFile(path.join(artifactDir,part.name),part.bytes,{flag:'wx',mode:0o600});
     await db.query(`INSERT INTO chat_artifacts(id,task_id,conversation_id,name,path,mime,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,task,conversation,part.name,relative,part.mime,part.bytes.length,part.hash]);
     attachments.push({name:part.name,path:relative,size:part.bytes.length});
    }
   });
  }catch(error){await Promise.all(created.map(dir=>rm(dir,{recursive:true,force:true})));await cleanupOrphanBlobs(app.db,hashes);throw error;}
  return {attachments};
 });
 app.get('/api/tasks/:id/attachments',async req=>({attachments:(await app.db.query('SELECT name,path,size,mime,sha256 FROM chat_artifacts WHERE task_id=$1 ORDER BY created_at',[Number((req.params as {id:string}).id)])).rows}));
}
