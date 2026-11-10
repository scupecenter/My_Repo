-- 0085: historical data without locks; per-site workflow locks (owner request 2026-11-10, technical decisions "Decided 2026-11-10" in
-- docs/spec/technical-decisions-2026-11-04.md).
--
-- WHY. The owner: "Accept all historical data as it is and do not lock it. Also make an option: in future, when I add a new site manually, I can restrict and lock
-- the phases." And (same day): "I need to see all sites' status even if there is missing data in the uploaded Excel sheet." A historical load enters tasks done long
-- ago, in any order; the sequencing locks (a task waits for its predecessors, and for the gate in front of its stage, Q81 / Q208) held those rows or refused them.
--
-- WHAT THIS ADDS.
--   1. sites.workflow_locks (default true = everything as before). When false ("open" site) the sequencing locks do not apply on that site: a locked task is opened for
--      entry (when the site is opened, and again by wf_start / wf_save_entry and the import staging and send), so dates are entered in any order. L1/L2, holders,
--      rights, step-up, audit, field validation and the mandatory documents (0073 waiver only) still apply; gates and milestones are still computed from the dates.
--   2. A task approved on an open site while it would have been held (a predecessor not done, a closed gate) is flagged task_instances.lock_bypassed with the reason
--      code it bypassed (predecessor_open:<codes> or gate_closed:<gate>), audited with the admin-override flag, shown with the "Admin override" badge and treated as
--      an override in the KPIs (like historical_no_documents, 0073). A task that leaves the approved state loses the flag; its next approval decides again.
--   3. site_workflow_locks_set(sites, locked, reason): a System Admin, or a holder of the delegable right "unlock" (overrides.unlock administer) for the site's region,
--      with a reason and a step-up, for one or many sites (one reason). Audited per site (site_workflow_locks_set, before/after). Switching back to Locked re-locks the
--      tasks that were opened only by the switch and are still untouched and still blocked; tasks already entered keep going (like Q81).
--   4. The historical load (0073: mi_apply_run with p_historical, a stream template with the mark) opens the sites of the file first (System Admin, step-up, audited
--      per site with the reason of the load); its staging then holds nothing for those sites. Missing data is never an error in a historical load: a task without an
--      actual date is saved without being submitted (warning missing_actual_date), a task without an actual start starts on its actual date (warning
--      missing_actual_start), a cell of a task that is approved, N/A or not on the site is not read (warning), a predecessor without a date is reported
--      (warning missing_predecessor_date). Invalid values (unknown site, bad date or number, value outside its list) stay errors of their own cell only.
--   5. New sites (manual form and TPL-SITE-NEW, new column "Workflow Locks": Locked / Open): Open needs the right of (3) for the region when L2 approves.
--   6. site_data_gaps / site_data_gap_count: the missing required values of a site (a task without an actual date while a successor has one; a site without a delivery
--      scenario), for SITE 360, the site page, the Master import run and the batch page.
--   7. Guards: sites.workflow_locks (and its who/when/why) and the bypass columns of task_instances are written only inside the definer functions of this migration
--      (triggers swl_sites_guard and swl_task_trg); pmis_app has no UPDATE right on them.
--
-- Redefined from their latest definitions (bodies unchanged except where marked 0085): wf_start, wf_save_entry (0015), imp_stage_task_row (0073),
-- imp_submit_stream_rows (0075), imp_stream_open, imp_stream_eval (0075), mi_apply_run (0075), site_new_clean (0070), tpl_sites_columns (0070),
-- dash_build_tasks, dash_core (0073). CREATE OR REPLACE keeps their owner and grants.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC; pmis_app is granted only the API doors
-- (site_workflow_locks_set, swl_can_manage, site_data_gaps, site_data_gap_count). pmis_app stays read-only on tables.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE sites
  ADD COLUMN workflow_locks boolean NOT NULL DEFAULT true,
  ADD COLUMN workflow_locks_changed_at timestamptz,
  ADD COLUMN workflow_locks_changed_by uuid REFERENCES users (id),
  ADD COLUMN workflow_locks_reason text;
COMMENT ON COLUMN sites.workflow_locks IS '0085: true = the sequencing locks apply (predecessors, gates); false = an "open" site: dates in any order, approvals that bypass a lock are flagged. Written only by swl_apply.';

ALTER TABLE task_instances
  ADD COLUMN lock_bypassed boolean NOT NULL DEFAULT false,
  ADD COLUMN lock_bypass_reason text,
  ADD COLUMN lock_bypassed_at timestamptz,
  ADD COLUMN lock_bypass_pending text,
  ADD CONSTRAINT task_instances_lock_bypass_check CHECK (NOT lock_bypassed OR (lock_bypass_reason IS NOT NULL AND lock_bypassed_at IS NOT NULL));
CREATE INDEX task_instances_lock_bypassed_idx ON task_instances (site_id) WHERE lock_bypassed;
COMMENT ON COLUMN task_instances.lock_bypassed IS '0085: approved on a site whose workflow locks were off while a predecessor or a gate would have held it (the "Admin override" badge, an override in KPIs)';
COMMENT ON COLUMN task_instances.lock_bypass_pending IS '0085: the lock the task skipped when an open site opened it for entry; decided again at its approval';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE UPDATE (workflow_locks, workflow_locks_changed_at, workflow_locks_changed_by, workflow_locks_reason) ON sites FROM pmis_app;
    REVOKE UPDATE (lock_bypassed, lock_bypass_reason, lock_bypassed_at, lock_bypass_pending) ON task_instances FROM pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- Locked / Open as typed in a form or a file (EN/AR); NULL when it is neither.
CREATE OR REPLACE FUNCTION swl_parse(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN lower(btrim(coalesce(p, ''))) IN ('locked', 'lock', 'on', 'true', 'yes', 'مقفل', 'مقفلة', 'مغلق') THEN true
              WHEN lower(btrim(coalesce(p, ''))) IN ('open', 'unlocked', 'off', 'false', 'no', 'مفتوح', 'مفتوحة') THEN false END
$$;

-- The site keeps its sequencing locks (true for an unknown site: nothing is opened by mistake).
CREATE OR REPLACE FUNCTION swl_site_locked(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT s.workflow_locks FROM public.sites s WHERE s.id = p_site), true)
$$;

-- The tasks an open site opens for entry: every task but the calculated milestones (MS4 Site RFI is entered by hand), the dismantle tasks (E*, opened by hand, Q382)
-- and the mobilisation tasks (MOB-*, which follow "Ready to mobilize").
CREATE OR REPLACE FUNCTION swl_task_eligible(p_task uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id
                 WHERE t.id = p_task AND (NOT td.is_milestone_task OR td.code = 'MS4') AND td.code !~ '^(E[0-9]|MOB-)')
$$;

-- What would hold the task now on a locked site: its predecessors that are not done, else the closed gate in front of its stage (wf_gate_hold); NULL = nothing.
CREATE OR REPLACE FUNCTION swl_blocker(p_task uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; pend text; hold record;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT string_agg(pd.code, ',' ORDER BY pd.code) INTO pend FROM public.task_predecessors tp
    JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
    JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = tp.predecessor_id
    WHERE tp.task_def_id = t.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped');
  IF pend IS NOT NULL THEN RETURN 'predecessor_open:' || pend; END IF;
  SELECT * INTO hold FROM public.wf_gate_hold(p_task);
  IF hold.gate_code IS NOT NULL THEN RETURN 'gate_closed:' || hold.gate_code; END IF;
  RETURN NULL;
END $$;

-- The right to switch the locks of a site of this region: a System Admin, or the delegable right "unlock" (overrides.unlock administer) for the region.
CREATE OR REPLACE FUNCTION swl_may(p_region integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); r int[];
BEGIN
  IF a IS NULL OR p_region IS NULL THEN RETURN false; END IF;
  IF public.app_user_is_system_admin(a) THEN RETURN true; END IF;
  r := public.wf_actor_regions('overrides.unlock', 'administer');
  RETURN r IS NULL OR p_region = ANY (r);
END $$;

-- For the screens (granted): may the caller switch the locks of this site (visible to them)?
CREATE OR REPLACE FUNCTION swl_can_manage(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT public.swl_may(s.region_id) FROM public.sites s WHERE s.id = p_site AND public.app_region_check(s.region_id)), false)
$$;

-- An audit row of this migration (internal). Written directly, as hw_recheck_task (0073) does: the actor of an approval on an open site is the L2, who is neither a System
-- Admin nor a delegate, but the row records an override that a System Admin (or the delegated right) decided when the site was opened (is_admin_override).
CREATE OR REPLACE FUNCTION swl_audit(p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_reason text, p_site uuid, p_region integer,
  p_override boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, is_admin_override)
  VALUES (p_action, p_entity_type, left(p_entity_id, 200), p_site, p_region, p_before, p_after, left(p_reason, 2000), public.app_actor(), coalesce(p_override, false));
END $$;

