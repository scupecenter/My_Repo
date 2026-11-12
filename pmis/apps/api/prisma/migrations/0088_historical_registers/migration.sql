-- 0088: the register sheets of the historical Master load, loaded from the same file and approved directly (owner decision 2026-11-12, "Everything from the
-- one file"; CHANGELOG 130).
--
-- WHY. The owner loads the real Site Master through "Master import and comparison" (mi_apply_run). Until now the apply entered only the typed task columns of
-- the Master sheet (0087 approves them directly, as an admin override). The same workbook also holds the register sheets: RF & Design, Acquisition, Permission
-- Log, PR-PO, GECOL, HLC, As-Built and Risk Register. The owner wants them in their registers from the same file, in the same apply, and, with the direct
-- approval, approved at once so the registers show the data. The offline helper tools/master-import/fill-templates.py already maps each of these sheets onto
-- the register template GSDN Workspace issues (TPL-RF ... TPL-RSK); its maps now ship with the API (apps/api/src/master-import/register-maps/, one source of
-- truth for both), which reads the sheets from the file stored with the run.
--
-- WHAT THIS ADDS.
--   1. `historical_load.registers` of POST /master-import/runs/{run_id}/apply. The API reads the register sheets of the run's stored file (its SHA-256 checked
--      against the run), maps and normalises them (never a personal column: landlord, contact, phone, e-mail, Q469), and passes the rows to the new signature
--      mi_apply_run(..., p_registers). The database checks again that the rows are of this run's file, that the option comes with the historical load (the
--      checks of hw_mark_authorize, 0073), keeps only the fields of a register row and drops every personal field again. A big file applied in the background
--      (0086) keeps the rows on its mi_apply_jobs row (definer-only; cleared when the run ends) and mi_apply_step passes them on.
--   2. hrg_stage_registers stages each sheet as the register's own template (imp_master_unit, the staging of a TPL-MASTER register sheet: site check against
--      GSDN Workspace sites, lists, keys, rights, the register's rules on a probe) in the same group as the stream batches, source master_import, and marks it
--      historical (hw_mark_batch, now also for a register sheet of the Master import). A row that cannot be read is an error row of its batch; a sheet that
--      cannot be staged is "skipped" with its reason; neither stops the apply. The batches are then sent like the others (imp_submit_batch, or in chunks with
--      imp_async_start, 0075), after the stream batches.
--   3. With `approve_directly` (0087) the register batches are marked too (hda_mark_batches, hda_batch_ok now also for a register batch), and
--      imp_submit_register_rows approves each sent row of a marked batch at once (hda_approve_record): the data effects of the final approval of reg_complete
--      (0019): the level actors, a register step "approve" with the note "historical load: approved directly (admin override)", the approved version in force,
--      the typed table (reg_apply) and the register's own approval effects (the triggers on the approved state; reg_complete_task). The flag
--      `register_records.historical_direct_approved` (+ batch, time), one audit row per record `register_record_historical_direct_approval` with
--      is_admin_override and the reason of the load. Without `approve_directly` the rows are sent and wait for L2 like any register batch.
--   4. Side effects handled explicitly. (a) A record sent from a register sheet of the historical load is never linked to its source task (reg_link_task):
--      the task dates of the load come from the Master sheet. (b) No notice for a record approved directly right after its submit (reg_notify, the marker
--      pmis.hda_quiet_record, checked against the stored batch). (c) A Procurement record approved directly opens no Car Dispatcher booking and no Financial
--      Advance request (fa_after): historical field work needs no vehicle or advance today. The other approval effects of these eight registers (the typed
--      tables, the change-control feeds of RF & Design, Acquisition, As-Built and Risk Register, the HLC / C3 sync) run as in an L2 approval. No warehouse
--      posting or generated form belongs to these registers.
--   5. Guards, as 0087: the record flag is written only by hda_approve_record (definer role, transaction marker pmis.hda_record, a row of a marked batch that may
--      still be approved directly, read from the stored rows) and clears (audited) if the record ever leaves the approved state. No security function is
--      weakened: reg_require_actor, the grants and the eligibility of reg_complete are untouched; the direct approval is its own internal function, reached
--      only from imp_submit_register_rows for a batch with the mark, which only mi_apply_run sets.
--
-- Redefined from their latest definitions (changes marked "0088"): hw_guard_batch (0073), hw_mark_batch (0073), hda_batch_ok (0087), reg_link_task (0019),
-- reg_notify (0019), fa_after (0076), imp_submit_register_rows (0075), imp_submit_register_finish (0075), mi_apply_run (0087: now a wrapper of the new
-- signature), mi_apply_step (0087). CREATE OR REPLACE keeps their owner (pmis_definer), search_path and grants.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. pmis_app gets one new door,
-- mi_apply_run(uuid, integer, text, text, boolean, jsonb, jsonb); the new internal functions are granted to nobody. No new table right (db/sql/app_grants.sql:
-- a comment line only).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE import_batches DROP CONSTRAINT import_batches_historical_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_historical_check CHECK (NOT historical_load OR (
    historical_cutoff IS NOT NULL AND historical_marked_by IS NOT NULL AND historical_marked_at IS NOT NULL
    AND char_length(btrim(coalesce(historical_reason, ''))) >= 3
    AND (stream_code IS NOT NULL OR (register_key IS NOT NULL AND source = 'master_import'))));
ALTER TABLE import_batches DROP CONSTRAINT import_batches_hda_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_hda_check CHECK (NOT historical_direct_approve OR (historical_load AND source = 'master_import'
  AND (stream_code IS NOT NULL OR register_key IS NOT NULL)));

ALTER TABLE register_records
  ADD COLUMN historical_direct_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN historical_direct_batch_id uuid REFERENCES import_batches (id),
  ADD COLUMN historical_direct_approved_at timestamptz,
  ADD CONSTRAINT register_records_hda_check CHECK (NOT historical_direct_approved OR (historical_direct_batch_id IS NOT NULL AND historical_direct_approved_at IS NOT NULL
    AND state = 'approved'));
CREATE INDEX register_records_hda_idx ON register_records (register_key) WHERE historical_direct_approved;
COMMENT ON COLUMN register_records.historical_direct_approved IS '0088: approved directly by the historical Master import (a register sheet of the file; admin override, no L2): the "Admin override" badge';

ALTER TABLE mi_apply_jobs
  ADD COLUMN load_registers boolean NOT NULL DEFAULT false,
  ADD COLUMN registers jsonb,
  ADD CONSTRAINT mi_apply_jobs_hrg_check CHECK (NOT load_registers OR (hw_reason IS NOT NULL AND mode = 'submit'));
COMMENT ON COLUMN mi_apply_jobs.registers IS '0088: the register sheets the API read from the run''s stored file, kept for the background apply and cleared when the run ends (definer-only table)';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT (historical_direct_approved, historical_direct_batch_id, historical_direct_approved_at),
           UPDATE (historical_direct_approved, historical_direct_batch_id, historical_direct_approved_at) ON register_records FROM pmis_app;
  END IF;
