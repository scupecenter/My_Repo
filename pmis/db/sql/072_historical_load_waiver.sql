-- 0073: the one-time historical-load document waiver (technical decision on owner question Q462).
--
-- WHY. The owner's Master carries the history of the project (tasks already done, with their dates) but no documents, and the submit of a task needs every mandatory
-- document slot filled (wf_complete / wf_missing_slots). Q351 forbids an "accept without workflow" for the load, and the plan of 2026-11-04 (blocker 5, gap G5) left the
-- choice to the owner. The technical lead, with the owner's delegation, decided a time-boxed, admin-only override for this one load (CLAUDE.md "Admin overrides are all
-- allowed ... accept without document or workflow ... reason, step-up MFA, audit with before/after values, 'Admin override' badge, reversible, excluded from or flagged in KPIs").
--
-- WHAT THIS ADDS.
--   1. The setting `load.historical_waiver` = { open, cutoff_date, ... }, closed by default. Only a System Admin (never a delegate) opens or closes it, with a reason and a
--      step-up; a cutoff date that is not in the future is required to open it; every change is audited; it closes itself after 30 days (hw_waiver_expire, run by a job; the
--      effective state also reads the expiry, so an expired waiver is closed even before the job runs). Direct writes to the setting are refused by a trigger.
--   2. A System Admin applying a P3 Master import (mi_apply_run, new parameter p_historical) or uploading a stream template (imp_stage_batch, new parameter p_hw) may mark the
--      batch "historical load: accept without documents" (reason and step-up, waiver open). For the rows of that batch the mandatory-document check is skipped ONLY when the
--      task's actual (completion) date is on or before the cutoff date. Every other check still runs. Rows after the cutoff, and every other batch, are unchanged.
--   3. Marking: a task approved this way is flagged `task_instances.historical_no_documents` (with the batch and the document codes that were missing); an audit row with
--      before and after values and the batch reference is written with the admin-override flag of log_audit_write (0066); the badge, the task grid and the KPIs read the flag.
--   4. Reversible: when the documents are uploaded later the flag clears by itself (a trigger on the slots), audited; a task that goes back to Data Entry (rejection, reopening)
--      loses the flag too, so the normal rule applies to its next submit. Documents can be uploaded to a flagged task after its approval (doc_slot_owner_for_write); nothing else changes.
--   5. Nothing else may skip the documents. Marking a batch, flagging a task and writing the setting are guarded by triggers that read the verified session context only
--      (app_actor(), app_ctx_stepup(), the System Admin test): pmis_app cannot set the flag, the batch mark or the setting, with any session setting it can forge.
--
-- Redefined from their latest definitions (0016, 0047, 0060, 0070, 0046, 0059; the bodies are unchanged except where marked "0073"): wf_complete (now a wrapper of
-- wf_complete_hw), imp_stage_task_row, imp_stage_stream_batch, imp_stage_batch, imp_stage_master_core, mi_apply_run, imp_submit_stream_batch, doc_slot_owner_for_write,
-- dash_build_tasks, dash_core. The old signatures stay as thin wrappers, so no caller changes.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC; pmis_app is granted only the API doors
-- (hw_waiver_state, hw_waiver_set, hw_waiver_expire, imp_stage_batch with the mark, mi_apply_run with the mark). pmis_app stays read-only on tables.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE import_batches
  ADD COLUMN historical_load boolean NOT NULL DEFAULT false,
  ADD COLUMN historical_cutoff date,
  ADD COLUMN historical_reason text,
  ADD COLUMN historical_marked_by uuid REFERENCES users (id),
  ADD COLUMN historical_marked_at timestamptz,
  ADD CONSTRAINT import_batches_historical_check CHECK (NOT historical_load OR (
    historical_cutoff IS NOT NULL AND historical_marked_by IS NOT NULL AND historical_marked_at IS NOT NULL
    AND char_length(btrim(coalesce(historical_reason, ''))) >= 3 AND stream_code IS NOT NULL));

ALTER TABLE task_instances
  ADD COLUMN historical_no_documents boolean NOT NULL DEFAULT false,
  ADD COLUMN historical_batch_id uuid REFERENCES import_batches (id),
  ADD COLUMN historical_flagged_at timestamptz,
  ADD COLUMN historical_missing text[],
  ADD COLUMN historical_cleared_at timestamptz,
  ADD CONSTRAINT task_instances_historical_check CHECK (NOT historical_no_documents OR (historical_batch_id IS NOT NULL AND historical_flagged_at IS NOT NULL));
CREATE INDEX task_instances_historical_idx ON task_instances (historical_batch_id) WHERE historical_no_documents;

COMMENT ON COLUMN task_instances.historical_no_documents IS '0073 (Q462): approved or submitted under the historical-load waiver without its mandatory documents (the badge "Admin override"); cleared when the documents are uploaded';
COMMENT ON COLUMN import_batches.historical_load IS '0073 (Q462): marked by a System Admin under the open waiver: rows whose actual date is on or before historical_cutoff skip the mandatory-document check';

-- The setting, closed. Its value is written only by hw_waiver_set / hw_waiver_expire (the trigger below refuses every other writer).
INSERT INTO settings (key, value, description, updated_at)
VALUES ('load.historical_waiver', '{"open": false, "cutoff_date": null}'::jsonb,
        'Q462: one-time historical-load document waiver. open, cutoff_date; opened_at / expires_at (30 days) / opened_by / reason while open. Written only by hw_waiver_set and hw_waiver_expire.', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The waiver setting: state, open, close, expiry
-- ---------------------------------------------------------------------------------------------------------------------
-- The raw value (internal).
CREATE OR REPLACE FUNCTION hw_waiver_cfg() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT s.value FROM public.settings s WHERE s.key = 'load.historical_waiver'), '{"open": false, "cutoff_date": null}'::jsonb)
$$;

-- Open now: the stored state is open, it has a cutoff and an expiry in the future. A stored "open" without an expiry (a hand-edited row) is closed.
CREATE OR REPLACE FUNCTION hw_waiver_open_now() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((c ->> 'open')::boolean, false) AND nullif(c ->> 'cutoff_date', '') IS NOT NULL
         AND nullif(c ->> 'expires_at', '') IS NOT NULL AND (c ->> 'expires_at')::timestamptz > now()
  FROM (SELECT public.hw_waiver_cfg() AS c) x
$$;

-- The cutoff date of the waiver that is open now, else NULL.
CREATE OR REPLACE FUNCTION hw_waiver_cutoff() RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN public.hw_waiver_open_now() THEN (c ->> 'cutoff_date')::date END FROM (SELECT public.hw_waiver_cfg() AS c) x
$$;

-- The state for the screens (granted): the effective state (an expired waiver is closed here even before the job writes it), who opened it and why (System Admin only), the
-- days left, and whether the caller is a System Admin (the only one who may open, close or use it).
CREATE OR REPLACE FUNCTION hw_waiver_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb := public.hw_waiver_cfg(); isopen boolean := public.hw_waiver_open_now(); adm boolean := coalesce(public.app_actor_is_system_admin(), false); exp timestamptz;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  exp := nullif(c ->> 'expires_at', '')::timestamptz;
  RETURN jsonb_build_object(
    'open', isopen,
    'cutoff_date', CASE WHEN isopen THEN c -> 'cutoff_date' ELSE 'null'::jsonb END,
    'opened_at', CASE WHEN isopen THEN c -> 'opened_at' ELSE 'null'::jsonb END,
    'expires_at', CASE WHEN isopen THEN to_jsonb(exp) ELSE 'null'::jsonb END,
    'days_left', CASE WHEN isopen THEN greatest(0, ceil(extract(epoch FROM (exp - now())) / 86400.0))::int END,
    'window_days', 30,
    'opened_by', CASE WHEN isopen AND adm THEN c -> 'opened_by' ELSE 'null'::jsonb END,
    'reason', CASE WHEN isopen AND adm THEN c -> 'reason' ELSE 'null'::jsonb END,
    'closed_at', c -> 'closed_at',
    'closed_how', c -> 'closed_how',
    'can_manage', adm);
END $$;

