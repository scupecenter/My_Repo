-- 0075: register and stream batches in the background, and the setting of the threshold (technical decision of 2026-11-05 (6), CHANGELOG 108).
-- Mirror: db/sql/074_register_stream_async.sql (kept identical).
--
-- WHY. 0074 moved a big New sites batch out of the HTTP request (every request is one transaction that Prisma rolls back after 30 s). The owner asked for the
-- same with the other batches: a send or an L2 decision of a register batch (an approved register template: Procurement, GECOL, HLC, Permits & HSE,
-- Warehouse, Quality, Issue, Risk, Change Control, Readiness & Handover, As-Built, Meetings, RF & Design, Acquisition, Contractors ...) and of a stream batch
-- (TPL-SITE-DA / -CW / -TE / -CL, and the stream parts of TPL-MASTER and of the Master import apply), measured at 300 rows in the CHANGELOG entry.
--
-- WHAT THIS CHANGES. Nothing in the per-row rules: the same functions decide every row, in the same order, with the same audit rows.
--   1. The send and the decision of a register batch (0037 / 0041) and of a stream batch (0073 / 0051) are split, as 0074 did for New sites, into a "rows"
--      function (a given list of rows, or all of them) and a "finish" function (the batch status, its one audit row and its notice). The synchronous functions
--      imp_submit_register_batch, imp_decide_register_batch, imp_submit_stream_batch and imp_decide_stream_batch are the same composition as before.
--   2. imp_async_start also queues a register or a stream batch (a send, or an approve / review / return of all or of selected rows) with more rows than
--      imports.async_rows. Every check of the request runs there, as for New sites: visibility and If-Match, the uploader for a send, the state, the notes of a
--      return, the authority of the person on at least one row (403 otherwise), and the step-up, read from the verified context, when the send can be a
--      self-approval (the sender holds L2 of the register row or of a task of the rows, B5) or when the decision approves. The run keeps the fixed list of the
--      rows (in the order of the synchronous call). Each chunk then checks every row again under the newly signed context of the same person. In a chunk, a row
--      that would need a step-up that the run does not have is left as it was and reported as failed (step_up_required) instead of stopping the whole run.
--   3. imp_async_step and imp_async_close dispatch by the kind of batch; imp_async_chunk_tasks gives the API the tasks of the next chunk of a stream send, so the
--      document slots of those tasks are synchronised inside that chunk's transaction (the synchronous send synchronises them all before the call, as before).
--      The chunk size depends on the kind (imp_async_chunk_size): New sites 25 (0074), register rows 50, stream rows 25.
--   4. import_batch_jobs gains n_held and n_saved (rows held at a send, saved in Save Draft mode) and accepts the actions approve, review and reject.
--   5. The hot spot of every row (pg_stat_user_functions, CHANGELOG 108): the holder and grid-right helpers app_user_is_system_admin, app_user_delegations,
--      wf_user_in_scope, reg_user_in_scope, reg_eligible_cell, reg_cell_row, wf_cell, reg_module, reg_row_key and reg_cell were SQL functions, planned again at
--      every call; they are PL/pgSQL now (same statements, plan kept for the session). wf_eligible, reg_eligible and wf_actor_regions run 3 to 5 times faster.
--   6. The Master import apply (mi_apply_run, same signatures) stages in the request as before and sends each staged batch with more rows than the threshold in
--      the background, through the same imp_async_start (the step-up expiry of the run is read from the session row); mi_run_progress_json gives the progress.
--   7. The setting imports.async_rows (default 50) gets its own screen: imports_async_json() and admin_set_imports_async_rows(rows, reason, version), for a
--      System Admin or a delegate of `settings` edit for all regions (the rule of the calendar confirmation of 0072), range 10 to 500, reason, If-Match
--      (settings_etag), audited as imports_async_rows_update with before and after. The key is guarded against direct writes like the keys of 0072.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. pmis_app gets the new doors
-- imp_async_chunk_tasks, imports_async_json, admin_set_imports_async_rows and mi_run_progress_json; the doors of 0074 and mi_apply_run keep their grants.
-- No new table right.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The run table
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE import_batch_jobs DROP CONSTRAINT IF EXISTS import_batch_jobs_action_check;
ALTER TABLE import_batch_jobs ADD CONSTRAINT import_batch_jobs_action_check CHECK (action IS NULL OR action IN ('approve', 'review', 'reject'));
ALTER TABLE import_batch_jobs ADD COLUMN n_held integer NOT NULL DEFAULT 0, ADD COLUMN n_saved integer NOT NULL DEFAULT 0;
COMMENT ON TABLE import_batch_jobs IS '0074 / 0075: the background run of the send or the decision of a big batch (New sites, register, stream; status processing). Written only by imp_async_*; no right for pmis_app.';

UPDATE settings SET description = 'A batch (New sites, register or stream) with more rows than this to send or to decide is processed in the background (status processing, in chunks), never in one HTTP request (0074, 0075). Range 10 to 500; changed in Settings, Imports.'
WHERE key = 'imports.async_rows';

-- ---------------------------------------------------------------------------------------------------------------------
-- 1b. The hot spot of the per-row checks (measured in CHANGELOG 108): the holder and right helpers below were SQL functions. A SECURITY DEFINER SQL function is
--    never inlined, and PostgreSQL plans its statement again at every call (no plan cache for SQL functions); they are called 10 to 20 times per row (the holders
--    of each level, the grid rights, the System Admin test). The same statements in PL/pgSQL keep their plan for the session. Bodies, owners and grants unchanged.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_user_is_system_admin(p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
    JOIN public.users u ON u.id = gm.user_id AND u.status = 'active'
    WHERE gm.user_id = p_user);
END $$;

CREATE OR REPLACE FUNCTION public.app_user_delegations(p_user uuid) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT d.id FROM public.delegations d
  WHERE public.deleg_effective(d.id)
    AND ( (d.target_kind = 'user' AND d.target_user_id = p_user)
       OR (d.target_kind = 'role' AND EXISTS (
             SELECT 1 FROM public.user_role_assignments a JOIN public.users u ON u.id = a.user_id AND u.status = 'active'
             WHERE a.user_id = p_user AND a.role_id = d.target_role_id AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())))
       OR (d.target_kind = 'group' AND EXISTS (
             SELECT 1 FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_active
             WHERE gm.user_id = p_user AND gm.group_id = d.target_group_id)) );
END $$;

CREATE OR REPLACE FUNCTION public.wf_user_in_scope(p_user uuid, p_region integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass)
     AND (public.app_user_is_system_admin(p_user)
          OR EXISTS (SELECT 1 FROM public.user_role_assignments ua
                     WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
                       AND (ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = ua.id AND r.region_id = p_region))
                       AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = ua.id AND m.module_key = 'sites'))));
END $$;

CREATE OR REPLACE FUNCTION public.reg_user_in_scope(p_user uuid, p_region integer, p_module text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass)
     AND (public.app_user_is_system_admin(p_user)
          OR EXISTS (SELECT 1 FROM public.user_role_assignments ua
                     WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
                       AND (p_region IS NULL OR ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = ua.id AND r.region_id = p_region))
                       AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = ua.id AND m.module_key = p_module))));
END $$;

CREATE OR REPLACE FUNCTION public.reg_eligible_cell(p_cell uuid, p_region integer, p_module text, p_need "PermissionLevel") RETURNS TABLE(user_id uuid, via_group uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH ex AS (
    SELECT a.ref_id AS uid, NULL::uuid AS gid
      FROM public.matrix_cell_assignees a WHERE a.cell_id = p_cell AND a.kind = 'user'
    UNION ALL
    SELECT ua.user_id, NULL::uuid
      FROM public.matrix_cell_assignees a
      JOIN public.roles r ON r.id = a.ref_id AND r.is_active AND r.can_hold_matrix_levels
      JOIN public.user_role_assignments ua ON ua.role_id = r.id
      WHERE a.cell_id = p_cell AND a.kind = 'role'
        AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
        AND ua.permission_level >= p_need
        AND (p_region IS NULL OR ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions rr WHERE rr.assignment_id = ua.id AND rr.region_id = p_region))
        AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules mm WHERE mm.assignment_id = ua.id AND mm.module_key = p_module))
    UNION ALL
    SELECT gm.user_id, g.id
      FROM public.matrix_cell_assignees a
      JOIN public.groups g ON g.id = a.ref_id AND g.is_active
      JOIN public.group_members gm ON gm.group_id = g.id
      WHERE a.cell_id = p_cell AND a.kind = 'group'
  )
  SELECT ex.uid, (array_agg(ex.gid) FILTER (WHERE ex.gid IS NOT NULL))[1]
  FROM ex
  WHERE public.reg_user_in_scope(ex.uid, p_region, p_module)
  GROUP BY ex.uid;
END $$;

