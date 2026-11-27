-- 0320_warehouse_doc_order_link: every warehouse document except a stock adjustment (receipt PL / OPEN, delivery note DN, return note RN) can name its Procurement order.
-- Mirror: db/sql/319_warehouse_doc_order_link.sql (kept identical to prisma/migrations/0320_warehouse_doc_order_link/migration.sql).
--
--   0181 let a receipt (PL / OPEN) name its order; PR No., PO / WO No. and the contractor are read from the order. A delivery note (cw_dn / te_dn: materials issued to a site) and a return
--   note (cw_rn / te_rn) belong to an order too, so they get the same optional picker and the same derived fields, with the same rules (an approved, active order the caller may see
--   through the Procurement view right of the matrix; the order is on the document's site; derived fields cannot be typed; a version in review or approved is never rewritten).
--   Only a stock adjustment (adj) refuses an order. The Procurement order screen lists the documents of every type against the order.
--   Additive: two functions replaced (same names, same grants and owner), no new field, table or permission, nothing deleted. Documents without an order stay valid.

CREATE OR REPLACE FUNCTION wh_order_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  regs int[]; d jsonb := NEW.data; errs jsonb := '[]'::jsonb; ord uuid; o public.register_records%ROWTYPE; pname text;
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  d := d - 'pr_no' - 'po_wo_no' - 'order_contractor';                       -- derived: never typed, always rebuilt from the order
  IF coalesce(d ->> 'procurement_order_id', '') = '' THEN
    NEW.data := d - 'procurement_order_id';
    RETURN NEW;
  END IF;
  IF NEW.record_type IS NULL OR NEW.record_type = 'adj' THEN
    errs := errs || public.reg_err_item('/data/procurement_order_id', 'receipt_only', 'A stock adjustment does not name a Procurement order (a receipt, a delivery note and a return note do).');
  ELSIF d ->> 'procurement_order_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    errs := errs || public.reg_err_item('/data/procurement_order_id', 'invalid', 'A Procurement record id.');
  ELSE
    ord := (d ->> 'procurement_order_id')::uuid;
    regs := public.wf_actor_regions('procurement', 'view');                 -- the matrix decides who may read Procurement: NULL = every region
    SELECT * INTO o FROM public.register_records x
      WHERE x.register_key = 'procurement' AND x.entity_id = ord AND x.is_current AND x.state = 'approved'
        AND NOT public.proc_order_cancelled(x.data ->> 'order_status') AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.region_id = ANY (regs));
    IF NOT FOUND THEN
      errs := errs || public.reg_err_item('/data/procurement_order_id', 'order_not_active', 'Not an approved, active Procurement order that you can see (it needs the Procurement view right).');
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
CREATE OR REPLACE FUNCTION proc_order_receipts(p_order uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'record_type', r.record_type, 'state', r.state,
           'doc_no', r.data ->> 'doc_no', 'doc_date', r.data ->> 'doc_date', 'txn_status', r.data ->> 'txn_status', 'movement_status', m.status,
           'lines', coalesce(l.n, 0), 'qty', coalesce(l.q, 0))) ORDER BY r.data ->> 'doc_date' DESC NULLS LAST, r.id), '[]'::jsonb)
  FROM public.register_records r
  LEFT JOIN public.wh_movements m ON m.entity_id = r.entity_id
  LEFT JOIN LATERAL (SELECT count(*)::int AS n, sum(wl.qty) AS q FROM public.wh_movement_lines wl WHERE wl.movement_id = m.id) l ON true
  WHERE r.register_key = 'warehouse' AND r.is_current AND r.state <> 'voided' AND r.record_type <> 'adj' AND r.data ->> 'procurement_order_id' = p_order::text
$$;


ALTER FUNCTION wh_order_rules() OWNER TO pmis_definer;
ALTER FUNCTION proc_order_receipts(uuid) OWNER TO pmis_definer;
