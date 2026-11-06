-- Rebuildable execution aggregates. Raw receipts remain solely in llm_usage_ledger.
CREATE OR REPLACE FUNCTION usage_rollup_key(t BIGINT,c BIGINT,s TEXT,src TEXT,tr TEXT,r TEXT)
RETURNS JSONB LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
 SELECT jsonb_build_array(t,c,s,CASE WHEN src IN('provider','request_audit') THEN 'physical' ELSE src END,tr,r)
$$;
CREATE TABLE IF NOT EXISTS usage_execution_rollups (
 identity JSONB PRIMARY KEY,task_id BIGINT,conversation_id BIGINT,scope_key TEXT NOT NULL,source_class TEXT NOT NULL,
 turn_id TEXT,runtime_id TEXT,ready BOOLEAN NOT NULL DEFAULT false,
 totals NUMERIC[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0,0,0,0,0,0]::numeric[],
 models BIGINT NOT NULL DEFAULT 0,finished_at TIMESTAMPTZ
);
ALTER TABLE usage_execution_rollups ADD COLUMN IF NOT EXISTS roles_ready BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE usage_execution_rollups ADD COLUMN IF NOT EXISTS attempts_ready BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE usage_execution_rollups ADD COLUMN IF NOT EXISTS attempt_totals NUMERIC[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0]::numeric[];
CREATE TABLE IF NOT EXISTS usage_rollup_roles (
 identity JSONB NOT NULL,role TEXT NOT NULL,receipts BIGINT NOT NULL,PRIMARY KEY(identity,role)
);
CREATE INDEX IF NOT EXISTS usage_rollup_task_turn ON usage_execution_rollups(task_id,turn_id);
CREATE INDEX IF NOT EXISTS usage_rollup_conv_turn ON usage_execution_rollups(conversation_id,turn_id);
CREATE INDEX IF NOT EXISTS usage_rollup_runtime ON usage_execution_rollups(runtime_id);
CREATE INDEX IF NOT EXISTS usage_rollup_task_scope ON usage_execution_rollups(task_id,scope_key);
CREATE INDEX IF NOT EXISTS usage_rollup_conv_scope ON usage_execution_rollups(conversation_id,scope_key);
CREATE TABLE IF NOT EXISTS usage_model_transitions (
 identity JSONB NOT NULL,request_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(identity,request_id)
);
CREATE INDEX IF NOT EXISTS usage_model_transition_order ON usage_model_transitions(identity,created_at,request_id);
CREATE TABLE IF NOT EXISTS turn_usage_rollup_initialized (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,PRIMARY KEY(scope,scope_id,turn_id)
);
CREATE INDEX IF NOT EXISTS usage_rollup_receipt_order ON llm_usage_ledger
 (usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id),created_at,request_id);
CREATE INDEX IF NOT EXISTS usage_rollup_receipt_finished ON llm_usage_ledger
 (usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id),finished_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS usage_rollup_receipt_role_order ON llm_usage_ledger
 (usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id),role,created_at,request_id);

-- n, inclusive input, uncached input, output, cache read/write, incomplete,
-- compaction calls/tokens and failed calls/tokens. Matches USAGE_SUM_SQL and
-- the attempt-specific raw sums (which intentionally do not clamp negatives).
CREATE OR REPLACE FUNCTION usage_rollup_values(r llm_usage_ledger)
RETURNS NUMERIC[] LANGUAGE SQL IMMUTABLE AS $$
 SELECT ARRAY[1,
 CASE WHEN r.usage->>'_input_total_known'='true' THEN (r.usage->>'inputTotal')::bigint
  ELSE greatest(0,COALESCE((r.usage->>'input')::bigint,0))+CASE WHEN r.input_semantics='exclusive_cache' THEN
   greatest(0,COALESCE((r.usage->>'cacheRead')::bigint,0))+greatest(0,COALESCE((r.usage->>'cacheWrite')::bigint,0)) ELSE 0 END END,
 CASE WHEN r.input_semantics='exclusive_cache' THEN greatest(0,COALESCE((r.usage->>'input')::bigint,0)) ELSE 0 END,
 greatest(0,COALESCE((r.usage->>'output')::bigint,0)),greatest(0,COALESCE((r.usage->>'cacheRead')::bigint,0)),greatest(0,COALESCE((r.usage->>'cacheWrite')::bigint,0)),
 CASE WHEN r.quality IN('complete','not_sent') THEN 0 ELSE 1 END,
 CASE WHEN r.purpose='compaction' THEN 1 ELSE 0 END,CASE WHEN r.purpose='compaction' THEN raw_tokens ELSE 0 END,
 CASE WHEN r.status IN('failed','aborted') THEN 1 ELSE 0 END,CASE WHEN r.status IN('failed','aborted') THEN raw_tokens ELSE 0 END]::numeric[]
 FROM (SELECT COALESCE((r.usage->>'input')::numeric,0)+COALESCE((r.usage->>'output')::numeric,0)+
 COALESCE((r.usage->>'cacheRead')::numeric,0)+COALESCE((r.usage->>'cacheWrite')::numeric,0) raw_tokens) n
