-- 0775 (spec: docs/plans/specs/k2b-company-status-orders.md): company status details, status history and the order value.
-- Additive only: new register fields (optional), a validation block patched in place, one read function. No permission, role, grant or default change.
--   * contractors: status_reason (text), status_date (date). Required (checked at submit) only when company_status is Suspended or Blacklisted.
--   * procurement: po_value (number) and po_currency (list), optional.
--   * company_status_json(party): the current status with reason and date, and the status history read from the approved versions (the approver is the
--     version's approved_by, so no typed approver field exists).

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('contractors', 'status_reason', 'Status reason', 'سبب الحالة', 'text', false, false, false, NULL, false, 'Contract', 62),
  ('contractors', 'status_date',   'Status date',   'تاريخ الحالة', 'date', false, false, false, NULL, false, 'Contract', 64),
  ('procurement', 'po_value',      'Order value',   'قيمة الأمر', 'number', false, false, false, NULL, false, 'Order', 66),
  ('procurement', 'po_currency',   'Order currency', 'عملة الأمر', 'list', false, false, false, '["LYD", "USD", "EUR"]'::jsonb, false, 'Order', 67)
ON CONFLICT (register_key, code) DO NOTHING;

-- A company record may carry the two new fields, and Suspended or Blacklisted needs a reason and a date. Patched in place, anchored on two lines of the
-- current definition; the migration stops loudly when an anchor is missing.
DO $$
DECLARE def text;
  m1 text := '''contract_end'', ''company_status'']';
  m2 text := '-- one contract per company (D26 simplification 1): the company name is unique';
  blk text := E'IF lower(coalesce(d ->> ''company_status'', '''')) IN (''suspended'', ''blacklisted'') THEN\n'
    || E'          IF nullif(btrim(coalesce(d ->> ''status_reason'', '''')), '''') IS NULL THEN errs := errs || public.reg_err_item(''/data/status_reason'', ''required'', ''A reason is required for this status.''); END IF;\n'
    || E'          IF nullif(btrim(coalesce(d ->> ''status_date'', '''')), '''') IS NULL THEN errs := errs || public.reg_err_item(''/data/status_date'', ''required'', ''A date is required for this status.''); END IF;\n'
    || E'        END IF;\n        ';
BEGIN
  def := pg_get_functiondef('public.reg_validate_catalog(uuid)'::regprocedure);
  IF position('status_reason' IN def) = 0 THEN
    IF position(m1 IN def) = 0 OR position(m2 IN def) = 0 THEN RAISE EXCEPTION 'reg_validate_catalog(uuid) lacks the anchors to patch'; END IF;
    def := replace(def, m1, '''contract_end'', ''company_status'', ''status_reason'', ''status_date'']');
    def := replace(def, m2, blk || m2);
    EXECUTE def;
  END IF;
END $$;

GRANT SELECT ON register_records, external_parties, users TO pmis_definer;

CREATE OR REPLACE FUNCTION company_status_json(p_party uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE nm text; ent uuid; cur jsonb; hist jsonb;
BEGIN
  SELECT p.name INTO nm FROM public.external_parties p WHERE p.id = p_party;
  IF nm IS NULL THEN RETURN NULL; END IF;
  SELECT r.entity_id INTO ent FROM public.register_records r
   WHERE r.register_key = 'contractors' AND r.record_type = 'company' AND r.is_current AND lower(r.data ->> 'contractor_name') = lower(nm) LIMIT 1;
  IF ent IS NULL THEN RETURN jsonb_build_object('status', NULL, 'reason', NULL, 'date', NULL, 'history', '[]'::jsonb); END IF;
  SELECT jsonb_build_object('status', r.data ->> 'company_status', 'reason', nullif(r.data ->> 'status_reason', ''), 'date', nullif(r.data ->> 'status_date', ''))
    INTO cur FROM public.register_records r WHERE r.entity_id = ent AND r.is_current;
  SELECT coalesce(jsonb_agg(h ORDER BY (h ->> 'version_no')::int DESC), '[]'::jsonb) INTO hist FROM (
    SELECT jsonb_build_object('version_no', v.version_no, 'status', v.st, 'reason', v.rs, 'date', v.dt,
             'approved_at', to_char(v.approved_at, 'YYYY-MM-DD'), 'approved_by', u.display_name) AS h
    FROM (SELECT r.version_no, r.data ->> 'company_status' AS st, nullif(r.data ->> 'status_reason', '') AS rs, nullif(r.data ->> 'status_date', '') AS dt,
                 r.approved_at, r.approved_by, lag(r.data ->> 'company_status') OVER (ORDER BY r.version_no) AS prev
          FROM public.register_records r WHERE r.entity_id = ent AND r.state = 'approved') v
    LEFT JOIN public.users u ON u.id = v.approved_by
    WHERE v.st IS DISTINCT FROM v.prev) x;
  RETURN cur || jsonb_build_object('history', hist);
END $$;

DO $$ BEGIN
  ALTER FUNCTION company_status_json(uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION company_status_json(uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION company_status_json(uuid) TO pmis_app;
  END IF;
END $$;
