-- 0087: the System Admin "approve all as is" of an upload (owner decision of 2026-11-12, decision 1).
--
-- An uploader stays what the Responsibility Matrix says (L1 Data Entry sends, L2 holders approve). A System Admin gets one more final approval on a
-- template batch of a task stream (TPL-SITE-* and the stream parts of a Master upload or apply): every open row of the batch is submitted (when it was
-- not yet) and approved in one call, whoever holds L2 of its cell. The action is `admin_approve` on imp_decide_batch / imp_async_start (POST /imports/:id/decisions).
--   - Who: a System Admin only (never a delegate), with a verified step-up and a reason of 3 to 2000 characters. Anyone else: 403 action_forbidden.
--   - What a row gets: the values of the file (when the row was not sent yet), then the state approved, a workflow step `admin_override` (reason, batch row),
--     task_instances.admin_override = true (so the KPIs count it as an override, as lock_bypassed and historical_no_documents already are: dash_build_tasks and
--     dash_core read t.admin_override) and, when something is missing (actual start or date, mandatory documents, a document rule still pending), task_instances.incomplete
--     = true with the codes in incomplete_reasons. The gaps stay visible: site_data_gaps lists them as `approved_incomplete`.
--   - Audit: one row per task (task_admin_approved_as_is, is_admin_override, batch and batch row stamped) and one for the batch (import_batch_admin_approve).
--   - Not covered (409 invalid_transition): New sites batches, register batches, draft-mode batches. A row in error, an unchanged row, an approved task, a task with open
--     snags and a date that is not valid are not approved: each is listed in `failed` with its reason.
--   - A big batch runs in the background like any other decision: imp_async_start / imp_async_step / imp_async_close keep their names and signatures and route the
--     job of this action to imp_admin_async_*; the others move to *_std (no grant for pmis_app).
-- The flags leave a task that leaves the approved state (reopened, returned): the normal rules apply again.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE task_instances
  ADD COLUMN admin_approved_as_is boolean NOT NULL DEFAULT false,
  ADD COLUMN incomplete boolean NOT NULL DEFAULT false,
  ADD COLUMN incomplete_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN admin_approved_at timestamptz,
  ADD COLUMN admin_approved_by uuid REFERENCES users (id),
  ADD COLUMN admin_approve_reason text,
  ADD COLUMN admin_approve_batch_id uuid REFERENCES import_batches (id);
ALTER TABLE task_instances ADD CONSTRAINT task_instances_admin_approved_check CHECK (
  (NOT admin_approved_as_is OR (admin_override AND admin_approved_at IS NOT NULL AND admin_approved_by IS NOT NULL AND char_length(btrim(admin_approve_reason)) >= 3))
  AND (NOT incomplete OR admin_approved_as_is)
  AND (incomplete OR cardinality(incomplete_reasons) = 0));
CREATE INDEX task_instances_admin_approved_idx ON task_instances (admin_approve_batch_id) WHERE admin_approved_as_is;
COMMENT ON COLUMN task_instances.admin_approved_as_is IS '0087: approved as it is by a System Admin (approve all of an upload); admin_override is true with it, so the KPIs count it as an override.';
COMMENT ON COLUMN task_instances.incomplete IS '0087: approved as is while something was missing (incomplete_reasons: missing_actual_start, missing_actual_date, missing_documents, document_rule_pending).';

ALTER TABLE import_batch_rows
  ADD COLUMN admin_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN incomplete boolean NOT NULL DEFAULT false,
  ADD COLUMN incomplete_reasons text[] NOT NULL DEFAULT ARRAY[]::text[];
COMMENT ON COLUMN import_batch_rows.admin_approved IS '0087: the row was approved as it is by a System Admin (admin_approve).';

ALTER TABLE import_batch_jobs DROP CONSTRAINT IF EXISTS import_batch_jobs_action_check;
ALTER TABLE import_batch_jobs ADD CONSTRAINT import_batch_jobs_action_check CHECK (action IS NULL OR action IN ('approve', 'review', 'reject', 'admin_approve'));
ALTER TABLE import_batch_jobs ADD COLUMN n_incomplete integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The bypass inside the approval transaction, and the guard of the flags
-- ---------------------------------------------------------------------------------------------------------------------
-- True only inside aap_approve_task (a transaction-local marker) for a System Admin. Used by the two checks that a normal approval cannot skip: a document rule that
-- is still pending (doc_task_pending_gate, 0056) and the hold of a converted task without an L2 holder (levels_hold_guard, 0054). Anyone can set a marker, so the
-- marker alone is never enough: the actor must be a System Admin (and aap_approve_task only runs after aap_require_admin).
CREATE OR REPLACE FUNCTION aap_bypass() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(current_setting('pmis.admin_approve', true), '') = 'on' AND public.app_actor() IS NOT NULL AND public.app_user_is_system_admin(public.app_actor())
$$;

