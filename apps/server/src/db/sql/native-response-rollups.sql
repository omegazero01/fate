-- Native-only presentation fallback. Originals and full model names remain in
-- activity; this index keeps only response refs, numeric sums and transitions.
CREATE TABLE IF NOT EXISTS turn_native_rollups (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,ready BOOLEAN NOT NULL DEFAULT false,
 activity_version BIGINT NOT NULL DEFAULT 0,access_version BIGINT NOT NULL DEFAULT 0,
 totals NUMERIC[] NOT NULL DEFAULT ARRAY[0,0,0,0,0]::numeric[],models BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,scope_id,turn_id)
);
CREATE TABLE IF NOT EXISTS turn_native_responses (
 group_id BIGINT PRIMARY KEY,scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,key_hash TEXT NOT NULL,key_text TEXT NOT NULL,
 first_id BIGINT NOT NULL,last_id BIGINT NOT NULL,totals NUMERIC[] NOT NULL,
 model_visible BOOLEAN NOT NULL,transition BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS native_response_identity ON turn_native_responses(scope,scope_id,turn_id,key_hash);
CREATE INDEX IF NOT EXISTS native_response_turn ON turn_native_responses(scope,scope_id,turn_id,first_id);
CREATE INDEX IF NOT EXISTS native_model_neighbors ON turn_native_responses(scope,scope_id,turn_id,first_id) WHERE model_visible;
CREATE INDEX IF NOT EXISTS native_model_page ON turn_native_responses(scope,scope_id,turn_id,first_id) WHERE transition;

-- known usage records, raw input/output/cache read/cache write. Preserve the
-- historical native fallback's raw sums; do not turn it into billed usage.
CREATE OR REPLACE FUNCTION native_response_values(m JSONB) RETURNS NUMERIC[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE u JSONB:=m#>'{response,usage}';
BEGIN
 RETURN ARRAY[CASE WHEN u ?| ARRAY['input','output','cacheRead','cacheWrite'] THEN 1 ELSE 0 END,
  COALESCE((u->>'input')::numeric,0),COALESCE((u->>'output')::numeric,0),COALESCE((u->>'cacheRead')::numeric,0),COALESCE((u->>'cacheWrite')::numeric,0)];
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION capture_native_response_rollup() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE sc TEXT; os BIGINT; ns BIGINT; oa BIGINT; na BIGINT; ot TEXT; nt TEXT; onid BIGINT; nnid BIGINT;
 sid BIGINT; aid BIGINT; tr TEXT; base turn_activity_rollups; native turn_native_rollups; current_access BIGINT; k TEXT;
BEGIN
 sc:=CASE WHEN TG_TABLE_NAME='activity' THEN 'task' ELSE 'conversation' END;
 IF TG_OP<>'INSERT' THEN
  ot:=OLD.metadata->>'turn_id';
  IF sc='task' THEN oa:=OLD.exploration_id;onid:=OLD.node_id;SELECT id INTO os FROM tasks WHERE exploration_id=oa;ELSE oa:=OLD.conversation_id;os:=oa;END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  nt:=NEW.metadata->>'turn_id';
  IF sc='task' THEN na:=NEW.exploration_id;nnid:=NEW.node_id;SELECT id INTO ns FROM tasks WHERE exploration_id=na;ELSE na:=NEW.conversation_id;ns:=na;END IF;
 END IF;
 FOR sid,tr,aid IN SELECT DISTINCT s,t,a FROM (VALUES(os,ot,oa),(ns,nt,na)) keys(s,t,a) WHERE s IS NOT NULL AND t IS NOT NULL ORDER BY s,t,a LOOP
  -- Base grouping already holds this same transaction guard. The explicit
  -- lock also protects lazy initialization if an older trigger was disabled.
  PERFORM pg_advisory_xact_lock(hashtextextended('activity-rollup:'||sc||':'||sid||':'||tr,0));
  SELECT * INTO native FROM turn_native_rollups WHERE scope=sc AND scope_id=sid AND turn_id=tr FOR UPDATE;
  IF NOT FOUND OR NOT native.ready THEN CONTINUE;END IF;
  SELECT * INTO base FROM turn_activity_rollups WHERE scope=sc AND scope_id=sid AND turn_id=tr;
  SELECT COALESCE((SELECT version FROM turn_read_versions WHERE scope=sc AND scope_id=sid AND kind='access' AND entity='all'),0) INTO current_access;
  IF NOT base.ready OR base.format_version<>2 OR native.access_version<>current_access OR base.access_version<>current_access THEN
   UPDATE turn_native_rollups SET ready=false WHERE scope=sc AND scope_id=sid AND turn_id=tr;CONTINUE;
  END IF;
  IF TG_OP<>'UPDATE' OR OLD.id IS DISTINCT FROM NEW.id OR OLD.metadata IS DISTINCT FROM NEW.metadata
   OR (os,ot,onid) IS DISTINCT FROM (ns,nt,nnid) THEN
   FOR k IN SELECT DISTINCT key_text FROM (
    SELECT x.key_text FROM activity_rollup_keys(OLD.kind,OLD.tool_use_id,OLD.is_error,OLD.metadata) x
     WHERE TG_OP<>'INSERT' AND (os,ot)=(sid,tr) AND x.category='response'
    UNION ALL
    SELECT x.key_text FROM activity_rollup_keys(NEW.kind,NEW.tool_use_id,NEW.is_error,NEW.metadata) x
     WHERE TG_OP<>'DELETE' AND (ns,nt)=(sid,tr) AND x.category='response'
   ) affected LOOP PERFORM sync_native_response(sc,sid,tr,k);END LOOP;
  END IF;
  UPDATE turn_native_rollups SET activity_version=base.activity_version WHERE scope=sc AND scope_id=sid AND turn_id=tr;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS zzz_native_response_rollup ON activity;
CREATE TRIGGER zzz_native_response_rollup AFTER INSERT OR UPDATE OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION capture_native_response_rollup();
DROP TRIGGER IF EXISTS zzz_native_response_rollup ON conversation_activities;
CREATE TRIGGER zzz_native_response_rollup AFTER INSERT OR UPDATE OR DELETE ON conversation_activities FOR EACH ROW EXECUTE FUNCTION capture_native_response_rollup();
CREATE OR REPLACE FUNCTION native_values_add(a NUMERIC[],b NUMERIC[],sign INT) RETURNS NUMERIC[] LANGUAGE SQL IMMUTABLE AS $$
 SELECT array_agg(COALESCE(a[i],0)+COALESCE(b[i],0)*sign ORDER BY i) FROM generate_series(1,5) i
$$;
CREATE OR REPLACE FUNCTION native_original_model(sc TEXT,rid BIGINT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE result TEXT;
BEGIN
 IF sc='task' THEN SELECT metadata#>>'{response,model}' INTO result FROM activity WHERE id=rid;
 ELSE SELECT metadata#>>'{response,model}' INTO result FROM conversation_activities WHERE id=rid;END IF;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION refresh_native_transition(gid BIGINT) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE r turn_native_responses; previous_id BIGINT; current_model TEXT; previous_model TEXT; changed BOOLEAN;
BEGIN
 SELECT * INTO r FROM turn_native_responses WHERE group_id=gid;IF NOT FOUND THEN RETURN 0;END IF;
 IF r.model_visible THEN
  SELECT last_id INTO previous_id FROM turn_native_responses WHERE scope=r.scope AND scope_id=r.scope_id AND turn_id=r.turn_id
   AND model_visible AND first_id<r.first_id ORDER BY first_id DESC LIMIT 1;
  current_model:=native_original_model(r.scope,r.last_id);previous_model:=native_original_model(r.scope,previous_id);
 END IF;
 changed:=r.model_visible AND current_model IS NOT NULL AND current_model<>'' AND current_model IS DISTINCT FROM previous_model;
 IF changed IS DISTINCT FROM r.transition THEN UPDATE turn_native_responses SET transition=changed WHERE group_id=gid;END IF;
 RETURN changed::int-r.transition::int;
END $$;

-- Base activity grouping has already processed this row. Updating one stream
-- can affect its own model transition and its previous/new immediate successor.
CREATE OR REPLACE FUNCTION sync_native_response(sc TEXT,sid BIGINT,tr TEXT,k TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE oldrow turn_native_responses; g turn_activity_groups; m JSONB; v NUMERIC[]; old_first BIGINT; new_first BIGINT;
 old_group BIGINT; delta BIGINT:=0; next_group BIGINT; visible BOOLEAN;
BEGIN
 SELECT * INTO oldrow FROM turn_native_responses WHERE scope=sc AND scope_id=sid AND turn_id=tr AND key_hash=md5(k) AND key_text=k;
 SELECT * INTO g FROM turn_activity_groups WHERE scope=sc AND scope_id=sid AND turn_id=tr AND category='response' AND key_hash=md5(k) AND key_text=k;
 old_first:=oldrow.first_id;old_group:=oldrow.group_id;
 IF g.id IS NOT NULL THEN
  IF sc='task' THEN SELECT activity_presentation_metadata(metadata) INTO m FROM activity WHERE id=g.last_id;
  ELSE SELECT activity_presentation_metadata(metadata) INTO m FROM conversation_activities WHERE id=g.last_id;END IF;
 END IF;
 IF m IS NOT NULL THEN
  v:=native_response_values(m);
  IF v IS NULL THEN UPDATE turn_native_rollups SET ready=false WHERE scope=sc AND scope_id=sid AND turn_id=tr;RETURN;END IF;
  visible:=(m#>>'{response,provider}') IS DISTINCT FROM 'series-router';new_first:=g.first_id;
 END IF;
 IF old_group IS NOT NULL THEN DELETE FROM turn_native_responses WHERE group_id=old_group;delta:=-oldrow.transition::int;END IF;
 IF m IS NOT NULL THEN
  INSERT INTO turn_native_responses(group_id,scope,scope_id,turn_id,key_hash,key_text,first_id,last_id,totals,model_visible)
   VALUES(g.id,sc,sid,tr,g.key_hash,g.key_text,g.first_id,g.last_id,v,visible);
  delta:=delta+refresh_native_transition(g.id);
 END IF;
 UPDATE turn_native_rollups SET totals=native_values_add(native_values_add(totals,oldrow.totals,-1),v,1) WHERE scope=sc AND scope_id=sid AND turn_id=tr;
 FOR next_group IN SELECT DISTINCT candidate FROM (
  (SELECT group_id candidate FROM turn_native_responses WHERE scope=sc AND scope_id=sid AND turn_id=tr AND model_visible AND first_id>=old_first AND group_id IS DISTINCT FROM g.id ORDER BY first_id LIMIT 1)
  UNION ALL
  (SELECT group_id FROM turn_native_responses WHERE scope=sc AND scope_id=sid AND turn_id=tr AND model_visible AND first_id>new_first ORDER BY first_id LIMIT 1)
 ) candidates LOOP delta:=delta+refresh_native_transition(next_group);END LOOP;
 UPDATE turn_native_rollups SET models=models+delta WHERE scope=sc AND scope_id=sid AND turn_id=tr;
END $$;
