-- 0492_upload_policy: the upload policy of the imports, Enforce or Accept incomplete (D49 part 3, owner approval relayed 2026-11-27). Additive.
-- Mirror: db/sql/491_upload_policy.sql (kept identical to prisma/migrations/0492_upload_policy/migration.sql).
--
-- WHY. An upload follows the sequencing locks of the site (0085): a row that breaks the sequence is held. The owner wants to choose, in Settings, what the
-- Master import apply does with sites whose data is incomplete: keep the locks (Enforce, as today) or accept the incomplete data (Accept incomplete).
--   1. One setting, imports.upload_policy, a JSON string: 'enforce' (default, no behaviour change) or 'accept_incomplete'. Changed only through
--      admin_set_imports_upload_policy(policy, reason, version): System Admin or an all-regions delegate of settings edit, reason, If-Match, audit row
--      imports_upload_policy_update with before and after. Read by every signed-in user through imports_upload_policy_json().
--   2. The setting does not write anything by itself. The API reads it when a Master import run is applied and, for accept_incomplete, opens the sites of
--      the run with the existing door site_workflow_locks_set (the unlock right, a reason, a step-up, an audit row per site; an approval that bypasses a
--      lock is flagged lock_bypassed). No right, role or grant changes.
--   3. site_data_gaps is unchanged; the API lists its items per site on the import status page (the per-row missing-data indicator).
-- The third mode (valid rows only) is not stored here: it comes with its own migration when its enforcement is built.
-- No new table.

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('imports.upload_policy', '"enforce"'::jsonb,
        'D49 part 3 (0492): what the Master import apply does with incomplete data: enforce (keep the sequencing locks) or accept_incomplete. Changed only through admin_set_imports_upload_policy.', now())
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS b_settings_upload_policy ON settings;
DROP TRIGGER IF EXISTS b_settings_upload_policy_update ON settings;
DROP TRIGGER IF EXISTS b_settings_upload_policy_delete ON settings;
CREATE TRIGGER b_settings_upload_policy BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'imports.upload_policy') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_upload_policy_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'imports.upload_policy' OR NEW.key = 'imports.upload_policy') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_upload_policy_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'imports.upload_policy') EXECUTE FUNCTION settings_guarded_keys();

-- The policy in force; a missing or unknown value reads as enforce.
CREATE OR REPLACE FUNCTION imports_upload_policy_cfg() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT CASE WHEN jsonb_typeof(s.value) = 'string' AND (s.value #>> '{}') IN ('enforce', 'accept_incomplete') THEN s.value #>> '{}' END
                   FROM public.settings s WHERE s.key = 'imports.upload_policy'), 'enforce')
$$;

CREATE OR REPLACE FUNCTION imports_upload_policy_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'imports.upload_policy';
  RETURN jsonb_build_object('policy', public.imports_upload_policy_cfg(), 'default_policy', 'enforce', 'policies', jsonb_build_array('enforce', 'accept_incomplete'),
    'updated_at', s.updated_at, 'updated_by', s.updated_by, 'version', public.settings_etag('imports.upload_policy'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_imports_upload_policy(p_policy text, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_policy IS NULL OR p_policy NOT IN ('enforce', 'accept_incomplete') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/policy', 'invalid', 'The upload policy is enforce or accept_incomplete.')));
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('imports.upload_policy', '"enforce"'::jsonb, 'D49 part 3 (0492): the upload policy of the Master import apply.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'imports.upload_policy' FOR UPDATE;
  cur := public.imports_upload_policy_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF cur ->> 'policy' = p_policy THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The upload policy is already ' || p_policy || '.'));
  END IF;
  UPDATE public.settings SET value = to_jsonb(p_policy), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'imports.upload_policy';
  res := public.imports_upload_policy_json();
  PERFORM public.log_audit_write('imports_upload_policy_update', 'setting', 'imports.upload_policy',
    jsonb_build_object('policy', cur -> 'policy', 'updated_at', cur -> 'updated_at', 'updated_by', cur -> 'updated_by'),
    jsonb_build_object('policy', res -> 'policy', 'updated_at', res -> 'updated_at', 'updated_by', res -> 'updated_by'), btrim(p_reason));
  RETURN res;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['imports_upload_policy_cfg()', 'imports_upload_policy_json()', 'admin_set_imports_upload_policy(text,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION imports_upload_policy_json() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_set_imports_upload_policy(text, text, integer) TO pmis_app;
  END IF;
END $$;
