import {recognizedHistoricalDescription} from './tool-description-policy.js';
import {CONSTRAINT_TOOL_DESCRIPTION} from './constraint-policy.js';
import { LEGACY_TOOL_DESCRIPTIONS } from './prompt-legacy.js';
import type {Database} from '../db/index.js';
export const ARTEX_PREVIOUS_TOOL_DESCRIPTIONS:Record<string,string>={"add_intent": "创建探索意图。先检索已有工作；Planner 提供稳定 work 身份、验收条件和依据，只派前置已满足的工作。Main 提交会请求宿主下发；以返回的准入状态为准。", "dispatch_intents": "请求宿主下发已有待执行意图，仅 Main 可用；不能绕过封禁或授权检查。", "record_fact": "执行中边发现边写回新结论，提交成功立即入图。summary 概括，detail 合并同一结论的观察，evidence 保存真实证据；已保存的不重复提交，无新增事实不必写。", "insert_assets": "登记新资产及关系到资产图；登记不等于获准访问。探索结论使用 record_fact。", "report_finding": "提交本次亲自验证且可复现的漏洞与真实证据，成功后立即入图。先 list_findings 查重；疑似问题用 record_fact 记录并注明不确定性。", "record_plan_decision": "每轮规划结束前保存决策、依据和恢复条件。已派单用 dispatched，否则如实等待依赖、请求输入或结束方向；不要为保持运行凑单。", "context_search": "检索授权范围内的意图、事实、漏洞及冷图原文，返回摘要、稳定引用和版本。来源任务只读；按 next_cursor 续读。", "context_get": "按稳定引用和版本分页读取完整节点及关系。版本冲突重新检索；使用返回的游标续读，不自行估算偏移。", "read_tool_output": "按返回引用与游标续读完整工具 JSON；未读取的内容不能当作已确认信息。", "graph_overview": "读取有界态势摘要：目标、待执行和运行中意图、近期结果、覆盖及待办；详情按节点引用读取。", "node_detail": "读取指定授权节点的详情、来源和关联；按返回游标续读。", "search_worker_traces": "按需检索 Worker 的历史执行过程；优先查事实与结果，定位阻塞时再读轨迹。", "get_worker_trace": "读取指定意图的进度与执行轨迹；需要原始过程时启用 include_output，按返回游标续读。", "prove_goal": "用仍获授权的 confirmed 事实或漏洞证明目标；任务原文、线索及撤回记录不能作证。证据须支持该目标，量化条件核对实测值。", "kill_work": "终止指定运行意图；先确认当前进度和原因，以返回状态确认结果。", "steer_work": "已停用 Agent 间消息；用户调整须通过黑板目标、约束或意图控制记录。", "todo_write": "保存跨轮依赖待办；有依赖的步骤仅在前置满足后下发。", "set_goals": "保存任务的最终可验收目标，不把探索步骤当作目标；遵循用户明确要求。", "set_constraints": "保存用户明确的允许或禁止约束，写明具体目标；约束不替代资产授权。", "register_user_target": "登记用户明确授权的目标边界；不得从发现结果推断授权。", "update_finding_report": "以读取的 evidence_version 保存报告；版本冲突先重读证据，成功返回才算保存。", "get_finding": "读取漏洞、证据版本和证据引用，按 next_offset 续读完整内容。", "get_finding_retest_context": "分页读取本次漏洞复测的固定快照、证据和范围，仅限当前漏洞。", "record_finding_retest_result": "保存复测结论及证据：实际复现才 reproduced，证据充分才 fixed，否则 inconclusive；宿主负责更新原漏洞状态。", "record_conversation_fact": "向当前绑定任务保存有来源的新事实及真实证据，未绑定任务不能写入。", "report_conversation_finding": "向当前绑定任务提交已复现漏洞及证据，先查重；疑似问题记录为事实。"};

const PLANNER_RECALL_PREVIOUS:Record<string,string> = {"context_search": "按新到旧检索节点及冷图原文，默认 fact/finding/intent；types 显式包含 activity 才查询 Worker 活动。q 是字面短语，不是语义搜索。按 asset_id 核对历史方向，has_more 时用 next_cursor 续页；命中的 read 可直接交给 context_get。来源任务只读。", "context_get": "按 items 读取引用；summary 索引、detail 详情、output 结果，field 选择字段。续读优先将返回的 next_item 原样放入 items；缺省 offset 会重读首页。正文只需 offset=next_offset；仅 parents/members 还需 cursor=page_cursor，读完本页再按 next_cursor 翻页。沿用 version，冲突重新检索。"};

