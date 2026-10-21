import type {Database} from '../db/index.js';
import {PLANNER_PROMPT,WORKER_PROMPT,promptHash} from './prompts.js';
import {TOOL_DESCRIPTIONS,effectiveToolDescription,DIRECTION_PREVIOUS_TOOL_DESCRIPTIONS} from './tool-descriptions.js';

/** Exact built-in upgrades only. History, explicit overrides and disabled bindings survive. */
export async function migrateDirectionWriteback(db:Database){
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    if(await tx.platform().getSetting('direction_writeback_v1')==='done')return;
    const defaults=[
      ['planner','4f4f7e8c4964473a81d4b3f0655900434b946d4419996e11fc65d1343bd1aebb',PLANNER_PROMPT],
      ['worker','b10f72c6dbb26adf9abcd5c7c94917a796761ff687d0e7bc24d9e768e6f85bcf',WORKER_PROMPT],
    ];
    for(const [role,hash,template] of defaults){
      const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key=$1 FOR UPDATE OF a`,[role])).rows[0];
      if(!row||promptHash(String(row.template_text))!==hash)continue;
      const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,'方向级派单、结论级写回；保留原文','migration'
        FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,template])).rows[0]!;
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
    }
    const previous:Record<string,string>={};
    const rows=(await tx.query("SELECT key,description FROM tools WHERE system AND kind='builtin' AND key=ANY($1::text[])",[Object.keys(DIRECTION_PREVIOUS_TOOL_DESCRIPTIONS)])).rows;
    for(const r of rows){
      const key=String(r.key);
      const result=effectiveToolDescription(key,TOOL_DESCRIPTIONS[key]!,r.description);
      if(result.source!=='builtin'||result.description===r.description)continue;
      previous[key]=String(r.description);
      await tx.query('UPDATE tools SET description=$2 WHERE key=$1',[r.key,result.description]);
    }
    await tx.platform().setSetting('direction_writeback_previous_descriptions',JSON.stringify(previous));
    await tx.platform().setSetting('direction_writeback_v1','done');
  });
}
