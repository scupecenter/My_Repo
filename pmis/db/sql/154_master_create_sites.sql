-- 0155_master_create_sites: the Master import creates the sites of its file that are not in GSDN Workspace, then enters their task dates and register rows,
-- in one apply (owner request 2026-11-25, open question Q350; CHANGELOG 210; contract 0.15.73).
-- Mirror: db/sql/154_master_create_sites.sql (kept byte-identical).
--
-- WHY. After a project data reset (0146 .. 0154) the sites are gone, so applying the owner's Master answers 422 "No typed task column of this file belongs to
-- a site of GSDN Workspace: nothing can be entered": every row of the file is "Not in GSDN Workspace". Until now the sites had to be created first with the
-- New sites template (TPL-SITE-NEW, 0070), then the Master applied. The owner asked for an option of the apply dialog: "Create the sites that are not in GSDN
-- Workspace from the Master", so that one Master upload recreates the sites and then enters their task dates and register rows.
--
-- WHAT THIS BUILDS.
--   1. The option create_sites of mi_apply_run (a new 8-argument door; the 7-argument door is now a wrapper that passes false, so every earlier caller is
--      unchanged). With it, before anything is entered, the rows of the run whose Site ID is not a site of GSDN Workspace (site_id NULL at the comparison;
--      the first row of a Site ID; a blank Site ID is never a site) become one New sites batch (import_batches entity site, source master_import, the new
--      column master_run_id), and each of its rows is created by THE SAME path as an approved New sites row:
--        - the identity of the row is read from the Master identity and scope columns (mcs_identity, the mapping below) into the fields of the New sites
--          template, and validated by site_new_clean (the one validation of both entry ways: Site ID unique and never reused, also against a cancelled,
--          voided or deleted site and a waiting draft; region through the region aliases; Delivery Scenario, Site Scenario and Site Type from their lists;
--          scope flags; coordinates; the RF survey date; the scenario rules probe). A row that fails is refused with its reasons on the batch row and in the
--          result of the run; no value is ever defaulted (a blank region or delivery scenario refuses the row);
--        - a site draft (in_approval, the actor as L1) and site_create_apply (the one writer: the workflow version in force with every task, the root tasks
--          opened by the engine, the cluster of the row created in its region when new, the scenario applicability wf_apply_applicability_run, the
--          calculation, the site_create audit row with before NULL and after the site, now also naming the Master run, Q466 for a Cancelled row).
--      Then the run's rows of the created sites are linked to them (master_reconciliation_rows.site_id / region_id), so the staging of the task cells, the
--      register sheets, the historical load, its direct approval and every later step treat them as any site of the file. A Site ID that exists (active,
--      cancelled, voided or deleted) is never touched: its row is refused "This Site ID exists already" and listed as skipped.
--   2. Rights (checked here, in the database, at the request, at every step of the background run and on every row): a System Admin (a member of the System
--      Admins group, never a delegate; as "Direct approval (no L2) - admin override"), the creation then flagged admin_override in its audit row unless the
--      admin also holds both levels; or a person who holds BOTH L1 (Data Entry) and L2 (Review and Approve) of the Matrix row site_creation in the region of
--      the row with the Site Master create and approve rights, the creation then being a self-approval (B5: the step-up of the apply, flagged self_approval in
--      the draft and the audit row). Anyone else cannot use the option (403 action_forbidden; mcs_offer says why, the screen disables the option with it);
--      a row of a region where the person does not hold both levels is refused with that reason. The apply already needs the step-up.
--   3. Order: the sites are created first, then the task cells and the register sheets are entered as before. Big runs: the threshold imports.async_rows now
--      counts the sites to create too; above it the request records the background apply (mi_apply_jobs, the same run of 0086, with the choice create_sites)
--      and answers 202. mi_apply_step then stages the New sites batch in one step, creates the sites in chunks of 25 (one transaction each, about 2 s,
--      far from the 30 s request limit and the 20 min limit of a step), visible as progress on the run (mi_run_applying_json: phase, create_total,
--      create_done), and applies the run in its last step as before. A stopped run keeps the sites created so far (and their links); its rows not done are
--      closed "not created". The batch is processed only by the apply: the batch doors refuse it (imp_async_guard, 409 batch_processing).
--   4. The outcome of the run lists the created sites and the refused rows with their reasons (create_sites: batch_id, created, skipped, counts).
--
-- MAPPING (Master column -> New sites field; the Master structure is checked at the upload, so the letters are those of master_columns):
--   B Site ID -> site_code (required) | C Site Owner ID -> owner_site_id | D Site Name -> name (required) | E Region -> region (required, region aliases)
--   F Sub Region -> sub_region | G Cluster ID -> cluster_code (created in the region when new) | H Latitude, I Longitude -> latitude, longitude (together)
--   J Site Type -> site_type (SiteType list) | K Site Scenario -> site_scenario (SiteScenario list) | S RF Survey Date -> rf_survey_date
--   X Project Phase -> project_phase | Y Delivery Batch -> delivery_batch | Z Delivery Scenario -> delivery_scenario (required, DeliveryScenario list)
--   AA Tower Erection, AB Site Adaption, AC GECOL Power, AD HLC Fiber, AE Full Scope, AF IP Router Only -> the six scope flags (Yes / No / blank)
--   AG CW Delivery Model -> cw_delivery_model | FZ Overall Status -> overall_status only when Cancelled (Q466); any other status follows the work.
--   Not read at creation: A (row number); L Site Uplink and M:Q tower data (Tower Owner, Existing or New, RT or GF, Tower Type, Tower Height), R Configuration,
--   T Acquisition Date: they are not fields of the New sites template (site_new_clean refuses an unknown field); in the Master they are formulas over the
--   RF & Design, As-Built and Acquisition sheets, whose registers feed them into the site when those sheets are loaded (the "registers" option, P4a 0062).
--   U, V, W and the task columns are task data, entered after the creation as before. The Arabic name and the address are not in the Master (left empty).
--   A cell is read as the file shows it (its cached value also when it holds a formula: C:Q of the Master are formulas over the RF & Design sheet).
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0155"): mi_apply_run 7 arguments (0126, now a wrapper of the new 8-argument
-- door, whose body is the 0126 body with the changes marked), mi_apply_step (0122), mi_apply_fail (0086), mi_run_applying_json (0086), site_create_apply
-- (0074), imp_async_guard (0074). CREATE OR REPLACE keeps their owner (pmis_definer), search_path and grants.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. Granted to pmis_app: the
-- new door mi_apply_run(uuid, integer, text, text, boolean, jsonb, jsonb, boolean) and mcs_offer() (the screen's offer). No new table: two columns on
-- import_batches (master_run_id) and mi_apply_jobs (create_sites, create_batch_id, create_total, create_done), both tables already closed to pmis_app writes
-- (db/sql/app_grants.sql) and already classified in the data-reset plan (import_batches: with the rows that point at it, here the site drafts, so the sites
-- part; mi_apply_jobs: imports). The new columns have no foreign key, so a partial data reset that keeps one side never fails on the other.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE import_batches ADD COLUMN master_run_id uuid;
COMMENT ON COLUMN import_batches.master_run_id IS '0155: the Master import run whose apply created this New sites batch (option create_sites). Processed only by that apply (imp_async_guard refuses the batch doors). No foreign key: a partial data reset may keep one side.';
CREATE INDEX import_batches_master_run_idx ON import_batches (master_run_id) WHERE master_run_id IS NOT NULL;

ALTER TABLE mi_apply_jobs
  ADD COLUMN create_sites    boolean NOT NULL DEFAULT false,
  ADD COLUMN create_batch_id uuid,
  ADD COLUMN create_total    integer CHECK (create_total IS NULL OR create_total >= 0),
  ADD COLUMN create_done     integer NOT NULL DEFAULT 0 CHECK (create_done >= 0),
  ADD CONSTRAINT mi_apply_jobs_create_batch_check CHECK (create_batch_id IS NULL OR create_sites);
COMMENT ON COLUMN mi_apply_jobs.create_sites IS '0155: the apply creates the sites of the file that are not in GSDN Workspace first (staged, then created in chunks by mi_apply_step)';
COMMENT ON COLUMN mi_apply_jobs.create_batch_id IS '0155: the New sites batch staged from the Master by the first step (import_batches.master_run_id = run_id)';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT (master_run_id), UPDATE (master_run_id) ON import_batches FROM pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The mapping of the Master identity columns onto the fields of the New sites template
-- ---------------------------------------------------------------------------------------------------------------------
-- A cell of a run row ({letter: {v, f}}): its value as text, control characters removed, NULL when blank.
CREATE OR REPLACE FUNCTION mcs_cell(p_cells jsonb, p_col text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT nullif(btrim(regexp_replace(coalesce(CASE WHEN jsonb_typeof(p_cells -> p_col) = 'object' THEN p_cells -> p_col ->> 'v' END, ''), '[[:cntrl:]]', '', 'g')), '')
$$;

-- The New sites fields of one Master row (only the fields the New sites template carries; blank cells are left out, never defaulted).
CREATE OR REPLACE FUNCTION mcs_identity(p_cells jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'site_code',               public.mcs_cell(p_cells, 'B'),
    'owner_site_id',           public.mcs_cell(p_cells, 'C'),
    'name',                    public.mcs_cell(p_cells, 'D'),
    'region',                  public.mcs_cell(p_cells, 'E'),
    'sub_region',              public.mcs_cell(p_cells, 'F'),
    'cluster_code',            public.mcs_cell(p_cells, 'G'),
    'latitude',                public.mcs_cell(p_cells, 'H'),
    'longitude',               public.mcs_cell(p_cells, 'I'),
    'site_type',               public.mcs_cell(p_cells, 'J'),
    'site_scenario',           public.mcs_cell(p_cells, 'K'),
    'rf_survey_date',          public.mcs_cell(p_cells, 'S'),
    'project_phase',           public.mcs_cell(p_cells, 'X'),
    'delivery_batch',          public.mcs_cell(p_cells, 'Y'),
    'delivery_scenario',       public.mcs_cell(p_cells, 'Z'),
    'scope_tower_erection',    public.mcs_cell(p_cells, 'AA'),
    'scope_site_adaption',     public.mcs_cell(p_cells, 'AB'),
    'scope_gecol_power',       public.mcs_cell(p_cells, 'AC'),
    'scope_hlc_fiber',         public.mcs_cell(p_cells, 'AD'),
    'scope_te_full',           public.mcs_cell(p_cells, 'AE'),
    'scope_te_ip_router_only', public.mcs_cell(p_cells, 'AF'),
    'cw_delivery_model',       public.mcs_cell(p_cells, 'AG'),
    'overall_status',          CASE WHEN lower(public.mcs_cell(p_cells, 'FZ')) = 'cancelled' THEN 'Cancelled' END))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Who may create a site from the Master
-- ---------------------------------------------------------------------------------------------------------------------
-- The actor holds both L1 and L2 of the Matrix row site_creation in the region, with the grid rights create and approve of the Site Master (B5).
CREATE OR REPLACE FUNCTION mcs_holds_both(p_region integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_region IS NOT NULL AND public.app_actor() IS NOT NULL
     AND public.site_new_may('create', p_region) AND public.site_new_holds(p_region, 'entry')
     AND public.site_new_may('approve', p_region) AND public.site_new_holds(p_region, 'approve')
$$;

-- NULL when the actor may create a site of this region without a second person (a System Admin, or the holder of both levels), else the reason.
CREATE OR REPLACE FUNCTION mcs_rights(p_region integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor();
BEGIN
  IF actor IS NULL THEN RETURN 'No signed-in person.'; END IF;
  IF public.app_user_is_system_admin(actor) THEN RETURN NULL; END IF;
  IF public.mcs_holds_both(p_region) THEN RETURN NULL; END IF;
  RETURN 'Creating a site from the Master needs a System Admin, or a person who holds both L1 (Data Entry) and L2 (Review and Approve) of the Site creation row of the Matrix in this region, with the Site Master create and approve rights.';
END $$;

-- The offer of the option for the apply dialog (granted): allowed, whether the actor is a System Admin, the regions where the actor holds both levels, the reason.
CREATE OR REPLACE FUNCTION mcs_offer() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); adm boolean; regs int[];
BEGIN
  IF actor IS NULL OR NOT public.mi_can_use() THEN
    RETURN jsonb_build_object('allowed', false, 'admin', false, 'regions', '[]'::jsonb, 'reason', 'The legacy Master import is for a System Admin or a delegate of templates administer.');
  END IF;
  adm := public.app_user_is_system_admin(actor);
  SELECT coalesce(array_agg(r.id ORDER BY r.id), ARRAY[]::int[]) INTO regs FROM public.regions r WHERE adm OR public.mcs_holds_both(r.id);
  RETURN jsonb_build_object('allowed', adm OR cardinality(regs) > 0, 'admin', adm, 'regions', to_jsonb(regs),
    'reason', CASE WHEN NOT (adm OR cardinality(regs) > 0) THEN
      'Only a System Admin, or a person who holds both L1 and L2 of the Site creation row of the Matrix, can create sites from the Master without a second person. Create them with the New sites template instead.' END);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The New sites batch of a run: staged (the checks of a New sites upload), created row by row (the path of an approved New sites row), finished, read
-- ---------------------------------------------------------------------------------------------------------------------
-- Stages the rows of the run whose Site ID is not a site of GSDN Workspace. NULL when there is none. Rows that fail are kept as error rows with their reasons.
CREATE OR REPLACE FUNCTION mcs_stage(p_run uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); r public.master_reconciliation_runs%ROWTYPE; d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; cols jsonb;
  el record; raw jsonb; res jsonb; errs jsonb; e jsonb; region int; ckey text; rr text; diffj jsonb; k text; results jsonb := '[]'::jsonb; bid uuid := gen_random_uuid();
  n_rows int; n_err int; regions int[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce((public.mcs_offer() ->> 'allowed')::boolean, false) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', public.mcs_offer() ->> 'reason'));
  END IF;
  SELECT * INTO r FROM public.master_reconciliation_runs WHERE id = p_run;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The import run does not exist.')); END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = 'TPL-SITE-NEW' AND is_active AND kind = 'sites';
  IF NOT FOUND THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The New sites template is not in use, so no site can be created from the Master.'));
  END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  cols := v.columns;
  FOR el IN
    SELECT DISTINCT ON (upper(btrim(x.site_code))) x.row_no, btrim(x.site_code) AS site_code, x.cells
    FROM public.master_reconciliation_rows x
    WHERE x.run_id = p_run AND x.site_id IS NULL AND nullif(btrim(x.site_code), '') IS NOT NULL
    ORDER BY upper(btrim(x.site_code)), x.row_no
  LOOP
    raw := public.mcs_identity(el.cells) || jsonb_build_object('site_code', el.site_code);
    errs := '[]'::jsonb;
    res := public.site_new_clean(raw, NULL);
    FOR e IN SELECT * FROM jsonb_array_elements(res -> 'errors') LOOP
      errs := errs || jsonb_build_array(public.imp_cell_err(cols, e ->> 'field', e ->> 'code', e ->> 'message'));
    END LOOP;
    region := (res -> 'clean' ->> 'region_id')::int;
    ckey := coalesce(res -> 'clean' ->> 'site_code', upper(el.site_code));
    IF jsonb_array_length(errs) = 0 THEN
      rr := public.mcs_rights(region);
      IF rr IS NOT NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('code', 'not_eligible_holder', 'message', rr)); END IF;
    END IF;
    diffj := '{}'::jsonb;
    IF jsonb_array_length(errs) = 0 THEN
      FOR k IN SELECT jsonb_object_keys(res -> 'clean') LOOP
        diffj := diffj || jsonb_build_object(k, jsonb_build_object('old', NULL, 'new', res -> 'clean' -> k));
      END LOOP;
    END IF;
    results := results || jsonb_build_array(jsonb_build_object('row_no', el.row_no, 'site_code', left(ckey, 60), 'region', region,
      'action', CASE WHEN jsonb_array_length(errs) = 0 THEN 'create' ELSE 'error' END, 'errors', errs, 'diff', diffj,
      'payload', jsonb_build_object('data', res -> 'clean', 'master_row', el.row_no), 'warnings', res -> 'warnings'));
  END LOOP;
  IF jsonb_array_length(results) = 0 THEN RETURN NULL; END IF;

  SELECT coalesce(array_agg(DISTINCT (t ->> 'region')::int) FILTER (WHERE t ->> 'action' <> 'error' AND t ->> 'region' IS NOT NULL), ARRAY[]::int[]), count(*),
         count(*) FILTER (WHERE t ->> 'action' = 'error')
    INTO regions, n_rows, n_err FROM jsonb_array_elements(results) t;
  INSERT INTO public.import_batches (id, template_version_id, source, file_name, file_sha256, status, uploaded_by, region_scope, rows_total, rows_error, entity, master_run_id)
  VALUES (bid, v.id, 'master_import', left(r.file_name, 200), r.file_sha256, 'validated', actor, regions, n_rows, n_err, 'site', p_run);
  INSERT INTO public.import_batch_rows (batch_id, row_no, sheet, site_code, region_id, target_entity, action, payload, diff, errors, decision, row_key, warnings)
  SELECT bid, (t ->> 'row_no')::int, 'Master', t ->> 'site_code', (t ->> 'region')::int, 'site', t ->> 'action', t -> 'payload',
         CASE WHEN t ->> 'action' = 'error' THEN '{}'::jsonb ELSE t -> 'diff' END, t -> 'errors', 'pending', t ->> 'site_code',
         CASE WHEN jsonb_array_length(coalesce(t -> 'warnings', '[]'::jsonb)) > 0 THEN t -> 'warnings' END
  FROM jsonb_array_elements(results) t ORDER BY (t ->> 'row_no')::int;
  PERFORM public.log_audit_write('import_batch_create', 'import_batch', bid::text, NULL,
    jsonb_build_object('template_id', d.template_id, 'template_version', v.version, 'file_name', left(r.file_name, 200), 'file_sha256', r.file_sha256, 'rows', n_rows,
      'errors', n_err, 'create', n_rows - n_err, 'source', 'master_import', 'master_run_id', p_run,
      'rule', 'the sites of the Master that are not in GSDN Workspace, created by the apply of the run (option create_sites)'), NULL);
  RETURN bid;
END $$;

-- Creates up to p_limit rows of the batch (NULL: all), each in a subtransaction: checked again (site_new_clean, the rights), a draft by the actor, then
-- site_create_apply; the run rows of the created site are linked to it. A row that fails gets its reason and the others go on.
CREATE OR REPLACE FUNCTION mcs_create_rows(p_batch uuid, p_limit integer, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; v jsonb; c jsonb; rid int; did uuid; sid uuid; rr text;
  processed int := 0; created int := 0; failed jsonb := '[]'::jsonb; j jsonb; msg text; code text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR b.master_run_id IS NULL OR b.entity IS DISTINCT FROM 'site' OR b.uploaded_by <> actor THEN
    RAISE EXCEPTION 'mcs: only the person who applies the Master creates the sites of its batch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL
           ORDER BY x.row_no LIMIT p_limit LOOP
    processed := processed + 1;
    BEGIN
      v := public.site_new_clean(r.payload -> 'data', NULL);
      IF jsonb_array_length(v -> 'errors') > 0 THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.site_draft_errors(v -> 'errors'), 'detail', coalesce(v -> 'errors' -> 0 ->> 'message', 'The row is not valid.')));
      END IF;
      c := v -> 'clean'; rid := (c ->> 'region_id')::int;
      rr := public.mcs_rights(rid);
      IF rr IS NOT NULL THEN PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', rr)); END IF;
      INSERT INTO public.site_drafts (site_code, region_id, data, status, created_by, submitted_by, submitted_at, batch_id, batch_row_id)
      VALUES (c ->> 'site_code', rid, c, 'in_approval', actor, actor, clock_timestamp(), p_batch, r.id) RETURNING id INTO did;
      UPDATE public.import_batch_rows SET site_draft_id = did WHERE id = r.id;
      -- B5: the holder of both levels approves their own entry (the step-up of the apply); a System Admin without both levels creates it as an admin override
      sid := public.site_create_apply(did, public.mcs_holds_both(rid));
      UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), site_id = sid WHERE id = r.id;
      UPDATE public.master_reconciliation_rows SET site_id = sid, region_id = rid
        WHERE run_id = b.master_run_id AND site_id IS NULL AND upper(btrim(site_code)) = c ->> 'site_code';
      created := created + 1;
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'master-import', 'a site of the Master could not be created', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The site could not be created. See the System Log (master-import) for the technical reason.' END;
      code := coalesce(j ->> 'code', 'row_failed');
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', site_draft_id = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('code', code, 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', code, 'message', left(msg, 300)));
    END;
  END LOOP;
  RETURN jsonb_build_object('processed', processed, 'created', created, 'failed', failed);
