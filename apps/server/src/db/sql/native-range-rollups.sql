-- Mixed audit/native fallback counts ALL response versions in execution ranges,
-- unlike the latest-stream presentation index. Keep numeric summaries only.
CREATE TABLE IF NOT EXISTS turn_native_range_state (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,ready BOOLEAN NOT NULL DEFAULT false,
 activity_version BIGINT NOT NULL DEFAULT 0,access_version BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,scope_id,turn_id)
);
CREATE TABLE IF NOT EXISTS turn_native_ranges (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,start_id BIGINT NOT NULL,next_id BIGINT,runtime_id TEXT,
 totals NUMERIC[] NOT NULL DEFAULT ARRAY[0,0,0,0,0]::numeric[],invalid BIGINT NOT NULL DEFAULT 0,dirty BOOLEAN NOT NULL DEFAULT true,
 PRIMARY KEY(scope,scope_id,turn_id,start_id)
);

-- Find the final visible boundary image. AFTER ROW triggers can see all changes
-- of a bulk statement before the other callbacks have updated derived ranges.
CREATE OR REPLACE FUNCTION repair_native_boundary(sc TEXT,sid BIGINT,aid BIGINT,tr TEXT,rid BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE prev BIGINT; nxt BIGINT; present BOOLEAN; runtime TEXT; prev_runtime TEXT;
BEGIN
 IF sc='task' THEN
  SELECT id,activity_presentation_metadata(metadata)->>'runtime_id' INTO prev,prev_runtime FROM activity a
   WHERE exploration_id=aid AND metadata->>'turn_id'=tr AND metadata->>'event_type'='turn_start' AND id<rid
    AND exploration_activity_readable(aid,a.node_id,a.metadata) ORDER BY id DESC LIMIT 1;
  SELECT id INTO nxt FROM activity a WHERE exploration_id=aid AND metadata->>'turn_id'=tr AND metadata->>'event_type'='turn_start'
   AND id>rid AND exploration_activity_readable(aid,a.node_id,a.metadata) ORDER BY id LIMIT 1;
  SELECT true,activity_presentation_metadata(metadata)->>'runtime_id' INTO present,runtime FROM activity a WHERE id=rid
   AND exploration_id=aid AND metadata->>'turn_id'=tr AND metadata->>'event_type'='turn_start' AND exploration_activity_readable(aid,a.node_id,a.metadata);
 ELSE
  SELECT id,activity_presentation_metadata(metadata)->>'runtime_id' INTO prev,prev_runtime FROM conversation_activities
   WHERE conversation_id=aid AND metadata->>'turn_id'=tr AND metadata->>'event_type'='turn_start' AND id<rid ORDER BY id DESC LIMIT 1;
  SELECT id INTO nxt FROM conversation_activities WHERE conversation_id=aid AND metadata->>'turn_id'=tr AND metadata->>'event_type'='turn_start' AND id>rid ORDER BY id LIMIT 1;
  SELECT true,activity_presentation_metadata(metadata)->>'runtime_id' INTO present,runtime FROM conversation_activities WHERE id=rid
   AND conversation_id=aid AND metadata->>'turn_id'=tr AND metadata->>'event_type'='turn_start';
 END IF;
 prev:=COALESCE(prev,0);
 DELETE FROM turn_native_ranges WHERE scope=sc AND scope_id=sid AND turn_id=tr AND start_id>prev
  AND (nxt IS NULL OR start_id<nxt) AND NOT(COALESCE(present,false) AND start_id=rid);
 INSERT INTO turn_native_ranges(scope,scope_id,turn_id,start_id,next_id,runtime_id) VALUES(sc,sid,tr,prev,CASE WHEN present THEN rid ELSE nxt END,prev_runtime)
  ON CONFLICT(scope,scope_id,turn_id,start_id) DO UPDATE SET next_id=EXCLUDED.next_id,runtime_id=EXCLUDED.runtime_id,dirty=true;
 IF present THEN
  INSERT INTO turn_native_ranges(scope,scope_id,turn_id,start_id,next_id,runtime_id) VALUES(sc,sid,tr,rid,nxt,runtime)
   ON CONFLICT(scope,scope_id,turn_id,start_id) DO UPDATE SET next_id=EXCLUDED.next_id,runtime_id=EXCLUDED.runtime_id,dirty=true;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION apply_native_range_delta(sc TEXT,sid BIGINT,tr TEXT,rid BIGINT,m JSONB,sign INT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE start BIGINT; v NUMERIC[];
BEGIN
 IF m->>'stream_id' IS NULL OR m->>'stream_id'='' OR m->'response' IS NULL
  OR m->'response' IN('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) THEN RETURN;END IF;
 SELECT start_id INTO start FROM turn_native_ranges WHERE scope=sc AND scope_id=sid AND turn_id=tr AND start_id<=rid ORDER BY start_id DESC LIMIT 1;
 v:=native_response_values(m);
 UPDATE turn_native_ranges SET totals=native_values_add(totals,v,sign),invalid=invalid+CASE WHEN v IS NULL THEN sign ELSE 0 END
  WHERE scope=sc AND scope_id=sid AND turn_id=tr AND start_id=start AND NOT dirty;
END $$;

CREATE OR REPLACE FUNCTION capture_native_range_rollup() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE sc TEXT; os BIGINT; ns BIGINT; oa BIGINT; na BIGINT; ot TEXT; nt TEXT; onid BIGINT; nnid BIGINT;
 sid BIGINT; aid BIGINT; tr TEXT; state turn_native_range_state; base turn_activity_rollups; current_access BIGINT;
 om JSONB; nm JSONB; old_here BOOLEAN; new_here BOOLEAN; old_start BOOLEAN; new_start BOOLEAN;
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
  -- Base grouping holds the same guard. Skip entirely before first mixed read.
  SELECT * INTO state FROM turn_native_range_state WHERE scope=sc AND scope_id=sid AND turn_id=tr;
  IF NOT FOUND OR NOT state.ready THEN CONTINUE;END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('activity-rollup:'||sc||':'||sid||':'||tr,0));
  SELECT * INTO state FROM turn_native_range_state WHERE scope=sc AND scope_id=sid AND turn_id=tr FOR UPDATE;
  SELECT * INTO base FROM turn_activity_rollups WHERE scope=sc AND scope_id=sid AND turn_id=tr;
  SELECT COALESCE((SELECT version FROM turn_read_versions WHERE scope=sc AND scope_id=sid AND kind='access' AND entity='all'),0) INTO current_access;
  IF NOT state.ready OR NOT COALESCE(base.ready,false) OR base.format_version<>2 OR state.access_version<>current_access OR base.access_version<>current_access THEN
   UPDATE turn_native_range_state SET ready=false WHERE scope=sc AND scope_id=sid AND turn_id=tr;CONTINUE;
  END IF;
  IF TG_OP<>'INSERT' AND om IS NULL THEN om:=activity_presentation_metadata(OLD.metadata);END IF;
  IF TG_OP<>'DELETE' AND nm IS NULL THEN nm:=activity_presentation_metadata(NEW.metadata);END IF;
  old_here:=TG_OP<>'INSERT' AND (os,ot)=(sid,tr) AND (sc<>'task' OR exploration_activity_readable(aid,onid,OLD.metadata));
  new_here:=TG_OP<>'DELETE' AND (ns,nt)=(sid,tr) AND (sc<>'task' OR exploration_activity_readable(aid,nnid,NEW.metadata));
  old_start:=COALESCE(old_here AND om->>'event_type'='turn_start',false);
  new_start:=COALESCE(new_here AND nm->>'event_type'='turn_start',false);
  IF old_start AND new_start AND OLD.id=NEW.id THEN
   -- Runtime identity changes coverage, not range contents.
   UPDATE turn_native_ranges SET runtime_id=nm->>'runtime_id' WHERE scope=sc AND scope_id=sid AND turn_id=tr AND start_id=NEW.id;
  ELSE
   IF old_start THEN PERFORM repair_native_boundary(sc,sid,aid,tr,OLD.id);END IF;
   IF new_start THEN PERFORM repair_native_boundary(sc,sid,aid,tr,NEW.id);END IF;
  END IF;
  IF old_here THEN PERFORM apply_native_range_delta(sc,sid,tr,OLD.id,om,-1);END IF;
  IF new_here THEN PERFORM apply_native_range_delta(sc,sid,tr,NEW.id,nm,1);END IF;
  UPDATE turn_native_range_state SET activity_version=base.activity_version WHERE scope=sc AND scope_id=sid AND turn_id=tr;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS zzzz_native_range_rollup ON activity;
CREATE TRIGGER zzzz_native_range_rollup AFTER INSERT OR UPDATE OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION capture_native_range_rollup();
DROP TRIGGER IF EXISTS zzzz_native_range_rollup ON conversation_activities;
CREATE TRIGGER zzzz_native_range_rollup AFTER INSERT OR UPDATE OR DELETE ON conversation_activities FOR EACH ROW EXECUTE FUNCTION capture_native_range_rollup();
