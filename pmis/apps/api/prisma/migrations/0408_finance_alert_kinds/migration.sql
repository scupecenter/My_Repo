-- 0408_finance_alert_kinds: two financial kinds for the generic alert rules (0342), notifications only (D59; contract 0.15.365).
-- Mirror: db/sql/407_finance_alert_kinds.sql (kept identical to prisma/migrations/0408_finance_alert_kinds/migration.sql).
--
--   advance_unsettled  {days 1..365, optional}  fires for every current approved advance of the Financial Advances register that is still disbursed or in
--                      settlement and was disbursed at least `days` days ago. When `days` is not given the Finance hub value `settle_warn_days` is used
--                      (setting ui.features, section finance_hub, 0406) and 30 when that value is not set. period: the working week (Sunday), target: the
--                      record id, so the reminder comes once a week while the advance stays open. Placeholders: {{record}} (the Procurement PO / WO No.
--                      of the assignment, else the short id), {{days}} (days since disbursement), {{state}} (advance state).
--   invoice_due_soon   {days 0..365, optional, default 7}  fires for every current approved invoice that is not Paid or Cancelled and whose due date is
--                      within `days` days from today or already past. period: the due date, target: the record id (once per invoice and due date).
--                      Placeholders: {{record}} (invoice no.), {{days}} (days until the due date, negative when overdue), {{due}} (the due date).
--
-- The kind list of the table, alert_rule_params_errs() and alert_rules_run() are accumulating objects: each is patched in place and idempotently (the stored
-- text is extended at anchors that do not assume indentation), so kinds added by other migrations stay. Audience, templates, the one-per-period-and-target
-- journal (alert_rule_fires) and the mail rule are the ones of 0342; nothing new is stored, so no table, no reset-plan change, no grant to a user role.

-- 1. the closed kind list of the table
DO $$
DECLARE cname text; def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO cname, def FROM pg_constraint c
   WHERE c.conrelid = 'public.alert_rules'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%record_idle%' LIMIT 1;
  IF cname IS NULL THEN RAISE EXCEPTION 'alert_rules: the kind check was not found'; END IF;
  IF position('advance_unsettled' IN def) = 0 THEN
    IF position('''record_idle''' IN def) = 0 THEN RAISE EXCEPTION 'alert_rules: the kind list anchor was not found'; END IF;
    EXECUTE format('ALTER TABLE public.alert_rules DROP CONSTRAINT %I', cname);
    EXECUTE format('ALTER TABLE public.alert_rules ADD CONSTRAINT %I %s', cname, replace(def, '''record_idle''', '''record_idle'', ''advance_unsettled'', ''invoice_due_soon'''));
  END IF;
END $$;