CREATE OR REPLACE FUNCTION doc_task_pending_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE codes text[];
BEGIN
  IF public.aap_bypass() THEN RETURN NEW; END IF;   -- 0087: the admin approval takes the task as it is (flagged incomplete: document_rule_pending)
  SELECT coalesce(array_agg(DISTINCT dt.code ORDER BY dt.code), ARRAY[]::text[]) INTO codes
  FROM public.document_slots s JOIN public.document_types dt ON dt.id = s.doc_type_id
  WHERE s.task_id = NEW.id AND s.determination_pending AND NOT s.conditional_declared;
  IF cardinality(codes) > 0 THEN
    PERFORM public.wf_err('document_rule_pending', jsonb_build_object('missing', to_jsonb(codes),
      'detail', 'The rule of ' || array_to_string(codes, ', ') || ' cannot be decided yet (no approved Procurement order with a delivery): the task cannot be approved until it is.'));
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION levels_hold_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE kind text := TG_ARGV[0]; has_l2 boolean;
BEGIN
  IF public.aap_bypass() THEN RETURN NEW; END IF;   -- 0087: the hold stays; the admin approval does not release it
  IF NOT EXISTS (SELECT 1 FROM public.levels_conversions c WHERE c.entity_type = kind AND c.entity_id = NEW.id AND c.held AND c.hold_released_at IS NULL) THEN RETURN NEW; END IF;
  has_l2 := CASE WHEN kind = 'task' THEN public.wf_has_holder(NEW.id, 'approve') ELSE public.reg_has_holder(NEW.id, 'approve') END;
  IF NOT has_l2 THEN
    PERFORM public.wf_err('empty_cell', jsonb_build_object('detail',
      'This item was converted to two levels (owner decision Q217) and nobody holds its L2 (Data Reviewer & Approver): it is held until the Responsibility Matrix names one.'));
  END IF;
  UPDATE public.levels_conversions SET hold_released_at = now() WHERE entity_type = kind AND entity_id = NEW.id;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES ('levels_hold_released', kind, NEW.id::text, NEW.site_id, NEW.region_id, jsonb_build_object('held', true), jsonb_build_object('held', false),
          'an L2 holder is now named in the Responsibility Matrix (Q217)', public.app_actor());
  RETURN NEW;
END $$;

