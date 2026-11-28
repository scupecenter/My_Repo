-- 0409_register_links: one declaration per link between registers (D60, phase 1). Additive; nothing is deleted, no permission or grant of a role changes.
-- Mirror: db/sql/408_register_links.sql (kept identical to prisma/migrations/0409_register_links/migration.sql).
--
-- Until now a link between two registers (a field in `data` that holds the id of the other record) was spread over a hand-written list in record_related(),
-- one trigger per link (0407) and one hand-coded picker per link in the web. This adds the declaration: table register_links, one row per link field.
--   * record_related() also reads the declared links (patched in place, idempotent; the hand-coded list stays and the union removes repeats).
--   * register_link_rules(): for a link with enforce = true, while the row is in entry and only when the value changed, the id must be a current approved record
--     of the target register (and record type when given) that the caller can see, and of the same site when same_site. Links with a hand-written trigger or
--     old data are seeded with enforce = false (declared only), so no old row is refused: switch them on after the orphan check (register_link_orphans()).
--   * register_link_options(register, field, site, q) is the one generic picker; register_links_of(register) lists the declared links of a register (web).
--   * register_link_orphans(): per declared link, how many current rows hold an id that is not a current record of the target (read only report).
-- A new link is one INSERT: it shows in the Related records panel, gets the check (enforce) and the picker without new code.
SELECT set_config('app.region_ids', '*', true);

CREATE TABLE IF NOT EXISTS register_links (
  register_key        text    NOT NULL REFERENCES register_definitions (register_key) ON DELETE CASCADE ON UPDATE CASCADE,
  field_code          text    NOT NULL CHECK (field_code ~ '^[a-z][a-z0-9_]{0,40}$'),
  target_register     text    NOT NULL REFERENCES register_definitions (register_key) ON DELETE CASCADE ON UPDATE CASCADE,
  target_record_type  text,                                    -- NULL = any record type of the target
  target_state        text    NOT NULL DEFAULT 'approved',     -- the state a record must have to be picked or accepted
  same_site           boolean NOT NULL DEFAULT false,          -- the target must belong to the same site as the row
  label_fields        text[]  NOT NULL DEFAULT ARRAY['code', 'name']::text[],  -- data keys of the target shown in the picker, in this order
  enforce             boolean NOT NULL DEFAULT false,          -- check the id in entry (see above)
  is_active           boolean NOT NULL DEFAULT true,
  sort_order          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (register_key, field_code)
);

INSERT INTO register_links (register_key, field_code, target_register, target_record_type, same_site, label_fields, enforce, sort_order)
SELECT v.* FROM (VALUES
  ('warehouse',          'procurement_order_id',  'procurement',        NULL,      false, ARRAY['po_wo_no', 'pr_no'], false, 10),
  ('dismantle',          'procurement_order_id',  'procurement',        NULL,      false, ARRAY['po_wo_no', 'pr_no'], false, 20),
  ('issues',             'procurement_order_id',  'procurement',        NULL,      false, ARRAY['po_wo_no', 'pr_no'], false, 30),
  ('quality',            'procurement_order_id',  'procurement',        NULL,      false, ARRAY['po_wo_no', 'pr_no'], false, 40),
  ('change_control',     'procurement_order_id',  'procurement',        NULL,      false, ARRAY['po_wo_no', 'pr_no'], false, 50),
  ('car_dispatcher',     'procurement_record_id', 'procurement',        NULL,      false, ARRAY['po_wo_no', 'pr_no'], false, 60),
  ('financial_advances', 'procurement_record_id', 'procurement',        NULL,      false, ARRAY['po_wo_no', 'pr_no'], false, 70),
  ('invoices',           'procurement_record_id', 'procurement',        NULL,      true,  ARRAY['po_wo_no', 'pr_no'], false, 80),
  ('hlc',                'procurement_record_id', 'procurement',        NULL,      false, ARRAY['po_wo_no', 'pr_no'], false, 90),
  ('financial_advances', 'advance_id',            'financial_advances', 'advance', true,  ARRAY['po_wo_no', 'advance_kind', 'disbursed_date'], false, 100),
  ('issues',             'risk_entity_id',        'risks',              NULL,      false, ARRAY['code', 'title'], false, 110),
  ('dismantle',          'closing_rn_id',         'warehouse',          NULL,      false, ARRAY['rn_no', 'dn_no'], false, 120)
) v(register_key, field_code, target_register, target_record_type, same_site, label_fields, enforce, sort_order)
WHERE EXISTS (SELECT 1 FROM register_definitions d WHERE d.register_key = v.register_key) AND EXISTS (SELECT 1 FROM register_definitions d WHERE d.register_key = v.target_register)
ON CONFLICT (register_key, field_code) DO NOTHING;

-- the declared links (read through definer functions: the table itself is not readable by the app role)
CREATE OR REPLACE FUNCTION register_link_pairs() RETURNS TABLE (register_key text, field_code text, target_register text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.register_key, k.field_code, k.target_register FROM public.register_links k WHERE k.is_active
$$;

CREATE OR REPLACE FUNCTION register_links_of(p_register text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('field', k.field_code, 'target_register', k.target_register, 'target_record_type', k.target_record_type,
           'same_site', k.same_site, 'enforce', k.enforce) ORDER BY k.sort_order, k.field_code), '[]'::jsonb)
  FROM public.register_links k WHERE k.register_key = p_register AND k.is_active
$$;

