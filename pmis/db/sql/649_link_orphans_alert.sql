-- 0650_link_orphans_alert: the orphans alert of the register links catalogue (D60 follow-up, contract 0.15.510). Notifications only, additive.
-- Mirror: db/sql/649_link_orphans_alert.sql (kept identical to prisma/migrations/0650_link_orphans_alert/migration.sql).
--
--   link_orphans  {register_key?, field_code?, min_rows 1..100000, optional default 1}  fires once per declared link (register_links, 0409) that has at
--                 least `min_rows` current rows holding an id which is no current record of the target (register_link_orphans()). Without register_key
--                 and field_code every declared link is checked; field_code needs register_key. period: the working week (Sunday), target:
--                 register_key.field_code, so the reminder comes once a week while the link keeps dangling. Placeholders: {{register}}, {{field}},
--                 {{target}} (the target register key), {{count}} (the orphan rows). Audience, templates, the journal (alert_rule_fires) are those of 0342.
--   register_link_orphans_json(limit)  System Admin report (admin.settings): the same counts per declared link plus up to `limit` (default 20, max 100)
--                 example record ids of the rows that dangle, for GET /settings/alert-rules/link-orphans.
--
-- The kind list of the table, alert_rule_params_errs() and alert_rules_run() are accumulating objects: each is patched in place and idempotently (the stored
-- text is extended at anchors that do not assume indentation), so kinds added by other migrations stay. No table, no reset-plan change, no role grant widened.

-- 1. the closed kind list of the table
DO $$
DECLARE cname text; def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO cname, def FROM pg_constraint c
   WHERE c.conrelid = 'public.alert_rules'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%record_idle%' LIMIT 1;
  IF cname IS NULL THEN RAISE EXCEPTION 'alert_rules: the kind check was not found'; END IF;
  IF position('link_orphans' IN def) = 0 THEN
    IF position('''record_idle''' IN def) = 0 THEN RAISE EXCEPTION 'alert_rules: the kind list anchor was not found'; END IF;
    EXECUTE format('ALTER TABLE public.alert_rules DROP CONSTRAINT %I', cname);
    EXECUTE format('ALTER TABLE public.alert_rules ADD CONSTRAINT %I %s', cname, replace(def, '''record_idle''', '''record_idle'', ''link_orphans'''));
  END IF;
END $$;

-- 2. the params check
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('link_orphans' IN def) = 0 THEN
    ins := $ins$ELSIF p_kind = 'link_orphans' THEN
    IF p_params - 'register_key' - 'field_code' - 'min_rows' <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes only register_key, field_code and min_rows.');
    END IF;
    IF p_params ? 'register_key' AND (jsonb_typeof(p_params -> 'register_key') <> 'string' OR NOT EXISTS (SELECT 1 FROM public.register_links k WHERE k.register_key = p_params ->> 'register_key')) THEN
      errs := errs || jsonb_build_object('path', '/params/register_key', 'code', 'invalid', 'message', 'register_key must be a register that has a declared link.');
    END IF;
    IF p_params ? 'field_code' AND (jsonb_typeof(p_params -> 'field_code') <> 'string' OR NOT (p_params ? 'register_key')
         OR NOT EXISTS (SELECT 1 FROM public.register_links k WHERE k.register_key = p_params ->> 'register_key' AND k.field_code = p_params ->> 'field_code')) THEN
      errs := errs || jsonb_build_object('path', '/params/field_code', 'code', 'invalid', 'message', 'field_code must be a declared link of register_key.');
    END IF;
    IF p_params ? 'min_rows' AND (coalesce(p_params ->> 'min_rows', '') !~ '^[0-9]+$' OR NOT ((p_params ->> 'min_rows')::numeric BETWEEN 1 AND 100000)) THEN
      errs := errs || jsonb_build_object('path', '/params/min_rows', 'code', 'invalid', 'message', 'min_rows is 1 to 100000.');
    END IF;
  $ins$;
    IF regexp_replace(def, 'ELSE(\s+errs := errs \|\| jsonb_build_object\(''path'', ''/kind'')', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rule_params_errs: the unknown-kind anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, 'ELSE(\s+errs := errs \|\| jsonb_build_object\(''path'', ''/kind'')', ins || 'ELSE\1');
  END IF;
