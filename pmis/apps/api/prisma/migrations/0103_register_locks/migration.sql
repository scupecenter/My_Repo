-- 0103: register locks (owner request 2026-11-15, F16): a record or a column of a register can be locked; a locked row or column is read-only
-- for everyone except System Admins.
--
-- WHY. The grid shows what the register holds, but the owner needs approved or agreed rows and whole columns to stay fixed without a
-- System Admin changing the data by hand. A lock is an explicit, audited decision with a reason, not a state the workflow infers.
--
-- WHAT THIS ADDS
--   register_record_locks       one open lock per record (unlocked_at IS NULL); the lock and its unlock are both kept, with who and why
--   register_column_locks       one open lock per register column (field_code); same rules
--   reg_lock_check(...)         internal: refuses a write that touches a locked record or a locked column (403 register_locked); System Admins exempt
--   reg_record_lock_set(...)    the administer grant of the register (reg_require_grant) locks or unlocks one record, at the record version; a reason is required
--   reg_column_lock_set(...)    the administer grant in every region locks or unlocks one column; a reason is required
--   reg_save_record             the 9-argument writer of 0026, byte-identical except for two reg_lock_check calls (create and edit)
--   reg_void_record             the writer of 0019, byte-identical except for one reg_lock_check call (a locked record cannot be voided)
--   reg_transition_record       the dispatcher of 0019 with one reg_lock_check call: a locked record takes no submit, review, approve or reject step for non-admins
-- Every lock and unlock is audited with before and after and the reason. Step-up is required by the API for both lock routes (x-step-up).
-- A locked column refuses only a value that changes the stored value (an unchanged value resent with the form is accepted).
-- Only the definer functions write the lock tables (reg_backstop); pmis_app reads them.

CREATE TABLE register_record_locks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     uuid NOT NULL REFERENCES register_records (id) ON DELETE RESTRICT,
  register_key  text NOT NULL,
  reason        text NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  locked_by     uuid NOT NULL,
  locked_at     timestamptz NOT NULL DEFAULT now(),
  unlocked_by   uuid,
  unlocked_at   timestamptz,
  unlock_reason text,
  CONSTRAINT register_record_locks_unlock_pair CHECK ((unlocked_at IS NULL) = (unlocked_by IS NULL))
);
CREATE UNIQUE INDEX register_record_locks_open_idx ON register_record_locks (record_id) WHERE unlocked_at IS NULL;
CREATE INDEX register_record_locks_register_idx ON register_record_locks (register_key);

CREATE TABLE register_column_locks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_key  text NOT NULL,
  field_code    text NOT NULL,
  reason        text NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  locked_by     uuid NOT NULL,
  locked_at     timestamptz NOT NULL DEFAULT now(),
  unlocked_by   uuid,
  unlocked_at   timestamptz,
  unlock_reason text,
  CONSTRAINT register_column_locks_field_fkey FOREIGN KEY (register_key, field_code) REFERENCES register_fields (register_key, code) ON DELETE RESTRICT,
  CONSTRAINT register_column_locks_unlock_pair CHECK ((unlocked_at IS NULL) = (unlocked_by IS NULL))
);
CREATE UNIQUE INDEX register_column_locks_open_idx ON register_column_locks (register_key, field_code) WHERE unlocked_at IS NULL;

CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON register_record_locks FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON register_column_locks FOR EACH ROW EXECUTE FUNCTION reg_backstop();

