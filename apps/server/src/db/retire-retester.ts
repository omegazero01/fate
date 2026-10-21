import type {Database} from './index.js';

/** Stop old executors before removing their quota accounting. No historical evidence is deleted. */
export async function retireRetester(db: Database): Promise<void> {
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO settings(key,value) VALUES('retester_retired_v1_backup',
      jsonb_build_object(
        'agents',(SELECT jsonb_agg(to_jsonb(a)) FROM agents a WHERE key='retester'),
        'tools',(SELECT jsonb_agg(to_jsonb(t)) FROM tools t WHERE agents ? 'retester'),
        'triggers',(SELECT jsonb_agg(to_jsonb(t)) FROM agent_triggers t WHERE agent_key='retester')
      )::text) ON CONFLICT(key) DO NOTHING`);
    await tx.query("UPDATE agents SET enabled=false WHERE key='retester' AND enabled");
    await tx.query("UPDATE agent_triggers SET enabled=false WHERE agent_key='retester' AND enabled");
    await tx.query("UPDATE tools SET agents=agents-'retester' WHERE agents ? 'retester'");
    await tx.query("UPDATE tools SET enabled=false WHERE key IN ('get_finding_retest_context','record_finding_retest_result') AND kind='builtin'");
    await tx.query("UPDATE finding_retests SET stop_requested=true WHERE status IN ('pending','running')");
    await tx.query(`UPDATE runtime_session_leases SET stop_requested=true
      WHERE key IN (SELECT 'conversation:'||id FROM conversations WHERE agent_key='retester')`);
  });
  // An older binary will see stop_requested in its lease watchdog. Never pretend it has exited.
  const active = await db.query(`SELECT 1 FROM finding_retests WHERE status='running' AND lease_until>clock_timestamp()
    UNION ALL SELECT 1 FROM runtime_session_leases l JOIN conversations c ON l.key='conversation:'||c.id
      WHERE c.agent_key='retester' AND l.expires_at>clock_timestamp() LIMIT 1`);
  if (active.rowCount) throw new Error('等待旧 Retester 执行器确认停止或租约过期后再启动服务；已提交停止请求。');
  await db.transaction(async tx => {
    await tx.query(`UPDATE finding_retests SET status='stopped',error=concat_ws(E'\\n',NULLIF(error,''),'Retester 功能已移除'),
      finished_at=now(),lease_until=NULL WHERE status IN ('pending','running')`);
    await tx.query(`UPDATE conversation_runs SET status='stopped',error='Retester 功能已移除',finished_at=now()
      WHERE status IN ('queued','running') AND conversation_id IN (SELECT id FROM conversations WHERE agent_key='retester')`);
  });
}