-- The flags of a task: set only inside the admin approval; they leave a task that leaves the approved state; a gap filled later (an actual date typed by an admin
-- override) removes its reason, and the task stops being incomplete when no reason is left.
CREATE OR REPLACE FUNCTION aap_task_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE reasons text[];
BEGIN
  IF NEW.admin_approved_as_is AND NOT OLD.admin_approved_as_is AND NOT public.aap_bypass() THEN
    RAISE EXCEPTION 'admin approval: a task is approved as it is only by a System Admin through the approval of a batch (migration 0087)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.admin_approved_as_is AND NEW.state IS DISTINCT FROM 'approved' THEN
    NEW.admin_approved_as_is := false; NEW.incomplete := false; NEW.incomplete_reasons := ARRAY[]::text[]; NEW.admin_override := false;
    NEW.admin_approved_at := NULL; NEW.admin_approved_by := NULL; NEW.admin_approve_reason := NULL; NEW.admin_approve_batch_id := NULL;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('task_admin_approved_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
      jsonb_build_object('admin_approved_as_is', true, 'incomplete', OLD.incomplete, 'incomplete_reasons', to_jsonb(OLD.incomplete_reasons), 'state', OLD.state::text, 'batch_id', OLD.admin_approve_batch_id),
      jsonb_build_object('admin_approved_as_is', false, 'incomplete', false, 'state', NEW.state::text),
      'The task left the approved state (' || NEW.state::text || '): the normal rules apply again.', public.app_actor());
    RETURN NEW;
  END IF;
  IF OLD.admin_approved_as_is AND NEW.admin_approved_as_is AND NEW.incomplete THEN
    reasons := array_remove(array_remove(NEW.incomplete_reasons, CASE WHEN NEW.actual_date IS NOT NULL THEN 'missing_actual_date' END),
                            CASE WHEN NEW.actual_start IS NOT NULL THEN 'missing_actual_start' END);
    IF reasons IS DISTINCT FROM NEW.incomplete_reasons THEN
      NEW.incomplete_reasons := reasons;
      NEW.incomplete := cardinality(reasons) > 0;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_aap_task BEFORE UPDATE ON task_instances FOR EACH ROW WHEN (NEW.admin_approved_as_is OR OLD.admin_approved_as_is) EXECUTE FUNCTION aap_task_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The data gaps of a site: the approved-incomplete tasks join the list (latest definition 0085; the change is the CTE `a`)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_data_gaps(p_site uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH s AS (SELECT x.* FROM public.sites x WHERE x.id = p_site AND public.app_region_check(x.region_id)),
  t AS (
    SELECT jsonb_build_object('kind', 'missing_actual_date', 'task_code', td.code, 'successor_code', min(sd.code)) AS item, td.sort_order AS ord
    FROM s JOIN public.task_instances ti ON ti.site_id = s.id
    JOIN public.task_definitions td ON td.id = ti.task_def_id AND NOT td.is_milestone_task
    JOIN public.task_predecessors tp ON tp.predecessor_id = ti.task_def_id
    JOIN public.task_instances si ON si.site_id = s.id AND si.task_def_id = tp.task_def_id AND si.actual_date IS NOT NULL
    JOIN public.task_definitions sd ON sd.id = si.task_def_id
    WHERE ti.actual_date IS NULL AND NOT ti.is_na AND ti.state NOT IN ('approved', 'na', 'skipped')
    GROUP BY td.code, td.sort_order
  ), f AS (
    SELECT jsonb_build_object('kind', 'missing_field', 'field', 'delivery_scenario') AS item, -1 AS ord FROM s WHERE s.delivery_scenario IS NULL
  ), a AS (   -- 0087: approved as is by a System Admin while something was missing
    SELECT jsonb_build_object('kind', 'approved_incomplete', 'task_code', td.code, 'reasons', to_jsonb(ti.incomplete_reasons)) AS item, td.sort_order AS ord
    FROM s JOIN public.task_instances ti ON ti.site_id = s.id AND ti.incomplete AND ti.state = 'approved'
    JOIN public.task_definitions td ON td.id = ti.task_def_id
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM s) THEN jsonb_build_object('count', 0, 'items', '[]'::jsonb)
         ELSE jsonb_build_object('count', (SELECT count(*) FROM (SELECT item FROM t UNION ALL SELECT item FROM f UNION ALL SELECT item FROM a) q),
                                 'items', coalesce((SELECT jsonb_agg(item ORDER BY ord) FROM (SELECT item, ord FROM t UNION ALL SELECT item, ord FROM f UNION ALL SELECT item, ord FROM a) q), '[]'::jsonb)) END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The authority, the reason, and the approval of one task
-- ---------------------------------------------------------------------------------------------------------------------
-- A System Admin with a verified step-up (read from the signed context, never from a parameter). A delegate is not a System Admin: 403 action_forbidden.
CREATE OR REPLACE FUNCTION aap_require_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_user_is_system_admin(a) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin can approve a whole upload as it is. It cannot be delegated.'));
  END IF;
  IF NOT coalesce(public.app_ctx_stepup(), false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION aap_reason(p_note text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE rs text := btrim(coalesce(p_note, ''));
BEGIN
  IF char_length(rs) < 3 OR char_length(rs) > 2000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/note', 'code', 'required', 'message', 'A reason of 3 to 2000 characters is required.'))));
  END IF;
  RETURN rs;
END $$;

-- Approves one task as it is (internal; the caller checked the System Admin and the step-up). Applies the values of the row when the task did not receive them yet,
-- records the missing data, approves at the last level whatever the L2 holder, and audits. Raises wf:<code> for what it will not take (open snags, an invalid date,
-- a task that is already approved, N/A or suspended).
CREATE OR REPLACE FUNCTION aap_approve_task(p_task uuid, p_row uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; r public.import_batch_rows%ROWTYPE; flds jsonb; patch jsonb := '{}'::jsonb; before jsonb; n int; key text; d date;
  errs jsonb := '[]'::jsonb; reasons text[] := ARRAY[]::text[]; miss text[]; n_snags int; v_scope text; unlocked uuid[]; sid uuid;
  new_start date; new_date date; new_planned date; new_values jsonb; pending text[]; code text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO r FROM public.import_batch_rows WHERE id = p_row;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.'));
  END IF;
  IF t.is_na OR t.state::text NOT IN ('locked', 'open', 'entry', 'in_review', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is ' || t.state::text || ': it cannot be approved as it is.'));
  END IF;
  v_scope := public.wf_snag_scope_of(p_task);
  IF v_scope IS NOT NULL THEN
    n_snags := public.wf_open_snags_of(p_task);
    IF n_snags > 0 THEN PERFORM public.wf_err('open_snags', jsonb_build_object('count', n_snags, 'scope', v_scope)); END IF;
  END IF;

  -- the values of the file: only for a row that was never sent (a sent row already put them in the task)
  IF r.task_submitted_at IS NULL THEN
    flds := coalesce(r.payload -> 'fields', '{}'::jsonb);
    patch := public.imp_task_patch(flds, r.diff);
  END IF;
  FOREACH key IN ARRAY ARRAY['actual_start', 'actual_date', 'planned_date'] LOOP
    IF patch ? key AND jsonb_typeof(patch -> key) <> 'null' THEN
      d := (patch ->> key)::date;
      IF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || key, 'code', 'invalid_date', 'message', 'The date must be between 2020-01-01 and 2035-12-31.'));
      ELSIF key <> 'planned_date' AND d > public.cal_today() THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || key, 'code', 'future_date', 'message', 'An actual date cannot be in the future.'));
      END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  new_start   := CASE WHEN patch ? 'actual_start' THEN (patch ->> 'actual_start')::date ELSE t.actual_start END;
  new_date    := CASE WHEN patch ? 'actual_date' THEN (patch ->> 'actual_date')::date ELSE t.actual_date END;
  new_planned := CASE WHEN patch ? 'planned_date' THEN (patch ->> 'planned_date')::date ELSE t.planned_date END;
  new_values  := CASE WHEN patch ? 'values' AND jsonb_typeof(patch -> 'values') = 'object' THEN coalesce(t.values, '{}'::jsonb) || (patch -> 'values') ELSE t.values END;
  IF new_start IS NULL AND r.task_code IS NOT NULL AND t.state::text IN ('locked', 'open') THEN   -- a single-event task starts on its actual date (Q209)
    new_start := public.imp_start_date(r.task_code, coalesce(flds, '{}'::jsonb), t);
  END IF;

  -- what is missing, recorded before anything changes
  IF new_start IS NULL THEN reasons := reasons || 'missing_actual_start'; END IF;
  IF new_date IS NULL THEN reasons := reasons || 'missing_actual_date'; END IF;
  miss := public.wf_missing_slots(p_task);
  IF cardinality(miss) > 0 THEN reasons := reasons || 'missing_documents'; END IF;
  SELECT coalesce(array_agg(DISTINCT dt.code ORDER BY dt.code), ARRAY[]::text[]) INTO pending
    FROM public.document_slots s JOIN public.document_types dt ON dt.id = s.doc_type_id WHERE s.task_id = p_task AND s.determination_pending AND NOT s.conditional_declared;
  IF cardinality(pending) > 0 THEN reasons := reasons || 'document_rule_pending'; END IF;

  before := public.wf_snap(p_task);
  n := public.wf_task_levels(p_task);
  PERFORM set_config('pmis.admin_approve', 'on', true);
  UPDATE public.task_instances SET
    actual_start = new_start, actual_date = new_date, planned_date = new_planned, values = new_values,
    state = 'approved', current_level = n,
    levels_required = CASE WHEN path_frozen_at IS NULL THEN n ELSE levels_required END, path_frozen_at = coalesce(path_frozen_at, now()),
    submitted_date = coalesce(submitted_date, current_date), approved_date = current_date, ball_in_court_user_id = NULL, level_opened_at = NULL, self_approval = false,
    admin_override = true, admin_approved_as_is = true, incomplete = cardinality(reasons) > 0, incomplete_reasons = reasons,
    admin_approved_at = now(), admin_approved_by = actor, admin_approve_reason = p_reason, admin_approve_batch_id = r.batch_id,
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = p_task AND status IN ('uploaded', 'in_review');
  UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
    WHERE s.task_id = p_task AND f.slot_id = s.id AND f.is_current AND f.approved_date IS NULL;
  PERFORM set_config('pmis.admin_approve', '', true);

  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, self_approval, batch_row_id, before_state, after_state, created_at)
  VALUES (p_task, n, 'admin_override', actor, p_reason, true, p_reason, true, false, p_row, t.state, 'approved', clock_timestamp())
  RETURNING id INTO sid;
  INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, n, actor, 'acted')
    ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  unlocked := public.wf_unlock_successors(p_task);
  PERFORM public.log_audit_write('task_admin_approved_as_is', 'task', p_task::text, before,
    public.wf_snap(p_task) || jsonb_build_object('admin_approved_as_is', true, 'incomplete', cardinality(reasons) > 0, 'incomplete_reasons', to_jsonb(reasons),
      'missing_documents', to_jsonb(miss), 'batch_id', r.batch_id, 'batch_row_id', p_row, 'unlocked_task_ids', to_jsonb(unlocked)),
    p_reason, t.site_id, t.region_id, NULL, true);
  RETURN jsonb_build_object('step_id', sid, 'incomplete', cardinality(reasons) > 0, 'reasons', to_jsonb(reasons), 'from_state', t.state::text);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('pmis.admin_approve', '', true);
  RAISE;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The rows, the end, and the synchronous call of the batch
