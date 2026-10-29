// Controlled local rollout after isolated acceptance; never starts a second executor.
import pg from 'pg';
import path from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,cpSync,statSync} from 'node:fs';
import {spawn,execFileSync,spawnSync} from 'node:child_process';
import {Database,openDatabase} from '../src/db/index.js';
import {postgresDSN} from '../src/config/index.js';
import {signJWT} from '../src/http/auth.js';
const resultFile=process.env.FATE_PERFORMANCE_RESULT;
if(!resultFile)throw new Error('Provide the reviewed 30 minute performance result');
const acceptance=JSON.parse(readFileSync(resultFile,'utf8'));
if(acceptance.elapsed_seconds<1800||!acceptance.checks||Object.values(acceptance.checks).some(v=>v!==true))throw new Error('Performance acceptance has not passed');
const evidence=path.resolve('../../docs/reviews/evidence/performance-20261026');
if(JSON.parse(readFileSync(path.join(evidence,'real-smoke.json'),'utf8')).status!=='passed')throw new Error('Real model smoke has not passed');
const listeners=spawnSync('lsof',['-tiTCP:8787','-tiTCP:8788','-sTCP:LISTEN'],{encoding:'utf8'});
if(listeners.stdout.trim())throw new Error('An executor is listening; stop and verify it before this rollout');
const cwd=process.cwd(),stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backup=path.join(process.env.HOME!,'.local/share/fate/backups',`performance-${stamp}`);
mkdirSync(backup,{recursive:true,mode:0o700});
const dsn=postgresDSN().dsn,db=new Database(new pg.Pool({connectionString:dsn}));
const states=async(d:Database)=>(await d.query('SELECT id,status,paused,queued,execution_mode FROM tasks WHERE deleted_at IS NULL ORDER BY id')).rows;
const invariant=async(d:Database)=>(await d.query(`SELECT
 (SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM assets) assets,(SELECT count(*) FROM exploration_nodes) nodes,
 (SELECT count(*) FROM activity) activities,
 (SELECT md5(string_agg(id::text||':'||md5(COALESCE(detail,'')),',' ORDER BY id)) FROM activity) activity_digest,
 (SELECT md5(string_agg(id::text||':'||payload::text,',' ORDER BY id)) FROM exploration_nodes WHERE kind IN('fact','finding')) evidence_digest`)).rows[0];
const beforePrompts=(await db.query('SELECT id,md5(template_text) hash FROM agent_prompts ORDER BY id')).rows;
const manifest:any={version:'fate-performance-20261026',backup,acceptance:resultFile,started_at:new Date().toISOString(),before_tasks:await states(db),before_migration:await invariant(db)};
const save=()=>{for(const root of [backup,evidence])writeFileSync(path.join(root,'deployment.json'),JSON.stringify(manifest,null,2),{mode:0o600});};save();
const dump=openSync(path.join(backup,'database.dump'),'w',0o600);
try{execFileSync('docker',['exec','series-ts-pg','pg_dump','-U','series','-d','series','-Fc'],{stdio:['ignore',dump,'pipe']});}finally{closeSync(dump);}
cpSync(path.join(cwd,'data'),path.join(backup,'data'),{recursive:true});
for(const file of ['config.json','jwt.key'])cpSync(path.join(cwd,file),path.join(backup,file));
cpSync(path.join(cwd,'dist'),path.join(backup,'release-dist'),{recursive:true});
manifest.backup_bytes=statSync(path.join(backup,'database.dump')).size;save();await db.close();
process.env.SERIES_PG_DSN=dsn;
for(let pass=1;pass<=2;pass++){
 const migrated=await openDatabase();
 try{
  const after=await invariant(migrated);
  if(JSON.stringify(after)!==JSON.stringify(manifest.before_migration))throw new Error(`Historical evidence changed during migration pass ${pass}`);
  if(JSON.stringify(await states(migrated))!==JSON.stringify(manifest.before_tasks))throw new Error('Task state changed during migration');
  const prompts=(await migrated.query('SELECT id,md5(template_text) hash FROM agent_prompts WHERE id=ANY($1::bigint[]) ORDER BY id',[beforePrompts.map(r=>r.id)])).rows;
  if(JSON.stringify(prompts)!==JSON.stringify(beforePrompts))throw new Error('Historical prompts changed');
  manifest[`migration_${pass}`]=after;
 }finally{await migrated.close();save();}
}
const key=readFileSync(path.join(cwd,'jwt.key'),'utf8').trim(),headers={authorization:`Bearer ${signJWT(key)}`};
const get=async(route:string)=>{const r=await fetch('http://127.0.0.1:8787'+route,{headers,signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error(`GET ${route}: ${r.status}`);return r.json() as Promise<any>;};
const log=openSync(path.join(backup,'server.log'),'a',0o600);
const child=spawn(process.execPath,['dist/index.js','-addr','127.0.0.1:8787','-proxy','127.0.0.1:8788'],{cwd,env:{...process.env,SERIES_PG_DSN:dsn,SERIES_VERSION:manifest.version},detached:true,stdio:['ignore',log,log]});
child.unref();closeSync(log);manifest.new_pid=child.pid;save();
let healthy=false;
for(let i=0;i<120;i++){try{healthy=(await get('/api/health')).version===manifest.version;}catch{}if(healthy)break;await new Promise(r=>setTimeout(r,500));}
if(!healthy)throw new Error(`New server did not become ready; inspect ${backup}/server.log`);
manifest.after_tasks=(await get('/api/tasks?page=1&page_size=100')).tasks.map((t:any)=>({id:t.id,status:t.status,paused:t.paused,queued:t.queued}));
for(const before of manifest.before_tasks.filter((t:any)=>t.paused||['done','failed','timeout','cancelled'].includes(t.status))){
 const after=manifest.after_tasks.find((t:any)=>t.id===before.id);
 if(!after||before.paused&&!after.paused||!before.paused&&after.status!==before.status)throw new Error(`Task state was not preserved: ${before.id}`);
}
manifest.metrics=await get('/api/runtime/metrics');manifest.restarted_at=new Date().toISOString();save();
console.log(JSON.stringify({deployed:true,backup,pid:child.pid,version:manifest.version,states:manifest.after_tasks}));
