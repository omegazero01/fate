/** Opt-in synthetic native-pi benchmark. Never executes domain/network/file tools. */
import pg from 'pg';import path from 'node:path';import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';
import {Database,openDatabase} from '../src/db/index.js';import {buildModelSource} from '../src/pi/providerFromProfile.js';
import {AgentRunner} from '../src/pi/runner.js';import {roleDefinitions} from '../src/agent/tool-catalog.js';
import {toolLoadout} from '../src/agent/tool-loading.js';import {applyToolBindings,disabledBuiltinTools} from '../src/agent/tool-bindings.js';
import {ROLE_PROMPTS,renderPrompt} from '../src/agent/prompts.js';import {createReadToolDefinition,createBashToolDefinition,createWriteToolDefinition,createEditToolDefinition,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {runContext} from '../src/tools/context.js';import {platformBashDescription} from '../src/tools/custom.js';
import {terminalToolDefinitions} from '../src/pi/terminal.js';
const liveDSN=process.env.FATE_COST_PROFILE_DSN,profileID=Number(process.env.FATE_COST_PROFILE_ID),output=process.env.FATE_COST_OUTPUT;
if(!liveDSN||!profileID||!output)throw new Error('Set explicit profile DSN, profile ID, and output path');
if(existsSync(output))throw new Error('Use a fresh evidence file');
const live=new Database(new pg.Pool({connectionString:liveDSN}));const profile=await live.platform().profileByID(profileID);await live.close();
if(!profile?.apiKey||new URL(profile.baseURL).hostname!=='api.deepseek.com')throw new Error('Configured DeepSeek unavailable');
const root=mkdtempSync(path.join(tmpdir(),'fate-slim-cost-')),name=`fate_slim_cost_${process.pid}`;process.env.SERIES_PG_DSN=`postgres://series:series@127.0.0.1:5433/${name}`;const db=await openDatabase();
const rows:any[]=[],ledger:any[]=[],started=new Date().toISOString();let current:any;
const save=()=>{mkdirSync(path.dirname(output!),{recursive:true});const text=JSON.stringify({started_at:started,updated_at:new Date().toISOString(),model:profile.model,target_requests:0,method:'Same current domain schemas and fixed role input; direct compatibility loadout versus lean native discovery. Three fresh sessions per role/condition; alternating order; all physical requests including search recorded. Tool handlers return synthetic local evidence only.',rows,requests:ledger},null,2);if(text.includes(profile.apiKey))throw new Error('Credential leak');writeFileSync(output!,text+'\n',{mode:0o600});};
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com')throw new Error('Synthetic fixture forbids all target requests');
 const body=typeof init?.body==='string'?JSON.parse(init.body):{};const record:any={at:new Date().toISOString(),role:current.role,variant:current.variant,repeat:current.repeat,bytes:Buffer.byteLength(JSON.stringify(body)),schema_bytes:Buffer.byteLength(JSON.stringify(body.tools??[])),estimated_tokens:Math.ceil(Buffer.byteLength(JSON.stringify(body))/4)};ledger.push(record);current.requests.push(record);save();
 const response=await original(input,init);record.status=response.status;
 const text=await response.clone().text();for(const line of text.startsWith('{')?[text]:text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6))){try{const c=JSON.parse(line);if(c.usage)record.usage=c.usage;}catch{}}
 save();return response;
};
try{
 cases: for(const role of ['worker','planner','mainagent'] as const)for(let repeat=1;repeat<=3;repeat++)for(const variant of repeat%2?['before','after']:['after','before']){
  current={role,variant,repeat,calls:[],requests:[],saved_facts:0,unexpected:[],status:'running'};rows.push(current);
  const cwd=path.join(root,`${role}-${repeat}-${variant}`);mkdirSync(cwd,{recursive:true});const disabled=await disabledBuiltinTools(db,role);
  const domain=await applyToolBindings(db,role,roleDefinitions(db,role));
  const candidates=[...domain,...[createReadToolDefinition(cwd),createBashToolDefinition(cwd),createWriteToolDefinition(cwd),createEditToolDefinition(cwd)].filter(t=>!disabled.has(t.name)),...terminalToolDefinitions()] as ToolDefinition[];
  const bash=candidates.find(t=>t.name==='bash');if(bash)bash.description=await platformBashDescription(runContext(db,1,1,role),bash.description,true);
  const permitted=new Set((await applyToolBindings(db,role,candidates.map(t=>({name:t.name})))).map(t=>t.name));
  const raw=candidates.filter(t=>permitted.has(t.name));
  const tools=raw.map(t=>({...t,async execute(_id:string,args:any){current.calls.push({name:t.name});let result:any={};
   if(t.name==='asset_get')result={assets:[{id:7,type:'service',identity:{url:'http://synthetic.invalid/'},fingerprint:{service_name:'LOCAL synthetic',page_title:'Synthetic catalog'},read_only:true}],next_offset:null};
   else if(['context_search','graph_overview','list_assets','asset_search'].includes(t.name))result={items:[{ref:'node:19',kind:'intent',state:'running',summary:'核对合成资产 #7 的版本信息'}],running_intents:[{id:19,summary:'核对合成资产 #7 的版本信息'}],next_cursor:null};
   else if(t.name==='record_fact'){current.saved_facts++;result={node_id:42,saved:true,published:true};}
   else if(t.name==='todo_write')result={saved:true};
   else{current.unexpected.push(t.name);return {content:[{type:'text' as const,text:'LOCAL fixture rejects this operation; no execution occurred.'}],isError:true,details:undefined};}
   return {content:[{type:'text' as const,text:JSON.stringify(result)}],details:undefined};}}));
  const source=await buildModelSource({...profile,maxTokens:1600,proxy:'',streaming:true});
  const loadout=variant==='after'?toolLoadout(role,{customTools:tools,toolAllowlist:tools.map(t=>t.name)}):{customTools:tools,toolAllowlist:tools.map(t=>t.name)};
  const runner=await AgentRunner.create({...source,...loadout,cwd,agentDir:path.join(cwd,'pi'),inMemory:true,maxTurns:8,signal:AbortSignal.timeout(120000),systemPrompt:renderPrompt(ROLE_PROMPTS[role],{Goal:'核对现有本地合成资产，禁止任何外部探测与文件执行。'})+'\n这是本地合成验收，所有工具返回固定合成数据。需要未加载的工具时使用 tool_search 的英文名称。'});
  try{await runner.prompt('仅通过 asset_get 读取合成资产 #7 的 identity、fingerprint。'+(role==='worker'?'当前唯一意图：把读取到的合成服务名称写成一条事实，注明 LOCAL synthetic，不重复写入，然后总结停止。':role==='planner'?'已知意图 #19 正在核对同一资产的版本；核对后说明应等待，不再派重复意图，不证明目标已完成。':'告诉我合成服务名称，不创建、派发或控制意图。')+'禁止执行 HTTP、bash、文件和其他操作。');current.status=current.unexpected.length||!current.calls.some((c:any)=>c.name==='asset_get')||role==='worker'&&current.saved_facts!==1?'behavior_failed':'completed';}catch(e){current.status='failed';current.error=String(e).replaceAll(profile.apiKey,'[redacted]');}finally{await runner.dispose();save();}
  if(current.requests.some((r:any)=>[401,402,403].includes(r.status)))break cases;
 }
}finally{globalThis.fetch=original;await db.close();const c=new pg.Client({connectionString:'postgres://series:series@127.0.0.1:5433/postgres'});await c.connect();await c.query(`DROP DATABASE IF EXISTS ${name}`);await c.end();save();}
