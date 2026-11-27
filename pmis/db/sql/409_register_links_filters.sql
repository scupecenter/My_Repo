-- 0410_register_links_filters: the link declaration (0409) learns the filters and labels of the hand-coded pickers (D60, phase 2). Additive.
-- Mirror: db/sql/409_register_links_filters.sql (kept identical to prisma/migrations/0410_register_links_filters/migration.sql).
--
--   * register_links.data_in {key: [values]} (the target's data key must be one of these) and data_not_like {key: [patterns]} (must match none, ILIKE): the
--     "disbursed or in settlement" rule of the advance picker and the "not cancelled" rule of the order pickers become data, not code.
--   * label_fields understands `a|b` (first not empty), `field>key` (key of the record that field points to) and `@party` (the company of the record), so the
--     generic picker shows what the hand-coded ones show: PO / WO No. and the contractor for an order, the PO of the assignment for an advance.
--   * The seeds of the order links and of advance_id get these filters and same_site, as the pickers had. enforce stays OFF for every link (a decision after the
--     orphan report, register_link_orphans()); the check, when switched on, applies the same filters.
--   * register_link_options() and register_link_rules() take the filters (they are this feature's own functions, so they are replaced whole).
SELECT set_config('app.region_ids', '*', true);

ALTER TABLE public.register_links ADD COLUMN IF NOT EXISTS data_in jsonb;
ALTER TABLE public.register_links ADD COLUMN IF NOT EXISTS data_not_like jsonb;

UPDATE public.register_links SET label_fields = ARRAY['po_wo_no|pr_no', '@party'], data_not_like = '{"order_status": ["cancel%", " cancel%"]}'::jsonb
 WHERE target_register = 'procurement' AND data_not_like IS NULL;
UPDATE public.register_links SET same_site = true
 WHERE target_register = 'procurement' AND register_key IN ('warehouse', 'issues', 'quality', 'change_control', 'financial_advances', 'invoices');
UPDATE public.register_links SET label_fields = ARRAY['procurement_record_id>po_wo_no|pr_no', 'advance_kind', 'disbursed_date'],
       data_in = '{"advance_state": ["disbursed", "settlement_in_progress"]}'::jsonb
 WHERE register_key = 'financial_advances' AND field_code = 'advance_id' AND data_in IS NULL;

CREATE OR REPLACE FUNCTION register_link_filter_ok(p_data jsonb, p_in jsonb, p_not_like jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT (p_in IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_each(p_in) e
            WHERE NOT coalesce((p_data ->> e.key) = ANY (ARRAY(SELECT jsonb_array_elements_text(e.value))), false)))
     AND (p_not_like IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_each(p_not_like) e, jsonb_array_elements_text(e.value) pat
            WHERE coalesce(p_data ->> e.key, '') ILIKE pat))
$$;

CREATE OR REPLACE FUNCTION register_link_label(r public.register_records, lf text[]) RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE tok text; alt text; v text; parts text[] := '{}';
BEGIN
  FOREACH tok IN ARRAY coalesce(lf, '{}') LOOP
    v := NULL;
    FOREACH alt IN ARRAY string_to_array(tok, '|') LOOP
      IF alt = '@party' THEN
        SELECT ep.name INTO v FROM public.external_parties ep WHERE ep.id = r.external_party_id;
      ELSIF position('>' IN alt) > 0 THEN
        SELECT p.data ->> split_part(alt, '>', 2) INTO v FROM public.register_records p
         WHERE p.entity_id::text = r.data ->> split_part(alt, '>', 1) AND p.is_current ORDER BY p.version_no DESC LIMIT 1;
      ELSE
        v := r.data ->> alt;
      END IF;
      EXIT WHEN coalesce(v, '') <> '';
    END LOOP;
    IF coalesce(v, '') <> '' THEN parts := parts || v; END IF;
  END LOOP;
  RETURN nullif(array_to_string(parts, ' · '), '');
END $$;

DROP FUNCTION IF EXISTS register_link_def(text, text);
CREATE OR REPLACE FUNCTION register_link_def(p_register text, p_field text)
RETURNS TABLE (target_register text, target_record_type text, target_state text, same_site boolean, label_fields jsonb, enforce boolean, data_in jsonb, data_not_like jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.target_register, k.target_record_type, k.target_state, k.same_site, to_jsonb(k.label_fields), k.enforce, k.data_in, k.data_not_like
    FROM public.register_links k WHERE k.register_key = p_register AND k.field_code = p_field AND k.is_active
$$;

CREATE OR REPLACE FUNCTION register_link_options(p_register text, p_field text, p_site uuid DEFAULT NULL, p_q text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE k jsonb; tr text; rt text; st text; ss boolean; lf text[]; regs int[]; out jsonb;
BEGIN
  SELECT to_jsonb(x) INTO k FROM public.register_link_def(p_register, p_field) x;
  IF k IS NULL THEN RETURN '[]'::jsonb; END IF;
  tr := k ->> 'target_register'; rt := k ->> 'target_record_type'; st := k ->> 'target_state'; ss := (k ->> 'same_site')::boolean;
  SELECT array_agg(e) INTO lf FROM jsonb_array_elements_text(k -> 'label_fields') e;
  regs := public.wf_actor_regions(tr, 'view');
  SELECT coalesce(jsonb_agg(z.j ORDER BY z.created_at DESC, z.id), '[]'::jsonb) INTO out FROM (
    SELECT r.id, r.created_at, jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'site_id', r.site_id, 'record_type', r.record_type,
             'label', coalesce(public.register_link_label(r, lf), left(r.entity_id::text, 8)))) AS j
      FROM public.register_records r
     WHERE r.register_key = tr AND r.is_current AND r.state = st AND (rt IS NULL OR r.record_type = rt)
       AND public.register_link_filter_ok(r.data, k -> 'data_in', k -> 'data_not_like')
       AND (NOT ss OR p_site IS NULL OR r.site_id = p_site)
       AND public.app_region_read(r.is_global, r.region_id) AND (regs IS NULL OR r.is_global OR r.region_id = ANY (regs))
       AND (coalesce(p_q, '') = '' OR coalesce(public.register_link_label(r, lf), '') ILIKE '%' || p_q || '%')
     ORDER BY r.created_at DESC, r.id LIMIT 500) z;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION register_link_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  k public.register_links; v text; t public.register_records%ROWTYPE; regs int[]; errs jsonb := '[]'::jsonb;
BEGIN
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF NOT (NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided')) THEN RETURN NEW; END IF;
  FOR k IN SELECT * FROM public.register_links x WHERE x.register_key = NEW.register_key AND x.enforce AND x.is_active ORDER BY x.sort_order, x.field_code LOOP
    v := NEW.data ->> k.field_code;
    IF coalesce(v, '') = '' THEN
      IF NEW.data ? k.field_code THEN NEW.data := NEW.data - k.field_code; END IF;
      CONTINUE;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.data ->> k.field_code IS NOT DISTINCT FROM v THEN CONTINUE; END IF;
    IF v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      errs := errs || public.reg_err_item('/data/' || k.field_code, 'invalid', 'A record id of ' || k.target_register || '.');
      CONTINUE;
    END IF;
    regs := public.wf_actor_regions(k.target_register, 'view');
    SELECT * INTO t FROM public.register_records x
     WHERE x.register_key = k.target_register AND x.entity_id = v::uuid AND x.is_current AND x.state = k.target_state
       AND (k.target_record_type IS NULL OR x.record_type = k.target_record_type)
       AND public.register_link_filter_ok(x.data, k.data_in, k.data_not_like)
       AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.is_global OR x.region_id = ANY (regs));
    IF NOT FOUND THEN
      errs := errs || public.reg_err_item('/data/' || k.field_code, 'link_not_found', 'Not a ' || k.target_state || ' record of ' || k.target_register || ' that you can see and may link.');
    ELSIF k.same_site AND NEW.site_id IS NOT NULL AND t.site_id IS DISTINCT FROM NEW.site_id THEN
      errs := errs || public.reg_err_item('/data/' || k.field_code, 'link_other_site', 'The linked record belongs to another site.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  ALTER FUNCTION register_link_def(text, text) OWNER TO pmis_definer;
  ALTER FUNCTION register_link_rules() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION register_link_def(text, text), register_link_rules(), register_link_filter_ok(jsonb, jsonb, jsonb), register_link_label(public.register_records, text[]), register_link_options(text, text, uuid, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION register_link_def(text, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION register_link_def(text, text), register_link_filter_ok(jsonb, jsonb, jsonb), register_link_label(public.register_records, text[]), register_link_options(text, text, uuid, text) TO pmis_app;
  END IF;
END $$;