-- ---------------------------------------------------------------------------------------------------------------------
-- The batch must be a stream batch (a task template), not a draft, and open (validated, in approval, partly approved). The System Admin and the step-up are checked first
-- (so a non-admin gets 403 whatever the batch shows), then the reason, then the batch.
CREATE OR REPLACE FUNCTION imp_admin_approve_check(b public.import_batches, p_note text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF b.stream_code IS NULL OR b.entity = 'site' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Approve as is is for the batches of a task template (a task stream). New sites and register batches keep their own approval.'));
  END IF;
  IF b.mode = 'draft' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch was uploaded as a draft: send it first, or upload it again in the Submit for Review mode.'));
  END IF;
  IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || '.'));
  END IF;
  RETURN public.aap_reason(p_note);
END $$;

-- Approves the rows of a batch as they are: p_ids (a slice of a background run) or, when NULL, every open row. Returns {decided, approved, incomplete, failed[]}.
CREATE OR REPLACE FUNCTION imp_admin_approve_rows(p_batch uuid, p_ids uuid[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); r public.v_import_rows%ROWTYPE; res jsonb; decided int := 0; approved int := 0; incomplete int := 0; failed jsonb := '[]'::jsonb; j jsonb; msg text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  FOR r IN SELECT x.* FROM public.v_import_rows x
           WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update' AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
             AND x.eff_decision IN ('pending', 'pending_previous_approval', 'saved') AND (p_ids IS NULL OR x.id = ANY (p_ids))
           ORDER BY x.ord LOOP
    BEGIN
      PERFORM set_config('app.batch_row', r.id::text, true);
      res := public.aap_approve_task(r.task_instance_id, r.id, p_reason);
      PERFORM set_config('app.batch_row', '', true);
      UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), decision_note = p_reason, decided_role = 'approve', hold_reason = NULL,
        task_submitted_at = coalesce(task_submitted_at, now()), admin_approved = true, incomplete = (res ->> 'incomplete')::boolean,
        incomplete_reasons = coalesce((SELECT array_agg(e) FROM jsonb_array_elements_text(res -> 'reasons') e), ARRAY[]::text[]) WHERE id = r.id;
      decided := decided + 1; approved := approved + 1;
      IF (res ->> 'incomplete')::boolean THEN incomplete := incomplete + 1; END IF;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.batch_row', '', true);
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be approved as it is', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN public.imp_wf_message(j, j ->> 'code') ELSE 'The row could not be approved. See the System Log (template-check) for the technical reason.' END;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  RETURN jsonb_build_object('decided', decided, 'approved', approved, 'incomplete', incomplete, 'failed', failed);
END $$;

