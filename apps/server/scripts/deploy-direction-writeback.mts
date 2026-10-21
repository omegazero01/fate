// One controlled replacement of the existing backend; frontend stays available.
import {createHash} from 'node:crypto';import pg from 'pg';import path from 'node:path';import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,cpSync,statSync,readdirSync,renameSync} from 'node:fs';import {spawn,execFileSync} from 'node:child_process';
import {Database,openDatabase} from '../src/db/index.js';import {postgresDSN} from '../src/config/index.js';import {signJWT} from '../src/http/auth.js';import {resolveRolePrompt,migrateSeriesPlannerPrompt} from '../src/agent/prompts.js';
import {migrateDirectionWriteback} from '../src/agent/direction-migration.js';
const cwd=process.cwd(),stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15),backup=path.join(process.env.HOME!,'.local/share/fate/backups',`review-fixes-${stamp}`),evidence=path.resolve(process.env.FATE_DEPLOY_EVIDENCE??'../../docs/reviews/evidence/review-fixes-20261019');mkdirSync(backup,{recursive:true,mode:0o700});
const staged=process.env.FATE_STAGED_DIST?path.resolve(process.env.FATE_STAGED_DIST):undefined;
if(staged){statSync(path.join(staged,'index.js'));statSync(path.join(staged,'db/sql/schema.sql'));if(staged===path.join(cwd,'dist'))throw new Error('Staging must be separate from the live dist');}
const dsn=postgresDSN().dsn,db=new Database(new pg.Pool({connectionString:dsn}));
const key=readFileSync(path.join(cwd,'jwt.key'),'utf8').trim(),headers={authorization:`Bearer ${signJWT(key)}`,'content-type':'application/json'};
const get=async(p:string)=>{const r=await fetch('http://127.0.0.1:8787'+p,{headers});if(!r.ok)throw new Error('GET '+p+' '+r.status);return r.json() as Promise<any>;};
const post=async(p:string)=>{const r=await fetch('http://127.0.0.1:8787'+p,{method:'POST',headers,body:'{}'});const body=await r.json();if(!r.ok)throw new Error('POST '+p+' '+JSON.stringify(body));return body;};
const wait=async(fn:()=>Promise<boolean>)=>{while(!await fn())await new Promise(r=>setTimeout(r,500));};
const oldPID=Number(process.env.FATE_OLD_SERVER_PID??27863),listener=execFileSync('lsof',['-tiTCP:8787','-sTCP:LISTEN'],{encoding:'utf8'}).trim();if(listener!==String(oldPID))throw new Error('Backend listener PID changed; inspect before replacement');
const previousPrompts=(await db.query('SELECT id,md5(template_text) hash FROM agent_prompts ORDER BY id')).rows;
const previousSelections=(await db.query('SELECT a.key,a.current_prompt_id,md5(p.template_text) hash FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id ORDER BY a.key')).rows;
const states=(await db.query('SELECT id,status,paused,queued,execution_mode FROM tasks WHERE deleted_at IS NULL ORDER BY id')).rows;
const active=(await db.query("SELECT n.id,t.id task_id FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id WHERE n.kind='intent' AND n.state='running' AND t.deleted_at IS NULL AND NOT t.paused")).rows;
const manifest:any={backup,version:process.env.FATE_DEPLOY_VERSION??'series-review-fixes-20261019',old_pid:oldPID,before_health:await get('/api/health'),before_tasks:states,before_prompt_selection:previousSelections,interrupted_intents:active,started_at:new Date().toISOString()};
const save=()=>{writeFileSync(path.join(backup,'deployment.json'),JSON.stringify(manifest,null,2),{mode:0o600});writeFileSync(path.join(evidence,'deployment.json'),JSON.stringify(manifest,null,2),{mode:0o600});};save();
const resumed:number[]=[];
for(const row of states.filter(r=>r.status==='running'&&!r.paused&&!r.queued)){
 const current=await db.tasks().getTask(Number(row.id));if(current?.status!=='running'||current.paused)continue;
 await post(`/api/tasks/${row.id}/pause`);resumed.push(Number(row.id));
}
await wait(async()=>!(await db.query('SELECT 1 FROM engine_worker_slots')).rowCount);
process.kill(oldPID,'SIGTERM');await wait(async()=>{try{process.kill(oldPID,0);return false;}catch{return true;}});manifest.stopped_at=new Date().toISOString();save();
const dump=openSync(path.join(backup,'database.dump'),'w',0o600);try{execFileSync('docker',['exec','series-ts-pg','pg_dump','-U','series','-d','series','-Fc'],{stdio:['ignore',dump,'pipe']});}finally{closeSync(dump);}
cpSync(path.join(cwd,'data'),path.join(backup,'data'),{recursive:true});for(const f of ['config.json','jwt.key'])cpSync(path.join(cwd,f),path.join(backup,f));cpSync(path.join(cwd,'src'),path.join(backup,'release-src'),{recursive:true});
const files=(root:string)=>readdirSync(root,{recursive:true}).map(String).filter(f=>statSync(path.join(root,f)).isFile()).sort().map(f=>[f,createHash('sha256').update(readFileSync(path.join(root,f))).digest('hex')]);
const originalFiles=files(path.join(cwd,'data')),copiedFiles=files(path.join(backup,'data'));if(JSON.stringify(originalFiles)!==JSON.stringify(copiedFiles))throw new Error('Runtime backup digest mismatch');manifest.runtime_files_preserved=originalFiles.length;writeFileSync(path.join(backup,'runtime-files.json'),JSON.stringify(originalFiles),{mode:0o600});
const invariant=async(d:Database)=>(await d.query(`SELECT
 (SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM assets) assets,(SELECT count(*) FROM exploration_nodes) nodes,
 (SELECT count(*) FROM activity) activity,(SELECT md5(string_agg(id::text||':'||md5(detail),',' ORDER BY id)) FROM activity) activity_digest,
 (SELECT md5(string_agg(id::text||':'||payload::text,',' ORDER BY id)) FROM exploration_nodes WHERE kind IN('fact','finding')) evidence_digest,
 (SELECT md5(string_agg(id::text||':'||template_text,',' ORDER BY id)) FROM agent_prompts) prompts_digest`)).rows[0];
