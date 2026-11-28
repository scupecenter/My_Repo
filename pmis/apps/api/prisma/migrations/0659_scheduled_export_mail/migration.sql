-- 0659: Scheduled export, unattended run and mail (P7(b), contract 0.15.584). Additive: one settings key, three functions, patches in place of three existing
-- functions, one mail kind. No new table.
-- 0251 let a due schedule start only when its owner opened Exports. A schedule can now also be set to run unattended and to mail its owner:
--   * `unattended` (per schedule, set by its owner): an hourly API job starts the schedule when it is due, even if nobody is signed in. The job does not use a
--     session: it opens the transaction as the owner (via = job) and the normal start path derives the owner's grants and region rules live (app_begin), so a
--     lost grant, a deactivated account or the security lock `disable_export` stops the run and the error is recorded on the schedule.
--   * a system switch `export.unattended` (Settings > Data > Exports, System Admin, default OFF) must be ON for any unattended run.
--   * `mail` (per schedule): the owner gets a text mail (kind export_ready, no file attached) when the export is done or failed; the file stays behind the
--     owner's sign-in in Exports.
--   * a schedule may now export one register or Master view (`spec.view`, the same body as POST /exports/master) as well as parts and regions.

INSERT INTO settings (key, value, description, updated_at)
VALUES ('export.unattended', '{"enabled": false}'::jsonb, 'Scheduled exports (0659): whether schedules marked unattended may run without their owner signed in; changed only through admin_set_export_unattended.', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION export_unattended_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'export.unattended';
  RETURN jsonb_build_object('enabled', coalesce((s.value ->> 'enabled')::boolean, false), 'updated_at', s.updated_at, 'updated_by', s.updated_by,
    'version', public.settings_etag('export.unattended'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_export_unattended(p_enabled boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/enabled', 'invalid', 'true or false.')));
  END IF;
  PERFORM 1 FROM public.settings WHERE key = 'export.unattended' FOR UPDATE;
  cur := public.export_unattended_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'enabled')::boolean = p_enabled THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This value is already set.'));
  END IF;
  UPDATE public.settings SET value = jsonb_build_object('enabled', p_enabled), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'export.unattended';
  res := public.export_unattended_json();
  PERFORM public.log_audit_write('export_unattended_update', 'setting', 'export.unattended', jsonb_build_object('enabled', cur -> 'enabled'), jsonb_build_object('enabled', res -> 'enabled'), btrim(p_reason));
  RETURN res;
END $$;

DROP TRIGGER IF EXISTS b_settings_export_unattended ON settings;
DROP TRIGGER IF EXISTS b_settings_export_unattended_update ON settings;
DROP TRIGGER IF EXISTS b_settings_export_unattended_delete ON settings;
CREATE TRIGGER b_settings_export_unattended BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'export.unattended') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_export_unattended_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'export.unattended' OR NEW.key = 'export.unattended') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_export_unattended_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'export.unattended') EXECUTE FUNCTION settings_guarded_keys();

-- The hourly job asks which unattended schedules are due. Only the job (no signed-in actor) may call it; it answers nothing while the switch is OFF, and it
-- skips owners that are not active. It reads schedule metadata only.
CREATE OR REPLACE FUNCTION export_schedules_due_unattended() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NOT NULL THEN RAISE EXCEPTION 'job only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce((SELECT (value ->> 'enabled')::boolean FROM public.settings WHERE key = 'export.unattended'), false) THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', x ->> 'id', 'owner_id', x ->> 'owner_id', 'name', x ->> 'name', 'spec', x -> 'spec', 'mail', coalesce((x ->> 'mail')::boolean, false),
      'next_due_at', public.export_schedule_next(x, coalesce((x ->> 'last_started_at')::timestamptz, (x ->> 'created_at')::timestamptz))) ORDER BY x ->> 'created_at')
    FROM public.settings s, jsonb_array_elements(s.value -> 'items') x
    WHERE s.key = 'master_export.schedules' AND coalesce((x ->> 'enabled')::boolean, false) AND coalesce((x ->> 'unattended')::boolean, false)
      AND now() >= public.export_schedule_next(x, coalesce((x ->> 'last_started_at')::timestamptz, (x ->> 'created_at')::timestamptz))
      AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (x ->> 'owner_id')::uuid AND u.status = 'active' AND u.deleted_at IS NULL)), '[]'::jsonb);
END $$;

-- export_schedule_save accepts mail, unattended and spec.view (patched in place; each patch is applied once)
DO $$
DECLARE def text; a text; b text; c text;
BEGIN
  def := pg_get_functiondef('public.export_schedule_save(jsonb)'::regprocedure);
  IF position('unattended' IN def) = 0 THEN
    a := '''spec'', ''enabled'') THEN';
    b := 'IF k NOT IN (''parts'', ''regions'') THEN';
    c := '''enabled'', coalesce((p_item ->> ''enabled'')::boolean, true),';
    IF (length(def) - length(replace(def, a, ''))) / length(a) <> 1 THEN RAISE EXCEPTION 'export_schedule_save: the key list was not found'; END IF;
    IF (length(def) - length(replace(def, b, ''))) / length(b) <> 1 THEN RAISE EXCEPTION 'export_schedule_save: the spec key list was not found'; END IF;
    IF (length(def) - length(replace(def, c, ''))) / length(c) <> 1 THEN RAISE EXCEPTION 'export_schedule_save: the item object was not found'; END IF;
    def := replace(def, a, '''spec'', ''enabled'', ''mail'', ''unattended'') THEN');
    def := replace(def, b, 'IF k NOT IN (''parts'', ''regions'', ''view'') THEN');
    def := replace(def, c, c || E'\n    ''mail'', coalesce((p_item ->> ''mail'')::boolean, false), ''unattended'', coalesce((p_item ->> ''unattended'')::boolean, false),');
    a := 'IF p_item ? ''enabled'' AND jsonb_typeof(p_item -> ''enabled'') <> ''boolean'' THEN';
    IF (length(def) - length(replace(def, a, ''))) / length(a) <> 1 THEN RAISE EXCEPTION 'export_schedule_save: the enabled check was not found'; END IF;
    def := replace(def, a, 'IF (p_item ? ''mail'' AND jsonb_typeof(p_item -> ''mail'') <> ''boolean'') OR (p_item ? ''unattended'' AND jsonb_typeof(p_item -> ''unattended'') <> ''boolean'') THEN
    PERFORM public.wf_err(''validation_failed'', jsonb_build_object(''errors'', public.reg_err_item(''/mail'', ''invalid'', ''true or false.'')));
  END IF;
  ' || a);
    EXECUTE def;
  END IF;
END $$;

-- the mail kind (Settings > Notifications > Mail kinds lists it; patched in place so a later redefinition of the list is not undone)
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.mail_kind_catalogue()'::regprocedure);
  IF position('''export_ready''' IN def) = 0 THEN
    IF def !~ E'\\n\\s*\\]\\) WITH ORDINALITY' THEN RAISE EXCEPTION 'mail_kind_catalogue: the end of the kind list was not found'; END IF;
    def := regexp_replace(def, E'(\\n\\s*)\\]\\) WITH ORDINALITY', E',\\1  ''export_ready''\\1]) WITH ORDINALITY');
    EXECUTE def;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['export_unattended_json()', 'admin_set_export_unattended(boolean,text,integer)', 'export_schedules_due_unattended()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION export_unattended_json(), admin_set_export_unattended(boolean, text, integer), export_schedules_due_unattended() TO pmis_app;
  END IF;
END $$;
