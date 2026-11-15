-- F1 (contract 0.15.15, CHANGELOG 139): approved status transitions of tasks and register records, and the time they spend in each state.
--
-- The table is read-only for the application. Rows come from two places:
--   1. a trigger on the approval doors' own step ledgers (workflow_steps for tasks, register_steps for records): every step that changes the
--      state writes one row, in the same transaction, so no approval function changes and an approval behaves as before;
--   2. a backfill of the history that existed before this migration: the audit log for tasks (the approval actions of wf_complete), and the
--      register step ledger for records (register approval audit rows do not carry the state in every path).
-- The backfill functions are idempotent (unique source and origin), so a re-run adds nothing.

CREATE TABLE status_transitions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT          NOT NULL CHECK (entity_type IN ('task', 'register_record')),
  entity_id       UUID          NOT NULL,     -- task_instances.id, or register_records.id of the version that moved
  region_id       INTEGER,
  site_id         UUID,
  group_key       TEXT,                       -- the stage code of a task, the register key of a record
  from_state      TEXT,
  to_state        TEXT          NOT NULL,
  at              TIMESTAMPTZ(6) NOT NULL,
  actor_id        UUID,
  level_no        INTEGER       NOT NULL,     -- the workflow level that acted (1 = Data Entry)
  level           TEXT          NOT NULL CHECK (level IN ('L1', 'L2')),
  action          TEXT          NOT NULL,
  admin_override  BOOLEAN       NOT NULL DEFAULT false,
  source          TEXT          NOT NULL CHECK (source IN ('step', 'backfill_audit', 'backfill_step')),
  origin_id       TEXT          NOT NULL,     -- workflow_steps.id, register_steps.id or audit_log.id it came from
  UNIQUE (source, origin_id)
);
CREATE INDEX status_transitions_entity_idx ON status_transitions (entity_type, entity_id, at);
CREATE INDEX status_transitions_group_idx ON status_transitions (entity_type, group_key, region_id, to_state);

-- Append-only: the generic guard of the log tables (0045) refuses every UPDATE and DELETE on it.
CREATE TRIGGER status_transitions_no_update BEFORE UPDATE OR DELETE ON status_transitions FOR EACH ROW EXECUTE FUNCTION log_block_mutation();

-- Visibility: a row is readable when its region is readable (a row without a region, a global record, is readable to every session and the
-- service narrows it by module). Writes come only from the triggers below, which run as the owner of the table.
ALTER TABLE status_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON status_transitions FOR SELECT USING (region_id IS NULL OR app_region_check(region_id));

-- A task step: the state changes of workflow_steps (approvals, rejections, submissions, auto-skips with a change, overrides).
CREATE OR REPLACE FUNCTION st_task_step_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; g text;
BEGIN
  IF NEW.after_state IS NULL OR NEW.before_state IS NOT DISTINCT FROM NEW.after_state THEN RETURN NEW; END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = NEW.task_id;
  SELECT sd.code INTO g FROM public.task_definitions td JOIN public.stage_definitions sd ON sd.id = td.stage_id WHERE td.id = t.task_def_id;
  INSERT INTO public.status_transitions (entity_type, entity_id, region_id, site_id, group_key, from_state, to_state, at, actor_id, level_no, level,
    action, admin_override, source, origin_id)
  VALUES ('task', NEW.task_id, t.region_id, t.site_id, g, NEW.before_state::text, NEW.after_state::text, NEW.created_at, NEW.acted_by, NEW.level,
    CASE WHEN NEW.level <= 1 THEN 'L1' ELSE 'L2' END, NEW.action::text, coalesce(NEW.admin_override, false), 'step', NEW.id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER st_task_step_ai AFTER INSERT ON public.workflow_steps FOR EACH ROW EXECUTE FUNCTION st_task_step_record();

-- A register step: the state changes of register_steps.
CREATE OR REPLACE FUNCTION st_record_step_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE;
BEGIN
  IF NEW.after_state IS NULL OR NEW.before_state IS NOT DISTINCT FROM NEW.after_state THEN RETURN NEW; END IF;
  SELECT * INTO r FROM public.register_records WHERE id = NEW.record_id;
  INSERT INTO public.status_transitions (entity_type, entity_id, region_id, site_id, group_key, from_state, to_state, at, actor_id, level_no, level,
    action, admin_override, source, origin_id)
  VALUES ('register_record', NEW.record_id, r.region_id, r.site_id, r.register_key, NEW.before_state, NEW.after_state, NEW.created_at, NEW.acted_by,
    NEW.level, CASE WHEN NEW.level <= 1 THEN 'L1' ELSE 'L2' END, NEW.action, false, 'step', NEW.id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER st_record_step_ai AFTER INSERT ON public.register_steps FOR EACH ROW EXECUTE FUNCTION st_record_step_record();

-- Backfill of the task history from the audit log: the approval actions that changed the state, before p_before (the moment this migration
-- runs; the step trigger covers everything after it). Returns the number of rows added.
CREATE OR REPLACE FUNCTION st_backfill_audit(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.status_transitions (entity_type, entity_id, region_id, site_id, group_key, from_state, to_state, at, actor_id, level_no, level,
    action, admin_override, source, origin_id)
  SELECT 'task', al.entity_id::uuid, al.region_id, al.site_id, sd.code, al.before->>'state', al.after->>'state', al.at, al.actor_id,
    lvl.n, CASE WHEN lvl.n <= 1 THEN 'L1' ELSE 'L2' END, al.action, coalesce(al.is_admin_override, false), 'backfill_audit', al.id::text
  FROM public.audit_log al
  CROSS JOIN LATERAL (SELECT coalesce((al.before->>'current_level')::int, 1) AS n) lvl
  LEFT JOIN public.task_instances t ON t.id = al.entity_id::uuid
  LEFT JOIN public.task_definitions td ON td.id = t.task_def_id
  LEFT JOIN public.stage_definitions sd ON sd.id = td.stage_id
  WHERE al.entity_type = 'task' AND al.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND al.action IN ('task_submit', 'task_review', 'task_approve', 'task_reject')
    AND al.before->>'state' IS NOT NULL AND al.after->>'state' IS NOT NULL AND al.before->>'state' IS DISTINCT FROM al.after->>'state'
    AND al.at < p_before
  ON CONFLICT (source, origin_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Backfill of the register history from the step ledger, before p_before. Returns the number of rows added.
CREATE OR REPLACE FUNCTION st_backfill_steps(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.status_transitions (entity_type, entity_id, region_id, site_id, group_key, from_state, to_state, at, actor_id, level_no, level,
    action, admin_override, source, origin_id)
  SELECT 'register_record', s.record_id, r.region_id, r.site_id, r.register_key, s.before_state, s.after_state, s.created_at, s.acted_by,
    s.level, CASE WHEN s.level <= 1 THEN 'L1' ELSE 'L2' END, s.action, false, 'backfill_step', s.id::text
  FROM public.register_steps s JOIN public.register_records r ON r.id = s.record_id
  WHERE s.after_state IS NOT NULL AND s.before_state IS DISTINCT FROM s.after_state AND s.created_at < p_before
  ON CONFLICT (source, origin_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

SELECT public.st_backfill_audit(now());
SELECT public.st_backfill_steps(now());
