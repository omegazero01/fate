// 工具运行上下文：领域工具与 store/引擎回调的唯一连接面。
// 每次 run（planner 轮 / worker 意图 / mainagent 回合 / goals 分解）构造一份，
// 工具工厂闭包持有它——工具不感知 HTTP、不感知 pi，只依赖此接口（低耦合关键）。

import type { Database } from "../db/index.js";
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export type AgentRole = "planner" | "worker" | "mainagent" | "goals" | "chat" | "auto" | "pentest" | "reporter" | "retester";

/** planner 跨唤醒共享的规划待办（按任务保留，内存态；引擎 M4 持有实例）。 */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
export class TodoStore {
  constructor(private db?: Database) {}
  async load(expID: number): Promise<void> {
    if (!this.db) return;
    const res = await this.db.query<{ planner_todos: TodoItem[] }>(`SELECT planner_todos FROM explorations WHERE id=$1`, [expID]);
    this.byExp.set(expID, res.rows[0]?.planner_todos ?? []);
  }
  private byExp = new Map<number, TodoItem[]>();
  get(expID: number): TodoItem[] {
    return this.byExp.get(expID) ?? [];
  }
  async set(expID: number, todos: TodoItem[]): Promise<void> {
    // 上限防御：planner 一次提交过多时只保留前 50 条。
    const bounded = todos.slice(0, 50);
    if (this.db) await this.db.query(`UPDATE explorations SET planner_todos=$2::jsonb WHERE id=$1`, [expID, JSON.stringify(bounded)]);
    this.byExp.set(expID, bounded);
  }
}

/** 引擎注入的回调面（M4 实装；M3 期由测试注入桩）。 */
export interface EngineHooks {
  assertOwnership?: (db:Database)=>Promise<void>;
  /** worker 报洞 → 立即唤醒 planner。 */
  notifyFinding?: (expID: number, findingNodeID: number) => void;
  /** 目标被证明 → 判定任务完成（取消在跑 worker）。 */
  notifyGoalMet?: (expID: number, goalNodeID: number) => void;
  /** mainagent 直投意图 → 自动下发。 */
  dispatchIntent?: (expID: number, intentID: number) => Promise<unknown>;
  goalsChanged?: (expID: number) => Promise<void>;
  constraintsChanged?: (expID: number) => void;
  notifyIntent?: (expID: number, intentID: number) => void;
  /** planner/mainagent 杀掉一条在跑意图。 */
  killWork?: (expID: number, intentID: number, reason: string, source?:string) => Promise<void>;
  /** Native pi steering delivered at the next model boundary, without blocking writeback. */
  steerWork?: (expID: number, intentID: number, message: string, source?:string) => Promise<void>;
}

export interface ToolRunContext {
  /** Current native transcript, supplied by the host for read receipts, never by tool arguments. */
  sessionEntries?:()=>readonly SessionEntry[];
  /** Actual current human request, bound by the host; never supplied in tool arguments. */
  userMessage?:string;
  /** Host-bound current Planner session; never supplied by a model or an HTTP parameter. */
  plannerSession?: {identity:()=>string;entries:()=>readonly SessionEntry[]};
  collaborationPolicy?: "blackboard-v1";
  planningRoundID?: string;
  conversationID?: number;
  mainSegment?: number;
  toolCallID?: string;
  signal?: AbortSignal;
  db: Database;
  taskID: number;
  expID: number;
  role: AgentRole;
  /** worker 执行名（work#N），活动流归属用。 */
  workerName?: string;
  /** worker 绑定的意图 id（写通道纪律：只能写回自己的意图）。 */
  intentID?: number;
  /** Fixed per-session network scope, used by a directed retest on every redirect. */
  networkTargets?: ReadonlyArray<{host:string;port:number|null}>;
  /** planner 跨唤醒 TodoStore（todo_write 与态势渲染用）。 */
  todos?: TodoStore;
  hooks: EngineHooks;
}

export function runContext(
  db: Database,
  taskID: number,
  expID: number,
  role: AgentRole,
  overrides: Partial<ToolRunContext> = {},
): ToolRunContext {
  return { db, taskID, expID, role, hooks: {}, ...overrides };
}
