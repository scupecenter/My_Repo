-- 0148_table_display_settings: the defaults of the Display menu of the site-data tables (W8 item 4 of plan 2026-11-23-next-ui-cleanup, contract 0.15.64,
-- CHANGELOG 201). Mirror: db/sql/147_table_display_settings.sql (kept byte-identical).
--
-- The Display menu (text size, alignment of text cells, row density, wrap long text, zebra rows) is stored per user and per screen in the browser and
-- in the saved views (SavedViewColumns, no schema change: the columns object is kept as sent, only hidden columns are stripped). Its DEFAULTS are a
-- general setting (owner rule: settings live in Administration > Settings): the guarded key table.display, read by every signed-in user (a screen
-- needs them to draw its first table) and written only through admin_set_table_display: System Admin or a delegate of admin.settings edit for all
-- regions, a reason, If-Match (the version), a closed body with field errors (unknown_key, invalid), one audit row with before and after.
--
-- Every new function is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked; pmis_app executes the reader and
-- the door only. No table is added.

SELECT set_config('app.region_ids', '*', true);

-- The seed defaults when nothing was saved: the look of the tables before W8.
CREATE OR REPLACE FUNCTION table_display_seed() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT '{"size": "md", "align": "start", "density": "comfortable", "wrap": false, "zebra": true}'::jsonb
$$;

-- GET /settings/table-display: {defaults: {size, align, density, wrap, zebra}, version, updated_at?, updated_by?}
CREATE OR REPLACE FUNCTION table_display_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; d jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'table display: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'table.display';
  d := public.table_display_seed() || coalesce(s.value -> 'defaults', '{}'::jsonb);
  RETURN jsonb_build_object('defaults', d, 'version', coalesce((s.value ->> 'version')::integer, 0))
    || CASE WHEN s.key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_at', s.updated_at) END
    || CASE WHEN s.updated_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_by', public.wfe_user_ref(s.updated_by)) END;
END $$;

-- PUT /settings/table-display. p_body = {defaults: {size, align, density, wrap, zebra}} (closed, every key required); the reason apart; p_version = If-Match (NULL = *).
CREATE OR REPLACE FUNCTION admin_set_table_display(p_body jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; k text; d jsonb; iv integer; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('table.display', jsonb_build_object('defaults', public.table_display_seed(), 'version', 0),
          'W8: the defaults of the Display menu of the site-data tables (migration 0148).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'table.display' FOR UPDATE;
  cur := public.table_display_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with defaults.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k <> 'defaults' THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  d := p_body -> 'defaults';
  IF d IS NULL OR jsonb_typeof(d) <> 'object' THEN
    errs := errs || public.reg_err_item('/defaults', 'required', 'An object with size, align, density, wrap and zebra.');
  ELSE
    FOR k IN SELECT jsonb_object_keys(d) LOOP
      IF k NOT IN ('size', 'align', 'density', 'wrap', 'zebra') THEN errs := errs || public.reg_err_item('/defaults/' || k, 'unknown_key', 'Unknown key.'); END IF;
    END LOOP;
    IF jsonb_typeof(d -> 'size') IS DISTINCT FROM 'string' OR (d ->> 'size') NOT IN ('sm', 'md', 'lg') THEN
      errs := errs || public.reg_err_item('/defaults/size', 'invalid', 'sm, md or lg.');
    END IF;
    IF jsonb_typeof(d -> 'align') IS DISTINCT FROM 'string' OR (d ->> 'align') NOT IN ('start', 'center') THEN
      errs := errs || public.reg_err_item('/defaults/align', 'invalid', 'start or center.');
    END IF;
    IF jsonb_typeof(d -> 'density') IS DISTINCT FROM 'string' OR (d ->> 'density') NOT IN ('compact', 'normal', 'comfortable') THEN
      errs := errs || public.reg_err_item('/defaults/density', 'invalid', 'compact, normal or comfortable.');
    END IF;
    IF jsonb_typeof(d -> 'wrap') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/defaults/wrap', 'invalid', 'true or false.'); END IF;
    IF jsonb_typeof(d -> 'zebra') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/defaults/zebra', 'invalid', 'true or false.'); END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  SELECT coalesce((value ->> 'version')::integer, 0) INTO iv FROM public.settings WHERE key = 'table.display';
  UPDATE public.settings SET value = jsonb_build_object('defaults', d, 'version', iv + 1), updated_by = public.app_actor(), updated_at = clock_timestamp()
  WHERE key = 'table.display';
  res := public.table_display_json();
  PERFORM public.log_audit_write('table_display_update', 'setting', 'table.display', cur -> 'defaults', res -> 'defaults', btrim(p_reason));
  RETURN res;
END $$;

-- the key changes only through its audited door (as the other guarded settings, 0072 and 0145); an UPDATE is guarded on the old and the new key
CREATE TRIGGER b_settings_tdisp_insert BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'table.display') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_tdisp_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'table.display' OR NEW.key = 'table.display') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_tdisp_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'table.display') EXECUTE FUNCTION settings_guarded_keys();

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('table_display_settings_applied', 'workflow', NULL,
        jsonb_build_object('table_display', 'table.display with admin_set_table_display; read by every signed-in user'),
        'Display defaults of the site-data tables (migration 0148, contract 0.15.64).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['table_display_seed()', 'table_display_json()', 'admin_set_table_display(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['table_display_json()', 'admin_set_table_display(jsonb,text,integer)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
