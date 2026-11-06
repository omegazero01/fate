/** Read-only release audit. Never opens/migrates a database or starts an engine.
 * Hashes original rows in PostgreSQL and streams only hashes to Node. A stopped
 * executor is required for before/after migration equality, not for previewing.
 * Derived indexes/receipts are deliberately outside this original-data audit.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {postgresDSN} from '../src/config/index.js';

const originals=[
 'companies','company_scope','assets','explorations','exploration_nodes',
 'exploration_edges','exploration_anchors','task_constraints','activity','main_sessions',
 'tasks','task_archives','task_templates','task_categories','task_relations',
 'task_asset_links','task_llm_profiles','task_scope','conversations','conversation_activities',
 'findings','finding_retests','traffic_evidence_snapshots','finding_traffic_bindings',
 'evidence_blobs','traffic_exchanges','chat_artifacts','tool_output_artifacts',
 'worker_observations','worker_observation_revisions','worker_checkpoints','worker_settlements',
 'worker_interventions','worker_feedback','worker_feedback_delivery','worker_feedback_run',
 'planner_decisions','finding_report_versions','finding_step_images','agent_prompts',
] as const;
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
type TableState={columns:string[];rows:number;sha256:string;max_id?:string};
export type ReleaseState={version:1;at:string;tables:Record<string,TableState>;tasks:Record<string,unknown>[]};

/** The baseline column list survives additive schema migrations. Old prompt
 * versions must match byte-for-byte; a migration may append a new version. */
export async function captureReleaseState(client:pg.Client,baseline?:ReleaseState):Promise<ReleaseState>{
 const result:ReleaseState={version:1,at:new Date().toISOString(),tables:{},tasks:[]};
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const names=baseline?Object.keys(baseline.tables):originals;
  for(const table of names){
   assert(originals.includes(table as typeof originals[number]),`Unexpected audit table: ${table}`);
   const exists=(await client.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present;
   if(!exists){assert(!baseline,`Original table missing: ${table}`);continue;}
   const columns=baseline?.tables[table]?.columns??(await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,[table])).rows.map(r=>String(r.column_name));
   assert(columns.length>0);
   let maxID=baseline?.tables[table]?.max_id;
   if(!baseline&&table==='agent_prompts')maxID=String((await client.query(`SELECT COALESCE(max(id),0)::text n FROM public.${quote(table)}`)).rows[0].n);
   const args=maxID===undefined?[]:[maxID];
   const selected=`SELECT ${columns.map(quote).join(',')} FROM public.${quote(table)}${maxID===undefined?'':' WHERE id<=$1::bigint'}`;
   // Sort row hashes, preserving duplicate multiplicity, without retaining
   // evidence bodies or a full per-row inventory in the application process.
   await client.query(`DECLARE release_originals NO SCROLL CURSOR FOR
    SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') hash
    FROM (${selected}) r ORDER BY hash`,args);
   const hash=createHash('sha256');let rows=0;
   for(;;){const page=(await client.query('FETCH FORWARD 256 FROM release_originals')).rows;if(!page.length)break;
    for(const row of page){hash.update(String(row.hash)+'\n');rows++;}}
   await client.query('CLOSE release_originals');
   result.tables[table]={columns,rows,sha256:hash.digest('hex'),...(maxID===undefined?{}:{max_id:maxID})};
  }
  // Include soft-deleted tasks too. REST pagination must not hide a task from
  // the release state audit. No names, descriptions, secrets or evidence.
  result.tasks=(await client.query(`SELECT id::text,status,paused,queued,execution_mode,
   (deleted_at IS NOT NULL) deleted FROM tasks ORDER BY id`)).rows;
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}
}

export function compareReleaseState(before:ReleaseState,after:ReleaseState){
 assert.equal(before.version,1);assert.equal(after.version,1);
 const mismatches:string[]=[];
 for(const [name,expected] of Object.entries(before.tables)){
  const actual=after.tables[name];
  if(!actual)mismatches.push(`${name}: missing`);
  else if(JSON.stringify(expected)!==JSON.stringify(actual))mismatches.push(`${name}: original rows or schema selection changed`);
 }
 if(JSON.stringify(before.tasks)!==JSON.stringify(after.tasks))mismatches.push('tasks: execution states changed');
 return {passed:mismatches.length===0,mismatches,tables_checked:Object.keys(before.tables).length,tasks_checked:before.tasks.length};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [output,baselineFile]=process.argv.slice(2);assert(output,'Usage: long-chain-release-state.mts OUTPUT.json [BASELINE.json]');
 const baseline=baselineFile?JSON.parse(await readFile(baselineFile,'utf8')) as ReleaseState:undefined;
 const client=new pg.Client({connectionString:postgresDSN().dsn,application_name:'fate-release-readonly-audit'});
 await client.connect();
 try{const state=await captureReleaseState(client,baseline);await writeFile(output,JSON.stringify(state,null,2)+'\n',{mode:0o600});
  const check=baseline?compareReleaseState(baseline,state):undefined;
  console.log(JSON.stringify({output,tables:Object.keys(state.tables).length,tasks:state.tasks.length,check}));
  if(check&&!check.passed)process.exitCode=1;
 }finally{await client.end();}
}
