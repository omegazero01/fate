import {legacyReadCandidates} from '../tools/legacy-reads.js';
import {effectiveToolDescription} from './tool-descriptions.js';
import {createReadToolDefinition,createBashToolDefinition,createWriteToolDefinition,createEditToolDefinition,createToolSearchExtension,type ToolDefinition,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {workerTools,plannerTools,mainTools,goalsTools} from '../tools/index.js';
import {runContext} from '../tools/context.js';
import {contextSearchTool,contextGetTool} from '../tools/context-read.js';
import {readAttachmentTool,trafficBodyTool} from '../tools/evidence.js';
import {toolOutputTool} from '../tools/output.js';
import {listAssetsTool,assetGetTool} from '../tools/assets.js';
import {mergedAssetSearchTool} from '../tools/asset-search-compat.js';
import {recordFactTool,nodeDetailTool,searchWorkerTracesTool,getWorkerTraceTool} from '../tools/graph.js';
import {graphIndexTool,expandDigestTool} from '../tools/graph_read.js';
import {listFindingsTool,reportFindingTool} from '../tools/findings.js';
import {graphOverviewTool} from '../tools/overview.js';
import {httpRequestTool} from '../tools/evidence.js';
import {conversationDomainTools} from '../tools/conversations.js';
import {terminalToolDefinitions} from '../pi/terminal.js';
import {customWorkerTools,platformBashDescription} from '../tools/custom.js';
import {applyToolBindings,disabledBuiltinTools} from './tool-bindings.js';
import {toolIdentity,ACTIVE_ROLES} from './tool-registry.js';
import {prepareToolLoading,compactToolSchema} from './tool-loading.js';
import {platformPolicy} from '../pi/platform-policy.js';
import {hasDeferredMcp,TOOL_SEARCH_HINT} from '../pi/platform-mcp.js';
import {resolveRolePrompt} from './prompts.js';
import {roleResources} from './resources.js';
import {skillDir} from '../config/index.js';
import type {Database} from '../db/index.js';
const previewCwd='/tmp/fate-tool-preview';
const native=()=>[createReadToolDefinition(previewCwd),createBashToolDefinition(previewCwd),createWriteToolDefinition(previewCwd),createEditToolDefinition(previewCwd)] as ToolDefinition[];
export function searchDefinition(){let tool!:ToolDefinition;createToolSearchExtension()({registerTool:(t:ToolDefinition)=>{tool=t;}} as ExtensionAPI);return {...tool,description:tool.description+TOOL_SEARCH_HINT};}
/** Constructors only: no model, MCP connection, terminal process, or domain action. */
export function roleDefinitions(db:Database,role:string,taskBound=true):ToolDefinition[]{
 const ctx=runContext(db,taskBound?1:0,taskBound?1:0,role as never);
 const factory={worker:workerTools,planner:plannerTools,mainagent:mainTools,goals:goalsTools}[role];
 if(factory)return factory(ctx);
 const tools:ToolDefinition[]=[contextGetTool(ctx),readAttachmentTool(ctx),toolOutputTool(ctx),...conversationDomainTools(ctx,{} as never)];
 if(taskBound)tools.push(contextSearchTool(ctx),mergedAssetSearchTool(ctx),assetGetTool(ctx),listAssetsTool(ctx),listFindingsTool(ctx),nodeDetailTool(ctx),graphOverviewTool(ctx),trafficBodyTool(ctx));
 if(role==='pentest'&&taskBound)tools.push({...recordFactTool(ctx),name:'record_conversation_fact'},{...reportFindingTool(ctx),name:'report_conversation_finding'},httpRequestTool(ctx));
 return tools;
}
export function builtinDefinitions(db:Database){
 const ctx=runContext(db,1,1,'worker');
 const all=[...ACTIVE_ROLES.flatMap(role=>roleDefinitions(db,role)),...native(),...terminalToolDefinitions(),searchDefinition(),
  searchWorkerTracesTool(ctx),getWorkerTraceTool(ctx),graphIndexTool(ctx),graphIndexTool(ctx,'list_facts'),expandDigestTool(ctx)];
 return new Map(all.map(t=>[t.name,t]));
}
export async function previewRoleTools(db:Database,role:string,taskBound=true){
 const agent=await db.platform().getAgentByKey(role);if(!agent)throw Object.assign(new Error('Agent 不存在'),{statusCode:404});
 const ctx=runContext(db,taskBound?1:0,taskBound?1:0,role as never);
 const nativeNames=['worker','planner','mainagent'].includes(role)||role==='pentest'&&taskBound?['read','bash','write','edit']:['auto','reporter','pentest','goals'].includes(role)?['read']:[];
 const disabled=await disabledBuiltinTools(db,role);
 const domain=await applyToolBindings(db,role,roleDefinitions(db,role,taskBound));
 const custom=role==='pentest'&&!taskBound?[]:await customWorkerTools(ctx,previewCwd);
 const candidate=[...domain,...native().filter(t=>nativeNames.includes(t.name)&&!disabled.has(t.name)),...(agent.interactiveShell&&['worker','planner','mainagent'].includes(role)?terminalToolDefinitions():[]),...custom];
 if(['worker','planner','mainagent'].includes(role)){const bash=candidate.find(t=>t.name==='bash');if(bash)bash.description=await platformBashDescription(ctx,bash.description,agent.interactiveShell);}
 const permitted=new Set((await applyToolBindings(db,role,candidate.map(t=>({name:t.name})))).map(t=>t.name));
 const bound=candidate.filter(t=>permitted.has(t.name)),policy=await platformPolicy(db,role),prompt=await resolveRolePrompt(db,role),resources=await roleResources(db,role,skillDir());
 const loadout=await prepareToolLoading(db,role,{customTools:bound,legacyTools:taskBound?legacyReadCandidates(ctx):[],toolAllowlist:bound.map(t=>t.name),systemPrompt:prompt.template,...resources},policy.builtinLoading==='direct',policy.fallback);
 const definitions=new Map(loadout.customTools.map(t=>[t.name,t]));
 const initial=loadout.toolLoading.initialActive.map(n=>definitions.get(n)!).filter(Boolean);
 if(loadout.toolLoading.deferred.length||hasDeferredMcp(resources))initial.push(searchDefinition());
 const measure=(tools:ToolDefinition[])=>Buffer.byteLength(JSON.stringify(tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))));
 return {role,scope:taskBound?'task_bound':'standalone',policy_version:loadout.toolLoading.version,platform_policy:policy,
  resident:initial.map(t=>t.name),deferred:loadout.toolLoading.deferred,compatibility:loadout.toolLoading.compatibility,fallback:loadout.toolLoading.fallback,
  schema_bytes:{before:measure(bound),resident:measure(initial),registered:measure([...definitions.values()])},
  mcp:{status:'not_connected',servers:resources.mcpEntries?.map(e=>e.name)??[],schema_counted:false},
  schemas:Object.fromEntries([...definitions.values()].map(t=>[t.name,t.parameters]))};
}
export async function catalogTools(db:Database){
 const definitions=builtinDefinitions(db),rows=(await db.query('SELECT * FROM tools ORDER BY key')).rows;
 const roles:Awaited<ReturnType<typeof previewRoleTools>>[]=[];for(const role of ACTIVE_ROLES)roles.push(await previewRoleTools(db,role));
 return {roles,tools:rows.map(row=>{
  const identity=toolIdentity(String(row.key),String(row.kind)),definition=definitions.get(String(row.key));
  const implementation=definition?compactToolSchema(definition):undefined;
  const loaded=roles.filter(r=>r.resident.includes(String(row.key))||r.deferred.includes(String(row.key)));
  const description=row.kind==='builtin'&&definition?effectiveToolDescription(String(row.key),definition.description,row.description):{description:row.description,source:'configuration'};
  return {...row,...identity,description:description.description,description_source:description.source,schema:row.kind==='builtin'?implementation?.parameters??row.schema??{}:row.schema??{},schema_source:row.kind==='builtin'?definition?'implementation':'unavailable':'configuration',
   schema_read_only:row.kind==='builtin',agents:row.agents??[],loading:Object.fromEntries(loaded.map(r=>[r.role,r.deferred.includes(String(row.key))?'deferred':'resident']))};
 })};
}
