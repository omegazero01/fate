-- Projection delivery metadata only. Domain effects and native sessions remain
-- authoritative; replaying activity never runs a tool or changes task state.
CREATE TABLE IF NOT EXISTS activity_outbox_identity (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), identity UUID NOT NULL
);
INSERT INTO activity_outbox_identity(singleton,identity) VALUES(true,gen_random_uuid()) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS activity_outbox_progress (
 producer_id UUID PRIMARY KEY, namespace UUID NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('task','conversation')),
 scope_id BIGINT NOT NULL, task_id BIGINT, run_id BIGINT, header_hash TEXT NOT NULL,
 byte_offset BIGINT NOT NULL, next_seq BIGINT NOT NULL DEFAULT 0, last_hash TEXT,
 closed BOOLEAN NOT NULL DEFAULT false, discarded BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Native transcript reconciliation. No tool/domain work is enqueued here.
CREATE TABLE IF NOT EXISTS native_activity_runs (
 runtime_id TEXT PRIMARY KEY REFERENCES runtime_role_configs(id) ON DELETE CASCADE,
 namespace UUID NOT NULL,canonical_file TEXT NOT NULL,session_id TEXT NOT NULL,marker_id TEXT NOT NULL,
 identity JSONB NOT NULL,byte_offset BIGINT NOT NULL,tail_hash TEXT NOT NULL,
 scan_state JSONB NOT NULL DEFAULT '{"bound":false,"sequence":0}',
 completed BOOLEAN NOT NULL DEFAULT false,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS native_activity_pending ON native_activity_runs(next_attempt_at,runtime_id) WHERE NOT completed;
CREATE TABLE IF NOT EXISTS native_activity_receipts (
 runtime_id TEXT NOT NULL REFERENCES native_activity_runs(runtime_id) ON DELETE CASCADE,
 event_key TEXT NOT NULL,source_hash TEXT NOT NULL,activity_id BIGINT,
 PRIMARY KEY(runtime_id,event_key)
);
