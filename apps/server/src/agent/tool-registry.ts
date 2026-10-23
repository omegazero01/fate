/** Catalog identity and exposure policy. Execution implementations remain native pi/domain tools. */
export const TOOL_POLICY_VERSION = 'lean-tools-v1';
export const ACTIVE_ROLES = ['goals','planner','mainagent','worker','auto','pentest','reporter'] as const;
export const NATIVE_TOOLS = ['read','bash','write','edit'];
export const TOOL_ALIASES: Record<string,string> = {
  node_detail:'context_get',search_worker_traces:'context_search',get_worker_trace:'context_get',
  expand_index:'context_search',expand_digest:'context_get',list_facts:'context_search',
  read_tool_output:'context_get',read_attachment:'context_get',traffic_body:'context_get',
  list_assets:'asset_search',list_untested_assets:'asset_search',
};
export const RETIRED_TOOLS = new Set(['get_finding_retest_context','record_finding_retest_result','checkpoint_intent','complete_intent']);
export const DOMAIN_TOOL_NAMES = [
  'context_search','context_get','graph_overview','asset_search','asset_get','insert_assets',
  'record_fact','report_finding','list_findings','http_request','add_intent','dispatch_intents',
  'prove_goal','kill_work','steer_work','add_task_scope','todo_write','set_goals','set_constraints','register_user_target',
  'list_tasks','get_task','list_llm_profiles','spawn_task','pause_task','resume_task','add_task_hint',
  'get_finding','update_finding_report','record_conversation_fact','report_conversation_finding',
  'shell_open','shell_send','shell_read','shell_close','shell_list',
];
const supported = new Set([...NATIVE_TOOLS,...DOMAIN_TOOL_NAMES,...Object.keys(TOOL_ALIASES),'tool_search',
  'list_mcp_resources','list_mcp_resource_templates','read_mcp_resource']);
const common = ['context_search','context_get'];
const core:Record<string,string[]>={
  worker:[...common,'http_request','insert_assets','record_fact','report_finding'],
  planner:[...common,'graph_overview','asset_search','add_intent','prove_goal','todo_write','kill_work','steer_work'],
  mainagent:[...common,'http_request','insert_assets','record_fact','report_finding','add_intent','dispatch_intents','steer_work'],
  goals:[...common,'set_goals','set_constraints','register_user_target'],
  auto:[...common,'list_tasks','get_task','spawn_task','pause_task','resume_task'],
  pentest:[...common,'http_request','record_conversation_fact','report_conversation_finding'],
  reporter:[...common,'get_finding','update_finding_report'],
};
export function isCoreTool(role:string,name:string) {
  return NATIVE_TOOLS.includes(name)||name==='tool_search'||core[role]?.includes(name)===true;
}
export function toolIdentity(name:string,kind='builtin') {
  const status=kind!=='builtin'?'active':RETIRED_TOOLS.has(name)?'retired':TOOL_ALIASES[name]?'compatibility':supported.has(name)?'active':'unsupported';
  return {implementation_status:status,canonical_name:TOOL_ALIASES[name]??name,
    source:kind!=='builtin'?'custom':NATIVE_TOOLS.includes(name)||name==='tool_search'?'pi':name.includes('mcp_resource')?'mcp':'platform',
    aliases:Object.entries(TOOL_ALIASES).filter(([,target])=>target===name).map(([alias])=>alias)};
}

/** Sub-capabilities keep their old switches after entrypoints are merged. */
export async function assertToolBinding(db:import('../db/index.js').Database,role:string,key:string) {
  if(RETIRED_TOOLS.has(key))throw new Error(`工具 ${key} 已移除`);
  if(TOOL_ALIASES[key])await assertToolBinding(db,role,TOOL_ALIASES[key]!);
  const row=(await db.query('SELECT enabled,agents FROM tools WHERE key=$1',[key])).rows[0];
  if(row&&(row.enabled===false||!Array.isArray(row.agents)||!row.agents.includes(role)))
    throw new Error(`当前角色无 ${key} 读取或执行权限`);
}
