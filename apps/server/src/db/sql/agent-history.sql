-- Rebuildable byte/branch and host-receipt index. Native PI JSONL is authoritative.
-- Scope is a host-validated task/intent/Main segment or standalone conversation;
-- no new public cross-session read permission is implied by this table.
CREATE TABLE IF NOT EXISTS agent_session_sources (
 session_key TEXT PRIMARY KEY,task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
 exploration_id BIGINT REFERENCES explorations(id) ON DELETE CASCADE,
 intent_id BIGINT REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
 role TEXT NOT NULL,main_seg BIGINT,scope JSONB NOT NULL,
 generation UUID NOT NULL,session_id TEXT NOT NULL,source_path TEXT NOT NULL,
 device TEXT NOT NULL,inode TEXT NOT NULL,indexed_bytes BIGINT NOT NULL,
 source_size BIGINT NOT NULL,source_mtime TEXT NOT NULL,tail_hash TEXT NOT NULL,
 entry_count BIGINT NOT NULL,header JSONB NOT NULL,host_index_version INT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_session_entries (
 session_key TEXT NOT NULL REFERENCES agent_session_sources(session_key) ON DELETE CASCADE,
 ordinal BIGINT NOT NULL,entry_id TEXT NOT NULL,parent_id TEXT,entry_type TEXT NOT NULL,
 byte_offset BIGINT NOT NULL,byte_length BIGINT NOT NULL,raw_hash TEXT NOT NULL,runtime_meta JSONB,
 PRIMARY KEY(session_key,ordinal),UNIQUE(session_key,entry_id)
);
CREATE TABLE IF NOT EXISTS agent_session_host_state (
 session_key TEXT NOT NULL REFERENCES agent_session_sources(session_key) ON DELETE CASCADE,
 namespace TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,ordinal BIGINT NOT NULL,
 subject_ref TEXT,content_version BIGINT,incomplete BOOLEAN,context_ids BIGINT[],wakeup_ids BIGINT[],
 need_data TEXT,need_key TEXT,need_hash TEXT,need_priority INT,
 PRIMARY KEY(session_key,namespace,key)
);
CREATE INDEX IF NOT EXISTS agent_session_host_ref ON agent_session_host_state(session_key,namespace,subject_ref);
CREATE INDEX IF NOT EXISTS agent_session_host_recent ON agent_session_host_state(session_key,namespace,ordinal DESC,key);
CREATE INDEX IF NOT EXISTS agent_session_host_needs ON agent_session_host_state(session_key,need_priority DESC,subject_ref COLLATE "C",need_key) WHERE need_data IS NOT NULL;
