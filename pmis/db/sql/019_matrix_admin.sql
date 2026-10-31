-- 0020_matrix_admin: the Responsibility Matrix as an administered, audited screen (P1-BE-12). Mirror: db/sql/019_matrix_admin.sql (kept byte-identical).
--
-- One model for the register rows (decision B11). Migration 0019 already keys the cells of a register row with matrix_cells.register_key and keeps the
-- level count of the row in register_definitions.approval_levels; the reg_* functions read exactly those. This migration builds on them and adds no
-- second model: there is no matrix_rows table, no row_code column and no second level count. The Matrix screen reads and writes
--   * the cells of a register row: matrix_cells.register_key (levels 1 / 2 / 3 = Entry / Review / Approve, whatever the level count of the row),
--   * the level count of a register row: register_definitions.approval_levels (the stage rows keep theirs in stage_definitions.approval_levels).
--
-- What this adds on top of the engine (0015/0016) and the registers (0019):
--   * matrix_state: one row, a revision number that every saved change raises. It is the ETag of GET /matrix and the If-Match of PATCH /matrix.
--   * the catalogue rows of the three registers that are not built yet and have no entry in 0019 (RF & Design and Acquisition, Q44; Deliverables, Q71):
--     register_definitions rows with enabled = false, so a Matrix row exists for them and the API of the registers does not list them.
--   * seed: default holders by role code for the register rows that are NOT built yet (enabled = false): Contractors, RF & Design, Acquisition,
--     Warehouse, Quality, Issue, Risk, Change Control, Readiness & Handover, As-Built, Meetings, Deliverables and Dismantle. Nothing existing is
--     overwritten: the four registers built in 0019 (Procurement, GECOL, HLC, Permits & HSE) are not touched at all, so the Q56 entry cells that 0019
--     seeded stay as they are and, by Q90, their Review and Approve cells stay empty until the admin sets them. "Only when the cell is missing" makes
--     the seed safe to run again.
--   * matrix_save (SECURITY DEFINER, owner pmis_definer, BYPASSRLS): the only writer. It takes the actor from app_actor() (never from an argument),
--     needs System Admin or a delegation covering matrix.edit (module matrix, action edit), needs an all-regions delegation for a cell that spans
--     all regions and for a level count (both are global), checks the revision (If-Match) under a lock, refuses a used level without a holder
--     (wf:empty_cell), refuses roles that may not hold levels, applies everything in one transaction and writes one audit row per changed cell and
--     per changed level count with before and after values and the reason. A change applies to new transitions only: the engine freezes the level
--     path of a task (and of a register record) at its first submission (B7), so records in flight keep theirs and those not yet submitted follow
--     the new count.
--   * matrix_preview: the self-skip / self-approval preview (B5, B6, MX-06), computed with the engine's own rules (people behind users, roles and
--     groups; the next level is skipped when the same person holds it and its rule is any_one; reaching the last level this way is a self-approval).
--     Restricted to the regions the caller can see.
--
-- Not touched: cal_* / sla_* / calc_* / gate_eval / wf_unlock_successors, reg_* and the register tables. Contents: 1 tables and columns
-- 2 backstop and rights  3 catalogue and seed  4 helpers  5 preview  6 save  7 ownership and execute rights.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Tables and columns
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matrix_state (
  id         BOOLEAN     PRIMARY KEY DEFAULT true CHECK (id),
  revision   INTEGER     NOT NULL DEFAULT 1,
  updated_by UUID,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
INSERT INTO matrix_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE matrix_state IS 'One row. revision rises with every saved matrix change: the ETag of GET /matrix and the If-Match of PATCH /matrix.';

-- A cell belongs to a stage (stage_id, optionally one task of it) or to a register row (register_key, 0019), never both: 0019 made stage_id nullable
-- and added matrix_cells_stage_xor_register, matrix_cells_register_no_task and the unique index per (register_key, level, region).
ALTER TABLE matrix_cells ADD CONSTRAINT matrix_cells_level_check CHECK (level BETWEEN 1 AND 3) NOT VALID;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Backstop and rights: only matrix_* functions (owner pmis_definer), the draft cloner (same owner) and the migration role write the matrix cells.
--    The level count of a register row is written by matrix_save too (register_definitions: the definer may update approval_levels only).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION matrix_backstop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'pmis_definer' OR app_is_seeding() THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION '% is written only through matrix_* functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER a_matrix_backstop BEFORE INSERT OR UPDATE OR DELETE ON matrix_cells FOR EACH ROW EXECUTE FUNCTION matrix_backstop();
CREATE TRIGGER a_matrix_backstop BEFORE INSERT OR UPDATE OR DELETE ON matrix_cell_assignees FOR EACH ROW EXECUTE FUNCTION matrix_backstop();
CREATE TRIGGER a_matrix_backstop BEFORE INSERT OR UPDATE OR DELETE ON matrix_state FOR EACH ROW EXECUTE FUNCTION matrix_backstop();

-- Configuration table: everyone reads, nobody but the definer (BYPASSRLS) and the migration role writes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['matrix_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY rls_select ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY rls_insert ON %I FOR INSERT WITH CHECK (app_is_seeding())', t);
    EXECUTE format('CREATE POLICY rls_update ON %I FOR UPDATE USING (app_is_seeding()) WITH CHECK (app_is_seeding())', t);
    EXECUTE format('CREATE POLICY rls_delete ON %I FOR DELETE USING (app_is_seeding())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON matrix_state, matrix_cells, matrix_cell_assignees TO pmis_definer;
GRANT UPDATE (approval_levels) ON stage_definitions TO pmis_definer;
GRANT UPDATE (approval_levels) ON register_definitions TO pmis_definer;   -- 0019 gave the definer SELECT only
GRANT SELECT ON regions, workflow_definitions, task_definitions, stage_definitions, users, roles, groups, group_members, user_role_assignments,
  user_role_assignment_regions, user_role_assignment_modules, delegations TO pmis_definer;
GRANT INSERT ON audit_log TO pmis_definer;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON matrix_state TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON matrix_cells, matrix_cell_assignees, matrix_state FROM pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Catalogue and seed. Default holders by role code (editable in the screen). Nothing existing is overwritten.
--    Entry / Review / Approve per row. Defaults follow B2 (the owning team lead reviews, the Project Manager approves) and Q44 / Q71 (RF & Design
--    and Acquisition take the stage-1 holders: the RF / MW / Acquisition roles enter, the RF & Design / Acquisition Team Lead reviews and approves;
--    Deliverables: entry by Project Support, approval by the Project Manager). ASSUMPTION for every row except the stage-1 ones; open question Q85.
-- ---------------------------------------------------------------------------------------------------------------------
-- The catalogue of 0019 has no row for RF & Design, Acquisition (Q44) and Deliverables (Q71). They get a row that is not enabled (the API of the
-- registers lists only enabled registers and refuses records of the others), so the Matrix has its row and the engine can read its cells later.
INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('rf_design',    'RF & Design',  'تصميم RF',   'rf_design',    'register', true,  false, ARRAY[]::text[], 3, '{}'::jsonb, false, 22),
  ('acquisition',  'Acquisition',  'الاستحواذ',  'acquisition',  'register', true,  false, ARRAY[]::text[], 3, '{}'::jsonb, false, 24),
  ('deliverables', 'Deliverables', 'المخرجات',   'deliverables', 'register', false, true,  ARRAY[]::text[], 3, '{}'::jsonb, false, 135)
ON CONFLICT (register_key) DO NOTHING;

DO $seed$
DECLARE r record; cid uuid; ids uuid[]; prev text := coalesce(current_setting('app.region_ids', true), '');
BEGIN
  PERFORM set_config('app.region_ids', '*', true);   -- the migration role seeds global cells: the row-level policy of matrix_cells wants a full-access session
  FOR r IN SELECT * FROM (VALUES
    ('contractors',        1, ARRAY['PROJ_SUPPORT']),
    ('contractors',        2, ARRAY['CW_TL']),
    ('contractors',        3, ARRAY['PM']),
    ('rf_design',          1, ARRAY['RF_ENG', 'MW_ENG', 'ACQ_TEAM']),
    ('rf_design',          2, ARRAY['RFD_ACQ_TL']),
    ('rf_design',          3, ARRAY['RFD_ACQ_TL']),
    ('acquisition',        1, ARRAY['RF_ENG', 'MW_ENG', 'ACQ_TEAM']),
    ('acquisition',        2, ARRAY['RFD_ACQ_TL']),
    ('acquisition',        3, ARRAY['RFD_ACQ_TL']),
    ('warehouse',          1, ARRAY['INV_SUP']),
    ('warehouse',          2, ARRAY['PROJ_SUPPORT']),
    ('warehouse',          3, ARRAY['PM']),
    ('quality',            1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE']),
    ('quality',            2, ARRAY['CW_TL', 'TE_TL']),
    ('quality',            3, ARRAY['PM']),
    ('issues',             1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE', 'PROJ_SUPPORT']),
    ('issues',             2, ARRAY['CW_TL', 'TE_TL']),
    ('issues',             3, ARRAY['PM']),
    ('risks',              1, ARRAY['PROJ_SUPPORT']),
    ('risks',              2, ARRAY['CW_TL', 'TE_TL', 'RFD_ACQ_TL']),
    ('risks',              3, ARRAY['PM']),
    ('change_control',     1, ARRAY['PROJ_SUPPORT']),
    ('change_control',     2, ARRAY['CW_TL', 'TE_TL']),
    ('change_control',     3, ARRAY['PM']),
    ('readiness_handover', 1, ARRAY['SITE_ENG_TE', 'HOTO_ENG']),
    ('readiness_handover', 2, ARRAY['TE_TL']),
    ('readiness_handover', 3, ARRAY['PM']),
    ('as_built',           1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE']),
    ('as_built',           2, ARRAY['CW_TL', 'TE_TL']),
    ('as_built',           3, ARRAY['PM']),
    ('meetings',           1, ARRAY['PROJ_SUPPORT']),
    ('meetings',           2, ARRAY['CW_TL', 'TE_TL']),
    ('meetings',           3, ARRAY['PM']),
    ('deliverables',       1, ARRAY['PROJ_SUPPORT']),
    ('deliverables',       2, ARRAY['CW_TL', 'TE_TL']),
    ('deliverables',       3, ARRAY['PM']),
    ('dismantle',          1, ARRAY['SITE_ENG_CW', 'SITE_ENG_TE']),
    ('dismantle',          2, ARRAY['CW_TL', 'TE_TL']),
    ('dismantle',          3, ARRAY['PM'])
  ) AS v(code, lvl, role_codes) LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM register_definitions d WHERE d.register_key = r.code AND NOT d.enabled);   -- the registers built in 0019 are left to Q90
    CONTINUE WHEN EXISTS (SELECT 1 FROM matrix_cells c WHERE c.register_key = r.code AND c.level = r.lvl AND c.region_id IS NULL);
    SELECT coalesce(array_agg(ro.id ORDER BY ro.code COLLATE "C"), ARRAY[]::uuid[]) INTO ids FROM roles ro WHERE ro.code = ANY (r.role_codes) AND ro.can_hold_matrix_levels;
    CONTINUE WHEN cardinality(ids) = 0;
    INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES (r.code, r.lvl, 'any_one', NULL, true, now()) RETURNING id INTO cid;
    INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', x FROM unnest(ids) AS x ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.region_ids', prev, true);
END $seed$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Helpers (internal: executable only by the owner, except where section 7 grants them to the application role)
-- ---------------------------------------------------------------------------------------------------------------------
-- Is a cell level in use for a row with p_n levels? Entry = cell level 1, approve = cell level 3, review = cell level 2 (as wf_cell reads them).
CREATE OR REPLACE FUNCTION matrix_level_used(p_n int, p_level int) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_level = 1 OR (p_level = 3 AND p_n >= 2) OR (p_level = 2 AND p_n >= 3) $$;

CREATE OR REPLACE FUNCTION matrix_level_kind(p_level int) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_level WHEN 1 THEN 'entry' WHEN 2 THEN 'review' ELSE 'approve' END $$;

-- Is the user active and able to work in this region and module (the same test wf_user_in_scope applies with module `sites`)?
CREATE OR REPLACE FUNCTION matrix_user_in_scope(p_user uuid, p_region int, p_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass)
     AND (public.app_user_is_system_admin(p_user)
          OR EXISTS (SELECT 1 FROM public.user_role_assignments ua
                     WHERE ua.user_id = p_user AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
                       AND (ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions r WHERE r.assignment_id = ua.id AND r.region_id = p_region))
                       AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = ua.id AND m.module_key = p_module))))
