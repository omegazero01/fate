-- Rebuildable read-side state. These revisions never acknowledge events or
-- affect scheduling; they invalidate projections at the same commit as writes.
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS view_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS view_revision_xid xid8;
CREATE TABLE IF NOT EXISTS exploration_node_counts (
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,state TEXT NOT NULL,n BIGINT NOT NULL CHECK(n>=0),
 PRIMARY KEY(exploration_id,kind,state)
);
CREATE TABLE IF NOT EXISTS graph_projection_migrations(version INT PRIMARY KEY);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM graph_projection_migrations WHERE version=1) THEN
  INSERT INTO exploration_node_counts SELECT exploration_id,kind,state,count(*) FROM exploration_nodes GROUP BY exploration_id,kind,state
   ON CONFLICT(exploration_id,kind,state) DO UPDATE SET n=EXCLUDED.n;
  INSERT INTO graph_projection_migrations VALUES(1);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION update_node_projection_counts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change RECORD;eids BIGINT[];
BEGIN
 -- Transition tables aggregate one SQL statement. A bulk import must not
 -- create thousands of HOT versions of the same tiny counter row.
 IF TG_OP='INSERT' THEN SELECT array_agg(DISTINCT exploration_id) INTO eids FROM projection_new;
 ELSIF TG_OP='DELETE' THEN SELECT array_agg(DISTINCT exploration_id) INTO eids FROM projection_old;
 ELSE
  SELECT array_agg(DISTINCT eid) INTO eids FROM (
   SELECT unnest(ARRAY[o.exploration_id,n.exploration_id]) eid FROM projection_old o FULL JOIN projection_new n USING(id)
   WHERE (o.exploration_id,o.kind,o.state,o.content_version,o.report_revision,o.priority,o.owner,o.queue_position)
    IS DISTINCT FROM (n.exploration_id,n.kind,n.state,n.content_version,n.report_revision,n.priority,n.owner,n.queue_position)
  ) changed WHERE eid IS NOT NULL;
 END IF;
 PERFORM id FROM explorations WHERE id=ANY(eids) AND view_revision_xid IS DISTINCT FROM pg_current_xact_id() ORDER BY id FOR UPDATE;
 UPDATE explorations SET view_revision=view_revision+1,view_revision_xid=pg_current_xact_id()
  WHERE id=ANY(eids) AND view_revision_xid IS DISTINCT FROM pg_current_xact_id();
 IF TG_OP='INSERT' THEN
  INSERT INTO exploration_node_counts SELECT exploration_id,kind,state,count(*) FROM projection_new GROUP BY exploration_id,kind,state ORDER BY exploration_id,kind,state
   ON CONFLICT(exploration_id,kind,state) DO UPDATE SET n=exploration_node_counts.n+EXCLUDED.n;
 ELSIF TG_OP='DELETE' THEN
  FOR change IN SELECT exploration_id,kind,state,count(*) n FROM projection_old GROUP BY exploration_id,kind,state ORDER BY exploration_id,kind,state LOOP
   UPDATE exploration_node_counts SET n=n-change.n WHERE exploration_id=change.exploration_id AND kind=change.kind AND state=change.state;
  END LOOP;
 ELSE
  FOR change IN SELECT exploration_id,kind,state,sum(delta)::bigint n FROM (
   SELECT exploration_id,kind,state,count(*) delta FROM projection_new GROUP BY exploration_id,kind,state
   UNION ALL SELECT exploration_id,kind,state,-count(*) FROM projection_old GROUP BY exploration_id,kind,state
  ) d GROUP BY exploration_id,kind,state HAVING sum(delta)<>0 ORDER BY exploration_id,kind,state LOOP
   IF change.n>0 THEN
    INSERT INTO exploration_node_counts VALUES(change.exploration_id,change.kind,change.state,change.n)
     ON CONFLICT(exploration_id,kind,state) DO UPDATE SET n=exploration_node_counts.n+EXCLUDED.n;
   ELSE
    UPDATE exploration_node_counts SET n=n+change.n WHERE exploration_id=change.exploration_id AND kind=change.kind AND state=change.state;
   END IF;
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS projection_node_counts ON exploration_nodes;
DROP TRIGGER IF EXISTS projection_revision ON exploration_nodes;
DROP TRIGGER IF EXISTS projection_counts_insert ON exploration_nodes;
CREATE TRIGGER projection_counts_insert AFTER INSERT ON exploration_nodes REFERENCING NEW TABLE AS projection_new FOR EACH STATEMENT EXECUTE FUNCTION update_node_projection_counts();
DROP TRIGGER IF EXISTS projection_counts_update ON exploration_nodes;
CREATE TRIGGER projection_counts_update AFTER UPDATE ON exploration_nodes REFERENCING OLD TABLE AS projection_old NEW TABLE AS projection_new FOR EACH STATEMENT EXECUTE FUNCTION update_node_projection_counts();
DROP TRIGGER IF EXISTS projection_counts_delete ON exploration_nodes;
CREATE TRIGGER projection_counts_delete AFTER DELETE ON exploration_nodes REFERENCING OLD TABLE AS projection_old FOR EACH STATEMENT EXECUTE FUNCTION update_node_projection_counts();