export const DIRECTION_PREVIOUS_TOOL_DESCRIPTIONS:Record<string,string> = {"add_intent": "创建探索意图。先检索已有工作；提供 summary、asset_ids、parent_ids、priority；执行约定可选，宿主记录引用版本，只派前置已满足的工作。Main 提交会请求宿主下发；以返回的准入状态为准。", "record_fact": "执行中边发现边写回新结论，提交成功立即入图。summary 概括，detail 合并同一结论的观察，evidence 保存真实证据；已保存的不重复提交，无新增事实不必写。", "report_finding": "提交本次亲自验证且可复现的漏洞与真实证据，成功后立即入图。先 context_search 按 finding 类型 查重；疑似问题用 record_fact 记录并注明不确定性。", "asset_search": "检索本任务及直接来源资产摘要。普通检索提供 DSL，untested=true 查范围内未测资产。用 next_offset 续页，详情使用 asset_get。"};

/** Only behavioral hints belong here; parameter shapes and limits live in the schema. */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  add_intent: '按有价值的方向派单：summary 简述目的，asset_ids 给入口范围，parent_ids 引用依据；Worker 自选步骤，contract 仅按需补边界。不按接口或参数拆单；局部重叠见 dedup.related_intent_ids，派前核对已有方向。Main 以宿主下发回执为准。',
  dispatch_intents: '请求宿主下发已有待执行意图，仅 Main 可用；执行前检查任务状态和意图归属。',
  record_fact: '边发现边按结论写回，成功立即入图；同一结论的相关观察合并，不按请求拆节点。asset_ids 明确实际涉及资产，缺省不继承意图范围；scope 简述实际验证、未测和限制，observation_type 区分实测、推断、负面或未知。缺项仍保存但不计覆盖，evidence 保留真实证据。',
  asset_search: '检索本任务及直接来源资产摘要。普通检索提供 DSL，untested=true 查无明确范围测试记录的资产，不代表从未测试；legacy_tested 提示历史范围待核实。用 next_offset 续页，详情用 asset_get。',
  asset_get: '按 ids 和字段组读取资产；identity/fingerprint 默认返回，dns/params/auth/extra 按需选择。field 使用 JSON Pointer；next 参数原样续读 Unicode 正文。',
  insert_assets: '边发现边用 assets 数组登记资产。按 Schema 填写各类型字段：record_value 必须为数组，endpoint 使用 url/method/params，HTTP service 使用 url 和指纹，app 使用 app_name。results/errors 逐项返回，成功即入图，探索结论用 record_fact。',
  report_finding: '提交亲自验证且可复现的漏洞和真实证据，成功立即入图。asset_ids 只列实际受影响资产，缺省不继承意图范围；scope 说明已验证范围和限制。先 context_search 按 finding 查重；疑似结论用 record_fact。',
  context_search: '按新到旧检索节点及冷图原文，默认 fact/finding/intent；types 显式包含 activity 才查询 Worker 活动。q 是字面短语，不是语义搜索。按 asset_id 核对历史方向，has_more 时用 next_cursor 续页；命中的 read 可直接交给 context_get。来源任务只读。 Planner 可用 source=planner_session 检索本任务历史规划原文；历史不能代替实时图查询。',
  context_get: '按 items 读取引用；summary 索引、detail 详情、output 结果，field 选择字段。续读优先将返回的 next_item 原样放入 items；缺省 offset 会重读首页。正文只需 offset=next_offset；仅 parents/members 还需 cursor=page_cursor，读完本页再按 next_cursor 翻页。沿用 version，冲突重新检索。 Planner 可读本任务 session: 条目，field=/content 续读历史原文。',
  read_tool_output: '按返回引用与游标续读完整工具 JSON；未读取的内容不能当作已确认信息。',
  graph_overview: '默认只读目标与授权计数；view=recent 获取近期态势摘要。用 context_search 按类型、状态、资产、意图检索，再用 context_get 读取所需字段，避免展开整图。',
  node_detail: '读取指定授权节点的详情、来源和关联；按返回游标续读。',
  search_worker_traces: '按需检索 Worker 的历史执行过程；优先查事实与结果，定位阻塞时再读轨迹。',
  get_worker_trace: '读取指定意图的进度与执行轨迹；需要原始过程时启用 include_output，按返回游标续读。',
  prove_goal: '用仍获授权的 confirmed 事实或漏洞证明目标；任务原文、线索及撤回记录不能作证。证据须支持该目标，量化条件核对实测值。',
  kill_work: '终止指定运行意图；先确认当前进度和原因，以返回状态确认结果。',
  steer_work: '给所属运行中 Worker 追加纠偏，PI 在工具回合边界交付；不扩大授权。',
  todo_write: '保存跨轮依赖待办；有依赖的步骤仅在前置满足后下发。',
  set_goals: '仅保存目标栏要求的最终结果，不从描述扩写、不把探索步骤当作目标。新任务 Goals 阶段须逐字提供 source_quote；Main 追加保持原有接口。成功返回即已保存。',
  set_constraints: CONSTRAINT_TOOL_DESCRIPTION,
  register_user_target: '登记用户明确授权的目标边界；不得从发现结果推断授权。',
  update_finding_report: '以读取的 evidence_version 保存报告；版本冲突先重读证据，成功返回才算保存。',
  get_finding: '读取漏洞、证据版本和证据引用，按 next_offset 续读完整内容。',
  get_finding_retest_context: '分页读取本次漏洞复测的固定快照、证据和范围，仅限当前漏洞。',
  record_finding_retest_result: '保存复测结论及证据：实际复现才 reproduced，证据充分才 fixed，否则 inconclusive；宿主负责更新原漏洞状态。',
  record_conversation_fact: '向当前绑定任务保存有来源的新事实及真实证据，未绑定任务不能写入。',
  report_conversation_finding: '向当前绑定任务提交已复现漏洞及证据，先查重；疑似问题记录为事实。',
};
export function effectiveToolDescription(name: string, code: string, stored?: unknown): { description: string; source: string } {
  stored=recognizedHistoricalDescription(name,stored);
  if(name==='set_constraints'&&stored==='保存用户明确的允许或禁止约束，写明具体目标。')return {description:CONSTRAINT_TOOL_DESCRIPTION,source:'builtin'};
  const priorPagedDefault = '按 items 批量读取引用。summary 只读索引，detail 读详情，output 读结果；field 选 JSON Pointer 字段。parents/members 每页最多 20 条；有 next_offset 时用 page_cursor 和 offset 读完本页，再用 next_cursor 翻页并重置 offset。沿用 version，冲突重新检索。';
  const priorDefaults:Record<string,string>={
    context_search:'检索授权节点及冷图原文；types 显式包含 activity 才查询 Worker 活动。返回摘要、稳定引用和快照游标；来源任务只读，按 next_cursor 续读。',
    context_get:'批量读取 items 中的 node:/activity: 引用。detail 读详情，output 读执行结果，parents 读上游，members 读摘要成员；field 选 JSON Pointer 字段，按返回的 Unicode next_offset 续读。版本冲突重新检索。',
    graph_overview:'读取有界态势摘要：目标、待执行和运行中意图、近期结果、覆盖及待办；详情按节点引用读取。',
    record_fact:'及时写回本意图的新事实或负面观察：summary 简述结论，evidence 保存真实证据，confidence 区分直接观察与推断。',
    report_finding:'提交本次已验证且可复现的漏洞和证据，写入探索图并连接资产。先 context_search 按 finding 类型 查重；疑似问题用事实记录。',
    steer_work:'给指定运行意图追加纠偏要求，在后续动作边界生效；不改变授权范围。',
  };
  const blackboardDefaults:Record<string,string>={record_fact:'Worker 暂存本意图的新事实或负面观察，最终 complete_intent 集中发布：summary 简述结论，evidence 保存真实证据，confidence 区分直接观察与推断。',report_finding:'提交本次已验证且可复现的漏洞和证据，Worker 先暂存，complete_intent 集中发布到探索图并连接资产。先 context_search 按 finding 类型 查重；疑似问题用事实记录。',checkpoint_intent:'阶段变化、连续操作或阻塞时保存当前意图进度、已尝试方法和下一步；进度不等于事实或完成。',complete_intent:'结束当前意图前保存逐项验收结果。criteria.index 从零开始，事实引用必须属于本意图；完整回答并有证据才 complete，否则 partial/blocked 并写 remaining。成功后停止操作。'};
  const retiredApprovalDefaults:Record<string,string>={"dispatch_intents": "请求宿主下发已有待执行意图，仅 Main 可用；不能绕过封禁或授权检查。", "insert_assets": "登记新资产及关系到资产图；登记不等于获准访问。探索结论使用 record_fact。", "set_constraints": "保存用户明确的允许或禁止约束，写明具体目标；约束不替代资产授权。"};
  const previous = stored===DIRECTION_PREVIOUS_TOOL_DESCRIPTIONS[name] || stored===PLANNER_RECALL_PREVIOUS[name] || name==='asset_search' && stored==='检索任务资产摘要，按 DSL 或未测条件分页' || name==='asset_get' && stored==='按资产 ID 和字段组读取详情' || name==='insert_assets' && stored==='登记新资产及关系到资产图，登记后可直接继续探索。探索结论使用 record_fact。' || stored===retiredApprovalDefaults[name] || name==='context_get' && stored===priorPagedDefault || stored===ARTEX_PREVIOUS_TOOL_DESCRIPTIONS[name] || stored===DIRECT_WRITE_PREVIOUS[name] || stored===priorDefaults[name] || stored===blackboardDefaults[name] || name === 'prove_goal' && stored === '用仍获授权的事实或漏洞证明目标；证据必须支持该目标，量化条件须核对实测值。';
  if (typeof stored === 'string' && stored.trim() && stored !== LEGACY_TOOL_DESCRIPTIONS[name] && stored !== TOOL_DESCRIPTIONS[name] && !previous)
    return { description: stored, source: 'custom' };
  return { description: TOOL_DESCRIPTIONS[name] ?? code, source: 'builtin' };
}

