import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {applyToolBindings} from './tool-bindings.js';
import {TOOL_POLICY_VERSION,TOOL_ALIASES,isCoreTool,toolIdentity,RETIRED_TOOLS} from './tool-registry.js';
import type {AgentRunnerOptions} from '../pi/runner.js';
import type {Database} from '../db/index.js';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';

export function compactToolSchema(tool:ToolDefinition):ToolDefinition {
 if(!['insert_assets','add_intent'].includes(tool.name))return tool;
 const schema=structuredClone(tool.parameters) as any;
 if(tool.name==='insert_assets'&&schema.properties?.assets){
  delete schema.properties.items;delete schema.anyOf;schema.required=['assets'];
 }
 if(tool.name==='add_intent'){
  const descriptions:Record<string,string>={summary:'方向与终点',parent_ids:'已读 fact/finding ID',parent_id:'单个依据 ID',asset_ids:'资产 ID',priority:'省略/0→5',
   contract:'可选约定及去重',basis:'已读 fact/finding 及版本',allowed_tools:'精确执行工具名；不限制写回',intents:'1–4 条；单条/批量互斥'};
  const visit=(value:any)=>{if(!value||typeof value!=='object')return;for(const [name,property] of Object.entries(value.properties??{}) as [string,any][]){if(descriptions[name])property.description=descriptions[name];visit(property);}if(value.items)visit(value.items);};visit(schema);
 }
 return {...tool,description:tool.name==='add_intent'?tool.description+' 父节点不可用 goal/intent；省略则连接任务根事实。':tool.description,parameters:schema};
}
export interface ToolLoading {
 version:string;initialActive:string[];deferred:string[];compatibility:string[];fallback?:string;
}
/** Pure loadout shared with preview. Filtering never introduces a tool absent from the bound set. */
export function toolLoadout(role:string,options:Pick<AgentRunnerOptions,'customTools'|'toolAllowlist'>,settings:{direct?:boolean;legacy?:boolean;legacyParameters?:string[];referenced?:string[];custom?:string[];fallback?:string}={}) {
 const allowed=[...new Set(options.toolAllowlist??[])].filter(n=>!RETIRED_TOOLS.has(n));
 const compatibility=allowed.filter(n=>TOOL_ALIASES[n]&&(settings.legacy||settings.referenced?.includes(n)||!allowed.includes(TOOL_ALIASES[n]!)));
 const names=allowed.filter(n=>!TOOL_ALIASES[n]||compatibility.includes(n));
 const customTools=(options.customTools??[]).filter(t=>names.includes(t.name)).map(t=>settings.legacy||settings.legacyParameters?.includes(t.name)?t:compactToolSchema(t));
 const deferred=settings.direct?[]:names.filter(n=>!n.includes('*')&&!n.startsWith('mcp__')&&!isCoreTool(role,n)&&!compatibility.includes(n)&&!settings.custom?.includes(n));
 const initialActive=names.filter(n=>!deferred.includes(n));
 const policy:ToolLoading={version:TOOL_POLICY_VERSION,initialActive,deferred,compatibility,...(settings.fallback?{fallback:settings.fallback}:{})};
 return {customTools:customTools.map(t=>({...t,...(deferred.includes(t.name)?{exposure:'deferred' as const}: {})})),toolAllowlist:names,toolLoading:policy};
}
type ToolLoadingOptions=Pick<AgentRunnerOptions,'customTools'|'toolAllowlist'|'legacyTools'|'systemPrompt'|'resumeSessionPath'|'skillsDir'|'allowedSkills'>;
export async function prepareToolLoading(db:Database,role:string,options:ToolLoadingOptions,direct:boolean,fallback?:string){
 let legacy=false;
 if(options.resumeSessionPath){try{const lines=(await readFile(options.resumeSessionPath,'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));legacy=lines.some(e=>e.type==='message')&&!lines.some(e=>e.type==='custom'&&e.customType===TOOL_POLICY_VERSION);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 // Scan only explicitly bound Skills for compatibility; no Skill content is injected into the model.
 const sources=[options.systemPrompt??''];
 if(options.skillsDir)for(const skill of options.allowedSkills??[]){
  if(skill.includes('/')||skill.includes('\\')||skill==='..')continue;
  try{sources.push(await readFile(path.join(options.skillsDir,skill,'SKILL.md'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
 const referenced=Object.keys(TOOL_ALIASES).filter(name=>sources.some(text=>new RegExp(`\\b${name}\\b`).test(text)));
 const legacyParameters=sources.some(text=>/\binsert_assets\b/.test(text)&&/\bitems\b/.test(text))?['insert_assets']:[];
 // Absent catalog rows are not permission to restore historical capabilities.
 const bindings=(await db.query("SELECT key FROM tools WHERE kind='builtin' AND enabled AND agents ? $1",[role])).rows.map(r=>String(r.key));
 const extra=(await applyToolBindings(db,role,options.legacyTools??[])).filter(t=>
  bindings.includes(t.name)&&(legacy||referenced.includes(t.name))&&!(options.toolAllowlist??[]).includes(t.name));
 options={...options,customTools:[...options.customTools??[],...extra],toolAllowlist:[...options.toolAllowlist??[],...extra.map(t=>t.name)]};
 const custom=(await db.query("SELECT key FROM tools WHERE kind<>'builtin' AND enabled AND agents ? $1",[role])).rows.map(r=>String(r.key));
 const allowed=await applyToolBindings(db,role,(options.toolAllowlist??[]).map(name=>({name})));
 return toolLoadout(role,{...options,toolAllowlist:allowed.map(t=>t.name)},{direct,legacy,legacyParameters,referenced,custom,fallback:legacy?'旧会话保留兼容工具名称和参数':fallback});
}