-- A System Admin with a fresh step-up, for opening, closing and marking. A delegate is not a System Admin: refused (403 action_forbidden).
CREATE OR REPLACE FUNCTION hw_require_admin_stepup() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT public.app_user_is_system_admin(a) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a System Admin can open, close or use the historical-load waiver. It cannot be delegated.'));
  END IF;
  IF NOT coalesce(public.app_ctx_stepup(), false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  RETURN a;
END $$;

-- Open or close the waiver (granted). Opening: a reason, a cutoff date that is not in the future, 30 days. Closing: a reason. Both audited with before and after.
CREATE OR REPLACE FUNCTION hw_waiver_set(p_open boolean, p_cutoff date, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid; before jsonb; cur jsonb; nv jsonb; rs text := btrim(coalesce(p_reason, '')); errs jsonb := '[]'::jsonb; is_open boolean;
BEGIN
  a := public.hw_require_admin_stepup();
  PERFORM public.hw_waiver_expire();
  cur := public.hw_waiver_cfg();
  is_open := public.hw_waiver_open_now();
  before := cur;
  IF p_open IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/open', 'code', 'required', 'message', 'open is true or false.')); END IF;
  IF char_length(rs) < 3 OR char_length(rs) > 1000 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of 3 to 1000 characters is required.'));
  END IF;
  IF p_open IS TRUE THEN
    IF p_cutoff IS NULL THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/cutoff_date', 'code', 'required', 'message', 'The cutoff date is required to open the waiver.'));
    ELSIF p_cutoff > public.cal_today() THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/cutoff_date', 'code', 'in_the_future', 'message', 'The cutoff date cannot be in the future.'));
    ELSIF p_cutoff < date '2000-01-01' THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/cutoff_date', 'code', 'invalid', 'message', 'The cutoff date is not valid.'));
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF p_open THEN
    IF is_open THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The waiver is already open (cutoff ' || (cur ->> 'cutoff_date') || '). Close it first to open it again with another cutoff date.'));
    END IF;
    nv := jsonb_build_object('open', true, 'cutoff_date', p_cutoff, 'opened_at', now(), 'expires_at', now() + interval '30 days', 'opened_by', a, 'reason', rs,
                             'closed_at', NULL, 'closed_how', NULL);
  ELSE
    IF NOT is_open THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The waiver is not open.')); END IF;
    nv := jsonb_build_object('open', false, 'cutoff_date', NULL, 'closed_at', now(), 'closed_how', 'manual', 'closed_by', a, 'close_reason', rs,
                             'last_cutoff_date', cur -> 'cutoff_date', 'last_opened_at', cur -> 'opened_at');
  END IF;
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('load.historical_waiver', nv, NULL, a, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  PERFORM public.log_audit_write(CASE WHEN p_open THEN 'historical_waiver.open' ELSE 'historical_waiver.close' END, 'setting', 'load.historical_waiver',
    before, nv, rs, NULL, NULL, NULL, true);
  RETURN public.hw_waiver_state();
END $$;

-- The waiver closes itself after 30 days (granted: the job calls it every few minutes; calling it early changes nothing). Audited, with no actor (the system).
CREATE OR REPLACE FUNCTION hw_waiver_expire() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb := public.hw_waiver_cfg(); nv jsonb;
BEGIN
  IF NOT (coalesce((cur ->> 'open')::boolean, false) AND NOT public.hw_waiver_open_now()) THEN RETURN false; END IF;
  nv := jsonb_build_object('open', false, 'cutoff_date', NULL, 'closed_at', now(), 'closed_how', 'expired', 'closed_by', NULL,
                           'last_cutoff_date', cur -> 'cutoff_date', 'last_opened_at', cur -> 'opened_at');
  UPDATE public.settings SET value = nv, updated_at = now() WHERE key = 'load.historical_waiver';
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, is_admin_override, actor_id)
  VALUES ('historical_waiver.expired', 'setting', 'load.historical_waiver', cur, nv, 'The waiver closed itself after 30 days.', true, NULL);
  RETURN true;
END $$;

-- The setting is written only by the two functions above (they run as pmis_definer). pmis_app, with any permission grid, and every other role are refused.
CREATE OR REPLACE FUNCTION hw_guard_settings() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND OLD.key = 'load.historical_waiver') OR (TG_OP <> 'DELETE' AND NEW.key = 'load.historical_waiver') THEN
    IF current_user::text <> 'pmis_definer' AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user::text) THEN
      RAISE EXCEPTION 'historical waiver: the setting load.historical_waiver is written only by hw_waiver_set' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'historical waiver: the setting load.historical_waiver is never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER hw_guard_settings BEFORE INSERT OR UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION hw_guard_settings();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Marking a batch, using the mark on a row, flagging and un-flagging a task
-- ---------------------------------------------------------------------------------------------------------------------
-- Before a batch is marked: a System Admin, a step-up, the waiver open, a reason. Returns the cutoff date.
CREATE OR REPLACE FUNCTION hw_mark_authorize(p_reason text) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid; cutoff date;
BEGIN
  a := public.hw_require_admin_stepup();
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 OR char_length(btrim(p_reason)) > 2000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load/reason', 'code', 'required',
      'message', 'A reason of 3 to 2000 characters is required to accept a batch without documents.'))));
  END IF;
  cutoff := public.hw_waiver_cutoff();
  IF cutoff IS NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The historical-load waiver is closed: a batch cannot be accepted without documents.'));
  END IF;
  RETURN cutoff;
END $$;

-- Marks a stream batch (internal; the guard trigger below checks the mark again at the write).
CREATE OR REPLACE FUNCTION hw_mark_batch(p_batch uuid, p_reason text, p_cutoff date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); rs text := btrim(p_reason);
BEGIN
  UPDATE public.import_batches SET historical_load = true, historical_cutoff = p_cutoff, historical_reason = rs, historical_marked_by = a, historical_marked_at = now()
    WHERE id = p_batch AND stream_code IS NOT NULL AND NOT historical_load;
  IF NOT FOUND THEN RAISE EXCEPTION 'historical waiver: only a stream batch is marked, once' USING ERRCODE = 'check_violation'; END IF;
  PERFORM public.log_audit_write('import_batch.historical_load', 'import_batch', p_batch::text, jsonb_build_object('historical_load', false),
    jsonb_build_object('historical_load', true, 'cutoff_date', p_cutoff, 'batch_id', p_batch,
      'rule', 'mandatory documents are skipped for rows whose actual date is on or before the cutoff date'), rs, NULL, NULL, NULL, true);
END $$;

-- The batch whose mark covers this row of this task now, else NULL (internal; read by wf_complete_hw). The mark must be the caller's own (the System Admin who marked the batch
-- sends it), made under the waiver that is open now, with the cutoff of that waiver, on a batch that is still being decided, and the task's actual date must be on or before it.
CREATE OR REPLACE FUNCTION hw_row_waiver(p_task uuid, p_row uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT b.id
  FROM public.import_batch_rows r
  JOIN public.import_batches b ON b.id = r.batch_id
  JOIN public.task_instances t ON t.id = p_task
  WHERE p_row IS NOT NULL AND r.id = p_row AND r.task_instance_id = p_task
    AND b.historical_load AND b.stream_code IS NOT NULL AND b.status IN ('validated', 'in_approval', 'partially_approved')
    AND public.hw_waiver_open_now() AND b.historical_cutoff = public.hw_waiver_cutoff()
    AND b.historical_marked_at >= nullif((public.hw_waiver_cfg() ->> 'opened_at'), '')::timestamptz
    AND b.historical_marked_by = public.app_actor() AND public.app_user_is_system_admin(b.historical_marked_by)
    AND t.actual_date IS NOT NULL AND t.actual_date <= b.historical_cutoff
$$;

-- The document codes still missing on a task: the two branches of wf_missing_slots (0056) without its slot building and without the region test (internal).
CREATE OR REPLACE FUNCTION hw_missing_codes(p_task uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT x.code ORDER BY x.code), ARRAY[]::text[]) FROM (
    SELECT dt.code FROM public.document_slots s
      JOIN public.document_types dt ON dt.id = s.doc_type_id
      LEFT JOIN public.document_type_versions v ON v.id = s.doc_type_version_id
    WHERE s.task_id = p_task AND s.status::text IN ('missing', 'rejected') AND coalesce(v.is_mandatory, dt.is_mandatory)
      AND NOT public.doc_twin_holds(s.id)
    UNION
    SELECT dt.code FROM public.task_instances t
      JOIN public.document_type_placements pl ON pl.task_def_id = t.task_def_id AND pl.kind = 'task'
      JOIN public.document_types dt ON dt.id = pl.doc_type_id AND dt.is_active AND dt.is_mandatory AND NOT dt.lib_managed
    WHERE t.id = p_task
      AND NOT EXISTS (SELECT 1 FROM public.document_slots s WHERE s.task_id = t.id AND s.doc_type_id = dt.id AND s.status IN ('uploaded', 'in_review', 'approved'))
      AND (dt.condition_rule IS NULL OR EXISTS (SELECT 1 FROM public.document_slots s WHERE s.task_id = t.id AND s.doc_type_id = dt.id))
  ) x
$$;