END $$;

-- The parsed register rows of a background apply are kept only while it runs.
CREATE OR REPLACE FUNCTION hrg_jobs_clear() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.registers := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER hrg_jobs_clear BEFORE UPDATE ON mi_apply_jobs FOR EACH ROW WHEN (NEW.state <> 'running' AND NEW.registers IS NOT NULL) EXECUTE FUNCTION hrg_jobs_clear();


-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The historical mark on a register batch of the Master import (hw_guard_batch, hw_mark_batch: latest 0073, changes marked 0088; hda_batch_ok: 0087)
-- ---------------------------------------------------------------------------------------------------------------------
-- hw_guard_batch (latest 0073; 0088: a register batch of the Master import may carry the mark)
CREATE OR REPLACE FUNCTION hw_guard_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.historical_load THEN
    IF NEW.historical_load IS DISTINCT FROM OLD.historical_load OR NEW.historical_cutoff IS DISTINCT FROM OLD.historical_cutoff
       OR NEW.historical_reason IS DISTINCT FROM OLD.historical_reason OR NEW.historical_marked_by IS DISTINCT FROM OLD.historical_marked_by
       OR NEW.historical_marked_at IS DISTINCT FROM OLD.historical_marked_at THEN
      RAISE EXCEPTION 'historical waiver: the mark of a batch never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.historical_load THEN
    IF (NEW.stream_code IS NULL AND NOT (NEW.register_key IS NOT NULL AND NEW.source = 'master_import'))   -- 0088: a register sheet of the Master import too
       OR NEW.historical_marked_by IS DISTINCT FROM public.app_actor() OR NOT public.app_user_is_system_admin(NEW.historical_marked_by)
       OR NOT coalesce(public.app_ctx_stepup(), false) OR NOT public.hw_waiver_open_now() OR NEW.historical_cutoff IS DISTINCT FROM public.hw_waiver_cutoff() THEN
      RAISE EXCEPTION 'historical waiver: a batch is marked only by a System Admin with a step-up under the open waiver' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.historical_cutoff IS NOT NULL OR NEW.historical_reason IS NOT NULL OR NEW.historical_marked_by IS NOT NULL OR NEW.historical_marked_at IS NOT NULL THEN
    RAISE EXCEPTION 'historical waiver: no mark data without the mark' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- hw_mark_batch (latest 0073; 0088: also a register sheet staged by the Master import, mi_apply_run)
CREATE OR REPLACE FUNCTION hw_mark_batch(p_batch uuid, p_reason text, p_cutoff date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); rs text := btrim(p_reason);
BEGIN
  UPDATE public.import_batches SET historical_load = true, historical_cutoff = p_cutoff, historical_reason = rs, historical_marked_by = a, historical_marked_at = now()
    WHERE id = p_batch AND (stream_code IS NOT NULL OR (register_key IS NOT NULL AND source = 'master_import')) AND NOT historical_load;   -- 0088
  IF NOT FOUND THEN RAISE EXCEPTION 'historical waiver: only a stream batch or a register sheet of the Master import is marked, once' USING ERRCODE = 'check_violation'; END IF;
  PERFORM public.log_audit_write('import_batch.historical_load', 'import_batch', p_batch::text, jsonb_build_object('historical_load', false),
    jsonb_build_object('historical_load', true, 'cutoff_date', p_cutoff, 'batch_id', p_batch,
      'rule', 'mandatory documents are skipped for rows whose actual date is on or before the cutoff date'), rs, NULL, NULL, NULL, true);
END $$;

-- hda_batch_ok (latest 0087; 0088: a register batch of the Master import too)
CREATE OR REPLACE FUNCTION hda_batch_ok(p_batch public.import_batches) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(p_batch.historical_load AND p_batch.source = 'master_import' AND (p_batch.stream_code IS NOT NULL OR p_batch.register_key IS NOT NULL) AND p_batch.mode = 'submit'
    AND public.app_actor() IS NOT NULL AND p_batch.historical_marked_by = public.app_actor() AND p_batch.uploaded_by = public.app_actor()
    AND public.app_user_is_system_admin(p_batch.historical_marked_by)
    AND public.hw_waiver_open_now() AND p_batch.historical_cutoff = public.hw_waiver_cutoff()
    AND p_batch.historical_marked_at >= nullif((public.hw_waiver_cfg() ->> 'opened_at'), '')::timestamptz, false)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. A historical register row is never the source of a task (reg_link_task: latest 0019, changes marked 0088)
-- ---------------------------------------------------------------------------------------------------------------------
-- WHY. The task dates of the historical load come from the Master sheet (the stream batches of the same run, sent first). A register record that also
-- closed its source task (Q43: A3, B1, B2, B3, C1, C2, C4, D1) would approve a second time a task the Master sheet already entered, or, when the task is
-- locked or waits for L2, refuse the whole record ("cannot be submitted until the task is open"). A record sent from a register sheet of the historical
-- load is therefore approved on its register row only; every other record links as before.
-- True while the current import row (app.batch_row, set by the batch writers) is a row of a register batch of the historical Master import of the signed-in
-- System Admin, under the waiver open now (read from the stored rows; internal).
CREATE OR REPLACE FUNCTION hrg_row_historical() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.import_batch_rows r JOIN public.import_batches b ON b.id = r.batch_id
    WHERE r.id = public.imp_current_row() AND b.register_key IS NOT NULL AND b.source = 'master_import' AND b.historical_load
      AND public.app_actor() IS NOT NULL AND b.uploaded_by = public.app_actor() AND b.historical_marked_by = public.app_actor()
      AND public.app_user_is_system_admin(b.historical_marked_by) AND public.hw_waiver_open_now() AND b.historical_cutoff = public.hw_waiver_cutoff()
      AND b.historical_marked_at >= nullif((public.hw_waiver_cfg() ->> 'opened_at'), '')::timestamptz)
$$;