-- Opens one locked task of an open site for entry (internal). Keeps the lock it skipped in lock_bypass_pending. p_audit: one audit row for the task (a manual entry);
-- the switch of a whole site writes one row for the site instead.
CREATE OR REPLACE FUNCTION swl_open_task(p_task uuid, p_audit boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; why text; before jsonb;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR t.state <> 'locked' OR public.swl_site_locked(t.site_id) OR NOT public.swl_task_eligible(p_task) THEN RETURN false; END IF;
  why := coalesce(public.swl_blocker(p_task), t.lock_reason, 'locked');
  IF p_audit THEN before := public.wf_snap(p_task); END IF;
  UPDATE public.task_instances SET state = 'open', current_level = 1, level_opened_at = now(), lock_reason = NULL, lock_bypass_pending = why,
    version = version + 1, updated_at = now()
  WHERE id = p_task AND state = 'locked';
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_audit THEN
    PERFORM public.wf_audit('task_unlock', p_task, before, public.wf_snap(p_task) || jsonb_build_object('lock_bypass_pending', why),
      'workflow locks are off on this site: opened for entry (' || why || ')');
  END IF;
  RETURN true;
END $$;

-- Locks again a task that only the switch opened (internal): still untouched (no date, no value, never submitted) and still held by a predecessor or a gate.
CREATE OR REPLACE FUNCTION swl_relock_task(p_task uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; b text;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR t.state <> 'open' OR t.lock_bypass_pending IS NULL THEN RETURN false; END IF;
  b := public.swl_blocker(p_task);
  IF b IS NULL OR t.actual_start IS NOT NULL OR t.actual_date IS NOT NULL OR t.planned_date IS NOT NULL OR t.path_frozen_at IS NOT NULL
     OR coalesce(t.values, '{}'::jsonb) <> '{}'::jsonb THEN
    IF b IS NULL THEN UPDATE public.task_instances SET lock_bypass_pending = NULL WHERE id = p_task; END IF;
    RETURN false;
  END IF;
  UPDATE public.task_instances SET state = 'locked', lock_reason = CASE WHEN starts_with(b, 'gate_closed:') THEN b END, lock_bypass_pending = NULL,
    level_opened_at = NULL, ball_in_court_user_id = NULL, version = version + 1, updated_at = now()
  WHERE id = p_task;
  RETURN true;
END $$;

-- Switches the locks of one site (internal; the callers check the right). Audited with before/after; opening is flagged as an admin override.
CREATE OR REPLACE FUNCTION swl_apply(p_site uuid, p_locked boolean, p_reason text, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.sites%ROWTYPE; r record; opened text[] := ARRAY[]::text[]; relocked text[] := ARRAY[]::text[]; actor uuid := public.app_actor();
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist.')); END IF;
  IF s.workflow_locks = p_locked THEN
    RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'workflow_locks', s.workflow_locks, 'changed', false, 'tasks_opened', '[]'::jsonb, 'tasks_relocked', '[]'::jsonb);
  END IF;
  PERFORM set_config('pmis.swl_apply', '1', true);
  UPDATE public.sites SET workflow_locks = p_locked, workflow_locks_changed_at = now(), workflow_locks_changed_by = actor, workflow_locks_reason = left(btrim(p_reason), 2000),
    updated_at = clock_timestamp() WHERE id = p_site;
  PERFORM set_config('pmis.swl_apply', '', true);
  IF NOT p_locked THEN
    FOR r IN SELECT ti.id, td.code FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
             WHERE ti.site_id = p_site AND ti.state = 'locked' ORDER BY td.sort_order, td.code LOOP
      IF public.swl_open_task(r.id, false) THEN opened := opened || r.code; END IF;
    END LOOP;
  ELSE
    FOR r IN SELECT ti.id, td.code FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
             WHERE ti.site_id = p_site AND ti.state = 'open' AND ti.lock_bypass_pending IS NOT NULL ORDER BY td.sort_order, td.code LOOP
      IF public.swl_relock_task(r.id) THEN relocked := relocked || r.code; END IF;
    END LOOP;
  END IF;
  PERFORM public.swl_audit('site_workflow_locks_set', 'site', p_site::text,
    jsonb_build_object('workflow_locks', s.workflow_locks, 'changed_at', s.workflow_locks_changed_at, 'reason', s.workflow_locks_reason),
    jsonb_build_object('workflow_locks', p_locked, 'source', p_source, 'tasks_opened', to_jsonb(opened), 'tasks_relocked', to_jsonb(relocked)),
    btrim(p_reason), p_site, s.region_id, NOT p_locked);
  RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'workflow_locks', p_locked, 'changed', true, 'tasks_opened', to_jsonb(opened), 'tasks_relocked', to_jsonb(relocked));
END $$;

-- The API door (granted): one or many sites, one reason, a step-up. Atomic: a site the caller cannot see is 404, a site outside the right is 403, and nothing changes.
CREATE OR REPLACE FUNCTION site_workflow_locks_set(p_sites uuid[], p_locked boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); ids uuid[]; sid uuid; s public.sites%ROWTYPE; res jsonb := '[]'::jsonb; one jsonb; n int := 0; rs text := btrim(coalesce(p_reason, ''));
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT array_agg(DISTINCT x) INTO ids FROM unnest(coalesce(p_sites, ARRAY[]::uuid[])) x WHERE x IS NOT NULL;
  IF ids IS NULL OR cardinality(ids) = 0 OR cardinality(ids) > 5000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/site_ids', 'code', 'required', 'message', 'Choose 1 to 5000 sites.'))));
  END IF;
  FOREACH sid IN ARRAY ids LOOP
    SELECT * INTO s FROM public.sites x WHERE x.id = sid AND public.app_region_check(x.region_id);
    IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'A site does not exist or is not visible to you.')); END IF;
    IF NOT public.swl_may(s.region_id) THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Switching the workflow locks of ' || s.site_code || ' needs a System Admin or the delegated right to unlock for its region.'));
    END IF;
  END LOOP;
  IF p_locked IS NULL OR char_length(rs) < 3 OR char_length(rs) > 2000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object(
      'path', CASE WHEN p_locked IS NULL THEN '/locked' ELSE '/reason' END, 'code', 'required',
      'message', CASE WHEN p_locked IS NULL THEN 'locked is true or false.' ELSE 'A reason of 3 to 2000 characters is required.' END))));
  END IF;
  IF NOT coalesce(public.app_ctx_stepup(), false) THEN PERFORM public.wf_err('step_up_required'); END IF;
  FOREACH sid IN ARRAY ids LOOP
    one := public.swl_apply(sid, p_locked, rs, CASE WHEN cardinality(ids) > 1 THEN 'bulk' ELSE 'manual' END);
    IF (one ->> 'changed')::boolean THEN n := n + 1; END IF;
    res := res || jsonb_build_array(one);
  END LOOP;
  RETURN jsonb_build_object('workflow_locks', p_locked, 'changed', n, 'unchanged', cardinality(ids) - n, 'sites', res);
END $$;

-- The historical load (internal): a System Admin with a step-up (hw_require_admin_stepup, as the mark of 0073); every given site still locked is opened, audited per site.
CREATE OR REPLACE FUNCTION swl_open_for_load(p_sites uuid[], p_reason text, p_source text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sid uuid; n int := 0;
BEGIN
  IF p_sites IS NULL OR cardinality(p_sites) = 0 THEN RETURN 0; END IF;
  PERFORM public.hw_require_admin_stepup();
  FOR sid IN SELECT s.id FROM public.sites s WHERE s.id = ANY (p_sites) AND s.workflow_locks ORDER BY s.site_code LOOP
    PERFORM public.swl_apply(sid, false, 'Historical load: ' || btrim(coalesce(p_reason, '')), p_source);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The bypass flag: decided when a task is approved; guarded
-- ---------------------------------------------------------------------------------------------------------------------
-- The lock a task approved now bypassed, or NULL (internal): an eligible task of an open site still held now, or one the switch opened (lock_bypass_pending).
CREATE OR REPLACE FUNCTION swl_bypass_reason(p_task uuid, p_site uuid, p_pending text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.swl_task_eligible(p_task) THEN RETURN NULL; END IF;
  IF public.swl_site_locked(p_site) AND p_pending IS NULL THEN RETURN NULL; END IF;
  RETURN coalesce(public.swl_blocker(p_task), p_pending);
END $$;

CREATE OR REPLACE FUNCTION swl_bypass_audit(p_task uuid, p_site uuid, p_region integer, p_why text, p_set boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_set THEN
    PERFORM public.swl_audit('task_lock_bypassed', 'task', p_task::text, jsonb_build_object('lock_bypassed', false),
      jsonb_build_object('lock_bypassed', true, 'lock_bypass_reason', p_why, 'state', 'approved'),
      'approved on a site whose workflow locks are off, while ' || p_why || ' would have held it', p_site, p_region, true);
  ELSE
    PERFORM public.swl_audit('task_lock_bypass_cleared', 'task', p_task::text, jsonb_build_object('lock_bypassed', true, 'lock_bypass_reason', p_why),
      jsonb_build_object('lock_bypassed', false), 'the task left the approved state: its next approval decides again', p_site, p_region, false);
  END IF;
END $$;

-- BEFORE INSERT OR UPDATE on task_instances. Not a definer: current_user is the writer. The bypass columns are written only on the definer path; the flag itself is decided here.
CREATE OR REPLACE FUNCTION swl_task_trg() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE why text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.lock_bypassed OR NEW.lock_bypass_reason IS NOT NULL OR NEW.lock_bypassed_at IS NOT NULL OR NEW.lock_bypass_pending IS NOT NULL) AND NOT public.app_in_admin_path() THEN
      RAISE EXCEPTION 'workflow locks: the lock bypass of a task is written only by GSDN Workspace (migration 0085)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.lock_bypassed, NEW.lock_bypass_reason, NEW.lock_bypassed_at, NEW.lock_bypass_pending) IS DISTINCT FROM (OLD.lock_bypassed, OLD.lock_bypass_reason, OLD.lock_bypassed_at, OLD.lock_bypass_pending)
     AND NOT public.app_in_admin_path() THEN
    RAISE EXCEPTION 'workflow locks: the lock bypass of a task is written only by GSDN Workspace (migration 0085)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved' AND NOT NEW.lock_bypassed THEN
    why := public.swl_bypass_reason(NEW.id, NEW.site_id, NEW.lock_bypass_pending);
    IF why IS NOT NULL THEN
      NEW.lock_bypassed := true; NEW.lock_bypass_reason := why; NEW.lock_bypassed_at := now();
      PERFORM public.swl_bypass_audit(NEW.id, NEW.site_id, NEW.region_id, why, true);
    END IF;
    NEW.lock_bypass_pending := NULL;
  ELSIF OLD.state = 'approved' AND NEW.state IS DISTINCT FROM 'approved' AND OLD.lock_bypassed THEN
    NEW.lock_bypassed := false; NEW.lock_bypassed_at := NULL; NEW.lock_bypass_pending := OLD.lock_bypass_reason; NEW.lock_bypass_reason := NULL;
    PERFORM public.swl_bypass_audit(NEW.id, NEW.site_id, NEW.region_id, OLD.lock_bypass_reason, false);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER swl_task_trg_ins BEFORE INSERT ON task_instances FOR EACH ROW
  WHEN (NEW.lock_bypassed OR NEW.lock_bypass_reason IS NOT NULL OR NEW.lock_bypassed_at IS NOT NULL OR NEW.lock_bypass_pending IS NOT NULL) EXECUTE FUNCTION swl_task_trg();
CREATE TRIGGER swl_task_trg_upd BEFORE UPDATE ON task_instances FOR EACH ROW
  WHEN (NEW.state IS DISTINCT FROM OLD.state OR NEW.lock_bypassed IS DISTINCT FROM OLD.lock_bypassed OR NEW.lock_bypass_reason IS DISTINCT FROM OLD.lock_bypass_reason
        OR NEW.lock_bypassed_at IS DISTINCT FROM OLD.lock_bypassed_at OR NEW.lock_bypass_pending IS DISTINCT FROM OLD.lock_bypass_pending)
  EXECUTE FUNCTION swl_task_trg();

-- BEFORE INSERT OR UPDATE on sites: the locks of a site change only inside swl_apply (the definer role and its transaction marker), or in a migration.
CREATE OR REPLACE FUNCTION swl_sites_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.workflow_locks OR NEW.workflow_locks_changed_at IS NOT NULL OR NEW.workflow_locks_changed_by IS NOT NULL OR NEW.workflow_locks_reason IS NOT NULL THEN
      RAISE EXCEPTION 'workflow locks: a site is created with its locks on; they change only through site_workflow_locks_set (migration 0085)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.workflow_locks, NEW.workflow_locks_changed_at, NEW.workflow_locks_changed_by, NEW.workflow_locks_reason)
     IS DISTINCT FROM (OLD.workflow_locks, OLD.workflow_locks_changed_at, OLD.workflow_locks_changed_by, OLD.workflow_locks_reason)
     AND NOT (current_user = 'pmis_definer' AND coalesce(current_setting('pmis.swl_apply', true), '') = '1') THEN
    RAISE EXCEPTION 'workflow locks: the locks of a site change only through site_workflow_locks_set (migration 0085)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_swl_sites_guard_ins BEFORE INSERT ON sites FOR EACH ROW EXECUTE FUNCTION swl_sites_guard();
CREATE TRIGGER b_swl_sites_guard_upd BEFORE UPDATE OF workflow_locks, workflow_locks_changed_at, workflow_locks_changed_by, workflow_locks_reason ON sites
  FOR EACH ROW EXECUTE FUNCTION swl_sites_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. New sites: "Workflow locks: Open" is applied when L2 approves the site, with the right of site_workflow_locks_set (the step-up of the approval covers it)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION swl_site_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.swl_parse(NEW.data ->> 'workflow_locks') IS FALSE THEN
    IF NOT public.swl_may(NEW.region_id) THEN
      PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'A site with its workflow locks off is approved only by a System Admin or a holder of the delegated right to unlock for its region.'));
    END IF;
    PERFORM public.swl_apply(NEW.site_id, false, 'Created with workflow locks off (' || CASE WHEN NEW.batch_id IS NOT NULL THEN 'batch ' || NEW.batch_id::text ELSE 'draft ' || NEW.id::text END || ')', 'site_create');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER swl_site_created AFTER UPDATE OF status ON site_drafts FOR EACH ROW
  WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' AND NEW.site_id IS NOT NULL) EXECUTE FUNCTION swl_site_created();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Data gaps: the missing required values of a site (granted; a site the caller cannot see has none)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_data_gaps(p_site uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH s AS (SELECT x.* FROM public.sites x WHERE x.id = p_site AND public.app_region_check(x.region_id)),
  t AS (
    SELECT jsonb_build_object('kind', 'missing_actual_date', 'task_code', td.code, 'successor_code', min(sd.code)) AS item, td.sort_order AS ord
    FROM s JOIN public.task_instances ti ON ti.site_id = s.id
    JOIN public.task_definitions td ON td.id = ti.task_def_id AND NOT td.is_milestone_task
    JOIN public.task_predecessors tp ON tp.predecessor_id = ti.task_def_id
    JOIN public.task_instances si ON si.site_id = s.id AND si.task_def_id = tp.task_def_id AND si.actual_date IS NOT NULL
    JOIN public.task_definitions sd ON sd.id = si.task_def_id
    WHERE ti.actual_date IS NULL AND NOT ti.is_na AND ti.state NOT IN ('approved', 'na', 'skipped')
    GROUP BY td.code, td.sort_order
  ), f AS (
    SELECT jsonb_build_object('kind', 'missing_field', 'field', 'delivery_scenario') AS item, -1 AS ord FROM s WHERE s.delivery_scenario IS NULL
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM s) THEN jsonb_build_object('count', 0, 'items', '[]'::jsonb)
         ELSE jsonb_build_object('count', (SELECT count(*) FROM (SELECT item FROM t UNION ALL SELECT item FROM f) q),
                                 'items', coalesce((SELECT jsonb_agg(item ORDER BY ord) FROM (SELECT item, ord FROM t UNION ALL SELECT item, ord FROM f) q), '[]'::jsonb)) END
