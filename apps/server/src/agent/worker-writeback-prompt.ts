import {createHash} from 'node:crypto';
import type {Database} from '../db/index.js';

export const WORKER_WRITEBACK_GUIDANCE = 'summary 用一句通俗结论；细节与测试影响放 detail/evidence。结尾简述结论、线索或未完成原因及影响；不重复平台表格，不额外调用工具。';

/** Exact built-in texts only; custom prompts and explicitly selected rollbacks survive. */
export async function migrateWorkerWritebackPrompt(db:Database,template:string,previousHashes:readonly string[]){
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(4200000018)');
    if(await tx.platform().getSetting('worker_writeback_summary_v1')==='done')return;
    const row=(await tx.query(`SELECT a.id,p.template_text FROM agents a
      LEFT JOIN agent_prompts p ON p.id=a.current_prompt_id WHERE a.key='worker' FOR UPDATE OF a`)).rows[0];
    if(typeof row?.template_text==='string'&&previousHashes.includes(createHash('sha256').update(row.template_text).digest('hex'))){
      const saved=(await tx.query(`INSERT INTO agent_prompts(agent_id,version,template_text,note,updated_by)
        SELECT $1,COALESCE(max(version),0)+1,$2,'写回表格配套精简说明；保留旧版本','migration'
        FROM agent_prompts WHERE agent_id=$1 RETURNING id`,[row.id,template])).rows[0]!;
      await tx.query('UPDATE agents SET current_prompt_id=$2 WHERE id=$1',[row.id,saved.id]);
    }
    await tx.platform().setSetting('worker_writeback_summary_v1','done');
  });
}