-- reg_link_task (latest 0019; 0088 marked)
CREATE OR REPLACE FUNCTION reg_link_task(p_record uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.register_records%ROWTYPE; src record; t public.task_instances%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.site_id IS NULL THEN RETURN NULL; END IF;
  IF public.hrg_row_historical() THEN   -- 0088: a row of a register sheet of the historical load: the register row only (audited when the register feeds a task)
    IF EXISTS (SELECT 1 FROM public.register_task_sources x WHERE x.register_key = r.register_key AND x.is_active) THEN
      PERFORM public.reg_audit('register_record_task_not_linked', p_record, NULL, jsonb_build_object('task_id', NULL, 'historical_load', true),
        'historical load: the task dates come from the Master sheet; the record is approved on the register row only');
    END IF;
    RETURN NULL;
  END IF;
  FOR src IN SELECT x.task_code FROM public.register_task_sources x WHERE x.register_key = r.register_key AND x.is_active ORDER BY x.sort_order, x.task_code LOOP
    IF NOT public.reg_source_matches(p_record, src.task_code) THEN CONTINUE; END IF;
    SELECT ti.* INTO t FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id
      JOIN public.sites s ON s.id = ti.site_id AND s.workflow_version_id = td.workflow_id
      WHERE ti.site_id = r.site_id AND td.code = src.task_code
      LIMIT 1;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF t.state IN ('approved', 'na', 'skipped') OR t.is_na THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = t.id AND o.id <> p_record AND o.state IN ('in_review', 'in_approval')) THEN CONTINUE; END IF;
    IF t.state NOT IN ('open', 'entry') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This record is the source of task ' || src.task_code || ', which is ' || t.state::text
        || ': it cannot be submitted until the task is open.'));
    END IF;
    RETURN t.id;
  END LOOP;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The direct approval of one register record, the guard of its flag, the quiet notices, no field-work drafts
-- ---------------------------------------------------------------------------------------------------------------------
-- Approves the record that the row p_row of the marked register batch p_batch has just submitted (internal; called only by imp_submit_register_rows, inside the
-- row's own block, so a refusal is the error of that row). The data effects are those of the final approval of reg_complete (0019): the level actors, a
-- register step, the approved version in force (the N/A approver of a permit, Q45), the typed table (reg_apply) and the task effects (reg_complete_task); the
-- triggers on the approved state run as for an L2 approval. Who may act is decided by the mark (hda_batch_ok), not by the Responsibility Matrix: this is the
-- admin override the owner chose for the historical load, so reg_require_actor is not called and is not changed. Returns the unlocked tasks.
CREATE OR REPLACE FUNCTION hda_approve_record(p_record uuid, p_batch uuid, p_row uuid, p_stepup boolean) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.register_records%ROWTYPE; n int; lvl int; before jsonb; aname text;
  unlocked uuid[] := ARRAY[]::uuid[]; note text := 'historical load: approved directly (admin override)';
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND OR NOT b.historical_direct_approve OR b.register_key IS NULL OR NOT public.hda_batch_ok(b) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail',
      'This row cannot be approved directly: the historical-load waiver is closed, or the batch is not a register sheet of a historical Master import of yours marked for direct approval.'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.import_batch_rows x WHERE x.id = p_row AND x.batch_id = p_batch AND x.register_record_id = p_record) THEN
    RAISE EXCEPTION 'historical direct approval: the row is not a row of this record in this batch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;   -- a final approval (as reg_complete)
  r := public.reg_lock(p_record, NULL);
  IF r.register_key IS DISTINCT FROM b.register_key THEN
    RAISE EXCEPTION 'historical direct approval: the record is not of the register of this batch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.state = 'approved' THEN RETURN unlocked; END IF;   -- the submit was already final (the sender holds L1 and L2, B5): a normal approval, no flag
  IF r.state NOT IN ('in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The record is ' || r.state || ': it cannot be approved directly.'));
  END IF;
  before := public.reg_snap(p_record);
  n := coalesce(r.levels_required, public.reg_levels(p_record));
  PERFORM set_config('app.batch_row', p_row::text, true);   -- the steps and audit rows name the import row
  FOR lvl IN r.current_level .. greatest(n, r.current_level) LOOP
    PERFORM public.reg_step(p_record, lvl, 'approve', actor, note, r.state, 'approved', true, false);
    INSERT INTO public.register_level_actors (record_id, level, user_id, how) VALUES (p_record, lvl, actor, 'acted')
      ON CONFLICT (record_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  END LOOP;
  IF r.register_key = 'permits_hse' AND lower(coalesce(r.data ->> 'status', '')) = 'n/a' THEN   -- Q45, as reg_complete
    SELECT u.display_name INTO aname FROM public.users u WHERE u.id = actor;
    UPDATE public.register_records SET data = data || jsonb_build_object('na_approved_by', aname) WHERE id = p_record;
  END IF;
  UPDATE public.register_records SET is_current = false WHERE entity_id = r.entity_id AND id <> p_record AND is_current;
  PERFORM set_config('pmis.hda_record', p_record::text, true);
  UPDATE public.register_records SET state = 'approved', current_level = greatest(n, r.current_level), approved_at = now(), approved_by = actor, is_current = true,
    ball_in_court_user_id = NULL, level_opened_at = NULL, self_approval = false,
    historical_direct_approved = true, historical_direct_batch_id = p_batch, historical_direct_approved_at = now()
  WHERE id = p_record;
  PERFORM set_config('pmis.hda_record', '', true);
  PERFORM public.reg_apply(p_record);                                         -- the typed table first: the task's calculations read it
  unlocked := public.reg_complete_task(p_record, actor, true, false);
  UPDATE public.register_records SET version = version + 1, updated_at = now() WHERE id = p_record;
  PERFORM public.log_audit_write('register_record_historical_direct_approval', 'register_record', p_record::text,
    before || jsonb_build_object('historical_direct_approved', false),
    public.reg_snap(p_record) || jsonb_build_object('historical_direct_approved', true, 'register_key', r.register_key, 'batch_id', p_batch, 'batch_row_id', p_row,
      'levels_approved', greatest(n, r.current_level) - r.current_level + 1, 'unlocked_task_ids', to_jsonb(unlocked),
      'rule', 'approved at once as an admin override of the historical load (no L2)'),
    b.historical_reason, r.site_id, r.region_id, NULL, true);
  PERFORM set_config('app.batch_row', '', true);
  RETURN unlocked;
END $$;

-- BEFORE INSERT OR UPDATE on register_records. Not a definer: current_user is the writer. The flag is set only inside hda_approve_record (the definer role and
-- its marker for this record), on an approved record with a row in a marked batch; it clears (audited) if the record leaves the approved state.
CREATE OR REPLACE FUNCTION hda_guard_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'historical direct approval: the flag of a register record is written only by GSDN Workspace (migration 0088)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.historical_direct_approved AND NEW.state IS DISTINCT FROM 'approved' THEN
    IF (NEW.historical_direct_batch_id, NEW.historical_direct_approved_at) IS DISTINCT FROM (OLD.historical_direct_batch_id, OLD.historical_direct_approved_at) THEN
      RAISE EXCEPTION 'historical direct approval: the batch of a flagged record never changes (migration 0088)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.historical_direct_approved := false;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('register_record_historical_direct_approval_cleared', 'register_record', NEW.id::text, NEW.site_id, NEW.region_id,
      jsonb_build_object('historical_direct_approved', true, 'state', OLD.state, 'batch_id', OLD.historical_direct_batch_id),
      jsonb_build_object('historical_direct_approved', false, 'state', NEW.state, 'batch_id', OLD.historical_direct_batch_id),
      'The record left the approved state (' || NEW.state || ').', public.app_actor());
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF (NEW.historical_direct_approved, NEW.historical_direct_batch_id, NEW.historical_direct_approved_at)
     IS NOT DISTINCT FROM (OLD.historical_direct_approved, OLD.historical_direct_batch_id, OLD.historical_direct_approved_at) THEN
    RETURN NEW;
  END IF;
  IF NOT (current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hda_record', true), '') = NEW.id::text
          AND NEW.historical_direct_approved AND NOT OLD.historical_direct_approved AND NEW.state = 'approved' AND OLD.state IN ('in_review', 'in_approval')
          AND EXISTS (SELECT 1 FROM public.import_batches b JOIN public.import_batch_rows x ON x.batch_id = b.id AND x.register_record_id = NEW.id
                      WHERE b.id = NEW.historical_direct_batch_id AND b.historical_direct_approve AND b.register_key = NEW.register_key AND public.hda_batch_ok(b))) THEN
    RAISE EXCEPTION 'historical direct approval: the flag of a register record is written only by GSDN Workspace (migration 0088)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hda_guard_record_ins BEFORE INSERT ON register_records FOR EACH ROW
  WHEN (NEW.historical_direct_approved OR NEW.historical_direct_batch_id IS NOT NULL OR NEW.historical_direct_approved_at IS NOT NULL) EXECUTE FUNCTION hda_guard_record();
