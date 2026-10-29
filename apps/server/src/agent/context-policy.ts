export type ContextRole = 'planner' | 'worker';
export const CONTEXT_DEFAULTS = {planner:48_000,worker:0} as const;

/** Separate working-set targets; never override the provider's real capacity. */
export function roleContextPolicy(role:ContextRole,contextWindow:number,configured?:string|null) {
  const requested=configured==null||configured===''?CONTEXT_DEFAULTS[role]:Number(configured);
  if(!Number.isSafeInteger(requested)||requested<0||requested>1_000_000||requested>0&&requested<8192)
    throw new Error(`${role}_context_budget_tokens 必须为 8192–1000000 的整数；0 使用 pi 自动压缩`);
  const version=role==='planner'?'planner-context-v2':'worker-context-v1';
  if(requested===0||contextWindow<=0)return {version,mode:'capacity' as const};
  const threshold=Math.max(1,Math.min(requested,contextWindow-Math.min(16_384,Math.floor(contextWindow/4))));
  const keepRecentTokens=Math.max(1,Math.min(role==='planner'?12_000:20_000,Math.floor(threshold/4)));
  return {version,mode:'working_set' as const,thresholdTokens:threshold,
    summaryMaxTokens:role==='planner'?2048:4096,
    compactionSettings:{reserveTokens:contextWindow-threshold,keepRecentTokens}};
}
