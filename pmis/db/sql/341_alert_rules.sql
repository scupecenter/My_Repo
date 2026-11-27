-- 0342_alert_rules: generic if/then alert rules, notifications only (the PM-platforms research of 2026-11-27, item 13; contract 0.15.242; CHANGELOG AlertRules).
-- Mirror: db/sql/341_alert_rules.sql (kept identical to prisma/migrations/0342_alert_rules/migration.sql).
--
-- WHAT. Generic if/then alert rules, NOTIFICATIONS ONLY (no state, owner or permission changes). A System Admin (or an all-regions admin.settings
-- delegate) manages the rules in Settings. Each rule: a closed condition kind with closed params, a closed audience, and a title/body template in
-- English and Arabic with {{placeholders}} of the kind. The daily job (jobs.service, the weekly_digest_notify pattern) runs alert_rules_run for the
-- kinds whose targets the database finds, and hands the live KPI of the run day to alert_rule_notify for kpi_threshold (the dashboard computes the
-- value). One in-app notification per recipient per rule per period and target; alert_rule_fires is the dedupe record, so a second run adds nothing.
--
-- KINDS (closed catalogue, v1). kpi_threshold is designed (params kpi + band of the dashboard catalogue) but NOT in v1: the KPI values are computed
-- by the web dashboard under the caller's row security and the daily job has no actor, so a correct evaluation needs a definer-side KPI evaluator
-- (a fast follow). v1 ships the two kinds whose targets the database finds directly:
--   weekly_status_missing  {} - fires for every region without a Weekly status update of the current working week (complements item 12).
--                          period: the week start, target: the region id. Link default /status-updates.
--   record_idle            {register_key, state, days 1..3650} - fires for every current record of the register that has been in the state for at
--                          least `days` calendar days. period: the run day, target: the record id. Link default /registers/<register_key>.
--
-- AUDIENCE (closed): {"type":"system_admin"} = the System Admins group members; {"type":"module","module":<module key>} = the active users whose
-- current role assignments cover the module (all regions, or the item's region, the weekly_digest_notify reach pattern).
--
-- TEMPLATES. title_en/title_ar up to 200 chars, body_en/body_ar up to 2000. The placeholders replaced at fire time: {{value}}, {{kpi}}, {{region}},
-- {{record}}, {{days}}, {{state}}, {{week}} (unknown placeholders stay as written; {{value}} and {{kpi}} are reserved for the KPI kind). The recipient's users.locale picks the language, English fallback.
-- IN-APP ONLY. This migration adds no mail rule; an admin who lists the kind alert_rule in mail.notification_kinds gets it mailed as well.

CREATE TABLE public.alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  kind text NOT NULL CHECK (kind IN ('weekly_status_missing', 'record_idle')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience jsonb NOT NULL,
  title_en text NOT NULL, title_ar text NOT NULL,
  body_en text NOT NULL, body_ar text NOT NULL,
  link text,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL REFERENCES public.users(id)
);

CREATE TABLE public.alert_rule_fires (
  rule_id uuid NOT NULL REFERENCES public.alert_rules(id) ON DELETE CASCADE,
  period_key text NOT NULL,
  target text NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, period_key, target)
);

-- The closed per-kind params check. Returns the field errors (an empty array when valid).
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
  ELSE
    errs := errs || jsonb_build_object('path', '/kind', 'code', 'invalid', 'message', 'Unknown alert rule kind.');
  END IF;
  RETURN errs;
END $$;

-- The rules for the management screen (admin.settings edit, as the other system settings).
CREATE OR REPLACE FUNCTION alert_rules_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'code', r.code, 'kind', r.kind, 'params', r.params, 'audience', r.audience,
      'title_en', r.title_en, 'title_ar', r.title_ar, 'body_en', r.body_en, 'body_ar', r.body_ar,
      'link', r.link, 'enabled', r.enabled, 'version', r.version,
      'created_at', r.created_at, 'updated_at', r.updated_at) ORDER BY r.code)
    FROM public.alert_rules r), '[]'::jsonb);
END $$;

