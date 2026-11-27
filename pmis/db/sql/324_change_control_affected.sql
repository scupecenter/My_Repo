-- 0325_change_control_affected: a Change Control record can name the Procurement order and the task it affects, both picked from lists.
-- Mirror: db/sql/324_change_control_affected.sql (kept identical to prisma/migrations/0325_change_control_affected/migration.sql).
--
--   Item F2 of the approved relations review: a change request said what it changes in free text only. Two optional fields now point at the records it touches:
--   `procurement_order_id` (an approved, active Procurement order of the same site that the caller may see) and `affected_task_code` (a task code of the workflow).
--   Both are validated on a version in entry only (a version in review or approved is history). The change-pending badge on the order is read from these links
--   by record_related (0324), so nothing new is stored for it. Additive: two optional fields, one row trigger. No table, no grant, no permission change, nothing deleted.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('change_control', 'procurement_order_id', 'Affected Procurement Order', 'أمر المشتريات المتأثر', 'text', false, false, false, NULL, false, 'Affected', 100),
  ('change_control', 'affected_task_code',   'Affected Task',              'المهمة المتأثرة',        'text', false, false, false, NULL, false, 'Affected', 110)
ON CONFLICT (register_key, code) DO NOTHING;

CREATE OR REPLACE FUNCTION change_control_affected_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  regs int[]; d jsonb := NEW.data; errs jsonb := '[]'::jsonb; o public.register_records%ROWTYPE;
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  IF coalesce(d ->> 'procurement_order_id', '') = '' THEN NEW.data := NEW.data - 'procurement_order_id';
  ELSIF NOT (TG_OP = 'UPDATE' AND OLD.data ->> 'procurement_order_id' IS NOT DISTINCT FROM d ->> 'procurement_order_id') THEN   -- unchanged: never re-checked
    IF d ->> 'procurement_order_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      errs := errs || public.reg_err_item('/data/procurement_order_id', 'invalid', 'A Procurement record id.');
    ELSE
      regs := public.wf_actor_regions('procurement', 'view');
      SELECT * INTO o FROM public.register_records x
        WHERE x.register_key = 'procurement' AND x.entity_id = (d ->> 'procurement_order_id')::uuid AND x.is_current AND x.state = 'approved'
          AND NOT public.proc_order_cancelled(x.data ->> 'order_status') AND public.app_region_read(x.is_global, x.region_id) AND (regs IS NULL OR x.region_id = ANY (regs));
      IF NOT FOUND THEN
        errs := errs || public.reg_err_item('/data/procurement_order_id', 'order_not_active', 'Not an approved, active Procurement order that you can see (it needs the Procurement view right).');
      ELSIF NEW.site_id IS NOT NULL AND o.site_id IS DISTINCT FROM NEW.site_id THEN
        errs := errs || public.reg_err_item('/data/procurement_order_id', 'order_other_site', 'The order belongs to another site than this record.');
      END IF;
    END IF;
  END IF;
  IF coalesce(d ->> 'affected_task_code', '') = '' THEN NEW.data := NEW.data - 'affected_task_code';
  ELSIF NOT (TG_OP = 'UPDATE' AND OLD.data ->> 'affected_task_code' IS NOT DISTINCT FROM d ->> 'affected_task_code') THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.code = d ->> 'affected_task_code') THEN
      errs := errs || public.reg_err_item('/data/affected_task_code', 'unknown_task', 'Not a task code of the workflow.');
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_change_control_affected_rules BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'change_control') EXECUTE FUNCTION change_control_affected_rules();

-- The related-records reader (0324) also lists the change requests that name an order.
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
      ('dismantle',          'closing_rn_id',         'warehouse'),
      ('change_control',     'procurement_order_id',  'procurement')
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

DO $$
BEGIN
  ALTER FUNCTION change_control_affected_rules() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION change_control_affected_rules() FROM PUBLIC;
  ALTER FUNCTION record_related(text, uuid) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION record_related(text, uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION record_related(text, uuid) TO pmis_app;
  END IF;
END $$;
