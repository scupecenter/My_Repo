-- 0060_p3_master_import: work package P3 of the owner answers of 2026-11-04 (plan docs/plans/2026-11-04-owner-answers-gap.md, section P3; owner decision D112).
-- Mirror: db/sql/059_p3_master_import.sql (kept byte-identical).
--
-- What it builds
--   1. Q205: the Master column a task field fills is scenario- and scope-aware. template_task_fields gains `scenarios` (the delivery scenarios the row is for;
--      NULL = all) and `projection` (earliest / latest: the documented Master value when two tasks apply). A Master column may now carry several task fields
--      (AY / AZ: B8 Tower MOS or B9 Adaption MOS; BK:BN: B10 Tower erection or B11 Site adaption). For one site, tpl_master_candidates() keeps the fields
--      whose scenario fits and whose task applies on the site (exists and is not N/A); one left is written, several with a projection are shown and never
--      read, several without a projection are ambiguous and refuse the row (`ambiguous_mapping`). The stream templates keep one column per task.
--   2. Q206: a stream batch has a mode. `submit` (as before) enters and submits every row; `draft` (Save Draft / Planning) saves the planned dates and
--      values without submitting: no actual date or document is required, no L2 decision follows and no milestone moves. Q208: a row whose task a closed
--      gate locks is held (`gate_locked`) instead of refused; held rows are never applied on their own, the uploader sends the batch again (every check
--      runs again) or returns the row. Q209: a pending task is started with the actual start of the row (or of the task); today is never used. A task whose
--      template has no Actual Start column (its definition maps no `actual_start`) is a single-event task: its actual date is its start.
--   3. D112: a file of an older template version is accepted when only non-input columns changed between its version and the current one (grey, info,
--      calculated or register-owned columns); any change of a typed column (added, removed, renamed, retyped, other list values, other sheet) refuses it
--      with the list of the changed columns. tpl_version_compat() is the column-level diff; the staging functions call it.
--   4. Q207: tpl_mapping_save() is the mapping screen's writer (System Admin or a delegate of templates.edit; reason; test run that rolls back and answers
--      the impact; the next template versions are issued by the triggers of 0051 and carry the reason). A calculated or register-owned field never becomes
--      a typed column, and a Master column that GSDN Workspace does not own is never mapped.
--   5. Q8 and Q10: role_aliases and region_aliases, editable data used by the legacy import. Unknown, unmapped and ambiguous values are import exceptions;
--      an imported job title never grants a right. The role mapping is owner data that is not available yet: every Master StaffRole value is seeded
--      unmapped or ambiguous.
--   6. Q11: mx_issue_cells() is the Master projection of the Issue Log for GA:GE (the oldest open issue, else the latest closed one, ties by record id,
--      "+N more" appended to the remark). It feeds the comparison report and the Master-format export when that is built.
--   7. Q1 and Q211: the admin-only legacy Master import and the parallel-run comparison report. master_reconciliation_runs keeps every upload of the real
--      Master (no `_tpl`): file name, SHA-256, size, the stored original, the structure check, the summary, who and when. mi_stage_run() identifies the file
--      by its sheet names and headers, checks the structure, and writes the per-cell differences against what GSDN Workspace holds (master_reconciliation_diffs)
--      without changing anything. mi_apply_run() (reason, step-up) enters the typed task columns through the TPL-MASTER staging and the batch flow
--      (source master_import), so every validation, gate, holder and L2 decision of a manual entry applies. mi_resolve_diff() records the resolution of
--      one difference. Every use is written to the audit log (log_audit_write) and the System Log (log_system_write).
--   8. pmis_app only reads the new tables. Every write goes through the functions above (owner pmis_definer, search_path set).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Q205: scenario-aware Master columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE template_task_fields
  ADD COLUMN scenarios  TEXT[] CHECK (scenarios IS NULL OR (cardinality(scenarios) > 0 AND scenarios <@ ARRAY['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation']::text[])),
  ADD COLUMN projection TEXT CHECK (projection IN ('earliest', 'latest'));
COMMENT ON COLUMN template_task_fields.scenarios IS 'Q205: the delivery scenarios this row is for (NULL = every scenario). With the task applicability of the site it decides which task a shared Master column fills.';
COMMENT ON COLUMN template_task_fields.projection IS 'Q205: when several tasks of a site fill the same Master column, the documented Master value: earliest (a start) or latest (an end). The column is then shown, never read.';

DROP INDEX template_task_fields_master_col_idx;
CREATE UNIQUE INDEX template_task_fields_master_col_task_idx ON template_task_fields (master_col, task_code) WHERE master_col IS NOT NULL AND is_active;

-- B9 Adaption MOS shares AY / AZ with B8 Tower MOS (one applies on a site: B9 only when AB = Yes and AA <> Yes); B10 Tower erection shares BK:BN with
-- B11 Site adaption (both can apply: the Master shows the earliest start and the latest end).
INSERT INTO template_task_fields (task_code, field_key, label, field_type, master_col, read_only, projection) VALUES
  ('B9',  'planned_date',  'Planned Date',  'date', 'AY', false, NULL),
  ('B9',  'actual_date',   'Actual Date',   'date', 'AZ', false, NULL),
  ('B10', 'planned_start', 'Planned Start', 'date', 'BK', true,  'earliest'),
  ('B10', 'actual_start',  'Actual Start',  'date', 'BL', false, 'earliest'),
  ('B10', 'planned_date',  'Planned Date',  'date', 'BM', false, 'latest'),
  ('B10', 'actual_date',   'Actual Date',   'date', 'BN', false, 'latest')
ON CONFLICT (task_code, field_key) DO NOTHING;
UPDATE template_task_fields SET projection = 'earliest' WHERE task_code = 'B11' AND field_key IN ('planned_start', 'actual_start') AND projection IS NULL;
UPDATE template_task_fields SET projection = 'latest' WHERE task_code = 'B11' AND field_key IN ('planned_date', 'actual_date') AND projection IS NULL;

-- The fields a template may type: the dates of the task and its values; everything else is set by the workflow or owned by a register.
CREATE OR REPLACE FUNCTION tpl_field_writable(p_field text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(p_field ~ '^(planned_date|actual_start|actual_date|v:)', false)
$$;

-- How a template treats a task of the active workflow: edit, register, readonly, exclude (the rule of tpl_stream_tasks, for any stream).
CREATE OR REPLACE FUNCTION tpl_task_mode(p_task text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN r.mode = 'exclude' THEN 'exclude'
              WHEN td.is_milestone_task OR r.mode = 'readonly' THEN 'readonly'
              WHEN EXISTS (SELECT 1 FROM public.register_task_sources s WHERE s.task_code = td.code AND s.is_active) THEN 'register'
              ELSE 'edit' END
  FROM public.task_definitions td LEFT JOIN public.template_task_rules r ON r.task_code = td.code
  WHERE td.workflow_id = public.tpl_active_workflow() AND td.code = p_task AND td.is_active
$$;

-- The fields one Master column can fill on one site. status: single (one applies: write it), projection (several apply and the column has a projection:
-- shown, never read), ambiguous (several apply, no projection: the row is refused), none (no task applies on the site), direct (the column has one field).
CREATE OR REPLACE FUNCTION tpl_master_candidates(p_site uuid, p_letter text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; n int; out jsonb; k int; proj text;
BEGIN
  SELECT count(*) INTO n FROM public.template_task_fields f WHERE f.master_col = p_letter AND f.is_active;
  SELECT * INTO s FROM public.sites x WHERE x.id = p_site;
  -- the caller learns nothing about a site outside their regions
  IF NOT FOUND OR NOT public.app_region_check(s.region_id) THEN RETURN NULL; END IF;
  WITH c AS (
    SELECT f.task_code, f.field_key, f.projection, f.read_only, ti.id AS task_id
    FROM public.template_task_fields f
    JOIN public.task_definitions td ON td.code = f.task_code AND td.workflow_id = s.workflow_version_id
    JOIN public.task_instances ti ON ti.site_id = s.id AND ti.task_def_id = td.id
    WHERE f.master_col = p_letter AND f.is_active AND NOT ti.is_na AND ti.state::text NOT IN ('na', 'skipped')
      AND (f.scenarios IS NULL OR s.delivery_scenario::text = ANY (f.scenarios))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('task', c.task_code, 'field', c.field_key, 'task_id', c.task_id, 'projection', c.projection, 'read_only', c.read_only)
           ORDER BY c.task_code COLLATE "C"), '[]'::jsonb), count(*), min(c.projection) FILTER (WHERE c.projection IS NOT NULL)
    INTO out, k, proj FROM c;
  RETURN jsonb_build_object('fields', n, 'candidates', out,
    'status', CASE WHEN n <= 1 THEN 'direct' WHEN k = 0 THEN 'none' WHEN k = 1 THEN 'single'
                   WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(out) x WHERE x ->> 'projection' IS NULL) THEN 'projection' ELSE 'ambiguous' END,
    'projection', proj);
END $$;

-- The Master sheet: a column with several task fields becomes one column `mx:<letter>` with its candidates; it is typed when one of its fields is typed
-- (the field is resolved per site on upload). Everything else is as in 0051.
CREATE OR REPLACE FUNCTION tpl_master_columns() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out jsonb;
BEGIN
  WITH tk AS (
    SELECT st.code AS stream, x.code AS task, x.mode
    FROM public.workflow_streams st CROSS JOIN LATERAL public.tpl_stream_tasks(st.code) x
    WHERE st.workflow_id = public.tpl_active_workflow()
  ), fm AS (
    SELECT f.master_col, count(*) AS n FROM public.template_task_fields f JOIN tk ON tk.task = f.task_code
    WHERE f.is_active AND f.master_col IS NOT NULL GROUP BY f.master_col
  ), m AS (
    SELECT mc.ord, mc.letter, mc.header, mc.owner, coalesce(fm.n, 0) AS n, f.task_code, f.field_key, f.field_type, f.options, f.read_only, tk.stream, tk.mode
    FROM public.master_columns mc
    LEFT JOIN fm ON fm.master_col = mc.letter
    LEFT JOIN public.template_task_fields f ON coalesce(fm.n, 0) = 1 AND f.master_col = mc.letter AND f.is_active
    LEFT JOIN tk ON tk.task = f.task_code
    WHERE mc.is_active
  ), mx AS (
    SELECT f.master_col,
      jsonb_agg(jsonb_strip_nulls(jsonb_build_object('task', f.task_code, 'field', f.field_key, 'stream', tk.stream, 'projection', f.projection, 'scenarios', to_jsonb(f.scenarios),
        'typed', NOT (f.read_only OR tk.mode <> 'edit' OR NOT public.tpl_field_writable(f.field_key))))
        ORDER BY f.task_code COLLATE "C") AS candidates,
      bool_or(NOT (f.read_only OR tk.mode <> 'edit' OR NOT public.tpl_field_writable(f.field_key))) AS typed,
      min(f.field_type) AS field_type, min(f.projection) AS projection
    FROM public.template_task_fields f JOIN tk ON tk.task = f.task_code
    WHERE f.is_active AND f.master_col IN (SELECT fm.master_col FROM fm WHERE fm.n > 1)
    GROUP BY f.master_col
  )
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(
    CASE WHEN m.owner = 'key' THEN jsonb_build_object('code', 'site_code', 'header', m.header, 'type', 'text', 'kind', 'site', 'required', true, 'derived', false, 'master_col', m.letter)
         WHEN m.n > 1 THEN jsonb_build_object('code', 'mx:' || m.letter, 'header', m.header, 'type', x.field_type, 'kind', 'task', 'required', false, 'derived', NOT x.typed,
           'field', 'mx', 'master_col', m.letter, 'candidates', x.candidates, 'projection', x.projection)
         WHEN m.task_code IS NOT NULL AND m.stream IS NOT NULL THEN jsonb_build_object('code', m.task_code || ':' || m.field_key, 'header', m.header, 'type', m.field_type, 'kind', 'task',
           'required', false, 'derived', m.read_only OR m.mode <> 'edit' OR NOT public.tpl_field_writable(m.field_key), 'options', m.options, 'task', m.task_code, 'field', m.field_key,
           'master_col', m.letter, 'stream', m.stream)
         ELSE jsonb_build_object('code', 'm:' || m.letter, 'header', m.header, 'type', 'text', 'kind', 'info', 'required', false, 'derived', true, 'master_col', m.letter, 'owner', m.owner)
    END) ORDER BY m.ord), '[]'::jsonb)
  INTO out FROM m LEFT JOIN mx x ON x.master_col = m.letter;
  RETURN out;
