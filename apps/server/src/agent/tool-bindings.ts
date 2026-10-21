import {RETIRED_TOOLS,TOOL_ALIASES} from './tool-registry.js';
import { effectiveToolDescription } from './tool-descriptions.js';
import {roleToolDescription} from './tool-description-policy.js';

/** DB 工具目录过滤：按 tools.agents 绑定与 enabled 开关过滤角色可用工具（绑定 DB 可管）。 */
export async function applyToolBindings<T extends { name: string }>(db: import("../db/index.js").Database, role: string, tools: T[]): Promise<T[]> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    const res = await db.query(`SELECT key, agents, enabled, description FROM tools WHERE kind='builtin'`);
    rows = res.rows as Array<Record<string, unknown>>;
  } catch {
    throw new Error('工具目录不可用');
  }
  const byKey = new Map(rows.map((r) => [String(r["key"]), r]));
  for(const tool of tools) {
    const description=byKey.get(tool.name)?.description;
    if ('description' in tool) Object.assign(tool, {description:roleToolDescription(tool.name,effectiveToolDescription(tool.name, String(tool.description ?? ''), description),role)});
  }
  return tools.filter((t) => {
    if(RETIRED_TOOLS.has(t.name))return false;
    const canonical=byKey.get(TOOL_ALIASES[t.name]??'');
    if(canonical&&(canonical.enabled===false||!Array.isArray(canonical.agents)||!canonical.agents.includes(role)))return false;
    const row = byKey.get(t.name);
    if (!row) return true;
    if (row["enabled"] === false) return false;
    const agents = Array.isArray(row["agents"]) ? (row["agents"] as string[]) : [];
    return agents.includes(role);
  });
}

/** pi 内置工具（bash/read/write/edit）的 DB 开关：返回该角色被禁用的内置名。 */
export async function disabledBuiltinTools(db: import("../db/index.js").Database, role = "worker"): Promise<Set<string>> {
  try {
    const res = await db.query(`SELECT key FROM tools WHERE kind='builtin' AND (enabled=false OR NOT agents @> $1::jsonb)`, [JSON.stringify([role])]);
    return new Set(res.rows.map((r) => String(r["key"])));
  } catch {
    throw new Error('工具目录不可用');
  }
}
