-- 0760 (contract 0.15.640): the Settings screen of the expiry radar (0360). Additive: two functions, no table, no data change.
--
-- WHAT. The expiry radar already writes the notices (expiry_radar_notify, the setting `expiry.radar`). Its lead times could only be changed in the database. This adds the
-- two doors of a Settings screen: expiry_radar_json() reads the setting with the names of the registers and the date fields that can be chosen; admin_set_expiry_radar() saves it.
-- RIGHTS. Read: System Admin or a delegate of admin.settings (view or edit). Save: edit on admin.settings for every region, with a reason, If-Match and an audit row (before and after).
-- CHECKS. A register must exist and be active and enabled; the field must be an active, typed date field of it; 1 to 6 different lead times of 1 to 365 days; at most 40 registers.
-- The notice job, the recipients (the Matrix holders of the record's region) and the mail kind are unchanged and are not set here.

CREATE OR REPLACE FUNCTION expiry_radar_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; regs jsonb; cands jsonb;
BEGIN
  IF NOT (public.app_actor_is_admin('admin.settings', 'view') OR public.app_actor_is_admin('admin.settings', 'edit')) THEN
    RAISE EXCEPTION 'expiry radar: System Admin or a delegation covering admin.settings required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'expiry.radar';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'register_key', e.key, 'name_en', d.name_en, 'name_ar', d.name_ar, 'field', e.value ->> 'field',
           'field_label_en', f.label_en, 'field_label_ar', f.label_ar,
           'lead_days', (SELECT coalesce(jsonb_agg(x::integer ORDER BY x::integer), '[]'::jsonb) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value -> 'lead_days') = 'array' THEN e.value -> 'lead_days' ELSE '[]'::jsonb END) x WHERE x ~ '^[0-9]{1,3}$'))
         ORDER BY d.sort_order, e.key), '[]'::jsonb)
    INTO regs
    FROM jsonb_each(CASE WHEN jsonb_typeof(s.value -> 'registers') = 'object' THEN s.value -> 'registers' ELSE '{}'::jsonb END) e
    LEFT JOIN public.register_definitions d ON d.register_key = e.key
    LEFT JOIN public.register_fields f ON f.register_key = e.key AND f.code = e.value ->> 'field'
   WHERE jsonb_typeof(e.value) = 'object';
  SELECT coalesce(jsonb_agg(jsonb_build_object('register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar,
           'fields', (SELECT jsonb_agg(jsonb_build_object('code', f.code, 'label_en', f.label_en, 'label_ar', f.label_ar) ORDER BY f.sort_order, f.code)
                        FROM public.register_fields f WHERE f.register_key = d.register_key AND f.is_active AND f.field_type = 'date'))
         ORDER BY d.sort_order, d.register_key), '[]'::jsonb)
    INTO cands
    FROM public.register_definitions d
   WHERE d.is_active AND d.enabled
     AND EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = d.register_key AND f.is_active AND f.field_type = 'date');
  RETURN jsonb_build_object(
    'enabled', coalesce(CASE WHEN jsonb_typeof(s.value -> 'enabled') = 'boolean' THEN (s.value ->> 'enabled')::boolean END, true),
    'version', coalesce((s.value ->> 'version')::integer, 0),
    'registers', regs, 'candidates', cands)
    || CASE WHEN s.key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_at', s.updated_at) END
    || CASE WHEN s.updated_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_by', public.wfe_user_ref(s.updated_by)) END;
END $$;