$$;

-- The effective cell of a level for a scope and a region: task+region > task > stage+region > stage (the order of wf_cell); a register row has no task.
CREATE OR REPLACE FUNCTION matrix_eff_cell(p_stage uuid, p_row text, p_task uuid, p_level int, p_region int) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id
  FROM public.matrix_cells c
  WHERE c.level = p_level AND (c.region_id IS NULL OR c.region_id = p_region)
    AND ((p_row IS NOT NULL AND c.register_key = p_row AND c.task_def_id IS NULL)
      OR (p_row IS NULL AND c.stage_id = p_stage AND (c.task_def_id IS NULL OR c.task_def_id = p_task)))
  ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id
  LIMIT 1
$$;

-- The people behind a cell for a region and module (users; roles through active assignments of enough level; active groups), in scope.
CREATE OR REPLACE FUNCTION matrix_people(p_cell uuid, p_kind text, p_region int, p_module text) RETURNS TABLE (o_user uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE need public."PermissionLevel";
BEGIN
  IF p_cell IS NULL THEN RETURN; END IF;
  need := p_kind::public."PermissionLevel";
  RETURN QUERY
  WITH ex AS (
    SELECT a.ref_id AS uid FROM public.matrix_cell_assignees a WHERE a.cell_id = p_cell AND a.kind = 'user'
    UNION
    SELECT ua.user_id
      FROM public.matrix_cell_assignees a
      JOIN public.roles r ON r.id = a.ref_id AND r.is_active AND r.can_hold_matrix_levels
      JOIN public.user_role_assignments ua ON ua.role_id = r.id
      WHERE a.cell_id = p_cell AND a.kind = 'role'
        AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now())
        AND ua.permission_level >= need
        AND (ua.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions rr WHERE rr.assignment_id = ua.id AND rr.region_id = p_region))
        AND (ua.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules mm WHERE mm.assignment_id = ua.id AND mm.module_key = p_module))
    UNION
    SELECT gm.user_id
      FROM public.matrix_cell_assignees a
      JOIN public.groups g ON g.id = a.ref_id AND g.is_active
      JOIN public.group_members gm ON gm.group_id = g.id
      WHERE a.cell_id = p_cell AND a.kind = 'group'
  )
  SELECT DISTINCT ex.uid FROM ex WHERE public.matrix_user_in_scope(ex.uid, p_region, p_module);