END $$;

-- the Master sheet of TPL-MASTER is rebuilt with the shared columns (the triggers of 0051 ran with the earlier function)
SELECT tpl_sync_all();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q206, Q208, Q209: the mode of a batch, held gate-locked rows, the actual start of a pending task
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE import_batches
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'submit' CHECK (mode IN ('submit', 'draft')),
  ADD COLUMN file_template_version INTEGER;
COMMENT ON COLUMN import_batches.mode IS 'Q206: submit (every row is entered and submitted for L2) or draft (Save Draft / Planning: the entry is saved, nothing is submitted).';
COMMENT ON COLUMN import_batches.file_template_version IS 'D112: the template version of the file when it was older than the current one and only non-input columns had changed.';
COMMENT ON COLUMN import_batches.source IS 'template (a register or stream template), master_template (a part of a TPL-MASTER file), master_import (the legacy import of the real Master, Q1).';

ALTER TABLE import_batch_rows DROP CONSTRAINT import_batch_rows_decision_check;
ALTER TABLE import_batch_rows ADD CONSTRAINT import_batch_rows_decision_check CHECK (decision IN ('pending', 'approved', 'rejected', 'pending_previous_approval', 'saved'));

-- A task with no Actual Start column on its template is a single-event task: its actual date is its start (Q209).
CREATE OR REPLACE FUNCTION imp_single_event(p_task text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.template_task_fields f WHERE f.task_code = p_task AND f.field_key = 'actual_start' AND f.is_active)
$$;

-- The start date of a pending task entered from a file (Q209): the actual start of the row, else the task's, else (single-event task) the actual date.
CREATE OR REPLACE FUNCTION imp_start_date(p_task_code text, p_fields jsonb, p_ti public.task_instances) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(nullif(p_fields ->> 'actual_start', '')::date, p_ti.actual_start,
                  CASE WHEN public.imp_single_event(p_task_code) THEN coalesce(nullif(p_fields ->> 'actual_date', '')::date, p_ti.actual_date) END)
$$;

DROP FUNCTION imp_stage_task_row(jsonb, jsonb, uuid, int[], int[], int[]);
-- One file row of a stream template (0051), with the mode of the batch. Changes: Q206 draft rows need no actual date or document; Q208 a gate-locked task
-- is held; Q209 a pending task needs its actual start.
CREATE OR REPLACE FUNCTION imp_stage_task_row(p_cols jsonb, p_row jsonb, p_task_site uuid, p_view int[], p_imp int[], p_edit int[], p_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
              e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'mandatory_slots_missing', 'Missing document(s): ' || array_to_string(missing, ', ') || '. Upload them on the task first.'));
            END IF;
          END IF;
          -- Q209: a pending task is started with its actual start, never with today; a planning row (draft, no actual date) does not start it
          IF jsonb_array_length(e) = 0 AND ti.state = 'open' AND (NOT draft OR p ? 'actual_start' OR p ? 'actual_date')
             AND public.imp_start_date(tc, p, ti) IS NULL THEN
            e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_start', 'actual_start_required',
              'The task is pending: type its Actual Start. GSDN Workspace never uses today as the start of an earlier piece of work (Q209).'));
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
END $$;

DROP FUNCTION imp_stage_stream_batch(text, int, text, text, text, uuid, jsonb, uuid, text, text);
-- A stream file (0051) with the mode of the batch. The version and checksum it gets are the current ones (imp_stage_batch handles an older file, D112).
CREATE OR REPLACE FUNCTION imp_stage_stream_batch(p_template text, p_version int, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb,
  p_group uuid, p_source text, p_sheet text, p_mode text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; r_import int[]; r_view int[]; r_edit int[]; task_site uuid;
  el jsonb; res jsonb; it jsonb; items jsonb; seen jsonb := '{}'::jsonb; results jsonb := '[]'::jsonb; bid uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
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
    res := public.imp_stage_task_row(v.columns, el, task_site, r_view, r_import, r_edit, p_mode);
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
  RETURN bid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. D112: the column-level diff between two versions of a template
-- ---------------------------------------------------------------------------------------------------------------------
-- The columns of a version as rows: key (the column code; part/code for TPL-MASTER), whether a user types it, and what a file of it means.
CREATE OR REPLACE FUNCTION tpl_version_cols(p_kind text, p_columns jsonb) RETURNS TABLE (key text, header text, input boolean, sig jsonb)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  WITH c AS (
    SELECT NULL::text AS part, NULL::text AS sheet, x AS col FROM jsonb_array_elements(CASE WHEN p_kind = 'master' THEN '[]'::jsonb ELSE coalesce(p_columns, '[]'::jsonb) END) x
    UNION ALL
    SELECT pt ->> 'part', pt ->> 'sheet', x FROM jsonb_array_elements(CASE WHEN p_kind = 'master' THEN coalesce(p_columns, '[]'::jsonb) ELSE '[]'::jsonb END) pt
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(pt -> 'columns', '[]'::jsonb)) x
  )
  SELECT coalesce(c.part || '/', '') || (c.col ->> 'code'), c.col ->> 'header',
         (c.col ->> 'kind') IN ('site', 'record_type', 'field', 'custom', 'record_id', 'task') AND NOT coalesce((c.col ->> 'derived')::boolean, false),
         jsonb_strip_nulls(jsonb_build_object('header', c.col ->> 'header', 'type', c.col ->> 'type', 'kind', c.col ->> 'kind', 'required', coalesce((c.col ->> 'required')::boolean, false),
           'options', CASE WHEN c.col ->> 'type' = 'list' THEN c.col -> 'options' END, 'task', c.col ->> 'task', 'field', c.col ->> 'field', 'sheet', c.sheet,
           'candidates', c.col -> 'candidates'))
  FROM c
$$;

-- D112. NULL when the version was never issued. compatible = no input column changed between p_version and the current version.
CREATE OR REPLACE FUNCTION tpl_version_compat(p_template text, p_version int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.template_definitions%ROWTYPE; o public.template_versions%ROWTYPE; c public.template_versions%ROWTYPE; inp jsonb; oth jsonb;
BEGIN
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM public.template_versions WHERE template_def_id = d.id AND version = p_version;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO c FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  WITH a AS (SELECT * FROM public.tpl_version_cols(d.kind, o.columns)), b AS (SELECT * FROM public.tpl_version_cols(d.kind, c.columns)),
  ch AS (
    SELECT coalesce(a.key, b.key) AS key, coalesce(b.header, a.header) AS header,
      CASE WHEN a.key IS NULL THEN 'added' WHEN b.key IS NULL THEN 'removed'
           WHEN a.input AND NOT b.input THEN 'no_longer_typed' WHEN b.input AND NOT a.input THEN 'now_typed' ELSE 'changed' END AS change,
      coalesce(a.input, false) OR coalesce(b.input, false) AS input
    FROM a FULL JOIN b ON b.key = a.key
    WHERE a.key IS NULL OR b.key IS NULL OR a.input IS DISTINCT FROM b.input OR a.sig IS DISTINCT FROM b.sig
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', ch.key, 'header', ch.header, 'change', ch.change) ORDER BY ch.key) FILTER (WHERE ch.input), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('key', ch.key, 'header', ch.header, 'change', ch.change) ORDER BY ch.key) FILTER (WHERE NOT ch.input), '[]'::jsonb)
    INTO inp, oth FROM ch;
  RETURN jsonb_build_object('template_id', p_template, 'kind', d.kind, 'from_version', p_version, 'to_version', c.version, 'is_current', o.is_current,
    'compatible', jsonb_array_length(inp) = 0, 'input_changes', inp, 'other_changes', oth);
END $$;

-- The refusal of an older file whose typed columns changed (the message names both versions and the columns, D112).
CREATE OR REPLACE FUNCTION tpl_refuse_outdated(p_compat jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE lst text;
BEGIN
  SELECT string_agg(coalesce(x ->> 'header', x ->> 'key') || ' (' || (x ->> 'change') || ')', ', ' ORDER BY x ->> 'key')
    INTO lst FROM (SELECT x FROM jsonb_array_elements(p_compat -> 'input_changes') x LIMIT 8) q;
  PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'input_changes', p_compat -> 'input_changes',
    'detail', 'This file was made from version ' || (p_compat ->> 'from_version') || ' of ' || (p_compat ->> 'template_id') || '; the current version is ' || (p_compat ->> 'to_version')
      || ', and typed columns changed between them: ' || coalesce(lst, '?') || CASE WHEN jsonb_array_length(p_compat -> 'input_changes') > 8 THEN ' ...' ELSE '' END
      || '. Download the template again (D112).'));
END $$;

-- The upload entry of pmis_app with the batch mode (Q206) and the older-version rule (D112). The 7-argument form of 0051 stays and means mode submit.
CREATE OR REPLACE FUNCTION imp_stage_batch(p_template text, p_version int, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb, p_mode text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
        'message', 'Save Draft / Planning is for the Site Register stream templates and the Master sheet; a register file is always submitted.'))));
    END IF;
  END IF;
  IF d.kind = 'stream' THEN
    bid := public.imp_stage_stream_batch(p_template, ver, cs, p_file_name, p_sha, p_task, p_rows, NULL, 'template', 'Data', coalesce(p_mode, 'submit'));
  ELSE
    bid := public.imp_stage_register_batch(p_template, ver, cs, p_file_name, p_sha, p_task, p_rows);
  END IF;
  IF bid IS NOT NULL AND file_v IS NOT NULL THEN
    UPDATE public.import_batches SET file_template_version = file_v WHERE id = bid;
    PERFORM public.log_audit_write('template.old_version_accepted', 'import_batch', bid::text, NULL,
      jsonb_build_object('template_id', p_template, 'file_version', file_v, 'current_version', ver, 'other_changes', jsonb_array_length(compat -> 'other_changes')), NULL);
  END IF;
  RETURN bid;
