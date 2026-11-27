-- 0340_register_triage: intake triage for the Issue Log and the Change Control Log (accept / reject / merge duplicate / defer, with a note).
-- Mirror: db/sql/339_register_triage.sql (kept identical to prisma/migrations/0340_register_triage/migration.sql).
--
--   Owner request (relayed 2026-11-27, benchmark Linear Triage): new issues and change requests land in a triage queue; the register's L2 holder
--   (the Responsibility Matrix row of the register, no new permission and no widening) accepts, rejects, merges as a duplicate of another record,
--   or defers, each with a note that goes to the person who entered the record.
--   Additive: one flag on register_definitions, five nullable columns on register_records, one trigger, one action function. Existing records are
--   untouched (triage_state stays NULL = not triaged); the L1 -> L2 approval flow is unchanged and triage never blocks it. A reject or a merge
--   voids the unapproved record (same end state as a void, audited as triage), and asks for a step-up like a void does.

SELECT set_config('app.region_ids', '*', true);

ALTER TABLE register_definitions ADD COLUMN triage_enabled boolean NOT NULL DEFAULT false;
UPDATE register_definitions SET triage_enabled = true WHERE register_key IN ('issues', 'change_control');

ALTER TABLE register_records
  ADD COLUMN triage_state text,
  ADD COLUMN triage_note text,
  ADD COLUMN triage_by uuid,
  ADD COLUMN triage_at timestamptz,
  ADD COLUMN triage_duplicate_of uuid;
ALTER TABLE register_records ADD CONSTRAINT register_records_triage_state_check
  CHECK (triage_state IS NULL OR triage_state IN ('pending', 'accepted', 'rejected', 'duplicate', 'deferred'));
CREATE INDEX register_records_triage_idx ON register_records (register_key, triage_state) WHERE triage_state IN ('pending', 'deferred');

-- the record's history trail names the four triage decisions (same pattern as 053 adding 'transfer')
ALTER TABLE register_steps DROP CONSTRAINT IF EXISTS register_steps_action_check;
ALTER TABLE register_steps ADD CONSTRAINT register_steps_action_check
  CHECK (action IN ('create', 'edit', 'submit', 'review', 'approve', 'reject', 'auto_skip', 'claim', 'release', 'new_version', 'void', 'transfer',
    'triage_accept', 'triage_reject', 'triage_merge', 'triage_defer'));

-- Every brand-new record (version 1) of a triage-enabled register enters the queue. Later versions keep the decision of the entity (copied below
-- in reg_new_version's successor: the trigger only fills version 1; a new version of a triaged entity starts untriaged, as a fresh intake of new data).
CREATE OR REPLACE FUNCTION reg_triage_default() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.triage_state IS DISTINCT FROM 'pending'
     AND EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = NEW.register_key AND d.triage_enabled) THEN
    -- every insert enters the queue: a new record, and a new version of an already-decided record (a fresh intake, the old decision is cleared)
    NEW.triage_state := 'pending';
    NEW.triage_note := NULL;
    NEW.triage_by := NULL;
    NEW.triage_at := NULL;
    NEW.triage_duplicate_of := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_register_triage_default BEFORE INSERT ON register_records FOR EACH ROW EXECUTE FUNCTION reg_triage_default();

