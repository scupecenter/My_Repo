-- 0407_links_fixes: three gaps of the links and relations review (D58), all additive.
-- Mirror: db/sql/406_links_fixes.sql (kept identical to prisma/migrations/0407_links_fixes/migration.sql).
--
--   1. Expense and settlement rows of Financial Advances name their advance in `advance_id`. Until now it was checked only when the row was submitted
--      (fa_rules, "Choose a disbursed advance"); in entry any text was accepted. A row trigger now checks it while the row is in entry: it must be an approved
--      advance of the same site. The "disbursed" rule at submit stays as it is.
--   2. Invoices: `procurement_record_id` is checked in entry (an approved Procurement record, visible to the caller, of the same site) and a new optional
--      `supplier_party_id` points to a company of the Contractors list (external_parties). The free-text `supplier` stays, and is filled from the company
--      when it is empty (auto-fill).
--   3. Pickers: fa_advance_options(site) and invoice_supplier_options() (read only), behind three new GET routes.
--   4. record_related() also lists the HLC record <-> Procurement record link (the HLC register stores the id of the Procurement version row, so both
--      sides are matched by the entity or by one of its version rows). Patched in place and idempotent; links added by other migrations stay.
-- No table, no grant, no permission change, nothing deleted.
SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('invoices', 'supplier_party_id', 'Supplier company (Contractors list)', 'شركة المورّد (قائمة المقاولين)', 'text', false, false, false, NULL, false, 'Invoice', 35)
ON CONFLICT (register_key, code) DO NOTHING;

-- 1. advance_id of an expense / settlement
CREATE OR REPLACE FUNCTION fa_advance_link_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := NEW.data; a public.register_records%ROWTYPE;
BEGIN
  IF public.app_is_seeding() OR NEW.record_type NOT IN ('expense', 'settlement') THEN RETURN NEW; END IF;
  IF NOT (NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided')) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.data ->> 'advance_id' IS NOT DISTINCT FROM d ->> 'advance_id' THEN RETURN NEW; END IF;  -- unchanged: never re-checked
  IF coalesce(d ->> 'advance_id', '') = '' THEN NEW.data := NEW.data - 'advance_id'; RETURN NEW; END IF;
  IF d ->> 'advance_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(public.reg_err_item('/data/advance_id', 'unknown_advance', 'Choose an advance of this site.'))));
  END IF;
  SELECT * INTO a FROM public.fa_latest('financial_advances') x WHERE x.record_type = 'advance' AND x.entity_id = (d ->> 'advance_id')::uuid;
  IF NOT FOUND OR a.site_id IS DISTINCT FROM NEW.site_id OR NOT public.app_region_check(a.region_id) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(public.reg_err_item('/data/advance_id', 'unknown_advance', 'Choose an approved advance of this site.'))));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_fa_advance_link ON register_records;
CREATE TRIGGER b_fa_advance_link BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'financial_advances') EXECUTE FUNCTION fa_advance_link_rules();

-- 2. invoice links
CREATE OR REPLACE FUNCTION invoice_links_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d jsonb := NEW.data; errs jsonb := '[]'::jsonb; p public.register_records%ROWTYPE; regs int[]; pn text; uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF NOT (NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided')) THEN RETURN NEW; END IF;
  IF coalesce(d ->> 'procurement_record_id', '') = '' THEN NEW.data := NEW.data - 'procurement_record_id';
  ELSIF NOT (TG_OP = 'UPDATE' AND OLD.data ->> 'procurement_record_id' IS NOT DISTINCT FROM d ->> 'procurement_record_id') THEN
    IF d ->> 'procurement_record_id' !~* uuid_re THEN
      errs := errs || public.reg_err_item('/data/procurement_record_id', 'invalid', 'A Procurement record id.');
    ELSE
      regs := public.wf_actor_regions('procurement', 'view');
      SELECT * INTO p FROM public.fa_latest('procurement') x WHERE x.entity_id = (d ->> 'procurement_record_id')::uuid
         AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.region_id = ANY (regs));
      IF NOT FOUND THEN
        errs := errs || public.reg_err_item('/data/procurement_record_id', 'order_not_found', 'Not an approved Procurement record that you can see.');
      ELSIF NEW.site_id IS NOT NULL AND p.site_id IS DISTINCT FROM NEW.site_id THEN
        errs := errs || public.reg_err_item('/data/procurement_record_id', 'order_other_site', 'The Procurement record belongs to another site than this invoice.');
      END IF;
    END IF;
  END IF;
  IF coalesce(d ->> 'supplier_party_id', '') = '' THEN NEW.data := NEW.data - 'supplier_party_id';
  ELSIF NOT (TG_OP = 'UPDATE' AND OLD.data ->> 'supplier_party_id' IS NOT DISTINCT FROM d ->> 'supplier_party_id') THEN
    IF d ->> 'supplier_party_id' !~* uuid_re THEN
      errs := errs || public.reg_err_item('/data/supplier_party_id', 'invalid', 'A company id.');
    ELSE
      SELECT x.name INTO pn FROM public.external_parties x WHERE x.id = (d ->> 'supplier_party_id')::uuid AND x.is_active;
      IF NOT FOUND THEN errs := errs || public.reg_err_item('/data/supplier_party_id', 'unknown_company', 'Not an active company of the Contractors list.');
      ELSIF coalesce(d ->> 'supplier', '') = '' THEN NEW.data := NEW.data || jsonb_build_object('supplier', pn);
      END IF;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_invoice_links ON register_records;