END $$;

CREATE OR REPLACE FUNCTION imp_stage_batch(p_template text, p_version int, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.imp_stage_batch(p_template, p_version, p_checksum, p_file_name, p_sha, p_task, p_rows, 'submit');
END $$;

-- TPL-MASTER (0051) with the mode, the source and the group of the caller, the per-site resolution of the shared Master columns (Q205) and the older-version
-- rule (D112). p_parts = [{sheet, header_checksum, rows}]; rows of the Master sheet carry `cells` keyed by the Master column codes (mx:<letter> included).
CREATE OR REPLACE FUNCTION imp_stage_master_core(p_template text, p_version int, p_file_name text, p_sha text, p_parts jsonb, p_mode text, p_source text, p_group uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
          bid := public.imp_stage_stream_batch(sd.template_id, sv.version, NULL, p_file_name, p_sha, NULL, srows, gid, p_source, 'Master', p_mode);
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
END $$;

CREATE OR REPLACE FUNCTION imp_stage_master(p_template text, p_version int, p_file_name text, p_sha text, p_parts jsonb, p_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.imp_stage_master_core(p_template, p_version, p_file_name, p_sha, p_parts, coalesce(p_mode, 'submit'), 'master_template', NULL);
END $$;

CREATE OR REPLACE FUNCTION imp_stage_master(p_template text, p_version int, p_file_name text, p_sha text, p_parts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.imp_stage_master_core(p_template, p_version, p_file_name, p_sha, p_parts, 'submit', 'master_template', NULL);
END $$;

-- Sending a stream batch (0051) with the mode (Q206), the hold of gate-locked rows (Q208) and the start date rule (Q209).
CREATE OR REPLACE FUNCTION imp_submit_stream_batch(p_batch uuid, p_version int, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
      PERFORM public.wf_submit(t.id, NULL, NULL, p_stepup);
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
END $$;

-- Decisions on a draft batch (Q206): there is no L2 decision. The uploader (or an admin) discards a batch that was not sent, and the uploader returns held
-- rows (Q208: the uploader may cancel a held row instead of sending it again).
CREATE OR REPLACE FUNCTION imp_decide_draft_batch(p_batch uuid, p_version int, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; n int := 0; new_st text; n_open int;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF p_action = 'discard' AND b.submitted_at IS NULL THEN
    RETURN public.imp_decide_stream_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  IF p_action <> 'reject' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A Save Draft / Planning batch has no L2 decision: its rows are saved, not submitted (Q206).'));
  END IF;
  IF b.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can return its held rows.'));
  END IF;
  IF coalesce(btrim(p_note), '') = '' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e WHERE coalesce(btrim(e ->> 'note'), '') <> '') THEN
    PERFORM public.wf_err('note_required');
  END IF;
  UPDATE public.import_batch_rows x SET decision = 'rejected', decided_by = actor, decided_at = now(), hold_reason = NULL,
      decision_note = coalesce(nullif(btrim((SELECT e ->> 'note' FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e WHERE (e ->> 'row_id')::uuid = x.id LIMIT 1)), ''), btrim(p_note))
    WHERE x.batch_id = p_batch AND x.action = 'update' AND x.decision IN ('pending', 'pending_previous_approval')
      AND (p_scope = 'all' OR x.id IN (SELECT (e ->> 'row_id')::uuid FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e));
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT count(*) INTO n_open FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action = 'update' AND x.decision IN ('pending', 'pending_previous_approval');
  new_st := CASE WHEN n_open > 0 THEN b.status
                 WHEN EXISTS (SELECT 1 FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.decision = 'saved') THEN 'applied' ELSE 'rejected' END;
  UPDATE public.import_batches SET status = new_st, version = version + 1, closed_at = CASE WHEN n_open = 0 THEN now() ELSE closed_at END WHERE id = p_batch;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id)
  VALUES ('import_batch_reject', 'import_batch', p_batch::text, jsonb_build_object('scope', p_scope, 'mode', 'draft', 'rejected', n, 'status', new_st), p_note, actor);
  RETURN jsonb_build_object('decided', n, 'approved', 0, 'rejected', n, 'held', '[]'::jsonb, 'failed', '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION imp_decide_batch(p_batch uuid, p_version int, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL AND b.mode = 'draft') THEN
    RETURN public.imp_decide_draft_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL) THEN
    RETURN public.imp_decide_stream_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  RETURN public.imp_decide_register_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q207: the template mapping screen
-- ---------------------------------------------------------------------------------------------------------------------
-- The columns of the stream templates and of the Master sheet as they would be now: [{template_id, kind, hash, headers[]}].
CREATE OR REPLACE FUNCTION tpl_mapping_snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out jsonb := '[]'::jsonb; d record; cols jsonb;
BEGIN
  FOR d IN SELECT x.template_id, x.kind, x.stream_code, x.current_version FROM public.template_definitions x WHERE x.kind IN ('stream', 'master') AND x.is_active ORDER BY x.sort_order, x.template_id LOOP
    cols := CASE WHEN d.kind = 'stream' THEN public.tpl_stream_columns(d.stream_code) ELSE public.tpl_master_columns() END;
    out := out || jsonb_build_array(jsonb_build_object('template_id', d.template_id, 'kind', d.kind, 'version', d.current_version,
      'columns', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', c ->> 'code', 'header', c ->> 'header', 'typed', NOT coalesce((c ->> 'derived')::boolean, false))), '[]'::jsonb) FROM jsonb_array_elements(cols) c)));
  END LOOP;
  RETURN out;
END $$;

-- Q207. p_changes = [{op: upsert | deactivate, task_code, field_key, label, label_ar, field_type, options, master_col, read_only, scenarios, projection}].
-- p_dry_run = the test: everything is applied and measured, then rolled back. The answer lists, per template, the columns added, removed or changed and
-- whether a new version is issued, and how many batches still in preview were made from the version in force.
CREATE OR REPLACE FUNCTION tpl_mapping_save(p_changes jsonb, p_reason text, p_dry_run boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); errs jsonb := '[]'::jsonb; ch jsonb; i int := 0; pth text; mode text; fk text; ro boolean; mc public.master_columns%ROWTYPE;
  before_s jsonb; after_s jsonb; impact jsonb := '[]'::jsonb; b jsonb; a jsonb; before_rows jsonb; after_rows jsonb; vers_before jsonb; vers_after jsonb; n int := 0;
BEGIN
  IF actor IS NULL OR NOT public.app_can('templates', 'edit') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Changing the template mapping needs templates edit for all regions (System Admin or a delegate).'));
  END IF;
  IF coalesce(char_length(btrim(p_reason)), 0) < 3 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason is required.'));
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) = 0 OR jsonb_array_length(p_changes) > 200 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/changes', 'code', 'required', 'message', 'List between 1 and 200 changes.'));
  END IF;
  FOR ch IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_changes) = 'array' THEN p_changes ELSE '[]'::jsonb END) x LOOP
    pth := '/changes/' || i; i := i + 1;
    fk := ch ->> 'field_key';
    IF coalesce(ch ->> 'op', '') NOT IN ('upsert', 'deactivate') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/op', 'code', 'invalid', 'message', 'op is upsert or deactivate.'));
      CONTINUE;
    END IF;
    mode := public.tpl_task_mode(ch ->> 'task_code');
    IF mode IS NULL THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/task_code', 'code', 'unknown_task', 'message', 'No active task of the workflow in force has this code.'));
      CONTINUE;
    END IF;
    IF fk IS NULL OR fk !~ '^(planned_date|planned_start|actual_start|actual_date|submitted_date|approved_date|external_party|v:[a-z0-9_]{1,60}|r:[a-z_]{2,40}\.[a-z0-9_]{1,60})$' THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/field_key', 'code', 'invalid', 'message', 'Not a task field key.'));
      CONTINUE;
    END IF;
    IF ch ->> 'op' = 'deactivate' THEN
      IF NOT EXISTS (SELECT 1 FROM public.template_task_fields f WHERE f.task_code = ch ->> 'task_code' AND f.field_key = fk) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', pth, 'code', 'not_found', 'message', 'This task field is not mapped.'));
      END IF;
      CONTINUE;
    END IF;
    ro := coalesce((ch ->> 'read_only')::boolean, false);
    IF NOT ro AND (NOT public.tpl_field_writable(fk) OR mode <> 'edit') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/read_only', 'code', 'calculated_field',
        'message', 'This field is set by the workflow, calculated or owned by a register: it stays read only (Q207).'));
    END IF;
    IF coalesce(btrim(ch ->> 'label'), '') = '' OR char_length(ch ->> 'label') > 80 THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/label', 'code', 'required', 'message', 'A label of at most 80 characters is required.'));
    END IF;
    IF coalesce(ch ->> 'field_type', 'text') NOT IN ('text', 'number', 'date', 'list', 'yes_no') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/field_type', 'code', 'invalid', 'message', 'field_type is text, number, date, list or yes_no.'));
    ELSIF ch ->> 'field_type' = 'list' AND (jsonb_typeof(ch -> 'options') IS DISTINCT FROM 'array' OR jsonb_array_length(ch -> 'options') = 0
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(ch -> 'options') o WHERE jsonb_typeof(o) <> 'string')) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/options', 'code', 'required', 'message', 'A list field needs its values.'));
    END IF;
    IF ch ->> 'master_col' IS NOT NULL THEN
      SELECT * INTO mc FROM public.master_columns m WHERE m.letter = ch ->> 'master_col' AND m.is_active;
      IF NOT FOUND THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/master_col', 'code', 'invalid', 'message', 'Not a column of the Master sheet.'));
      ELSIF mc.owner <> 'task' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/master_col', 'code', 'column_not_owned',
          'message', 'This Master column is ' || mc.owner || ': a task field never fills it (Q207, Q210).'));
      END IF;
    END IF;
    IF ch ->> 'projection' IS NOT NULL AND ch ->> 'projection' NOT IN ('earliest', 'latest') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/projection', 'code', 'invalid', 'message', 'projection is earliest or latest.'));
    END IF;
    IF ch -> 'scenarios' IS NOT NULL AND jsonb_typeof(ch -> 'scenarios') <> 'null' AND (jsonb_typeof(ch -> 'scenarios') <> 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ch -> 'scenarios') s WHERE s NOT IN ('new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'))) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', pth || '/scenarios', 'code', 'invalid', 'message', 'Delivery scenarios: new_build, expansion, hot_swap, cold_swap, relocation.'));
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.task_code, f.field_key), '[]'::jsonb) INTO before_rows
    FROM public.template_task_fields f WHERE (f.task_code, f.field_key) IN (SELECT x ->> 'task_code', x ->> 'field_key' FROM jsonb_array_elements(p_changes) x);
  before_s := public.tpl_mapping_snapshot();
  SELECT coalesce(jsonb_object_agg(d.template_id, d.current_version), '{}'::jsonb) INTO vers_before FROM public.template_definitions d WHERE d.kind IN ('stream', 'master');
  BEGIN
    FOR ch IN SELECT x FROM jsonb_array_elements(p_changes) x LOOP
      IF ch ->> 'op' = 'deactivate' THEN
        UPDATE public.template_task_fields SET is_active = false WHERE task_code = ch ->> 'task_code' AND field_key = ch ->> 'field_key';
      ELSE
        INSERT INTO public.template_task_fields (task_code, field_key, label, label_ar, field_type, options, master_col, read_only, is_active, scenarios, projection)
        VALUES (ch ->> 'task_code', ch ->> 'field_key', btrim(ch ->> 'label'), nullif(btrim(ch ->> 'label_ar'), ''), coalesce(ch ->> 'field_type', 'text'),
                CASE WHEN ch ->> 'field_type' = 'list' THEN ch -> 'options' END, ch ->> 'master_col', coalesce((ch ->> 'read_only')::boolean, false), true,
                CASE WHEN jsonb_typeof(ch -> 'scenarios') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(ch -> 'scenarios')) END, ch ->> 'projection')
        ON CONFLICT (task_code, field_key) DO UPDATE SET label = EXCLUDED.label, label_ar = EXCLUDED.label_ar, field_type = EXCLUDED.field_type, options = EXCLUDED.options,
          master_col = EXCLUDED.master_col, read_only = EXCLUDED.read_only, is_active = true, scenarios = EXCLUDED.scenarios, projection = EXCLUDED.projection;
      END IF;
      n := n + 1;
    END LOOP;
    after_s := public.tpl_mapping_snapshot();
    SELECT coalesce(jsonb_object_agg(d.template_id, d.current_version), '{}'::jsonb) INTO vers_after FROM public.template_definitions d WHERE d.kind IN ('stream', 'master');
    FOR a IN SELECT x FROM jsonb_array_elements(after_s) x LOOP
      SELECT x INTO b FROM jsonb_array_elements(before_s) x WHERE x ->> 'template_id' = a ->> 'template_id';
      CONTINUE WHEN b -> 'columns' = a -> 'columns';
      impact := impact || jsonb_build_array(jsonb_build_object('template_id', a ->> 'template_id', 'kind', a ->> 'kind',
        'version_before', (vers_before ->> (a ->> 'template_id'))::int, 'version_after', (vers_after ->> (a ->> 'template_id'))::int,
        'columns_added', (SELECT coalesce(jsonb_agg(c ->> 'header'), '[]'::jsonb) FROM jsonb_array_elements(a -> 'columns') c WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b -> 'columns') c2 WHERE c2 ->> 'code' = c ->> 'code')),
        'columns_removed', (SELECT coalesce(jsonb_agg(c ->> 'header'), '[]'::jsonb) FROM jsonb_array_elements(b -> 'columns') c WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'columns') c2 WHERE c2 ->> 'code' = c ->> 'code')),
        'columns_changed', (SELECT coalesce(jsonb_agg(c ->> 'header'), '[]'::jsonb) FROM jsonb_array_elements(a -> 'columns') c JOIN jsonb_array_elements(b -> 'columns') c2 ON c2 ->> 'code' = c ->> 'code' WHERE c2 <> c),
        'open_batches', (SELECT count(*) FROM public.import_batches ib JOIN public.template_versions tv ON tv.id = ib.template_version_id JOIN public.template_definitions td ON td.id = tv.template_def_id
                          WHERE td.template_id = a ->> 'template_id' AND ib.status = 'validated')));
    END LOOP;
    SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.task_code, f.field_key), '[]'::jsonb) INTO after_rows
      FROM public.template_task_fields f WHERE (f.task_code, f.field_key) IN (SELECT x ->> 'task_code', x ->> 'field_key' FROM jsonb_array_elements(p_changes) x);
    IF p_dry_run THEN RAISE EXCEPTION 'tpl:dry_run'; END IF;
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'tpl:dry_run' THEN RAISE; END IF;
  END;
  IF NOT p_dry_run THEN
    -- the versions the triggers issued carry the reason of the change
    UPDATE public.template_versions tv SET reason = left(btrim(p_reason), 500)
      FROM public.template_definitions d WHERE tv.template_def_id = d.id AND tv.is_current AND d.kind IN ('stream', 'master')
        AND (vers_before ->> d.template_id)::int IS DISTINCT FROM d.current_version;
    PERFORM public.log_audit_write('template_mapping.save', 'template_mapping', 'template_task_fields', jsonb_build_object('fields', before_rows),
      jsonb_build_object('fields', after_rows, 'impact', impact), btrim(p_reason));
  END IF;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'changes', n, 'impact', impact);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q8 and Q10: role and region aliases
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE region_aliases (
  alias      TEXT PRIMARY KEY CHECK (alias = lower(btrim(alias)) AND char_length(alias) BETWEEN 1 AND 80),
  label      TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  region_id  INTEGER NOT NULL REFERENCES regions (id),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  note       TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
COMMENT ON TABLE region_aliases IS 'Q10: the values of other files (the Master writes "Tripoli Area") that mean a region. Import and export convert through this table, never by cutting text; an unknown value is an import exception. Editing a label never changes the region of a record.';

CREATE TABLE role_aliases (
  alias      TEXT PRIMARY KEY CHECK (alias = lower(btrim(alias)) AND char_length(alias) BETWEEN 1 AND 80),
  label      TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  role_id    UUID REFERENCES roles (id),
  status     TEXT NOT NULL CHECK (status IN ('mapped', 'ambiguous', 'unmapped')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  note       TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CHECK ((status = 'mapped') = (role_id IS NOT NULL))
);
COMMENT ON TABLE role_aliases IS 'Q8: the Master StaffRole values and the stable PMIS role each one means, reviewed by the owner. A mapped value is a suggestion shown in the import preview, never a grant; ambiguous and unmapped values are import exceptions.';

INSERT INTO region_aliases (alias, label, region_id, note)
SELECT lower(x.alias), x.alias, r.id, x.note
FROM regions r CROSS JOIN LATERAL (VALUES (r.code, 'region code'), (r.name_en, 'English name'), (r.name_ar, 'Arabic name')) AS x(alias, note)
WHERE x.alias IS NOT NULL
ON CONFLICT (alias) DO NOTHING;
INSERT INTO region_aliases (alias, label, region_id, note)
SELECT lower(v.alias), v.alias, r.id, 'Master Setting list Region'
FROM (VALUES ('Tripoli Area', 'TRIPOLI'), ('Middle Area', 'MIDDLE'), ('WM Area', 'WM'), ('Zawia Area', 'ZAWIA'), ('Benghazi Area', 'BENGHAZI'), ('GM Area', 'GM'), ('Sebha Area', 'SEBHA')) AS v(alias, code)
JOIN regions r ON upper(r.code) = v.code
ON CONFLICT (alias) DO NOTHING;

-- The 15 StaffRole values of the Master Setting sheet. The owner has not approved a mapping yet (C list): none is mapped. The note keeps the proposal of Q8.
INSERT INTO role_aliases (alias, label, status, note) VALUES
  ('project manager', 'Project Manager', 'unmapped', 'proposal: Project Manager (awaiting owner approval, Q8)'),
  ('team lead (design & acquisition)', 'Team Lead (Design & Acquisition)', 'unmapped', 'proposal: RF & Design / Acquisition Team Lead (awaiting owner approval, Q8)'),
  ('team lead (cw)', 'Team Lead (CW)', 'unmapped', 'proposal: CW Team Lead (awaiting owner approval, Q8)'),
  ('team lead (gecol)', 'Team Lead (GECOL)', 'unmapped', 'proposal: GECOL Power Team (awaiting owner approval, Q8); keep the GECOL function'),
  ('team lead (fiber)', 'Team Lead (Fiber)', 'unmapped', 'proposal: HLC Fiber Team (awaiting owner approval, Q8); keep the Fiber function'),
  ('team lead (te)', 'Team Lead (TE)', 'unmapped', 'proposal: TE Team Lead (awaiting owner approval, Q8)'),
  ('site engineer', 'Site Engineer', 'ambiguous', 'CW or TE is not known: never mapped to CW automatically (Q8)'),
  ('rf engineer', 'RF Engineer', 'unmapped', 'proposal: RF Engineer (awaiting owner approval, Q8)'),
  ('power engineer', 'Power Engineer', 'unmapped', 'proposal: Power Engineer (awaiting owner approval, Q8)'),
  ('mw engineer', 'MW Engineer', 'unmapped', 'proposal: MW Engineer (awaiting owner approval, Q8)'),
  ('cw engineer', 'CW Engineer', 'unmapped', 'proposal: Site Engineers (CW) (awaiting owner approval, Q8)'),
  ('inventory supervisor', 'Inventory Supervisor', 'unmapped', 'proposal: Inventory Supervisor (awaiting owner approval, Q8)'),
  ('project support', 'Project Support', 'unmapped', 'proposal: Project Support (awaiting owner approval, Q8)'),
  ('acquisition team', 'Acquisition Team', 'unmapped', 'proposal: Acquisition Team (awaiting owner approval, Q8)'),
  ('other', 'Other', 'ambiguous', 'no PMIS role: review each person (Q8)')
ON CONFLICT (alias) DO NOTHING;

CREATE OR REPLACE FUNCTION imp_region_resolve(p_value text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.region_id FROM public.region_aliases a WHERE a.alias = lower(btrim(coalesce(p_value, ''))) AND a.is_active
$$;

CREATE OR REPLACE FUNCTION imp_role_resolve(p_value text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT jsonb_build_object('status', a.status, 'role_id', a.role_id, 'role_code', r.code, 'role_name', r.name_en)
                   FROM public.role_aliases a LEFT JOIN public.roles r ON r.id = a.role_id
                   WHERE a.alias = lower(btrim(coalesce(p_value, ''))) AND a.is_active),
                  jsonb_build_object('status', 'unknown'))
$$;

-- Q8 / Q10: saves one alias. p_kind region (p_target = region id or code) or role (p_target = role code, NULL with p_status ambiguous or unmapped).
CREATE OR REPLACE FUNCTION imp_alias_save(p_kind text, p_alias text, p_label text, p_target text, p_status text, p_active boolean, p_note text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); al text := lower(btrim(coalesce(p_alias, ''))); lbl text := btrim(coalesce(p_label, p_alias, '')); before jsonb; after jsonb; rid int; ro uuid; st text;
  errs jsonb := '[]'::jsonb;
BEGIN
  IF actor IS NULL OR NOT public.app_can('templates', 'edit') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The import aliases need templates edit for all regions (System Admin or a delegate).'));
  END IF;
  IF p_kind NOT IN ('region', 'role') THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/kind', 'code', 'invalid', 'message', 'kind is region or role.')); END IF;
  IF char_length(al) NOT BETWEEN 1 AND 80 THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/alias', 'code', 'required', 'message', 'The value is 1 to 80 characters.')); END IF;
  IF coalesce(char_length(btrim(p_reason)), 0) < 3 THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason is required.')); END IF;
  IF p_kind = 'region' THEN
    SELECT r.id INTO rid FROM public.regions r WHERE r.id::text = btrim(coalesce(p_target, '')) OR upper(r.code) = upper(btrim(coalesce(p_target, '')));
    IF rid IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/target', 'code', 'invalid', 'message', 'Name one of the 7 regions.')); END IF;
  ELSIF p_kind = 'role' THEN
    IF nullif(btrim(coalesce(p_target, '')), '') IS NOT NULL THEN
      SELECT r.id INTO ro FROM public.roles r WHERE r.code = btrim(p_target) AND r.is_active;
      IF ro IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/target', 'code', 'invalid', 'message', 'No active role has this code.')); END IF;
      st := 'mapped';
    ELSE
      st := coalesce(p_status, 'unmapped');
      IF st NOT IN ('ambiguous', 'unmapped') THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/status', 'code', 'invalid', 'message', 'Without a role the value is ambiguous or unmapped.')); END IF;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF p_kind = 'region' THEN
    SELECT to_jsonb(a) INTO before FROM public.region_aliases a WHERE a.alias = al;
    INSERT INTO public.region_aliases (alias, label, region_id, is_active, note, updated_by, updated_at)
    VALUES (al, left(lbl, 80), rid, coalesce(p_active, true), left(p_note, 500), actor, now())
    ON CONFLICT (alias) DO UPDATE SET label = EXCLUDED.label, region_id = EXCLUDED.region_id, is_active = EXCLUDED.is_active, note = EXCLUDED.note, updated_by = actor, updated_at = now();
    SELECT to_jsonb(a) INTO after FROM public.region_aliases a WHERE a.alias = al;
  ELSE
    SELECT to_jsonb(a) INTO before FROM public.role_aliases a WHERE a.alias = al;
    INSERT INTO public.role_aliases (alias, label, role_id, status, is_active, note, updated_by, updated_at)
    VALUES (al, left(lbl, 80), ro, st, coalesce(p_active, true), left(p_note, 500), actor, now())
    ON CONFLICT (alias) DO UPDATE SET label = EXCLUDED.label, role_id = EXCLUDED.role_id, status = EXCLUDED.status, is_active = EXCLUDED.is_active, note = EXCLUDED.note,
      updated_by = actor, updated_at = now();
    SELECT to_jsonb(a) INTO after FROM public.role_aliases a WHERE a.alias = al;
  END IF;
  PERFORM public.log_audit_write('import_alias.save', p_kind || '_alias', al, before, after, btrim(p_reason));
  RETURN after;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Q11: the Issue Log in the Master columns GA:GE
-- ---------------------------------------------------------------------------------------------------------------------
-- The oldest open issue of the site (raised date, then record id); with none open, the latest closed one (resolution or raised date, then record id).
-- The remark keeps its text and gets "(+N more)" when the site has other issues. The full Issue Log is exported by its own register (TPL-ISS).
CREATE OR REPLACE FUNCTION mx_issue_cells(p_site uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pick record; n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = p_site AND public.app_region_check(s.region_id)) THEN RETURN NULL; END IF;
  WITH i AS (
    SELECT r.entity_id, r.data, r.external_party_id, nullif(r.data ->> 'raised_date', '')::date AS raised, nullif(r.data ->> 'resolution_date', '')::date AS resolved,
           lower(coalesce(r.data ->> 'issue_status', '')) ~ '^(closed|resolved|done|cancel)' AS closed
    FROM public.register_records r WHERE r.register_key = 'issues' AND r.is_current AND r.site_id = p_site AND r.state <> 'voided'
  )
  SELECT * INTO pick FROM (
    (SELECT i.*, 0 AS grp FROM i WHERE NOT i.closed ORDER BY i.raised NULLS LAST, i.entity_id LIMIT 1)
    UNION ALL
    (SELECT i.*, 1 FROM i WHERE i.closed ORDER BY coalesce(i.resolved, i.raised) DESC NULLS LAST, i.entity_id DESC LIMIT 1)
  ) q ORDER BY q.grp LIMIT 1;
  IF pick IS NULL OR pick.entity_id IS NULL THEN RETURN jsonb_build_object('GA', NULL, 'GB', NULL, 'GC', NULL, 'GD', NULL, 'GE', NULL, 'count', 0); END IF;
  SELECT count(*) INTO n FROM public.register_records r WHERE r.register_key = 'issues' AND r.is_current AND r.site_id = p_site AND r.state <> 'voided';
  RETURN jsonb_build_object(
    'GA', pick.data ->> 'pending_issue',
    'GB', coalesce((SELECT u.display_name FROM public.users u WHERE u.id::text = pick.data ->> 'owner_user'),
                   (SELECT ep.name FROM public.external_parties ep WHERE ep.id = pick.external_party_id), pick.data ->> 'owner_text'),
    'GC', pick.raised::text,
    'GD', pick.data ->> 'issue_status',
    'GE', nullif(btrim(coalesce(pick.data ->> 'remark', '') || CASE WHEN n > 1 THEN ' (+' || (n - 1) || ' more)' ELSE '' END), ''),
    'count', n, 'entity_id', pick.entity_id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q1 and Q211: the legacy Master import and the comparison report of the parallel run
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE master_reconciliation_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name    TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  file_sha256  TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size    BIGINT NOT NULL CHECK (file_size > 0),
  storage_key  TEXT,                                -- the original file, kept as uploaded (never rewritten, never given a _tpl sheet)
  structure    JSONB NOT NULL,                      -- the identification and structure check
  summary      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'applied')),
  created_by   UUID NOT NULL REFERENCES users (id),
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  applied_by   UUID REFERENCES users (id),
  applied_at   TIMESTAMPTZ(6),
  apply_reason TEXT,
  apply_mode   TEXT CHECK (apply_mode IN ('submit', 'draft')),
  group_id     UUID,                                -- the import batches the apply created (source master_import)
  outcome      JSONB,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX master_reconciliation_runs_created_idx ON master_reconciliation_runs (created_at DESC, id DESC);
CREATE INDEX master_reconciliation_runs_sha_idx ON master_reconciliation_runs (file_sha256);
COMMENT ON TABLE master_reconciliation_runs IS 'Q1 / Q211: one upload of the real Site Master (no _tpl) through the admin-only legacy path: the file, its hash, the stored original, the structure check, the comparison summary, and the apply.';

CREATE TABLE master_reconciliation_rows (
  run_id    UUID NOT NULL REFERENCES master_reconciliation_runs (id) ON DELETE RESTRICT,
  row_no    INTEGER NOT NULL,
  site_code TEXT,
  site_id   UUID,
  region_id INTEGER,
  cells     JSONB NOT NULL,                         -- {letter: {v, f}} in Master column letters (f = the cell held a formula, v its cached value)
  PRIMARY KEY (run_id, row_no)
);

CREATE TABLE master_reconciliation_diffs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES master_reconciliation_runs (id) ON DELETE RESTRICT,
  ord             INTEGER NOT NULL,
  sheet           TEXT NOT NULL,
  row_no          INTEGER,
  source_ref      TEXT,                             -- Sheet!row of the file
  site_code       TEXT,
  site_id         UUID,
  region_id       INTEGER,
  master_col      TEXT,
  header          TEXT,
  field           TEXT,                             -- what GSDN Workspace holds the value in (task:field, site field, issue projection)
  master_value    TEXT,
  pmis_value      TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('diff', 'missing_in_pmis', 'missing_in_master', 'exception')),
  reason          TEXT NOT NULL,
  applicable      BOOLEAN NOT NULL DEFAULT false,   -- a typed task column: the apply can enter it through the batch flow
  resolution      TEXT NOT NULL DEFAULT 'open' CHECK (resolution IN ('open', 'pmis_correct', 'master_correct', 'fixed', 'ignored')),
  resolution_note TEXT,
  resolved_by     UUID REFERENCES users (id),
  resolved_at     TIMESTAMPTZ(6)
);
CREATE INDEX master_reconciliation_diffs_run_idx ON master_reconciliation_diffs (run_id, ord);
CREATE INDEX master_reconciliation_diffs_site_idx ON master_reconciliation_diffs (run_id, site_code);

