-- 0125_historical_reapply_fix: the historical re-apply approved directly sends every dated row of a task that is not approved, the Matrix entry holder (L1)
-- does not stop a row of the System Admin's historical direct approval, and a register value outside its list is kept as typed (owner report 2026-11-18,
-- run f0274405; CHANGELOG 164; no contract change).
-- Mirror: db/sql/124_historical_reapply_fix.sql (kept byte-identical).
--
-- WHY (what the re-apply of 2026-11-18 14:44 showed, read from the code of 0085 / 0037 / 0122):
--   1. "unchanged" is decided by imp_stage_task_row against the task itself (task_instances.planned_date, actual_start, actual_date and values), never
--      against a batch, a template or an earlier run. A row is "unchanged" when (a) it equals what the task holds, (b) the task is approved, N/A, skipped,
--      suspended or rejected (the historical load keeps what the system holds; warning task_approved / task_not_open), or (c) the task does not exist on the
--      site (warning task_not_on_site). Case (a) also catches a task that is NOT approved: an earlier load or an entry saved the same values on it (the
--      historical save-only rows of 0085, a draft, a submission returned to entry, an admin date edit) and nothing sent it since; such a row was never
--      sent, so the task stayed open although the file carries its actual date.
--   2. The Matrix entry-holder check (L1) runs on every row of the historical load like an ordinary upload: imp_stage_task_row (task rows, note
--      not_entry_holder), imp_stage_register_row (register rows, code not_entry_holder), and when a row is sent, wf_require_actor (wf_start, wf_save_entry,
--      wf_complete_hw), reg_save_record, reg_new_version, reg_require_actor (reg_complete) and the triggers reg_scope_entry_guard / reg_permit_submit_guard (the
--      scoped rows: a permit per stream, a PR-PO row per scope). A System Admin passes it only when the Matrix cell has no
--      holder (B10). On the server the Matrix names holders, so 468 Acquisition rows, 235 RF & Design rows (and the rows of the other sheets and of CW / TE)
--      were refused, and the Design & Acquisition rows of A2 / A4 too.
--   3. A list value of the owner's file that is not a value (code, label or alias) of the register's list is refused (not_in_list) by reg_clean_data, before
--      anything else is checked.
--
-- WHAT THIS CHANGES (only for the historical load approved directly: a System Admin, never a delegate, a step-up, a reason, the waiver open, approve_directly;
-- every other check of 0073 / 0085 / 0092 / 0093 / 0122 / 0123 / 0124 stays):
--   1. A row of the historical load approved directly that carries an actual date is sent and approved directly when its task is open, in entry or locked and
--      already holds the values of the row (warning historical_resend). Approved, N/A, skipped, suspended and rejected tasks keep their "unchanged" (never
--      approved twice, never reopened); a task with its own submission in review or approval keeps its L2 path; a row without an actual date is not sent
--      (nothing to approve).
--   2. The Matrix entry holder (L1) does not stop such a row (owner decision "nothing stops the stages": the direct approval is the admin override). Only that
--      check is lifted, only in that path: (a) while mi_apply_run stages the file, through a mark of its own transaction in hrf_stage_marks (written only by
--      mi_apply_run, after its checks; removed when the staging ends); (b) while a row is sent, through hrf_override_ok: the row being sent (app.batch_row) is
--      an unsent create / update row of a batch marked for direct approval that the signed-in System Admin may still approve directly (hda_batch_ok: the
--      uploader and marker, the waiver open, its cutoff), and it is the row of this task or of this register record. The region and module grants, the
--      claim of another holder, the locks, the dates, the documents and the register's own rules keep their checks. Each such row carries the warning
--      historical_entry_override; one audit row per batch (`import_batch.historical_entry_override`, admin override, the reason of the load) counts the rows
--      entered by override, the rows sent again and the list values kept; each task and record keeps its own audit row of the direct approval (0092 / 0093).
--   3. A value outside a register list is kept as typed on such a register row (reg_list_value and the submit rule p5_record_rules answer as for a list that
--      allows other values, the existing rule of list_catalogues.allow_other; at most 200 characters), with the warning not_in_list_kept on the row (the value and the list named), so the record
--      is loaded and approved; the admin adds the value (or an alias) to the list, or corrects the record. Ordinary uploads keep refusing it.
--   4. site_not_in_scope is unchanged: a Site ID of a register sheet that is no site of GSDN Workspace (or outside the loader's regions; a System Admin has
--      all of them).
--
-- Getting it applied: run f0274405 is applied and is never applied again (0122). Upload the same file again (a new previewed run of the same SHA-256) and apply
-- it with historical_load {approve_directly, registers, reapply}: hrp_discard_open (0122) first discards every open Master batch of a historical load (the
-- validated batches of f0274405 included, their rows rejected "discarded: ..."), then the file is staged with this migration's rules. No catch-up runs here:
-- the refused rows of f0274405 were staged as errors and must be staged again from the file.
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0125"; the search path now ends with pg_temp): wf_require_actor (0015),
-- reg_require_actor (0019), reg_save_record 9 arguments (0103), reg_new_version 2 arguments (0037), reg_list_value (0057), the trigger function
-- p5_record_rules (0057: the list rule of a register record at submit), the trigger functions reg_scope_entry_guard and reg_permit_submit_guard
-- (0054: the scoped Matrix rows of Permits and PR-PO, at entry and at the submit of a permit), imp_stage_register_row (0037),
-- imp_stage_task_row 8 arguments (0085), mi_apply_run 7 arguments (0124). CREATE OR REPLACE keeps their owner (pmis_definer) and grants.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. No new function is granted to
-- pmis_app: the API door stays mi_apply_run / mi_apply_step. The new table hrf_stage_marks has row security forced and no right for pmis_app.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The mark of a staging of the historical load approved directly (one row per transaction of mi_apply_run; never read or written by pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE hrf_stage_marks (
  xid        bigint      PRIMARY KEY,                 -- txid_current() of the transaction of mi_apply_run (also its probes, which are subtransactions)
  actor_id   uuid        NOT NULL REFERENCES users (id),
  run_id     uuid        NOT NULL REFERENCES master_reconciliation_runs (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE hrf_stage_marks IS '0125: the staging of a historical Master load approved directly, for the transaction of mi_apply_run only (removed when the staging ends). Written only by mi_apply_run; no right for pmis_app.';
ALTER TABLE hrf_stage_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrf_stage_marks FORCE ROW LEVEL SECURITY;   -- no policy: only the definer functions (pmis_definer bypasses row security) read it
REVOKE ALL ON hrf_stage_marks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON hrf_stage_marks TO pmis_definer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN REVOKE ALL ON hrf_stage_marks FROM pmis_app; END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The checks of the override (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- True while mi_apply_run stages a historical load approved directly in this transaction, for the System Admin who applies it, the waiver open.
CREATE OR REPLACE FUNCTION hrf_staging() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.app_actor() IS NOT NULL AND public.app_user_is_system_admin(public.app_actor()) AND public.hw_waiver_open_now()
    AND EXISTS (SELECT 1 FROM public.hrf_stage_marks m WHERE m.xid = txid_current() AND m.actor_id = public.app_actor())
$$;

-- True when the signed-in System Admin enters this task (p_task), this register record (p_record) or a new record of this register (p_key) as the admin
-- override of the historical direct approval: during the staging (hrf_staging), or while the row of it is sent (app.batch_row: an unsent create / update row
-- of a batch marked for direct approval that this System Admin may still approve directly, hda_batch_ok; the row of this task, or of this register and
-- record). With every argument NULL: any register row of such a batch (a list value kept as typed).
CREATE OR REPLACE FUNCTION hrf_override_ok(p_task uuid, p_record uuid, p_key text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); rid uuid; ent uuid;
BEGIN
  IF actor IS NULL OR NOT public.app_user_is_system_admin(actor) OR NOT public.hw_waiver_open_now() THEN RETURN false; END IF;
  IF public.hrf_staging() THEN RETURN true; END IF;
  rid := public.imp_current_row();
  IF rid IS NULL THEN RETURN false; END IF;
  IF p_record IS NOT NULL THEN SELECT x.entity_id INTO ent FROM public.register_records x WHERE x.id = p_record; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.import_batch_rows r JOIN public.import_batches b ON b.id = r.batch_id
    WHERE r.id = rid AND b.source = 'master_import' AND b.historical_load AND b.historical_direct_approve AND b.status <> 'discarded' AND public.hda_batch_ok(b)
      AND r.action IN ('create', 'update') AND r.decision IN ('pending', 'pending_previous_approval')
      AND CASE WHEN p_task IS NOT NULL THEN b.stream_code IS NOT NULL AND r.task_instance_id = p_task AND r.task_submitted_at IS NULL
               ELSE b.register_key IS NOT NULL AND (p_key IS NULL OR b.register_key = p_key)
                    AND (p_record IS NULL OR r.register_record_id = p_record OR (ent IS NOT NULL AND r.matched_entity_id = ent)) END);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The rows of the override, noted and audited after the staging (internal; called only by mi_apply_run)
-- ---------------------------------------------------------------------------------------------------------------------
-- For each batch just marked for direct approval: the register rows the signed-in System Admin enters without being the Matrix entry holder (L1) get the
-- warning historical_entry_override, and a value kept outside its list the warning not_in_list_kept (the task rows got theirs while staged); one audit row
-- per batch with the counts (admin override, the reason of the load). Returns [{id, register_key, stream_code, rows_entry_override, rows_resent,
-- values_kept_outside_list}].
CREATE OR REPLACE FUNCTION hrf_note_batches(p_batches uuid[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r record; f record; v text; notes jsonb; n_ovr int; n_res int; n_list int;
  out_ jsonb[] := ARRAY[]::jsonb[]; c jsonb; rk text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  FOR b IN SELECT * FROM public.import_batches x WHERE x.id = ANY (coalesce(p_batches, ARRAY[]::uuid[])) ORDER BY x.created_at, x.id LOOP
    IF NOT (b.historical_direct_approve AND public.hda_batch_ok(b)) THEN
      RAISE EXCEPTION 'historical direct approval: only a batch of the signed-in System Admin marked for direct approval is noted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    n_ovr := 0; n_res := 0; n_list := 0;
    IF b.stream_code IS NOT NULL THEN
      SELECT count(*) FILTER (WHERE x.warnings @> '[{"code": "historical_entry_override"}]'::jsonb),
             count(*) FILTER (WHERE x.warnings @> '[{"code": "historical_resend"}]'::jsonb)
        INTO n_ovr, n_res FROM public.import_batch_rows x WHERE x.batch_id = b.id AND x.action = 'update';
    ELSIF b.register_key IS NOT NULL THEN
      FOR r IN SELECT x.id, x.region_id, x.payload, coalesce(x.warnings, '[]'::jsonb) AS warnings FROM public.import_batch_rows x
               WHERE x.batch_id = b.id AND x.action IN ('create', 'update') ORDER BY x.row_no LOOP
        notes := '[]'::jsonb;
        rk := public.reg_row_key(b.register_key, coalesce(r.payload -> 'data', '{}'::jsonb));   -- the scoped row (a permit per stream, a PR-PO row per scope)
        IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders(b.register_key, r.region_id) h WHERE h.user_id = actor)
                OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(b.register_key, r.region_id))))
           OR NOT (EXISTS (SELECT 1 FROM public.reg_row_entry_holders(rk, r.region_id) h WHERE h.user_id = actor)
                   OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_row_entry_holders(rk, r.region_id)))) THEN
          notes := notes || jsonb_build_array(jsonb_build_object('code', 'historical_entry_override',
            'message', 'You are not an entry holder (L1) of this register row of the Matrix: entered as the admin override of the historical direct approval (audited).'));
          n_ovr := n_ovr + 1;
        END IF;
        FOR f IN SELECT rf.code, rf.label_en, rf.list_catalogue FROM public.register_fields rf JOIN public.list_catalogues lc ON lc.code = rf.list_catalogue
                 WHERE rf.register_key = b.register_key AND rf.is_active AND rf.field_type IN ('list', 'list_code') AND NOT coalesce(lc.allow_other, false)
                   AND NOT (jsonb_typeof(rf.options) = 'object' AND coalesce((rf.options ->> 'multiple')::boolean, false)) ORDER BY rf.sort_order, rf.code LOOP
          v := r.payload -> 'data' ->> f.code;
          CONTINUE WHEN v IS NULL OR public.list_pick(f.list_catalogue, v) IS NOT NULL;
          notes := notes || jsonb_build_array(jsonb_build_object('column', f.label_en, 'field', f.code, 'code', 'not_in_list_kept',
            'message', 'The value "' || left(v, 80) || '" is not in the list ' || f.list_catalogue || ': kept as typed (historical load). Add it to the list (or as an alias) in Settings, or correct the record.'));
          n_list := n_list + 1;
        END LOOP;
        IF notes <> '[]'::jsonb THEN UPDATE public.import_batch_rows SET warnings = r.warnings || notes WHERE id = r.id; END IF;
      END LOOP;
    END IF;
    CONTINUE WHEN n_ovr + n_res + n_list = 0;
    c := jsonb_build_object('id', b.id, 'register_key', b.register_key, 'stream_code', b.stream_code, 'rows_entry_override', n_ovr, 'rows_resent', n_res,
      'values_kept_outside_list', n_list);
    PERFORM public.log_audit_write('import_batch.historical_entry_override', 'import_batch', b.id::text, NULL,
      c || jsonb_build_object('rule', 'historical direct approval: the Matrix entry holder (L1) does not stop a row (admin override); a task that already holds the '
        || 'values of its dated row is sent and approved; a register value outside its list is kept as typed'),
      coalesce(nullif(btrim(p_reason), ''), b.historical_reason), NULL, NULL, NULL, true);
    out_ := array_append(out_, c);
  END LOOP;
  RETURN to_jsonb(out_);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The redefined functions (bodies unchanged except where marked "0125")