$$;
CREATE OR REPLACE FUNCTION usage_rollup_add(a NUMERIC[],b NUMERIC[],sign INT)
RETURNS NUMERIC[] LANGUAGE SQL IMMUTABLE AS $$ SELECT array_agg(COALESCE(a[i],0)+COALESCE(b[i],0)*sign ORDER BY i) FROM generate_series(1,11) i $$;

-- Raw runtime-owned attempt fallback differs from billed turn attribution.
-- known, input/output/cache read/cache write, incomplete. Never clamp these
-- historical raw sums or infer a missing turn ID from a runtime marker.
CREATE OR REPLACE FUNCTION usage_attempt_values(r llm_usage_ledger) RETURNS NUMERIC[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE raw_total NUMERIC;
BEGIN
 raw_total:=COALESCE((r.usage->>'input')::numeric,0)+COALESCE((r.usage->>'output')::numeric,0)
  +COALESCE((r.usage->>'cacheRead')::numeric,0)+COALESCE((r.usage->>'cacheWrite')::numeric,0);
 RETURN ARRAY[CASE WHEN r.usage ?| ARRAY['input','output','cacheRead','cacheWrite'] THEN 1 ELSE 0 END,
  COALESCE((r.usage->>'input')::numeric,0),COALESCE((r.usage->>'output')::numeric,0),
  COALESCE((r.usage->>'cacheRead')::numeric,0),COALESCE((r.usage->>'cacheWrite')::numeric,0),
  CASE WHEN r.status='running' OR r.quality NOT IN('complete','not_sent') OR COALESCE((r.usage->>'unavailable')::boolean,false)
   OR r.usage='{}'::jsonb OR r.status IN('failed','aborted') AND raw_total=0 THEN 1 ELSE 0 END];
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION usage_attempt_add(a NUMERIC[],b NUMERIC[],sign INT) RETURNS NUMERIC[] LANGUAGE SQL IMMUTABLE AS $$
 SELECT array_agg(COALESCE(a[i],0)+COALESCE(b[i],0)*sign ORDER BY i) FROM generate_series(1,6) i
$$;

CREATE OR REPLACE FUNCTION refresh_usage_model_transition(k JSONB,rid TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE r RECORD; previous TEXT; added INT; removed INT;
BEGIN
 SELECT * INTO r FROM llm_usage_ledger WHERE request_id=rid
  AND usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=k;
 IF NOT FOUND THEN RETURN 0;END IF;
 SELECT model INTO previous FROM llm_usage_ledger
  WHERE usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=k
   AND (created_at,request_id)<(r.created_at,r.request_id) ORDER BY created_at DESC,request_id DESC LIMIT 1;
 IF r.model<>'' AND r.model IS DISTINCT FROM previous THEN
  INSERT INTO usage_model_transitions VALUES(k,r.request_id,r.created_at) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS added=ROW_COUNT;RETURN added;
 END IF;
 DELETE FROM usage_model_transitions WHERE identity=k AND request_id=rid;
 GET DIAGNOSTICS removed=ROW_COUNT;RETURN -removed;
END $$;
CREATE OR REPLACE FUNCTION capture_usage_rollup() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE oldkey JSONB; newkey JSONB; k JSONB; active BOOLEAN; r llm_usage_ledger; rid TEXT; delta BIGINT; removed INT;
 values_now NUMERIC[]; last_finished TIMESTAMPTZ; model_changed BOOLEAN; time_changed BOOLEAN; roles_active BOOLEAN;
 attempts_active BOOLEAN; attempt_values_now NUMERIC[]; old_attempt NUMERIC[]; new_attempt NUMERIC[];
BEGIN
 IF TG_OP<>'INSERT' THEN oldkey:=usage_rollup_key(OLD.task_id,OLD.conversation_id,OLD.scope_key,OLD.source,OLD.turn_id,OLD.runtime_id);END IF;
 IF TG_OP<>'DELETE' THEN newkey:=usage_rollup_key(NEW.task_id,NEW.conversation_id,NEW.scope_key,NEW.source,NEW.turn_id,NEW.runtime_id);END IF;
 model_changed:=TG_OP<>'UPDATE' OR (oldkey,OLD.request_id,OLD.created_at,OLD.model) IS DISTINCT FROM (newkey,NEW.request_id,NEW.created_at,NEW.model);
 time_changed:=TG_OP<>'UPDATE' OR (oldkey,OLD.finished_at) IS DISTINCT FROM (newkey,NEW.finished_at);
 -- A fixed order also covers a correction which moves a receipt across groups.
 FOR k IN SELECT DISTINCT x FROM unnest(ARRAY[oldkey,newkey]) x WHERE x IS NOT NULL ORDER BY x LOOP
  IF k=newkey THEN r:=NEW;ELSE r:=OLD;END IF;
  INSERT INTO usage_execution_rollups(identity,task_id,conversation_id,scope_key,source_class,turn_id,runtime_id)
   VALUES(k,r.task_id,r.conversation_id,r.scope_key,k->>3,r.turn_id,r.runtime_id) ON CONFLICT DO NOTHING;
  SELECT ready,totals,finished_at,roles_ready,attempts_ready,attempt_totals INTO active,values_now,last_finished,roles_active,attempts_active,attempt_values_now FROM usage_execution_rollups WHERE identity=k FOR UPDATE;
  -- Historic groups initialize lazily under this same lock. Never publish a
  -- partial sum of old receipts, or scan history in a live writer's transaction.
  IF NOT active THEN CONTINUE;END IF;
  IF attempts_active THEN
   IF k=oldkey THEN old_attempt:=usage_attempt_values(OLD);IF old_attempt IS NULL THEN attempts_active:=false;ELSE attempt_values_now:=usage_attempt_add(attempt_values_now,old_attempt,-1);END IF;END IF;
   IF k=newkey THEN new_attempt:=usage_attempt_values(NEW);IF new_attempt IS NULL THEN attempts_active:=false;ELSE attempt_values_now:=usage_attempt_add(attempt_values_now,new_attempt,1);END IF;END IF;
  END IF;
  IF roles_active AND (TG_OP<>'UPDATE' OR (oldkey,OLD.role) IS DISTINCT FROM (newkey,NEW.role)) THEN
   IF k=oldkey THEN UPDATE usage_rollup_roles SET receipts=receipts-1 WHERE identity=k AND role=OLD.role;END IF;
   IF k=newkey THEN INSERT INTO usage_rollup_roles VALUES(k,NEW.role,1)
    ON CONFLICT(identity,role) DO UPDATE SET receipts=usage_rollup_roles.receipts+1;END IF;
  END IF;
  delta:=0;
  IF k=oldkey THEN
   values_now:=usage_rollup_add(values_now,usage_rollup_values(OLD),-1);
   IF model_changed THEN
    DELETE FROM usage_model_transitions WHERE identity=k AND request_id=OLD.request_id;
    GET DIAGNOSTICS removed=ROW_COUNT;delta:=delta-removed;
   END IF;
  END IF;
  IF k=newkey THEN
   values_now:=usage_rollup_add(values_now,usage_rollup_values(NEW),1);
   IF model_changed THEN delta:=delta+refresh_usage_model_transition(k,NEW.request_id);END IF;
  END IF;
  -- Removing/reordering/changing a model can only change its immediate successor.
  IF model_changed THEN FOR rid IN SELECT DISTINCT candidate FROM (
   (SELECT request_id candidate FROM llm_usage_ledger WHERE k=oldkey
    AND usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=k
    AND (created_at,request_id)>(OLD.created_at,OLD.request_id) ORDER BY created_at,request_id LIMIT 1)
   UNION ALL
   (SELECT request_id FROM llm_usage_ledger WHERE k=newkey
    AND usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=k
    AND (created_at,request_id)>(NEW.created_at,NEW.request_id) ORDER BY created_at,request_id LIMIT 1)
  ) candidates LOOP delta:=delta+refresh_usage_model_transition(k,rid);END LOOP;END IF;
  IF time_changed THEN SELECT finished_at INTO last_finished FROM llm_usage_ledger
   WHERE usage_rollup_key(task_id,conversation_id,scope_key,source,turn_id,runtime_id)=k ORDER BY finished_at DESC NULLS LAST LIMIT 1;END IF;
  UPDATE usage_execution_rollups SET totals=values_now,models=models+delta,finished_at=last_finished,
   attempts_ready=attempts_active,attempt_totals=attempt_values_now WHERE identity=k;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS zz_usage_rollup ON llm_usage_ledger;
CREATE TRIGGER zz_usage_rollup AFTER INSERT OR UPDATE OR DELETE ON llm_usage_ledger FOR EACH ROW EXECUTE FUNCTION capture_usage_rollup();

-- A turn can resume into several executions whose timestamps interleave. A
-- per-turn selected model sequence stores only original request references.
-- Source selection is compared exactly at read time; changed membership cannot
-- silently use a previous sequence. Rebuilds are lazy, not in live writers.
CREATE TABLE IF NOT EXISTS usage_turn_model_views (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,
 selection JSONB NOT NULL,models BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,scope_id,turn_id)
);
CREATE TABLE IF NOT EXISTS usage_turn_model_members (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,identity JSONB NOT NULL,
 PRIMARY KEY(scope,scope_id,turn_id,identity)
);
CREATE INDEX IF NOT EXISTS usage_turn_model_member ON usage_turn_model_members(identity,scope,scope_id,turn_id);
CREATE TABLE IF NOT EXISTS usage_turn_model_transitions (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,request_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(scope,scope_id,turn_id,request_id)
);
CREATE INDEX IF NOT EXISTS usage_turn_model_order ON usage_turn_model_transitions(scope,scope_id,turn_id,created_at,request_id);

CREATE OR REPLACE FUNCTION usage_turn_model_neighbor(sc TEXT,sid BIGINT,tr TEXT,at_time TIMESTAMPTZ,rid TEXT,forward BOOLEAN)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE result TEXT;
BEGIN
 IF forward THEN
  SELECT p.request_id INTO result FROM usage_turn_model_members m CROSS JOIN LATERAL (
   SELECT l.request_id,l.created_at FROM llm_usage_ledger l
   WHERE usage_rollup_key(l.task_id,l.conversation_id,l.scope_key,l.source,l.turn_id,l.runtime_id)=m.identity
    AND (l.created_at,l.request_id)>(at_time,rid) ORDER BY l.created_at,l.request_id LIMIT 1
  ) p WHERE m.scope=sc AND m.scope_id=sid AND m.turn_id=tr ORDER BY p.created_at,p.request_id LIMIT 1;
 ELSE
  SELECT p.request_id INTO result FROM usage_turn_model_members m CROSS JOIN LATERAL (
   SELECT l.request_id,l.created_at FROM llm_usage_ledger l
   WHERE usage_rollup_key(l.task_id,l.conversation_id,l.scope_key,l.source,l.turn_id,l.runtime_id)=m.identity
    AND (l.created_at,l.request_id)<(at_time,rid) ORDER BY l.created_at DESC,l.request_id DESC LIMIT 1
  ) p WHERE m.scope=sc AND m.scope_id=sid AND m.turn_id=tr ORDER BY p.created_at DESC,p.request_id DESC LIMIT 1;
 END IF;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION refresh_usage_turn_model(sc TEXT,sid BIGINT,tr TEXT,rid TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE r RECORD; previous TEXT; previous_id TEXT; changed INT;
BEGIN
 SELECT l.* INTO r FROM llm_usage_ledger l WHERE request_id=rid AND EXISTS(
  SELECT 1 FROM usage_turn_model_members m WHERE m.scope=sc AND m.scope_id=sid AND m.turn_id=tr
   AND m.identity=usage_rollup_key(l.task_id,l.conversation_id,l.scope_key,l.source,l.turn_id,l.runtime_id));
 IF NOT FOUND THEN RETURN 0;END IF;
 -- Materialize the volatile neighbor call ONCE. A volatile function in the
 -- WHERE clause prevents the primary-key probe and runs once per ledger row.
 previous_id:=usage_turn_model_neighbor(sc,sid,tr,r.created_at,r.request_id,false);
 SELECT model INTO previous FROM llm_usage_ledger WHERE request_id=previous_id;
 IF r.model<>'' AND r.model IS DISTINCT FROM previous THEN
  INSERT INTO usage_turn_model_transitions VALUES(sc,sid,tr,r.request_id,r.created_at) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed=ROW_COUNT;RETURN changed;
 END IF;
 DELETE FROM usage_turn_model_transitions WHERE scope=sc AND scope_id=sid AND turn_id=tr AND request_id=rid;
 GET DIAGNOSTICS changed=ROW_COUNT;RETURN -changed;
END $$;
CREATE OR REPLACE FUNCTION capture_usage_turn_models() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE oldkey JSONB; newkey JSONB; v RECORD; rid TEXT; delta BIGINT; removed INT;
BEGIN
 IF TG_OP<>'INSERT' THEN oldkey:=usage_rollup_key(OLD.task_id,OLD.conversation_id,OLD.scope_key,OLD.source,OLD.turn_id,OLD.runtime_id);END IF;
 IF TG_OP<>'DELETE' THEN newkey:=usage_rollup_key(NEW.task_id,NEW.conversation_id,NEW.scope_key,NEW.source,NEW.turn_id,NEW.runtime_id);END IF;
 IF TG_OP='UPDATE' AND (oldkey,OLD.request_id,OLD.created_at,OLD.model) IS NOT DISTINCT FROM (newkey,NEW.request_id,NEW.created_at,NEW.model) THEN RETURN NULL;END IF;
 FOR v IN SELECT DISTINCT scope,scope_id,turn_id FROM usage_turn_model_members
  WHERE identity=oldkey OR identity=newkey ORDER BY scope,scope_id,turn_id LOOP
  -- Writers already hold their execution group locks; bootstrap follows the
  -- same group -> view lock order and skips busy views.
  PERFORM 1 FROM usage_turn_model_views WHERE scope=v.scope AND scope_id=v.scope_id AND turn_id=v.turn_id FOR UPDATE;
  IF NOT FOUND THEN CONTINUE;END IF;
  delta:=0;
  IF oldkey IS NOT NULL THEN
   DELETE FROM usage_turn_model_transitions WHERE scope=v.scope AND scope_id=v.scope_id AND turn_id=v.turn_id AND request_id=OLD.request_id;
   GET DIAGNOSTICS removed=ROW_COUNT;delta:=delta-removed;
  END IF;
  IF newkey IS NOT NULL THEN delta:=delta+refresh_usage_turn_model(v.scope,v.scope_id,v.turn_id,NEW.request_id);END IF;
  FOR rid IN SELECT DISTINCT x FROM unnest(ARRAY[
   CASE WHEN oldkey IS NOT NULL THEN usage_turn_model_neighbor(v.scope,v.scope_id,v.turn_id,OLD.created_at,OLD.request_id,true) END,
   CASE WHEN newkey IS NOT NULL THEN usage_turn_model_neighbor(v.scope,v.scope_id,v.turn_id,NEW.created_at,NEW.request_id,true) END
  ]) x WHERE x IS NOT NULL LOOP delta:=delta+refresh_usage_turn_model(v.scope,v.scope_id,v.turn_id,rid);END LOOP;
  UPDATE usage_turn_model_views SET models=models+delta WHERE scope=v.scope AND scope_id=v.scope_id AND turn_id=v.turn_id;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS zzz_usage_turn_models ON llm_usage_ledger;
CREATE TRIGGER zzz_usage_turn_models AFTER INSERT OR UPDATE OR DELETE ON llm_usage_ledger FOR EACH ROW EXECUTE FUNCTION capture_usage_turn_models();
