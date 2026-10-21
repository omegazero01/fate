import {authorizeEvidence,type EvidenceOwner} from './authorization.js';
import {putBlob,readBlob,readBlobRange} from './blobs.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '../db/index.js';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export interface ExchangeInput {taskID:number;intentID?:number;url:string;method:string;status:number;reqHead:string;respHead:string;request:Buffer;response:Buffer;contentType?:string;truncated?:boolean;}
export async function recordExchange(db:Database,input:ExchangeInput){
 const id=randomUUID(),reqHash=hash(input.request),respHash=hash(input.response),url=new URL(input.url);
 await db.transaction(async tx=>{
  for(const [,bytes] of ([[reqHash,input.request],[respHash,input.response]] as const).slice().sort((a,b)=>a[0].localeCompare(b[0])))await putBlob(tx,bytes);
  await tx.query(`INSERT INTO traffic_evidence_snapshots(id,source_traffic_id,captured_at,url,method,status,content_type,req_head,resp_head,req_hash,resp_hash,req_len,resp_len,task_id,intent_id) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,Date.now(),input.url,input.method,input.status,input.contentType??'',input.reqHead,input.respHead,reqHash,respHash,input.request.length,input.response.length,input.taskID,input.intentID??null]);
  await tx.query(`INSERT INTO traffic_exchanges(id,task_id,intent_id,host,truncated) VALUES($1,$2,$3,$4,$5)`,[id,input.taskID,input.intentID??null,url.hostname,input.truncated===true]);
 });return id;
}
export async function evidenceBody(db:Database,snapshotID:string,side:string,offset=0,limit=8192){
 const column=side==='request'?'req_hash':'resp_hash';
 const r=await db.query(`SELECT ${column} AS hash FROM traffic_evidence_snapshots WHERE id=$1`,[snapshotID]);
 if(!r.rows[0])throw Object.assign(new Error('证据正文不存在'),{statusCode:404});
 const page=await readBlobRange(db,String(r.rows[0].hash),Math.max(0,Math.floor(Number.isFinite(offset)?offset:0)),limit);
 const bytes=page.bytes,start=page.start;
 // Base64 pages preserve every byte, including invalid UTF-8 and split multibyte characters.
 let end=bytes.length;
 let binary=false,content='';
 try { content=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,end)); }
 catch { binary=true;content=bytes.subarray(0,end).toString('base64'); }
 while(Buffer.byteLength(JSON.stringify(content),'utf8')>16000&&end>0){
   end=Math.floor(end/2);
   try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,end));binary=false;}
   catch{binary=true;content=bytes.subarray(0,end).toString('base64');}
 }
 return {content,offset:start,total:page.total,next_offset:start+end,truncated:start+end<page.total,binary,encoding:binary?'base64':'utf8'};
}
export async function findingEvidence(db:Database,findingID:number){
 const f=(await db.query('SELECT evidence_version,report_evidence_version FROM findings WHERE id=$1',[findingID])).rows[0];
 if(!f)throw Object.assign(new Error('finding not found'),{statusCode:404});
 const rows=await db.query('SELECT b.*,row_to_json(s) AS snapshot FROM finding_traffic_bindings b JOIN traffic_evidence_snapshots s ON s.id=b.snapshot_id WHERE b.finding_id=$1 ORDER BY position,id',[findingID]);
 return {finding_id:String(findingID),version:Number(f.evidence_version),report_version:Number(f.report_evidence_version),bindings:await (async()=>{const visible=[];for(const row of rows.rows){try{await authorizeEvidence(db,row.snapshot as EvidenceOwner);visible.push(row);}catch{/* revoked evidence is absent from every report projection */}}return visible;})()};
}
export async function bindEvidence(db:Database,findingID:number,refs:Array<{traffic_id:string;role?:string;note?:string}>,taskID:number){
 await db.query('SELECT id FROM findings WHERE id=$1 FOR UPDATE',[findingID]);
 for(const ref of refs){
  if(!['baseline','proof','verification','supporting'].includes(ref.role??'supporting'))throw Object.assign(new Error('无效证据角色'),{statusCode:400});
  const permitted=await db.query(`SELECT s.* FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id WHERE e.id=$1 AND e.task_id=$2`,[ref.traffic_id,taskID]);
  if(!permitted.rowCount)throw Object.assign(new Error('流量不存在或不属于漏洞任务'),{statusCode:404});
  await authorizeEvidence(db,permitted.rows[0] as EvidenceOwner,taskID);
  await db.query(`INSERT INTO finding_traffic_bindings(finding_id,snapshot_id,role,note,position) VALUES($1,$2,$3,$4,COALESCE((SELECT max(position)+1 FROM finding_traffic_bindings WHERE finding_id=$1),0)) ON CONFLICT(finding_id,snapshot_id) DO NOTHING`,[findingID,ref.traffic_id,ref.role??'supporting',ref.note??'']);
 }
 await db.query('UPDATE findings SET evidence_version=evidence_version+1 WHERE id=$1',[findingID]);
 return findingEvidence(db,findingID);
}
