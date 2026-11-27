-- 0321_dismantle_closing_rn_link: a Dismantle part closes by naming its signed Warehouse RN (picked from a list); the RN reference is then READ from the RN.
-- Mirror: db/sql/320_dismantle_closing_rn_link.sql (kept identical to prisma/migrations/0321_dismantle_closing_rn_link/migration.sql).
--
--   Q101 (2026-11-01) left a text field, `closing_rn_ref`, until the Warehouse register exists. It exists now (0026), so the text is replaced by a link, without removing the text:
--   a new optional field `closing_rn_id` (the entity id of a Warehouse RN) is picked from the RNs of the same site and of the part (CW part: cw_rn, TE part: te_rn). When it is set,
--   `closing_rn_ref` is rebuilt from the RN's Doc No. (never typed), and the existing closing rule (a part closes only with its RN reference) is satisfied by the link.
--   Without a link the typed reference still works (old records, a part whose RN is not in the system). Additive: one optional field, one row trigger, one reader. No new table,
--   no permission widening, nothing deleted. The trigger fires before dismantle_rules (alphabetical order of trigger names) so the rule sees the derived reference.
--   Rules (blocking, on a version in entry): the RN is a current, not voided, Received Warehouse RN of the part's type that the caller may see; it is on the same site; and the caller
--   holds the Warehouse view right in the RN's region (the responsibility matrix decides, so a user without it cannot read or pick an RN).

SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order)
SELECT 'dismantle', 'closing_rn_id', 'Closing RN (Warehouse)', 'إيصال الإرجاع (من المخزن)', 'text', false, false, false, NULL, false, f.section, f.sort_order + 1
FROM register_fields f WHERE f.register_key = 'dismantle' AND f.code = 'closing_rn_ref'
ON CONFLICT (register_key, code) DO NOTHING;

CREATE OR REPLACE FUNCTION dismantle_rn_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  regs int[]; d jsonb := NEW.data; errs jsonb := '[]'::jsonb; rn uuid; w public.register_records%ROWTYPE;
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  IF coalesce(d ->> 'closing_rn_id', '') = '' THEN
    NEW.data := d - 'closing_rn_id';                                       -- no link: the typed reference stands
    RETURN NEW;
  END IF;
  IF d ->> 'closing_rn_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    errs := errs || public.reg_err_item('/data/closing_rn_id', 'invalid', 'A Warehouse record id.');
  ELSIF NEW.record_type IS NULL OR NEW.record_type NOT IN ('cw', 'te') THEN
    errs := errs || public.reg_err_item('/record_type', 'required', 'The part (CW or TE) comes first.');
  ELSE
    rn := (d ->> 'closing_rn_id')::uuid;
    regs := public.wf_actor_regions('warehouse', 'view');                  -- the matrix decides who may read the Warehouse: NULL = every region
    SELECT * INTO w FROM public.register_records x
      WHERE x.register_key = 'warehouse' AND x.entity_id = rn AND x.is_current AND x.state <> 'voided' AND x.record_type = NEW.record_type || '_rn'
        AND x.data ->> 'txn_status' = 'Received' AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.region_id = ANY (regs));
    IF NOT FOUND THEN
      errs := errs || public.reg_err_item('/data/closing_rn_id', 'rn_not_available', 'Not a received RN of this part that you can see (it needs the Warehouse view right).');
    ELSIF NEW.site_id IS NOT NULL AND w.site_id IS DISTINCT FROM NEW.site_id THEN
      errs := errs || public.reg_err_item('/data/closing_rn_id', 'rn_other_site', 'The RN belongs to another site than this part.');
    ELSE
      d := d || jsonb_build_object('closing_rn_ref', w.data ->> 'doc_no');
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  NEW.data := d;
  RETURN NEW;
END $$;
CREATE TRIGGER a_dismantle_rn_link BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'dismantle') EXECUTE FUNCTION dismantle_rn_link();

-- The picker: received RNs of the part's type on the site, that the caller may see.
CREATE OR REPLACE FUNCTION dismantle_rn_options(p_site uuid, p_part text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.sort_date DESC NULLS LAST, x.sort_id), '[]'::jsonb) FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'site_id', r.site_id, 'record_type', r.record_type,
             'doc_no', r.data ->> 'doc_no', 'doc_date', r.data ->> 'doc_date', 'txn_status', r.data ->> 'txn_status')) AS j,
           r.data ->> 'doc_date' AS sort_date, r.id AS sort_id
    FROM public.register_records r
    CROSS JOIN (SELECT public.wf_actor_regions('warehouse', 'view') AS regs) a
    WHERE (a.regs IS NULL OR r.region_id = ANY (a.regs)) AND r.register_key = 'warehouse' AND r.is_current AND r.state <> 'voided'
      AND r.record_type = p_part || '_rn' AND r.data ->> 'txn_status' = 'Received' AND r.site_id = p_site
    ORDER BY r.data ->> 'doc_date' DESC NULLS LAST, r.id LIMIT 500) x
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['dismantle_rn_link()', 'dismantle_rn_options(uuid, text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION dismantle_rn_options(uuid, text) TO pmis_app;
  END IF;
END $$;
