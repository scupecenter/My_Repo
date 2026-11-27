-- 0348_kpi_threshold_alerts: the kpi_threshold alert-rule kind with editable thresholds, plus enable and lock on every rule
-- (owner approval 2026-11-27 relayed by Main; follows 0342 alert_rules; contract 0.15.249; CHANGELOG KpiThresholdAlerts).
-- Mirror: db/sql/347_kpi_threshold_alerts.sql (kept identical to prisma/migrations/0348_kpi_threshold_alerts/migration.sql).
--
-- WHAT. The third closed kind of the generic alert rules (0342): kpi_threshold {kpi, op, value}. The KPI is one of the dashboard
-- settings catalogue (dashboard_settings_catalogue), op is above or below, and value is the rule's OWN editable threshold
-- (0..100000, in the KPI's unit) - independent of the dashboard green/amber bands, which stay display-only. The daily job computes
-- the live KPI values system-wide (DashboardExtrasService.kpiValuesForJob, the same queries the dashboard uses, with no caller
-- scope) and hands them to alert_rules_kpi_run; a rule whose KPI crosses its threshold fires one in-app notification per
-- recipient, deduped by (rule, day, kpi) through the existing alert_rule_fires. Notifications only: no state, owner or
-- permission change. Placeholders {{kpi}} (the catalogue label), {{value}} (the live value) and {{threshold}} (the rule's own)
-- are replaced at fire time.
-- LOCK. Every alert rule gains `locked` (default false, so existing rules are unchanged): while locked, a rule cannot be edited
-- or disabled - the only accepted save is the unlock itself (locked=false, every other field unchanged), audited like any
-- update. A locked rule still fires. Enable stays the existing `enabled` switch.

ALTER TABLE public.alert_rules DROP CONSTRAINT alert_rules_kind_check;
ALTER TABLE public.alert_rules ADD CONSTRAINT alert_rules_kind_check CHECK (kind IN ('weekly_status_missing', 'record_idle', 'kpi_threshold'));
ALTER TABLE public.alert_rules ADD COLUMN locked boolean NOT NULL DEFAULT false;

-- The closed per-kind params check, with the kpi_threshold branch (the KPI code comes from the dashboard settings catalogue).
CREATE OR REPLACE FUNCTION alert_rule_params_errs(p_kind text, p_params jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb := '[]'::jsonb;
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RETURN jsonb_build_array(jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'params is an object.'));
  END IF;
  IF p_kind = 'weekly_status_missing' THEN
    IF p_params <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes no params.');
    END IF;
  ELSIF p_kind = 'record_idle' THEN
    IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = p_params ->> 'register_key') THEN
      errs := errs || jsonb_build_object('path', '/params/register_key', 'code', 'invalid', 'message', 'A known register key.');
    END IF;
    IF coalesce(p_params ->> 'state', '') !~ '^[a-z0-9_]{1,60}$' THEN
      errs := errs || jsonb_build_object('path', '/params/state', 'code', 'invalid', 'message', 'A register state.');
    END IF;
    IF coalesce(p_params ->> 'days', '') !~ '^[0-9]+$' OR NOT ((p_params ->> 'days')::int BETWEEN 1 AND 3650) THEN
      errs := errs || jsonb_build_object('path', '/params/days', 'code', 'invalid', 'message', 'days is 1 to 3650.');
    END IF;
  ELSIF p_kind = 'kpi_threshold' THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.dashboard_settings_catalogue() -> 'kpis') e WHERE e ->> 'code' = p_params ->> 'kpi') THEN
      errs := errs || jsonb_build_object('path', '/params/kpi', 'code', 'invalid', 'message', 'A KPI of the dashboard catalogue.');
    END IF;
    IF coalesce(p_params ->> 'op', '') NOT IN ('above', 'below') THEN
      errs := errs || jsonb_build_object('path', '/params/op', 'code', 'invalid', 'message', 'above or below.');
    END IF;
    IF jsonb_typeof(p_params -> 'value') IS DISTINCT FROM 'number'
       OR (p_params ->> 'value')::numeric < 0 OR (p_params ->> 'value')::numeric > 100000 THEN
      errs := errs || jsonb_build_object('path', '/params/value', 'code', 'invalid', 'message', 'A number from 0 to 100000, in the unit of the KPI.');
    END IF;
  ELSE
    errs := errs || jsonb_build_object('path', '/kind', 'code', 'invalid', 'message', 'Unknown alert rule kind.');
  END IF;
  RETURN errs;
