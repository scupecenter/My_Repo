-- 0413_site_linked_records: the "Linked records" view of a site (D60, phase 3). Read only, additive; no table, no grant of a role changes.
-- Mirror: db/sql/412_site_linked_records.sql (kept identical to prisma/migrations/0413_site_linked_records/migration.sql).
--
-- site_linked_records(site): for every enabled register, the current records of the site that the caller can see (the register view and the region rule, as
-- the register lists): the count, the latest ten, and for each of them the records it points to through the declared links (register_links, 0409) with
-- their label. `linked` says whether the register takes part in any declared link (either side): a register with `linked = false` is an orphan register
-- (no link declared yet), shown as such so the gap is visible. SECURITY INVOKER: row-level security applies as for the lists.
SELECT set_config('app.region_ids', '*', true);

CREATE OR REPLACE FUNCTION site_linked_records(p_site uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  d record; x public.register_records; t public.register_records; regs int[]; tregs int[]; n integer; items jsonb; links jsonb; lk jsonb; l jsonb; def jsonb;
  out jsonb := '[]'::jsonb; lf text[]; linked boolean;
BEGIN
  FOR d IN SELECT g.register_key, g.name_en, g.name_ar FROM public.register_definitions g
            WHERE g.is_active AND g.enabled AND g.site_scoped ORDER BY g.sort_order, g.register_key LOOP
    regs := public.wf_actor_regions(d.register_key, 'view');
    SELECT count(*) INTO n FROM public.register_records r
     WHERE r.register_key = d.register_key AND r.site_id = p_site AND r.is_current AND r.state <> 'voided'
       AND public.app_region_read(r.is_global, r.region_id) AND (regs IS NULL OR r.is_global OR r.region_id = ANY (regs));
    IF n = 0 THEN CONTINUE; END IF;
    lk := public.register_links_of(d.register_key);
    SELECT EXISTS (SELECT 1 FROM public.register_link_pairs() p WHERE p.register_key = d.register_key OR p.target_register = d.register_key) INTO linked;
    items := '[]'::jsonb;
    FOR x IN SELECT r.* FROM public.register_records r
              WHERE r.register_key = d.register_key AND r.site_id = p_site AND r.is_current AND r.state <> 'voided'
                AND public.app_region_read(r.is_global, r.region_id) AND (regs IS NULL OR r.is_global OR r.region_id = ANY (regs))
              ORDER BY r.updated_at DESC, r.id LIMIT 10 LOOP
      links := '[]'::jsonb;
      FOR l IN SELECT e FROM jsonb_array_elements(lk) e LOOP
        IF coalesce(x.data ->> (l ->> 'field'), '') = '' THEN CONTINUE; END IF;
        SELECT to_jsonb(f) INTO def FROM public.register_link_def(d.register_key, l ->> 'field') f;
        IF def IS NULL THEN CONTINUE; END IF;
        tregs := public.wf_actor_regions(def ->> 'target_register', 'view');
        SELECT * INTO t FROM public.register_records y
         WHERE y.register_key = def ->> 'target_register' AND y.entity_id::text = x.data ->> (l ->> 'field') AND y.is_current AND y.state <> 'voided'
           AND public.app_region_read(y.is_global, y.region_id) AND (tregs IS NULL OR y.is_global OR y.region_id = ANY (tregs))
         ORDER BY y.version_no DESC LIMIT 1;
        IF FOUND THEN
          SELECT array_agg(e) INTO lf FROM jsonb_array_elements_text(def -> 'label_fields') e;
          links := links || jsonb_build_array(jsonb_build_object('field', l ->> 'field', 'target_register', t.register_key, 'entity_id', t.entity_id,
                     'label', coalesce(public.register_link_label(t, lf), left(t.entity_id::text, 8))));
        END IF;
      END LOOP;
      items := items || jsonb_build_array(public.related_item(x) || jsonb_build_object('links', links));
    END LOOP;
    out := out || jsonb_build_array(jsonb_build_object('register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar, 'count', n, 'linked', linked, 'items', items));
  END LOOP;
  RETURN out;
END $$;

DO $$
BEGIN
  REVOKE ALL ON FUNCTION site_linked_records(uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION site_linked_records(uuid) TO pmis_app;
  END IF;
END $$;