CREATE OR REPLACE FUNCTION public.reg_cell_row(p_key text, p_region integer, p_kind text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN (SELECT c.id FROM public.matrix_cells c
          WHERE c.register_key = p_key AND c.level = CASE p_kind WHEN 'entry' THEN 1 WHEN 'review' THEN 2 ELSE 3 END
            AND (c.region_id IS NULL OR c.region_id = p_region)
          ORDER BY (c.region_id IS NOT NULL)::int DESC, c.id
          LIMIT 1);
END $$;

CREATE OR REPLACE FUNCTION public.wf_cell(p_task uuid, p_kind text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN (SELECT c.id
          FROM public.task_instances t
          JOIN public.task_definitions td ON td.id = t.task_def_id
          JOIN public.matrix_cells c ON c.stage_id = td.stage_id
               AND c.level = CASE p_kind WHEN 'entry' THEN 1 WHEN 'review' THEN 2 ELSE 3 END
               AND (c.task_def_id IS NULL OR c.task_def_id = td.id)
               AND (c.region_id IS NULL OR c.region_id = t.region_id)
          WHERE t.id = p_task AND public.app_region_check(t.region_id)
          ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id
          LIMIT 1);
END $$;

CREATE OR REPLACE FUNCTION public.reg_module(p_key text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = p_key);
END $$;

CREATE OR REPLACE FUNCTION public.reg_row_key(p_key text, p_data jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN coalesce((
    SELECT s.register_key FROM public.register_definitions d
    JOIN public.register_definitions s ON s.register_key = d.rules -> 'scope_rows' ->> public.reg_scope_of(p_key, p_data) AND s.is_active
    WHERE d.register_key = p_key AND jsonb_typeof(d.rules -> 'scope_rows') = 'object'), p_key);
END $$;

CREATE OR REPLACE FUNCTION public.reg_cell(p_record uuid, p_kind text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN (SELECT CASE WHEN p_kind <> 'entry' AND r.task_id IS NOT NULL THEN public.wf_cell(r.task_id, p_kind)
                      ELSE public.reg_cell_row(public.reg_row_key(r.register_key, r.data), r.region_id, p_kind) END
          FROM public.register_records r WHERE r.id = p_record AND public.app_region_read(r.is_global, r.region_id));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Register batches: the send (0037) and the decision (0041), split into rows and finish
-- ---------------------------------------------------------------------------------------------------------------------
-- Sends the rows of p_rows (NULL: every row still to send), in row order. p_async: a row that would need a step-up that the run does not have stays as it was
-- and is reported as failed (step_up_required); the synchronous call refuses the whole send instead (401), as before.
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
      PERFORM public.reg_transition_record(rid, rver, 'submit', NULL, p_stepup, r.id);
      SELECT state INTO st FROM public.register_records WHERE id = rid;
      UPDATE public.import_batch_rows SET register_record_id = rid, hold_reason = NULL,
        decision = CASE WHEN st = 'approved' THEN 'approved' ELSE 'pending' END,
        decided_by = CASE WHEN st = 'approved' THEN actor END, decided_at = CASE WHEN st = 'approved' THEN now() END WHERE id = r.id;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
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

-- The end of a register send: the status and the one audit row (as 0037).
CREATE OR REPLACE FUNCTION imp_submit_register_finish(p_batch uuid, p_prev_status text, p_submitted integer, p_held integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); new_st text;
BEGIN
  new_st := CASE WHEN p_submitted > 0 OR p_prev_status <> 'validated' THEN public.imp_status_of_after(p_batch) ELSE p_prev_status END;
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_submit', 'import_batch', p_batch::text, NULL,
    jsonb_build_object('submitted', p_submitted, 'held', p_held, 'failed', p_failed, 'status', new_st), NULL);
  RETURN new_st;
END $$;

-- The synchronous send (as 0037): the uploader creates every valid row as a record and submits it.
CREATE OR REPLACE FUNCTION imp_submit_register_batch(p_batch uuid, p_version int, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; res jsonb;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  -- the records are created and submitted as the uploader (L1 Data Entry): nobody else, not even an admin, enters them in the uploader's name
  IF b.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
  END IF;
  IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
  END IF;
  res := public.imp_submit_register_rows(p_batch, NULL, p_stepup, false);
  PERFORM public.imp_submit_register_finish(p_batch, b.status, (res ->> 'submitted')::int, jsonb_array_length(res -> 'held'), jsonb_array_length(res -> 'failed'));
  RETURN jsonb_build_object('submitted', (res ->> 'submitted')::int, 'held', res -> 'held', 'failed', res -> 'failed');
END $$;

-- Decides rows of a register batch (the loop of 0041). Returns the counts, the held rows and the first refusal of the authority (the caller raises it when
-- nothing was decided). p_async: as imp_submit_register_rows.
CREATE OR REPLACE FUNCTION imp_decide_register_rows(p_batch uuid, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean, p_async boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.v_import_rows%ROWTYPE; act text; rnote text; decided int := 0; approved int := 0; rejected int := 0;
  held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; first_forbidden text; st text; msg text; rec public.register_records%ROWTYPE; item jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  FOR r IN SELECT x.* FROM public.v_import_rows x
           WHERE x.batch_id = p_batch AND x.action IN ('create', 'update') AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
             AND ((p_scope = 'all' AND x.eff_decision IN ('pending', 'pending_previous_approval'))
                  OR (p_scope = 'rows' AND x.id IN (SELECT (e ->> 'row_id')::uuid FROM jsonb_array_elements(p_rows) e)))
           ORDER BY x.row_no LOOP
    item := CASE WHEN p_scope = 'rows' THEN (SELECT e FROM jsonb_array_elements(p_rows) e WHERE (e ->> 'row_id')::uuid = r.id LIMIT 1) END;
    act := CASE WHEN p_action = 'reject' THEN 'reject' WHEN p_scope = 'rows' AND item ->> 'decision' = 'rejected' THEN 'reject' ELSE p_action END;
    rnote := coalesce(nullif(btrim(item ->> 'note'), ''), nullif(btrim(p_note), ''));
    IF r.eff_decision = 'approved' OR r.eff_decision = 'rejected' THEN CONTINUE; END IF;
    -- a held row has no record yet: "approve all" lists it and leaves it; a return takes it back to the uploader
    IF r.register_record_id IS NULL THEN
      IF act = 'reject' THEN
        IF rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
        -- the same authority as returning a record: the uploader (taking the row back) or an L2 holder of the register row in the row's region
        IF actor <> b.uploaded_by AND NOT EXISTS (
             SELECT 1 FROM public.reg_eligible_cell(public.reg_cell_row(b.register_key, r.region_id, 'approve'), r.region_id, public.reg_module(b.register_key), 'approve') e
             WHERE e.user_id = actor) THEN
          BEGIN
            PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the uploader or an L2 holder of this register can return the row.'));
          EXCEPTION WHEN others THEN
            first_forbidden := coalesce(first_forbidden, SQLERRM);
          END;
          failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'not_eligible_holder',
            'message', 'Only the uploader or an L2 holder of this register can return the row.'));
          CONTINUE;
        END IF;
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, hold_reason = NULL WHERE id = r.id;
        decided := decided + 1; rejected := rejected + 1;
      ELSE
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', coalesce(r.hold_reason, 'open_version'),
          'record_id', (SELECT x.id FROM public.register_records x WHERE x.entity_id = r.matched_entity_id AND x.state IN ('entry', 'in_review', 'in_approval') LIMIT 1)));
      END IF;
      CONTINUE;
    END IF;
    IF act = 'reject' AND rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
    BEGIN
      SELECT * INTO rec FROM public.register_records WHERE id = r.register_record_id;
      IF act <> 'reject' AND ((act = 'approve' AND rec.state <> 'in_approval') OR (act = 'review' AND rec.state <> 'in_review')) THEN
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'invalid_transition',
          'message', 'The record is ' || rec.state || ': ' || act || ' is not possible now.'));
        CONTINUE;
      END IF;
      PERFORM public.reg_transition_record(rec.id, rec.version, act, rnote, p_stepup, r.id);
      SELECT state INTO st FROM public.register_records WHERE id = rec.id;
      IF act = 'reject' THEN
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        rejected := rejected + 1; decided := decided + 1;
      ELSIF st = 'approved' THEN
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        approved := approved + 1; decided := decided + 1;
      ELSE
        decided := decided + 1;     -- passed a level; the row stays open
      END IF;
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE 'wf:step_up_required%' THEN
        IF NOT coalesce(p_async, false) THEN RAISE; END IF;
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'step_up_required',
          'message', 'This row is a final approval and needs a step-up.'));
        CONTINUE;
      END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j ->> 'code' IN ('not_eligible_holder', 'action_forbidden') AND first_forbidden IS NULL THEN first_forbidden := SQLERRM; END IF;
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be decided', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The row could not be decided. See the System Log (template-check) for the technical reason.' END;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  RETURN jsonb_build_object('decided', decided, 'approved', approved, 'rejected', rejected, 'held', held, 'failed', failed, 'first_forbidden', first_forbidden);
END $$;

