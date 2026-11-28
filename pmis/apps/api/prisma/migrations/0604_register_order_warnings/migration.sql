-- 0604: order warnings for every register (M1, contract 0.15.464). The reviewer warnings of Q151 (0063) only knew the GECOL register. Now:
--   1. reg_order_cfg(register) reads the setting of a register: GECOL keeps its old key `gecol.order_warnings` (no data move, nothing lost); every other register
--      reads `register.order_warnings` -> registers -> <key> (enabled, chains, billing_after, billing_field, version). Nothing is seeded: off everywhere.
--   2. reg_order_warnings(register, data) is the chain walk of gecol_order_warnings, generalised: the same steps, the same messages. The warning code is
--      `gecol_order` for GECOL (unchanged) and `order` for the others. The billing check compares the configured billing field with its event field (GECOL: the
--      billing conversion date, as before). gecol_order_warnings(data) becomes a wrapper, so the GECOL output is unchanged.
--   3. reg_warnings_p4c (the reviewer warnings) gets a call to reg_order_warnings for every register but GECOL (which already has its call). Patched in place from
--      the stored text, asserted, idempotent.
--   4. Reader register_order_warnings_json(register) and writer admin_save_register_order_warnings(register, config, reason, version): System Admin or a delegation
--      of admin.settings edit for all regions, a reason, If-Match per register, audit with before and after. For GECOL the writer is admin_save_gecol_order_warnings.
-- Warnings never block. Additive: new functions, one patched function, no table, no seed.

CREATE OR REPLACE FUNCTION reg_order_cfg(p_register text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_register = 'gecol' THEN public.gecol_order_cfg()
    ELSE '{"enabled": false, "chains": [], "billing_after": null, "billing_field": null, "version": 0}'::jsonb
         || coalesce(CASE WHEN jsonb_typeof(public.calc_setting('register.order_warnings', '{}'::jsonb) -> 'registers' -> p_register) = 'object'
                          THEN public.calc_setting('register.order_warnings', '{}'::jsonb) -> 'registers' -> p_register END, '{}'::jsonb)
  END
$$;

CREATE OR REPLACE FUNCTION reg_field_label(p_register text, p_code text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT f.label_en FROM public.register_fields f WHERE f.register_key = p_register AND f.code = p_code), p_code)
$$;

CREATE OR REPLACE FUNCTION reg_order_warnings(p_register text, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cfg jsonb := public.reg_order_cfg(p_register); w jsonb := '[]'::jsonb; chain jsonb; code text; d date; prev date; prev_code text; ev text; bf text; evd date; bd date; wcode text;
BEGIN
  IF NOT coalesce((cfg ->> 'enabled')::boolean, false) THEN RETURN w; END IF;
  wcode := CASE WHEN p_register = 'gecol' THEN 'gecol_order' ELSE 'order' END;
  FOR chain IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cfg -> 'chains') = 'array' THEN cfg -> 'chains' ELSE '[]'::jsonb END) LOOP
    prev := NULL; prev_code := NULL;
    CONTINUE WHEN jsonb_typeof(chain) <> 'array';
    FOR code IN SELECT * FROM jsonb_array_elements_text(chain) LOOP
      BEGIN d := (p_data ->> code)::date; EXCEPTION WHEN others THEN d := NULL; END;
      CONTINUE WHEN d IS NULL;                                 -- a step that does not apply (no date) is skipped
      IF prev IS NOT NULL AND d < prev THEN
        w := w || jsonb_build_array(jsonb_build_object('path', '/data/' || code, 'code', wcode, 'related_path', '/data/' || prev_code,
          'message', public.reg_field_label(p_register, code) || ' is before ' || public.reg_field_label(p_register, prev_code) || '.'));
      ELSE
        prev := d; prev_code := code;
      END IF;
    END LOOP;
  END LOOP;
  ev := nullif(cfg ->> 'billing_after', '');
  bf := CASE WHEN p_register = 'gecol' THEN 'billing_conversion_date' ELSE nullif(cfg ->> 'billing_field', '') END;
  IF ev IS NOT NULL AND bf IS NOT NULL THEN
    BEGIN evd := (p_data ->> ev)::date; bd := (p_data ->> bf)::date; EXCEPTION WHEN others THEN evd := NULL; END;
    IF evd IS NOT NULL AND bd IS NOT NULL AND bd < evd THEN
      w := w || jsonb_build_array(jsonb_build_object('path', '/data/' || bf, 'code', 'billing_before_event', 'related_path', '/data/' || ev,
        'message', CASE WHEN p_register = 'gecol' THEN 'The billing conversion is before ' || public.reg_field_label('gecol', ev) || ' (the contract event it follows).'
                        ELSE public.reg_field_label(p_register, bf) || ' is before ' || public.reg_field_label(p_register, ev) || '.' END));
    END IF;
  END IF;
  RETURN w;
