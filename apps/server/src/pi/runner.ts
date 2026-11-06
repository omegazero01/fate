import {ActivityDelivery} from './activity-delivery.js';
import {nativeStreamID,withNativeActivity,type NativeActivityIdentity,type NativeActivityReference} from './native-activity.js';
import type {ToolLoading} from '../agent/tool-loading.js';
import {platformMcpExtension,hasDeferredMcp,MCP_RESOURCE_TOOLS,toolDiscoveryInstructions} from './platform-mcp.js';
import {domainCompactionExtension,type CompactionHealth} from './domain-compaction.js';
import {validatePlatformRunner,type PlatformPolicy} from './platform-policy.js';
import {requestSize,systemPromptSize,textSize} from '../agent/prompt-diagnostics.js';
import {stableToolPayload,hostTaskContext} from './request-prefix.js';
import {restrictRegisteredTools,wrapRegisteredTools} from './operation-tools.js';
import { randomUUID } from "node:crypto";
import { mkdirSync } from 'node:fs';
import path from 'node:path';
/**
 * pi SDK 会话生命周期、工具守卫、运行预算和事件适配。
 *
 * 基于 @earendil-works/pi-coding-agent 1.3.0 的真实 API 面（详见 src/pi/spike.ts 的验证结论）：
 * - 会话：createAgentSession({ model, modelRuntime, sessionManager, settingsManager, resourceLoader,
 *   tools, customTools, cwd, agentDir })
 * - guard：注入 InlineExtension，监听扩展事件 `tool_call`，返回 { block, reason } 阻断（等价于
 *   pi-agent-core Agent.beforeToolCall，但带会话/扩展上下文，spike T4 已验证）
 * - wrapup：InlineExtension 监听 `agent_before_settle`，返回 { continue: true, entries: [...] }
 *   注入收尾提示并续跑一轮（spike T5 已验证；预算封顶由本层计数保证）
 * - resume：SessionManager.open(path) 恢复 JSONL 会话继续对话（spike T6 已验证）
 * - steer/abort：session.steer() / session.abort()（spike T7/T7b 已验证）
 *
 * 模型对象类型从 pi-coding-agent 的导出推导；pi-ai 与 coding-agent 版本保持一致。
 */