-- ---------------------------------------------------------------------------------------------------------------------
-- wf_require_actor (latest 0015)
CREATE OR REPLACE FUNCTION public.wf_require_actor(p_task uuid, p_kind text, p_actor uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t public.task_instances%ROWTYPE; rl public."MatrixRule"; is_admin boolean; has_holder boolean;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  rl := public.wf_rule(p_task, p_kind);
  is_admin := public.app_user_is_system_admin(p_actor);
  has_holder := public.wf_has_holder(p_task, p_kind);
  IF rl = 'all_members' THEN
    IF EXISTS (SELECT 1 FROM public.task_level_voters v WHERE v.task_id = p_task AND v.level = t.current_level AND v.round = t.level_round AND v.user_id = p_actor AND v.voted_at IS NULL) THEN
      RETURN 'vote';
    END IF;
    IF EXISTS (SELECT 1 FROM public.task_level_voters v WHERE v.task_id = p_task AND v.level = t.current_level AND v.round = t.level_round AND v.user_id = p_actor) THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'You have already voted on this level.'));
    END IF;
    IF is_admin AND NOT EXISTS (SELECT 1 FROM public.task_level_voters v WHERE v.task_id = p_task AND v.level = t.current_level AND v.round = t.level_round) THEN
      RETURN 'admin';
    END IF;
    IF p_kind = 'entry' AND p_actor = public.app_actor() AND public.hrf_override_ok(p_task, NULL, NULL) THEN RETURN 'admin'; END IF;   -- 0125
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF NOT (public.wf_is_eligible(p_task, p_kind, p_actor) OR (is_admin AND NOT has_holder))
     AND NOT (p_kind = 'entry' AND p_actor = public.app_actor() AND public.hrf_override_ok(p_task, NULL, NULL)) THEN   -- 0125: the historical direct approval
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF t.ball_in_court_user_id IS NOT NULL AND t.ball_in_court_user_id <> p_actor AND public.wf_is_eligible(p_task, p_kind, t.ball_in_court_user_id) THEN
    PERFORM public.wf_err('already_claimed', jsonb_build_object('claimed_by', t.ball_in_court_user_id));
  END IF;
  RETURN CASE WHEN public.wf_is_eligible(p_task, p_kind, p_actor) THEN 'holder' ELSE 'admin' END;
END $function$;

-- reg_require_actor (latest 0019)
CREATE OR REPLACE FUNCTION public.reg_require_actor(p_record uuid, p_kind text, p_actor uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r public.register_records%ROWTYPE; rl public."MatrixRule"; is_admin boolean; has_holder boolean;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  rl := public.reg_rule(p_record, p_kind);
  is_admin := public.app_user_is_system_admin(p_actor);
  has_holder := public.reg_has_holder(p_record, p_kind);
  IF rl = 'all_members' THEN
    IF EXISTS (SELECT 1 FROM public.register_level_voters v WHERE v.record_id = p_record AND v.level = r.current_level AND v.round = r.level_round AND v.user_id = p_actor AND v.voted_at IS NULL) THEN
      RETURN 'vote';
    END IF;
    IF EXISTS (SELECT 1 FROM public.register_level_voters v WHERE v.record_id = p_record AND v.level = r.current_level AND v.round = r.level_round AND v.user_id = p_actor) THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'You have already voted on this level.'));
    END IF;
    IF is_admin AND NOT EXISTS (SELECT 1 FROM public.register_level_voters v WHERE v.record_id = p_record AND v.level = r.current_level AND v.round = r.level_round) THEN
      RETURN 'admin';
    END IF;
    IF p_kind = 'entry' AND p_actor = public.app_actor() AND public.hrf_override_ok(NULL, p_record, r.register_key) THEN RETURN 'admin'; END IF;   -- 0125
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF NOT (public.reg_is_eligible(p_record, p_kind, p_actor) OR (is_admin AND NOT has_holder))
     AND NOT (p_kind = 'entry' AND p_actor = public.app_actor() AND public.hrf_override_ok(NULL, p_record, r.register_key)) THEN   -- 0125: the historical direct approval
    PERFORM public.wf_err('not_eligible_holder');
  END IF;
  IF r.ball_in_court_user_id IS NOT NULL AND r.ball_in_court_user_id <> p_actor AND public.reg_is_eligible(p_record, p_kind, r.ball_in_court_user_id) THEN
    PERFORM public.wf_err('already_claimed', jsonb_build_object('claimed_by', r.ball_in_court_user_id));
  END IF;
  RETURN CASE WHEN public.reg_is_eligible(p_record, p_kind, p_actor) THEN 'holder' ELSE 'admin' END;
END $function$;

-- reg_save_record, 9 arguments (latest 0103)
CREATE OR REPLACE FUNCTION public.reg_save_record(p_key text, p_id uuid, p_version integer, p_site uuid, p_record_type text, p_data jsonb, p_custom jsonb, p_party uuid, p_clear_party boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
            OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, s.region_id)))
            OR public.hrf_override_ok(NULL, NULL, p_key)) THEN   -- 0125: the historical direct approval
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
END $function$;

