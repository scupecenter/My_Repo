-- 0251: Scheduled recurring Master export (contract 0.15.99, item 8). Additive: one settings key and five functions, no new table.
-- A person saves a schedule (daily, weekly on a weekday, or monthly on a day 1 to 28) for a Master export (the whole Master or chosen parts).
-- No job ever runs as the person. When the owner next opens Exports, the API starts every due schedule of the owner in the owner's own request, with the
-- owner's own session and region rules, through the same POST /exports/master path (all its grant checks apply at that moment). The file then appears in
-- the owner's exports list like any export. A schedule that cannot start (a grant was lost, a part was removed) records the error and moves on.
-- The items live in the settings key master_export.schedules; the functions only ever show and change the caller's own items.

INSERT INTO settings (key, value, description, updated_at)
VALUES ('master_export.schedules', '{"items": []}'::jsonb, 'Scheduled Master exports (0251): the schedules of every owner; changed only through export_schedule_* (own items only).', now())
ON CONFLICT (key) DO NOTHING;

-- The first instant after p_after that the schedule's day starts, in the project time zone (calc.timezone, default Africa/Tripoli).
CREATE OR REPLACE FUNCTION export_schedule_next(p_item jsonb, p_after timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE tz text := coalesce(public.calc_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli'); d date := (p_after AT TIME ZONE tz)::date; i int;
BEGIN
  IF p_item ->> 'cadence' = 'daily' THEN
    d := d + 1;
  ELSIF p_item ->> 'cadence' = 'weekly' THEN
    FOR i IN 1..7 LOOP d := d + 1; EXIT WHEN extract(dow FROM d)::int = (p_item ->> 'weekday')::int; END LOOP;
  ELSE
    FOR i IN 1..35 LOOP d := d + 1; EXIT WHEN extract(day FROM d)::int = (p_item ->> 'day_of_month')::int; END LOOP;
  END IF;
  RETURN (d::timestamp) AT TIME ZONE tz;
END $$;

CREATE OR REPLACE FUNCTION export_schedules_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE me uuid := public.app_actor();
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(x - 'owner_id' || jsonb_build_object(
      'next_due_at', public.export_schedule_next(x, coalesce((x ->> 'last_started_at')::timestamptz, (x ->> 'created_at')::timestamptz)),
      'due', (x ->> 'enabled')::boolean AND now() >= public.export_schedule_next(x, coalesce((x ->> 'last_started_at')::timestamptz, (x ->> 'created_at')::timestamptz)))
      ORDER BY x ->> 'created_at')
    FROM public.settings s, jsonb_array_elements(s.value -> 'items') x WHERE s.key = 'master_export.schedules' AND x ->> 'owner_id' = me::text), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION export_schedule_save(p_item jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE me uuid := public.app_actor(); k text; id uuid; old jsonb; nw jsonb; items jsonb; nm text; cad text; spec jsonb; n int;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_item) LOOP
    IF k NOT IN ('id', 'name', 'cadence', 'weekday', 'day_of_month', 'spec', 'enabled') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/' || left(k, 40), 'unknown_key', 'Unknown key.')));
    END IF;
  END LOOP;
  nm := btrim(coalesce(p_item ->> 'name', ''));
  IF char_length(nm) < 1 OR char_length(nm) > 80 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/name', 'invalid', 'A name of 1 to 80 characters.')));
  END IF;
  cad := p_item ->> 'cadence';
  IF cad IS NULL OR cad NOT IN ('daily', 'weekly', 'monthly') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/cadence', 'invalid', 'daily, weekly or monthly.')));
  END IF;
  IF cad = 'weekly' AND (jsonb_typeof(p_item -> 'weekday') IS DISTINCT FROM 'number' OR (p_item ->> 'weekday') !~ '^[0-6]$') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/weekday', 'invalid', 'A weekday from 0 (Sunday) to 6.')));
  END IF;
  IF cad = 'monthly' AND (jsonb_typeof(p_item -> 'day_of_month') IS DISTINCT FROM 'number' OR (p_item ->> 'day_of_month') !~ '^([1-9]|1[0-9]|2[0-8])$') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/day_of_month', 'invalid', 'A day of the month from 1 to 28.')));
  END IF;
  spec := coalesce(p_item -> 'spec', '{}'::jsonb);
  IF jsonb_typeof(spec) <> 'object' OR length(spec::text) > 4000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/spec', 'invalid', 'An object with parts and regions.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(spec) LOOP
    IF k NOT IN ('parts', 'regions') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/spec/' || left(k, 40), 'unknown_key', 'Only parts and regions can be scheduled.')));
    END IF;
  END LOOP;
  IF p_item ? 'enabled' AND jsonb_typeof(p_item -> 'enabled') <> 'boolean' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/enabled', 'invalid', 'true or false.')));
  END IF;
  PERFORM 1 FROM public.settings WHERE key = 'master_export.schedules' FOR UPDATE;
  SELECT value -> 'items' INTO items FROM public.settings WHERE key = 'master_export.schedules';
  items := coalesce(items, '[]'::jsonb);
  IF p_item ->> 'id' IS NOT NULL THEN
    IF (p_item ->> 'id') !~ '^[0-9a-fA-F-]{36}$' THEN PERFORM public.wf_err('not_found'); END IF;
    id := (p_item ->> 'id')::uuid;
    SELECT x INTO old FROM jsonb_array_elements(items) x WHERE x ->> 'id' = id::text AND x ->> 'owner_id' = me::text;
    IF old IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  ELSE
    SELECT count(*) INTO n FROM jsonb_array_elements(items) x WHERE x ->> 'owner_id' = me::text;
    IF n >= 5 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'limit', 'At most 5 scheduled exports each.'))); END IF;
    id := gen_random_uuid();
  END IF;
  nw := jsonb_build_object('id', id, 'owner_id', me, 'name', nm, 'cadence', cad, 'spec', spec, 'enabled', coalesce((p_item ->> 'enabled')::boolean, true),
    'created_at', coalesce(old ->> 'created_at', clock_timestamp()::text), 'last_started_at', old -> 'last_started_at', 'last_job_id', old -> 'last_job_id', 'last_error', NULL::text)
    || CASE WHEN cad = 'weekly' THEN jsonb_build_object('weekday', (p_item ->> 'weekday')::int) ELSE '{}'::jsonb END
    || CASE WHEN cad = 'monthly' THEN jsonb_build_object('day_of_month', (p_item ->> 'day_of_month')::int) ELSE '{}'::jsonb END;
  UPDATE public.settings SET value = jsonb_build_object('items',
      coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(items) x WHERE x ->> 'id' <> id::text), '[]'::jsonb) || jsonb_build_array(nw)),
    updated_by = me, updated_at = clock_timestamp() WHERE key = 'master_export.schedules';
  PERFORM public.log_audit_write('export_schedule_save', 'export_schedule', id::text, old - 'owner_id', nw - 'owner_id', NULL);
  RETURN public.export_schedules_json();