END $$;

-- GECOL output is unchanged: the old function is now a one-line wrapper.
CREATE OR REPLACE FUNCTION gecol_order_warnings(p_data jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.reg_order_warnings('gecol', p_data)
$$;

-- The reviewer warnings call the generic function for every register but GECOL.
DO $$
DECLARE def text; n text; cnt int;
BEGIN
  def := pg_get_functiondef('public.reg_warnings_p4c(uuid,jsonb)'::regprocedure);
  IF position('reg_order_warnings' IN def) = 0 THEN
    n := E'\n  RETURN w;\nEND';
    cnt := (length(def) - length(replace(def, n, ''))) / length(n);
    IF cnt <> 1 THEN RAISE EXCEPTION 'reg_warnings_p4c: the final return is there % times, expected 1', cnt; END IF;
    def := replace(def, n, E'\n  IF r.register_key <> ''gecol'' THEN w := w || public.reg_order_warnings(r.register_key, dd); END IF;\n  RETURN w;\nEND');
    EXECUTE def;
  END IF;
END $$;

-- Reader: the setting of one register with its date fields.
CREATE OR REPLACE FUNCTION register_order_warnings_json(p_register text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c jsonb; s record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = p_register) THEN PERFORM public.wf_err('not_found'); END IF;
  c := public.reg_order_cfg(p_register);
  SELECT st.updated_at, st.updated_by INTO s FROM public.settings st WHERE st.key = CASE WHEN p_register = 'gecol' THEN 'gecol.order_warnings' ELSE 'register.order_warnings' END;
  RETURN jsonb_build_object('register_key', p_register, 'enabled', coalesce((c ->> 'enabled')::boolean, false), 'chains', coalesce(c -> 'chains', '[]'::jsonb),
    'billing_after', c -> 'billing_after', 'billing_field', CASE WHEN p_register = 'gecol' THEN to_jsonb('billing_conversion_date'::text) ELSE c -> 'billing_field' END,
    'version', coalesce((c ->> 'version')::int, 0), 'updated_at', s.updated_at, 'updated_by', s.updated_by,
    'fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', f.code, 'label_en', f.label_en, 'label_ar', f.label_ar) ORDER BY f.sort_order), '[]'::jsonb)
               FROM public.register_fields f WHERE f.register_key = p_register AND f.field_type = 'date' AND f.is_active));
END $$;

