export const CONTEXT_BUDGET_KEYS = ["planner_context_budget_tokens", "worker_context_budget_tokens"] as const;
export type ContextBudgetKey = (typeof CONTEXT_BUDGET_KEYS)[number];
export type ContextBudgets = Record<ContextBudgetKey, number>;

export function contextBudgetFromK(value: string): number | null {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const tokens = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  return Number.isSafeInteger(tokens) && (tokens === 0 || tokens >= 8192 && tokens <= 1_000_000) ? tokens : null;
}

/** Missing fields mean an older server, not permission to silently save defaults. */
export function readContextBudgets(value: Partial<ContextBudgets>): ContextBudgets {
  for (const key of CONTEXT_BUDGET_KEYS) {
    const n = value[key];
    if (typeof n !== "number" || contextBudgetFromK(String(n / 1000)) !== n)
      throw new Error("服务未返回有效的上下文配置，请确认后端已更新后重试。");
  }
  return value as ContextBudgets;
}