END $$;

-- A cell as JSON for the audit log: scope, task, level, region, rule and the holders with their names.
CREATE OR REPLACE FUNCTION matrix_cell_json(p_cell uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'row', coalesce(st.code, c.register_key), 'task_code', td.code, 'level', c.level, 'level_kind', public.matrix_level_kind(c.level),
    'region_id', c.region_id, 'rule', c.rule,
    'assignees', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', a.kind, 'ref_id', a.ref_id,
                      'label', coalesce(u.display_name, ro.name_en, g.name), 'employee_id', nullif(btrim(u.employee_id), ''))
                      ORDER BY a.kind::text COLLATE "C", coalesce(u.display_name, ro.name_en, g.name) COLLATE "C", a.ref_id)
                    FROM public.matrix_cell_assignees a
                    LEFT JOIN public.users u ON a.kind = 'user' AND u.id = a.ref_id
                    LEFT JOIN public.roles ro ON a.kind = 'role' AND ro.id = a.ref_id
                    LEFT JOIN public.groups g ON a.kind = 'group' AND g.id = a.ref_id
                    WHERE a.cell_id = c.id), '[]'::jsonb))
  FROM public.matrix_cells c
  LEFT JOIN public.stage_definitions st ON st.id = c.stage_id
  LEFT JOIN public.task_definitions td ON td.id = c.task_def_id
  WHERE c.id = p_cell
