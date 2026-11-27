-- 0381_register_state_control: the admin switches a whole register on or off and locks it, from Settings (audit item 1 of the 2026-11-27 relations review).
-- Mirror: db/sql/380_register_state_control.sql (kept identical).
--
--   Until now only a migration could change register_definitions.enabled; there was no lock. Every reader already hides a disabled register (the register
--   list, the definition, the Matrix, the schedules), so DISABLE here means HIDE: no record, step, template or history is touched, and enabling it again restores
--   everything. LOCK keeps the register visible and readable but refuses every new record and every change to a record (screen, upload, workflow step, derive)
--   until it is unlocked; like the record and column locks of 0103, System Admins, the Settings data reset (pmis_reset_owner) and the migration role are exempt.
--
--   1. register_definitions.locked, state_reason, state_changed_at, state_changed_by.
--   2. reg_state_json(): every register INCLUDING the disabled ones (the register picker of Settings lists enabled registers only, so a disabled register
--      could not be switched back on from it), with record counts.
--   3. admin_register_state(register, enabled, locked, reason, version): System Admin or a delegate of fields.edit for ALL regions (the gate of the register
--      rename: no permission is widened), a reason, the ETag, audited with before and after. A register nothing can use is refused: the System Admin gate is the
--      only way back, so a lock/disable never removes the control itself.
--   4. Triggers register_records_lock and snags_register_lock: refuse INSERT/UPDATE of a record (or a linked QC snag) of a locked register (403 register_locked, the code of the record/column locks of 0103).
--
-- Additive: one table gains four columns with defaults (enabled and unlocked, the current behaviour), two functions, one trigger. No data changes.
SELECT set_config('app.region_ids', '*', true);

ALTER TABLE register_definitions
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS state_reason text,
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS state_changed_by uuid;
COMMENT ON COLUMN register_definitions.locked IS '0381: read only. No new record and no change to a record until unlocked in Settings; the data reset is exempt.';

CREATE OR REPLACE FUNCTION reg_state_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  RETURN jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'register_key', d.register_key, 'name_en', d.name_en, 'name_ar', d.name_ar, 'module_key', d.module_key, 'enabled', d.enabled, 'locked', d.locked,
      'reason', d.state_reason, 'changed_at', d.state_changed_at, 'version', d.version,
      'records', (SELECT count(*) FROM public.register_records r WHERE r.register_key = d.register_key AND r.is_current AND r.state <> 'voided')
    ) ORDER BY d.sort_order, d.register_key)
    FROM public.register_definitions d WHERE d.is_active AND d.kind = 'register'), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION admin_register_state(p_register text, p_enabled boolean, p_locked boolean, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE old_d public.register_definitions%ROWTYPE; d public.register_definitions%ROWTYPE;
BEGIN
  PERFORM public.calc_require_admin('fields', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_enabled IS NULL AND p_locked IS NULL THEN
    PERFORM public.rcol_err('/', 'required', 'Say what to change: enabled, locked or both.');
  END IF;
  SELECT * INTO old_d FROM public.register_definitions WHERE register_key = p_register AND is_active AND kind = 'register' FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> old_d.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The register changed since you read it. Reload and try again.'));
  END IF;
  UPDATE public.register_definitions
     SET enabled = coalesce(p_enabled, enabled), locked = coalesce(p_locked, locked), state_reason = btrim(p_reason),
         state_changed_at = now(), state_changed_by = public.app_actor(), version = version + 1
   WHERE register_key = p_register RETURNING * INTO d;
  PERFORM public.log_audit_write('register_state', 'register', p_register,
    jsonb_build_object('enabled', old_d.enabled, 'locked', old_d.locked), jsonb_build_object('enabled', d.enabled, 'locked', d.locked), p_reason);
  RETURN jsonb_build_object('register_key', d.register_key, 'enabled', d.enabled, 'locked', d.locked, 'reason', d.state_reason, 'changed_at', d.state_changed_at, 'version', d.version);
END $$;

-- The lock (the triggers run as the writer, so they cannot be definer; two definer helpers read the definitions). Every register stores its records in register_records (the Procurement, GECOL, HLC, Permits, Warehouse and Car Dispatcher tables
-- procurement_records, gecol_records, hlc_records, permit_records, wh_movements, wh_movement_lines, vehicle_reservations are projections written by the reg_*
-- functions in the same statement as the register_records row, so refusing that row refuses the projection too). The only register data with its own writers is
-- the QC snag (snags, linked to a Quality record by register_entity_id): it gets the same guard through the register of its linked record.
-- helpers (definer: they read register_definitions / register_records whatever role the writer has)
CREATE OR REPLACE FUNCTION register_is_locked(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = p_key AND d.locked)
$$;
CREATE OR REPLACE FUNCTION register_of_entity(p_entity uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.register_key FROM public.register_records r WHERE r.entity_id = p_entity AND r.is_current LIMIT 1
$$;

-- the triggers run as the writer (like reg_backstop), so current_user is the reset role during a Settings data reset
CREATE OR REPLACE FUNCTION register_records_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'pmis_reset_owner' OR (SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user) OR coalesce(public.app_actor_is_system_admin(), false) THEN RETURN NEW; END IF;
  IF public.register_is_locked(NEW.register_key) THEN
    PERFORM public.wf_err('register_locked', jsonb_build_object('detail', 'This register is locked in Settings: unlock it to add or change records.', 'register_key', NEW.register_key));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS register_records_lock ON register_records;
CREATE TRIGGER register_records_lock BEFORE INSERT OR UPDATE ON register_records FOR EACH ROW EXECUTE FUNCTION register_records_lock();

CREATE OR REPLACE FUNCTION snags_register_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text;
BEGIN
  IF NEW.register_entity_id IS NULL THEN RETURN NEW; END IF;
  IF current_user = 'pmis_reset_owner' OR (SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user) OR coalesce(public.app_actor_is_system_admin(), false) THEN RETURN NEW; END IF;
  k := public.register_of_entity(NEW.register_entity_id);
  IF k IS NOT NULL AND public.register_is_locked(k) THEN
    PERFORM public.wf_err('register_locked', jsonb_build_object('detail', 'The register of this snag is locked in Settings: unlock it to add or change its snags.', 'register_key', k));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS snags_register_lock ON snags;
CREATE TRIGGER snags_register_lock BEFORE INSERT OR UPDATE ON snags FOR EACH ROW EXECUTE FUNCTION snags_register_lock();

-- the two helpers are harmless booleans called by the triggers under whatever role writes: executable by everyone, owned by the definer
ALTER FUNCTION register_is_locked(text) OWNER TO pmis_definer;
ALTER FUNCTION register_of_entity(uuid) OWNER TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['reg_state_json()', 'admin_register_state(text,boolean,boolean,text,integer)', 'register_records_lock()', 'snags_register_lock()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION reg_state_json() TO pmis_app;
    GRANT EXECUTE ON FUNCTION admin_register_state(text, boolean, boolean, text, integer) TO pmis_app;
  END IF;
END $$;
