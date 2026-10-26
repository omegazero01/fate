import type { ModelTokenStat } from "./types";

// Older TypeScript servers returned a bare array; the original API uses an
// envelope. Normalize at the HTTP boundary so overview state is always an array.
export function modelTokenStats(response: { models?: ModelTokenStat[] | null } | ModelTokenStat[] | null) {
  const models = Array.isArray(response) ? response : response?.models;
  return { models: Array.isArray(models) ? models : [] };
}

export function cacheHitRate(cacheRead: number, input: number, known: boolean) {
  if (!known || !Number.isFinite(input) || !Number.isFinite(cacheRead) || input <= 0 || cacheRead < 0 || cacheRead > input) return "—";
  return `${((cacheRead / input) * 100).toFixed(1)}%`;
}

export function modelTokenTotals(models: ModelTokenStat[]) {
  return models.reduce((total, m) => ({
    input: total.input + m.input_tokens, output: total.output + m.output_tokens,
    uncached: total.uncached + (m.uncached_input_tokens ?? 0),
    cacheRead: total.cacheRead + m.cache_read_tokens, cacheWrite: total.cacheWrite + m.cache_write_tokens,
    calls: total.calls + (m.calls ?? 0), knownCalls: total.knownCalls && m.calls_complete !== false && typeof m.calls === 'number' && (m.source === 'request_audit'||m.source==='usage_ledger'),
    knownInput: total.knownInput && m.input_semantics === 'inclusive_cache' && m.input_complete !== false,
    compactions: total.compactions + (m.compaction_calls ?? 0), failures: total.failures + (m.failed_calls ?? 0),
    pending: total.pending + (m.pending_calls ?? 0), unknown: total.unknown + (m.unknown_usage_calls ?? 0),historyGaps:total.historyGaps+(m.history_gap_requests??0),
  }), {input:0,output:0,uncached:0,cacheRead:0,cacheWrite:0,calls:0,knownCalls:true,knownInput:true,compactions:0,failures:0,pending:0,unknown:0,historyGaps:0});
}
