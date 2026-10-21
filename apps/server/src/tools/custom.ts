import {evidenceRequest} from "../evidence/http.js";
import { defineTool, createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRunContext } from "./context.js";
import type { ToolGuard } from "../pi/runner.js";
import { clampOutput } from "./define.js";

export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function renderToolTemplate(template: string, args: Record<string, unknown>, quote = (s: string) => s): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    if (!(key in args)) throw new Error(`缺少模板参数 ${key}`);
    const v = args[key];
    return quote(typeof v === "string" ? v : JSON.stringify(v));
  });
}

/** Share eligibility with planning; loading this catalog does not execute tools. */
export async function boundCustomTools(db: import('../db/index.js').Database, role: string) {
  if (!["worker", "planner", "mainagent", "pentest"].includes(role)) return [];
  const catalog = await db.platform().listTools();
  const reserved = new Set(catalog.filter(t => t.system || t.kind === 'builtin').map(t => t.key));
  return catalog.filter(t => t.enabled && t.agents.includes(role) && !t.system && t.kind !== 'builtin' && t.kind !== 'shell' && !reserved.has(t.key));
}

/** Custom tools enter the same pi tool pipeline and execution lifecycle as native tools. */
export async function customWorkerTools(ctx: ToolRunContext, cwd: string, bash?: ToolDefinition, guard?: ToolGuard): Promise<ToolDefinition[]> {
  const catalog = await boundCustomTools(ctx.db, ctx.role);
  const shell = bash ?? createBashToolDefinition(cwd) as unknown as ToolDefinition;
  return catalog
    .map((tool) => defineTool({
      name: tool.key, label: tool.key, description: tool.description,
      parameters: (Object.keys(tool.schema).length ? tool.schema : { type: "object", properties: { args: { type: "string" } } }) as never,
      async execute(callID: string, args: Record<string, unknown>, signal, update, extensionContext) {
        const spec = tool.exec;
        const timeout = Math.min(Math.max(Number(spec["timeout_ms"]) || 30_000, 100), 300_000);
        const check = async (toolName: string, input: Record<string, unknown>) => {
          signal?.throwIfAborted();
          const decision = await guard?.({ toolName, toolCallId: callID, args: input, signal });
          if (decision?.block) throw new Error(decision.reason ?? "当前执行已停止");
        };
        if (tool.kind === "http") {
          let url = renderToolTemplate(String(spec["url"] ?? ""), args);
          const headers = Object.fromEntries(Object.entries((spec["headers"] ?? {}) as Record<string, string>).map(([k,v]) => [k, renderToolTemplate(String(v), args)]));
          let method = String(spec["method"] ?? "GET").toUpperCase();
          let body = spec["body"] === undefined || spec["body"] === "" ? undefined : renderToolTemplate(typeof spec["body"] === "string" ? spec["body"] : JSON.stringify(spec["body"]), args);
          const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
          const result=await evidenceRequest(ctx,{url,method,headers,body},combined,input=>check(tool.key,{...args,...input}));
          return {content:[{type:'text' as const,text:clampOutput(JSON.stringify(result))}],isError:result.status>=400,details:undefined};
        }
        let command: string;
        if (tool.kind === "script") {
          const code = String(spec["code"] ?? "");
          if (!code.trim()) throw new Error("脚本 code 为空");
          command = `printf %s ${shellQuote(JSON.stringify(args))} | python3 -c ${shellQuote(code)}`;
        } else if (tool.kind === "command" && spec["legacy_shell_args"] === true && tool.executable) {
          // Executable is configured by the operator; model supplies an argument string.
          command = `${shellQuote(tool.executable)} ${String(args["args"] ?? "")}`;
        } else {
          command = renderToolTemplate(String(spec["command"] ?? ""), args, shellQuote);
          if (Array.isArray(spec["args"])) command += " " + spec["args"].map((v) => shellQuote(renderToolTemplate(String(v), args))).join(" ");
        }
        if (!command.trim()) throw new Error("自定义工具 command 为空");
        await check("bash", { command, custom_tool: tool.key });
        return shell.execute(callID, { command, timeout: timeout / 1000 }, signal, update, extensionContext);
      },
    }) as unknown as ToolDefinition);
}

/** Shell entries describe installed command environments; they are not separate tools. */
export async function shellEnvironmentNotes(ctx:ToolRunContext){
 const entries=(await ctx.db.platform().listTools()).filter(t=>t.kind==='shell'&&t.enabled&&t.agents.includes(ctx.role));
 return entries.map(t=>`${t.key}: ${t.description}\n${t.usageHelp??''} ${t.whenToUse??''}`).join('\n').slice(0,8000);
}

export async function platformBashDescription(ctx:ToolRunContext,base:string,interactive:boolean){
 const notes=await shellEnvironmentNotes(ctx);
 return base+(notes?`\n可用命令环境：\n${notes}`:'')+
  (interactive?'\n需要持续交互时用 shell_open，后续 shell_send/read/close/list；句柄仅属于当前执行会话。':'');
}
