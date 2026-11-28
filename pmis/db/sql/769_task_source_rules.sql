-- 0770_task_source_rules (contract 0.15.646): the "order status to task" rules, edited in Settings (automation item 4).
-- Mirror: db/sql/769_task_source_rules.sql (kept byte-identical).
--
-- What already exists (0019, Q43): register_task_sources says which register record is the source of which task. At the submission of a record the first matching
-- source row whose task is still open links the record to the task (reg_link_task), and the final approval of the record gives the task its date and approves it
-- (reg_complete_task). The conditions of a row are data_eq (a field equals a value) and data_in (a field is one of the values). Until now those rows could only be
-- changed by a migration, so an order whose status changes later (for example "Delivered") could not move a linked task.
--
-- This migration adds no workflow logic. It adds the edit door and the read of the same table, so the owner can write the rule "when the order status is X, the record
-- is the source of task T, taking its date from field F" in Settings. A new approved version of the order then goes through the unchanged path: only an OPEN task is
-- linked, an approved task is never reopened or re-dated, and the existing date rules (no future date) apply.
--   1. register_task_sources gets rev (one step per change). Additive. Rows are never deleted: a row is hidden with is_active.
--   2. register_task_sources_json(): the rows, the registers with their fields and the tasks, and the version.
--   3. admin_save_register_task_sources(rows, reason, version): reason, If-Match, audit; checks that the register is active and has a site, the task exists, the date
--      field is a date field of the register, and that every condition names a field of the register.
-- Seeds: nothing is added; the six rows of 0019 stay as they are, so no new rule fires until the owner writes one.
-- The table is already in data_reset_plan() (config, KEEP); no new table.
ALTER TABLE register_task_sources ADD COLUMN IF NOT EXISTS rev integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN register_task_sources.rev IS '0770: one step per change made in Settings (the version for If-Match is the sum of rev and the row count).';