$$;

CREATE OR REPLACE FUNCTION site_data_gap_count(p_site uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (public.site_data_gaps(p_site) ->> 'count')::int
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The redefined functions: entry, staging, send, apply, new-site check, template columns, KPIs
-- ---------------------------------------------------------------------------------------------------------------------
-- wf_start (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.wf_start(p_task uuid, p_version integer, p_start date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; sid uuid; d date := coalesce(p_start, public.cal_today()); pin uuid; cnt int;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  -- 0085: on a site whose workflow locks are off, a locked task is entered as if it were open (kept for its approval)
  IF t.state = 'locked' AND public.swl_open_task(p_task, true) THEN t.state := 'open'; END IF;
  IF t.state <> 'open' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a pending task can be started (it is ' || t.state::text || ').'));
  END IF;
  IF d > public.cal_today() OR d < DATE '2020-01-01' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/actual_start', 'code', 'invalid_date', 'message', 'The start date cannot be in the future.'))));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(p_task, 'entry', actor);
  before := public.wf_snap(p_task);
  SELECT count(*) INTO cnt FROM public.wf_eligible(p_task, 'entry');
  pin := CASE WHEN cnt > 1 THEN actor ELSE t.ball_in_court_user_id END;
  UPDATE public.task_instances SET state = 'entry', current_level = 1, actual_start = d, ball_in_court_user_id = pin, version = version + 1, updated_at = now() WHERE id = p_task;
  sid := public.wf_step(p_task, 1, 'start', actor, NULL, t.state, 'entry', false, false);
  PERFORM public.wf_audit('task_start', p_task, before, public.wf_snap(p_task), NULL);
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb);
END $function$;

-- wf_save_entry (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.wf_save_entry(p_task uuid, p_version integer, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; k text; d date; errs jsonb := '[]'::jsonb; cnt int; pin uuid; key text;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  -- 0085: on a site whose workflow locks are off, a locked task is entered as if it were open (kept for its approval)
  IF t.state = 'locked' AND public.swl_open_task(p_task, true) THEN t.state := 'open'; END IF;
  IF t.state NOT IN ('open', 'entry') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Entry data can be saved only while the task is pending or ongoing (it is ' || t.state::text || ').'));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(p_task, 'entry', actor);
  FOREACH key IN ARRAY ARRAY['actual_start', 'actual_date', 'planned_date'] LOOP
    IF p_patch ? key AND jsonb_typeof(p_patch->key) <> 'null' THEN
      d := (p_patch->>key)::date;
      IF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || key, 'code', 'invalid_date', 'message', 'The date must be between 2020-01-01 and 2035-12-31.'));
      ELSIF key <> 'planned_date' AND d > public.cal_today() THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || key, 'code', 'future_date', 'message', 'An actual date cannot be in the future.'));
      END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := public.wf_snap(p_task);
  SELECT count(*) INTO cnt FROM public.wf_eligible(p_task, 'entry');
  pin := CASE WHEN t.ball_in_court_user_id IS NULL AND cnt > 1 THEN actor ELSE t.ball_in_court_user_id END;
  UPDATE public.task_instances SET
    actual_start = CASE WHEN p_patch ? 'actual_start' THEN (p_patch->>'actual_start')::date ELSE actual_start END,
    actual_date  = CASE WHEN p_patch ? 'actual_date'  THEN (p_patch->>'actual_date')::date  ELSE actual_date END,
    planned_date = CASE WHEN p_patch ? 'planned_date' THEN (p_patch->>'planned_date')::date ELSE planned_date END,
    values = CASE WHEN p_patch ? 'values' AND jsonb_typeof(p_patch->'values') = 'object' THEN coalesce(values, '{}'::jsonb) || (p_patch->'values') ELSE values END,
    ball_in_court_user_id = pin, version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.wf_audit('task_entry_update', p_task, before, public.wf_snap(p_task) || jsonb_build_object('values', (SELECT values FROM public.task_instances WHERE id = p_task)), NULL);
END $function$;