CREATE OR REPLACE FUNCTION invalidate_graph_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eids BIGINT[];tids BIGINT[];roots TEXT[];company BIGINT;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME IN('exploration_nodes','exploration_edges','planner_decisions') THEN
  eids:=CASE WHEN TG_OP='DELETE' THEN ARRAY[OLD.exploration_id] WHEN TG_OP='INSERT' THEN ARRAY[NEW.exploration_id] ELSE ARRAY[OLD.exploration_id,NEW.exploration_id] END;
 ELSIF TG_TABLE_NAME='exploration_anchors' THEN
  SELECT array_agg(DISTINCT exploration_id) INTO eids FROM exploration_nodes WHERE id=ANY(
   CASE WHEN TG_OP='DELETE' THEN ARRAY[OLD.node_id] WHEN TG_OP='INSERT' THEN ARRAY[NEW.node_id] ELSE ARRAY[OLD.node_id,NEW.node_id] END);
 ELSIF TG_TABLE_NAME='assets' THEN
  -- last_seen alone doesn't change counts, scope membership or graph summaries.
  IF TG_OP='UPDATE' AND NEW.content_version=OLD.content_version THEN RETURN NULL; END IF;
  roots:=CASE WHEN TG_OP='DELETE' THEN CASE WHEN OLD.type='root_domain' THEN ARRAY[OLD.domain] END
   WHEN TG_OP='INSERT' THEN CASE WHEN NEW.type='root_domain' THEN ARRAY[NEW.domain] END
   ELSE ARRAY[CASE WHEN OLD.type='root_domain' THEN OLD.domain END,CASE WHEN NEW.type='root_domain' THEN NEW.domain END] END;
  SELECT array_agg(DISTINCT task_id) INTO tids FROM task_asset_links WHERE asset_id=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF cardinality(array_remove(roots,NULL))>0 THEN
   tids:=COALESCE(tids,ARRAY[]::bigint[])||ARRAY(SELECT DISTINCT l.task_id FROM task_asset_links l JOIN assets a ON a.id=l.asset_id WHERE a.type='subdomain' AND a.root_domain=ANY(roots));
  END IF;
 ELSIF TG_TABLE_NAME='companies' THEN
  company:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  SELECT array_agg(DISTINCT l.task_id) INTO tids FROM task_asset_links l JOIN assets a ON a.id=l.asset_id
   WHERE a.company_id=company OR (a.type='subdomain' AND a.root_domain IN(SELECT domain FROM assets WHERE type='root_domain' AND company_id=company));
 ELSE
  tids:=CASE WHEN TG_OP='DELETE' THEN ARRAY[OLD.task_id] WHEN TG_OP='INSERT' THEN ARRAY[NEW.task_id] ELSE ARRAY[OLD.task_id,NEW.task_id] END;
 END IF;
 -- Lock changed owners in a stable order. Direct-source readers compare each
 -- source revision; no fan-out updates or recursive source inheritance needed.
 -- Resolve task owners first. In a cached generic plan, OR with the task
 -- subquery scanned every exploration for EACH inserted edge (including
 -- hundreds of covers edges). Keep both revision statements as primary-key
 -- point lookups even after PostgreSQL switches to its generic plan.
 IF tids IS NOT NULL THEN
  eids:=COALESCE(eids,'{}'::bigint[])||ARRAY(SELECT exploration_id FROM tasks WHERE id=ANY(tids));
 END IF;
 PERFORM id FROM explorations WHERE id=ANY(eids)
  AND view_revision_xid IS DISTINCT FROM pg_current_xact_id() ORDER BY id FOR UPDATE;
 UPDATE explorations SET view_revision=view_revision+1,view_revision_xid=pg_current_xact_id()
  WHERE id=ANY(eids) AND view_revision_xid IS DISTINCT FROM pg_current_xact_id();
 -- Assets use BEFORE DELETE to see owner links before FK cascades. Returning
 -- NULL there would cancel the domain deletion; this observer must preserve it.
 RETURN COALESCE(NEW,OLD);
END $$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['exploration_edges','exploration_anchors','task_asset_links','task_scope','task_relations','findings','planner_decisions'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS projection_revision ON %I',tab);
  EXECUTE format('CREATE TRIGGER projection_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION invalidate_graph_projection()',tab);
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS projection_revision ON assets;
CREATE TRIGGER projection_revision AFTER INSERT OR UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION invalidate_graph_projection();
DROP TRIGGER IF EXISTS projection_revision_delete ON assets;
CREATE TRIGGER projection_revision_delete BEFORE DELETE ON assets FOR EACH ROW EXECUTE FUNCTION invalidate_graph_projection();

DROP TRIGGER IF EXISTS projection_revision ON companies;
CREATE TRIGGER projection_revision AFTER INSERT OR UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION invalidate_graph_projection();
DROP TRIGGER IF EXISTS projection_revision_delete ON companies;
CREATE TRIGGER projection_revision_delete BEFORE DELETE ON companies FOR EACH ROW EXECUTE FUNCTION invalidate_graph_projection();