manifest.before_migration=await invariant(db);manifest.backup_bytes=statSync(path.join(backup,'database.dump')).size;save();await db.close();
process.env.SERIES_PG_DSN=dsn;const migrated=await openDatabase();
// The old executor did not stamp resumability on task pause. Bridge only the
// specific in-flight attempts we stopped, never completed/cancelled history.
for(const row of active)await migrated.query("UPDATE exploration_nodes SET payload=payload||'{\"resume_requested\":true}'::jsonb WHERE id=$1 AND state='open' AND payload->'execution_stop'->>'reason'='task_paused' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'",[row.id]);
manifest.after_migration=await invariant(migrated);const prompt=await resolveRolePrompt(migrated,'planner');manifest.planner_prompt={source:prompt.source,version:prompt.version};
for(const key of ['tasks','assets','nodes','activity','activity_digest','evidence_digest'])if(manifest.before_migration[key]!==manifest.after_migration[key])throw new Error('Unexpected migration change: '+key);
const preservedPrompts=(await migrated.query('SELECT id,md5(template_text) hash FROM agent_prompts WHERE id=ANY($1::bigint[]) ORDER BY id',[previousPrompts.map(p=>p.id)])).rows;
if(JSON.stringify(previousPrompts)!==JSON.stringify(preservedPrompts))throw new Error('Historical prompts changed');
manifest.after_prompt_selection=(await migrated.query('SELECT a.key,a.current_prompt_id,md5(p.template_text) hash FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id ORDER BY a.key')).rows;
for(const row of previousSelections){
 if(row.key==='planner')continue;
 const after=manifest.after_prompt_selection.find((p:any)=>p.key===row.key);
 if(!after||after.hash!==row.hash)throw new Error('Unexpected custom role prompt change: '+row.key);
}
const count=(await migrated.query('SELECT count(*) FROM agent_prompts')).rows[0]!.count;await migrateSeriesPlannerPrompt(migrated);await migrateDirectionWriteback(migrated);if((await migrated.query('SELECT count(*) FROM agent_prompts')).rows[0]!.count!==count)throw new Error('Prompt migration not idempotent');
manifest.prompt_history=(await migrated.query("SELECT p.id,p.version,p.note,p.updated_by FROM agents a JOIN agent_prompts p ON p.agent_id=a.id WHERE a.key='planner' ORDER BY version DESC LIMIT 3")).rows;await migrated.close();save();
if(staged){renameSync(path.join(cwd,'dist'),path.join(backup,'previous-dist'));renameSync(staged,path.join(cwd,'dist'));}
const log=openSync(path.join(backup,'server.log'),'a',0o600),child=spawn(process.execPath,['dist/index.js','-addr','127.0.0.1:8787','-proxy','127.0.0.1:8788'],{cwd,env:{...process.env,SERIES_PG_DSN:dsn,SERIES_VERSION:manifest.version},detached:true,stdio:['ignore',log,log]});child.unref();closeSync(log);manifest.new_pid=child.pid;save();
await wait(async()=>{try{return (await get('/api/health')).version===manifest.version;}catch{return false;}});
for(const id of resumed)await post(`/api/tasks/${id}/resume`);
manifest.after_tasks=await Promise.all(states.map(async r=>{const v=await get(`/api/tasks/${r.id}`);return {id:r.id,status:v.status,paused:v.paused,queued:v.queued};}));for(const before of states.filter(r=>r.paused)){if(!manifest.after_tasks.find((r:any)=>r.id===before.id)?.paused)throw new Error('Original paused task resumed unexpectedly: '+before.id);}
manifest.restarted_at=new Date().toISOString();manifest.resumed_task_ids=resumed;save();console.log(JSON.stringify({deployed:true,backup,pid:child.pid,version:manifest.version,resumed}));
