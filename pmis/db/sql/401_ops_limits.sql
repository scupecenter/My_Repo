-- 0402: operational limits in Settings (owner decision 35, review item 5, relayed by Main).
--
-- WHY. The session lengths (8 h idle, 12 h absolute), the step-up window (300 s) and the row caps of imports, prefill, exports and the idempotency store were
-- numbers inside the code. A System Admin could not see or change them. They now live in one guarded setting, ops.limits, edited in Settings > Security > Limits.
-- Every default is the number the code used before, so nothing changes until an admin changes a value.
--
-- WHAT THIS ADDS. (ops_limit() is granted to pmis_app: the session load query reads it before any actor exists, and it reveals one number.)
--   1. The setting ops.limits (a flat object key -> number; an empty object means "all defaults"), guarded by settings_guarded_keys like 0290.
--   2. ops_limits_catalogue(): key, default, min, max, unit, group. The single list of what can be set.
--   3. ops_limit(p_key): the effective value (stored value when valid, else the legacy stepup_max_age_seconds for the step-up key, else the default). An unknown key is an error.
--   4. ops_limits_public(): effective values and the keys set explicitly, for the API cache (no actor needed: they are limits, not data).
--   5. ops_limits_state(): read door for the Settings page (catalogue, values, version, can_edit).
--   6. admin_set_ops_limits(p_values, p_reason, p_version): the write door. System Admin only, reason of 3+ characters, If-Match, min/max per key, absolute >= idle,
--      one audit row ops_limits_update with before and after. The step-up is enforced by the API (PUT /settings/ops-limits).
--   7. auth_session_create, auth_self_session_ok, sec_log_session_expired and idm_stepup_seconds read ops_limit() instead of a literal. Their other logic is unchanged.
--      Protocol windows (the 1 and 6 minute sign-in proofs) stay in code: they are part of the sign-in protocol, not a policy.
SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('ops.limits', '{}'::jsonb, 'Owner decision 35 (0402): operational limits. Empty = every default. Changed only through admin_set_ops_limits.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_ops_limits ON settings;
DROP TRIGGER IF EXISTS b_settings_ops_limits_update ON settings;
DROP TRIGGER IF EXISTS b_settings_ops_limits_delete ON settings;
CREATE TRIGGER b_settings_ops_limits BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'ops.limits') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_ops_limits_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'ops.limits' OR NEW.key = 'ops.limits') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_ops_limits_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'ops.limits') EXECUTE FUNCTION settings_guarded_keys();

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
    jsonb_build_object('key', 'idempotency.max_entries',   'group', 'exports',  'unit', 'entries', 'default', 5000,   'min', 500,  'max', 100000))
$$;