-- Who may use the legacy path and read the comparison report: a System Admin or a delegate of templates administer (all regions).
CREATE OR REPLACE FUNCTION mi_can_use() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_has_session() AND public.app_actor() IS NOT NULL AND public.app_can('templates', 'administer')
$$;

ALTER TABLE master_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_reconciliation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON master_reconciliation_runs FOR SELECT USING (mi_can_use());
ALTER TABLE master_reconciliation_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_reconciliation_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON master_reconciliation_rows FOR SELECT USING (mi_can_use() AND (region_id IS NULL OR app_region_check(region_id)));
ALTER TABLE master_reconciliation_diffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_reconciliation_diffs FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON master_reconciliation_diffs FOR SELECT USING (mi_can_use() AND (region_id IS NULL OR app_region_check(region_id)));
ALTER TABLE region_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON region_aliases FOR SELECT USING (true);
ALTER TABLE role_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON role_aliases FOR SELECT USING (true);

-- The text the comparison uses: trimmed, spaces collapsed, lower case; a number without trailing zeros; a date as yyyy-mm-dd.
CREATE OR REPLACE FUNCTION mi_norm(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE s text := lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'));
BEGIN
  IF s IN ('', '-') THEN RETURN NULL; END IF;
  IF s ~ '^\d{4}-\d{2}-\d{2}([ t].*)?$' THEN RETURN substr(s, 1, 10); END IF;
  IF s ~ '^-?\d+(\.\d+)?$' THEN RETURN trim_scale(s::numeric)::text; END IF;
  RETURN s;
END $$;

-- What GSDN Workspace holds for one site in every Master column it compares: {letter: text}. A letter that is missing is not compared.
CREATE OR REPLACE FUNCTION mi_pmis_row(p_site uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; out jsonb; f record; v text; res jsonb; vals text[]; iss jsonb;
  yn CONSTANT jsonb := '{"yes": "Yes", "na": "N/A"}';
BEGIN
  SELECT x.*, r.name_en AS region_name, c.cluster_code INTO s FROM public.sites x JOIN public.regions r ON r.id = x.region_id LEFT JOIN public.clusters c ON c.id = x.cluster_id WHERE x.id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;
  out := jsonb_build_object('B', s.site_code, 'C', s.owner_site_id, 'D', s.name, 'E', s.region_name, 'F', s.sub_region, 'G', s.cluster_code,
    'H', s.latitude::text, 'I', s.longitude::text, 'J', s.site_type, 'K', s.site_scenario, 'L', s.uplink_site, 'M', s.tower_owner, 'N', s.existing_or_new,
    'O', s.rt_or_gf, 'P', s.tower_type, 'Q', s.tower_height_m::text, 'R', s.config_summary, 'S', s.rf_survey_date::text, 'T', s.acquisition_date::text,
    'X', s.project_phase, 'Y', s.delivery_batch,
    'Z', CASE s.delivery_scenario::text WHEN 'new_build' THEN 'New Build' WHEN 'expansion' THEN 'Expansion' WHEN 'hot_swap' THEN 'Hot Swap' WHEN 'cold_swap' THEN 'Cold Swap' WHEN 'relocation' THEN 'Relocation' END,
    'AA', yn ->> s.scope_tower_erection::text, 'AB', yn ->> s.scope_site_adaption::text, 'AC', yn ->> s.scope_gecol_power::text, 'AD', yn ->> s.scope_hlc_fiber::text,
    'AE', yn ->> s.scope_te_full::text, 'AF', yn ->> s.scope_te_ip_router_only::text, 'AG', s.cw_delivery_model);
  -- the task columns (a shared column through its candidates, Q205)
  FOR f IN SELECT DISTINCT ON (x.master_col) x.master_col, count(*) OVER (PARTITION BY x.master_col) AS n, x.task_code, x.field_key
           FROM public.template_task_fields x JOIN public.master_columns m ON m.letter = x.master_col AND m.is_active
           WHERE x.is_active AND x.master_col IS NOT NULL ORDER BY x.master_col, x.task_code LOOP
    IF f.n > 1 THEN
      res := public.tpl_master_candidates(p_site, f.master_col);
      IF res ->> 'status' = 'ambiguous' THEN out := out || jsonb_build_object(f.master_col, NULL); CONTINUE; END IF;
      SELECT array_agg(public.mi_task_value(p_site, c ->> 'task', c ->> 'field')) INTO vals FROM jsonb_array_elements(res -> 'candidates') c;
      v := CASE WHEN res ->> 'status' = 'projection' AND res ->> 'projection' = 'earliest' THEN (SELECT min(x) FROM unnest(vals) x)
                WHEN res ->> 'status' = 'projection' THEN (SELECT max(x) FROM unnest(vals) x)
                ELSE vals[1] END;
    ELSE
      v := public.mi_task_value(p_site, f.task_code, f.field_key);
    END IF;
    out := out || jsonb_build_object(f.master_col, v);
  END LOOP;
  iss := public.mx_issue_cells(p_site);
  out := out || jsonb_build_object('GA', iss ->> 'GA', 'GB', iss ->> 'GB', 'GC', iss ->> 'GC', 'GD', iss ->> 'GD', 'GE', iss ->> 'GE');
  RETURN out;
END $$;

-- One field of one task of a site, as text (dates yyyy-mm-dd). NULL when the site has no such task or it is N/A.
CREATE OR REPLACE FUNCTION mi_task_value(p_site uuid, p_task text, p_field text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ti public.task_instances%ROWTYPE; m text[];
BEGIN
  SELECT x.* INTO ti FROM public.task_instances x JOIN public.sites s ON s.id = x.site_id JOIN public.task_definitions td ON td.id = x.task_def_id AND td.workflow_id = s.workflow_version_id
  WHERE x.site_id = p_site AND td.code = p_task;
  IF NOT FOUND OR ti.is_na THEN RETURN NULL; END IF;
  RETURN CASE p_field
    WHEN 'planned_date' THEN ti.planned_date::text WHEN 'planned_start' THEN ti.planned_start::text WHEN 'actual_start' THEN ti.actual_start::text
    WHEN 'actual_date' THEN ti.actual_date::text WHEN 'submitted_date' THEN ti.submitted_date::text WHEN 'approved_date' THEN ti.approved_date::text
    WHEN 'external_party' THEN (SELECT ep.name FROM public.external_parties ep WHERE ep.id = ti.external_party_id)
    ELSE CASE WHEN p_field LIKE 'v:%' THEN ti.values ->> substr(p_field, 3)
              WHEN p_field LIKE 'r:%' THEN (
                SELECT r.data ->> split_part(substr(p_field, 3), '.', 2) FROM public.register_records r
                WHERE r.register_key = split_part(substr(p_field, 3), '.', 1) AND r.site_id = p_site AND r.state = 'approved' AND r.is_current ORDER BY r.version_no DESC LIMIT 1) END
  END;
END $$;

-- The column metadata the comparison needs: one row per active Master column with its owner, the field it maps and whether a user types it.
CREATE OR REPLACE FUNCTION mi_columns() RETURNS TABLE (ord int, letter text, header text, owner text, field text, typed boolean, shared boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH q AS (SELECT DISTINCT ON (x ->> 'master_col') x ->> 'master_col' AS letter, x AS c FROM jsonb_array_elements(public.tpl_master_columns()) x ORDER BY x ->> 'master_col')
  SELECT mc.ord, mc.letter, mc.header, mc.owner, q.c ->> 'code', NOT coalesce((q.c ->> 'derived')::boolean, true) AND q.c ->> 'kind' = 'task', coalesce(q.c ->> 'code' LIKE 'mx:%', false)
  FROM public.master_columns mc LEFT JOIN q ON q.letter = mc.letter
  WHERE mc.is_active
$$;

-- Q1 / Q211. Identifies the uploaded file as the Site Master, checks its structure and writes the comparison with what GSDN Workspace holds. Nothing else changes.
-- p_sheets = [sheet names]; p_headers = [{col, header}] of the Master sheet (the header of a column is its group and name, as in master_columns);
-- p_rows = [{row_no, cells: {file column letter: {v, f}}}]; p_staff = [{row_no, name, role, region, status}] (Setting sheet, Project Staff).
CREATE OR REPLACE FUNCTION mi_stage_run(p_file_name text, p_sha text, p_size bigint, p_storage_key text, p_sheets jsonb, p_headers jsonb, p_rows jsonb, p_staff jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); rid uuid := gen_random_uuid(); cols record; fmap jsonb := '{}'::jsonb; missing jsonb := '[]'::jsonb; moved jsonb := '[]'::jsonb;
  extra jsonb := '[]'::jsonb; found int := 0; total int := 0; miss_input jsonb := '[]'::jsonb; h jsonb; el jsonb; cells jsonb; k text; val jsonb; site public.sites%ROWTYPE;
  scode text; pm jsonb; mv text; pv text; nm text; np text; ord int := 0; matches int := 0; compared int := 0; n_rows int := 0; n_sites int := 0; n_unknown int := 0;
  seen jsonb := '{}'::jsonb; cmeta jsonb := '[]'::jsonb; c jsonb; reason text; kind text; appl boolean; isf boolean; regs int[] := ARRAY[]::int[]; st jsonb; rr jsonb;
  rg int; v_structure jsonb; v_summary jsonb; cst text; staff_mapped int := 0; expected_sheets jsonb; sheets_missing jsonb; ignored int := 0;
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  IF p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'invalid', 'message', 'The file hash is missing.'))));
  END IF;
  -- 1. identification: the sheet Master and the Master headers
  IF NOT coalesce(p_sheets ? 'Master', false) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'not_a_master', 'detail', 'This file is not the Site Master: it has no sheet "Master". Upload the real Master, or a PMIS template through Upload.'));
  END IF;
  FOR cols IN SELECT * FROM public.mi_columns() ORDER BY 1 LOOP
    total := total + 1;
    -- the header as master_columns stores it, or as the three header rows of the Master compose it (group / name: "Identification / Site ID")
    SELECT x INTO h FROM jsonb_array_elements(coalesce(p_headers, '[]'::jsonb)) x
      WHERE btrim(x ->> 'header') = cols.header
         OR btrim(x ->> 'header') = (SELECT m.group_mid || ' / ' || m.name FROM public.master_columns m WHERE m.letter = cols.letter AND m.name IS NOT NULL)
      ORDER BY (btrim(x ->> 'header') = cols.header) DESC LIMIT 1;
    IF h IS NULL THEN
      missing := missing || jsonb_build_array(jsonb_build_object('letter', cols.letter, 'header', cols.header, 'typed', coalesce(cols.typed, false)));
      IF coalesce(cols.typed, false) OR cols.owner = 'key' THEN miss_input := miss_input || jsonb_build_array(cols.header); END IF;
    ELSE
      found := found + 1;
      fmap := fmap || jsonb_build_object(h ->> 'col', cols.letter);
      IF h ->> 'col' <> cols.letter THEN moved := moved || jsonb_build_array(jsonb_build_object('header', cols.header, 'expected', cols.letter, 'found', h ->> 'col')); END IF;
    END IF;
    cmeta := cmeta || jsonb_build_array(jsonb_build_object('letter', cols.letter, 'header', cols.header, 'owner', cols.owner, 'field', cols.field, 'typed', coalesce(cols.typed, false), 'shared', coalesce(cols.shared, false)));
  END LOOP;
  SELECT coalesce(jsonb_agg(x ->> 'header'), '[]'::jsonb) INTO extra FROM jsonb_array_elements(coalesce(p_headers, '[]'::jsonb)) x
    WHERE coalesce(btrim(x ->> 'header'), '') <> '' AND NOT EXISTS (SELECT 1 FROM public.master_columns m WHERE m.is_active AND m.header = btrim(x ->> 'header'));
  SELECT coalesce(jsonb_agg(tp.sheet_name ORDER BY tp.sort_order), '[]'::jsonb) INTO expected_sheets FROM public.template_parts tp WHERE tp.template_id = 'TPL-MASTER';
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO sheets_missing FROM jsonb_array_elements_text(expected_sheets) x WHERE NOT (p_sheets ? x);
  v_structure := jsonb_build_object('identified', NOT (fmap ? '') AND fmap <> '{}'::jsonb AND found * 10 >= total * 9 AND EXISTS (SELECT 1 FROM jsonb_each_text(fmap) e WHERE e.value = 'B'),
    'columns_expected', total, 'columns_found', found, 'missing', missing, 'moved', moved, 'extra', extra, 'missing_typed', miss_input,
    'sheets', p_sheets, 'register_sheets_missing', sheets_missing, 'has_tpl', p_sheets ? '_tpl');
  IF NOT (v_structure ->> 'identified')::boolean THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'not_a_master', 'detail', 'This file is not the Site Master: only ' || found || ' of the ' || total ||
      ' Master column headers were found (the Site ID column is required). Upload the real Master as it is, without changing its header rows.'));
  END IF;
  IF jsonb_array_length(miss_input) > 0 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'structure_mismatch', 'detail', 'The Master sheet lacks typed column(s): ' ||
      (SELECT string_agg(x, ', ') FROM (SELECT jsonb_array_elements_text(miss_input) x LIMIT 6) q) || CASE WHEN jsonb_array_length(miss_input) > 6 THEN ' ...' ELSE '' END ||
      '. The file cannot be compared or applied.'));
  END IF;
  IF jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'size_or_rows_exceeded', 'detail', 'The Master sheet has more than 5000 rows.'));
  END IF;

  INSERT INTO public.master_reconciliation_runs (id, file_name, file_sha256, file_size, storage_key, structure, created_by)
  VALUES (rid, left(p_file_name, 200), p_sha, p_size, p_storage_key, v_structure, actor);

  -- 2. every row: the cells in Master letters, the site, the comparison with what GSDN Workspace holds
  FOR el IN SELECT x FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x LOOP
    cells := '{}'::jsonb;
    FOR k, val IN SELECT * FROM jsonb_each(coalesce(el -> 'cells', '{}'::jsonb)) LOOP
      IF fmap ? k THEN cells := cells || jsonb_build_object(fmap ->> k, val); END IF;
    END LOOP;
    scode := nullif(btrim(cells -> 'B' ->> 'v'), '');
    CONTINUE WHEN scode IS NULL;
    n_rows := n_rows + 1;
    SELECT * INTO site FROM public.sites x WHERE upper(x.site_code) = upper(scode) AND public.app_region_check(x.region_id);
    INSERT INTO public.master_reconciliation_rows (run_id, row_no, site_code, site_id, region_id, cells)
    VALUES (rid, (el ->> 'row_no')::int, scode, site.id, site.region_id, cells) ON CONFLICT DO NOTHING;
    IF seen ? upper(scode) THEN
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, site_id, region_id, master_col, header, field, master_value, kind, reason)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), scode, site.id, site.region_id, 'B', 'Site ID', 'site', scode, 'exception', 'duplicate_in_file');
      CONTINUE;
    END IF;
    seen := seen || jsonb_build_object(upper(scode), el ->> 'row_no');
    IF site.id IS NULL THEN
      n_unknown := n_unknown + 1; ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, master_col, header, field, master_value, kind, reason)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), scode, 'B', 'Site ID', 'site', scode, 'missing_in_pmis', 'site_not_in_pmis');
      CONTINUE;
    END IF;
    n_sites := n_sites + 1;
    IF NOT (site.region_id = ANY (regs)) THEN regs := regs || site.region_id; END IF;
    pm := public.mi_pmis_row(site.id);
    FOR c IN SELECT x FROM jsonb_array_elements(cmeta) x LOOP
      CONTINUE WHEN c ->> 'letter' IN ('A', 'B');
      isf := coalesce((cells -> (c ->> 'letter') ->> 'f')::boolean, false);
      mv := cells -> (c ->> 'letter') ->> 'v';
      IF NOT (pm ? (c ->> 'letter')) THEN
        IF mv IS NOT NULL THEN ignored := ignored + 1; END IF;
        CONTINUE;                                                        -- a column GSDN Workspace does not compare (calculated gates, SLA, Dismantle ...)
      END IF;
      pv := pm ->> (c ->> 'letter');
      compared := compared + 1;
      reason := NULL; kind := 'diff'; appl := false;
      IF c ->> 'letter' = 'E' THEN
        IF mv IS NOT NULL THEN
          rg := public.imp_region_resolve(mv);
          IF rg IS NULL THEN kind := 'exception'; reason := 'region_alias_unknown';
          ELSIF rg = site.region_id THEN matches := matches + 1; CONTINUE;
          ELSE reason := 'owned_elsewhere'; END IF;
        ELSE matches := matches + 1; CONTINUE;
        END IF;
      ELSE
        nm := public.mi_norm(mv); np := public.mi_norm(pv);
        cst := CASE WHEN coalesce((c ->> 'shared')::boolean, false) THEN public.tpl_master_candidates(site.id, c ->> 'letter') ->> 'status' END;
        IF cst = 'ambiguous' AND nm IS NULL THEN matches := matches + 1; CONTINUE; END IF;
        IF cst IS DISTINCT FROM 'ambiguous' AND nm IS NOT DISTINCT FROM np THEN matches := matches + 1; CONTINUE; END IF;
        IF cst = 'ambiguous' THEN
          kind := 'exception'; reason := 'ambiguous_mapping';
        ELSIF c ->> 'owner' = 'task' AND coalesce((c ->> 'typed')::boolean, false) THEN
          IF isf THEN kind := 'exception'; reason := 'formula_in_input';
          ELSIF mv IS NULL THEN reason := 'empty_in_master';
          ELSE reason := 'value_differs'; appl := true; END IF;
        ELSIF c ->> 'owner' IN ('task', 'calc') THEN reason := 'calculated';
        ELSIF c ->> 'owner' = 'issues' THEN reason := 'issue_projection';
        ELSE reason := 'owned_elsewhere'; END IF;
      END IF;
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, site_id, region_id, master_col, header, field, master_value, pmis_value, kind, reason, applicable)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), site.site_code, site.id, site.region_id, c ->> 'letter', c ->> 'header',
              coalesce(c ->> 'field', c ->> 'owner'), left(mv, 1000), left(pv, 1000), kind, reason, appl);
    END LOOP;
  END LOOP;

  -- 3. the sites of the regions the file covers that the file does not hold
  IF cardinality(regs) > 0 THEN
    FOR site IN SELECT x.* FROM public.sites x WHERE x.is_active AND x.overall_status::text <> 'cancelled' AND x.region_id = ANY (regs) AND public.app_region_check(x.region_id)
                  AND NOT (seen ? upper(x.site_code)) ORDER BY x.site_code LOOP
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, site_code, site_id, region_id, master_col, header, field, pmis_value, kind, reason)
      VALUES (rid, ord, 'Master', site.site_code, site.id, site.region_id, 'B', 'Site ID', 'site', site.site_code, 'missing_in_master', 'site_not_in_master');
    END LOOP;
  END IF;

  -- 4. Q8 / Q10: the Project Staff of the Setting sheet. A mapped role is a suggestion only; nothing is granted.
  FOR st IN SELECT x FROM jsonb_array_elements(coalesce(p_staff, '[]'::jsonb)) x LOOP
    CONTINUE WHEN coalesce(btrim(st ->> 'name'), '') = '' AND coalesce(btrim(st ->> 'role'), '') = '';
    IF coalesce(btrim(st ->> 'role'), '') <> '' THEN
      rr := public.imp_role_resolve(st ->> 'role');
      IF rr ->> 'status' = 'mapped' THEN staff_mapped := staff_mapped + 1;
      ELSE
        ord := ord + 1;
        INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, master_col, header, field, master_value, pmis_value, kind, reason)
        VALUES (rid, ord, 'Setting', (st ->> 'row_no')::int, 'Setting!' || (st ->> 'row_no'), 'J', 'Project Staff / Role', 'role_aliases', left(st ->> 'role', 200), left(st ->> 'name', 200), 'exception',
                CASE rr ->> 'status' WHEN 'ambiguous' THEN 'role_ambiguous' WHEN 'unmapped' THEN 'role_unmapped' ELSE 'role_unknown' END);
      END IF;
    END IF;
    IF coalesce(btrim(st ->> 'region'), '') <> '' AND public.imp_region_resolve(st ->> 'region') IS NULL THEN
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, master_col, header, field, master_value, pmis_value, kind, reason)
      VALUES (rid, ord, 'Setting', (st ->> 'row_no')::int, 'Setting!' || (st ->> 'row_no'), 'K', 'Project Staff / Region', 'region_aliases', left(st ->> 'region', 200), left(st ->> 'name', 200), 'exception', 'region_alias_unknown');
    END IF;
  END LOOP;

  SELECT jsonb_build_object('rows', n_rows, 'sites_matched', n_sites, 'sites_unknown', n_unknown, 'cells_compared', compared, 'matches', matches, 'cells_not_compared', ignored,
    'diffs', count(*) FILTER (WHERE d.kind = 'diff'), 'missing_in_pmis', count(*) FILTER (WHERE d.kind = 'missing_in_pmis'),
    'missing_in_master', count(*) FILTER (WHERE d.kind = 'missing_in_master'), 'exceptions', count(*) FILTER (WHERE d.kind = 'exception'),
    'applicable', count(*) FILTER (WHERE d.applicable), 'staff_mapped', staff_mapped, 'staff_rows', jsonb_array_length(coalesce(p_staff, '[]'::jsonb)),
    'by_reason', coalesce((SELECT jsonb_object_agg(q.reason, q.n) FROM (SELECT x.reason, count(*) AS n FROM public.master_reconciliation_diffs x WHERE x.run_id = rid GROUP BY x.reason) q), '{}'::jsonb))
    INTO v_summary FROM public.master_reconciliation_diffs d WHERE d.run_id = rid;
  UPDATE public.master_reconciliation_runs SET summary = v_summary WHERE id = rid;
  PERFORM public.log_audit_write('master_import.preview', 'master_reconciliation_run', rid::text, NULL,
    jsonb_build_object('file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'file_size', p_size, 'storage_key', p_storage_key, 'summary', v_summary, 'structure_moved', jsonb_array_length(moved)), NULL);
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: previewed',
    jsonb_build_object('run_id', rid, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'rows', n_rows, 'diffs', v_summary -> 'diffs', 'exceptions', v_summary -> 'exceptions'), actor, NULL);
  RETURN rid;
END $$;

-- Q1 / Q211. Applies a previewed run: the typed task columns of its rows are entered through the TPL-MASTER staging and the batch flow as the caller
-- (source master_import), then sent (submit: L2 decides each task; draft: saved without submission). Nothing is written around the normal checks:
-- the holders, the gates, the dates and the documents decide every row, as for a person on the task. A file is applied once.
CREATE OR REPLACE FUNCTION mi_apply_run(p_run uuid, p_version int, p_mode text, p_reason text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); r public.master_reconciliation_runs%ROWTYPE; prev uuid; tv public.template_versions%ROWTYPE; mpart jsonb; mcols jsonb; v_rows jsonb := '[]'::jsonb;
  row_ record; cells jsonb; pres jsonb; c jsonb; cv jsonb; res jsonb; b jsonb; sent jsonb; v_outcome jsonb; batches jsonb := '[]'::jsonb; gid uuid := gen_random_uuid();
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
    jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid);
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
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256), btrim(p_reason));
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches)), actor, NULL);
  RETURN v_outcome;
