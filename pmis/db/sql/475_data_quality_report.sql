-- 0476_data_quality_report: the settings of the read-only Data quality report (Settings > Data > Quality; D3, contract 0.15.538).
-- Mirror: db/sql/475_data_quality_report.sql (kept identical to prisma/migrations/0476_data_quality_report/migration.sql).
--
-- The report has no table and writes nothing: GET /reports/data-quality reads sites, tasks and document slots with the regions of the caller.
-- What an admin may configure is one setting, data_quality.report, changed only through admin_set_data_quality:
--   enabled, checks (closed list: site_required_empty, dates_out_of_order, site_without_contractor, orphan_ids, missing_photos),
--   required_site_fields (closed list of site columns), max_rows (10 to 500 rows per check).
-- Doors: data_quality_state() (any signed-in user), admin_set_data_quality(body, reason, version) (System Admin or a delegate of settings edit for all
-- regions, a reason, If-Match version, strict validation, one audit row data_quality_update). Additive: one setting, three functions, no table.

SELECT set_config('app.region_ids', '*', true);
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('data_quality.report',
        '{"enabled": true, "checks": ["site_required_empty", "dates_out_of_order", "site_without_contractor", "orphan_ids", "missing_photos"], "required_site_fields": ["latitude", "longitude", "site_type"], "max_rows": 100}'::jsonb,
        'D3 (0476): the Data quality report settings. Changed only through admin_set_data_quality.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_data_quality ON settings;
DROP TRIGGER IF EXISTS b_settings_data_quality_update ON settings;
DROP TRIGGER IF EXISTS b_settings_data_quality_delete ON settings;
CREATE TRIGGER b_settings_data_quality BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'data_quality.report') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_data_quality_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'data_quality.report' OR NEW.key = 'data_quality.report') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_data_quality_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'data_quality.report') EXECUTE FUNCTION settings_guarded_keys();

-- strict = the write door (a bad value is a 422), lenient = the reader (a bad value reads as the default).
CREATE OR REPLACE FUNCTION data_quality_normalize(p jsonb, p_strict boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d jsonb := '{"enabled": true, "checks": ["site_required_empty", "dates_out_of_order", "site_without_contractor", "orphan_ids", "missing_photos"], "required_site_fields": ["latitude", "longitude", "site_type"], "max_rows": 100}'::jsonb;
  chk text[] := ARRAY['site_required_empty', 'dates_out_of_order', 'site_without_contractor', 'orphan_ids', 'missing_photos'];
  flds text[] := ARRAY['name_ar', 'latitude', 'longitude', 'address', 'site_type', 'site_scenario', 'sub_region', 'cluster_id', 'rf_survey_date', 'acquisition_date', 'project_phase'];
  bad text; out jsonb := '{}'::jsonb; arr jsonb; el jsonb; k text; allowed text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    IF p_strict THEN PERFORM public.wfe_err1('/', 'invalid', 'The Data quality settings must be an object.'); END IF;
    RETURN d;
  END IF;
  IF p_strict THEN
    SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p) key
     WHERE key NOT IN ('enabled', 'checks', 'required_site_fields', 'max_rows');
    IF bad IS NOT NULL THEN PERFORM public.wfe_err1('/', 'unknown_field', format('Unknown keys: %s', bad)); END IF;
  END IF;
  IF jsonb_typeof(p -> 'enabled') = 'boolean' THEN out := out || jsonb_build_object('enabled', p -> 'enabled');
  ELSIF p_strict THEN PERFORM public.wfe_err1('/enabled', 'invalid', 'enabled is true or false.');
  ELSE out := out || jsonb_build_object('enabled', d -> 'enabled'); END IF;
  IF jsonb_typeof(p -> 'max_rows') = 'number' AND (p ->> 'max_rows')::numeric = trunc((p ->> 'max_rows')::numeric) AND (p ->> 'max_rows')::numeric BETWEEN 10 AND 500 THEN
    out := out || jsonb_build_object('max_rows', (p ->> 'max_rows')::int);
  ELSIF p_strict THEN PERFORM public.wfe_err1('/max_rows', 'invalid', 'max_rows is a whole number from 10 to 500.');
  ELSE out := out || jsonb_build_object('max_rows', 100); END IF;
  FOREACH k IN ARRAY ARRAY['checks', 'required_site_fields'] LOOP
    allowed := CASE WHEN k = 'checks' THEN chk ELSE flds END;
    arr := '[]'::jsonb;
    IF jsonb_typeof(p -> k) = 'array' AND jsonb_array_length(p -> k) <= 20 THEN
      FOR el IN SELECT value FROM jsonb_array_elements(p -> k) LOOP
        IF jsonb_typeof(el) = 'string' AND (el #>> '{}') = ANY (allowed) AND NOT arr @> jsonb_build_array(el) THEN arr := arr || jsonb_build_array(el);
        ELSIF p_strict THEN PERFORM public.wfe_err1('/' || k, 'invalid', format('Each value is one of: %s, once.', array_to_string(allowed, ', '))); END IF;
      END LOOP;
    ELSIF p_strict THEN PERFORM public.wfe_err1('/' || k, 'invalid', format('%s is a list.', k));
    ELSE arr := d -> k; END IF;
    out := out || jsonb_build_object(k, arr);
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION data_quality_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.data_quality_normalize((SELECT value FROM public.settings WHERE key = 'data_quality.report'), false)
$$;

CREATE OR REPLACE FUNCTION data_quality_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'data_quality.report';
  RETURN public.data_quality_cfg() || jsonb_build_object(
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('data_quality.report'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_data_quality(p_body jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; nxt jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  nxt := public.data_quality_normalize(p_body, true);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('data_quality.report', public.data_quality_normalize(NULL, false), 'D3 (0476): the Data quality report settings. Changed only through admin_set_data_quality.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'data_quality.report' FOR UPDATE;
  cur := public.data_quality_cfg();
  IF p_version IS NOT NULL AND p_version <> public.settings_etag('data_quality.report') THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur = nxt THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the Data quality settings.'));
  END IF;
  UPDATE public.settings SET value = nxt, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'data_quality.report';
  res := public.data_quality_state();
  PERFORM public.log_audit_write('data_quality_update', 'setting', 'data_quality.report', cur, public.data_quality_cfg(), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['data_quality_normalize(jsonb,boolean)', 'data_quality_cfg()', 'data_quality_state()', 'admin_set_data_quality(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION data_quality_state() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_data_quality(jsonb, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION data_quality_normalize(jsonb, boolean) FROM pmis_app;
    REVOKE ALL ON FUNCTION data_quality_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('data_quality_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'data_quality.report', 'read', 'data_quality_state', 'write', 'admin_set_data_quality', 'audit', jsonb_build_array('data_quality_update')),
        'D3: the read-only Data quality report settings, edited from Settings > Data > Quality (migration 0476).');

-- The orphan check reads fk_orphan_report() (0182), which no user role may call: this door answers it to a settings viewer (System Admin or a
-- delegate), as constraint names and counts only (never a row).
CREATE OR REPLACE FUNCTION data_quality_orphans() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('settings', false);
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('constraint', r.constraint_name, 'orphans', r.orphans, 'validated', r.validated) ORDER BY r.constraint_name)
                     FROM public.fk_orphan_report() r WHERE r.orphans > 0), '[]'::jsonb);
END $$;
ALTER FUNCTION data_quality_orphans() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION data_quality_orphans() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION data_quality_orphans() TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN GRANT EXECUTE ON FUNCTION data_quality_orphans() TO pmis_app; END IF;
END $$;
