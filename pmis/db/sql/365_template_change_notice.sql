-- 0366 (P3): "the template changed" notice, IN-APP ONLY. Additive: one setting and one function; no table, no record, no permission changes.
--
-- WHAT. template_change_notify() writes an in-app notice to the people who hold the ENTRY level (Matrix level 1) of a register when its template has a new version
-- (a column added, removed or renamed; tpl_sync already issues the version). The notice says which version is current and how many columns were added, removed or renamed,
-- and links to the Templates page, where "What changed" shows the columns. The daily job calls it. Nothing is deleted or hidden; old versions stay in template_versions.
-- SETTING. `templates.change_notice` = {"enabled": true, "days": 14}: whether the notice is written, and for how many days after a version is issued a person who was not yet
-- notified (for example somebody just added to the Matrix row) still gets it. (A Settings screen row for it is still to do in this PR.)
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
