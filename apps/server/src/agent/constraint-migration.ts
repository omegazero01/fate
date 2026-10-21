import type {Database} from '../db/index.js';
import {GOALS_PROMPT,WORKER_PROMPT,promptHash} from './prompts.js';
import {CONSTRAINT_TOOL_DESCRIPTION} from './constraint-policy.js';
import {LEGACY_PROMPT_HASHES,LEGACY_TOOL_DESCRIPTIONS} from './prompt-legacy.js';

// SERIES 78ab23f agent/goals.go, plus the two shipped fate defaults.
export const SERIES_GOALS_HASH = '72a7a0159443b41dde29dfba8a3de6a2c8a15b273935495a7b88561fa708aa68';
const knownGoals=new Set([SERIES_GOALS_HASH,LEGACY_PROMPT_HASHES.goals,'2e7b25b77d5a12248c2bcf4f23a765a7a142bf15645544fd035f55d8add1cbfb']);
export const CONSTRAINT_MIGRATION_KEY='source_grounded_constraints_v1';

/** Exact known defaults only. Candidate versions do not become active custom prompts. */
export async function migrateConstraintPrompts(db:Database) {
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    if(await tx.platform().getSetting(CONSTRAINT_MIGRATION_KEY)==='done')return;
    for(const role of ['goals','worker']){
      const row=(await tx.query(`SELECT a.id,a.current_prompt_id,p.template_text FROM agents a
        LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a`,[role])).rows[0];
      if(!row)continue;
      const text=String(row.template_text??''),candidate=role==='goals'?GOALS_PROMPT:WORKER_PROMPT;
      const upgrade=role==='goals'&&knownGoals.has(promptHash(text));
      const obsolete=role==='goals'&&text!==candidate||role==='worker'&&/待审批|申请授权|自动批准|pending/.test(text);
      if(!text||text===candidate||!obsolete)continue;
      const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,$3,'migration' FROM agent_prompts WHERE agent_id=$1 RETURNING id`,
        [row.id,candidate,upgrade?'修复旧内置 Goals 将目标误作排他约束；保留历史版本':'操作约束来源修订候选（未启用）；保留当前自定义提示词'])).rows[0]!;
      if(upgrade)await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
    }
    await tx.query(`UPDATE tools SET description=$1 WHERE key='set_constraints' AND description=ANY($2::text[])`,
      [CONSTRAINT_TOOL_DESCRIPTION,[LEGACY_TOOL_DESCRIPTIONS.set_constraints,'保存用户明确的允许或禁止约束，写明具体目标。','保存用户明确的允许或禁止约束，写明具体目标；约束不替代资产授权。']]);
    await tx.platform().setSetting(CONSTRAINT_MIGRATION_KEY,'done');
  });
}