CREATE TRIGGER hda_guard_record_upd BEFORE UPDATE ON register_records FOR EACH ROW
  WHEN (NEW.historical_direct_approved IS DISTINCT FROM OLD.historical_direct_approved OR NEW.historical_direct_batch_id IS DISTINCT FROM OLD.historical_direct_batch_id
        OR NEW.historical_direct_approved_at IS DISTINCT FROM OLD.historical_direct_approved_at OR (OLD.historical_direct_approved AND NEW.state IS DISTINCT FROM OLD.state))
  EXECUTE FUNCTION hda_guard_record();

-- reg_notify (latest 0019, changes marked 0088): no in-app notice about the record whose submit is followed at once by its direct approval. The notice is skipped
-- only for the record named by the sender's marker (imp_submit_register_rows) AND only while that record has a row in a batch marked for direct approval that
-- may still be approved directly (hda_batch_ok): a marker set anywhere else never hides a notice.
CREATE OR REPLACE FUNCTION reg_notify(p_user uuid, p_kind text, p_title text, p_body text, p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_record IS NOT NULL AND coalesce(current_setting('pmis.hda_quiet_record', true), '') = p_record::text
     AND EXISTS (SELECT 1 FROM public.import_batch_rows x JOIN public.import_batches b ON b.id = x.batch_id
                 WHERE x.register_record_id = p_record AND b.historical_direct_approve AND public.hda_batch_ok(b)) THEN
    RETURN;   -- 0088
  END IF;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  SELECT p_user, 'in_app', p_kind, p_title, p_body, '/registers/' || r.register_key || '/records/' || r.id::text FROM public.register_records r WHERE r.id = p_record;
END $$;

-- fa_after (latest 0076, changes marked 0088): a Procurement record approved directly by the historical load opens no Car Dispatcher booking and no Financial
-- Advance request (historical field work needs no vehicle or advance now); its Ready-to-mobilize state is still synchronised.
CREATE OR REPLACE FUNCTION fa_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_is_seeding() THEN RETURN NULL; END IF;
  IF NEW.register_key = 'procurement' THEN
    IF NEW.state = 'approved' AND public.fa_field_work(NEW.data) THEN
      IF NOT NEW.historical_direct_approved THEN PERFORM public.fa_open_drafts(NEW.id); END IF;   -- 0088
      PERFORM public.fleet_sync(NEW.entity_id);
    END IF;
  ELSIF NEW.state = 'voided' AND NEW.register_key = 'car_dispatcher' THEN
    UPDATE public.vehicle_reservations SET state = 'released', released_at = now() WHERE booking_entity_id = NEW.entity_id AND state = 'reserved';
    IF NEW.record_type = 'booking' AND NOT public.fa_blank(NEW.data, 'procurement_record_id') THEN PERFORM public.fleet_sync((NEW.data ->> 'procurement_record_id')::uuid); END IF;
  ELSIF NEW.state = 'approved' AND NEW.record_type IN ('booking', 'advance') AND NOT public.fa_blank(NEW.data, 'procurement_record_id') THEN
    PERFORM public.fleet_sync((NEW.data ->> 'procurement_record_id')::uuid);
  END IF;
  RETURN NULL;
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The sender of a register batch (imp_submit_register_rows, imp_submit_register_finish: latest 0075, changes marked 0088)
-- ---------------------------------------------------------------------------------------------------------------------
-- imp_submit_register_rows (latest 0075; 0088 marked: a sent row of a batch marked for direct approval is approved at once)
CREATE OR REPLACE FUNCTION imp_submit_register_rows(p_batch uuid, p_rows uuid[], p_stepup boolean, p_async boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; key text; cur public.register_records%ROWTYPE; opn public.register_records%ROWTYPE;
  rid uuid; rver int; st text; submitted int := 0; processed int := 0; held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; patch jsonb; cpatch jsonb; k text; msg text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  key := b.register_key;
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action IN ('create', 'update') AND x.decision IN ('pending', 'pending_previous_approval')
             AND x.register_record_id IS NULL AND (p_rows IS NULL OR x.id = ANY (p_rows)) ORDER BY x.row_no LOOP
    processed := processed + 1;
    BEGIN
      IF r.action = 'update' THEN
        opn := NULL;
        SELECT * INTO opn FROM public.register_records x WHERE x.entity_id = r.matched_entity_id AND x.state IN ('entry', 'in_review', 'in_approval');
        IF opn.id IS NOT NULL THEN
          UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = 'open_version' WHERE id = r.id;
          held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', 'open_version', 'record_id', opn.id));
          CONTINUE;
        END IF;
        SELECT * INTO cur FROM public.register_records x WHERE x.entity_id = r.matched_entity_id AND x.state = 'approved' AND x.is_current;
        IF NOT FOUND OR cur.id IS DISTINCT FROM r.base_record_id THEN
          UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', hold_reason = NULL, diff = '{}'::jsonb,
            errors = jsonb_build_array(jsonb_build_object('code', 'stale_base', 'message', 'The record changed after the file was uploaded. Download the template again.')) WHERE id = r.id;
          failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'stale_base'));
          CONTINUE;
        END IF;
        rid := public.reg_new_version(cur.id, cur.version, r.id);
        SELECT version INTO rver FROM public.register_records WHERE id = rid;
        patch := '{}'::jsonb; cpatch := '{}'::jsonb;
        FOR k IN SELECT jsonb_object_keys(r.diff) LOOP
          IF r.payload -> 'data' ? k THEN patch := patch || jsonb_build_object(k, r.payload -> 'data' -> k);
          ELSIF r.payload -> 'custom' ? k THEN cpatch := cpatch || jsonb_build_object(k, r.payload -> 'custom' -> k); END IF;
        END LOOP;
        PERFORM public.reg_save_record(key, rid, rver, NULL, NULL, patch, nullif(cpatch, '{}'::jsonb), NULL, false, r.id);
      ELSE
        rid := public.reg_save_record(key, NULL, NULL, r.site_id, r.record_type, r.payload -> 'data', nullif(r.payload -> 'custom', '{}'::jsonb), NULL, false, r.id);
      END IF;
      SELECT version INTO rver FROM public.register_records WHERE id = rid;
      UPDATE public.import_batch_rows SET register_record_id = rid WHERE id = r.id;      -- the overload below checks that the row belongs to the record
      -- 0088: the submit of a row approved directly right after sends no notice (no "waits for you" to L2, no "no holder" to the System Admins): see reg_notify
      IF b.historical_direct_approve THEN PERFORM set_config('pmis.hda_quiet_record', rid::text, true); END IF;
      PERFORM public.reg_transition_record(rid, rver, 'submit', NULL, p_stepup, r.id);
      IF b.historical_direct_approve THEN   -- 0088: a register sheet of the historical load marked for direct approval (read from the stored batch, never from the caller)
        PERFORM public.hda_approve_record(rid, b.id, r.id, p_stepup);
        PERFORM set_config('pmis.hda_quiet_record', '', true);
      END IF;
      SELECT state INTO st FROM public.register_records WHERE id = rid;
      UPDATE public.import_batch_rows SET register_record_id = rid, hold_reason = NULL,
        decision = CASE WHEN st = 'approved' THEN 'approved' ELSE 'pending' END,
        decided_by = CASE WHEN st = 'approved' THEN actor END, decided_at = CASE WHEN st = 'approved' THEN now() END WHERE id = r.id;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
      PERFORM set_config('pmis.hda_quiet_record', '', true);   -- 0088
      PERFORM set_config('app.batch_row', '', true);
      IF SQLERRM LIKE 'wf:step_up_required%' THEN
        IF NOT coalesce(p_async, false) THEN RAISE; END IF;
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'step_up_required',
          'message', 'This row is a final approval and needs a step-up: send the batch again after confirming your password.'));
        CONTINUE;
      END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be sent', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The register refused this row. See the System Log (template-check) for the technical reason.' END;
      IF j ->> 'code' = 'validation_failed' THEN
        msg := coalesce((SELECT string_agg(e ->> 'message', ' ') FROM jsonb_array_elements(j -> 'extra' -> 'errors') e), msg);
      END IF;
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', register_record_id = NULL, hold_reason = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  RETURN jsonb_build_object('submitted', submitted, 'processed', processed, 'held', held, 'failed', failed);
END $$;

