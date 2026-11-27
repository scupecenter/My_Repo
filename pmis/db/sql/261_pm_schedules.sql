-- 0261_pm_schedules: recurring preventive-maintenance schedules that create DRAFT records only. Contract 0.15.161.
-- Mirror: db/sql/261_pm_schedules.sql (kept identical to prisma/migrations/0261_pm_schedules/migration.sql).
--
--   A schedule says: "every N weeks / months create a draft record in register R (for site S, with these field values)". Schedules live in the existing
--   settings table under the key 'pm.schedules' (no new table; the version is kept in the value, as for dashboard.goals, 0260). A schedule never creates
--   anything by itself and never approves anything: a person who may create records in that register presses "Create draft" on a due schedule, the API
--   saves the record through the register's own create path (reg_save_record, as that person, so the register's rights, region rules and field rules apply
--   unchanged: a record is an entry draft that goes through the normal review and approval), and then pm_schedule_mark_generated moves the next due date on.
--   Reader pm_schedules_json() = stored schedules + the catalogue of registers + today. Writer admin_save_pm_schedules(config, reason, version): admin.settings
--   edit for all regions, reason, If-Match, one audit row. pmis_app only executes these functions. Additive: nothing is changed or deleted.

CREATE OR REPLACE FUNCTION pm_schedules_catalogue() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'registers', coalesce((SELECT jsonb_agg(jsonb_build_object('key', d.register_key, 'name_en', d.name_en, 'name_ar', coalesce(d.name_ar, d.name_en),
                                                              'site_scoped', d.site_scoped) ORDER BY d.sort_order)
                           FROM public.register_definitions d WHERE d.is_active AND d.enabled), '[]'::jsonb),
    'units', '["week","month"]'::jsonb)
$$;

CREATE OR REPLACE FUNCTION pm_schedules_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'version', coalesce((SELECT (s.value ->> 'version')::int FROM public.settings s WHERE s.key = 'pm.schedules'), 0),
    'schedules', coalesce((SELECT s.value -> 'schedules' FROM public.settings s WHERE s.key = 'pm.schedules'), '[]'::jsonb),
    'updated_at', (SELECT s.updated_at FROM public.settings s WHERE s.key = 'pm.schedules'),
    'updated_by', (SELECT s.updated_by FROM public.settings s WHERE s.key = 'pm.schedules'),
    'today', public.cal_today(),
    'catalogue', public.pm_schedules_catalogue())
$$;