CREATE OR REPLACE FUNCTION register_task_sources_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object(
    'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('register_key', s.register_key, 'task_code', s.task_code, 'date_field', s.date_field, 'data_eq', s.data_eq,
                'data_in', s.data_in, 'sort_order', s.sort_order, 'is_active', s.is_active) ORDER BY s.register_key, s.sort_order, s.task_code), '[]'::jsonb)
             FROM public.register_task_sources s),
    'registers', (SELECT coalesce(jsonb_agg(jsonb_build_object('register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar,
                'fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', f.code, 'label_en', f.label_en, 'label_ar', f.label_ar, 'field_type', f.field_type,
                             'options', CASE WHEN jsonb_typeof(f.options) = 'array' THEN f.options ELSE NULL END) ORDER BY f.sort_order, f.code), '[]'::jsonb)
                           FROM public.register_fields f WHERE f.register_key = d.register_key AND NOT f.derived)) ORDER BY d.sort_order, d.register_key), '[]'::jsonb)
             FROM public.register_definitions d WHERE d.is_active AND d.enabled AND d.site_scoped),
    'tasks', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'name_en', t.name_en, 'name_ar', t.name_ar) ORDER BY t.code), '[]'::jsonb)
              FROM (SELECT DISTINCT ON (td.code) td.code, td.name_en, td.name_ar FROM public.task_definitions td WHERE td.is_active ORDER BY td.code, td.version DESC) t),
    'version', (SELECT coalesce(sum(s.rev), 0)::integer + count(*)::integer FROM public.register_task_sources s),
    'can_edit', (public.app_actor_is_admin('admin.settings', 'edit') AND public.app_actor_region_filter('admin.settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_save_register_task_sources(p_rows jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before jsonb; e jsonb; i int := 0; o public.register_task_sources%ROWTYPE; seen text[] := ARRAY[]::text[]; k text; v jsonb; nxt integer; deq jsonb; din jsonb; ord integer;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 60 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows', 'invalid', 'A list of at most 60 rows.')));
  END IF;
  LOCK TABLE public.register_task_sources IN SHARE ROW EXCLUSIVE MODE;
  before := public.register_task_sources_json();
  IF p_version IS NOT NULL AND p_version <> (before ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    i := i + 1;
    IF jsonb_typeof(e) <> 'object' THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i, 'invalid', 'An object.'))); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = e ->> 'register_key' AND d.is_active AND d.enabled AND d.site_scoped) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/register_key', 'unknown_register', 'An active register with a site.')));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.code = e ->> 'task_code' AND td.is_active) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/task_code', 'unknown_task', 'Not a task of the workflow.')));
    END IF;
    IF (e ->> 'register_key') || '/' || (e ->> 'task_code') = ANY (seen) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i, 'duplicate', 'One row per register and task.')));
    END IF;
    seen := seen || ((e ->> 'register_key') || '/' || (e ->> 'task_code'));
    IF NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = e ->> 'register_key' AND f.code = e ->> 'date_field' AND f.field_type = 'date') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/date_field', 'not_a_date_field', 'A date field of the register.')));
    END IF;
    FOREACH k IN ARRAY ARRAY['data_eq', 'data_in'] LOOP
      IF e ? k THEN
        IF jsonb_typeof(e -> k) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(e -> k)) > 8 THEN
          PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/' || k, 'invalid', 'An object of at most 8 conditions.')));
        END IF;
        FOR v IN SELECT jsonb_build_object('k', x.key, 'v', x.value) FROM jsonb_each(e -> k) x LOOP
          IF NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = e ->> 'register_key' AND f.code = v ->> 'k') THEN
            PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/' || k, 'unknown_field', (v ->> 'k') || ' is not a field of the register.')));
          END IF;
          IF k = 'data_eq' AND jsonb_typeof(v -> 'v') <> 'string' THEN
            PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/data_eq', 'invalid', 'A text value.')));
          END IF;
          IF k = 'data_in' AND (jsonb_typeof(v -> 'v') <> 'array' OR jsonb_array_length(v -> 'v') > 40 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'v') z WHERE jsonb_typeof(z) <> 'string')) THEN
            PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/rows/' || i || '/data_in', 'invalid', 'A list of at most 40 texts.')));
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
  SELECT coalesce(max(sort_order), 0) + 10 INTO nxt FROM public.register_task_sources;
  FOR e IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    SELECT * INTO o FROM public.register_task_sources t WHERE t.register_key = e ->> 'register_key' AND t.task_code = e ->> 'task_code';
    IF FOUND THEN
      deq := CASE WHEN e ? 'data_eq' THEN e -> 'data_eq' ELSE o.data_eq END;
      din := CASE WHEN e ? 'data_in' THEN e -> 'data_in' ELSE o.data_in END;
      UPDATE public.register_task_sources SET date_field = e ->> 'date_field', data_eq = deq, data_in = din, is_active = coalesce((e ->> 'is_active')::boolean, o.is_active), rev = o.rev + 1
       WHERE register_key = o.register_key AND task_code = o.task_code
         AND (date_field, data_eq, data_in, is_active) IS DISTINCT FROM (e ->> 'date_field', deq, din, coalesce((e ->> 'is_active')::boolean, o.is_active));
    ELSE
      ord := coalesce((e ->> 'sort_order')::integer, nxt);
      INSERT INTO public.register_task_sources (register_key, task_code, date_field, data_eq, data_in, sort_order, is_active)
      VALUES (e ->> 'register_key', e ->> 'task_code', e ->> 'date_field', coalesce(e -> 'data_eq', '{}'::jsonb), coalesce(e -> 'data_in', '{}'::jsonb), ord, coalesce((e ->> 'is_active')::boolean, true));
      nxt := nxt + 10;
    END IF;
  END LOOP;
  IF (public.register_task_sources_json() -> 'rows') IS DISTINCT FROM (before -> 'rows') THEN
    PERFORM public.log_audit_write('register_task_sources_update', 'setting', 'register_task_sources', before -> 'rows', public.register_task_sources_json() -> 'rows', p_reason);
  END IF;
  RETURN public.register_task_sources_json();
END $$;

GRANT SELECT, UPDATE, INSERT ON register_task_sources TO pmis_definer;
GRANT SELECT ON register_definitions, register_fields, task_definitions TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['register_task_sources_json()', 'admin_save_register_task_sources(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END IF;
  END LOOP;
END $$;
