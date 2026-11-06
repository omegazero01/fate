-- Presentation dependencies, not another event queue or execution authority.
-- Links retain a conservative superset after edits/deletes; no evidence bodies.
CREATE TABLE IF NOT EXISTS turn_read_versions (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,kind TEXT NOT NULL,entity TEXT NOT NULL,
 version BIGINT NOT NULL DEFAULT 1,PRIMARY KEY(scope,scope_id,kind,entity)
);
CREATE TABLE IF NOT EXISTS turn_read_links (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,relation TEXT NOT NULL,
 source_key TEXT NOT NULL,target_key TEXT NOT NULL,
 PRIMARY KEY(scope,scope_id,relation,source_key,target_key)
);
CREATE TABLE IF NOT EXISTS turn_read_initialized (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,
 PRIMARY KEY(scope,scope_id,turn_id)
);
CREATE INDEX IF NOT EXISTS idx_act_turn_runtime ON activity(exploration_id,(metadata->>'turn_id'),id)
 WHERE metadata->>'event_type'='turn_start';
CREATE INDEX IF NOT EXISTS idx_conv_act_turn_runtime ON conversation_activities(conversation_id,(metadata->>'turn_id'),id)
 WHERE metadata->>'event_type'='turn_start';

CREATE OR REPLACE FUNCTION bump_turn_read(p_scope TEXT,p_id BIGINT,p_kind TEXT,p_entity TEXT)
RETURNS VOID LANGUAGE SQL AS $$
 INSERT INTO turn_read_versions(scope,scope_id,kind,entity)
 SELECT p_scope,p_id,p_kind,p_entity WHERE p_id IS NOT NULL AND p_entity IS NOT NULL
 ON CONFLICT(scope,scope_id,kind,entity) DO UPDATE SET version=turn_read_versions.version+1
$$;
CREATE OR REPLACE FUNCTION link_turn_read(p_scope TEXT,p_id BIGINT,p_relation TEXT,p_source TEXT,p_target TEXT)
RETURNS VOID LANGUAGE SQL AS $$
 INSERT INTO turn_read_links VALUES(p_scope,p_id,p_relation,p_source,p_target)
 ON CONFLICT DO NOTHING
$$;
CREATE OR REPLACE FUNCTION touch_turn_activity(p_scope TEXT,p_id BIGINT,p_turn TEXT,p_runtime TEXT,p_edit BOOLEAN)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 IF p_id IS NULL OR p_turn IS NULL THEN RETURN;END IF;
 PERFORM bump_turn_read(p_scope,p_id,'activity',p_turn);
 IF p_edit THEN PERFORM bump_turn_read(p_scope,p_id,'activity_rewrite',p_turn);END IF;
 IF p_runtime IS NOT NULL THEN PERFORM link_turn_read(p_scope,p_id,'activity_runtime',p_turn,p_runtime);END IF;
 -- Inserts already change max(activity.id). Older edits/deletes need a wakeup.
 IF p_edit THEN INSERT INTO stream_usage_versions VALUES(p_scope,p_id,1)
  ON CONFLICT(scope,scope_id) DO UPDATE SET version=stream_usage_versions.version+1;END IF;
