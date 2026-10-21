import {beforeAll,afterAll,it,expect} from 'vitest';
import http from 'node:http';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {openDatabase,type Database} from '../db/index.js';
import {configureEvidenceStore,readBlob} from '../evidence/blobs.js';
import {startRecordingGateway} from './recording.js';
import {taskCredentials} from './credentials.js';
import {evidenceRequest} from '../evidence/http.js';
import {runContext} from '../tools/context.js';

const exec=promisify(execFile),name=`series_recording_${process.pid}`;
let db:Database,dir:string;
beforeAll(async()=>{process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}?sslmode=disable`;db=await openDatabase();dir=await mkdtemp(path.join(tmpdir(),'fate-recording-'));configureEvidenceStore(db,dir);});
afterAll(async()=>{await db.close();const admin=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres?sslmode=disable'});await admin.connect();await admin.query(`DROP DATABASE ${name}`);await admin.end();await rm(dir,{recursive:true,force:true});});

it('records HTTP and self-signed wrong-host HTTPS through both target transports without changing global TLS',async()=>{
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',dir+'/key','-out',dir+'/cert','-days','1','-subj','/CN=wrong-host.invalid','-addext','subjectAltName=DNS:wrong-host.invalid']);
 const seen:Array<http.IncomingHttpHeaders>=[],handler:http.RequestListener=(req,res)=>{seen.push(req.headers);res.writeHead(200,{'Content-Type':'text/plain'});res.end('LOCAL PROXY FIXTURE '+req.url);};
 const plain=http.createServer(handler),secure=https.createServer({key:await readFile(dir+'/key'),cert:await readFile(dir+'/cert')},handler);
 const listen=async(server:http.Server)=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return (server.address() as {port:number}).port;};
 const httpPort=await listen(plain),httpsPort=await listen(secure);
 const task=await db.tasks().createTaskWithOptions('LOCAL recording fixture','',{}),s=db.exploration(task.exploration_id);
 await db.assets().upsertHTTPService({url:`http://127.0.0.1:${httpPort}`,taskID:task.id});
 await db.assets().upsertHTTPService({url:`https://127.0.0.1:${httpsPort}`,taskID:task.id});
 const intent=await s.addIntent({summary:'LOCAL proxy only'},1,[],'user');await s.setIntentState(intent,'running');
 const proxy=await startRecordingGateway(db,'127.0.0.1',0,dir),creds=taskCredentials(task.id,`worker:${intent}`)!;
 try{
  for(const url of [`http://127.0.0.1:${httpPort}/plain`,`https://127.0.0.1:${httpsPort}/secure`]){
   const result=await exec('curl',['--silent','--show-error','--fail','--max-time','10','--noproxy','','--proxy',proxy.proxyURL(),'--proxy-user',creds.username+':'+creds.password,'--cacert',proxy.caFile!,url]);
   expect(result.stdout).toContain('LOCAL PROXY FIXTURE');
  }
  await expect(fetch(`https://127.0.0.1:${httpsPort}/global-must-verify`)).rejects.toThrow();
  const direct=await evidenceRequest(runContext(db,task.id,task.exploration_id,'worker',{intentID:intent}),{url:`https://127.0.0.1:${httpsPort}/direct`});
  expect(direct.status).toBe(200);expect(direct.traffic_id).toBeTruthy();
  const rows=(await db.query('SELECT s.*,e.intent_id FROM traffic_exchanges e JOIN traffic_evidence_snapshots s ON s.id=e.id WHERE e.task_id=$1 ORDER BY s.url',[task.id])).rows;
  expect(rows).toHaveLength(3);expect(seen.every(h=>!h['proxy-authorization'])).toBe(true);
  for(const row of rows){expect(Number(row.intent_id)).toBe(intent);expect((await readBlob(db,String(row.resp_hash))).toString()).toContain('LOCAL PROXY FIXTURE');}
  expect((await db.query('SELECT bytes,file_path FROM evidence_blobs WHERE hash=$1',[rows[0]!.resp_hash])).rows[0]).toMatchObject({bytes:null,file_path:expect.any(String)});
  expect((await stat(path.join(dir,'proxy-ca','keys','ca.private.key'))).mode&0o777).toBe(0o600);
 }finally{await proxy.close();for(const server of [plain,secure]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}}
});