-- imp_stage_task_row (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.imp_stage_task_row(p_cols jsonb, p_row jsonb, p_task_site uuid, p_view integer[], p_imp integer[], p_edit integer[], p_mode text, p_hw_cutoff date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); rowerrs jsonb := '[]'::jsonb; pre jsonb := coalesce(p_row -> 'pre_errors', '[]'::jsonb); cells jsonb := coalesce(p_row -> 'cells', '{}'::jsonb);
  scode text := nullif(btrim(p_row ->> 'site_code'), ''); s public.sites%ROWTYPE; col record; v jsonb; cl jsonb; tc text; plain text; pe jsonb;
  order_codes text[] := ARRAY[]::text[]; pay jsonb := '{}'::jsonb; terr jsonb := '{}'::jsonb; twarn jsonb := '{}'::jsonb; items jsonb := '[]'::jsonb;
  p jsonb; e jsonb; w jsonb; diff jsonb; ti public.task_instances%ROWTYPE; tname text; action text; decision text; hold text; k text; nv jsonb; pend text; missing text[];
  eff_actual date; eff_start date; patch jsonb; j jsonb; item jsonb; cur date; have boolean; draft boolean := (p_mode = 'draft'); gate_msg text;
  hist boolean := (p_hw_cutoff IS NOT NULL);   -- 0085: the historical load: a missing value is a warning, never an error
  save_only boolean; pmiss text;
BEGIN
  IF scode IS NULL THEN
    rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'required', 'message', 'The Site ID is required.'));
  ELSE
    SELECT * INTO s FROM public.sites x WHERE upper(x.site_code) = upper(scode) AND public.app_region_check(x.region_id) AND public.imp_region_ok(p_view, x.region_id);
    IF NOT FOUND THEN
      rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'site_not_in_scope', 'message', 'Unknown site, or a site outside your regions.'));
    ELSIF p_task_site IS NOT NULL AND s.id <> p_task_site THEN
      rowerrs := rowerrs || jsonb_build_array(jsonb_build_object('column', 'Site ID', 'field', 'site_code', 'code', 'not_task_site',
        'message', 'This file was uploaded from a task: only the rows of the task''s site are accepted.'));
    END IF;
  END IF;
  IF jsonb_array_length(rowerrs) > 0 THEN
    RETURN jsonb_build_object('site_id', NULL, 'site_code', scode, 'region_id', NULL, 'row_errors', rowerrs || pre, 'items', '[]'::jsonb);
  END IF;

  FOR pe IN SELECT * FROM jsonb_array_elements(pre) LOOP
    SELECT c ->> 'task' INTO tc FROM jsonb_array_elements(p_cols) c WHERE c ->> 'code' = pe ->> 'field' LIMIT 1;
    IF tc IS NULL THEN rowerrs := rowerrs || jsonb_build_array(pe); CONTINUE; END IF;
    IF NOT (tc = ANY (order_codes)) THEN order_codes := order_codes || tc; END IF;
    terr := terr || jsonb_build_object(tc, coalesce(terr -> tc, '[]'::jsonb) || jsonb_build_array(pe));
  END LOOP;

  FOR col IN SELECT c ->> 'code' AS code, c ->> 'task' AS task, c ->> 'field' AS field, c ->> 'type' AS type, c -> 'options' AS options, c ->> 'header' AS header
             FROM jsonb_array_elements(p_cols) c
             WHERE c ->> 'kind' = 'task' AND NOT coalesce((c ->> 'derived')::boolean, false) LOOP
    v := cells -> col.code;
    IF v IS NULL THEN CONTINUE; END IF;
    cl := public.imp_clean_cell(col.type, col.options, v);
    IF cl IS NULL THEN CONTINUE; END IF;
    IF NOT (col.task = ANY (order_codes)) THEN order_codes := order_codes || col.task; END IF;
    IF cl ? 'error' THEN
      terr := terr || jsonb_build_object(col.task, coalesce(terr -> col.task, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object('column', col.header, 'field', col.code, 'code', cl ->> 'error', 'message', cl ->> 'message')));
    ELSE
      plain := regexp_replace(col.field, '^v:', '');
      pay := pay || jsonb_build_object(col.task, coalesce(pay -> col.task, '{}'::jsonb) || jsonb_build_object(plain, cl -> 'value'));
    END IF;
  END LOOP;

  FOR col IN SELECT c ->> 'code' AS code, c ->> 'task' AS task, c ->> 'field' AS field, c ->> 'header' AS header
             FROM jsonb_array_elements(p_cols) c
             WHERE c ->> 'kind' = 'task' AND coalesce((c ->> 'derived')::boolean, false)
               AND c ->> 'field' IN ('planned_date', 'planned_start', 'actual_start', 'actual_date', 'submitted_date', 'approved_date') LOOP
    v := cells -> col.code;
    IF v IS NULL THEN CONTINUE; END IF;
    cl := public.imp_clean_cell('date', NULL, v);
    IF cl IS NULL OR cl ? 'error' THEN CONTINUE; END IF;
    SELECT CASE col.field WHEN 'planned_date' THEN x.planned_date WHEN 'planned_start' THEN x.planned_start WHEN 'actual_start' THEN x.actual_start
                          WHEN 'actual_date' THEN x.actual_date WHEN 'submitted_date' THEN x.submitted_date ELSE x.approved_date END INTO cur
      FROM public.task_instances x JOIN public.task_definitions td ON td.id = x.task_def_id
      WHERE x.site_id = s.id AND td.code = col.task AND td.workflow_id = s.workflow_version_id;
    CONTINUE WHEN NOT FOUND;
    IF cur IS DISTINCT FROM (cl ->> 'value')::date THEN
      IF NOT (col.task = ANY (order_codes)) THEN order_codes := order_codes || col.task; END IF;
      twarn := twarn || jsonb_build_object(col.task, coalesce(twarn -> col.task, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object('column', col.header, 'field', col.code, 'code', 'calculated_column', 'message', 'Calculated or register-owned column: the value is not read.')));
    END IF;
  END LOOP;

  FOREACH tc IN ARRAY order_codes LOOP
    p := coalesce(pay -> tc, '{}'::jsonb); e := coalesce(terr -> tc, '[]'::jsonb); w := coalesce(twarn -> tc, '[]'::jsonb);
    diff := '{}'::jsonb; action := 'update'; decision := 'pending'; hold := NULL; save_only := false;
    SELECT x.* INTO ti FROM public.task_instances x JOIN public.task_definitions td ON td.id = x.task_def_id
      WHERE x.site_id = s.id AND td.code = tc AND td.workflow_id = s.workflow_version_id;
    have := FOUND;
    tname := CASE WHEN have THEN (SELECT d2.name_en FROM public.task_definitions d2 WHERE d2.id = ti.task_def_id) END;
    IF NOT have AND hist THEN
      -- 0085: the historical load keeps the rest of the row; this cell is not read
      w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_on_site', 'This task does not exist on this site (its scope or delivery scenario does not use it): the value is not read.'));
      action := 'unchanged';
    ELSIF NOT have THEN
      e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_on_site', 'This task does not exist on this site (its scope or delivery scenario does not use it).'));
      action := 'error';
    ELSE
      IF p ? 'planned_date' AND (p ->> 'planned_date')::date IS DISTINCT FROM ti.planned_date THEN
        diff := diff || jsonb_build_object('planned_date', jsonb_build_object('old', to_jsonb(ti.planned_date), 'new', p -> 'planned_date')); END IF;
      IF p ? 'actual_start' AND (p ->> 'actual_start')::date IS DISTINCT FROM ti.actual_start THEN
        diff := diff || jsonb_build_object('actual_start', jsonb_build_object('old', to_jsonb(ti.actual_start), 'new', p -> 'actual_start')); END IF;
      IF p ? 'actual_date' AND (p ->> 'actual_date')::date IS DISTINCT FROM ti.actual_date THEN
        diff := diff || jsonb_build_object('actual_date', jsonb_build_object('old', to_jsonb(ti.actual_date), 'new', p -> 'actual_date')); END IF;
      FOR k, nv IN SELECT * FROM jsonb_each(p) LOOP
        CONTINUE WHEN k IN ('planned_date', 'actual_start', 'actual_date');
        IF (ti.values -> k) IS DISTINCT FROM nv THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', ti.values -> k, 'new', nv)); END IF;
      END LOOP;

      IF jsonb_array_length(e) = 0 THEN
        IF diff = '{}'::jsonb THEN
          action := 'unchanged';
        ELSIF hist AND (ti.is_na OR ti.state IN ('na', 'skipped', 'suspended', 'rejected', 'approved')) THEN
          -- 0085: the historical load keeps what GSDN Workspace holds; the value of the file is not read for this task
          w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', CASE WHEN ti.state = 'approved' THEN 'task_approved' ELSE 'task_not_open' END,
            'The task is ' || ti.state::text || ': the value of the file is not read (the task keeps its current value).'));
          action := 'unchanged'; diff := '{}'::jsonb;
        ELSIF ti.is_na OR ti.state IN ('na', 'skipped', 'suspended', 'rejected') THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_not_open', 'The task is ' || ti.state::text || ': it takes no entry.'));
        ELSIF ti.state = 'approved' THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'task_approved', 'The task is approved. An approved task is changed only by an admin reopening it.'));
        ELSIF NOT public.imp_region_ok(p_imp, ti.region_id) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'region_forbidden', 'You may not import in this region.'));
        ELSIF NOT public.imp_region_ok(p_edit, ti.region_id) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'action_forbidden', 'You may not edit tasks in this region.'));
        ELSIF NOT (public.wf_is_eligible(ti.id, 'entry', actor) OR (public.app_user_is_system_admin(actor) AND NOT public.wf_has_holder(ti.id, 'entry'))) THEN
          e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'not_entry_holder', 'You are not an entry holder (L1) of this task in the Matrix.'));
        ELSIF ti.state IN ('in_review', 'in_approval') THEN
          decision := 'pending_previous_approval'; hold := 'open_submission';
          w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_open_submission', 'The task is in ' || ti.state::text || ': the row waits until that submission is decided.'));
        ELSIF ti.state = 'locked' AND s.workflow_locks THEN   -- 0085: only a site whose workflow locks are on holds the row
          SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pend FROM public.task_predecessors tp
            JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
            JOIN public.task_instances pi ON pi.site_id = ti.site_id AND pi.task_def_id = tp.predecessor_id
            WHERE tp.task_def_id = ti.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped');
          IF pend IS NOT NULL THEN
            decision := 'pending_previous_approval'; hold := 'predecessor_open';
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_predecessor', 'The row waits until ' || pend || ' is approved.'));
          ELSE
            -- Q208: held, never refused; the row is applied only when the uploader sends the batch again after the gate opens (every check runs again)
            gate_msg := CASE WHEN starts_with(coalesce(ti.lock_reason, ''), 'gate_closed:') THEN 'the gate ' || substr(ti.lock_reason, 13) || ' is not open yet'
                             ELSE coalesce(ti.lock_reason, 'the gate of its stage is not open yet') END;
            decision := 'pending_previous_approval'; hold := 'gate_locked';
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'held_gate_locked',
              'The task is locked: ' || gate_msg || ' (Q81). The row is kept; send the batch again once the gate opens (Q208).'));
          END IF;
        ELSE
          -- open or ongoing: the manual rules, by running the save on the real task inside a savepoint that is rolled back
          patch := public.imp_task_patch(p, diff);
          BEGIN
            PERFORM public.wf_save_entry(ti.id, NULL, patch);
            RAISE EXCEPTION 'imp:probe_done';
          EXCEPTION WHEN others THEN
            IF SQLERRM <> 'imp:probe_done' THEN
              j := public.imp_wf_json(SQLERRM);
              IF j ->> 'code' = 'validation_failed' THEN
                FOR item IN SELECT * FROM jsonb_array_elements(coalesce(j -> 'extra' -> 'errors', '[]'::jsonb)) LOOP
                  e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, regexp_replace(item ->> 'path', '^/', ''), coalesce(item ->> 'code', 'invalid'), coalesce(item ->> 'message', 'Not valid.')));
                END LOOP;
              ELSIF j IS NOT NULL THEN
                e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', coalesce(j ->> 'code', 'row_failed'), public.imp_wf_message(j)));
              ELSE
                e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'row_failed', left(SQLERRM, 200)));
              END IF;
            END IF;
          END;
          IF jsonb_array_length(e) = 0 AND NOT draft THEN
            -- what the submit asks for (the same checks as the task screen): the actual date and the mandatory documents
            eff_actual := coalesce((p ->> 'actual_date')::date, ti.actual_date);
            IF eff_actual IS NULL AND hist THEN
              -- 0085: the historical load saves the values of the row without submitting the task (a warning, never an error)
              save_only := true;
              w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'missing_actual_date',
                'No actual date: the values of the row are saved and the task is not submitted (historical load).'));
            ELSIF eff_actual IS NULL THEN
              e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'actual_date_required',
                'The actual date is required: the task is submitted with its row, as on the task screen. Use Save Draft / Planning to save a plan only (Q206).'));
            END IF;
            missing := CASE WHEN save_only THEN ARRAY[]::text[] ELSE public.wf_missing_slots(ti.id) END;
            IF cardinality(missing) > 0 THEN
              IF p_hw_cutoff IS NOT NULL AND eff_actual IS NOT NULL AND eff_actual <= p_hw_cutoff THEN
                -- 0073 (Q462): a marked batch under the open waiver; the actual date is on or before the cutoff, so the documents are not asked for (every other check ran)
                w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'historical_no_documents', 'Missing document(s): ' || array_to_string(missing, ', ') ||
                  '. Accepted without documents under the historical-load waiver (the actual date is on or before ' || p_hw_cutoff::text || '); the task will be flagged.'));
              ELSE
                e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'mandatory_slots_missing', 'Missing document(s): ' || array_to_string(missing, ', ') || '. Upload them on the task first.'));
              END IF;
            END IF;
          END IF;
          -- Q209: a pending task is started with its actual start, never with today; a planning row (draft, no actual date) does not start it
          IF jsonb_array_length(e) = 0 AND ti.state IN ('open', 'locked') AND (NOT (draft OR save_only) OR p ? 'actual_start' OR p ? 'actual_date')
             AND public.imp_start_date(tc, p, ti) IS NULL AND hist AND coalesce((p ->> 'actual_date')::date, ti.actual_date) IS NOT NULL THEN
            -- 0085: the historical load starts the task on its actual date when the file has no actual start (a warning)
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_start', 'missing_actual_start',
              'No actual start: the actual date is used as the start of the task (historical load).'));
          ELSIF jsonb_array_length(e) = 0 AND ti.state IN ('open', 'locked') AND (NOT (draft OR save_only) OR p ? 'actual_start' OR p ? 'actual_date')
             AND public.imp_start_date(tc, p, ti) IS NULL THEN
            e := e || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_start', 'actual_start_required',
              'The task is pending: type its Actual Start. GSDN Workspace never uses today as the start of an earlier piece of work (Q209).'));
          END IF;
        END IF;

        IF jsonb_array_length(e) = 0 AND action = 'update' AND (hist OR NOT s.workflow_locks) THEN
          -- 0085: a predecessor without an actual date while this task has one (a data gap: a warning)
          SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pmiss FROM public.task_predecessors tp
            JOIN public.task_definitions pd ON pd.id = tp.predecessor_id AND NOT pd.is_milestone_task
            JOIN public.task_instances pi ON pi.site_id = ti.site_id AND pi.task_def_id = tp.predecessor_id
            WHERE tp.task_def_id = ti.task_def_id AND pi.actual_date IS NULL AND NOT pi.is_na AND pi.state NOT IN ('approved', 'na', 'skipped')
              AND NOT coalesce((pay -> pd.code) ? 'actual_date', false);
          IF pmiss IS NOT NULL AND coalesce((p ->> 'actual_date')::date, ti.actual_date) IS NOT NULL THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'missing_predecessor_date',
              'The predecessor ' || pmiss || ' has no actual date (missing data).'));
          END IF;
        END IF;
        IF jsonb_array_length(e) = 0 AND action = 'update' THEN
          eff_actual := coalesce((p ->> 'actual_date')::date, ti.actual_date);
          eff_start := coalesce((p ->> 'actual_start')::date, ti.actual_start);
          IF eff_start IS NOT NULL AND eff_actual IS NOT NULL AND eff_start > eff_actual THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'date_order', 'The actual start is after the actual date.'));
          END IF;
          IF eff_actual IS NOT NULL AND ti.sla_start_date IS NOT NULL AND eff_actual < ti.sla_start_date THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'sla_negative',
              'The actual date is before the SLA start (' || ti.sla_start_date::text || '): the duration is negative and raises a data-quality alert.'));
          ELSIF eff_actual IS NOT NULL AND ti.due_date IS NOT NULL AND eff_actual > ti.due_date THEN
            w := w || jsonb_build_array(public.imp_task_note(p_cols, tc, 'actual_date', 'sla_late', 'The actual date is after the SLA limit (' || ti.due_date::text || '): the task is late.'));
          END IF;
        END IF;
      END IF;
    END IF;
    IF jsonb_array_length(e) > 0 THEN action := 'error'; diff := '{}'::jsonb; decision := 'pending'; hold := NULL; END IF;
    items := items || jsonb_build_array(jsonb_build_object('task_code', tc, 'task_id', ti.id, 'name', tname, 'action', action, 'decision', decision, 'hold_reason', hold,
      'errors', e, 'warnings', w, 'diff', diff, 'payload', jsonb_build_object('fields', p) || CASE WHEN save_only THEN jsonb_build_object('save_only', true) ELSE '{}'::jsonb END, 'key', s.site_code || ' / ' || tc,
      'sig', CASE WHEN ti.id IS NOT NULL THEN 't:' || ti.id::text END));
  END LOOP;
  RETURN jsonb_build_object('site_id', s.id, 'site_code', s.site_code, 'region_id', s.region_id, 'row_errors', rowerrs, 'items', items);
