import type {Database} from '../db/index.js';
import {GOALS_CONSTRAINT_RULES} from './constraint-policy.js';
import {GOALS_PROMPT} from './prompts.js';
export const GOALS_MIGRATION_KEY='goals_field_isolation_v1';
const ending='明确目标用 register_user_target 登记。一个最终结果保持一个目标，独立交付物分别列出；探索步骤不冒充目标。';
const oldRules='set_constraints 仅摘录用户明确的操作要求，text/source_quote 使用完整原文段落，保留列表、限定词和例外，不改写、不加强、不把“无需重点关注”改成“禁止”。目标地址本身不是操作约束；没有明确要求就不调用。当前目标等指代保留原文，结合本任务目标理解。';
export const PREVIOUS_GOALS_DEFAULTS=[
 `你是 Goals，从任务目标与用户描述提取最终可交付、可核验的结果，不规划执行步骤，不扩展用户意图。\n${GOALS_CONSTRAINT_RULES}\n${ending}`,
 `你是 Goals，从任务目标提取最终可交付、可核验的结果，不规划执行步骤，不扩展用户意图。\n${oldRules}\n${ending}`,
];
/** Only exact shipped text is activated. Custom text receives an inactive candidate. */
export async function migrateIsolatedGoalsPrompt(db:Database){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
  if(await tx.platform().getSetting(GOALS_MIGRATION_KEY)==='done')return;
  const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='goals' FOR UPDATE OF a`)).rows[0];
  if(row?.template_text&&row.template_text!==GOALS_PROMPT){
   const activate=PREVIOUS_GOALS_DEFAULTS.includes(String(row.template_text));
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
    SELECT $1,COALESCE(max(version),0)+1,$2,$3,'migration' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,
    [row.id,GOALS_PROMPT,activate?'目标栏分阶段隔离；仅升级精确匹配内置模板':'目标栏分阶段隔离候选（未启用）；保留自定义提示词'])).rows[0]!;
   if(activate)await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
  }
  await tx.query("UPDATE tools SET description=$1 WHERE key='set_goals' AND description=$2",['仅保存目标栏要求的最终结果，不从描述扩写、不把探索步骤当作目标。新任务 Goals 阶段须逐字提供 source_quote；Main 追加保持原有接口。成功返回即已保存。','保存任务的最终可验收目标，不把探索步骤当作目标；遵循用户明确要求。']);
  await tx.platform().setSetting(GOALS_MIGRATION_KEY,'done');
 });
}
