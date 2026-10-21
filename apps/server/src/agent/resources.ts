import {platformPolicy} from '../pi/platform-policy.js';
import {MCP_RESOURCE_TOOLS} from '../pi/platform-mcp.js';
import type { Database } from "../db/index.js";
import type { AgentRunnerOptions } from "../pi/runner.js";

/** Reload role visibility for every session. The server configuration is the resource authority. */
export async function roleResources(db: Database, role: string, skillsDir?: string): Promise<Pick<AgentRunnerOptions, "skillsDir" | "allowedSkills" | "mcpEntries" | "mcpResourceTools">> {
  const skills = await db.query<{ skill_name: string }>(
    `SELECT v.skill_name FROM agent_skill_visibility v JOIN agents a ON a.id=v.agent_id WHERE a.key=$1 AND v.enabled ORDER BY v.skill_name`, [role]);
  // Only explicitly bound resources are registered; execution guards remain live.
  if (!["worker", "planner", "mainagent", "pentest", "auto"].includes(role)) return { skillsDir, allowedSkills: skills.rows.map((r) => r.skill_name) };
  const visibility = await db.query<{ resource_id: string; mcp_tool_name: string; enabled: boolean }>(
    `SELECT v.resource_id,v.mcp_tool_name,v.enabled FROM agent_visibility v JOIN agents a ON a.id=v.agent_id
     WHERE a.key=$1 AND v.resource_kind='mcp' ORDER BY v.resource_id,v.mcp_tool_name`, [role]);
  const servers = await db.platform().listMCP();
  const policy=await platformPolicy(db,role);
  const mcpEntries = servers.filter((server) => server.enabled).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:a.id-b.id).flatMap((server) => {
    const rows = visibility.rows.filter((v) => Number(v.resource_id) === server.id);
    const all = rows.find((v) => !v.mcp_tool_name)?.enabled === true;
    if (!all && !rows.some((v) => v.enabled && v.mcp_tool_name)) return [];
    const config: Record<string, unknown> = {
      transport: server.transport, insecure: server.insecure,
      ...(server.transport === "stdio" ? { command: server.command, args: server.args, env: server.env }
        : { url: server.url, headers: server.env }),
      exposure: all ? policy.mcpLoading : "hidden",
      toolExposure: Object.fromEntries(rows.filter((v) => v.mcp_tool_name).map((v) => [v.mcp_tool_name, v.enabled ? policy.mcpLoading : "hidden"])),
    };
    return [{ name: server.name, config }];
  });
  const bindings=(await db.query('SELECT key,enabled,agents FROM tools WHERE key=ANY($1::text[])',[MCP_RESOURCE_TOOLS])).rows;
  const mcpResourceTools=MCP_RESOURCE_TOOLS.filter(name=>{
    const binding=bindings.find(row=>row.key===name);
    return !binding||(binding.enabled&&Array.isArray(binding.agents)&&binding.agents.includes(role));
  });
  return { skillsDir, allowedSkills: skills.rows.map((r) => r.skill_name), mcpEntries, mcpResourceTools };
}
