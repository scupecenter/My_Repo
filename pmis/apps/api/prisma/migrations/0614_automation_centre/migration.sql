-- 0614_automation_centre: the run history of the alert rules for the Automation centre (contract 0.15.473). Notifications only, additive.
-- Mirror: db/sql/613_automation_centre.sql (kept identical to prisma/migrations/0614_automation_centre/migration.sql).
--
--   alert_rule_runs          one row per enabled rule per daily run: when it ran and for how many targets it fired (LOG table, like alert_rule_fires).
--   alert_rules_runs_record() called by the daily job in the same transaction right after alert_rules_run() and alert_rules_kpi_run(). Counts the targets each
--                            enabled rule fired in this transaction (alert_rule_fires.fired_at = the transaction time), writes the run row and, when the rule
--                            fired, ONE audit row per rule: action alert_rule_run, entity alert_rule, no actor (the system), via job, job_name alert_rules.
--                            A run that fired nothing is recorded at most once per 12 hours, so a repeated run adds no noise.
--   alert_rule_runs_json(n)  the last n runs (default 50, max 200) with the rule code and kind, for GET /settings/alert-rules/runs (admin.settings view).
--
-- The rules, their kinds, audiences, templates and the dedupe journal are those of 0342 and later; nothing there is redefined. A rule still changes no record,
-- state, owner or permission. No role grant is widened.

CREATE TABLE IF NOT EXISTS public.alert_rule_runs (
  id bigserial PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES public.alert_rules(id) ON DELETE CASCADE,
  run_at timestamptz NOT NULL DEFAULT now(),
  fired integer NOT NULL CHECK (fired >= 0)
);
CREATE INDEX IF NOT EXISTS alert_rule_runs_rule_at ON public.alert_rule_runs (rule_id, run_at DESC);
CREATE INDEX IF NOT EXISTS alert_rule_runs_at ON public.alert_rule_runs (run_at DESC, id DESC);

CREATE OR REPLACE FUNCTION alert_rules_runs_record() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; n integer; total integer := 0;
BEGIN
  FOR r IN SELECT x.id, x.code, x.kind FROM public.alert_rules x WHERE x.enabled ORDER BY x.code LOOP
    SELECT count(*)::int INTO n FROM public.alert_rule_fires f WHERE f.rule_id = r.id AND f.fired_at >= now();
    IF n = 0 AND EXISTS (SELECT 1 FROM public.alert_rule_runs u WHERE u.rule_id = r.id AND u.run_at > now() - interval '12 hours') THEN CONTINUE; END IF;
    INSERT INTO public.alert_rule_runs (rule_id, fired) VALUES (r.id, n);
    IF n > 0 THEN
      INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, via, job_name)
      VALUES ('alert_rule_run', 'alert_rule', r.id::text, jsonb_build_object('code', r.code, 'kind', r.kind, 'targets', n), 'Automatic run of an alert rule', 'job', 'alert_rules');
      total := total + 1;
    END IF;
  END LOOP;
  RETURN total;
END $$;

CREATE OR REPLACE FUNCTION alert_rule_runs_json(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'rule_id', q.rule_id, 'rule_code', q.code, 'kind', q.kind, 'run_at', q.run_at, 'fired', q.fired) ORDER BY q.run_at DESC, q.id DESC)
    FROM (SELECT u.id, u.rule_id, r.code, r.kind, u.run_at, u.fired FROM public.alert_rule_runs u JOIN public.alert_rules r ON r.id = u.rule_id
          ORDER BY u.run_at DESC, u.id DESC LIMIT greatest(1, least(coalesce(p_limit, 50), 200))) q), '[]'::jsonb);
END $$;

-- Data reset coverage (0152): the run history is a journal (LOG, with alert_rule_fires). data_reset_plan() is an accumulating function: patched in place and idempotently.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''alert_rule_runs''' IN def) = 0 THEN
    IF position('''alert_rule_fires''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the log list anchor was not found'; END IF;
    def := replace(def, '''alert_rule_fires''', '''alert_rule_fires'', ''alert_rule_runs''');
    EXECUTE def;
  END IF;
END $$;

GRANT SELECT, UPDATE ON public.alert_rule_runs TO pmis_reset_owner;
ALTER TABLE public.alert_rule_runs OWNER TO pmis_definer;
REVOKE ALL ON public.alert_rule_runs FROM PUBLIC;
GRANT INSERT ON public.audit_log TO pmis_definer;
DO $$
BEGIN
  ALTER SEQUENCE public.alert_rule_runs_id_seq OWNER TO pmis_definer;
  ALTER FUNCTION alert_rules_runs_record() OWNER TO pmis_definer;
  ALTER FUNCTION alert_rule_runs_json(integer) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION alert_rules_runs_record() FROM PUBLIC;
  REVOKE ALL ON FUNCTION alert_rule_runs_json(integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION alert_rules_runs_record() TO pmis_definer;
  GRANT EXECUTE ON FUNCTION alert_rule_runs_json(integer) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION alert_rules_runs_record() TO pmis_app;
    GRANT EXECUTE ON FUNCTION alert_rule_runs_json(integer) TO pmis_app;
  END IF;
END $$;