END $$;

-- 3. the daily evaluation
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rules_run(date)'::regprocedure);
  IF position('link_orphans' IN def) = 0 THEN
    ins := $ins$ELSIF r.kind = 'link_orphans' THEN
      FOR c IN SELECT o.register_key AS rk, o.field_code AS fc, o.target_register AS tr, o.orphan_rows AS cnt,
                      (SELECT d2.module_key FROM public.register_definitions d2 WHERE d2.register_key = o.register_key) AS mk
               FROM public.register_link_orphans() o
               WHERE o.orphan_rows >= coalesce(nullif(r.params ->> 'min_rows', '')::int, 1)
                 AND (r.params ->> 'register_key' IS NULL OR o.register_key = r.params ->> 'register_key')
                 AND (r.params ->> 'field_code' IS NULL OR o.field_code = r.params ->> 'field_code')
               ORDER BY o.register_key, o.field_code LOOP
        t_en := replace(replace(replace(replace(replace(r.title_en, '{{register}}', c.rk), '{{field}}', c.fc), '{{target}}', c.tr), '{{count}}', c.cnt::text), '{{region}}', '');
        t_ar := replace(replace(replace(replace(replace(r.title_ar, '{{register}}', c.rk), '{{field}}', c.fc), '{{target}}', c.tr), '{{count}}', c.cnt::text), '{{region}}', '');
        b_en := replace(replace(replace(replace(replace(r.body_en, '{{register}}', c.rk), '{{field}}', c.fc), '{{target}}', c.tr), '{{count}}', c.cnt::text), '{{region}}', '');
        b_ar := replace(replace(replace(replace(replace(r.body_ar, '{{register}}', c.rk), '{{field}}', c.fc), '{{target}}', c.tr), '{{count}}', c.cnt::text), '{{region}}', '');
        n := n + public.alert_rule_notify(r.id, 'week:' || wk::text, c.rk || '.' || c.fc, NULL,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/registers/' || c.rk), c.mk);
      END LOOP;
    $ins$;
    IF regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rules_run: the loop end anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', ins || '\1');
  END IF;
END $$;

-- 4. the System Admin report with example ids
CREATE OR REPLACE FUNCTION register_link_orphans_json(p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE lim integer := least(greatest(coalesce(p_limit, 20), 1), 100);
BEGIN
  PERFORM public.calc_require_admin('admin.settings', false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'register_key', o.register_key, 'field_code', o.field_code, 'target_register', o.target_register,
      'rows_with_value', o.rows_with_value, 'orphan_rows', o.orphan_rows,
      'examples', coalesce((SELECT jsonb_agg(x.id) FROM (
          SELECT r.id FROM public.register_records r
           WHERE r.register_key = o.register_key AND r.is_current AND r.state <> 'voided' AND coalesce(r.data ->> o.field_code, '') <> ''
             AND NOT EXISTS (SELECT 1 FROM public.register_records t WHERE t.register_key = o.target_register AND t.is_current
                             AND (t.entity_id::text = r.data ->> o.field_code OR t.id::text = r.data ->> o.field_code))
           ORDER BY r.id LIMIT lim) x), '[]'::jsonb)) ORDER BY o.register_key, o.field_code)
    FROM public.register_link_orphans() o), '[]'::jsonb);
END $$;

DO $$
BEGIN
  ALTER FUNCTION register_link_orphans_json(integer) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION register_link_orphans_json(integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION register_link_orphans_json(integer) TO pmis_definer;
  GRANT EXECUTE ON FUNCTION register_link_orphans() TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION register_link_orphans_json(integer) TO pmis_app;
  END IF;
END $$;