-- Stored values that are whole numbers inside the range; anything else is ignored (reads as default).
CREATE OR REPLACE FUNCTION ops_limits_stored() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; c jsonb; out jsonb := '{}'::jsonb; n numeric;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'ops.limits';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(public.ops_limits_catalogue()) LOOP
    IF jsonb_typeof(v -> (c ->> 'key')) = 'number' THEN
      n := (v ->> (c ->> 'key'))::numeric;
      IF n = trunc(n) AND n BETWEEN (c ->> 'min')::numeric AND (c ->> 'max')::numeric THEN out := out || jsonb_build_object(c ->> 'key', n::int); END IF;
    END IF;
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION ops_limits_effective() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE st jsonb := public.ops_limits_stored(); c jsonb; out jsonb := '{}'::jsonb; legacy numeric; val int;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(public.ops_limits_catalogue()) LOOP
    val := NULL;
    IF st ? (c ->> 'key') THEN val := (st ->> (c ->> 'key'))::int;
    ELSIF c ->> 'key' = 'stepup.seconds' THEN
      -- the setting that existed before 0402 stays honoured until an admin sets the new one
      SELECT CASE WHEN jsonb_typeof(s.value) = 'number' THEN (s.value #>> '{}')::numeric END INTO legacy FROM public.settings s WHERE s.key = 'stepup_max_age_seconds';
      IF legacy BETWEEN 30 AND 3600 THEN val := round(legacy)::int; END IF;
    END IF;
    out := out || jsonb_build_object(c ->> 'key', coalesce(val, (c ->> 'default')::int));
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION ops_limit(p_key text) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e jsonb := public.ops_limits_effective();
BEGIN
  IF p_key IS NULL OR NOT (e ? p_key) THEN RAISE EXCEPTION 'unknown limit key' USING ERRCODE = 'invalid_parameter_value'; END IF;
  RETURN (e ->> p_key)::int;
END $$;

CREATE OR REPLACE FUNCTION ops_limits_public() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('values', public.ops_limits_effective(), 'explicit', (SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(public.ops_limits_stored()) k))
$$;

CREATE OR REPLACE FUNCTION idm_stepup_seconds() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT public.ops_limit('stepup.seconds') $$;

CREATE OR REPLACE FUNCTION ops_limits_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; e jsonb := public.ops_limits_effective(); st jsonb := public.ops_limits_stored();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'ops.limits';
  RETURN jsonb_build_object(
    'items', (SELECT jsonb_agg(c || jsonb_build_object('value', e -> (c ->> 'key'), 'is_default', NOT (st ? (c ->> 'key')))) FROM jsonb_array_elements(public.ops_limits_catalogue()) c),
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('ops.limits'),
    'can_edit', coalesce(public.app_actor_is_system_admin(), false));
END $$;

-- p_values: an object of key -> whole number. A key that is not given is reset to its default.
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

CREATE OR REPLACE FUNCTION public.auth_session_create(p_user uuid, p_token_hash text, p_method "AuthMethod", p_csrf text, p_ip inet, p_user_agent text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE sid uuid; two boolean := false; pass_id uuid; pass_via text;
BEGIN
  IF coalesce(public.app_ctx_user()::text, '') <> p_user::text THEN
    RAISE EXCEPTION 'session must be created for the signing-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_csrf IS NULL OR length(p_csrf) < 32 THEN
    RAISE EXCEPTION 'invalid session token' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deleted_at IS NULL AND NOT u.is_break_glass
                 AND u.status IN ('active', 'pending_assignment')) THEN
    RAISE EXCEPTION 'account may not sign in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_method = 'local' THEN
    two := EXISTS (SELECT 1 FROM public.user_totp t WHERE t.user_id = p_user AND t.required);
    IF NOT two THEN
      -- 0292: when the new-device step applies, a pass of the last minute is needed (one use). A pass made by a code already carries its own password check.
      IF public.new_device_applies(p_user) THEN
        UPDATE public.auth_device_pass SET used_at = now()
         WHERE id = (SELECT p.id FROM public.auth_device_pass p WHERE p.user_id = p_user AND p.used_at IS NULL AND p.created_at > now() - interval '1 minute'
                      ORDER BY p.created_at DESC LIMIT 1 FOR UPDATE)
        RETURNING id, via INTO pass_id, pass_via;
        IF pass_id IS NULL THEN
          RAISE EXCEPTION 'no recent new-device check' USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
      IF pass_via IS DISTINCT FROM 'code' THEN
        IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled
                       AND (c.locked_until IS NULL OR c.locked_until <= now())
                       AND c.last_success_at > now() - interval '1 minute') THEN
          RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
        END IF;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM public.local_credentials c WHERE c.user_id = p_user AND c.enabled AND (c.locked_until IS NULL OR c.locked_until <= now())) THEN
          RAISE EXCEPTION 'no recent successful sign-in' USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.local_credentials c JOIN public.user_totp t ON t.user_id = c.user_id
                     WHERE c.user_id = p_user AND c.enabled AND (c.locked_until IS NULL OR c.locked_until <= now())
                       AND c.last_success_at > now() - interval '6 minutes'
                       AND t.required AND t.secret_enc IS NOT NULL
                       AND t.last_success_at > now() - interval '1 minute' AND t.last_success_at >= c.last_success_at)
         OR NOT EXISTS (SELECT 1 FROM public.auth_pending p WHERE p.user_id = p_user AND p.used_at > now() - interval '1 minute') THEN
        RAISE EXCEPTION 'no recent successful sign-in with a code' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  ELSE
    -- M365 and break-glass sign-in are not built yet; they extend this function with their own proof.
    RAISE EXCEPTION 'sign-in method % not available', p_method USING ERRCODE = 'feature_not_supported';
  END IF;
  INSERT INTO public.user_sessions (token_hash, user_id, auth_method, csrf_token, expires_at, ip, user_agent, two_factor)
  VALUES (p_token_hash, p_user, p_method, p_csrf, now() + make_interval(hours => public.ops_limit('session.absolute_hours')), p_ip, left(p_user_agent, 400), two)
  RETURNING id INTO sid;
  RETURN sid;
END $function$;

CREATE OR REPLACE FUNCTION public.auth_self_session_ok(p_user uuid, p_session uuid, p_need_stepup boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_sessions s
                 WHERE s.id = p_session AND s.user_id = p_user AND s.auth_method = 'local' AND s.revoked_at IS NULL
                   AND s.expires_at > now() AND s.last_activity_at > now() - make_interval(hours => public.ops_limit('session.idle_hours'))
                   AND (NOT p_need_stepup OR s.stepup_at > now() - make_interval(secs => public.idm_stepup_seconds())))
$function$;

CREATE OR REPLACE FUNCTION public.sec_log_session_expired(p_session uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE s public.user_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.user_sessions WHERE id = p_session;
  IF NOT FOUND OR s.revoked_at IS NOT NULL THEN RETURN; END IF;
  IF s.expires_at > now() AND s.last_activity_at > now() - make_interval(hours => public.ops_limit('session.idle_hours')) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pmis.session_expired'), hashtext(p_session::text));
  IF EXISTS (SELECT 1 FROM public.security_log WHERE session_id = p_session AND event = 'session_expired') THEN RETURN; END IF;
  PERFORM public.sec_log_write('session_expired', 'info', s.user_id, NULL,
    jsonb_build_object('limit', CASE WHEN s.expires_at <= now() THEN 'absolute' ELSE 'idle' END), jsonb_build_object('session_id', p_session::text));
END $function$;



DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ops_limits_catalogue()', 'ops_limits_stored()', 'ops_limits_effective()', 'ops_limit(text)', 'ops_limits_public()', 'ops_limits_state()',
                           'admin_set_ops_limits(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  -- idm_stepup_seconds() keeps its owner and grants (CREATE OR REPLACE above); the sign-in functions run as pmis_identity_owner and read the limits
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_identity_owner') THEN
    GRANT EXECUTE ON FUNCTION ops_limit(text) TO pmis_identity_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION ops_limit(text), ops_limits_public(), ops_limits_state(), admin_set_ops_limits(jsonb, text, integer) TO pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('ops_limits_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'ops.limits', 'read', 'ops_limits_state', 'write', 'admin_set_ops_limits', 'check', 'ops_limit', 'audit', jsonb_build_array('ops_limits_update')),
        'Owner decision 35: operational limits in Settings, every default unchanged (migration 0402).');
