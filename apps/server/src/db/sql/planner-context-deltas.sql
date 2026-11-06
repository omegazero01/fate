-- Immutable committed change batches. Coalesce only inside one transaction;
-- a Planner acknowledging an earlier batch must not hide a later asset edit.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS content_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE exploration_context_events ADD COLUMN IF NOT EXISTS subject_type TEXT;
ALTER TABLE exploration_context_events ADD COLUMN IF NOT EXISTS subject_id BIGINT;
ALTER TABLE exploration_context_events ADD COLUMN IF NOT EXISTS subject_version BIGINT;
ALTER TABLE exploration_context_events ADD COLUMN IF NOT EXISTS source_task_id BIGINT;
ALTER TABLE exploration_context_events ADD COLUMN IF NOT EXISTS changed_fields TEXT[];
ALTER TABLE exploration_context_events ADD COLUMN IF NOT EXISTS event_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS context_event_transaction_key ON exploration_context_events(exploration_id,event_key) WHERE event_key IS NOT NULL;

CREATE OR REPLACE FUNCTION version_asset_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-ARRAY['last_seen','updated_at','task_ids','content_version']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['last_seen','updated_at','task_ids','content_version']) THEN
  NEW.content_version:=OLD.content_version+1;
 ELSE NEW.content_version:=OLD.content_version;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS asset_content_version ON assets;
CREATE TRIGGER asset_content_version BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION version_asset_content();

CREATE OR REPLACE FUNCTION capture_asset_graph_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE tids BIGINT[]; origin_id BIGINT; target_task RECORD; aid BIGINT; ver BIGINT;
 stype TEXT; sid BIGINT; fields TEXT[]; old_json JSONB; new_json JSONB;
BEGIN
 IF current_setting('series.asset_repair',true)='on' THEN RETURN COALESCE(NEW,OLD); END IF;
 IF TG_TABLE_NAME='assets' THEN
  IF TG_OP='UPDATE' AND NEW.content_version=OLD.content_version THEN RETURN NULL; END IF;
  aid:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  ver:=CASE WHEN TG_OP='DELETE' THEN OLD.content_version ELSE NEW.content_version END;
  stype:='asset';sid:=aid;
  SELECT array_agg(task_id ORDER BY task_id) INTO tids FROM task_asset_links WHERE asset_id=aid;
  IF TG_OP='UPDATE' THEN
   old_json:=to_jsonb(OLD);new_json:=to_jsonb(NEW);
   SELECT array_agg(key ORDER BY key) INTO fields FROM jsonb_object_keys(new_json) key
    WHERE key<>ALL(ARRAY['last_seen','updated_at','task_ids','content_version']) AND old_json->key IS DISTINCT FROM new_json->key;
  ELSE fields:=ARRAY[lower(TG_OP)]; END IF;
 ELSIF TG_TABLE_NAME='tasks' THEN
  IF (OLD.coverage_enabled,OLD.deleted_at) IS NOT DISTINCT FROM (NEW.coverage_enabled,NEW.deleted_at) THEN RETURN NULL; END IF;
  tids:=ARRAY[NEW.id];stype:='task';sid:=NEW.id;fields:=ARRAY['coverage_or_visibility'];
 ELSE
  IF TG_TABLE_NAME='task_asset_links' AND TG_OP='UPDATE' AND
   (to_jsonb(OLD)-ARRAY['updated_at','notification_xid','tested','tested_at','tested_by']) IS NOT DISTINCT FROM
   (to_jsonb(NEW)-ARRAY['updated_at','notification_xid','tested','tested_at','tested_by']) THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['updated_at','notification_xid']) IS NOT DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['updated_at','notification_xid']) THEN RETURN NULL; END IF;
  tids:=CASE WHEN TG_OP='DELETE' THEN ARRAY[OLD.task_id] WHEN TG_OP='UPDATE' THEN ARRAY[OLD.task_id,NEW.task_id] ELSE ARRAY[NEW.task_id] END;
  IF TG_TABLE_NAME='task_asset_links' THEN
   stype:='asset';sid:=CASE WHEN TG_OP='DELETE' THEN OLD.asset_id ELSE NEW.asset_id END;
   SELECT content_version INTO ver FROM assets WHERE id=sid;
   fields:=ARRAY['task_link'];
  ELSIF TG_TABLE_NAME='task_scope' THEN
   stype:='scope';sid:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;fields:=ARRAY['scope'];
  ELSE
   stype:='source';sid:=CASE WHEN TG_OP='DELETE' THEN OLD.source_task_id ELSE NEW.source_task_id END;fields:=ARRAY['source_relation'];
  END IF;
 END IF;
 FOR origin_id IN SELECT DISTINCT unnest(tids) LOOP
  FOR target_task IN SELECT id,exploration_id FROM tasks WHERE deleted_at IS NULL AND
   (id=origin_id OR (TG_TABLE_NAME<>'task_relations' AND id IN(SELECT task_id FROM task_relations WHERE source_task_id=origin_id))) LOOP
   -- One wakeup/revision increment per task/transaction, independent of how
   -- many assets or fields the committed tool item changed.
   WITH saved AS (
    INSERT INTO blackboard_wakeups(exploration_id,event_key,kind)
     VALUES(target_task.exploration_id,'assets:'||pg_current_xact_id()::text,'assets_changed') ON CONFLICT DO NOTHING RETURNING id
   ) UPDATE explorations SET published_revision=published_revision+1
      WHERE id=target_task.exploration_id AND EXISTS(SELECT 1 FROM saved);
   INSERT INTO exploration_context_events(exploration_id,kind,subject_type,subject_id,subject_version,source_task_id,changed_fields,event_key)
    VALUES(target_task.exploration_id,'assets',stype,sid,ver,origin_id,fields,
      'assets:'||pg_current_xact_id()::text||':'||stype||':'||sid||':'||origin_id)
    ON CONFLICT(exploration_id,event_key) WHERE event_key IS NOT NULL DO UPDATE
     SET subject_version=GREATEST(exploration_context_events.subject_version,EXCLUDED.subject_version),
      changed_fields=ARRAY(SELECT DISTINCT unnest(exploration_context_events.changed_fields||EXCLUDED.changed_fields) ORDER BY 1);
  END LOOP;
 END LOOP;
 RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS asset_graph_delete ON assets;
