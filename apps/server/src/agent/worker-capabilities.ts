import {TERMINAL_TOOLS} from '../pi/terminal.js';
import {applyToolBindings, disabledBuiltinTools} from './tool-bindings.js';
import {boundCustomTools} from '../tools/custom.js';
import type {ToolRunContext} from '../tools/context.js';
import {roleResources} from './resources.js';
import {hasDeferredMcp} from '../pi/platform-mcp.js';
import {prepareToolLoading} from './tool-loading.js';
import {platformPolicy} from '../pi/platform-policy.js';
import {resolveRolePrompt} from './prompts.js';
import {skillDir} from '../config/index.js';

/** Uses the same factories/bindings as execution, without connecting MCP or running a model. */
export async function workerCapabilities(ctx: ToolRunContext) {
  // Lazy import avoids a module initialization cycle through graph_overview/add_intent.
  const {workerTools} = await import('../tools/index.js');
  const {legacyReadCandidates} = await import('../tools/legacy-reads.js');
  const [tools, disabled, custom, resources, agent, policy, prompt] = await Promise.all([
    applyToolBindings(ctx.db, 'worker', workerTools({...ctx, role:'worker'})),
    disabledBuiltinTools(ctx.db), boundCustomTools(ctx.db, 'worker'),
    roleResources(ctx.db, 'worker',skillDir()), ctx.db.platform().getAgentByKey('worker'),
    platformPolicy(ctx.db,'worker'),resolveRolePrompt(ctx.db,'worker'),
  ]);
  const candidates = [...new Set([
    ...['bash','read','write','edit'].filter(name => !disabled.has(name)),
    ...(agent?.interactiveShell?TERMINAL_TOOLS.filter(name=>!disabled.has(name)):[]),
    ...tools.map(t => t.name), ...custom.map(t => t.key),
    ...(resources.mcpEntries?.length ? resources.mcpResourceTools ?? [] : []),
  ])].sort();
  const loadout=await prepareToolLoading(ctx.db,'worker',{
    customTools:tools,toolAllowlist:candidates,legacyTools:legacyReadCandidates({...ctx,role:'worker'}),
    systemPrompt:prompt.template,...resources,
  },policy.builtinLoading==='direct',policy.fallback);
  const names=[...loadout.toolAllowlist,...(loadout.toolLoading.deferred.length||hasDeferredMcp(resources)?['tool_search']:[])];
  const cached=(await ctx.db.query(`SELECT s.name,c.tool_name FROM mcp_servers s JOIN mcp_tools_cache c ON c.server_id=s.id ORDER BY s.id,c.tool_name`)).rows;
  const mcp = (resources.mcpEntries ?? []).map(e => {
    const config=e.config as {exposure?:string;toolExposure?:Record<string,string>};
    const discovered=cached.filter(r=>r.name===e.name&&(config.toolExposure?.[String(r.tool_name)]??config.exposure)!=='hidden').map(r=>String(r.tool_name));
    // Short, collision-free names use PI's documented namespace. Long or
    // ambiguous names remain discoverable by PI, which owns hash allocation.
    const raw=discovered.map(tool=>`mcp__${e.name}__${tool}`.replace(/[^A-Za-z0-9_]/g,'_'));
    const exact=raw.filter(name=>name.length<=64&&raw.filter(n=>n===name).length===1);
    return {server:e.name,namespace:`mcp__${e.name.replace(/[^A-Za-z0-9_]/g,'_')}__`,
      tools:exact,remote_tools:discovered,complete:discovered.length>0&&exact.length===discovered.length,
      validation:discovered.length?'cached_names_live_guard':'live_discovery_required'};
  });
  return {enabled:agent?.enabled !== false, tools:[...new Set([...names,...mcp.flatMap(server=>server.tools)])].sort(), mcp,
    usage:'allowed_tools 使用此处精确工具名；HTTP GET 使用 http_request。MCP 使用已发现的精确名称，不要猜测别名；未发现时省略可选 allowed_tools，由 Worker 原生发现并按实时绑定授权执行。'};
}

export function validateWorkerToolNames(names: string[] | undefined, catalog: Awaited<ReturnType<typeof workerCapabilities>>) {
  // A disabled role can still have queued/manual work. Catalog.enabled reports
  // availability; admission/execution enforce it without rejecting valid drafts.
  if (!names) return;
  // MCP schemas are dynamic. Do not claim the offline catalog verifies them or
  // start an execution service in a Planner session. pi discovery and the live
  // per-tool guard remain authoritative (including explicit tool revocations).
  const invalid = names.filter(name => !catalog.tools.includes(name) &&
    !catalog.mcp.some(server => !server.complete && name.startsWith(server.namespace) && name.length > server.namespace.length && !name.includes('*')));
  if (invalid.length) throw new Error(`contract.allowed_tools 包含不存在、已禁用或未绑定 Worker 的工具：${invalid.join(', ')}。请使用 graph_overview.worker_capabilities 中的精确名称；HTTP GET 的工具名是 http_request。当前可用：${catalog.tools.join(', ')}`);
}