-- The end of a register decision: the status, the note of a return, the one audit row and the notice to the uploader (as 0041).
CREATE OR REPLACE FUNCTION imp_decide_register_finish(p_batch uuid, p_action text, p_scope text, p_note text, p_decided integer, p_approved integer, p_rejected integer,
  p_held integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; new_st text;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  new_st := public.imp_status_of_after(p_batch);
  UPDATE public.import_batches SET status = new_st, version = version + 1, note = CASE WHEN p_action = 'reject' THEN coalesce(nullif(btrim(p_note), ''), note) ELSE note END,
    closed_at = CASE WHEN new_st IN ('approved', 'rejected') THEN now() ELSE closed_at END WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_' || p_action, 'import_batch', p_batch::text, NULL,
    jsonb_build_object('scope', p_scope, 'decided', p_decided, 'approved', p_approved, 'rejected', p_rejected, 'held', p_held, 'failed', p_failed, 'status', new_st), p_note);
  IF b.uploaded_by <> actor AND p_decided > 0 THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (b.uploaded_by, 'in_app', 'import_batch', CASE WHEN p_action = 'reject' THEN 'Rows of your upload were returned' ELSE 'Rows of your upload were decided' END,
            b.file_name || ': ' || p_approved || ' approved, ' || p_rejected || ' returned' || CASE WHEN p_action = 'reject' AND p_note IS NOT NULL THEN '. ' || left(p_note, 200) ELSE '' END,
            '/registers/' || b.register_key || '/batches/' || p_batch::text);
  END IF;
  RETURN new_st;
END $$;

-- The checks of a decision on a batch that is not a New sites batch (the start of 0041 / 0051): the action, the discard, the state, the note, the rows.
-- Returns true when the discard was done (nothing else to do).
CREATE OR REPLACE FUNCTION imp_decide_checks(b public.import_batches, p_action text, p_scope text, p_rows jsonb, p_note text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor();
BEGIN
  IF p_action NOT IN ('review', 'approve', 'reject', 'discard') OR p_scope NOT IN ('all', 'rows') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope.'))));
  END IF;
  IF p_action = 'discard' THEN
    IF b.uploaded_by <> actor AND NOT public.app_user_is_system_admin(actor) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can discard it.'));
    END IF;
    IF b.status <> 'validated' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a batch that has not been sent can be discarded. Return the rows with a note instead.'));
    END IF;
    UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = coalesce(nullif(btrim(p_note), ''), 'discarded') WHERE batch_id = b.id;
    UPDATE public.import_batches SET status = 'discarded', note = nullif(btrim(p_note), ''), closed_at = now(), version = version + 1 WHERE id = b.id;
    PERFORM public.log_audit_write('import_batch_discard', 'import_batch', b.id::text, NULL, jsonb_build_object('status', 'discarded'), p_note);
    RETURN true;
  END IF;
  IF b.status NOT IN ('in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN b.status = 'validated' THEN 'The batch has not been sent into the flow yet.' ELSE 'The batch is ' || b.status || '.' END));
  END IF;
  IF p_action = 'reject' AND coalesce(btrim(p_note), '') = '' AND p_scope = 'all' THEN PERFORM public.wf_err('note_required'); END IF;
  IF p_scope = 'rows' AND (p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rows', 'code', 'required', 'message', 'Name the rows to decide.'))));
  END IF;
  RETURN false;
END $$;

-- The synchronous decision of a register batch (as 0041).
CREATE OR REPLACE FUNCTION imp_decide_register_batch(p_batch uuid, p_version int, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; res jsonb;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF public.imp_decide_checks(b, p_action, p_scope, p_rows, p_note) THEN
    RETURN jsonb_build_object('decided', 0, 'approved', 0, 'rejected', 0, 'held', '[]'::jsonb, 'failed', '[]'::jsonb);
  END IF;
  res := public.imp_decide_register_rows(p_batch, p_action, p_scope, p_rows, p_note, p_stepup, false);
  IF (res ->> 'decided')::int = 0 AND res ->> 'first_forbidden' IS NOT NULL THEN RAISE EXCEPTION '%', res ->> 'first_forbidden' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.imp_decide_register_finish(p_batch, p_action, p_scope, p_note, (res ->> 'decided')::int, (res ->> 'approved')::int, (res ->> 'rejected')::int,
    jsonb_array_length(res -> 'held'), jsonb_array_length(res -> 'failed'));
  RETURN jsonb_build_object('decided', (res ->> 'decided')::int, 'approved', (res ->> 'approved')::int, 'rejected', (res ->> 'rejected')::int, 'held', res -> 'held', 'failed', res -> 'failed');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Stream batches: the send (0073) and the decision (0051), split into rows and finish
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION imp_submit_stream_rows(p_batch uuid, p_rows uuid[], p_stepup boolean, p_async boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; t public.task_instances%ROWTYPE; submitted int := 0; saved int := 0;
  processed int := 0; held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; patch jsonb; st text; msg text; pend text; start_d date; draft boolean; flds jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  draft := (b.mode = 'draft');
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update'
             AND x.decision IN ('pending', 'pending_previous_approval') AND x.task_submitted_at IS NULL AND (p_rows IS NULL OR x.id = ANY (p_rows)) ORDER BY x.ord LOOP
    processed := processed + 1;
    BEGIN
      SELECT * INTO t FROM public.task_instances x WHERE x.id = r.task_instance_id FOR UPDATE;
      IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN
        RAISE EXCEPTION 'wf:not_found:{"detail": "The task does not exist or is not visible to you."}';
      END IF;
      IF t.state IN ('in_review', 'in_approval') THEN
        UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = 'open_submission' WHERE id = r.id;
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', 'open_submission', 'record_id', NULL));
        CONTINUE;
      ELSIF t.state = 'locked' THEN
        SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pend FROM public.task_predecessors tp
          JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
          JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = tp.predecessor_id
          WHERE tp.task_def_id = t.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped');
        UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = CASE WHEN pend IS NOT NULL THEN 'predecessor_open' ELSE 'gate_locked' END WHERE id = r.id;
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key,
          'reason', CASE WHEN pend IS NOT NULL THEN 'predecessor_open' ELSE 'gate_locked' END, 'record_id', NULL));
        CONTINUE;
      ELSIF t.state NOT IN ('open', 'entry') THEN
        RAISE EXCEPTION 'wf:task_not_open:{"detail": "The task is no longer open for entry."}';
      END IF;

      flds := coalesce(r.payload -> 'fields', '{}'::jsonb);
      patch := public.imp_task_patch(flds, r.diff);
      PERFORM set_config('app.batch_row', r.id::text, true);
      IF t.state = 'open' AND (NOT draft OR flds ? 'actual_start' OR flds ? 'actual_date') THEN
        start_d := public.imp_start_date(r.task_code, flds, t);
        IF start_d IS NULL THEN
          RAISE EXCEPTION 'wf:actual_start_required:{"detail": "The task is pending: type its Actual Start. GSDN Workspace never uses today as the start of an earlier piece of work (Q209)."}';
        END IF;
        PERFORM public.wf_start(t.id, NULL, start_d);
      END IF;
      PERFORM public.wf_save_entry(t.id, NULL, patch);
      IF draft THEN
        PERFORM set_config('app.batch_row', '', true);
        UPDATE public.import_batch_rows SET hold_reason = NULL, decision = 'saved', decided_by = actor, decided_at = now() WHERE id = r.id;
        saved := saved + 1;
        CONTINUE;
      END IF;
      IF b.historical_load THEN   -- 0073 (Q462): the mandatory-document check can be waived for this row (see hw_row_waiver)
        PERFORM public.wf_complete_hw(t.id, NULL, 'submit', NULL, p_stepup, r.id);
      ELSE
        PERFORM public.wf_submit(t.id, NULL, NULL, p_stepup);
      END IF;
      PERFORM set_config('app.batch_row', '', true);
      SELECT x.state::text INTO st FROM public.task_instances x WHERE x.id = t.id;
      UPDATE public.import_batch_rows SET hold_reason = NULL, task_submitted_at = now(),
        decision = CASE WHEN st = 'approved' THEN 'approved' ELSE 'pending' END,
        decided_by = CASE WHEN st = 'approved' THEN actor END, decided_at = CASE WHEN st = 'approved' THEN now() END WHERE id = r.id;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
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
      msg := CASE WHEN j IS NOT NULL THEN public.imp_wf_message(j, j ->> 'code') ELSE 'The task refused this row. See the System Log (template-check) for the technical reason.' END;
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', task_submitted_at = NULL, hold_reason = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('column', coalesce(r.task_code, 'Task'), 'field', coalesce(r.task_code, 'task'), 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  RETURN jsonb_build_object('submitted', submitted, 'saved', saved, 'processed', processed, 'held', held, 'failed', failed);
END $$;

-- The status of a stream batch after a send (as 0060 / 0073): Save Draft mode stays validated while rows are open, applied when rows were saved.
CREATE OR REPLACE FUNCTION imp_stream_status_after_send(p_batch uuid, p_prev_status text, p_submitted integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; n_open int;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF b.mode = 'draft' THEN
    SELECT count(*) INTO n_open FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action = 'update' AND x.decision IN ('pending', 'pending_previous_approval');
    RETURN CASE WHEN n_open > 0 THEN 'validated'
                WHEN EXISTS (SELECT 1 FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.decision = 'saved') THEN 'applied' ELSE p_prev_status END;
  END IF;
  RETURN CASE WHEN p_submitted > 0 OR p_prev_status <> 'validated' THEN public.imp_status_of_after(p_batch) ELSE p_prev_status END;
END $$;

-- The end of a stream send: the status and the one audit row (as 0073).
CREATE OR REPLACE FUNCTION imp_submit_stream_finish(p_batch uuid, p_prev_status text, p_submitted integer, p_saved integer, p_held integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; new_st text;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  new_st := public.imp_stream_status_after_send(p_batch, p_prev_status, p_submitted);
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    closed_at = CASE WHEN new_st = 'applied' THEN now() ELSE closed_at END,
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_submit', 'import_batch', p_batch::text, NULL,
    jsonb_build_object('mode', b.mode, 'submitted', p_submitted, 'saved', p_saved, 'held', p_held, 'failed', p_failed, 'status', new_st), NULL);
  RETURN new_st;
END $$;

-- The synchronous send of a stream batch (as 0073).
CREATE OR REPLACE FUNCTION public.imp_submit_stream_batch(p_batch uuid, p_version integer, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; res jsonb;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF b.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
  END IF;
  IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
  END IF;
  res := public.imp_submit_stream_rows(p_batch, NULL, p_stepup, false);
  PERFORM public.imp_submit_stream_finish(p_batch, b.status, (res ->> 'submitted')::int, (res ->> 'saved')::int, jsonb_array_length(res -> 'held'), jsonb_array_length(res -> 'failed'));
  RETURN jsonb_build_object('submitted', (res ->> 'submitted')::int, 'saved', (res ->> 'saved')::int, 'held', res -> 'held', 'failed', res -> 'failed');
END $$;

-- Decides rows of a stream batch (the loop of 0051).
CREATE OR REPLACE FUNCTION imp_decide_stream_rows(p_batch uuid, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean, p_async boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.v_import_rows%ROWTYPE; act text; rnote text; decided int := 0; approved int := 0; rejected int := 0;
  held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; first_forbidden text; st text; msg text; t public.task_instances%ROWTYPE; item jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  FOR r IN SELECT x.* FROM public.v_import_rows x
           WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update' AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
             AND ((p_scope = 'all' AND x.eff_decision IN ('pending', 'pending_previous_approval'))
                  OR (p_scope = 'rows' AND x.id IN (SELECT (e ->> 'row_id')::uuid FROM jsonb_array_elements(p_rows) e)))
           ORDER BY x.ord LOOP
    item := CASE WHEN p_scope = 'rows' THEN (SELECT e FROM jsonb_array_elements(p_rows) e WHERE (e ->> 'row_id')::uuid = r.id LIMIT 1) END;
    act := CASE WHEN p_action = 'reject' THEN 'reject' WHEN p_scope = 'rows' AND item ->> 'decision' = 'rejected' THEN 'reject' ELSE p_action END;
    rnote := coalesce(nullif(btrim(item ->> 'note'), ''), nullif(btrim(p_note), ''));
    IF r.eff_decision = 'approved' OR r.eff_decision = 'rejected' THEN CONTINUE; END IF;
    -- a held row has not entered the task: "approve all" lists it and leaves it; a return takes it back (the uploader, or an L2 holder of the task)
    IF r.task_submitted_at IS NULL THEN
      IF act = 'reject' THEN
        IF rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
        IF actor <> b.uploaded_by AND NOT public.wf_is_eligible(r.task_instance_id, 'approve', actor) THEN
          BEGIN
            PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the uploader or an L2 holder of this task can return the row.'));
          EXCEPTION WHEN others THEN
            first_forbidden := coalesce(first_forbidden, SQLERRM);
          END;
          failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'not_eligible_holder',
            'message', 'Only the uploader or an L2 holder of this task can return the row.'));
          CONTINUE;
        END IF;
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, hold_reason = NULL WHERE id = r.id;
        decided := decided + 1; rejected := rejected + 1;
      ELSE
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', coalesce(r.hold_reason, 'open_submission'), 'record_id', NULL));
      END IF;
      CONTINUE;
    END IF;
    IF act = 'reject' AND rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
    BEGIN
      SELECT * INTO t FROM public.task_instances x WHERE x.id = r.task_instance_id;
      IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN RAISE EXCEPTION 'wf:not_found:{"detail": "The task does not exist or is not visible to you."}'; END IF;
      IF act <> 'reject' AND ((act = 'approve' AND t.state <> 'in_approval') OR (act = 'review' AND t.state <> 'in_review')) THEN
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'invalid_transition',
          'message', 'The task is ' || t.state::text || ': ' || act || ' is not possible now.'));
        CONTINUE;
      END IF;
      PERFORM set_config('app.batch_row', r.id::text, true);
      IF act = 'reject' THEN PERFORM public.wf_reject(t.id, NULL, rnote, '[]'::jsonb);
      ELSIF act = 'review' THEN PERFORM public.wf_review(t.id, NULL, rnote, p_stepup);
      ELSE PERFORM public.wf_approve(t.id, NULL, rnote, p_stepup); END IF;
      PERFORM set_config('app.batch_row', '', true);
      SELECT x.state::text INTO st FROM public.task_instances x WHERE x.id = t.id;
      IF act = 'reject' THEN
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        rejected := rejected + 1; decided := decided + 1;
      ELSIF st = 'approved' THEN
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        approved := approved + 1; decided := decided + 1;
      ELSE
        decided := decided + 1;     -- passed a level; the row stays open
      END IF;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.batch_row', '', true);
      IF SQLERRM LIKE 'wf:step_up_required%' THEN
        IF NOT coalesce(p_async, false) THEN RAISE; END IF;
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'step_up_required',
          'message', 'This row is a final approval and needs a step-up.'));
        CONTINUE;
      END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j ->> 'code' IN ('not_eligible_holder', 'action_forbidden') AND first_forbidden IS NULL THEN first_forbidden := SQLERRM; END IF;
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be decided', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN public.imp_wf_message(j, j ->> 'code') ELSE 'The row could not be decided. See the System Log (template-check) for the technical reason.' END;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  RETURN jsonb_build_object('decided', decided, 'approved', approved, 'rejected', rejected, 'held', held, 'failed', failed, 'first_forbidden', first_forbidden);
END $$;