-- One triage decision. p_action: accept | reject | merge | defer. The database decides who may (the L2 holders of the register's matrix row for the
-- record's region, or a System Admin when the row has no holder, exactly like reg_require_actor), checks the version, audits and notifies.
CREATE OR REPLACE FUNCTION reg_triage_act(p_record uuid, p_version int, p_action text, p_note text, p_duplicate_of uuid, p_stepup boolean)
  RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); r public.register_records%ROWTYPE; before jsonb; dup public.register_records%ROWTYPE;
  is_admin boolean; has_holder boolean; new_state text; lbl text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_action NOT IN ('accept', 'reject', 'merge', 'defer') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/action', 'invalid', 'accept, reject, merge or defer.')));
  END IF;
  IF p_action IN ('reject', 'merge') AND coalesce(btrim(p_note), '') = '' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/note', 'required', 'A note is required for a rejection and for a merge.')));
  END IF;
  r := public.reg_lock(p_record, p_version);
  IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r.register_key AND d.triage_enabled) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This register has no triage.'));
  END IF;
  IF r.triage_state IS NULL OR r.triage_state IN ('accepted', 'rejected', 'duplicate') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This record is not waiting for triage (it is ' || coalesce(r.triage_state, 'not triaged') || ').'));
  END IF;
  IF r.state NOT IN ('entry', 'in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a record that is not approved yet can be triaged (it is ' || r.state || ').'));
  END IF;
  -- who may triage: the L2 (approve) holders of the register's matrix row for this record, or a System Admin when the row has no holder
  is_admin := public.app_user_is_system_admin(actor);
  has_holder := public.reg_has_holder(p_record, 'approve');
  IF NOT (public.reg_is_eligible(p_record, 'approve', actor) OR (is_admin AND NOT has_holder)) THEN
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF p_action IN ('reject', 'merge') AND NOT p_stepup THEN
    PERFORM public.wf_err('step_up_required');
  END IF;
  IF p_action = 'merge' THEN
    IF p_duplicate_of IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/duplicate_of', 'required', 'Pick the record this one is a duplicate of.')));
    END IF;
    SELECT * INTO dup FROM public.register_records x
      WHERE x.register_key = r.register_key AND x.entity_id = p_duplicate_of AND x.state <> 'voided'
        AND NOT EXISTS (SELECT 1 FROM public.register_records n WHERE n.entity_id = x.entity_id AND n.version_no > x.version_no)
        AND public.app_region_read(x.is_global, x.region_id);
    IF NOT FOUND OR dup.entity_id = r.entity_id THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/duplicate_of', 'invalid', 'Not another live record of this register that you can see.')));
    END IF;
  END IF;

  before := public.reg_snap(p_record);
  new_state := CASE p_action WHEN 'accept' THEN 'accepted' WHEN 'reject' THEN 'rejected' WHEN 'merge' THEN 'duplicate' ELSE 'deferred' END;
  lbl := public.reg_label(p_record);
  IF p_action IN ('reject', 'merge') THEN
    UPDATE public.register_records SET state = 'voided', voided_at = now(), voided_by = actor,
      void_reason = CASE WHEN p_action = 'merge' THEN 'Duplicate of ' || public.reg_label(dup.id) || ': ' || p_note ELSE 'Triage rejection: ' || p_note END,
      triage_state = new_state, triage_note = p_note, triage_by = actor, triage_at = now(),
      triage_duplicate_of = CASE WHEN p_action = 'merge' THEN p_duplicate_of ELSE NULL END,
      ball_in_court_user_id = NULL, level_opened_at = NULL, version = version + 1, updated_at = now()
    WHERE id = p_record;
  ELSE
    UPDATE public.register_records SET triage_state = new_state, triage_note = p_note, triage_by = actor, triage_at = now(),
      triage_duplicate_of = NULL, version = version + 1, updated_at = now()
    WHERE id = p_record;
  END IF;
  PERFORM public.reg_step(p_record, r.current_level, 'triage_' || p_action, actor, p_note, r.triage_state, new_state, p_stepup, false);
  PERFORM public.reg_audit('register_record_triage', p_record, before, public.reg_snap(p_record), p_note);
  -- the person who entered the record hears the decision; on a merge, the surviving record's thread gets a note
  IF r.created_by IS NOT NULL AND r.created_by <> actor THEN
    PERFORM public.reg_notify(r.created_by, 'triage_decision',
      CASE p_action WHEN 'accept' THEN 'Triage: accepted' WHEN 'reject' THEN 'Triage: rejected' WHEN 'merge' THEN 'Triage: merged as duplicate' ELSE 'Triage: deferred' END,
      lbl || CASE WHEN p_note IS NULL OR btrim(p_note) = '' THEN '' ELSE ': ' || left(p_note, 200) END, p_record);
  END IF;
  IF p_action = 'merge' AND dup.region_id IS NOT NULL THEN
    INSERT INTO public.comments (region_id, entity_type, entity_id, author_id, body)
    VALUES (dup.region_id, 'register_record', dup.entity_id, actor, 'Merged duplicate: ' || lbl || CASE WHEN p_note IS NULL OR btrim(p_note) = '' THEN '' ELSE ' - ' || p_note END);
  END IF;
  RETURN jsonb_build_object('id', p_record, 'triage_state', new_state, 'state', CASE WHEN p_action IN ('reject', 'merge') THEN 'voided' ELSE r.state END);
END $$;

DO $$
DECLARE f text;
BEGIN
  -- Q441: the mail notification kinds are edited in Settings; the catalogue must hold every kind a migration writes
  EXECUTE $sql$
    CREATE OR REPLACE FUNCTION mail_kind_catalogue() RETURNS jsonb
    LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$
      SELECT jsonb_agg(jsonb_build_object('kind', k, 'recommended', ord <= 6) ORDER BY ord)
      FROM unnest(ARRAY[
        'task_assigned', 'register_assigned', 'snag_review', 'task_rejected', 'register_rejected', 'snag_rejected',
        'email_change_decided', 'email_change_requested', 'followed_change', 'gate_closed_again', 'holiday_tentative', 'import_batch', 'levels_converted', 'mention',
        'no_eligible_holder', 'order_team_mismatch', 'party_type_review', 'permit_transferred', 'phone_change_decided', 'phone_change_requested', 'site_draft_approved',
        'site_draft_assigned', 'site_draft_returned', 'site_region_moved', 'sla_negative_duration', 'snag_closed', 'snag_raised', 'team_safety_cert',
        'absence_alert', 'reassigned',
        'mfa_exemption', 'assignment_request',
        'daily_plan_reminder',
        'triage_decision'
      ]) WITH ORDINALITY AS t(k, ord)
    $f$
  $sql$;
  EXECUTE 'ALTER FUNCTION mail_kind_catalogue() OWNER TO pmis_definer';
  EXECUTE 'REVOKE ALL ON FUNCTION mail_kind_catalogue() FROM PUBLIC';

  FOREACH f IN ARRAY ARRAY['reg_triage_default()', 'reg_triage_act(uuid,int,text,text,uuid,boolean)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION reg_triage_act(uuid,int,text,text,uuid,boolean) TO pmis_app;
  END IF;
END $$;