-- reg_new_version, 2 arguments (latest 0037)
CREATE OR REPLACE FUNCTION public.reg_new_version(p_record uuid, p_version integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; rid uuid; d public.register_definitions%ROWTYPE; cnt int; derived text[];
BEGIN
  r := public.reg_lock(p_record, p_version);
  SELECT * INTO d FROM public.register_definitions WHERE register_key = r.register_key AND is_active AND enabled;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'This register is not available.')); END IF;
  IF r.state <> 'approved' OR NOT r.is_current THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A new version is made from the approved version that is in force.'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = r.entity_id AND o.state IN ('entry', 'in_review', 'in_approval')) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'An open version of this record exists already.'));
  END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'edit');
  IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders(r.register_key, r.region_id) h WHERE h.user_id = actor)
          OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(r.register_key, r.region_id)))
          OR public.hrf_override_ok(NULL, p_record, r.register_key)) THEN   -- 0125: the historical direct approval
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not an entry holder of the ' || d.name_en || ' row of the Matrix.'));
  END IF;
  SELECT coalesce(array_agg(f.code), ARRAY[]::text[]) INTO derived FROM public.register_fields f WHERE f.register_key = r.register_key AND f.derived;
  SELECT count(*) INTO cnt FROM public.reg_entry_holders(r.register_key, r.region_id);
  INSERT INTO public.register_records (entity_id, version_no, supersedes_id, register_key, record_type, site_id, region_id, is_global, levels_required, data, custom, external_party_id,
    ball_in_court_user_id, created_by, level_opened_at)
  VALUES (r.entity_id, (SELECT max(o.version_no) + 1 FROM public.register_records o WHERE o.entity_id = r.entity_id), r.id, r.register_key, r.record_type, r.site_id, r.region_id, r.is_global,
    d.approval_levels, r.data - derived, r.custom, r.external_party_id, CASE WHEN cnt > 1 THEN actor END, actor, now())
  RETURNING id INTO rid;
  PERFORM public.reg_step(rid, 1, 'new_version', actor, NULL, NULL, 'entry', false, false);
  PERFORM public.reg_audit('register_record_new_version', rid, public.reg_snap(p_record), public.reg_snap(rid), NULL);
  RETURN rid;
END $function$;

-- reg_list_value (latest 0057)
CREATE OR REPLACE FUNCTION public.reg_list_value(p_catalogue text, p_text text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(public.list_pick(p_catalogue, p_text),
                  CASE WHEN (SELECT c.allow_other FROM public.list_catalogues c WHERE c.code = p_catalogue) AND char_length(btrim(p_text)) <= 200 THEN btrim(p_text) END,
                  -- 0125: a register row of the historical direct approval keeps a value outside the list as typed (as a list that allows other values)
                  CASE WHEN char_length(btrim(p_text)) BETWEEN 1 AND 200 AND public.hrf_override_ok(NULL, NULL, NULL) THEN btrim(p_text) END)
$function$;

-- p5_record_rules (latest 0057)
CREATE OR REPLACE FUNCTION public.p5_record_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  f record; v jsonb; prev jsonb; errs jsonb := '[]'::jsonb; c text; lv public.list_values%ROWTYPE; cat public.list_catalogues%ROWTYPE; missing text[];
BEGIN
  IF OLD.state = 'entry' THEN
    SELECT p.data INTO prev FROM public.register_records p WHERE p.id = NEW.supersedes_id;
    FOR f IN SELECT x.code, x.field_type, x.list_catalogue, x.options FROM public.register_fields x
             WHERE x.register_key = NEW.register_key AND x.is_active AND NOT x.derived AND x.field_type IN ('file', 'list', 'list_code', 'warehouse_item') LOOP
      v := NEW.data -> f.code;
      CONTINUE WHEN v IS NULL OR jsonb_typeof(v) = 'null';
      IF f.field_type = 'file' THEN
        IF NOT public.reg_record_file_ok(NEW.entity_id, (v #>> '{}')::uuid) THEN
          errs := errs || public.reg_err_item('/data/' || f.code, 'file_not_attached', 'Upload the file to the record''s documents and choose it here: a typed reference is not an upload (Q111).');
        END IF;
      ELSIF f.field_type = 'warehouse_item' THEN
        IF EXISTS (SELECT 1 FROM public.warehouse_items w WHERE w.id = (v #>> '{}')::uuid AND NOT w.is_active) AND (prev -> f.code) IS DISTINCT FROM v THEN
          errs := errs || public.reg_err_item('/data/' || f.code, 'inactive_value', 'This Warehouse item is deactivated: choose an active one.');
        END IF;
      ELSIF f.list_catalogue IS NOT NULL THEN
        SELECT * INTO cat FROM public.list_catalogues WHERE code = f.list_catalogue;
        FOR c IN SELECT CASE WHEN jsonb_typeof(v) = 'array' THEN e #>> '{}' ELSE v #>> '{}' END
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END) e LOOP
          SELECT * INTO lv FROM public.list_values WHERE catalogue_code = f.list_catalogue AND code = c;
          IF NOT FOUND THEN
            IF NOT cat.allow_other AND NOT coalesce(prev -> f.code @> to_jsonb(c) OR prev ->> f.code = c, false)
               AND NOT public.hrf_override_ok(NULL, NULL, NULL) THEN   -- 0125: a register row of the historical direct approval keeps it as typed
              errs := errs || public.reg_err_item('/data/' || f.code, 'not_in_list', '"' || left(c, 80) || '" is not a value of the list ' || cat.code || '.');
            END IF;
          ELSIF NOT lv.is_active AND NOT coalesce(prev -> f.code @> to_jsonb(c) OR prev ->> f.code = c, false) THEN
            errs := errs || public.reg_err_item('/data/' || f.code, 'inactive_value', '"' || left(c, 80) || '" is deactivated in the list ' || cat.code || ': choose an active value.');
          END IF;
        END LOOP;
      END IF;
    END LOOP;
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  END IF;
  IF NEW.state = 'approved' THEN
    -- Q104: a critical list without an active value blocks the approval of every record of a register that uses it
    SELECT array_agg(x ORDER BY x) INTO missing FROM unnest(public.list_catalogues_of(NEW.register_key)) x
    WHERE EXISTS (SELECT 1 FROM public.list_catalogues c2 WHERE c2.code = x AND c2.critical)
      AND NOT EXISTS (SELECT 1 FROM public.list_values v2 WHERE v2.catalogue_code = x AND v2.is_active);
    IF cardinality(missing) > 0 THEN
      PERFORM public.wf_err('list_not_configured', jsonb_build_object('lists', to_jsonb(missing),
        'detail', 'A critical list of this register has no value yet (' || array_to_string(missing, ', ') || '): ask the System Admin to configure it before approving.'));
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- reg_scope_entry_guard (latest 0054)
CREATE OR REPLACE FUNCTION public.reg_scope_entry_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid := public.app_actor(); rk text; n int; holder boolean; sc text; issue jsonb; permit boolean := NEW.register_key = 'permits_hse'; opening boolean := false;
BEGIN
  IF public.app_is_seeding() OR actor IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = NEW.register_key AND jsonb_typeof(d.rules -> 'scope_rows') = 'object') THEN RETURN NEW; END IF;
  IF NEW.state <> 'entry' THEN RETURN NEW; END IF;
  rk := public.reg_row_key(NEW.register_key, NEW.data);
  IF permit THEN
    issue := public.reg_permit_stream_issue(NEW.data);
    -- a new version of a permit entered before the stream choice existed: it opens without a stream, which is chosen before it is saved
    opening := TG_OP = 'INSERT' AND NEW.supersedes_id IS NOT NULL AND issue IS NOT NULL AND issue -> 0 ->> 'code' = 'stream_required';
    IF issue IS NOT NULL AND NOT opening THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', issue)); END IF;
  ELSIF TG_OP = 'UPDATE' AND rk = public.reg_row_key(OLD.register_key, OLD.data) THEN
    RETURN NEW;
  END IF;
  sc := public.reg_scope_of(NEW.register_key, NEW.data);
  IF opening THEN
    SELECT count(DISTINCT h.user_id)::int, coalesce(bool_or(h.user_id = actor), false) INTO n, holder
    FROM public.permit_types t CROSS JOIN LATERAL unnest(t.stream_options) o CROSS JOIN LATERAL public.reg_row_entry_holders(public.reg_permit_row(o), NEW.region_id) h
    WHERE t.code = NEW.data ->> 'permit_type';
  ELSE
    SELECT count(*)::int, coalesce(bool_or(h.user_id = actor), false) INTO n, holder FROM public.reg_row_entry_holders(rk, NEW.region_id) h;
  END IF;
  IF NOT holder AND NOT (n = 0 AND public.app_user_is_system_admin(actor))
     AND NOT public.hrf_override_ok(NULL, NULL, NEW.register_key) THEN   -- 0125: the historical direct approval
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail',
      'You are not an entry holder (L1) of the ' || coalesce((SELECT d.name_en FROM public.register_definitions d WHERE d.register_key = rk), rk)
      || ' row of the Matrix' || CASE WHEN sc IS NOT NULL THEN ' (' || CASE WHEN permit THEN 'stream ' ELSE 'scope ' END || sc || ')' ELSE '' END || '.'
      || CASE WHEN permit AND TG_OP = 'UPDATE' THEN ' Ask for a transfer of the draft to a qualified holder.' ELSE '' END));
  END IF;
  -- the claim pin of a new version follows the holders of its own row (one holder: nobody to claim against)
  IF TG_OP = 'INSERT' AND NEW.ball_in_court_user_id = actor AND n <= 1 THEN NEW.ball_in_court_user_id := NULL; END IF;
  RETURN NEW;
END $function$;

-- reg_permit_submit_guard (latest 0054)
CREATE OR REPLACE FUNCTION public.reg_permit_submit_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid := public.app_actor(); rk text; n int; holder boolean; issue jsonb;
BEGIN
  IF public.app_is_seeding() OR actor IS NULL THEN RETURN NEW; END IF;
  issue := public.reg_permit_stream_issue(NEW.data);
  IF issue IS NOT NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', issue)); END IF;
  rk := public.reg_row_key(NEW.register_key, NEW.data);
  SELECT count(*)::int, coalesce(bool_or(h.user_id = actor), false) INTO n, holder FROM public.reg_row_entry_holders(rk, NEW.region_id) h;
  IF NOT holder AND NOT (n = 0 AND public.app_user_is_system_admin(actor))
     AND NOT public.hrf_override_ok(NULL, NEW.id, NEW.register_key) THEN   -- 0125: the historical direct approval
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail',
      'You are no longer an entry holder (L1) of the ' || coalesce((SELECT d.name_en FROM public.register_definitions d WHERE d.register_key = rk), rk)
      || ' row of the Matrix, so you cannot submit this permit. Ask for a transfer of the draft to a qualified holder.'));
  END IF;
  RETURN NEW;