-- The end of a stream decision (as 0051).
CREATE OR REPLACE FUNCTION imp_decide_stream_finish(p_batch uuid, p_action text, p_scope text, p_note text, p_decided integer, p_approved integer, p_rejected integer,
  p_held integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; new_st text;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  new_st := public.imp_status_of_after(p_batch);
  UPDATE public.import_batches SET status = new_st, version = version + 1, note = CASE WHEN p_action = 'reject' THEN coalesce(nullif(btrim(p_note), ''), note) ELSE note END,
    closed_at = CASE WHEN new_st IN ('approved', 'rejected') THEN now() ELSE closed_at END WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_' || p_action, 'import_batch', p_batch::text, NULL,
    jsonb_build_object('scope', p_scope, 'decided', p_decided, 'approved', p_approved, 'rejected', p_rejected, 'held', p_held, 'failed', p_failed, 'status', new_st), p_note);
  IF b.uploaded_by <> actor AND p_decided > 0 THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (b.uploaded_by, 'in_app', 'import_batch', CASE WHEN p_action = 'reject' THEN 'Rows of your upload were returned' ELSE 'Rows of your upload were decided' END,
            b.file_name || ': ' || p_approved || ' approved, ' || p_rejected || ' returned' || CASE WHEN p_action = 'reject' AND p_note IS NOT NULL THEN '. ' || left(p_note, 200) ELSE '' END,
            '/templates/batches/' || p_batch::text);
  END IF;
  RETURN new_st;
END $$;