-- Writer: one register. GECOL goes through its own writer (its key and its audit action are kept).
CREATE OR REPLACE FUNCTION admin_save_register_order_warnings(p_register text, p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; k text; chain jsonb; el jsonb; i int; j int; seen text[]; dates text[]; ev jsonb; bf jsonb; v int; whole jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = p_register) THEN PERFORM public.wf_err('not_found'); END IF;
  IF p_register = 'gecol' THEN
    IF p_config IS NOT NULL AND jsonb_typeof(p_config) = 'object' AND p_config ? 'billing_field' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/billing_field', 'unknown_key', 'The billing field of GECOL is the billing conversion date.')));
    END IF;
    PERFORM public.admin_save_gecol_order_warnings(p_config, p_reason, p_version);
    RETURN public.register_order_warnings_json('gecol');
  END IF;
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('register.order_warnings', '{"registers": {}}'::jsonb, 'M1: reviewer warnings on the order of the dates of a register (see migration 0604).', public.app_actor(), now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'register.order_warnings' FOR UPDATE;
  cur := public.reg_order_cfg(p_register);
  v := coalesce((cur ->> 'version')::int, 0);
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  SELECT coalesce(array_agg(f.code), ARRAY[]::text[]) INTO dates FROM public.register_fields f WHERE f.register_key = p_register AND f.field_type = 'date' AND f.is_active;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with enabled, chains, billing_after and billing_field.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('enabled', 'chains', 'billing_after', 'billing_field') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_config -> 'enabled') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/enabled', 'required', 'true or false.'); END IF;
  IF jsonb_typeof(p_config -> 'chains') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/chains', 'required', 'The list of chains is required (it may be empty).');
  ELSIF jsonb_array_length(p_config -> 'chains') > 10 THEN
    errs := errs || public.reg_err_item('/chains', 'too_many', 'At most 10 chains.');
  ELSE
    i := 0;
    FOR chain IN SELECT * FROM jsonb_array_elements(p_config -> 'chains') LOOP
      IF jsonb_typeof(chain) <> 'array' OR jsonb_array_length(chain) < 2 OR jsonb_array_length(chain) > 20 THEN
        errs := errs || public.reg_err_item('/chains/' || i, 'invalid', 'A chain lists 2 to 20 date fields of the register in their expected order.');
      ELSE
        seen := ARRAY[]::text[]; j := 0;
        FOR el IN SELECT * FROM jsonb_array_elements(chain) LOOP
          IF jsonb_typeof(el) <> 'string' OR NOT ((el #>> '{}') = ANY (dates)) THEN
            errs := errs || public.reg_err_item('/chains/' || i || '/' || j, 'unknown_field', 'Not a date field of this register.');
          ELSIF (el #>> '{}') = ANY (seen) THEN
            errs := errs || public.reg_err_item('/chains/' || i || '/' || j, 'duplicate', 'This field is listed twice in the chain.');
          ELSE seen := seen || (el #>> '{}'); END IF;
          j := j + 1;
        END LOOP;
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  ev := p_config -> 'billing_after';
  bf := p_config -> 'billing_field';
  IF ev IS NOT NULL AND jsonb_typeof(ev) <> 'null' THEN
    IF jsonb_typeof(ev) <> 'string' OR NOT ((ev #>> '{}') = ANY (dates)) THEN
      errs := errs || public.reg_err_item('/billing_after', 'unknown_field', 'A date field of this register, or null.');
    END IF;
  END IF;
  IF bf IS NOT NULL AND jsonb_typeof(bf) <> 'null' THEN
    IF jsonb_typeof(bf) <> 'string' OR NOT ((bf #>> '{}') = ANY (dates)) OR (ev IS NOT NULL AND ev = bf) THEN
      errs := errs || public.reg_err_item('/billing_field', 'unknown_field', 'A date field of this register other than the event it follows, or null.');
    END IF;
  END IF;
  IF (ev IS NOT NULL AND jsonb_typeof(ev) <> 'null') <> (bf IS NOT NULL AND jsonb_typeof(bf) <> 'null') THEN
    errs := errs || public.reg_err_item('/billing_field', 'invalid', 'Give both the billing field and the event it follows, or neither.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := public.register_order_warnings_json(p_register) - 'fields' - 'updated_at' - 'updated_by';
  SELECT value INTO whole FROM public.settings WHERE key = 'register.order_warnings';
  whole := jsonb_set(CASE WHEN jsonb_typeof(whole -> 'registers') = 'object' THEN whole ELSE '{"registers": {}}'::jsonb END, ARRAY['registers', p_register],
    jsonb_build_object('enabled', p_config -> 'enabled', 'chains', p_config -> 'chains', 'billing_after', coalesce(ev, 'null'::jsonb), 'billing_field', coalesce(bf, 'null'::jsonb), 'version', v + 1), true);
  UPDATE public.settings SET value = whole, updated_by = public.app_actor(), updated_at = now() WHERE key = 'register.order_warnings';
  after := public.register_order_warnings_json(p_register);
  PERFORM public.log_audit_write('register_order_warnings_update', 'setting', 'register.order_warnings:' || p_register, before, after - 'fields' - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['reg_order_cfg(text)', 'reg_field_label(text,text)', 'reg_order_warnings(text,jsonb)', 'register_order_warnings_json(text)',
                           'admin_save_register_order_warnings(text,jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['register_order_warnings_json(text)', 'admin_save_register_order_warnings(text,jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
