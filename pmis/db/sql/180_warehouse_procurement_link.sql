-- 0181_warehouse_procurement_link: a warehouse receipt (PL / OPEN) can name the Procurement order it belongs to, and the order shows its receipts.
-- Mirror: db/sql/180_warehouse_procurement_link.sql (kept identical to prisma/migrations/0181_warehouse_procurement_link/migration.sql).
--
--   Owner principle (2026-11-26): registers feed each other, a value is typed once. The receipt names the order (optional, picked from a list); PR No., PO / WO No.
--   and the contractor are then READ from the order by the database and cannot be typed. A receipt without an order stays valid (stock that arrives with no order).
--   Additive: three derived fields, one optional field, one row trigger, two readers. No new table, no permission widening, nothing deleted.
--   Rules (blocking, on a version in entry): the order must be an approved, current, not cancelled Procurement record the caller may see; if the receipt has a site,
--   the order is on the same site; only a receipt (PL / OPEN) takes an order. A version in review or approved is history and is never rewritten.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('warehouse', 'procurement_order_id', 'Procurement Order',  'أمر المشتريات',     'text', false, false, false, NULL, false, 'Procurement', 70),
  ('warehouse', 'pr_no',                'PR No.',             'رقم طلب الشراء',    'text', false, false, true,  NULL, true,  'Procurement', 72),
  ('warehouse', 'po_wo_no',             'PO / WO No.',        'رقم أمر الشراء / العمل', 'text', false, false, true, NULL, true, 'Procurement', 74),
  ('warehouse', 'order_contractor',     'Contractor (from the order)', 'المقاول (من الأمر)', 'text', false, false, true, NULL, false, 'Procurement', 76)
ON CONFLICT (register_key, code) DO NOTHING;

CREATE OR REPLACE FUNCTION wh_order_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d jsonb := NEW.data; errs jsonb := '[]'::jsonb; ord uuid; o public.register_records%ROWTYPE; pname text;
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  d := d - 'pr_no' - 'po_wo_no' - 'order_contractor';                       -- derived: never typed, always rebuilt from the order
  IF coalesce(d ->> 'procurement_order_id', '') = '' THEN
    NEW.data := d - 'procurement_order_id';
    RETURN NEW;
  END IF;
  IF NEW.record_type IS NULL OR NEW.record_type NOT IN ('pl', 'open') THEN
    errs := errs || public.reg_err_item('/data/procurement_order_id', 'receipt_only', 'Only a receipt (PL or OPEN) names a Procurement order.');
  ELSIF d ->> 'procurement_order_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    errs := errs || public.reg_err_item('/data/procurement_order_id', 'invalid', 'A Procurement record id.');
  ELSE
    ord := (d ->> 'procurement_order_id')::uuid;
    SELECT * INTO o FROM public.register_records x
      WHERE x.register_key = 'procurement' AND x.entity_id = ord AND x.is_current AND x.state = 'approved'
        AND NOT public.proc_order_cancelled(x.data ->> 'order_status') AND public.app_region_read(x.is_global, x.region_id);
    IF NOT FOUND THEN
      errs := errs || public.reg_err_item('/data/procurement_order_id', 'order_not_active', 'Not an approved, active Procurement order that you can see.');
    ELSIF NEW.site_id IS NOT NULL AND o.site_id IS DISTINCT FROM NEW.site_id THEN
      errs := errs || public.reg_err_item('/data/procurement_order_id', 'order_other_site', 'The order belongs to another site than this receipt.');
    ELSE
      SELECT ep.name INTO pname FROM public.external_parties ep WHERE ep.id = o.external_party_id;
      d := d || jsonb_strip_nulls(jsonb_build_object('pr_no', o.data ->> 'pr_no', 'po_wo_no', o.data ->> 'po_wo_no', 'order_contractor', pname));
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  NEW.data := d;
  RETURN NEW;
END $$;
CREATE TRIGGER b_wh_order_rules BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'warehouse') EXECUTE FUNCTION wh_order_rules();

-- The picker of the receipt form: approved, active orders the caller can see (row-level security applies), of the receipt's site when one is given.
CREATE OR REPLACE FUNCTION wh_order_options(p_site uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.sort_date DESC NULLS LAST, x.sort_id), '[]'::jsonb) FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'site_id', r.site_id, 'scope', r.data ->> 'scope', 'pr_no', r.data ->> 'pr_no',
             'po_wo_no', r.data ->> 'po_wo_no', 'po_wo_date', r.data ->> 'po_wo_date', 'order_status', r.data ->> 'order_status',
             'external_party', CASE WHEN ep.id IS NOT NULL THEN jsonb_build_object('id', ep.id, 'name', ep.name, 'type', ep.type::text) END)) AS j,
           r.data ->> 'po_wo_date' AS sort_date, r.id AS sort_id
    FROM public.register_records r LEFT JOIN public.external_parties ep ON ep.id = r.external_party_id
    WHERE r.register_key = 'procurement' AND r.is_current AND r.state = 'approved' AND NOT public.proc_order_cancelled(r.data ->> 'order_status')
      AND (p_site IS NULL OR r.site_id = p_site)
    ORDER BY r.data ->> 'po_wo_date' DESC NULLS LAST, r.id LIMIT 500) x
$$;

-- The receipts against one order (current versions, not voided), with what arrived. Row-level security applies to the caller.
CREATE OR REPLACE FUNCTION proc_order_receipts(p_order uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'record_type', r.record_type, 'state', r.state,
           'doc_no', r.data ->> 'doc_no', 'doc_date', r.data ->> 'doc_date', 'txn_status', r.data ->> 'txn_status', 'movement_status', m.status,
           'lines', coalesce(l.n, 0), 'qty', coalesce(l.q, 0))) ORDER BY r.data ->> 'doc_date' DESC NULLS LAST, r.id), '[]'::jsonb)
  FROM public.register_records r
  LEFT JOIN public.wh_movements m ON m.entity_id = r.entity_id
  LEFT JOIN LATERAL (SELECT count(*)::int AS n, sum(wl.qty) AS q FROM public.wh_movement_lines wl WHERE wl.movement_id = m.id) l ON true
  WHERE r.register_key = 'warehouse' AND r.is_current AND r.state <> 'voided' AND r.record_type IN ('pl', 'open') AND r.data ->> 'procurement_order_id' = p_order::text
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['wh_order_rules()', 'wh_order_options(uuid)', 'proc_order_receipts(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION wh_order_options(uuid), proc_order_receipts(uuid) TO pmis_app;
  END IF;
END $$;