-- Flags the task (internal; called by wf_complete_hw after the submit went through on the strength of hw_row_waiver). Audited with the admin-override flag.
CREATE OR REPLACE FUNCTION hw_flag_task(p_task uuid, p_batch uuid, p_row uuid, p_missing text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; b public.import_batches%ROWTYPE;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  UPDATE public.task_instances SET historical_no_documents = true, historical_batch_id = p_batch, historical_flagged_at = now(), historical_missing = p_missing,
    historical_cleared_at = NULL WHERE id = p_task RETURNING * INTO t;
  PERFORM public.log_audit_write('task_historical_no_documents', 'task', p_task::text,
    jsonb_build_object('historical_no_documents', false, 'missing_documents', to_jsonb(p_missing), 'state', 'entry'),
    jsonb_build_object('historical_no_documents', true, 'missing_documents', to_jsonb(p_missing), 'state', t.state::text, 'actual_date', t.actual_date, 'batch_id', p_batch,
      'batch_row_id', p_row, 'cutoff_date', b.historical_cutoff),
    b.historical_reason, t.site_id, t.region_id, NULL, true);
END $$;

-- The flag clears when the last mandatory document of the task is uploaded (internal; the slot trigger calls it). Audited; nothing else changes.
CREATE OR REPLACE FUNCTION hw_recheck_task(p_task uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task AND historical_no_documents FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF cardinality(public.hw_missing_codes(p_task)) > 0 THEN RETURN false; END IF;
  UPDATE public.task_instances SET historical_no_documents = false, historical_cleared_at = now(), version = version + 1, updated_at = now() WHERE id = p_task;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES ('task_historical_no_documents_cleared', 'task', p_task::text, t.site_id, t.region_id,
    jsonb_build_object('historical_no_documents', true, 'missing_documents', to_jsonb(t.historical_missing), 'batch_id', t.historical_batch_id),
    jsonb_build_object('historical_no_documents', false, 'missing_documents', '[]'::jsonb, 'batch_id', t.historical_batch_id),
    'The missing documents were uploaded.', public.app_actor());
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION hw_slot_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.hw_recheck_task(NEW.task_id);
  RETURN NULL;
END $$;
CREATE TRIGGER hw_slot_filled AFTER INSERT OR UPDATE OF status ON document_slots FOR EACH ROW
  WHEN (NEW.task_id IS NOT NULL AND NEW.status::text IN ('uploaded', 'in_review', 'approved')) EXECUTE FUNCTION hw_slot_changed();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Guards: the mark on a batch, the flag on a task
-- ---------------------------------------------------------------------------------------------------------------------
-- A batch is marked only by a System Admin who is the signed-in actor, with a step-up, under the open waiver and its cutoff date, and a mark never changes afterwards.
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
    IF NEW.stream_code IS NULL OR NEW.historical_marked_by IS DISTINCT FROM public.app_actor() OR NOT public.app_user_is_system_admin(NEW.historical_marked_by)
       OR NOT coalesce(public.app_ctx_stepup(), false) OR NOT public.hw_waiver_open_now() OR NEW.historical_cutoff IS DISTINCT FROM public.hw_waiver_cutoff() THEN
      RAISE EXCEPTION 'historical waiver: a batch is marked only by a System Admin with a step-up under the open waiver' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.historical_cutoff IS NOT NULL OR NEW.historical_reason IS NOT NULL OR NEW.historical_marked_by IS NOT NULL OR NEW.historical_marked_at IS NOT NULL THEN
    RAISE EXCEPTION 'historical waiver: no mark data without the mark' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hw_guard_batch BEFORE INSERT OR UPDATE ON import_batches FOR EACH ROW EXECUTE FUNCTION hw_guard_batch();

-- The flag is set only on a task of a marked batch, by the System Admin who marked it, under the open waiver, for an actual date on or before the cutoff, and the task must
-- have a row in that batch. It clears (without conditions) when set to false; a task that leaves the submitted path (rejected, reopened) loses it.
CREATE OR REPLACE FUNCTION hw_guard_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.historical_no_documents THEN
    IF NOT NEW.historical_no_documents THEN
      NEW.historical_cleared_at := coalesce(NEW.historical_cleared_at, now());
      RETURN NEW;
    END IF;
    IF NEW.state::text NOT IN ('in_review', 'in_approval', 'approved') THEN
      NEW.historical_no_documents := false;
      NEW.historical_cleared_at := now();
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_historical_no_documents_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
        jsonb_build_object('historical_no_documents', true, 'state', OLD.state::text, 'missing_documents', to_jsonb(OLD.historical_missing), 'batch_id', OLD.historical_batch_id),
        jsonb_build_object('historical_no_documents', false, 'state', NEW.state::text, 'batch_id', OLD.historical_batch_id),
        'The task left the submitted path (' || NEW.state::text || '): the normal document rule applies again.', public.app_actor());
      RETURN NEW;
    END IF;
    IF NEW.historical_batch_id IS DISTINCT FROM OLD.historical_batch_id OR NEW.historical_flagged_at IS DISTINCT FROM OLD.historical_flagged_at THEN
      RAISE EXCEPTION 'historical waiver: the batch of a flagged task never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.historical_no_documents THEN
    SELECT * INTO b FROM public.import_batches x WHERE x.id = NEW.historical_batch_id;
    IF NOT FOUND OR NOT b.historical_load OR b.stream_code IS NULL OR b.historical_marked_by IS DISTINCT FROM public.app_actor()
       OR NOT public.app_user_is_system_admin(b.historical_marked_by) OR NOT public.hw_waiver_open_now() OR b.historical_cutoff IS DISTINCT FROM public.hw_waiver_cutoff()
       OR NEW.actual_date IS NULL OR NEW.actual_date > b.historical_cutoff
       OR NOT EXISTS (SELECT 1 FROM public.import_batch_rows r WHERE r.batch_id = b.id AND r.task_instance_id = NEW.id) THEN
      RAISE EXCEPTION 'historical waiver: a task is flagged only through a batch marked by a System Admin under the open waiver, for an actual date on or before the cutoff' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hw_guard_task_ins BEFORE INSERT ON task_instances FOR EACH ROW WHEN (NEW.historical_no_documents) EXECUTE FUNCTION hw_guard_task();
CREATE TRIGGER hw_guard_task_upd BEFORE UPDATE ON task_instances FOR EACH ROW WHEN (NEW.historical_no_documents OR OLD.historical_no_documents) EXECUTE FUNCTION hw_guard_task();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. wf_complete: submit, review and approve (latest definition 0016). The body moves to wf_complete_hw, which takes the import row of a batch row; wf_complete is the
--    same function without it. The mandatory-document check of the submit is the only change (marked 0073): when the row's batch is marked and hw_row_waiver says the
--    waiver covers this task, the missing documents are not an error; the task is flagged once the submit went through.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wf_complete_hw(p_task uuid, p_version integer, p_action text, p_note text, p_stepup boolean, p_batch_row uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; n int; lvl int; k text; mode text;
  ch record; before jsonb; step_ids uuid[] := ARRAY[]::uuid[]; sk int; self boolean; unlocked uuid[] := ARRAY[]::uuid[];
  missing_f text[] := ARRAY[]::text[]; missing_s text[]; after_state public."TaskState"; v_left int; n_snags int; v_scope text; sid uuid; first boolean;
  hw_batch uuid;   -- 0073: the batch whose mark covers this submit
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF (p_action = 'submit' AND t.state <> 'entry') OR (p_action = 'review' AND t.state <> 'in_review') OR (p_action = 'approve' AND t.state <> 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is ' || t.state::text || ': ' || p_action || ' is not possible now.'));
  END IF;
  before := public.wf_snap(p_task);
  first := t.path_frozen_at IS NULL;
  n := public.wf_task_levels(p_task);
  lvl := t.current_level;
  k := public.wf_kind(n, lvl);
  IF p_action = 'review' AND k <> 'review' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is at the approve level.')); END IF;
  IF p_action = 'approve' AND k <> 'approve' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The task is not at the approve level.')); END IF;
  PERFORM public.wf_require_grant(t.region_id, CASE k WHEN 'entry' THEN 'edit' WHEN 'approve' THEN 'approve' ELSE 'view' END::public."PermissionAction");
  mode := public.wf_require_actor(p_task, k, actor);

  -- E6 / Q25: the four acceptances are blocked by the open snags of their own stream, whatever the action (submit, review, approve).
  v_scope := public.wf_snag_scope_of(p_task);
  IF v_scope IS NOT NULL THEN
    n_snags := public.wf_open_snags_of(p_task);
    IF n_snags > 0 THEN PERFORM public.wf_err('open_snags', jsonb_build_object('count', n_snags, 'scope', v_scope)); END IF;
  END IF;

  IF p_action = 'submit' THEN
    IF t.actual_date IS NULL THEN missing_f := ARRAY['actual_date']; END IF;
    IF cardinality(missing_f) > 0 THEN PERFORM public.wf_err('mandatory_fields_missing', jsonb_build_object('missing', to_jsonb(missing_f))); END IF;
    missing_s := public.wf_missing_slots(p_task);
    IF cardinality(missing_s) > 0 THEN
      hw_batch := public.hw_row_waiver(p_task, p_batch_row);   -- 0073 (Q462): NULL unless the batch is marked, the waiver is open and the actual date is on or before the cutoff
      IF hw_batch IS NULL THEN PERFORM public.wf_err('mandatory_slots_missing', jsonb_build_object('missing', to_jsonb(missing_s))); END IF;
    END IF;
    IF first THEN
      UPDATE public.task_instances SET levels_required = n, path_frozen_at = now() WHERE id = p_task;   -- B7
    END IF;
  END IF;

  -- all_members: record the vote; the level completes with the last vote
  IF mode = 'vote' THEN
    UPDATE public.task_level_voters SET voted_at = now() WHERE task_id = p_task AND level = lvl AND round = t.level_round AND user_id = actor;
    SELECT count(*) INTO v_left FROM public.task_level_voters WHERE task_id = p_task AND level = lvl AND round = t.level_round AND voted_at IS NULL;
    IF v_left > 0 THEN
      sid := public.wf_step(p_task, lvl, p_action, actor, p_note, t.state, t.state, false, false);
      UPDATE public.task_instances SET version = version + 1, updated_at = now() WHERE id = p_task;
      PERFORM public.wf_audit('task_' || p_action || '_vote', p_task, before, public.wf_snap(p_task), p_note);
      RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb, 'votes_missing', v_left);
    END IF;
  END IF;

  SELECT * INTO ch FROM public.wf_chain(p_task, lvl, actor);
  IF ch.is_final THEN
    IF k <> 'approve' THEN PERFORM public.wf_require_grant(t.region_id, 'approve'); END IF;
    IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;   -- B5 and the final approval
  END IF;

  self := ch.is_final AND (n = 1 OR n = ANY (ch.skipped));
  after_state := CASE WHEN ch.is_final THEN 'approved'
                      ELSE CASE public.wf_kind(n, ch.next_level) WHEN 'review' THEN 'in_review' WHEN 'approve' THEN 'in_approval' ELSE 'entry' END END;

  sid := public.wf_step(p_task, lvl, p_action, actor, p_note, t.state, after_state, coalesce(p_stepup, false) AND ch.is_final, self);
  step_ids := step_ids || sid;
  INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, lvl, actor, 'acted')
    ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  FOREACH sk IN ARRAY ch.skipped LOOP
    sid := public.wf_step(p_task, sk, 'auto_skip', actor, 'level skipped: same holder', t.state, after_state, false, self);
    step_ids := step_ids || sid;
    INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, sk, actor, 'skipped')
      ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'skipped', acted_at = now();
  END LOOP;

  IF p_action = 'submit' THEN
    UPDATE public.task_instances SET submitted_date = current_date WHERE id = p_task;
    UPDATE public.document_slots SET status = 'in_review', reject_reason = NULL WHERE task_id = p_task AND status = 'uploaded';
  END IF;

  IF ch.is_final THEN
    UPDATE public.task_instances SET state = 'approved', current_level = n, approved_date = current_date, ball_in_court_user_id = NULL,
      level_opened_at = NULL, self_approval = self WHERE id = p_task;
    UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = p_task AND status IN ('uploaded', 'in_review');
    UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
      WHERE s.task_id = p_task AND f.slot_id = s.id AND f.is_current AND f.approved_date IS NULL;
    unlocked := public.wf_unlock_successors(p_task);
  ELSE
    PERFORM public.wf_open_level(p_task, ch.next_level, NULL);
  END IF;
  UPDATE public.task_instances SET version = version + 1, updated_at = now() WHERE id = p_task;
  IF hw_batch IS NOT NULL THEN PERFORM public.hw_flag_task(p_task, hw_batch, p_batch_row, missing_s); END IF;   -- 0073

  PERFORM public.wf_audit('task_' || p_action, p_task, before,
    public.wf_snap(p_task) || jsonb_build_object('skipped_levels', to_jsonb(ch.skipped), 'self_approval_flag', self), p_note);
  FOREACH sk IN ARRAY ch.skipped LOOP
    PERFORM public.wf_audit('task_auto_skip', p_task, jsonb_build_object('level', sk, 'holder', actor),
      jsonb_build_object('level', sk, 'skipped', true, 'reason', 'same holder', 'self_approval', self), 'level skipped: same holder');
  END LOOP;

  RETURN jsonb_build_object('step_ids', to_jsonb(step_ids), 'skipped_levels', to_jsonb(ch.skipped), 'unlocked_task_ids', to_jsonb(unlocked));
