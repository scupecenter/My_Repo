-- 0254_column_defaults: a default value per register column (item 10 of the 2026-11-26 final review), set in Settings > Register columns.
-- Mirror: db/sql/190_column_defaults.sql (kept identical to prisma/migrations/0254_column_defaults/migration.sql).
--
--   Additive. register_fields gets default_value (jsonb, NULL = no default). The register form prefills it on a NEW record and shows it as prefilled; it is
--   a convenience of the screen only: the server never fills it in by itself (a template import, an API call or a record saved without the column stay as sent).
--   admin_reg_field_default_set(register, code, value, reason, version) is the one door (System Admin or a delegate of fields.edit, as admin_reg_field_save).
--   It accepts only a simple column (text, long text, email, phone, link, number, currency, percentage, date, yes/no, list, multi-list; not computed, document,
--   child list, user, party or site columns), validates the value with the same cleaning as a record (reg_clean_data) and, for a list, against the active
--   values. Setting it never changes a record and never issues a template version. No permission is widened.
ALTER TABLE register_fields ADD COLUMN default_value jsonb;
COMMENT ON COLUMN register_fields.default_value IS '0254: prefilled on a new record in the register form (NULL = none); never applied by the server.';

CREATE OR REPLACE FUNCTION rcol_json(f public.register_fields) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('code', f.code, 'label_en', f.label_en, 'label_ar', f.label_ar, 'type', public.rcol_eff_type(f.field_type, f.options), 'required', f.required,
    'list_catalogue', f.list_catalogue, 'section', f.section, 'sort_order', f.sort_order, 'in_list', f.in_list, 'in_filter', f.in_filter, 'in_template', f.in_template,
    'in_export', f.in_export, 'is_active', f.is_active, 'is_system', f.is_system, 'default_value', f.default_value, 'version', f.version)
$$;

CREATE OR REPLACE FUNCTION admin_reg_field_default_set(p_register text, p_code text, p_value jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  old_f public.register_fields%ROWTYPE; f public.register_fields%ROWTYPE; v_type text; v_clean jsonb; v_val jsonb := CASE WHEN p_value = 'null'::jsonb THEN NULL ELSE p_value END; v_item jsonb;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM public.rcol_need_register(p_register);
  old_f := public.rcol_lock(p_register, p_code);
  IF p_version IS NOT NULL AND p_version <> old_f.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The column changed since you read it. Reload and try again.'));
  END IF;
  v_type := public.rcol_eff_type(old_f.field_type, old_f.options);
  IF v_val IS NOT NULL THEN
    IF old_f.derived OR v_type NOT IN ('text', 'long_text', 'email', 'phone', 'link', 'number', 'currency', 'percentage', 'date', 'yes_no', 'list', 'multi_list') THEN
      PERFORM public.rcol_err('/value', 'not_supported', 'This kind of column cannot have a default value.');
    END IF;
    IF v_type = 'multi_list' AND jsonb_typeof(v_val) <> 'array' THEN PERFORM public.rcol_err('/value', 'invalid', 'A list of values.'); END IF;
    IF v_type IN ('list', 'multi_list') THEN
      FOR v_item IN SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(v_val) = 'array' THEN v_val ELSE jsonb_build_array(v_val) END) LOOP
        IF NOT EXISTS (SELECT 1 FROM public.list_values lv WHERE lv.catalogue_code = old_f.list_catalogue AND lv.code = v_item #>> '{}' AND lv.is_active) THEN
          PERFORM public.rcol_err('/value', 'unknown_value', 'This value is not an active value of the list.');
        END IF;
      END LOOP;
    END IF;
    -- the same cleaning and format checks as a record; the cleaned value is the one stored
    v_clean := public.reg_clean_data(p_register, jsonb_build_object(p_code, v_val));
    IF NOT (v_clean ? p_code) OR v_clean -> p_code = 'null'::jsonb THEN
      PERFORM public.rcol_err('/value', 'invalid', 'This value is not accepted by the column.');
    END IF;
    v_val := v_clean -> p_code;
  END IF;
  UPDATE public.register_fields x SET default_value = v_val, version = x.version + 1 WHERE x.register_key = p_register AND x.code = p_code RETURNING * INTO f;
  PERFORM public.log_audit_write('register_field_default', 'register_field', p_register || ':' || p_code, public.rcol_json(old_f), public.rcol_json(f), p_reason);
  RETURN jsonb_build_object('code', f.code, 'version', f.version, 'default_value', f.default_value);
END $$;
ALTER FUNCTION admin_reg_field_default_set(text, text, jsonb, text, integer) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION admin_reg_field_default_set(text, text, jsonb, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_reg_field_default_set(text, text, jsonb, text, integer) TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_reg_field_default_set(text, text, jsonb, text, integer) TO pmis_app;
  END IF;
END $$;
