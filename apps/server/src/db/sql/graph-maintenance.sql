-- Derived graph maintenance is independent of Planner execution. These counters
-- invalidate a read snapshot; they are not a new dispatch/acknowledgement protocol.
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS cold_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS cold_structure_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS cold_processed_revision BIGINT NOT NULL DEFAULT -1;
ALTER TABLE explorations ADD COLUMN IF NOT EXISTS cold_next_round BIGINT;
CREATE INDEX IF NOT EXISTS blackboard_wakeups_pending ON blackboard_wakeups(exploration_id,id)
  WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS exploration_nodes_state_cursor ON exploration_nodes(exploration_id,kind,state,id);
-- Reverse traversal must seek by (graph,destination), not scan the primary
-- (graph,source,relation,destination) index for every ancestor/neighbor.
CREATE INDEX IF NOT EXISTS exploration_graph_parents ON exploration_edges(exploration_id,dst_id,src_id) WHERE rel<>'covers';
CREATE INDEX IF NOT EXISTS exploration_graph_children ON exploration_edges(exploration_id,src_id,dst_id) WHERE rel<>'covers';
CREATE INDEX IF NOT EXISTS exploration_claim_priority ON exploration_nodes(exploration_id,(-priority),id)
  WHERE kind='intent' AND state='open' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'
    AND payload->>'needs_replanning' IS DISTINCT FROM 'true';
CREATE INDEX IF NOT EXISTS exploration_claim_manual ON exploration_nodes(exploration_id,queue_position,id)
  WHERE kind='intent' AND state='open' AND payload->>'cancelled_by_user' IS DISTINCT FROM 'true'
    AND payload->>'needs_replanning' IS DISTINCT FROM 'true';

