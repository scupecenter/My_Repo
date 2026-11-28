-- 0700_alert_date_approaching: third generic alert kind date_approaching for the alert rules (0342, 0408), notifications only (L5; contract 0.15.560).
-- Mirror: db/sql/699_alert_date_approaching.sql (kept identical to prisma/migrations/0700_alert_date_approaching/migration.sql).
--
--   date_approaching   {register_key, date_field, days_before 0..365}  fires for every current approved record of the register whose date field
--                      `date_field` falls from today up to `days_before` days ahead. register_key must be an active register and date_field a field of
--                      that register of type date (register_fields), so the form offers a closed list. Dates already past do not fire (the existing
--                      invoice_due_soon kind of 0408 keeps its own overdue behaviour). period: the date value, target: the record id (once per record
--                      and date; a changed date fires again). Placeholders: {{record}} (code, name, invoice no. or the short id), {{due}} (the date),
--                      {{days}} (days left), {{field}} (the field code), {{register}} (the register key).
--   Fields the Settings form offers include invoices due_date, permits_hse valid_to, contractors contract_end and safety_cert_expiry (a team record
--   field); a register that gains a date field later (for example C4 calibration due) is offered automatically, nothing is hard-coded.
--
-- The kind list of the table, alert_rule_params_errs() and alert_rules_run() are accumulating objects: each is patched in place and idempotently (the
-- stored text is extended at anchors that do not assume indentation), so kinds added by other migrations stay. Audience, templates, the
-- one-per-period-and-target journal (alert_rule_fires) and the mail rule are the ones of 0342; nothing new is stored, so no table, no reset-plan change,
-- no grant to a user role.

-- 1. the closed kind list of the table
DO $$
DECLARE cname text; def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO cname, def FROM pg_constraint c
   WHERE c.conrelid = 'public.alert_rules'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%record_idle%' LIMIT 1;
  IF cname IS NULL THEN RAISE EXCEPTION 'alert_rules: the kind check was not found'; END IF;
  IF position('date_approaching' IN def) = 0 THEN
    IF position('''record_idle''' IN def) = 0 THEN RAISE EXCEPTION 'alert_rules: the kind list anchor was not found'; END IF;
    EXECUTE format('ALTER TABLE public.alert_rules DROP CONSTRAINT %I', cname);
    EXECUTE format('ALTER TABLE public.alert_rules ADD CONSTRAINT %I %s', cname, replace(def, '''record_idle''', '''record_idle'', ''date_approaching'''));
  END IF;
END $$;

-- 2. the params check
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('date_approaching' IN def) = 0 THEN
    ins := $ins$ELSIF p_kind = 'date_approaching' THEN
    IF p_params - 'register_key' - 'date_field' - 'days_before' <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes register_key, date_field and days_before.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.is_active AND d.register_key = p_params ->> 'register_key') THEN
      errs := errs || jsonb_build_object('path', '/params/register_key', 'code', 'invalid', 'message', 'A known register key.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = p_params ->> 'register_key' AND f.code = p_params ->> 'date_field' AND f.field_type = 'date') THEN
      errs := errs || jsonb_build_object('path', '/params/date_field', 'code', 'invalid', 'message', 'A date field of that register.');
    END IF;
    IF coalesce(p_params ->> 'days_before', '') !~ '^[0-9]+$' OR NOT ((p_params ->> 'days_before')::int BETWEEN 0 AND 365) THEN
      errs := errs || jsonb_build_object('path', '/params/days_before', 'code', 'invalid', 'message', 'days_before is 0 to 365.');
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
  IF position('date_approaching' IN def) = 0 THEN
    ins := $ins$ELSIF r.kind = 'date_approaching' THEN
      SELECT d2.module_key INTO mod FROM public.register_definitions d2 WHERE d2.register_key = r.params ->> 'register_key';
      FOR c IN SELECT rec.id, rec.region_id, rec.entity_id, rec.data,
                      ((rec.data ->> (r.params ->> 'date_field'))::date - d) AS left_days,
                      coalesce(nullif(rec.data ->> 'code', ''), nullif(rec.data ->> 'name', ''), nullif(rec.data ->> 'invoice_no', ''), left(rec.entity_id::text, 8)) AS lbl
               FROM public.register_records rec
               WHERE rec.is_current AND rec.register_key = r.params ->> 'register_key' AND rec.state = 'approved'
                 AND CASE WHEN coalesce(rec.data ->> (r.params ->> 'date_field'), '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                          THEN (rec.data ->> (r.params ->> 'date_field'))::date BETWEEN d AND d + (r.params ->> 'days_before')::int ELSE false END
               ORDER BY rec.id LOOP
        t_en := replace(replace(replace(replace(replace(r.title_en, '{{record}}', c.lbl), '{{due}}', c.data ->> (r.params ->> 'date_field')), '{{days}}', c.left_days::text), '{{field}}', r.params ->> 'date_field'), '{{register}}', r.params ->> 'register_key');
        t_ar := replace(replace(replace(replace(replace(r.title_ar, '{{record}}', c.lbl), '{{due}}', c.data ->> (r.params ->> 'date_field')), '{{days}}', c.left_days::text), '{{field}}', r.params ->> 'date_field'), '{{register}}', r.params ->> 'register_key');
        b_en := replace(replace(replace(replace(replace(r.body_en, '{{record}}', c.lbl), '{{due}}', c.data ->> (r.params ->> 'date_field')), '{{days}}', c.left_days::text), '{{field}}', r.params ->> 'date_field'), '{{register}}', r.params ->> 'register_key');
        b_ar := replace(replace(replace(replace(replace(r.body_ar, '{{record}}', c.lbl), '{{due}}', c.data ->> (r.params ->> 'date_field')), '{{days}}', c.left_days::text), '{{field}}', r.params ->> 'date_field'), '{{register}}', r.params ->> 'register_key');
        n := n + public.alert_rule_notify(r.id, 'due:' || (c.data ->> (r.params ->> 'date_field')), c.id::text, c.region_id,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/registers/' || (r.params ->> 'register_key')), mod);
      END LOOP;
    $ins$;
    IF regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rules_run: the loop end anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', ins || '\1');
  END IF;
END $$;

GRANT SELECT ON public.register_fields, public.register_records TO pmis_definer;