END $function$;

-- imp_submit_stream_rows (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.imp_submit_stream_rows(p_batch uuid, p_rows uuid[], p_stepup boolean, p_async boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; t public.task_instances%ROWTYPE; submitted int := 0; saved int := 0;
  processed int := 0; held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; patch jsonb; st text; msg text; pend text; start_d date; draft boolean; flds jsonb;
  row_draft boolean;   -- 0085: a row of the historical load without an actual date is saved, not submitted
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  draft := (b.mode = 'draft');
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.task_instance_id IS NOT NULL AND x.action = 'update'
             AND x.decision IN ('pending', 'pending_previous_approval') AND x.task_submitted_at IS NULL AND (p_rows IS NULL OR x.id = ANY (p_rows)) ORDER BY x.ord LOOP
    processed := processed + 1;
    BEGIN
      SELECT * INTO t FROM public.task_instances x WHERE x.id = r.task_instance_id FOR UPDATE;
      IF NOT FOUND OR NOT public.app_region_check(t.region_id) THEN
        RAISE EXCEPTION 'wf:not_found:{"detail": "The task does not exist or is not visible to you."}';
      END IF;
      IF t.state IN ('in_review', 'in_approval') THEN
        UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = 'open_submission' WHERE id = r.id;
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', 'open_submission', 'record_id', NULL));
        CONTINUE;
      ELSIF t.state = 'locked' AND public.swl_site_locked(t.site_id) THEN   -- 0085: an open site never holds the row
        SELECT string_agg(pd.code, ', ' ORDER BY pd.code) INTO pend FROM public.task_predecessors tp
          JOIN public.task_definitions pd ON pd.id = tp.predecessor_id
          JOIN public.task_instances pi ON pi.site_id = t.site_id AND pi.task_def_id = tp.predecessor_id
          WHERE tp.task_def_id = t.task_def_id AND pi.state NOT IN ('approved', 'na', 'skipped');
        UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = CASE WHEN pend IS NOT NULL THEN 'predecessor_open' ELSE 'gate_locked' END WHERE id = r.id;
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key,
          'reason', CASE WHEN pend IS NOT NULL THEN 'predecessor_open' ELSE 'gate_locked' END, 'record_id', NULL));
        CONTINUE;
      ELSIF t.state NOT IN ('open', 'entry', 'locked') THEN
        RAISE EXCEPTION 'wf:task_not_open:{"detail": "The task is no longer open for entry."}';
      END IF;

      flds := coalesce(r.payload -> 'fields', '{}'::jsonb);
      patch := public.imp_task_patch(flds, r.diff);
      PERFORM set_config('app.batch_row', r.id::text, true);
      row_draft := draft OR (b.historical_load AND coalesce((r.payload ->> 'save_only')::boolean, false));
      IF t.state IN ('open', 'locked') AND (NOT row_draft OR flds ? 'actual_start' OR flds ? 'actual_date') THEN
        start_d := public.imp_start_date(r.task_code, flds, t);
        IF start_d IS NULL AND b.historical_load THEN start_d := coalesce(nullif(flds ->> 'actual_date', '')::date, t.actual_date); END IF;   -- 0085 (warning missing_actual_start)
        IF start_d IS NULL THEN
          RAISE EXCEPTION 'wf:actual_start_required:{"detail": "The task is pending: type its Actual Start. GSDN Workspace never uses today as the start of an earlier piece of work (Q209)."}';
        END IF;
        PERFORM public.wf_start(t.id, NULL, start_d);
      END IF;
      PERFORM public.wf_save_entry(t.id, NULL, patch);
      IF row_draft THEN
        PERFORM set_config('app.batch_row', '', true);
        UPDATE public.import_batch_rows SET hold_reason = NULL, decision = 'saved', decided_by = actor, decided_at = now() WHERE id = r.id;
        saved := saved + 1;
        CONTINUE;
      END IF;
      IF b.historical_load THEN   -- 0073 (Q462): the mandatory-document check can be waived for this row (see hw_row_waiver)
        PERFORM public.wf_complete_hw(t.id, NULL, 'submit', NULL, p_stepup, r.id);
      ELSE
        PERFORM public.wf_submit(t.id, NULL, NULL, p_stepup);
      END IF;
      PERFORM set_config('app.batch_row', '', true);
      SELECT x.state::text INTO st FROM public.task_instances x WHERE x.id = t.id;
      UPDATE public.import_batch_rows SET hold_reason = NULL, task_submitted_at = now(),
        decision = CASE WHEN st = 'approved' THEN 'approved' ELSE 'pending' END,
        decided_by = CASE WHEN st = 'approved' THEN actor END, decided_at = CASE WHEN st = 'approved' THEN now() END WHERE id = r.id;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.batch_row', '', true);
      IF SQLERRM LIKE 'wf:step_up_required%' THEN
        IF NOT coalesce(p_async, false) THEN RAISE; END IF;
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'step_up_required',
          'message', 'This row is a final approval and needs a step-up: send the batch again after confirming your password.'));
        CONTINUE;
      END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be sent', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN public.imp_wf_message(j, j ->> 'code') ELSE 'The task refused this row. See the System Log (template-check) for the technical reason.' END;
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', task_submitted_at = NULL, hold_reason = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('column', coalesce(r.task_code, 'Task'), 'field', coalesce(r.task_code, 'task'), 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  RETURN jsonb_build_object('submitted', submitted, 'saved', saved, 'processed', processed, 'held', held, 'failed', failed);
END $function$;

-- imp_stream_open (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.imp_stream_open(p_template text, p_version integer, p_checksum text, p_task uuid, p_mode text, p_hw jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; r_import int[]; r_view int[]; r_edit int[]; task_site uuid;
  hw_cutoff date;   -- 0073: the cutoff of the open waiver when the batch is marked
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_hw IS NOT NULL THEN
    IF p_mode <> 'submit' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'The historical load is for Submit for Review: a draft has no document check.'))));
    END IF;
    hw_cutoff := public.hw_mark_authorize(p_hw ->> 'reason');   -- 0073 (Q462): a System Admin, a step-up, the waiver open, a reason
  END IF;
  IF p_mode NOT IN ('submit', 'draft') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'mode is submit or draft.'))));
  END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active AND kind = 'stream';
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file was made from version ' || p_version || ' of ' || p_template || '; the current version is ' || v.version || '. Download the template again.'));
  END IF;
  IF p_checksum IS NOT NULL AND v.header_checksum <> p_checksum THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
  END IF;
  r_import := public.wf_actor_regions('templates', 'import');
  r_view := public.wf_actor_regions('sites', 'view');
  r_edit := public.wf_actor_regions('sites', 'edit');
  IF (r_import IS NOT NULL AND cardinality(r_import) = 0) OR (r_view IS NOT NULL AND cardinality(r_view) = 0) OR (r_edit IS NOT NULL AND cardinality(r_edit) = 0) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'import_not_allowed', 'detail', 'You may not import tasks of the Site Register.'));
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT t.site_id INTO task_site FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id);
    IF task_site IS NULL THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.')); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
                   WHERE ti.id = p_task AND sd.stream_code = d.stream_code) THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'This task belongs to another stream: this template is for the stream ' || d.stream_code || '.'));
    END IF;
  END IF;
  RETURN jsonb_build_object('template_id', p_template, 'version_id', v.id, 'stream_code', d.stream_code, 'r_import', to_jsonb(r_import), 'r_view', to_jsonb(r_view),
    'r_edit', to_jsonb(r_edit), 'task_site', task_site, 'hw_cutoff', hw_cutoff,
    'hw_reason', CASE WHEN hw_cutoff IS NOT NULL THEN btrim(p_hw ->> 'reason') END);   -- 0085
END $function$;

-- imp_stream_eval (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.imp_stream_eval(p_ctx jsonb, p_rows jsonb, p_mode text, p_sheet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  cols jsonb; r_view int[] := public.imp_int_array(p_ctx -> 'r_view'); r_import int[] := public.imp_int_array(p_ctx -> 'r_import'); r_edit int[] := public.imp_int_array(p_ctx -> 'r_edit');
  task_site uuid := (p_ctx ->> 'task_site')::uuid; hw_cutoff date := (p_ctx ->> 'hw_cutoff')::date; el jsonb; acc jsonb[] := ARRAY[]::jsonb[]; sids uuid[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT v.columns INTO cols FROM public.template_versions v WHERE v.id = (p_ctx ->> 'version_id')::uuid;
  IF hw_cutoff IS NOT NULL THEN
    -- 0085: a historical load accepts the data as it is: the sites of these rows lose their workflow locks first (audited per site, the reason of the load)
    SELECT array_agg(DISTINCT s.id) INTO sids FROM public.sites s
    WHERE upper(s.site_code) IN (SELECT upper(btrim(x ->> 'site_code')) FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x)
      AND public.app_region_check(s.region_id) AND public.imp_region_ok(r_view, s.region_id) AND (task_site IS NULL OR s.id = task_site);
    PERFORM public.swl_open_for_load(sids, coalesce(p_ctx ->> 'hw_reason', 'historical load'), 'historical_template');
  END IF;
  FOR el IN SELECT x FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x LOOP
    acc := array_append(acc, jsonb_build_object('row_no', (el ->> 'row_no')::int, 'sheet', coalesce(el ->> 'sheet', p_sheet),
      'res', public.imp_stage_task_row(cols, el, task_site, r_view, r_import, r_edit, p_mode, hw_cutoff)));
  END LOOP;
  RETURN to_jsonb(acc);
END $function$;

-- mi_apply_run (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb)
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
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  SELECT * INTO r FROM public.master_reconciliation_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The import run does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The run changed since you read it. Reload and try again.')); END IF;
  IF r.status <> 'previewed' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This run was already applied.')); END IF;
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
  END IF;
  IF hw IS NOT NULL THEN
    -- 0085: the historical load accepts the data as it is: every site of the file loses its workflow locks first (audited per site, the reason of the load)
    PERFORM public.swl_open_for_load((SELECT array_agg(DISTINCT x.site_id) FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL),
      hw ->> 'reason', 'historical_master_import');
  END IF;
  IF public.app_ctx_stepup() THEN   -- 0075
    SELECT us.stepup_at + make_interval(secs => coalesce((SELECT CASE WHEN jsonb_typeof(st.value) = 'number' THEN (st.value #>> '{}')::int END
                                                          FROM public.settings st WHERE st.key = 'stepup_max_age_seconds'), 300))
      INTO su_until FROM public.user_sessions us WHERE us.id = public.log_ctx_uuid('session_id') AND us.user_id = actor AND us.revoked_at IS NULL AND us.stepup_at IS NOT NULL;
  END IF;
  SELECT x.id INTO prev FROM public.master_reconciliation_runs x WHERE x.file_sha256 = r.file_sha256 AND x.status = 'applied' AND x.id <> r.id LIMIT 1;
  IF prev IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This file was already applied (run ' || prev::text || '). A reconciliation run compares again; it never applies the same file twice.'));
  END IF;

  SELECT v.* INTO tv FROM public.template_versions v JOIN public.template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MASTER' AND v.is_current;
  SELECT x INTO mpart FROM jsonb_array_elements(tv.columns) x WHERE x ->> 'kind' = 'master' LIMIT 1;
  mcols := mpart -> 'columns';
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
    CONTINUE WHEN cells = '{}'::jsonb AND pres = '[]'::jsonb;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('row_no', row_.row_no, 'site_code', row_.site_code, 'cells', cells, 'pre_errors', pres));
  END LOOP;
  IF jsonb_array_length(v_rows) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'No typed task column of this file belongs to a site of GSDN Workspace: nothing can be entered.'));
  END IF;
  res := public.imp_stage_master_core('TPL-MASTER', tv.version, r.file_name, r.file_sha256,
    jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid, hw);
  FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x LOOP
    -- 0075: a batch with more rows than imports.async_rows is sent in the background (the checks of the request run in imp_async_start, the rows in chunks)
    q := public.imp_async_start((b ->> 'id')::uuid, NULL, 'submit', NULL, NULL, NULL, NULL, su_until);
    IF coalesce((q ->> 'queued')::boolean, false) THEN
      queued := queued + 1;
      batches := batches || jsonb_build_array(b || jsonb_build_object('queued', true, 'job_id', q -> 'job' -> 'job_id', 'rows', q -> 'job' -> 'rows_total',
        'submitted', 0, 'saved', 0, 'held', 0, 'failed', 0,
        'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error')));
      CONTINUE;
    END IF;
    sent := public.imp_submit_batch((b ->> 'id')::uuid, NULL, p_stepup);
    batches := batches || jsonb_build_array(b || jsonb_build_object('submitted', sent -> 'submitted', 'saved', sent -> 'saved', 'held', jsonb_array_length(coalesce(sent -> 'held', '[]'::jsonb)),
      'failed', jsonb_array_length(coalesce(sent -> 'failed', '[]'::jsonb)),
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error')));
  END LOOP;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued);
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL), btrim(p_reason));
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;