-- Rebuildable cold-graph working state. Original nodes/edges remain authoritative.
CREATE SEQUENCE IF NOT EXISTS cold_dirty_generation;
CREATE TABLE IF NOT EXISTS cold_node_state (
 node_id BIGINT PRIMARY KEY REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 ancestor_hot BOOLEAN NOT NULL, cold_since_round BIGINT, eligible BOOLEAN NOT NULL,
 component_id BIGINT, chunk_id BIGINT, sync_needed BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS cold_state_component ON cold_node_state(exploration_id,component_id,node_id);
CREATE INDEX IF NOT EXISTS cold_state_chunk ON cold_node_state(exploration_id,chunk_id,node_id);
CREATE INDEX IF NOT EXISTS cold_state_due ON cold_node_state(exploration_id,cold_since_round) WHERE NOT eligible AND cold_since_round IS NOT NULL;
CREATE INDEX IF NOT EXISTS cold_state_sync ON cold_node_state(exploration_id,node_id) WHERE sync_needed;
CREATE TABLE IF NOT EXISTS cold_dirty_nodes (
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,node_id BIGINT NOT NULL,
 generation BIGINT NOT NULL DEFAULT nextval('cold_dirty_generation'), reclassify BOOLEAN NOT NULL,regroup BOOLEAN NOT NULL,
 old_component BIGINT,old_chunk BIGINT,PRIMARY KEY(exploration_id,node_id)
);
CREATE TABLE IF NOT EXISTS cold_digest_chunks (
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,chunk_id BIGINT NOT NULL,
 component_id BIGINT NOT NULL,member_ids BIGINT[] NOT NULL CHECK(cardinality(member_ids) BETWEEN 1 AND 256),
 dirty BOOLEAN NOT NULL DEFAULT true,digest_id BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,
 PRIMARY KEY(exploration_id,chunk_id)
);
CREATE INDEX IF NOT EXISTS cold_chunks_component ON cold_digest_chunks(exploration_id,component_id);
CREATE INDEX IF NOT EXISTS cold_chunks_pending ON cold_digest_chunks(exploration_id,chunk_id) WHERE dirty;
CREATE INDEX IF NOT EXISTS cold_chunks_digest ON cold_digest_chunks(digest_id);
CREATE TABLE IF NOT EXISTS cold_digest_retire (
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 digest_id BIGINT PRIMARY KEY REFERENCES exploration_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS cold_retire_task ON cold_digest_retire(exploration_id,digest_id);
CREATE INDEX IF NOT EXISTS active_digest_fingerprint ON exploration_nodes(exploration_id,(payload->>'fingerprint')) WHERE kind='digest' AND state='active';

CREATE OR REPLACE FUNCTION mark_cold_nodes(eid BIGINT,nids BIGINT[],classify BOOLEAN,group_needed BOOLEAN) RETURNS void LANGUAGE SQL AS $$
 INSERT INTO cold_dirty_nodes(exploration_id,node_id,reclassify,regroup,old_component,old_chunk)
 SELECT eid,n.id,classify,group_needed,s.component_id,s.chunk_id FROM exploration_nodes n
 LEFT JOIN cold_node_state s ON s.node_id=n.id WHERE n.exploration_id=eid AND n.id=ANY(nids)
  AND EXISTS(SELECT 1 FROM explorations WHERE id=eid)
 ON CONFLICT(exploration_id,node_id) DO UPDATE SET generation=nextval('cold_dirty_generation'),
  reclassify=cold_dirty_nodes.reclassify OR EXCLUDED.reclassify,regroup=cold_dirty_nodes.regroup OR EXCLUDED.regroup,
  old_component=COALESCE(cold_dirty_nodes.old_component,EXCLUDED.old_component),old_chunk=COALESCE(cold_dirty_nodes.old_chunk,EXCLUDED.old_chunk)
$$;

-- Only summaries containing affected members become stale. A live-state or
-- topology change also affects the upstream branch's hot/cold classification.
CREATE OR REPLACE FUNCTION invalidate_exploration_digests() RETURNS trigger AS $$
DECLARE eid BIGINT; seeds BIGINT[]; upstream BOOLEAN := false; group_needed BOOLEAN := false;
BEGIN
  IF TG_TABLE_NAME='exploration_nodes' THEN
    IF TG_OP='DELETE' THEN
      IF OLD.kind='digest' THEN
        -- The owning graph may already be gone during a cascading delete. Do
        -- not modify other rows which the same DELETE is about to remove.
        IF NOT EXISTS(SELECT 1 FROM explorations WHERE id=OLD.exploration_id) THEN RETURN OLD; END IF;
        UPDATE cold_digest_chunks SET dirty=true,digest_id=NULL WHERE digest_id=OLD.id;
        IF FOUND THEN UPDATE explorations SET cold_revision=cold_revision+1,cold_next_round=round_no WHERE id=OLD.exploration_id; END IF;
        RETURN OLD;
      END IF;
      eid:=OLD.exploration_id;seeds:=ARRAY[OLD.id];upstream:=true;group_needed:=true;
      SELECT seeds||COALESCE(array_agg(CASE WHEN src_id=OLD.id THEN dst_id ELSE src_id END),'{}'::bigint[]) INTO seeds
       FROM exploration_edges WHERE exploration_id=eid AND rel<>'covers' AND (src_id=OLD.id OR dst_id=OLD.id);
    ELSE
      IF NEW.kind='digest' AND (TG_OP='INSERT' OR OLD.kind='digest') THEN RETURN NEW; END IF;
      IF TG_OP='UPDATE' AND OLD.kind='digest' THEN UPDATE cold_digest_chunks SET dirty=true,digest_id=NULL WHERE digest_id=NEW.id; END IF;
      IF TG_OP='UPDATE' AND NEW.kind=OLD.kind AND NEW.payload IS NOT DISTINCT FROM OLD.payload AND NEW.state=OLD.state AND NEW.content_version=OLD.content_version THEN RETURN NEW; END IF;
      eid:=NEW.exploration_id;seeds:=ARRAY[NEW.id];
      upstream:=TG_OP='INSERT' OR NEW.kind IS DISTINCT FROM OLD.kind OR
       ((NEW.kind='intent' AND NEW.state IN ('open','running','paused')) IS DISTINCT FROM (OLD.kind='intent' AND OLD.state IN ('open','running','paused'))) OR
       ((NEW.state='origin') IS DISTINCT FROM (OLD.state='origin'));
      group_needed:=upstream;
      IF upstream THEN
        SELECT seeds || COALESCE(array_agg(dst_id),'{}'::bigint[]) INTO seeds
          FROM exploration_edges WHERE exploration_id=eid AND src_id=NEW.id AND rel<>'covers';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='exploration_anchors' THEN
    SELECT exploration_id INTO eid FROM exploration_nodes WHERE id=COALESCE(NEW.node_id,OLD.node_id) AND kind<>'digest';
    IF eid IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
    seeds:=CASE WHEN TG_OP='UPDATE' THEN ARRAY[OLD.node_id,NEW.node_id] ELSE ARRAY[COALESCE(NEW.node_id,OLD.node_id)] END;
  ELSE
    IF TG_OP='DELETE' THEN
      IF OLD.rel='covers' THEN RETURN OLD; END IF;
      eid:=OLD.exploration_id;seeds:=ARRAY[OLD.src_id,OLD.dst_id];
    ELSE
      IF NEW.rel='covers' AND (TG_OP='INSERT' OR OLD.rel='covers') THEN RETURN NEW; END IF;
      eid:=NEW.exploration_id;seeds:=CASE WHEN TG_OP='UPDATE' THEN ARRAY[OLD.src_id,OLD.dst_id,NEW.src_id,NEW.dst_id] ELSE ARRAY[NEW.src_id,NEW.dst_id] END;
    END IF;
    upstream:=true;group_needed:=true;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM explorations WHERE id=eid) THEN RETURN COALESCE(NEW,OLD); END IF;
  UPDATE explorations SET cold_revision=cold_revision+1,
    cold_structure_revision=cold_structure_revision+CASE WHEN upstream OR group_needed THEN 1 ELSE 0 END WHERE id=eid;
  PERFORM mark_cold_nodes(eid,seeds,upstream,group_needed);
  -- During initial ingestion or an entirely live chain there is no summary to
  -- invalidate. Reachability belongs to deferred maintenance, not every write.
  IF NOT EXISTS(SELECT 1 FROM exploration_nodes WHERE exploration_id=eid AND kind='digest' AND state='active') THEN RETURN COALESCE(NEW,OLD); END IF;
  WITH RECURSIVE affected(id) AS (
    SELECT unnest(seeds)
    UNION SELECT e.src_id FROM exploration_edges e JOIN affected a ON a.id=e.dst_id
      WHERE upstream AND e.exploration_id=eid AND e.rel<>'covers'
  ) UPDATE exploration_nodes d SET state='superseded'
    WHERE d.exploration_id=eid AND d.kind='digest' AND d.state='active'
      AND EXISTS(SELECT 1 FROM exploration_edges e JOIN affected a ON a.id=e.dst_id
        WHERE e.src_id=d.id AND e.rel='covers');
  RETURN COALESCE(NEW,OLD);
END;
$$ LANGUAGE plpgsql;

-- Before deletion retains the member link long enough to invalidate its summary.
DROP TRIGGER IF EXISTS trg_nodes_invalidate_digests ON exploration_nodes;
CREATE TRIGGER trg_nodes_invalidate_digests AFTER INSERT OR UPDATE OF payload,state,content_version,kind ON exploration_nodes
  FOR EACH ROW EXECUTE FUNCTION invalidate_exploration_digests();
DROP TRIGGER IF EXISTS trg_nodes_delete_digests ON exploration_nodes;
CREATE TRIGGER trg_nodes_delete_digests BEFORE DELETE ON exploration_nodes
  FOR EACH ROW EXECUTE FUNCTION invalidate_exploration_digests();
DROP TRIGGER IF EXISTS trg_edges_invalidate_digests ON exploration_edges;
CREATE TRIGGER trg_edges_invalidate_digests BEFORE INSERT OR DELETE OR UPDATE ON exploration_edges
  FOR EACH ROW EXECUTE FUNCTION invalidate_exploration_digests();
DROP TRIGGER IF EXISTS trg_anchors_invalidate_digests ON exploration_anchors;
CREATE TRIGGER trg_anchors_invalidate_digests BEFORE INSERT OR DELETE OR UPDATE ON exploration_anchors
  FOR EACH ROW EXECUTE FUNCTION invalidate_exploration_digests();

-- One-time lazy bootstrap; restarting does not enqueue unchanged projections.
INSERT INTO cold_dirty_nodes(exploration_id,node_id,reclassify,regroup)
 SELECT n.exploration_id,n.id,true,true FROM exploration_nodes n LEFT JOIN cold_node_state s ON s.node_id=n.id
 WHERE n.kind<>'digest' AND s.node_id IS NULL ON CONFLICT DO NOTHING;
