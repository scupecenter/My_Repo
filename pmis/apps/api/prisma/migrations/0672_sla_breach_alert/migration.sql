-- 0672_sla_breach_alert: the SLA breach notice of the contractor performance view (Ahmed-approved item, contract 0.15.592). In-app notifications only, additive.
-- Mirror: db/sql/671_sla_breach_alert.sql (kept identical to prisma/migrations/0672_sla_breach_alert/migration.sql).
--
--   sla_breach    {party_type?, min_late_days 1..100000 default 1, min_snags 1..100000 default 1}  fires once per active external party (contractor,
--                 supplier, ...) that has at least `min_snags` snags past their target date (open and past it, or closed after it) and at least
--                 `min_late_days` days late in all (open: today minus target date; closed: closing day minus target date), the same snag rule as
--                 the contractor performance view (0180). party_type narrows to one party type. period: the working week (Sunday), target: the
--                 party id, so the reminder repeats once a week while the party stays in breach. Placeholders: {{party}}, {{type}}, {{snags}},
--                 {{days}}. Audience, templates, the journal (alert_rule_fires) are those of 0342. No amount is ever in the text.
--   The text goes in-app first. A rule is channel-ready: an admin who lists the kind alert_rule in mail.notification_kinds gets it mailed as well.
--
-- The kind list, alert_rule_params_errs() and alert_rules_run() are accumulating objects: each is patched in place and idempotently (anchors that do not
-- assume indentation), so kinds added by other migrations stay. No table, no reset-plan change, no role grant widened, nothing deleted.

-- 1. the closed kind list of the table
DO $$
DECLARE cname text; def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO cname, def FROM pg_constraint c
   WHERE c.conrelid = 'public.alert_rules'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%record_idle%' LIMIT 1;
  IF cname IS NULL THEN RAISE EXCEPTION 'alert_rules: the kind check was not found'; END IF;
  IF position('sla_breach' IN def) = 0 THEN
    IF position('''record_idle''' IN def) = 0 THEN RAISE EXCEPTION 'alert_rules: the kind list anchor was not found'; END IF;
    EXECUTE format('ALTER TABLE public.alert_rules DROP CONSTRAINT %I', cname);
    EXECUTE format('ALTER TABLE public.alert_rules ADD CONSTRAINT %I %s', cname, replace(def, '''record_idle''', '''record_idle'', ''sla_breach'''));
  END IF;
END $$;

-- 2. the params check
DO $$
DECLARE def text; ins text;
BEGIN
  def := pg_get_functiondef('public.alert_rule_params_errs(text,jsonb)'::regprocedure);
  IF position('sla_breach' IN def) = 0 THEN
    ins := $ins$ELSIF p_kind = 'sla_breach' THEN
    IF p_params - 'party_type' - 'min_late_days' - 'min_snags' <> '{}'::jsonb THEN
      errs := errs || jsonb_build_object('path', '/params', 'code', 'invalid', 'message', 'This kind takes only party_type, min_late_days and min_snags.');
    END IF;
    IF p_params ? 'party_type' AND (jsonb_typeof(p_params -> 'party_type') <> 'string' OR NOT EXISTS (SELECT 1 FROM public.external_parties x WHERE x.type::text = p_params ->> 'party_type')) THEN
      errs := errs || jsonb_build_object('path', '/params/party_type', 'code', 'invalid', 'message', 'party_type must be a type of an existing external party.');
    END IF;
    IF p_params ? 'min_late_days' AND (coalesce(p_params ->> 'min_late_days', '') !~ '^[0-9]+$' OR NOT ((p_params ->> 'min_late_days')::numeric BETWEEN 1 AND 100000)) THEN
      errs := errs || jsonb_build_object('path', '/params/min_late_days', 'code', 'invalid', 'message', 'min_late_days is 1 to 100000.');
    END IF;
    IF p_params ? 'min_snags' AND (coalesce(p_params ->> 'min_snags', '') !~ '^[0-9]+$' OR NOT ((p_params ->> 'min_snags')::numeric BETWEEN 1 AND 100000)) THEN
      errs := errs || jsonb_build_object('path', '/params/min_snags', 'code', 'invalid', 'message', 'min_snags is 1 to 100000.');
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
  IF position('sla_breach' IN def) = 0 THEN
    ins := $ins$ELSIF r.kind = 'sla_breach' THEN
      FOR c IN SELECT p.id::text AS pid, p.name AS pn, p.type::text AS pt, z.sn, z.dl
               FROM public.external_parties p
               JOIN LATERAL (
                 SELECT count(*)::int AS sn,
                        coalesce(sum(greatest(0, CASE WHEN s.status::text = 'closed' THEN s.closed_at::date - s.target_date ELSE CURRENT_DATE - s.target_date END)), 0)::int AS dl
                 FROM public.snags s
                 WHERE s.responsible_party_id = p.id AND s.target_date IS NOT NULL AND s.status::text <> 'cancelled'
                   AND ((s.status::text <> 'closed' AND s.target_date < CURRENT_DATE) OR (s.status::text = 'closed' AND s.closed_at::date > s.target_date))
               ) z ON true
               WHERE p.is_active AND z.sn >= coalesce(nullif(r.params ->> 'min_snags', '')::int, 1)
                 AND z.dl >= coalesce(nullif(r.params ->> 'min_late_days', '')::int, 1)
                 AND (r.params ->> 'party_type' IS NULL OR p.type::text = r.params ->> 'party_type')
               ORDER BY p.name, p.id LOOP
        t_en := replace(replace(replace(replace(replace(r.title_en, '{{party}}', c.pn), '{{type}}', c.pt), '{{snags}}', c.sn::text), '{{days}}', c.dl::text), '{{region}}', '');
        t_ar := replace(replace(replace(replace(replace(r.title_ar, '{{party}}', c.pn), '{{type}}', c.pt), '{{snags}}', c.sn::text), '{{days}}', c.dl::text), '{{region}}', '');
        b_en := replace(replace(replace(replace(replace(r.body_en, '{{party}}', c.pn), '{{type}}', c.pt), '{{snags}}', c.sn::text), '{{days}}', c.dl::text), '{{region}}', '');
        b_ar := replace(replace(replace(replace(replace(r.body_ar, '{{party}}', c.pn), '{{type}}', c.pt), '{{snags}}', c.sn::text), '{{days}}', c.dl::text), '{{region}}', '');
        n := n + public.alert_rule_notify(r.id, 'week:' || wk::text, c.pid, NULL,
                  jsonb_build_object('en', t_en, 'ar', t_ar), jsonb_build_object('en', b_en, 'ar', b_ar),
                  coalesce(r.link, '/reports/contractors'), NULL);
      END LOOP;
    $ins$;
    IF regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', 'X\1') = def THEN
      RAISE EXCEPTION 'alert_rules_run: the loop end anchor was not found';
    END IF;
    EXECUTE regexp_replace(def, '(END IF;\s*END LOOP;\s*RETURN n;)', ins || '\1');
  END IF;
END $$;