END $$;

-- What the batch did: the created sites and the refused rows with their reasons.
CREATE OR REPLACE FUNCTION mcs_result(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('batch_id', p_batch,
    'created', coalesce(jsonb_agg(jsonb_build_object('row_no', x.row_no, 'site_code', x.site_code, 'site_id', x.site_id, 'region_id', x.region_id,
                 'self_approval', coalesce(d.self_approval, false)) ORDER BY x.row_no) FILTER (WHERE x.decision = 'approved' AND x.site_id IS NOT NULL), '[]'::jsonb),
    'skipped', coalesce(jsonb_agg(jsonb_build_object('row_no', x.row_no, 'site_code', x.site_code, 'code', coalesce(x.errors -> 0 ->> 'code', 'not_created'),
                 'reason', coalesce(x.errors -> 0 ->> 'message', x.decision_note), 'column', x.errors -> 0 ->> 'column', 'errors', coalesce(x.errors, '[]'::jsonb))
                 ORDER BY x.row_no) FILTER (WHERE x.action = 'error' OR x.decision = 'rejected'), '[]'::jsonb),
    'created_count', count(*) FILTER (WHERE x.decision = 'approved' AND x.site_id IS NOT NULL),
    'skipped_count', count(*) FILTER (WHERE x.action = 'error' OR x.decision = 'rejected'))
  FROM public.import_batch_rows x LEFT JOIN public.site_drafts d ON d.id = x.site_draft_id
  WHERE x.batch_id = p_batch
$$;

-- The end of the creation: the status, the one audit row of the send (imp_submit_site_finish), the batch closed.
CREATE OR REPLACE FUNCTION mcs_finish(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; n_ok int; n_err int;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR b.master_run_id IS NULL THEN RAISE EXCEPTION 'mcs: not a batch of the Master import' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF b.submitted_at IS NULL THEN
    SELECT count(*) FILTER (WHERE x.decision = 'approved'), count(*) FILTER (WHERE x.action = 'error') INTO n_ok, n_err FROM public.import_batch_rows x WHERE x.batch_id = p_batch;
    PERFORM public.imp_submit_site_finish(p_batch, 'validated', n_ok, n_err);
    UPDATE public.import_batches SET status = CASE WHEN n_ok = 0 THEN 'rejected' ELSE status END, closed_at = coalesce(closed_at, now()), submitted_at = coalesce(submitted_at, now()),
      note = CASE WHEN n_ok = 0 THEN 'No site of the Master could be created: see the reasons of the rows.' ELSE note END
      WHERE id = p_batch;
  END IF;
  RETURN public.mcs_result(p_batch);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The writer of a site (site_create_apply: latest 0074, changes marked 0155) and the guard of the batch doors (imp_async_guard: latest 0074, changes marked 0155)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_create_apply(p_draft uuid, p_self boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.site_drafts%ROWTYPE; v jsonb; c jsonb; wf uuid := public.active_workflow_id(); sid uuid; cid uuid; ccode text; created_cluster boolean := false; t record; s jsonb;
  actor uuid := public.app_actor(); first_seq int; applied jsonb; errs jsonb := '[]'::jsonb; e jsonb; why text;
  was_busy text := coalesce(current_setting('pmis.calc_busy', true), '');
  mrun uuid; ovr boolean := false;   -- 0155: the Master import run whose apply creates the site, and whether it is an admin override
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- 0074: the calculation layer runs once, at the end (the opening of the first tasks and the applicability no longer refresh the site in between)
  PERFORM set_config('pmis.calc_busy', '1', true);
  SELECT * INTO d FROM public.site_drafts WHERE id = p_draft FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The draft does not exist.')); END IF;
  IF d.status NOT IN ('entry', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The draft is ' || d.status || '.'));
  END IF;
  -- checked again now: a Site ID, a list or a rule may have changed since the draft was entered
  v := public.site_new_clean(d.data, d.id);
  IF jsonb_array_length(v -> 'errors') > 0 THEN
    FOR e IN SELECT * FROM jsonb_array_elements(v -> 'errors') LOOP
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || (e ->> 'field'), 'code', e ->> 'code', 'message', e ->> 'message'));
    END LOOP;
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs, 'detail', 'The site cannot be created: ' || coalesce(errs -> 0 ->> 'message', 'a value is not valid') ));
  END IF;
  c := v -> 'clean';
  IF wf IS NULL OR NOT public.wf_is_published(wf) THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'There is no published workflow version.')); END IF;

  -- the cluster of the row: an existing one, or a new one in the site's region
  IF c ->> 'cluster_code' IS NOT NULL THEN
    SELECT id INTO cid FROM public.clusters WHERE upper(cluster_code) = upper(c ->> 'cluster_code');
    IF cid IS NULL THEN
      INSERT INTO public.clusters (cluster_code, region_id, is_global) VALUES (c ->> 'cluster_code', (c ->> 'region_id')::int, false) RETURNING id INTO cid;
      created_cluster := true;
      PERFORM public.log_audit_write('cluster_create', 'cluster', cid::text, NULL, jsonb_build_object('cluster_code', c ->> 'cluster_code', 'region_id', (c ->> 'region_id')::int),
        'created with the first site of the cluster (site creation, draft ' || d.id::text || ')', NULL, (c ->> 'region_id')::int);
    END IF;
  END IF;

  INSERT INTO public.sites (site_code, owner_site_id, name, name_ar, region_id, workflow_version_id, sub_region, cluster_id, latitude, longitude, address, site_type, site_scenario,
    project_phase, delivery_batch, delivery_scenario, cw_delivery_model, rf_survey_date, scope_tower_erection, scope_site_adaption, scope_gecol_power, scope_hlc_fiber,
    scope_te_full, scope_te_ip_router_only, overall_status, updated_at)
  VALUES (c ->> 'site_code', c ->> 'owner_site_id', c ->> 'name', c ->> 'name_ar', (c ->> 'region_id')::int, wf, c ->> 'sub_region', cid,
    (c ->> 'latitude')::numeric, (c ->> 'longitude')::numeric, c ->> 'address', c ->> 'site_type', c ->> 'site_scenario', c ->> 'project_phase', c ->> 'delivery_batch',
    (c ->> 'delivery_scenario')::"DeliveryScenario", c ->> 'cw_delivery_model', (c ->> 'rf_survey_date')::date,
    coalesce((c ->> 'scope_tower_erection')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_site_adaption')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_gecol_power')::"ScopeFlag", 'na'),
    coalesce((c ->> 'scope_hlc_fiber')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_te_full')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_te_ip_router_only')::"ScopeFlag", 'na'),
    'not_started', clock_timestamp())
  RETURNING id INTO sid;

  -- every task of the workflow version in force, locked, with its levels and SLA rule (the pattern of admin_migrate_sites_to_workflow)
  INSERT INTO public.task_instances (site_id, region_id, task_def_id, state, levels_required, sla_rule_id, updated_at)
  SELECT s2.id, s2.region_id, td.id, 'locked', coalesce(td.approval_levels, st.approval_levels), public.sla_rule_for(td.id, s2.delivery_scenario, s2.region_id, current_date), now()
  FROM public.sites s2 JOIN public.task_definitions td ON td.workflow_id = wf AND td.is_active JOIN public.stage_definitions st ON st.id = td.stage_id AND st.is_active
  WHERE s2.id = sid;

  -- the engine opens the first tasks: those of the first stage that wait for no predecessor (a dismantle task is opened by hand, Q382)
  SELECT min(st.seq) INTO first_seq FROM public.stage_definitions st WHERE st.workflow_id = wf AND st.is_active;
  FOR t IN SELECT ti.id FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions st ON st.id = td.stage_id
           WHERE ti.site_id = sid AND st.seq = first_seq AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p WHERE p.task_def_id = td.id) ORDER BY td.sort_order, td.code LOOP
    PERFORM public.wf_open_locked(t.id, 'site created');
  END LOOP;

  why := 'site created (' || CASE WHEN d.batch_id IS NOT NULL THEN 'batch ' || d.batch_id::text || ' row ' || coalesce(d.batch_row_id::text, '?') ELSE 'draft ' || d.id::text END || ')';
  -- 0155: a site of a New sites batch staged by the apply of a Master import run (option create_sites) names that run; a System Admin who does not hold
  -- both levels of the Matrix row site_creation creates it as an admin override
  IF d.batch_id IS NOT NULL THEN SELECT b.master_run_id INTO mrun FROM public.import_batches b WHERE b.id = d.batch_id; END IF;
  IF mrun IS NOT NULL THEN
    why := 'site created from Master run ' || mrun::text || ' (batch ' || d.batch_id::text || ' row ' || coalesce(d.batch_row_id::text, '?') || ')';
    ovr := NOT p_self AND public.app_user_is_system_admin(actor);
  END IF;
  -- the scenario applicability of P1: tasks that the scenario and the scope flags make N/A, and the chain that follows
  applied := public.wf_apply_applicability_run(sid, why, true);   -- 0074: a brand-new site, the successors are opened once at the end

  UPDATE public.site_drafts SET status = 'approved', site_id = sid, decided_by = actor, decided_at = clock_timestamp(), self_approval = p_self, version = version + 1, updated_at = clock_timestamp()
  WHERE id = d.id;

  SELECT jsonb_build_object('site_code', s3.site_code, 'name', s3.name, 'name_ar', s3.name_ar, 'region_id', s3.region_id, 'cluster_code', c ->> 'cluster_code',
           'cluster_created', created_cluster, 'delivery_scenario', s3.delivery_scenario, 'workflow_version_id', s3.workflow_version_id, 'tasks', (SELECT count(*) FROM public.task_instances WHERE site_id = sid),
           'applicability_changed', jsonb_array_length(applied -> 'changed'), 'draft_id', d.id, 'batch_id', d.batch_id, 'batch_row_id', d.batch_row_id,
           'self_approval', p_self, 'created_by', d.created_by)
         || CASE WHEN mrun IS NOT NULL THEN jsonb_build_object('source', 'master_import', 'master_run_id', mrun, 'admin_override', ovr) ELSE '{}'::jsonb END   -- 0155
    INTO s FROM public.sites s3 WHERE s3.id = sid;
  PERFORM public.log_audit_write('site_create', 'site', sid::text, NULL, s, why, sid, (c ->> 'region_id')::int, NULL, ovr);   -- 0155: the admin override flag

  -- Q466: a Cancelled row creates the site and then cancels it, so its history exists
  IF c ->> 'overall_status' = 'cancelled' THEN
    UPDATE public.sites SET overall_status = 'cancelled', updated_at = clock_timestamp() WHERE id = sid;
    PERFORM public.log_audit_write('site_cancelled', 'site', sid::text, jsonb_build_object('overall_status', 'not_started'), jsonb_build_object('overall_status', 'cancelled'),
      'created as Cancelled (Q466): ' || why, sid, (c ->> 'region_id')::int);
  END IF;
  PERFORM set_config('pmis.calc_busy', was_busy, true);
  PERFORM public.calc_refresh_site(sid);
  RETURN sid;
