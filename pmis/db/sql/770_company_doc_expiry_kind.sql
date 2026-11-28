-- 0771_company_doc_expiry_kind: the company document expiry kind for the generic alert rules (0342), notifications only (extras item 1; contract 0.15.489).
-- Mirror: db/sql/770_company_doc_expiry_kind.sql (kept identical to prisma/migrations/0771_company_doc_expiry_kind/migration.sql).
--
--   company_doc_expiry  {} no params  fires for every active document of an active company (company_documents, 0745) that has an expiry date and is expired
--                       or expires within the lead days of its document type (company_document_types.lead_days, set in Settings). period: the working week
--                       (Sunday), target: the document id, so the reminder comes once a week while the document stays expired or due.
--                       Audience: system admin or the module of the rule (use contractors). No region (company documents are central).
--                       Placeholders: {{company}}, {{type}}, {{date}} (the expiry date), {{days}} (days left, negative when expired).
-- The rule adds an audience and a wording of your own to the built-in daily notice of 0745; it never blocks an order or an assignment and changes no record.
-- The kind list, alert_rule_params_errs() and alert_rules_run() are accumulating objects, patched in place and idempotently (anchor checks raise when missing).
-- Nothing new is stored: no table, no reset-plan change, no grant to a user role.

-- 1. the closed kind list of the table
DO $$
DECLARE cname text; def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO cname, def FROM pg_constraint c
   WHERE c.conrelid = 'public.alert_rules'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%record_idle%' LIMIT 1;
  IF cname IS NULL THEN RAISE EXCEPTION 'alert_rules: the kind check was not found'; END IF;
  IF position('company_doc_expiry' IN def) = 0 THEN
    IF position('''record_idle''' IN def) = 0 THEN RAISE EXCEPTION 'alert_rules: the kind list anchor was not found'; END IF;
    EXECUTE format('ALTER TABLE public.alert_rules DROP CONSTRAINT %I', cname);
    EXECUTE format('ALTER TABLE public.alert_rules ADD CONSTRAINT %I %s', cname, replace(def, '''record_idle''', '''record_idle'', ''company_doc_expiry'''));
  END IF;
END $$;

-- 2. the params check
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('company_doc_expiry' IN def) = 0 THEN
    ins := $ins$ELSIF p_kind = 'company_doc_expiry' THEN
    IF p_params <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes no params.');
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
  IF position('company_doc_expiry' IN def) = 0 THEN
    ins := $ins$ELSIF r.kind = 'company_doc_expiry' THEN
      FOR c IN SELECT d.id, p.name AS company, ty.label_en AS dtype, d.expires_on AS exp, p.id AS pid, (d.expires_on - public.cal_today()) AS left_days
               FROM public.company_documents d
                 JOIN public.company_document_types ty ON ty.code = d.type_code AND ty.is_active
                 JOIN public.external_parties p ON p.id = d.party_id AND p.is_active
               WHERE d.is_active AND d.expires_on IS NOT NULL AND d.expires_on <= public.cal_today() + ty.lead_days
               ORDER BY d.expires_on, d.id LOOP
        t_en := replace(replace(replace(replace(r.title_en, '{{company}}', c.company), '{{type}}', c.dtype), '{{date}}', c.exp::text), '{{days}}', c.left_days::text);
        t_ar := replace(replace(replace(replace(r.title_ar, '{{company}}', c.company), '{{type}}', c.dtype), '{{date}}', c.exp::text), '{{days}}', c.left_days::text);
        b_en := replace(replace(replace(replace(r.body_en, '{{company}}', c.company), '{{type}}', c.dtype), '{{date}}', c.exp::text), '{{days}}', c.left_days::text);
        b_ar := replace(replace(replace(replace(r.body_ar, '{{company}}', c.company), '{{type}}', c.dtype), '{{date}}', c.exp::text), '{{days}}', c.left_days::text);
        n := n + public.alert_rule_notify(r.id, 'week:' || wk::text, c.id::text, NULL,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/companies/' || c.pid::text), 'contractors');
      END LOOP;
    $ins$;
    IF regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rules_run: the loop end anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', ins || '\1');
  END IF;
END $$;

GRANT SELECT ON public.company_documents, public.company_document_types, public.external_parties TO pmis_definer;
