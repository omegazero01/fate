-- Rebuildable distinct-key counts and response references. No transcript bodies,
-- model text or usage authority are copied into this read model.
CREATE TABLE IF NOT EXISTS turn_activity_rollups (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,activity_id BIGINT NOT NULL,
 ready BOOLEAN NOT NULL DEFAULT false,format_version INT NOT NULL DEFAULT 2,activity_version BIGINT NOT NULL DEFAULT 0,access_version BIGINT NOT NULL DEFAULT 0,
 steps BIGINT NOT NULL DEFAULT 0,tools BIGINT NOT NULL DEFAULT 0,errors BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,scope_id,turn_id)
);
ALTER TABLE turn_activity_rollups ADD COLUMN IF NOT EXISTS format_version INT NOT NULL DEFAULT 0;
ALTER TABLE turn_activity_rollups ALTER COLUMN format_version SET DEFAULT 2;
CREATE TABLE IF NOT EXISTS turn_activity_groups (
 id BIGSERIAL PRIMARY KEY,scope TEXT NOT NULL,scope_id BIGINT NOT NULL,turn_id TEXT NOT NULL,
 category TEXT NOT NULL,key_hash TEXT NOT NULL,key_text TEXT NOT NULL,members BIGINT NOT NULL,
 first_id BIGINT NOT NULL,last_id BIGINT NOT NULL
);
-- Full key equality is always checked after the hash. A turn guard serializes
-- inserts, including hash collisions and identifiers too large for a B-tree key.
CREATE INDEX IF NOT EXISTS activity_group_identity ON turn_activity_groups(scope,scope_id,turn_id,category,key_hash);
CREATE INDEX IF NOT EXISTS activity_group_first ON turn_activity_groups(scope,scope_id,turn_id,category,first_id);
CREATE OR REPLACE FUNCTION activity_rollup_keys(entry_kind TEXT,call_id TEXT,failed BOOLEAN,meta JSONB)
RETURNS TABLE(category TEXT,key_text TEXT) LANGUAGE plpgsql IMMUTABLE AS $$
 BEGIN RETURN QUERY
 WITH projected AS MATERIALIZED (SELECT activity_presentation_metadata(meta) m)
 SELECT k.* FROM projected CROSS JOIN LATERAL (VALUES
  ('row','all'),
  ('response',CASE WHEN m->>'stream_id' IS NOT NULL AND m->>'stream_id'<>'' AND m->'response' IS NOT NULL
    AND m->'response' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) THEN m->>'stream_id' END),
  ('tool',CASE WHEN entry_kind='tool_use' THEN NULLIF(call_id,'') END),
  ('error',CASE WHEN entry_kind='tool_result' AND failed THEN NULLIF(call_id,'') END)
 ) k(category,key_text) WHERE k.key_text IS NOT NULL;
 END
$$;

CREATE OR REPLACE FUNCTION activity_group_bounds(sc TEXT,aid BIGINT,tr TEXT,cat TEXT,k TEXT)
RETURNS TABLE(first_id BIGINT,last_id BIGINT) LANGUAGE plpgsql AS $$
DECLARE tbl TEXT; col TEXT; predicate TEXT; access_filter TEXT; selection TEXT;
BEGIN
 tbl:=CASE WHEN sc='task' THEN 'activity' ELSE 'conversation_activities' END;
 col:=CASE WHEN sc='task' THEN 'exploration_id' ELSE 'conversation_id' END;
 access_filter:=CASE WHEN sc='task' THEN ' AND exploration_activity_readable($1,a.node_id,a.metadata)' ELSE '' END;
 predicate:=CASE WHEN cat='row' THEN 'true' WHEN cat='response' THEN
  'a.metadata ? ''stream_id'' AND a.metadata ? ''response'' AND md5(a.metadata->>''stream_id'')=md5($3) AND a.metadata->>''stream_id''=$3
   AND EXISTS(SELECT 1 FROM activity_rollup_keys(a.kind,a.tool_use_id,a.is_error,a.metadata) x WHERE x.category=''response'' AND x.key_text=$3 OFFSET 0)'
  WHEN cat='tool' THEN 'a.kind=''tool_use'' AND md5(a.tool_use_id)=md5($3) AND a.tool_use_id=$3'
  ELSE 'a.kind=''tool_result'' AND a.is_error AND md5(a.tool_use_id)=md5($3) AND a.tool_use_id=$3' END;
 selection:=format('SELECT a.id FROM %I a WHERE a.%I=$1 AND a.metadata->>''turn_id''=$2 AND %s%s ORDER BY a.id ',tbl,col,predicate,access_filter);
 RETURN QUERY EXECUTE 'SELECT ('||selection||'ASC LIMIT 1),('||selection||'DESC LIMIT 1)' USING aid,tr,k;