END $function$;

-- imp_stage_register_row (latest 0037)
CREATE OR REPLACE FUNCTION public.imp_stage_register_row(p_key text, p_keysets jsonb, p_cols jsonb, p_row jsonb, p_task_site uuid, p_entity text, p_view integer[], p_imp integer[], p_create integer[], p_edit integer[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); d public.register_definitions%ROWTYPE; s public.sites%ROWTYPE;
  errs jsonb := coalesce(p_row -> 'pre_errors', '[]'::jsonb); data jsonb := coalesce(p_row -> 'data', '{}'::jsonb); custom jsonb := coalesce(p_row -> 'custom', '{}'::jsonb);
  clean jsonb := '{}'::jsonb; cclean jsonb := '{}'::jsonb; scode text := nullif(btrim(p_row ->> 'site_code'), ''); rtype text := nullif(btrim(p_row ->> 'record_type'), '');
  rid text := nullif(btrim(p_row ->> 'record_id'), ''); no_site boolean; ent uuid; ents uuid[]; n int; col record; k text; v jsonb; tid uuid; msg text; j jsonb; e jsonb;
  cur public.register_records%ROWTYPE; opn public.register_records%ROWTYPE; base_data jsonb := '{}'::jsonb; base_custom jsonb := '{}'::jsonb; diff jsonb := '{}'::jsonb;
  action text; decision text := 'pending'; hold text; base_id uuid; region int; rkey text; sig text; ks jsonb; usable boolean; kc text; fd public.field_definitions%ROWTYPE;
  merged jsonb; mcustom jsonb; probe uuid; perrs jsonb := '[]'::jsonb; perr text; item jsonb; glob boolean; keyparts text[] := ARRAY[]::text[]; used_set jsonb;
  has_entry boolean;
BEGIN
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_key;

  -- record type
  IF rtype IS NOT NULL THEN
    SELECT x INTO rtype FROM unnest(d.record_types) x WHERE lower(x) = lower(rtype) LIMIT 1;
    IF rtype IS NULL THEN
      errs := errs || public.imp_cell_err(p_cols, 'record_type', 'not_in_list', 'Not a record type of this register.');
      rtype := '?';
    END IF;
  END IF;
  no_site := NOT d.site_scoped OR coalesce(rtype = ANY (d.site_optional_types), false);

  -- site, inside the caller's regions (unknown and out-of-scope sites answer the same)
  IF NOT no_site THEN
    IF scode IS NULL THEN
      errs := errs || public.imp_cell_err(p_cols, 'site_code', 'required', 'The Site ID is required.');
    ELSE
      SELECT * INTO s FROM public.sites x WHERE upper(x.site_code) = upper(scode) AND public.app_region_check(x.region_id) AND public.imp_region_ok(p_view, x.region_id);
      IF NOT FOUND THEN
        errs := errs || public.imp_cell_err(p_cols, 'site_code', 'site_not_in_scope', 'Unknown site, or a site outside your regions.');
      ELSIF p_task_site IS NOT NULL AND s.id <> p_task_site THEN
        errs := errs || public.imp_cell_err(p_cols, 'site_code', 'not_task_site', 'This file was uploaded from a task: only the rows of the task''s site are accepted.');
      END IF;
    END IF;
  ELSIF scode IS NOT NULL THEN
    errs := errs || public.imp_cell_err(p_cols, 'site_code', 'not_site_scoped', 'This record has no site: leave Site ID empty.');
  END IF;
  region := s.region_id;
  glob := no_site;

  -- the values: names and employee IDs become ids, then the same cleaning as manual entry
  FOR col IN SELECT c ->> 'code' AS code, c ->> 'type' AS type, c ->> 'kind' AS kind, coalesce((c ->> 'derived')::boolean, false) AS derived
             FROM jsonb_array_elements(p_cols) c WHERE c ->> 'kind' = 'field' LOOP
    IF col.derived THEN data := data - col.code; CONTINUE; END IF;
    IF NOT (data ? col.code) THEN CONTINUE; END IF;
    v := data -> col.code;
    IF col.type = 'external_team' THEN
      SELECT count(*), min(t.id::text) INTO n, msg FROM public.external_teams t WHERE lower(t.name) = lower(btrim(v #>> '{}')) AND t.is_active;
      IF n = 1 THEN data := data || jsonb_build_object(col.code, msg);
      ELSE errs := errs || public.imp_cell_err(p_cols, col.code, CASE WHEN n = 0 THEN 'unknown_team' ELSE 'ambiguous_team' END, CASE WHEN n = 0 THEN 'Unknown or inactive team.' ELSE 'More than one team has this name.' END);
           data := data - col.code; END IF;
    ELSIF col.type = 'user' THEN
      SELECT count(*), min(u.id::text) INTO n, msg FROM public.users u WHERE u.deleted_at IS NULL AND (btrim(u.employee_id) = btrim(v #>> '{}') OR lower(u.email) = lower(btrim(v #>> '{}')));
      IF n = 1 THEN data := data || jsonb_build_object(col.code, msg);
      ELSE errs := errs || public.imp_cell_err(p_cols, col.code, 'unknown_user', 'Type the 4-digit employee ID or the e-mail of an existing user.');
           data := data - col.code; END IF;
    END IF;
  END LOOP;
  BEGIN
    clean := public.reg_clean_data(p_key, data);
  EXCEPTION WHEN others THEN
    j := public.imp_wf_json(SQLERRM);
    IF j ->> 'code' = 'validation_failed' THEN
      FOR e IN SELECT * FROM jsonb_array_elements(j -> 'extra' -> 'errors') LOOP
        errs := errs || public.imp_cell_err(p_cols, regexp_replace(e ->> 'path', '^/data/', ''), e ->> 'code', e ->> 'message');
      END LOOP;
    ELSE
      errs := errs || jsonb_build_array(jsonb_build_object('code', 'row_failed', 'message', 'The row could not be read.'));
    END IF;
  END;
  -- Excel type mistakes arrive as text: the cleaning reports them. Blank cells never clear a value (they are not sent).
  clean := jsonb_strip_nulls(clean);

  -- custom fields (the admin-added columns)
  FOR k, v IN SELECT * FROM jsonb_each(custom) LOOP
    SELECT * INTO fd FROM public.field_definitions x WHERE x.entity_type::text = p_entity AND x.code = k AND x.is_active AND x.in_templates AND x.task_code IS NULL;
    IF NOT FOUND THEN CONTINUE; END IF;
    msg := public.custom_check_value(fd, v);
    IF msg IS NOT NULL THEN errs := errs || public.imp_cell_err(p_cols, k, 'invalid', initcap(msg) || '.');
    ELSE cclean := cclean || jsonb_build_object(k, v); END IF;
  END LOOP;

  -- match: Record ID first, then the natural keys
  IF rid IS NOT NULL THEN
    BEGIN
      SELECT x.entity_id INTO ent FROM public.register_records x
      WHERE x.entity_id = rid::uuid AND x.register_key = p_key AND x.state <> 'voided' AND public.app_region_read(x.is_global, x.region_id) LIMIT 1;
    EXCEPTION WHEN others THEN ent := NULL;
    END;
    IF ent IS NULL THEN errs := errs || public.imp_cell_err(p_cols, 'record_id', 'record_not_found', 'No record of this register has this Record ID, or it is outside your regions.'); END IF;
  END IF;
  IF ent IS NULL AND rid IS NULL AND jsonb_array_length(errs) = 0 THEN
    FOR ks IN SELECT * FROM jsonb_array_elements(p_keysets) LOOP
      usable := true;
      FOR kc IN SELECT * FROM jsonb_array_elements_text(ks) LOOP
        IF kc = 'site_code' THEN usable := usable AND s.id IS NOT NULL;
        ELSIF kc = 'record_type' THEN usable := usable AND rtype IS NOT NULL;
        ELSE usable := usable AND clean ->> kc IS NOT NULL; END IF;
      END LOOP;
      CONTINUE WHEN NOT usable;
      used_set := ks;
      SELECT array_agg(DISTINCT x.entity_id) INTO ents FROM public.register_records x
      WHERE x.register_key = p_key AND x.state <> 'voided' AND public.app_region_read(x.is_global, x.region_id)
        AND x.version_no = (SELECT max(y.version_no) FROM public.register_records y WHERE y.entity_id = x.entity_id AND y.state <> 'voided')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(ks) k2(code) WHERE
              CASE k2.code WHEN 'site_code' THEN x.site_id IS DISTINCT FROM s.id
                           WHEN 'record_type' THEN x.record_type IS DISTINCT FROM rtype
                           ELSE lower(coalesce(x.data ->> k2.code, '')) <> lower(coalesce(clean ->> k2.code, '')) END);
      IF ents IS NOT NULL AND cardinality(ents) > 1 THEN
        errs := errs || jsonb_build_array(jsonb_build_object('code', 'ambiguous_match', 'message', 'More than one record has these key values: use the Record ID.'));
      ELSIF ents IS NOT NULL THEN ent := ents[1]; END IF;
      EXIT;
    END LOOP;
  END IF;
  -- the human key
  IF used_set IS NOT NULL THEN
    FOR kc IN SELECT * FROM jsonb_array_elements_text(used_set) LOOP
      keyparts := keyparts || CASE kc WHEN 'site_code' THEN s.site_code WHEN 'record_type' THEN upper(rtype) ELSE clean ->> kc END;
    END LOOP;
  ELSE
    keyparts := ARRAY[coalesce(s.site_code, scode), CASE WHEN rtype IS NOT NULL AND rtype <> '?' THEN upper(rtype) END];
  END IF;
  rkey := nullif(array_to_string(array_remove(keyparts, NULL), ' / '), '');
  sig := CASE WHEN ent IS NOT NULL THEN 'e:' || ent::text WHEN used_set IS NOT NULL THEN 'k:' || md5(array_to_string(keyparts, '|')) END;

  -- the version to compare with
  IF ent IS NOT NULL THEN
    SELECT * INTO cur FROM public.register_records x WHERE x.entity_id = ent AND x.state = 'approved' AND x.is_current;
    SELECT * INTO opn FROM public.register_records x WHERE x.entity_id = ent AND x.state IN ('entry', 'in_review', 'in_approval');
    IF cur.id IS NOT NULL THEN base_data := cur.data; base_custom := cur.custom; base_id := cur.id;
    ELSIF opn.id IS NOT NULL THEN base_data := opn.data; base_custom := opn.custom; base_id := opn.id; END IF;
    IF opn.id IS NOT NULL THEN decision := 'pending_previous_approval'; hold := 'open_version'; END IF;
    IF jsonb_array_length(errs) = 0 AND coalesce(s.id, cur.site_id, opn.site_id) IS NOT NULL AND s.id IS NOT NULL
       AND coalesce(cur.site_id, opn.site_id) IS DISTINCT FROM s.id THEN
      errs := errs || public.imp_cell_err(p_cols, 'site_code', 'site_mismatch', 'The Record ID belongs to another site.');
    END IF;
    IF jsonb_array_length(errs) = 0 AND rtype IS NOT NULL AND coalesce(cur.record_type, opn.record_type) IS DISTINCT FROM rtype THEN
      errs := errs || public.imp_cell_err(p_cols, 'record_type', 'type_mismatch', 'The Record ID belongs to a record of another type.');
    END IF;
    IF jsonb_array_length(errs) = 0 AND s.id IS NULL AND coalesce(cur.site_id, opn.site_id) IS NOT NULL THEN
      SELECT * INTO s FROM public.sites x WHERE x.id = coalesce(cur.site_id, opn.site_id);
      region := s.region_id;
    END IF;
  END IF;

  -- the diff
  IF jsonb_array_length(errs) = 0 THEN
    FOR k, v IN SELECT * FROM jsonb_each(clean) LOOP
      IF ent IS NULL THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', NULL, 'new', v));
      ELSIF base_data -> k IS DISTINCT FROM v THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', base_data -> k, 'new', v)); END IF;
    END LOOP;
    FOR k, v IN SELECT * FROM jsonb_each(cclean) LOOP
      IF ent IS NULL THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', NULL, 'new', v));
      ELSIF base_custom -> k IS DISTINCT FROM v THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', base_custom -> k, 'new', v)); END IF;
    END LOOP;
    action := CASE WHEN ent IS NULL THEN 'create' WHEN diff = '{}'::jsonb THEN 'unchanged' ELSE 'update' END;
    IF action = 'unchanged' THEN decision := 'pending'; hold := NULL; END IF;
    IF action = 'create' AND NOT no_site AND s.id IS NULL THEN action := 'error'; END IF;
  END IF;

  -- the caller's rights on this row: import, create or edit, and the entry level of the register row
  IF jsonb_array_length(errs) = 0 AND action IN ('create', 'update') THEN
    IF NOT public.imp_region_ok(p_imp, region) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('code', 'region_forbidden', 'message', 'You may not import in this region.'));
    ELSIF NOT public.imp_region_ok(CASE action WHEN 'create' THEN p_create ELSE p_edit END, region) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('code', 'action_forbidden', 'message', 'You may not ' || CASE action WHEN 'create' THEN 'create' ELSE 'edit' END || ' records of this register in this region.'));
    ELSE
      has_entry := EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, region) h WHERE h.user_id = actor)
                   OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, region)))
                   OR public.hrf_staging();   -- 0125: the historical direct approval (the row is noted and audited after the staging, hrf_note_batches)
      IF NOT has_entry THEN
        errs := errs || jsonb_build_array(jsonb_build_object('code', 'not_entry_holder', 'message', 'You are not an entry holder (L1) of the ' || d.name_en || ' row of the Matrix.'));
      END IF;
    END IF;
  END IF;

  -- the register's own rules (reg_validate) on a probe record that is rolled back at once
  IF jsonb_array_length(errs) = 0 AND action IN ('create', 'update') THEN
    merged := jsonb_strip_nulls(base_data || clean);
    mcustom := jsonb_strip_nulls(base_custom || cclean);
    BEGIN
      INSERT INTO public.register_records (entity_id, version_no, register_key, record_type, site_id, region_id, is_global, levels_required, data, custom, created_by)
      VALUES (gen_random_uuid(), 2, p_key, nullif(rtype, '?'), s.id, region, glob AND s.id IS NULL, 2, merged, mcustom, actor) RETURNING id INTO probe;
      perrs := public.reg_validate(probe);
      RAISE EXCEPTION 'imp:probe_done';
    EXCEPTION WHEN others THEN
      IF SQLERRM <> 'imp:probe_done' THEN
        j := public.imp_wf_json(SQLERRM);
        IF j IS NOT NULL THEN perr := coalesce(j -> 'extra' ->> 'detail', 'The row is not valid.'); ELSE perr := SQLERRM; END IF;
        perrs := jsonb_build_array(jsonb_build_object('path', '/row', 'code', 'invalid', 'message', left(perr, 300)));
      END IF;
    END;
    FOR item IN SELECT * FROM jsonb_array_elements(perrs) LOOP
      errs := errs || public.imp_cell_err(p_cols, CASE WHEN item ->> 'path' LIKE '/data/%' THEN regexp_replace(item ->> 'path', '^/data/', '') WHEN item ->> 'path' = '/site_id' THEN 'site_code' ELSE 'record_id' END,
                                          item ->> 'code', item ->> 'message');
    END LOOP;
  END IF;

  IF jsonb_array_length(errs) > 0 THEN action := 'error'; diff := '{}'::jsonb; decision := 'pending'; hold := NULL; END IF;
  RETURN jsonb_build_object('action', action, 'decision', decision, 'hold_reason', hold, 'errors', errs, 'diff', diff,
    'payload', jsonb_build_object('data', clean, 'custom', cclean), 'region_id', region, 'site_id', s.id, 'site_code', coalesce(s.site_code, scode),
    'record_type', nullif(rtype, '?'), 'key', rkey, 'matched_entity_id', ent, 'base_record_id', base_id, 'sig', sig);