END $function$;

CREATE OR REPLACE FUNCTION wf_complete(p_task uuid, p_version int, p_action text, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT public.wf_complete_hw(p_task, p_version, p_action, p_note, p_stepup, NULL::uuid) $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Staging: the preview of a row (0060, new parameter p_hw_cutoff), a stream batch (0060, p_hw), a template file (0070, p_hw), the Master staging (0060, p_hw)
--    The old signatures stay as wrappers with no mark.
-- ---------------------------------------------------------------------------------------------------------------------
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
    diff := '{}'::jsonb; action := 'update'; decision := 'pending'; hold := NULL;
    SELECT x.* INTO ti FROM public.task_instances x JOIN public.task_definitions td ON td.id = x.task_def_id
      WHERE x.site_id = s.id AND td.code = tc AND td.workflow_id = s.workflow_version_id;
    have := FOUND;
    tname := CASE WHEN have THEN (SELECT d2.name_en FROM public.task_definitions d2 WHERE d2.id = ti.task_def_id) END;
    IF NOT have THEN
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

      IF jsonb_array_length(e) = 0 THEN
        IF diff = '{}'::jsonb THEN
          action := 'unchanged';
        ELSIF ti.is_na OR ti.state IN ('na', 'skipped', 'suspended', 'rejected') THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_open', 'The task is ' || ti.state::text || ': it takes no entry.'));
        ELSIF ti.state = 'approved' THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_approved', 'The task is approved. An approved task is changed only by an admin reopening it.'));
        ELSIF NOT public.imp_region_ok(p_imp, ti.region_id) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'region_forbidden', 'You may not import in this region.'));
        ELSIF NOT public.imp_region_ok(p_edit, ti.region_id) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'action_forbidden', 'You may not edit tasks in this region.'));
        ELSIF NOT (public.wf_is_eligible(ti.id, 'entry', actor) OR (public.app_user_is_system_admin(actor) AND NOT public.wf_has_holder(ti.id, 'entry'))) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'not_entry_holder', 'You are not an entry holder (L1) of this task in the Matrix.'));
        ELSIF ti.state IN ('in_review', 'in_approval') THEN
          decision := 'pending_previous_approval'; hold := 'open_submission';
          w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_open_submission', 'The task is in ' || ti.state::text || ': the row waits until that submission is decided.'));
        ELSIF ti.state = 'locked' THEN
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
            IF eff_actual IS NULL THEN
              e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'actual_date_required',
                'The actual date is required: the task is submitted with its row, as on the task screen. Use Save Draft / Planning to save a plan only (Q206).'));
            END IF;
            missing := public.wf_missing_slots(ti.id);
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
          IF jsonb_array_length(e) = 0 AND ti.state = 'open' AND (NOT draft OR p ? 'actual_start' OR p ? 'actual_date')
             AND public.imp_start_date(tc, p, ti) IS NULL THEN
            e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_start', 'actual_start_required',
              'The task is pending: type its Actual Start. The PMIS never uses today as the start of an earlier piece of work (Q209).'));
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
    IF jsonb_array_length(e) > 0 THEN action := 'error'; diff := '{}'::jsonb; decision := 'pending'; hold := NULL; END IF;
    items := items || jsonb_build_array(jsonb_build_object('task_code', tc, 'task_id', ti.id, 'name', tname, 'action', action, 'decision', decision, 'hold_reason', hold,
      'errors', e, 'warnings', w, 'diff', diff, 'payload', jsonb_build_object('fields', p), 'key', s.site_code || ' / ' || tc,
      'sig', CASE WHEN ti.id IS NOT NULL THEN 't:' || ti.id::text END));
  END LOOP;
  RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'region_id', s.region_id, 'row_errors', rowerrs, 'items', items);
END $function$;

CREATE OR REPLACE FUNCTION imp_stage_task_row(p_cols jsonb, p_row jsonb, p_task_site uuid, p_view int[], p_imp int[], p_edit int[], p_mode text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT public.imp_stage_task_row(p_cols, p_row, p_task_site, p_view, p_imp, p_edit, p_mode, NULL::date) $$;
CREATE OR REPLACE FUNCTION public.imp_stage_stream_batch(p_template text, p_version integer, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb, p_group uuid, p_source text, p_sheet text, p_mode text, p_hw jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; r_import int[]; r_view int[]; r_edit int[]; task_site uuid;
  el jsonb; res jsonb; it jsonb; items jsonb; seen jsonb := '{}'::jsonb; results jsonb := '[]'::jsonb; bid uuid;
  hw_cutoff date;   -- 0073: the cutoff of the open waiver when the batch is marked
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_hw IS NOT NULL THEN
    IF p_mode <> 'submit' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'The historical load is for Submit for Review: a draft has no document check.'))));
    END IF;
    hw_cutoff := public.hw_mark_authorize(p_hw ->> 'reason');   -- 0073 (Q462): a System Admin, a step-up, the waiver open, a reason
  END IF;
  IF p_mode NOT IN ('submit', 'draft') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'mode is submit or draft.'))));
  END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active AND kind = 'stream';
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file was made from version ' || p_version || ' of ' || p_template || '; the current version is ' || v.version || '. Download the template again.'));
  END IF;
  IF p_checksum IS NOT NULL AND v.header_checksum <> p_checksum THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
  END IF;
  r_import := public.wf_actor_regions('templates', 'import');
  r_view := public.wf_actor_regions('sites', 'view');
  r_edit := public.wf_actor_regions('sites', 'edit');
  IF (r_import IS NOT NULL AND cardinality(r_import) = 0) OR (r_view IS NOT NULL AND cardinality(r_view) = 0) OR (r_edit IS NOT NULL AND cardinality(r_edit) = 0) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'import_not_allowed', 'detail', 'You may not import tasks of the Site Register.'));
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT t.site_id INTO task_site FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id);
    IF task_site IS NULL THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.')); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
                   WHERE ti.id = p_task AND sd.stream_code = d.stream_code) THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'This task belongs to another stream: this template is for the stream ' || d.stream_code || '.'));
    END IF;
  END IF;

  FOR el IN SELECT x FROM jsonb_array_elements(p_rows) x LOOP
    res := public.imp_stage_task_row(v.columns, el, task_site, r_view, r_import, r_edit, p_mode, hw_cutoff);
    items := '[]'::jsonb;
    FOR it IN SELECT x FROM jsonb_array_elements(coalesce(res -> 'items', '[]'::jsonb)) x LOOP
      IF it ->> 'sig' IS NOT NULL THEN
        IF seen ? (it ->> 'sig') THEN
          it := it || jsonb_build_object('action', 'error', 'diff', '{}'::jsonb, 'decision', 'pending', 'hold_reason', NULL,
            'errors', coalesce(it -> 'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'duplicate_in_file',
              'message', 'Row ' || (seen ->> (it ->> 'sig')) || ' of this file is the same task of the same site.')));
        ELSE
          seen := seen || jsonb_build_object(it ->> 'sig', el ->> 'row_no');
        END IF;
      END IF;
      items := items || jsonb_build_array(it);
    END LOOP;
    res := res || jsonb_build_object('items', items);
    results := results || jsonb_build_array(jsonb_build_object('row_no', (el ->> 'row_no')::int, 'sheet', coalesce(el ->> 'sheet', p_sheet), 'res', res));
  END LOOP;
  bid := public.imp_insert_task_batch(v.id, p_template, d.stream_code, p_file_name, p_sha, p_group, p_sheet, results, p_task, task_site, p_source);
  IF bid IS NOT NULL THEN UPDATE public.import_batches SET mode = p_mode WHERE id = bid; END IF;
  IF bid IS NOT NULL AND hw_cutoff IS NOT NULL THEN PERFORM public.hw_mark_batch(bid, p_hw ->> 'reason', hw_cutoff); END IF;   -- 0073
  RETURN bid;