END $$;
CREATE OR REPLACE FUNCTION capture_turn_activity_read() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE s TEXT; old_id BIGINT; new_id BIGINT; ot TEXT; nt TEXT; ort TEXT; nrt TEXT; sensitive BOOLEAN:=false;
BEGIN
 s:=CASE WHEN TG_TABLE_NAME='activity' THEN 'task' ELSE 'conversation' END;
 IF TG_OP<>'INSERT' THEN
  IF s='task' THEN SELECT id INTO old_id FROM tasks WHERE exploration_id=OLD.exploration_id;ELSE old_id:=OLD.conversation_id;END IF;
  ot:=OLD.metadata->>'turn_id';ort:=CASE WHEN OLD.metadata->>'event_type'='turn_start' THEN OLD.metadata->>'runtime_id' END;
 END IF;
 IF TG_OP<>'DELETE' THEN
  IF s='task' THEN SELECT id INTO new_id FROM tasks WHERE exploration_id=NEW.exploration_id;ELSE new_id:=NEW.conversation_id;END IF;
  nt:=NEW.metadata->>'turn_id';nrt:=CASE WHEN NEW.metadata->>'event_type'='turn_start' THEN NEW.metadata->>'runtime_id' END;
  PERFORM touch_turn_activity(s,new_id,nt,nrt,TG_OP='UPDATE');
 END IF;
 IF TG_OP='DELETE' OR TG_OP='UPDATE' AND (old_id,ot,ort) IS DISTINCT FROM (new_id,nt,nrt) THEN
  PERFORM touch_turn_activity(s,old_id,ot,ort,true);
 END IF;
 -- Distinguish edits which can affect counts/model/usage from presentation-only
 -- control changes. This is a revision fence, not a copied activity journal.
 IF TG_OP='INSERT' THEN
  sensitive:=NEW.metadata ? 'response' OR NEW.metadata->>'event_type'='turn_start';
 ELSIF TG_OP='DELETE' THEN
  sensitive:=OLD.metadata ? 'response' OR OLD.kind IN('tool_use','tool_result') OR OLD.metadata->>'event_type'='turn_start';
 ELSE
  sensitive:=((OLD.metadata ? 'response' OR NEW.metadata ? 'response')
    AND (OLD.metadata IS DISTINCT FROM NEW.metadata OR OLD.id IS DISTINCT FROM NEW.id))
   OR ((OLD.metadata->>'event_type'='turn_start' OR NEW.metadata->>'event_type'='turn_start')
    AND (OLD.metadata IS DISTINCT FROM NEW.metadata OR OLD.id IS DISTINCT FROM NEW.id))
   OR (old_id,ot,ort) IS DISTINCT FROM (new_id,nt,nrt)
   OR (OLD.metadata->>'event_type'='turn_start') IS DISTINCT FROM (NEW.metadata->>'event_type'='turn_start')
   OR (OLD.kind,OLD.tool_use_id,OLD.is_error) IS DISTINCT FROM (NEW.kind,NEW.tool_use_id,NEW.is_error)
      AND (OLD.kind IN('tool_use','tool_result') OR NEW.kind IN('tool_use','tool_result'))
   OR OLD.metadata->'worker_feedback' IS DISTINCT FROM NEW.metadata->'worker_feedback';
  IF s='task' THEN sensitive:=sensitive OR OLD.node_id IS DISTINCT FROM NEW.node_id;END IF;
 END IF;
 IF COALESCE(sensitive,false) THEN
  IF TG_OP<>'DELETE' THEN PERFORM bump_turn_read(s,new_id,'activity_data_rewrite',nt);END IF;
  IF TG_OP='DELETE' OR TG_OP='UPDATE' AND (old_id,ot) IS DISTINCT FROM (new_id,nt) THEN
   PERFORM bump_turn_read(s,old_id,'activity_data_rewrite',ot);
  END IF;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS activity_turn_read ON activity;
CREATE TRIGGER activity_turn_read AFTER INSERT OR UPDATE OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION capture_turn_activity_read();
DROP TRIGGER IF EXISTS conversation_turn_read ON conversation_activities;
CREATE TRIGGER conversation_turn_read AFTER INSERT OR UPDATE OR DELETE ON conversation_activities FOR EACH ROW EXECUTE FUNCTION capture_turn_activity_read();