-- The synchronous decision of a stream batch (as 0051).
CREATE OR REPLACE FUNCTION imp_decide_stream_batch(p_batch uuid, p_version int, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; res jsonb;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF public.imp_decide_checks(b, p_action, p_scope, p_rows, p_note) THEN
    RETURN jsonb_build_object('decided', 0, 'approved', 0, 'rejected', 0, 'held', '[]'::jsonb, 'failed', '[]'::jsonb);
  END IF;
  res := public.imp_decide_stream_rows(p_batch, p_action, p_scope, p_rows, p_note, p_stepup, false);
  IF (res ->> 'decided')::int = 0 AND res ->> 'first_forbidden' IS NOT NULL THEN RAISE EXCEPTION '%', res ->> 'first_forbidden' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.imp_decide_stream_finish(p_batch, p_action, p_scope, p_note, (res ->> 'decided')::int, (res ->> 'approved')::int, (res ->> 'rejected')::int,
    jsonb_array_length(res -> 'held'), jsonb_array_length(res -> 'failed'));
  RETURN jsonb_build_object('decided', (res ->> 'decided')::int, 'approved', (res ->> 'approved')::int, 'rejected', (res ->> 'rejected')::int, 'held', res -> 'held', 'failed', res -> 'failed');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The background run of a register or a stream batch
-- ---------------------------------------------------------------------------------------------------------------------
-- The kind of a batch for the background run: site (0074), register, stream (TPL-SITE-* and the stream parts of a Master upload or apply).
CREATE OR REPLACE FUNCTION imp_batch_kind(p_batch uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN b.entity = 'site' THEN 'site' WHEN b.stream_code IS NOT NULL THEN 'stream' ELSE 'register' END FROM public.import_batches b WHERE b.id = p_batch
$$;

-- Rows per chunk (each chunk is one transaction, a few seconds; the CHANGELOG entry 108 has the measures). p_chunk (1 to 100) overrides it.
CREATE OR REPLACE FUNCTION imp_async_chunk_size(p_batch_kind text, p_chunk integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT greatest(1, least(coalesce(p_chunk, CASE p_batch_kind WHEN 'register' THEN 50 WHEN 'stream' THEN 25 ELSE 25 END), 100))
$$;

-- imp_async_start for a register or a stream batch (called by imp_async_start). The same checks as the synchronous call, in the request transaction.
CREATE OR REPLACE FUNCTION imp_async_start_rs(p_batch uuid, p_version integer, p_kind text, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup_until timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; lim int; n int; items jsonb; su boolean := public.app_ctx_stepup(); jid uuid; noted boolean; bk text; may boolean;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  bk := CASE WHEN b.stream_code IS NOT NULL THEN 'stream' ELSE 'register' END;
  BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;

  IF p_kind = 'submit' THEN
    IF b.uploaded_by <> actor THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
    END IF;
    IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
    END IF;
    -- the fixed list of the rows to send, in the order of the synchronous call
    IF bk = 'register' THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object('row_id', x.id) ORDER BY x.row_no), '[]'::jsonb), count(*) INTO items, n FROM public.import_batch_rows x
      WHERE x.batch_id = p_batch AND x.action IN ('create', 'update') AND x.decision IN ('pending', 'pending_previous_approval') AND x.register_record_id IS NULL;
    ELSE
      SELECT coalesce(jsonb_agg(jsonb_build_object('row_id', x.id) ORDER BY x.ord), '[]'::jsonb), count(*) INTO items, n FROM public.import_batch_rows x
      WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update' AND x.decision IN ('pending', 'pending_previous_approval') AND x.task_submitted_at IS NULL;
    END IF;
    IF n <= lim THEN RETURN jsonb_build_object('queued', false); END IF;
    -- B5: a sender who also holds L2 (of the register row, or of a task of the rows) approves at once, so the step-up is needed now (the synchronous send refuses it all)
    IF NOT su AND b.mode <> 'draft' THEN
      IF bk = 'register' THEN
        may := EXISTS (SELECT 1 FROM (SELECT DISTINCT x.region_id FROM public.import_batch_rows x JOIN jsonb_array_elements(items) e ON (e ->> 'row_id')::uuid = x.id) g
                       WHERE EXISTS (SELECT 1 FROM public.reg_eligible_cell(public.reg_cell_row(b.register_key, g.region_id, 'approve'), g.region_id, public.reg_module(b.register_key), 'approve') c
                                     WHERE c.user_id = actor));
      ELSE
        may := EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (t.task_def_id, t.region_id) t.id FROM public.import_batch_rows x JOIN jsonb_array_elements(items) e ON (e ->> 'row_id')::uuid = x.id
                                      JOIN public.task_instances t ON t.id = x.task_instance_id) g
                       WHERE public.wf_is_eligible(g.id, 'approve', actor));
      END IF;
      IF may THEN PERFORM public.wf_err('step_up_required'); END IF;
    END IF;
  ELSE
    IF b.mode = 'draft' AND bk = 'stream' THEN RETURN jsonb_build_object('queued', false); END IF;   -- a Save Draft batch has no L2 decision (Q206)
    IF p_action NOT IN ('review', 'approve', 'reject') THEN RETURN jsonb_build_object('queued', false); END IF;   -- a discard is one statement
    IF p_scope NOT IN ('all', 'rows') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope.'))));
    END IF;
    IF b.status NOT IN ('in_approval', 'partially_approved') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN b.status = 'validated' THEN 'The batch has not been sent into the flow yet.' ELSE 'The batch is ' || b.status || '.' END));
    END IF;
    IF p_action = 'reject' AND coalesce(btrim(p_note), '') = '' AND p_scope = 'all' THEN PERFORM public.wf_err('note_required'); END IF;
    IF p_scope = 'rows' AND (p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rows', 'code', 'required', 'message', 'Name the rows to decide.'))));
    END IF;
    -- the fixed list of the rows to decide, in the order of the synchronous call; each item says whether it is a return (and its note)
    SELECT coalesce(jsonb_agg(jsonb_build_object('row_id', x.id,
             'decision', CASE WHEN p_action = 'reject' OR it.e ->> 'decision' = 'rejected' THEN 'rejected' ELSE 'approved' END)
             || CASE WHEN nullif(btrim(it.e ->> 'note'), '') IS NOT NULL THEN jsonb_build_object('note', it.e ->> 'note') ELSE '{}'::jsonb END
             ORDER BY CASE WHEN bk = 'register' THEN x.row_no ELSE x.ord END, x.row_no), '[]'::jsonb), count(*)
      INTO items, n
    FROM public.v_import_rows x
    LEFT JOIN LATERAL (SELECT e FROM jsonb_array_elements(CASE WHEN p_scope = 'rows' THEN p_rows ELSE '[]'::jsonb END) e WHERE (e ->> 'row_id')::uuid = x.id LIMIT 1) it ON true
    WHERE x.batch_id = p_batch AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
      AND ((bk = 'register' AND x.action IN ('create', 'update')) OR (bk = 'stream' AND x.task_instance_id IS NOT NULL AND x.action = 'update'))
      AND x.eff_decision NOT IN ('approved', 'rejected')
      AND ((p_scope = 'all' AND x.eff_decision IN ('pending', 'pending_previous_approval')) OR (p_scope = 'rows' AND it.e IS NOT NULL));
    IF n <= lim THEN RETURN jsonb_build_object('queued', false); END IF;
    -- a return needs a note (as the synchronous call, which refuses the whole decision)
    SELECT bool_and(coalesce(nullif(btrim(e ->> 'note'), ''), nullif(btrim(p_note), '')) IS NOT NULL) INTO noted FROM jsonb_array_elements(items) e WHERE e ->> 'decision' = 'rejected';
    IF noted IS FALSE THEN PERFORM public.wf_err('note_required'); END IF;
    -- the authority: the person may act on at least one row (otherwise 403, as the synchronous call when nothing could be decided). Every row is checked again in its chunk.
    IF bk = 'register' THEN
      may := EXISTS (SELECT 1 FROM jsonb_array_elements(items) e JOIN public.import_batch_rows q ON q.id = (e ->> 'row_id')::uuid
                     WHERE CASE WHEN q.register_record_id IS NULL
                                THEN e ->> 'decision' = 'rejected' AND (actor = b.uploaded_by OR EXISTS (SELECT 1 FROM public.reg_eligible_cell(public.reg_cell_row(b.register_key, q.region_id, 'approve'),
                                       q.region_id, public.reg_module(b.register_key), 'approve') c WHERE c.user_id = actor))
                                ELSE public.reg_is_eligible(q.register_record_id, CASE WHEN p_action = 'review' THEN 'review' ELSE 'approve' END, actor)
                                     OR (e ->> 'decision' = 'rejected' AND public.reg_is_eligible(q.register_record_id, 'review', actor)) END);
    ELSE
      may := EXISTS (SELECT 1 FROM jsonb_array_elements(items) e JOIN public.import_batch_rows q ON q.id = (e ->> 'row_id')::uuid
                     WHERE CASE WHEN q.task_submitted_at IS NULL
                                THEN e ->> 'decision' = 'rejected' AND (actor = b.uploaded_by OR public.wf_is_eligible(q.task_instance_id, 'approve', actor))
                                ELSE public.wf_is_eligible(q.task_instance_id, CASE WHEN p_action = 'review' THEN 'review' ELSE 'approve' END, actor)
                                     OR (e ->> 'decision' = 'rejected' AND public.wf_is_eligible(q.task_instance_id, 'review', actor)) END);
    END IF;
    IF NOT coalesce(may, false) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a holder of the level these rows wait for.'));
    END IF;
    -- an approval is final (B5 and the final approval): the step-up is needed now
    IF NOT su AND p_action = 'approve' AND EXISTS (SELECT 1 FROM jsonb_array_elements(items) e WHERE e ->> 'decision' = 'approved') THEN PERFORM public.wf_err('step_up_required'); END IF;
  END IF;

  INSERT INTO public.import_batch_jobs (batch_id, kind, action, scope, items, note, actor_id, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, prev_status, rows_total)
  VALUES (p_batch, p_kind, CASE WHEN p_kind = 'decide' THEN p_action END, CASE WHEN p_kind = 'decide' THEN p_scope END, items,
          CASE WHEN p_kind = 'decide' THEN left(p_note, 2000) END, actor, su, CASE WHEN su THEN p_stepup_until END,
          CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
          public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END,
          left(public.app_ctx_get('request_id'), 64), b.status, n)
  RETURNING id INTO jid;
  UPDATE public.import_batches SET version = version + 1 WHERE id = p_batch;   -- a stale If-Match is refused from now on
  PERFORM public.log_audit_write('import_batch_processing', 'import_batch', p_batch::text, jsonb_build_object('status', b.status),
    jsonb_build_object('status', 'processing', 'job_id', jid, 'kind', p_kind, 'batch_kind', bk, 'action', CASE WHEN p_kind = 'decide' THEN p_action END,
      'scope', CASE WHEN p_kind = 'decide' THEN p_scope END, 'rows', n, 'stepup', su), CASE WHEN p_kind = 'decide' THEN p_note END);
  RETURN jsonb_build_object('queued', true, 'job', public.imp_batch_job_json(p_batch));
END $$;

-- As 0074, and a register or a stream batch goes to imp_async_start_rs (the New sites part is unchanged).
CREATE OR REPLACE FUNCTION imp_async_start(p_batch uuid, p_version integer, p_kind text, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup_until timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; lim int; n int; items jsonb; su boolean := public.app_ctx_stepup(); jid uuid; noted boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind NOT IN ('submit', 'decide') THEN RAISE EXCEPTION 'imp_async_start: kind is submit or decide' USING ERRCODE = 'invalid_parameter_value'; END IF;
  PERFORM public.imp_async_guard(p_batch);
  IF NOT EXISTS (SELECT 1 FROM public.import_batches x WHERE x.id = p_batch AND x.entity = 'site') THEN   -- 0075
    IF NOT EXISTS (SELECT 1 FROM public.import_batches x WHERE x.id = p_batch) THEN RETURN jsonb_build_object('queued', false); END IF;
    RETURN public.imp_async_start_rs(p_batch, p_version, p_kind, p_action, p_scope, p_rows, p_note, p_stepup_until);
  END IF;
  IF p_kind = 'decide' AND p_action IS DISTINCT FROM 'approve' THEN RETURN jsonb_build_object('queued', false); END IF;
  b := public.imp_lock_batch(p_batch, p_version);
  BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;

  IF p_kind = 'submit' THEN
    IF b.uploaded_by <> actor THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
    END IF;
    IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
    END IF;
    SELECT count(*) INTO n FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL;
    IF n <= lim THEN RETURN jsonb_build_object('queued', false); END IF;
    -- B5: a sender who also holds L2 of a region of the rows approves at once, so the step-up is needed now (as the synchronous send, which refuses it all)
    IF NOT su AND EXISTS (SELECT 1 FROM (SELECT DISTINCT x.region_id FROM public.import_batch_rows x
                                         WHERE x.batch_id = p_batch AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL AND x.region_id IS NOT NULL) g
                          WHERE public.site_new_holds(g.region_id, 'approve') AND public.site_new_may('approve', g.region_id)) THEN
      PERFORM public.wf_err('step_up_required');
    END IF;
  ELSE
    IF p_scope NOT IN ('all', 'rows') THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope: a site has two levels, approve or reject.'))));
    END IF;
    IF b.status NOT IN ('in_approval', 'partially_approved') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN b.status = 'validated' THEN 'The batch has not been sent into the flow yet.' ELSE 'The batch is ' || b.status || '.' END));
    END IF;
    IF p_scope = 'rows' AND (p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rows', 'code', 'required', 'message', 'Name the rows to decide.'))));
    END IF;
    SELECT coalesce(jsonb_agg(CASE WHEN p_scope = 'all' THEN jsonb_build_object('row_id', x.id, 'decision', 'approved') ELSE it.e END ORDER BY x.row_no), '[]'::jsonb), count(*)
      INTO items, n
    FROM public.v_import_rows x
    LEFT JOIN LATERAL (SELECT e FROM jsonb_array_elements(CASE WHEN p_scope = 'rows' THEN p_rows ELSE '[]'::jsonb END) e WHERE (e ->> 'row_id')::uuid = x.id LIMIT 1) it ON true
    WHERE x.batch_id = p_batch AND x.action = 'create' AND EXISTS (SELECT 1 FROM public.import_batch_rows q WHERE q.id = x.id AND q.site_draft_id IS NOT NULL)
      AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
      AND x.eff_decision NOT IN ('approved', 'rejected')
      AND ((p_scope = 'all' AND x.eff_decision = 'pending') OR (p_scope = 'rows' AND it.e IS NOT NULL));
    IF n <= lim THEN RETURN jsonb_build_object('queued', false); END IF;
    SELECT bool_and(coalesce(nullif(btrim(e ->> 'note'), ''), nullif(btrim(p_note), '')) IS NOT NULL) INTO noted FROM jsonb_array_elements(items) e WHERE e ->> 'decision' = 'rejected';
    IF noted IS FALSE THEN PERFORM public.wf_err('note_required'); END IF;
    IF NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT d.region_id FROM jsonb_array_elements(items) e JOIN public.import_batch_rows q ON q.id = (e ->> 'row_id')::uuid
                                  JOIN public.site_drafts d ON d.id = q.site_draft_id WHERE d.status = 'in_approval') g
                   WHERE public.site_new_may('approve', g.region_id) AND public.site_new_holds(g.region_id, 'approve')) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Review and Approve holder (L2) of the Site creation row in this region.'));
    END IF;
    IF NOT su AND EXISTS (SELECT 1 FROM jsonb_array_elements(items) e WHERE e ->> 'decision' IS DISTINCT FROM 'rejected') THEN PERFORM public.wf_err('step_up_required'); END IF;
  END IF;

  INSERT INTO public.import_batch_jobs (batch_id, kind, action, scope, items, note, actor_id, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, prev_status, rows_total)
  VALUES (p_batch, p_kind, CASE WHEN p_kind = 'decide' THEN 'approve' END, CASE WHEN p_kind = 'decide' THEN p_scope END, CASE WHEN p_kind = 'decide' THEN items END,
          CASE WHEN p_kind = 'decide' THEN left(p_note, 2000) END, actor, su, CASE WHEN su THEN p_stepup_until END,
          CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
          public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END,
          left(public.app_ctx_get('request_id'), 64), b.status, n)
  RETURNING id INTO jid;
  UPDATE public.import_batches SET version = version + 1 WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_processing', 'import_batch', p_batch::text, jsonb_build_object('status', b.status),
    jsonb_build_object('status', 'processing', 'job_id', jid, 'kind', p_kind, 'action', CASE WHEN p_kind = 'decide' THEN 'approve' END, 'scope', CASE WHEN p_kind = 'decide' THEN p_scope END,
      'rows', n, 'stepup', su), CASE WHEN p_kind = 'decide' THEN p_note END);
  RETURN jsonb_build_object('queued', true, 'job', public.imp_batch_job_json(p_batch));
