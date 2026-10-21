/** Exact shipped text from ARTEX agent/tools.go:setConstraints. No fuzzy matching:
 * edited descriptions remain user configuration. */
export const ARTEX_CONSTRAINT_DESCRIPTION =
  '给【本任务】新增操作约束,用来框定探索边界:type=allow(允许做的操作)或 deny(禁止做的操作)。\n'+
  '约束=对『可以/不可以做哪些操作』的规定(如『仅测当前端口,不扫其他端口』『禁止对生产库做写操作』『只允许被动侦察』),不是目标、也不是攻击步骤。\n'+
  '★优先批量:多条放进 constraints 数组一次提交,返回 ids 与之等长同序(失败项 id=0,详情见 errors)。单条则省略 constraints 直接给顶层 text/type。\n'+
  '只登记任务目标/描述里【明确写出】的约束,不要臆造;拿不准类型时用 deny(更保守)。';
export const ARTEX_INTENT_DESCRIPTION = "生成【探索方向】写入 frontier，并连入探索链路。意图是开放的探索方向，不是固定类型——用 summary 一句话自由描述要探索/验证/利用什么。\n主 Agent 成功下发后结束本轮，Worker 自动回传总结，不轮询等待。Planner 对未审批候选本轮跳过；主 Agent 可明确下发待审批资产方向，但封禁和撤回仍拒绝。未知候选先批量 check_target_access。★优先批量：一轮筛出的多个新方向放进 intents 数组一次提交（最多 4 条，比逐条调用省往返）。返回 ids 数组，与 intents 等长同序（失败项 id=0，详情见 errors；已存在的活跃同方向见 duplicates）。单条则省略 intents 直接给顶层 summary。";
const previousConstraintDescription = '保存用户明确的操作要求，text/source_quote 必须为任务原文或本轮用户消息中的完整段落，保留例外和原有语气。不能把目标 URL 改写成仅限该地址；allow 不默认排他。';

export function recognizedHistoricalDescription(name:string,stored:unknown):unknown {
  if(name==='add_intent'&&stored===ARTEX_INTENT_DESCRIPTION)return undefined;
  return name==='set_constraints'&&[ARTEX_CONSTRAINT_DESCRIPTION,previousConstraintDescription].includes(stored as string)?undefined:stored;
}

/** These are built-in capability hints, not edits to the user's prompt or text. */
export function roleToolDescription(name:string,resolved:{description:string;source:string},role:string):string {
  if(role==='planner'||resolved.source!=='builtin')return resolved.description;
  if(name==='context_search')return resolved.description.replace(' Planner 可用 source=planner_session 检索本任务历史规划原文；历史不能代替实时图查询。','');
  if(name==='context_get')return resolved.description.replace(' Planner 可读本任务 session: 条目，field=/content 续读历史原文。','');
  return resolved.description;
}

export function roleToolParameters(name:string,parameters:Record<string,unknown>,role:string):Record<string,unknown> {
  if(role==='planner'||!['context_search','context_get'].includes(name))return parameters;
  const result=structuredClone(parameters) as any;
  if(name==='context_search'&&result.properties?.source){
    const source=result.properties.source;
    if(Array.isArray(source.enum))source.enum=source.enum.filter((value:string)=>value!=='planner_session');
    if(typeof source.description==='string')source.description=source.description.replace('；planner_session 召回规划历史','');
  }
  if(name==='context_get'){
    const ref=result.properties?.items?.items?.properties?.ref;
    if(typeof ref?.pattern==='string')ref.pattern=ref.pattern.replace('session:[a-zA-Z0-9_-]+|','');
  }
  return result;
}
