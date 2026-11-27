-- 0563: the sign-in rate-limit numbers in Settings > Security > Limits (follow-up of 0402, relayed by Main).
--
-- WHY. How many failed sign-ins one address may make before the wait starts (10), the window they are counted over (15 minutes), the first and longest wait (2 s and 60 s)
-- and how many attempts one account may make (5) were numbers inside auth.service.ts. A System Admin could not see or change them. They join the 0402 catalogue.
-- Every default is the number the code used before, so nothing changes until an admin changes a value.
--
-- WHAT THIS CHANGES. Only ops_limits_catalogue() (five new keys, group sessions) and admin_set_ops_limits() (one new rule: the longest wait cannot be shorter than the first wait).
-- Reading, audit (ops_limits_update), If-Match, the reason and the System Admin rule are the 0402 ones. Additive: no table, no column, no grant changes.
SELECT set_config('app.region_ids', '*', true);

CREATE OR REPLACE FUNCTION ops_limits_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('key', 'session.idle_hours',        'group', 'sessions', 'unit', 'hours',   'default', 8,      'min', 1,   'max', 24),
    jsonb_build_object('key', 'session.absolute_hours',    'group', 'sessions', 'unit', 'hours',   'default', 12,     'min', 1,   'max', 72),
    jsonb_build_object('key', 'stepup.seconds',            'group', 'sessions', 'unit', 'seconds', 'default', 300,    'min', 30,  'max', 3600),
    jsonb_build_object('key', 'assignments.max_rows',      'group', 'rows',     'unit', 'rows',    'default', 2000,   'min', 100, 'max', 50000),
    jsonb_build_object('key', 'import.max_rows',           'group', 'rows',     'unit', 'rows',    'default', 2000,   'min', 100, 'max', 50000),
    jsonb_build_object('key', 'master_import.max_rows',    'group', 'rows',     'unit', 'rows',    'default', 5000,   'min', 100, 'max', 50000),
    jsonb_build_object('key', 'register_import.max_rows',  'group', 'rows',     'unit', 'rows',    'default', 5000,   'min', 100, 'max', 50000),
    jsonb_build_object('key', 'prefill.max_rows',          'group', 'rows',     'unit', 'rows',    'default', 5000,   'min', 100, 'max', 50000),
    jsonb_build_object('key', 'prefill.max_sites',         'group', 'rows',     'unit', 'sites',   'default', 5000,   'min', 100, 'max', 50000),
    jsonb_build_object('key', 'export.max_rows',           'group', 'exports',  'unit', 'rows',    'default', 100000, 'min', 1000, 'max', 1000000),
    jsonb_build_object('key', 'idempotency.max_entries',   'group', 'exports',  'unit', 'entries', 'default', 5000,   'min', 500,  'max', 100000),
    jsonb_build_object('key', 'login.ip_attempts', 'group', 'sessions', 'unit', 'attempts', 'default', 10, 'min', 3, 'max', 100),
    jsonb_build_object('key', 'login.ip_window_seconds', 'group', 'sessions', 'unit', 'seconds', 'default', 900, 'min', 60, 'max', 86400),
    jsonb_build_object('key', 'login.ip_base_seconds', 'group', 'sessions', 'unit', 'seconds', 'default', 2, 'min', 1, 'max', 60),
    jsonb_build_object('key', 'login.ip_max_seconds', 'group', 'sessions', 'unit', 'seconds', 'default', 60, 'min', 5, 'max', 3600),
    jsonb_build_object('key', 'login.identifier_attempts', 'group', 'sessions', 'unit', 'attempts', 'default', 5, 'min', 3, 'max', 50))
$$;

CREATE OR REPLACE FUNCTION admin_set_ops_limits(p_values jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; c jsonb; k text; n numeric; clean jsonb := '{}'::jsonb; before jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin changes the operational limits.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN PERFORM public.wfe_err1('/values', 'required', 'Send the limits as an object.'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_values) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.ops_limits_catalogue()) x WHERE x ->> 'key' = k) THEN
      PERFORM public.wfe_err1('/values/' || k, 'unknown', 'This limit does not exist.');
    END IF;
  END LOOP;
  FOR c IN SELECT * FROM jsonb_array_elements(public.ops_limits_catalogue()) LOOP
    k := c ->> 'key';
    IF NOT (p_values ? k) THEN CONTINUE; END IF;
    IF jsonb_typeof(p_values -> k) <> 'number' OR (p_values ->> k)::numeric <> trunc((p_values ->> k)::numeric) THEN
      PERFORM public.wfe_err1('/values/' || k, 'invalid', 'Use a whole number.');
    END IF;
    n := (p_values ->> k)::numeric;
    IF n < (c ->> 'min')::numeric OR n > (c ->> 'max')::numeric THEN
      PERFORM public.wfe_err1('/values/' || k, 'out_of_range', format('Use a value from %s to %s.', c ->> 'min', c ->> 'max'));
    END IF;
    clean := clean || jsonb_build_object(k, n::int);
  END LOOP;
  -- a key that is not given reads as its default, so compare the values that will be in force
  IF coalesce((clean ->> 'session.absolute_hours')::int, 12) < coalesce((clean ->> 'session.idle_hours')::int, 8) THEN
    PERFORM public.wfe_err1('/values/session.absolute_hours', 'invalid', 'The absolute session length cannot be shorter than the idle limit.');
  END IF;
  IF coalesce((clean ->> 'login.ip_max_seconds')::int, 60) < coalesce((clean ->> 'login.ip_base_seconds')::int, 2) THEN
    PERFORM public.wfe_err1('/values/login.ip_max_seconds', 'invalid', 'The longest wait cannot be shorter than the first wait.');
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('ops.limits', '{}'::jsonb, 'Owner decision 35 (0402): operational limits. Empty = every default. Changed only through admin_set_ops_limits.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'ops.limits' FOR UPDATE;
  cur := public.ops_limits_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  before := public.ops_limits_stored();
  IF before = clean THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the limits in force.'));
  END IF;
  UPDATE public.settings SET value = clean, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'ops.limits';
  res := public.ops_limits_state();
  PERFORM public.log_audit_write('ops_limits_update', 'setting', 'ops.limits', before, clean, btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ops_limits_catalogue()', 'admin_set_ops_limits(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
  END LOOP;
END $$;
