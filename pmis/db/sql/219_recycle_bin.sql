-- 0220: Recycle bin for voided register records (contract 0.15.98). Additive: one settings key and three functions, no table changes.
-- A voided record stays in register_records (state 'voided', voided_at); nothing is ever deleted. The bin lists the voided records inside the
-- retention window (default 90 days, 30 to 730, Settings > Registers > Recycle bin) and a System Admin can restore one. A restored record comes back
-- as a draft ('entry', level 1) and goes through the workflow again; its version, history and audit stay. A delegate cannot restore (System Admin only).

INSERT INTO settings (key, value, description, updated_at)
VALUES ('recycle_bin.settings', '{"retention_days": 90}'::jsonb, 'Recycle bin (0220): how many days a voided register record can be restored.', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION recycle_bin_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE days integer; items jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'recycle bin: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  days := coalesce((SELECT (value ->> 'retention_days')::integer FROM public.settings WHERE key = 'recycle_bin.settings'), 90);
  SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'voided_at' DESC), '[]'::jsonb) INTO items FROM (
    SELECT jsonb_build_object('id', r.id, 'register_key', r.register_key, 'register_name_en', d.name_en, 'register_name_ar', d.name_ar,
      'label', public.reg_label(r.id), 'site_id', r.site_id, 'site_code', s.site_code, 'version', r.version, 'version_no', r.version_no,
      'voided_at', r.voided_at, 'voided_by', r.voided_by, 'voided_by_name', u.display_name, 'void_reason', r.void_reason,
      'restorable_until', r.voided_at + make_interval(days => days),
      'blocked', CASE
        WHEN EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = r.entity_id AND o.id <> r.id AND o.state IN ('entry', 'in_review', 'in_approval')) THEN 'open_version_exists'
        WHEN r.version_no = 1 AND r.register_key IN ('gecol', 'hlc') AND r.site_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.register_records o WHERE o.register_key = r.register_key AND o.site_id = r.site_id AND o.version_no = 1 AND o.state <> 'voided' AND o.id <> r.id) THEN 'site_slot_taken'
        ELSE NULL END) AS x
    FROM public.register_records r
    JOIN public.register_definitions d ON d.register_key = r.register_key
    LEFT JOIN public.sites s ON s.id = r.site_id
    LEFT JOIN public.users u ON u.id = r.voided_by
    WHERE r.state = 'voided' AND r.voided_at >= now() - make_interval(days => days)
    ORDER BY r.voided_at DESC LIMIT 500) q;
  RETURN jsonb_build_object('retention_days', days, 'version', public.settings_etag('recycle_bin.settings'), 'items', items);
END $$;

CREATE OR REPLACE FUNCTION admin_set_recycle_retention(p_days integer, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_days IS NULL OR p_days < 30 OR p_days > 730 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/retention_days', 'out_of_range', 'A whole number of days from 30 to 730.')));
  END IF;
  PERFORM 1 FROM public.settings WHERE key = 'recycle_bin.settings' FOR UPDATE;
  cur := jsonb_build_object('retention_days', (SELECT (value ->> 'retention_days')::integer FROM public.settings WHERE key = 'recycle_bin.settings'), 'version', public.settings_etag('recycle_bin.settings'));
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'retention_days')::integer = p_days THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The retention is already ' || p_days || ' days.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('retention_days', p_days), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'recycle_bin.settings';
  PERFORM public.log_audit_write('recycle_bin_retention_update', 'setting', 'recycle_bin.settings',
    jsonb_build_object('retention_days', (cur ->> 'retention_days')::integer), jsonb_build_object('retention_days', p_days), btrim(p_reason));
  res := jsonb_build_object('retention_days', p_days, 'version', public.settings_etag('recycle_bin.settings'));
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION admin_restore_register_record(p_record uuid, p_version integer, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; before jsonb; days integer;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'recycle bin: only a System Admin can restore' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_reason(p_reason);
  days := coalesce((SELECT (value ->> 'retention_days')::integer FROM public.settings WHERE key = 'recycle_bin.settings'), 90);
  SELECT * INTO r FROM public.register_records WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF r.state <> 'voided' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a voided record can be restored (it is ' || r.state || ').'));
  END IF;
  IF r.voided_at < now() - make_interval(days => days) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The retention of ' || days || ' days has passed; the record can no longer be restored.'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = r.entity_id AND o.id <> r.id AND o.state IN ('entry', 'in_review', 'in_approval')) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A newer open version of this record exists; restoring this one would make two open versions.'));
  END IF;
  IF r.version_no = 1 AND r.register_key IN ('gecol', 'hlc') AND r.site_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.register_records o WHERE o.register_key = r.register_key AND o.site_id = r.site_id AND o.version_no = 1 AND o.state <> 'voided' AND o.id <> r.id) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The site already has another record in this register; only one is allowed per site.'));
  END IF;
  before := public.reg_snap(p_record);
  UPDATE public.register_records SET state = 'entry', current_level = 1, voided_at = NULL, voided_by = NULL, void_reason = NULL,
    ball_in_court_user_id = NULL, level_opened_at = NULL, version = version + 1, updated_at = now() WHERE id = p_record;
  PERFORM public.reg_step(p_record, 1, 'edit', actor, 'Restored from the recycle bin: ' || btrim(p_reason), 'voided', 'entry', false, false);
  PERFORM public.reg_audit('register_record_restore', p_record, before, public.reg_snap(p_record), btrim(p_reason));
  RETURN jsonb_build_object('id', p_record, 'register_key', r.register_key, 'state', 'entry', 'version', r.version + 1);
END $$;

DROP TRIGGER IF EXISTS b_settings_recycle ON settings;
DROP TRIGGER IF EXISTS b_settings_recycle_update ON settings;
DROP TRIGGER IF EXISTS b_settings_recycle_delete ON settings;
CREATE TRIGGER b_settings_recycle BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'recycle_bin.settings') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_recycle_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'recycle_bin.settings' OR NEW.key = 'recycle_bin.settings') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_recycle_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'recycle_bin.settings') EXECUTE FUNCTION settings_guarded_keys();

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT, UPDATE ON register_records TO pmis_definer;
GRANT SELECT ON users, sites, register_definitions TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['recycle_bin_json()', 'admin_set_recycle_retention(integer,text,integer)', 'admin_restore_register_record(uuid,integer,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION recycle_bin_json(), admin_set_recycle_retention(integer, text, integer), admin_restore_register_record(uuid, integer, text) TO pmis_app;
  END IF;
END $$;
