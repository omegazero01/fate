-- Legacy snapshots keep their complete body (storage_version=0). New writers
-- append immutable original chunks and keep only a bounded display tail here.
ALTER TABLE agent_stream_snapshots ADD COLUMN IF NOT EXISTS storage_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE agent_stream_snapshots ADD COLUMN IF NOT EXISTS total_chars BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_stream_snapshots ADD COLUMN IF NOT EXISTS next_chunk BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS agent_stream_chunks (
 scope TEXT NOT NULL, scope_id BIGINT NOT NULL, stream_id TEXT NOT NULL, channel TEXT NOT NULL,
 chunk_no BIGINT NOT NULL, start_char BIGINT NOT NULL, end_char BIGINT NOT NULL,
 body TEXT NOT NULL CHECK(char_length(body)>0 AND char_length(body)<=65536),
 PRIMARY KEY(scope,scope_id,stream_id,channel,chunk_no),
 FOREIGN KEY(scope,scope_id,stream_id,channel)
   REFERENCES agent_stream_snapshots(scope,scope_id,stream_id,channel) ON DELETE CASCADE,
 CHECK(start_char>=0 AND end_char=start_char+char_length(body))
);
CREATE INDEX IF NOT EXISTS idx_stream_chunk_position ON agent_stream_chunks(scope,scope_id,stream_id,channel,start_char);
-- The per-chunk final check must not scan the task's growing activity history.
CREATE INDEX IF NOT EXISTS idx_act_stream_identity ON activity(exploration_id,(metadata->>'stream_id'),(metadata->>'channel'))
 WHERE metadata->>'stream_id' IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conv_act_stream_identity ON conversation_activities(conversation_id,(metadata->>'stream_id'),(metadata->>'channel'))
 WHERE metadata->>'stream_id' IS NOT NULL;

-- One network round trip, with all checks and writes in the same transaction.
-- VOLATILE is essential: the final-row check gets a fresh snapshot after a
-- concurrent final writer releases the per-stream lock.
CREATE OR REPLACE FUNCTION append_agent_stream_chunk(
 p_scope TEXT,p_id BIGINT,p_stream TEXT,p_channel TEXT,p_turn TEXT,p_worker TEXT,
 p_node BIGINT,p_segment INTEGER,p_no BIGINT,p_start BIGINT,p_text TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE saved agent_stream_snapshots%ROWTYPE; prior agent_stream_chunks%ROWTYPE;
BEGIN
 IF p_scope NOT IN ('task','conversation') THEN RAISE EXCEPTION 'Invalid live stream scope'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stream:'||jsonb_build_array(p_scope,p_id,p_stream,p_channel)::text,0));
 IF p_scope='task' THEN
  IF NOT EXISTS(SELECT 1 FROM explorations WHERE id=p_id AND NOT EXISTS(SELECT 1 FROM tasks WHERE exploration_id=p_id AND deleted_at IS NOT NULL))
   OR EXISTS(SELECT 1 FROM activity WHERE exploration_id=p_id AND metadata->>'stream_id'=p_stream AND metadata->>'channel'=p_channel) THEN RETURN false; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_id)
   OR EXISTS(SELECT 1 FROM conversation_activities WHERE conversation_id=p_id AND metadata->>'stream_id'=p_stream AND metadata->>'channel'=p_channel) THEN RETURN false; END IF;
 END IF;
 INSERT INTO agent_stream_snapshots(scope,scope_id,stream_id,channel,turn_id,worker,node_id,main_seg,storage_version,expires_at)
  VALUES(p_scope,p_id,p_stream,p_channel,p_turn,p_worker,p_node,p_segment,1,now()+interval '12 seconds') ON CONFLICT DO NOTHING;
 SELECT * INTO saved FROM agent_stream_snapshots WHERE scope=p_scope AND scope_id=p_id AND stream_id=p_stream AND channel=p_channel FOR UPDATE;
 IF saved.turn_id<>p_turn OR saved.storage_version<>1 THEN RAISE EXCEPTION 'Live stream identity or storage version changed'; END IF;
 IF saved.next_chunk>p_no THEN
  SELECT * INTO prior FROM agent_stream_chunks WHERE scope=p_scope AND scope_id=p_id AND stream_id=p_stream AND channel=p_channel AND chunk_no=p_no;
  IF prior.start_char IS DISTINCT FROM p_start OR prior.body IS DISTINCT FROM p_text THEN RAISE EXCEPTION 'Live stream retry conflicts with saved original'; END IF;
  RETURN true;
 END IF;
 IF saved.next_chunk<>p_no OR saved.total_chars<>p_start THEN RAISE EXCEPTION 'Live stream chunk is not contiguous'; END IF;
 INSERT INTO agent_stream_chunks(scope,scope_id,stream_id,channel,chunk_no,start_char,end_char,body)
  VALUES(p_scope,p_id,p_stream,p_channel,p_no,p_start,p_start+char_length(p_text),p_text);
 UPDATE agent_stream_snapshots SET body=right(body||p_text,8192),total_chars=p_start+char_length(p_text),
  next_chunk=p_no+1,expires_at=now()+interval '12 seconds' WHERE scope=p_scope AND scope_id=p_id AND stream_id=p_stream AND channel=p_channel;
 RETURN true;
END $$;
