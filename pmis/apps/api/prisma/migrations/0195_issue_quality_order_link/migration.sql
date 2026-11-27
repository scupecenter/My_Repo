-- 0195_issue_quality_order_link: an Issue or a Quality record can name the Procurement order it concerns; the contractor is then read from the order.
-- Mirror: db/sql/194_issue_quality_order_link.sql (kept identical to prisma/migrations/0195_issue_quality_order_link/migration.sql).
--
--   Relations map section 4: the contractor of an issue or a quality record was an id column nobody could set from the screen, so the contractor performance view
--   (0180) saw almost no issues or inspections. Owner principle (2026-11-26): registers feed each other, a value is typed once. The record now names the order
--   (optional, picked from a list); the database sets the contractor (external_party_id, which the projections issues.party_id and quality_inspections.party_id copy)
--   from the order and refuses a different typed contractor (`contractor_from_order`). Without an order the contractor stays as it is today (optional, chosen).
--   Rules (blocking, on a version in entry only; a version in review or approved is history): the order must be an approved, current, not cancelled Procurement
--   record in a region where the caller holds the Procurement view right (the responsibility matrix decides), on the same site as the record.
--   Additive: one optional field per register, one row trigger. No new table, no grant, no permission change, nothing deleted.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('issues',  'procurement_order_id', 'Procurement Order', 'أمر المشتريات', 'text', false, false, false, NULL, false, 'Contractor', 90),
  ('quality', 'procurement_order_id', 'Procurement Order', 'أمر المشتريات', 'text', false, false, false, NULL, false, 'Contractor', 90)
ON CONFLICT (register_key, code) DO NOTHING;

CREATE OR REPLACE FUNCTION issue_quality_order_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  regs int[]; d jsonb := NEW.data; errs jsonb := '[]'::jsonb; o public.register_records%ROWTYPE;
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
  typed boolean := (TG_OP = 'INSERT' AND NEW.supersedes_id IS NULL AND NEW.external_party_id IS NOT NULL)
                   OR (TG_OP = 'UPDATE' AND NEW.external_party_id IS DISTINCT FROM OLD.external_party_id);
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  IF coalesce(d ->> 'procurement_order_id', '') = '' THEN
    NEW.data := d - 'procurement_order_id';
    RETURN NEW;
  END IF;
  IF d ->> 'procurement_order_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    errs := errs || public.reg_err_item('/data/procurement_order_id', 'invalid', 'A Procurement record id.');
  ELSE
    regs := public.wf_actor_regions('procurement', 'view');                   -- the matrix decides who may read Procurement: NULL = every region
    SELECT * INTO o FROM public.register_records x
      WHERE x.register_key = 'procurement' AND x.entity_id = (d ->> 'procurement_order_id')::uuid AND x.is_current AND x.state = 'approved'
        AND NOT public.proc_order_cancelled(x.data ->> 'order_status') AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.region_id = ANY (regs));
    IF NOT FOUND THEN
      errs := errs || public.reg_err_item('/data/procurement_order_id', 'order_not_active', 'Not an approved, active Procurement order that you can see (it needs the Procurement view right).');
    ELSIF NEW.site_id IS NOT NULL AND o.site_id IS DISTINCT FROM NEW.site_id THEN
      errs := errs || public.reg_err_item('/data/procurement_order_id', 'order_other_site', 'The order belongs to another site than this record.');
    ELSIF typed AND NEW.external_party_id IS NOT NULL AND NEW.external_party_id IS DISTINCT FROM o.external_party_id THEN
      errs := errs || public.reg_err_item('/external_party_id', 'contractor_from_order', 'The contractor comes from the Procurement order and cannot be typed here.');
    ELSE
      NEW.external_party_id := o.external_party_id;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_issue_quality_order_rules BEFORE INSERT OR UPDATE OF data, external_party_id, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key IN ('issues', 'quality')) EXECUTE FUNCTION issue_quality_order_rules();

DO $$
BEGIN
  ALTER FUNCTION issue_quality_order_rules() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION issue_quality_order_rules() FROM PUBLIC;
END $$;
