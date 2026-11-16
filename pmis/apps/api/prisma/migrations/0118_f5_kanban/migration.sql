-- 0118_f5_kanban: the sites board by milestone and the tasks board by approval state (F5 of the features build plan of 2026-11-14,
-- owner-approved; contract 0.15.32, CHANGELOG 156).
-- Mirror: db/sql/117_f5_kanban.sql (kept byte-identical).
--
-- Both boards are read only. The API builds them from tables the application role already reads (sites, stage_definitions,
-- task_instances, status_transitions of 0098, external_parties) with row security and the caller's regions (B3); nothing here changes a
-- state, a holder or a date, and no new task or site door is added. A card dropped on the tasks board only opens the existing action of
-- the task in the client (submit, review, approve, reject), which the existing doors check again. This migration adds only:
--   1. The WIP limits of the sites board: the setting `kanban.wip_limits`, an object {"<stage code>": <limit>} keyed by the stable stage
--      code (ADR 0010, so a rename never breaks it). Default {} = no limit on any column. A limit is a warning only: a column with more
--      cards than its limit is marked in the board, nothing is ever blocked (build plan, "no automation"). Read by every signed-in user
--      (kanban_wip_json); changed by a System Admin or a delegate of `settings` edit for all regions, with a reason and If-Match
--      (settings_etag), audited as kanban_wip_limits_update with before and after (admin_set_kanban_wip_limits, the rule of 0075). The
--      key is guarded against direct writes like the keys of 0072 and 0075.
--   2. The saved views of the tasks board: the screen `tasks-board` (module sites) in sv_screen_module (redefined from 0082, the latest
--      definition, with the addition marked "0118"). Its filter whitelist is the one of `site-tasks` (FilterCatalogService).
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. pmis_app
-- gets kanban_wip_json (read) and admin_set_kanban_wip_limits (the audited settings door, refused by the database to anyone but a System
-- Admin or an all-regions settings delegate). No new table and no new table right.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The WIP limits of the sites board
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at)
VALUES ('kanban.wip_limits', '{}'::jsonb,
        'Sites board (F5, 0118): the WIP limit of each milestone column, {"<stage code>": n}. A warning only, never a block. Empty = no limit. Changed in Settings, Workflow, Board.', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION kanban_wip_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; v jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'kanban.wip_limits';
  v := CASE WHEN jsonb_typeof(s.value) = 'object' THEN s.value ELSE '{}'::jsonb END;
  RETURN jsonb_build_object('limits', v, 'min', 1, 'max', 10000,
    'updated_at', s.updated_at, 'updated_by', s.updated_by, 'version', public.settings_etag('kanban.wip_limits'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_kanban_wip_limits(p_limits jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb; k text; val jsonb; n integer; clean jsonb := '{}'::jsonb;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_limits IS NULL OR jsonb_typeof(p_limits) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/limits', 'invalid', 'An object of stage code to limit.')));
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_limits)) > 100 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/limits', 'too_many', 'At most 100 columns.')));
  END IF;
  FOR k, val IN SELECT x.key, x.value FROM jsonb_each(p_limits) x LOOP
    IF k !~ '^[A-Z][A-Z0-9_]{0,30}$' OR NOT EXISTS (SELECT 1 FROM public.stage_definitions sd WHERE sd.code = k) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/limits/' || left(k, 40), 'unknown_stage', 'Not a milestone of a workflow version.')));
    END IF;
    IF val = 'null'::jsonb THEN CONTINUE; END IF; -- null = no limit for this column
    IF jsonb_typeof(val) <> 'number' OR (val #>> '{}') !~ '^[0-9]{1,5}$' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/limits/' || k, 'out_of_range', 'A whole number from 1 to 10000.')));
    END IF;
    n := (val #>> '{}')::integer;
    IF n < 1 OR n > 10000 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/limits/' || k, 'out_of_range', 'A whole number from 1 to 10000.')));
    END IF;
    clean := clean || jsonb_build_object(k, n);
  END LOOP;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('kanban.wip_limits', '{}'::jsonb, 'Sites board (F5, 0118): the WIP limit of each milestone column. A warning only.', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'kanban.wip_limits' FOR UPDATE;
  cur := public.kanban_wip_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur -> 'limits') = clean THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The WIP limits are already these.'));
  END IF;
  UPDATE public.settings SET value = clean, updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'kanban.wip_limits';
  res := public.kanban_wip_json();
  PERFORM public.log_audit_write('kanban_wip_limits_update', 'setting', 'kanban.wip_limits',
    jsonb_build_object('limits', cur -> 'limits', 'updated_at', cur -> 'updated_at', 'updated_by', cur -> 'updated_by'),
    jsonb_build_object('limits', res -> 'limits', 'updated_at', res -> 'updated_at', 'updated_by', res -> 'updated_by'), btrim(p_reason));
  RETURN res;
END $$;

-- The key changes only through admin_set_kanban_wip_limits (the guard function of 0072; an UPDATE is guarded on the old and the new key).
DROP TRIGGER IF EXISTS b_settings_kanban_wip ON settings;
DROP TRIGGER IF EXISTS b_settings_kanban_wip_update ON settings;
DROP TRIGGER IF EXISTS b_settings_kanban_wip_delete ON settings;
CREATE TRIGGER b_settings_kanban_wip BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'kanban.wip_limits') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_kanban_wip_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'kanban.wip_limits' OR NEW.key = 'kanban.wip_limits') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_kanban_wip_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'kanban.wip_limits') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The saved views of the tasks board (screen tasks-board, module sites)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sv_screen_module(p_screen text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_screen IS NULL THEN RETURN NULL; END IF;
  IF p_screen ~ '^register-[a-z0-9_]{2,60}$' THEN
    RETURN (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = substr(p_screen, 10) AND d.is_active);
  END IF;
  RETURN CASE p_screen
    WHEN 'sites' THEN 'sites'
    WHEN 'sites-stream' THEN 'sites'
    WHEN 'site-tasks' THEN 'sites'
    WHEN 'tasks-board' THEN 'sites' -- 0118 (F5)
    WHEN 'audit-log' THEN 'audit'
    WHEN 'field-changes' THEN 'audit'
    WHEN 'security-log' THEN 'admin.security_log'
    WHEN 'system-log' THEN 'admin.system_log'
    ELSE NULL END;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['kanban_wip_json()', 'admin_set_kanban_wip_limits(jsonb,text,integer)', 'sv_screen_module(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION kanban_wip_json(), admin_set_kanban_wip_limits(jsonb, text, integer) TO pmis_app;
  END IF;
END $$;