END $function$;

CREATE OR REPLACE FUNCTION imp_stage_stream_batch(p_template text, p_version int, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb,
  p_group uuid, p_source text, p_sheet text, p_mode text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.imp_stage_stream_batch(p_template, p_version, p_checksum, p_file_name, p_sha, p_task, p_rows, p_group, p_source, p_sheet, p_mode, NULL::jsonb)
$$;
CREATE OR REPLACE FUNCTION public.imp_stage_batch(p_template text, p_version integer, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb, p_mode text, p_hw jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE d public.template_definitions%ROWTYPE; cur public.template_versions%ROWTYPE; o public.template_versions%ROWTYPE; compat jsonb; ver int := p_version; cs text := p_checksum;
  file_v int; bid uuid;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF coalesce(p_mode, 'submit') NOT IN ('submit', 'draft') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'mode is submit or draft.'))));
  END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active;
  IF FOUND THEN
    SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
    IF p_version <> cur.version THEN
      compat := public.tpl_version_compat(p_template, p_version);
      IF compat IS NULL THEN
        PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file names version ' || p_version || ' of ' || p_template || ', which is not an issued version. Download the template again.'));
      END IF;
      IF NOT (compat ->> 'compatible')::boolean THEN PERFORM public.tpl_refuse_outdated(compat); END IF;
      SELECT * INTO o FROM public.template_versions WHERE template_def_id = d.id AND version = p_version;
      IF p_checksum IS NOT NULL AND o.header_checksum <> p_checksum THEN
        PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
      END IF;
      ver := cur.version; cs := CASE WHEN p_checksum IS NULL THEN NULL ELSE cur.header_checksum END; file_v := p_version;
    END IF;
    IF coalesce(p_mode, 'submit') = 'draft' AND d.kind <> 'stream' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid',
        'message', 'Save Draft / Planning is for the Site Register stream templates and the Master sheet; a register file and a New sites file are always submitted.'))));
    END IF;
  END IF;
  IF p_hw IS NOT NULL AND d.kind IS DISTINCT FROM 'stream' THEN   -- 0073 (Q462)
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load_reason', 'code', 'invalid',
      'message', 'Accepting without documents is for the Site Register stream templates only.'))));
  END IF;
  IF d.kind = 'stream' THEN
    bid := public.imp_stage_stream_batch(p_template, ver, cs, p_file_name, p_sha, p_task, p_rows, NULL, 'template', 'Data', coalesce(p_mode, 'submit'), p_hw);
  ELSIF d.kind = 'sites' THEN
    IF p_task IS NOT NULL THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'The New sites template is not used from a task.'));
    END IF;
    bid := public.imp_stage_site_batch(p_template, ver, cs, p_file_name, p_sha, p_rows);
  ELSE
    bid := public.imp_stage_register_batch(p_template, ver, cs, p_file_name, p_sha, p_task, p_rows);
  END IF;
  IF bid IS NOT NULL AND file_v IS NOT NULL THEN
    UPDATE public.import_batches SET file_template_version = file_v WHERE id = bid;
    PERFORM public.log_audit_write('template.old_version_accepted', 'import_batch', bid::text, NULL,
      jsonb_build_object('template_id', p_template, 'file_version', file_v, 'current_version', ver, 'other_changes', jsonb_array_length(compat -> 'other_changes')), NULL);
  END IF;
  RETURN bid;
END $function$;

