-- 0136_master_import_na_routing: the Master import reads "Pending" and "N/A" as the owner means them, skips the placeholder rows of the register sheets,
-- routes the GECOL purchase requests of the PR-PO sheet into the GECOL register, derives an empty Order Status, and selects the one candidate that holds a
-- contract sign-off (owner decisions 2026-11-22; CHANGELOG 182; contract 0.15.46).
-- Mirror: db/sql/135_master_import_na_routing.sql (kept byte-identical).
--
-- WHY (the owner's real Site Master, error summary with counts only): date columns of the Master sheet hold the text "N/A" or "Pending" (D10 window, KPI dates
-- and Cutover Result N/A in 469 rows; D11 SSV Date N/A 282; D8 MW Alignment Date N/A 205 and Pending 30; D8 Measured RSL N/A 203; D9 Integration Date Pending
-- 50; B13 CW PAC N/A 87 / 64), each an invalid_date / invalid_number / not_in_list error; 240 GECOL rows and 110 HLC rows hold only the Site ID (required and
-- scope_conflict errors); 375 PR-PO rows have no Order Status and 191 PR-PO rows are GECOL purchase requests (wrong_register); 223 Acquisition rows hold a
-- Contract Sign-off Date on a candidate that is not Selected (not_selected).
--
-- SCOPE: ONLY the Master paths. (a) The Master import and comparison (mi_apply_run: the Master sheet staged as TPL-MASTER through imp_stage_master_core, the
-- register sheets through hrg_stage_registers), (b) the upload of the Master template TPL-MASTER (imp_stage_master_core, or in the background imp_upload_step).
-- All of them stage a stream unit with the sheet 'Master' (imp_stream_eval) and a register sheet through imp_master_unit; nothing else calls them with that
-- sheet. Manual entry, the stream templates, the register templates and the New sites template keep every rule of today.
--
-- THE RULES (owner decisions 2026-11-22):
--   1. "Pending" (trimmed, any case) in a date, number or list cell is an empty cell (not done yet): no error. A list whose own values hold "Pending" keeps it.
--   2. "N/A" (trimmed, any case: 'n/a', 'na', 'not applicable', '-') in a cell:
--      a. in the task's ACTUAL date column (the column whose field is actual_date) of a Master row: the task becomes N/A as an admin override by rule, when the
--         batch is sent (imp_submit_stream_finish), revertible, like 0126 / 0134 (flag task_instances.master_na + time, guard mina_guard_task, admin_overrides
--         kind master_na with acted_by NULL, a workflow step admin_override, an audit row task_master_na; POST /overrides/{id}/revert restores it, and a
--         reverted task is never marked again). Never a milestone task, never a task with an actual / start / submitted / approved date, never one that is
--         approved, N/A, skipped, in entry, review or approval, rejected or suspended, never one with a human workflow step (submit, approve, reject, claim,
--         release, reassign, reopen, start, review) or a register record in review, never one a gate holds (lock reason gate_closed:* or wf_gate_hold).
--         The uploader must hold the rights of an entry of that task, at the staging and again at the send: the import and edit regions of the task
--         (templates import, sites edit) and its entry level (L1 holder, or a System Admin when the level has no holder, or the admin override of a
--         historical load approved directly); otherwise the row says why and nothing is marked (security review of 0136).
--         When the row also carries other values of that task, the N/A is read as an empty cell (rule 2b) and the row is staged as today. A draft upload
--         (Save Draft / Planning) never marks: the N/A is an empty cell there.
--      b. in any other date, number or list column (task or register): an empty cell. A list whose own values hold "N/A" keeps it.
--      The counts of the cells read as empty and of the tasks asked N/A are informational notes of the batch (import_batches.import_notes), never errors.
--   3. A register row whose only filled cells are its keys (Site ID, Record Type, Record ID and the natural keys of the register template, match_keys) is a
--      placeholder: skipped, counted (placeholder_rows_skipped), never an error and never a scope_conflict. A sheet of placeholders only is "skipped" with that
--      count.
--   4. A PR-PO row whose Scope belongs to GECOL (procurement.rules.refused_scopes -> gecol, the wrong_register rule of Q56) is routed into the GECOL register
--      of the same staging: PR No. -> GECOL PR No., PR Date -> GECOL Request Date, Remark -> Remark. The other PR-PO values have no GECOL field and are not
--      kept (named in the row warning; open question Q581). The GECOL register holds one record per site (its key is the Site ID): a routed request fills the
--      blank fields of the GECOL sheet row of the same site; when both hold different values, the routed row stays an error of its own (gecol_one_per_site).
--      Without a GECOL sheet in the file, the routed rows become a GECOL batch of their own (sheet PR-PO). The rows are then approved through the same batch
--      path as every other GECOL row.
--   5. A PR-PO row with an empty Order Status gets the value of the setting imports.master_order_status_derived: `po_wo_issued` when a PO / WO date exists,
--      else `pr_raised`, each an active value of the Order Status list (ProcStatus). The list holds Active, Completed, Cancelled and Rejected only: none means
--      "PR raised" or "PO / WO issued", so the setting is seeded with both null (open question Q582): the rule stays off and the row keeps its error until the
--      owner names the values. A derived row carries the warning order_status_derived.
--   6. An Acquisition row with a Contract Sign-off Date on a candidate not Selected = Yes is set Selected = Yes, only when no other candidate of the same site is
--      Selected (in the file or in the register) and no other row of the same site needs the same; the row carries the warning selected_set_by_import. Else
--      the not_selected error stays for review.
-- Every derivation is a warning on its batch row and a count in the batch notes; one audit row per batch (import_batch.master_import_rules, counts only).
--
-- HOW (no rule of an existing function is rewritten): the internal functions imp_master_plan, imp_master_unit, imp_stream_eval, imp_stream_close and
-- imp_submit_stream_finish (all last defined in 0083 / 0092, owner pmis_definer, nothing granted to pmis_app) are renamed *_pre_0136 and wrapped by a
-- function of the same name and signature that prepares the rows before them (only for the Master sheet or a register unit) and records the notes after
-- them, as 0063 wrapped reg_validate. hrg_stage_registers (0093) is redefined with the routing (rule 4); ao_current_matches and admin_override_revert (latest
-- 0134) learn the kind master_na.
--
-- Function rules: SECURITY DEFINER (except the guard, which runs as its writer like nmw_guard_task), search_path = pg_catalog, public, pg_temp, owner
-- pmis_definer, EXECUTE revoked from PUBLIC and pmis_app (none is an API door; admin_override_revert stays the revert door). The new columns are revoked from
-- pmis_app (task_instances and import_batches are not writable by it anyway). No new table.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns, checks and the setting
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE task_instances
  ADD COLUMN master_na boolean NOT NULL DEFAULT false,
  ADD COLUMN master_na_at timestamptz,
  ADD CONSTRAINT task_instances_mina_check CHECK (NOT master_na OR (state = 'na' AND is_na AND master_na_at IS NOT NULL));
CREATE INDEX task_instances_mina_idx ON task_instances (site_id) WHERE master_na;
COMMENT ON COLUMN task_instances.master_na IS '0136: N/A because the actual date of the task is N/A in the Master file (owner decision 2026-11-22; admin override by rule, reversible through POST /overrides/{id}/revert)';

ALTER TABLE import_batches ADD COLUMN import_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN import_batches.import_notes IS '0136: informational notes of a Master staging ([{code, count}], counts only, never a value): cells read as empty, placeholder rows skipped, rows routed, values derived';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT (master_na, master_na_at), UPDATE (master_na, master_na_at) ON task_instances FROM pmis_app;
    REVOKE INSERT (import_notes), UPDATE (import_notes) ON import_batches FROM pmis_app;
  END IF;
END $$;

ALTER TABLE admin_overrides DROP CONSTRAINT admin_overrides_rule_actor_check;
ALTER TABLE admin_overrides ADD CONSTRAINT admin_overrides_rule_actor_check CHECK (acted_by IS NOT NULL OR kind IN ('gate_moved_past_open', 'no_microwave_na', 'master_na'));
ALTER TABLE admin_overrides DROP CONSTRAINT admin_overrides_revert_check;
ALTER TABLE admin_overrides ADD CONSTRAINT admin_overrides_revert_check CHECK ((reverted_at IS NULL) = (reverted_by IS NULL)
  OR (reverted_at IS NOT NULL AND reverted_by IS NULL AND kind IN ('gate_moved_past_open', 'no_microwave_na', 'master_na')));
COMMENT ON COLUMN admin_overrides.acted_by IS '0134 / 0136: NULL only for an override made by a rule of GSDN Workspace (kinds gate_moved_past_open, no_microwave_na and master_na, owner decisions 2026-11-22)';

-- Rule 5: the Order Status values of a derived PR-PO row (both null = off; open question Q582). Changes only through definer code (settings_guarded_keys).
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('imports.master_order_status_derived', '{"po_wo_issued": null, "pr_raised": null}'::jsonb,
   '0136 (owner decision 2026-11-22, rule 5): the Order Status the Master import gives a PR-PO row with no Order Status: po_wo_issued when a PO / WO date exists, else pr_raised. Each must be an active value of the list ProcStatus; null = not derived (the row keeps its "Order Status is required" error). Open question Q582: the list has no value meaning "PR raised" or "PO / WO issued".',
   now())
