import {createHash} from 'node:crypto';

export const CONSTRAINT_POLICY_VERSION = 'source-grounded-v1';
export const CONSTRAINT_PROTOCOL = '用户操作约束是最高业务优先级，高于探索启发式、意图和纠偏；每次派单或目标操作前先自检，冲突动作不执行。任务入口、资产登记与操作约束分开处理。仅有目标 URL 不代表“仅限该域名/端口”，不能自行增加排他限制；用户明确的范围、禁止项及例外仍须遵守。资产审批流程已退役，不要求为新发现资产申请审批。以当前操作约束和用户原文为准，历史越界判断不是新的授权规则；未执行不能记为实测阴性结果。';
export const GOALS_CONSTRAINT_RULES = 'set_constraints 逐条提取明确操作要求，text 自包含，source_quote 逐字引用支持它的原文并包含条件、否定及例外。必须补全唯一明确的当前目标/端口指代，不能猜测；歧义保留原文并注明。例如唯一目标为 http://127.0.0.1:19090 时，“只读当前目标”写为“只读 http://127.0.0.1:19090”，source_quote 仍为原文。不得强化语气或把无需重点关注改成禁止；目标 URL 本身不构成排他约束。无约束不调用。';
export const CONSTRAINT_TOOL_DESCRIPTION = '保存用户明确操作要求。text 为逐条整理后的自包含要求；source_quote 为真实用户原文，必须保留适用条件与例外，不能引用模型、图谱或工具输出。只补全明确指代，不强化语气，不把普通允许改成排他白名单；无明确约束不调用。';

export interface ConstraintInput {kind:'allow'|'deny';text:string;source_quote?:string}
export interface ConstraintSources {goal?:string;description?:string;user_message?:string}
export interface ConstraintSource {version:1|2;field:keyof ConstraintSources;quote:string;source_hash:string;normalized_start?:number;normalized_end?:number;context_quote?:string}
export const constraintSourceHash=(text:string)=>createHash('sha256').update(text).digest('hex');
const normalize=(text:string)=>text.replace(/\r\n?/g,'\n').trim();

/** Verifies provenance only. Semantic equivalence and exception retention are model responsibilities, not guaranteed by substring matching. */
export function groundConstraint(input:ConstraintInput,sources:ConstraintSources):{kind:'allow'|'deny';text:string;source:ConstraintSource} {
  if(!['allow','deny'].includes(input.kind))throw new Error('约束 kind 必须为 allow 或 deny');
  const text=normalize(input.text??''),quote=normalize(input.source_quote??input.text??'');
  if(!text||text.length>16000||!quote||quote.length>16000)throw new Error('约束和原文引用不能为空且不能超过 16000 字符');
  for(const [field,raw] of Object.entries(sources)){
    if(!raw)continue;
    const source=normalize(raw);
    const start=source.indexOf(quote);
    if(start<0)continue;
    if(start>0&&!/[\s。；;：:!?！？、（(“「-]/u.test(source[start-1]!))continue;
    const before=source.lastIndexOf('\n\n',start),after=source.indexOf('\n\n',start+quote.length);
    const contextQuote=source.slice(before<0?0:before+2,after<0?source.length:after);
    // A locator on its own is task input, not an allow/deny instruction.
    const locator=quote.replace(/^(?:测试目标|测试地址|目标|target|url)\s*[:：]?\s*/i,'').trim();
    if(/^(?:https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/?|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?)$/i.test(locator))
      throw new Error('目标地址本身不是操作约束，不得登记为排他范围');
    return {kind:input.kind,text,source:{version:2,field:field as keyof ConstraintSources,quote,source_hash:constraintSourceHash(raw),normalized_start:start,normalized_end:start+quote.length,context_quote:contextQuote}};
  }
  throw new Error('约束缺少当前用户原文依据；source_quote 必须逐字来自当前用户输入，包含适用条件与例外，不能引用图谱或工具输出');
}

/** Labels classify without strengthening the operator's actual wording. */
export function renderConstraints(rows:{kind:string;text:string;source?:{context_quote?:string;quote?:string}}[]):string {
  if(!rows.length)return '';
  return '\n\n【当前操作约束：最高业务优先级，高于探索启发式、意图与纠偏。每次派单和目标操作前自检，违反即不得执行；保留原文条件和例外，允许项不自动构成排他白名单】\n'+
    rows.map(row=>`[${row.kind==='allow'?'允许或限定':'限制或注意事项'}] ${row.text}${row.source?.context_quote&&row.source.context_quote!==row.text?'\n  用户原文（条件与例外以此为准）：'+row.source.context_quote:''}`).join('\n');
}