CREATE OR REPLACE FUNCTION imp_stage_batch(p_template text, p_version int, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb, p_mode text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.imp_stage_batch(p_template, p_version, p_checksum, p_file_name, p_sha, p_task, p_rows, p_mode, NULL::jsonb)
$$;
CREATE OR REPLACE FUNCTION public.imp_stage_master_core(p_template text, p_version integer, p_file_name text, p_sha text, p_parts jsonb, p_mode text, p_source text, p_group uuid, p_hw jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; o public.template_versions%ROWTYPE; gid uuid := coalesce(p_group, gen_random_uuid());
  part jsonb; vp jsonb; op jsonb; st record; sd public.template_definitions%ROWTYPE; sv public.template_versions%ROWTYPE; srows jsonb; el jsonb; cells jsonb; pres jsonb; codes text[];
  bid uuid; batches jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb; j jsonb; rd public.template_definitions%ROWTYPE; rv public.template_versions%ROWTYPE;
  compat jsonb; parts jsonb := '[]'::jsonb; mcols jsonb; nrows jsonb; k text; val jsonb; res jsonb; site uuid; cand jsonb; hdr text; file_v int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_mode NOT IN ('submit', 'draft') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'mode is submit or draft.'))));
  END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active AND kind = 'master';
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    compat := public.tpl_version_compat(p_template, p_version);
    IF compat IS NULL THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file names version ' || p_version || ' of ' || p_template || ', which is not an issued version. Download the template again.'));
    END IF;
    IF NOT (compat ->> 'compatible')::boolean THEN PERFORM public.tpl_refuse_outdated(compat); END IF;
    SELECT * INTO o FROM public.template_versions WHERE template_def_id = d.id AND version = p_version;
    file_v := p_version;
  ELSE
    o := v;
  END IF;
  -- every sheet of the file keeps the header row as its version issued it; it is then read under the current version
  FOR part IN SELECT x FROM jsonb_array_elements(p_parts) x LOOP
    SELECT x INTO op FROM jsonb_array_elements(o.columns) x WHERE x ->> 'sheet' = part ->> 'sheet' LIMIT 1;
    IF op IS NULL OR op ->> 'header_checksum' <> part ->> 'header_checksum' THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch',
        'detail', 'The header row of the sheet "' || left(part ->> 'sheet', 40) || '" was changed. Use the template as it was issued.'));
    END IF;
    SELECT x INTO vp FROM jsonb_array_elements(v.columns) x WHERE x ->> 'sheet' = part ->> 'sheet' LIMIT 1;
    CONTINUE WHEN vp IS NULL;   -- a sheet the current version no longer has holds no typed column (the compatibility check said so)
    parts := parts || jsonb_build_array(part || jsonb_build_object('header_checksum', vp ->> 'header_checksum'));
  END LOOP;

  FOR part IN SELECT x FROM jsonb_array_elements(parts) x LOOP
    SELECT x INTO vp FROM jsonb_array_elements(v.columns) x WHERE x ->> 'sheet' = part ->> 'sheet' LIMIT 1;
    IF vp ->> 'kind' = 'master' THEN
      -- Q205: a shared Master column (mx:<letter>) becomes the column of the one task it fills on the row's site
      mcols := vp -> 'columns';
      nrows := '[]'::jsonb;
      FOR el IN SELECT x FROM jsonb_array_elements(coalesce(part -> 'rows', '[]'::jsonb)) x LOOP
        cells := coalesce(el -> 'cells', '{}'::jsonb); pres := coalesce(el -> 'pre_errors', '[]'::jsonb);
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(cells) kk WHERE kk LIKE 'mx:%') OR EXISTS (SELECT 1 FROM jsonb_array_elements(pres) x WHERE x ->> 'field' LIKE 'mx:%') THEN
          SELECT x.id INTO site FROM public.sites x WHERE upper(x.site_code) = upper(btrim(coalesce(el ->> 'site_code', ''))) AND public.app_region_check(x.region_id);
          FOR k, val IN SELECT * FROM jsonb_each(cells) LOOP
            CONTINUE WHEN k NOT LIKE 'mx:%';
            cells := cells - k;
            SELECT x INTO cand FROM jsonb_array_elements(mcols) x WHERE x ->> 'code' = k LIMIT 1;
            CONTINUE WHEN cand IS NULL OR coalesce((cand ->> 'derived')::boolean, false);
            hdr := cand ->> 'header';
            res := CASE WHEN site IS NULL THEN jsonb_build_object('status', 'none', 'candidates', '[]'::jsonb) ELSE public.tpl_master_candidates(site, substr(k, 4)) END;
            IF res ->> 'status' IN ('single', 'direct') AND jsonb_array_length(res -> 'candidates') = 1 THEN
              cells := cells || jsonb_build_object((res -> 'candidates' -> 0 ->> 'task') || ':' || (res -> 'candidates' -> 0 ->> 'field'), val);
            ELSIF res ->> 'status' = 'projection' THEN
              CONTINUE;   -- several tasks fill it: the Master value is their projection, shown, never read
            ELSIF res ->> 'status' = 'ambiguous' THEN
              pres := pres || jsonb_build_array(jsonb_build_object('column', hdr, 'field', (res -> 'candidates' -> 0 ->> 'task') || ':' || (res -> 'candidates' -> 0 ->> 'field'),
                'code', 'ambiguous_mapping', 'message', 'This Master column fills more than one task of the site (' ||
                  (SELECT string_agg(x ->> 'task', ', ') FROM jsonb_array_elements(res -> 'candidates') x) ||
                  ') and has no documented projection: the row is refused (Q205). Use the stream template, which has a column per task.'));
            ELSE
              -- no task of the column applies on the site: the first one answers why (not on the site, N/A)
              cells := cells || jsonb_build_object((cand -> 'candidates' -> 0 ->> 'task') || ':' || (cand -> 'candidates' -> 0 ->> 'field'), val);
            END IF;
          END LOOP;
          SELECT coalesce(jsonb_agg(CASE WHEN x ->> 'field' LIKE 'mx:%'
                   THEN x || jsonb_build_object('field', coalesce((SELECT (c -> 'candidates' -> 0 ->> 'task') || ':' || (c -> 'candidates' -> 0 ->> 'field') FROM jsonb_array_elements(mcols) c WHERE c ->> 'code' = x ->> 'field' LIMIT 1), x ->> 'field'))
                   ELSE x END), '[]'::jsonb) INTO pres FROM jsonb_array_elements(pres) x;
        END IF;
        nrows := nrows || jsonb_build_array(el || jsonb_build_object('cells', cells, 'pre_errors', pres));
      END LOOP;

      FOR st IN SELECT s.code, s.sort_order FROM public.workflow_streams s WHERE s.workflow_id = public.tpl_active_workflow() ORDER BY s.sort_order LOOP
        SELECT * INTO sd FROM public.template_definitions x WHERE x.kind = 'stream' AND x.stream_code = st.code AND x.is_active;
        CONTINUE WHEN NOT FOUND;
        SELECT * INTO sv FROM public.template_versions x WHERE x.template_def_id = sd.id AND x.is_current;
        SELECT array_agg(c ->> 'code') INTO codes FROM jsonb_array_elements(sv.columns) c WHERE c ->> 'kind' = 'task';
        srows := '[]'::jsonb;
        FOR el IN SELECT x FROM jsonb_array_elements(nrows) x LOOP
          SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO cells FROM jsonb_each(coalesce(el -> 'cells', '{}'::jsonb)) e WHERE e.key = ANY (codes);
          SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO pres FROM jsonb_array_elements(coalesce(el -> 'pre_errors', '[]'::jsonb)) x WHERE x ->> 'field' = ANY (codes);
          CONTINUE WHEN cells = '{}'::jsonb AND pres = '[]'::jsonb;
          srows := srows || jsonb_build_array(jsonb_build_object('row_no', el -> 'row_no', 'sheet', 'Master', 'site_code', el ->> 'site_code', 'cells', cells, 'pre_errors', pres));
        END LOOP;
        CONTINUE WHEN jsonb_array_length(srows) = 0;
        BEGIN
          bid := public.imp_stage_stream_batch(sd.template_id, sv.version, NULL, p_file_name, p_sha, NULL, srows, gid, p_source, 'Master', p_mode, p_hw);
          IF bid IS NOT NULL THEN
            UPDATE public.import_batches SET file_template_version = file_v WHERE id = bid AND file_v IS NOT NULL;
            batches := batches || jsonb_build_array(jsonb_build_object('id', bid, 'sheet', 'Master', 'kind', 'stream', 'ref', st.code, 'template_id', sd.template_id));
          END IF;
        EXCEPTION WHEN others THEN
          j := public.imp_wf_json(SQLERRM);
          IF j IS NULL OR j ->> 'code' <> 'template_rejected' THEN RAISE; END IF;
          skipped := skipped || jsonb_build_array(jsonb_build_object('sheet', 'Master', 'kind', 'stream', 'ref', st.code, 'reason', j -> 'extra' ->> 'reason', 'detail', j -> 'extra' ->> 'detail'));
        END;
      END LOOP;
    ELSE
      SELECT * INTO rd FROM public.template_definitions x WHERE x.kind = 'register' AND x.register_key = vp ->> 'ref' AND x.is_active;
      IF NOT FOUND THEN
        skipped := skipped || jsonb_build_array(jsonb_build_object('sheet', part ->> 'sheet', 'kind', 'register', 'ref', vp ->> 'ref', 'reason', 'template_unknown_or_inactive',
          'detail', 'The register of this sheet is not available.'));
        CONTINUE;
      END IF;
      IF p_mode = 'draft' THEN
        skipped := skipped || jsonb_build_array(jsonb_build_object('sheet', part ->> 'sheet', 'kind', 'register', 'ref', rd.register_key, 'reason', 'draft_not_for_registers',
          'detail', 'Save Draft / Planning is for the Master sheet only: a register sheet is always submitted. Upload it again with Submit for Review.'));
        CONTINUE;
      END IF;
      SELECT * INTO rv FROM public.template_versions x WHERE x.template_def_id = rd.id AND x.is_current;
      BEGIN
        bid := public.imp_stage_register_batch(rd.template_id, rv.version, rv.header_checksum, p_file_name, p_sha, NULL, part -> 'rows');
        UPDATE public.import_batches SET source = p_source, group_id = gid, part_sheet = part ->> 'sheet', file_template_version = file_v WHERE id = bid;
        UPDATE public.import_batch_rows SET source_ref = (part ->> 'sheet') || '!' || row_no::text, ord = row_no WHERE batch_id = bid;
        batches := batches || jsonb_build_array(jsonb_build_object('id', bid, 'sheet', part ->> 'sheet', 'kind', 'register', 'ref', rd.register_key, 'template_id', rd.template_id));
      EXCEPTION WHEN others THEN
        j := public.imp_wf_json(SQLERRM);
        IF j IS NULL OR j ->> 'code' <> 'template_rejected' THEN RAISE; END IF;
        skipped := skipped || jsonb_build_array(jsonb_build_object('sheet', part ->> 'sheet', 'kind', 'register', 'ref', rd.register_key, 'reason', j -> 'extra' ->> 'reason', 'detail', j -> 'extra' ->> 'detail'));
      END;
    END IF;
  END LOOP;

  IF jsonb_array_length(batches) = 0 AND jsonb_array_length(skipped) > 0 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', coalesce(skipped -> 0 ->> 'reason', 'import_not_allowed'),
      'detail', coalesce(skipped -> 0 ->> 'detail', 'You may not import any part of this file.')));
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES (CASE WHEN p_source = 'master_import' THEN 'import_master_legacy_stage' ELSE 'import_master_upload' END, 'import_group', gid::text,
          jsonb_build_object('template_id', p_template, 'template_version', v.version, 'file_version', file_v, 'mode', p_mode, 'source', p_source, 'file_name', left(p_file_name, 200),
            'file_sha256', p_sha, 'batches', batches, 'skipped', skipped), actor);
  RETURN jsonb_build_object('group_id', gid, 'batches', batches, 'skipped', skipped, 'file_version', file_v);
END $function$;

CREATE OR REPLACE FUNCTION imp_stage_master_core(p_template text, p_version int, p_file_name text, p_sha text, p_parts jsonb, p_mode text, p_source text, p_group uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.imp_stage_master_core(p_template, p_version, p_file_name, p_sha, p_parts, p_mode, p_source, p_group, NULL::jsonb)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The P3 apply with the mark (0060, new parameter p_historical = {"reason": ...}); the old signature stays as a wrapper
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); r public.master_reconciliation_runs%ROWTYPE; prev uuid; tv public.template_versions%ROWTYPE; mpart jsonb; mcols jsonb; v_rows jsonb := '[]'::jsonb;
  row_ record; cells jsonb; pres jsonb; c jsonb; cv jsonb; res jsonb; b jsonb; sent jsonb; v_outcome jsonb; batches jsonb := '[]'::jsonb; gid uuid := gen_random_uuid();
  hw jsonb;   -- 0073: the mark of the batches
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
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'No typed task column of this file belongs to a site of the PMIS: nothing can be entered.'));
  END IF;
  res := public.imp_stage_master_core('TPL-MASTER', tv.version, r.file_name, r.file_sha256,
    jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid, hw);
  FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x LOOP
    sent := public.imp_submit_batch((b ->> 'id')::uuid, NULL, p_stepup);
    batches := batches || jsonb_build_array(b || jsonb_build_object('submitted', sent -> 'submitted', 'saved', sent -> 'saved', 'held', jsonb_array_length(coalesce(sent -> 'held', '[]'::jsonb)),
      'failed', jsonb_array_length(coalesce(sent -> 'failed', '[]'::jsonb)),
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error')));
  END LOOP;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped');
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL), btrim(p_reason));
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches)), actor, NULL);
  RETURN v_outcome;
END $function$;

