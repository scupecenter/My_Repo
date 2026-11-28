-- 0625_alert_defaults: two additions to the automation centre (contract 0.15.484). Notifications only, additive.
-- Mirror: db/sql/624_alert_defaults.sql (kept identical to prisma/migrations/0625_alert_defaults/migration.sql).
--
--   data_gaps  {min_sites 1..100000, optional default 1}  weekly data-completeness reminder: fires once a week for every region that has at least `min_sites`
--              active sites with a data gap (a delivery scenario that is not set, or a task with no actual date that a later task of the site already has).
--              period: the working week (Sunday), target: the region id. Placeholders {{region}}, {{count}} (the sites with a gap), {{week}}. The audience is
--              the module audience of 0342 (the people who work on the module in that region), so the reminder reaches the data owners of the region.
--              Link default /sites?data_gaps=with.
--   alert_rules_seed_defaults()  puts the default rules in place once: one record_idle rule for each main register that exists and is enabled (a record
--              in the entry state for 14 days), audience = the register's module, and one data_gaps rule for the sites. A default is a normal alert
--              rule: an admin switches it off or edits it in the Automation centre and the change is kept (a rule that exists is never touched). It runs at the
--              start of alert_rules_run() and does nothing until a System Admin exists (the rule needs an author).
--
-- The kind list of the table, alert_rule_params_errs() and alert_rules_run() are accumulating objects: each is patched in place and idempotently (the stored
-- text is extended at anchors), so kinds added by other migrations stay. No table, no reset-plan change, no role grant widened.

-- 1. the closed kind list of the table
DO $$
DECLARE cname text; def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO cname, def FROM pg_constraint c
   WHERE c.conrelid = 'public.alert_rules'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%record_idle%' LIMIT 1;
  IF cname IS NULL THEN RAISE EXCEPTION 'alert_rules: the kind check was not found'; END IF;
  IF position('data_gaps' IN def) = 0 THEN
    IF position('''record_idle''' IN def) = 0 THEN RAISE EXCEPTION 'alert_rules: the kind list anchor was not found'; END IF;
    EXECUTE format('ALTER TABLE public.alert_rules DROP CONSTRAINT %I', cname);
    EXECUTE format('ALTER TABLE public.alert_rules ADD CONSTRAINT %I %s', cname, replace(def, '''record_idle''', '''record_idle'', ''data_gaps'''));
  END IF;
END $$;

-- 2. the params check
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('data_gaps' IN def) = 0 THEN
    ins := $ins$ELSIF p_kind = 'data_gaps' THEN
    IF p_params - 'min_sites' <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes only min_sites.');
    END IF;
    IF p_params ? 'min_sites' AND (coalesce(p_params ->> 'min_sites', '') !~ '^[0-9]+$' OR NOT ((p_params ->> 'min_sites')::numeric BETWEEN 1 AND 100000)) THEN
      errs := errs || jsonb_build_object('path', '/params/min_sites', 'code', 'invalid', 'message', 'min_sites is 1 to 100000.');
    END IF;
  $ins$;
    IF regexp_replace(def, 'ELSE(\s+errs := errs \|\| jsonb_build_object\(''path'', ''/kind'')', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rule_params_errs: the unknown-kind anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, 'ELSE(\s+errs := errs \|\| jsonb_build_object\(''path'', ''/kind'')', ins || 'ELSE\1');
  END IF;
END $$;

-- 3. the default rules, created once and never touched again
CREATE OR REPLACE FUNCTION public.alert_rules_seed_defaults() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE author uuid; d record; n integer := 0; c text;
BEGIN
  SELECT u.id INTO author FROM public.users u
   WHERE u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass AND public.app_user_is_system_admin(u.id)
   ORDER BY u.created_at, u.id LIMIT 1;
  IF author IS NULL THEN RETURN 0; END IF;
  FOR d IN SELECT rd.register_key, rd.name_en, rd.name_ar, rd.module_key FROM public.register_definitions rd
            WHERE rd.is_active AND rd.enabled AND rd.register_key IN ('acquisition', 'procurement', 'change_control', 'issues', 'risks', 'rf_design', 'permits', 'gecol', 'hlc')
            ORDER BY rd.sort_order, rd.register_key LOOP
    c := 'idle-' || replace(d.register_key, '_', '-');
    IF NOT EXISTS (SELECT 1 FROM public.alert_rules WHERE code = c) THEN
      INSERT INTO public.alert_rules (code, kind, params, audience, title_en, title_ar, body_en, body_ar, link, enabled, created_by, updated_by)
      VALUES (c, 'record_idle', jsonb_build_object('register_key', d.register_key, 'state', 'entry', 'days', 14), jsonb_build_object('type', 'module', 'module', d.module_key),
              d.name_en || ' record idle for {{days}} days: {{record}}', coalesce(d.name_ar, d.name_en) || ': سجل بلا حركة منذ {{days}} أيام: {{record}}',
              '{{record}} has been {{state}} for at least {{days}} days.', '{{record}} في حالة {{state}} منذ {{days}} أيام على الأقل.', NULL, true, author, author);
      n := n + 1;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.alert_rules WHERE code = 'data-completeness-weekly') THEN
    INSERT INTO public.alert_rules (code, kind, params, audience, title_en, title_ar, body_en, body_ar, link, enabled, created_by, updated_by)
    VALUES ('data-completeness-weekly', 'data_gaps', '{}'::jsonb, '{"type":"module","module":"sites"}'::jsonb,
            'Data to complete: {{region}}', 'بيانات تحتاج استكمالاً: {{region}}',
            '{{count}} site(s) in {{region}} have missing data for the week of {{week}}. Open the sites with data gaps and complete them.',
            '{{count}} موقعاً في {{region}} ينقصها بيانات لأسبوع {{week}}. افتح المواقع ذات النواقص واستكملها.', '/sites?data_gaps=with', true, author, author);
    n := n + 1;
  END IF;
  RETURN n;
