-- 0165: SLA escalation ladder, NOTIFY ONLY (scope: SLA escalation ladder, notify only).
--
-- WHAT. sla_rules already has `escalation_role` (migration 0109, set in Settings > SLA) but nothing used it. sla_escalation_notify() is called by the daily job
-- and writes ONE in-app notification per (person, task) when an open task is past the maximum of its SLA (colour red, the same rule as sla_colour) and its
-- rule names an escalation role. It changes no task, no assignment, no permission and no date.
-- WHO. Only active people (not deleted, not break-glass) who hold that role NOW (valid_from <= now < valid_to) AND may see the task: the assignment covers the
-- task's region (all_regions or a region row) AND the Sites module (all_modules or a `sites` module row). The role is matched on its code or its English name,
-- ignoring case; an inactive role or an unmatched name notifies nobody.
-- SAFE TO REPEAT. A person is notified once per task (kind sla_escalation, task_id); a second run adds nothing. A task that leaves the open states is not escalated.
-- Returns the number of notifications written (an integer, never void: Prisma cannot read a void result).

CREATE OR REPLACE FUNCTION sla_escalation_notify() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer := 0; c integer;
BEGIN
  INSERT INTO public.notifications (user_id, channel, kind, title, body, task_id, link, region_id, module_key)
  SELECT DISTINCT ON (a.user_id, x.task_id)
         a.user_id, 'in_app', 'sla_escalation',
         'SLA escalation: ' || x.site_code || ' ' || x.task_name,
         'The task is past its SLA maximum (' || x.elapsed::text || ' of ' || x.max_wd::text || ' working days). You get this because your role is the escalation role of its SLA rule.',
         x.task_id, '/sites/' || x.site_id::text, x.region_id, 'sites'
  FROM (
    SELECT t.id AS task_id, t.site_id, t.region_id, s.site_code, td.name_en AS task_name, r.escalation_role, r.max_working_days AS max_wd,
           public.cal_workdays_between(t.sla_start_date, public.cal_today(), r.calendar_id) AS elapsed
    FROM public.task_instances t
    JOIN public.sites s ON s.id = t.site_id
    JOIN public.task_definitions td ON td.id = t.task_def_id
    JOIN public.sla_rules r ON r.id = t.sla_rule_id
    WHERE t.state::text IN ('open', 'entry', 'in_review', 'in_approval')
      AND t.sla_start_date IS NOT NULL AND r.escalation_role IS NOT NULL AND r.is_active
  ) x
  JOIN public.roles ro ON ro.is_active AND (lower(ro.code) = lower(x.escalation_role) OR lower(ro.name_en) = lower(x.escalation_role))
  JOIN public.user_role_assignments a ON a.role_id = ro.id AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
  JOIN public.users u ON u.id = a.user_id AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass
  WHERE public.sla_colour(x.elapsed, 0, x.max_wd) = 'red'
    AND (a.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions rg WHERE rg.assignment_id = a.id AND rg.region_id = x.region_id))
    AND (a.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = a.id AND m.module_key = 'sites'))
    AND NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = a.user_id AND nt.kind = 'sla_escalation' AND nt.task_id = x.task_id)
  ORDER BY a.user_id, x.task_id;
  GET DIAGNOSTICS c = ROW_COUNT;
  n := c;
  RETURN n;
END $$;

GRANT SELECT ON task_instances, sites, task_definitions, sla_rules, roles, user_role_assignments, user_role_assignment_regions, user_role_assignment_modules, users, notifications TO pmis_definer;
GRANT INSERT ON notifications TO pmis_definer;

DO $$
BEGIN
  ALTER FUNCTION sla_escalation_notify() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION sla_escalation_notify() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION sla_escalation_notify() TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION sla_escalation_notify() TO pmis_app;
  END IF;
END $$;