END $$;

-- The tasks of the next chunk of a stream send (the API synchronises their document slots in the chunk's transaction, before imp_async_step). Only for the
-- person who asked for the run; empty for any other run.
CREATE OR REPLACE FUNCTION imp_async_chunk_tasks(p_job uuid, p_chunk integer DEFAULT NULL) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); j public.import_batch_jobs%ROWTYPE; chunk int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO j FROM public.import_batch_jobs WHERE id = p_job;
  IF NOT FOUND OR j.actor_id <> actor OR j.state <> 'running' OR j.kind <> 'submit' OR public.imp_batch_kind(j.batch_id) <> 'stream' THEN RETURN; END IF;
  -- the Master import apply never synchronised the documents of its rows (mi_apply_run sends in the database): its batches keep that behaviour
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = j.batch_id AND b.source = 'master_import') THEN RETURN; END IF;
  chunk := public.imp_async_chunk_size('stream', p_chunk);
  RETURN QUERY
    SELECT DISTINCT x.task_instance_id
    FROM jsonb_array_elements(j.items) WITH ORDINALITY AS t(e, o)
    JOIN public.import_batch_rows x ON x.id = (t.e ->> 'row_id')::uuid
    WHERE t.o > j.pos AND t.o <= j.pos + chunk AND x.batch_id = j.batch_id AND x.task_instance_id IS NOT NULL AND x.action = 'update'
      AND x.task_submitted_at IS NULL AND x.decision IN ('pending', 'pending_previous_approval');
END $$;