CREATE OR REPLACE FUNCTION admin_save_pm_schedules(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cur jsonb; before jsonb; after jsonb; cat jsonb := public.pm_schedules_catalogue(); errs jsonb := '[]'::jsonb; g jsonb; i int := 0; v int;
  ids text[] := ARRAY[]::text[]; k text; out jsonb := '[]'::jsonb; old jsonb; reg jsonb; p text;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
    VALUES ('pm.schedules', '{"version":0,"schedules":[]}'::jsonb, 'Recurring preventive-maintenance schedules that create drafts (migration 0261).', NULL, now()) ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'pm.schedules' FOR UPDATE;
  cur := public.pm_schedules_json();
  v := (cur ->> 'version')::int;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' OR jsonb_typeof(p_config -> 'schedules') IS DISTINCT FROM 'array' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/schedules', 'required', 'A list of schedules is required.')));
  END IF;
  IF jsonb_array_length(p_config -> 'schedules') > 100 THEN errs := errs || public.reg_err_item('/schedules', 'too_many', 'At most 100 schedules.'); END IF;
  FOR g IN SELECT e FROM jsonb_array_elements(p_config -> 'schedules') e LOOP
    i := i + 1; p := '/schedules/' || i;
    IF jsonb_typeof(g) <> 'object' THEN errs := errs || public.reg_err_item(p, 'invalid', 'An object.'); CONTINUE; END IF;
    FOR k IN SELECT jsonb_object_keys(g) LOOP
      IF k NOT IN ('id', 'name_en', 'name_ar', 'register_key', 'site_id', 'record_type', 'data', 'every', 'unit', 'next_due', 'active') THEN errs := errs || public.reg_err_item(p || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
    END LOOP;
    IF coalesce(g ->> 'id', '') !~ '^[a-z0-9-]{3,40}$' THEN errs := errs || public.reg_err_item(p || '/id', 'invalid', '3 to 40 characters: a-z, 0-9, hyphen.');
    ELSIF g ->> 'id' = ANY (ids) THEN errs := errs || public.reg_err_item(p || '/id', 'duplicate', 'Used twice.');
    ELSE ids := ids || (g ->> 'id'); END IF;
    IF jsonb_typeof(g -> 'name_en') IS DISTINCT FROM 'string' OR length(btrim(g ->> 'name_en')) NOT BETWEEN 1 AND 120 THEN errs := errs || public.reg_err_item(p || '/name_en', 'invalid', '1 to 120 characters.'); END IF;
    IF g ? 'name_ar' AND jsonb_typeof(g -> 'name_ar') NOT IN ('null', 'string') OR length(coalesce(g ->> 'name_ar', '')) > 120 THEN errs := errs || public.reg_err_item(p || '/name_ar', 'invalid', 'At most 120 characters.'); END IF;
    SELECT r INTO reg FROM jsonb_array_elements(cat -> 'registers') r WHERE r ->> 'key' = g ->> 'register_key';
    IF reg IS NULL THEN errs := errs || public.reg_err_item(p || '/register_key', 'unknown_register', 'Not an active register.');
    ELSIF (reg ->> 'site_scoped')::boolean AND coalesce(g ->> 'site_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN errs := errs || public.reg_err_item(p || '/site_id', 'required', 'This register needs a site.');
    END IF;
    reg := NULL;
    IF coalesce(g ->> 'site_id', '') <> '' AND NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id::text = g ->> 'site_id') THEN errs := errs || public.reg_err_item(p || '/site_id', 'unknown_site', 'Not a site.'); END IF;
    IF g ? 'record_type' AND jsonb_typeof(g -> 'record_type') NOT IN ('null', 'string') OR length(coalesce(g ->> 'record_type', '')) > 40 THEN errs := errs || public.reg_err_item(p || '/record_type', 'invalid', 'At most 40 characters.'); END IF;
    IF jsonb_typeof(g -> 'data') IS DISTINCT FROM 'object' OR length((g -> 'data')::text) > 4000 THEN errs := errs || public.reg_err_item(p || '/data', 'invalid', 'An object of field values, at most 4000 characters.'); END IF;
    IF jsonb_typeof(g -> 'every') IS DISTINCT FROM 'number' OR (g ->> 'every')::numeric < 1 OR (g ->> 'every')::numeric > 52 OR (g ->> 'every')::numeric <> trunc((g ->> 'every')::numeric) THEN errs := errs || public.reg_err_item(p || '/every', 'invalid', 'A whole number from 1 to 52.'); END IF;
    IF coalesce(g ->> 'unit', '') NOT IN ('week', 'month') THEN errs := errs || public.reg_err_item(p || '/unit', 'invalid', 'week or month.'); END IF;
    IF coalesce(g ->> 'next_due', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN errs := errs || public.reg_err_item(p || '/next_due', 'invalid', 'A date, YYYY-MM-DD.');
    ELSE BEGIN PERFORM (g ->> 'next_due')::date; EXCEPTION WHEN others THEN errs := errs || public.reg_err_item(p || '/next_due', 'invalid', 'Not a date.'); END; END IF;
    IF g ? 'active' AND jsonb_typeof(g -> 'active') <> 'boolean' THEN errs := errs || public.reg_err_item(p || '/active', 'invalid', 'true or false.'); END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  -- the run history of a schedule is kept by the database, never typed
  FOR g IN SELECT e FROM jsonb_array_elements(p_config -> 'schedules') e LOOP
    SELECT o INTO old FROM jsonb_array_elements(cur -> 'schedules') o WHERE o ->> 'id' = g ->> 'id';
    out := out || ((g - 'site_id' - 'record_type') || CASE WHEN coalesce(g ->> 'site_id', '') <> '' THEN jsonb_build_object('site_id', g ->> 'site_id') ELSE '{}'::jsonb END
                                                    || CASE WHEN coalesce(g ->> 'record_type', '') <> '' THEN jsonb_build_object('record_type', g ->> 'record_type') ELSE '{}'::jsonb END
                                                    || CASE WHEN old IS NOT NULL THEN coalesce(old - 'id' - 'name_en' - 'name_ar' - 'register_key' - 'site_id' - 'record_type' - 'data' - 'every' - 'unit' - 'next_due' - 'active', '{}'::jsonb) ELSE '{}'::jsonb END);
    old := NULL;
  END LOOP;
  before := cur - 'catalogue' - 'updated_at' - 'updated_by' - 'today';
  UPDATE public.settings SET value = jsonb_build_object('version', v + 1, 'schedules', out), updated_by = public.app_actor(), updated_at = now() WHERE key = 'pm.schedules';
  after := public.pm_schedules_json();
  PERFORM public.log_audit_write('pm_schedules_update', 'setting', 'pm.schedules', before, after - 'catalogue' - 'updated_at' - 'updated_by' - 'today', btrim(p_reason));
  RETURN after;
END $$;

-- Called by the API right after the register saved the draft as the caller. Moves the next due date past today in steps of the schedule (one draft per press,
-- never a backlog), remembers the record. Only the stored schedule changes; no record, right or approval is touched.
CREATE OR REPLACE FUNCTION pm_schedule_mark_generated(p_id text, p_record uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cur jsonb; sched jsonb; nxt date; step interval; today date := public.cal_today(); out jsonb := '[]'::jsonb; e jsonb; after jsonb; before jsonb;
BEGIN
  PERFORM 1 FROM public.settings WHERE key = 'pm.schedules' FOR UPDATE;
  cur := public.pm_schedules_json();
  SELECT o INTO sched FROM jsonb_array_elements(cur -> 'schedules') o WHERE o ->> 'id' = p_id;
  IF sched IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  step := CASE sched ->> 'unit' WHEN 'week' THEN make_interval(weeks => (sched ->> 'every')::int) ELSE make_interval(months => (sched ->> 'every')::int) END;
  nxt := (sched ->> 'next_due')::date;
  WHILE nxt <= today LOOP nxt := (nxt + step)::date; END LOOP;
  FOR e IN SELECT x FROM jsonb_array_elements(cur -> 'schedules') x LOOP
    IF e ->> 'id' = p_id THEN
      e := e || jsonb_build_object('next_due', nxt, 'last_generated_at', now(), 'last_record_id', p_record);
    END IF;
    out := out || e;
  END LOOP;
  before := cur - 'catalogue' - 'updated_at' - 'updated_by' - 'today';
  UPDATE public.settings SET value = jsonb_build_object('version', (cur ->> 'version')::int + 1, 'schedules', out), updated_by = public.app_actor(), updated_at = now() WHERE key = 'pm.schedules';
  after := public.pm_schedules_json();
  PERFORM public.log_audit_write('pm_schedule_generated', 'setting', 'pm.schedules', before, after - 'catalogue' - 'updated_at' - 'updated_by' - 'today', 'draft ' || p_record::text);
  RETURN after;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['pm_schedules_catalogue()', 'pm_schedules_json()', 'admin_save_pm_schedules(jsonb,text,integer)', 'pm_schedule_mark_generated(text,uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['pm_schedules_json()', 'admin_save_pm_schedules(jsonb,text,integer)', 'pm_schedule_mark_generated(text,uuid)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