ON CONFLICT (key) DO NOTHING;
CREATE TRIGGER b_settings_mina_status BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'imports.master_order_status_derived') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_mina_status_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'imports.master_order_status_derived' OR NEW.key = 'imports.master_order_status_derived') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_mina_status_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'imports.master_order_status_derived') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The guard of the flag (runs as its writer, like nmw_guard_task). Set only by mina_mark_task (current user pmis_definer AND the definer-only marker row
--    mina_task of this task in hgd_marks, from locked / open to na). When the task leaves N/A by any path the flag goes (audited, its override closed), unless
--    the restore of mina_restore_task does it (marker mina_restore). A session setting never stands in for a marker.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mina_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Master import: the N/A of a task from the Master file is written only by GSDN Workspace (migration 0136)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.master_na AND (NEW.state IS DISTINCT FROM 'na' OR NOT NEW.is_na) THEN
    NEW.master_na := false;
    IF NOT (current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('mina_restore', NEW.id::text) ELSE false END)) THEN
      UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = coalesce(public.app_actor(), acted_by),
        revert_reason = left('the task left N/A (' || NEW.state::text || ')', 2000)
      WHERE task_id = NEW.id AND kind = 'master_na' AND reverted_at IS NULL;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_master_na_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
        jsonb_build_object('master_na', true, 'state', OLD.state::text),
        jsonb_build_object('master_na', false, 'state', NEW.state::text),
        'The task left N/A (' || NEW.state::text || '): the N/A of the Master file is cleared.', public.app_actor());
    END IF;
    NEW.admin_override := EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = NEW.id AND o.reverted_at IS NULL AND o.kind <> 'master_na');
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF (NEW.master_na, NEW.master_na_at) IS NOT DISTINCT FROM (OLD.master_na, OLD.master_na_at) THEN RETURN NEW; END IF;
  IF current_user::text = 'pmis_definer' AND (CASE WHEN current_user::text = 'pmis_definer' THEN public.hgd_marked('mina_task', NEW.id::text) ELSE false END)
     AND NEW.master_na AND NOT OLD.master_na AND NEW.state = 'na' AND NEW.is_na AND OLD.state IN ('locked', 'open') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Master import: the N/A of a task from the Master file is written only by GSDN Workspace (migration 0136)' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER mina_guard_task_ins BEFORE INSERT ON task_instances FOR EACH ROW
  WHEN (NEW.master_na OR NEW.master_na_at IS NOT NULL) EXECUTE FUNCTION mina_guard_task();
