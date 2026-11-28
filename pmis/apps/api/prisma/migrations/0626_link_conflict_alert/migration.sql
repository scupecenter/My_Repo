-- 0626_link_conflict_alert: consistency alert of the register links catalogue. Notifications only, additive (contract 0.15.485).
-- Mirror: db/sql/625_link_conflict_alert.sql (kept identical to prisma/migrations/0626_link_conflict_alert/migration.sql).
--
--   link_conflict  {register_key?, field_code?, min_rows 1..100000, optional default 1}  fires once per declared link (register_links, 0409) that has at
--                  least `min_rows` approved current rows whose linked record in the target register is still open (neither approved nor voided).
--                  Without register_key and field_code every declared link is checked; field_code needs register_key. period: the working week,
--                  target: register_key.field_code. Placeholders: {{register}}, {{field}}, {{target}} (the target register key), {{count}}.
--   register_link_conflicts()  per declared link: rows with a value, and the conflicting rows. Read-only; the app role has no grant.
-- The kind list, alert_rule_params_errs() and alert_rules_run() are patched in place and idempotently. No table, no reset-plan change, no grant widened.

CREATE OR REPLACE FUNCTION register_link_conflicts() RETURNS TABLE (register_key text, field_code text, target_register text, rows_with_value bigint, conflict_rows bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.register_key, k.field_code, k.target_register,
         count(*) FILTER (WHERE coalesce(r.data ->> k.field_code, '') <> ''),
         count(*) FILTER (WHERE coalesce(r.data ->> k.field_code, '') <> ''
                            AND EXISTS (SELECT 1 FROM public.register_records t WHERE t.register_key = k.target_register AND t.is_current
                                        AND t.state NOT IN ('approved', 'voided')
                                        AND (t.entity_id::text = r.data ->> k.field_code OR t.id::text = r.data ->> k.field_code)))
    FROM public.register_links k
    LEFT JOIN public.register_records r ON r.register_key = k.register_key AND r.is_current AND r.state = 'approved'
   WHERE k.is_active GROUP BY k.register_key, k.field_code, k.target_register, k.sort_order ORDER BY k.sort_order, k.field_code
$$;

-- 1. the closed kind list of the table
DO $$
DECLARE cname text; def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO cname, def FROM pg_constraint c
   WHERE c.conrelid = 'public.alert_rules'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%record_idle%' LIMIT 1;
  IF cname IS NULL THEN RAISE EXCEPTION 'alert_rules: the kind check was not found'; END IF;
  IF position('link_conflict' IN def) = 0 THEN
    IF position('''record_idle''' IN def) = 0 THEN RAISE EXCEPTION 'alert_rules: the kind list anchor was not found'; END IF;
    EXECUTE format('ALTER TABLE public.alert_rules DROP CONSTRAINT %I', cname);
    EXECUTE format('ALTER TABLE public.alert_rules ADD CONSTRAINT %I %s', cname, replace(def, '''record_idle''', '''record_idle'', ''link_conflict'''));
  END IF;
END $$;

-- 2. the params check
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('link_conflict' IN def) = 0 THEN
    ins := $ins$ELSIF p_kind = 'link_conflict' THEN
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
  IF position('link_conflict' IN def) = 0 THEN
    ins := $ins$ELSIF r.kind = 'link_conflict' THEN
      FOR c IN SELECT o.register_key AS rk, o.field_code AS fc, o.target_register AS tr, o.conflict_rows AS cnt,
                      (SELECT d2.module_key FROM public.register_definitions d2 WHERE d2.register_key = o.register_key) AS mk
               FROM public.register_link_conflict() o
               WHERE o.conflict_rows >= coalesce(nullif(r.params ->> 'min_rows', '')::int, 1)
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


DO $$
BEGIN
  ALTER FUNCTION register_link_conflicts() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION register_link_conflicts() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION register_link_conflicts() TO pmis_definer;
END $$;
