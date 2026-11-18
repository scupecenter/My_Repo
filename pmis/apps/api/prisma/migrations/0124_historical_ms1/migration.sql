-- 0124_historical_ms1: Site Release (MS1) of the historical Master load: A3 from the Acquisition sheet (Master T "Acquisition Date"), and A5 not applicable
-- on a site that is not HUB or Terminal (owner request 2026-11-18; CHANGELOG 163; contract 0.15.37).
-- Mirror: db/sql/123_historical_ms1.sql (kept byte-identical).
--
-- WHY. After 0123 every one of the 469 sites still stops at Site Release (MS1), which waits for A2, A3, A4 and A5. The re-apply of the historical file (0122)
-- feeds A2 and A4 (and A5 for a HUB or Terminal site) from the RF & Design sheet. Two blockers stay after it (0123 investigation, CHANGELOG 162 "open"):
--   A3: the Acquisition register refuses the selected candidate of the owner's file (a selected candidate needs a Selection Date, which the file has not: Q468,
--       D35), so the register record that is the source of A3 (Q43, register_task_sources: acquisition.contract_signoff_date where selected = Yes) never
--       exists. The task catalogue says A3 <- Master column T "Acquisition Date". Column T is a formula in every row of the Master sheet:
--       =IFERROR(INDEX(cAcq_AcquisitionCompletedDate, MATCH($B&"|Yes", cAcq_SelectKeyhelper, 0)), "") over the Acquisition sheet, where "Acquisition
--       Completed Date" (AD) is itself =IF(AND($AC="Yes", <X is a date>), $X, "") and "Feeds Master" (AC) is Yes when the row is Selected = Yes and it is the
--       only selected row of its site. Its typed source is therefore the Acquisition sheet: the Contract Sign-off Date (X in the repository Master, U in the
--       owner's file) of the one candidate with Selected = Yes.
--   A5: the catalogue says N/A for a Core, MFN or FN site, but no applicability rule says it (Q241 deferred), so Site Release of such a site waits for an A5
--       that never comes. The Master says the same: its Site Release formula (V) asks for the MW LOS survey and the link budget only when the site type (J)
--       is HUB or Terminal.
--
-- WHAT THIS ADDS.
--   1. A3 from the Acquisition sheet of the historical load. When mi_apply_run loads the register sheets with direct approval (0093, 0122), the rows of its
--      Acquisition batch (import_batch_rows, the typed cells of the owner's sheet as staged, also a row the register refused) close the tasks the Acquisition
--      register is the source of (register_task_sources of acquisition: A3, contract_signoff_date, selected = Yes), as Master T reads them: for each site, the
--      one row that matches the data conditions (exactly one, the "Feeds Master" rule; none or several: left, counted), its source date (a date, not in the
--      future) becomes the actual date and the task is approved directly as the admin override of the historical load (hms_feed_task: the flag
--      historical_direct_approved with the Acquisition batch, one audit row `task_historical_direct_approval`, the reason of the load), its successors unlock
--      and the milestones, gates, SLA and overall status follow through the existing calculation (calc_refresh_site). Never twice, never reopened: an
--      approved, N/A or skipped task, a task with its own submission in review or approval, a rejected or suspended task is left as it is (the rules of
--      0123). A register row the register accepted is still approved and linked by the feed of 0123 (hrt_feed_record): the first of the two that runs
--      approves the task; the other finds it approved. One audit row per Acquisition batch (`import_batch.historical_acquisition_tasks`) with the counts.
--   2. A5 is not applicable when the site type is not HUB or Terminal, for every site. The rule lives in the existing rule table of Settings, Scenario rules
--      (scenario_task_rules, 0052): a new flag expression `hub_terminal` (site_flag: true for the site type HUB or Terminal, false for any other site type,
--      NULL when the site has no site type, so the task keeps its state), and the seeded rule A5 / every scenario / flag hub_terminal. The admin may change or
--      remove it there like any rule (admin_save_scenario_rules accepts the new expression). A scenario rule still wins (Expansion keeps A5 N/A). The site type
--      is not a scope flag (AA:AF): a scenario rule that makes the task N/A is not a scope conflict for it (scope_scenario_conflicts ignores hub_terminal).
--      New sites: site_create_apply runs the applicability of a new site (0074), which now reads the rule. Existing sites: when the site type of a site
--      changes (the RF & Design feed, Change Control, an admin edit ...), a trigger applies the rules of the site type to that site's tasks
--      (hms_apply_type_rules: the step-by-step applicability of wf_apply_applicability_run, only for the tasks with a hub_terminal rule; N/A with
--      na_reason 'applicability: ...' and one audit row `task_applicability_na` per task, or applicable again with `task_applicability_restore`; never an
--      approved task or one in review or approval), then the site is recalculated.
--   3. A one-time catch-up in this migration (hms_catch_up): (a) A3 from every Acquisition batch of a historical Master load approved directly that is not
--      discarded (the data already in the system; on a server where the file was not applied again yet there is none, and the re-apply then takes path 1),
--      as the System Admin who loaded it (the migration session's legacy context); (b) the A5 rule on every site, the milestones and the overall status
--      recalculated by the existing calculation for each site that changed; a site with no site type keeps A5 as it is and is counted. Then one summary
--      audit row `historical_ms1_catch_up` with the counts. Running it again changes nothing (idempotent).
--   4. The guard of the task flag (hda_guard_task) gets a third path for 1: the marker pmis.hms_task of this task and pmis.hms_row of a row of the
--      Acquisition batch named on the task, of the same site, the task a source task of the Acquisition register, the batch a register batch of a historical
--      Master import marked for direct approval and not discarded, and either the batch may still be approved directly by the signed-in System Admin
--      (hda_batch_ok) or the catch-up runs in a migration session (marker pmis.hms_catchup and app_ctx_legacy). The previous state is locked, open or entry.
--
-- Redefined from their latest definitions (bodies unchanged except where marked "0124"): site_flag (0052), scope_scenario_conflicts (0052),
-- admin_save_scenario_rules (0052), hda_guard_task (0123), mi_apply_run 7 arguments (0122). CREATE OR REPLACE keeps their owner, search_path and grants.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC. No new function is granted to
-- pmis_app: the API doors stay mi_apply_run / mi_apply_step and PUT /settings/scenario-rules (admin_save_scenario_rules). No new table right. Contract
-- 0.15.37: the flag expression `hub_terminal` of ScenarioRule.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The flag expression hub_terminal (the site type) in the rule table of Settings, Scenario rules
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE scenario_task_rules DROP CONSTRAINT scenario_task_rules_flag_expr_check;
ALTER TABLE scenario_task_rules ADD CONSTRAINT scenario_task_rules_flag_expr_check
  CHECK (flag_expr IN ('cw', 'tower', 'adaption_only', 'gecol', 'hlc', 'rfi', 'te', 'hub_terminal'));

-- site_flag (latest 0052; changes marked 0124). hub_terminal: the site type (Master J) is HUB or Terminal; NULL when the site has no site type (the rule then
-- says nothing and the task keeps its state).
CREATE OR REPLACE FUNCTION site_flag(p_site uuid, p_expr text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE p_expr
    WHEN 'cw' THEN s.scope_tower_erection = 'yes' OR s.scope_site_adaption = 'yes'
    WHEN 'tower' THEN s.scope_tower_erection = 'yes'
    WHEN 'adaption_only' THEN s.scope_site_adaption = 'yes' AND s.scope_tower_erection <> 'yes'
    WHEN 'gecol' THEN s.scope_gecol_power = 'yes'
    WHEN 'hlc' THEN s.scope_hlc_fiber = 'yes'
    WHEN 'rfi' THEN s.scope_tower_erection = 'yes' OR s.scope_site_adaption = 'yes' OR s.scope_gecol_power = 'yes' OR s.scope_hlc_fiber = 'yes'
    WHEN 'te' THEN s.scope_te_full = 'yes' OR s.scope_te_ip_router_only = 'yes'
    WHEN 'hub_terminal' THEN CASE WHEN nullif(btrim(coalesce(s.site_type, '')), '') IS NULL THEN NULL   -- 0124
                                  ELSE lower(btrim(s.site_type)) IN ('hub', 'terminal') END
  END
  FROM public.sites s WHERE s.id = p_site
$$;

-- scope_scenario_conflicts (latest 0052; changes marked 0124): the site type is not a scope flag (AA:AF); a scenario rule that makes a task N/A wins over a
-- hub_terminal rule (site_task_rule) and is never a scope conflict.
CREATE OR REPLACE FUNCTION scope_scenario_conflicts(p_site uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', n.task_code, 'scenario', n.scenario, 'flag_expr', f.flag_expr,
           'message', 'The scenario ' || n.scenario::text || ' makes ' || n.task_code || ' N/A, but the scope flags (' || f.flag_expr || ') say the work exists. Correct the flags or approve a scope exception.')
           ORDER BY n.task_code COLLATE "C"), '[]'::jsonb)
  FROM public.sites s
  JOIN public.scenario_task_rules n ON n.workflow_id = s.workflow_version_id AND n.is_active AND n.rule = 'na' AND n.scenario = s.delivery_scenario
  JOIN public.scenario_task_rules f ON f.workflow_id = s.workflow_version_id AND f.is_active AND f.rule = 'flag' AND f.task_code = n.task_code AND f.scenario IS NULL
    AND f.flag_expr <> 'hub_terminal'   -- 0124
  WHERE s.id = p_site AND public.site_flag(p_site, f.flag_expr)
    AND NOT EXISTS (SELECT 1 FROM public.site_scope_exceptions e WHERE e.site_id = s.id AND e.task_code = n.task_code AND e.revoked_at IS NULL)
$$;

-- admin_save_scenario_rules (latest 0052; changes marked 0124): the flag expression hub_terminal is accepted.
CREATE OR REPLACE FUNCTION admin_save_scenario_rules(p_rules jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE wf uuid := public.sla_workflow(); r jsonb; idx integer; errs jsonb := '[]'::jsonb; seen text[] := ARRAY[]::text[]; k text; cur integer; before jsonb; nv integer;
BEGIN
  PERFORM public.calc_require_admin('task_definitions', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT version INTO cur FROM public.scenario_rule_state WHERE id FOR UPDATE;
  IF p_version IS NOT NULL AND p_version <> cur THEN PERFORM public.calc_err('precondition_failed'); END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array' THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rules', 'code', 'required', 'message', 'rules is required.'))));
  END IF;
  FOR r, idx IN SELECT value, ordinality - 1 FROM jsonb_array_elements(p_rules) WITH ORDINALITY LOOP
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE workflow_id = wf AND code = r ->> 'task_code') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/task_code', 'code', 'unknown_task_code', 'message', 'Unknown task code.'));
    END IF;
    IF r ->> 'scenario' IS NOT NULL AND NOT (r ->> 'scenario' = ANY (enum_range(NULL::"DeliveryScenario")::text[])) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/scenario', 'code', 'invalid', 'message', 'Unknown scenario.'));
    END IF;
    IF coalesce(r ->> 'rule', '') NOT IN ('applies', 'na', 'sla_not_measured', 'flag') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/rule', 'code', 'invalid', 'message', 'rule is applies, na, sla_not_measured or flag.'));
    ELSIF (r ->> 'rule' = 'flag') <> (r ->> 'flag_expr' IS NOT NULL)
       OR (r ->> 'flag_expr' IS NOT NULL AND r ->> 'flag_expr' NOT IN ('cw', 'tower', 'adaption_only', 'gecol', 'hlc', 'rfi', 'te', 'hub_terminal')) THEN   -- 0124: hub_terminal
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/flag_expr', 'code', 'invalid', 'message', 'A flag rule needs a flag expression (cw, tower, adaption_only, gecol, hlc, rfi, te, hub_terminal); other rules have none.'));
    END IF;
    IF char_length(btrim(coalesce(r ->> 'reason', ''))) < 3 THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/reason', 'code', 'required', 'message', 'Each rule needs a reason of at least 3 characters.'));
    END IF;
    k := coalesce(r ->> 'task_code', '') || '|' || coalesce(r ->> 'scenario', '*') || '|' || (coalesce(r ->> 'rule', '') = 'sla_not_measured')::text;
    IF k = ANY (seen) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx, 'code', 'duplicate', 'message', 'The same task and scenario appear twice.'));
    END IF;
    seen := seen || k;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := (SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', x.task_code, 'scenario', x.scenario, 'rule', x.rule, 'flag_expr', x.flag_expr) ORDER BY x.task_code COLLATE "C", x.scenario NULLS FIRST, x.rule COLLATE "C"), '[]'::jsonb)
             FROM public.scenario_task_rules x WHERE x.workflow_id = wf AND x.is_active);
  nv := cur + 1;
  UPDATE public.scenario_task_rules SET is_active = false, retired_by = public.app_actor(), retired_at = now() WHERE workflow_id = wf AND is_active;
  INSERT INTO public.scenario_task_rules (workflow_id, task_code, scenario, rule, flag_expr, reason, version, created_by)
  SELECT wf, value ->> 'task_code', (value ->> 'scenario')::"DeliveryScenario", value ->> 'rule', value ->> 'flag_expr', btrim(value ->> 'reason'), nv, public.app_actor()
  FROM jsonb_array_elements(p_rules);
  UPDATE public.scenario_rule_state SET version = nv WHERE id;
  PERFORM public.calc_audit('scenario_rules_update', 'scenario_rules', 'v' || nv::text, jsonb_build_object('rules', before),
    jsonb_build_object('version', nv, 'rules', (SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', value ->> 'task_code', 'scenario', value ->> 'scenario', 'rule', value ->> 'rule', 'flag_expr', value ->> 'flag_expr')), '[]'::jsonb) FROM jsonb_array_elements(p_rules))),
    p_reason);
  RETURN nv;
END $$;


-- The rule of the catalogue (A5 "N/A for Core / MFN / FN", Q241): A5 follows the site type, for every scenario, in every workflow version that has A5 (an active
-- rule for every scenario that the admin already set for A5 is kept). The list of Settings, Scenario rules gets a new version, so a screen holding the old
-- ETag cannot overwrite it without reading it.
DO $$
DECLARE n int; nv int;
BEGIN
  SELECT version + 1 INTO nv FROM scenario_rule_state WHERE id;
  INSERT INTO scenario_task_rules (workflow_id, task_code, scenario, rule, flag_expr, reason, version, created_by)
  SELECT DISTINCT td.workflow_id, 'A5', NULL::"DeliveryScenario", 'flag', 'hub_terminal',
         'A5 (MW LOS survey and link budget) applies to HUB and Terminal sites only; N/A for Core, MFN and FN (task catalogue, Master V; migration 0124)', nv, NULL::uuid
  FROM task_definitions td
  WHERE td.code = 'A5'
    AND NOT EXISTS (SELECT 1 FROM scenario_task_rules r WHERE r.workflow_id = td.workflow_id AND r.task_code = 'A5' AND r.is_active AND r.scenario IS NULL
                      AND r.rule <> 'sla_not_measured')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN UPDATE scenario_rule_state SET version = nv WHERE id; END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The rules of the site type applied to the tasks of one site (internal), and the trigger when the site type changes
-- ---------------------------------------------------------------------------------------------------------------------
-- The step-by-step applicability of wf_apply_applicability_run (0074), only for the tasks of the site that have an active hub_terminal rule in the site's
-- workflow: a task the rules make N/A becomes N/A (never an approved task, one in review or approval, or a rejected or suspended one: listed in kept), a task
-- made N/A by the applicability that applies again comes back. A task whose rule says nothing (no site type) keeps its state and is listed in unknown. The
-- site is recalculated at the end when something changed (unless the caller's calculation is running). Returns {site_id, changed, kept, unknown}.
CREATE OR REPLACE FUNCTION hms_apply_type_rules(p_site uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.sites%ROWTYPE; t record; x record; cur_state text; cur_reason text; before jsonb; hold record; opened boolean;
  changed jsonb := '[]'::jsonb; kept jsonb := '[]'::jsonb; unknown jsonb := '[]'::jsonb; was_busy text := coalesce(current_setting('pmis.calc_busy', true), '');
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM set_config('pmis.calc_busy', '1', true);
  FOR t IN
    SELECT ti.id, td.code, td.id AS def_id FROM public.task_instances ti
    JOIN public.task_definitions td ON td.id = ti.task_def_id AND td.workflow_id = s.workflow_version_id
    JOIN public.stage_definitions sd ON sd.id = td.stage_id
    WHERE ti.site_id = p_site
      AND EXISTS (SELECT 1 FROM public.scenario_task_rules r WHERE r.workflow_id = s.workflow_version_id AND r.task_code = td.code AND r.is_active
                    AND r.rule = 'flag' AND r.flag_expr = 'hub_terminal')
    ORDER BY sd.seq, td.sort_order, td.code COLLATE "C"
  LOOP
    SELECT ti.state::text, ti.na_reason INTO cur_state, cur_reason FROM public.task_instances ti WHERE ti.id = t.id;
    SELECT * INTO x FROM public.site_task_rule(p_site, t.code);
    IF x.applies IS NULL THEN
      unknown := unknown || jsonb_build_array(jsonb_build_object('task_code', t.code, 'state', cur_state, 'reason', 'site_type_unknown'));
    ELSIF x.applies IS FALSE AND cur_state NOT IN ('na', 'skipped') THEN
      IF cur_state IN ('locked', 'open', 'entry') THEN
        before := public.wf_snap(t.id);
        UPDATE public.task_instances SET state = 'na', is_na = true, na_reason = left('applicability: ' || coalesce(x.rule_reason, x.source), 500),
          ball_in_court_user_id = NULL, lock_reason = NULL, version = version + 1, updated_at = now()
        WHERE id = t.id;
        INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
        VALUES ('task_applicability_na', 'task', t.id::text, s.id, s.region_id, before,
                public.wf_snap(t.id) || jsonb_build_object('source', x.source, 'rule', x.rule_reason, 'site_type', s.site_type), p_reason, public.app_actor());
        PERFORM public.wf_unlock_successors(t.id);
        changed := changed || jsonb_build_array(jsonb_build_object('task_code', t.code, 'from', cur_state, 'to', 'na', 'source', x.source));
      ELSE
        kept := kept || jsonb_build_array(jsonb_build_object('task_code', t.code, 'state', cur_state, 'reason', 'in_progress_or_approved'));
      END IF;
    ELSIF x.applies IS TRUE AND cur_state = 'na' AND starts_with(coalesce(cur_reason, ''), 'applicability:') THEN
      before := public.wf_snap(t.id);
      UPDATE public.task_instances SET state = 'locked', is_na = false, na_reason = NULL, current_level = 0, version = version + 1, updated_at = now() WHERE id = t.id;
      opened := false;
      IF NOT EXISTS (SELECT 1 FROM public.task_predecessors p2 JOIN public.task_instances pi ON pi.site_id = p_site AND pi.task_def_id = p2.predecessor_id
                     WHERE p2.task_def_id = t.def_id AND pi.state NOT IN ('approved', 'na', 'skipped')) THEN
        SELECT * INTO hold FROM public.wf_gate_hold(t.id);
        IF hold.gate_code IS NOT NULL THEN
          UPDATE public.task_instances SET lock_reason = 'gate_closed:' || hold.gate_code WHERE id = t.id;
        ELSE
          opened := public.wf_open_locked(t.id, 'applies again: ' || coalesce(x.source, ''));
        END IF;
      END IF;
      INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
      VALUES ('task_applicability_restore', 'task', t.id::text, s.id, s.region_id, before,
              public.wf_snap(t.id) || jsonb_build_object('source', x.source, 'exception_id', x.exception_id, 'site_type', s.site_type), p_reason, public.app_actor());
      changed := changed || jsonb_build_array(jsonb_build_object('task_code', t.code, 'from', 'na', 'to', CASE WHEN opened THEN 'open' ELSE 'locked' END, 'source', x.source));
    END IF;
  END LOOP;
  PERFORM set_config('pmis.calc_busy', was_busy, true);
  IF was_busy <> '1' AND jsonb_array_length(changed) > 0 THEN PERFORM public.calc_refresh_site(p_site); END IF;
  RETURN jsonb_build_object('site_id', p_site, 'changed', changed, 'kept', kept, 'unknown', unknown);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('pmis.calc_busy', was_busy, true);
  RAISE;
END $$;

-- AFTER UPDATE OF site_type on sites: the rules of the site type follow the new type (every writer of the site type: the RF & Design feed, Change Control,
-- the admin edit ...). A new site takes them from its first applicability (site_create_apply).
CREATE OR REPLACE FUNCTION hms_site_type_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF lower(btrim(coalesce(OLD.site_type, ''))) IS DISTINCT FROM lower(btrim(coalesce(NEW.site_type, ''))) THEN
    PERFORM public.hms_apply_type_rules(NEW.id, left('the site type changed (' || coalesce(nullif(btrim(OLD.site_type), ''), 'none') || ' -> '
      || coalesce(nullif(btrim(NEW.site_type), ''), 'none') || '): the tasks that follow the site type (A5: HUB and Terminal only) follow it', 1000));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_hms_site_type AFTER UPDATE OF site_type ON sites FOR EACH ROW
  WHEN (OLD.site_type IS DISTINCT FROM NEW.site_type) EXECUTE FUNCTION hms_site_type_changed();

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. A3 (and every other task the Acquisition register is the source of) from the Acquisition sheet of the historical load (internal)
-- ---------------------------------------------------------------------------------------------------------------------
-- Approves the task p_task with the date p_date read from the row p_row of the Acquisition batch p_batch (source p_code / p_field), as the admin override of
-- the historical load. The rules of hrt_feed_task (0123): never twice, never reopened. Returns {task_id, task_code, outcome, unlocked_task_ids}. Called only
-- by hms_feed_acquisition (inside its own block, so a refusal is reported there).
CREATE OR REPLACE FUNCTION hms_feed_task(p_task uuid, p_batch uuid, p_row uuid, p_date date, p_code text, p_field text, p_catchup boolean, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; rw public.import_batch_rows%ROWTYPE; n int; lvl int; before jsonb; unlocked uuid[] := ARRAY[]::uuid[];
  note text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO rw FROM public.import_batch_rows WHERE id = p_row AND batch_id = p_batch;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR rw.id IS NULL OR t.site_id IS DISTINCT FROM rw.site_id THEN
    RETURN jsonb_build_object('task_id', p_task, 'task_code', p_code, 'outcome', 'no_task');
  END IF;
  IF t.state = 'approved' THEN RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'already_approved'); END IF;
  IF t.state IN ('na', 'skipped') OR t.is_na THEN RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'not_applicable'); END IF;
  IF t.state IN ('in_review', 'in_approval')
     OR EXISTS (SELECT 1 FROM public.register_records o WHERE o.task_id = t.id AND o.state IN ('in_review', 'in_approval')) THEN
    RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'open_submission');   -- keeps its normal L2 path
  END IF;
  IF t.state NOT IN ('locked', 'open', 'entry') THEN
    RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'kept_' || t.state::text);
  END IF;
  IF p_date IS NULL THEN RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'no_date'); END IF;
  IF p_date > public.cal_today() THEN RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'future_date'); END IF;
  before := public.wf_snap(p_task);
  n := coalesce(t.levels_required, public.wf_task_levels(p_task));
  note := 'historical load: approved directly with the Acquisition sheet (Master T, the selected candidate''s ' || p_field || ', row ' || coalesce(rw.source_ref, rw.row_no::text)
          || ') (admin override)' || CASE WHEN p_catchup THEN ', migration 0124' ELSE '' END;
  PERFORM set_config('pmis.hms_task', p_task::text, true);
  PERFORM set_config('pmis.hms_row', p_row::text, true);
  IF p_catchup THEN PERFORM set_config('pmis.hms_catchup', p_task::text, true); END IF;
  UPDATE public.task_instances SET state = 'approved', actual_date = p_date, current_level = greatest(n, t.current_level),
    path_frozen_at = coalesce(path_frozen_at, now()), submitted_date = coalesce(submitted_date, current_date), approved_date = current_date,
    ball_in_court_user_id = NULL, ball_in_court_group_id = NULL, ball_in_court_role_id = NULL, level_opened_at = NULL, lock_reason = NULL, self_approval = false,
    historical_direct_approved = true, historical_direct_batch_id = p_batch, historical_direct_approved_at = now(), version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM set_config('pmis.hms_task', '', true);
  PERFORM set_config('pmis.hms_row', '', true);
  PERFORM set_config('pmis.hms_catchup', '', true);
  UPDATE public.document_slots SET status = 'approved', reject_reason = NULL WHERE task_id = p_task AND status IN ('uploaded', 'in_review');
  UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
    WHERE s.task_id = p_task AND f.slot_id = s.id AND f.is_current AND f.approved_date IS NULL;
  INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, created_at)
  VALUES (p_task, greatest(n, 1), 'approve', actor, note, t.state, 'approved', NOT coalesce(p_catchup, false), false, clock_timestamp());
  FOR lvl IN greatest(t.current_level, 1) .. greatest(n, 1) LOOP
    INSERT INTO public.task_level_actors (task_id, level, user_id, how) VALUES (p_task, lvl, actor, 'acted')
      ON CONFLICT (task_id, level) DO UPDATE SET user_id = EXCLUDED.user_id, how = 'acted', acted_at = now();
  END LOOP;
  unlocked := public.wf_unlock_successors(p_task);
  PERFORM public.log_audit_write('task_historical_direct_approval', 'task', p_task::text,
    before || jsonb_build_object('historical_direct_approved', false),
    public.wf_snap(p_task) || jsonb_build_object('historical_direct_approved', true, 'batch_id', p_batch, 'batch_row_id', p_row, 'source_ref', rw.source_ref,
      'register_key', 'acquisition', 'task_code', p_code, 'source_field', p_field, 'master_column', 'T',
      'levels_approved', greatest(n, 1) - greatest(t.current_level, 1) + 1, 'unlocked_task_ids', to_jsonb(unlocked), 'catch_up', coalesce(p_catchup, false),
      'rule', 'a task fed by the Acquisition sheet of the historical load (Master T: the one selected candidate''s Contract Sign-off Date), approved at once as an admin override (no L2)'),
    p_reason, t.site_id, t.region_id, NULL, true);
  RETURN jsonb_build_object('task_id', t.id, 'task_code', p_code, 'outcome', 'approved', 'unlocked_task_ids', to_jsonb(unlocked));
