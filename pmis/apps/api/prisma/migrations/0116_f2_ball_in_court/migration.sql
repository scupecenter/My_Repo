-- 0116_f2_ball_in_court (F2 of the 2026-11-14 features plan; contract 0.15.30, CHANGELOG 153): who holds the ball and since when, the SLA overrun
-- in working days and the stale update flag. Mirror: db/sql/113_f2_ball_in_court.sql (kept identical).
--
-- Read only: nothing here changes a state, a holder, a date or an SLA. The API reads the existing columns (level_opened_at, sla_*), the calendar
-- functions of 0017 (cal_workdays_between, weekend Friday and Saturday plus the holidays table) and cal_local_date of 0113. Two doors are added:
--   1. task_last_activity(task): the last time a person did something on a task: an audit row with an actor (entry save, transition, override,
--      reassignment), a workflow step with an actor, a comment, a document file upload, or the opening of its current level. The task's own
--      updated_at is only the fallback for a task with none of these, because system recalculations (sla_recalc_open after a holiday change) also
--      move it. The audit log is readable only by the definer role, so this is a SECURITY DEFINER read that answers null for a task outside the
--      caller's regions (B3): it reveals one timestamp of a task the caller may already read.
--   2. task_stale_idle_days(): the idle limit of the stale flag. It reuses the existing setting stale_idle_days of dashboard.settings (CLAUDE.md
--      B12b: "a task idle for N working days (default 2, a setting) alerts the lead"; migration 0113), so the badge and the dashboard counter agree.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The last activity of a task (null when the task is not visible to the caller)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_last_activity(p_task uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(greatest(
           t.level_opened_at,
           (SELECT max(a.at) FROM public.audit_log a WHERE a.entity_type = 'task' AND a.entity_id = t.id::text AND a.actor_id IS NOT NULL),
           (SELECT max(w.created_at) FROM public.workflow_steps w WHERE w.task_id = t.id AND w.acted_by IS NOT NULL),
           (SELECT max(c.created_at) FROM public.comments c WHERE c.task_id = t.id),
           (SELECT max(f.uploaded_at) FROM public.document_slots ds JOIN public.document_files f ON f.slot_id = ds.id WHERE ds.task_id = t.id)),
         t.updated_at)
  FROM public.task_instances t
  WHERE t.id = p_task AND public.app_region_check(t.region_id)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The idle limit of the stale flag: dashboard.settings.stale_idle_days (1 to 30, default 2)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_stale_idle_days() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((public.dashboard_settings_cfg() ->> 'stale_idle_days')::integer, 2)
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['task_last_activity(uuid)', 'task_stale_idle_days()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['task_last_activity(uuid)', 'task_stale_idle_days()'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