-- Create (p_id null) or update (If-Match p_version) a rule. admin.settings edit for all regions, a reason, one audit row.
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
    INSERT INTO public.alert_rules (code, kind, params, audience, title_en, title_ar, body_en, body_ar, link, enabled, created_by, updated_by)
    VALUES (p_rule ->> 'code', p_rule ->> 'kind', coalesce(p_rule -> 'params', '{}'::jsonb), a,
            btrim(p_rule ->> 'title_en'), btrim(p_rule ->> 'title_ar'), btrim(p_rule ->> 'body_en'), btrim(p_rule ->> 'body_ar'),
            p_rule ->> 'link', coalesce((p_rule ->> 'enabled')::boolean, true), public.app_actor(), public.app_actor())
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
      version = x.version + 1, updated_at = now(), updated_by = public.app_actor()
    WHERE x.id = rid;
    SELECT to_jsonb(x) - 'created_at' - 'updated_at' INTO after FROM public.alert_rules x WHERE x.id = rid;
    PERFORM public.log_audit_write('alert_rule_update', 'alert_rule', rid::text, before, after, btrim(p_reason));
  END IF;
  RETURN (SELECT jsonb_build_object('id', x.id, 'version', x.version) FROM public.alert_rules x WHERE x.id = rid);
END $$;

-- One notification per recipient, deduped by (rule, period, target): the number of notifications written (0 when this fire is a repeat or the rule
-- is off). Called by the daily job only; the caller renders the templates, the recipients are resolved here from the audience. The recipient's
-- users.locale picks the language of the title and body (English fallback). The job runs with no signed-in actor, so no admin check happens here.
CREATE OR REPLACE FUNCTION alert_rule_notify(p_rule_id uuid, p_period text, p_target text, p_region integer, p_title jsonb, p_body jsonb, p_link text, p_module text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.alert_rules; n integer := 0;
BEGIN
  SELECT * INTO r FROM public.alert_rules x WHERE x.id = p_rule_id AND x.enabled;
  IF NOT FOUND THEN RETURN 0; END IF;
  INSERT INTO public.alert_rule_fires (rule_id, period_key, target) VALUES (p_rule_id, p_period, p_target) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 0; END IF;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
  SELECT u.user_id, 'in_app', 'alert_rule',
         coalesce(nullif(p_title ->> u.loc, ''), p_title ->> 'en'),
         coalesce(nullif(p_body ->> u.loc, ''), p_body ->> 'en'),
         p_link, p_module
  FROM (
    SELECT x.user_id, CASE WHEN x.locale = 'ar' THEN 'ar' ELSE 'en' END AS loc
    FROM (
      -- the System Admins group members
      SELECT gm.user_id, ux.locale FROM public.group_members gm
        JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
        JOIN public.users ux ON ux.id = gm.user_id AND ux.status = 'active' AND ux.deleted_at IS NULL AND NOT ux.is_break_glass
      WHERE r.audience ->> 'type' = 'system_admin'
      UNION
      -- the active users whose current assignments cover the module; an item region narrows the reach as in weekly_digest_notify
      SELECT a.user_id, ux.locale FROM public.user_role_assignments a
        JOIN public.users ux ON ux.id = a.user_id AND ux.status = 'active' AND ux.deleted_at IS NULL AND NOT ux.is_break_glass
      WHERE r.audience ->> 'type' = 'module'
        AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
        AND (a.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = a.id AND m.module_key = r.audience ->> 'module'))
        AND (p_region IS NULL OR a.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions y WHERE y.assignment_id = a.id AND y.region_id = p_region))
    ) x
  ) u;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- The daily evaluation of every kind of v1 (the daily job calls it; jobs.service, the weekly_digest_notify pattern). Safe to repeat:
