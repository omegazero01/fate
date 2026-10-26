import { createHash } from 'node:crypto';

export interface EvidenceRef { node_id: number; version: number; report_revision?: number; }
/** Reading versions include report prose; execution validity excludes only report-only revisions. */
export const basisVersion=(ref:{version:number;report_revision?:number})=>ref.version-(ref.report_revision??0);
export interface WorkIdentity { resource: string; question_key: string; method_class: string; identity: string; }
export interface IntentContract {
  version: 1;
  objective: string;
  acceptance: string[];
  out_of_scope: string[];
  basis: EvidenceRef[];
  work?: WorkIdentity;
  allowed_tools?: string[];
}
export interface IntentResult {
  outcome: 'complete' | 'partial' | 'blocked';
  summary: string;
  criteria: { index: number; outcome: 'supported' | 'not_supported' | 'unknown'; fact_ids: number[] }[];
  remaining: string;
  publish_ids?: number[];
}

function text(value: unknown, name: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 不能为空且不能超过 ${max} 字符`);
  return value.trim();
}
export function normalizeContract(value: unknown, summary: string): IntentContract {
  if (value === undefined) return { version: 1, objective: text(summary, 'summary'), acceptance: [summary.trim()], out_of_scope: [], basis: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('contract 必须是对象');
  const c = value as Record<string, unknown>;
  const acceptance = c.acceptance ?? [summary.trim()];
  if (!Array.isArray(acceptance) || !acceptance.length || acceptance.length > 10) throw new Error('acceptance 需要 1–10 条完成条件');
  const list = (v: unknown, name: string, max: number) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max) throw new Error(`${name} 列表无效`);
    return v.map(x => text(x, name));
  };
  const basis = c.basis ?? [];
  if (!Array.isArray(basis) || basis.length > 20) throw new Error('basis 最多 20 个事实引用');
  const refs = basis.map((r: EvidenceRef) => {
    if (!r || !Number.isSafeInteger(r.node_id) || r.node_id <= 0 || !Number.isSafeInteger(r.version) || r.version < 0) throw new Error('basis 需要有效 node_id 和 version');
    if(r.report_revision!==undefined&&(!Number.isSafeInteger(r.report_revision)||r.report_revision<0))throw new Error('report_revision 无效');
    return { node_id: r.node_id, version: r.version,...(r.report_revision!==undefined?{report_revision:r.report_revision}:{}) };
  });
  let work: WorkIdentity | undefined;
  if (c.work !== undefined) {
    const w = c.work as Record<string, unknown>;
    if (!w || typeof w !== 'object') throw new Error('work 无效');
    work = { resource: text(w.resource, 'resource'), question_key: text(w.question_key, 'question_key', 200), method_class: text(w.method_class, 'method_class', 200), identity: text(w.identity, 'identity', 200) };
  }
  const allowed = c.allowed_tools === undefined ? undefined : list(c.allowed_tools, 'allowed_tools', 50);
  const contract:IntentContract={ version: 1, objective: text(c.objective ?? summary, 'objective'), acceptance: acceptance.map(x => text(x, 'acceptance')), out_of_scope: list(c.out_of_scope, 'out_of_scope', 20), basis: refs, ...(work ? { work } : {}), ...(allowed ? { allowed_tools: allowed } : {}) };
  if(Buffer.byteLength(JSON.stringify(contract))>12*1024)throw new Error('执行约定超过 12 KiB，请缩短约定并通过 basis 引用详情');
  return contract;
}

/** Work identity intentionally excludes prose, budget, and changing evidence.
 * New evidence must be an explicit retry, not a different deduplication key. */
export function workFingerprint(contract: IntentContract, anchors: number[]): string | undefined {
  if (!contract.work) return undefined;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  let resource = contract.work.resource.trim();
  try { resource = new URL(resource).toString(); } catch { /* opaque resource key */ }
  // Hash routes and case-sensitive identities can denote distinct application work.
  return createHash('sha256').update(JSON.stringify([resource, norm(contract.work.question_key), norm(contract.work.method_class), contract.work.identity.trim(), [...new Set(anchors)].sort((a,b)=>a-b)])).digest('hex');
}

export function validateResult(value: IntentResult, contract: IntentContract): IntentResult {
  if (!['complete','partial','blocked'].includes(value.outcome)) throw new Error('结果 outcome 无效');
  const summary = text(value.summary, 'summary', 4000);
  if (!Array.isArray(value.criteria) || value.criteria.length > 10) throw new Error('criteria 无效');
  const seen = new Set<number>();
  const criteria = value.criteria.map(c => {
    if (!Number.isInteger(c.index) || c.index < 0 || c.index >= contract.acceptance.length || seen.has(c.index)) throw new Error('criteria 索引重复或越界');
    seen.add(c.index);
    if (!['supported','not_supported','unknown'].includes(c.outcome)) throw new Error('criteria outcome 无效');
    if (!Array.isArray(c.fact_ids) || c.fact_ids.length > 20 || c.fact_ids.some(id=>!Number.isSafeInteger(id)||id<=0)) throw new Error('fact_ids 无效');
    if (c.outcome !== 'unknown' && !c.fact_ids.length) throw new Error('已回答的完成条件必须引用事实或漏洞证据');
    return { index:c.index, outcome:c.outcome, fact_ids:[...new Set(c.fact_ids)].sort((a,b)=>a-b) };
  }).sort((a,b)=>a.index-b.index);
  if (value.outcome === 'complete' && (criteria.length !== contract.acceptance.length || criteria.some(c=>c.outcome==='unknown'))) throw new Error('仍有未回答的完成条件，不能 complete');
  const remaining = value.outcome === 'complete' ? '' : text(value.remaining, 'remaining');
  let publish_ids:number[]|undefined;
  if(value.publish_ids!==undefined){
    if(!Array.isArray(value.publish_ids)||value.publish_ids.length>100||value.publish_ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('publish_ids 无效');
    publish_ids=[...new Set(value.publish_ids)].sort((a,b)=>a-b);
    if(criteria.some(c=>c.fact_ids.some(id=>!publish_ids!.includes(id))))throw new Error('验收引用必须包含在最终 publish_ids 中');
  }
  return { outcome:value.outcome, summary, criteria, remaining,...(publish_ids===undefined?{}:{publish_ids}) };
}