CREATE TRIGGER mina_guard_task_upd BEFORE UPDATE ON task_instances FOR EACH ROW
  WHEN (NEW.master_na IS DISTINCT FROM OLD.master_na OR NEW.master_na_at IS DISTINCT FROM OLD.master_na_at
        OR (OLD.master_na AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.is_na IS DISTINCT FROM OLD.is_na)))
  EXECUTE FUNCTION mina_guard_task();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Helpers (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- 'pending' or 'na' for a text cell that holds one of the owner's words (trimmed, any case, a no-break space read as a space); NULL otherwise.
CREATE OR REPLACE FUNCTION mina_token(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p IS NULL OR jsonb_typeof(p) <> 'string' THEN NULL
    WHEN lower(btrim(replace(p #>> '{}', chr(160), ' '))) = 'pending' THEN 'pending'
    WHEN lower(btrim(replace(p #>> '{}', chr(160), ' '))) IN ('n/a', 'na', 'not applicable', '-') THEN 'na'
  END
$$;

-- A list whose own values hold the text (any case): the word is then a value, never read as empty.
CREATE OR REPLACE FUNCTION mina_list_has(p_options jsonb, p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_options) = 'array' THEN p_options ELSE '[]'::jsonb END) x
                 WHERE lower(btrim(x)) = lower(btrim(replace(coalesce(p_text, ''), chr(160), ' '))))
$$;

-- A blank value: missing, null, a blank text, an empty array or object.
CREATE OR REPLACE FUNCTION mina_blank(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p IS NULL OR jsonb_typeof(p) = 'null' OR (jsonb_typeof(p) = 'string' AND btrim(p #>> '{}') = '')
    OR (jsonb_typeof(p) = 'array' AND jsonb_array_length(p) = 0) OR (jsonb_typeof(p) = 'object' AND p = '{}'::jsonb)
$$;

-- A count added to an object of counts.
CREATE OR REPLACE FUNCTION mina_cnt(p_counts jsonb, p_code text, p_n integer) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(p_counts, '{}'::jsonb) || jsonb_build_object(p_code, coalesce((p_counts ->> p_code)::int, 0) + coalesce(p_n, 0))
$$;

-- A row as the import reads it, without the marks of this migration (they are set only below, never taken from a file or a caller).
CREATE OR REPLACE FUNCTION mina_clean_row(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'object' THEN p - 'mina_warn' - 'mina_routed' - 'mina_conflict' - 'mina' ELSE p END
$$;

-- Adds counts ({code: n}) to the notes of a batch ([{code, count}], sorted by code; zero counts are not kept).
CREATE OR REPLACE FUNCTION mina_notes_add(p_batch uuid, p_counts jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE res jsonb;
BEGIN
  IF p_batch IS NULL OR p_counts IS NULL OR jsonb_typeof(p_counts) <> 'object' THEN RETURN NULL; END IF;
  UPDATE public.import_batches b SET import_notes = (
    SELECT coalesce(jsonb_agg(jsonb_build_object('code', z.k, 'count', z.n) ORDER BY z.k), '[]'::jsonb) FROM (
      SELECT q.k, sum(q.n)::int AS n FROM (
        SELECT x ->> 'code' AS k, (x ->> 'count')::int AS n FROM jsonb_array_elements(b.import_notes) x
        UNION ALL
        SELECT e.key, (e.value #>> '{}')::int FROM jsonb_each(p_counts) e WHERE jsonb_typeof(e.value) = 'number') q
      GROUP BY q.k HAVING sum(q.n) > 0) z)
  WHERE b.id = p_batch RETURNING b.import_notes INTO res;
  RETURN res;
END $$;

-- Why a task is NOT made N/A by rule 2a (NULL = it may be). The same checks at the staging (a warning) and at the send (the decision).
CREATE OR REPLACE FUNCTION mina_na_check(p_task uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; ms boolean; hold record;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN 'not_on_site'; END IF;
  SELECT td.is_milestone_task INTO ms FROM public.task_definitions td WHERE td.id = t.task_def_id;
  IF coalesce(ms, false) THEN RETURN 'milestone'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = t.site_id AND s.is_active AND s.overall_status::text <> 'cancelled') THEN RETURN 'site_inactive'; END IF;
  IF t.state = 'approved' THEN RETURN 'approved'; END IF;
  IF t.is_na OR t.state IN ('na', 'skipped') THEN RETURN 'already_na'; END IF;
  IF t.state NOT IN ('locked', 'open') THEN RETURN 'not_open'; END IF;
  IF t.actual_date IS NOT NULL OR t.actual_start IS NOT NULL OR t.submitted_date IS NOT NULL OR t.approved_date IS NOT NULL THEN RETURN 'has_date'; END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_steps w WHERE w.task_id = p_task
             AND w.action::text IN ('submit', 'approve', 'reject', 'claim', 'release', 'reassign', 'reopen', 'start', 'review')) THEN
    RETURN 'human_step';
  END IF;
  IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = p_task AND o.state IN ('in_review', 'in_approval')) THEN RETURN 'record_in_review'; END IF;
  IF EXISTS (SELECT 1 FROM public.admin_overrides o WHERE o.task_id = p_task AND o.kind = 'master_na' AND o.reverted_at IS NOT NULL) THEN RETURN 'reverted_before'; END IF;
  IF coalesce(t.lock_reason, '') LIKE 'gate_closed:%' THEN RETURN 'gate_held'; END IF;
  SELECT * INTO hold FROM public.wf_gate_hold(p_task);
  IF hold.gate_code IS NOT NULL THEN RETURN 'gate_held'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION mina_reason_text(p_reason text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_reason
    WHEN 'not_on_site' THEN 'the task does not exist on this site'
    WHEN 'milestone' THEN 'a milestone is calculated from its tasks'
    WHEN 'site_inactive' THEN 'the site is not active'
    WHEN 'approved' THEN 'the task is approved'
    WHEN 'already_na' THEN 'the task is N/A or skipped already'
    WHEN 'not_open' THEN 'the task has an entry, a submission or a decision of its own'
    WHEN 'has_date' THEN 'the task holds a date already'
    WHEN 'human_step' THEN 'a person acted on the task already'
    WHEN 'record_in_review' THEN 'a register record of the task waits for its review'
    WHEN 'reverted_before' THEN 'a System Admin restored this task from the N/A of the Master file before'
    WHEN 'gate_held' THEN 'a closed gate holds the task'
    WHEN 'region_forbidden' THEN 'you may not import in the region of this task'
    WHEN 'action_forbidden' THEN 'you may not edit tasks in the region of this task'
    WHEN 'not_entry_holder' THEN 'you are not an entry holder (L1) of this task in the Matrix'
    WHEN 'not_uploader' THEN 'only the person who uploaded the file sends its rows'
    ELSE coalesce(p_reason, 'not applicable') END
$$;

-- The rights of an entry on the task, decided as imp_stage_task_row decides them for a row of the same batch (security review of 0136): the import region
-- (templates import), the edit region (sites edit) and the entry level (L1 holder of the task, or a System Admin when the level has no holder, or the admin
-- override of a historical load approved directly, p_override). NULL = allowed; else the reason. Read at the staging (the uploader's context) and again at the
-- send (mina_mark_task: the rights may have changed in between).
CREATE OR REPLACE FUNCTION mina_rights_check(p_task uuid, p_actor uuid, p_imp int[], p_edit int[], p_override boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE rg int;
BEGIN
  IF p_actor IS NULL THEN RETURN 'not_entry_holder'; END IF;
  SELECT t.region_id INTO rg FROM public.task_instances t WHERE t.id = p_task;
  IF NOT FOUND THEN RETURN 'not_on_site'; END IF;
  IF NOT public.imp_region_ok(p_imp, rg) THEN RETURN 'region_forbidden'; END IF;
  IF NOT public.imp_region_ok(p_edit, rg) THEN RETURN 'action_forbidden'; END IF;
  IF NOT (public.wf_is_eligible(p_task, 'entry', p_actor) OR (public.app_user_is_system_admin(p_actor) AND NOT public.wf_has_holder(p_task, 'entry'))
          OR coalesce(p_override, false)) THEN
    RETURN 'not_entry_holder';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Rules 1 and 2 on a row of the Master sheet (internal). Returns {row, pending, na_empty, na_tasks}: the row without the cells read as empty, the counts,
--    and the tasks whose ACTUAL date column holds N/A (never in a draft).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mina_prep_task_row(p_cols jsonb, p_row jsonb, p_draft boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cells jsonb := CASE WHEN jsonb_typeof(p_row -> 'cells') = 'object' THEN p_row -> 'cells' ELSE '{}'::jsonb END; col record; v jsonb; tok text;
  np int := 0; nn int := 0; tasks text[] := ARRAY[]::text[];
BEGIN
  FOR col IN SELECT c ->> 'code' AS code, c ->> 'task' AS task, c ->> 'field' AS field, c ->> 'type' AS type, c -> 'options' AS options
             FROM jsonb_array_elements(coalesce(p_cols, '[]'::jsonb)) c
             WHERE c ->> 'kind' = 'task' AND NOT coalesce((c ->> 'derived')::boolean, false) AND c ->> 'type' IN ('date', 'number', 'list') LOOP
    v := cells -> col.code;
    tok := public.mina_token(v);
    CONTINUE WHEN tok IS NULL;
    CONTINUE WHEN col.type = 'list' AND public.mina_list_has(col.options, v #>> '{}');
    cells := cells - col.code;
    IF tok = 'pending' THEN np := np + 1;
    ELSIF col.field = 'actual_date' AND NOT coalesce(p_draft, false) AND col.task IS NOT NULL THEN
      IF NOT (col.task = ANY (tasks)) THEN tasks := tasks || col.task; END IF;
    ELSE nn := nn + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('row', p_row || jsonb_build_object('cells', cells), 'pending', np, 'na_empty', nn, 'na_tasks', to_jsonb(tasks));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Rule 4: the GECOL purchase requests of the PR-PO rows (internal). Returns {proc, gecol, routed}: the PR-PO rows left, the GECOL rows with the routed ones
--    merged or added, the number routed.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mina_route_gecol(p_proc jsonb, p_gecol jsonb, p_proc_sheet text, p_gecol_sheet text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  scopes text[]; el jsonb; d jsonb; m jsonb; nk text[]; conf text[]; ref text; tref text; site text; idx int; t jsonb; td jsonb; warn jsonb;
  outp jsonb[] := ARRAY[]::jsonb[]; g jsonb[]; n int := 0; psheet text;
BEGIN
  SELECT coalesce(array_agg(lower(btrim(e.key))), ARRAY[]::text[]) INTO scopes
  FROM public.register_definitions rd,
       jsonb_each_text(CASE WHEN jsonb_typeof(rd.rules -> 'refused_scopes') = 'object' THEN rd.rules -> 'refused_scopes' ELSE '{}'::jsonb END) e
  WHERE rd.register_key = 'procurement' AND e.value = 'gecol';
  g := ARRAY(SELECT public.mina_clean_row(x) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_gecol) = 'array' THEN p_gecol ELSE '[]'::jsonb END) x);
  FOR el IN SELECT public.mina_clean_row(x) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_proc) = 'array' THEN p_proc ELSE '[]'::jsonb END) x LOOP
    d := CASE WHEN jsonb_typeof(el -> 'data') = 'object' THEN el -> 'data' ELSE '{}'::jsonb END;
    IF cardinality(scopes) = 0 OR jsonb_typeof(el) <> 'object' OR jsonb_typeof(d -> 'scope') IS DISTINCT FROM 'string'
       OR NOT (lower(btrim(d ->> 'scope')) = ANY (scopes)) OR nullif(btrim(el ->> 'site_code'), '') IS NULL OR nullif(btrim(el ->> 'record_id'), '') IS NOT NULL
       OR jsonb_array_length(CASE WHEN jsonb_typeof(el -> 'pre_errors') = 'array' THEN el -> 'pre_errors' ELSE '[]'::jsonb END) > 0 THEN
      outp := array_append(outp, el);
      CONTINUE;
    END IF;
    psheet := left(coalesce(nullif(el ->> 'sheet', ''), p_proc_sheet, 'PR-PO'), 60);
    m := jsonb_strip_nulls(jsonb_build_object(
      'pr_no', CASE WHEN NOT public.mina_blank(d -> 'pr_no') THEN d -> 'pr_no' END,
      'request_date', CASE WHEN NOT public.mina_blank(d -> 'pr_date') THEN d -> 'pr_date' END,
      'remark', CASE WHEN NOT public.mina_blank(d -> 'remark') THEN d -> 'remark' END));
    nk := ARRAY(SELECT e.key FROM jsonb_each(d) e WHERE e.key NOT IN ('scope', 'pr_no', 'pr_date', 'remark') AND NOT public.mina_blank(e.value) ORDER BY e.key);
    ref := psheet || '!' || coalesce(el ->> 'row_no', '?');
    site := upper(btrim(el ->> 'site_code'));
    warn := jsonb_build_object('column', 'Scope', 'field', 'scope', 'code', 'routed_from_procurement',
      'message', 'Routed from ' || ref || ' (scope ' || left(d ->> 'scope', 40) || '): a GECOL purchase request is entered in the GECOL register (owner decision 2026-11-22).'
        || CASE WHEN cardinality(nk) > 0 THEN ' Not kept, the GECOL register has no such field: ' || array_to_string(nk, ', ') || '.' ELSE '' END);
    n := n + 1;
    idx := NULL;
    SELECT u.o INTO idx FROM unnest(g) WITH ORDINALITY AS u(x, o)
      WHERE upper(btrim(coalesce(u.x ->> 'site_code', ''))) = site AND NOT coalesce((u.x ->> 'mina_conflict')::boolean, false) ORDER BY u.o LIMIT 1;
    IF idx IS NOT NULL THEN
      t := g[idx];
      td := CASE WHEN jsonb_typeof(t -> 'data') = 'object' THEN t -> 'data' ELSE '{}'::jsonb END;
      conf := ARRAY(SELECT e.key FROM jsonb_each(m) e WHERE NOT public.mina_blank(td -> e.key) AND lower(btrim(td ->> e.key)) <> lower(btrim(e.value #>> '{}')) ORDER BY e.key);
      tref := coalesce(nullif(t ->> 'sheet', ''), p_gecol_sheet, 'GECOL') || '!' || coalesce(t ->> 'row_no', '?');
      IF cardinality(conf) > 0 THEN
        g := array_append(g, jsonb_build_object('row_no', el -> 'row_no', 'sheet', psheet, 'site_code', site, 'data', m, 'custom', '{}'::jsonb,
          'pre_errors', jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'gecol_one_per_site',
            'message', 'The GECOL register holds one record per site and ' || tref || ' holds other values (' || array_to_string(conf, ', ') ||
              '): this purchase request is not merged. Correct one of the two rows.')),
          'mina_warn', jsonb_build_array(warn), 'mina_routed', true, 'mina_conflict', true));
      ELSE
        g[idx] := t || jsonb_build_object('data', td || coalesce((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(m) e WHERE public.mina_blank(td -> e.key)), '{}'::jsonb),
          'mina_warn', CASE WHEN jsonb_typeof(t -> 'mina_warn') = 'array' THEN t -> 'mina_warn' ELSE '[]'::jsonb END
                       || jsonb_build_array(warn || jsonb_build_object('message', (warn ->> 'message') || ' Merged into ' || tref || ' (the values of the GECOL row are kept).')));
      END IF;
    ELSE
      g := array_append(g, jsonb_build_object('row_no', el -> 'row_no', 'sheet', psheet, 'site_code', site, 'data', m, 'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb,
        'mina_warn', jsonb_build_array(warn), 'mina_routed', true));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('proc', to_jsonb(outp), 'gecol', to_jsonb(g), 'routed', n);
END $$;

-- The same on the register parts of the Master import (p_regs of hrg_stage_registers): the PR-PO part loses its GECOL requests, the GECOL part gets them
-- (or a GECOL part is added with the sheet of the PR-PO part when the file has no GECOL sheet and the GECOL template is in use). Each part keeps its counts in
-- `mina_counts`.
CREATE OR REPLACE FUNCTION mina_route_regs(p_regs jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parts jsonb; pi int; gi int; pp jsonb; gp jsonb; res jsonb; tid text; n int;
BEGIN
  IF p_regs IS NULL OR jsonb_typeof(p_regs -> 'parts') <> 'array' THEN RETURN p_regs; END IF;
  -- no mark of this migration is ever taken from the caller
  SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(x) = 'object' THEN x - 'mina_counts' ELSE x END ORDER BY o), '[]'::jsonb) INTO parts
  FROM jsonb_array_elements(p_regs -> 'parts') WITH ORDINALITY AS t(x, o);
  SELECT (o - 1)::int INTO pi FROM jsonb_array_elements(parts) WITH ORDINALITY AS t(x, o) WHERE x ->> 'register' = 'procurement' ORDER BY o LIMIT 1;
  IF pi IS NULL THEN RETURN p_regs || jsonb_build_object('parts', parts); END IF;
  SELECT (o - 1)::int INTO gi FROM jsonb_array_elements(parts) WITH ORDINALITY AS t(x, o) WHERE x ->> 'register' = 'gecol' ORDER BY o LIMIT 1;
  pp := parts -> pi;
  gp := CASE WHEN gi IS NOT NULL THEN parts -> gi END;
  IF gi IS NULL THEN
    SELECT d.template_id INTO tid FROM public.template_definitions d WHERE d.kind = 'register' AND d.register_key = 'gecol' AND d.is_active ORDER BY d.template_id LIMIT 1;
    IF tid IS NULL THEN RETURN p_regs || jsonb_build_object('parts', parts); END IF;
  END IF;
  res := public.mina_route_gecol(pp -> 'rows', CASE WHEN gp IS NOT NULL THEN gp -> 'rows' END, pp ->> 'sheet', coalesce(gp ->> 'sheet', pp ->> 'sheet'));
  n := (res ->> 'routed')::int;
  IF n = 0 THEN RETURN p_regs || jsonb_build_object('parts', parts); END IF;
  parts := jsonb_set(parts, ARRAY[pi::text], pp || jsonb_build_object('rows', res -> 'proc', 'mina_counts', jsonb_build_object('routed_to_gecol', n)));
  IF gi IS NOT NULL THEN
    parts := jsonb_set(parts, ARRAY[gi::text], gp || jsonb_build_object('rows', res -> 'gecol', 'mina_counts', jsonb_build_object('routed_from_procurement', n)));
  ELSE
    parts := parts || jsonb_build_array(jsonb_build_object('register', 'gecol', 'template_id', tid, 'sheet', pp ->> 'sheet', 'rows', res -> 'gecol',
      'mina_counts', jsonb_build_object('routed_from_procurement', n)));
  END IF;
  RETURN p_regs || jsonb_build_object('parts', parts);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Rules 1, 2b, 3, 5 and 6 on a register unit of a Master file (internal). Returns {unit, counts}: the unit with its rows prepared (each row may carry
--    `mina_warn`, its warnings), and the counts.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mina_prep_register_unit(p_unit jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.template_definitions%ROWTYPE; cols jsonb; keys text[]; el jsonb; data jsonb; cust jsonb; col record; v jsonb; tok text; w jsonb; filled boolean;
  c jsonb := '{}'::jsonb; rows_ jsonb[] := ARRAY[]::jsonb[]; i int; cfg jsonb; val text; po boolean; cat text; site text; cand text; blocked boolean;
BEGIN
  SELECT * INTO d FROM public.template_definitions x WHERE x.template_id = p_unit ->> 'template_id' AND x.kind = 'register';
  IF NOT FOUND THEN RETURN jsonb_build_object('unit', p_unit, 'counts', '{}'::jsonb); END IF;
  SELECT v2.columns INTO cols FROM public.template_versions v2 WHERE v2.template_def_id = d.id AND v2.version = (p_unit ->> 'version')::int;
  cols := coalesce(cols, '[]'::jsonb);
  keys := ARRAY['site_code', 'record_type', 'record_id']::text[]
          || ARRAY(SELECT DISTINCT k FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.match_keys) = 'array' THEN d.match_keys ELSE '[]'::jsonb END) ks,
                   jsonb_array_elements_text(CASE WHEN jsonb_typeof(ks) = 'array' THEN ks ELSE '[]'::jsonb END) k);
  FOR el IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_unit -> 'rows') = 'array' THEN p_unit -> 'rows' ELSE '[]'::jsonb END) x LOOP
    CONTINUE WHEN jsonb_typeof(el) <> 'object';
    data := CASE WHEN jsonb_typeof(el -> 'data') = 'object' THEN el -> 'data' ELSE '{}'::jsonb END;
    cust := CASE WHEN jsonb_typeof(el -> 'custom') = 'object' THEN el -> 'custom' ELSE '{}'::jsonb END;
    w := CASE WHEN jsonb_typeof(el -> 'mina_warn') = 'array' THEN el -> 'mina_warn' ELSE '[]'::jsonb END;
    -- rules 1 and 2b: "Pending" and "N/A" in a date, number or list cell are empty cells (a list whose values hold the word keeps it)
    FOR col IN SELECT x ->> 'code' AS code, x ->> 'kind' AS kind, x ->> 'type' AS type, x -> 'options' AS options FROM jsonb_array_elements(cols) x
               WHERE x ->> 'kind' IN ('field', 'custom') AND x ->> 'type' IN ('date', 'number', 'list') AND NOT coalesce((x ->> 'derived')::boolean, false) LOOP
      v := CASE WHEN col.kind = 'field' THEN data -> col.code ELSE cust -> col.code END;
      tok := public.mina_token(v);
      CONTINUE WHEN tok IS NULL;
      CONTINUE WHEN col.type = 'list' AND public.mina_list_has(col.options, v #>> '{}');
      IF col.kind = 'field' THEN data := data - col.code; ELSE cust := cust - col.code; END IF;
      c := public.mina_cnt(c, CASE tok WHEN 'pending' THEN 'pending_as_empty' ELSE 'na_as_empty' END, 1);
    END LOOP;
    -- rule 3: a row of keys only is a placeholder (a cell of a derived column is never read, so it does not count)
    filled := EXISTS (SELECT 1 FROM jsonb_each(data) e WHERE NOT (e.key = ANY (keys)) AND NOT public.mina_blank(e.value)
                        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cols) x WHERE x ->> 'code' = e.key AND coalesce((x ->> 'derived')::boolean, false)))
              OR EXISTS (SELECT 1 FROM jsonb_each(cust) e WHERE NOT public.mina_blank(e.value))
              OR jsonb_array_length(CASE WHEN jsonb_typeof(el -> 'pre_errors') = 'array' THEN el -> 'pre_errors' ELSE '[]'::jsonb END) > 0;
    IF NOT filled THEN c := public.mina_cnt(c, 'placeholder_rows_skipped', 1); CONTINUE; END IF;
    rows_ := array_append(rows_, el || jsonb_build_object('data', data, 'custom', cust, 'mina_warn', w));
  END LOOP;

  IF d.register_key = 'procurement' THEN
    -- rule 5: an empty Order Status is derived from the PO / WO date, with the values of the setting (both null = off, Q582)
    cfg := public.calc_setting('imports.master_order_status_derived', '{}'::jsonb);
    SELECT f.list_catalogue INTO cat FROM public.register_fields f WHERE f.register_key = 'procurement' AND f.code = 'order_status';
    FOR i IN 1 .. coalesce(cardinality(rows_), 0) LOOP
      el := rows_[i]; data := el -> 'data';
      CONTINUE WHEN NOT public.mina_blank(data -> 'order_status');
      po := NOT public.mina_blank(data -> 'po_wo_date');
      val := CASE WHEN jsonb_typeof(cfg) = 'object' THEN cfg ->> CASE WHEN po THEN 'po_wo_issued' ELSE 'pr_raised' END END;
      IF val IS NOT NULL AND cat IS NOT NULL AND EXISTS (SELECT 1 FROM public.list_values lv WHERE lv.catalogue_code = cat AND lv.is_active AND lv.code = val) THEN
        rows_[i] := el || jsonb_build_object('data', data || jsonb_build_object('order_status', val),
          'mina_warn', (el -> 'mina_warn') || jsonb_build_array(jsonb_build_object('column', 'Order Status', 'field', 'order_status', 'code', 'order_status_derived',
            'message', 'Order Status was empty: set to "' || val || '" by the Master import (' || CASE WHEN po THEN 'a PO / WO date exists' ELSE 'no PO / WO date' END
              || '; owner decision 2026-11-22).')));
        c := public.mina_cnt(c, 'order_status_derived', 1);
      ELSE
        c := public.mina_cnt(c, 'order_status_not_derived', 1);
      END IF;
    END LOOP;
  ELSIF d.register_key = 'acquisition' THEN
    -- rule 6: the one candidate of a site holding a contract sign-off is Selected = Yes, unless another candidate of the site is selected or needs it too
    FOR i IN 1 .. coalesce(cardinality(rows_), 0) LOOP
      el := rows_[i]; data := el -> 'data';
      CONTINUE WHEN public.mina_blank(data -> 'contract_signoff_date') OR lower(btrim(coalesce(data ->> 'selected', ''))) = 'yes';
      site := upper(btrim(coalesce(el ->> 'site_code', '')));
      cand := lower(btrim(coalesce(data ->> 'candidate', '')));
      blocked := site = ''
        OR EXISTS (SELECT 1 FROM unnest(rows_) WITH ORDINALITY AS u(x, o) WHERE u.o <> i AND upper(btrim(coalesce(u.x ->> 'site_code', ''))) = site
                     AND (lower(btrim(coalesce(u.x -> 'data' ->> 'selected', ''))) = 'yes' OR NOT public.mina_blank(u.x -> 'data' -> 'contract_signoff_date')))
        OR EXISTS (SELECT 1 FROM public.register_records x JOIN public.sites s ON s.id = x.site_id
                   WHERE upper(s.site_code) = site AND x.register_key = 'acquisition' AND x.state <> 'voided' AND x.data ->> 'selected' = 'Yes'
                     AND lower(btrim(coalesce(x.data ->> 'candidate', ''))) <> cand);
      IF blocked THEN c := public.mina_cnt(c, 'selected_not_set', 1); CONTINUE; END IF;
      rows_[i] := el || jsonb_build_object('data', data || jsonb_build_object('selected', 'Yes'),
        'mina_warn', (el -> 'mina_warn') || jsonb_build_array(jsonb_build_object('column', 'Selected', 'field', 'selected', 'code', 'selected_set_by_import',
          'message', 'Selected was not Yes on a candidate with a Contract Sign-off Date and no other candidate of the site is selected: set to Yes by the Master import (owner decision 2026-11-22).')));
      c := public.mina_cnt(c, 'selected_set_by_import', 1);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('unit', p_unit || jsonb_build_object('rows', to_jsonb(rows_)), 'counts', c);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Rule 2a: the N/A of one task (internal), and the N/A of the tasks of a sent batch
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mina_mark_task(p_task uuid, p_batch uuid, p_row uuid, p_ref text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur public.task_instances%ROWTYPE; why_not text; before jsonb; oid uuid; tcode text; uploader uuid; b public.import_batches%ROWTYPE;
  why constant text := 'N/A in the Master file';
  rs constant text := 'owner decision 2026-11-22: the actual date of the task is N/A in the Master file, so the task does not apply (admin override by rule, revertible)';
BEGIN
  SELECT * INTO cur FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'skipped', 'reason', 'not_on_site'); END IF;
  why_not := public.mina_na_check(p_task);
  IF why_not IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'skipped', 'reason', why_not, 'site_id', cur.site_id); END IF;
  SELECT td.code INTO tcode FROM public.task_definitions td WHERE td.id = cur.task_def_id;
  SELECT * INTO b FROM public.import_batches x WHERE x.id = p_batch;
  uploader := b.uploaded_by;
  -- the rights of the uploader, again at the send (they may have changed since the staging): only the uploader sends, in the task's regions of import and
  -- edit, as an entry holder of the task (or the admin override of a historical load approved directly, which only a System Admin marks)
  why_not := CASE WHEN b.id IS NULL OR public.app_actor() IS DISTINCT FROM b.uploaded_by OR NOT public.app_region_check(cur.region_id) THEN 'not_uploader'
                  ELSE public.mina_rights_check(p_task, b.uploaded_by, public.wf_actor_regions('templates', 'import'), public.wf_actor_regions('sites', 'edit'),
                         b.historical_direct_approve AND public.app_user_is_system_admin(b.uploaded_by)) END;
  IF why_not IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'skipped', 'reason', why_not, 'site_id', cur.site_id); END IF;
  before := public.wf_snap(p_task);
  PERFORM public.hgd_mark('mina_task', p_task::text);
  UPDATE public.task_instances SET state = 'na', is_na = true, na_reason = why, master_na = true, master_na_at = now(), admin_override = true,
    ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL,
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.hgd_unmark('mina_task');
  INSERT INTO public.admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
  VALUES ('task', cur.site_id, p_task, 'master_na', rs, jsonb_build_object('state', cur.state::text),
          jsonb_build_object('state', 'na', 'na_reason', why, 'source_ref', left(p_ref, 80), 'batch_id', p_batch), NULL)
  RETURNING id INTO oid;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
  VALUES (p_task, greatest(cur.current_level, 1), 'admin_override', NULL,
          left(why || ' (' || coalesce(left(p_ref, 80), 'Master') || '): the task does not apply (admin override by the rule of 2026-11-22)', 2000),
          true, rs, false, cur.state, 'na', clock_timestamp());
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('task_master_na', 'task', p_task::text, cur.site_id, cur.region_id, before || jsonb_build_object('master_na', false),
          public.wf_snap(p_task) || jsonb_build_object('master_na', true, 'reason_code', 'master_na', 'na_reason', why, 'task_code', tcode, 'override_id', oid,
            'batch_id', p_batch, 'batch_row_id', p_row, 'source_ref', left(p_ref, 80), 'uploaded_by', uploader,
            'rule', 'the actual date of the task is N/A in the Master file: the task is N/A as an admin override (never a task with a date, a person''s step, approved, or held by a gate)'),
          rs, NULL, true);
  PERFORM public.wf_unlock_successors(p_task);
  RETURN jsonb_build_object('outcome', 'marked', 'override_id', oid, 'site_id', cur.site_id);
END $$;

-- The N/A rows of a stream batch of a Master file, when the batch is sent (internal; called by imp_submit_stream_finish). Each row is decided once.
CREATE OR REPLACE FUNCTION mina_apply_batch(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; r record; res jsonb; nm int := 0; ns int := 0; sites uuid[] := ARRAY[]::uuid[]; sid uuid; ok boolean;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND OR b.source NOT IN ('master_import', 'master_template') OR b.stream_code IS NULL OR b.mode <> 'submit' THEN RETURN NULL; END IF;
  FOR r IN SELECT x.id, x.task_instance_id, x.task_code, x.source_ref FROM public.import_batch_rows x
           WHERE x.batch_id = p_batch AND x.action = 'unchanged' AND x.payload ->> 'master_na' = 'true' AND NOT (x.payload ? 'master_na_result')
             AND x.task_instance_id IS NOT NULL ORDER BY x.ord, x.row_no LOOP
    res := public.mina_mark_task(r.task_instance_id, p_batch, r.id, r.source_ref);
    ok := res ->> 'outcome' = 'marked';
    UPDATE public.import_batch_rows SET
      payload = payload || jsonb_build_object('master_na_result', res ->> 'outcome') || CASE WHEN ok THEN '{}'::jsonb ELSE jsonb_build_object('master_na_reason', res ->> 'reason') END,
      warnings = coalesce(warnings, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('column', 'Actual date', 'field', r.task_code || ':actual_date',
        'code', CASE WHEN ok THEN 'master_na_marked' ELSE 'master_na_not_marked' END,
        'message', CASE WHEN ok THEN 'The task is N/A (its actual date is N/A in the Master file; admin override by rule, revertible).'
                        ELSE 'The task is not made N/A: ' || public.mina_reason_text(res ->> 'reason') || '.' END))
    WHERE id = r.id;
    IF ok THEN
      nm := nm + 1;
      IF NOT ((res ->> 'site_id')::uuid = ANY (sites)) THEN sites := sites || (res ->> 'site_id')::uuid; END IF;
    ELSE ns := ns + 1; END IF;
  END LOOP;
  IF nm + ns = 0 THEN RETURN jsonb_build_object('marked', 0, 'not_marked', 0); END IF;
  PERFORM public.mina_notes_add(p_batch, jsonb_build_object('na_task_marked', nm, 'na_task_not_marked', ns));
  -- the milestones and gates follow (the calculation path), unless a historical load works on the site: its own rules recalculate it at the end (0134)
  FOREACH sid IN ARRAY sites LOOP
    IF NOT public.gmp_site_deferred(sid) THEN PERFORM public.calc_refresh_site(sid); END IF;
  END LOOP;
  PERFORM public.log_audit_write('import_batch.master_na', 'import_batch', p_batch::text, NULL,
    jsonb_build_object('marked', nm, 'not_marked', ns, 'rule', 'owner decision 2026-11-22: a task whose actual date is N/A in the Master file is N/A (admin override by rule)'),
    'Master import: N/A in the actual date column', NULL, NULL, NULL, false);   -- a summary of the batch (each task carries its own override audit row)
  RETURN jsonb_build_object('marked', nm, 'not_marked', ns);
END $$;

-- The restore of a task made N/A by rule 2a (internal): the revert door. The task is locked again, opened at once when its predecessors are done and no
-- gate holds it; never marked by the rule again.
CREATE OR REPLACE FUNCTION mina_restore_task(p_task uuid, p_actor uuid, p_reason text, p_why text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; before jsonb; oid uuid; hold record; opened boolean := false;
BEGIN
  IF p_actor IS NULL OR NOT public.app_user_is_system_admin(p_actor) THEN
    RAISE EXCEPTION 'Master import: only a System Admin restores the task' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT (t.state = 'na' AND t.master_na) THEN
    RETURN jsonb_build_object('task_id', p_task, 'outcome', 'not_marked');
  END IF;
  UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = p_actor, revert_reason = left(btrim(p_reason), 2000)
  WHERE task_id = p_task AND kind = 'master_na' AND reverted_at IS NULL RETURNING id INTO oid;
  before := public.wf_snap(p_task);
  PERFORM public.hgd_mark('mina_restore', p_task::text);
  UPDATE public.task_instances SET state = 'locked', is_na = false, na_reason = NULL, current_level = 0, master_na = false,
    version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.hgd_unmark('mina_restore');
  IF NOT EXISTS (SELECT 1 FROM public.task_predecessors p2 JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = p2.predecessor_id
                 WHERE p2.task_def_id = t.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped')) THEN
    SELECT * INTO hold FROM public.wf_gate_hold(p_task);
    IF hold.gate_code IS NOT NULL THEN
      UPDATE public.task_instances SET lock_reason = 'gate_closed:' || hold.gate_code WHERE id = p_task;
    ELSE
      opened := public.wf_open_locked(p_task, 'restored from N/A (Master file)');
    END IF;
  END IF;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, admin_override, override_reason, stepup_verified, before_state, after_state, created_at)
  VALUES (p_task, 1, 'override_revert', p_actor, left(p_why, 2000), true, left(btrim(p_reason), 2000), coalesce(p_stepup, false), 'na',
          (SELECT state FROM public.task_instances WHERE id = p_task), clock_timestamp());
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES ('task_master_na_restore', 'task', p_task::text, t.site_id, t.region_id, before || jsonb_build_object('master_na', true),
          public.wf_snap(p_task) || jsonb_build_object('master_na', false, 'override_id', oid, 'opened', opened, 'why', p_why),
          left(btrim(p_reason), 2000), p_actor, true);
  PERFORM public.calc_refresh_site(t.site_id);
  RETURN jsonb_build_object('task_id', p_task, 'outcome', 'restored', 'override_id', oid, 'opened', opened);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The wrapped staging functions (internal, renamed and called unchanged; the new functions keep their name and signature)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION imp_master_plan(text, integer, jsonb, text) RENAME TO imp_master_plan_pre_0136;
ALTER FUNCTION imp_master_unit(jsonb, text, text, text, text, uuid, jsonb, integer) RENAME TO imp_master_unit_pre_0136;
ALTER FUNCTION imp_stream_eval(jsonb, jsonb, text, text) RENAME TO imp_stream_eval_pre_0136;
ALTER FUNCTION imp_stream_close(jsonb, jsonb, text, text, uuid, text, text, text, jsonb, uuid) RENAME TO imp_stream_close_pre_0136;
ALTER FUNCTION imp_submit_stream_finish(uuid, text, integer, integer, integer, integer) RENAME TO imp_submit_stream_finish_pre_0136;

-- The plan of a TPL-MASTER file (0083), then rule 4 on its register units: the GECOL requests of the PR-PO unit go to the GECOL unit (or to a GECOL unit added
-- with the sheet of the PR-PO unit when the file has no GECOL sheet and the GECOL template is in use). A draft has no register unit (they are skipped).
CREATE FUNCTION imp_master_plan(p_template text, p_version integer, p_parts jsonb, p_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE plan jsonb; units jsonb; pi int; gi int; pu jsonb; gu jsonb; res jsonb; n int; gd public.template_definitions%ROWTYPE; gv public.template_versions%ROWTYPE;
BEGIN
  plan := public.imp_master_plan_pre_0136(p_template, p_version, p_parts, p_mode);
  units := coalesce(plan -> 'units', '[]'::jsonb);
  SELECT (o - 1)::int INTO pi FROM jsonb_array_elements(units) WITH ORDINALITY AS t(x, o) WHERE x ->> 'kind' = 'register' AND x ->> 'ref' = 'procurement' ORDER BY o LIMIT 1;
  IF pi IS NULL THEN RETURN plan; END IF;
  SELECT (o - 1)::int INTO gi FROM jsonb_array_elements(units) WITH ORDINALITY AS t(x, o) WHERE x ->> 'ref' = 'gecol' ORDER BY o LIMIT 1;
  pu := units -> pi;
  IF gi IS NOT NULL THEN
    gu := units -> gi;
    IF gu ->> 'kind' <> 'register' THEN RETURN plan; END IF;   -- the GECOL sheet cannot be staged: the requests stay where they are (and are refused as today)
  ELSE
    SELECT * INTO gd FROM public.template_definitions x WHERE x.kind = 'register' AND x.register_key = 'gecol' AND x.is_active ORDER BY x.template_id LIMIT 1;
    IF NOT FOUND THEN RETURN plan; END IF;
    SELECT * INTO gv FROM public.template_versions x WHERE x.template_def_id = gd.id AND x.is_current;
  END IF;
  res := public.mina_route_gecol(pu -> 'rows', CASE WHEN gu IS NOT NULL THEN gu -> 'rows' END, pu ->> 'sheet', coalesce(gu ->> 'sheet', pu ->> 'sheet'));
  n := (res ->> 'routed')::int;
  IF n = 0 THEN RETURN plan; END IF;
  units := jsonb_set(units, ARRAY[pi::text], pu || jsonb_build_object('rows', res -> 'proc', 'mina_counts', jsonb_build_object('routed_to_gecol', n)));
  IF gi IS NOT NULL THEN
    units := jsonb_set(units, ARRAY[gi::text], gu || jsonb_build_object('rows', res -> 'gecol', 'mina_counts', jsonb_build_object('routed_from_procurement', n)));
  ELSE
    units := units || jsonb_build_array(jsonb_build_object('kind', 'register', 'sheet', pu ->> 'sheet', 'ref', 'gecol', 'template_id', gd.template_id, 'version', gv.version,
      'checksum', gv.header_checksum, 'rows', res -> 'gecol', 'mina_counts', jsonb_build_object('routed_from_procurement', n)));
  END IF;
  RETURN plan || jsonb_build_object('units', units);
END $$;

-- One unit of a Master file (0083). A register unit is prepared first (rules 1, 2b, 3, 5, 6); its rows' warnings, the source of a routed row and the notes are
-- written on the batch after it is staged. The batch answer carries `import_notes`.
CREATE FUNCTION imp_master_unit(p_unit jsonb, p_file_name text, p_sha text, p_mode text, p_source text, p_group uuid, p_hw jsonb, p_file_v integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE prep jsonb; u jsonb; r jsonb; bid uuid; counts jsonb := '{}'::jsonb; notes jsonb; k text; nv jsonb; n_rows int;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_unit ->> 'kind' IS DISTINCT FROM 'register' THEN
    r := public.imp_master_unit_pre_0136(p_unit, p_file_name, p_sha, p_mode, p_source, p_group, p_hw, p_file_v);
    IF r ? 'batch' THEN
      SELECT b.import_notes INTO notes FROM public.import_batches b WHERE b.id = (r -> 'batch' ->> 'id')::uuid;
      r := jsonb_set(r, '{batch,import_notes}', coalesce(notes, '[]'::jsonb));
    END IF;
    RETURN r;
  END IF;
  prep := public.mina_prep_register_unit(p_unit);
  u := prep -> 'unit';
  counts := coalesce(prep -> 'counts', '{}'::jsonb);
  FOR k, nv IN SELECT * FROM jsonb_each(CASE WHEN jsonb_typeof(p_unit -> 'mina_counts') = 'object' THEN p_unit -> 'mina_counts' ELSE '{}'::jsonb END) LOOP
    IF k IN ('routed_to_gecol', 'routed_from_procurement') AND jsonb_typeof(nv) = 'number' THEN counts := public.mina_cnt(counts, k, (nv #>> '{}')::int); END IF;
  END LOOP;
  n_rows := jsonb_array_length(coalesce(u -> 'rows', '[]'::jsonb));
  IF n_rows = 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('code', e.key, 'count', (e.value #>> '{}')::int) ORDER BY e.key), '[]'::jsonb) INTO notes
    FROM jsonb_each(counts) e WHERE (e.value #>> '{}')::int > 0;
    RETURN jsonb_build_object('skipped', jsonb_build_object('sheet', p_unit ->> 'sheet', 'kind', 'register', 'ref', p_unit ->> 'ref', 'reason', 'no_rows',
      'detail', 'No row of the sheet holds data to load: '
        || coalesce((counts ->> 'placeholder_rows_skipped')::int, 0) || ' placeholder row(s) hold only their keys and were skipped'
        || CASE WHEN coalesce((counts ->> 'routed_to_gecol')::int, 0) > 0 THEN '; ' || (counts ->> 'routed_to_gecol') || ' row(s) were routed to the GECOL register' ELSE '' END || '.',
      'import_notes', notes));
  END IF;
  r := public.imp_master_unit_pre_0136(u, p_file_name, p_sha, p_mode, p_source, p_group, p_hw, p_file_v);
  IF r ? 'batch' THEN
    bid := (r -> 'batch' ->> 'id')::uuid;
    -- a row routed from another sheet keeps its own source (Sheet!row)
    UPDATE public.import_batch_rows x SET source_ref = x.sheet || '!' || x.row_no::text WHERE x.batch_id = bid AND x.sheet IS DISTINCT FROM (p_unit ->> 'sheet');
    -- the warnings of the rows (what the import derived, routed or read as empty), on the rows the reviewer sees
    UPDATE public.import_batch_rows x SET warnings = coalesce(x.warnings, '[]'::jsonb) || w.warn
    FROM (SELECT coalesce(e ->> 'sheet', 'Data') AS sh, (e ->> 'row_no')::int AS rn, e -> 'mina_warn' AS warn
          FROM jsonb_array_elements(u -> 'rows') e WHERE jsonb_typeof(e -> 'mina_warn') = 'array' AND jsonb_array_length(e -> 'mina_warn') > 0) w
    WHERE x.batch_id = bid AND x.sheet = w.sh AND x.row_no = w.rn;
    notes := public.mina_notes_add(bid, counts);
    IF EXISTS (SELECT 1 FROM jsonb_each(counts) e WHERE (e.value #>> '{}')::int > 0) THEN
      PERFORM public.log_audit_write('import_batch.master_import_rules', 'import_batch', bid::text, NULL,
        jsonb_build_object('register', p_unit ->> 'ref', 'sheet', p_unit ->> 'sheet', 'counts', counts,
          'rules', 'owner decisions 2026-11-22: Pending and N/A read as empty, placeholder rows skipped, GECOL requests of PR-PO routed to GECOL, empty Order Status derived, the one candidate with a contract sign-off selected'),
        'Master import rules (owner decisions 2026-11-22)');
    END IF;
    r := jsonb_set(r, '{batch,import_notes}', coalesce(notes, '[]'::jsonb));
  END IF;
  RETURN r;
END $$;

-- The rows of a stream unit (0083 / 0085). For the Master sheet only: rules 1, 2a and 2b before the rows are read, then the task asked N/A (rule 2a) becomes an
-- item of its own ("unchanged", payload master_na) that the send decides (mina_apply_batch). The counts ride on each result (`mina`) to imp_stream_close.
CREATE FUNCTION imp_stream_eval(p_ctx jsonb, p_rows jsonb, p_mode text, p_sheet text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cols jsonb; preps jsonb[] := ARRAY[]::jsonb[]; rows_ jsonb[] := ARRAY[]::jsonb[]; el jsonb; pr jsonb; res jsonb; out_ jsonb[] := ARRAY[]::jsonb[]; i int;
  r jsonb; items jsonb; tc text; idx int; it jsonb; s public.sites%ROWTYPE; ti public.task_instances%ROWTYPE; why_not text; cnt jsonb; w jsonb;
  draft boolean := (p_mode = 'draft');
BEGIN
  IF p_sheet IS DISTINCT FROM 'Master' THEN RETURN public.imp_stream_eval_pre_0136(p_ctx, p_rows, p_mode, p_sheet); END IF;
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT v.columns INTO cols FROM public.template_versions v WHERE v.id = (p_ctx ->> 'version_id')::uuid;
  FOR el IN SELECT x FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x LOOP
    pr := public.mina_prep_task_row(cols, el, draft);
    preps := array_append(preps, pr);
    rows_ := array_append(rows_, pr -> 'row');
  END LOOP;
  res := public.imp_stream_eval_pre_0136(p_ctx, to_jsonb(rows_), p_mode, p_sheet);
  FOR i IN 1 .. coalesce(jsonb_array_length(res), 0) LOOP
    el := res -> (i - 1);
    pr := preps[i];
    cnt := jsonb_build_object('pending_as_empty', coalesce((pr ->> 'pending')::int, 0), 'na_as_empty', coalesce((pr ->> 'na_empty')::int, 0));
    r := el -> 'res';
    IF pr IS NOT NULL AND jsonb_array_length(coalesce(pr -> 'na_tasks', '[]'::jsonb)) > 0 THEN
      IF r ->> 'site_id' IS NULL THEN
        cnt := public.mina_cnt(cnt, 'na_as_empty', jsonb_array_length(pr -> 'na_tasks'));
      ELSE
        SELECT * INTO s FROM public.sites x WHERE x.id = (r ->> 'site_id')::uuid;
        items := coalesce(r -> 'items', '[]'::jsonb);
        FOR tc IN SELECT jsonb_array_elements_text(pr -> 'na_tasks') LOOP
          idx := NULL;
          SELECT (o - 1)::int INTO idx FROM jsonb_array_elements(items) WITH ORDINALITY AS t(x, o) WHERE x ->> 'task_code' = tc ORDER BY o LIMIT 1;
          IF idx IS NOT NULL AND NOT ((items -> idx) ->> 'action' = 'unchanged' AND coalesce((items -> idx) -> 'payload' -> 'fields', '{}'::jsonb) = '{}'::jsonb) THEN
            -- the row carries other values of the task: the N/A is an empty cell (rule 2b), the row is staged as today
            items := jsonb_set(items, ARRAY[idx::text], (items -> idx) || jsonb_build_object('warnings', coalesce((items -> idx) -> 'warnings', '[]'::jsonb)
              || jsonb_build_array(public.imp_task_note(cols, tc, 'actual_date', 'master_na_ignored',
                   'The actual date is N/A in the Master file, but the row carries other values of this task: the N/A is read as an empty cell.'))));
            cnt := public.mina_cnt(cnt, 'na_as_empty', 1);
            CONTINUE;
          END IF;
          SELECT x.* INTO ti FROM public.task_instances x JOIN public.task_definitions td ON td.id = x.task_def_id
            WHERE x.site_id = s.id AND td.code = tc AND td.workflow_id = s.workflow_version_id;
          IF NOT FOUND THEN cnt := public.mina_cnt(cnt, 'na_as_empty', 1); CONTINUE; END IF;
          why_not := public.mina_na_check(ti.id);
          IF why_not IS NULL THEN   -- the same rights as an entry of this row (region of import and edit, the entry level)
            why_not := public.mina_rights_check(ti.id, public.app_actor(), public.imp_int_array(p_ctx -> 'r_import'), public.imp_int_array(p_ctx -> 'r_edit'),
              (p_ctx ->> 'hw_cutoff') IS NOT NULL AND public.hrf_staging());
          END IF;
          w := public.imp_task_note(cols, tc, 'actual_date', CASE WHEN why_not IS NULL THEN 'master_na_requested' ELSE 'master_na_not_applicable' END,
            CASE WHEN why_not IS NULL THEN 'N/A in the Master file: the task is made N/A (admin override by rule, revertible) when the batch is sent.'
                 ELSE 'N/A in the Master file, but the task is not made N/A: ' || public.mina_reason_text(why_not) || '.' END);
          cnt := public.mina_cnt(cnt, CASE WHEN why_not IS NULL THEN 'na_task_requested' ELSE 'na_task_not_applicable' END, 1);
          IF idx IS NOT NULL THEN
            it := items -> idx;
            it := it || jsonb_build_object('warnings', coalesce(it -> 'warnings', '[]'::jsonb) || jsonb_build_array(w),
              'payload', coalesce(it -> 'payload', '{}'::jsonb) || CASE WHEN why_not IS NULL THEN jsonb_build_object('master_na', true) ELSE '{}'::jsonb END);
            items := jsonb_set(items, ARRAY[idx::text], it);
          ELSE
            items := items || jsonb_build_array(jsonb_build_object('task_code', tc, 'task_id', ti.id,
              'name', (SELECT d2.name_en FROM public.task_definitions d2 WHERE d2.id = ti.task_def_id), 'action', 'unchanged', 'decision', 'pending', 'hold_reason', NULL,
              'errors', '[]'::jsonb, 'warnings', jsonb_build_array(w), 'diff', '{}'::jsonb,
              'payload', jsonb_build_object('fields', '{}'::jsonb) || CASE WHEN why_not IS NULL THEN jsonb_build_object('master_na', true) ELSE '{}'::jsonb END,
              'key', s.site_code || ' / ' || tc, 'sig', 't:' || ti.id::text));
          END IF;
        END LOOP;
        el := el || jsonb_build_object('res', r || jsonb_build_object('items', items));
      END IF;
    END IF;
    out_ := array_append(out_, el || jsonb_build_object('mina', cnt));
  END LOOP;
  RETURN to_jsonb(out_);
END $$;

-- The end of a stream batch (0083), then the counts of the Master sheet as the notes of the batch.
CREATE FUNCTION imp_stream_close(p_ctx jsonb, p_results jsonb, p_file_name text, p_sha text, p_group uuid, p_source text, p_sheet text, p_mode text, p_hw jsonb, p_task uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE bid uuid; counts jsonb;
BEGIN
  bid := public.imp_stream_close_pre_0136(p_ctx, p_results, p_file_name, p_sha, p_group, p_source, p_sheet, p_mode, p_hw, p_task);
  IF bid IS NOT NULL AND p_sheet = 'Master' THEN
    SELECT coalesce(jsonb_object_agg(q.k, q.n), '{}'::jsonb) INTO counts FROM (
      SELECT e.key AS k, sum((e.value #>> '{}')::int)::int AS n
      FROM jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x, jsonb_each(CASE WHEN jsonb_typeof(x -> 'mina') = 'object' THEN x -> 'mina' ELSE '{}'::jsonb END) e
      WHERE jsonb_typeof(e.value) = 'number' GROUP BY e.key) q;
    IF EXISTS (SELECT 1 FROM jsonb_each(counts) e WHERE (e.value #>> '{}')::int > 0) THEN
      PERFORM public.mina_notes_add(bid, counts);
      PERFORM public.log_audit_write('import_batch.master_import_rules', 'import_batch', bid::text, NULL,
        jsonb_build_object('sheet', 'Master', 'counts', counts,
          'rules', 'owner decisions 2026-11-22: Pending and N/A in a date, number or list cell read as empty; N/A in the actual date makes the task N/A when the batch is sent'),
        'Master import rules (owner decisions 2026-11-22)');
    END IF;
  END IF;
  RETURN bid;
END $$;

-- The end of a stream send (0092), then rule 2a on the rows of a Master batch (each decided once).
CREATE FUNCTION imp_submit_stream_finish(p_batch uuid, p_prev_status text, p_submitted integer, p_saved integer, p_held integer, p_failed integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE st text;
BEGIN
  st := public.imp_submit_stream_finish_pre_0136(p_batch, p_prev_status, p_submitted, p_saved, p_held, p_failed);
  PERFORM public.mina_apply_batch(p_batch);
  RETURN st;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. The register sheets of the Master import route the GECOL requests first (hrg_stage_registers: latest 0093, changes marked 0136)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hrg_stage_registers(p_regs jsonb, p_run public.master_reconciliation_runs, p_mode text, p_group uuid, p_hw_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); part jsonb; rk text; sheet text; d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; personal text[]; rows_ jsonb;
  n int; u jsonb; res jsonb; bid uuid; j jsonb; seen text[] := ARRAY[]::text[]; batches jsonb[] := ARRAY[]::jsonb[]; skipped jsonb[] := ARRAY[]::jsonb[]; s jsonb; notes jsonb;
  allowed constant text[] := ARRAY['rf_design', 'acquisition', 'permits_hse', 'procurement', 'gecol', 'hlc', 'as_built', 'risks'];
  cutoff date := public.hw_waiver_cutoff();
  regs jsonb := public.mina_route_regs(p_regs);   -- 0136: rule 4, the GECOL requests of the PR-PO sheet go to the GECOL sheet
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- the sheets the API could not read (missing, no Site ID column, too many rows ...): reported as skipped
  FOR s IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(regs -> 'skipped') = 'array' THEN regs -> 'skipped' ELSE '[]'::jsonb END) x LIMIT 50 LOOP
    skipped := array_append(skipped, jsonb_build_object('sheet', left(s ->> 'sheet', 60), 'kind', 'register', 'ref', left(s ->> 'ref', 40),
      'reason', left(coalesce(s ->> 'reason', 'not_read'), 40), 'detail', left(s ->> 'detail', 300)));
  END LOOP;
  FOR part IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(regs -> 'parts') = 'array' THEN regs -> 'parts' ELSE '[]'::jsonb END) x LOOP
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
    -- 0136: a row routed from another sheet keeps its sheet and its warnings (mina_warn, set by mina_route_regs only: the parts are cleaned of them first)
    SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('row_no', (t.e ->> 'row_no')::int,
             'sheet', CASE WHEN coalesce((t.e ->> 'mina_routed')::boolean, false) THEN left(coalesce(nullif(t.e ->> 'sheet', ''), sheet), 60) ELSE sheet END,
             'site_code', left(nullif(btrim(t.e ->> 'site_code'), ''), 60), 'record_type', left(nullif(btrim(t.e ->> 'record_type'), ''), 40),
             'data', CASE WHEN jsonb_typeof(t.e -> 'data') = 'object' THEN (t.e -> 'data') - personal ELSE '{}'::jsonb END, 'custom', '{}'::jsonb,
             'pre_errors', CASE WHEN jsonb_typeof(t.e -> 'pre_errors') = 'array' THEN t.e -> 'pre_errors' ELSE '[]'::jsonb END,
             'mina_warn', CASE WHEN jsonb_typeof(t.e -> 'mina_warn') = 'array' THEN t.e -> 'mina_warn' END)) ORDER BY t.o), '[]'::jsonb), count(*)
      INTO rows_, n
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(part -> 'rows') = 'array' THEN part -> 'rows' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, o)
    WHERE jsonb_typeof(t.e) = 'object' AND (t.e ->> 'row_no') ~ '^[0-9]{1,7}$';
    IF n = 0 THEN
      skipped := array_append(skipped, jsonb_build_object('sheet', sheet, 'kind', 'register', 'ref', rk, 'reason', 'no_rows',
        'detail', CASE WHEN coalesce((part -> 'mina_counts' ->> 'routed_to_gecol')::int, 0) > 0   -- 0136
                       THEN 'Every row of the sheet was routed to the GECOL register (' || (part -> 'mina_counts' ->> 'routed_to_gecol') || ' row(s)).'
                       ELSE 'The sheet has no data rows.' END));
      CONTINUE;
    END IF;
    IF n > 5000 THEN
      skipped := array_append(skipped, jsonb_build_object('sheet', sheet, 'kind', 'register', 'ref', rk, 'reason', 'size_or_rows_exceeded', 'detail', 'The sheet has more than 5000 rows.'));
      CONTINUE;
    END IF;
    u := jsonb_build_object('kind', 'register', 'sheet', sheet, 'ref', rk, 'template_id', d.template_id, 'version', v.version, 'checksum', v.header_checksum, 'rows', rows_)
         || CASE WHEN jsonb_typeof(part -> 'mina_counts') = 'object' THEN jsonb_build_object('mina_counts', part -> 'mina_counts') ELSE '{}'::jsonb END;   -- 0136
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
  FROM (SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(regs -> 'notes') = 'array' THEN regs -> 'notes' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) = 'object' LIMIT 100) y;
  -- 0136: the notes of the Master rules of each register batch (counts only), in the same list
  SELECT notes || coalesce(jsonb_agg(jsonb_build_object('sheet', b ->> 'sheet', 'ref', b ->> 'ref', 'code', n2 ->> 'code', 'count', (n2 ->> 'count')::int)), '[]'::jsonb)
    INTO notes
  FROM unnest(batches) b, jsonb_array_elements(CASE WHEN jsonb_typeof(b -> 'import_notes') = 'array' THEN b -> 'import_notes' ELSE '[]'::jsonb END) n2;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES ('import_master_legacy_registers', 'import_group', p_group::text,
          jsonb_build_object('run_id', p_run.id, 'file_name', p_run.file_name, 'file_sha256', p_run.file_sha256, 'batches', to_jsonb(batches), 'skipped', to_jsonb(skipped),
            'personal_columns', 'never read (Q469)'), actor);
  RETURN jsonb_build_object('batches', to_jsonb(batches), 'skipped', to_jsonb(skipped), 'notes', notes);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. The revert door (ao_current_matches and admin_override_revert: latest 0134, changes marked 0136)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ao_current_matches(p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.admin_overrides%ROWTYPE; k text; ok boolean := true;
BEGIN
  SELECT * INTO o FROM public.admin_overrides WHERE id = p_id;
  IF NOT FOUND OR o.reverted_at IS NOT NULL THEN RETURN false; END IF;
  IF o.kind = 'historical_no_source_na' THEN   -- 0126: the task is still N/A from the mark
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'na' AND t.historical_no_source);
  END IF;
  IF o.kind = 'historical_gate_open' THEN   -- 0127: the gate is still open by this override
    RETURN EXISTS (SELECT 1 FROM public.site_gate_state g WHERE g.site_id = o.site_id AND g.gate_code = o.after ->> 'gate' AND g.historical_open_override = o.id);
  END IF;
  IF o.kind = 'historical_inferred_date' THEN   -- 0127: the milestone is still approved with the inferred date
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'approved' AND t.historical_inferred_date
                   AND t.actual_date::text IS NOT DISTINCT FROM o.after ->> 'actual_date');
  END IF;
  IF o.kind = 'historical_manual_ms_approved' THEN   -- 0129: the manual milestone is still approved directly with that date
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'approved' AND t.historical_manual_ms
                   AND t.actual_date::text IS NOT DISTINCT FROM o.after ->> 'actual_date');
  END IF;
  IF o.kind = 'gate_moved_past_open' THEN   -- 0134: the gate is still open by this override
    RETURN EXISTS (SELECT 1 FROM public.site_gate_state g WHERE g.site_id = o.site_id AND g.gate_code = o.after ->> 'gate' AND g.historical_open_override = o.id);
  END IF;
  IF o.kind = 'no_microwave_na' THEN   -- 0134: the task is still N/A from the mark
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'na' AND t.no_microwave_na);
  END IF;
  IF o.kind = 'master_na' THEN   -- 0136: the task is still N/A from the Master file
    RETURN EXISTS (SELECT 1 FROM public.task_instances t WHERE t.id = o.task_id AND t.state = 'na' AND t.master_na);
  END IF;
  FOR k IN SELECT jsonb_object_keys(o.after) LOOP
    IF o.entity = 'task' THEN
      ok := ok AND coalesce(public.ao_task_date(o.task_id, k)::text, '(none)') = coalesce(o.after ->> k, '(none)');
    ELSE
      ok := ok AND coalesce(public.p4a_site_current(o.site_id, k), '(none)') = coalesce(o.after ->> k, '(none)');
    END IF;
  END LOOP;
  RETURN ok;
END $$;

CREATE OR REPLACE FUNCTION admin_override_revert(p_override uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid; o public.admin_overrides%ROWTYPE; rs text; t public.task_instances%ROWTYPE; s public.sites%ROWTYPE; fld text; k text; items jsonb := '[]'::jsonb; applied jsonb;
  before_snap jsonb; moved_region int;
BEGIN
  actor := public.ao_require_admin();
  SELECT * INTO o FROM public.admin_overrides WHERE id = p_override FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.sites x WHERE x.id = o.site_id AND public.app_region_check(x.region_id)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The override does not exist or is not visible to you.'));
  END IF;
  rs := public.ao_reason(p_reason);
  IF o.reverted_at IS NOT NULL THEN
    PERFORM public.wf_err('override_not_revertible', jsonb_build_object('detail', 'This override was reverted already.'));
  END IF;
  IF NOT public.ao_current_matches(o.id) THEN
    PERFORM public.wf_err('override_not_revertible', jsonb_build_object('detail', CASE o.entity WHEN 'task' THEN 'The task date changed since this override.' ELSE 'The site changed since this edit.' END));
  END IF;
  PERFORM public.ao_require_stepup();
  IF o.kind = 'historical_no_source_na' THEN   -- 0126: the N/A "historical load: no source" is restored (the task locked again, opened when it can be)
    PERFORM public.hns_restore_task(o.task_id, rs, 'restored from N/A "historical load: no source" by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'historical_gate_open' THEN   -- 0127: the gate is closed again by its conditions (never opened by the rule again)
    PERFORM public.hgd_restore_gate(o.id, actor, rs, 'the gate opened by the historical load is closed again by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'historical_inferred_date' THEN   -- 0127: the milestone goes back to open without a date (never inferred again)
    PERFORM public.hgd_restore_milestone(o.task_id, actor, rs, 'the inferred date of the historical load is taken back by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'historical_manual_ms_approved' THEN   -- 0129: the manual milestone is open again with its pre-filled date (never approved by the rule again)
    PERFORM public.hmm_restore_task(o.task_id, actor, rs, 'the direct approval of the historical load is taken back by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'gate_moved_past_open' THEN   -- 0134: the gate follows its conditions again (never opened by the rule again)
    PERFORM public.hgd_restore_gate(o.id, actor, rs, 'the gate opened because the site moved past it is closed again by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'no_microwave_na' THEN   -- 0134: MW alignment is restored from N/A (locked again, opened when it can be; never marked by the rule again)
    PERFORM public.nmw_restore_task(o.task_id, actor, rs, 'restored from N/A "no microwave on site" by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.kind = 'master_na' THEN   -- 0136: the task is restored from the N/A of the Master file (locked again, opened when it can be; never marked by the rule again)
    PERFORM public.mina_restore_task(o.task_id, actor, rs, 'restored from N/A "N/A in the Master file" by a System Admin (revert of the override)', true);
    RETURN public.ao_override_json(o.id);
  END IF;
  IF o.entity = 'task' THEN
    t := public.wf_lock_task(o.task_id, NULL);
    SELECT jsonb_object_keys(o.before) INTO fld LIMIT 1;
    before_snap := public.wf_snap(o.task_id);
    UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = actor, revert_reason = rs WHERE id = o.id;
    PERFORM public.ao_task_write(o.task_id, fld, nullif(o.before ->> fld, '')::date,
      EXISTS (SELECT 1 FROM public.admin_overrides x WHERE x.task_id = o.task_id AND x.reverted_at IS NULL));
    PERFORM public.ao_task_step(o.task_id, 'override_revert', rs);
    PERFORM public.log_audit_write('task_override_reverted', 'task', o.task_id::text, before_snap,
      public.wf_snap(o.task_id) || jsonb_build_object('override_id', o.id, 'date_field', fld), rs, t.site_id, t.region_id, NULL, true);
    PERFORM public.ao_task_recalc(o.task_id, fld);
  ELSE
    FOR k IN SELECT jsonb_object_keys(o.before) LOOP
      items := items || jsonb_build_array(jsonb_build_object('item', k, 'text', coalesce(o.before ->> k, '(none)')));
    END LOOP;
    SELECT * INTO s FROM public.sites WHERE id = o.site_id FOR UPDATE;
    applied := public.ao_site_apply(o.site_id, items);
    UPDATE public.admin_overrides SET reverted_at = clock_timestamp(), reverted_by = actor, revert_reason = rs WHERE id = o.id;
    PERFORM public.log_audit_write('site_admin_edit_reverted', 'site', o.site_id::text,
      jsonb_build_object('fields', applied -> 'before', 'columns', applied -> 'columns_before'),
      jsonb_build_object('fields', applied -> 'after', 'columns', applied -> 'columns_after', 'override_id', o.id), rs, o.site_id,
      (SELECT x.region_id FROM public.sites x WHERE x.id = o.site_id), NULL, true);
    moved_region := nullif(applied ->> 'moved_from', '')::int;
    IF moved_region IS NOT NULL THEN
      PERFORM public.log_audit_write('site_region_moved_out', 'site', o.site_id::text, jsonb_build_object('fields', applied -> 'before'),
        jsonb_build_object('fields', applied -> 'after', 'override_id', o.id), rs, o.site_id, moved_region, NULL, true);
    END IF;
  END IF;
  RETURN public.ao_override_json(o.id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Ownership and execute rights. Every new function (the wrappers included) is owned by pmis_definer and closed to PUBLIC and pmis_app; none is an API
--     door. The renamed functions keep their owner and grants (none for pmis_app). The redefined ones keep theirs (admin_override_revert stays the door).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['mina_guard_task()', 'mina_token(jsonb)', 'mina_list_has(jsonb,text)', 'mina_blank(jsonb)', 'mina_cnt(jsonb,text,integer)',
                           'mina_clean_row(jsonb)', 'mina_notes_add(uuid,jsonb)', 'mina_na_check(uuid)', 'mina_reason_text(text)',
                           'mina_rights_check(uuid,uuid,integer[],integer[],boolean)',
                           'mina_prep_task_row(jsonb,jsonb,boolean)', 'mina_route_gecol(jsonb,jsonb,text,text)', 'mina_route_regs(jsonb)',
                           'mina_prep_register_unit(jsonb)', 'mina_mark_task(uuid,uuid,uuid,text)', 'mina_apply_batch(uuid)',
                           'mina_restore_task(uuid,uuid,text,text,boolean)',
                           'imp_master_plan(text,integer,jsonb,text)', 'imp_master_unit(jsonb,text,text,text,text,uuid,jsonb,integer)',
                           'imp_stream_eval(jsonb,jsonb,text,text)', 'imp_stream_close(jsonb,jsonb,text,text,uuid,text,text,text,jsonb,uuid)',
                           'imp_submit_stream_finish(uuid,text,integer,integer,integer,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF f <> 'mina_guard_task()' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;
