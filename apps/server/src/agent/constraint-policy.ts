import {createHash} from 'node:crypto';

export const CONSTRAINT_POLICY_VERSION = 'source-grounded-v1';
export const CONSTRAINT_PROTOCOL = '任务入口、资产登记与操作约束分开处理。仅有目标 URL 不代表“仅限该域名/端口”，不能自行增加排他限制；用户明确的范围、禁止项及例外仍须遵守。资产审批流程已退役，不要求为新发现资产申请审批。以当前操作约束和用户原文为准，历史越界判断不是新的授权规则；未执行不能记为实测阴性结果。';
const PARAGRAPH_RULE = '段落以空行分隔，单换行仍属同段；原文字段没有空行时须引用整个字段，不带宿主添加的【任务描述】等标题。';
export const GOALS_CONSTRAINT_RULES = 'set_constraints 仅摘录用户明确的操作要求，text/source_quote 使用完整原文段落，保留列表、限定词和例外，不改写、不加强、不把“无需重点关注”改成“禁止”。'+PARAGRAPH_RULE+'目标地址本身不是操作约束；没有明确要求就不调用。当前目标等指代保留原文，结合本任务目标理解。';
export const CONSTRAINT_TOOL_DESCRIPTION = '保存用户明确的操作要求，text/source_quote 必须为任务原文或本轮用户消息中的完整段落，保留例外和原有语气。'+PARAGRAPH_RULE+'不能把目标 URL 改写成仅限该地址；allow 不默认排他。';

export interface ConstraintInput {kind:'allow'|'deny';text:string;source_quote?:string}
export interface ConstraintSources {goal?:string;description?:string;user_message?:string}
export interface ConstraintSource {version:1;field:keyof ConstraintSources;quote:string;source_hash:string}
export const constraintSourceHash=(text:string)=>createHash('sha256').update(text).digest('hex');
const normalize=(text:string)=>text.replace(/\r\n?/g,'\n').trim();

/** Grounding, not a semantic authorization classifier: save the operator's words,
 * never a model-authored policy. Whole paragraphs retain negation and exceptions. */
export function groundConstraint(input:ConstraintInput,sources:ConstraintSources):{kind:'allow'|'deny';text:string;source:ConstraintSource} {
  if(!['allow','deny'].includes(input.kind))throw new Error('约束 kind 必须为 allow 或 deny');
  const text=normalize(input.text??''),quote=normalize(input.source_quote??input.text??'');
  if(!text||text.length>16000||text!==quote)throw new Error('约束必须逐字摘录原文，text 与 source_quote 一致；不能改写、增加“仅限”或省略例外');
  for(const [field,raw] of Object.entries(sources)){
    if(!raw)continue;
    const source=normalize(raw);
    if(!source.split(/\n[ \t]*\n+/).some(p=>p.trim()===quote))continue;
    // A locator on its own is task input, not an allow/deny instruction.
    const locator=quote.replace(/^(?:测试目标|测试地址|目标|target|url)\s*[:：]?\s*/i,'').trim();
    if(/^(?:https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/?|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?)$/i.test(locator))
      throw new Error('目标地址本身不是操作约束，不得登记为排他范围');
    return {kind:input.kind,text:quote,source:{version:1,field:field as keyof ConstraintSources,quote,source_hash:constraintSourceHash(raw)}};
  }
  throw new Error('约束缺少当前用户原文依据；请引用完整段落并保留列表、否定词和例外。'+PARAGRAPH_RULE+'不能引用图谱、工具输出或旧会话推断');
}

/** Labels classify without strengthening the operator's actual wording. */
export function renderConstraints(rows:{kind:string;text:string}[]):string {
  if(!rows.length)return '';
  return '\n\n【当前操作约束；按原文执行，允许项不自动构成排他白名单】\n'+
    rows.map(row=>`[${row.kind==='allow'?'允许或限定':'限制或注意事项'}] ${row.text}`).join('\n');
}