END $function$;

-- imp_stage_task_row, 8 arguments (latest 0085)
CREATE OR REPLACE FUNCTION public.imp_stage_task_row(p_cols jsonb, p_row jsonb, p_task_site uuid, p_view integer[], p_imp integer[], p_edit integer[], p_mode text, p_hw_cutoff date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); rowerrs jsonb := '[]'::jsonb; pre jsonb := coalesce(p_row -> 'pre_errors', '[]'::jsonb); cells jsonb := coalesce(p_row -> 'cells', '{}'::jsonb);
  scode text := nullif(btrim(p_row ->> 'site_code'), ''); s public.sites%ROWTYPE; col record; v jsonb; cl jsonb; tc text; plain text; pe jsonb;
  order_codes text[] := ARRAY[]::text[]; pay jsonb := '{}'::jsonb; terr jsonb := '{}'::jsonb; twarn jsonb := '{}'::jsonb; items jsonb := '[]'::jsonb;
  p jsonb; e jsonb; w jsonb; diff jsonb; ti public.task_instances%ROWTYPE; tname text; action text; decision text; hold text; k text; nv jsonb; pend text; missing text[];
  eff_actual date; eff_start date; patch jsonb; j jsonb; item jsonb; cur date; have boolean; draft boolean := (p_mode = 'draft'); gate_msg text;
  hist boolean := (p_hw_cutoff IS NOT NULL);   -- 0085: the historical load: a missing value is a warning, never an error
  save_only boolean; pmiss text;
  hdo boolean := (p_hw_cutoff IS NOT NULL) AND public.hrf_staging();   -- 0125: the historical load approved directly (staged inside mi_apply_run)
  resend boolean; ovr boolean;                                          -- 0125
