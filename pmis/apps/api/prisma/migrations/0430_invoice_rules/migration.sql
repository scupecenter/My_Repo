-- 0430_invoice_rules: Settings > Register rules and the order's PR / PO on an invoice (decisions L1 and L2 of the 2026-11-27 relations review, on top of D58 / 0407).
-- Mirror: db/sql/429_invoice_rules.sql (kept identical).
--
--   0407 (D58) already checks the order link and the supplier company (`supplier_party_id`, the Contractors list) of an invoice in entry. This migration adds, on that
--   same trigger (invoice_links_rules(), patched in place and idempotent, never redefined):
--     * PR No. and PO / WO No. are READ from the order (derived fields order_pr_no, order_po_wo_no), never typed;
--     * two rules edited in Settings > Register rules: order_required (an invoice must name its Procurement order) and supplier_required (it must name its supplier company).
--   The register rules screen (register_rule_catalogue, reg_rules_json, admin_register_rules) is one list of editable keys per register; other registers add theirs there.
--   Additive: two derived fields, three readers/writers, no table, no permission widening, nothing deleted. Both rules default to off.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('invoices', 'order_pr_no',        'PR No. (from the order)',                    'رقم طلب الشراء (من الطلب)',        'text', false, false, true,  NULL, false, 'Invoice', 44),
  ('invoices', 'order_po_wo_no',     'PO / WO No. (from the order)',               'رقم أمر الشراء / العمل (من الطلب)', 'text', false, false, true,  NULL, true,  'Invoice', 46)
ON CONFLICT (register_key, code) DO NOTHING;

UPDATE register_definitions SET rules = '{"order_required": false, "supplier_required": false}'::jsonb || coalesce(rules, '{}'::jsonb) WHERE register_key = 'invoices';

-- The register rules screen (Settings > Register rules). One list of the keys that can be edited and what they mean; the values live in register_definitions.rules.
CREATE OR REPLACE FUNCTION register_rule_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('register_key', 'invoices', 'key', 'currency', 'type', 'text', 'default', 'LYD',
      'label_en', 'Invoice currency', 'label_ar', 'عملة الفواتير'),
    jsonb_build_object('register_key', 'invoices', 'key', 'order_required', 'type', 'boolean', 'default', false,
      'label_en', 'An invoice must name its Procurement order', 'label_ar', 'الفاتورة يجب أن تحدد أمر المشتريات'),
    jsonb_build_object('register_key', 'invoices', 'key', 'supplier_required', 'type', 'boolean', 'default', false,
      'label_en', 'An invoice must name its supplier company', 'label_ar', 'الفاتورة يجب أن تحدد شركة المورّد'))
$$;

CREATE OR REPLACE FUNCTION reg_rules_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  RETURN jsonb_build_object('catalogue', public.register_rule_catalogue(), 'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object('register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar, 'rules', d.rules, 'version', d.version) ORDER BY d.sort_order, d.register_key)
    FROM public.register_definitions d
    WHERE d.is_active AND d.kind = 'register' AND d.register_key IN (SELECT DISTINCT c ->> 'register_key' FROM jsonb_array_elements(public.register_rule_catalogue()) c)), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION admin_register_rules(p_register text, p_rules jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE old_d public.register_definitions%ROWTYPE; d public.register_definitions%ROWTYPE; k text; v jsonb; spec jsonb; merged jsonb;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'object' OR p_rules = '{}'::jsonb THEN
    PERFORM public.rcol_err('/rules', 'required', 'Send the rules to change.');
  END IF;
  SELECT * INTO old_d FROM public.register_definitions WHERE register_key = p_register AND is_active AND kind = 'register' FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> old_d.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The register changed since you read it. Reload and try again.'));
  END IF;
  merged := coalesce(old_d.rules, '{}'::jsonb);
  FOR k, v IN SELECT * FROM jsonb_each(p_rules) LOOP
    spec := NULL;
    SELECT c INTO spec FROM jsonb_array_elements(public.register_rule_catalogue()) c WHERE c ->> 'register_key' = p_register AND c ->> 'key' = k;
    IF spec IS NULL THEN PERFORM public.rcol_err('/rules/' || k, 'unknown_rule', 'This register has no such rule.'); END IF;
    IF (spec ->> 'type' = 'boolean' AND jsonb_typeof(v) <> 'boolean') OR (spec ->> 'type' = 'text' AND (jsonb_typeof(v) <> 'string' OR btrim(v #>> '{}') = '' OR length(v #>> '{}') > 20)) THEN
      PERFORM public.rcol_err('/rules/' || k, 'invalid', 'A value of the right type.');
    END IF;
    merged := merged || jsonb_build_object(k, v);
  END LOOP;
  UPDATE public.register_definitions SET rules = merged, version = version + 1 WHERE register_key = p_register RETURNING * INTO d;
  PERFORM public.log_audit_write('register_rules', 'register', p_register, jsonb_build_object('rules', old_d.rules), jsonb_build_object('rules', d.rules), p_reason);
  RETURN jsonb_build_object('register_key', d.register_key, 'rules', d.rules, 'version', d.version);
END $$;


-- Extend 0407's invoice trigger: derive PR / PO from the order, apply the two rules (the function text is patched in place; idempotent)
DO $$
DECLARE def text; marker text := E'\n  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err(''validation_failed'', jsonb_build_object(''errors'', errs)); END IF;';
        blk text;
BEGIN
  def := pg_get_functiondef('public.invoice_links_rules()'::regprocedure);
  IF position('order_pr_no' IN def) = 0 THEN
    IF position(marker IN def) = 0 THEN RAISE EXCEPTION 'invoice_links_rules() has no end to extend'; END IF;
    blk := $b$
  DECLARE inv_rules jsonb; inv_ord public.register_records%ROWTYPE;
  BEGIN
    SELECT x.rules INTO inv_rules FROM public.register_definitions x WHERE x.register_key = 'invoices';
    NEW.data := NEW.data - 'order_pr_no' - 'order_po_wo_no';                 -- derived: never typed, always read from the order
    IF coalesce(NEW.data ->> 'procurement_record_id', '') ~* uuid_re THEN
      SELECT * INTO inv_ord FROM public.fa_latest('procurement') x WHERE x.entity_id = (NEW.data ->> 'procurement_record_id')::uuid;
      IF FOUND THEN
        NEW.data := NEW.data || jsonb_strip_nulls(jsonb_build_object('order_pr_no', inv_ord.data ->> 'pr_no', 'order_po_wo_no', inv_ord.data ->> 'po_wo_no'));
      END IF;
    ELSIF coalesce((inv_rules ->> 'order_required')::boolean, false) THEN
      errs := errs || public.reg_err_item('/data/procurement_record_id', 'order_required', 'Settings require an invoice to name its Procurement order.');
    END IF;
    IF coalesce(NEW.data ->> 'supplier_party_id', '') = '' AND coalesce((inv_rules ->> 'supplier_required')::boolean, false) THEN
      errs := errs || public.reg_err_item('/data/supplier_party_id', 'supplier_required', 'Settings require an invoice to name its supplier company.');
    END IF;
  END;$b$;
    EXECUTE replace(def, marker, blk || marker);
  END IF;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['register_rule_catalogue()', 'reg_rules_json()', 'admin_register_rules(text,jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION register_rule_catalogue(), reg_rules_json(), admin_register_rules(text, jsonb, text, integer) TO pmis_app;
  END IF;
END $$;