const DIRECT_WRITE_PREVIOUS:Record<string,string> = {"record_fact": "结束前汇总本意图最新结论：summary 简述，detail 写细节，evidence 保留真实证据。Worker 先存私有稿，replace_node_id 可修订；complete_intent 最终选定后才发布，暂存不唤醒 Planner。", "report_finding": "保存本次已验证且可复现的漏洞证据。Worker 先存私有稿，replace_node_id 可更新；结束时经 complete_intent 选定发布，运行中不唤醒 Planner。先 context_search 按 finding 类型 查重，疑似问题用事实记录。"};

export async function migrateDirectWorkerToolDescriptions(db:Database) {
  const rows=(await db.query("SELECT key,description FROM tools WHERE system AND kind='builtin' AND key=ANY($1::text[])",[['record_fact','report_finding']])).rows;
  const previous:Record<string,string>={};
  for(const row of rows){
    const key=String(row.key),resolved=effectiveToolDescription(key,TOOL_DESCRIPTIONS[key]!,row.description);
    if(resolved.source==='builtin'&&row.description!==resolved.description){
      previous[key]=String(row.description);
      await db.query('UPDATE tools SET description=$2 WHERE key=$1',[key,resolved.description]);
    }
  }
  await db.platform().setSetting('pi_worker_direct_tool_descriptions_previous',JSON.stringify(previous));
}

/** Replace recognized built-in descriptions only; keep custom text and disabled bindings. */
export async function migrateRetiredApprovalToolDescriptions(db: Database) {
  const rows = (await db.query("SELECT key,description FROM tools WHERE system AND kind='builtin' AND key=ANY($1::text[])",
    [['dispatch_intents', 'insert_assets', 'set_constraints']])).rows;
  const previous: Record<string, string> = {};
  for (const row of rows) {
    const key = String(row.key), resolved = effectiveToolDescription(key, TOOL_DESCRIPTIONS[key]!, row.description);
    if (resolved.source !== 'builtin' || row.description === resolved.description) continue;
    previous[key] = String(row.description);
    await db.query('UPDATE tools SET description=$2 WHERE key=$1', [key, resolved.description]);
  }
  await db.platform().setSetting('pi_no_approvals_tool_descriptions_previous', JSON.stringify(previous));
}
