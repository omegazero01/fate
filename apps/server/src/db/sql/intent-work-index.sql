-- Rebuildable host projection. No historical intent, asset or result is rewritten.
CREATE TABLE IF NOT EXISTS intent_work_index (
 intent_id BIGINT PRIMARY KEY REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 identity_key TEXT, family TEXT, resource_hash TEXT, target_hashes TEXT[] NOT NULL DEFAULT '{}',
 prose_key TEXT, has_work BOOLEAN NOT NULL, strength TEXT,
 dynamic_assets BOOLEAN NOT NULL, uses_graph_anchors BOOLEAN NOT NULL,
 error TEXT, indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intent_work_exact ON intent_work_index(exploration_id,identity_key,intent_id DESC);
CREATE INDEX IF NOT EXISTS intent_work_prose ON intent_work_index(exploration_id,prose_key,intent_id DESC);
CREATE INDEX IF NOT EXISTS intent_work_family ON intent_work_index(exploration_id,family,resource_hash);
CREATE INDEX IF NOT EXISTS intent_work_targets ON intent_work_index USING GIN(target_hashes);
CREATE INDEX IF NOT EXISTS intent_work_invalid ON intent_work_index(exploration_id,intent_id) WHERE error IS NOT NULL;
CREATE TABLE IF NOT EXISTS intent_work_assets (
 intent_id BIGINT NOT NULL REFERENCES intent_work_index(intent_id) ON DELETE CASCADE,
 asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 PRIMARY KEY(intent_id,asset_id)
);
CREATE INDEX IF NOT EXISTS intent_work_assets_reverse ON intent_work_assets(asset_id,intent_id);
CREATE SEQUENCE IF NOT EXISTS intent_work_revision;
CREATE TABLE IF NOT EXISTS intent_work_dirty (
 intent_id BIGINT PRIMARY KEY REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL DEFAULT nextval('intent_work_revision')
);
CREATE INDEX IF NOT EXISTS intent_work_dirty_task ON intent_work_dirty(exploration_id,intent_id);

CREATE OR REPLACE FUNCTION dirty_intent_work() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE nid BIGINT;
BEGIN
 IF TG_TABLE_NAME='exploration_nodes' THEN
  IF NEW.kind<>'intent' THEN
   IF TG_OP='UPDATE' AND OLD.kind='intent' THEN
    DELETE FROM intent_work_index WHERE intent_id=NEW.id;DELETE FROM intent_work_dirty WHERE intent_id=NEW.id;
   END IF;
   RETURN NULL;
  END IF;
  IF TG_OP='UPDATE' AND NEW.kind=OLD.kind AND NEW.exploration_id=OLD.exploration_id AND
   (NEW.payload->'summary',NEW.payload->'contract',NEW.payload->'work_identity',NEW.payload->'dispatch_asset_ids',NEW.payload->'asset_ids') IS NOT DISTINCT FROM
   (OLD.payload->'summary',OLD.payload->'contract',OLD.payload->'work_identity',OLD.payload->'dispatch_asset_ids',OLD.payload->'asset_ids') THEN RETURN NULL; END IF;
  nid:=NEW.id;
 ELSIF TG_TABLE_NAME='exploration_anchors' THEN
  IF TG_OP='UPDATE' AND OLD.node_id IS DISTINCT FROM NEW.node_id THEN
   INSERT INTO intent_work_dirty(intent_id,exploration_id)
    SELECT n.id,n.exploration_id FROM exploration_nodes n WHERE n.id=OLD.node_id AND n.kind='intent'
     AND NOT EXISTS(SELECT 1 FROM intent_work_index w WHERE w.intent_id=n.id AND NOT w.uses_graph_anchors)
    ON CONFLICT(intent_id) DO UPDATE SET revision=nextval('intent_work_revision');
  END IF;
  nid:=CASE WHEN TG_OP='DELETE' THEN OLD.node_id ELSE NEW.node_id END;
  IF EXISTS(SELECT 1 FROM intent_work_index WHERE intent_id=nid AND NOT uses_graph_anchors) THEN RETURN NULL; END IF;
 ELSE
  IF TG_OP='UPDATE' AND (NEW.type,NEW.url,NEW.method,NEW.domain,NEW.ip,NEW.port) IS NOT DISTINCT FROM
    (OLD.type,OLD.url,OLD.method,OLD.domain,OLD.ip,OLD.port) THEN RETURN NULL; END IF;
  INSERT INTO intent_work_dirty(intent_id,exploration_id)
   SELECT w.intent_id,w.exploration_id FROM intent_work_assets a JOIN intent_work_index w ON w.intent_id=a.intent_id
   WHERE a.asset_id=OLD.id AND w.dynamic_assets
   ON CONFLICT(intent_id) DO UPDATE SET revision=nextval('intent_work_revision');
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END IF;
 INSERT INTO intent_work_dirty(intent_id,exploration_id)
  SELECT id,exploration_id FROM exploration_nodes WHERE id=nid AND kind='intent'
  ON CONFLICT(intent_id) DO UPDATE SET exploration_id=EXCLUDED.exploration_id,revision=nextval('intent_work_revision');
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS intent_work_nodes ON exploration_nodes;
CREATE TRIGGER intent_work_nodes AFTER INSERT OR UPDATE OF payload,kind,exploration_id ON exploration_nodes FOR EACH ROW EXECUTE FUNCTION dirty_intent_work();
DROP TRIGGER IF EXISTS intent_work_anchors ON exploration_anchors;
CREATE TRIGGER intent_work_anchors AFTER INSERT OR DELETE OR UPDATE OF node_id,asset_id ON exploration_anchors FOR EACH ROW EXECUTE FUNCTION dirty_intent_work();
DROP TRIGGER IF EXISTS intent_work_asset_update ON assets;
CREATE TRIGGER intent_work_asset_update AFTER UPDATE OF type,url,method,domain,ip,port ON assets FOR EACH ROW EXECUTE FUNCTION dirty_intent_work();
DROP TRIGGER IF EXISTS intent_work_asset_delete ON assets;
CREATE TRIGGER intent_work_asset_delete BEFORE DELETE ON assets FOR EACH ROW EXECUTE FUNCTION dirty_intent_work();

-- Idempotent upgrade: unchanged indexed rows are not queued on every startup.
INSERT INTO intent_work_dirty(intent_id,exploration_id)
 SELECT n.id,n.exploration_id FROM exploration_nodes n LEFT JOIN intent_work_index w ON w.intent_id=n.id
 WHERE n.kind='intent' AND w.intent_id IS NULL ON CONFLICT DO NOTHING;
