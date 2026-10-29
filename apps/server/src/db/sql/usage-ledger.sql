-- Deliberately no foreign keys: deleting a chat/log/config cannot erase metering.
CREATE TABLE IF NOT EXISTS llm_usage_ledger (
 request_id TEXT PRIMARY KEY, audit_id BIGINT UNIQUE,
 task_id BIGINT, conversation_id BIGINT, intent_id BIGINT, main_seg INT,
 runtime_id TEXT, turn_id TEXT, scope_key TEXT NOT NULL,
 worker_name TEXT, role TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'conversation',
 profile_id BIGINT, profile_name TEXT, model TEXT NOT NULL,
 status TEXT NOT NULL, usage JSONB NOT NULL DEFAULT '{}',
 quality TEXT NOT NULL DEFAULT 'unknown', input_semantics TEXT NOT NULL DEFAULT 'exclusive_cache',
 source TEXT NOT NULL DEFAULT 'request_audit', receipt_seq BIGINT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL, finished_at TIMESTAMPTZ,
 CHECK(quality IN ('complete','partial','unknown','not_sent','legacy_unknown'))
);
ALTER TABLE llm_usage_ledger ADD COLUMN IF NOT EXISTS worker_name TEXT;
CREATE INDEX IF NOT EXISTS usage_ledger_task ON llm_usage_ledger(task_id,created_at);
CREATE INDEX IF NOT EXISTS usage_ledger_conversation ON llm_usage_ledger(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS usage_ledger_runtime ON llm_usage_ledger(runtime_id);
CREATE INDEX IF NOT EXISTS usage_ledger_scope ON llm_usage_ledger(scope_key,source);
CREATE INDEX IF NOT EXISTS usage_ledger_date ON llm_usage_ledger(created_at);
ALTER TABLE llm_request_attempts ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS llm_attempt_request_id ON llm_request_attempts(request_id) WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION capture_request_usage() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE identity JSONB; profile_label TEXT; rid TEXT; q TEXT;
BEGIN
 SELECT effective->'usage_scope' INTO identity FROM runtime_role_configs WHERE id=NEW.runtime_id;
 SELECT name INTO profile_label FROM llm_profiles WHERE id=NEW.profile_id;
 rid:=COALESCE(NEW.request_id,'audit:'||NEW.id);
 q:=COALESCE(NEW.usage->>'_quality',CASE
   WHEN NEW.status='running' OR COALESCE((NEW.usage->>'unavailable')::boolean,false) THEN 'unknown'
   WHEN NEW.usage ?& ARRAY['input','output','cacheRead','cacheWrite'] AND
     COALESCE((NEW.usage->>'input')::numeric,0)+COALESCE((NEW.usage->>'output')::numeric,0)+COALESCE((NEW.usage->>'cacheRead')::numeric,0)+COALESCE((NEW.usage->>'cacheWrite')::numeric,0)>0 THEN 'complete'
   WHEN NEW.usage ?| ARRAY['input','output','cacheRead','cacheWrite'] THEN 'partial' ELSE 'unknown' END);
 INSERT INTO llm_usage_ledger(request_id,audit_id,task_id,conversation_id,intent_id,main_seg,runtime_id,turn_id,scope_key,
   worker_name,role,purpose,profile_id,profile_name,model,status,usage,quality,source,receipt_seq,created_at,finished_at)
 VALUES(rid,NEW.id,NEW.task_id,NEW.conversation_id,(identity->>'intentID')::bigint,(identity->>'mainSegment')::int,
   NEW.runtime_id,identity->>'turnID',COALESCE(NEW.runtime_id,identity->>'turnID',rid),(SELECT worker FROM activity WHERE node_id=(identity->>'intentID')::bigint ORDER BY id DESC LIMIT 1),NEW.role,NEW.purpose,
   NEW.profile_id,profile_label,NEW.model,NEW.status,NEW.usage,q,COALESCE(NEW.usage->>'_source','request_audit'),
   COALESCE((NEW.usage->>'_receipt_seq')::bigint,0),NEW.created_at,NEW.finished_at)
 ON CONFLICT(request_id) DO UPDATE SET status=EXCLUDED.status,usage=EXCLUDED.usage,quality=EXCLUDED.quality,
   receipt_seq=EXCLUDED.receipt_seq,finished_at=EXCLUDED.finished_at,source=EXCLUDED.source
 WHERE llm_usage_ledger.receipt_seq<=EXCLUDED.receipt_seq;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS request_usage_capture ON llm_request_attempts;
CREATE TRIGGER request_usage_capture AFTER INSERT OR UPDATE ON llm_request_attempts FOR EACH ROW EXECUTE FUNCTION capture_request_usage();

CREATE OR REPLACE FUNCTION capture_activity_usage() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE tid BIGINT; cid BIGINT; eid BIGINT; nid BIGINT; seg INT; identity JSONB; runtime TEXT; role_key TEXT; token_data JSONB; src TEXT; rid TEXT; namespace TEXT; q TEXT;
BEGIN
 IF TG_TABLE_NAME='activity' THEN
   eid:=NEW.exploration_id;SELECT id INTO tid FROM tasks WHERE exploration_id=eid;
   nid:=NEW.node_id;seg:=NEW.main_seg;namespace:='task:'||COALESCE(tid::text,NEW.exploration_id::text);
 ELSE
   cid:=NEW.conversation_id;SELECT task_id INTO tid FROM conversations WHERE id=cid;namespace:='conversation:'||cid;
 END IF;
 IF NEW.kind='result' AND NEW.input_tokens IS NOT NULL THEN
   token_data:=jsonb_build_object('input',NEW.input_tokens,'output',COALESCE(NEW.output_tokens,0),'cacheRead',COALESCE(NEW.cache_read_tokens,0),'cacheWrite',COALESCE(NEW.cache_write_tokens,0));
   src:='legacy_results';rid:='legacy:'||namespace||':'||NEW.id;q:='legacy_unknown';
 ELSIF NEW.metadata ? 'response' AND NEW.metadata ? 'stream_id' AND NEW.metadata->'response'->'usage' IS NOT NULL THEN
   token_data:=NEW.metadata->'response'->'usage';src:='native_response';rid:='native:'||namespace||':'||(NEW.metadata->>'stream_id');
   IF COALESCE((token_data->>'totalTokens')::numeric,0)=0 AND NEW.metadata->'response'->>'stop_reason' IN ('aborted','error') AND COALESCE(NEW.summary,'')='' THEN RETURN NEW;END IF;
   q:=CASE WHEN token_data ?& ARRAY['input','output','cacheRead','cacheWrite'] AND COALESCE((token_data->>'totalTokens')::numeric,0)>0 THEN 'complete' ELSE 'unknown' END;
 ELSE RETURN NEW;END IF;
 SELECT metadata INTO identity FROM (
   SELECT a.metadata,a.id FROM activity a WHERE TG_TABLE_NAME='activity' AND a.exploration_id=eid AND a.metadata->>'turn_id'=NEW.metadata->>'turn_id' AND a.metadata->>'event_type'='turn_start' AND a.created_at<=NEW.created_at
   UNION ALL SELECT a.metadata,a.id FROM conversation_activities a WHERE TG_TABLE_NAME='conversation_activities' AND a.conversation_id=cid AND a.metadata->>'turn_id'=NEW.metadata->>'turn_id' AND a.metadata->>'event_type'='turn_start' AND a.created_at<=NEW.created_at
 ) starts ORDER BY id DESC LIMIT 1;
 runtime:=identity->>'runtime_id';role_key:=COALESCE(identity->>'role',CASE WHEN NEW.worker='main' THEN 'mainagent' WHEN NEW.worker LIKE 'work#%' THEN 'worker' ELSE NEW.worker END,'unknown');
 IF src='legacy_results' AND runtime IS NOT NULL THEN q:='complete';END IF;
 INSERT INTO llm_usage_ledger(request_id,task_id,conversation_id,intent_id,main_seg,runtime_id,turn_id,scope_key,worker_name,role,model,status,usage,quality,input_semantics,source,created_at,finished_at)
 VALUES(rid,tid,cid,nid,seg,runtime,NEW.metadata->>'turn_id',COALESCE(runtime,NEW.metadata->>'turn_id',rid),NEW.worker,role_key,
   COALESCE(NEW.metadata->'response'->>'model','未记录模型'),'completed',token_data,q,CASE WHEN q='legacy_unknown' THEN 'unknown' ELSE 'exclusive_cache' END,src,NEW.created_at,NEW.created_at)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS activity_usage_capture ON activity;
CREATE TRIGGER activity_usage_capture AFTER INSERT ON activity FOR EACH ROW EXECUTE FUNCTION capture_activity_usage();
DROP TRIGGER IF EXISTS conversation_usage_capture ON conversation_activities;
CREATE TRIGGER conversation_usage_capture AFTER INSERT ON conversation_activities FOR EACH ROW EXECUTE FUNCTION capture_activity_usage();

-- Version-only read-model invalidation, no evidence bodies or per-client state.
CREATE TABLE IF NOT EXISTS stream_usage_versions(scope TEXT NOT NULL,scope_id BIGINT NOT NULL,version BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(scope,scope_id));
CREATE OR REPLACE FUNCTION bump_stream_usage_version() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
 IF TG_TABLE_NAME='runtime_role_configs' AND TG_OP='UPDATE' AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at THEN RETURN NEW;END IF;
 IF TG_OP='DELETE' THEN r:=OLD;ELSE r:=NEW;END IF;
 IF r.task_id IS NOT NULL THEN INSERT INTO stream_usage_versions VALUES('task',r.task_id,1) ON CONFLICT(scope,scope_id) DO UPDATE SET version=stream_usage_versions.version+1;END IF;
 IF r.conversation_id IS NOT NULL THEN INSERT INTO stream_usage_versions VALUES('conversation',r.conversation_id,1) ON CONFLICT(scope,scope_id) DO UPDATE SET version=stream_usage_versions.version+1;END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS stream_usage_version ON llm_usage_ledger;
CREATE TRIGGER stream_usage_version AFTER INSERT OR UPDATE OR DELETE ON llm_usage_ledger FOR EACH ROW EXECUTE FUNCTION bump_stream_usage_version();
DROP TRIGGER IF EXISTS stream_runtime_version ON runtime_role_configs;
CREATE TRIGGER stream_runtime_version AFTER INSERT OR UPDATE OR DELETE ON runtime_role_configs FOR EACH ROW EXECUTE FUNCTION bump_stream_usage_version();

-- Removing a graph node revokes its activity projection even without new usage.
CREATE OR REPLACE FUNCTION invalidate_deleted_node_stream() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stream_usage_versions(scope,scope_id,version)
 SELECT 'task',id,1 FROM tasks WHERE exploration_id=OLD.exploration_id
 ON CONFLICT(scope,scope_id) DO UPDATE SET version=stream_usage_versions.version+1;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS stream_node_deleted ON exploration_nodes;
CREATE TRIGGER stream_node_deleted AFTER DELETE ON exploration_nodes FOR EACH ROW EXECUTE FUNCTION invalidate_deleted_node_stream();