END $$;

CREATE OR REPLACE FUNCTION imp_async_guard(p_batch uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.import_batch_jobs%ROWTYPE; mrun uuid;
BEGIN
  -- 0155: a New sites batch staged by the apply of a Master import run is processed by that apply only (never sent, decided or discarded by hand)
  SELECT b.master_run_id INTO mrun FROM public.import_batches b WHERE b.id = p_batch;
  IF mrun IS NOT NULL THEN
    PERFORM public.wf_err('batch_processing', jsonb_build_object('detail', 'This New sites batch was made by the apply of the Master import run ' || mrun::text
      || ': it is processed by that apply only. Apply the Master file again to create the sites it refused.', 'master_run_id', mrun));
  END IF;
  SELECT * INTO j FROM public.import_batch_jobs x WHERE x.batch_id = p_batch AND x.state = 'running';
  IF FOUND THEN
    PERFORM public.wf_err('batch_processing', jsonb_build_object('detail', 'The batch is being processed (' || j.rows_done || ' of ' || j.rows_total || ' rows). Wait until it ends.',
      'rows_done', j.rows_done, 'rows_total', j.rows_total));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The apply. mi_apply_run with the option (the 0126 body of the 7-argument door, changes marked 0155); the background run: mi_apply_step (latest 0122),
--    mi_apply_fail (latest 0086), mi_run_applying_json (latest 0086), changes marked 0155
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb, p_registers jsonb,
  p_create_sites boolean)
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
  hnsr jsonb; hnsp jsonb;                            -- 0126: the no-source N/A restored by a dated row of the file, and the rule at the end
  cs boolean := coalesce(p_create_sites, false); ncreate int := 0; cb uuid; csr jsonb; ndetail text;   -- 0155: create the sites of the file first
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
  IF cs THEN
    -- 0155: the option is for a person who may create a site without a second person (a System Admin, or the holder of both L1 and L2 of the Matrix row
    -- site_creation in a region); checked here, again in the background and on every row
    IF NOT coalesce((public.mcs_offer() ->> 'allowed')::boolean, false) THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', public.mcs_offer() ->> 'reason'));
    END IF;
    SELECT count(DISTINCT upper(btrim(x.site_code))) INTO ncreate FROM public.master_reconciliation_rows x
      WHERE x.run_id = p_run AND x.site_id IS NULL AND nullif(btrim(x.site_code), '') IS NOT NULL;
  END IF;
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
    IF nsites + ncreate > lim THEN   -- 0155: the sites to create count too
      INSERT INTO public.mi_apply_jobs (run_id, actor_id, mode, reason, hw_reason, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, sites_total,
                                        approve_directly, load_registers, registers, reapply, create_sites, create_total)   -- 0092, 0093, 0122, 0155
      VALUES (p_run, actor, p_mode, left(btrim(p_reason), 2000), hw ->> 'reason', true, su_until,
              CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
              public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64), nsites + ncreate,
              hda, hrg, regs, rap, cs, CASE WHEN cs THEN ncreate END)
      RETURNING id INTO jid;
      UPDATE public.master_reconciliation_runs SET status = 'applying', version = version + 1 WHERE id = p_run;
      PERFORM public.log_audit_write('master_import.apply_queued', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
        jsonb_build_object('status', 'applying', 'job_id', jid, 'mode', p_mode, 'sites', nsites + ncreate, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
          'approve_directly', hda, 'registers', hrg, 'reapply', rap, 'create_sites', cs, 'sites_to_create', ncreate), btrim(p_reason));   -- 0092, 0093, 0122, 0155
      PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: apply queued', jsonb_build_object('run_id', p_run, 'job_id', jid, 'mode', p_mode, 'sites', nsites + ncreate,
        'sites_to_create', ncreate), actor, NULL);
      RETURN jsonb_build_object('queued_apply', true, 'job_id', jid, 'mode', p_mode, 'sites', nsites + ncreate, 'batches', '[]'::jsonb, 'queued', 0, 'approve_directly', hda, 'registers', hrg, 'reapply', rap,
        'create_sites', cs, 'sites_to_create', ncreate);   -- 0155
    END IF;
  END IF;
  IF cs THEN
    -- 0155: the sites first. In the request: the New sites batch of the run is staged, every row created (the path of an approved New sites row) and the
    -- batch closed, here; in the background the steps of mi_apply_step did it (in chunks) before this last step. The rows of the created sites are linked
    -- to them, so everything below treats them as any site of the file.
    IF bg IS NULL THEN
      cb := public.mcs_stage(p_run);
      IF cb IS NOT NULL THEN
        PERFORM public.mcs_create_rows(cb, NULL, p_stepup);
        PERFORM public.mcs_finish(cb);
      END IF;
    ELSE
      SELECT j.create_batch_id INTO cb FROM public.mi_apply_jobs j WHERE j.id = bg;
      IF cb IS NOT NULL THEN PERFORM public.mcs_finish(cb); END IF;   -- closed by the step before; nothing changes then
    END IF;
    csr := CASE WHEN cb IS NOT NULL THEN public.mcs_result(cb)
                ELSE jsonb_build_object('batch_id', NULL, 'created', '[]'::jsonb, 'skipped', '[]'::jsonb, 'created_count', 0, 'skipped_count', 0) END;
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
  IF jsonb_array_length(v_rows) = 0 AND NOT (hrg AND jsonb_array_length(coalesce(regs -> 'parts', '[]'::jsonb)) > 0)   -- 0093: a file of register sheets only
     AND NOT (cs AND coalesce((csr ->> 'created_count')::int, 0) > 0) THEN   -- 0155: the sites created from the file are a result of their own
    -- 0155: the detail says what to do: the option when sites of the file are not in GSDN Workspace, the first reasons when none could be created
    ndetail := 'No typed task column of this file belongs to a site of GSDN Workspace: nothing can be entered.';
    IF cs THEN
      ndetail := ndetail || ' No site of the file could be created from the Master: '
        || coalesce((SELECT string_agg('row ' || (x ->> 'row_no') || ' (' || coalesce(x ->> 'site_code', '?') || '): ' || coalesce(x ->> 'reason', x ->> 'code'), '; ' ORDER BY (x ->> 'row_no')::int)
                     FROM (SELECT x FROM jsonb_array_elements(csr -> 'skipped') x LIMIT 5) y(x)), 'the file has no Site ID that is not in GSDN Workspace') || '.';
    ELSIF EXISTS (SELECT 1 FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NULL AND nullif(btrim(x.site_code), '') IS NOT NULL) THEN
      ndetail := ndetail || ' ' || (SELECT count(DISTINCT upper(btrim(x.site_code))) FROM public.master_reconciliation_rows x
                                     WHERE x.run_id = p_run AND x.site_id IS NULL AND nullif(btrim(x.site_code), '') IS NOT NULL)::text
        || ' site(s) of the file are not in GSDN Workspace: apply with "Create the sites that are not in GSDN Workspace from the Master" to create them first.';
    END IF;
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', ndetail, 'create_sites', csr));
  END IF;
  IF hda THEN
    -- 0126: a task marked N/A "historical load: no source" whose row of this file now carries an actual date is restored first (its override reverted,
    -- audited), so the staging below sends the row and approves it directly like any open task
    hnsr := public.hns_restore_dated(v_rows, hw ->> 'reason');
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
  IF hda AND queued = 0 THEN
    -- 0126: every batch of the file is sent and A3 is fed: a task with no date in the file is N/A "historical load: no source" where a later task of the
    -- site is approved with a date (hns_mark_site). When a batch is sent in the background, this runs when its last send ends (hns_after_job).
    hnsp := public.hns_apply_sites(ARRAY(SELECT DISTINCT x.site_id FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL),
      hw ->> 'reason', false, p_run);
  END IF;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued, 'approve_directly', hda,   -- 0092
    'registers', hrg, 'register_notes', rnotes,   -- 0093
    'reapply', rap, 'discarded', disc)   -- 0122
    || CASE WHEN cs THEN jsonb_build_object('create_sites', csr) ELSE '{}'::jsonb END;   -- 0155: the created sites and the refused rows with their reasons
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
      'approve_directly', hda, 'registers', hrg, 'reapply', rap, 'create_sites', cs), btrim(p_reason));   -- 0092, 0093, 0122, 0155
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;