$$;

CREATE OR REPLACE FUNCTION matrix_audit(p_action text, p_entity text, p_id text, p_region int, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); obo uuid;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN
    SELECT d.from_user_id INTO obo FROM public.app_user_delegations(a) x(id) JOIN public.delegations d ON d.id = x.id LIMIT 1;   -- "X on behalf of System Admin"
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, before, after, reason, actor_id, on_behalf_of, is_admin_override)
  VALUES (p_action, p_entity, p_id, p_region, p_before, p_after, p_reason, a, obo, false);
END $$;

-- Used levels without a holder for one row (a stage or a register row), as a JSON list for the error `empty_cell`.
CREATE OR REPLACE FUNCTION matrix_empty_cells(p_stage uuid, p_row text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int; code text; lvl int; cid uuid; res jsonb := '[]'::jsonb; c record; tn int;
BEGIN
  IF p_row IS NOT NULL THEN
    SELECT d.approval_levels, d.register_key INTO n, code FROM public.register_definitions d WHERE d.register_key = p_row;
  ELSE
    SELECT s.approval_levels, s.code INTO n, code FROM public.stage_definitions s WHERE s.id = p_stage;
  END IF;
  IF n IS NULL THEN RETURN res; END IF;
  FOR lvl IN 1..3 LOOP
    CONTINUE WHEN NOT public.matrix_level_used(n, lvl);
    SELECT c2.id INTO cid FROM public.matrix_cells c2
      WHERE c2.level = lvl AND c2.region_id IS NULL AND c2.task_def_id IS NULL
        AND ((p_row IS NOT NULL AND c2.register_key = p_row) OR (p_row IS NULL AND c2.stage_id = p_stage))
      ORDER BY c2.id LIMIT 1;
    IF cid IS NULL OR NOT EXISTS (SELECT 1 FROM public.matrix_cell_assignees a WHERE a.cell_id = cid) THEN
      res := res || jsonb_build_array(jsonb_build_object('stage_code', code, 'task_code', NULL, 'level', lvl, 'level_kind', public.matrix_level_kind(lvl), 'region_id', NULL));
    END IF;
  END LOOP;
  -- task- and region-specific cells that exist must not be empty at a level that is in use
  FOR c IN
    SELECT k.level, k.region_id, td.code AS task_code, coalesce(td.approval_levels, n) AS tn
    FROM public.matrix_cells k LEFT JOIN public.task_definitions td ON td.id = k.task_def_id
    WHERE ((p_row IS NOT NULL AND k.register_key = p_row) OR (p_row IS NULL AND k.stage_id = p_stage))
      AND (k.task_def_id IS NOT NULL OR k.region_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM public.matrix_cell_assignees a WHERE a.cell_id = k.id)
    ORDER BY k.level, td.code COLLATE "C" NULLS FIRST, k.region_id NULLS FIRST
  LOOP
    tn := c.tn;
    IF public.matrix_level_used(tn, c.level) THEN
      res := res || jsonb_build_array(jsonb_build_object('stage_code', code, 'task_code', c.task_code, 'level', c.level, 'level_kind', public.matrix_level_kind(c.level), 'region_id', c.region_id));
    END IF;
  END LOOP;
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Self-skip / self-approval preview (B5, B6, MX-06), for one workflow version.
--    For every scope (stage default, a task with its own cells, a register row) and every region the caller can see, and for every level a
--    person holds: when they also hold the next level and its rule is any_one, that next level is skipped for them (the engine's wf_chain);
--    when the chain reaches the last level the task becomes a self-approval (needs step-up). Only the cases that skip are returned.
--    Level 1 of a one-level row is a self-approval for every holder; the API reports that as a flag, not as rows.
--    from_kind = the level the person acts at; skipped = the kinds skipped after it, in order.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION matrix_preview(p_workflow int)
RETURNS TABLE (o_row text, o_task text, o_region int, o_user uuid, o_from text, o_skipped text[], o_final boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  wf uuid; sc record; rg record; n int; p0 int; lvl int; nxt int; kn text; u uuid; sk text[];
  h1 uuid[]; h2 uuid[]; h3 uuid[]; rl2 public."MatrixRule"; rl3 public."MatrixRule"; c1 uuid; c2 uuid; c3 uuid; cur uuid[]; nx uuid[]; nrule public."MatrixRule";
BEGIN
  SELECT w.id INTO wf FROM public.workflow_definitions w WHERE w.version = p_workflow;
  IF wf IS NULL THEN RETURN; END IF;
  FOR sc IN
    SELECT st.code AS rcode, st.id AS stage_id, NULL::text AS row_code, NULL::uuid AS task_id, NULL::text AS tcode, st.approval_levels AS n, 'sites'::text AS module
      FROM public.stage_definitions st WHERE st.workflow_id = wf AND st.is_active
    UNION ALL
    SELECT st.code, st.id, NULL::text, td.id, td.code, coalesce(td.approval_levels, st.approval_levels), 'sites'::text
      FROM public.task_definitions td JOIN public.stage_definitions st ON st.id = td.stage_id
      WHERE td.workflow_id = wf AND td.is_active AND EXISTS (SELECT 1 FROM public.matrix_cells k WHERE k.task_def_id = td.id)
    UNION ALL
    SELECT d.register_key, NULL::uuid, d.register_key, NULL::uuid, NULL::text, d.approval_levels, d.module_key
      FROM public.register_definitions d WHERE d.is_active
  LOOP
    n := sc.n;
    CONTINUE WHEN n < 2;
    FOR rg IN SELECT r.id FROM public.regions r WHERE public.app_region_check(r.id) ORDER BY r.id LOOP
      c1 := public.matrix_eff_cell(sc.stage_id, sc.row_code, sc.task_id, 1, rg.id);
      c2 := public.matrix_eff_cell(sc.stage_id, sc.row_code, sc.task_id, 2, rg.id);
      c3 := public.matrix_eff_cell(sc.stage_id, sc.row_code, sc.task_id, 3, rg.id);
      h1 := ARRAY(SELECT x.o_user FROM public.matrix_people(c1, 'entry', rg.id, sc.module) x);
      h2 := CASE WHEN n >= 3 THEN ARRAY(SELECT x.o_user FROM public.matrix_people(c2, 'review', rg.id, sc.module) x) ELSE ARRAY[]::uuid[] END;
      h3 := ARRAY(SELECT x.o_user FROM public.matrix_people(c3, 'approve', rg.id, sc.module) x);
      rl2 := coalesce((SELECT k.rule FROM public.matrix_cells k WHERE k.id = c2), 'any_one');
      rl3 := coalesce((SELECT k.rule FROM public.matrix_cells k WHERE k.id = c3), 'any_one');
      -- positions 1..n; position p has kind wf_kind(n, p): entry, then review (only when n = 3), then approve
      FOR p0 IN 1..(n - 1) LOOP
        cur := CASE WHEN p0 = 1 THEN h1 ELSE h2 END;
        FOREACH u IN ARRAY cur LOOP
          lvl := p0; sk := ARRAY[]::text[];
          LOOP
            EXIT WHEN lvl >= n;
            nxt := lvl + 1;
            kn := public.wf_kind(n, nxt);
            nx := CASE kn WHEN 'review' THEN h2 ELSE h3 END;
            nrule := CASE kn WHEN 'review' THEN rl2 ELSE rl3 END;
            IF nrule = 'any_one' AND u = ANY (nx) THEN
              sk := sk || kn; lvl := nxt;
            ELSE
              EXIT;
            END IF;
          END LOOP;
          IF cardinality(sk) > 0 THEN
            o_row := sc.rcode; o_task := sc.tcode; o_region := rg.id; o_user := u; o_from := public.wf_kind(n, p0); o_skipped := sk; o_final := lvl >= n;
            RETURN NEXT;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. matrix_save: the only writer (see the header). p_levels = [{code, approval_levels}], p_cells = [{code, task_code, level, region_id, rule,
--    assignees: [{kind, ref_id}]}]; `code` is a stage code of the workflow version or a matrix row code. p_version = the revision the caller read
--    (NULL = any). Returns {revision, changed, cells_changed, levels_changed}.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION matrix_save(p_workflow int, p_version int, p_levels jsonb, p_cells jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); wf uuid; st public.matrix_state%ROWTYPE;
  el jsonb; i int; j int; v_code text; v_task text; lvl int; reg int; rl public."MatrixRule"; sid uuid; rcode text; tid uuid; old_n int; new_n int;
  cid uuid; old_rule public."MatrixRule"; is_new boolean; before jsonb; after jsonb; asg jsonb; ak text; ar uuid;
  want_k text[]; want_r uuid[]; have_k text[]; have_r uuid[]; touched text[] := ARRAY[]::text[]; tkey text; cells_n int := 0; levels_n int := 0;
  empty jsonb; bad jsonb; rev int; same boolean; sys boolean;
BEGIN
  IF actor IS NULL OR NOT public.app_actor_is_admin('matrix', 'edit') THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering matrix.edit required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  sys := public.app_actor_is_system_admin();
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of at least 3 characters is required.'))));
  END IF;
  SELECT w.id INTO wf FROM public.workflow_definitions w WHERE w.version = p_workflow;
  IF wf IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/workflow_version', 'code', 'unknown_version', 'message', 'No such workflow version.'))));
  END IF;
  SELECT * INTO st FROM public.matrix_state WHERE id FOR UPDATE;   -- one editor at a time
  IF p_version IS NOT NULL AND p_version <> st.revision THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The matrix changed since you read it. Reload and try again.'));
  END IF;

  -- level counts (global: they reach every region)
  FOR el, i IN SELECT e, (o - 1)::int FROM jsonb_array_elements(coalesce(p_levels, '[]'::jsonb)) WITH ORDINALITY AS t(e, o) LOOP
    v_code := el ->> 'code'; new_n := (el ->> 'approval_levels')::int;
    IF new_n IS NULL OR new_n < 1 OR new_n > 3 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/stage_levels/' || i || '/approval_levels', 'code', 'invalid', 'message', 'Levels are 1 to 3.'))));
    END IF;
    IF NOT sys AND public.app_actor_region_filter('matrix', 'edit') IS NOT NULL THEN
      RAISE EXCEPTION 'matrix: a level count applies to every region and needs a delegation for all regions' USING ERRCODE = 'insufficient_privilege';
    END IF;
    sid := NULL; rcode := NULL;
    SELECT s.id, s.approval_levels INTO sid, old_n FROM public.stage_definitions s WHERE s.workflow_id = wf AND s.code = v_code;
    IF sid IS NULL THEN
      SELECT d.register_key, d.approval_levels INTO rcode, old_n FROM public.register_definitions d WHERE d.register_key = v_code AND d.is_active FOR UPDATE;
    END IF;
    IF sid IS NULL AND rcode IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/stage_levels/' || i || '/stage_code', 'code', 'unknown_row', 'message', 'No such stage or register row.'))));
    END IF;
    IF old_n IS DISTINCT FROM new_n THEN
      IF sid IS NOT NULL THEN
        UPDATE public.stage_definitions SET approval_levels = new_n WHERE id = sid;
        touched := touched || ('S:' || sid::text);
      ELSE
        UPDATE public.register_definitions SET approval_levels = new_n WHERE register_key = rcode;   -- the one level count of a register row; reg_levels_live reads it
        touched := touched || ('R:' || rcode);
      END IF;
      PERFORM public.matrix_audit('matrix_levels_update', 'matrix_row', v_code, NULL,
        jsonb_build_object('row', v_code, 'workflow_version', p_workflow, 'approval_levels', old_n),
        jsonb_build_object('row', v_code, 'workflow_version', p_workflow, 'approval_levels', new_n), p_reason);
      levels_n := levels_n + 1;
    END IF;
  END LOOP;

  -- cells
  FOR el, i IN SELECT e, (o - 1)::int FROM jsonb_array_elements(coalesce(p_cells, '[]'::jsonb)) WITH ORDINALITY AS t(e, o) LOOP
    v_code := el ->> 'code'; v_task := nullif(el ->> 'task_code', ''); lvl := (el ->> 'level')::int;
    reg := CASE WHEN jsonb_typeof(el -> 'region_id') = 'number' THEN (el ->> 'region_id')::int END;
    rl := coalesce(el ->> 'rule', 'any_one')::public."MatrixRule";
    IF lvl IS NULL OR lvl < 1 OR lvl > 3 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/cells/' || i || '/level', 'code', 'invalid', 'message', 'Levels are 1 to 3.'))));
    END IF;
    IF lvl = 1 AND rl = 'all_members' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/cells/' || i || '/rule', 'code', 'entry_rule_fixed',
        'message', 'The Entry level is always any one member: the first member to act claims the task.'))));
    END IF;
    sid := NULL; rcode := NULL; tid := NULL;
    SELECT s.id INTO sid FROM public.stage_definitions s WHERE s.workflow_id = wf AND s.code = v_code;
    IF sid IS NULL THEN SELECT d.register_key INTO rcode FROM public.register_definitions d WHERE d.register_key = v_code AND d.is_active; END IF;
    IF sid IS NULL AND rcode IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/cells/' || i || '/stage_code', 'code', 'unknown_row', 'message', 'No such stage or register row.'))));
    END IF;
    IF v_task IS NOT NULL THEN
      IF sid IS NOT NULL THEN SELECT td.id INTO tid FROM public.task_definitions td WHERE td.workflow_id = wf AND td.stage_id = sid AND td.code = v_task; END IF;
      IF tid IS NULL THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/cells/' || i || '/task_code', 'code', 'unknown_task', 'message', 'No such task in this stage.'))));
      END IF;
    END IF;
    IF reg IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id = reg) THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/cells/' || i || '/region_id', 'code', 'unknown_region', 'message', 'No such region.'))));
      END IF;
      IF NOT public.app_actor_is_admin('matrix', 'edit', ARRAY[reg]) THEN
        RAISE EXCEPTION 'matrix: no matrix.edit right for region %', reg USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NOT sys AND public.app_actor_region_filter('matrix', 'edit') IS NOT NULL THEN
      RAISE EXCEPTION 'matrix: a cell for all regions needs a delegation for all regions' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- wanted holders (deduplicated)
    want_k := ARRAY[]::text[]; want_r := ARRAY[]::uuid[];
    FOR asg, j IN SELECT e, (o - 1)::int FROM jsonb_array_elements(coalesce(el -> 'assignees', '[]'::jsonb)) WITH ORDINALITY AS t(e, o) LOOP
      ak := asg ->> 'kind'; ar := (asg ->> 'ref_id')::uuid;
      CONTINUE WHEN EXISTS (SELECT 1 FROM unnest(want_k, want_r) AS w(k, r) WHERE w.k = ak AND w.r = ar);
      want_k := want_k || ak; want_r := want_r || ar;
    END LOOP;

    -- the existing cell, and who holds it now
    SELECT c.id, c.rule INTO cid, old_rule FROM public.matrix_cells c
      WHERE c.level = lvl AND c.region_id IS NOT DISTINCT FROM reg
        AND ((rcode IS NOT NULL AND c.register_key = rcode) OR (rcode IS NULL AND c.stage_id = sid AND c.task_def_id IS NOT DISTINCT FROM tid))
      ORDER BY c.id LIMIT 1 FOR UPDATE;
    is_new := cid IS NULL;
    have_k := ARRAY[]::text[]; have_r := ARRAY[]::uuid[];
    IF NOT is_new THEN
      SELECT coalesce(array_agg(a.kind::text), ARRAY[]::text[]), coalesce(array_agg(a.ref_id), ARRAY[]::uuid[]) INTO have_k, have_r FROM public.matrix_cell_assignees a WHERE a.cell_id = cid;
    END IF;

    -- who may be added: active users, active groups, active roles that may hold levels (people already in the cell stay as they are)
    FOR j IN 1..coalesce(cardinality(want_k), 0) LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM unnest(have_k, have_r) AS h(k, r) WHERE h.k = want_k[j] AND h.r = want_r[j]);
      bad := NULL;
      IF want_k[j] = 'user' THEN
        IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = want_r[j]) THEN bad := jsonb_build_object('code', 'unknown_holder', 'message', 'No such user.');
        ELSIF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = want_r[j] AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass) THEN
          bad := jsonb_build_object('code', 'holder_inactive', 'message', 'This user is not active and cannot hold a level.');
        END IF;
      ELSIF want_k[j] = 'role' THEN
        IF NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.id = want_r[j]) THEN bad := jsonb_build_object('code', 'unknown_holder', 'message', 'No such role.');
        ELSIF NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.id = want_r[j] AND r.can_hold_matrix_levels) THEN
          bad := jsonb_build_object('code', 'role_cannot_hold_levels', 'message', 'This role may not hold matrix levels.');
        ELSIF NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.id = want_r[j] AND r.is_active) THEN
          bad := jsonb_build_object('code', 'holder_inactive', 'message', 'This role is not active.');
        END IF;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = want_r[j]) THEN bad := jsonb_build_object('code', 'unknown_holder', 'message', 'No such group.');
        ELSIF NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = want_r[j] AND g.is_active) THEN
          bad := jsonb_build_object('code', 'holder_inactive', 'message', 'This group is not active.');
        END IF;
      END IF;
      IF bad IS NOT NULL THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(bad || jsonb_build_object('path', '/cells/' || i || '/assignees/' || (j - 1)))));
      END IF;
    END LOOP;

    -- no change at all: nothing to write
    same := NOT is_new AND old_rule = rl
            AND NOT EXISTS (SELECT 1 FROM unnest(want_k, want_r) AS w(k, r) WHERE NOT EXISTS (SELECT 1 FROM unnest(have_k, have_r) AS h(k, r) WHERE h.k = w.k AND h.r = w.r))
            AND NOT EXISTS (SELECT 1 FROM unnest(have_k, have_r) AS h(k, r) WHERE NOT EXISTS (SELECT 1 FROM unnest(want_k, want_r) AS w(k, r) WHERE w.k = h.k AND w.r = h.r));
    CONTINUE WHEN same;

    before := CASE WHEN is_new THEN NULL ELSE public.matrix_cell_json(cid) END;
    IF is_new THEN
      INSERT INTO public.matrix_cells (stage_id, register_key, task_def_id, level, rule, region_id, is_global, updated_by, updated_at)
      VALUES (sid, rcode, tid, lvl, rl, reg, reg IS NULL, actor, now()) RETURNING id INTO cid;
    ELSE
      UPDATE public.matrix_cells SET rule = rl, updated_by = actor, updated_at = now() WHERE id = cid;
      DELETE FROM public.matrix_cell_assignees a WHERE a.cell_id = cid
        AND NOT EXISTS (SELECT 1 FROM unnest(want_k, want_r) AS w(k, r) WHERE w.k = a.kind::text AND w.r = a.ref_id);
    END IF;
    INSERT INTO public.matrix_cell_assignees (cell_id, kind, ref_id)
      SELECT cid, w.k::public."AssigneeKind", w.r FROM unnest(want_k, want_r) AS w(k, r) ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
    after := public.matrix_cell_json(cid);
    PERFORM public.matrix_audit(CASE WHEN is_new THEN 'matrix_cell_create' ELSE 'matrix_cell_update' END, 'matrix_cell', cid::text, reg,
      CASE WHEN before IS NULL THEN NULL ELSE before || jsonb_build_object('workflow_version', p_workflow) END, after || jsonb_build_object('workflow_version', p_workflow), p_reason);
    cells_n := cells_n + 1;
    tkey := CASE WHEN rcode IS NOT NULL THEN 'R:' || rcode ELSE 'S:' || sid::text END;
    IF NOT tkey = ANY (touched) THEN touched := touched || tkey; END IF;
  END LOOP;

  -- every level in use of every touched row needs a holder (MX-02): the message names the cells
  empty := '[]'::jsonb;
  FOREACH tkey IN ARRAY touched LOOP
    empty := empty || CASE WHEN left(tkey, 2) = 'S:' THEN public.matrix_empty_cells(substr(tkey, 3)::uuid, NULL) ELSE public.matrix_empty_cells(NULL, substr(tkey, 3)) END;
  END LOOP;
  IF jsonb_array_length(empty) > 0 THEN
    PERFORM public.wf_err('empty_cell', jsonb_build_object('detail', 'Every level in use needs at least one holder.', 'cells', empty));
  END IF;

  rev := st.revision;
  IF levels_n + cells_n > 0 THEN
    UPDATE public.matrix_state SET revision = revision + 1, updated_by = actor, updated_at = now() WHERE id RETURNING revision INTO rev;
  END IF;
  RETURN jsonb_build_object('revision', rev, 'changed', levels_n + cells_n > 0, 'cells_changed', cells_n, 'levels_changed', levels_n);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and execute rights. The API calls only matrix_preview and matrix_save; the rest are internal to the owner.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'matrix_user_in_scope(uuid,int,text)', 'matrix_eff_cell(uuid,text,uuid,int,int)', 'matrix_people(uuid,text,int,text)', 'matrix_cell_json(uuid)',
    'matrix_audit(text,text,text,int,jsonb,jsonb,text)', 'matrix_empty_cells(uuid,text)', 'matrix_preview(int)', 'matrix_save(int,int,jsonb,jsonb,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  ALTER FUNCTION matrix_backstop() OWNER TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION matrix_preview(int) TO pmis_app;
    GRANT EXECUTE ON FUNCTION matrix_save(int, int, jsonb, jsonb, text) TO pmis_app;
  END IF;
END $$;