END $$;

-- The rules for the management screen, now with `locked`.
CREATE OR REPLACE FUNCTION alert_rules_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'code', r.code, 'kind', r.kind, 'params', r.params, 'audience', r.audience,
      'title_en', r.title_en, 'title_ar', r.title_ar, 'body_en', r.body_en, 'body_ar', r.body_ar,
      'link', r.link, 'enabled', r.enabled, 'locked', r.locked, 'version', r.version,
      'created_at', r.created_at, 'updated_at', r.updated_at) ORDER BY r.code)
    FROM public.alert_rules r), '[]'::jsonb);
END $$;

-- Create (p_id null) or update (If-Match p_version) a rule. admin.settings edit for all regions, a reason, one audit row.
-- Lock rule: while a rule is locked the only accepted save is the unlock itself (locked = false, every other field unchanged);
-- any other save of a locked rule fails rule_locked. Create accepts locked (default false).
CREATE OR REPLACE FUNCTION admin_alert_rule_save(p_rule jsonb, p_reason text, p_id uuid DEFAULT NULL, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  errs jsonb := '[]'::jsonb; cur public.alert_rules; rid uuid; before jsonb; after jsonb; a jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_rule IS NULL OR jsonb_typeof(p_rule) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/', 'code', 'invalid', 'message', 'The rule is a JSON object.'))));
  END IF;

  IF p_id IS NULL THEN
    IF coalesce(p_rule ->> 'code', '') !~ '^[a-z0-9][a-z0-9-]{1,60}$' THEN
      errs := errs || jsonb_build_object('path', '/code', 'code', 'invalid', 'message', 'Lowercase letters, digits and dashes, 2 to 61 chars.');
    ELSIF EXISTS (SELECT 1 FROM public.alert_rules x WHERE x.code = p_rule ->> 'code') THEN
      errs := errs || jsonb_build_object('path', '/code', 'code', 'conflict', 'message', 'The code is taken.');
    END IF;
  ELSE
    SELECT * INTO cur FROM public.alert_rules x WHERE x.id = p_id FOR UPDATE;
    IF NOT FOUND THEN PERFORM public.wf_err('not_found'); END IF;
    IF p_version IS NULL OR p_version <> cur.version THEN
      PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The rule changed since you read it. Reload and try again.'));
    END IF;
    IF (p_rule ? 'code') AND p_rule ->> 'code' IS DISTINCT FROM cur.code THEN
      errs := errs || jsonb_build_object('path', '/code', 'code', 'invalid', 'message', 'The code does not change.');
    END IF;
    -- the lock: a locked rule takes no edit; the one accepted save is the unlock alone
    IF cur.locked THEN
      IF coalesce((p_rule ->> 'locked')::boolean, true) THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/locked', 'code', 'rule_locked', 'message', 'The rule is locked. Unlock it first.'))));
      ELSIF p_rule ->> 'kind' IS DISTINCT FROM cur.kind
         OR coalesce(p_rule -> 'params', '{}'::jsonb) IS DISTINCT FROM cur.params
         OR p_rule -> 'audience' IS DISTINCT FROM cur.audience
         OR btrim(coalesce(p_rule ->> 'title_en', '')) IS DISTINCT FROM cur.title_en
         OR btrim(coalesce(p_rule ->> 'title_ar', '')) IS DISTINCT FROM cur.title_ar
         OR btrim(coalesce(p_rule ->> 'body_en', '')) IS DISTINCT FROM cur.body_en
         OR btrim(coalesce(p_rule ->> 'body_ar', '')) IS DISTINCT FROM cur.body_ar
         OR p_rule ->> 'link' IS DISTINCT FROM cur.link
         OR coalesce((p_rule ->> 'enabled')::boolean, true) IS DISTINCT FROM cur.enabled THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/locked', 'code', 'rule_locked', 'message', 'Unlocking changes nothing else.'))));
      END IF;
    END IF;
  END IF;

  errs := errs || public.alert_rule_params_errs(p_rule ->> 'kind', coalesce(p_rule -> 'params', '{}'::jsonb));

  a := p_rule -> 'audience';
  IF a IS NULL OR jsonb_typeof(a) <> 'object'
     OR NOT (a ->> 'type' IN ('system_admin', 'module'))
     OR ((a ->> 'type') = 'module' AND coalesce(a ->> 'module', '') !~ '^[a-z0-9_]{1,60}$') THEN
    errs := errs || jsonb_build_object('path', '/audience', 'code', 'invalid', 'message', '{"type":"system_admin"} or {"type":"module","module":"<module key>"}.');
  END IF;
  IF length(btrim(coalesce(p_rule ->> 'title_en', ''))) NOT BETWEEN 1 AND 200 THEN errs := errs || jsonb_build_object('path', '/title_en', 'code', 'invalid', 'message', '1 to 200 chars.'); END IF;
  IF length(btrim(coalesce(p_rule ->> 'title_ar', ''))) NOT BETWEEN 1 AND 200 THEN errs := errs || jsonb_build_object('path', '/title_ar', 'code', 'invalid', 'message', '1 to 200 chars.'); END IF;
  IF length(btrim(coalesce(p_rule ->> 'body_en', ''))) NOT BETWEEN 1 AND 2000 THEN errs := errs || jsonb_build_object('path', '/body_en', 'code', 'invalid', 'message', '1 to 2000 chars.'); END IF;
  IF length(btrim(coalesce(p_rule ->> 'body_ar', ''))) NOT BETWEEN 1 AND 2000 THEN errs := errs || jsonb_build_object('path', '/body_ar', 'code', 'invalid', 'message', '1 to 2000 chars.'); END IF;
  IF (p_rule ? 'link') AND p_rule ->> 'link' IS NOT NULL AND coalesce(p_rule ->> 'link', '') !~ '^/[a-zA-Z0-9/?=&_-]{1,200}$' THEN
    errs := errs || jsonb_build_object('path', '/link', 'code', 'invalid', 'message', 'An in-app path.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.alert_rules (code, kind, params, audience, title_en, title_ar, body_en, body_ar, link, enabled, locked, created_by, updated_by)
    VALUES (p_rule ->> 'code', p_rule ->> 'kind', coalesce(p_rule -> 'params', '{}'::jsonb), a,
            btrim(p_rule ->> 'title_en'), btrim(p_rule ->> 'title_ar'), btrim(p_rule ->> 'body_en'), btrim(p_rule ->> 'body_ar'),
            p_rule ->> 'link', coalesce((p_rule ->> 'enabled')::boolean, true), coalesce((p_rule ->> 'locked')::boolean, false), public.app_actor(), public.app_actor())
    RETURNING alert_rules.id INTO rid;
    SELECT to_jsonb(x) - 'created_at' - 'updated_at' INTO after FROM public.alert_rules x WHERE x.id = rid;
    PERFORM public.log_audit_write('alert_rule_create', 'alert_rule', rid::text, NULL, after, btrim(p_reason));
  ELSE
    rid := p_id;
    SELECT to_jsonb(x) - 'created_at' - 'updated_at' INTO before FROM public.alert_rules x WHERE x.id = rid;
    UPDATE public.alert_rules x SET
      kind = p_rule ->> 'kind', params = coalesce(p_rule -> 'params', '{}'::jsonb), audience = a,
      title_en = btrim(p_rule ->> 'title_en'), title_ar = btrim(p_rule ->> 'title_ar'),
      body_en = btrim(p_rule ->> 'body_en'), body_ar = btrim(p_rule ->> 'body_ar'),
      link = p_rule ->> 'link', enabled = coalesce((p_rule ->> 'enabled')::boolean, true),
      locked = coalesce((p_rule ->> 'locked')::boolean, x.locked),
      version = x.version + 1, updated_at = now(), updated_by = public.app_actor()
    WHERE x.id = rid;
    SELECT to_jsonb(x) - 'created_at' - 'updated_at' INTO after FROM public.alert_rules x WHERE x.id = rid;
    PERFORM public.log_audit_write('alert_rule_update', 'alert_rule', rid::text, before, after, btrim(p_reason));
  END IF;
  RETURN (SELECT jsonb_build_object('id', x.id, 'version', x.version) FROM public.alert_rules x WHERE x.id = rid);
END $$;

-- The daily evaluation of the kpi_threshold rules. The job computes the live KPI values system-wide and passes them in
-- ({<kpi code>: <number or null>}); a rule fires when its KPI crosses the rule's own threshold, one notification per recipient
-- per (rule, day, kpi) through alert_rule_notify. Safe to repeat; a null or missing value skips the rule (a pending KPI alerts nobody).
CREATE OR REPLACE FUNCTION alert_rules_kpi_run(p_values jsonb, p_day date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d date := coalesce(p_day, public.cal_today());
  cat jsonb := public.dashboard_settings_catalogue() -> 'kpis';
  r public.alert_rules; k jsonb; v numeric; th numeric; vs text; ts text; hit boolean;
  n integer := 0; t_en text; t_ar text; b_en text; b_ar text;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM public.alert_rules x WHERE x.enabled AND x.kind = 'kpi_threshold' ORDER BY x.code LOOP
    SELECT e INTO k FROM jsonb_array_elements(cat) e WHERE e ->> 'code' = r.params ->> 'kpi';
    IF k IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(p_values -> (r.params ->> 'kpi')) IS DISTINCT FROM 'number' THEN CONTINUE; END IF;
    v := (p_values ->> (r.params ->> 'kpi'))::numeric;
    th := (r.params ->> 'value')::numeric;
    hit := (r.params ->> 'op' = 'above' AND v > th) OR (r.params ->> 'op' = 'below' AND v < th);
    IF NOT hit THEN CONTINUE; END IF;
    vs := trim(to_char(v, 'FM999999990.###'));
    ts := trim(to_char(th, 'FM999999990.###'));
    t_en := replace(replace(replace(r.title_en, '{{kpi}}', k ->> 'label_en'), '{{value}}', vs), '{{threshold}}', ts);
    t_ar := replace(replace(replace(r.title_ar, '{{kpi}}', coalesce(k ->> 'label_ar', k ->> 'label_en')), '{{value}}', vs), '{{threshold}}', ts);
    b_en := replace(replace(replace(r.body_en, '{{kpi}}', k ->> 'label_en'), '{{value}}', vs), '{{threshold}}', ts);
    b_ar := replace(replace(replace(r.body_ar, '{{kpi}}', coalesce(k ->> 'label_ar', k ->> 'label_en')), '{{value}}', vs), '{{threshold}}', ts);
    n := n + public.alert_rule_notify(r.id, 'day:' || d::text, r.params ->> 'kpi', NULL,
              jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
              coalesce(r.link, '/dashboard'), 'dashboard');
  END LOOP;
  RETURN n;
END $$;

ALTER TABLE public.alert_rules OWNER TO pmis_definer;

DO $$
BEGIN
  ALTER FUNCTION alert_rule_params_errs(text, jsonb) OWNER TO pmis_definer;
  ALTER FUNCTION alert_rules_json() OWNER TO pmis_definer;
  ALTER FUNCTION admin_alert_rule_save(jsonb, text, uuid, integer) OWNER TO pmis_definer;
  ALTER FUNCTION alert_rules_kpi_run(jsonb, date) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION alert_rule_params_errs(text, jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION alert_rules_json() FROM PUBLIC;
  REVOKE ALL ON FUNCTION admin_alert_rule_save(jsonb, text, uuid, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION alert_rules_kpi_run(jsonb, date) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION alert_rule_params_errs(text, jsonb) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION alert_rules_json() TO pmis_definer;
  GRANT EXECUTE ON FUNCTION admin_alert_rule_save(jsonb, text, uuid, integer) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION alert_rules_kpi_run(jsonb, date) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION alert_rules_json() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_alert_rule_save(jsonb, text, uuid, integer) TO pmis_app;
    GRANT EXECUTE ON FUNCTION alert_rules_kpi_run(jsonb, date) TO pmis_app;
  END IF;
END $$;

-- Data reset coverage (0152): no new table. alert_rules stays KEEP (configuration, with the SLA rules), alert_rule_fires stays LOG.