-- alert_rule_notify writes nothing twice. Returns the notifications written.
CREATE OR REPLACE FUNCTION alert_rules_run(p_day date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d date := coalesce(p_day, public.cal_today());
  wk date := d - extract(dow FROM d)::int;   -- the Sunday that opens the working week (status_updates.week_start)
  r public.alert_rules; c record; n integer := 0;
  t_en text; t_ar text; b_en text; b_ar text; rec_label text; mod text;
BEGIN
  FOR r IN SELECT * FROM public.alert_rules x WHERE x.enabled ORDER BY x.code LOOP
    IF r.kind = 'weekly_status_missing' THEN
      FOR c IN SELECT rg.id, rg.name_en, rg.name_ar FROM public.regions rg
               WHERE NOT EXISTS (SELECT 1 FROM public.status_updates s WHERE s.scope = 'region' AND s.region_id = rg.id AND s.week_start = wk)
               ORDER BY rg.id LOOP
        t_en := replace(replace(r.title_en, '{{region}}', c.name_en), '{{week}}', wk::text);
        t_ar := replace(replace(r.title_ar, '{{region}}', coalesce(c.name_ar, c.name_en)), '{{week}}', wk::text);
        b_en := replace(replace(r.body_en, '{{region}}', c.name_en), '{{week}}', wk::text);
        b_ar := replace(replace(r.body_ar, '{{region}}', coalesce(c.name_ar, c.name_en)), '{{week}}', wk::text);
        n := n + public.alert_rule_notify(r.id, 'week:' || wk::text, c.id::text, c.id,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/status-updates'), 'sites');
      END LOOP;
    ELSIF r.kind = 'record_idle' THEN
      SELECT d2.module_key INTO mod FROM public.register_definitions d2 WHERE d2.register_key = r.params ->> 'register_key';
      FOR c IN SELECT rec.id, rec.region_id, rec.entity_id, rec.data FROM public.register_records rec
               WHERE rec.is_current AND rec.register_key = r.params ->> 'register_key' AND rec.state = r.params ->> 'state'
                 AND rec.updated_at <= now() - make_interval(days => (r.params ->> 'days')::int)
               ORDER BY rec.id LOOP
        rec_label := coalesce(c.data ->> 'code', c.data ->> 'name', c.entity_id::text);
        t_en := replace(replace(replace(replace(r.title_en, '{{record}}', rec_label), '{{state}}', r.params ->> 'state'), '{{days}}', r.params ->> 'days'), '{{region}}', '');
        t_ar := replace(replace(replace(replace(r.title_ar, '{{record}}', rec_label), '{{state}}', r.params ->> 'state'), '{{days}}', r.params ->> 'days'), '{{region}}', '');
        b_en := replace(replace(replace(replace(r.body_en, '{{record}}', rec_label), '{{state}}', r.params ->> 'state'), '{{days}}', r.params ->> 'days'), '{{region}}', '');
        b_ar := replace(replace(replace(replace(r.body_ar, '{{record}}', rec_label), '{{state}}', r.params ->> 'state'), '{{days}}', r.params ->> 'days'), '{{region}}', '');
        n := n + public.alert_rule_notify(r.id, 'day:' || d::text, c.id::text, c.region_id,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/registers/' || (r.params ->> 'register_key')), mod);
      END LOOP;
    END IF;
  END LOOP;
  RETURN n;
END $$;

ALTER TABLE public.alert_rules OWNER TO pmis_definer;
ALTER TABLE public.alert_rule_fires OWNER TO pmis_definer;
REVOKE ALL ON public.alert_rules FROM PUBLIC;
REVOKE ALL ON public.alert_rule_fires FROM PUBLIC;

GRANT SELECT ON public.users, public.group_members, public.groups, public.user_role_assignments, public.user_role_assignment_regions,
  public.user_role_assignment_modules, public.register_definitions, public.regions, public.status_updates, public.register_records TO pmis_definer;
GRANT INSERT ON public.notifications TO pmis_definer;

DO $$
BEGIN
  ALTER FUNCTION alert_rule_params_errs(text, jsonb) OWNER TO pmis_definer;
  ALTER FUNCTION alert_rules_json() OWNER TO pmis_definer;
  ALTER FUNCTION admin_alert_rule_save(jsonb, text, uuid, integer) OWNER TO pmis_definer;
  ALTER FUNCTION alert_rule_notify(uuid, text, text, integer, jsonb, jsonb, text, text) OWNER TO pmis_definer;
  ALTER FUNCTION alert_rules_run(date) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION alert_rule_params_errs(text, jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION alert_rules_json() FROM PUBLIC;
  REVOKE ALL ON FUNCTION admin_alert_rule_save(jsonb, text, uuid, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION alert_rule_notify(uuid, text, text, integer, jsonb, jsonb, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION alert_rules_run(date) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION alert_rule_params_errs(text, jsonb) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION alert_rules_json() TO pmis_definer;
  GRANT EXECUTE ON FUNCTION admin_alert_rule_save(jsonb, text, uuid, integer) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION alert_rule_notify(uuid, text, text, integer, jsonb, jsonb, text, text) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION alert_rules_run(date) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION alert_rules_json() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_alert_rule_save(jsonb, text, uuid, integer) TO pmis_app;
    GRANT EXECUTE ON FUNCTION alert_rule_notify(uuid, text, text, integer, jsonb, jsonb, text, text) TO pmis_app;
    GRANT EXECUTE ON FUNCTION alert_rules_run(date) TO pmis_app;
  END IF;
END $$;