END $$;

-- The tasks the rows of the Acquisition batch p_batch close (Master T). The batch must be a register batch of the Acquisition sheet of a historical Master
-- import marked for direct approval and not discarded. Live (p_catchup false): it may still be approved directly by the signed-in System Admin
-- (hda_batch_ok). Catch-up (p_catchup true): only in a migration session (app_ctx_legacy). For each active source of the Acquisition register (A3:
-- contract_signoff_date where selected = Yes) and each site of the batch, the rows that match the data conditions (case and spaces ignored) must be exactly
-- one (Master AC "Feeds Master"); its source date, read as staged, closes the task. One audit row with the counts. Returns {batch_id, sites, outcomes, approved}.
CREATE OR REPLACE FUNCTION hms_feed_acquisition(p_batch uuid, p_catchup boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  b public.import_batches%ROWTYPE; src record; c record; tid uuid; d date; res jsonb; j jsonb; outcomes jsonb := '{}'::jsonb; approved jsonb := '{}'::jsonb;
  nsites int := 0; oc text;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND OR b.register_key IS DISTINCT FROM 'acquisition' OR NOT b.historical_direct_approve OR NOT b.historical_load OR b.source <> 'master_import'
     OR b.status = 'discarded' OR NOT (CASE WHEN coalesce(p_catchup, false) THEN public.app_ctx_legacy() ELSE public.hda_batch_ok(b) END) THEN
    RAISE EXCEPTION 'historical Site Release: the batch is not the Acquisition sheet of a historical Master import approved directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(DISTINCT x.site_id) INTO nsites FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.site_id IS NOT NULL;
  FOR src IN SELECT x.task_code, x.date_field, x.data_eq FROM public.register_task_sources x
             WHERE x.register_key = 'acquisition' AND x.is_active AND x.task_code NOT LIKE 'MOB-%' ORDER BY x.sort_order, x.task_code LOOP
    FOR c IN
      SELECT y.site_id, count(*) AS n, (array_agg(y.id ORDER BY y.row_no, y.id))[1] AS row_id,
             (array_agg(y.payload -> 'data' ->> src.date_field ORDER BY y.row_no, y.id))[1] AS dv
      FROM public.import_batch_rows y
      WHERE y.batch_id = p_batch AND y.site_id IS NOT NULL AND jsonb_typeof(y.payload -> 'data') = 'object'
        AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(coalesce(src.data_eq, '{}'::jsonb)) k
                        WHERE lower(btrim(coalesce(y.payload -> 'data' ->> k.key, ''))) IS DISTINCT FROM lower(btrim(k.value)))
      GROUP BY y.site_id ORDER BY y.site_id
    LOOP
      tid := NULL;
      SELECT ti.id INTO tid FROM public.task_instances ti
        JOIN public.task_definitions td ON td.id = ti.task_def_id
        JOIN public.sites st ON st.id = ti.site_id AND st.workflow_version_id = td.workflow_id
        WHERE ti.site_id = c.site_id AND td.code = src.task_code LIMIT 1;
      IF tid IS NULL THEN
        res := jsonb_build_object('task_code', src.task_code, 'outcome', 'no_task');
      ELSIF c.n > 1 THEN
        res := jsonb_build_object('task_id', tid, 'task_code', src.task_code, 'outcome', 'several_rows');   -- Master AC: more than one selected candidate
      ELSE
        d := CASE WHEN c.dv ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN c.dv::date END;
        BEGIN
          res := public.hms_feed_task(tid, p_batch, c.row_id, d, src.task_code, src.date_field, p_catchup, p_reason);
        EXCEPTION WHEN others THEN
          j := public.imp_wf_json(SQLERRM);
          PERFORM set_config('pmis.hms_task', '', true);
          PERFORM set_config('pmis.hms_row', '', true);
          PERFORM set_config('pmis.hms_catchup', '', true);
          PERFORM public.log_system_write('warn', 'master-import', 'historical load: a task fed by the Acquisition sheet was not approved',
            jsonb_build_object('task_id', tid, 'task_code', src.task_code, 'batch_id', p_batch, 'batch_row_id', c.row_id, 'sqlstate', SQLSTATE,
              'code', j ->> 'code', 'error', left(SQLERRM, 300)), public.app_actor(), NULL);
          res := jsonb_build_object('task_id', tid, 'task_code', src.task_code, 'outcome', 'refused', 'code', coalesce(j ->> 'code', SQLSTATE));
        END;
      END IF;
      oc := res ->> 'outcome';
      outcomes := jsonb_set(outcomes, ARRAY[oc], to_jsonb(coalesce((outcomes ->> oc)::int, 0) + 1));
      IF oc = 'approved' THEN approved := jsonb_set(approved, ARRAY[src.task_code], to_jsonb(coalesce((approved ->> src.task_code)::int, 0) + 1)); END IF;
    END LOOP;
  END LOOP;
  PERFORM public.log_audit_write('import_batch.historical_acquisition_tasks', 'import_batch', p_batch::text, NULL,
    jsonb_build_object('batch_id', p_batch, 'sites', nsites, 'outcomes', outcomes, 'approved_by_task', approved, 'catch_up', coalesce(p_catchup, false),
      'rule', 'the tasks the Acquisition register is the source of (A3) close with the Acquisition sheet of the historical load, as Master T reads it: the one selected candidate''s Contract Sign-off Date'),
    p_reason, NULL, NULL, NULL, true);
  RETURN jsonb_build_object('batch_id', p_batch, 'sites', nsites, 'outcomes', outcomes, 'approved', approved);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The guard of the task flag (hda_guard_task: latest 0123, changes marked 0124)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hda_guard_task() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.app_is_seeding() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'historical direct approval: the flag of a task is written only by GSDN Workspace (migration 0092)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.historical_direct_approved AND NEW.state IS DISTINCT FROM 'approved' THEN
    -- a reopening: the flag goes, the batch reference stays for the history; the next approval is a normal one
    IF (NEW.historical_direct_batch_id, NEW.historical_direct_approved_at) IS DISTINCT FROM (OLD.historical_direct_batch_id, OLD.historical_direct_approved_at) THEN
      RAISE EXCEPTION 'historical direct approval: the batch of a flagged task never changes (migration 0092)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.historical_direct_approved := false;
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('task_historical_direct_approval_cleared', 'task', NEW.id::text, NEW.site_id, NEW.region_id,
      jsonb_build_object('historical_direct_approved', true, 'state', OLD.state::text, 'batch_id', OLD.historical_direct_batch_id),
      jsonb_build_object('historical_direct_approved', false, 'state', NEW.state::text, 'batch_id', OLD.historical_direct_batch_id),
      'The task left the approved state (' || NEW.state::text || '): its next approval follows the two levels.', public.app_actor());
    RETURN NEW;
  END IF;
  IF public.app_is_seeding() THEN RETURN NEW; END IF;   -- the migration role (after the clearing above, which applies to every writer)
  IF (NEW.historical_direct_approved, NEW.historical_direct_batch_id, NEW.historical_direct_approved_at)
     IS NOT DISTINCT FROM (OLD.historical_direct_approved, OLD.historical_direct_batch_id, OLD.historical_direct_approved_at) THEN
    RETURN NEW;
  END IF;
  IF current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hda_task', true), '') = NEW.id::text
     AND NEW.historical_direct_approved AND NOT OLD.historical_direct_approved AND NEW.state = 'approved' AND OLD.state IN ('in_review', 'in_approval')
     AND EXISTS (SELECT 1 FROM public.import_batches b JOIN public.import_batch_rows r ON r.batch_id = b.id AND r.task_instance_id = NEW.id
                 WHERE b.id = NEW.historical_direct_batch_id AND b.historical_direct_approve AND public.hda_batch_ok(b)) THEN
    RETURN NEW;   -- 0092: a task row of a stream batch approved directly (hda_approve_task)
  END IF;
  -- 0123: a task fed by a register record approved directly by a register sheet of the historical load (hrt_feed_task)
  IF current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hrt_task', true), '') = NEW.id::text
     AND NEW.historical_direct_approved AND NOT OLD.historical_direct_approved AND NEW.state = 'approved' AND OLD.state IN ('locked', 'open', 'entry')
     AND EXISTS (SELECT 1 FROM public.register_records rr JOIN public.import_batches b ON b.id = rr.historical_direct_batch_id
                 WHERE rr.id::text = coalesce(current_setting('pmis.hrt_record', true), '') AND rr.historical_direct_approved AND rr.state = 'approved'
                   AND rr.site_id = NEW.site_id AND b.id = NEW.historical_direct_batch_id AND b.historical_direct_approve AND b.historical_load
                   AND b.source = 'master_import' AND b.register_key = rr.register_key
                   AND (public.hda_batch_ok(b)
                        OR (coalesce(current_setting('pmis.hrt_catchup', true), '') = NEW.id::text AND public.app_ctx_legacy()))) THEN
    RETURN NEW;
  END IF;
  -- 0124: a task the Acquisition register is the source of (A3), fed by a row of the Acquisition sheet of the historical load (hms_feed_task, Master T)
  IF current_user::text = 'pmis_definer' AND coalesce(current_setting('pmis.hms_task', true), '') = NEW.id::text
     AND NEW.historical_direct_approved AND NOT OLD.historical_direct_approved AND NEW.state = 'approved' AND OLD.state IN ('locked', 'open', 'entry')
     AND EXISTS (SELECT 1 FROM public.task_definitions td JOIN public.register_task_sources x ON x.task_code = td.code AND x.register_key = 'acquisition' AND x.is_active
                 WHERE td.id = NEW.task_def_id)
     AND EXISTS (SELECT 1 FROM public.import_batch_rows rw JOIN public.import_batches b ON b.id = rw.batch_id
                 WHERE rw.id::text = coalesce(current_setting('pmis.hms_row', true), '') AND rw.site_id = NEW.site_id
                   AND b.id = NEW.historical_direct_batch_id AND b.register_key = 'acquisition' AND b.historical_direct_approve AND b.historical_load
                   AND b.source = 'master_import' AND b.status <> 'discarded'
                   AND (public.hda_batch_ok(b)
                        OR (coalesce(current_setting('pmis.hms_catchup', true), '') = NEW.id::text AND public.app_ctx_legacy()))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'historical direct approval: the flag of a task is written only by GSDN Workspace (migration 0092)' USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The apply (mi_apply_run: latest 0122, changes marked 0124)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mi_apply_run(p_run uuid, p_version integer, p_mode text, p_reason text, p_stepup boolean, p_historical jsonb, p_registers jsonb)
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
  bg uuid := CASE WHEN coalesce(current_setting('pmis.mi_apply_job', true), '') ~ '^[0-9a-f-]{36}$' THEN current_setting('pmis.mi_apply_job', true)::uuid END;   -- 0086: the background run of this apply
  lim int; nsites int; jid uuid;   -- 0086
  hda boolean := false;   -- 0092: the historical load is approved directly (admin override, no L2)
  hrg boolean := false; regs jsonb; rres jsonb; rnotes jsonb := '[]'::jsonb;   -- 0093: the register sheets of the same file
  rap boolean := false; disc jsonb := '[]'::jsonb;   -- 0122: re-apply a file already applied, with direct approval; the batches discarded first
  dacells jsonb := '{}'::jsonb; dacodes text[];      -- 0122: the Design & Acquisition task dates read from the RF & Design sheet of the same file
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  SELECT * INTO r FROM public.master_reconciliation_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The import run does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> r.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The run changed since you read it. Reload and try again.')); END IF;
  IF r.status = 'applying' AND bg IS NULL THEN   -- 0086
    PERFORM public.wf_err('upload_processing', jsonb_build_object('detail', 'This file is being applied in the background. Wait until it ends.', 'run_id', p_run));
  END IF;
  IF NOT (r.status = 'previewed' OR (r.status = 'applying' AND bg IS NOT NULL AND EXISTS (SELECT 1 FROM public.mi_apply_jobs j WHERE j.id = bg AND j.run_id = p_run AND j.state = 'running'))) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This run was already applied.'));
  END IF;
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
    hda := coalesce(p_historical -> 'approve_directly' = 'true'::jsonb, false);   -- 0092
    hrg := coalesce(p_historical -> 'registers' = 'true'::jsonb, false);          -- 0093
    rap := coalesce(p_historical -> 'reapply' = 'true'::jsonb, false);            -- 0122
    IF rap AND NOT hda THEN   -- 0122: a file already applied is applied again only with the direct approval (the owner decision of 2026-11-17)
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load/approve_directly',
        'code', 'required', 'message', 'Re-applying a file that was already applied is done with the direct approval of the historical load.'))));
    END IF;
  END IF;
  -- 0093: the register sheets are read by the API from the file stored with this run (never sent by the caller of the endpoint); they come only with the
  -- historical option, and they must be of this file (its SHA-256)
  IF (p_registers IS NOT NULL OR hrg) AND p_historical IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/historical_load/registers', 'code', 'invalid',
      'message', 'The register sheets are loaded with the historical load only.'))));
  END IF;
  IF hrg AND (p_registers IS NULL OR jsonb_typeof(p_registers) <> 'object' OR p_registers ->> 'file_sha256' IS DISTINCT FROM r.file_sha256
              OR jsonb_typeof(coalesce(p_registers -> 'parts', '[]'::jsonb)) <> 'array') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The register sheets were not read from the file of this run. Apply the file again.'));
  END IF;
  regs := CASE WHEN hrg THEN p_registers END;
  IF public.app_ctx_stepup() AND bg IS NULL THEN   -- 0075 (0086: in the background, the expiry recorded at the request)
    SELECT us.stepup_at + make_interval(secs => coalesce((SELECT CASE WHEN jsonb_typeof(st.value) = 'number' THEN (st.value #>> '{}')::int END
                                                          FROM public.settings st WHERE st.key = 'stepup_max_age_seconds'), 300))
      INTO su_until FROM public.user_sessions us WHERE us.id = public.log_ctx_uuid('session_id') AND us.user_id = actor AND us.revoked_at IS NULL AND us.stepup_at IS NOT NULL;
  ELSIF bg IS NOT NULL THEN
    SELECT j.stepup_until INTO su_until FROM public.mi_apply_jobs j WHERE j.id = bg;
  END IF;
  SELECT x.id INTO prev FROM public.master_reconciliation_runs x WHERE x.file_sha256 = r.file_sha256 AND x.status = 'applied' AND x.id <> r.id LIMIT 1;
  IF prev IS NOT NULL AND NOT rap THEN   -- 0122: lifted only for a re-apply with direct approval (the historical-load checks above passed)
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This file was already applied (run ' || prev::text || '). A reconciliation run compares again; it never applies the same file twice.',
      'already_applied', true, 'applied_run_id', prev));   -- 0122: the screen offers the re-apply to a System Admin
  END IF;
  -- 0086: a file with more sites than imports.async_rows is applied in the background, every check above passed: the request records the run and answers 202
  -- (status applying); mi_apply_step does the very same apply in a transaction of its own under the same person's signed context (no 30 s request limit)
  IF bg IS NULL THEN
    BEGIN lim := greatest(1, (public.log_setting('imports.async_rows', '50'::jsonb) #>> '{}')::int); EXCEPTION WHEN others THEN lim := 50; END;
    SELECT count(DISTINCT upper(x.site_code)) INTO nsites FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL;
    IF nsites > lim THEN
      INSERT INTO public.mi_apply_jobs (run_id, actor_id, mode, reason, hw_reason, stepup_verified, stepup_until, session_id, auth_method, mfa, request_id, sites_total,
                                        approve_directly, load_registers, registers, reapply)   -- 0092, 0093, 0122
      VALUES (p_run, actor, p_mode, left(btrim(p_reason), 2000), hw ->> 'reason', true, su_until,
              CASE WHEN public.app_ctx_get('session_id') ~ '^[0-9a-fA-F-]{36}$' THEN public.app_ctx_get('session_id')::uuid END,
              public.app_ctx_get('auth_method'), CASE public.app_ctx_get('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END, left(public.app_ctx_get('request_id'), 64), nsites,
              hda, hrg, regs, rap)
      RETURNING id INTO jid;
      UPDATE public.master_reconciliation_runs SET status = 'applying', version = version + 1 WHERE id = p_run;
      PERFORM public.log_audit_write('master_import.apply_queued', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
        jsonb_build_object('status', 'applying', 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
          'approve_directly', hda, 'registers', hrg, 'reapply', rap), btrim(p_reason));   -- 0092, 0093, 0122
      PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: apply queued', jsonb_build_object('run_id', p_run, 'job_id', jid, 'mode', p_mode, 'sites', nsites), actor, NULL);
      RETURN jsonb_build_object('queued_apply', true, 'job_id', jid, 'mode', p_mode, 'sites', nsites, 'batches', '[]'::jsonb, 'queued', 0, 'approve_directly', hda, 'registers', hrg, 'reapply', rap);
    END IF;
  END IF;
  IF hw IS NOT NULL THEN
    -- 0085: the historical load accepts the data as it is: every site of the file loses its workflow locks first (audited per site, the reason of the load)
    PERFORM public.swl_open_for_load((SELECT array_agg(DISTINCT x.site_id) FROM public.master_reconciliation_rows x WHERE x.run_id = p_run AND x.site_id IS NOT NULL),
      hw ->> 'reason', 'historical_master_import');
  END IF;
  IF rap THEN
    -- 0122: before anything is staged, the open batches of the earlier historical Master loads (and of this file) are discarded (audited per batch): their
    -- rows are never applied, so nothing is entered or approved twice. In the background this runs in the transaction of the apply itself.
    disc := public.hrp_discard_open(r, hw ->> 'reason');
  END IF;

  SELECT v.* INTO tv FROM public.template_versions v JOIN public.template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MASTER' AND v.is_current;
  SELECT x INTO mpart FROM jsonb_array_elements(tv.columns) x WHERE x ->> 'kind' = 'master' LIMIT 1;
  mcols := mpart -> 'columns';
  IF hrg THEN
    -- 0122: the Master sheet has no typed column for the Design & Acquisition tasks: its Site Release (V) is a formula over the RF & Design sheet (TSSR
    -- Approved, LLD Approved Date, and for a HUB or Terminal site the MW LOS Survey Date and the Link Budget Date) and the Acquisition sheet. With the register
    -- sheets of the same file, the dates of A2 (TSSR approval), A4 (LLD approval) and A5 (MW LOS and link budget, HUB / Terminal only, the later of the two)
    -- are entered on the site's row like a typed column, so they are staged in the Design & Acquisition batch. Only the non-derived task columns of an active
    -- stream template are used (A3 comes from the Acquisition register and is derived; A1 has no source in the file).
    SELECT coalesce(array_agg(DISTINCT tc ->> 'code'), ARRAY[]::text[]) INTO dacodes
    FROM public.template_definitions td_ JOIN public.template_versions tv_ ON tv_.template_def_id = td_.id AND tv_.is_current, jsonb_array_elements(tv_.columns) tc
    WHERE td_.kind = 'stream' AND td_.is_active AND tc ->> 'kind' = 'task' AND NOT coalesce((tc ->> 'derived')::boolean, false)
      AND tc ->> 'code' IN ('A2:actual_date', 'A4:actual_date', 'A5:actual_date');
    SELECT coalesce(jsonb_object_agg(x.k, x.cl), '{}'::jsonb) INTO dacells FROM (
      SELECT DISTINCT ON (y.k) y.k, y.cl FROM (
        SELECT upper(btrim(e ->> 'site_code')) AS k, (e ->> 'row_no') AS rn,
          (SELECT coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb) FROM jsonb_each(jsonb_strip_nulls(jsonb_build_object(
             'A2:actual_date', CASE WHEN (e -> 'data' ->> 'tssr_approved') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN e -> 'data' ->> 'tssr_approved' END,
             'A4:actual_date', CASE WHEN (e -> 'data' ->> 'lld_approved_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN e -> 'data' ->> 'lld_approved_date' END,
             'A5:actual_date', CASE WHEN lower(coalesce(s.site_type, '')) IN ('hub', 'terminal')
                                     AND (e -> 'data' ->> 'mw_los_survey_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND (e -> 'data' ->> 'link_budget_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                                    THEN greatest(e -> 'data' ->> 'mw_los_survey_date', e -> 'data' ->> 'link_budget_date') END))) kv
           WHERE kv.key = ANY (dacodes)) AS cl
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(regs -> 'parts') = 'array' THEN regs -> 'parts' ELSE '[]'::jsonb END) p,
             jsonb_array_elements(CASE WHEN jsonb_typeof(p -> 'rows') = 'array' THEN p -> 'rows' ELSE '[]'::jsonb END) e
        LEFT JOIN public.sites s ON upper(s.site_code) = upper(btrim(e ->> 'site_code'))
        WHERE p ->> 'register' = 'rf_design' AND jsonb_typeof(e -> 'data') = 'object' AND nullif(btrim(e ->> 'site_code'), '') IS NOT NULL) y
      WHERE y.cl <> '{}'::jsonb ORDER BY y.k, y.rn) x;
  END IF;
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
    IF dacells ? upper(row_.site_code) THEN cells := (dacells -> upper(row_.site_code)) || cells; END IF;   -- 0122
    CONTINUE WHEN cells = '{}'::jsonb AND pres = '[]'::jsonb;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('row_no', row_.row_no, 'site_code', row_.site_code, 'cells', cells, 'pre_errors', pres));
  END LOOP;
  IF jsonb_array_length(v_rows) = 0 AND NOT (hrg AND jsonb_array_length(coalesce(regs -> 'parts', '[]'::jsonb)) > 0) THEN   -- 0093: a file of register sheets only
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'No typed task column of this file belongs to a site of GSDN Workspace: nothing can be entered.'));
  END IF;
  IF jsonb_array_length(v_rows) > 0 THEN
    res := public.imp_stage_master_core('TPL-MASTER', tv.version, r.file_name, r.file_sha256,
      jsonb_build_array(jsonb_build_object('sheet', mpart ->> 'sheet', 'header_checksum', mpart ->> 'header_checksum', 'rows', v_rows)), p_mode, 'master_import', gid, hw);
  ELSE
    res := jsonb_build_object('group_id', gid, 'batches', '[]'::jsonb, 'skipped', '[]'::jsonb);
  END IF;
  IF hrg THEN
    -- 0093: each register sheet becomes a register batch of the same group (source master_import, the historical mark), after the stream batches, so it is
    -- sent after them; a sheet that cannot be staged is skipped with its reason, never the whole apply
    rres := public.hrg_stage_registers(regs, r, p_mode, gid, hw ->> 'reason');
    res := res || jsonb_build_object('batches', (res -> 'batches') || (rres -> 'batches'), 'skipped', coalesce(res -> 'skipped', '[]'::jsonb) || (rres -> 'skipped'));
    rnotes := rres -> 'notes';
  END IF;
  IF hda THEN
    -- 0092: the batches just staged are marked for direct approval (a System Admin, the step-up, the open waiver, checked again on each batch); every
    -- submitted row of them is then approved at once by the sender, here or in the chunked background send (the mark is read from the batch row there)
    PERFORM public.hda_mark_batches(ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(res -> 'batches') x), hw ->> 'reason');
  END IF;
  FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x LOOP
    -- 0075: a batch with more rows than imports.async_rows is sent in the background (the checks of the request run in imp_async_start, the rows in chunks)
    q := public.imp_async_start((b ->> 'id')::uuid, NULL, 'submit', NULL, NULL, NULL, NULL, su_until);
    IF coalesce((q ->> 'queued')::boolean, false) THEN
      queued := queued + 1;
      batches := batches || jsonb_build_array(b || jsonb_build_object('queued', true, 'job_id', q -> 'job' -> 'job_id', 'rows', q -> 'job' -> 'rows_total',
        'submitted', 0, 'saved', 0, 'held', 0, 'failed', 0, 'approved', 0,
        'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
        'skipped', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'unchanged')));   -- 0093
      CONTINUE;
    END IF;
    sent := public.imp_submit_batch((b ->> 'id')::uuid, NULL, p_stepup);
    batches := batches || jsonb_build_array(b || jsonb_build_object('submitted', sent -> 'submitted', 'saved', sent -> 'saved', 'held', jsonb_array_length(coalesce(sent -> 'held', '[]'::jsonb)),
      'failed', jsonb_array_length(coalesce(sent -> 'failed', '[]'::jsonb)),
      'errors', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'error'),
      'approved', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action IN ('create', 'update') AND x.decision = 'approved'),   -- 0092, 0093
      'rows', (SELECT x.rows_total FROM public.import_batches x WHERE x.id = (b ->> 'id')::uuid),   -- 0093: the rows of the batch, and the rows that changed nothing
      'skipped', (SELECT count(*) FROM public.import_batch_rows x WHERE x.batch_id = (b ->> 'id')::uuid AND x.action = 'unchanged')));
  END LOOP;
  IF hda AND hrg THEN
    -- 0124: the Acquisition sheet of the same file closes the tasks the Acquisition register is the source of (A3), as Master T reads it (the one selected
    -- candidate's Contract Sign-off Date), approved directly; also when the register refused its row (no Selection Date in the owner's file, Q468)
    FOR b IN SELECT x FROM jsonb_array_elements(res -> 'batches') x WHERE x ->> 'kind' = 'register' AND x ->> 'ref' = 'acquisition' LOOP
      PERFORM public.hms_feed_acquisition((b ->> 'id')::uuid, false, hw ->> 'reason');
    END LOOP;
  END IF;
  v_outcome := jsonb_build_object('group_id', gid, 'mode', p_mode, 'batches', batches, 'skipped', res -> 'skipped', 'queued', queued, 'approve_directly', hda,   -- 0092
    'registers', hrg, 'register_notes', rnotes,   -- 0093
    'reapply', rap, 'discarded', disc);   -- 0122
  UPDATE public.master_reconciliation_runs SET status = 'applied', applied_by = actor, applied_at = now(), apply_reason = left(btrim(p_reason), 2000), apply_mode = p_mode,
    group_id = gid, outcome = v_outcome, version = version + 1 WHERE id = p_run;
  PERFORM public.log_audit_write('master_import.apply', 'master_reconciliation_run', p_run::text, jsonb_build_object('status', 'previewed'),
    jsonb_build_object('status', 'applied', 'outcome', v_outcome, 'file_sha256', r.file_sha256, 'historical_load', hw IS NOT NULL,
      'approve_directly', hda, 'registers', hrg, 'reapply', rap), btrim(p_reason));   -- 0092, 0093, 0122
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: applied', jsonb_build_object('run_id', p_run, 'group_id', gid, 'mode', p_mode, 'batches', jsonb_array_length(batches), 'queued', queued), actor, NULL);
  RETURN v_outcome;
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The one-time catch-up (internal; only in a migration session)
-- ---------------------------------------------------------------------------------------------------------------------
-- (a) Every Acquisition batch of a historical Master load approved directly, not discarded, goes through hms_feed_acquisition as the System Admin who
-- loaded it (app.user_id of the migration session's legacy context, every region); a batch whose loader is no longer an active System Admin is counted and
-- left. (b) The rules of the site type on every site (hms_apply_type_rules, recalculated when something changed). One summary audit row with the counts.
-- Running it again changes nothing.
CREATE OR REPLACE FUNCTION hms_catch_up() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  bt record; sid uuid; fed jsonb; r jsonb; k text; uid text := current_setting('app.user_id', true); rg text := current_setting('app.region_ids', true);
  n_batches int := 0; n_left int := 0; a3_outcomes jsonb := '{}'::jsonb; a3_approved jsonb := '{}'::jsonb;
  n_sites int := 0; n_changed int := 0; to_na int := 0; restored int := 0; kept int := 0; unknown int := 0;
  ms1_before int; ms1_after int; st_before jsonb; st_after jsonb; res jsonb;
  why constant text := 'migration 0124: A5 applies to HUB and Terminal sites only (task catalogue, Master V); N/A for Core, MFN and FN';
BEGIN
  IF NOT public.app_ctx_legacy() THEN
    RAISE EXCEPTION 'historical Site Release: the catch-up runs only in a migration session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO ms1_before FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE td.code = 'MS1' AND t.state = 'approved';
  SELECT coalesce(jsonb_object_agg(x.st, x.n), '{}'::jsonb) INTO st_before FROM (SELECT overall_status::text AS st, count(*) AS n FROM public.sites GROUP BY 1) x;
  PERFORM set_config('app.region_ids', '*', true);
  -- (a) A3 from the Acquisition sheet already loaded
  FOR bt IN
    SELECT b.id, b.historical_marked_by, b.historical_reason FROM public.import_batches b
    WHERE b.register_key = 'acquisition' AND b.historical_direct_approve AND b.historical_load AND b.source = 'master_import' AND b.status <> 'discarded'
    ORDER BY b.created_at, b.id
  LOOP
    n_batches := n_batches + 1;
    IF bt.historical_marked_by IS NULL OR NOT public.app_user_is_system_admin(bt.historical_marked_by) THEN
      n_left := n_left + 1;
      CONTINUE;
    END IF;
    PERFORM set_config('app.user_id', bt.historical_marked_by::text, true);
    BEGIN
      fed := public.hms_feed_acquisition(bt.id, true, coalesce(bt.historical_reason, 'historical load'));
    EXCEPTION WHEN others THEN   -- one batch never stops the update of the server: reported in the System Log and counted
      PERFORM public.log_system_write('warn', 'master-import', 'migration 0124: an Acquisition batch of the historical load could not feed its tasks',
        jsonb_build_object('batch_id', bt.id, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), NULL, NULL);
      fed := jsonb_build_object('outcomes', jsonb_build_object('batch_failed', 1), 'approved', '{}'::jsonb);
    END;
    FOR k IN SELECT jsonb_object_keys(coalesce(fed -> 'outcomes', '{}'::jsonb)) LOOP
      a3_outcomes := jsonb_set(a3_outcomes, ARRAY[k], to_jsonb(coalesce((a3_outcomes ->> k)::int, 0) + (fed -> 'outcomes' ->> k)::int));
    END LOOP;
    FOR k IN SELECT jsonb_object_keys(coalesce(fed -> 'approved', '{}'::jsonb)) LOOP
      a3_approved := jsonb_set(a3_approved, ARRAY[k], to_jsonb(coalesce((a3_approved ->> k)::int, 0) + (fed -> 'approved' ->> k)::int));
    END LOOP;
  END LOOP;
  PERFORM set_config('app.user_id', coalesce(uid, ''), true);
  -- (b) the rules of the site type (A5) on every site
  FOR sid IN SELECT s.id FROM public.sites s ORDER BY s.id LOOP
    n_sites := n_sites + 1;
    r := public.hms_apply_type_rules(sid, why);
    CONTINUE WHEN r IS NULL;
    IF jsonb_array_length(r -> 'changed') > 0 THEN n_changed := n_changed + 1; END IF;
    to_na := to_na + (SELECT count(*) FROM jsonb_array_elements(r -> 'changed') x WHERE x ->> 'to' = 'na');
    restored := restored + (SELECT count(*) FROM jsonb_array_elements(r -> 'changed') x WHERE x ->> 'to' <> 'na');
    kept := kept + jsonb_array_length(r -> 'kept');
    unknown := unknown + jsonb_array_length(r -> 'unknown');
  END LOOP;
  PERFORM set_config('app.region_ids', coalesce(rg, ''), true);
  SELECT count(*) INTO ms1_after FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE td.code = 'MS1' AND t.state = 'approved';
  SELECT coalesce(jsonb_object_agg(x.st, x.n), '{}'::jsonb) INTO st_after FROM (SELECT overall_status::text AS st, count(*) AS n FROM public.sites GROUP BY 1) x;
  res := jsonb_build_object(
    'a3', jsonb_build_object('acquisition_batches', n_batches, 'batches_loader_not_admin', n_left, 'tasks', a3_outcomes, 'approved_by_task', a3_approved),
    'site_type_rules', jsonb_build_object('sites', n_sites, 'sites_changed', n_changed, 'tasks_na', to_na, 'tasks_restored', restored,
      'tasks_kept_in_progress_or_approved', kept, 'tasks_site_type_unknown', unknown),
    'ms1_approved_before', ms1_before, 'ms1_approved_after', ms1_after, 'overall_status_before', st_before, 'overall_status_after', st_after);
  INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, is_admin_override)
  VALUES ('historical_ms1_catch_up', 'site', 'all', jsonb_build_object('ms1_approved', ms1_before, 'by_status', st_before),
          res || jsonb_build_object('rule', 'A3 from the Acquisition sheet of the historical load (Master T); A5 N/A when the site type is not HUB or Terminal (a site without a site type keeps A5)'),
          'migration 0124: Site Release of the historical load (owner request 2026-11-18)', true);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Ownership and execute rights. The new functions are owned by pmis_definer and closed to PUBLIC; none is granted to pmis_app. The redefined functions
--    keep their owner and grants (CREATE OR REPLACE).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hms_apply_type_rules(uuid,text)', 'hms_site_type_changed()', 'hms_feed_task(uuid,uuid,uuid,date,text,text,boolean,text)',
                           'hms_feed_acquisition(uuid,boolean,text)', 'hms_catch_up()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM pmis_app', f); END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The one-time catch-up (the migration session: its legacy context names the loader of each batch)
-- ---------------------------------------------------------------------------------------------------------------------
SELECT hms_catch_up();