-- One chunk (as 0074 for New sites; a register or a stream batch takes the next slice of its fixed list of rows).
CREATE OR REPLACE FUNCTION imp_async_step(p_job uuid, p_chunk integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); j public.import_batch_jobs%ROWTYPE; chunk int; res jsonb; slice jsonb; done boolean; n_proc int; f jsonb; bk text; ids uuid[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO j FROM public.import_batch_jobs WHERE id = p_job FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.import_batch_jobs WHERE id = p_job) THEN RETURN jsonb_build_object('job_id', p_job, 'state', 'busy'); END IF;
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The background run does not exist.'));
  END IF;
  IF j.actor_id <> actor THEN
    RAISE EXCEPTION 'only the person who asked for the run continues it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF j.state <> 'running' THEN RETURN public.imp_batch_job_json(j.batch_id); END IF;
  PERFORM 1 FROM public.import_batches WHERE id = j.batch_id FOR UPDATE;
  bk := public.imp_batch_kind(j.batch_id);
  chunk := public.imp_async_chunk_size(bk, p_chunk);
  IF bk = 'site' AND j.kind = 'submit' THEN
    res := public.imp_submit_site_rows(j.batch_id, chunk, j.stepup_verified, true);
    n_proc := (res ->> 'processed')::int;
    done := n_proc < chunk OR NOT EXISTS (SELECT 1 FROM public.import_batch_rows x WHERE x.batch_id = j.batch_id AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL);
    f := res -> 'failed';
    UPDATE public.import_batch_jobs SET rows_done = least(rows_total, rows_done + n_proc), n_submitted = n_submitted + (res ->> 'submitted')::int,
      n_approved = (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = j.batch_id AND x.action = 'create' AND x.decision = 'approved'),
      n_failed = n_failed + jsonb_array_length(f), failed = CASE WHEN jsonb_array_length(failed) < 500 THEN failed || f ELSE failed END,
      chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_job;
  ELSE
    SELECT coalesce(jsonb_agg(e ORDER BY o), '[]'::jsonb) INTO slice FROM jsonb_array_elements(j.items) WITH ORDINALITY AS t(e, o) WHERE o > j.pos AND o <= j.pos + chunk;
    n_proc := jsonb_array_length(slice);
    done := j.pos + n_proc >= jsonb_array_length(j.items);
    IF n_proc = 0 THEN
      res := jsonb_build_object('submitted', 0, 'saved', 0, 'decided', 0, 'approved', 0, 'rejected', 0, 'held', '[]'::jsonb, 'failed', '[]'::jsonb);
    ELSIF bk = 'site' THEN
      res := public.imp_decide_site_rows(j.batch_id, 'approve', 'rows', slice, j.note, j.stepup_verified);
    ELSIF j.kind = 'submit' THEN
      SELECT array_agg((e ->> 'row_id')::uuid) INTO ids FROM jsonb_array_elements(slice) e;
      res := CASE bk WHEN 'register' THEN public.imp_submit_register_rows(j.batch_id, ids, j.stepup_verified, true)
                     ELSE public.imp_submit_stream_rows(j.batch_id, ids, j.stepup_verified, true) END;
    ELSE
      res := CASE bk WHEN 'register' THEN public.imp_decide_register_rows(j.batch_id, j.action, 'rows', slice, j.note, j.stepup_verified, true)
                     ELSE public.imp_decide_stream_rows(j.batch_id, j.action, 'rows', slice, j.note, j.stepup_verified, true) END;
    END IF;
    f := res -> 'failed';
    UPDATE public.import_batch_jobs SET pos = pos + n_proc, rows_done = least(rows_total, rows_done + n_proc),
      n_submitted = n_submitted + coalesce((res ->> 'submitted')::int, 0), n_saved = n_saved + coalesce((res ->> 'saved')::int, 0),
      n_decided = n_decided + coalesce((res ->> 'decided')::int, 0), n_rejected = n_rejected + coalesce((res ->> 'rejected')::int, 0),
      n_approved = CASE WHEN j.kind = 'submit'
                        THEN (SELECT count(*) FROM jsonb_array_elements(j.items) e JOIN public.import_batch_rows x ON x.id = (e ->> 'row_id')::uuid WHERE x.decision = 'approved')
                        ELSE n_approved + coalesce((res ->> 'approved')::int, 0) END,
      n_held = n_held + jsonb_array_length(coalesce(res -> 'held', '[]'::jsonb)),
      n_failed = n_failed + jsonb_array_length(f), failed = CASE WHEN jsonb_array_length(failed) < 500 THEN failed || f ELSE failed END,
      chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_job;
  END IF;
  IF done THEN PERFORM public.imp_async_close(p_job, 'done', NULL); END IF;
  RETURN public.imp_batch_job_json(j.batch_id);
END $$;

-- Ends a run (as 0074): the finish of the send or the decision of its kind of batch, and the run's own state.
CREATE OR REPLACE FUNCTION imp_async_close(p_job uuid, p_state text, p_error text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.import_batch_jobs%ROWTYPE; st text; bk text;
BEGIN
  SELECT * INTO j FROM public.import_batch_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.state <> 'running' THEN RETURN; END IF;
  UPDATE public.import_batch_jobs SET state = p_state, error = left(p_error, 500), finished_at = clock_timestamp(), heartbeat_at = clock_timestamp() WHERE id = p_job;
  bk := public.imp_batch_kind(j.batch_id);
  IF public.app_actor() IS NOT NULL THEN
    IF bk = 'site' AND j.kind = 'submit' THEN
      st := public.imp_submit_site_finish(j.batch_id, j.prev_status, j.n_submitted, j.n_failed);
    ELSIF bk = 'site' THEN
      st := public.imp_decide_site_finish(j.batch_id, 'approve', j.scope, j.note, j.n_decided, j.n_approved, j.n_rejected, j.n_failed);
    ELSIF bk = 'register' AND j.kind = 'submit' THEN
      st := public.imp_submit_register_finish(j.batch_id, j.prev_status, j.n_submitted, j.n_held, j.n_failed);
    ELSIF bk = 'register' THEN
      st := public.imp_decide_register_finish(j.batch_id, j.action, j.scope, j.note, j.n_decided, j.n_approved, j.n_rejected, j.n_held, j.n_failed);
    ELSIF j.kind = 'submit' THEN
      st := public.imp_submit_stream_finish(j.batch_id, j.prev_status, j.n_submitted, j.n_saved, j.n_held, j.n_failed);
    ELSE
      st := public.imp_decide_stream_finish(j.batch_id, j.action, j.scope, j.note, j.n_decided, j.n_approved, j.n_rejected, j.n_held, j.n_failed);
    END IF;
  ELSE
    -- the person can no longer act (deactivated or deleted): the rows done so far stay, the status follows them, the audit row names no actor
    st := CASE WHEN bk = 'stream' AND j.kind = 'submit' THEN public.imp_stream_status_after_send(j.batch_id, j.prev_status, j.n_submitted)
               WHEN j.kind = 'submit' AND j.n_submitted = 0 AND j.prev_status = 'validated' THEN j.prev_status
               ELSE public.imp_status_of_after(j.batch_id) END;
    UPDATE public.import_batches SET status = st, version = version + 1,
      submitted_at = CASE WHEN j.kind = 'submit' AND j.n_submitted + j.n_saved > 0 THEN coalesce(submitted_at, now()) ELSE submitted_at END,
      submitted_by = CASE WHEN j.kind = 'submit' AND j.n_submitted + j.n_saved > 0 THEN coalesce(submitted_by, j.actor_id) ELSE submitted_by END,
      closed_at = CASE WHEN st = 'applied' THEN coalesce(closed_at, now()) ELSE closed_at END,
      rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = j.batch_id AND action = 'error') WHERE id = j.batch_id;
  END IF;
  IF p_state <> 'done' THEN
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('import_batch_processing_stopped', 'import_batch', j.batch_id::text, jsonb_build_object('status', 'processing'),
            jsonb_build_object('status', st, 'job_id', j.id, 'kind', j.kind, 'rows_total', j.rows_total, 'rows_done', j.rows_done, 'failed', j.n_failed), left(p_error, 2000), public.app_actor());
  END IF;
END $$;

-- The progress (as 0074), with the action, the batch kind and the held and saved rows.
CREATE OR REPLACE FUNCTION imp_batch_job_json(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('job_id', j.id, 'kind', j.kind, 'action', j.action, 'batch_kind', public.imp_batch_kind(j.batch_id), 'state', j.state,
           'rows_total', j.rows_total, 'rows_done', j.rows_done,
           'percent', CASE WHEN j.rows_total = 0 THEN 100 ELSE floor(100.0 * j.rows_done / j.rows_total)::int END,
           'submitted', j.n_submitted, 'saved', j.n_saved, 'decided', j.n_decided, 'approved', j.n_approved, 'rejected', j.n_rejected, 'held', j.n_held, 'failed', j.n_failed,
           'started_at', j.created_at, 'updated_at', j.heartbeat_at, 'finished_at', j.finished_at, 'error', j.error)
  FROM public.import_batch_jobs j
  WHERE j.batch_id = p_batch AND public.app_actor() IS NOT NULL AND public.imp_batch_visible(p_batch)
  ORDER BY j.created_at DESC LIMIT 1
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4b. The Master import apply (P3, 0060 / 0073): the staging stays in the request; each staged batch with more rows than imports.async_rows is sent in the
--     background (imp_async_start, as a send of that batch by the same person), the others are sent at once as before. The latest body is 0073; the changes
--     are marked "0075". The run is `applied` once staged; its batches show `processing` until their runs end (mi_run_progress_json).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb)
 RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $function$
