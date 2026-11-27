-- 0362 (A9): daily approval digest, IN-APP NOTIFICATION ONLY.
--
-- WHAT. approval_digest_notify(p_day) writes ONE in-app notice per person per day listing how many tasks and register records are waiting at THEIR level
-- (review or approve) and how many of those have waited longer than the stale threshold. The daily job calls it. It changes no task, record, assignment, permission or date.
-- WHO. The holders of the Matrix cell that decides the open level, found the same way the engine finds them: a task uses the cell of its stage (task and region rows first),
-- a register record uses the register's own row (a record that is the source of a task uses the task's cell for review and approve). Only active people in scope
-- (reg_eligible_cell). A level that someone already claimed (ball_in_court_user_id) counts only for the claimant. Nothing is hard-coded: no Matrix row, no notice.
-- WHICH ITEMS. Tasks in state in_review or in_approval, register records in state in_review or in_approval (current, not voided). "Waiting since" is level_opened_at.
-- SETTING `approvals.digest` = {"enabled": true, "version": 0, "stale_days": 3, "registers": {"<register_key>": {"stale_days": N}}}. Default 3 days. A register may carry its own
-- threshold (a later Settings screen edits it, item E5); tasks use the general one. Setting missing or disabled: nothing is written.
-- DAILY CAP. One notice per person per day (the title carries the date). A person with nothing waiting gets nothing.
-- E-MAIL. The kind `approval_digest` is mailed only if an admin adds it to the setting mail.notification_kinds; until then it is in the bell only.
-- SAFE TO REPEAT. Returns the number of notices written (an integer).

INSERT INTO settings (key, value, description, updated_at)
VALUES ('approvals.digest',
        '{"enabled": true, "version": 0, "stale_days": 3, "registers": {}}'::jsonb,
        'A9: daily in-app digest to each Matrix holder of the tasks and register records waiting at their review or approval level, with the number waiting longer than stale_days (a register may set its own).',
        now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION approval_digest_notify(p_day date DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d date := coalesce(p_day, public.cal_today());
  cfg jsonb; dflt integer; n integer := 0; v_title text;
BEGIN
  SELECT value INTO cfg FROM public.settings WHERE key = 'approvals.digest';
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' OR coalesce((cfg ->> 'enabled')::boolean, true) IS NOT TRUE THEN RETURN 0; END IF;
  dflt := CASE WHEN (cfg ->> 'stale_days') ~ '^[0-9]{1,3}$' THEN (cfg ->> 'stale_days')::integer ELSE 3 END;
  v_title := 'Waiting for your review or approval, ' || to_char(d, 'YYYY-MM-DD');

  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  SELECT s.user_id, 'in_app', 'approval_digest', v_title,
         s.total_n::text || ' item(s) waiting at your level (' || s.task_n::text || ' task(s), ' || s.rec_n::text || ' register record(s)); '
           || s.stale_n::text || ' waiting more than their limit (default ' || dflt::text || ' days).',
         '/my-work'
  FROM (
    WITH items AS (
      SELECT 'task'::text AS src, t.id, t.region_id, NULL::text AS register_key,
             CASE t.state::text WHEN 'in_review' THEN 'review' ELSE 'approve' END AS kind,
             t.level_opened_at, t.ball_in_court_user_id AS claimant,
             (SELECT c.id FROM public.task_definitions td JOIN public.matrix_cells c ON c.stage_id = td.stage_id
                WHERE td.id = t.task_def_id
                  AND c.level = CASE t.state::text WHEN 'in_review' THEN 2 ELSE 3 END
                  AND (c.task_def_id IS NULL OR c.task_def_id = td.id) AND (c.region_id IS NULL OR c.region_id = t.region_id)
                ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id LIMIT 1) AS cell,
             'sites'::text AS module, dflt AS stale
      FROM public.task_instances t WHERE t.state::text IN ('in_review', 'in_approval')
      UNION ALL
      SELECT 'record', r.id, r.region_id, r.register_key,
             CASE r.state WHEN 'in_review' THEN 'review' ELSE 'approve' END,
             r.level_opened_at, r.ball_in_court_user_id,
             CASE WHEN r.task_id IS NOT NULL THEN
               (SELECT c.id FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id JOIN public.matrix_cells c ON c.stage_id = td.stage_id
                  WHERE t.id = r.task_id AND c.level = CASE r.state WHEN 'in_review' THEN 2 ELSE 3 END
                    AND (c.task_def_id IS NULL OR c.task_def_id = td.id) AND (c.region_id IS NULL OR c.region_id = t.region_id)
                  ORDER BY (c.task_def_id IS NOT NULL)::int * 2 + (c.region_id IS NOT NULL)::int DESC, c.id LIMIT 1)
             ELSE public.reg_cell_row(r.register_key, r.region_id, CASE r.state WHEN 'in_review' THEN 'review' ELSE 'approve' END) END,
             CASE WHEN r.task_id IS NOT NULL THEN 'sites' ELSE public.reg_module(r.register_key) END,
             CASE WHEN (cfg -> 'registers' -> r.register_key ->> 'stale_days') ~ '^[0-9]{1,3}$' THEN (cfg -> 'registers' -> r.register_key ->> 'stale_days')::integer ELSE dflt END
      FROM public.register_records r WHERE r.state IN ('in_review', 'in_approval') AND r.voided_at IS NULL
    ), pairs AS (
      SELECT i.src, i.id, i.level_opened_at, i.stale, e.user_id
      FROM items i
      CROSS JOIN LATERAL (SELECT x.user_id FROM public.reg_eligible_cell(i.cell, i.region_id, i.module, i.kind::public."PermissionLevel") x) e
      WHERE i.cell IS NOT NULL AND (i.claimant IS NULL OR i.claimant = e.user_id)
    )
    SELECT p.user_id, count(*)::int AS total_n, count(*) FILTER (WHERE p.src = 'task')::int AS task_n, count(*) FILTER (WHERE p.src = 'record')::int AS rec_n,
           count(*) FILTER (WHERE p.level_opened_at IS NOT NULL AND p.level_opened_at::date + p.stale < d)::int AS stale_n
    FROM pairs p GROUP BY p.user_id
  ) s
  WHERE NOT EXISTS (SELECT 1 FROM public.notifications nt WHERE nt.user_id = s.user_id AND nt.kind = 'approval_digest' AND nt.title = v_title);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT SELECT ON settings, task_instances, task_definitions, register_records, matrix_cells, matrix_cell_assignees TO pmis_definer;
GRANT SELECT, INSERT ON notifications TO pmis_definer;

DO $$
BEGIN
  ALTER FUNCTION approval_digest_notify(date) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION approval_digest_notify(date) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION approval_digest_notify(date) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION approval_digest_notify(date) TO pmis_app;
  END IF;
END $$;
