-- 0032_two_levels: the owner decision of 2026-11-01 (CLAUDE.md "Two approval levels"): every task, register record and Dismantle part has exactly two levels,
-- L1 = Data Entry and L2 = Data Reviewer & Approver. The number of levels is no longer configurable.
-- Mirror: db/sql/031_two_levels.sql (kept identical to prisma/migrations/0032_two_levels/migration.sql).
--
-- How the engine carries it (no rewrite of the wf_* / reg_* functions): a row with 2 levels runs level 1 = kind 'entry' (L1) and level 2 = kind 'approve' (L2);
-- the middle kind 'review' simply never occurs for it. The L2 holders are therefore the cells stored at matrix level 3 (the final approver's cells, as wf_cell and
-- reg_cell_row read them). The skip rule and the self-approval rule (B5) are unchanged: a person who holds L1 and L2 has the submission skip L2 and it is a
-- self-approval (step-up, flag in the KPIs and the audit log). Group claim, all_members (B10) and the no-holder alert work as before.
--
-- What changes:
--   1. Holders. Where a scope (stage or register row, optionally one task, optionally one region) has no L2 holder, the holders of its middle level become
--      its L2 holders (a missing L2 cell is created with the middle cell's rule). Where both have holders, the final approver's holders win, as decided.
--      The middle cells are kept: tasks and register records already submitted on 3 levels still need them (below).
--   2. Level counts. Stage, task and register definitions all become 2, and a CHECK refuses anything else, so no write path (matrix_save, the task-definition
--      functions, a workflow publish) can set 1 or 3. New tasks and records default to 2.
--   3. Items not yet submitted (no path snapshot) follow the new count: levels_required becomes 2.
--   4. Items already submitted keep their snapshot and finish on it (B7). Collapsing them in place would move a task that sits at the middle level to a level whose
--      holders are not the ones who were asked, so it is not done; they finish on their 3 levels with the middle holders, and a rejection returns them to L1 and
--      back along the same snapshot. They disappear as the in-flight work closes. Nothing is rewritten in their history.
--   5. Permission level 'review' (the middle level) is folded into 'approve' (= L2): the people who reviewed can now hold L2. The old value is still accepted
--      on input and stored as 'approve'. 'entry' = L1, 'approve' = L2 (and it may also be named at L1, which is how one person holds both).
--   6. The matrix revision rises, so an editor holding the old matrix gets 412 and reloads.

-- the tables below have forced row-level security; this runs as the migration role, which sees every region
SELECT set_config('app.region_ids', '*', true);

DO $$
BEGIN

  -- 1a. a missing L2 cell where the middle level has holders
  INSERT INTO matrix_cells (stage_id, register_key, task_def_id, level, rule, region_id, is_global, updated_at)
  SELECT c.stage_id, c.register_key, c.task_def_id, 3, c.rule, c.region_id, c.is_global, now()
  FROM matrix_cells c
  WHERE c.level = 2 AND EXISTS (SELECT 1 FROM matrix_cell_assignees a WHERE a.cell_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM matrix_cells f WHERE f.level = 3 AND f.stage_id IS NOT DISTINCT FROM c.stage_id AND f.register_key IS NOT DISTINCT FROM c.register_key
                    AND f.task_def_id IS NOT DISTINCT FROM c.task_def_id AND f.region_id IS NOT DISTINCT FROM c.region_id);

  -- 1b. an L2 cell without holders takes the holders of the middle cell of the same scope
  INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id)
  SELECT f.id, a.kind, a.ref_id
  FROM matrix_cells f
  JOIN matrix_cells c ON c.level = 2 AND c.stage_id IS NOT DISTINCT FROM f.stage_id AND c.register_key IS NOT DISTINCT FROM f.register_key
                     AND c.task_def_id IS NOT DISTINCT FROM f.task_def_id AND c.region_id IS NOT DISTINCT FROM f.region_id
  JOIN matrix_cell_assignees a ON a.cell_id = c.id
  WHERE f.level = 3 AND NOT EXISTS (SELECT 1 FROM matrix_cell_assignees x WHERE x.cell_id = f.id)
  ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
END $$;

-- 5. the middle permission level folds into L2
UPDATE user_role_assignments SET permission_level = 'approve' WHERE permission_level = 'review';
CREATE OR REPLACE FUNCTION two_levels_normalise() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.permission_level = 'review' THEN NEW.permission_level := 'approve'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_two_levels_normalise BEFORE INSERT OR UPDATE OF permission_level ON user_role_assignments FOR EACH ROW EXECUTE FUNCTION two_levels_normalise();

-- 2. level counts
UPDATE stage_definitions SET approval_levels = 2 WHERE approval_levels <> 2;
UPDATE task_definitions SET approval_levels = 2 WHERE approval_levels IS NOT NULL AND approval_levels <> 2;
UPDATE register_definitions SET approval_levels = 2 WHERE approval_levels <> 2;
ALTER TABLE register_definitions DROP CONSTRAINT register_definitions_approval_levels_check;
ALTER TABLE stage_definitions ADD CONSTRAINT stage_definitions_two_levels CHECK (approval_levels = 2);
ALTER TABLE task_definitions ADD CONSTRAINT task_definitions_two_levels CHECK (approval_levels IS NULL OR approval_levels = 2);
ALTER TABLE register_definitions ADD CONSTRAINT register_definitions_two_levels CHECK (approval_levels = 2);
ALTER TABLE stage_definitions ALTER COLUMN approval_levels SET DEFAULT 2;
ALTER TABLE register_definitions ALTER COLUMN approval_levels SET DEFAULT 2;
ALTER TABLE task_instances ALTER COLUMN levels_required SET DEFAULT 2;
ALTER TABLE register_records ALTER COLUMN levels_required SET DEFAULT 2;
COMMENT ON COLUMN stage_definitions.approval_levels IS 'Always 2 (L1 Data Entry, L2 Data Reviewer & Approver); fixed by the owner decision of 2026-11-01 and enforced by a CHECK.';
COMMENT ON COLUMN task_definitions.approval_levels IS 'Null or 2: the number of levels is fixed (owner decision 2026-11-01).';
COMMENT ON COLUMN register_definitions.approval_levels IS 'Always 2 (L1 Data Entry, L2 Data Reviewer & Approver); fixed by the owner decision of 2026-11-01 and enforced by a CHECK.';
COMMENT ON COLUMN task_instances.levels_required IS 'Number of levels: 2 for everything submitted since migration 0032; 1..3 only for tasks already submitted on their old snapshot (B7). Final once path_frozen_at is set.';

-- 3. not yet submitted items follow the new count
UPDATE task_instances SET levels_required = 2 WHERE path_frozen_at IS NULL AND levels_required <> 2;
UPDATE register_records SET levels_required = 2 WHERE path_frozen_at IS NULL AND levels_required <> 2;

-- 6. an open matrix editor must reload
UPDATE matrix_state SET revision = revision + 1, updated_at = now();

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('two_levels_applied', 'workflow', NULL, jsonb_build_object('levels', 2, 'l1', 'Data Entry', 'l2', 'Data Reviewer & Approver'),
        'Owner decision 2026-11-01: two fixed approval levels (migration 0032).');