-- site_new_clean (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.site_new_clean(p_raw jsonb, p_draft uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  raw jsonb := CASE WHEN jsonb_typeof(p_raw) = 'object' THEN p_raw ELSE '{}'::jsonb END;
  allowed text[] := ARRAY['site_code', 'region', 'region_id', 'name', 'name_ar', 'owner_site_id', 'cluster_code', 'delivery_scenario', 'site_scenario', 'site_type',
    'project_phase', 'delivery_batch', 'cw_delivery_model', 'scope_tower_erection', 'scope_site_adaption', 'scope_gecol_power', 'scope_hlc_fiber', 'scope_te_full',
    'scope_te_ip_router_only', 'overall_status', 'sub_region', 'latitude', 'longitude', 'address', 'rf_survey_date', 'workflow_locks'];
  flags text[] := ARRAY['scope_tower_erection', 'scope_site_adaption', 'scope_gecol_power', 'scope_hlc_fiber', 'scope_te_full', 'scope_te_ip_router_only'];
  errs jsonb := '[]'::jsonb; warns jsonb := '[]'::jsonb; clean jsonb := '{}'::jsonb; k text; v text; code text; rid integer; rid2 integer; rtext text; canon text; lat numeric; lon numeric;
  d date; wf uuid; probe uuid; conf jsonb; allow_other boolean; msg text; cl public.clusters%ROWTYPE; short text; lim int;
BEGIN
  -- only the known fields; anything else (a landlord, a phone, an e-mail) is refused: those columns are not loaded (Q469)
  FOR k IN SELECT jsonb_object_keys(raw) LOOP
    IF NOT (k = ANY (allowed)) THEN
      errs := errs || public.site_new_err(left(k, 60), 'unknown_field', 'This field is not accepted. A new site carries its identity and scope only; landlord and contact data are not loaded.');
    ELSIF jsonb_typeof(raw -> k) NOT IN ('string', 'number', 'boolean', 'null') THEN
      errs := errs || public.site_new_err(k, 'invalid', 'A single value is expected.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN RETURN jsonb_build_object('clean', clean, 'errors', errs, 'warnings', warns); END IF;

  -- Site ID: required, a plain code, never used before (a cancelled or voided site keeps its ID), not waiting in another draft
  code := public.site_new_code(raw ->> 'site_code');
  IF code = '' THEN
    errs := errs || public.site_new_err('site_code', 'required', 'The Site ID is required.');
  ELSIF code !~ '^[A-Z0-9]([A-Z0-9 ._/-]{0,38}[A-Z0-9])?$' THEN
    errs := errs || public.site_new_err('site_code', 'invalid', 'A Site ID uses Latin letters, digits, space, dot, dash, underscore or slash (for example TR001).');
  ELSE
    clean := clean || jsonb_build_object('site_code', code);
    IF EXISTS (SELECT 1 FROM public.sites s WHERE public.site_new_code(s.site_code) = code) THEN
      errs := errs || public.site_new_err('site_code', 'duplicate', 'This Site ID exists already. A Site ID is never reused, also when the site is cancelled or voided.');
    ELSIF EXISTS (SELECT 1 FROM public.site_drafts d WHERE d.site_code = code AND d.status IN ('entry', 'in_approval') AND d.id IS DISTINCT FROM p_draft) THEN
      errs := errs || public.site_new_err('site_code', 'duplicate', 'A site with this Site ID is already waiting for approval.');
    END IF;
  END IF;

  -- Region: an id, or a name, code or alias (region_aliases, P3)
  rtext := nullif(btrim(raw ->> 'region'), '');
  IF nullif(btrim(raw ->> 'region_id'), '') IS NOT NULL THEN
    IF (raw ->> 'region_id') ~ '^[0-9]{1,3}$' THEN
      SELECT id INTO rid FROM public.regions WHERE id = (raw ->> 'region_id')::int;
    END IF;
    IF rid IS NULL THEN errs := errs || public.site_new_err('region', 'unknown_region', 'Unknown region.'); END IF;
  END IF;
  IF rtext IS NOT NULL THEN
    rid2 := public.imp_region_resolve(rtext);
    IF rid2 IS NULL THEN
      errs := errs || public.site_new_err('region', 'unknown_region', 'Unknown region. Use a region name, its code or a known alias (Settings, region aliases).');
    ELSIF rid IS NOT NULL AND rid <> rid2 THEN
      errs := errs || public.site_new_err('region', 'region_mismatch', 'Region and region ID name different regions.');
    ELSE rid := rid2; END IF;
  END IF;
  IF rid IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(errs) e WHERE e ->> 'field' = 'region') THEN
    errs := errs || public.site_new_err('region', 'required', 'The region is required.');
  END IF;
  IF rid IS NOT NULL THEN clean := clean || jsonb_build_object('region_id', rid); END IF;

  -- names and plain text fields
  FOREACH k IN ARRAY ARRAY['name', 'name_ar', 'owner_site_id', 'sub_region', 'project_phase', 'delivery_batch', 'cw_delivery_model', 'address'] LOOP
    v := nullif(btrim(regexp_replace(coalesce(raw ->> k, ''), '[[:cntrl:]]', '', 'g')), '');
    IF v IS NULL THEN
      IF k = 'name' THEN errs := errs || public.site_new_err('name', 'required', 'The English site name is required.'); END IF;
      CONTINUE;
    END IF;
    lim := CASE WHEN k = 'address' THEN 500 WHEN k IN ('name', 'name_ar') THEN 200 ELSE 80 END;
    IF char_length(v) > lim THEN
      errs := errs || public.site_new_err(k, 'too_long', 'This text is too long.');
    ELSE clean := clean || jsonb_build_object(k, v); END IF;
  END LOOP;

  -- cluster: it must exist in the site's region (or be global), or it is created when L2 approves (a warning tells the reviewer)
  v := nullif(btrim(regexp_replace(coalesce(raw ->> 'cluster_code', ''), '[[:space:]]+', ' ', 'g')), '');
  IF v IS NOT NULL THEN
    IF v !~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,38}$' THEN
      errs := errs || public.site_new_err('cluster_code', 'invalid', 'A cluster code uses letters, digits, space, dot, dash or underscore.');
    ELSE
      SELECT * INTO cl FROM public.clusters c WHERE upper(c.cluster_code) = upper(v);
      IF FOUND THEN
        IF NOT cl.is_global AND rid IS NOT NULL AND cl.region_id IS DISTINCT FROM rid THEN
          errs := errs || public.site_new_err('cluster_code', 'cluster_other_region', 'This cluster belongs to another region.');
        ELSE clean := clean || jsonb_build_object('cluster_code', cl.cluster_code); END IF;
      ELSE
        clean := clean || jsonb_build_object('cluster_code', upper(v));
        warns := warns || public.site_new_err('cluster_code', 'cluster_will_be_created', 'This cluster does not exist yet: it is created in the region of the site when L2 approves.');
      END IF;
    END IF;
  END IF;

  -- delivery scenario: the DeliveryScenario list (stored as its code)
  v := nullif(btrim(raw ->> 'delivery_scenario'), '');
  IF v IS NULL THEN
    errs := errs || public.site_new_err('delivery_scenario', 'required', 'The delivery scenario is required.');
  ELSIF NOT (replace(lower(v), ' ', '_') = ANY (enum_range(NULL::"DeliveryScenario")::text[]))
        OR public.site_new_list('DeliveryScenario', v) IS NULL THEN
    errs := errs || public.site_new_err('delivery_scenario', 'not_in_list', 'Not a delivery scenario: New Build, Expansion, Hot Swap, Cold Swap or Relocation.');
  ELSE clean := clean || jsonb_build_object('delivery_scenario', replace(lower(v), ' ', '_')); END IF;

  -- the other lists
  FOREACH k IN ARRAY ARRAY['site_scenario', 'site_type'] LOOP
    v := nullif(btrim(raw ->> k), '');
    CONTINUE WHEN v IS NULL;
    canon := public.site_new_list(CASE k WHEN 'site_scenario' THEN 'SiteScenario' ELSE 'SiteType' END, v);
    IF canon IS NOT NULL THEN clean := clean || jsonb_build_object(k, canon);
    ELSE
      SELECT c.allow_other INTO allow_other FROM public.list_catalogues c WHERE c.code = CASE k WHEN 'site_scenario' THEN 'SiteScenario' ELSE 'SiteType' END;
      IF coalesce(allow_other, false) AND char_length(v) <= 80 THEN
        clean := clean || jsonb_build_object(k, v);
        warns := warns || public.site_new_err(k, 'list_other', 'This value is not in the list; the list allows another value.');
      ELSE errs := errs || public.site_new_err(k, 'not_in_list', 'Not a value of the list.'); END IF;
    END IF;
  END LOOP;

  -- scope flags: Yes, No (N/A) or blank
  FOREACH k IN ARRAY flags LOOP
    v := lower(btrim(coalesce(raw ->> k, '')));
    CONTINUE WHEN v = '';
    IF v IN ('yes', 'y', 'true', '1') THEN clean := clean || jsonb_build_object(k, 'yes');
    ELSIF v IN ('no', 'n', 'n/a', 'na', 'false', '0') THEN clean := clean || jsonb_build_object(k, 'na');
    ELSE errs := errs || public.site_new_err(k, 'invalid', 'Yes, No or blank.'); END IF;
  END LOOP;

  -- the overall status of a new site: Not Started, or Cancelled (a cancelled site of the Master still has its history, Q466)
  v := nullif(replace(lower(btrim(coalesce(raw ->> 'overall_status', ''))), ' ', '_'), '');
  IF v IS NOT NULL THEN
    IF v IN ('not_started', 'cancelled') THEN clean := clean || jsonb_build_object('overall_status', v);
    ELSE errs := errs || public.site_new_err('overall_status', 'invalid', 'A new site is Not Started, or Cancelled. Other statuses follow the work.'); END IF;
  END IF;

  -- coordinates: both or none, in range
  lat := NULL; lon := NULL;
  IF nullif(btrim(coalesce(raw ->> 'latitude', '')), '') IS NOT NULL THEN
    IF btrim(raw ->> 'latitude') ~ '^-?[0-9]{1,2}(\.[0-9]+)?$' AND abs((btrim(raw ->> 'latitude'))::numeric) <= 90 THEN lat := round((btrim(raw ->> 'latitude'))::numeric, 6);
    ELSE errs := errs || public.site_new_err('latitude', 'invalid', 'A latitude is a number from -90 to 90.'); END IF;
  END IF;
  IF nullif(btrim(coalesce(raw ->> 'longitude', '')), '') IS NOT NULL THEN
    IF btrim(raw ->> 'longitude') ~ '^-?[0-9]{1,3}(\.[0-9]+)?$' AND abs((btrim(raw ->> 'longitude'))::numeric) <= 180 THEN lon := round((btrim(raw ->> 'longitude'))::numeric, 6);
    ELSE errs := errs || public.site_new_err('longitude', 'invalid', 'A longitude is a number from -180 to 180.'); END IF;
  END IF;
  IF (nullif(btrim(coalesce(raw ->> 'latitude', '')), '') IS NULL) <> (nullif(btrim(coalesce(raw ->> 'longitude', '')), '') IS NULL) THEN
    errs := errs || public.site_new_err(CASE WHEN nullif(btrim(coalesce(raw ->> 'latitude', '')), '') IS NULL THEN 'latitude' ELSE 'longitude' END, 'pair_required', 'Latitude and longitude go together.');
  ELSIF lat IS NOT NULL AND lon IS NOT NULL THEN
    clean := clean || jsonb_build_object('latitude', lat, 'longitude', lon);
    IF lat NOT BETWEEN 19 AND 34 OR lon NOT BETWEEN 9 AND 26 THEN
      warns := warns || public.site_new_err('latitude', 'outside_libya', 'These coordinates are outside Libya. Check them.');
    END IF;
  END IF;

  -- date
  v := nullif(btrim(coalesce(raw ->> 'rf_survey_date', '')), '');
  IF v IS NOT NULL THEN
    d := NULL;
    IF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN BEGIN d := v::date; EXCEPTION WHEN others THEN d := NULL; END; END IF;
    IF d IS NULL OR d < DATE '2000-01-01' THEN errs := errs || public.site_new_err('rf_survey_date', 'invalid', 'A date as yyyy-mm-dd, from 2000-01-01.');
    ELSIF d > public.cal_today() THEN errs := errs || public.site_new_err('rf_survey_date', 'future_date', 'An actual date cannot be in the future.');
    ELSE clean := clean || jsonb_build_object('rf_survey_date', d::text); END IF;
  END IF;

  -- the scenario rules (P1, Q3): a probe site in a subtransaction that is rolled back says whether the scope and the scenario conflict
  IF jsonb_array_length(errs) = 0 THEN
    wf := public.active_workflow_id();
    IF wf IS NULL OR NOT public.wf_is_published(wf) THEN
      errs := errs || public.site_new_err('delivery_scenario', 'no_workflow', 'There is no published workflow version to create a site on.');
    ELSE
      BEGIN
        INSERT INTO public.sites (site_code, name, region_id, workflow_version_id, delivery_scenario, scope_tower_erection, scope_site_adaption, scope_gecol_power, scope_hlc_fiber,
          scope_te_full, scope_te_ip_router_only, updated_at)
        VALUES ('PROBE-' || gen_random_uuid()::text, 'probe', rid, wf, (clean ->> 'delivery_scenario')::"DeliveryScenario",
          coalesce((clean ->> 'scope_tower_erection')::"ScopeFlag", 'na'), coalesce((clean ->> 'scope_site_adaption')::"ScopeFlag", 'na'),
          coalesce((clean ->> 'scope_gecol_power')::"ScopeFlag", 'na'), coalesce((clean ->> 'scope_hlc_fiber')::"ScopeFlag", 'na'),
          coalesce((clean ->> 'scope_te_full')::"ScopeFlag", 'na'), coalesce((clean ->> 'scope_te_ip_router_only')::"ScopeFlag", 'na'), now()) RETURNING id INTO probe;
        conf := public.scope_scenario_conflicts(probe);
        RAISE EXCEPTION 'site_new:probe_done';
      EXCEPTION WHEN others THEN
        IF SQLERRM <> 'site_new:probe_done' THEN
          errs := errs || public.site_new_err('delivery_scenario', 'invalid', 'The site could not be checked against the scenario rules.');
          conf := NULL;
        END IF;
      END;
      IF conf IS NOT NULL AND jsonb_array_length(conf) > 0 THEN
        short := left(coalesce(conf -> 0 ->> 'message', 'The scenario and the scope flags disagree.'), 300);
        errs := errs || public.site_new_err('delivery_scenario', 'scope_scenario_conflict', short);
      END IF;
    END IF;
  END IF;
  -- 0085: Workflow locks, Locked (the default) or Open; Open needs the right of site_workflow_locks_set when L2 approves the site (swl_site_created)
  v := nullif(btrim(coalesce(raw ->> 'workflow_locks', '')), '');
  IF v IS NOT NULL THEN
    IF public.swl_parse(v) IS NULL THEN
      errs := errs || public.site_new_err('workflow_locks', 'invalid', 'Workflow locks is Locked or Open.');
    ELSE
      clean := clean || jsonb_build_object('workflow_locks', CASE WHEN public.swl_parse(v) THEN 'locked' ELSE 'open' END);
      IF NOT public.swl_parse(v) THEN
        warns := warns || public.site_new_err('workflow_locks', 'workflow_locks_open', 'The site is created with its workflow locks off: tasks are not held by predecessors or gates. The approver needs the right to unlock (System Admin or the delegated right).');
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('clean', clean, 'errors', errs, 'warnings', warns);
END $function$;

-- tpl_sites_columns (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.tpl_sites_columns()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  WITH c (ord, code, header, type, kind, required, options, allow_other) AS (VALUES
    (1,  'site_code',         'Site ID',                'text',   'site',  true,  NULL::jsonb, NULL::boolean),
    (2,  'region',            'Region',                 'text',   'field', true,  (SELECT jsonb_agg(r.name_en ORDER BY r.id) FROM public.regions r), true),
    (3,  'name',              'Site Name (EN)',         'text',   'field', true,  NULL, NULL),
    (4,  'name_ar',           'Site Name (AR)',         'text',   'field', false, NULL, NULL),
    (5,  'owner_site_id',     'Site Owner ID',          'text',   'field', false, NULL, NULL),
    (6,  'cluster_code',      'Cluster',                'text',   'field', false, NULL, NULL),
    (7,  'delivery_scenario', 'Delivery Scenario',      'list',   'field', true,  public.list_active_codes('DeliveryScenario'), NULL),
    (8,  'site_scenario',     'Site Scenario',          'list',   'field', false, public.list_active_codes('SiteScenario'), NULL),
    (9,  'site_type',         'Site Type',              'list',   'field', false, public.list_active_codes('SiteType'), NULL),
    (10, 'project_phase',     'Project Phase',          'text',   'field', false, NULL, NULL),
    (11, 'delivery_batch',    'Delivery Batch',         'text',   'field', false, NULL, NULL),
    (12, 'cw_delivery_model', 'CW Delivery Model',      'text',   'field', false, NULL, NULL),
    (13, 'scope_tower_erection',    'Tower Erection',   'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (14, 'scope_site_adaption',     'Site Adaption',    'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (15, 'scope_gecol_power',       'GECOL Power',      'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (16, 'scope_hlc_fiber',         'HLC Fiber',        'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (17, 'scope_te_full',           'TE Full',          'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (18, 'scope_te_ip_router_only', 'TE IP Router Only', 'list',  'field', false, '["Yes", "No"]'::jsonb, NULL),
    (19, 'overall_status',    'Overall Status',         'list',   'field', false, '["Not Started", "Cancelled"]'::jsonb, NULL),
    (20, 'sub_region',        'Sub-region',             'text',   'field', false, NULL, NULL),
    (21, 'latitude',          'Latitude',               'number', 'field', false, NULL, NULL),
    (22, 'longitude',         'Longitude',              'number', 'field', false, NULL, NULL),
    (23, 'address',           'Address',                'text',   'field', false, NULL, NULL),
    (24, 'rf_survey_date',    'RF Survey Date',         'date',   'field', false, NULL, NULL),
    (25, 'workflow_locks',    'Workflow Locks',         'list',   'field', false, '["Locked", "Open"]'::jsonb, NULL))   -- 0085
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('code', c.code, 'header', c.header, 'type', c.type, 'kind', c.kind, 'required', c.required, 'derived', false,
           'options', c.options, 'allow_other', c.allow_other)) ORDER BY c.ord) FROM c
$function$;

-- dash_build_tasks (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.dash_build_tasks(p_ref date, p_stream text, p_excl boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE eff date;
BEGIN
  SELECT max(d) INTO eff FROM _dcal WHERE d <= p_ref AND is_wd;
  DROP TABLE IF EXISTS _dtask;
  CREATE TEMP TABLE _dtask ON COMMIT DROP AS
    WITH base AS (
      SELECT t.id, t.site_id, s.region_id, td.code AS task_code, sd.code AS stage_code, sd.stream_code,
             t.state::text AS state, (t.admin_override OR t.historical_no_documents OR t.lock_bypassed) AS admin_override, t.sla_target_date, t.due_date, t.sla_elapsed_wd, t.sla_end_date,
             r.max_working_days AS sla_max, t.return_count, coalesce(t.actual_date, t.approved_date) AS done_date,
             t.external_party_id, td.default_external_party::text AS default_party,
             CASE WHEN t.sla_start_date IS NULL OR t.sla_start_date > p_ref OR t.state IN ('locked', 'na', 'skipped') OR t.is_na
                       OR (p_excl AND (t.admin_override OR t.historical_no_documents OR t.lock_bypassed)) THEN 'none'
                  WHEN t.state = 'approved' AND coalesce(t.sla_end_date, t.actual_date, t.approved_date, p_ref) <= p_ref THEN 'closed'
                  WHEN t.due_date IS NULL THEN 'none'
                  ELSE 'open' END AS phase
      FROM _dsite s
      JOIN public.task_instances t ON t.site_id = s.id
      JOIN public.task_definitions td ON td.id = t.task_def_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id
      LEFT JOIN public.sla_rules r ON r.id = t.sla_rule_id
      WHERE NOT s.cancelled AND t.state NOT IN ('locked', 'na', 'skipped') AND (p_stream IS NULL OR sd.stream_code = p_stream)
    )
    SELECT b.id, b.site_id, b.region_id, b.task_code, b.stage_code, b.stream_code, b.state, b.admin_override, b.due_date, b.return_count, b.done_date,
      b.external_party_id, b.default_party, b.phase,
      CASE WHEN b.phase = 'closed' THEN CASE WHEN b.sla_elapsed_wd IS NULL OR b.sla_max IS NULL THEN NULL WHEN b.sla_elapsed_wd <= b.sla_max THEN 'on_time' ELSE 'late' END
           WHEN b.phase = 'open' THEN CASE WHEN eff <= coalesce(b.sla_target_date, b.due_date) THEN 'on_time' WHEN eff <= b.due_date THEN 'at_risk' ELSE 'late' END END AS cls,
      CASE WHEN b.phase = 'closed' AND b.sla_elapsed_wd IS NOT NULL AND b.sla_max IS NOT NULL THEN greatest(0, b.sla_elapsed_wd - b.sla_max)
           WHEN b.phase = 'open' AND eff > b.due_date THEN greatest(0, (SELECT wd FROM _dcal WHERE d = p_ref) - cd.wd) ELSE 0 END AS days_over
    FROM base b LEFT JOIN _dcal cd ON cd.d = b.due_date;
  CREATE INDEX ON _dtask (phase, cls);
END $function$;

-- dash_core (latest definition, changes marked 0085)
CREATE OR REPLACE FUNCTION public.dash_core(p_ref date, p_scope integer[], p_region integer, p_cluster text, p_scenario text, p_stream text, p_excl boolean, p_ws uuid, p_sections text[], p_snap date, p_group text, p_issue_scope integer[], p_issues boolean, p_view text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  out_ jsonb := '{}'::jsonb; ws uuid; wide boolean; all_regions boolean; need_tasks boolean; hl jsonb; ps_card jsonb; snap_ws uuid; flagged int; hist int; wf_versions int[];
  rows_none jsonb; rows_region jsonb; ms jsonb; live boolean := (p_ref = public.cal_today()); blk_ok boolean; appr text[]; gt jsonb;
BEGIN
  PERFORM public.dash_build_cal();
  IF p_snap IS NOT NULL THEN PERFORM public.dash_build_facts_snap(p_snap, p_scope, p_region, p_cluster, p_scenario);
  ELSE PERFORM public.dash_build_facts(p_ref, p_scope, p_region, p_cluster, p_scenario); END IF;
  blk_ok := CASE WHEN p_snap IS NULL THEN live
                 ELSE EXISTS (SELECT 1 FROM public.site_snapshots ss WHERE ss.snapshot_date = p_snap AND public.dash_local_date(ss.created_at) = p_snap) END;
  IF p_snap IS NULL AND (p_stream IS NOT NULL OR p_sections && ARRAY['streams']) THEN PERFORM public.dash_build_streams(p_ref); END IF;
  IF p_stream IS NOT NULL THEN
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM _dstr x WHERE x.site_id = s.id AND x.stream = p_stream AND x.status <> 'na');
  END IF;
  IF p_view IS NOT NULL THEN
    PERFORM public.dash_build_view(p_view);
    DELETE FROM _dsite s WHERE NOT EXISTS (SELECT 1 FROM public.task_instances t JOIN _dview v ON v.id = t.task_def_id
                                           WHERE t.site_id = s.id AND t.state NOT IN ('na', 'skipped') AND NOT t.is_na);
  END IF;
  all_regions := p_scope IS NULL OR NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id <> ALL (p_scope));
  wide := all_regions AND p_region IS NULL AND p_cluster IS NULL AND p_scenario IS NULL AND p_stream IS NULL AND p_view IS NULL;
  need_tasks := p_sections && ARRAY['sla', 'delay', 'health', 'regions'];
  IF p_sections && ARRAY['headline', 'health', 'regions', 'ps'] THEN
    IF p_snap IS NOT NULL THEN
      SELECT weight_set_id INTO snap_ws FROM public.site_snapshots WHERE snapshot_date = p_snap AND weight_set_id IS NOT NULL LIMIT 1;
      ws := coalesce(p_ws, snap_ws, public.weight_set_in_force('project_status', p_ref));
      IF p_ws IS NULL AND snap_ws IS NOT NULL THEN PERFORM public.dash_build_items_snap(p_snap, ws); ELSE PERFORM public.dash_build_items(p_ref, ws, p_excl); END IF;
    ELSE
      ws := coalesce(p_ws, public.weight_set_in_force('project_status', p_ref));
      PERFORM public.dash_build_items(p_ref, ws, p_excl);
    END IF;
    rows_none := public.dash_ps_rows('none', wide);
    rows_region := public.dash_ps_rows('region', wide);
    ps_card := public.dash_ps_card(wide, rows_none);
  END IF;
  IF need_tasks THEN
    PERFORM public.dash_build_tasks(p_ref, p_stream, p_excl);
    IF p_view IS NOT NULL THEN
      DELETE FROM _dtask x WHERE NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN _dview v ON v.id = ti.task_def_id WHERE ti.id = x.id);
    END IF;
  END IF;

  SELECT array_agg(DISTINCT wd.version ORDER BY wd.version) INTO wf_versions FROM _dsite s JOIN public.workflow_definitions wd ON wd.id = s.wf;
  SELECT count(*) INTO flagged FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.admin_override OR t.historical_no_documents OR t.lock_bypassed;   -- 0085: a lock bypass too
  SELECT count(*) INTO hist FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.historical_no_documents;   -- 0073 (Q462)
  out_ := jsonb_build_object('meta', jsonb_build_object('project_wide', wide, 'workflow_versions', coalesce(to_jsonb(wf_versions), '[]'::jsonb), 'override_flagged_count', flagged, 'historical_flagged_count', hist,
    'lock_bypass_flagged_count', (SELECT count(*) FROM public.task_instances t JOIN _dsite s ON s.id = t.site_id AND NOT s.cancelled WHERE t.lock_bypassed),
    'overrides_excluded', p_excl, 'weight_set_id', ws, 'blocked_gates_available', blk_ok));

  IF p_sections && ARRAY['headline'] THEN
    out_ := out_ || jsonb_build_object('headline', public.dash_sec_status(p_ref) || jsonb_build_object('final_closure', public.dash_sec_closure(p_ref), 'project_status', ps_card));
  END IF;
  IF p_sections && ARRAY['pipeline', 'headline'] THEN
    ms := public.dash_sec_milestones(p_ref, CASE WHEN p_stream IN (SELECT DISTINCT stream_code FROM _dms WHERE stream_code IS NOT NULL) THEN p_stream END);
    IF p_view IS NOT NULL THEN
      SELECT coalesce(jsonb_agg(x.e ORDER BY x.n), '[]'::jsonb) INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n) WHERE x.e ->> 'code' IN (SELECT code FROM _dviewms);
    END IF;
    -- Q186: a blocked count that cannot be known for the date is null ("historically unavailable"), not 0
    SELECT coalesce(jsonb_agg(CASE WHEN blk_ok THEN x.e || jsonb_build_object('blocked_available', true)
                                   ELSE x.e || jsonb_build_object('blocked', NULL, 'blocked_available', false) END ORDER BY x.n), '[]'::jsonb)
    INTO ms FROM jsonb_array_elements(ms) WITH ORDINALITY x(e, n);
    out_ := out_ || jsonb_build_object('milestones', ms);
  END IF;
  IF p_sections && ARRAY['streams'] THEN out_ := out_ || jsonb_build_object('streams', public.dash_sec_streams()); END IF;
  IF p_sections && ARRAY['sla'] THEN out_ := out_ || jsonb_build_object('sla', public.dash_sec_sla(p_ref)); END IF;
  IF p_sections && ARRAY['gates'] THEN
    IF live THEN gt := public.dash_sec_gates(p_ref) || jsonb_build_object('status', 'live');
    ELSIF blk_ok THEN
      gt := jsonb_build_object('available', false, 'status', 'snapshot', 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb,
        'blocked_total', (SELECT count(*) FROM _dms m JOIN _dsite s ON s.id = m.site_id AND NOT s.cancelled WHERE m.blocked));
    ELSE
      gt := jsonb_build_object('available', false, 'status', 'historically_unavailable', 'blocked_total', NULL, 'by_gate', '[]'::jsonb, 'items', '[]'::jsonb);
    END IF;
    out_ := out_ || jsonb_build_object('gates', gt);
  END IF;
  IF p_sections && ARRAY['issues'] THEN
    out_ := out_ || jsonb_build_object('issues', CASE WHEN p_issues THEN public.dash_sec_issues(p_ref, p_issue_scope) ELSE NULL END);
  END IF;
  IF p_sections && ARRAY['health', 'regions'] THEN
    hl := public.dash_sec_health(p_ref, wide, p_issue_scope, p_issues, rows_none, rows_region);
    -- D16: the draft label sits on each factor the owner has not approved; the index itself carries none (Q121)
    SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO appr FROM jsonb_array_elements_text(public.calc_setting('dashboard.health_approved_factors', '["D", "I"]'::jsonb)) x;
    hl := hl || jsonb_build_object('draft', false,
      'components', coalesce((SELECT jsonb_agg(c.e || jsonb_build_object('draft', NOT ((c.e ->> 'code') = ANY (appr))) ORDER BY c.n)
                              FROM jsonb_array_elements(hl -> 'components') WITH ORDINALITY c(e, n)), '[]'::jsonb),
      'draft_factors', coalesce((SELECT jsonb_agg(c.e ->> 'code' ORDER BY c.n) FROM jsonb_array_elements(hl -> 'components') WITH ORDINALITY c(e, n)
                                 WHERE NOT ((c.e ->> 'code') = ANY (appr))), '[]'::jsonb),
      'approved_factors', to_jsonb(appr));
  END IF;
  IF p_sections && ARRAY['health'] THEN out_ := out_ || jsonb_build_object('health', hl); END IF;
  IF p_sections && ARRAY['delay'] THEN out_ := out_ || jsonb_build_object('delay', public.dash_sec_delay(p_ref)); END IF;
  IF p_sections && ARRAY['regions'] THEN out_ := out_ || jsonb_build_object('regions', public.dash_sec_regions(hl, true, rows_region)); END IF;
  IF p_sections && ARRAY['ps'] THEN
    out_ := out_ || jsonb_build_object('ps', jsonb_build_object('card', ps_card, 'rows', CASE WHEN p_group = 'region' THEN rows_region WHEN p_group = 'site' THEN public.dash_ps_rows('site', wide) ELSE '[]'::jsonb END,
      'sites_in_scope', (SELECT count(*) FROM _dsite WHERE NOT cancelled)));
  END IF;
  RETURN out_;
END $function$;

-- The New sites template takes the new column (a new version; an older file is still read by the compatibility rule of 0072 when only this optional column is missing)
SELECT tpl_sync('TPL-SITE-NEW', '0085: the column Workflow Locks (Locked / Open)');

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and execute rights. Every new function is owned by pmis_definer and closed to PUBLIC. pmis_app gets only the API doors: the switch, whether the caller
--    may switch a site, and the data gaps. The opening, re-locking, bypass decision, guards and the historical opening are internal: no grant.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'swl_audit(text,text,text,jsonb,jsonb,text,uuid,integer,boolean)', 'swl_parse(text)', 'swl_site_locked(uuid)', 'swl_task_eligible(uuid)', 'swl_blocker(uuid)', 'swl_may(integer)', 'swl_can_manage(uuid)',
    'swl_open_task(uuid,boolean)', 'swl_relock_task(uuid)', 'swl_apply(uuid,boolean,text,text)', 'site_workflow_locks_set(uuid[],boolean,text)',
    'swl_open_for_load(uuid[],text,text)', 'swl_bypass_reason(uuid,uuid,text)', 'swl_bypass_audit(uuid,uuid,integer,text,boolean)', 'swl_task_trg()',
    'swl_sites_guard()', 'swl_site_created()', 'site_data_gaps(uuid)', 'site_data_gap_count(uuid)',
    'wf_start(uuid,integer,date)', 'wf_save_entry(uuid,integer,jsonb)', 'imp_stage_task_row(jsonb,jsonb,uuid,integer[],integer[],integer[],text,date)',
    'imp_submit_stream_rows(uuid,uuid[],boolean,boolean)', 'imp_stream_open(text,integer,text,uuid,text,jsonb)', 'imp_stream_eval(jsonb,jsonb,text,text)',
    'mi_apply_run(uuid,integer,text,text,boolean,jsonb)', 'site_new_clean(jsonb,uuid)', 'tpl_sites_columns()', 'dash_build_tasks(date,text,boolean)',
    'dash_core(date,integer[],integer,text,text,text,boolean,uuid,text[],date,text,integer[],boolean,text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['site_workflow_locks_set(uuid[],boolean,text)', 'swl_can_manage(uuid)', 'site_data_gaps(uuid)', 'site_data_gap_count(uuid)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