CREATE TRIGGER asset_graph_delete BEFORE DELETE ON assets FOR EACH ROW EXECUTE FUNCTION capture_asset_graph_change();

-- A deleted node's FK is cleared, but its historical reference survives as
-- metadata. Do not rewrite old null-node notices into invented references.
CREATE OR REPLACE FUNCTION capture_exploration_context() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE eid BIGINT; nid BIGINT; event_kind TEXT; ver BIGINT; source_id BIGINT;
BEGIN
 IF TG_OP='DELETE' THEN eid:=OLD.exploration_id;nid:=OLD.id;ver:=OLD.content_version;event_kind:='node_deleted';
 ELSIF TG_OP='INSERT' OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.state IS DISTINCT FROM OLD.state OR NEW.content_version IS DISTINCT FROM OLD.content_version THEN
  eid:=NEW.exploration_id;nid:=NEW.id;ver:=NEW.content_version;event_kind:=NEW.kind;
 ELSE RETURN NEW;
 END IF;
 SELECT id INTO source_id FROM tasks WHERE exploration_id=eid;
 -- Summaries are a rebuildable index over original evidence. Thousands of
 -- derived members must not become thousands of repeated Planner inputs. This
 -- transaction-scoped notice is immutable after commit; later refreshes remain
 -- pending even if an earlier delivery is acknowledged concurrently.
 IF (TG_OP='DELETE' AND OLD.kind='digest') OR
    (TG_OP<>'DELETE' AND NEW.kind='digest' AND (TG_OP='INSERT' OR OLD.kind='digest')) THEN
  IF EXISTS(SELECT 1 FROM explorations WHERE id=eid) THEN
   INSERT INTO exploration_context_events(exploration_id,kind,subject_type,subject_id,source_task_id,changed_fields,event_key)
    SELECT target,'cold_summaries','index',eid,source_id,ARRAY['digest_index'],
      'cold_summaries:'||pg_current_xact_id()::text||':'||eid
    FROM (SELECT current.exploration_id target FROM tasks current
     WHERE (current.exploration_id=eid OR current.id IN(SELECT task_id FROM task_relations WHERE source_task_id=source_id)) AND current.deleted_at IS NULL
     UNION SELECT eid WHERE source_id IS NULL) recipients
    ON CONFLICT(exploration_id,event_key) WHERE event_key IS NOT NULL DO NOTHING;
  END IF;
  RETURN COALESCE(NEW,OLD);
 END IF;
 IF EXISTS(SELECT 1 FROM explorations WHERE id=eid) THEN
  INSERT INTO exploration_context_events(exploration_id,node_id,kind,subject_type,subject_id,subject_version,source_task_id)
   SELECT current.exploration_id,CASE WHEN TG_OP='DELETE' THEN NULL ELSE nid END,event_kind,'node',nid,ver,source_id
   FROM tasks current WHERE (current.exploration_id=eid OR current.id IN(SELECT task_id FROM task_relations WHERE source_task_id=source_id)) AND current.deleted_at IS NULL;
  -- Exploration-only fixtures and legacy unattached graphs remain compatible.
  IF source_id IS NULL THEN
   INSERT INTO exploration_context_events(exploration_id,node_id,kind,subject_type,subject_id,subject_version)
    VALUES(eid,CASE WHEN TG_OP='DELETE' THEN NULL ELSE nid END,event_kind,'node',nid,ver);
  END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
