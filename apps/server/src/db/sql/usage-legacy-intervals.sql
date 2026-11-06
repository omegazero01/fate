-- Rebuildable legacy time boundaries, never another token ledger. Both bound
-- and unbound old records define predecessors; only unbound intervals mark an
-- otherwise physical request's history as uncertain.
CREATE TABLE IF NOT EXISTS usage_legacy_initialized (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,ready BOOLEAN NOT NULL DEFAULT false,PRIMARY KEY(scope,scope_id)
);
CREATE TABLE IF NOT EXISTS usage_legacy_intervals (
 scope TEXT NOT NULL,scope_id BIGINT NOT NULL,domain_key TEXT NOT NULL,role TEXT NOT NULL,segment TEXT NOT NULL,
 request_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL,previous_end TIMESTAMPTZ NOT NULL,unbound BOOLEAN NOT NULL,
 coverage TSTZRANGE GENERATED ALWAYS AS(tstzrange(previous_end,created_at,'(]')) STORED,
 PRIMARY KEY(scope,scope_id,request_id)
);
CREATE INDEX IF NOT EXISTS usage_legacy_order ON usage_legacy_intervals(scope,scope_id,domain_key,role,segment,created_at,request_id);
CREATE INDEX IF NOT EXISTS usage_legacy_role_order ON usage_legacy_intervals(scope,scope_id,domain_key,role,created_at,request_id) WHERE unbound;