CREATE OR REPLACE FUNCTION mi_apply_step(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); j public.mi_apply_jobs%ROWTYPE; res jsonb; e jsonb;
  cb uuid; n int; cr jsonb;   -- 0155: the New sites batch of the run, and a chunk of its creation
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
  IF j.create_sites THEN
    -- 0155: the sites of the file that are not in GSDN Workspace are created first, each step one transaction under the newly signed context of the same
    -- person (the rights are checked again by every step and every row): the first step stages the New sites batch, each next step creates up to 25 sites,
    -- the step after the last row closes the batch and goes on with the apply below in the same transaction. A refusal stops the run (mi_apply_fail).
    BEGIN
      IF j.create_batch_id IS NULL THEN
        cb := public.mcs_stage(j.run_id);
        SELECT count(*) INTO n FROM public.import_batch_rows x WHERE x.batch_id = cb AND x.action = 'create';
        UPDATE public.mi_apply_jobs SET create_batch_id = cb, create_total = coalesce(n, 0), heartbeat_at = clock_timestamp() WHERE id = p_job;
        IF cb IS NOT NULL THEN
          RETURN jsonb_build_object('job_id', j.id, 'state', 'running', 'phase', 'create_sites', 'create_total', coalesce(n, 0), 'create_done', 0);
        END IF;
      ELSIF EXISTS (SELECT 1 FROM public.import_batch_rows x WHERE x.batch_id = j.create_batch_id AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL) THEN
        cr := public.mcs_create_rows(j.create_batch_id, 25, j.stepup_verified);
        UPDATE public.mi_apply_jobs SET create_done = least(coalesce(create_total, create_done + (cr ->> 'processed')::int), create_done + (cr ->> 'processed')::int),
          heartbeat_at = clock_timestamp() WHERE id = p_job RETURNING create_done INTO n;
        RETURN jsonb_build_object('job_id', j.id, 'state', 'running', 'phase', 'create_sites', 'create_total', j.create_total, 'create_done', n);
      ELSE
        PERFORM public.mcs_finish(j.create_batch_id);
      END IF;
    EXCEPTION WHEN others THEN
      e := public.imp_wf_json(SQLERRM);
      IF e IS NULL THEN RAISE; END IF;
      PERFORM public.mi_apply_fail(p_job, e ->> 'code', coalesce(e -> 'extra' ->> 'detail',
        CASE WHEN e ->> 'code' = 'step_up_required' THEN 'The confirmation of your password expired before the background run started. Apply the file again.' END, e ->> 'code'));
      RETURN jsonb_build_object('job_id', j.id, 'state', 'failed', 'code', e ->> 'code');
    END;
  END IF;
  PERFORM set_config('pmis.mi_apply_job', p_job::text, true);
  BEGIN
    res := public.mi_apply_run(j.run_id, NULL, j.mode, j.reason, j.stepup_verified,
      CASE WHEN j.hw_reason IS NOT NULL THEN jsonb_build_object('reason', j.hw_reason, 'approve_directly', j.approve_directly, 'registers', j.load_registers,
        'reapply', j.reapply) END,   -- 0122: the re-apply chosen at the request
      j.registers,   -- 0092, 0093: the choices and the register sheets stored at the request (the sheets read by the API from the run's file)
      j.create_sites);   -- 0155: the sites were created by the steps above; the apply reads the batch from the run
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

CREATE OR REPLACE FUNCTION mi_apply_fail(p_job uuid, p_code text, p_detail text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.mi_apply_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.mi_apply_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.state <> 'running' THEN RETURN; END IF;
  UPDATE public.mi_apply_jobs SET state = 'failed', error_code = left(p_code, 60), error = left(p_detail, 2000), finished_at = clock_timestamp(), heartbeat_at = clock_timestamp()
    WHERE id = p_job;
  UPDATE public.master_reconciliation_runs SET status = 'previewed', version = version + 1 WHERE id = j.run_id AND status = 'applying';
  IF j.create_batch_id IS NOT NULL THEN
    -- 0155: the sites created so far stay (and their rows stay linked); the rows of the New sites batch not done are closed "not created"
    UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = j.actor_id, decided_at = now(),
      decision_note = left('Not created: the Master apply stopped before this row (' || coalesce(p_code, 'stopped') || '). Apply the file again.', 2000)
      WHERE batch_id = j.create_batch_id AND action = 'create' AND decision = 'pending' AND site_draft_id IS NULL;
    UPDATE public.import_batches SET status = public.imp_status_of_after(id), closed_at = coalesce(closed_at, now()), submitted_at = coalesce(submitted_at, now()), version = version + 1,
      rows_error = (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = j.create_batch_id AND x.action = 'error')
      WHERE id = j.create_batch_id AND closed_at IS NULL;
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
  VALUES ('master_import.apply_failed', 'master_reconciliation_run', j.run_id::text, jsonb_build_object('status', 'applying'),
          jsonb_build_object('status', 'previewed', 'job_id', j.id, 'code', p_code, 'create_sites', j.create_sites, 'sites_created', j.create_done), left(coalesce(p_detail, p_code), 2000), coalesce(public.app_actor(), j.actor_id));
  PERFORM public.log_system_write('warn', 'master-import', 'legacy Master import: background apply failed',
    jsonb_build_object('run_id', j.run_id, 'job_id', j.id, 'code', p_code, 'detail', left(p_detail, 500)), j.actor_id, j.request_id);
END $$;

CREATE OR REPLACE FUNCTION mi_run_applying_json(p_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('job_id', j.id, 'state', j.state, 'sites_total', j.sites_total, 'started_at', j.created_at, 'updated_at', j.heartbeat_at,
           'finished_at', j.finished_at, 'error_code', j.error_code, 'error', j.error,
           -- 0155: the creation of the sites of the file first (option create_sites), then the apply
           'create_sites', j.create_sites, 'create_total', j.create_total, 'create_done', j.create_done,
           'phase', CASE WHEN j.state <> 'running' THEN NULL
                         WHEN j.create_sites AND (j.create_batch_id IS NULL OR EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = j.create_batch_id AND b.submitted_at IS NULL))
                         THEN 'create_sites' ELSE 'apply' END)
  FROM public.mi_apply_jobs j
  WHERE j.run_id = p_run AND public.mi_can_use()
  ORDER BY j.created_at DESC LIMIT 1
$$;

-- The 7-argument door (0126) is now the wrapper of the 8-argument one, without the creation of sites: every earlier caller (the 5- and 6-argument wrappers,
-- the API without the option) is unchanged.
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb, p_registers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN public.mi_apply_run(p_run, p_version, p_mode, p_reason, p_stepup, p_historical, p_registers, false);
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC; pmis_app gets only the new door of the apply and the
--    offer of the option. The redefined functions keep their owner and grants (CREATE OR REPLACE); they are set again here so that the rule holds whatever
--    the history of the database.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['mcs_cell(jsonb,text)', 'mcs_identity(jsonb)', 'mcs_holds_both(integer)', 'mcs_rights(integer)', 'mcs_offer()', 'mcs_stage(uuid)',
                           'mcs_create_rows(uuid,integer,boolean)', 'mcs_result(uuid)', 'mcs_finish(uuid)',
                           'mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb,boolean)', 'mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)',
                           'mi_apply_step(uuid)', 'mi_apply_fail(uuid,text,text)', 'mi_run_applying_json(uuid)', 'site_create_apply(uuid,boolean)',
                           'imp_async_guard(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['mcs_cell(jsonb,text)', 'mcs_identity(jsonb)', 'mcs_holds_both(integer)', 'mcs_rights(integer)', 'mcs_stage(uuid)',
                             'mcs_create_rows(uuid,integer,boolean)', 'mcs_result(uuid)', 'mcs_finish(uuid)', 'mi_apply_fail(uuid,text,text)',
                             'site_create_apply(uuid,boolean)', 'imp_async_guard(uuid)'] LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f);
    END LOOP;
    -- the doors of the API (the apply with the option, the offer) and the ones it already had (the earlier apply, the background step, the progress)
    FOREACH f IN ARRAY ARRAY['mcs_offer()', 'mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb,boolean)', 'mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)',
                             'mi_apply_step(uuid)', 'mi_run_applying_json(uuid)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