CREATE OR REPLACE FUNCTION touch_turn_usage(p_task BIGINT,p_conversation BIGINT,p_scope TEXT,p_turn TEXT,p_runtime TEXT,p_role TEXT,p_legacy BOOLEAN)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE s TEXT; sid BIGINT; identity TEXT; role_identity TEXT;
BEGIN
 identity:=jsonb_build_array(p_conversation,p_scope)::text;role_identity:=jsonb_build_array(p_conversation,p_role)::text;
 FOR s,sid IN SELECT 'task',p_task WHERE p_task IS NOT NULL UNION ALL SELECT 'conversation',p_conversation WHERE p_conversation IS NOT NULL LOOP
  PERFORM bump_turn_read(s,sid,'usage',identity);
  IF p_legacy THEN PERFORM bump_turn_read(s,sid,'legacy',role_identity);END IF;
  -- Same relation/key order as lazy historical initialization.
  PERFORM link_turn_read(s,sid,'usage_role',identity,role_identity);
  IF p_runtime IS NOT NULL THEN PERFORM link_turn_read(s,sid,'usage_runtime',p_runtime,identity);END IF;
  IF p_turn IS NOT NULL THEN PERFORM link_turn_read(s,sid,'usage_turn',p_turn,identity);END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION capture_turn_usage_read() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'DELETE' THEN
  PERFORM touch_turn_usage(NEW.task_id,NEW.conversation_id,NEW.scope_key,NEW.turn_id,NEW.runtime_id,NEW.role,NEW.source='legacy_results');
 END IF;
 IF TG_OP='DELETE' OR TG_OP='UPDATE' AND
  (OLD.task_id,OLD.conversation_id,OLD.scope_key,OLD.turn_id,OLD.runtime_id,OLD.role,OLD.source='legacy_results') IS DISTINCT FROM
  (NEW.task_id,NEW.conversation_id,NEW.scope_key,NEW.turn_id,NEW.runtime_id,NEW.role,NEW.source='legacy_results') THEN
  PERFORM touch_turn_usage(OLD.task_id,OLD.conversation_id,OLD.scope_key,OLD.turn_id,OLD.runtime_id,OLD.role,OLD.source='legacy_results');
  IF TG_OP='UPDATE' AND (OLD.task_id,OLD.conversation_id) IS DISTINCT FROM (NEW.task_id,NEW.conversation_id) THEN
   INSERT INTO stream_usage_versions SELECT 'task',OLD.task_id,1 WHERE OLD.task_id IS NOT NULL
    ON CONFLICT(scope,scope_id) DO UPDATE SET version=stream_usage_versions.version+1;
   INSERT INTO stream_usage_versions SELECT 'conversation',OLD.conversation_id,1 WHERE OLD.conversation_id IS NOT NULL
    ON CONFLICT(scope,scope_id) DO UPDATE SET version=stream_usage_versions.version+1;
  END IF;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS usage_turn_read ON llm_usage_ledger;
CREATE TRIGGER usage_turn_read AFTER INSERT OR UPDATE OR DELETE ON llm_usage_ledger FOR EACH ROW EXECUTE FUNCTION capture_turn_usage_read();

CREATE OR REPLACE FUNCTION capture_turn_runtime_read() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD; s TEXT; sid BIGINT;
BEGIN
 -- Ordinary future-to-future lease renewals do not change a visible summary.
 IF TG_OP='UPDATE' AND (NEW.id,NEW.task_id,NEW.conversation_id,NEW.role,NEW.finished_at,NEW.effective->>'stop_reason') IS NOT DISTINCT FROM
  (OLD.id,OLD.task_id,OLD.conversation_id,OLD.role,OLD.finished_at,OLD.effective->>'stop_reason') AND OLD.expires_at>now() AND NEW.expires_at>now() THEN RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN r:=OLD;ELSE r:=NEW;END IF;
 FOR s,sid IN SELECT 'task',r.task_id WHERE r.task_id IS NOT NULL UNION ALL SELECT 'conversation',r.conversation_id WHERE r.conversation_id IS NOT NULL LOOP
  PERFORM bump_turn_read(s,sid,'runtime',r.id);
  INSERT INTO stream_usage_versions VALUES(s,sid,1) ON CONFLICT(scope,scope_id) DO UPDATE SET version=stream_usage_versions.version+1;
 END LOOP;
 IF TG_OP='UPDATE' AND (OLD.id,OLD.task_id,OLD.conversation_id) IS DISTINCT FROM (NEW.id,NEW.task_id,NEW.conversation_id) THEN
  PERFORM bump_turn_read('task',OLD.task_id,'runtime',OLD.id);PERFORM bump_turn_read('conversation',OLD.conversation_id,'runtime',OLD.id);
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS runtime_turn_read ON runtime_role_configs;
CREATE TRIGGER runtime_turn_read AFTER INSERT OR UPDATE OR DELETE ON runtime_role_configs FOR EACH ROW EXECUTE FUNCTION capture_turn_runtime_read();