END $$;

-- Q211: the resolution of one difference (who, when, why). A difference is never applied from here: the apply or the normal screens change data.
CREATE OR REPLACE FUNCTION mi_resolve_diff(p_diff uuid, p_resolution text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); d public.master_reconciliation_diffs%ROWTYPE; before jsonb; after jsonb;
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The comparison report is for a System Admin or a delegate of templates administer.'));
  END IF;
  SELECT * INTO d FROM public.master_reconciliation_diffs WHERE id = p_diff AND (region_id IS NULL OR public.app_region_check(region_id)) FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The difference does not exist.')); END IF;
  IF coalesce(p_resolution, '') NOT IN ('open', 'pmis_correct', 'master_correct', 'fixed', 'ignored') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/resolution', 'code', 'invalid',
      'message', 'resolution is open, pmis_correct, master_correct, fixed or ignored.'))));
  END IF;
  IF p_resolution <> 'open' AND coalesce(char_length(btrim(p_note)), 0) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/note', 'code', 'required', 'message', 'Say why (a note).'))));
  END IF;
  before := jsonb_build_object('resolution', d.resolution, 'note', d.resolution_note);
  UPDATE public.master_reconciliation_diffs SET resolution = p_resolution, resolution_note = nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
    resolved_by = CASE WHEN p_resolution = 'open' THEN NULL ELSE actor END, resolved_at = CASE WHEN p_resolution = 'open' THEN NULL ELSE now() END
  WHERE id = p_diff RETURNING jsonb_build_object('resolution', resolution, 'note', resolution_note) INTO after;
  PERFORM public.log_audit_write('master_import.diff_resolve', 'master_reconciliation_diff', p_diff::text, before, after || jsonb_build_object('run_id', d.run_id, 'site_code', d.site_code, 'master_col', d.master_col),
    nullif(btrim(coalesce(p_note, '')), ''), d.site_id, d.region_id);
  RETURN (SELECT to_jsonb(x) FROM public.master_reconciliation_diffs x WHERE x.id = p_diff);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership and grants
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON region_aliases, role_aliases, master_reconciliation_runs, master_reconciliation_rows, master_reconciliation_diffs TO pmis_definer;
GRANT INSERT, UPDATE ON region_aliases, role_aliases, master_reconciliation_runs, master_reconciliation_rows, master_reconciliation_diffs TO pmis_definer;
GRANT INSERT, UPDATE ON template_task_fields TO pmis_definer;
GRANT SELECT ON clusters, external_parties TO pmis_definer;
-- the definer functions read and write the run tables whatever the caller sees (the reads of pmis_app stay under RLS)
CREATE POLICY rls_definer ON master_reconciliation_runs FOR ALL TO pmis_definer USING (true) WITH CHECK (true);
CREATE POLICY rls_definer ON master_reconciliation_rows FOR ALL TO pmis_definer USING (true) WITH CHECK (true);
CREATE POLICY rls_definer ON master_reconciliation_diffs FOR ALL TO pmis_definer USING (true) WITH CHECK (true);
CREATE POLICY rls_definer ON region_aliases FOR ALL TO pmis_definer USING (true) WITH CHECK (true);
CREATE POLICY rls_definer ON role_aliases FOR ALL TO pmis_definer USING (true) WITH CHECK (true);

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'tpl_field_writable(text)', 'tpl_task_mode(text)', 'tpl_master_candidates(uuid,text)', 'tpl_master_columns()',
    'imp_single_event(text)', 'imp_start_date(text,jsonb,task_instances)',
    'imp_stage_task_row(jsonb,jsonb,uuid,int[],int[],int[],text)', 'imp_stage_stream_batch(text,int,text,text,text,uuid,jsonb,uuid,text,text,text)',
    'tpl_version_cols(text,jsonb)', 'tpl_version_compat(text,int)', 'tpl_refuse_outdated(jsonb)',
    'imp_stage_batch(text,int,text,text,text,uuid,jsonb,text)', 'imp_stage_batch(text,int,text,text,text,uuid,jsonb)',
    'imp_stage_master_core(text,int,text,text,jsonb,text,text,uuid)', 'imp_stage_master(text,int,text,text,jsonb,text)', 'imp_stage_master(text,int,text,text,jsonb)',
    'imp_submit_stream_batch(uuid,int,boolean)', 'imp_decide_draft_batch(uuid,int,text,text,jsonb,text,boolean)', 'imp_decide_batch(uuid,int,text,text,jsonb,text,boolean)',
    'tpl_mapping_snapshot()', 'tpl_mapping_save(jsonb,text,boolean)',
    'imp_region_resolve(text)', 'imp_role_resolve(text)', 'imp_alias_save(text,text,text,text,text,boolean,text,text)',
    'mx_issue_cells(uuid)', 'mi_can_use()', 'mi_norm(text)', 'mi_pmis_row(uuid)', 'mi_task_value(uuid,text,text)', 'mi_columns()',
    'mi_stage_run(text,text,bigint,text,jsonb,jsonb,jsonb,jsonb)', 'mi_apply_run(uuid,int,text,text,boolean)', 'mi_resolve_diff(uuid,text,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON region_aliases, role_aliases, master_reconciliation_runs, master_reconciliation_rows, master_reconciliation_diffs FROM pmis_app;
    GRANT SELECT ON region_aliases, role_aliases, master_reconciliation_runs, master_reconciliation_rows, master_reconciliation_diffs TO pmis_app;
    FOREACH f IN ARRAY ARRAY[
      'tpl_version_compat(text,int)', 'tpl_master_candidates(uuid,text)', 'tpl_mapping_snapshot()', 'tpl_task_mode(text)', 'tpl_active_workflow()', 'tpl_mapping_save(jsonb,text,boolean)',
      'imp_stage_batch(text,int,text,text,text,uuid,jsonb,text)', 'imp_stage_batch(text,int,text,text,text,uuid,jsonb)',
      'imp_stage_master(text,int,text,text,jsonb,text)', 'imp_stage_master(text,int,text,text,jsonb)', 'imp_decide_batch(uuid,int,text,text,jsonb,text,boolean)',
      'imp_region_resolve(text)', 'imp_role_resolve(text)', 'imp_alias_save(text,text,text,text,text,boolean,text,text)', 'mx_issue_cells(uuid)', 'mi_can_use()',
      'mi_stage_run(text,text,bigint,text,jsonb,jsonb,jsonb,jsonb)', 'mi_apply_run(uuid,int,text,text,boolean)', 'mi_resolve_diff(uuid,text,text)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