-- 2. the params check
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('advance_unsettled' IN def) = 0 THEN
    ins := $ins$ELSIF p_kind = 'advance_unsettled' THEN
    IF p_params - 'days' <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes only days.');
    END IF;
    IF p_params ? 'days' AND (coalesce(p_params ->> 'days', '') !~ '^[0-9]+$' OR NOT ((p_params ->> 'days')::int BETWEEN 1 AND 365)) THEN
      errs := errs || jsonb_build_object('path', '/params/days', 'code', 'invalid', 'message', 'days is 1 to 365.');
    END IF;
  ELSIF p_kind = 'invoice_due_soon' THEN
    IF p_params - 'days' <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes only days.');
    END IF;
    IF p_params ? 'days' AND (coalesce(p_params ->> 'days', '') !~ '^[0-9]+$' OR NOT ((p_params ->> 'days')::int BETWEEN 0 AND 365)) THEN
      errs := errs || jsonb_build_object('path', '/params/days', 'code', 'invalid', 'message', 'days is 0 to 365.');
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
  IF position('advance_unsettled' IN def) = 0 THEN
    ins := $ins$ELSIF r.kind = 'advance_unsettled' THEN
      SELECT d2.module_key INTO mod FROM public.register_definitions d2 WHERE d2.register_key = 'financial_advances';
      FOR c IN SELECT rec.id, rec.region_id, rec.entity_id, rec.data,
                      (d - (rec.data ->> 'disbursed_date')::date) AS age,
                      coalesce((SELECT p.data ->> 'po_wo_no' FROM public.register_records p WHERE p.register_key = 'procurement' AND p.is_current
                                  AND p.entity_id::text = rec.data ->> 'procurement_record_id' LIMIT 1), left(rec.entity_id::text, 8)) AS lbl
               FROM public.register_records rec
               WHERE rec.is_current AND rec.register_key = 'financial_advances' AND rec.record_type = 'advance' AND rec.state = 'approved'
                 AND rec.data ->> 'advance_state' IN ('disbursed', 'settlement_in_progress')
                 AND coalesce(rec.data ->> 'disbursed_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                 AND (rec.data ->> 'disbursed_date')::date <= d - coalesce(nullif(r.params ->> 'days', '')::int,
                       (SELECT nullif(s.value -> 'sections' -> 'finance_hub' ->> 'settle_warn_days', '')::int FROM public.settings s WHERE s.key = 'ui.features'), 30)
               ORDER BY rec.id LOOP
        t_en := replace(replace(replace(replace(r.title_en, '{{record}}', c.lbl), '{{state}}', c.data ->> 'advance_state'), '{{days}}', c.age::text), '{{region}}', '');
        t_ar := replace(replace(replace(replace(r.title_ar, '{{record}}', c.lbl), '{{state}}', c.data ->> 'advance_state'), '{{days}}', c.age::text), '{{region}}', '');
        b_en := replace(replace(replace(replace(r.body_en, '{{record}}', c.lbl), '{{state}}', c.data ->> 'advance_state'), '{{days}}', c.age::text), '{{region}}', '');
        b_ar := replace(replace(replace(replace(r.body_ar, '{{record}}', c.lbl), '{{state}}', c.data ->> 'advance_state'), '{{days}}', c.age::text), '{{region}}', '');
        n := n + public.alert_rule_notify(r.id, 'week:' || wk::text, c.id::text, c.region_id,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/registers/financial_advances'), mod);
      END LOOP;
    ELSIF r.kind = 'invoice_due_soon' THEN
      SELECT d2.module_key INTO mod FROM public.register_definitions d2 WHERE d2.register_key = 'invoices';
      FOR c IN SELECT rec.id, rec.region_id, rec.entity_id, rec.data,
                      ((rec.data ->> 'due_date')::date - d) AS left_days,
                      coalesce(nullif(rec.data ->> 'invoice_no', ''), left(rec.entity_id::text, 8)) AS lbl
               FROM public.register_records rec
               WHERE rec.is_current AND rec.register_key = 'invoices' AND rec.state = 'approved'
                 AND coalesce(rec.data ->> 'invoice_state', '') NOT IN ('Paid', 'Cancelled')
                 AND coalesce(rec.data ->> 'due_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                 AND (rec.data ->> 'due_date')::date <= d + coalesce(nullif(r.params ->> 'days', '')::int, 7)
               ORDER BY rec.id LOOP
        t_en := replace(replace(replace(replace(r.title_en, '{{record}}', c.lbl), '{{due}}', c.data ->> 'due_date'), '{{days}}', c.left_days::text), '{{region}}', '');
        t_ar := replace(replace(replace(replace(r.title_ar, '{{record}}', c.lbl), '{{due}}', c.data ->> 'due_date'), '{{days}}', c.left_days::text), '{{region}}', '');
        b_en := replace(replace(replace(replace(r.body_en, '{{record}}', c.lbl), '{{due}}', c.data ->> 'due_date'), '{{days}}', c.left_days::text), '{{region}}', '');
        b_ar := replace(replace(replace(replace(r.body_ar, '{{record}}', c.lbl), '{{due}}', c.data ->> 'due_date'), '{{days}}', c.left_days::text), '{{region}}', '');
        n := n + public.alert_rule_notify(r.id, 'due:' || (c.data ->> 'due_date'), c.id::text, c.region_id,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/registers/invoices'), mod);
      END LOOP;
    $ins$;
    IF regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rules_run: the loop end anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', ins || '\1');
  END IF;
END $$;

GRANT SELECT ON public.settings TO pmis_definer;
