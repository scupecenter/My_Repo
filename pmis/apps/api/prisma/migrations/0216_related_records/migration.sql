-- 0216_related_records: one reader that lists the records linked to a register record, in both directions (item 14 of the 2026-11-26 relations review).
-- Mirror: db/sql/215_related_records.sql (kept identical to prisma/migrations/0216_related_records/migration.sql).
--
--   Registers feed each other through id fields in `data` (the relations map, section 3). This function reads those links so a record page can show
--   "what this record points to" and "what points to this record" without any new stored value. Read only, additive: no table, no data, no permission change.
--   Which fields are links is one list inside the function (from register, field, to register); adding a link later is one line. A group is shown only when the caller
--   holds the view right of the other register in that record's region (the responsibility matrix, wf_actor_regions); the record itself needs the caller's view right.
CREATE OR REPLACE FUNCTION record_related(p_register text, p_entity uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  src public.register_records;
  src_regs int[];
  out jsonb := '[]'::jsonb;
  l record;
  items jsonb;
  regs int[];
BEGIN
  SELECT * INTO src FROM public.register_records r
   WHERE r.register_key = p_register AND r.entity_id = p_entity AND r.is_current AND r.state <> 'voided';
  IF NOT FOUND THEN RETURN out; END IF;
  src_regs := public.wf_actor_regions(p_register, 'view');
  IF src_regs IS NOT NULL AND NOT (src.is_global OR src.region_id = ANY (src_regs)) THEN RETURN out; END IF;

  FOR l IN
    SELECT * FROM (VALUES
      ('warehouse',          'procurement_order_id', 'procurement'),
      ('dismantle',          'procurement_order_id', 'procurement'),
      ('issues',             'procurement_order_id', 'procurement'),
      ('quality',            'procurement_order_id', 'procurement'),
      ('car_dispatcher',     'procurement_record_id', 'procurement'),
      ('financial_advances', 'procurement_record_id', 'procurement'),
      ('issues',             'risk_entity_id',        'risks'),
      ('dismantle',          'closing_rn_id',         'warehouse')
    ) v(from_register, field, to_register)
  LOOP
    -- this record points to another one
    IF l.from_register = p_register AND coalesce(src.data ->> l.field, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      regs := public.wf_actor_regions(l.to_register, 'view');
      SELECT coalesce(jsonb_agg(public.related_item(x) ORDER BY x.created_at DESC, x.id), '[]'::jsonb) INTO items
        FROM public.register_records x
       WHERE x.register_key = l.to_register AND x.entity_id = (src.data ->> l.field)::uuid AND x.is_current AND x.state <> 'voided'
         AND (regs IS NULL OR x.is_global OR x.region_id = ANY (regs));
      IF jsonb_array_length(items) > 0 THEN
        out := out || jsonb_build_array(jsonb_build_object('direction', 'to', 'register_key', l.to_register, 'field', l.field, 'items', items));
      END IF;
    END IF;
    -- other records point to this one
    IF l.to_register = p_register THEN
      regs := public.wf_actor_regions(l.from_register, 'view');
      SELECT coalesce(jsonb_agg(public.related_item(x) ORDER BY x.created_at DESC, x.id), '[]'::jsonb) INTO items
        FROM public.register_records x
       WHERE x.id IN (SELECT y.id FROM public.register_records y
               WHERE y.register_key = l.from_register AND y.is_current AND y.state <> 'voided' AND y.data ->> l.field = p_entity::text
                 AND (regs IS NULL OR y.is_global OR y.region_id = ANY (regs))
               ORDER BY y.created_at DESC, y.id LIMIT 200);
      IF jsonb_array_length(items) > 0 THEN
        out := out || jsonb_build_array(jsonb_build_object('direction', 'from', 'register_key', l.from_register, 'field', l.field, 'items', items));
      END IF;
    END IF;
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION related_item(r public.register_records) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('entity_id', r.entity_id, 'record_id', r.id, 'record_type', r.record_type, 'state', r.state, 'site_id', r.site_id,
    'title', coalesce(nullif(r.data ->> 'doc_no', ''), nullif(r.data ->> 'po_wo_no', ''), nullif(r.data ->> 'pr_no', ''), nullif(r.data ->> 'risk_id', ''),
                      nullif(r.data ->> 'pending_issue', ''), nullif(r.data ->> 'risk_statement', ''), nullif(r.data ->> 'dismantle_reason', ''), left(r.entity_id::text, 8))))
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['record_related(text, uuid)', 'related_item(public.register_records)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION record_related(text, uuid), related_item(public.register_records) TO pmis_app;
  END IF;
END $$;