import {
	createAgentSession,
  createWriteToolDefinition,createEditToolDefinition,
	DefaultResourceLoader,
	loadSkillsFromDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentBeforeSettleEventResult,
	type AgentSession,
	type AgentSessionEvent,
	type SessionEntry,
	type CreateAgentSessionOptions,
	type ExtensionFactory,
	type ToolCallEventResult,
	type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

/** 会话模型对象（等价 pi-ai 的 Model<Api>） */
export type PiModel = NonNullable<CreateAgentSessionOptions['model']>;
/** 思考级别（等价 pi-agent-core 的 ThinkingLevel） */
export type PiThinkingLevel = Extract<AgentSessionEvent, { type: 'thinking_level_changed' }>['level'];

/** 工具门控决定：block=true 时工具不执行，reason 会作为错误工具结果返回给模型 */
export interface ToolGuardDecision {
	block: boolean;
	reason?: string;
  /** A durable prerequisite changed: restrict tools and allow only a bounded writeback phase. */
  settle?: GuardSettlementReason;
}
export type GuardSettlementReason = 'basis_changed' | 'basis_unavailable';

/** 一次工具调用的门控上下文 */
export interface ToolGuardContext {
	signal?: AbortSignal;
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

/** 外部 guard：每次工具调用前询问（同步或异步） */
export type ToolGuard = (ctx: ToolGuardContext) => ToolGuardDecision | undefined | Promise<ToolGuardDecision | undefined>;

/** wrapup 决定：预算到点时给出收尾提示，本层注入并只允许有限轮收尾 */
export interface WrapupDecision {
	/** 注入给模型的收尾提示（作为 custom_message 进入上下文） */
	prompt: string;
}

/** 外部预算函数：每次 agent 即将 settle 时询问。返回 undefined 表示正常运行结束 */
export interface WrapupContext {
  reason: 'turn_limit' | 'duration_limit' | 'settled';
  usedRequests: number;
  remainingRequests?: number;
}
export type WrapupBudget = (context: WrapupContext) => WrapupDecision | undefined | Promise<WrapupDecision | undefined>;

type ClosingState = { active: boolean; reason?: WrapupContext['reason'];
  control?: {reason:GuardSettlementReason;prompt:string;limit:number;announced:boolean} };
const CLOSING_RULE = '已进入收尾阶段，停止新探索。bash、外部请求、MCP 等探索工具已停用，不要重试或排查工具环境。被宿主拒绝的调用未执行，不能当作目标响应或实测证据。仅读取已有证据、整理并提交本角色的最终结果；未完成的条件如实标记，不能继续探测来补齐。';
function closingToolError(name: string, text: string | undefined, closing: ClosingState, tools?: readonly string[]) {
  // pi resolves inactive tools before tool_call. Preserve the real failure but
  // explain deliberate host deactivation in both the transcript and activity UI.
  return closing.active && tools && !tools.includes(name) && text === `Tool ${name} not found`
    ? `${CLOSING_RULE}\n原始工具错误：${text}` : text;
}
function toolAvailabilityError(name:string,text:string|undefined,closing:ClosingState,opts:AgentRunnerOptions){
  const result=closingToolError(name,text,closing,opts.settlementTools);
  if(result!==text||text!==`Tool ${name} not found`||!opts.toolLoading?.deferred.includes(name))return result;
  return `工具 ${name} 尚未在当前声明中激活；先用 tool_search(query=${JSON.stringify(name)}) 检索，成功加载后再调用。若已禁用或撤销则停止，不能绕过。\n原始工具错误：${text}`;
}

/** 归一化后的 activity 事件（对接 Go/norma 的 activity 流） */
export type RunnerActivity = (
  | {kind:'host_status';text:string;phase?:string}
	| { kind: 'run_metadata'; runtimeID: string; role: string; mode: string; startedAt: string }
	| { kind: 'assistant_delta'; text: string; streamID: string; isThinking?: boolean }
	| { kind: 'assistant_message_end'; text: string; streamID?: string; isThinking?: boolean; final?: boolean; response?: { stop_reason: string; has_tools: boolean; model: string; provider: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } } }
	| { kind: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
	| { kind: 'tool_end'; toolCallId: string; toolName: string; isError: boolean; durationMs?: number; text?: string }
	| { kind: 'settled'; aborted: boolean; stopReason?: string }
	| { kind: 'usage'; input: number; output: number; cacheRead: number; cacheWrite: number }
	| { kind: 'queue_update'; steering: readonly string[]; followUp: readonly string[] }) & {native_event?:NativeActivityReference};

export interface AgentRunnerOptions {
  nativeActivity?:NativeActivityIdentity;
  nativeActivityRuntime?:string;
  flushNativeSession?:()=>Promise<void>;
  /** Host admission lease; never serialized into model context. */
  resourceLease?: import("../engine/runtime-resources.js").RuntimeResourceLease;
  goalsPhase?: import('../db/goals-bootstrap.js').GoalsPhase;
  /** Host execution receipts; never wraps model requests or changes pi's tool loop. */
  wrapExecutionTool?: (tool:ToolDefinition)=>ToolDefinition;
  /** Unknown external effects end at the native batch boundary, without a retry loop. */
  stopOnRecoveryBlock?:()=>boolean;
  contextLayout?: 'stable-prefix-v1';
  /** Host mandate at the request tail; rebuilt on session restore, never compacted away. */
  taskContext?: string;
  /** Host-owned durable completion; checked after paired tool results are saved. */
  stopWhen?: () => Promise<boolean>;
  reserveSettlementTurns?: number;
  boundaryContext?: () => Promise<string>;
  /** Request-only projection; native transcript stays immutable, including during compaction. */
  projectMessages?: (messages:import('@earendil-works/pi-coding-agent').ContextEvent['messages']) => import('@earendil-works/pi-coding-agent').ContextEvent['messages'];
  toolLoading?: ToolLoading;
  discoveryGuard?: (name:string)=>Promise<void>;
  platform?: {role:string;taskID:number;conversationID?:number;policy:PlatformPolicy};
  /** Size-only provider boundary instrumentation; never stores request content/credentials. */
  loadDomainState?: () => Promise<Record<string,unknown>>;
  intentID?: number;
  turnID?:string;
  mainSegment?:number;
  compactionSettings?: {reserveTokens?:number;keepRecentTokens?:number};
  contextPolicy?: ReturnType<typeof import('../agent/context-policy.js').roleContextPolicy>;
  /** Independent of compaction reserve/headroom, which can be very large. */
  summaryMaxTokens?:number;
  /** Adds role-specific retention requirements to native SDK compaction. */
  compactionInstructions?: string;
  /** Platform storage at the awaited native compaction boundary. Never another model loop. */
  onSessionCompacted?: (manager:SessionManager)=>Promise<void>;
  canonicalSessionPath?:string;
  archiveDiagnostics?:()=>unknown;
  /** Explicit SDK aggregate retention. Managed sessions default to last-turn;
   * originals remain in JSONL. False retains the SDK full-run default. */
  boundedRunHistory?:boolean;
  onRequestSize?: (size: ReturnType<typeof requestSize>,purpose?:'conversation'|'compaction') => void | Promise<void>;
	mcpGuard?: (server:string,method:string,tool?:string)=>Promise<void>;
	modelPolicy?: { onResponse(message: unknown): Promise<void>; retry(signal?:AbortSignal): Promise<boolean>; setPurpose?(purpose: 'conversation'|'compaction'):void; setRuntimeID?(id:string):void; setScope?(scope:import('../db/usage-ledger.js').UsageScope):void; finish?():Promise<void> };
	signal?: AbortSignal;
	maxTurns?: number;
	maxDurationMs?: number;
	allowedSkills?: string[];
	/** 工作目录（项目本地发现 + 会话默认目录基准） */
	cwd: string;
	/** pi 全局配置目录（auth.json / models.json 所在；建议每实例独立临时目录或服务级共享目录） */
	agentDir: string;
	/** 会话目录（文件会话存放处；缺省用 pi 默认） */
	sessionDir?: string;
	/** 已注入 provider 的模型运行时（服务启动时构造一次，多个 runner 复用） */
	modelRuntime: ModelRuntime;
	/** 模型对象 */
	model: PiModel;
	thinkingLevel?: PiThinkingLevel;
	/** 替换 SDK 默认角色正文；SDK 仍追加允许的 Skill 索引和工作目录。 */
	systemPrompt?: string;
	/** 允许启用的工具名（内置 + customTools；缺省 ['read','bash','edit','write']） */
	toolAllowlist?: string[];
	/** 服务端自定义工具 */
	customTools?: ToolDefinition[];
	/** Read-only compatibility candidates; the host filters these before registration. */
	legacyTools?: ToolDefinition[];
  extensionFactories?: ExtensionFactory[];
	/** 工具门控（等价 norma 的 guard） */
	guard?: ToolGuard;
	/** 收尾预算（等价 norma 的 settlement wrapup） */
	wrapup?: WrapupBudget;
	/** wrapup 最大续跑轮数（防止预算函数一直返回续跑导致死循环） */
	maxWrapupTurns?: number;
	/** Once closing begins only these tools may run; domain authorization still applies. */
	settlementTools?: readonly string[];
	/** 恢复既有会话文件（JSONL 路径）；给出时忽略 sessionDir 的新建语义 */
	resumeSessionPath?: string;
	/** 内存会话（不落盘），用于一次性角色。 */
	inMemory?: boolean;
	/** skills 根目录（SKILL.md 发现目录）；给出时注入会话技能（agentskills 渐进披露） */
	skillsDir?: string;
	/** MCP 服务器配置（DB mcp_servers 映射）；非空时挂 pi 的 MCP 扩展 */
	mcpEntries?: Array<{ name: string; config: Record<string, unknown> }>;
  mcpResourceTools?: string[];
	/** 原始 AgentSessionEvent 透传（调试 / 持久化用） */
	onRawEvent?: (event: AgentSessionEvent) => void;
	/** Hide incremental text events when the selected model profile disables visible streaming. */
	streaming?: boolean;
	/** 归一化 activity 流（对接 Go 侧 activity 映射） */
	onActivity?: (activity: RunnerActivity) => unknown;
}

export interface RunResult {
	/** settled 时是否被 abort */
	aborted: boolean;
	/** 最后一条助手文本（若有） */
	lastAssistantText: string | undefined;
	stopReason?: "completed" | "aborted" | "budget";
	budgetReason?: "turn_limit" | "duration_limit";
  settlementReason?: GuardSettlementReason;
}

/**
 * 单个 agent 运行器：封装「构造 session → 订阅事件 → guard/wrapup 门控 → resume/abort」。
 * 一个 runner 对应一个会话（内存或文件），不可跨会话复用；多会话由上层池化管理。
 */
export class AgentRunner {
	private entryCache?:{sessionID:string;count:number;entries:readonly SessionEntry[]};
  private runHistory = {mode:'all' as 'all'|'last-turn',native_starts:0,native_ends:0,omitted_messages:0,last_result_messages:0};
	private readonly session: AgentSession;
	private readonly opts: AgentRunnerOptions;
	private turns = 0;
	private streamID:string = randomUUID();
	private budgetExceeded = false;
	private closing: ClosingState = { active: false };
  private wrapupContext!: (reason: WrapupContext['reason']) => WrapupContext;
	private budgetReason: RunResult['budgetReason'];
  private compactionHealth:CompactionHealth={requests:0,completed:0,failed:0};
	private modelError: string | undefined;
  private hostContextFailure: {error?:Error} = {};
  private domainCompletion = {done:false};
	private settled!: (result: RunResult) => void;
	private settledPromise!: Promise<RunResult>;

	private constructor(session: AgentSession, opts: AgentRunnerOptions, private readonly activityDelivery: ActivityDelivery) {
		this.session = session;
		this.opts = opts;
		this.resetSettled();
		this.session.subscribe((event) => this.handleEvent(event));
	}

	private resetSettled(): void {
		this.settledPromise = new Promise<RunResult>((resolve) => {
			this.settled = resolve;
		});
	}

	// -------------------------------------------------------------------------
	// 构造
	// -------------------------------------------------------------------------

	static async create(opts: AgentRunnerOptions): Promise<AgentRunner> {
    const closing: ClosingState = { active: false };
    const domainCompletion = {done:false};
    let turns = 0;
    const wrapupContext = (reason: WrapupContext['reason']): WrapupContext => ({reason,
      usedRequests: turns + compactionHealth.requests,
      remainingRequests: opts.maxTurns ? Math.max(0, opts.maxTurns + (opts.wrapup ? (opts.maxWrapupTurns ?? 1) : 0) - turns - compactionHealth.requests) : undefined,
    });
    const closingPrompt = (prompt: string) => opts.settlementTools ? `${CLOSING_RULE}\n${prompt}` : prompt;
    const requestLimit=()=>Math.min(
      opts.maxTurns?opts.maxTurns+(opts.wrapup?(opts.maxWrapupTurns??1):0):Infinity,
      closing.control?.limit??Infinity,
    );
    let enterClosing = () => {closing.active=true;};
    if(opts.platform) validatePlatformRunner(opts.platform.role,opts,opts.platform.taskID);
    const activityDelivery = new ActivityDelivery();
    const hostContextFailure: {error?:Error} = {};
    let invalidateNativeEntries=()=>{};
    const activityExtension: ExtensionFactory = api => {
      const drain = async (_event: unknown, context: {abort():void}) => {
        try { await activityDelivery.drain(); } catch { context.abort(); }
      };
      // These hooks are awaited by PI. A subscribe callback is deliberately not
      // used as an async queue: PI does not await public event listeners.
      api.on('message_start', drain);
      api.on('tool_execution_start', drain);
      api.on('tool_execution_end', drain);
      api.on('turn_end', drain);
      api.on('before_provider_request', drain);
      api.on('agent_before_settle', drain);
      api.on('tool_call', async (_event, context) => {
        try { await activityDelivery.drain(); }
        catch(error) { context.abort(); return {block:true,reason:String(error),terminate:true}; }
      });
    };
    const diagnosticsExtension: ExtensionFactory = api => {
      api.on('session_compact',async(_event,context)=>{
        if(!opts.onSessionCompacted)return;
        try{await activityDelivery.drain();await opts.onSessionCompacted(sessionManager);}
        catch(error){
          hostContextFailure.error=new Error(`原生会话归档失败，已停止本次执行：${error instanceof Error?error.message:String(error)}`,{cause:error});
          context.abort();
        }finally{invalidateNativeEntries();}
      });
      api.on('before_agent_start',event=>{
        if(opts.contextLayout)event.systemPromptOptions.sections.cwd='实际工作目录见本次宿主执行上下文的 cwd；相对路径由工具在该目录解析。';
      });
      api.on('context', async (event,context) => {
        try {
        // Keep legacy feedback in the audit session, never in Agent coordination.
        const messages=[...(opts.projectMessages?.(event.messages)??event.messages)];
        if(opts.contextLayout)messages.push({role:'custom',customType:'host_task_context',display:false,timestamp:Date.now(),content:hostTaskContext(opts.cwd,opts.taskContext)});
        const current=await opts.boundaryContext?.();
        if(current)messages.push({role:'custom',customType:'blackboard_boundary',content:current,display:false,timestamp:Date.now()});
        if(opts.settlementTools){
          const budget=wrapupContext(closing.reason??'settled');
          // Current host state takes precedence over old budget notices on resume.
          // This projection does not grow the persisted conversation each turn.
          messages.push({role:'custom',customType:'execution_budget',display:false,timestamp:Date.now(),content:
            '【本次执行预算，以此为准】'+(budget.remainingRequests===undefined?'配置为不限模型请求轮数；时间限制、暂停和授权仍生效。':`已用 ${budget.usedRequests} 次，剩余最多 ${budget.remainingRequests} 次模型请求（含收尾和压缩）；工具失败后的重试也占用轮数。`)+
            (closing.active ? CLOSING_RULE : '当前仍在执行阶段；完成本意图即可提交，不必用满预算。')+
            (closing.control?`\n【宿主收尾，以此为准】${closing.control.prompt}；剩余最多 ${Math.max(0,requestLimit()-turns-compactionHealth.requests)} 次请求（含压缩）。写回已有观察并总结，不重试探测。`:'' )});
        }
        return {messages};
        } catch(error) {
          // PI reports extension errors, but may otherwise continue with the
          // default transcript. A failed authoritative context must stop the
          // request, never silently omit current state/read-gap metadata.
          hostContextFailure.error=new Error(`宿主上下文构建失败，已停止本次执行：${error instanceof Error?error.message:String(error)}`,{cause:error});
          context.abort();
          return {messages:event.messages};
        }
      });
      api.on('message_end', event => {
        const message=event.message;
        if(message.role!=='toolResult'||!message.isError)return;
        const original=toolResultText(message),text=toolAvailabilityError(message.toolName,original,closing,opts);
        if(text!==original && text)return {message:{...message,content:[{type:'text' as const,text}]}};
      });
      api.on('before_provider_request', async (event,context) => {
        if(hostContextFailure.error){context.abort();return event.payload;}
        if(closing.active)enterClosing();
        const payload=opts.contextLayout?stableToolPayload(event.payload):event.payload;
        await opts.onRequestSize?.(requestSize(payload));
        return payload;
      });
    };
    const declared=[...new Set([...(opts.toolAllowlist??[]),...(hasDeferredMcp(opts)||opts.toolLoading?.deferred.length?['tool_search']:[]),...(opts.mcpEntries?.length&&opts.toolAllowlist?.includes('mcp__*')?(opts.mcpResourceTools??MCP_RESOURCE_TOOLS):[])])];
    const permitted=(name:string)=>declared.includes(name)||name.startsWith('mcp__')&&declared.includes('mcp__*');

		const settings = SettingsManager.inMemory({
      ...(opts.toolLoading?{defaultTools:declared.filter(n=>!opts.toolLoading!.deferred.includes(n)&&!n.includes('*'))}:{}),
			// pi owns conversation compaction; graph compaction remains a separate domain projection.
			retry: { enabled: false },
			compaction: { enabled: true,...opts.compactionSettings },
		});
		const modelPolicyExtension: ExtensionFactory = (pi) => {
			pi.on('message_end', async event => {
				if(event.message.role === 'assistant') await opts.modelPolicy?.onResponse(event.message);
			});
			pi.on('agent_before_settle', async (event,context) => {
        const signal=opts.signal&&context.signal?AbortSignal.any([opts.signal,context.signal]):opts.signal??context.signal;
				if(event.outcome === 'error' && !signal?.aborted && await opts.modelPolicy?.retry(signal)) return {
					continue:true, entries:[{type:'custom_message' as const,customType:'model_failover',display:false,
					content:'模型请求失败后已由宿主切换或重试。依据已有消息和工具结果继续；已完成的工具操作无需重复。'}],
				};
			});
		};

		const guardExtension: ExtensionFactory | undefined = opts.guard || opts.settlementTools || opts.stopWhen
			? (pi) => {
					pi.on('tool_call', async (event, context): Promise<ToolCallEventResult | undefined> => {
            if(await opts.stopWhen?.())return {block:true,reason:'本角色的最终结果已提交，不能继续操作',terminate:false};
            if (closing.active && opts.settlementTools && !opts.settlementTools.includes(event.toolName))
              return {block:true,reason:CLOSING_RULE,terminate:false};
						const decision = await opts.guard?.({
							signal: context.signal,
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.input as Record<string, unknown>,
						});
						if (decision?.block) {
              if(decision.settle&&!closing.control){
                closing.control={reason:decision.settle,prompt:decision.reason??'意图依据不可用，停止新探测并保存已有观察',
                  limit:turns+compactionHealth.requests+1+Math.max(1,opts.maxWrapupTurns??2),announced:false};
                enterClosing();
                const text=`宿主已切换为收尾：${closing.control.prompt}；仅保留读取与写回，最多 ${Math.max(1,opts.maxWrapupTurns??2)} 次收尾请求。`;
                activityDelivery.emit(() => opts.onActivity?.({kind:'host_status',phase:'closing',text}));
              }
              return { block: true, reason: decision.reason ?? 'blocked by server guard', terminate: false };
            }
            return undefined;
					});
				}
			: undefined;

		const wrapupExtension: ExtensionFactory | undefined = opts.wrapup
			? (pi) => {
					pi.on('agent_before_settle', async (event): Promise<AgentBeforeSettleEventResult | undefined> => {
						if (closing.control || event.outcome !== 'completed' || (opts.maxTurns && turns >= opts.maxTurns)) return undefined;
						const maxTurns = opts.maxWrapupTurns ?? 1;
						if (this_wrapupUsed(opts) >= maxTurns) return undefined;
						const decision = await opts.wrapup?.(wrapupContext('settled'));
						if (!decision) return undefined;
            closing.reason ??= 'settled';
						enterClosing();
						incWrapup(opts);
						return {
							continue: true,
							entries: [
								{
									type: 'custom_message' as const,
									customType: 'server_wrapup',
									content: closingPrompt(decision.prompt),
									display: true,
								},
							],
						};
					});
				}
			: undefined;

    let budgetAnnounced = false;
		const budgetExtension: ExtensionFactory = (pi) => {
      enterClosing=()=>{closing.active=true;if(opts.settlementTools)pi.setActiveTools(pi.getActiveTools().filter(name=>opts.settlementTools!.includes(name)));};
      pi.on('turn_start',(_event,context)=>{
        if(turns+compactionHealth.requests>=requestLimit()){
          if(!closing.control)closing.reason='turn_limit';context.abort();
        }
      });
			pi.on('turn_end', async (_event, context) => {
				turns++;
        if(opts.stopOnRecoveryBlock?.()){context.abort();return;}
        if(await opts.stopWhen?.()){domainCompletion.done=true;context.abort();return;}
        if(closing.active)enterClosing();
        if(closing.control){
          if(turns+compactionHealth.requests>=requestLimit()){
            if(_event.message.role==='assistant'&&_event.message.content.some(b=>b.type==='toolCall'))context.abort();
            return;
          }
          if(!closing.control.announced){
            closing.control.announced=true;
            return {continue:true,entries:[{type:'custom_message' as const,customType:'server_prerequisite_changed',
              content:closingPrompt(closing.control.prompt),display:true}]};
          }
          return;
        }
				if (!opts.maxTurns) return;
        // A natural final response needs no extra budget-closing model turn.
        if (_event.message.role === 'assistant' && !_event.message.content.some(block => block.type === 'toolCall')) return;
				const grace = opts.wrapup ? (opts.maxWrapupTurns ?? 1) : 0;
				if (turns + compactionHealth.requests >= opts.maxTurns + grace) {
					if (_event.message.role === 'assistant' && _event.message.content.some((block) => block.type === 'toolCall')) context.abort();
					return;
				}
				if (turns + compactionHealth.requests >= Math.max(1,opts.maxTurns-(opts.reserveSettlementTurns??0)) && !budgetAnnounced) {
          budgetAnnounced = true;
					const decision = await opts.wrapup?.(wrapupContext('turn_limit'));
          // A role whose required result is already committed needs no budget reminder.
          if (opts.wrapup && !decision) return;
          closing.reason = 'turn_limit';
					enterClosing();
					return { continue: true, entries: [{ type: 'custom_message' as const, customType: 'server_budget',
						content: closingPrompt(decision?.prompt ?? '本轮预算已用尽。停止发起新操作，保存已有结果并简洁总结。'), display: true }] };
				}
			});
		};

		const mcpFactory=opts.mcpEntries?.length||opts.toolLoading?.deferred.length?platformMcpExtension(opts):undefined;


		const compactionHealth:CompactionHealth={requests:0,completed:0,failed:0};
    const compactionExtension=opts.platform?domainCompactionExtension(opts,compactionHealth,()=>requestLimit()-turns-compactionHealth.requests):undefined;
		const loader = new DefaultResourceLoader({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			settingsManager: settings,
			noExtensions: true,
			extensionFactories: [activityExtension, diagnosticsExtension, modelPolicyExtension, compactionExtension, guardExtension, wrapupExtension, budgetExtension, mcpFactory,...(opts.extensionFactories??[])].filter(
				(e): e is ExtensionFactory => typeof e === 'function',
			).map(factory=>wrapRegisteredTools(opts.toolLoading?restrictRegisteredTools(factory,permitted):factory,tool=>{
        const wrapped=opts.wrapExecutionTool?.(tool)??tool;
        return opts.toolLoading?.deferred.includes(tool.name)?{...wrapped,exposure:'deferred'}:wrapped;
      })),
			noSkills: !opts.skillsDir,
			skillsOverride: opts.skillsDir
				? (base) => {
						const loaded = loadSkillsFromDir({ dir: opts.skillsDir!, source: 'series' });
                        return { skills: loaded.skills.filter((skill) => !opts.allowedSkills || opts.allowedSkills.includes(skill.name)).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0), diagnostics: [...base.diagnostics, ...loaded.diagnostics] };
					}
				: undefined,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: opts.systemPrompt ? opts.systemPrompt+toolDiscoveryInstructions(opts) : opts.systemPrompt,
		});
		await loader.reload();

		if (opts.resumeSessionPath) mkdirSync(path.dirname(opts.resumeSessionPath), { recursive: true });
		const sessionManager = opts.resumeSessionPath
			? SessionManager.open(opts.resumeSessionPath, opts.sessionDir, opts.cwd)
			: opts.inMemory
				? SessionManager.inMemory(opts.cwd)
				: SessionManager.create(opts.cwd, opts.sessionDir);

    const customTools=[...(opts.customTools??[])];
    if(opts.wrapExecutionTool)for(const factory of [createWriteToolDefinition,createEditToolDefinition]){
      const tool=factory(opts.cwd) as ToolDefinition;
      if(opts.toolAllowlist?.includes(tool.name)&&!customTools.some(t=>t.name===tool.name))customTools.push(tool);
    }
		const { session } = await createAgentSession({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			model: opts.model,
			thinkingLevel: opts.thinkingLevel,
			modelRuntime: opts.modelRuntime,
			settingsManager: settings,
			sessionManager,
			resourceLoader: loader,
			tools:opts.toolLoading?undefined:opts.toolAllowlist?declared:undefined,
      excludeTools:opts.toolLoading?['read','bash','write','edit','grep','find','ls'].filter(n=>!permitted(n)):undefined,
			customTools:(opts.toolLoading?customTools.filter(t=>permitted(t.name)):customTools).map(t=>opts.wrapExecutionTool?.(t)??t),
		});

		const runner = new AgentRunner(session, opts, activityDelivery);
    if(opts.boundedRunHistory??!!opts.onSessionCompacted){
      // A checked public dependency patch only changes the aggregate result;
      // it does not split loops, replace hooks, or truncate native originals.
      if(!sessionManager.getSessionFile() || !('runHistoryMode' in session.agent)){
        session.dispose();
        throw new Error('有界运行汇总需要持久化 PI 会话及仓库锁定的 SDK 补丁');
      }
      session.agent.runHistoryMode='last-turn';
      runner.runHistory.mode='last-turn';
    }
    invalidateNativeEntries=()=>{runner.entryCache=undefined;};
    runner.domainCompletion=domainCompletion;
    runner.hostContextFailure=hostContextFailure;
    runner.closing = closing;
    runner.wrapupContext = wrapupContext;
    runner.compactionHealth=compactionHealth;
		try {
			await session.bindExtensions({}); // Fires session_start: native MCP connects here.
      if(opts.toolLoading){
        // Native recovery restores the previous declaration, which can be an old
        // or budget-closing loadout. Add today's permitted resident tools while
        // retaining discovered tools; never reactivate an unregistered binding.
        const registered=new Set(session.getAllTools().map(tool=>tool.name));
        session.setActiveToolsByName([...new Set([
          ...session.getActiveToolNames(),
          ...declared.filter(name=>!opts.toolLoading!.deferred.includes(name)),
        ])].filter(name=>permitted(name)&&registered.has(name)));
        const entries=sessionManager.getEntries();
        if(!entries.some(e=>e.type==='message'))sessionManager.appendCustomEntry(opts.toolLoading.version,{initial_active:session.getActiveToolNames()});
        // pi restores its transcript loadout and pending MCP names. No host replay of tools or messages.
      }
			return runner;
		} catch (err) { await runner.dispose(); throw err; }
	}

	// -------------------------------------------------------------------------
	// 事件 → activity 映射（spike T3 顺序：… → tool_execution_start → tool_execution_end
	// → … → agent_end → agent_settled）
	// -------------------------------------------------------------------------

  private nativeActivity(activity:RunnerActivity):RunnerActivity {
    return this.opts.nativeActivityRuntime?withNativeActivity(activity,this.opts.nativeActivityRuntime,this.nativeActivitySequence):activity;
  }
  private emitActivity(activity:RunnerActivity):void {
    this.nativeActivityRevision++;
    const delivered=this.nativeActivity(activity);
    this.activityDelivery.emit(() => this.opts.onActivity?.(delivered));
  }

  private nativeActivitySequence=0;
  private nativeActivityRevision=0;
  private nativeActivityAcknowledgement=-1;
  private nativeToolDurations=new Map<string,number|undefined>();

  /** Host acknowledgement only, after role-specific final projection succeeds.
   * Any subsequent event invalidates it. It never acknowledges a model claim. */
  async acknowledgeNativeActivities(){
    await this.activityDelivery.drain();
    if(this.session.isStreaming)throw new Error('Cannot acknowledge native activities before actual settlement');
    this.nativeActivityAcknowledgement=this.nativeActivityRevision;
  }
  get nativeActivitiesAcknowledged(){return this.nativeActivityAcknowledgement===this.nativeActivityRevision&&!this.activityDelivery.diagnostics.failed;}


  get activityDiagnostics() { return this.activityDelivery.diagnostics; }

	private handleEvent(event: AgentSessionEvent): void {
		this.opts.onRawEvent?.(event);
		switch (event.type) {
      case 'agent_start':this.runHistory.native_starts++;break;
      case 'agent_end':
        this.runHistory.native_ends++;
        this.runHistory.omitted_messages+=event.runHistory?.omittedMessages??0;
        this.runHistory.last_result_messages=event.messages.length;
        break;
			case 'turn_end':
				this.turns++;
				if (this.opts.maxTurns && this.turns + this.compactionHealth.requests >= this.opts.maxTurns
          && event.message.role === 'assistant' && event.message.content.some(block => block.type === 'toolCall')) {
          this.budgetExceeded = true; this.budgetReason ??= 'turn_limit';
        }
				break;
			case 'message_start':
				if (event.message.role === 'assistant') {
          this.nativeActivitySequence++;
          this.streamID=this.opts.nativeActivityRuntime?nativeStreamID(this.opts.nativeActivityRuntime,this.nativeActivitySequence):randomUUID();
        }
				break;
			case 'message_update': {
				const update = event.assistantMessageEvent;
				if (this.opts.streaming !== false && (update.type === 'text_delta' || update.type === 'thinking_delta')) {
					this.emitActivity({ kind: 'assistant_delta', text: update.delta, streamID: this.streamID, isThinking: update.type === 'thinking_delta' });
				}
				break;
			}
			case 'message_end':
				if (event.message.role === 'assistant') {
					this.modelError = event.message.stopReason === 'error' ? event.message.errorMessage ?? '模型调用失败' : undefined;
					const thinking = assistantThinking(event.message);
					if (thinking) {
						this.emitActivity({ kind: 'assistant_message_end', text: thinking, streamID: this.streamID, isThinking: true });
					}
          const original=this.nativeActivity({kind:'assistant_message_end',text:assistantText(event.message),streamID:this.streamID,
            response:{stop_reason:event.message.stopReason,has_tools:event.message.content.some(b=>b.type==='toolCall'),model:event.message.model,provider:event.message.provider,usage:event.message.usage}});
          this.emitActivity(this.domainCompletion.done&&['aborted','error'].includes(event.message.stopReason)&&!event.message.content.length&&!event.message.usage.totalTokens
            ? {...original,response:undefined} as RunnerActivity:original);
					const u = (event.message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }).usage;
					if (u) {
						this.emitActivity({ kind: 'usage', input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
					}
        }else if(event.message.role==='toolResult'&&this.opts.nativeActivityRuntime){
          // Native message_end follows result extensions. Hash this authoritative
          // text, not the earlier tool event before extension transformations.
          const m=event.message;
          this.emitActivity({kind:'tool_end',toolCallId:m.toolCallId,toolName:m.toolName,isError:!!m.isError,
            durationMs:this.nativeToolDurations.get(m.toolCallId),text:toolResultText(m)});
          this.nativeToolDurations.delete(m.toolCallId);
        }
        break;
      case 'tool_execution_start':
				this.emitActivity({
					kind: 'tool_start',
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				break;
			case 'tool_execution_end':
        if(this.opts.nativeActivityRuntime&& !('parentToolCallId' in event&&event.parentToolCallId)){this.nativeToolDurations.set(event.toolCallId,event.durationMs);break;}
				this.emitActivity({
					kind: 'tool_end',
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					durationMs: event.durationMs,
					text: toolAvailabilityError(event.toolName,toolResultText(event.result),this.closing,this.opts),
				});
				break;
			case 'queue_update':
				this.emitActivity({ kind: 'queue_update', steering: event.steering, followUp: event.followUp });
				break;
			case 'agent_settled':
				this.emitActivity({ kind: 'settled', aborted: this.domainCompletion.done?false:event.aborted, stopReason:this.domainCompletion.done?'completed':this.closing.control?.reason??(this.budgetExceeded||this.closing.reason==='turn_limit'||this.closing.reason==='duration_limit'?'budget':event.aborted?'aborted':'completed') });
				this.settled({ aborted: this.domainCompletion.done?false:event.aborted, lastAssistantText: this.session.getLastAssistantText(), stopReason: this.domainCompletion.done?"completed":this.budgetExceeded || this.closing.reason==='turn_limit' || this.closing.reason==='duration_limit' ? "budget" : event.aborted ? "aborted" : "completed", budgetReason:this.domainCompletion.done?undefined:this.budgetReason??(this.closing.reason==='settled'?undefined:this.closing.reason),settlementReason:this.domainCompletion.done?undefined:this.closing.control?.reason });
				this.resetSettled();
				break;
			default:
				break;
		}
	}

	// -------------------------------------------------------------------------
	// 对话驱动
	// -------------------------------------------------------------------------

	/** 发送一条用户消息并等待本次 run settle（含 wrapup 续跑轮） */
	async prompt(text: string, images?: import("../evidence/attachments.js").ChatImage[]): Promise<RunResult> {
		if(this.hostContextFailure.error)throw this.hostContextFailure.error;
		this.modelError = undefined;
    this.compactionHealth.error=undefined;
		this.opts.signal?.throwIfAborted();
		const finished = this.settledPromise;
		const abort = () => { void this.abort(); };
		this.opts.signal?.addEventListener('abort', abort, { once: true });
		const timer = this.opts.maxDurationMs ? setTimeout(() => {
			this.budgetExceeded = true;
      this.budgetReason = 'duration_limit';
			void this.abort();
		}, this.opts.maxDurationMs) : undefined;
    // Reserve time inside (never beyond) the run deadline for durable writeback.
    let active = true;
    const closingTimer = this.opts.maxDurationMs && this.opts.settlementTools && this.opts.wrapup ? setTimeout(() => {
      void (async()=>{
        const decision = await this.opts.wrapup?.(this.wrapupContext('duration_limit'));
        if(!active || this.opts.signal?.aborted || !decision)return;
        this.closing.active=true;this.closing.reason='duration_limit';
        await this.steer('时间预算即将耗尽。'+CLOSING_RULE+'\n'+decision.prompt);
      })().catch(()=>{ /* The hard deadline remains authoritative. */ });
    }, this.opts.maxDurationMs - Math.min(30_000, this.opts.maxDurationMs * 0.1)) : undefined;
		try {
			await this.session.prompt(text,{images});
			const result = await finished;
      await this.activityDelivery.drain();
      if(this.hostContextFailure.error)throw this.hostContextFailure.error;
      this.assertCompactionHealthy();
			if (this.modelError && !this.domainCompletion.done && !this.opts.signal?.aborted && !result.aborted) throw new Error(this.modelError);
			return result;
		} finally {
			active = false;
			clearTimeout(timer);
      clearTimeout(closingTimer);
			this.opts.signal?.removeEventListener('abort', abort);
		}
	}

	/** 运行中注入 steering 消息（当前回合工具跑完后、下一次 LLM 调用前生效） */
	async steer(text: string): Promise<'queued' | 'handled'> {
		return (await this.session.steer(text)) as 'queued' | 'handled';
	}

	/** 排队 follow-up（本轮彻底结束后再生效） */
	async followUp(text: string): Promise<'queued' | 'handled'> {
		return (await this.session.followUp(text)) as 'queued' | 'handled';
	}

	/** 中止当前运行并等待 idle */
	async abort(): Promise<void> {
		await this.session.abort();
	}

	// -------------------------------------------------------------------------
	// 会话生命周期
	// -------------------------------------------------------------------------

	/** 当前会话文件路径（内存会话为 undefined；首条用户消息落盘后才存在） */
	get sessionFile(): string | undefined {
		return this.opts.canonicalSessionPath??this.session.sessionFile;
	}

	get sessionId(): string {
		return this.session.sessionId;
	}

	/** 当前完整消息列表（含自定义消息） */
	get messages(): readonly unknown[] {
		return this.session.messages;
	}

  get sessionEntries(): readonly SessionEntry[] {
    const manager=this.session.sessionManager,sessionID=manager.getSessionId(),count=manager.getEntryCount();
    if(this.entryCache?.sessionID!==sessionID||this.entryCache.count!==count)
      this.entryCache={sessionID,count,entries:manager.getEntries()};
    return this.entryCache.entries;
  }

  get sessionLeafId():string|null {return this.session.sessionManager.getLeafId();}

  /** Host metadata stays in the native transcript and never becomes a model instruction. */
  appendSessionEntry(customType:string,data:unknown):string {
    return this.session.sessionManager.appendCustomEntry(customType,data);
  }

  contextKeys(prefix: string): string[] {
    return this.session.sessionManager.getBranch().flatMap(e => {
      if(e.type !== 'custom_message' || e.customType !== 'fate_context') return [];
      const key = (e.details as {key?: string} | undefined)?.key;
      return key?.startsWith(prefix) ? [key] : [];
    });
  }

  /** A single durable custom message is both context and its delivery marker. Branch-aware. */
  async appendContextOnce(key: string, content: string): Promise<boolean> {
    const entries = this.session.sessionManager.getBranch();
    if (entries.some(e => e.type === 'custom_message' && e.customType === 'fate_context' &&
      (e.details as {key?: string} | undefined)?.key === key)) return false;
    await this.session.sendCustomMessage({customType:'fate_context',content,display:false,details:{key}}, {triggerTurn:false});
    return true;
  }

  private assertCompactionHealthy(){if(this.compactionHealth.error)throw new Error(`会话压缩失败，可恢复重试：${this.compactionHealth.error.message}`);}

  async compact():Promise<void>{
    if(this.hostContextFailure.error)throw this.hostContextFailure.error;
    this.compactionHealth.error=undefined;
    try{await this.session.compact();}catch(error){throw this.compactionHealth.error??error;}
    this.assertCompactionHealthy();
    if(this.hostContextFailure.error)throw this.hostContextFailure.error;
  }

  get compactionDiagnostics(){const {requests,completed,failed,cancelled=0}=this.compactionHealth;return {requests,completed,failed,cancelled};}
  get runHistoryDiagnostics(){return {...this.runHistory};}

  get activeToolNames(){return this.session.getActiveToolNames();}
  get settlementReason(){return this.closing.control?.reason;}

  get promptDiagnostics() {
    const names = new Set(this.session.getActiveToolNames());
    const tools = this.session.getAllTools().filter(t => names.has(t.name)).map(t => ({name:t.name,description:t.description,parameters:t.parameters}));
    return {...systemPromptSize(this.session.systemPrompt, tools),context_layout:this.opts.contextLayout??'legacy',
      host_task_context:{...textSize(this.opts.contextLayout?hostTaskContext(this.opts.cwd,this.opts.taskContext):''),source:'host_request_tail'}};
  }

	/** 在当前 runner 之外按路径恢复一个新 runner（同一 modelRuntime 可复用） */
	async resume(options: Omit<AgentRunnerOptions, 'resumeSessionPath' | 'modelRuntime'> & { modelRuntime?: ModelRuntime }): Promise<AgentRunner> {
		const path = this.sessionFile;
		if (!path) throw new Error('当前会话尚未落盘，无法 resume');
		return AgentRunner.create({
			...options,
			modelRuntime: options.modelRuntime ?? this.opts.modelRuntime,
			resumeSessionPath: path,
		});
	}

	async dispose(): Promise<void> {
		try { await this.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
		finally {
      this.session.dispose();
      this.nativeToolDurations.clear();
      // Cancellation/disposal must release outstanding host writes, too. The
      // prompt already reports projection failures; do not mask its outcome.
      await this.activityDelivery.drain().catch(()=>{});
      await this.opts.modelPolicy?.finish?.();
    }
	}
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 提取 assistant 消息的 thinking 块文本（pi ThinkingContent）。 */
function assistantThinking(message: unknown): string | undefined {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'thinking') {
			const t = (block as { thinking?: unknown }).thinking;
			if (typeof t === 'string' && t.trim() !== '') parts.push(t);
		}
	}
	return parts.length > 0 ? parts.join('\n') : undefined;
}

/** 提取工具结果里的 text content（AgentToolResult.content[].text）。 */
function toolResultText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			const t = (block as { text?: unknown }).text;
			if (typeof t === "string") texts.push(t);
		}
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/** wrapup 已用轮数的 per-runner 计数（通过闭包挂到 opts 上，避免静态状态串会话） */
const wrapupCounters = new WeakMap<AgentRunnerOptions, number>();
function this_wrapupUsed(opts: AgentRunnerOptions): number {
	return wrapupCounters.get(opts) ?? 0;
}
function incWrapup(opts: AgentRunnerOptions): void {
	wrapupCounters.set(opts, this_wrapupUsed(opts) + 1);
}

function assistantText(message: unknown): string {
	if (typeof message !== 'object' || message === null) return '';
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return '';
	return content
		.filter((c): c is { type: 'text'; text: string } => typeof c === 'object' && c !== null && (c as { type: string }).type === 'text')
		.map((c) => c.text)
		.join('');
}