-- imp_submit_register_finish (latest 0075; 0088 marked: a batch approved directly is closed, the audit row counts the direct approvals)
CREATE OR REPLACE FUNCTION imp_submit_register_finish(p_batch uuid, p_prev_status text, p_submitted integer, p_held integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); new_st text; b public.import_batches%ROWTYPE;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  new_st := CASE WHEN p_submitted > 0 OR p_prev_status <> 'validated' THEN public.imp_status_of_after(p_batch) ELSE p_prev_status END;
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    closed_at = CASE WHEN new_st = 'approved' AND b.historical_direct_approve THEN now() ELSE closed_at END,   -- 0088
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_submit', 'import_batch', p_batch::text, NULL,
    jsonb_build_object('submitted', p_submitted, 'held', p_held, 'failed', p_failed, 'status', new_st)
      || CASE WHEN b.historical_direct_approve THEN jsonb_build_object('approved_directly',   -- 0088
           (SELECT count(*) FROM public.register_records x JOIN public.import_batch_rows y ON y.register_record_id = x.id AND y.batch_id = p_batch
             WHERE x.historical_direct_batch_id = p_batch AND x.historical_direct_approved)) ELSE '{}'::jsonb END, NULL);
  RETURN new_st;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Staging the register sheets of the file (internal; called only by mi_apply_run)