CREATE TRIGGER b_invoice_links BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'invoices') EXECUTE FUNCTION invoice_links_rules();

-- 3. HLC <-> Procurement in the related-records reader (patched in place, idempotent)
DO $$
DECLARE def text; n text;
BEGIN
  def := pg_get_functiondef('public.record_related(text,uuid)'::regprocedure);
  IF position('''hlc''' IN def) = 0 THEN
    n := regexp_replace(def, '(\s*\)\s*v\(from_register, field, to_register\))', E',\n      (''hlc'',               ''procurement_record_id'', ''procurement'')\1');
    IF n = def THEN RAISE EXCEPTION 'record_related() has no link list to patch'; END IF;
    -- the HLC record keeps the id of a Procurement version row: match the entity or any of its version rows
    n := replace(n, 'x.entity_id = (src.data ->> l.field)::uuid', '(x.entity_id = (src.data ->> l.field)::uuid OR x.id = (src.data ->> l.field)::uuid)');
    n := replace(n, 'y.data ->> l.field = p_entity::text', '(y.data ->> l.field = p_entity::text OR y.data ->> l.field IN (SELECT z.id::text FROM public.register_records z WHERE z.entity_id = p_entity))');
    EXECUTE n;
  END IF;
END $$;

-- 4. The pickers of the three links (read only; row-level security and the module view decide what the caller sees)
CREATE OR REPLACE FUNCTION fa_advance_options(p_site uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.sort_date DESC NULLS LAST, x.sort_id), '[]'::jsonb) FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'site_id', r.site_id, 'advance_state', r.data ->> 'advance_state',
             'advance_kind', r.data ->> 'advance_kind', 'disbursed_date', r.data ->> 'disbursed_date',
             'po_wo_no', (SELECT p.data ->> 'po_wo_no' FROM public.register_records p WHERE p.register_key = 'procurement' AND p.entity_id::text = r.data ->> 'procurement_record_id' AND p.is_current LIMIT 1),
             'pr_no', (SELECT p.data ->> 'pr_no' FROM public.register_records p WHERE p.register_key = 'procurement' AND p.entity_id::text = r.data ->> 'procurement_record_id' AND p.is_current LIMIT 1))) AS j,
           r.data ->> 'disbursed_date' AS sort_date, r.id AS sort_id
    FROM public.register_records r
    WHERE r.register_key = 'financial_advances' AND r.record_type = 'advance' AND r.is_current AND r.state = 'approved'
      AND r.data ->> 'advance_state' IN ('disbursed', 'settlement_in_progress') AND (p_site IS NULL OR r.site_id = p_site)
      AND public.app_region_read(r.is_global, r.region_id)
    ORDER BY r.data ->> 'disbursed_date' DESC NULLS LAST, r.id LIMIT 500) x
$$;

CREATE OR REPLACE FUNCTION invoice_supplier_options() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'type', p.type::text) ORDER BY p.name), '[]'::jsonb)
  FROM public.external_parties p WHERE p.is_active
$$;

DO $$
BEGIN
  ALTER FUNCTION fa_advance_link_rules() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION fa_advance_link_rules() FROM PUBLIC;
  ALTER FUNCTION invoice_links_rules() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION invoice_links_rules() FROM PUBLIC;
  ALTER FUNCTION invoice_supplier_options() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION invoice_supplier_options() FROM PUBLIC;
  REVOKE ALL ON FUNCTION fa_advance_options(uuid) FROM PUBLIC;
  ALTER FUNCTION record_related(text, uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION record_related(text, uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION record_related(text, uuid), fa_advance_options(uuid), invoice_supplier_options() TO pmis_app;
  END IF;
END $$;