-- The check. A write with no record id (a create) is checked for the columns only. A column is locked for this write when the write sets a value that differs from the stored one.
CREATE OR REPLACE FUNCTION reg_lock_check(p_key text, p_record uuid, p_data jsonb, p_custom jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); cur public.register_records%ROWTYPE; hit text;
BEGIN
  IF public.app_user_is_system_admin(actor) THEN RETURN; END IF;
  IF p_record IS NOT NULL THEN
    SELECT * INTO cur FROM public.register_records WHERE id = p_record;
    IF EXISTS (SELECT 1 FROM public.register_record_locks l WHERE l.record_id = p_record AND l.unlocked_at IS NULL) THEN
      PERFORM public.wf_err('register_locked', jsonb_build_object('scope', 'record', 'detail', 'This record is locked: only a System Admin can change it until it is unlocked.'));
    END IF;
  END IF;
  SELECT c.field_code INTO hit FROM public.register_column_locks c
   WHERE c.register_key = p_key AND c.unlocked_at IS NULL
     AND ((p_data IS NOT NULL AND p_data ? c.field_code AND (cur.id IS NULL OR p_data -> c.field_code IS DISTINCT FROM cur.data -> c.field_code))
       OR (p_custom IS NOT NULL AND p_custom ? c.field_code AND (cur.id IS NULL OR p_custom -> c.field_code IS DISTINCT FROM cur.custom -> c.field_code)))
   ORDER BY c.field_code LIMIT 1;
  IF hit IS NOT NULL THEN
    PERFORM public.wf_err('register_locked', jsonb_build_object('scope', 'column', 'field', hit, 'detail', 'This column is locked for every record of the register: only a System Admin can change it until it is unlocked.'));
  END IF;
END $$;

-- Lock or unlock one record. The record version guards the read (reg_lock); the lock does not change the record version.
CREATE OR REPLACE FUNCTION reg_record_lock_set(p_record uuid, p_version int, p_locked boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; was boolean;
BEGIN
  r := public.reg_lock(p_record, p_version);
  IF coalesce(btrim(p_reason), '') = '' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required', 'A reason is required.')));
  END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'administer');
  was := EXISTS (SELECT 1 FROM public.register_record_locks l WHERE l.record_id = p_record AND l.unlocked_at IS NULL);
  IF p_locked AND was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This record is already locked.')); END IF;
  IF NOT p_locked AND NOT was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This record is not locked.')); END IF;
  IF p_locked THEN
    INSERT INTO public.register_record_locks (record_id, register_key, reason, locked_by) VALUES (p_record, r.register_key, p_reason, actor);
  ELSE
    UPDATE public.register_record_locks SET unlocked_by = actor, unlocked_at = now(), unlock_reason = p_reason WHERE record_id = p_record AND unlocked_at IS NULL;
  END IF;
  PERFORM public.reg_audit(CASE WHEN p_locked THEN 'register_record_lock' ELSE 'register_record_unlock' END, p_record,
    jsonb_build_object('locked', was), jsonb_build_object('locked', p_locked), p_reason);
END $$;