CREATE OR REPLACE FUNCTION repair_usage_legacy_successor(sc TEXT,sid BIGINT,dom TEXT,r TEXT,seg TEXT,at_time TIMESTAMPTZ,rid TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE successor RECORD; previous_time TIMESTAMPTZ;
BEGIN
 SELECT request_id,created_at INTO successor FROM usage_legacy_intervals WHERE scope=sc AND scope_id=sid AND domain_key=dom AND role=r AND segment=seg
  AND (created_at,request_id)>(at_time,rid) ORDER BY created_at,request_id LIMIT 1;
 IF NOT FOUND THEN RETURN;END IF;
 SELECT created_at INTO previous_time FROM usage_legacy_intervals WHERE scope=sc AND scope_id=sid AND domain_key=dom AND role=r AND segment=seg
  AND (created_at,request_id)<(successor.created_at,successor.request_id) ORDER BY created_at DESC,request_id DESC LIMIT 1;
 UPDATE usage_legacy_intervals SET previous_end=COALESCE(previous_time,'-infinity') WHERE scope=sc AND scope_id=sid AND request_id=successor.request_id;
END $$;
CREATE OR REPLACE FUNCTION capture_usage_legacy_intervals() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE sc TEXT; sid BIGINT; active BOOLEAN; old_row RECORD; dom TEXT; seg TEXT; previous_time TIMESTAMPTZ;
BEGIN
 IF NOT (TG_OP<>'INSERT' AND OLD.source='legacy_results' OR TG_OP<>'DELETE' AND NEW.source='legacy_results') THEN RETURN NULL;END IF;
 -- Token-only changes do not change any interval.
 IF TG_OP='UPDATE' AND (OLD.request_id,OLD.task_id,OLD.conversation_id,OLD.source,OLD.runtime_id,OLD.turn_id,OLD.role,OLD.main_seg,OLD.created_at)
  IS NOT DISTINCT FROM (NEW.request_id,NEW.task_id,NEW.conversation_id,NEW.source,NEW.runtime_id,NEW.turn_id,NEW.role,NEW.main_seg,NEW.created_at) THEN RETURN NULL;END IF;
 FOR sc,sid IN SELECT DISTINCT s,id FROM (VALUES
  ('task',CASE WHEN TG_OP<>'INSERT' AND OLD.source='legacy_results' THEN OLD.task_id END),
  ('conversation',CASE WHEN TG_OP<>'INSERT' AND OLD.source='legacy_results' THEN OLD.conversation_id END),
  ('task',CASE WHEN TG_OP<>'DELETE' AND NEW.source='legacy_results' THEN NEW.task_id END),
  ('conversation',CASE WHEN TG_OP<>'DELETE' AND NEW.source='legacy_results' THEN NEW.conversation_id END)
 ) scopes(s,id) WHERE id IS NOT NULL ORDER BY s,id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-legacy-init:'||sc||':'||sid,0));
  INSERT INTO usage_legacy_initialized VALUES(sc,sid,false) ON CONFLICT DO NOTHING;
  SELECT ready INTO active FROM usage_legacy_initialized WHERE scope=sc AND scope_id=sid FOR UPDATE;
  IF NOT active THEN CONTINUE;END IF;
  IF TG_OP<>'INSERT' AND OLD.source='legacy_results' THEN
   DELETE FROM usage_legacy_intervals WHERE scope=sc AND scope_id=sid AND request_id=OLD.request_id RETURNING * INTO old_row;
   IF FOUND THEN PERFORM repair_usage_legacy_successor(sc,sid,old_row.domain_key,old_row.role,old_row.segment,old_row.created_at,old_row.request_id);END IF;
  END IF;
  IF TG_OP<>'DELETE' AND NEW.source='legacy_results' AND (CASE WHEN sc='task' THEN NEW.task_id=sid ELSE NEW.conversation_id=sid END) THEN
   dom:=COALESCE('conversation:'||NEW.conversation_id,'task:'||NEW.task_id,'platform');seg:=COALESCE(NEW.main_seg::text,'null');
   SELECT created_at INTO previous_time FROM usage_legacy_intervals WHERE scope=sc AND scope_id=sid AND domain_key=dom AND role=NEW.role AND segment=seg
    AND (created_at,request_id)<(NEW.created_at,NEW.request_id) ORDER BY created_at DESC,request_id DESC LIMIT 1;
   INSERT INTO usage_legacy_intervals(scope,scope_id,domain_key,role,segment,request_id,created_at,previous_end,unbound)
    VALUES(sc,sid,dom,NEW.role,seg,NEW.request_id,NEW.created_at,COALESCE(previous_time,'-infinity'),NEW.runtime_id IS NULL AND NEW.turn_id IS NULL);
   PERFORM repair_usage_legacy_successor(sc,sid,dom,NEW.role,seg,NEW.created_at,NEW.request_id);
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS zzzz_usage_legacy_intervals ON llm_usage_ledger;
CREATE TRIGGER zzzz_usage_legacy_intervals AFTER INSERT OR UPDATE OR DELETE ON llm_usage_ledger FOR EACH ROW EXECUTE FUNCTION capture_usage_legacy_intervals();

CREATE OR REPLACE FUNCTION usage_rollup_legacy_overlap(k JSONB,sc TEXT,sid BIGINT,dom TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM usage_rollup_roles roles
  CROSS JOIN LATERAL (SELECT created_at FROM llm_usage_ledger l
   WHERE usage_rollup_key(l.task_id,l.conversation_id,l.scope_key,l.source,l.turn_id,l.runtime_id)=k AND l.role=roles.role
   ORDER BY created_at,request_id LIMIT 1) lo
  CROSS JOIN LATERAL (SELECT created_at FROM llm_usage_ledger l
   WHERE usage_rollup_key(l.task_id,l.conversation_id,l.scope_key,l.source,l.turn_id,l.runtime_id)=k AND l.role=roles.role
   ORDER BY created_at DESC,request_id DESC LIMIT 1) hi
  CROSS JOIN LATERAL (
   SELECT 1 FROM usage_legacy_intervals i
   WHERE i.scope=sc AND i.scope_id=sid AND i.domain_key=dom AND i.role=roles.role AND i.unbound
    AND i.created_at>=lo.created_at AND i.coverage && tstzrange(lo.created_at,hi.created_at,'[]')
    -- Keep the correlated point probe. After ANALYZE, decorrelating EXISTS
    -- into a semi-join can materialize every interval x receipt before LIMIT.
    AND EXISTS(SELECT 1 FROM llm_usage_ledger p
     WHERE usage_rollup_key(p.task_id,p.conversation_id,p.scope_key,p.source,p.turn_id,p.runtime_id)=k AND p.role=roles.role
      AND p.created_at>i.previous_end AND p.created_at<=i.created_at OFFSET 0)
   ORDER BY i.created_at,i.request_id LIMIT 1
  ) hit
  WHERE roles.identity=k AND roles.receipts>0
 )
$$;
