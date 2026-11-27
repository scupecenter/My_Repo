-- 0214_issue_risk_link: an Issue can name the Risk it realises; the Risk shows the issues that came from it.
-- Mirror: db/sql/213_issue_risk_link.sql (kept identical to prisma/migrations/0214_issue_risk_link/migration.sql).
--
--   Owner principle (2026-11-26): registers feed each other, a value is typed once. A risk that happens becomes an issue; the issue names the risk (optional, picked from a list)
--   and the risk lists its realised issues with their status. Additive: one optional field, one row trigger, two readers. No new table, no permission widening, nothing deleted.
--   Rules (blocking, on a version in entry): the risk is a current, not voided Risks record that the caller may see and the caller holds the Risks view right in the risk's region
--   (the responsibility matrix decides, so an Issues user without it cannot read or pick a risk). A risk is not tied to one site, so the sites need not match.
--   The reader of the risk page checks both rights (Risks and Issues) for the caller: a risk shows only the issues of the regions where the caller holds the Issues view right.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order)
SELECT 'issues', 'risk_entity_id', 'Realised Risk', 'الخطر المتحقق', 'text', false, false, false, NULL, false, f.section, f.sort_order + 1
FROM register_fields f WHERE f.register_key = 'issues' AND f.code = 'blocked_gate_or_task'
ON CONFLICT (register_key, code) DO NOTHING;

CREATE OR REPLACE FUNCTION issue_risk_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  regs int[]; d jsonb := NEW.data; errs jsonb := '[]'::jsonb; rk uuid;
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  IF coalesce(d ->> 'risk_entity_id', '') = '' THEN
    NEW.data := d - 'risk_entity_id';
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.data ->> 'risk_entity_id' IS NOT DISTINCT FROM d ->> 'risk_entity_id' THEN RETURN NEW; END IF;   -- unchanged: never re-checked
  IF d ->> 'risk_entity_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    errs := errs || public.reg_err_item('/data/risk_entity_id', 'invalid', 'A Risks record id.');
  ELSE
    rk := (d ->> 'risk_entity_id')::uuid;
    regs := public.wf_actor_regions('risks', 'view');
    IF NOT EXISTS (SELECT 1 FROM public.register_records x
      WHERE x.register_key = 'risks' AND x.entity_id = rk AND x.is_current AND x.state <> 'voided'
        AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.is_global OR x.region_id = ANY (regs))) THEN
      errs := errs || public.reg_err_item('/data/risk_entity_id', 'risk_not_available', 'Not a risk that you can see (it needs the Risks view right).');
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_issue_risk_rules BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'issues') EXECUTE FUNCTION issue_risk_rules();

-- The picker of the issue form: the risks the caller may see, newest first (a risk is not tied to one site).
CREATE OR REPLACE FUNCTION issue_risk_options() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.sort_date DESC NULLS LAST, x.sort_id), '[]'::jsonb) FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'risk_id', r.data ->> 'risk_id', 'statement', r.data ->> 'risk_statement',
             'status', r.data ->> 'status', 'category', r.data ->> 'category', 'state', r.state)) AS j,
           r.created_at::text AS sort_date, r.id AS sort_id
    FROM public.register_records r
    CROSS JOIN (SELECT public.wf_actor_regions('risks', 'view') AS regs) a
    WHERE r.register_key = 'risks' AND r.is_current AND r.state <> 'voided' AND (a.regs IS NULL OR r.is_global OR r.region_id = ANY (a.regs))
    ORDER BY r.created_at DESC, r.id LIMIT 500) x
$$;

-- The issues that realise one risk (current versions, not voided), with their status. Row-level security applies to the caller; only the regions of the Issues view right.
CREATE OR REPLACE FUNCTION risk_realised_issues(p_risk uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'site_id', r.site_id, 'state', r.state,
           'pending_issue', r.data ->> 'pending_issue', 'issue_status', r.data ->> 'issue_status', 'raised_date', r.data ->> 'raised_date',
           'resolution_date', r.data ->> 'resolution_date')) ORDER BY r.data ->> 'raised_date' DESC NULLS LAST, r.id), '[]'::jsonb)
  FROM public.register_records r
  CROSS JOIN (SELECT public.wf_actor_regions('issues', 'view') AS regs) a
  WHERE r.register_key = 'issues' AND r.is_current AND r.state <> 'voided' AND r.data ->> 'risk_entity_id' = p_risk::text
    AND (a.regs IS NULL OR r.region_id = ANY (a.regs))
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['issue_risk_rules()', 'issue_risk_options()', 'risk_realised_issues(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION issue_risk_options(), risk_realised_issues(uuid) TO pmis_app;
  END IF;
END $$;
