import type { Database } from '../db/index.js';
import type { RunnerActivity } from '../pi/runner.js';

export type StreamScope = 'task' | 'conversation';
export type StreamIdentity = { worker: string; node_id?: number; main_seg?: number; turn_id: string };

/** Native message metadata is durable even when a response contains only tools. */
export function runnerActivityMetadata(a: RunnerActivity) {
  if(a.kind==='host_status')return {event_type:'goals_phase',phase:a.phase};
  if(a.kind==='settled')return {event_type:'runner_settled',stop_reason:a.stopReason};
  if(a.kind==='run_metadata')return {event_type:'turn_start',runtime_id:a.runtimeID,role:a.role,mode:a.mode,started_at:a.startedAt};
  if(a.kind==='assistant_message_end')return {final_answer:a.final,stream_id:a.streamID,channel:a.isThinking?'thinking':'text',...(a.response?{response:a.response}:{})};
  return {};
}

/** Shared snapshots are presentation state, never domain facts or execution authority. */
export class LiveStreamWriter {
  private messages = new Map<string, { text: string; channel: string; stream: string; dirty: boolean }>();
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private heartbeat = 0;
  private flushing = false;
  constructor(private db: Database, private scope: StreamScope, private id: number, readonly identity: StreamIdentity) {
    this.timer = setInterval(() => this.flush(), 75);
    this.timer.unref();
  }
  push(a: RunnerActivity) {
    if (a.kind !== 'assistant_delta') return;
    const channel = a.isThinking ? 'thinking' : 'text';
    const key = `${a.streamID}:${channel}`;
    const current = this.messages.get(key) ?? { text: '', stream: a.streamID, channel, dirty: false };
    current.text += a.text;
    current.dirty = true;
    this.messages.set(key, current);
  }
  private flush() {
    if (this.flushing) return; // Coalesce while PostgreSQL is slow; never queue every token batch.
    const batch: (() => Promise<unknown>)[] = [];
    const heartbeat = Date.now() - this.heartbeat > 3000;
    if (heartbeat) this.heartbeat = Date.now();
    for (const m of this.messages.values()) {
      if (!m.dirty && !heartbeat) continue;
      m.dirty = false;
      const text = m.text;
      batch.push(() => this.db.query(`
        INSERT INTO agent_stream_snapshots(scope,scope_id,turn_id,stream_id,channel,worker,node_id,main_seg,body,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '12 seconds')
        ON CONFLICT(scope,scope_id,stream_id,channel) DO UPDATE SET body=EXCLUDED.body,expires_at=EXCLUDED.expires_at`,
      [this.scope,this.id,this.identity.turn_id,m.stream,m.channel,this.identity.worker,this.identity.node_id??null,this.identity.main_seg??null,text]).catch(() => {
        // Keep the newest body dirty for the next bounded retry. Presentation
        // failures must not turn timer promises into unhandled process errors.
        if (this.messages.get(`${m.stream}:${m.channel}`) === m) m.dirty = true;
      }));
    }
    if (!batch.length) return;
    this.flushing = true;
    this.tail = this.tail.catch(() => undefined).then(async () => {
      for (const save of batch) await save();
    }).finally(() => { this.flushing = false; });
  }
  /** Called only after the authoritative final activity commits. */
  async committed(stream: string, channel: string) {
    this.messages.delete(`${stream}:${channel}`);
    const pending = this.tail.catch(() => undefined).then(() => this.db.query(
      'DELETE FROM agent_stream_snapshots WHERE scope=$1 AND scope_id=$2 AND stream_id=$3 AND channel=$4', [this.scope,this.id,stream,channel]));
    this.tail = pending;
    await pending;
  }
  async close() {
    clearInterval(this.timer);
    await this.tail.catch(() => undefined);
    this.flush();
    await this.tail.catch(() => undefined);
    // Providers can abort without message_end. Promote the partial output to
    // ordinary history and remove its temporary snapshot in the same transaction.
    // A crashed process still leaves its expiring snapshot available for recovery.
    await this.db.transaction(async tx => {
      const partials = await tx.query('DELETE FROM agent_stream_snapshots WHERE scope=$1 AND scope_id=$2 AND turn_id=$3 RETURNING *', [this.scope,this.id,this.identity.turn_id]);
      for (const row of partials.rows) {
        const metadata = JSON.stringify({turn_id:row.turn_id,stream_id:row.stream_id,channel:row.channel,interrupted:true});
        const kind = row.channel === 'thinking' ? 'thinking' : this.scope === 'task' ? 'text' : 'assistant';
        if (this.scope === 'task') {
          await tx.query(`INSERT INTO activity(exploration_id,worker,node_id,main_seg,kind,summary,detail,metadata,created_at)
            SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9 WHERE NOT EXISTS(SELECT 1 FROM activity WHERE exploration_id=$1 AND metadata->>'stream_id'=$10 AND metadata->>'channel'=$11)`,
          [this.id,row.worker,row.node_id,row.main_seg,kind,String(row.body).slice(0,4000),row.body,metadata,row.created_at,row.stream_id,row.channel]);
        } else {
          await tx.query(`INSERT INTO conversation_activities(conversation_id,worker,kind,summary,detail,metadata,created_at)
            SELECT $1,$2,$3,$4,$5,$6::jsonb,$7 WHERE NOT EXISTS(SELECT 1 FROM conversation_activities WHERE conversation_id=$1 AND metadata->>'stream_id'=$8 AND metadata->>'channel'=$9)`,
          [this.id,row.worker,kind,String(row.body).slice(0,1000),row.body,metadata,row.created_at,row.stream_id,row.channel]);
        }
      }
    });
    this.messages.clear();
  }
}

export function activityDTO(row: Record<string, unknown>) {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return { ...row, id: Number(row.id), seq: Number(row.id), ts: row.created_at,
    worker: row.worker === 'main' ? 'mainagent' : row.worker,
    intent_id: row.node_id == null ? undefined : String(row.node_id),
    main_seg: row.main_seg == null ? undefined : Number(row.main_seg),
    turn_id: metadata.turn_id, stream_id: metadata.stream_id, channel: metadata.channel, interrupted: metadata.interrupted === true, metadata };
}