CREATE OR REPLACE FUNCTION mi_apply_run(p_run uuid, p_version int, p_mode text, p_reason text, p_stepup boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT public.mi_apply_run(p_run, p_version, p_mode, p_reason, p_stepup, NULL::jsonb) $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Sending a stream batch (0060): a marked batch submits its rows through wf_complete_hw with the row, so the waiver can apply to each row
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.imp_submit_stream_batch(p_batch uuid, p_version integer, p_stepup boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; t public.task_instances%ROWTYPE; submitted int := 0; saved int := 0;
  held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; patch jsonb; st text; new_st text; msg text; pend text; start_d date; draft boolean; flds jsonb; n_open int;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF b.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
  END IF;
  IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
  END IF;
  draft := (b.mode = 'draft');
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update'
             AND x.decision IN ('pending', 'pending_previous_approval') AND x.task_submitted_at IS NULL ORDER BY x.ord LOOP
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
          RAISE EXCEPTION 'wf:actual_start_required:{"detail": "The task is pending: type its Actual Start. The PMIS never uses today as the start of an earlier piece of work (Q209)."}';
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
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
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
  IF draft THEN
    SELECT count(*) INTO n_open FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action = 'update' AND x.decision IN ('pending', 'pending_previous_approval');
    new_st := CASE WHEN n_open > 0 THEN 'validated'
                   WHEN EXISTS (SELECT 1 FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.decision = 'saved') THEN 'applied' ELSE b.status END;
  ELSE
    new_st := CASE WHEN submitted > 0 OR b.status <> 'validated' THEN public.imp_status_of_after(p_batch) ELSE b.status END;
  END IF;
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    closed_at = CASE WHEN new_st = 'applied' THEN now() ELSE closed_at END,
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES ('import_batch_submit', 'import_batch', p_batch::text, jsonb_build_object('mode', b.mode, 'submitted', submitted, 'saved', saved, 'held', jsonb_array_length(held),
    'failed', jsonb_array_length(failed), 'status', new_st), actor);
  RETURN jsonb_build_object('submitted', submitted, 'saved', saved, 'held', held, 'failed', failed);
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Documents: a flagged task takes the missing documents after its submit or approval (0047). Only an upload, and only to a slot that is not yet in review or approved.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.doc_slot_owner_for_write(p_slot document_slots, p_actor uuid, p_verb text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t public.task_instances%ROWTYPE; r public.register_records%ROWTYPE;
BEGIN
  IF p_slot.task_id IS NOT NULL THEN
    t := public.wf_lock_task(p_slot.task_id, NULL);
    IF t.state NOT IN ('open', 'entry')
       AND NOT (p_verb = 'uploaded' AND t.historical_no_documents AND t.state::text IN ('in_review', 'in_approval', 'approved') AND p_slot.status::text IN ('missing', 'rejected', 'uploaded')) THEN   -- 0073 (Q462)
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Documents can be ' || p_verb || ' only while the task is pending or ongoing (it is ' || t.state::text || ').'));
    END IF;
    PERFORM public.wf_require_grant(t.region_id, 'edit');
    PERFORM public.wf_require_actor(t.id, 'entry', p_actor);
    RETURN jsonb_build_object('kind', 'task', 'id', t.id);
  END IF;
  IF p_slot.register_entity_id IS NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This slot belongs to no task and no register record.'));
  END IF;
  SELECT * INTO r FROM public.register_records WHERE entity_id = p_slot.register_entity_id AND state IN ('entry', 'in_review', 'in_approval') ORDER BY version_no DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Documents can be ' || p_verb || ' only while a version of the record is in Data Entry (start a new version of an approved record).'));
  END IF;
  r := public.reg_lock(r.id, NULL);
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'edit');
  PERFORM public.reg_require_actor(r.id, 'entry', p_actor);
  RETURN jsonb_build_object('kind', 'register_record', 'id', r.id);
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. KPIs (dashboard, 0046 and 0059). A task flagged by the waiver is treated like an admin override in the SLA and on-time figures: left out when exclude_overrides is
--     on (the default), counted otherwise, and always flagged in the meta (override_flagged_count includes it; historical_flagged_count counts only these). _dtask.admin_override
--     carries both, so the health index (documentation completeness D, first-time approval F) leaves them out as it leaves out the overrides. Project Status progress
--     (dash_build_items) is NOT changed: the work was done.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dash_build_tasks(p_ref date, p_stream text, p_excl boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE eff date;
BEGIN
  SELECT max(d) INTO eff FROM _dcal WHERE d <= p_ref AND is_wd;
  DROP TABLE IF EXISTS _dtask;
  CREATE TEMP TABLE _dtask ON COMMIT DROP AS
    WITH base AS (
      SELECT t.id, t.site_id, s.region_id, td.code AS task_code, sd.code AS stage_code, sd.stream_code,
             t.state::text AS state, (t.admin_override OR t.historical_no_documents) AS admin_override, t.sla_target_date, t.due_date, t.sla_elapsed_wd, t.sla_end_date,
             r.max_working_days AS sla_max, t.return_count, coalesce(t.actual_date, t.approved_date) AS done_date,
             t.external_party_id, td.default_external_party::text AS default_party,
             CASE WHEN t.sla_start_date IS NULL OR t.sla_start_date > p_ref OR t.state IN ('locked', 'na', 'skipped') OR t.is_na
                       OR (p_excl AND (t.admin_override OR t.historical_no_documents)) THEN 'none'
                  WHEN t.state = 'approved' AND coalesce(t.sla_end_date, t.actual_date, t.approved_date, p_ref) <= p_ref THEN 'closed'
                  WHEN t.due_date IS NULL THEN 'none'
                  ELSE 'open' END AS phase
      FROM _dsite s
      JOIN public.task_instances t ON t.site_id = s.id
      JOIN public.task_definitions td ON td.id = t.task_def_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      LEFT JOIN public.sla_rules r ON r.id = t.sla_rule_id
      WHERE NOT s.cancelled AND t.state NOT IN ('locked', 'na', 'skipped') AND (p_stream IS NULL OR sd.stream_code = p_stream)
    )
    SELECT b.id, b.site_id, b.region_id, b.task_code, b.stage_code, b.stream_code, b.state, b.admin_override, b.due_date, b.return_count, b.done_date,
      b.external_party_id, b.default_party, b.phase,
      CASE WHEN b.phase = 'closed' THEN CASE WHEN b.sla_elapsed_wd IS NULL OR b.sla_max IS NULL THEN NULL WHEN b.sla_elapsed_wd <= b.sla_max THEN 'on_time' ELSE 'late' END
           WHEN b.phase = 'open' THEN CASE WHEN eff <= coalesce(b.sla_target_date, b.due_date) THEN 'on_time' WHEN eff <= b.due_date THEN 'at_risk' ELSE 'late' END END AS cls,
      CASE WHEN b.phase = 'closed' AND b.sla_elapsed_wd IS NOT NULL AND b.sla_max IS NOT NULL THEN greatest(0, b.sla_elapsed_wd - b.sla_max)
           WHEN b.phase = 'open' AND eff > b.due_date THEN greatest(0, (SELECT wd FROM _dcal WHERE d = p_ref) - cd.wd) ELSE 0 END AS days_over
    FROM base b LEFT JOIN _dcal cd ON cd.d = b.due_date;
  CREATE INDEX ON _dtask (phase, cls);
END $function$;
CREATE OR REPLACE FUNCTION public.dash_core(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_ws uuid, p_sections text[], p_snap date, p_group text, p_issue_scope integer[], p_issues boolean, p_view text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  out_ jsonb := '{}'::jsonb; ws uuid; wide boolean; all_regions boolean; need_tasks boolean; hl jsonb; ps_card jsonb; snap_ws uuid; flagged int; hist int; wf_versions int[];
  rows_none jsonb; rows_region jsonb; ms jsonb; live boolean := (p_ref = public.cal_today()); blk_ok boolean; appr text[]; gt jsonb;
BEGIN
  PERFORM public.dash_build_cal();
  IF p_snap IS NOT NULL THEN PERFORM public.dash_build_facts_snap(p_snap, p_scope, p_region, p_cluster, p_scenario);
  ELSE PERFORM public.dash_build_facts(p_ref, p_scope, p_region, p_cluster, p_scenario); END IF;
  blk_ok := CASE WHEN p_snap IS NULL THEN live
                 ELSE EXISTS (SELECT 1 FROM public.site_snapshots ss WHERE ss.snapshot_date = p_snap AND public.dash_local_date(ss.created_at) = p_snap) END;
  IF p_snap IS NULL AND (p_stream IS NOT NULL OR p_sections && ARRAY['streams']) THEN PERFORM public.dash_build_streams(p_ref); END IF;
  IF p_stream IS NOT NULL THEN
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM _dstr x WHERE x.site_id = s.id AND x.stream = p_stream AND x.status <> 'na');
  END IF;
  IF p_view IS NOT NULL THEN
    PERFORM public.dash_build_view(p_view);
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM public.task_instances t JOIN _dview v ON v.id = t.task_def_id
                                           WHERE t.site_id = s.id AND t.state NOT IN ('na', 'skipped') AND NOT t.is_na);
  END IF;
  all_regions := p_scope IS NULL OR NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id <> ALL (p_scope));
  wide := all_regions AND p_region IS NULL AND p_cluster IS NULL AND p_scenario IS NULL AND p_stream IS NULL AND p_view IS NULL;
  need_tasks := p_sections && ARRAY['sla', 'delay', 'health', 'regions'];
  IF p_sections && ARRAY['headline', 'health', 'regions', 'ps'] THEN
    IF p_snap IS NOT NULL THEN
      SELECT weight_set_id INTO snap_ws FROM public.site_snapshots WHERE snapshot_date = p_snap AND weight_set_id IS NOT NULL LIMIT 1;
      ws := coalesce(p_ws, snap_ws, public.weight_set_in_force('project_status', p_ref));
      IF p_ws IS NULL AND snap_ws IS NOT NULL THEN PERFORM public.dash_build_items_snap(p_snap, ws); ELSE PERFORM public.dash_build_items(p_ref, ws, p_excl); END IF;
    ELSE
      ws := coalesce(p_ws, public.weight_set_in_force('project_status', p_ref));
      PERFORM public.dash_build_items(p_ref, ws, p_excl);
    END IF;
    rows_none := public.dash_ps_rows('none', wide);
    rows_region := public.dash_ps_rows('region', wide);
    ps_card := public.dash_ps_card(wide, rows_none);
  END IF;
  IF need_tasks THEN
    PERFORM public.dash_build_tasks(p_ref, p_stream, p_excl);
    IF p_view IS NOT NULL THEN
      DELETE FROM _dtask x WHERE NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN _dview v ON v.id = ti.task_def_id WHERE ti.id = x.id);
    END IF;
  END IF;

  SELECT array_agg(DISTINCT wd.version ORDER BY wd.version) INTO wf_versions FROM _dsite s JOIN public.workflow_definitions wd ON wd.id = s.wf;
  SELECT count(*) INTO flagged FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.admin_override OR t.historical_no_documents;
  SELECT count(*) INTO hist FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.historical_no_documents;   -- 0073 (Q462)
  out_ := jsonb_build_object('meta', jsonb_build_object('project_wide', wide, 'workflow_versions', coalesce(to_jsonb(wf_versions), '[]'::jsonb), 'override_flagged_count', flagged, 'historical_flagged_count', hist,
    'overrides_excluded', p_excl, 'weight_set_id', ws, 'blocked_gates_available', blk_ok));

  IF p_sections && ARRAY['headline'] THEN
    out_ := out_ || jsonb_build_object('headline', public.dash_sec_status(p_ref) || jsonb_build_object('final_closure', public.dash_sec_closure(p_ref), 'project_status', ps_card));
  END IF;
  IF p_sections && ARRAY['pipeline', 'headline'] THEN
    ms := public.dash_sec_milestones(p_ref, CASE WHEN p_stream IN (SELECT DISTINCT stream_code FROM _dms WHERE stream_code IS NOT NULL) THEN p_stream END);
    IF p_view IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(x.e ORDER BY x.n), '[]'::jsonb) INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n) WHERE x.e ->> 'code' IN (SELECT code FROM _dviewms);
    END IF;
    -- Q186: a blocked count that cannot be known for the date is null ("historically unavailable"), not 0
    SELECT coalesce(jsonb_agg(CASE WHEN blk_ok THEN x.e || jsonb_build_object('blocked_available', true)
                                   ELSE x.e || jsonb_build_object('blocked', NULL, 'blocked_available', false) END ORDER BY x.n), '[]'::jsonb)
    INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n);
    out_ := out_ || jsonb_build_object('milestones', ms);
  END IF;
  IF p_sections && ARRAY['streams'] THEN out_ := out_ || jsonb_build_object('streams', public.dash_sec_streams()); END IF;
  IF p_sections && ARRAY['sla'] THEN out_ := out_ || jsonb_build_object('sla', public.dash_sec_sla(p_ref)); END IF;
  IF p_sections && ARRAY['gates'] THEN
    IF live THEN gt := public.dash_sec_gates(p_ref) || jsonb_build_object('status', 'live');
    ELSIF blk_ok THEN
      gt := jsonb_build_object('available', false, 'status', 'snapshot', 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb,
        'blocked_total', (SELECT count(*) FROM _dms m JOIN _dsite s ON s.id = m.site_id AND NOT s.cancelled WHERE m.blocked));
    ELSE
      gt := jsonb_build_object('available', false, 'status', 'historically_unavailable', 'blocked_total', NULL, 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb);
    END IF;
    out_ := out_ || jsonb_build_object('gates', gt);
  END IF;
  IF p_sections && ARRAY['issues'] THEN
    out_ := out_ || jsonb_build_object('issues', CASE WHEN p_issues THEN public.dash_sec_issues(p_ref, p_issue_scope) ELSE NULL END);
  END IF;
  IF p_sections && ARRAY['health', 'regions'] THEN
    hl := public.dash_sec_health(p_ref, wide, p_issue_scope, p_issues, rows_none, rows_region);
    -- D16: the draft label sits on each factor the owner has not approved; the index itself carries none (Q121)
    SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO appr FROM jsonb_array_elements_text(public.calc_setting('dashboard.health_approved_factors', '["D", "I"]'::jsonb)) x;
    hl := hl || jsonb_build_object('draft', false,
      'components', coalesce((SELECT jsonb_agg(c.e || jsonb_build_object('draft', NOT ((c.e ->> 'code') = ANY (appr))) ORDER BY c.n)
                              FROM jsonb_array_elements(hl -> 'components') WITH ORDINALITY c(e, n)), '[]'::jsonb),
      'draft_factors', coalesce((SELECT jsonb_agg(c.e ->> 'code' ORDER BY c.n) FROM jsonb_array_elements(hl -> 'components') WITH ORDINALITY c(e, n)
                                 WHERE NOT ((c.e ->> 'code') = ANY (appr))), '[]'::jsonb),
      'approved_factors', to_jsonb(appr));
  END IF;
  IF p_sections && ARRAY['health'] THEN out_ := out_ || jsonb_build_object('health', hl); END IF;
  IF p_sections && ARRAY['delay'] THEN out_ := out_ || jsonb_build_object('delay', public.dash_sec_delay(p_ref)); END IF;
  IF p_sections && ARRAY['regions'] THEN out_ := out_ || jsonb_build_object('regions', public.dash_sec_regions(hl, true, rows_region)); END IF;
  IF p_sections && ARRAY['ps'] THEN
    out_ := out_ || jsonb_build_object('ps', jsonb_build_object('card', ps_card, 'rows', CASE WHEN p_group = 'region' THEN rows_region WHEN p_group = 'site' THEN public.dash_ps_rows('site', wide) ELSE '[]'::jsonb END,
      'sites_in_scope', (SELECT count(*) FROM _dsite WHERE NOT cancelled)));
  END IF;
  RETURN out_;
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Ownership and execute rights. Every function above is owned by pmis_definer and closed to PUBLIC. pmis_app gets only the API doors: the state of the waiver,
--     opening and closing it, the expiry job, the staging of a template file with the mark and the P3 apply with the mark. The marking, the flagging, the row check and the
--     document check are internal: no grant. pmis_app stays read-only on tables.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'hw_waiver_cfg()', 'hw_waiver_open_now()', 'hw_waiver_cutoff()', 'hw_waiver_state()', 'hw_require_admin_stepup()', 'hw_waiver_set(boolean,date,text)',
    'hw_waiver_expire()', 'hw_guard_settings()', 'hw_mark_authorize(text)', 'hw_mark_batch(uuid,text,date)', 'hw_row_waiver(uuid,uuid)', 'hw_missing_codes(uuid)',
    'hw_flag_task(uuid,uuid,uuid,text[])', 'hw_recheck_task(uuid)', 'hw_slot_changed()', 'hw_guard_batch()', 'hw_guard_task()',
    'wf_complete_hw(uuid,integer,text,text,boolean,uuid)', 'wf_complete(uuid,integer,text,text,boolean)',
    'imp_stage_task_row(jsonb,jsonb,uuid,integer[],integer[],integer[],text,date)', 'imp_stage_task_row(jsonb,jsonb,uuid,integer[],integer[],integer[],text)',
    'imp_stage_stream_batch(text,integer,text,text,text,uuid,jsonb,uuid,text,text,text,jsonb)', 'imp_stage_stream_batch(text,integer,text,text,text,uuid,jsonb,uuid,text,text,text)',
    'imp_stage_batch(text,integer,text,text,text,uuid,jsonb,text,jsonb)', 'imp_stage_batch(text,integer,text,text,text,uuid,jsonb,text)',
    'imp_stage_master_core(text,integer,text,text,jsonb,text,text,uuid,jsonb)', 'imp_stage_master_core(text,integer,text,text,jsonb,text,text,uuid)',
    'mi_apply_run(uuid,integer,text,text,boolean,jsonb)', 'mi_apply_run(uuid,integer,text,text,boolean)',
    'imp_submit_stream_batch(uuid,integer,boolean)', 'doc_slot_owner_for_write(document_slots,uuid,text)',
    'dash_build_tasks(date,text,boolean)', 'dash_core(date,integer[],integer,text,text,text,boolean,uuid,text[],date,text,integer[],boolean,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'hw_waiver_state()', 'hw_waiver_set(boolean,date,text)', 'hw_waiver_expire()',
      'imp_stage_batch(text,integer,text,text,text,uuid,jsonb,text,jsonb)', 'mi_apply_run(uuid,integer,text,text,boolean,jsonb)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
