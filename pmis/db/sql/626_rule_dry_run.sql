-- 0627_rule_dry_run: the log of one rule and a dry run of a rule (contract 0.15.486). Read only for the data: nothing is notified and no journal row stays.
-- Mirror: db/sql/626_rule_dry_run.sql (kept identical to prisma/migrations/0627_rule_dry_run/migration.sql).
--
--   alert_rule_dry_run_json(rule_id)  System Admin (admin.settings). Evaluates the rule as the daily run would today, inside a sub-transaction that is always
--                                     rolled back, and returns what it would send now: {rule_id, would_fire (targets not yet notified this period), notifications
--                                     (in-app notifications it would create), targets: [{period_key, target}] (up to 50)}. The rule is evaluated even when it is
--                                     switched off. Targets already notified in the current period are not counted again (the journal dedupes them).
--   alert_rule_log_json(rule_id, limit)  System Admin. The journal of one rule: the last runs (alert_rule_runs) and the last firings (alert_rule_fires), newest first
--                                     (limit default 50, max 200).
-- No table, no reset-plan change, no grant of a role widened. Definer functions owned by pmis_definer; the app role gets execute, the admin check is inside.

CREATE OR REPLACE FUNCTION alert_rule_dry_run_json(p_rule uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  started timestamptz := clock_timestamp();
  before_n bigint; after_n bigint;
  fires jsonb; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  IF NOT EXISTS (SELECT 1 FROM public.alert_rules x WHERE x.id = p_rule) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('message', 'No such rule.'));
  END IF;
  SELECT count(*) INTO before_n FROM public.notifications WHERE kind = 'alert_rule';
  BEGIN
    UPDATE public.alert_rules SET enabled = true WHERE id = p_rule;
    PERFORM public.alert_rules_run(NULL);
    SELECT count(*) INTO after_n FROM public.notifications WHERE kind = 'alert_rule';
    SELECT coalesce(jsonb_agg(jsonb_build_object('period_key', q.period_key, 'target', q.target)), '[]'::jsonb) INTO fires
      FROM (SELECT f.period_key, f.target FROM public.alert_rule_fires f WHERE f.rule_id = p_rule AND f.fired_at >= started ORDER BY f.target LIMIT 50) q;
    res := jsonb_build_object('rule_id', p_rule,
      'would_fire', (SELECT count(*) FROM public.alert_rule_fires f WHERE f.rule_id = p_rule AND f.fired_at >= started),
      'notifications', after_n - before_n, 'targets', fires);
    RAISE EXCEPTION 'dry_run_rollback' USING ERRCODE = 'P0001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'dry_run_rollback' THEN RAISE; END IF;
  END;
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION alert_rule_log_json(p_rule uuid, p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE lim integer := greatest(1, least(coalesce(p_limit, 50), 200));
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  RETURN jsonb_build_object(
    'runs', coalesce((SELECT jsonb_agg(jsonb_build_object('run_at', q.run_at, 'fired', q.fired) ORDER BY q.run_at DESC)
                      FROM (SELECT u.run_at, u.fired FROM public.alert_rule_runs u WHERE u.rule_id = p_rule ORDER BY u.run_at DESC LIMIT lim) q), '[]'::jsonb),
    'fires', coalesce((SELECT jsonb_agg(jsonb_build_object('fired_at', q.fired_at, 'period_key', q.period_key, 'target', q.target) ORDER BY q.fired_at DESC, q.target)
                       FROM (SELECT f.fired_at, f.period_key, f.target FROM public.alert_rule_fires f WHERE f.rule_id = p_rule ORDER BY f.fired_at DESC, f.target LIMIT lim) q), '[]'::jsonb));
END $$;

DO $$
BEGIN
  ALTER FUNCTION alert_rule_dry_run_json(uuid) OWNER TO pmis_definer;
  ALTER FUNCTION alert_rule_log_json(uuid, integer) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION alert_rule_dry_run_json(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION alert_rule_log_json(uuid, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION alert_rule_dry_run_json(uuid) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION alert_rule_log_json(uuid, integer) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION alert_rule_dry_run_json(uuid) TO pmis_app;
    GRANT EXECUTE ON FUNCTION alert_rule_log_json(uuid, integer) TO pmis_app;
  END IF;
END $$;