-- Lock or unlock one column of a register for every record. Only an administer grant that covers every region can do it: a column is shared by all regions.
CREATE OR REPLACE FUNCTION reg_column_lock_set(p_key text, p_code text, p_locked boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); was boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = p_key AND f.code = p_code) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This column does not exist in this register.'));
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required', 'A reason is required.')));
  END IF;
  PERFORM public.reg_require_grant(p_key, NULL, 'administer');
  IF public.wf_actor_regions(public.reg_module(p_key), 'administer') IS NOT NULL THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'A column lock covers every region: it needs administer in all regions.'));
  END IF;
  was := EXISTS (SELECT 1 FROM public.register_column_locks c WHERE c.register_key = p_key AND c.field_code = p_code AND c.unlocked_at IS NULL);
  IF p_locked AND was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This column is already locked.')); END IF;
  IF NOT p_locked AND NOT was THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This column is not locked.')); END IF;
  IF p_locked THEN
    INSERT INTO public.register_column_locks (register_key, field_code, reason, locked_by) VALUES (p_key, p_code, p_reason, actor);
  ELSE
    UPDATE public.register_column_locks SET unlocked_by = actor, unlocked_at = now(), unlock_reason = p_reason
      WHERE register_key = p_key AND field_code = p_code AND unlocked_at IS NULL;
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (CASE WHEN p_locked THEN 'register_column_lock' ELSE 'register_column_unlock' END, 'register_column', p_key || '.' || p_code, NULL, NULL,
    jsonb_build_object('locked', was), jsonb_build_object('locked', p_locked), p_reason, actor);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The writers, with the lock check (copies of 0026 and 0019; the only changes are the lines marked by reg_lock_check).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_save_record(p_key text, p_id uuid, p_version int, p_site uuid, p_record_type text, p_data jsonb, p_custom jsonb, p_party uuid, p_clear_party boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); d public.register_definitions%ROWTYPE; s public.sites%ROWTYPE; r public.register_records%ROWTYPE; rid uuid; before jsonb;
  clean jsonb; cnt int; pin uuid; ent uuid; existing uuid; regs int[]; no_site boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_key AND is_active AND enabled;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register is not available.')); END IF;
  IF p_party IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.external_parties x WHERE x.id = p_party AND x.is_active) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/external_party_id', 'unknown_party', 'Unknown or inactive external party.')));
  END IF;
  IF p_record_type IS NOT NULL AND NOT (p_record_type = ANY (d.record_types)) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/record_type', 'not_in_list', 'Not a record type of this register.')));
  END IF;
  no_site := NOT d.site_scoped OR coalesce(p_record_type = ANY (d.site_optional_types), false);

  IF p_id IS NULL THEN
    -- create
    IF NOT no_site THEN
      IF p_site IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'required', 'The site is required.'))); END IF;
      SELECT * INTO s FROM public.sites WHERE id = p_site AND public.app_region_check(region_id);
      IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
      regs := public.wf_actor_regions(d.module_key, 'view');
      IF regs IS NOT NULL AND NOT (s.region_id = ANY (regs)) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
      PERFORM public.reg_require_grant(p_key, s.region_id, 'create');
      IF NOT public.reg_scope_ok(p_key, s.id) THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'scope_conflict', 'The site scope says N/A for this register (DQ07).')));
      END IF;
      IF NOT d.multiple_per_site THEN
        SELECT x.id INTO existing FROM public.register_records x WHERE x.register_key = p_key AND x.site_id = s.id AND x.version_no = 1 AND x.state <> 'voided';
        IF existing IS NOT NULL THEN PERFORM public.wf_err('duplicate', jsonb_build_object('existing_id', existing, 'detail', 'This site already has a ' || d.name_en || ' record: create a new version of it (Q55).')); END IF;
      END IF;
    ELSE
      IF p_site IS NOT NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/site_id', 'not_site_scoped', 'This register has no site.'))); END IF;
      PERFORM public.reg_require_grant(p_key, NULL, 'create');
    END IF;
    PERFORM public.reg_lock_check(p_key, NULL, p_data, p_custom);
    -- Q56 ownership: the entry holders of the register's own row (the System Admins when the row has nobody, B10)
    IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, s.region_id) h WHERE h.user_id = actor)
            OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, s.region_id)))) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not an entry holder of the ' || d.name_en || ' row of the Matrix.'));
    END IF;
    clean := public.reg_clean_data(p_key, p_data);
    ent := gen_random_uuid();
    SELECT count(*) INTO cnt FROM public.reg_entry_holders(p_key, s.region_id);
    INSERT INTO public.register_records (entity_id, register_key, record_type, site_id, region_id, is_global, levels_required, data, custom, external_party_id, ball_in_court_user_id, created_by, level_opened_at)
    VALUES (ent, p_key, p_record_type, s.id, s.region_id, no_site, d.approval_levels, public.reg_merge_data('{}'::jsonb, clean), coalesce(p_custom, '{}'::jsonb), p_party,
            CASE WHEN cnt > 1 THEN actor END, actor, now())
    RETURNING id INTO rid;
    PERFORM public.reg_step(rid, 1, 'create', actor, NULL, NULL, 'entry', false, false);
    PERFORM public.reg_audit('register_record_create', rid, NULL, public.reg_snap(rid), NULL);
    RETURN rid;
  END IF;

  -- edit
  r := public.reg_lock(p_id, p_version);
  IF r.register_key <> p_key THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The record does not exist or is not visible to you.')); END IF;
  IF r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A record can be edited only while it is in entry (it is ' || r.state || '): create a new version to change an approved record.'));
  END IF;
  PERFORM public.reg_require_grant(p_key, r.region_id, 'edit');
  PERFORM public.reg_lock_check(p_key, p_id, p_data, p_custom);
  PERFORM public.reg_require_actor(p_id, 'entry', actor);
  clean := public.reg_clean_data(p_key, p_data);
  before := public.reg_snap(p_id);
  SELECT count(*) INTO cnt FROM public.reg_eligible(p_id, 'entry');
  pin := CASE WHEN r.ball_in_court_user_id IS NULL AND cnt > 1 THEN actor ELSE r.ball_in_court_user_id END;
  UPDATE public.register_records SET
    data = public.reg_merge_data(data, clean),
    custom = CASE WHEN p_custom IS NOT NULL THEN jsonb_strip_nulls(custom || p_custom) ELSE custom END,
    external_party_id = CASE WHEN p_clear_party THEN NULL WHEN p_party IS NOT NULL THEN p_party ELSE external_party_id END,
    ball_in_court_user_id = pin, version = version + 1, updated_at = now()
  WHERE id = p_id;
  PERFORM public.reg_step(p_id, 1, 'edit', actor, NULL, 'entry', 'entry', false, false);
  PERFORM public.reg_audit('register_record_update', p_id, before, public.reg_snap(p_id), NULL);
  RETURN p_id;