-- The end of the approval: the status of the batch, the audit row of the batch (an admin override), the notice to the uploader.
CREATE OR REPLACE FUNCTION imp_admin_approve_finish(p_batch uuid, p_note text, p_decided integer, p_approved integer, p_incomplete integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; new_st text;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  new_st := public.imp_status_of_after(p_batch);
  UPDATE public.import_batches SET status = new_st, version = version + 1, closed_at = CASE WHEN new_st IN ('approved', 'rejected') THEN now() ELSE closed_at END WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_admin_approve', 'import_batch', p_batch::text, jsonb_build_object('status', b.status),
    jsonb_build_object('scope', 'all', 'decided', p_decided, 'approved', p_approved, 'incomplete', p_incomplete, 'failed', p_failed, 'status', new_st, 'admin_override', true),
    p_note, NULL, NULL, NULL, true);
  IF b.uploaded_by <> actor AND p_decided > 0 THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (b.uploaded_by, 'in_app', 'import_batch', 'Your upload was approved by a System Admin',
            b.file_name || ': ' || p_approved || ' approved as they are, ' || p_incomplete || ' of them incomplete. ' || left(p_note, 200), '/templates/batches/' || p_batch::text);
  END IF;
  RETURN new_st;
END $$;

-- The synchronous call (a batch with no more rows than imports.async_rows, or when no background run was asked).
CREATE OR REPLACE FUNCTION imp_admin_approve_batch(p_batch uuid, p_version integer, p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; rs text; res jsonb;
BEGIN
  PERFORM public.aap_require_admin();
  b := public.imp_lock_batch(p_batch, p_version);
  rs := public.imp_admin_approve_check(b, p_note);
  res := public.imp_admin_approve_rows(p_batch, NULL, rs);
  PERFORM public.imp_admin_approve_finish(p_batch, rs, (res ->> 'decided')::int, (res ->> 'approved')::int, (res ->> 'incomplete')::int, jsonb_array_length(res -> 'failed'));
  RETURN jsonb_build_object('decided', (res ->> 'decided')::int, 'approved', (res ->> 'approved')::int, 'rejected', 0, 'incomplete', (res ->> 'incomplete')::int,
    'held', '[]'::jsonb, 'failed', res -> 'failed');
END $$;

-- The dispatcher (latest definition 0074; the change is the first branch).
CREATE OR REPLACE FUNCTION imp_decide_batch(p_batch uuid, p_version integer, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.imp_async_guard(p_batch);
  IF p_action = 'admin_approve' THEN   -- 0087
    RETURN public.imp_admin_approve_batch(p_batch, p_version, p_note);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.entity = 'site') THEN
    RETURN public.imp_decide_site_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL AND b.mode = 'draft') THEN
    RETURN public.imp_decide_draft_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL) THEN
    RETURN public.imp_decide_stream_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  RETURN public.imp_decide_register_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The background run: imp_async_start / step / close route the job of this action; the others are the functions of 0075 under the names *_std
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION imp_async_start(uuid, integer, text, text, text, jsonb, text, timestamptz) RENAME TO imp_async_start_std;
ALTER FUNCTION imp_async_step(uuid, integer) RENAME TO imp_async_step_std;
ALTER FUNCTION imp_async_close(uuid, text, text) RENAME TO imp_async_close_std;