-- ---------------------------------------------------------------------------------------------------------------------
-- p_regs = {file_sha256, parts: [{register, template_id, sheet, rows: [{row_no, sheet, site_code, record_type, data, pre_errors}]}], skipped: [...], notes: [...]}
-- as the API read them from the run's stored file (mi_apply_run checked the SHA-256). Only the eight register sheets of the map are accepted, once each; a row
-- keeps only the fields of a register row (no custom field, no Record ID), and every personal field of the template (landlord, contact, phone, e-mail: Q469)
-- is dropped again. Each sheet is staged as the register's own template (imp_master_unit: the staging of a register sheet of TPL-MASTER) in the group of the
-- run, source master_import, then marked historical (hw_mark_batch). A sheet that cannot be staged is reported in `skipped` with its reason (its staging is
-- rolled back alone); nothing stops the apply. Returns {batches, skipped, notes}.
CREATE OR REPLACE FUNCTION hrg_stage_registers(p_regs jsonb, p_run public.master_reconciliation_runs, p_mode text, p_group uuid, p_hw_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); part jsonb; rk text; sheet text; d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; personal text[]; rows_ jsonb;
  n int; u jsonb; res jsonb; bid uuid; j jsonb; seen text[] := ARRAY[]::text[]; batches jsonb[] := ARRAY[]::jsonb[]; skipped jsonb[] := ARRAY[]::jsonb[]; s jsonb; notes jsonb;
  allowed constant text[] := ARRAY['rf_design', 'acquisition', 'permits_hse', 'procurement', 'gecol', 'hlc', 'as_built', 'risks'];
  cutoff date := public.hw_waiver_cutoff();
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- the sheets the API could not read (missing, no Site ID column, too many rows ...): reported as skipped
  FOR s IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_regs -> 'skipped') = 'array' THEN p_regs -> 'skipped' ELSE '[]'::jsonb END) x LIMIT 50 LOOP
    skipped := array_append(skipped, jsonb_build_object('sheet', left(s ->> 'sheet', 60), 'kind', 'register', 'ref', left(s ->> 'ref', 40),
      'reason', left(coalesce(s ->> 'reason', 'not_read'), 40), 'detail', left(s ->> 'detail', 300)));
  END LOOP;
  FOR part IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_regs -> 'parts') = 'array' THEN p_regs -> 'parts' ELSE '[]'::jsonb END) x LOOP
    rk := part ->> 'register';
    sheet := left(coalesce(part ->> 'sheet', rk), 60);
    IF rk IS NULL OR NOT rk = ANY (allowed) OR rk = ANY (seen) THEN
      skipped := array_append(skipped, jsonb_build_object('sheet', sheet, 'kind', 'register', 'ref', left(rk, 40), 'reason', 'register_not_loaded',
        'detail', 'This sheet is not one of the register sheets the Master import loads.'));
      CONTINUE;
    END IF;
    seen := seen || rk;
    SELECT * INTO d FROM public.template_definitions x WHERE x.kind = 'register' AND x.register_key = rk AND x.is_active AND x.template_id = part ->> 'template_id';
    IF NOT FOUND THEN
      skipped := array_append(skipped, jsonb_build_object('sheet', sheet, 'kind', 'register', 'ref', rk, 'reason', 'template_unknown_or_inactive',
        'detail', 'The register template of this sheet is not in use.'));
      CONTINUE;
    END IF;
    SELECT * INTO v FROM public.template_versions x WHERE x.template_def_id = d.id AND x.is_current;
    SELECT coalesce(array_agg(c ->> 'code'), ARRAY[]::text[]) INTO personal FROM jsonb_array_elements(v.columns) c
    WHERE c ->> 'header' ~* '(landlord|contact|phone|e-?mail)';
    SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('row_no', (t.e ->> 'row_no')::int, 'sheet', sheet,
             'site_code', left(nullif(btrim(t.e ->> 'site_code'), ''), 60), 'record_type', left(nullif(btrim(t.e ->> 'record_type'), ''), 40),
             'data', CASE WHEN jsonb_typeof(t.e -> 'data') = 'object' THEN (t.e -> 'data') - personal ELSE '{}'::jsonb END, 'custom', '{}'::jsonb,
             'pre_errors', CASE WHEN jsonb_typeof(t.e -> 'pre_errors') = 'array' THEN t.e -> 'pre_errors' ELSE '[]'::jsonb END)) ORDER BY t.o), '[]'::jsonb), count(*)
      INTO rows_, n
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(part -> 'rows') = 'array' THEN part -> 'rows' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, o)
    WHERE jsonb_typeof(t.e) = 'object' AND (t.e ->> 'row_no') ~ '^[0-9]{1,7}$';
    IF n = 0 THEN
      skipped := array_append(skipped, jsonb_build_object('sheet', sheet, 'kind', 'register', 'ref', rk, 'reason', 'no_rows', 'detail', 'The sheet has no data rows.'));
      CONTINUE;
    END IF;
    IF n > 5000 THEN
      skipped := array_append(skipped, jsonb_build_object('sheet', sheet, 'kind', 'register', 'ref', rk, 'reason', 'size_or_rows_exceeded', 'detail', 'The sheet has more than 5000 rows.'));
      CONTINUE;
    END IF;
    u := jsonb_build_object('kind', 'register', 'sheet', sheet, 'ref', rk, 'template_id', d.template_id, 'version', v.version, 'checksum', v.header_checksum, 'rows', rows_);
    BEGIN
      res := public.imp_master_unit(u, p_run.file_name, p_run.file_sha256, p_mode, 'master_import', p_group, NULL, NULL);
      IF res ? 'batch' THEN
        bid := (res -> 'batch' ->> 'id')::uuid;
        PERFORM public.hw_mark_batch(bid, p_hw_reason, cutoff);
        batches := array_append(batches, res -> 'batch');
      ELSIF res ? 'skipped' THEN
        skipped := array_append(skipped, res -> 'skipped');
      END IF;
    EXCEPTION WHEN others THEN
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        PERFORM public.log_system_write('warn', 'master-import', 'legacy Master import: a register sheet could not be staged',
          jsonb_build_object('run_id', p_run.id, 'sheet', sheet, 'register', rk, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor, NULL);
      END IF;
      skipped := array_append(skipped, jsonb_build_object('sheet', sheet, 'kind', 'register', 'ref', rk, 'reason', coalesce(j ->> 'code', 'staging_failed'),
        'detail', left(coalesce(j -> 'extra' ->> 'detail', 'The sheet could not be staged. See the System Log (master-import).'), 300)));
    END;
  END LOOP;
  -- the notes of the reading (counts, cell addresses and header names only, never a value)
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('sheet', left(x ->> 'sheet', 60), 'ref', left(x ->> 'ref', 40), 'code', left(x ->> 'code', 40),
           'count', CASE WHEN (x ->> 'count') ~ '^[0-9]{1,7}$' THEN (x ->> 'count')::int END,
           'cells', CASE WHEN jsonb_typeof(x -> 'cells') = 'array' THEN (SELECT jsonb_agg(left(c #>> '{}', 20)) FROM (SELECT c FROM jsonb_array_elements(x -> 'cells') c LIMIT 25) q) END,
           'headers', CASE WHEN jsonb_typeof(x -> 'headers') = 'array' THEN (SELECT jsonb_agg(left(c #>> '{}', 80)) FROM (SELECT c FROM jsonb_array_elements(x -> 'headers') c LIMIT 60) q) END))), '[]'::jsonb)
    INTO notes
  FROM (SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_regs -> 'notes') = 'array' THEN p_regs -> 'notes' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) = 'object' LIMIT 100) y;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES ('import_master_legacy_registers', 'import_group', p_group::text,
          jsonb_build_object('run_id', p_run.id, 'file_name', p_run.file_name, 'file_sha256', p_run.file_sha256, 'batches', to_jsonb(batches), 'skipped', to_jsonb(skipped),
            'personal_columns', 'never read (Q469)'), actor);
  RETURN jsonb_build_object('batches', to_jsonb(batches), 'skipped', to_jsonb(skipped), 'notes', notes);
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The apply: mi_apply_run with the register sheets (new signature; the body is that of 0087, changes marked 0088), its old signature as a wrapper,
--    and mi_apply_step (latest 0087, changes marked 0088)
-- ---------------------------------------------------------------------------------------------------------------------
-- mi_apply_run, new signature with p_registers (the body of 0087, changes marked 0088)
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb, p_registers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); r public.master_reconciliation_runs%ROWTYPE; prev uuid; tv public.template_versions%ROWTYPE; mpart jsonb; mcols jsonb; v_rows jsonb := '[]'::jsonb;
  row_ record; cells jsonb; pres jsonb; c jsonb; cv jsonb; res jsonb; b jsonb; sent jsonb; v_outcome jsonb; batches jsonb := '[]'::jsonb; gid uuid := gen_random_uuid();
  hw jsonb;   -- 0073: the mark of the batches
  q jsonb; queued int := 0;   -- 0075: a batch sent in the background
  su_until timestamptz;        -- 0075: when the verified step-up of this session ends (from the session row, never from the caller), for the audit rows of the run
  bg uuid := CASE WHEN coalesce(current_setting('pmis.mi_apply_job', true), '') ~ '^[0-9a-f-]{36}$' THEN current_setting('pmis.mi_apply_job', true)::uuid END;   -- 0086: the background run of this apply
  lim int; nsites int; jid uuid;   -- 0086
  hda boolean := false;   -- 0087: the historical load is approved directly (admin override, no L2)
  hrg boolean := false; regs jsonb; rres jsonb; rnotes jsonb := '[]'::jsonb;   -- 0088: the register sheets of the same file
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  SELECT * INTO r FROM public.master_reconciliation_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The import run does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The run changed since you read it. Reload and try again.')); END IF;
  IF r.status = 'applying' AND bg IS NULL THEN   -- 0086
    PERFORM public.wf_err('upload_processing', jsonb_build_object('detail', 'This file is being applied in the background. Wait until it ends.', 'run_id', p_run));
  END IF;
  IF NOT (r.status = 'previewed' OR (r.status = 'applying' AND bg IS NOT NULL AND EXISTS (SELECT 1 FROM public.mi_apply_jobs j WHERE j.id = bg AND j.run_id = p_run AND j.state = 'running'))) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This run was already applied.'));
  END IF;
  IF coalesce(p_mode, '') NOT IN ('submit', 'draft') OR coalesce(char_length(btrim(p_reason)), 0) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(
      jsonb_build_object('path', CASE WHEN coalesce(p_mode, '') NOT IN ('submit', 'draft') THEN '/mode' ELSE '/reason' END, 'code', 'required',
        'message', CASE WHEN coalesce(p_mode, '') NOT IN ('submit', 'draft') THEN 'mode is submit or draft.' ELSE 'A reason is required.' END))));
  END IF;
  IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  IF p_historical IS NOT NULL THEN
    -- 0073 (Q462): a System Admin (not a delegate), the waiver open, a reason; draft mode has no document check, so it cannot be marked
    IF p_mode <> 'submit' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'The historical load is for the submit mode.'))));
    END IF;
    PERFORM public.hw_mark_authorize(p_historical ->> 'reason');
    hw := jsonb_build_object('reason', btrim(p_historical ->> 'reason'));
    hda := coalesce(p_historical -> 'approve_directly' = 'true'::jsonb, false);   -- 0087
    hrg := coalesce(p_historical -> 'registers' = 'true'::jsonb, false);          -- 0088
  END IF;
  -- 0088: the register sheets are read by the API from the file stored with this run (never sent by the caller of the endpoint); they come only with the
  -- historical option, and they must be of this file (its SHA-256)
  IF (p_registers IS NOT NULL OR hrg) AND p_historical IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load/registers', 'code', 'invalid',
      'message', 'The register sheets are loaded with the historical load only.'))));
  END IF;
  IF hrg AND (p_registers IS NULL OR jsonb_typeof(p_registers) <> 'object' OR p_registers ->> 'file_sha256' IS DISTINCT FROM r.file_sha256
              OR jsonb_typeof(coalesce(p_registers -> 'parts', '[]'::jsonb)) <> 'array') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The register sheets were not read from the file of this run. Apply the file again.'));
  END IF;
  regs := CASE WHEN hrg THEN p_registers END;
  IF public.app_ctx_stepup() AND bg IS NULL THEN   -- 0075 (0086: in the background, the expiry recorded at the request)
    SELECT us.stepup_at + make_interval(secs => coalesce((SELECT CASE WHEN jsonb_typeof(st.value) = 'number' THEN (st.value #>> '{}')::int END
                                                          FROM public.settings st WHERE st.key = 'stepup_max_age_seconds'), 300))
      INTO su_until FROM public.user_sessions us WHERE us.id = public.log_ctx_uuid('session_id') AND us.user_id = actor AND us.revoked_at IS NULL AND us.stepup_at IS NOT NULL;
  ELSIF bg IS NOT NULL THEN
    SELECT j.stepup_until INTO su_until FROM public.mi_apply_jobs j WHERE j.id = bg;
  END IF;
  SELECT x.id INTO prev FROM public.master_reconciliation_runs x WHERE x.file_sha256 = r.file_sha256 AND x.status = 'applied' AND x.id <> r.id LIMIT 1;
  IF prev IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This file was already applied (run ' || prev::text || '). A reconciliation run compares again; it never applies the same file twice.'));
  END IF;
  -- 0086: a file with more sites than imports.async_rows is applied in the background, every check above passed: the request records the run and answers 202
  -- (status applying); mi_apply_step does the very same apply in a transaction of its own under the same person's signed context (no 30 s request limit)
  IF bg IS NULL THEN
    BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;
    SELECT count(DISTINCT upper(x.site_code)) INTO nsites FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL;
    IF nsites > lim THEN
      INSERT INTO public.mi_apply_jobs (run_id, actor_id, mode, reason, hw_reason, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, sites_total,
                                        approve_directly, load_registers, registers)   -- 0087, 0088
      VALUES (p_run, actor, p_mode, left(btrim(p_reason), 2000), hw ->> 'reason', true, su_until,
              CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
              public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64), nsites,
              hda, hrg, regs)
      RETURNING id INTO jid;
      UPDATE public.master_reconciliation_runs SET status = 'applying', version = version + 1 WHERE id = p_run;
      PERFORM public.log_audit_write('master_import.apply_queued', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
        jsonb_build_object('status', 'applying', 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
          'approve_directly', hda, 'registers', hrg), btrim(p_reason));   -- 0087, 0088
      PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: apply queued', jsonb_build_object('run_id', p_run, 'job_id', jid, 'mode', p_mode, 'sites', nsites), actor, NULL);
      RETURN jsonb_build_object('queued_apply', true, 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'batches', '[]'::jsonb, 'queued', 0, 'approve_directly', hda, 'registers', hrg);
    END IF;
  END IF;
  IF hw IS NOT NULL THEN
    -- 0085: the historical load accepts the data as it is: every site of the file loses its workflow locks first (audited per site, the reason of the load)
    PERFORM public.swl_open_for_load((SELECT array_agg(DISTINCT x.site_id) FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL),
      hw ->> 'reason', 'historical_master_import');
  END IF;

  SELECT v.* INTO tv FROM public.template_versions v JOIN public.template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MASTER' AND v.is_current;
  SELECT x INTO mpart FROM jsonb_array_elements(tv.columns) x WHERE x ->> 'kind' = 'master' LIMIT 1;
  mcols := mpart -> 'columns';
  FOR row_ IN SELECT * FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL ORDER BY x.row_no LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.master_reconciliation_rows y WHERE y.run_id = p_run AND upper(y.site_code) = upper(row_.site_code) AND y.row_no < row_.row_no);
    cells := '{}'::jsonb; pres := '[]'::jsonb;
    FOR c IN SELECT x FROM jsonb_array_elements(mcols) x WHERE x ->> 'kind' = 'task' AND NOT coalesce((x ->> 'derived')::boolean, false) LOOP
      cv := row_.cells -> (c ->> 'master_col');
      CONTINUE WHEN cv IS NULL OR cv -> 'v' IS NULL OR jsonb_typeof(cv -> 'v') = 'null';
      IF coalesce((cv ->> 'f')::boolean, false) THEN
        pres := pres || jsonb_build_array(jsonb_build_object('column', c ->> 'header', 'field', c ->> 'code', 'code', 'formula_not_allowed', 'message', 'Cells must hold values, not formulas.'));
      ELSE
        cells := cells || jsonb_build_object(c ->> 'code', cv -> 'v');
      END IF;
    END LOOP;
    CONTINUE WHEN cells = '{}'::jsonb AND pres = '[]'::jsonb;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('row_no', row_.row_no, 'site_code', row_.site_code, 'cells', cells, 'pre_errors', pres));
  END LOOP;
  IF jsonb_array_length(v_rows) = 0 AND NOT (hrg AND jsonb_array_length(coalesce(regs -> 'parts', '[]'::jsonb)) > 0) THEN   -- 0088: a file of register sheets only
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'No typed task column of this file belongs to a site of GSDN Workspace: nothing can be entered.'));
  END IF;
  IF jsonb_array_length(v_rows) > 0 THEN
    res := public.imp_stage_master_core('TPL-MASTER', tv.version, r.file_name, r.file_sha256,
      jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid, hw);
  ELSE
    res := jsonb_build_object('group_id', gid, 'batches', '[]'::jsonb, 'skipped', '[]'::jsonb);
  END IF;
  IF hrg THEN
    -- 0088: each register sheet becomes a register batch of the same group (source master_import, the historical mark), after the stream batches, so it is
    -- sent after them; a sheet that cannot be staged is skipped with its reason, never the whole apply
    rres := public.hrg_stage_registers(regs, r, p_mode, gid, hw ->> 'reason');
    res := res || jsonb_build_object('batches', (res -> 'batches') || (rres -> 'batches'), 'skipped', coalesce(res -> 'skipped', '[]'::jsonb) || (rres -> 'skipped'));
    rnotes := rres -> 'notes';
  END IF;
  IF hda THEN
    -- 0087: the batches just staged are marked for direct approval (a System Admin, the step-up, the open waiver, checked again on each batch); every
    -- submitted row of them is then approved at once by the sender, here or in the chunked background send (the mark is read from the batch row there)
    PERFORM public.hda_mark_batches(ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(res -> 'batches') x), hw ->> 'reason');
  END IF;
  FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x LOOP
    -- 0075: a batch with more rows than imports.async_rows is sent in the background (the checks of the request run in imp_async_start, the rows in chunks)
    q := public.imp_async_start((b ->> 'id')::uuid, NULL, 'submit', NULL, NULL, NULL, NULL, su_until);
    IF coalesce((q ->> 'queued')::boolean, false) THEN
      queued := queued + 1;
      batches := batches || jsonb_build_array(b || jsonb_build_object('queued', true, 'job_id', q -> 'job' -> 'job_id', 'rows', q -> 'job' -> 'rows_total',
        'submitted', 0, 'saved', 0, 'held', 0, 'failed', 0, 'approved', 0,
        'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
        'skipped', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'unchanged')));   -- 0088
      CONTINUE;
    END IF;
    sent := public.imp_submit_batch((b ->> 'id')::uuid, NULL, p_stepup);
    batches := batches || jsonb_build_array(b || jsonb_build_object('submitted', sent -> 'submitted', 'saved', sent -> 'saved', 'held', jsonb_array_length(coalesce(sent -> 'held', '[]'::jsonb)),
      'failed', jsonb_array_length(coalesce(sent -> 'failed', '[]'::jsonb)),
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
      'approved', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action IN ('create', 'update') AND x.decision = 'approved'),   -- 0087, 0088
      'rows', (SELECT x.rows_total FROM public.import_batches x WHERE x.id = (b ->> 'id')::uuid),   -- 0088: the rows of the batch, and the rows that changed nothing
      'skipped', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'unchanged')));
  END LOOP;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued, 'approve_directly', hda,   -- 0087
    'registers', hrg, 'register_notes', rnotes);   -- 0088
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
      'approve_directly', hda, 'registers', hrg), btrim(p_reason));   -- 0087, 0088
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;