CREATE OR REPLACE FUNCTION capture_turn_access_read() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE tid BIGINT;
BEGIN
 IF TG_TABLE_NAME='exploration_nodes' THEN SELECT id INTO tid FROM tasks WHERE exploration_id=OLD.exploration_id;
 ELSE tid:=OLD.id;END IF;
 PERFORM bump_turn_read('task',tid,'access','all');RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS node_turn_access ON exploration_nodes;
CREATE TRIGGER node_turn_access AFTER DELETE ON exploration_nodes FOR EACH ROW EXECUTE FUNCTION capture_turn_access_read();
DROP TRIGGER IF EXISTS task_turn_access ON tasks;
CREATE TRIGGER task_turn_access AFTER UPDATE OF deleted_at,exploration_id OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION capture_turn_access_read();

-- Small indexed membership probes let an appended tool call be counted without
-- retaining all previous call IDs in the server heap or scanning its whole turn.
CREATE INDEX IF NOT EXISTS idx_act_turn_tool_call ON activity(exploration_id,(metadata->>'turn_id'),(md5(tool_use_id)),id) WHERE kind='tool_use';
CREATE INDEX IF NOT EXISTS idx_act_turn_tool_error ON activity(exploration_id,(metadata->>'turn_id'),(md5(tool_use_id)),id) WHERE kind='tool_result' AND is_error;
CREATE INDEX IF NOT EXISTS idx_conv_turn_tool_call ON conversation_activities(conversation_id,(metadata->>'turn_id'),(md5(tool_use_id)),id) WHERE kind='tool_use';
CREATE INDEX IF NOT EXISTS idx_conv_turn_tool_error ON conversation_activities(conversation_id,(metadata->>'turn_id'),(md5(tool_use_id)),id) WHERE kind='tool_result' AND is_error;

-- Point selections for bounded control refreshes; no evidence/metadata bodies in indexes.
CREATE INDEX IF NOT EXISTS idx_act_turn_event ON activity(exploration_id,(metadata->>'turn_id'),(left(metadata->>'event_type',64)),id) WHERE metadata ? 'event_type';
CREATE INDEX IF NOT EXISTS idx_conv_turn_event ON conversation_activities(conversation_id,(metadata->>'turn_id'),(left(metadata->>'event_type',64)),id) WHERE metadata ? 'event_type';
CREATE INDEX IF NOT EXISTS idx_act_turn_explicit ON activity(exploration_id,(metadata->>'turn_id'),id) WHERE metadata ? 'final_answer';
CREATE INDEX IF NOT EXISTS idx_conv_turn_explicit ON conversation_activities(conversation_id,(metadata->>'turn_id'),id) WHERE metadata ? 'final_answer';
CREATE INDEX IF NOT EXISTS idx_act_turn_user ON activity(exploration_id,(metadata->>'turn_id'),id) WHERE kind='user';
CREATE INDEX IF NOT EXISTS idx_conv_turn_user ON conversation_activities(conversation_id,(metadata->>'turn_id'),id) WHERE kind='user';
CREATE INDEX IF NOT EXISTS idx_act_turn_planner ON activity(exploration_id,(metadata->>'turn_id'),id) WHERE worker='planner';
CREATE INDEX IF NOT EXISTS idx_conv_turn_planner ON conversation_activities(conversation_id,(metadata->>'turn_id'),id) WHERE worker='planner';

CREATE INDEX IF NOT EXISTS idx_act_turn_legacy_round ON activity(exploration_id,(metadata->>'turn_id'),id) WHERE worker='planner' AND kind='round';
CREATE INDEX IF NOT EXISTS idx_conv_turn_legacy_round ON conversation_activities(conversation_id,(metadata->>'turn_id'),id) WHERE worker='planner' AND kind='round';

-- Native stream dedup probes keep response appends independent of the number
-- of prior messages. Hash is only an index key: readers also compare full IDs.
CREATE INDEX IF NOT EXISTS idx_act_turn_response_stream ON activity(exploration_id,(metadata->>'turn_id'),(md5(metadata->>'stream_id')),id)
 WHERE metadata ? 'stream_id' AND metadata ? 'response';
CREATE INDEX IF NOT EXISTS idx_conv_turn_response_stream ON conversation_activities(conversation_id,(metadata->>'turn_id'),(md5(metadata->>'stream_id')),id)
 WHERE metadata ? 'stream_id' AND metadata ? 'response';