-- Asked by the request: every check runs here (System Admin, step-up, reason, If-Match, batch). {queued: false} when the batch has no more rows than imports.async_rows.
CREATE OR REPLACE FUNCTION imp_admin_async_start(p_batch uuid, p_version integer, p_note text, p_stepup_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid; b public.import_batches%ROWTYPE; rs text; lim int; n int; items jsonb; jid uuid;
BEGIN
  actor := public.aap_require_admin();
  PERFORM public.imp_async_guard(p_batch);
  b := public.imp_lock_batch(p_batch, p_version);
  rs := public.imp_admin_approve_check(b, p_note);
  BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('row_id', x.id, 'decision', 'approved') ORDER BY x.ord), '[]'::jsonb), count(*) INTO items, n
  FROM public.v_import_rows x
  WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update' AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
    AND x.eff_decision IN ('pending', 'pending_previous_approval', 'saved');
  IF n <= lim THEN RETURN jsonb_build_object('queued', false); END IF;
  INSERT INTO public.import_batch_jobs (batch_id, kind, action, scope, items, note, actor_id, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, prev_status, rows_total)
  VALUES (p_batch, 'decide', 'admin_approve', 'all', items, left(rs, 2000), actor, true, p_stepup_until,
          CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
          public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END,
          left(public.app_ctx_get('request_id'), 64), b.status, n)
  RETURNING id INTO jid;
  UPDATE public.import_batches SET version = version + 1 WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_processing', 'import_batch', p_batch::text, jsonb_build_object('status', b.status),
    jsonb_build_object('status', 'processing', 'job_id', jid, 'kind', 'decide', 'action', 'admin_approve', 'scope', 'all', 'rows', n, 'stepup', true), rs, NULL, NULL, NULL, true);
  RETURN jsonb_build_object('queued', true, 'job', public.imp_batch_job_json(p_batch));