END $$;

-- The caller holds the turn guard. Delta is membership, not a distinct count.
CREATE OR REPLACE FUNCTION change_activity_group(sc TEXT,sid BIGINT,aid BIGINT,tr TEXT,cat TEXT,k TEXT,rid BIGINT,delta INT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE g turn_activity_groups; bounds RECORD;
BEGIN
 SELECT * INTO g FROM turn_activity_groups WHERE scope=sc AND scope_id=sid AND turn_id=tr AND category=cat AND key_hash=md5(k) AND key_text=k;
 IF NOT FOUND THEN
  IF delta<0 THEN UPDATE turn_activity_rollups SET ready=false WHERE scope=sc AND scope_id=sid AND turn_id=tr;RETURN 0;END IF;
  INSERT INTO turn_activity_groups(scope,scope_id,turn_id,category,key_hash,key_text,members,first_id,last_id) VALUES(sc,sid,tr,cat,md5(k),k,1,rid,rid);RETURN 1;
 END IF;
 IF delta<0 AND g.members=1 THEN DELETE FROM turn_activity_groups WHERE id=g.id;RETURN -1;END IF;
 IF delta<0 AND rid IN(g.first_id,g.last_id) THEN
  SELECT * INTO bounds FROM activity_group_bounds(sc,aid,tr,cat,k);
  -- AFTER row triggers see the final statement image. A bulk deletion may
  -- already have removed every original while later queued row triggers still
  -- owe membership decrements. Keep temporary refs until the last decrement
  -- deletes the group; no other transaction can see this intermediate state.
  UPDATE turn_activity_groups SET members=members-1,first_id=COALESCE(bounds.first_id,g.first_id),last_id=COALESCE(bounds.last_id,g.last_id) WHERE id=g.id;
 ELSIF delta<0 THEN
  -- Bounds may already describe the final statement image. A later queued
  -- deletion can then lie outside those bounds; never reintroduce its ID.
  UPDATE turn_activity_groups SET members=members-1 WHERE id=g.id;
 ELSE
  UPDATE turn_activity_groups SET members=members+delta,first_id=least(first_id,rid),last_id=greatest(last_id,rid) WHERE id=g.id;
 END IF;
 RETURN 0;
END $$;

CREATE OR REPLACE FUNCTION capture_activity_rollup() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE sc TEXT; os BIGINT; ns BIGINT; oa BIGINT; na BIGINT; onid BIGINT; nnid BIGINT; ot TEXT; nt TEXT;
 sid BIGINT; aid BIGINT; tr TEXT; g turn_activity_rollups; av BIGINT; access_v BIGINT; old_keys JSONB; new_keys JSONB; k JSONB;
 change_n INT; step_delta INT; tool_delta INT; error_delta INT;
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
  PERFORM pg_advisory_xact_lock(hashtextextended('activity-rollup:'||sc||':'||sid||':'||tr,0));
  INSERT INTO turn_activity_rollups(scope,scope_id,turn_id,activity_id) VALUES(sc,sid,tr,aid) ON CONFLICT DO NOTHING;
  SELECT * INTO g FROM turn_activity_rollups WHERE scope=sc AND scope_id=sid AND turn_id=tr FOR UPDATE;
  SELECT COALESCE((SELECT version FROM turn_read_versions WHERE scope=sc AND scope_id=sid AND kind='activity' AND entity=tr),0),
   COALESCE((SELECT version FROM turn_read_versions WHERE scope=sc AND scope_id=sid AND kind='access' AND entity='all'),0) INTO av,access_v;
  IF NOT g.ready THEN CONTINUE;END IF;
  IF g.format_version<>2 OR g.access_version<>access_v OR g.activity_id<>aid THEN UPDATE turn_activity_rollups SET ready=false WHERE scope=sc AND scope_id=sid AND turn_id=tr;CONTINUE;END IF;
  IF TG_OP='UPDATE' AND OLD.id=NEW.id AND (os,ot,onid) IS NOT DISTINCT FROM (ns,nt,nnid)
   AND OLD.metadata IS NOT DISTINCT FROM NEW.metadata AND (OLD.kind,OLD.tool_use_id,OLD.is_error) IS NOT DISTINCT FROM (NEW.kind,NEW.tool_use_id,NEW.is_error) THEN
   UPDATE turn_activity_rollups SET activity_version=av WHERE scope=sc AND scope_id=sid AND turn_id=tr;CONTINUE;
  END IF;
  old_keys:='[]';new_keys:='[]';step_delta:=0;tool_delta:=0;error_delta:=0;
  IF TG_OP<>'INSERT' AND (os,ot)=(sid,tr) AND (sc<>'task' OR exploration_activity_readable(oa,onid,OLD.metadata)) THEN
   SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY category,key_text),'[]') INTO old_keys FROM activity_rollup_keys(OLD.kind,OLD.tool_use_id,OLD.is_error,OLD.metadata) x;
  END IF;
  IF TG_OP<>'DELETE' AND (ns,nt)=(sid,tr) AND (sc<>'task' OR exploration_activity_readable(na,nnid,NEW.metadata)) THEN
   SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY category,key_text),'[]') INTO new_keys FROM activity_rollup_keys(NEW.kind,NEW.tool_use_id,NEW.is_error,NEW.metadata) x;
  END IF;
  IF TG_OP<>'UPDATE' OR OLD.id IS DISTINCT FROM NEW.id OR old_keys IS DISTINCT FROM new_keys THEN
   FOR k IN SELECT value FROM jsonb_array_elements(old_keys) WHERE TG_OP<>'UPDATE' OR OLD.id IS DISTINCT FROM NEW.id OR NOT(new_keys @> jsonb_build_array(value)) LOOP
    change_n:=change_activity_group(sc,sid,aid,tr,k->>'category',k->>'key_text',OLD.id,-1);
    IF k->>'category'='response' THEN step_delta:=step_delta+change_n;ELSIF k->>'category'='tool' THEN tool_delta:=tool_delta+change_n;ELSIF k->>'category'='error' THEN error_delta:=error_delta+change_n;END IF;
   END LOOP;
   FOR k IN SELECT value FROM jsonb_array_elements(new_keys) WHERE TG_OP<>'UPDATE' OR OLD.id IS DISTINCT FROM NEW.id OR NOT(old_keys @> jsonb_build_array(value)) LOOP
    change_n:=change_activity_group(sc,sid,aid,tr,k->>'category',k->>'key_text',NEW.id,1);
    IF k->>'category'='response' THEN step_delta:=step_delta+change_n;ELSIF k->>'category'='tool' THEN tool_delta:=tool_delta+change_n;ELSIF k->>'category'='error' THEN error_delta:=error_delta+change_n;END IF;
   END LOOP;
  END IF;
  UPDATE turn_activity_rollups SET activity_version=av,steps=steps+step_delta,tools=tools+tool_delta,errors=errors+error_delta WHERE scope=sc AND scope_id=sid AND turn_id=tr;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS zz_activity_rollup ON activity;
CREATE TRIGGER zz_activity_rollup AFTER INSERT OR UPDATE OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION capture_activity_rollup();
DROP TRIGGER IF EXISTS zz_conversation_rollup ON conversation_activities;
CREATE TRIGGER zz_conversation_rollup AFTER INSERT OR UPDATE OR DELETE ON conversation_activities FOR EACH ROW EXECUTE FUNCTION capture_activity_rollup();