END $$;
CREATE OR REPLACE FUNCTION reg_void_record(p_record uuid, p_version int, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; before jsonb;
BEGIN
  r := public.reg_lock(p_record, p_version);
  PERFORM public.reg_lock_check(r.register_key, p_record, NULL, NULL);
  IF coalesce(btrim(p_reason), '') = '' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/reason', 'required', 'A reason is required.')));
  END IF;
  IF r.state NOT IN ('entry', 'in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a record that is not approved yet can be voided (it is ' || r.state || ').'));
  END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'delete');
  before := public.reg_snap(p_record);
  UPDATE public.register_records SET state = 'voided', voided_at = now(), voided_by = actor, void_reason = p_reason, ball_in_court_user_id = NULL, level_opened_at = NULL,
    version = version + 1, updated_at = now() WHERE id = p_record;
  PERFORM public.reg_step(p_record, r.current_level, 'void', actor, p_reason, r.state, 'voided', false, false);
  PERFORM public.reg_audit('register_record_void', p_record, before, public.reg_snap(p_record), p_reason);
END $$;
-- ---------------------------------------------------------------------------------------------------------------------
-- The workflow dispatcher (copy of 0019, one lock check added): a locked record takes no step for non-admins.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reg_transition_record(p_record uuid, p_version int, p_action text, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- 0103 (0.15.22): a locked record takes no workflow step (submit, review, approve, reject); System Admins are exempt in reg_lock_check
  PERFORM public.reg_lock_check(NULL, p_record, NULL, NULL);
  IF p_action = 'reject' THEN RETURN public.reg_reject(p_record, p_version, p_note); END IF;
  IF p_action NOT IN ('submit', 'review', 'approve') THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Unknown action.')); END IF;
  RETURN public.reg_complete(p_record, p_version, p_action, p_note, p_stepup);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Ownership and execute rights, as for the other reg_* functions. The lock functions are new; the writers keep their grants.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['reg_lock_check(text,uuid,jsonb,jsonb)', 'reg_record_lock_set(uuid,int,boolean,text)', 'reg_column_lock_set(text,text,boolean,text)',
    'reg_save_record(text,uuid,int,uuid,text,jsonb,jsonb,uuid,boolean)', 'reg_void_record(uuid,int,text)', 'reg_transition_record(uuid,int,text,text,boolean)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['reg_record_lock_set(uuid,int,boolean,text)', 'reg_column_lock_set(text,text,boolean,text)',
      'reg_save_record(text,uuid,int,uuid,text,jsonb,jsonb,uuid,boolean)', 'reg_void_record(uuid,int,text)', 'reg_transition_record(uuid,int,text,text,boolean)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    GRANT SELECT ON register_record_locks, register_column_locks TO pmis_app;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON register_record_locks, register_column_locks TO pmis_definer;
GRANT SELECT ON register_fields, register_definitions TO pmis_definer;