END $$;

-- One chunk of the run (rows of the slice are approved as they are, in the chunk's transaction).
CREATE OR REPLACE FUNCTION imp_admin_async_step(p_job uuid, p_chunk integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); j public.import_batch_jobs%ROWTYPE; chunk int; res jsonb; slice jsonb; ids uuid[]; n_proc int; done boolean; f jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO j FROM public.import_batch_jobs WHERE id = p_job FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.import_batch_jobs WHERE id = p_job) THEN RETURN jsonb_build_object('job_id', p_job, 'state', 'busy'); END IF;
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The background run does not exist.'));
  END IF;
  IF j.actor_id <> actor THEN RAISE EXCEPTION 'only the person who asked for the run continues it' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF j.state <> 'running' THEN RETURN public.imp_batch_job_json(j.batch_id); END IF;
  IF NOT public.app_user_is_system_admin(actor) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The person who asked for this run is no longer a System Admin.'));
  END IF;
  PERFORM 1 FROM public.import_batches WHERE id = j.batch_id FOR UPDATE;
  chunk := public.imp_async_chunk_size('stream', p_chunk);
  SELECT coalesce(jsonb_agg(e ORDER BY o), '[]'::jsonb) INTO slice FROM jsonb_array_elements(j.items) WITH ORDINALITY AS t(e, o) WHERE o > j.pos AND o <= j.pos + chunk;
  n_proc := jsonb_array_length(slice);
  done := j.pos + n_proc >= jsonb_array_length(j.items);
  IF n_proc = 0 THEN
    res := jsonb_build_object('decided', 0, 'approved', 0, 'incomplete', 0, 'failed', '[]'::jsonb);
  ELSE
    SELECT array_agg((e ->> 'row_id')::uuid) INTO ids FROM jsonb_array_elements(slice) e;
    res := public.imp_admin_approve_rows(j.batch_id, ids, j.note);
  END IF;
  f := res -> 'failed';
  UPDATE public.import_batch_jobs SET pos = pos + n_proc, rows_done = least(rows_total, rows_done + n_proc), n_decided = n_decided + (res ->> 'decided')::int,
    n_approved = n_approved + (res ->> 'approved')::int, n_incomplete = n_incomplete + (res ->> 'incomplete')::int,
    n_failed = n_failed + jsonb_array_length(f), failed = CASE WHEN jsonb_array_length(failed) < 500 THEN failed || f ELSE failed END,
    chunks = chunks + 1, heartbeat_at = clock_timestamp() WHERE id = p_job;
  IF done THEN PERFORM public.imp_async_close(p_job, 'done', NULL); END IF;
  RETURN public.imp_batch_job_json(j.batch_id);
END $$;

