-- 0293: download lock categories (S1b of section 3; Main relayed the instruction on 2026-11-27).
--
-- WHY. The export lock of 0290 refuses data exports. Three kinds of download were left out of it on purpose: blank templates, a single uploaded file, and a
-- generated library document. An admin may want to close those too. Each gets its own switch, all OFF by default, so nothing changes until a System Admin turns one
-- on in Settings > Security > Lock keys. Nothing is deleted, no permission is widened, no sign-in changes.
--
-- WHAT THIS ADDS (the same shape as 0290, a separate setting so no earlier function is redefined).
--   1. The setting security.download_locks = {"templates": false, "uploaded_files": false, "generated_documents": false}, guarded by settings_guarded_keys (0072).
--   2. download_locks_cfg(): the sanitised setting (anything that is not a boolean true reads as off).
--   3. download_lock_active(p_key): true when one category is on; an unknown key is an error. The API checks it for the routes marked with a category.
--   4. download_locks_state(): the read door for any signed-in user (the UI disables what is locked).
--   5. admin_set_download_locks(p_templates, p_uploaded_files, p_generated, p_reason, p_version): the write door, System Admin only, reason 3+ characters,
--      version (If-Match), one audit row download_locks_update with before and after. The step-up is enforced by the API. Turning a switch off is as easy as on.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC, owned by pmis_definer. No new table.
SELECT set_config('app.region_ids', '*', true);

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('security.download_locks', '{"templates": false, "uploaded_files": false, "generated_documents": false}'::jsonb,
        'S1b (0293): download lock categories {templates, uploaded_files, generated_documents}, all off by default. Changed only through admin_set_download_locks.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_download_locks ON settings;
DROP TRIGGER IF EXISTS b_settings_download_locks_update ON settings;
DROP TRIGGER IF EXISTS b_settings_download_locks_delete ON settings;
CREATE TRIGGER b_settings_download_locks BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'security.download_locks') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_download_locks_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.download_locks' OR NEW.key = 'security.download_locks') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_download_locks_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'security.download_locks') EXECUTE FUNCTION settings_guarded_keys();

CREATE OR REPLACE FUNCTION download_locks_cfg() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM public.settings WHERE key = 'security.download_locks';
  IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN v := '{}'::jsonb; END IF;
  RETURN jsonb_build_object(
    'templates', coalesce(jsonb_typeof(v -> 'templates') = 'boolean' AND (v ->> 'templates')::boolean, false),
    'uploaded_files', coalesce(jsonb_typeof(v -> 'uploaded_files') = 'boolean' AND (v ->> 'uploaded_files')::boolean, false),
    'generated_documents', coalesce(jsonb_typeof(v -> 'generated_documents') = 'boolean' AND (v ->> 'generated_documents')::boolean, false));
END $$;

CREATE OR REPLACE FUNCTION download_lock_active(p_key text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.download_locks_cfg();
BEGIN
  IF p_key IS NULL OR NOT (c ? p_key) THEN RAISE EXCEPTION 'unknown download lock key' USING ERRCODE = 'invalid_parameter_value'; END IF;
  RETURN (c ->> p_key)::boolean;
END $$;

CREATE OR REPLACE FUNCTION download_locks_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; c jsonb := public.download_locks_cfg();
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'security.download_locks';
  RETURN jsonb_build_object(
    'templates', c -> 'templates', 'uploaded_files', c -> 'uploaded_files', 'generated_documents', c -> 'generated_documents',
    'updated_at', CASE WHEN s.key IS NULL THEN 'null'::jsonb ELSE to_jsonb(s.updated_at) END,
    'updated_by', coalesce(public.wfe_user_ref(s.updated_by), 'null'::jsonb),
    'version', public.settings_etag('security.download_locks'),
    'can_edit', coalesce(public.app_actor_is_system_admin(), false));
END $$;

CREATE OR REPLACE FUNCTION admin_set_download_locks(p_templates boolean, p_uploaded_files boolean, p_generated boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin changes the download locks.'));
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF p_templates IS NULL THEN PERFORM public.wfe_err1('/templates', 'required', 'Say whether template downloads are locked.'); END IF;
  IF p_uploaded_files IS NULL THEN PERFORM public.wfe_err1('/uploaded_files', 'required', 'Say whether uploaded file downloads are locked.'); END IF;
  IF p_generated IS NULL THEN PERFORM public.wfe_err1('/generated_documents', 'required', 'Say whether generated document downloads are locked.'); END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('security.download_locks', '{"templates": false, "uploaded_files": false, "generated_documents": false}'::jsonb,
          'S1b (0293): download lock categories {templates, uploaded_files, generated_documents}, all off by default. Changed only through admin_set_download_locks.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'security.download_locks' FOR UPDATE;
  cur := public.download_locks_state();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'templates')::boolean = p_templates AND (cur ->> 'uploaded_files')::boolean = p_uploaded_files AND (cur ->> 'generated_documents')::boolean = p_generated THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These are already the download locks in force.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('templates', p_templates, 'uploaded_files', p_uploaded_files, 'generated_documents', p_generated),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
   WHERE key = 'security.download_locks';
  res := public.download_locks_state();
  PERFORM public.log_audit_write('download_locks_update', 'setting', 'security.download_locks',
    jsonb_build_object('templates', cur -> 'templates', 'uploaded_files', cur -> 'uploaded_files', 'generated_documents', cur -> 'generated_documents'),
    jsonb_build_object('templates', res -> 'templates', 'uploaded_files', res -> 'uploaded_files', 'generated_documents', res -> 'generated_documents'), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['download_locks_cfg()', 'download_lock_active(text)', 'download_locks_state()', 'admin_set_download_locks(boolean,boolean,boolean,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION download_lock_active(text), download_locks_state(), admin_set_download_locks(boolean, boolean, boolean, text, integer) TO pmis_app;
    REVOKE ALL ON FUNCTION download_locks_cfg() FROM pmis_app;
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('download_locks_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'security.download_locks', 'templates', false, 'uploaded_files', false, 'generated_documents', false,
          'read', 'download_locks_state', 'write', 'admin_set_download_locks', 'check', 'download_lock_active', 'audit', jsonb_build_array('download_locks_update')),
        'Download lock categories (templates, uploaded files, generated documents), all off by default (migration 0293).');
