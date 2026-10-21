import type { Database } from '../db/index.js';

type TriggerRow = Record<string, unknown> & {
  id: string | number;
  agent_key: string;
  enabled: boolean;
  interval_sec: number;
  last_fire: Date | string | null;
  trigger_run_mode: string;
  trigger_merge_mode: string;
  trigger_max_parallel: number;
};
type PendingEvent = { id: number; key: string; kind: string; task_id: number | null; payload: Record<string, unknown> };
const LOCK = 4_200_000_004;
const PAGE = 500;

/** Durable host-side trigger scheduler. It persists source events and queued runs;
 * pi owns each resulting conversation's model and tool loop. */
export class TriggerScheduler {
  private busy = false;
  constructor(private db: Database) {}

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
        const initialized = await tx.query("SELECT value FROM scheduler_state WHERE key='pi_trigger_scheduler_v1'");
        if (!initialized.rowCount) {
          await this.initialize(tx);
          await tx.query("INSERT INTO scheduler_state(key,value) VALUES('pi_trigger_scheduler_v1','ready') ON CONFLICT(key) DO NOTHING");
          return;
        }
        if(!(await tx.query("SELECT 1 FROM scheduler_state WHERE key='pi_trigger_seen_v2'")).rowCount){
          for(const [kind,key,table,condition] of [['finding','pi_trigger_last_finding','exploration_nodes',"kind='finding'"],['task','pi_trigger_last_task','tasks','true'],['tool','pi_trigger_last_tool','activity',"kind='tool_result'"]]){
            await tx.query(`INSERT INTO scheduler_seen_sources(kind,source_id) SELECT $1,id FROM ${table} WHERE ${condition} AND id<=$2 ON CONFLICT DO NOTHING`,[kind,Number(await this.state(tx,key!))||0]);
          }
          await this.saveState(tx,'pi_trigger_seen_v2','ready');
        }
        const triggers = (await tx.query(`SELECT t.*,a.enabled AS agent_enabled,a.builtin,a.trigger_run_mode,a.trigger_merge_mode,a.trigger_max_parallel
          FROM agent_triggers t JOIN agents a ON a.key=t.agent_key WHERE t.agent_key<>'retester' AND t.enabled AND a.enabled AND NOT a.builtin ORDER BY t.id`)).rows as TriggerRow[];
        await this.collectFindings(tx, triggers);
        await this.collectGoals(tx, triggers);
        await this.collectTimeouts(tx, triggers);
        await this.collectTaskCreates(tx, triggers);
        await this.collectToolCalls(tx, triggers);
        await this.collectIntervals(tx, triggers);
        await this.enqueuePending(tx, triggers);
      });
    } finally { this.busy = false; }
  }

  private async initialize(tx: Database) {
    const [finding, task, tool, goals, timeouts] = [
      await tx.query("SELECT COALESCE(max(id),0) n FROM exploration_nodes WHERE kind='finding'"),
      await tx.query('SELECT COALESCE(max(id),0) n FROM tasks'),
      await tx.query("SELECT COALESCE(max(id),0) n FROM activity WHERE kind='tool_result'"),
      await tx.query("SELECT COALESCE(json_agg(id),'[]'::json) ids FROM exploration_nodes WHERE kind='goal' AND state='met'"),
      await tx.query("SELECT COALESCE(json_agg(id),'[]'::json) ids FROM tasks WHERE status='timeout' AND deleted_at IS NULL"),
    ];
    for (const [key, value] of [
      ['pi_trigger_last_finding', String(finding.rows[0]?.n ?? 0)],
      ['pi_trigger_last_task', String(task.rows[0]?.n ?? 0)],
      ['pi_trigger_last_tool', String(tool.rows[0]?.n ?? 0)],
      ['pi_trigger_fired_goals', JSON.stringify((goals.rows[0]?.ids as unknown[]) ?? [])],
      ['pi_trigger_fired_timeouts', JSON.stringify((timeouts.rows[0]?.ids as unknown[]) ?? [])],
    ]) await tx.query('INSERT INTO scheduler_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', [key, value]);
    await tx.query("INSERT INTO scheduler_seen_sources(kind,source_id) SELECT 'finding',n.id FROM exploration_nodes n JOIN findings f ON f.node_id=n.id ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO scheduler_seen_sources(kind,source_id) SELECT 'task',id FROM tasks ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO scheduler_seen_sources(kind,source_id) SELECT 'tool',id FROM activity WHERE kind='tool_result' ON CONFLICT DO NOTHING");
    await this.saveState(tx,'pi_trigger_seen_v2','ready');
    await tx.query('UPDATE agent_triggers SET last_fire=now() WHERE enabled AND interval_sec>0 AND last_fire IS NULL');
  }

  private async state(tx: Database, key: string) { return String((await tx.query('SELECT value FROM scheduler_state WHERE key=$1', [key])).rows[0]?.value ?? '0'); }
  private async saveState(tx: Database, key: string, value: string) { await tx.query('INSERT INTO scheduler_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]); }
  private async fire(tx: Database, triggers: TriggerRow[], field: string, key: string, kind: string, taskID: number | null, payload: Record<string, unknown>, messageField: string) {
    const matching = triggers.filter(t => field === 'interval' ? Number(t.interval_sec) > 0 : t[field] === true);
    if (!matching.length) return;
    const event = await tx.query(`INSERT INTO agent_trigger_events(event_key,kind,task_id,payload) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(event_key) DO UPDATE SET event_key=EXCLUDED.event_key RETURNING id`, [key, kind, taskID, JSON.stringify(payload)]);
    for (const trigger of matching) {
      const custom = String(trigger[messageField] ?? '').trim();
      const text = JSON.stringify({source:'blackboard',kind,task_id:taskID,event_key:key,...Object.fromEntries(Object.entries(payload).filter(([key])=>key.endsWith('_id')||key.endsWith('_version')))}); // Resolve current domain records; never forward another Agent's prose.
      await tx.query('INSERT INTO agent_trigger_deliveries(trigger_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [trigger.id, event.rows[0]!.id]);
      if (text) await tx.query(`UPDATE agent_trigger_events SET payload=payload||jsonb_build_object('message_'||$1::text,$2::text) WHERE id=$3`, [trigger.id, text, event.rows[0]!.id]);
    }
  }

  private async collectFindings(tx: Database, triggers: TriggerRow[]) {
    const last = Number(await this.state(tx, 'pi_trigger_last_finding')) || 0;
    const rows = await tx.query(`SELECT n.id,f.id finding_id,f.summary,t.id task_id,t.description,t.goal,n.payload FROM exploration_nodes n
      JOIN tasks t ON t.exploration_id=n.exploration_id
      JOIN findings f ON f.node_id=n.id AND f.task_id=t.id
      WHERE n.kind='finding' AND n.payload->>'acceptance_status' IS DISTINCT FROM 'unverified' AND NOT EXISTS(SELECT 1 FROM scheduler_seen_sources ss WHERE ss.kind='finding' AND ss.source_id=n.id) AND t.deleted_at IS NULL ORDER BY n.id LIMIT $1`, [PAGE]);
    let max = last;
    for (const r of rows.rows) {
      const id=Number(r.id);max=Math.max(max,id);const p=(r.payload??{}) as Record<string,unknown>;
      await this.fire(tx,triggers,'on_finding',`finding:${id}`,'finding',Number(r.task_id),{finding_id:Number(r.finding_id),finding_node_id:id,summary:r.summary??p.summary??'',vulnclass:p.vulnclass??'',severity:p.severity??'',description:r.description,goal:r.goal,
        context:`【本次由已提交的 finding 触发】\n任务 #${r.task_id}：${r.description}\n目标：${r.goal}\n漏洞记录 finding_id=${r.finding_id}；图节点 finding_node_id=${id}。使用 finding_id 读取证据并更新报告。\n发现：${p.vulnclass??''}/${p.severity??''} ${r.summary??p.summary??''}`},'finding_message');
    }
    for(const r of rows.rows)await tx.query("INSERT INTO scheduler_seen_sources(kind,source_id) VALUES('finding',$1) ON CONFLICT DO NOTHING",[r.id]);
    if(max>last)await this.saveState(tx,'pi_trigger_last_finding',String(max));
  }

  private async collectGoals(tx: Database, triggers: TriggerRow[]) {
    const fired = new Set<number>(JSON.parse(await this.state(tx,'pi_trigger_fired_goals')) as number[]);
    const rows = await tx.query(`SELECT n.id,t.id task_id,t.description,t.goal,n.payload FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id
      WHERE n.kind='goal' AND n.state='met' AND t.deleted_at IS NULL AND NOT (n.id=ANY($2::bigint[])) ORDER BY n.id LIMIT $1`, [PAGE,[...fired]]);
    for(const r of rows.rows){const id=Number(r.id);if(fired.has(id))continue;fired.add(id);const p=(r.payload??{}) as Record<string,unknown>;const text=String(p.text??p.summary??'');
      await this.fire(tx,triggers,'on_goal_met',`goal:${id}`,'goal',Number(r.task_id),{goal_id:id,description:r.description,goal:r.goal,summary:text,
        context:`【本次由任务达成目标触发】\n任务 #${r.task_id}：${r.description}\n目标：${text}`},'goal_message');}
    await this.saveState(tx,'pi_trigger_fired_goals',JSON.stringify([...fired]));
  }

  private async collectTimeouts(tx: Database, triggers: TriggerRow[]) {
    const fired = new Set<number>(JSON.parse(await this.state(tx,'pi_trigger_fired_timeouts')) as number[]);
    const rows = await tx.query("SELECT id,description,goal FROM tasks WHERE status='timeout' AND deleted_at IS NULL AND NOT (id=ANY($2::bigint[])) ORDER BY id LIMIT $1", [PAGE,[...fired]]);
    for(const r of rows.rows){const id=Number(r.id);if(fired.has(id))continue;fired.add(id);await this.fire(tx,triggers,'on_task_timeout',`timeout:${id}`,'task_timeout',id,{description:r.description,goal:r.goal,
      context:`【本次由任务超时触发】\n任务 #${id}：${r.description}\n目标：${r.goal}`},'task_timeout_message');}
    await this.saveState(tx,'pi_trigger_fired_timeouts',JSON.stringify([...fired]));
  }

  private async collectTaskCreates(tx: Database, triggers: TriggerRow[]) {
    const last=Number(await this.state(tx,'pi_trigger_last_task'))||0;
    const rows=await tx.query("SELECT id,description,goal FROM tasks t WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM scheduler_seen_sources ss WHERE ss.kind='task' AND ss.source_id=t.id) ORDER BY id LIMIT $1",[PAGE]);let max=last;
    for(const r of rows.rows){const id=Number(r.id);max=Math.max(max,id);await this.fire(tx,triggers,'on_task_create',`task_create:${id}`,'task_create',id,{description:r.description,goal:r.goal,
      context:`【本次由任务创建触发】\n任务 #${id}：${r.description}\n目标：${r.goal}`},'task_create_message');}
    for(const r of rows.rows)await tx.query("INSERT INTO scheduler_seen_sources(kind,source_id) VALUES('task',$1) ON CONFLICT DO NOTHING",[r.id]);
    if(max>last)await this.saveState(tx,'pi_trigger_last_task',String(max));
  }

  private async collectToolCalls(tx: Database, triggers: TriggerRow[]) {
    const last=Number(await this.state(tx,'pi_trigger_last_tool'))||0;
    const rows=await tx.query(`SELECT r.id,t.id task_id,t.description,t.goal,r.tool,r.detail,r.is_error,u.detail input FROM activity r
      JOIN tasks t ON t.exploration_id=r.exploration_id LEFT JOIN activity u ON u.exploration_id=r.exploration_id AND u.tool_use_id=r.tool_use_id AND u.kind='tool_use'
      WHERE r.kind='tool_result' AND NOT EXISTS(SELECT 1 FROM scheduler_seen_sources ss WHERE ss.kind='tool' AND ss.source_id=r.id) AND r.tool<>'' AND t.deleted_at IS NULL ORDER BY r.id LIMIT $1`,[PAGE]);let max=last;
    for(const r of rows.rows){const id=Number(r.id);max=Math.max(max,id);const tool=String(r.tool);if(r.is_error&&tool==='report_finding')continue;
      const interested=triggers.filter(t=>{
        if(t.on_tool_call!==true)return false;
        try{return (JSON.parse(String(t.tool_names??'[]')) as string[]).some(name=>name.toLowerCase()===tool.toLowerCase());}catch{return false;}
      });
      await this.fire(tx,interested, 'on_tool_call',`tool:${id}`,'tool_call',Number(r.task_id),{tool,tool_input:String(r.input??'').slice(0,1500),tool_output:String(r.detail??'').slice(0,1500),tool_is_error:r.is_error===true,
       context:`【本次由工具调用触发】\n任务 #${r.task_id}：${r.description}\n目标：${r.goal}\n工具：${tool}\n入参：${String(r.input??'').slice(0,1500)}\n返回：${r.is_error?'[error] ':''}${String(r.detail??'').slice(0,1500)}`},'tool_call_message');}
    for(const r of rows.rows)await tx.query("INSERT INTO scheduler_seen_sources(kind,source_id) VALUES('tool',$1) ON CONFLICT DO NOTHING",[r.id]);
    if(max>last)await this.saveState(tx,'pi_trigger_last_tool',String(max));
  }

  private async collectIntervals(tx: Database, triggers: TriggerRow[]) {
    for(const trigger of triggers){const seconds=Number(trigger.interval_sec)||0;if(seconds<=0)continue;
      const updated=await tx.query(`UPDATE agent_triggers SET last_fire=now() WHERE id=$1 AND enabled AND (last_fire IS NULL OR last_fire<=now()-($2*interval '1 second')) RETURNING last_fire`,[trigger.id,seconds]);
      if(!updated.rowCount)continue;
      await this.fire(tx,[trigger],'interval',`interval:${trigger.id}:${new Date(String(updated.rows[0]!.last_fire)).getTime()}`,'interval',null,{context:'【周期触发】请根据可用上下文检查是否有待处理工作。'},'interval_message');
    }
  }

  private async enqueuePending(tx: Database, triggers: TriggerRow[]) {
    for(const trigger of triggers){
      const pending=(await tx.query(`SELECT e.id,e.event_key AS key,e.kind,e.task_id,e.payload FROM agent_trigger_deliveries d JOIN agent_trigger_events e ON e.id=d.event_id
        WHERE d.trigger_id=$1 AND d.delivered_at IS NULL ORDER BY e.id LIMIT $2`,[trigger.id,PAGE])).rows as Array<Record<string,unknown>>;
      if(!pending.length)continue;
      const runMode=String(trigger.trigger_run_mode??'serial'),mergeMode=String(trigger.trigger_merge_mode??'all');
      let groups:Record<string,unknown>[][]=[];
      if(runMode==='parallel'||mergeMode==='none')groups=pending.map(e=>[e]);
      else if(mergeMode==='all')groups=[pending];
      else {const grouped=new Map<string,Record<string,unknown>[]>();for(const event of pending){const key=event.task_id===null?`event:${event.id}`:`task:${event.task_id}`;const group=grouped.get(key)??[];group.push(event);grouped.set(key,group);}groups=[...grouped.values()];}
      for(const group of groups){
        const events=group as unknown as PendingEvent[],taskIDs=[...new Set(events.map(e=>e.task_id).filter((v):v is number=>v!==null))];
        const taskID=taskIDs.length===1?taskIDs[0]!:null;
        const keys=events.map(e=>e.key),texts=events.map(e=>{const payload=e.payload??{};return JSON.stringify({source:'blackboard',kind:e.kind,task_id:e.task_id,event_key:e.key,...Object.fromEntries(Object.entries(payload).filter(([key,value])=>/(?:_id|_version)$/.test(key)&&(typeof value==='number'||typeof value==='string')))});});
        const title=`触发 · ${trigger.agent_key} · ${events.length} 条`;
        const message=events.length===1?texts[0]!:texts.map((text,i)=>`[${i+1}/${texts.length}] ${text}`).join('\n\n');
        const conv=await tx.query('INSERT INTO conversations(agent_key,title,task_id) VALUES($1,$2,$3) RETURNING id',[trigger.agent_key,title,taskID]);
        const run=await tx.query(`INSERT INTO conversation_runs(conversation_id,status,message,trigger_id,event_keys) VALUES($1,'queued',$2,$3,$4::text[]) RETURNING id`,[conv.rows[0]!.id,message,trigger.id,keys]);
        await tx.query('UPDATE agent_trigger_deliveries SET run_id=$3,delivered_at=now() WHERE trigger_id=$1 AND event_id=ANY($2::bigint[]) AND delivered_at IS NULL',[trigger.id,events.map(e=>e.id),run.rows[0]!.id]);
      }
    }
  }
}