BEGIN
  IF scode IS NULL THEN
    rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'required', 'message', 'The Site ID is required.'));
  ELSE
    SELECT * INTO s FROM public.sites x WHERE upper(x.site_code) = upper(scode) AND public.app_region_check(x.region_id) AND public.imp_region_ok(p_view, x.region_id);
    IF NOT FOUND THEN
      rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'site_not_in_scope', 'message', 'Unknown site, or a site outside your regions.'));
    ELSIF p_task_site IS NOT NULL AND s.id <> p_task_site THEN
      rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'not_task_site',
        'message', 'This file was uploaded from a task: only the rows of the task''s site are accepted.'));
    END IF;
  END IF;
  IF jsonb_array_length(rowerrs) > 0 THEN
    RETURN jsonb_build_object('site_id', NULL, 'site_code', scode, 'region_id', NULL, 'row_errors', rowerrs || pre, 'items', '[]'::jsonb);
  END IF;

  FOR pe IN SELECT * FROM jsonb_array_elements(pre) LOOP
    SELECT c ->> 'task' INTO tc FROM jsonb_array_elements(p_cols) c WHERE c ->> 'code' = pe ->> 'field' LIMIT 1;
    IF tc IS NULL THEN rowerrs := rowerrs || jsonb_build_array(pe); CONTINUE; END IF;
    IF NOT (tc = ANY (order_codes)) THEN order_codes := order_codes || tc; END IF;
    terr := terr || jsonb_build_object(tc, coalesce(terr -> tc, '[]'::jsonb) || jsonb_build_array(pe));
  END LOOP;

  FOR col IN SELECT c ->> 'code' AS code, c ->> 'task' AS task, c ->> 'field' AS field, c ->> 'type' AS type, c -> 'options' AS options, c ->> 'header' AS header
             FROM jsonb_array_elements(p_cols) c
             WHERE c ->> 'kind' = 'task' AND NOT coalesce((c ->> 'derived')::boolean, false) LOOP
    v := cells -> col.code;
    IF v IS NULL THEN CONTINUE; END IF;
    cl := public.imp_clean_cell(col.type, col.options, v);
    IF cl IS NULL THEN CONTINUE; END IF;
    IF NOT (col.task = ANY (order_codes)) THEN order_codes := order_codes || col.task; END IF;
    IF cl ? 'error' THEN
      terr := terr || jsonb_build_object(col.task, coalesce(terr -> col.task, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object('column', col.header, 'field', col.code, 'code', cl ->> 'error', 'message', cl ->> 'message')));
    ELSE
      plain := regexp_replace(col.field, '^v:', '');
      pay := pay || jsonb_build_object(col.task, coalesce(pay -> col.task, '{}'::jsonb) || jsonb_build_object(plain, cl -> 'value'));
    END IF;
  END LOOP;

  FOR col IN SELECT c ->> 'code' AS code, c ->> 'task' AS task, c ->> 'field' AS field, c ->> 'header' AS header
             FROM jsonb_array_elements(p_cols) c
             WHERE c ->> 'kind' = 'task' AND coalesce((c ->> 'derived')::boolean, false)
               AND c ->> 'field' IN ('planned_date', 'planned_start', 'actual_start', 'actual_date', 'submitted_date', 'approved_date') LOOP
    v := cells -> col.code;
    IF v IS NULL THEN CONTINUE; END IF;
    cl := public.imp_clean_cell('date', NULL, v);
    IF cl IS NULL OR cl ? 'error' THEN CONTINUE; END IF;
    SELECT CASE col.field WHEN 'planned_date' THEN x.planned_date WHEN 'planned_start' THEN x.planned_start WHEN 'actual_start' THEN x.actual_start
                          WHEN 'actual_date' THEN x.actual_date WHEN 'submitted_date' THEN x.submitted_date ELSE x.approved_date END INTO cur
      FROM public.task_instances x JOIN public.task_definitions td ON td.id = x.task_def_id
      WHERE x.site_id = s.id AND td.code = col.task AND td.workflow_id = s.workflow_version_id;
    CONTINUE WHEN NOT FOUND;
    IF cur IS DISTINCT FROM (cl ->> 'value')::date THEN
      IF NOT (col.task = ANY (order_codes)) THEN order_codes := order_codes || col.task; END IF;
      twarn := twarn || jsonb_build_object(col.task, coalesce(twarn -> col.task, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object('column', col.header, 'field', col.code, 'code', 'calculated_column', 'message', 'Calculated or register-owned column: the value is not read.')));
    END IF;
  END LOOP;

  FOREACH tc IN ARRAY order_codes LOOP
    p := coalesce(pay -> tc, '{}'::jsonb); e := coalesce(terr -> tc, '[]'::jsonb); w := coalesce(twarn -> tc, '[]'::jsonb);
    diff := '{}'::jsonb; action := 'update'; decision := 'pending'; hold := NULL; save_only := false; resend := false; ovr := false;   -- 0125
    SELECT x.* INTO ti FROM public.task_instances x JOIN public.task_definitions td ON td.id = x.task_def_id
      WHERE x.site_id = s.id AND td.code = tc AND td.workflow_id = s.workflow_version_id;
    have := FOUND;
    tname := CASE WHEN have THEN (SELECT d2.name_en FROM public.task_definitions d2 WHERE d2.id = ti.task_def_id) END;
    IF NOT have AND hist THEN
      -- 0085: the historical load keeps the rest of the row; this cell is not read
      w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_on_site', 'This task does not exist on this site (its scope or delivery scenario does not use it): the value is not read.'));
      action := 'unchanged';
    ELSIF NOT have THEN
      e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_on_site', 'This task does not exist on this site (its scope or delivery scenario does not use it).'));
      action := 'error';
    ELSE
      IF p ? 'planned_date' AND (p ->> 'planned_date')::date IS DISTINCT FROM ti.planned_date THEN
        diff := diff || jsonb_build_object('planned_date', jsonb_build_object('old', to_jsonb(ti.planned_date), 'new', p -> 'planned_date')); END IF;
      IF p ? 'actual_start' AND (p ->> 'actual_start')::date IS DISTINCT FROM ti.actual_start THEN
        diff := diff || jsonb_build_object('actual_start', jsonb_build_object('old', to_jsonb(ti.actual_start), 'new', p -> 'actual_start')); END IF;
      IF p ? 'actual_date' AND (p ->> 'actual_date')::date IS DISTINCT FROM ti.actual_date THEN
        diff := diff || jsonb_build_object('actual_date', jsonb_build_object('old', to_jsonb(ti.actual_date), 'new', p -> 'actual_date')); END IF;
      FOR k, nv IN SELECT * FROM jsonb_each(p) LOOP
        CONTINUE WHEN k IN ('planned_date', 'actual_start', 'actual_date');
        IF (ti.values -> k) IS DISTINCT FROM nv THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', ti.values -> k, 'new', nv)); END IF;
      END LOOP;

      -- 0125: in the historical load approved directly, a task that is not approved and already holds the values of the row (an earlier load or entry saved
      -- them) is still sent and approved when the row carries its actual date; and the Matrix entry holder (L1) does not stop the row (admin override)
      IF hdo AND NOT ti.is_na AND ti.state IN ('open', 'entry', 'locked') THEN
        resend := diff = '{}'::jsonb AND nullif(p ->> 'actual_date', '') IS NOT NULL;
        ovr := NOT (public.wf_is_eligible(ti.id, 'entry', actor) OR (public.app_user_is_system_admin(actor) AND NOT public.wf_has_holder(ti.id, 'entry')));
      END IF;
      IF jsonb_array_length(e) = 0 THEN
        IF diff = '{}'::jsonb AND NOT resend THEN   -- 0125
          action := 'unchanged';
        ELSIF hist AND (ti.is_na OR ti.state IN ('na', 'skipped', 'suspended', 'rejected', 'approved')) THEN
          -- 0085: the historical load keeps what GSDN Workspace holds; the value of the file is not read for this task
          w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', CASE WHEN ti.state = 'approved' THEN 'task_approved' ELSE 'task_not_open' END,
            'The task is ' || ti.state::text || ': the value of the file is not read (the task keeps its current value).'));
          action := 'unchanged'; diff := '{}'::jsonb;
        ELSIF ti.is_na OR ti.state IN ('na', 'skipped', 'suspended', 'rejected') THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_open', 'The task is ' || ti.state::text || ': it takes no entry.'));
        ELSIF ti.state = 'approved' THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_approved', 'The task is approved. An approved task is changed only by an admin reopening it.'));
        ELSIF NOT public.imp_region_ok(p_imp, ti.region_id) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'region_forbidden', 'You may not import in this region.'));
        ELSIF NOT public.imp_region_ok(p_edit, ti.region_id) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'action_forbidden', 'You may not edit tasks in this region.'));
        ELSIF NOT (public.wf_is_eligible(ti.id, 'entry', actor) OR (public.app_user_is_system_admin(actor) AND NOT public.wf_has_holder(ti.id, 'entry'))) AND NOT ovr THEN   -- 0125
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'not_entry_holder', 'You are not an entry holder (L1) of this task in the Matrix.'));
        ELSIF ti.state IN ('in_review', 'in_approval') THEN
          decision := 'pending_previous_approval'; hold := 'open_submission';
          w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_open_submission', 'The task is in ' || ti.state::text || ': the row waits until that submission is decided.'));
        ELSIF ti.state = 'locked' AND s.workflow_locks THEN   -- 0085: only a site whose workflow locks are on holds the row
          SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pend FROM public.task_predecessors tp
            JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
            JOIN public.task_instances pi ON pi.site_id = ti.site_id AND pi.task_def_id = tp.predecessor_id
            WHERE tp.task_def_id = ti.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped');
          IF pend IS NOT NULL THEN
            decision := 'pending_previous_approval'; hold := 'predecessor_open';
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_predecessor', 'The row waits until ' || pend || ' is approved.'));
          ELSE
            -- Q208: held, never refused; the row is applied only when the uploader sends the batch again after the gate opens (every check runs again)
            gate_msg := CASE WHEN starts_with(coalesce(ti.lock_reason, ''), 'gate_closed:') THEN 'the gate ' || substr(ti.lock_reason, 13) || ' is not open yet'
                             ELSE coalesce(ti.lock_reason, 'the gate of its stage is not open yet') END;
            decision := 'pending_previous_approval'; hold := 'gate_locked';
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_gate_locked',
              'The task is locked: ' || gate_msg || ' (Q81). The row is kept; send the batch again once the gate opens (Q208).'));
          END IF;
        ELSE
          -- open or ongoing: the manual rules, by running the save on the real task inside a savepoint that is rolled back
          patch := public.imp_task_patch(p, diff);
          BEGIN
            PERFORM public.wf_save_entry(ti.id, NULL, patch);
            RAISE EXCEPTION 'imp:probe_done';
          EXCEPTION WHEN others THEN
            IF SQLERRM <> 'imp:probe_done' THEN
              j := public.imp_wf_json(SQLERRM);
              IF j ->> 'code' = 'validation_failed' THEN
                FOR item IN SELECT * FROM jsonb_array_elements(coalesce(j -> 'extra' -> 'errors', '[]'::jsonb)) LOOP
                  e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, regexp_replace(item ->> 'path', '^/', ''), coalesce(item ->> 'code', 'invalid'), coalesce(item ->> 'message', 'Not valid.')));
                END LOOP;
              ELSIF j IS NOT NULL THEN
                e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', coalesce(j ->> 'code', 'row_failed'), public.imp_wf_message(j)));
              ELSE
                e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'row_failed', left(SQLERRM, 200)));
              END IF;
            END IF;
          END;
          IF jsonb_array_length(e) = 0 AND NOT draft THEN
            -- what the submit asks for (the same checks as the task screen): the actual date and the mandatory documents
            eff_actual := coalesce((p ->> 'actual_date')::date, ti.actual_date);
            IF eff_actual IS NULL AND hist THEN
              -- 0085: the historical load saves the values of the row without submitting the task (a warning, never an error)
              save_only := true;
              w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'missing_actual_date',
                'No actual date: the values of the row are saved and the task is not submitted (historical load).'));
            ELSIF eff_actual IS NULL THEN
              e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'actual_date_required',
                'The actual date is required: the task is submitted with its row, as on the task screen. Use Save Draft / Planning to save a plan only (Q206).'));
            END IF;
            missing := CASE WHEN save_only THEN ARRAY[]::text[] ELSE public.wf_missing_slots(ti.id) END;
            IF cardinality(missing) > 0 THEN
              IF p_hw_cutoff IS NOT NULL AND eff_actual IS NOT NULL AND eff_actual <= p_hw_cutoff THEN
                -- 0073 (Q462): a marked batch under the open waiver; the actual date is on or before the cutoff, so the documents are not asked for (every other check ran)
                w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'historical_no_documents', 'Missing document(s): ' || array_to_string(missing, ', ') ||
                  '. Accepted without documents under the historical-load waiver (the actual date is on or before ' || p_hw_cutoff::text || '); the task will be flagged.'));
              ELSE
                e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'mandatory_slots_missing', 'Missing document(s): ' || array_to_string(missing, ', ') || '. Upload them on the task first.'));
              END IF;
            END IF;
          END IF;
          -- Q209: a pending task is started with its actual start, never with today; a planning row (draft, no actual date) does not start it
          IF jsonb_array_length(e) = 0 AND ti.state IN ('open', 'locked') AND (NOT (draft OR save_only) OR p ? 'actual_start' OR p ? 'actual_date')
             AND public.imp_start_date(tc, p, ti) IS NULL AND hist AND coalesce((p ->> 'actual_date')::date, ti.actual_date) IS NOT NULL THEN
            -- 0085: the historical load starts the task on its actual date when the file has no actual start (a warning)
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_start', 'missing_actual_start',
              'No actual start: the actual date is used as the start of the task (historical load).'));
          ELSIF jsonb_array_length(e) = 0 AND ti.state IN ('open', 'locked') AND (NOT (draft OR save_only) OR p ? 'actual_start' OR p ? 'actual_date')
             AND public.imp_start_date(tc, p, ti) IS NULL THEN
            e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_start', 'actual_start_required',
              'The task is pending: type its Actual Start. GSDN Workspace never uses today as the start of an earlier piece of work (Q209).'));
          END IF;
        END IF;

        IF jsonb_array_length(e) = 0 AND action = 'update' AND (hist OR NOT s.workflow_locks) THEN
          -- 0085: a predecessor without an actual date while this task has one (a data gap: a warning)
          SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pmiss FROM public.task_predecessors tp
            JOIN public.task_definitions pd ON pd.id = tp.predecessor_id AND NOT pd.is_milestone_task
            JOIN public.task_instances pi ON pi.site_id = ti.site_id AND pi.task_def_id = tp.predecessor_id
            WHERE tp.task_def_id = ti.task_def_id AND pi.actual_date IS NULL AND NOT pi.is_na AND pi.state NOT IN ('approved', 'na', 'skipped')
              AND NOT coalesce((pay -> pd.code) ? 'actual_date', false);
          IF pmiss IS NOT NULL AND coalesce((p ->> 'actual_date')::date, ti.actual_date) IS NOT NULL THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'missing_predecessor_date',
              'The predecessor ' || pmiss || ' has no actual date (missing data).'));
          END IF;
        END IF;
        IF jsonb_array_length(e) = 0 AND action = 'update' THEN
          eff_actual := coalesce((p ->> 'actual_date')::date, ti.actual_date);
          eff_start := coalesce((p ->> 'actual_start')::date, ti.actual_start);
          IF eff_start IS NOT NULL AND eff_actual IS NOT NULL AND eff_start > eff_actual THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'date_order', 'The actual start is after the actual date.'));
          END IF;
          IF eff_actual IS NOT NULL AND ti.sla_start_date IS NOT NULL AND eff_actual < ti.sla_start_date THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'sla_negative',
              'The actual date is before the SLA start (' || ti.sla_start_date::text || '): the duration is negative and raises a data-quality alert.'));
          ELSIF eff_actual IS NOT NULL AND ti.due_date IS NOT NULL AND eff_actual > ti.due_date THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'sla_late', 'The actual date is after the SLA limit (' || ti.due_date::text || '): the task is late.'));
          END IF;
        END IF;
      END IF;
    END IF;
    IF jsonb_array_length(e) = 0 AND action = 'update' AND resend THEN   -- 0125
      w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'historical_resend',
        'The task already holds these values but is not approved: the row is sent and approved directly (historical load).'));
    END IF;
    IF jsonb_array_length(e) = 0 AND action = 'update' AND ovr THEN   -- 0125
      w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'historical_entry_override',
        'You are not an entry holder (L1) of this task in the Matrix: entered as the admin override of the historical direct approval (audited).'));
    END IF;
    IF jsonb_array_length(e) > 0 THEN action := 'error'; diff := '{}'::jsonb; decision := 'pending'; hold := NULL; END IF;
    items := items || jsonb_build_array(jsonb_build_object('task_code', tc, 'task_id', ti.id, 'name', tname, 'action', action, 'decision', decision, 'hold_reason', hold,
      'errors', e, 'warnings', w, 'diff', diff, 'payload', jsonb_build_object('fields', p) || CASE WHEN save_only THEN jsonb_build_object('save_only', true) ELSE '{}'::jsonb END, 'key', s.site_code || ' / ' || tc,
      'sig', CASE WHEN ti.id IS NOT NULL THEN 't:' || ti.id::text END));
  END LOOP;
  RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'region_id', s.region_id, 'row_errors', rowerrs, 'items', items);