-- The end of the run of this action (as imp_async_close_std for the others).
CREATE OR REPLACE FUNCTION imp_admin_async_close(p_job uuid, p_state text, p_error text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.import_batch_jobs%ROWTYPE; st text;
BEGIN
  SELECT * INTO j FROM public.import_batch_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.state <> 'running' THEN RETURN; END IF;
  UPDATE public.import_batch_jobs SET state = p_state, error = left(p_error, 500), finished_at = clock_timestamp(), heartbeat_at = clock_timestamp() WHERE id = p_job;
  IF public.app_actor() IS NOT NULL THEN
    st := public.imp_admin_approve_finish(j.batch_id, j.note, j.n_decided, j.n_approved, j.n_incomplete, j.n_failed);
  ELSE
    -- the person can no longer act: the rows done so far stay, the status follows them, the audit row names no actor
    st := public.imp_status_of_after(j.batch_id);
    UPDATE public.import_batches SET status = st, version = version + 1, closed_at = CASE WHEN st = 'approved' THEN coalesce(closed_at, now()) ELSE closed_at END,
      rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = j.batch_id AND action = 'error') WHERE id = j.batch_id;
  END IF;
  IF p_state <> 'done' THEN
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id, is_admin_override)
    VALUES ('import_batch_processing_stopped', 'import_batch', j.batch_id::text, jsonb_build_object('status', 'processing'),
            jsonb_build_object('status', st, 'job_id', j.id, 'kind', j.kind, 'action', 'admin_approve', 'rows_total', j.rows_total, 'rows_done', j.rows_done, 'failed', j.n_failed),
            left(p_error, 2000), public.app_actor(), true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION imp_async_start(p_batch uuid, p_version integer, p_kind text, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup_until timestamptz)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_kind = 'decide' AND p_action = 'admin_approve' THEN
    RETURN public.imp_admin_async_start(p_batch, p_version, p_note, p_stepup_until);
  END IF;
  RETURN public.imp_async_start_std(p_batch, p_version, p_kind, p_action, p_scope, p_rows, p_note, p_stepup_until);
END $$;

CREATE OR REPLACE FUNCTION imp_async_step(p_job uuid, p_chunk integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batch_jobs j WHERE j.id = p_job AND j.action = 'admin_approve') THEN
    RETURN public.imp_admin_async_step(p_job, p_chunk);
  END IF;
  RETURN public.imp_async_step_std(p_job, p_chunk);
END $$;

CREATE OR REPLACE FUNCTION imp_async_close(p_job uuid, p_state text, p_error text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batch_jobs j WHERE j.id = p_job AND j.action = 'admin_approve') THEN
    PERFORM public.imp_admin_async_close(p_job, p_state, p_error);
    RETURN;
  END IF;
  PERFORM public.imp_async_close_std(p_job, p_state, p_error);
END $$;

-- The progress (latest definition 0075), with the number of incomplete rows.
CREATE OR REPLACE FUNCTION imp_batch_job_json(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('job_id', j.id, 'kind', j.kind, 'action', j.action, 'batch_kind', public.imp_batch_kind(j.batch_id), 'state', j.state,
           'rows_total', j.rows_total, 'rows_done', j.rows_done,
           'percent', CASE WHEN j.rows_total = 0 THEN 100 ELSE floor(100.0 * j.rows_done / j.rows_total)::int END,
           'submitted', j.n_submitted, 'saved', j.n_saved, 'decided', j.n_decided, 'approved', j.n_approved, 'rejected', j.n_rejected, 'held', j.n_held, 'failed', j.n_failed,
           'incomplete', j.n_incomplete,
           'started_at', j.created_at, 'updated_at', j.heartbeat_at, 'finished_at', j.finished_at, 'error', j.error)
  FROM public.import_batch_jobs j
  WHERE j.batch_id = p_batch AND public.app_actor() IS NOT NULL AND public.imp_batch_visible(p_batch)
  ORDER BY j.created_at DESC LIMIT 1
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and execute rights. Every new function is owned by pmis_definer and closed to PUBLIC. The doors of pmis_app stay the ones of 0074 / 0075 (imp_decide_batch,
--    imp_async_start, imp_async_step, imp_batch_job_json, site_data_gaps); the *_std functions and every aap_* / imp_admin_* function are internal.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['aap_bypass', 'aap_task_guard', 'aap_require_admin', 'aap_reason', 'aap_approve_task', 'imp_admin_approve_check',
             'imp_admin_approve_rows', 'imp_admin_approve_finish', 'imp_admin_approve_batch', 'imp_admin_async_start', 'imp_admin_async_step', 'imp_admin_async_close',
             'imp_async_start', 'imp_async_step', 'imp_async_close', 'imp_async_start_std', 'imp_async_step_std', 'imp_async_close_std', 'imp_batch_job_json', 'imp_decide_batch',
             'site_data_gaps', 'doc_task_pending_gate', 'levels_hold_guard'])
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      IF f.proname IN ('imp_async_start', 'imp_async_step', 'imp_batch_job_json', 'imp_decide_batch', 'site_data_gaps') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig);
      ELSE
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f.sig);
      END IF;
    END IF;
  END LOOP;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('admin_approve_uploads_applied', 'workflow', NULL,
        jsonb_build_object('action', 'admin_approve', 'endpoint', 'POST /imports/{id}/decisions', 'who', 'System Admin with a step-up and a reason', 'flags', jsonb_build_array('admin_override', 'incomplete'),
          'batches', 'task streams only'),
        'Owner decision of 2026-11-12 (1), CHANGELOG 129: a System Admin approves every row of an upload as it is, whoever holds L2 (migration 0087).');
