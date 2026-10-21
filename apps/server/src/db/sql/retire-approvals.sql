DROP FUNCTION IF EXISTS exploration_node_readable(BIGINT,BIGINT,BOOLEAN) CASCADE;
-- One-time retirement. Preserve old feature data as inert JSON before dropping it.
CREATE TABLE IF NOT EXISTS retired_feature_data (
 feature TEXT NOT NULL, source TEXT NOT NULL, data JSONB NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(feature,source)
);
DO $$
DECLARE item TEXT; fn RECORD;
BEGIN
 IF to_regclass('exploration_nodes') IS NOT NULL THEN
  UPDATE exploration_nodes SET payload=payload||'{"dispatch_source":"mainagent"}'::jsonb WHERE kind='intent' AND payload->'pending_asset_execution'->>'issuer'='mainagent' AND NOT payload ? 'dispatch_source';
 END IF;
 IF EXISTS(SELECT 1 FROM retired_feature_data WHERE feature='approvals' AND source='migration_complete') THEN RETURN; END IF;
 IF to_regclass('intercept_pending') IS NOT NULL THEN
  EXECUTE 'INSERT INTO retired_feature_data(feature,source,data) SELECT ''approvals'',''intercept_pending'',COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM intercept_pending r ON CONFLICT DO NOTHING';
 END IF;
 IF to_regclass('intercept_rules') IS NOT NULL THEN
  EXECUTE 'INSERT INTO retired_feature_data(feature,source,data) SELECT ''approvals'',''intercept_rules'',COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM intercept_rules r ON CONFLICT DO NOTHING';
 END IF;
 IF to_regclass('task_asset_blocks') IS NOT NULL THEN
  EXECUTE 'INSERT INTO retired_feature_data(feature,source,data) SELECT ''approvals'',''task_asset_blocks'',COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM task_asset_blocks r ON CONFLICT DO NOTHING';
 END IF;
 IF to_regclass('task_asset_grants') IS NOT NULL THEN
  EXECUTE 'INSERT INTO retired_feature_data(feature,source,data) SELECT ''approvals'',''task_asset_grants'',COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM task_asset_grants r ON CONFLICT DO NOTHING';
 END IF;
 IF to_regclass('task_asset_dns_evidence') IS NOT NULL THEN
  EXECUTE 'INSERT INTO retired_feature_data(feature,source,data) SELECT ''approvals'',''task_asset_dns_evidence'',COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM task_asset_dns_evidence r ON CONFLICT DO NOTHING';
 END IF;
 IF to_regclass('task_asset_skips') IS NOT NULL THEN
  EXECUTE 'INSERT INTO retired_feature_data(feature,source,data) SELECT ''approvals'',''task_asset_skips'',COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM task_asset_skips r ON CONFLICT DO NOTHING';
 END IF;
 IF to_regclass('task_worker_asset_access') IS NOT NULL THEN
  EXECUTE 'INSERT INTO retired_feature_data(feature,source,data) SELECT ''approvals'',''task_worker_asset_access'',COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM task_worker_asset_access r ON CONFLICT DO NOTHING';
 END IF;
 IF to_regclass('task_asset_links') IS NOT NULL THEN
  INSERT INTO retired_feature_data(feature,source,data) SELECT 'approvals','asset_link_states',COALESCE(jsonb_agg(jsonb_build_object('task_id',r.task_id,'asset_id',r.asset_id,'approval_state',to_jsonb(r)->'approval_state','approved_at',to_jsonb(r)->'approved_at','approved_by',to_jsonb(r)->'approved_by','approval_reason',to_jsonb(r)->'approval_reason')),'[]'::jsonb) FROM task_asset_links r ON CONFLICT DO NOTHING;
  DROP TRIGGER IF EXISTS context_authorization_event ON task_asset_links;
  DROP TRIGGER IF EXISTS blackboard_authorization ON task_asset_links;
 END IF;
 IF to_regclass('tasks') IS NOT NULL THEN
  INSERT INTO retired_feature_data(feature,source,data) SELECT 'approvals','task_templates',COALESCE(jsonb_agg(jsonb_build_object('id',id,'template',to_jsonb(t)->'asset_approval_template')),'[]'::jsonb) FROM tasks t ON CONFLICT DO NOTHING;
 END IF;
 IF to_regclass('settings') IS NOT NULL THEN
  INSERT INTO retired_feature_data(feature,source,data) SELECT 'approvals','settings',COALESCE(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM settings s WHERE key LIKE 'intercept_%' OR key LIKE 'llm_judge_%' ON CONFLICT DO NOTHING;
  DELETE FROM settings WHERE key LIKE 'intercept_%' OR key LIKE 'llm_judge_%';
 END IF;
 FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname=ANY(ARRAY['repair_task_asset_inputs','task_asset_worker_executable','task_host_template_allows','task_asset_template_allows','task_host_approval_state','apply_task_asset_template','task_asset_blocked','task_asset_owner_approval_state','task_asset_effective_approval_state','task_asset_effectively_approved','normalize_derived_task_asset_approvals','capture_context_authorization','task_asset_host_within','task_asset_identity_key','task_asset_host','task_asset_normalized_host']) LOOP EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE',fn.signature); END LOOP;
 DROP TABLE IF EXISTS intercept_pending CASCADE;
 DROP TABLE IF EXISTS intercept_rules CASCADE;
 DROP TABLE IF EXISTS task_asset_blocks CASCADE;
 DROP TABLE IF EXISTS task_asset_grants CASCADE;
 DROP TABLE IF EXISTS task_asset_dns_evidence CASCADE;
 DROP TABLE IF EXISTS task_asset_skips CASCADE;
 DROP TABLE IF EXISTS task_worker_asset_access CASCADE;
 ALTER TABLE IF EXISTS task_asset_links DROP COLUMN IF EXISTS approval_state, DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approval_reason;
 ALTER TABLE IF EXISTS tasks DROP COLUMN IF EXISTS asset_approval_template;
 ALTER TABLE IF EXISTS assets DROP COLUMN IF EXISTS authorization_host;
 INSERT INTO retired_feature_data(feature,source,data) VALUES('approvals','migration_complete','{}') ON CONFLICT DO NOTHING;
END $$;
