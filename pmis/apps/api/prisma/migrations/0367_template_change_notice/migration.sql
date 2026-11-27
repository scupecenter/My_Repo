-- 0367 (P3): "the template changed" notice, IN-APP ONLY. Additive: one setting and one function; no table, no record, no permission changes.
--
-- WHAT. template_change_notify() writes an in-app notice to the people who hold the ENTRY level (Matrix level 1) of a register when its template has a new version
-- (a column added, removed or renamed; tpl_sync already issues the version). The notice says which version is current and how many columns were added, removed or renamed,
-- and links to the Templates page, where "What changed" shows the columns. The daily job calls it. Nothing is deleted or hidden; old versions stay in template_versions.
-- SETTING. `templates.change_notice` = {"enabled": true, "days": 14}: whether the notice is written, and for how many days after a version is issued a person who was not yet
-- notified (for example somebody just added to the Matrix row) still gets it. Settings > Imports > Template change notice (admin_set_template_change_notice, audited).
-- ONE NOTICE PER VERSION PER PERSON: the version number is in the title. Registers' templates only (kind register); stream, master and site templates are not covered.
-- E-MAIL. The kind `template_changed` is mailed only if an admin adds it to the setting mail.notification_kinds; until then it is in the bell only.
-- SAFE TO REPEAT. Returns the number of notices written.

INSERT INTO settings (key, value, description, updated_at)
VALUES ('templates.change_notice', '{"enabled": true, "days": 14}'::jsonb,
        'P3: in-app notice to the entry holders of a register when its template gets a new version (enabled, and how many days after the version is issued people are still told).', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION template_change_notify() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cfg jsonb; days integer; v record; c record; u record; prev jsonb; added integer; removed integer; renamed integer; v_title text; v_body text; n integer := 0; rows_n integer;
BEGIN
  SELECT value INTO cfg FROM public.settings WHERE key = 'templates.change_notice';
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' OR coalesce((cfg ->> 'enabled')::boolean, true) IS NOT TRUE THEN RETURN 0; END IF;
  days := least(greatest(coalesce(nullif(cfg ->> 'days', '')::integer, 14), 1), 365);
  FOR v IN
    SELECT d.id AS def, d.template_id, d.register_key, v.version, v.columns, v.published_at
    FROM public.template_definitions d JOIN public.template_versions v ON v.template_def_id = d.id AND v.is_current
    WHERE d.is_active AND d.kind = 'register' AND d.register_key IS NOT NULL AND v.version > 1 AND v.published_at >= now() - make_interval(days => days)
  LOOP
    SELECT p.columns INTO prev FROM public.template_versions p WHERE p.template_def_id = v.def AND p.version = v.version - 1;
    prev := coalesce(prev, '[]'::jsonb);
    SELECT count(*) INTO added FROM jsonb_array_elements(v.columns) a WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prev) b WHERE b ->> 'code' = a ->> 'code');
    SELECT count(*) INTO removed FROM jsonb_array_elements(prev) b WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.columns) a WHERE a ->> 'code' = b ->> 'code');
    SELECT count(*) INTO renamed FROM jsonb_array_elements(v.columns) a JOIN jsonb_array_elements(prev) b ON b ->> 'code' = a ->> 'code' AND b ->> 'label' IS DISTINCT FROM a ->> 'label';
    v_title := 'Template ' || v.template_id || ' is now v' || v.version::text;
    v_body := 'Download the new version before you fill it: ' || added::text || ' column(s) added, ' || removed::text || ' removed, ' || renamed::text || ' renamed. Open Templates and press "What changed".';
    FOR c IN SELECT m.id, m.region_id FROM public.matrix_cells m WHERE m.register_key = v.register_key AND m.level = 1 LOOP
      FOR u IN SELECT DISTINCT e.user_id FROM public.reg_eligible_cell(c.id, c.region_id, public.reg_module(v.register_key), 'entry') e LOOP
        INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
        SELECT u.user_id, 'in_app', 'template_changed', v_title, v_body, '/templates'
        WHERE NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = u.user_id AND nt.kind = 'template_changed' AND nt.title = v_title);
        GET DIAGNOSTICS rows_n = ROW_COUNT;
        n := n + rows_n;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN n;
END $$;

GRANT SELECT ON settings, template_definitions, template_versions, matrix_cells, matrix_cell_assignees TO pmis_definer;
GRANT SELECT, INSERT ON notifications TO pmis_definer;

DO $$
BEGIN
  ALTER FUNCTION template_change_notify() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION template_change_notify() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION template_change_notify() TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION template_change_notify() TO pmis_app;
  END IF;
END $$;

-- SETTINGS DOORS. The setting changes only through admin_set_template_change_notice (reason, version, audit), like imports.async_rows (0074/0075).
CREATE OR REPLACE FUNCTION template_change_notice_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; en boolean; dy int;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'templates.change_notice';
  BEGIN en := (s.value ->> 'enabled')::boolean; EXCEPTION WHEN others THEN en := NULL; END;
  BEGIN dy := (s.value ->> 'days')::int; EXCEPTION WHEN others THEN dy := NULL; END;
  RETURN jsonb_build_object('enabled', coalesce(en, true), 'days', coalesce(dy, 14), 'default_days', 14, 'min', 1, 'max', 365,
    'updated_at', s.updated_at, 'updated_by', s.updated_by, 'version', public.settings_etag('templates.change_notice'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_template_change_notice(p_enabled boolean, p_days integer, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/days', 'out_of_range', 'A whole number from 1 to 365.')));
  END IF;
  IF p_enabled IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/enabled', 'required', 'Yes or no.')));
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('templates.change_notice', '{"enabled": true, "days": 14}'::jsonb, 'P3: in-app notice when a register template gets a new version.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'templates.change_notice' FOR UPDATE;
  cur := public.template_change_notice_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'enabled')::boolean = p_enabled AND (cur ->> 'days')::int = p_days THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'These values are already set.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('enabled', p_enabled, 'days', p_days), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'templates.change_notice';
  res := public.template_change_notice_json();
  PERFORM public.log_audit_write('template_change_notice_update', 'setting', 'templates.change_notice',
    jsonb_build_object('enabled', cur -> 'enabled', 'days', cur -> 'days'), jsonb_build_object('enabled', res -> 'enabled', 'days', res -> 'days'), btrim(p_reason));
  RETURN res;
END $$;

DROP TRIGGER IF EXISTS b_settings_tpl_change ON settings;
DROP TRIGGER IF EXISTS b_settings_tpl_change_update ON settings;
DROP TRIGGER IF EXISTS b_settings_tpl_change_delete ON settings;
CREATE TRIGGER b_settings_tpl_change BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'templates.change_notice') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_tpl_change_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'templates.change_notice' OR NEW.key = 'templates.change_notice') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_tpl_change_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'templates.change_notice') EXECUTE FUNCTION settings_guarded_keys();

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['template_change_notice_json()', 'admin_set_template_change_notice(boolean, integer, text, integer)'] LOOP
    EXECUTE 'ALTER FUNCTION ' || f || ' OWNER TO pmis_definer';
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO pmis_definer';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO pmis_app'; END IF;
  END LOOP;
END $$;