-- The signature of 0073 / 0087 (granted; the 5-argument wrapper of 0073 calls it): the same apply without register sheets.
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN public.mi_apply_run(p_run, p_version, p_mode, p_reason, p_stepup, p_historical, NULL::jsonb);
END $function$;

-- mi_apply_step (latest 0087, changes marked 0088)
CREATE OR REPLACE FUNCTION mi_apply_step(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); j public.mi_apply_jobs%ROWTYPE; res jsonb; e jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO j FROM public.mi_apply_jobs WHERE id = p_job FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.mi_apply_jobs WHERE id = p_job) THEN RETURN jsonb_build_object('job_id', p_job, 'state', 'busy'); END IF;
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The apply run does not exist.'));
  END IF;
  IF j.actor_id <> actor THEN RAISE EXCEPTION 'only the person who applied the file continues its run' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF j.state <> 'running' THEN RETURN jsonb_build_object('job_id', j.id, 'state', j.state); END IF;
  UPDATE public.mi_apply_jobs SET tries = tries + 1, heartbeat_at = clock_timestamp() WHERE id = p_job;
  PERFORM set_config('pmis.mi_apply_job', p_job::text, true);
  BEGIN
    res := public.mi_apply_run(j.run_id, NULL, j.mode, j.reason, j.stepup_verified,
      CASE WHEN j.hw_reason IS NOT NULL THEN jsonb_build_object('reason', j.hw_reason, 'approve_directly', j.approve_directly, 'registers', j.load_registers) END,
      j.registers);   -- 0087, 0088: the choices and the register sheets stored at the request (the sheets read by the API from the run's file)
  EXCEPTION WHEN others THEN
    PERFORM set_config('pmis.mi_apply_job', '', true);
    e := public.imp_wf_json(SQLERRM);
    IF e IS NULL THEN RAISE; END IF;   -- not a refusal of the apply: the API tries again, then stops the run (mi_apply_abandon)
    PERFORM public.mi_apply_fail(p_job, e ->> 'code', coalesce(e -> 'extra' ->> 'detail',
      CASE WHEN e ->> 'code' = 'step_up_required' THEN 'The confirmation of your password expired before the background run started. Apply the file again.' END, e ->> 'code'));
    RETURN jsonb_build_object('job_id', j.id, 'state', 'failed', 'code', e ->> 'code');
  END;
  PERFORM set_config('pmis.mi_apply_job', '', true);
  UPDATE public.mi_apply_jobs SET state = 'done', outcome = res, finished_at = clock_timestamp(), heartbeat_at = clock_timestamp() WHERE id = p_job;
  RETURN jsonb_build_object('job_id', j.id, 'state', 'done', 'outcome', res);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC. pmis_app gets only the new signature of mi_apply_run
--    (the API door of the apply); the stage, the direct approval, the guards and the helpers are internal. The redefined functions keep their owner and grants.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hrg_jobs_clear()', 'hrg_row_historical()', 'hda_approve_record(uuid,uuid,uuid,boolean)', 'hda_guard_record()',
                           'hrg_stage_registers(jsonb,master_reconciliation_runs,text,uuid,text)', 'mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      IF f LIKE 'mi_apply_run(%' THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
      ELSE
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f);
      END IF;
    END IF;
  END LOOP;
END $$;
