-- 0131: the stored current and next milestone of a site (Master FX / FY) follow its milestones (owner request 2026-11-20).
--
-- WHY. sites.current_milestone and sites.next_milestone (0001) were never written after the site was created: the site page computes both on the fly
-- (sites.service siteItem), but the stored columns stayed empty for every site. They are read by the SITE 360 grid (Master FX / FY, read model 0104),
-- the SITE 360 milestone filter, the saved-view filter catalogue and the site locks list, so all of those showed nothing (fill-rate check 2026-11-20:
-- 0 of 469 active sites).
--
-- WHAT THIS ADDS.
--   1. site_milestone_derive(p_site): the same rule as the site page, over the whole workflow of the site:
--        a milestone is done when its milestone task is approved, or (no milestone task) when all its counting tasks are approved;
--        it is N/A when its milestone task is N/A or skipped and not approved, or (no milestone task) when it has no counting task;
--        current = the done milestone with the highest sequence; next = the first milestone (by sequence) that is neither done nor N/A.
--   2. site_milestones_refresh(p_site): writes both columns when they changed (no write, no updated_at change otherwise).
--   3. site_status_refresh (0122) calls it first, so it runs at the end of every calc_refresh_site (every task state change) and for cancelled sites too.
--      Its own body and its return value (the overall status moved) are unchanged.
--   4. Statement triggers after INSERT and after DELETE on task_instances refresh the sites of the rows (site creation, workflow migration, imports),
--      which calc_refresh_site does not see.
--   5. A one-time backfill of every site, with one audit row of counts (no site data).
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC and pmis_app (all internal).
SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The rule
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_milestone_derive(p_site uuid, OUT cur text, OUT nxt text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  WITH st AS (
    SELECT sd.code, sd.seq, a.*
    FROM public.sites s
    JOIN public.stage_definitions sd ON sd.workflow_id = s.workflow_version_id AND sd.is_active
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE td.counts_toward_milestone AND NOT t.is_na AND t.state NOT IN ('na', 'skipped')) AS total,
             count(*) FILTER (WHERE td.counts_toward_milestone AND t.state = 'approved') AS done,
             coalesce(bool_or(td.is_milestone_task), false) AS has_ms,
             coalesce(bool_or(td.is_milestone_task AND t.state = 'approved'), false) AS ms_done,
             coalesce(bool_or(td.is_milestone_task AND (t.state IN ('na', 'skipped') OR t.is_na)), false) AS ms_na
      FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id
      WHERE t.site_id = s.id AND td.stage_id = sd.id
    ) a ON true
    WHERE s.id = p_site
  ), k AS (
    SELECT code, seq,
           (ms_done OR (NOT has_ms AND total > 0 AND done >= total)) AS is_done,
           ((has_ms AND ms_na AND NOT ms_done) OR (NOT has_ms AND total = 0)) AS is_na
    FROM st
  )
  SELECT (SELECT code FROM k WHERE is_done ORDER BY seq DESC LIMIT 1),
         (SELECT code FROM k WHERE NOT is_done AND NOT is_na ORDER BY seq LIMIT 1)
    INTO cur, nxt;
END $$;

CREATE OR REPLACE FUNCTION site_milestones_refresh(p_site uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d record;
BEGIN
  IF p_site IS NULL THEN RETURN false; END IF;
  d := public.site_milestone_derive(p_site);
  UPDATE public.sites SET current_milestone = d.cur, next_milestone = d.nxt, updated_at = clock_timestamp()
   WHERE id = p_site AND (current_milestone IS DISTINCT FROM d.cur OR next_milestone IS DISTINCT FROM d.nxt);
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. site_status_refresh (body of 0122, plus the milestone columns first)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_status_refresh(p_site uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur "OverallStatus"; nxt "OverallStatus";
BEGIN
  PERFORM public.site_milestones_refresh(p_site);   -- 0131: Master FX / FY follow the milestones, cancelled sites included
  SELECT s.overall_status INTO cur FROM public.sites s WHERE s.id = p_site;
  IF NOT FOUND OR cur = 'cancelled' THEN RETURN false; END IF;
  nxt := public.site_status_derive(p_site);
  IF nxt IS NOT DISTINCT FROM cur THEN RETURN false; END IF;
  UPDATE public.sites SET overall_status = nxt, updated_at = clock_timestamp() WHERE id = p_site AND overall_status = cur;
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Rows added or removed outside a state change
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_ms_after_task_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sid uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR sid IN SELECT DISTINCT site_id FROM new_t WHERE site_id IS NOT NULL LOOP PERFORM public.site_milestones_refresh(sid); END LOOP;
  ELSE
    FOR sid IN SELECT DISTINCT site_id FROM old_t WHERE site_id IS NOT NULL LOOP PERFORM public.site_milestones_refresh(sid); END LOOP;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS z_site_ms_after_insert ON task_instances;
DROP TRIGGER IF EXISTS z_site_ms_after_delete ON task_instances;
CREATE TRIGGER z_site_ms_after_insert AFTER INSERT ON task_instances REFERENCING NEW TABLE AS new_t
  FOR EACH STATEMENT EXECUTE FUNCTION site_ms_after_task_rows();
CREATE TRIGGER z_site_ms_after_delete AFTER DELETE ON task_instances REFERENCING OLD TABLE AS old_t
  FOR EACH STATEMENT EXECUTE FUNCTION site_ms_after_task_rows();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Ownership and rights (all internal: no grant to pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['site_milestone_derive(uuid)', 'site_milestones_refresh(uuid)', 'site_status_refresh(uuid)', 'site_ms_after_task_rows()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. One-time backfill of every site; one audit row with the counts (no site data in it)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE moved int := 0; sid uuid;
BEGIN
  FOR sid IN SELECT id FROM sites ORDER BY id LOOP
    IF site_milestones_refresh(sid) THEN moved := moved + 1; END IF;
  END LOOP;
  INSERT INTO audit_log (action, entity_type, entity_id, before, after, reason)
  VALUES ('site_milestone_columns_backfill', 'site', 'all', NULL,
          jsonb_build_object('sites_changed', moved,
            'with_current', (SELECT count(*) FROM sites WHERE current_milestone IS NOT NULL),
            'with_next', (SELECT count(*) FROM sites WHERE next_milestone IS NOT NULL)),
          'migration 0131: the stored current and next milestone (Master FX / FY) follow the milestones');
END $$;
