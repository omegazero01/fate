import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';

const RETIRED_DEFAULTS = ['63aefe055401b04e0ec2725feb0608be8c5a3f63c71365e5478722de837135e6', '698c583c1ff4179c9f3fd2f9f20204f4495d1c6259f7950b963ee18e0da1b266', 'c4d8523406ec9e738bad76c0ea4776b44745ceb147a940aa9782559146813de5'];

/** Exact built-in texts only; custom prompts and explicitly selected rollbacks survive. */
export async function retireWorkerTablePrompt(db:Database,template:string){
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    if(await tx.platform().getSetting('worker_plain_result_v1')==='done')return;
    const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a
      LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='worker' FOR UPDATE OF a`)).rows[0];
    if(typeof row?.template_text==='string'&&RETIRED_DEFAULTS.includes(createHash('sha256').update(row.template_text).digest('hex'))){
      const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,'移除写回表格约定，恢复文字总结；保留旧版本','migration'
        FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,template])).rows[0]!;
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
    }
    await tx.platform().setSetting('worker_plain_result_v1','done');
  });
}