DECLARE
  actor uuid := public.app_actor(); r public.master_reconciliation_runs%ROWTYPE; prev uuid; tv public.template_versions%ROWTYPE; mpart jsonb; mcols jsonb; v_rows jsonb := '[]'::jsonb;
  row_ record; cells jsonb; pres jsonb; c jsonb; cv jsonb; res jsonb; b jsonb; sent jsonb; v_outcome jsonb; batches jsonb := '[]'::jsonb; gid uuid := gen_random_uuid();
  hw jsonb;   -- 0073: the mark of the batches
  q jsonb; queued int := 0;   -- 0075: a batch sent in the background
  su_until timestamptz;        -- 0075: when the verified step-up of this session ends (from the session row, never from the caller), for the audit rows of the run
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  SELECT * INTO r FROM public.master_reconciliation_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The import run does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The run changed since you read it. Reload and try again.')); END IF;
  IF r.status <> 'previewed' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This run was already applied.')); END IF;
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
  END IF;
  IF public.app_ctx_stepup() THEN   -- 0075
    SELECT us.stepup_at + make_interval(secs => coalesce((SELECT CASE WHEN jsonb_typeof(st.value) = 'number' THEN (st.value #>> '{}')::int END
                                                          FROM public.settings st WHERE st.key = 'stepup_max_age_seconds'), 300))
      INTO su_until FROM public.user_sessions us WHERE us.id = public.log_ctx_uuid('session_id') AND us.user_id = actor AND us.revoked_at IS NULL AND us.stepup_at IS NOT NULL;
  END IF;
  SELECT x.id INTO prev FROM public.master_reconciliation_runs x WHERE x.file_sha256 = r.file_sha256 AND x.status = 'applied' AND x.id <> r.id LIMIT 1;
  IF prev IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This file was already applied (run ' || prev::text || '). A reconciliation run compares again; it never applies the same file twice.'));
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
  IF jsonb_array_length(v_rows) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'No typed task column of this file belongs to a site of GSDN Workspace: nothing can be entered.'));
  END IF;
  res := public.imp_stage_master_core('TPL-MASTER', tv.version, r.file_name, r.file_sha256,
    jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid, hw);
  FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x LOOP
    -- 0075: a batch with more rows than imports.async_rows is sent in the background (the checks of the request run in imp_async_start, the rows in chunks)
    q := public.imp_async_start((b ->> 'id')::uuid, NULL, 'submit', NULL, NULL, NULL, NULL, su_until);
    IF coalesce((q ->> 'queued')::boolean, false) THEN
      queued := queued + 1;
      batches := batches || jsonb_build_array(b || jsonb_build_object('queued', true, 'job_id', q -> 'job' -> 'job_id', 'rows', q -> 'job' -> 'rows_total',
        'submitted', 0, 'saved', 0, 'held', 0, 'failed', 0,
        'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error')));
      CONTINUE;
    END IF;
    sent := public.imp_submit_batch((b ->> 'id')::uuid, NULL, p_stepup);
    batches := batches || jsonb_build_array(b || jsonb_build_object('submitted', sent -> 'submitted', 'saved', sent -> 'saved', 'held', jsonb_array_length(coalesce(sent -> 'held', '[]'::jsonb)),
      'failed', jsonb_array_length(coalesce(sent -> 'failed', '[]'::jsonb)),
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error')));
  END LOOP;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued);
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL), btrim(p_reason));
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;


-- The progress of the background sends of an applied run: the runs of the batches of its group (NULL when none was sent in the background).
CREATE OR REPLACE FUNCTION mi_run_progress_json(p_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN count(j.id) = 0 THEN NULL ELSE jsonb_build_object(
           'state', CASE WHEN bool_or(j.state = 'running') THEN 'running' WHEN bool_or(j.state = 'failed') THEN 'failed' ELSE 'done' END,
           'batches', count(j.id), 'batches_running', count(j.id) FILTER (WHERE j.state = 'running'),
           'rows_total', sum(j.rows_total), 'rows_done', sum(j.rows_done),
           'percent', CASE WHEN sum(j.rows_total) = 0 THEN 100 ELSE floor(100.0 * sum(j.rows_done) / sum(j.rows_total))::int END,
           'submitted', sum(j.n_submitted), 'saved', sum(j.n_saved), 'approved', sum(j.n_approved), 'held', sum(j.n_held), 'failed', sum(j.n_failed),
           'started_at', min(j.created_at), 'updated_at', max(j.heartbeat_at),
           'finished_at', CASE WHEN bool_or(j.state = 'running') THEN NULL ELSE max(j.finished_at) END) END
  FROM public.master_reconciliation_runs r
  JOIN public.import_batches b ON b.group_id = r.group_id
  JOIN public.import_batch_jobs j ON j.batch_id = b.id AND j.kind = 'submit'
  WHERE r.id = p_run AND r.group_id IS NOT NULL AND public.mi_can_use()
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The setting imports.async_rows in Settings, Imports (owner request of 2026-11-05)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION imports_async_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; v int;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'imports.async_rows';
  BEGIN v := (s.value #>> '{}')::int; EXCEPTION WHEN others THEN v := NULL; END;
  RETURN jsonb_build_object('async_rows', coalesce(v, 50), 'default_async_rows', 50, 'min', 10, 'max', 500,
    'updated_at', s.updated_at, 'updated_by', s.updated_by, 'version', public.settings_etag('imports.async_rows'),
    'can_edit', (public.app_actor_is_admin('settings', 'edit') AND public.app_actor_region_filter('settings', 'edit') IS NULL));
END $$;

CREATE OR REPLACE FUNCTION admin_set_imports_async_rows(p_rows integer, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_rows IS NULL OR p_rows < 10 OR p_rows > 500 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/async_rows', 'out_of_range', 'A whole number from 10 to 500.')));
  END IF;
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('imports.async_rows', '50'::jsonb, 'A batch with more rows than this to send or to decide is processed in the background (0074, 0075).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'imports.async_rows' FOR UPDATE;
  cur := public.imports_async_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF (cur ->> 'async_rows')::int = p_rows THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The threshold is already ' || p_rows || ' rows.'));
  END IF;
  UPDATE public.settings SET value = to_jsonb(p_rows), updated_by = public.app_actor(), updated_at = clock_timestamp() WHERE key = 'imports.async_rows';
  res := public.imports_async_json();
  PERFORM public.log_audit_write('imports_async_rows_update', 'setting', 'imports.async_rows',
    jsonb_build_object('async_rows', cur -> 'async_rows', 'updated_at', cur -> 'updated_at', 'updated_by', cur -> 'updated_by'),
    jsonb_build_object('async_rows', res -> 'async_rows', 'updated_at', res -> 'updated_at', 'updated_by', res -> 'updated_by'), btrim(p_reason));
  RETURN res;
END $$;

-- The key changes only through admin_set_imports_async_rows (the guard function of 0072; an UPDATE is guarded on the old and the new key, so it cannot be renamed away).
DROP TRIGGER IF EXISTS b_settings_async_rows ON settings;
DROP TRIGGER IF EXISTS b_settings_async_rows_update ON settings;
DROP TRIGGER IF EXISTS b_settings_async_rows_delete ON settings;
CREATE TRIGGER b_settings_async_rows BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'imports.async_rows') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_async_rows_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'imports.async_rows' OR NEW.key = 'imports.async_rows') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_async_rows_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'imports.async_rows') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, UPDATE ON import_batches, import_batch_rows TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON import_batch_jobs TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['imp_submit_register_rows', 'imp_submit_register_finish', 'imp_submit_register_batch',
             'imp_decide_register_rows', 'imp_decide_register_finish', 'imp_decide_checks', 'imp_decide_register_batch', 'imp_submit_stream_rows',
             'imp_stream_status_after_send', 'imp_submit_stream_finish', 'imp_submit_stream_batch', 'imp_decide_stream_rows', 'imp_decide_stream_finish',
             'imp_decide_stream_batch', 'imp_batch_kind', 'imp_async_chunk_size', 'imp_async_start_rs', 'imp_async_start', 'imp_async_chunk_tasks', 'imp_async_step',
             'imp_async_close', 'imp_batch_job_json', 'imports_async_json', 'admin_set_imports_async_rows', 'mi_run_progress_json'])
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      IF f.proname IN ('imp_async_start', 'imp_async_step', 'imp_async_chunk_tasks', 'imp_batch_job_json', 'imports_async_json', 'admin_set_imports_async_rows', 'mi_run_progress_json') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig);
      ELSE
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f.sig);
      END IF;
    END IF;
  END LOOP;
  -- the Master import apply keeps its signatures, owner and grants (0060 / 0073; CREATE OR REPLACE keeps them)
  ALTER FUNCTION mi_apply_run(uuid, integer, text, text, boolean, jsonb) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION mi_apply_run(uuid, integer, text, text, boolean, jsonb) FROM PUBLIC;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('register_stream_async_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'imports.async_rows', 'batches', jsonb_build_array('register', 'stream'), 'actions', jsonb_build_array('submit', 'approve', 'review', 'reject'),
          'chunk_rows', jsonb_build_object('site', 25, 'register', 50, 'stream', 25), 'setting_screen', 'admin_set_imports_async_rows'),
        'Technical decision of 2026-11-05 (6), CHANGELOG 108: register and stream batches in the background; the threshold in Settings, Imports (migration 0075).');