-- PUT /settings/expiry-radar. p_body = {enabled, registers: [{register_key, field, lead_days: [int]}]} (closed); the reason apart; p_version = If-Match (NULL = *).
CREATE OR REPLACE FUNCTION admin_set_expiry_radar(p_body jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; k text; i integer := 0; r jsonb; rk text; fld text; leads jsonb; l jsonb; seen text[] := ARRAY[]::text[];
  newregs jsonb := '{}'::jsonb; iv integer; res jsonb; lead_n integer; lead_seen integer[];
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM 1 FROM public.settings WHERE key = 'expiry.radar' FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.settings (key, value, description, updated_at)
    VALUES ('expiry.radar', '{"enabled": true, "version": 0, "registers": {}}'::jsonb, 'A3: expiry radar (migration 0360); edited on the Settings screen (migration 0760).', now())
    ON CONFLICT (key) DO NOTHING;
    PERFORM 1 FROM public.settings WHERE key = 'expiry.radar' FOR UPDATE;
  END IF;
  cur := public.expiry_radar_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with enabled and registers.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('enabled', 'registers') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_body -> 'enabled') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/enabled', 'required', 'true or false.'); END IF;
  IF jsonb_typeof(p_body -> 'registers') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/registers', 'required', 'A list of registers.');
  ELSIF jsonb_array_length(p_body -> 'registers') > 40 THEN
    errs := errs || public.reg_err_item('/registers', 'too_many', 'At most 40 registers.');
  ELSE
    FOR r IN SELECT x FROM jsonb_array_elements(p_body -> 'registers') x LOOP
      IF jsonb_typeof(r) <> 'object' THEN errs := errs || public.reg_err_item('/registers/' || i, 'invalid', 'An object.'); i := i + 1; CONTINUE; END IF;
      FOR k IN SELECT jsonb_object_keys(r) LOOP
        IF k NOT IN ('register_key', 'field', 'lead_days') THEN errs := errs || public.reg_err_item('/registers/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      rk := r ->> 'register_key'; fld := r ->> 'field'; leads := r -> 'lead_days';
      IF rk IS NULL OR NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = rk AND d.is_active AND d.enabled) THEN
        errs := errs || public.reg_err_item('/registers/' || i || '/register_key', 'invalid', 'An active, enabled register.');
      ELSIF rk = ANY (seen) THEN
        errs := errs || public.reg_err_item('/registers/' || i || '/register_key', 'duplicate', 'Each register once.');
      ELSIF fld IS NULL OR NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = rk AND f.code = fld AND f.is_active AND f.field_type = 'date') THEN
        errs := errs || public.reg_err_item('/registers/' || i || '/field', 'invalid', 'An active date field of the register.');
      END IF;
      IF rk IS NOT NULL THEN seen := seen || rk; END IF;
      IF jsonb_typeof(leads) IS DISTINCT FROM 'array' OR jsonb_array_length(leads) NOT BETWEEN 1 AND 6 THEN
        errs := errs || public.reg_err_item('/registers/' || i || '/lead_days', 'invalid', 'From 1 to 6 lead times.');
      ELSE
        lead_seen := ARRAY[]::integer[];
        FOR l IN SELECT x FROM jsonb_array_elements(leads) x LOOP
          IF jsonb_typeof(l) <> 'number' OR (l #>> '{}')::numeric <> trunc((l #>> '{}')::numeric) OR (l #>> '{}')::numeric NOT BETWEEN 1 AND 365 THEN
            errs := errs || public.reg_err_item('/registers/' || i || '/lead_days', 'out_of_range', 'Whole days from 1 to 365.');
          ELSE
            lead_n := (l #>> '{}')::integer;
            IF lead_n = ANY (lead_seen) THEN errs := errs || public.reg_err_item('/registers/' || i || '/lead_days', 'duplicate', 'Each lead time once.'); END IF;
            lead_seen := lead_seen || lead_n;
          END IF;
        END LOOP;
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  FOR r IN SELECT x FROM jsonb_array_elements(p_body -> 'registers') x LOOP
    newregs := newregs || jsonb_build_object(r ->> 'register_key', jsonb_build_object('field', r ->> 'field',
      'lead_days', (SELECT jsonb_agg(v::integer ORDER BY v::integer) FROM jsonb_array_elements_text(r -> 'lead_days') v)));
  END LOOP;
  SELECT coalesce((value ->> 'version')::integer, 0) INTO iv FROM public.settings WHERE key = 'expiry.radar';
  UPDATE public.settings SET value = jsonb_build_object('enabled', (p_body ->> 'enabled')::boolean, 'version', iv + 1, 'registers', newregs),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'expiry.radar';
  res := public.expiry_radar_json();
  PERFORM public.log_audit_write('expiry_radar_update', 'setting', 'expiry.radar',
    jsonb_build_object('enabled', cur -> 'enabled', 'registers', cur -> 'registers'),
    jsonb_build_object('enabled', res -> 'enabled', 'registers', res -> 'registers'), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['expiry_radar_json()', 'admin_set_expiry_radar(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
  END LOOP;
END $$;
