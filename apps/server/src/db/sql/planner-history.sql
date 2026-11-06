-- Rebuildable search/offset index. The native JSONL remains the original source.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS planner_history_sources (
 exploration_id BIGINT PRIMARY KEY REFERENCES explorations(id) ON DELETE CASCADE,
 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 generation UUID NOT NULL, session_id TEXT NOT NULL, source_path TEXT NOT NULL,
 device TEXT NOT NULL, inode TEXT NOT NULL, indexed_bytes BIGINT NOT NULL,
 source_size BIGINT NOT NULL, source_mtime TEXT NOT NULL, tail_hash TEXT NOT NULL,
 entry_count BIGINT NOT NULL, header JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS planner_history_entries (
 exploration_id BIGINT NOT NULL REFERENCES planner_history_sources(exploration_id) ON DELETE CASCADE,
 ordinal BIGINT NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, entry_type TEXT NOT NULL,
 byte_offset BIGINT NOT NULL, byte_length BIGINT NOT NULL, raw_hash TEXT NOT NULL,
 metadata JSONB, content TEXT, content_chars BIGINT, content_hash TEXT,
 PRIMARY KEY(exploration_id,ordinal),UNIQUE(exploration_id,entry_id)
);
CREATE TABLE IF NOT EXISTS planner_history_parts (
 exploration_id BIGINT NOT NULL,ordinal BIGINT NOT NULL,part_no INT NOT NULL,
 start_char BIGINT NOT NULL,folded TEXT NOT NULL,expansions JSONB NOT NULL,
 PRIMARY KEY(exploration_id,ordinal,part_no),
 FOREIGN KEY(exploration_id,ordinal) REFERENCES planner_history_entries(exploration_id,ordinal) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS planner_history_literal ON planner_history_parts USING GIN(folded gin_trgm_ops);

-- Derived host metadata, committed with the source byte cursor. TEXT stores
-- JSON without PostgreSQL interpreting NUL/surrogate escapes in original input.
ALTER TABLE planner_history_sources ADD COLUMN IF NOT EXISTS host_index_version INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS planner_host_state (
 exploration_id BIGINT NOT NULL REFERENCES planner_history_sources(exploration_id) ON DELETE CASCADE,
 namespace TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,ordinal BIGINT NOT NULL,
 subject_ref TEXT,content_version BIGINT,incomplete BOOLEAN,context_ids BIGINT[],wakeup_ids BIGINT[],
 PRIMARY KEY(exploration_id,namespace,key)
);
CREATE INDEX IF NOT EXISTS planner_host_state_recent ON planner_host_state(exploration_id,namespace,ordinal DESC,key);
CREATE INDEX IF NOT EXISTS planner_host_state_ref ON planner_host_state(exploration_id,namespace,subject_ref);
CREATE INDEX IF NOT EXISTS planner_host_delivery_context ON planner_host_state USING GIN(context_ids) WHERE namespace='delivery';
CREATE INDEX IF NOT EXISTS planner_host_delivery_wakeup ON planner_host_state USING GIN(wakeup_ids) WHERE namespace='delivery';
CREATE INDEX IF NOT EXISTS planner_host_delivery_pending ON planner_host_state(exploration_id,ordinal) WHERE namespace='delivery' AND incomplete IS TRUE;
ALTER TABLE planner_history_entries ADD COLUMN IF NOT EXISTS runtime_meta JSONB;
ALTER TABLE planner_host_state ADD COLUMN IF NOT EXISTS need_data TEXT;
ALTER TABLE planner_host_state ADD COLUMN IF NOT EXISTS need_key TEXT;
ALTER TABLE planner_host_state ADD COLUMN IF NOT EXISTS need_hash TEXT;
ALTER TABLE planner_host_state ADD COLUMN IF NOT EXISTS need_priority INT;
CREATE INDEX IF NOT EXISTS planner_host_needs ON planner_host_state(exploration_id,need_priority DESC,subject_ref COLLATE "C",need_key) WHERE need_data IS NOT NULL;

-- Rebuildable receipt projection. These fields contain IDs/display metadata,
-- never model-authored claims about whether dispatch succeeded.
ALTER TABLE planner_history_sources ADD COLUMN IF NOT EXISTS receipt_index_version INT NOT NULL DEFAULT 0;
ALTER TABLE planner_history_entries ADD COLUMN IF NOT EXISTS delivery_entry_id TEXT;
ALTER TABLE planner_history_entries ADD COLUMN IF NOT EXISTS receipt_meta TEXT;
CREATE INDEX IF NOT EXISTS planner_history_delivery ON planner_history_entries(exploration_id,delivery_entry_id,ordinal);

-- Durable domain effects are independent of the rebuildable JSONL index. A
-- crash after COMMIT but before PI saves a tool result must not erase a receipt.
CREATE TABLE IF NOT EXISTS planner_dispatch_calls (
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL, delivery_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
 arguments_hash TEXT NOT NULL, result_text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(exploration_id,session_id,delivery_id,tool_call_id)
);
CREATE TABLE IF NOT EXISTS planner_dispatch_items (
 exploration_id BIGINT NOT NULL, session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
 item_no INT NOT NULL, delivery_id TEXT NOT NULL, intent_id BIGINT NOT NULL, created BOOLEAN NOT NULL,
 PRIMARY KEY(exploration_id,session_id,delivery_id,tool_call_id,item_no),
 CONSTRAINT planner_dispatch_items_call_fkey FOREIGN KEY(exploration_id,session_id,delivery_id,tool_call_id) REFERENCES planner_dispatch_calls(exploration_id,session_id,delivery_id,tool_call_id) ON DELETE CASCADE
);
-- Upgrade an earlier local receipt prototype without touching its records.
DO $$ DECLARE fk RECORD; BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='planner_dispatch_calls'::regclass AND contype='p' AND array_length(conkey,1)=3) THEN
  FOR fk IN SELECT conname FROM pg_constraint WHERE conrelid='planner_dispatch_items'::regclass AND contype='f' AND confrelid='planner_dispatch_calls'::regclass LOOP
   EXECUTE format('ALTER TABLE planner_dispatch_items DROP CONSTRAINT %I',fk.conname);
  END LOOP;
  ALTER TABLE planner_dispatch_calls DROP CONSTRAINT planner_dispatch_calls_pkey;
  ALTER TABLE planner_dispatch_calls ADD PRIMARY KEY(exploration_id,session_id,delivery_id,tool_call_id);
  ALTER TABLE planner_dispatch_items DROP CONSTRAINT planner_dispatch_items_pkey;
  ALTER TABLE planner_dispatch_items ADD PRIMARY KEY(exploration_id,session_id,delivery_id,tool_call_id,item_no);
  ALTER TABLE planner_dispatch_items ADD CONSTRAINT planner_dispatch_items_call_fkey FOREIGN KEY(exploration_id,session_id,delivery_id,tool_call_id)
   REFERENCES planner_dispatch_calls(exploration_id,session_id,delivery_id,tool_call_id) ON DELETE CASCADE;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS planner_dispatch_delivery ON planner_dispatch_items(exploration_id,session_id,delivery_id,intent_id) WHERE created;