END $$;

CREATE OR REPLACE FUNCTION export_schedule_delete(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE me uuid := public.app_actor(); old jsonb;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM 1 FROM public.settings WHERE key = 'master_export.schedules' FOR UPDATE;
  SELECT x INTO old FROM public.settings s, jsonb_array_elements(s.value -> 'items') x WHERE s.key = 'master_export.schedules' AND x ->> 'id' = p_id::text AND x ->> 'owner_id' = me::text;
  IF old IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  UPDATE public.settings SET value = jsonb_build_object('items', coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(value -> 'items') x WHERE x ->> 'id' <> p_id::text), '[]'::jsonb)),
    updated_by = me, updated_at = clock_timestamp() WHERE key = 'master_export.schedules';
  PERFORM public.log_audit_write('export_schedule_delete', 'export_schedule', p_id::text, old - 'owner_id', NULL, NULL);
  RETURN public.export_schedules_json();
END $$;

-- The API calls this after it tried to start a due schedule: the job id (or the error) is recorded and the next due instant moves on.
CREATE OR REPLACE FUNCTION export_schedule_mark(p_id uuid, p_job uuid, p_error text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE me uuid := public.app_actor();
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM 1 FROM public.settings WHERE key = 'master_export.schedules' FOR UPDATE;
  UPDATE public.settings SET value = jsonb_build_object('items', (SELECT coalesce(jsonb_agg(
      CASE WHEN x ->> 'id' = p_id::text AND x ->> 'owner_id' = me::text
           THEN x || jsonb_build_object('last_started_at', clock_timestamp()::text, 'last_job_id', p_job, 'last_error', left(p_error, 300)) ELSE x END), '[]'::jsonb)
      FROM jsonb_array_elements(value -> 'items') x)),
    updated_by = me, updated_at = clock_timestamp() WHERE key = 'master_export.schedules';
END $$;

DROP TRIGGER IF EXISTS b_settings_export_schedules ON settings;
DROP TRIGGER IF EXISTS b_settings_export_schedules_update ON settings;
DROP TRIGGER IF EXISTS b_settings_export_schedules_delete ON settings;
CREATE TRIGGER b_settings_export_schedules BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'master_export.schedules') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_export_schedules_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'master_export.schedules' OR NEW.key = 'master_export.schedules') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_export_schedules_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'master_export.schedules') EXECUTE FUNCTION settings_guarded_keys();

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['export_schedules_json()', 'export_schedule_save(jsonb)', 'export_schedule_delete(uuid)', 'export_schedule_mark(uuid,uuid,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION export_schedules_json(), export_schedule_save(jsonb), export_schedule_delete(uuid), export_schedule_mark(uuid, uuid, text) TO pmis_app;
  END IF;
END $$;
