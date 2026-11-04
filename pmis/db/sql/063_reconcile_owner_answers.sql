-- 0064_reconcile_owner_answers: makes the work packages of the owner answers of 2026-11-04 agree where two of them touch the same rule. Each package was
-- built on its own; these are the points where the later one changed what the earlier one decided, settled by the owner's answers. Mirrored
-- byte-identically as db/sql/063_reconcile_owner_answers.sql. No contract change.
--
--   1. Q180 (P1 0052 and P4a 0062): a suspension pairs with the resumption that names it (change_requests.paired_change_id, written by P4a) and,
--      without one, with the first approved resumption on or after its start. A suspension and a resumption on the same day leave an empty window
--      [start, resume), so the gate is not blocked by it. P1 paired only a strictly later resumption.
--   2. Q108 (P5 0057 and P4a 0062): the As-Built item types (WL / MW antenna type, router type) are Warehouse items of their group. P5 linked them to
--      the catalogues WLAntennaType, MWAntennaType and RouterType (another value allowed); P4a kept the list in register_fields.options. The
--      catalogue now follows the Warehouse: its values are the active items of the group, other values are deactivated, and another value is
--      allowed only while the group has no active item (the free text of Q108 then).
--   3. Q110 (P5 0057 and P4b 0061): an unknown company type becomes "other" with a review alert (P4b). P5 made CompanyType a closed critical list,
--      which refused it before the mapping ran. CompanyType is now non-critical and accepts another value (the mapping decides the party type).
--   4. Q104 (P5 0057 and P4b, P4a, P4c): every list field reads a catalogue. The list fields added after 0057 (contract status, withdrawn, part not
--      applicable, execution mode, and any other) get a pending catalogue with their current values, closed as before.

-- 1. Suspension windows
CREATE OR REPLACE FUNCTION cc_suspension_windows(p_site uuid, p_ref date DEFAULT NULL)
RETURNS TABLE (suspension_id uuid, suspended_from date, suspension_approved date, resumption_id uuid, resumed_on date, resumption_approved date, retroactive boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH s AS (
    SELECT c.id, coalesce(c.suspension_start, c.approval_date) AS d, c.approval_date AS a, c.paired_change_id AS p
    FROM public.change_requests c
    WHERE c.site_id = p_site AND c.kind = 'suspension' AND c.status IN ('approved', 'applied') AND coalesce(c.suspension_start, c.approval_date) IS NOT NULL
  ), r AS (
    SELECT c.id, coalesce(c.resumption_date, c.approval_date) AS d, c.approval_date AS a
    FROM public.change_requests c
    WHERE c.site_id = p_site AND c.kind = 'resumption' AND c.status IN ('approved', 'applied') AND coalesce(c.resumption_date, c.approval_date) IS NOT NULL
  )
  SELECT s.id, s.d, s.a, rr.id, rr.d, rr.a, (s.a IS NOT NULL AND s.d < s.a) OR (rr.a IS NOT NULL AND rr.d < rr.a)
  FROM s LEFT JOIN LATERAL (
    SELECT x.id, x.d, x.a FROM (
      SELECT r.id, r.d, r.a, 0 AS pri FROM r WHERE r.id = s.p AND r.d >= s.d
      UNION ALL
      SELECT r.id, r.d, r.a, 1 FROM r WHERE r.d >= s.d
    ) x ORDER BY x.pri, x.d, x.id LIMIT 1) rr ON true
  WHERE p_ref IS NULL OR s.d <= p_ref
  ORDER BY s.d, s.id
$$;

-- 2. As-Built item types follow the Warehouse catalogue
CREATE OR REPLACE FUNCTION reconcile_as_built_type_lists() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; cat text; opts jsonb;
BEGIN
  FOR s IN SELECT * FROM public.as_built_type_sources LOOP
    SELECT f.list_catalogue INTO cat FROM public.register_fields f WHERE f.register_key = 'as_built' AND f.code = s.field_code;
    IF cat IS NULL THEN CONTINUE; END IF;
    SELECT jsonb_agg(w.item_code ORDER BY w.item_code) INTO opts FROM public.warehouse_items w WHERE w.item_group = s.item_group AND w.is_active;
    INSERT INTO public.list_values (catalogue_code, code, label_en, sort_order, is_active)
    SELECT cat, w.item_code, left(coalesce(nullif(btrim(w.name), ''), w.item_code), 200), (row_number() OVER (ORDER BY w.item_code))::int * 10, true
    FROM public.warehouse_items w WHERE w.item_group = s.item_group AND w.is_active
    ON CONFLICT (catalogue_code, code) DO UPDATE SET is_active = true, updated_at = now() WHERE list_values.is_active IS DISTINCT FROM true;
    UPDATE public.list_values v SET is_active = false, updated_at = now()
    WHERE v.catalogue_code = cat AND v.is_active AND opts IS NOT NULL AND NOT (opts ? v.code);
    UPDATE public.list_catalogues c SET allow_other = (opts IS NULL), updated_at = now() WHERE c.code = cat AND c.allow_other IS DISTINCT FROM (opts IS NULL);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION reconcile_as_built_type_lists() FROM PUBLIC;

CREATE OR REPLACE FUNCTION reconcile_as_built_type_lists_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.reconcile_as_built_type_lists();
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION reconcile_as_built_type_lists_trg() FROM PUBLIC;
ALTER FUNCTION reconcile_as_built_type_lists() OWNER TO pmis_definer;
ALTER FUNCTION reconcile_as_built_type_lists_trg() OWNER TO pmis_definer;
-- after P4a's statement trigger p4a_sync_as_built_types (alphabetical order of trigger names: p4a_ before reconcile_)
CREATE TRIGGER reconcile_as_built_type_lists AFTER INSERT OR UPDATE OR DELETE ON warehouse_items FOR EACH STATEMENT EXECUTE FUNCTION reconcile_as_built_type_lists_trg();
SELECT reconcile_as_built_type_lists();

-- 3. Company type: the mapping of Q110 decides, an unknown type is kept and reviewed
UPDATE list_catalogues SET critical = false, allow_other = true, updated_at = now(),
  description = coalesce(description || ' ', '') || 'Another value is kept as typed: the party becomes "other" with a review alert (Q110, migration 0064).'
WHERE code = 'CompanyType';

-- 4. List fields added after 0057 read a catalogue too (closed, pending the owner's review)
DO $$
DECLARE f record; cat text; i int;
BEGIN
  FOR f IN SELECT register_key, code, label_en, options FROM register_fields
           WHERE field_type = 'list' AND list_catalogue IS NULL AND NOT derived AND jsonb_typeof(options) = 'array' ORDER BY register_key, code LOOP
    cat := left(replace(initcap(replace(f.register_key || '_' || f.code, '_', ' ')), ' ', ''), 41);
    INSERT INTO list_catalogues (code, name_en, critical, status, allow_other, description)
    VALUES (cat, left(coalesce(nullif(btrim(f.label_en), ''), f.code), 200), false, 'pending', false, 'Values of ' || f.register_key || '.' || f.code || ' (migration 0064).')
    ON CONFLICT (code) DO NOTHING;
    i := 0;
    FOR i IN 0 .. jsonb_array_length(f.options) - 1 LOOP
      INSERT INTO list_values (catalogue_code, code, label_en, sort_order)
      VALUES (cat, f.options ->> i, left(f.options ->> i, 200), (i + 1) * 10) ON CONFLICT (catalogue_code, code) DO NOTHING;
    END LOOP;
    UPDATE register_fields SET list_catalogue = cat WHERE register_key = f.register_key AND code = f.code;
  END LOOP;
END $$;