-- the generic picker: the current records of the target the caller can see (row-level security and the region rule apply, as for the hand-coded pickers)
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
             'label', coalesce(nullif((SELECT string_agg(r.data ->> f, ' · ' ORDER BY o) FROM unnest(lf) WITH ORDINALITY u(f, o) WHERE coalesce(r.data ->> f, '') <> ''), ''), left(r.entity_id::text, 8)))) AS j
      FROM public.register_records r
     WHERE r.register_key = tr AND r.is_current AND r.state = st AND (rt IS NULL OR r.record_type = rt)
       AND (NOT ss OR p_site IS NULL OR r.site_id = p_site)
       AND public.app_region_read(r.is_global, r.region_id) AND (regs IS NULL OR r.is_global OR r.region_id = ANY (regs))
       AND (coalesce(p_q, '') = '' OR (SELECT string_agg(r.data ->> f, ' ') FROM unnest(lf) f) ILIKE '%' || p_q || '%')
     ORDER BY r.created_at DESC, r.id LIMIT 200) z;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION register_link_def(p_register text, p_field text) RETURNS TABLE (target_register text, target_record_type text, target_state text, same_site boolean, label_fields jsonb, enforce boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.target_register, k.target_record_type, k.target_state, k.same_site, to_jsonb(k.label_fields), k.enforce
    FROM public.register_links k WHERE k.register_key = p_register AND k.field_code = p_field AND k.is_active
$$;

-- the check of an enforced link (entry only, only when the value changed; an empty value removes the key)
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
       AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.is_global OR x.region_id = ANY (regs));
    IF NOT FOUND THEN
      errs := errs || public.reg_err_item('/data/' || k.field_code, 'link_not_found', 'Not a ' || k.target_state || ' record of ' || k.target_register || ' that you can see.');
    ELSIF k.same_site AND NEW.site_id IS NOT NULL AND t.site_id IS DISTINCT FROM NEW.site_id THEN
      errs := errs || public.reg_err_item('/data/' || k.field_code, 'link_other_site', 'The linked record belongs to another site.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b_register_links ON register_records;
CREATE TRIGGER b_register_links BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW EXECUTE FUNCTION register_link_rules();

-- orphan report (operator and ops use only: no grant to the app role, it counts across regions): per declared link, the current rows that hold an id which is not a current record of the target
CREATE OR REPLACE FUNCTION register_link_orphans() RETURNS TABLE (register_key text, field_code text, target_register text, rows_with_value bigint, orphan_rows bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.register_key, k.field_code, k.target_register,
         count(*) FILTER (WHERE coalesce(r.data ->> k.field_code, '') <> ''),
         count(*) FILTER (WHERE coalesce(r.data ->> k.field_code, '') <> ''
                            AND NOT EXISTS (SELECT 1 FROM public.register_records t WHERE t.register_key = k.target_register AND t.is_current
                                            AND (t.entity_id::text = r.data ->> k.field_code OR t.id::text = r.data ->> k.field_code)))
    FROM public.register_links k
    LEFT JOIN public.register_records r ON r.register_key = k.register_key AND r.is_current AND r.state <> 'voided'
   WHERE k.is_active GROUP BY k.register_key, k.field_code, k.target_register, k.sort_order ORDER BY k.sort_order, k.field_code
$$;

-- record_related(): also read the declared links (patched in place, idempotent; the union removes repeats of the hand-coded list)
DO $$
DECLARE def text; n text;
BEGIN
  def := pg_get_functiondef('public.record_related(text,uuid)'::regprocedure);
  IF position('register_link_pairs' IN def) = 0 THEN
    n := replace(def, ') v(from_register, field, to_register)', ') v(from_register, field, to_register) UNION SELECT p.register_key, p.field_code, p.target_register FROM public.register_link_pairs() p');
    IF n = def THEN RAISE EXCEPTION 'record_related() has no link list to patch'; END IF;
    EXECUTE n;
  END IF;
END $$;

-- data reset: configuration (KEEP), patched in place (0361 pattern)
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('''register_links''' IN def) = 0 THEN
    IF position('''phase_gate_rules''' IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the keep list anchor was not found'; END IF;
    EXECUTE replace(def, '''phase_gate_rules''', '''phase_gate_rules'', ''register_links''');
  END IF;
END $$;

ALTER TABLE public.register_links OWNER TO pmis_definer;
REVOKE ALL ON public.register_links FROM PUBLIC;
GRANT SELECT ON public.register_links TO pmis_definer;
GRANT SELECT ON public.register_records TO pmis_definer;
GRANT SELECT, UPDATE ON public.register_links TO pmis_reset_owner;

DO $$
BEGIN
  ALTER FUNCTION register_link_pairs() OWNER TO pmis_definer;
  ALTER FUNCTION register_links_of(text) OWNER TO pmis_definer;
  ALTER FUNCTION register_link_def(text, text) OWNER TO pmis_definer;
  ALTER FUNCTION register_link_rules() OWNER TO pmis_definer;
  ALTER FUNCTION register_link_orphans() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION register_link_pairs(), register_links_of(text), register_link_def(text, text), register_link_rules(), register_link_orphans(), register_link_options(text, text, uuid, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION register_link_pairs(), register_links_of(text), register_link_def(text, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION register_link_pairs(), register_links_of(text), register_link_def(text, text), register_link_options(text, text, uuid, text) TO pmis_app;
  END IF;
END $$;
