-- 0166: weekly digest, IN-APP NOTIFICATION ONLY (scope: weekly digest, recipients scoped by role/region).
--
-- WHAT. weekly_digest_notify(p_day) writes ONE in-app notification per person for the week that starts on the Sunday on or before p_day (default: today in the
-- calendar time zone). It runs only when p_day is a Sunday (the daily job calls it every day, so it is a no-op on the other six). The text is a count of the
-- open tasks the person may see, how many are past their SLA maximum (colour red) and how many are in the amber band. It changes no task, assignment, permission or date.
-- WHO. Only active people (not deleted, not break-glass) with a role assignment valid NOW whose assignment covers the Sites module (all_modules or a `sites` row).
-- A task counts for a person only when SOME such assignment covers the task's region (all_regions or a region row). A person with no open task in scope gets nothing.
-- E-MAIL. This migration adds NO mail rule and changes no setting. The notification is mailed only if an admin adds the kind `weekly_digest` to the existing
-- setting mail.notification_kinds (migration 0055); until then it is in the bell only.
-- SAFE TO REPEAT. One notification per person per week (title carries the week start date). Returns the number written (an integer, never void).

CREATE OR REPLACE FUNCTION weekly_digest_notify(p_day date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d date := coalesce(p_day, public.cal_today()); wk date; n integer := 0;
BEGIN
  IF extract(isodow FROM d)::int <> 7 THEN RETURN 0; END IF;
  wk := d;
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
  SELECT s.user_id, 'in_app', 'weekly_digest',
         'Weekly summary, week of ' || to_char(wk, 'YYYY-MM-DD'),
         s.open_n::text || ' open tasks in your scope: ' || s.red_n::text || ' past their SLA maximum, ' || s.amber_n::text || ' close to it.',
         '/my-work', 'sites'
  FROM (
    -- the regions each eligible person reaches (one row per person and region), then the open tasks of those regions counted once per person
    WITH reach AS (
      SELECT DISTINCT a.user_id, rg.id AS region_id
      FROM public.user_role_assignments a
      JOIN public.users u ON u.id = a.user_id AND u.status = 'active' AND u.deleted_at IS NULL AND NOT u.is_break_glass
      JOIN public.regions rg ON a.all_regions OR EXISTS (SELECT 1 FROM public.user_role_assignment_regions x WHERE x.assignment_id = a.id AND x.region_id = rg.id)
      WHERE a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
        AND (a.all_modules OR EXISTS (SELECT 1 FROM public.user_role_assignment_modules m WHERE m.assignment_id = a.id AND m.module_key = 'sites'))
    ), tk AS (
      SELECT t.region_id,
             public.sla_colour(public.cal_workdays_between(t.sla_start_date, public.cal_today(), r.calendar_id), 0, r.max_working_days) AS colour
      FROM public.task_instances t
      LEFT JOIN public.sla_rules r ON r.id = t.sla_rule_id
      WHERE t.state::text IN ('open', 'entry', 'in_review', 'in_approval')
    )
    SELECT reach.user_id, count(*)::int AS open_n,
           count(*) FILTER (WHERE tk.colour = 'red')::int AS red_n,
           count(*) FILTER (WHERE tk.colour = 'amber')::int AS amber_n
    FROM reach JOIN tk ON tk.region_id = reach.region_id
    GROUP BY reach.user_id
  ) s
  WHERE NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = s.user_id AND nt.kind = 'weekly_digest' AND nt.title = 'Weekly summary, week of ' || to_char(wk, 'YYYY-MM-DD'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT SELECT ON task_instances, sla_rules, regions, user_role_assignments, user_role_assignment_regions, user_role_assignment_modules, users, notifications TO pmis_definer;
GRANT INSERT ON notifications TO pmis_definer;

DO $$
BEGIN
  ALTER FUNCTION weekly_digest_notify(date) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION weekly_digest_notify(date) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION weekly_digest_notify(date) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION weekly_digest_notify(date) TO pmis_app;
  END IF;
END $$;