END $function$;

-- mi_apply_run, 7 arguments (latest 0124)
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
  hda boolean := false;   -- 0092: the historical load is approved directly (admin override, no L2)
  hrg boolean := false; regs jsonb; rres jsonb; rnotes jsonb := '[]'::jsonb;   -- 0093: the register sheets of the same file
  rap boolean := false; disc jsonb := '[]'::jsonb;   -- 0122: re-apply a file already applied, with direct approval; the batches discarded first
  dacells jsonb := '{}'::jsonb; dacodes text[];      -- 0122: the Design & Acquisition task dates read from the RF & Design sheet of the same file
  hrfn jsonb;                                        -- 0125: the rows of the direct approval noted after the staging
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
    hda := coalesce(p_historical -> 'approve_directly' = 'true'::jsonb, false);   -- 0092
    hrg := coalesce(p_historical -> 'registers' = 'true'::jsonb, false);          -- 0093
    rap := coalesce(p_historical -> 'reapply' = 'true'::jsonb, false);            -- 0122
    IF rap AND NOT hda THEN   -- 0122: a file already applied is applied again only with the direct approval (the owner decision of 2026-11-17)
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load/approve_directly',
        'code', 'required', 'message', 'Re-applying a file that was already applied is done with the direct approval of the historical load.'))));
    END IF;
  END IF;
  -- 0093: the register sheets are read by the API from the file stored with this run (never sent by the caller of the endpoint); they come only with the
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
  IF prev IS NOT NULL AND NOT rap THEN   -- 0122: lifted only for a re-apply with direct approval (the historical-load checks above passed)
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This file was already applied (run ' || prev::text || '). A reconciliation run compares again; it never applies the same file twice.',
      'already_applied', true, 'applied_run_id', prev));   -- 0122: the screen offers the re-apply to a System Admin
  END IF;
  -- 0086: a file with more sites than imports.async_rows is applied in the background, every check above passed: the request records the run and answers 202
  -- (status applying); mi_apply_step does the very same apply in a transaction of its own under the same person's signed context (no 30 s request limit)
  IF bg IS NULL THEN
    BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;
    SELECT count(DISTINCT upper(x.site_code)) INTO nsites FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL;
    IF nsites > lim THEN
      INSERT INTO public.mi_apply_jobs (run_id, actor_id, mode, reason, hw_reason, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, sites_total,
                                        approve_directly, load_registers, registers, reapply)   -- 0092, 0093, 0122
      VALUES (p_run, actor, p_mode, left(btrim(p_reason), 2000), hw ->> 'reason', true, su_until,
              CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
              public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64), nsites,
              hda, hrg, regs, rap)
      RETURNING id INTO jid;
      UPDATE public.master_reconciliation_runs SET status = 'applying', version = version + 1 WHERE id = p_run;
      PERFORM public.log_audit_write('master_import.apply_queued', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
        jsonb_build_object('status', 'applying', 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
          'approve_directly', hda, 'registers', hrg, 'reapply', rap), btrim(p_reason));   -- 0092, 0093, 0122
      PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: apply queued', jsonb_build_object('run_id', p_run, 'job_id', jid, 'mode', p_mode, 'sites', nsites), actor, NULL);
      RETURN jsonb_build_object('queued_apply', true, 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'batches', '[]'::jsonb, 'queued', 0, 'approve_directly', hda, 'registers', hrg, 'reapply', rap);
    END IF;
  END IF;
  IF hw IS NOT NULL THEN
    -- 0085: the historical load accepts the data as it is: every site of the file loses its workflow locks first (audited per site, the reason of the load)
    PERFORM public.swl_open_for_load((SELECT array_agg(DISTINCT x.site_id) FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL),
      hw ->> 'reason', 'historical_master_import');
  END IF;
  IF rap THEN
    -- 0122: before anything is staged, the open batches of the earlier historical Master loads (and of this file) are discarded (audited per batch): their
    -- rows are never applied, so nothing is entered or approved twice. In the background this runs in the transaction of the apply itself.
    disc := public.hrp_discard_open(r, hw ->> 'reason');
  END IF;
  IF hda THEN
    -- 0125: the staging of the historical load approved directly is marked for this transaction (hrf_staging): the Matrix entry holder (L1) does not stop a
    -- row, and a value outside a register list is kept as typed; the mark ends with the staging (the sending checks the batch of each row, hrf_override_ok)
    INSERT INTO public.hrf_stage_marks (xid, actor_id, run_id) VALUES (txid_current(), actor, p_run)
      ON CONFLICT (xid) DO UPDATE SET actor_id = EXCLUDED.actor_id, run_id = EXCLUDED.run_id, created_at = now();
  END IF;

  SELECT v.* INTO tv FROM public.template_versions v JOIN public.template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MASTER' AND v.is_current;
  SELECT x INTO mpart FROM jsonb_array_elements(tv.columns) x WHERE x ->> 'kind' = 'master' LIMIT 1;
  mcols := mpart -> 'columns';
  IF hrg THEN
    -- 0122: the Master sheet has no typed column for the Design & Acquisition tasks: its Site Release (V) is a formula over the RF & Design sheet (TSSR
    -- Approved, LLD Approved Date, and for a HUB or Terminal site the MW LOS Survey Date and the Link Budget Date) and the Acquisition sheet. With the register
    -- sheets of the same file, the dates of A2 (TSSR approval), A4 (LLD approval) and A5 (MW LOS and link budget, HUB / Terminal only, the later of the two)
    -- are entered on the site's row like a typed column, so they are staged in the Design & Acquisition batch. Only the non-derived task columns of an active
    -- stream template are used (A3 comes from the Acquisition register and is derived; A1 has no source in the file).
    SELECT coalesce(array_agg(DISTINCT tc ->> 'code'), ARRAY[]::text[]) INTO dacodes
    FROM public.template_definitions td_ JOIN public.template_versions tv_ ON tv_.template_def_id = td_.id AND tv_.is_current, jsonb_array_elements(tv_.columns) tc
    WHERE td_.kind = 'stream' AND td_.is_active AND tc ->> 'kind' = 'task' AND NOT coalesce((tc ->> 'derived')::boolean, false)
      AND tc ->> 'code' IN ('A2:actual_date', 'A4:actual_date', 'A5:actual_date');
    SELECT coalesce(jsonb_object_agg(x.k, x.cl), '{}'::jsonb) INTO dacells FROM (
      SELECT DISTINCT ON (y.k) y.k, y.cl FROM (
        SELECT upper(btrim(e ->> 'site_code')) AS k, (e ->> 'row_no') AS rn,
          (SELECT coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb) FROM jsonb_each(jsonb_strip_nulls(jsonb_build_object(
             'A2:actual_date', CASE WHEN (e -> 'data' ->> 'tssr_approved') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN e -> 'data' ->> 'tssr_approved' END,
             'A4:actual_date', CASE WHEN (e -> 'data' ->> 'lld_approved_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN e -> 'data' ->> 'lld_approved_date' END,
             'A5:actual_date', CASE WHEN lower(coalesce(s.site_type, '')) IN ('hub', 'terminal')
                                     AND (e -> 'data' ->> 'mw_los_survey_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND (e -> 'data' ->> 'link_budget_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                                    THEN greatest(e -> 'data' ->> 'mw_los_survey_date', e -> 'data' ->> 'link_budget_date') END))) kv
           WHERE kv.key = ANY (dacodes)) AS cl
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(regs -> 'parts') = 'array' THEN regs -> 'parts' ELSE '[]'::jsonb END) p,
             jsonb_array_elements(CASE WHEN jsonb_typeof(p -> 'rows') = 'array' THEN p -> 'rows' ELSE '[]'::jsonb END) e
        LEFT JOIN public.sites s ON upper(s.site_code) = upper(btrim(e ->> 'site_code'))
        WHERE p ->> 'register' = 'rf_design' AND jsonb_typeof(e -> 'data') = 'object' AND nullif(btrim(e ->> 'site_code'), '') IS NOT NULL) y
      WHERE y.cl <> '{}'::jsonb ORDER BY y.k, y.rn) x;
  END IF;
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
    IF dacells ? upper(row_.site_code) THEN cells := (dacells -> upper(row_.site_code)) || cells; END IF;   -- 0122
    CONTINUE WHEN cells = '{}'::jsonb AND pres = '[]'::jsonb;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('row_no', row_.row_no, 'site_code', row_.site_code, 'cells', cells, 'pre_errors', pres));
  END LOOP;
  IF jsonb_array_length(v_rows) = 0 AND NOT (hrg AND jsonb_array_length(coalesce(regs -> 'parts', '[]'::jsonb)) > 0) THEN   -- 0093: a file of register sheets only
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'No typed task column of this file belongs to a site of GSDN Workspace: nothing can be entered.'));
  END IF;
  IF jsonb_array_length(v_rows) > 0 THEN
    res := public.imp_stage_master_core('TPL-MASTER', tv.version, r.file_name, r.file_sha256,
      jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid, hw);
  ELSE
    res := jsonb_build_object('group_id', gid, 'batches', '[]'::jsonb, 'skipped', '[]'::jsonb);
  END IF;
  IF hrg THEN
    -- 0093: each register sheet becomes a register batch of the same group (source master_import, the historical mark), after the stream batches, so it is
    -- sent after them; a sheet that cannot be staged is skipped with its reason, never the whole apply
    rres := public.hrg_stage_registers(regs, r, p_mode, gid, hw ->> 'reason');
    res := res || jsonb_build_object('batches', (res -> 'batches') || (rres -> 'batches'), 'skipped', coalesce(res -> 'skipped', '[]'::jsonb) || (rres -> 'skipped'));
    rnotes := rres -> 'notes';
  END IF;
  DELETE FROM public.hrf_stage_marks WHERE xid = txid_current();   -- 0125: the staging ends here
  IF hda THEN
    -- 0092: the batches just staged are marked for direct approval (a System Admin, the step-up, the open waiver, checked again on each batch); every
    -- submitted row of them is then approved at once by the sender, here or in the chunked background send (the mark is read from the batch row there)
    PERFORM public.hda_mark_batches(ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(res -> 'batches') x), hw ->> 'reason');
    hrfn := public.hrf_note_batches(ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(res -> 'batches') x), hw ->> 'reason');   -- 0125: noted and audited
  END IF;
  FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x LOOP
    -- 0075: a batch with more rows than imports.async_rows is sent in the background (the checks of the request run in imp_async_start, the rows in chunks)
    q := public.imp_async_start((b ->> 'id')::uuid, NULL, 'submit', NULL, NULL, NULL, NULL, su_until);
    IF coalesce((q ->> 'queued')::boolean, false) THEN
      queued := queued + 1;
      batches := batches || jsonb_build_array(b || jsonb_build_object('queued', true, 'job_id', q -> 'job' -> 'job_id', 'rows', q -> 'job' -> 'rows_total',
        'submitted', 0, 'saved', 0, 'held', 0, 'failed', 0, 'approved', 0,
        'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
        'skipped', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'unchanged')));   -- 0093
      CONTINUE;
    END IF;
    sent := public.imp_submit_batch((b ->> 'id')::uuid, NULL, p_stepup);
    batches := batches || jsonb_build_array(b || jsonb_build_object('submitted', sent -> 'submitted', 'saved', sent -> 'saved', 'held', jsonb_array_length(coalesce(sent -> 'held', '[]'::jsonb)),
      'failed', jsonb_array_length(coalesce(sent -> 'failed', '[]'::jsonb)),
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
      'approved', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action IN ('create', 'update') AND x.decision = 'approved'),   -- 0092, 0093
      'rows', (SELECT x.rows_total FROM public.import_batches x WHERE x.id = (b ->> 'id')::uuid),   -- 0093: the rows of the batch, and the rows that changed nothing
      'skipped', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'unchanged')));
  END LOOP;
  IF hda AND hrg THEN
    -- 0124: the Acquisition sheet of the same file closes the tasks the Acquisition register is the source of (A3), as Master T reads it (the one selected
    -- candidate's Contract Sign-off Date), approved directly; also when the register refused its row (no Selection Date in the owner's file, Q468)
    FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x WHERE x ->> 'kind' = 'register' AND x ->> 'ref' = 'acquisition' LOOP
      PERFORM public.hms_feed_acquisition((b ->> 'id')::uuid, false, hw ->> 'reason');
    END LOOP;
  END IF;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued, 'approve_directly', hda,   -- 0092
    'registers', hrg, 'register_notes', rnotes,   -- 0093
    'reapply', rap, 'discarded', disc);   -- 0122
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
      'approve_directly', hda, 'registers', hrg, 'reapply', rap), btrim(p_reason));   -- 0092, 0093, 0122
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC; none is granted to pmis_app. The redefined functions
--    keep their owner and grants (CREATE OR REPLACE).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hrf_staging()', 'hrf_override_ok(uuid,uuid,text)', 'hrf_note_batches(uuid[],text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;
