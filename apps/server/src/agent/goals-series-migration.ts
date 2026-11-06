import type {Database} from '../db/index.js';
import {GOALS_PROMPT} from './prompts.js';
import {CONSTRAINT_TOOL_DESCRIPTION} from './constraint-policy.js';
export const SERIES_GOALS_MIGRATION='goals_series_single_session_v1';
export const PREVIOUS_ISOLATED_PROMPT="你是 Goals，按宿主指定阶段执行，不规划执行步骤。\n阶段一：从目标与描述原文提取明确操作约束并登记测试资产；描述其余内容仅作 Planner 背景，不生成目标。set_constraints 仅摘录用户明确的操作要求，text/source_quote 使用完整原文段落，保留列表、限定词和例外，不改写、不加强、不把“无需重点关注”改成“禁止”。每项只引用一个完整段落，不拼接；空行分段，单换行仍属同段，保留真实换行（非字面量 \\n）。无空行则引用整个字段，不带宿主添加的【任务描述】等标题。目标地址本身不是操作约束；没有明确要求就不调用。当前目标等指代保留原文，结合本任务目标理解。\n阶段二：仅拆解本轮目标栏原文，用 set_goals 保存。一个最终结果保持一个目标；仅明确的多个独立结果才拆分。不得增加漏洞数量、严重性、交付物或探索步骤；source_quote 逐字引用目标栏。保存成功即结束。\n每阶段只能调用宿主提供的工具，阶段之间不共享对话。";
export const PREVIOUS_CONSTRAINT_DESCRIPTION="保存用户明确的操作要求，text/source_quote 必须为任务原文或本轮用户消息中的完整段落，保留例外和原有语气。每项只引用一个完整段落，不拼接；空行分段，单换行仍属同段，保留真实换行（非字面量 \\n）。无空行则引用整个字段，不带宿主添加的【任务描述】等标题。不能把目标 URL 改写成仅限该地址；allow 不默认排他。";
export async function migrateSeriesGoals(db:Database){
 await db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
  if(await tx.platform().getSetting(SERIES_GOALS_MIGRATION)==='done')return;
  const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='goals' FOR UPDATE OF a`)).rows[0];
  if(row?.template_text&&row.template_text!==GOALS_PROMPT){
   const activate=row.template_text===PREVIOUS_ISOLATED_PROMPT;
   const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by) SELECT $1,COALESCE(max(version),0)+1,$2,$3,'migration' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,GOALS_PROMPT,activate?'SERIES 单会话目标与约束；升级准确匹配内置版本':'SERIES 单会话修订候选（未启用）；保留自定义提示词'])).rows[0];
   if(activate)await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved!.id]);
  }
  await tx.query("UPDATE tools SET description=$1 WHERE key='set_constraints' AND description=$2",[CONSTRAINT_TOOL_DESCRIPTION,PREVIOUS_CONSTRAINT_DESCRIPTION]);
  await tx.platform().setSetting(SERIES_GOALS_MIGRATION,'done');
 });
}