END $$;

-- 4. the daily evaluation: seed the defaults first, then the data_gaps kind
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rules_run(date)'::regprocedure);
  IF position('alert_rules_seed_defaults' IN def) = 0 THEN
    IF regexp_replace(def, '(BEGIN\s+)(FOR r IN SELECT \* FROM public\.alert_rules x WHERE x\.enabled)', 'X\2') = def THEN
      RAISE EXCEPTION 'alert_rules_run: the rule loop anchor was not found';
    END IF;
    def := regexp_replace(def, '(BEGIN\s+)(FOR r IN SELECT \* FROM public\.alert_rules x WHERE x\.enabled)', '\1PERFORM public.alert_rules_seed_defaults();' || chr(10) || '  \2');
    EXECUTE def;
  END IF;
END $$;
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rules_run(date)'::regprocedure);
  IF position('''data_gaps''' IN def) = 0 THEN
    ins := $ins$ELSIF r.kind = 'data_gaps' THEN
      FOR c IN SELECT rg.id AS rid, rg.name_en AS rn_en, coalesce(rg.name_ar, rg.name_en) AS rn_ar, g.cnt
               FROM public.regions rg
               JOIN LATERAL (SELECT count(*)::int AS cnt FROM public.sites s
                              WHERE s.region_id = rg.id AND s.is_active AND s.overall_status IS DISTINCT FROM 'cancelled'
                                AND (s.delivery_scenario IS NULL
                                     OR EXISTS (SELECT 1 FROM public.task_instances ti
                                                  JOIN public.task_definitions td ON td.id = ti.task_def_id AND NOT td.is_milestone_task
                                                  JOIN public.task_predecessors tp ON tp.predecessor_id = ti.task_def_id
                                                  JOIN public.task_instances si ON si.site_id = s.id AND si.task_def_id = tp.task_def_id AND si.actual_date IS NOT NULL
                                                 WHERE ti.site_id = s.id AND ti.actual_date IS NULL AND NOT ti.is_na AND ti.state NOT IN ('approved', 'na', 'skipped')))) g ON true
               WHERE g.cnt >= coalesce(nullif(r.params ->> 'min_sites', '')::int, 1)
               ORDER BY rg.id LOOP
        t_en := replace(replace(replace(r.title_en, '{{region}}', c.rn_en), '{{count}}', c.cnt::text), '{{week}}', wk::text);
        t_ar := replace(replace(replace(r.title_ar, '{{region}}', c.rn_ar), '{{count}}', c.cnt::text), '{{week}}', wk::text);
        b_en := replace(replace(replace(r.body_en, '{{region}}', c.rn_en), '{{count}}', c.cnt::text), '{{week}}', wk::text);
        b_ar := replace(replace(replace(r.body_ar, '{{region}}', c.rn_ar), '{{count}}', c.cnt::text), '{{week}}', wk::text);
        n := n + public.alert_rule_notify(r.id, 'week:' || wk::text, c.rid::text, c.rid,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/sites?data_gaps=with'), 'sites');
      END LOOP;
    $ins$;
    IF regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rules_run: the loop end anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', ins || '\1');
  END IF;
END $$;

GRANT SELECT ON public.users, public.register_definitions, public.regions, public.sites, public.task_instances, public.task_definitions, public.task_predecessors TO pmis_definer;
GRANT INSERT ON public.alert_rules TO pmis_definer;
DO $$
BEGIN
  ALTER FUNCTION public.alert_rules_seed_defaults() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION public.alert_rules_seed_defaults() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.alert_rules_seed_defaults() TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON FUNCTION public.alert_rules_seed_defaults() FROM pmis_app;
  END IF;
END $$;
