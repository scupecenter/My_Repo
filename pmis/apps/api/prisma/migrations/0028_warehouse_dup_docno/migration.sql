-- 0028_warehouse_dup_docno. Mirror: db/sql/027_warehouse_dup_docno.sql (kept identical).
-- wh_create_movement checks a duplicate Doc No. only after reg_save_record's
-- grant and region checks, and no longer returns the existing record id
-- (it may be outside the caller's regions). Replaces the 0026 text; owner,
-- SECURITY DEFINER and grants are kept by CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION wh_create_movement(p_record_type text, p_site uuid, p_data jsonb, p_lines jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  rid uuid; rec public.register_records%ROWTYPE; mid uuid; kind_ text; ln jsonb; i int := 0; it public.warehouse_items%ROWTYPE; q numeric; qa numeric; errs jsonb := '[]'::jsonb;
  sers text[]; sn text; st record; net numeric; ser_row public.warehouse_serials%ROWTYPE; dup uuid; docno text; seen uuid[] := ARRAY[]::uuid[]; iid uuid;
BEGIN
  kind_ := CASE WHEN p_record_type IN ('te_dn', 'cw_dn') THEN 'issue' WHEN p_record_type IN ('te_rn', 'cw_rn') THEN 'return' WHEN p_record_type IN ('pl', 'open') THEN 'receipt' WHEN p_record_type = 'adj' THEN 'adjustment' END;
  IF kind_ IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/record_type', 'not_in_list', 'Not a warehouse document type.')));
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/lines', 'required', 'At least one line is required.')));
  END IF;
  -- the register checks who may create (grant, entry holder, region of the site) and the header fields
  rid := public.reg_save_record('warehouse', NULL, NULL, p_site, p_record_type, coalesce(p_data, '{}'::jsonb), NULL, NULL, false);
  -- duplicate Doc No. only after authorization; the existing id is not returned (it may be outside the caller's regions)
  docno := btrim(coalesce(p_data ->> 'doc_no', ''));
  IF docno <> '' THEN
    SELECT x.id INTO dup FROM public.register_records x WHERE x.register_key = 'warehouse' AND x.id <> rid AND x.state <> 'voided' AND lower(x.data ->> 'doc_no') = lower(docno) LIMIT 1;
    IF dup IS NOT NULL THEN PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'Duplicate Doc No.: ' || docno)); END IF;
  END IF;
  SELECT * INTO rec FROM public.register_records WHERE id = rid;
  INSERT INTO public.wh_movements (entity_id, record_id, record_type, kind, site_id, region_id, is_global, created_by)
  VALUES (rec.entity_id, rid, p_record_type, kind_, rec.site_id, rec.region_id, rec.is_global, public.app_actor()) RETURNING id INTO mid;

  -- lock the items in a fixed order: two documents cannot both take the last quantity
  PERFORM 1 FROM public.warehouse_items w WHERE w.id IN (SELECT (e ->> 'item_id')::uuid FROM jsonb_array_elements(p_lines) e WHERE e ->> 'item_id' ~* '^[0-9a-f-]{36}$') ORDER BY w.id FOR UPDATE;

  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    i := i + 1;
    IF coalesce(ln ->> 'item_id', '') !~* '^[0-9a-f-]{36}$' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'required', 'The item is required.'); CONTINUE; END IF;
    iid := (ln ->> 'item_id')::uuid;
    SELECT * INTO it FROM public.warehouse_items w WHERE w.id = iid AND w.is_active;
    IF NOT FOUND THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'unknown_item', 'Unknown or inactive item.'); CONTINUE; END IF;
    IF iid = ANY (seen) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/item_id', 'duplicate', 'The item appears twice: use one line per item.'); CONTINUE; END IF;
    seen := seen || iid;
    IF coalesce(ln ->> 'qty', '') !~ '^-?[0-9]+(\.[0-9]{1,3})?$' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'invalid', 'A number.'); CONTINUE; END IF;
    q := (ln ->> 'qty')::numeric;
    IF (kind_ <> 'adjustment' AND q <= 0) OR q = 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'not_positive', CASE WHEN kind_ = 'adjustment' THEN 'The quantity cannot be zero.' ELSE 'The quantity must be above zero (only an adjustment may be negative).' END); CONTINUE; END IF;
    IF lower(coalesce(it.unit, '')) IN ('pcs', 'set') AND q <> trunc(q) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'whole_units', 'No fraction in whole units (pieces and sets).'); CONTINUE; END IF;
    qa := NULL;
    IF ln ? 'qty_approved' AND jsonb_typeof(ln -> 'qty_approved') <> 'null' THEN
      IF kind_ <> 'issue' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty_approved', 'not_applicable', 'Qty Approved belongs to a delivery note.'); CONTINUE; END IF;
      IF coalesce(ln ->> 'qty_approved', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (ln ->> 'qty_approved')::numeric < q THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty_approved', 'below_dispatched', 'Qty Approved is a number not below the dispatched quantity.'); CONTINUE; END IF;
      qa := (ln ->> 'qty_approved')::numeric;
    END IF;
    IF ln ? 'condition' AND jsonb_typeof(ln -> 'condition') <> 'null' AND (kind_ <> 'return' OR ln ->> 'condition' NOT IN ('Good', 'Faulty', 'Damaged')) THEN
      errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/condition', 'invalid', 'Condition (Good, Faulty, Damaged) belongs to a return note.'); CONTINUE;
    END IF;

    -- serials: PL, DN and RN rows of a serial-tracked item carry exactly one serial per unit (WH Serials, DQ19)
    sers := CASE WHEN ln ? 'serials' AND jsonb_typeof(ln -> 'serials') = 'array' THEN ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(ln -> 'serials') x) ELSE ARRAY[]::text[] END;
    IF cardinality(sers) <> (SELECT count(DISTINCT s) FROM unnest(sers) s) OR '' = ANY (sers) THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'duplicate_serial', 'A serial appears twice or is empty.'); CONTINUE; END IF;
    IF NOT it.serialised AND cardinality(sers) > 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'not_serial_tracked', 'This item is not serial-tracked.'); CONTINUE; END IF;
    IF it.serialised AND kind_ = 'adjustment' AND cardinality(sers) > 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'not_applicable', 'An adjustment carries no serials.'); CONTINUE; END IF;
    IF it.serialised AND p_record_type <> 'open' AND kind_ <> 'adjustment' AND cardinality(sers) <> q THEN
      errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_count', 'The serial count must equal the quantity (' || q || ').'); CONTINUE;
    END IF;
    IF it.serialised AND kind_ = 'adjustment' AND q < 0 THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/qty', 'serial_adjustment', 'A serial-tracked item cannot be adjusted down: return or correct the serials.'); CONTINUE; END IF;
    FOREACH sn IN ARRAY sers LOOP
      SELECT * INTO ser_row FROM public.warehouse_serials w WHERE w.serial_no = sn;
      IF kind_ = 'receipt' THEN
        IF FOUND OR EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'receipt' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'duplicate_serial', 'Duplicate serial: ' || sn);
        END IF;
      ELSIF kind_ = 'issue' THEN
        IF NOT FOUND OR ser_row.item_id <> iid THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'unknown_serial', 'Unknown serial for this item: ' || sn);
        ELSIF ser_row.status IS DISTINCT FROM 'In Stock' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_not_in_stock', 'Serial not in stock: ' || sn);
        ELSIF EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'issue' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_reserved', 'Serial reserved by another pending delivery note: ' || sn);
        END IF;
      ELSIF kind_ = 'return' THEN
        IF NOT FOUND OR ser_row.item_id <> iid THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'unknown_serial', 'Unknown serial for this item: ' || sn);
        ELSIF ser_row.site_id IS DISTINCT FROM rec.site_id OR ser_row.status IS DISTINCT FROM 'Dispatched' THEN errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'rn_without_dn', 'Return without a delivery note to this site: ' || sn);
        ELSIF EXISTS (SELECT 1 FROM public.wh_movement_lines o JOIN public.wh_movements om ON om.id = o.movement_id WHERE om.status = 'pending' AND om.kind = 'return' AND sn = ANY (o.serials) AND om.id <> mid) THEN
          errs := errs || public.reg_err_item('/lines/' || (i - 1) || '/serials', 'serial_reserved', 'Serial in another pending return note: ' || sn);
        END IF;
      END IF;
    END LOOP;

    -- stock rules: an issue (or a negative adjustment) cannot take more than is available; a return cannot exceed what the site holds
    IF kind_ = 'issue' OR (kind_ = 'adjustment' AND q < 0) THEN
      SELECT * INTO st FROM public.wh_stock_levels(iid, NULL);
      IF st.available < abs(q) THEN
        PERFORM public.wf_err('insufficient_stock', jsonb_build_object('detail', 'Not enough stock of ' || it.name || ': ' || st.available || ' available (' || st.on_hand || ' on hand, ' || st.reserved || ' reserved).',
          'errors', public.reg_err_item('/lines/' || (i - 1) || '/qty', 'insufficient_stock', 'Available: ' || st.available)));
      END IF;
    ELSIF kind_ = 'return' THEN
      SELECT * INTO st FROM public.wh_stock_levels(iid, rec.site_id);
      net := coalesce(st.on_hand, 0) - coalesce(st.pending_return, 0);
      IF q > net THEN
        PERFORM public.wf_err('insufficient_stock', jsonb_build_object('detail', 'The site holds ' || net || ' of ' || it.name || ' (delivered minus returned): it cannot return ' || q || '.',
          'errors', public.reg_err_item('/lines/' || (i - 1) || '/qty', 'insufficient_on_site', 'The site holds ' || net)));
      END IF;
    END IF;
    INSERT INTO public.wh_movement_lines (movement_id, item_id, qty, qty_approved, condition, serials, sort_order)
    VALUES (mid, iid, q, qa, ln ->> 'condition', sers, i);
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN mid;
END $$;
