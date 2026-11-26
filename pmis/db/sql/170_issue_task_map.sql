-- 0171_issue_task_map: package 4a of the issue work. Where a site is stopped (its latest open, late or blocked task) gets an issue CATEGORY and BLOCKER REASON from an
-- editable map: task code -> category + reason. Owner decision 2026-11-26 (20:16, relayed by Main): the category and reason follow where the site is stopped
-- (stopped in acquisition -> acquisition problem, civil work -> civil, GECOL -> GECOL, likewise the other work groups); the map is seeded from the task group,
-- shown in Settings and editable. Mirror: db/sql/170_issue_task_map.sql (kept identical).
--
--   1. Table issue_task_map: one row per task CODE (follows the task through new workflow versions): category (a value of the list IssueCategory) and reason
--      (a value of the list BlockerReason, optional), `is_active`, who and when. Nothing is deleted: a row is hidden with is_active = false.
--   2. Seed: every task code of the workflow in force gets a row, by its group: A1, A3 acquisition; B1, B2 supply; B3, D1 access; B4-B15 civil; C1, C2 power (GECOL);
--      C3, C4 fiber (HLC); D2-D17 and F1, F2 telecom; anything else Other. The reason is set only where the group says it plainly (acquisition, GECOL, HLC, access, supply);
--      the rest stay without a reason ("Not classified") until the owner maps them. A task code created later has no row and shows as Other / Not classified.
--   3. admin_issue_task_map_save(task, category, reason, is_active, why): the audited door (needs the `settings` edit right, System Admin or delegation).
-- Read only for everything else: the derived "stopped at" rows are computed by the API (no register record is written) and no permission, role or default changes.

CREATE TABLE IF NOT EXISTS issue_task_map (
  task_code text PRIMARY KEY CHECK (task_code ~ '^[A-Za-z0-9_.-]{1,40}$'),
  category text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 80),   -- a code of the list IssueCategory (checked by the door, not by a key: list values are editable)
  reason text CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 80), -- a code of the list BlockerReason, or empty = Not classified
  is_active boolean NOT NULL DEFAULT true,
  changed_by uuid REFERENCES users (id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE issue_task_map IS '0171: task code -> issue category and blocker reason for the derived "stopped at" issue rows. Edited only through admin_issue_task_map_save.';
ALTER TABLE issue_task_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY issue_task_map_read ON issue_task_map FOR SELECT USING (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON issue_task_map FROM pmis_app;
    GRANT SELECT ON issue_task_map TO pmis_app;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON issue_task_map TO pmis_definer;
GRANT SELECT ON list_values TO pmis_definer;

-- Seed: one row per task code of the workflow in force, by the group of the task.
INSERT INTO issue_task_map (task_code, category, reason)
SELECT td.code,
  CASE
    WHEN td.code IN ('A1', 'A3') THEN 'Acquisition'
    WHEN td.code IN ('B1', 'B2') THEN 'Supply'
    WHEN td.code IN ('B3', 'D1') THEN 'Access'
    WHEN td.code ~ '^B[0-9]+' THEN 'Civil'
    WHEN td.code IN ('C1', 'C2') THEN 'Power'
    WHEN td.code IN ('C3', 'C4') THEN 'Fiber'
    WHEN td.code ~ '^(D|F)[0-9]+' THEN 'Telecom'
    ELSE 'Other'
  END,
  CASE
    WHEN td.code IN ('A1', 'A3') THEN 'Land or Acquisition'
    WHEN td.code IN ('B1', 'B2') THEN 'Material Not Delivered'
    WHEN td.code IN ('B3', 'D1') THEN 'Access or Permit'
    WHEN td.code IN ('C1', 'C2') THEN 'Waiting GECOL'
    WHEN td.code IN ('C3', 'C4') THEN 'Waiting HLC'
    ELSE NULL
  END
FROM task_definitions td
WHERE td.workflow_id = public.sla_workflow()
  AND td.is_active AND NOT td.is_milestone_task
ON CONFLICT (task_code) DO NOTHING;

-- The audited door. A value must exist in its list (a hidden value is still accepted so an old map keeps working); a reason is optional.
CREATE OR REPLACE FUNCTION admin_issue_task_map_save(p_task text, p_category text, p_reason text, p_active boolean, p_why text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before_ jsonb; after_ jsonb;
BEGIN
  PERFORM public.wfe_require('settings', 'edit');
  PERFORM public.calc_require_reason(p_why);
  IF p_task IS NULL OR NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE code = p_task) THEN
    PERFORM public.wfe_err1('/task_code', 'not_found', 'No workflow version has a task with this code.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.list_values WHERE catalogue_code = 'IssueCategory' AND code = p_category) THEN
    PERFORM public.wfe_err1('/category', 'invalid', 'Choose a value of the list Issue category.');
  END IF;
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.list_values WHERE catalogue_code = 'BlockerReason' AND code = btrim(p_reason)) THEN
    PERFORM public.wfe_err1('/reason', 'invalid', 'Choose a value of the list Blocker reason, or leave it empty.');
  END IF;
  SELECT to_jsonb(m) INTO before_ FROM public.issue_task_map m WHERE m.task_code = p_task;
  INSERT INTO public.issue_task_map (task_code, category, reason, is_active, changed_by, changed_at)
  VALUES (p_task, p_category, nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_active, true), public.app_actor(), now())
  ON CONFLICT (task_code) DO UPDATE SET category = EXCLUDED.category, reason = EXCLUDED.reason, is_active = EXCLUDED.is_active,
    changed_by = EXCLUDED.changed_by, changed_at = now();
  SELECT to_jsonb(m) INTO after_ FROM public.issue_task_map m WHERE m.task_code = p_task;
  PERFORM public.wfe_audit('issue_task_map_saved', 'issue_task_map', p_task, before_, after_, p_why);
  RETURN after_;
END $$;

DO $$
DECLARE f text := 'admin_issue_task_map_save(text,text,text,boolean,text)';
BEGIN
  EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('issue_task_map_applied', 'issue_task_map', NULL,
        jsonb_build_object('decision', 'owner 2026-11-26: the category and reason of a stopped site follow where it is stopped; seeded from the task group, editable in Settings', 'function', 'admin_issue_task_map_save'),
        'Migration 0171: the task -> issue category and reason map and its audited door.');
