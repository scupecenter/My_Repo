-- 0052_p1_sla_calendar_gates: work package P1 of the owner answers of 2026-11-04 (docs/spec/owner-answers-2026-11-04.md, plan
-- docs/plans/2026-11-04-owner-answers-gap.md section P1 and the owner decisions on the D list). Binding owner decisions.
-- Mirror: db/sql/051_p1_sla_calendar_gates.sql (kept byte-identical).
--
-- Nothing of an earlier migration is edited in place: functions are CREATE OR REPLACE (owner and grants of the existing ones are kept), the
-- new tables and functions get their ownership and rights in the last part. pmis_app stays read-only on every new table.
--
--   Q15  scenario applicability: table scenario_task_rules (per workflow version, task code, scenario: applies / na / sla_not_measured / flag).
--        Hot and Cold Swap on the same site make A1 and A3 N/A by default; an approved scope exception (site_scope_exceptions, admin with a
--        reason, optionally linked to an approved Change Control record) enables a task again. Nothing is ever marked done.
--        admin_apply_applicability(site, reason) sets tasks N/A or applicable again from scenario, flags and exceptions; never an approved task,
--        never a task in review or approval; audited. wf_apply_applicability_core is the same without the admin check, for the site creation of
--        P3 (Master import) and the approved scope change of P4a.
--   Q3   Site RFI is N/A for Hot / Cold Swap by scenario. scope_scenario_conflicts(site): a Swap with any of AA:AD = Yes is a conflict that
--        blocks applying the scope (422 scope_scenario_conflict) until it is reviewed: fix the flags or approve a scope exception. The Master
--        formula (flags only) is kept as master_rfi in site_applicability(), for the comparison only. baseline_proposal follows the scenario.
--   Q2   D-1 starts at MS4 when the RFI applies and at MS1 when it is N/A (start event grammar "A|B": the first that is not N/A), and is not
--        measured for Hot / Cold Swap (rule sla_not_measured: no clock, the task still applies). A missing start date is a data gap: the clock
--        waits, it never starts today.
--   Q9   gate history: table site_gate_events (opened, closed, date_moved) written by calc_gate_watch; an earlier opening date stays in the
--        history. ADR 0015.
--   Q180 cc_suspension_windows(site): the effective dates of suspension and resumption (fallback: the approval date), window [start, resume).
--        gate_eval uses them.
--   Q13  task value layout_submitted_date on B6 (Layout Submitted Date, never filled from another date), SLA end event
--        task.layout_submitted_date (used once an admin publishes a rule set with it); the Master AR -> AR metric is tagged inherited in
--        sla_master_columns.
--   Q14  sla_master_columns: the 45 SLA sheet columns D:AV mapped to task codes (B-10a and B-10b both on B10 by the Master O flag RT / GF).
--   Q136 SLA end event hlc.in_service_date (allowed in the rule check and in sla_task_close). The switch itself is a rule set published after the
--        parallel run (owner data C-7). Rule-set items now carry their end event and the admin may change it in a draft.
--   Q135 sla_rules.pending_confirmation (and on rule-set items): C-3 keeps 0 / 1 working day as an inherited value marked "Pending SLA
--        Confirmation"; the dashboard scorecard and penalties leave such rules out (read by P2).
--   Q4 / D4b tentative holidays count as holidays now (as built); sla_tentative_holidays() lists the tentative dates inside an SLA period so
--        the API marks the due date "tentative date"; they are corrected when confirmed (admin_save_holiday already recalculates open tasks).
--        Setting calendar.official_confirmed (default false, pending owner data C-1) drives the "calendar not confirmed" banner.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Settings (pending owner data stays a configurable default)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('calendar.official_confirmed', 'false', 'Q4 (pending owner data C-1): true once the official Libyan holiday calendar for the current and next year has been entered and confirmed. While false, the calendar screens show a banner; tentative dates count as holidays and the affected due dates carry a "tentative date" badge (D4b).', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Scenario applicability (Q15, Q3, Q2)
-- ---------------------------------------------------------------------------------------------------------------------
-- rule  applies           the task applies for this scenario
--       na                the task does not apply (set N/A by admin_apply_applicability), unless an approved scope exception enables it
--       sla_not_measured  the task applies but its SLA clock is not measured (D-1 for Swap, Q2)
--       flag              the task applies when the scope flag expression holds, else N/A (Master AA:AF)
-- scenario NULL = every scenario; a rule for the site's scenario wins over the rule for every scenario.
CREATE TABLE scenario_task_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflow_definitions (id),
  task_code   TEXT NOT NULL,
  scenario    "DeliveryScenario",
  rule        TEXT NOT NULL CHECK (rule IN ('applies', 'na', 'sla_not_measured', 'flag')),
  flag_expr   TEXT CHECK (flag_expr IN ('cw', 'tower', 'adaption_only', 'gecol', 'hlc', 'rfi', 'te')),
  reason      TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  retired_by  UUID,
  retired_at  TIMESTAMPTZ(6),
  CONSTRAINT scenario_task_rules_flag_chk CHECK ((rule = 'flag') = (flag_expr IS NOT NULL))
);
CREATE UNIQUE INDEX scenario_task_rules_one ON scenario_task_rules (workflow_id, task_code, scenario, (rule = 'sla_not_measured')) WHERE is_active AND scenario IS NOT NULL;
CREATE UNIQUE INDEX scenario_task_rules_one_all ON scenario_task_rules (workflow_id, task_code, (rule = 'sla_not_measured')) WHERE is_active AND scenario IS NULL;
CREATE INDEX scenario_task_rules_wf ON scenario_task_rules (workflow_id, task_code) WHERE is_active;

-- Version counter of the whole rule list (ETag of the settings screen).
CREATE TABLE scenario_rule_state (
  id      BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO scenario_rule_state (id, version) VALUES (true, 1) ON CONFLICT (id) DO NOTHING;

-- An approved scope exception: the task applies on this site although the scenario makes it N/A (Q15, Q3). Never deleted: revoked with a reason.
CREATE TABLE site_scope_exceptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           UUID NOT NULL REFERENCES sites (id) ON DELETE CASCADE ON UPDATE CASCADE,
  region_id         INTEGER NOT NULL,
  task_code         TEXT NOT NULL,
  reason            TEXT NOT NULL,
  change_request_id UUID REFERENCES change_requests (id),
  approved_by       UUID NOT NULL,
  approved_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  revoked_by        UUID,
  revoked_at        TIMESTAMPTZ(6),
  revoke_reason     TEXT
);
CREATE UNIQUE INDEX site_scope_exceptions_active ON site_scope_exceptions (site_id, task_code) WHERE revoked_at IS NULL;

-- 2a. Seed (docs/spec/task-catalogue.csv scenario_applicability, owner answers Q2, Q3, Q15, CLAUDE.md "Expansion scenario").
INSERT INTO scenario_task_rules (workflow_id, task_code, scenario, rule, flag_expr, reason, created_by)
SELECT td.workflow_id, v.code, v.scenario::"DeliveryScenario", v.rule, v.flag, v.reason, NULL
FROM (VALUES
  ('A1', 'expansion', 'na', NULL, 'Expansion keeps TSSR and LLD only (CLAUDE.md, agreed)'),
  ('A3', 'expansion', 'na', NULL, 'Expansion keeps TSSR and LLD only (CLAUDE.md, agreed)'),
  ('A5', 'expansion', 'na', NULL, 'Expansion keeps TSSR and LLD only (CLAUDE.md, agreed)'),
  ('A1', 'hot_swap', 'na', NULL, 'Q15: same site, no search; enable through a scope exception when a new candidate is needed'),
  ('A1', 'cold_swap', 'na', NULL, 'Q15: same site, no search; enable through a scope exception when a new candidate is needed'),
  ('A3', 'hot_swap', 'na', NULL, 'Q15: same site, no new acquisition; enable through a scope exception when a new contract is needed'),
  ('A3', 'cold_swap', 'na', NULL, 'Q15: same site, no new acquisition; enable through a scope exception when a new contract is needed'),
  ('MS4', 'hot_swap', 'na', NULL, 'Q3: Site RFI is N/A for Hot Swap by scenario'),
  ('MS4', 'cold_swap', 'na', NULL, 'Q3: Site RFI is N/A for Cold Swap by scenario'),
  ('MS4', NULL, 'flag', 'rfi', 'Site RFI applies when any of AA:AD is Yes (Master BQ)'),
  ('D1', 'hot_swap', 'sla_not_measured', NULL, 'Q2: D-1 is not measured for Hot Swap (BP section 06)'),
  ('D1', 'cold_swap', 'sla_not_measured', NULL, 'Q2: D-1 is not measured for Cold Swap (BP section 06)'),
  ('D10a', 'new_build', 'na', NULL, 'MOP only for Swap (task catalogue)'),
  ('D10a', 'expansion', 'na', NULL, 'MOP only for Swap (task catalogue)'),
  ('D10a', 'relocation', 'na', NULL, 'MOP only for Swap (task catalogue)'),
  ('D10b', 'new_build', 'na', NULL, 'Cutover window only for Swap (task catalogue)'),
  ('D10b', 'expansion', 'na', NULL, 'Cutover window only for Swap (task catalogue)'),
  ('D10b', 'relocation', 'na', NULL, 'Cutover window only for Swap (task catalogue)'),
  ('B1', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'), ('B2', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'),
  ('B3', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'), ('B4', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'),
  ('B6', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'), ('B7', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'),
  ('MS2', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'), ('MS3', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'),
  ('B13', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'), ('B14', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'),
  ('B15', NULL, 'flag', 'cw', 'CW tasks apply when AA or AB is Yes'),
  ('B8', NULL, 'flag', 'tower', 'Tower MOS only when AA Tower Erection is Yes'), ('B10', NULL, 'flag', 'tower', 'Tower erection only when AA is Yes'),
  ('B9', NULL, 'flag', 'adaption_only', 'Adaption only (AB Yes and AA not Yes)'), ('B11', NULL, 'flag', 'adaption_only', 'Adaption only (AB Yes and AA not Yes)'),
  ('C1', NULL, 'flag', 'gecol', 'GECOL tasks only when AC is Yes'), ('C2', NULL, 'flag', 'gecol', 'GECOL tasks only when AC is Yes'),
  ('C3', NULL, 'flag', 'hlc', 'HLC tasks only when AD is Yes'), ('C4', NULL, 'flag', 'hlc', 'HLC tasks only when AD is Yes')
) AS v(code, scenario, rule, flag, reason)
JOIN task_definitions td ON td.code = v.code
ON CONFLICT DO NOTHING;
-- TE tasks apply when AE or AF is Yes (every TE task of the catalogue except D8, which follows the MW need, and D10a / D10b, which follow the scenario).
INSERT INTO scenario_task_rules (workflow_id, task_code, scenario, rule, flag_expr, reason)
SELECT td.workflow_id, td.code, NULL, 'flag', 'te', 'TE tasks apply when AE or AF is Yes'
FROM task_definitions td
WHERE td.code IN ('D1', 'D2', 'D3', 'D4', 'D4b', 'D5', 'D6', 'MS5', 'D7', 'D9', 'D10', 'MS6', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'MS7', 'F1', 'F2', 'MS8', 'D17', 'MS9', 'D18')
ON CONFLICT DO NOTHING;

ALTER TABLE scenario_task_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_task_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON scenario_task_rules FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON scenario_task_rules FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE scenario_rule_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_rule_state FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON scenario_rule_state FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON scenario_rule_state FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
ALTER TABLE site_scope_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_scope_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON site_scope_exceptions FOR SELECT USING (app_region_check(region_id));
CREATE POLICY rls_seed_write ON site_scope_exceptions FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- 2b. Readers
-- A scope flag expression of the site (Master AA:AF). NULL never happens: the flags are yes / na.
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
  END
  FROM public.sites s WHERE s.id = p_site
$$;

-- What the rules say about one task of a site.
--   applies       true / false, or NULL when no rule speaks about the task (it keeps its state)
--   sla_measured  false when a sla_not_measured rule of the site's scenario holds (Q2)
--   source        exception | scenario | flag | none;  rule_reason  the reason of the deciding rule;  exception_id  the scope exception
CREATE OR REPLACE FUNCTION site_task_rule(p_site uuid, p_code text, OUT applies boolean, OUT sla_measured boolean, OUT source text, OUT rule_reason text, OUT exception_id uuid)
RETURNS record LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; r public.scenario_task_rules%ROWTYPE;
BEGIN
  sla_measured := true; source := 'none';
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO r FROM public.scenario_task_rules x
  WHERE x.workflow_id = s.workflow_version_id AND x.task_code = p_code AND x.is_active AND x.rule = 'sla_not_measured'
    AND (x.scenario IS NULL OR x.scenario = s.delivery_scenario)
  ORDER BY (x.scenario IS NOT NULL) DESC LIMIT 1;
  IF FOUND THEN sla_measured := false; END IF;
  SELECT e.id, e.reason INTO exception_id, rule_reason FROM public.site_scope_exceptions e WHERE e.site_id = p_site AND e.task_code = p_code AND e.revoked_at IS NULL;
  IF exception_id IS NOT NULL THEN applies := true; source := 'exception'; RETURN; END IF;
  SELECT * INTO r FROM public.scenario_task_rules x
  WHERE x.workflow_id = s.workflow_version_id AND x.task_code = p_code AND x.is_active AND x.rule <> 'sla_not_measured'
    AND (x.scenario IS NULL OR x.scenario = s.delivery_scenario)
  ORDER BY (x.scenario IS NOT NULL) DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  rule_reason := r.reason;
  IF r.rule = 'flag' THEN applies := public.site_flag(p_site, r.flag_expr); source := 'flag';
  ELSE applies := (r.rule = 'applies'); source := CASE WHEN r.scenario IS NULL THEN 'flag' ELSE 'scenario' END;
  END IF;
END $$;

-- Q3: does the Site RFI apply? The scenario rule first, then the flags; with no rule at all, the Master formula (flags).
CREATE OR REPLACE FUNCTION site_rfi_applies(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT x.applies FROM public.site_task_rule(p_site, 'MS4') x), public.site_flag(p_site, 'rfi'))
$$;

-- Q3: a scenario rule that makes a task N/A while the scope flags say the work exists, with no approved scope exception (for example a Hot Swap
-- with GECOL = Yes: the Site RFI is N/A by scenario, the flags need it). Each conflict blocks applying the scope until it is reviewed.
CREATE OR REPLACE FUNCTION scope_scenario_conflicts(p_site uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', n.task_code, 'scenario', n.scenario, 'flag_expr', f.flag_expr,
           'message', 'The scenario ' || n.scenario::text || ' makes ' || n.task_code || ' N/A, but the scope flags (' || f.flag_expr || ') say the work exists. Correct the flags or approve a scope exception.')
           ORDER BY n.task_code COLLATE "C"), '[]'::jsonb)
  FROM public.sites s
  JOIN public.scenario_task_rules n ON n.workflow_id = s.workflow_version_id AND n.is_active AND n.rule = 'na' AND n.scenario = s.delivery_scenario
  JOIN public.scenario_task_rules f ON f.workflow_id = s.workflow_version_id AND f.is_active AND f.rule = 'flag' AND f.task_code = n.task_code AND f.scenario IS NULL
  WHERE s.id = p_site AND public.site_flag(p_site, f.flag_expr)
    AND NOT EXISTS (SELECT 1 FROM public.site_scope_exceptions e WHERE e.site_id = s.id AND e.task_code = n.task_code AND e.revoked_at IS NULL)
$$;

-- The applicability of every task of the site, for GET /sites/{id}/applicability. master_rfi is the Master's flags-only value (comparison only).
CREATE OR REPLACE FUNCTION site_applicability(p_site uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'site_id', s.id, 'delivery_scenario', s.delivery_scenario,
    'rfi', jsonb_build_object('applies', public.site_rfi_applies(s.id), 'master_rfi', public.site_flag(s.id, 'rfi'),
                              'differs', public.site_rfi_applies(s.id) IS DISTINCT FROM public.site_flag(s.id, 'rfi')),
    'conflicts', public.scope_scenario_conflicts(s.id),
    'tasks', coalesce((
      SELECT jsonb_agg(jsonb_build_object('task_id', ti.id, 'task_code', td.code, 'state', ti.state, 'applies', x.applies, 'sla_measured', x.sla_measured,
               'source', x.source, 'reason', x.rule_reason, 'exception_id', x.exception_id,
               'would_change', CASE WHEN x.applies IS FALSE AND ti.state IN ('locked', 'open', 'entry') THEN 'na'
                                    WHEN x.applies IS TRUE AND ti.state = 'na' AND starts_with(coalesce(ti.na_reason, ''), 'applicability:') THEN 'applies' END)
             ORDER BY sd.seq, td.sort_order, td.code COLLATE "C")
      FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
      CROSS JOIN LATERAL public.site_task_rule(s.id, td.code) x
      WHERE ti.site_id = s.id), '[]'::jsonb),
    'exceptions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'task_code', e.task_code, 'reason', e.reason, 'change_request_id', e.change_request_id,
               'approved_by', e.approved_by, 'approved_at', e.approved_at, 'revoked_at', e.revoked_at, 'revoked_by', e.revoked_by, 'revoke_reason', e.revoke_reason)
             ORDER BY e.approved_at, e.id)
      FROM public.site_scope_exceptions e WHERE e.site_id = s.id), '[]'::jsonb))
  FROM public.sites s WHERE s.id = p_site
$$;

-- 2c. Applying the rules to the tasks of a site. Never touches an approved task or a task in review or approval (they are reported).
-- N/A set here carries na_reason 'applicability: ...', so that only those tasks come back when the scenario, the flags or an exception enable them.
CREATE OR REPLACE FUNCTION wf_apply_applicability_core(p_site uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sites%ROWTYPE; t record; x record; conf jsonb; changed jsonb := '[]'::jsonb; kept jsonb := '[]'::jsonb; before jsonb; hold record; opened boolean;
  cur_state text; cur_reason text; was_busy text := coalesce(current_setting('pmis.calc_busy', true), '');
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  conf := public.scope_scenario_conflicts(p_site);
  IF jsonb_array_length(conf) > 0 THEN
    PERFORM public.calc_err('scope_scenario_conflict', jsonb_build_object('detail', 'The scenario and the scope flags disagree. Review them before the scope is applied.', 'conflicts', conf));
  END IF;
  -- The calculation layer waits until every task is set (no milestone is calculated half way); it runs once at the end.
  PERFORM set_config('pmis.calc_busy', '1', true);
  FOR t IN
    SELECT ti.id, td.code, td.id AS def_id FROM public.task_instances ti
    JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions sd ON sd.id = td.stage_id
    WHERE ti.site_id = p_site ORDER BY sd.seq, td.sort_order, td.code COLLATE "C"
  LOOP
    -- the state now (an earlier step of this loop may have opened the task)
    SELECT ti.state::text, ti.na_reason INTO cur_state, cur_reason FROM public.task_instances ti WHERE ti.id = t.id;
    SELECT * INTO x FROM public.site_task_rule(p_site, t.code);
    IF x.applies IS FALSE AND cur_state NOT IN ('na', 'skipped') THEN
      IF cur_state IN ('locked', 'open', 'entry') THEN
        before := public.wf_snap(t.id);
        UPDATE public.task_instances SET state = 'na', is_na = true, na_reason = left('applicability: ' || coalesce(x.rule_reason, x.source), 500),
          ball_in_court_user_id = NULL, lock_reason = NULL, version = version + 1, updated_at = now()
        WHERE id = t.id;
        INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
        VALUES ('task_applicability_na', 'task', t.id::text, s.id, s.region_id, before,
                public.wf_snap(t.id) || jsonb_build_object('source', x.source, 'rule', x.rule_reason), p_reason, public.app_actor());
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
              public.wf_snap(t.id) || jsonb_build_object('source', x.source, 'exception_id', x.exception_id), p_reason, public.app_actor());
      changed := changed || jsonb_build_array(jsonb_build_object('task_code', t.code, 'from', 'na', 'to', CASE WHEN opened THEN 'open' ELSE 'locked' END, 'source', x.source));
    END IF;
  END LOOP;
  PERFORM set_config('pmis.calc_busy', was_busy, true);
  IF was_busy <> '1' THEN PERFORM public.calc_refresh_site(p_site); END IF;
  RETURN jsonb_build_object('site_id', p_site, 'changed', changed, 'kept', kept);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('pmis.calc_busy', was_busy, true);
  RAISE;
END $$;

-- The admin path: System Admin or a delegate of task_definitions edit for the site's region; a reason. The API adds the step-up.
CREATE OR REPLACE FUNCTION admin_apply_applicability(p_site uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE reg integer;
BEGIN
  SELECT region_id INTO reg FROM public.sites WHERE id = p_site;
  IF reg IS NULL THEN PERFORM public.calc_err('not_found'); END IF;
  IF NOT public.app_actor_is_admin('task_definitions', 'edit', ARRAY[reg]) THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering task_definitions.edit in the site region required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  RETURN public.wf_apply_applicability_core(p_site, p_reason);
END $$;

-- An approved scope exception (Q15, Q3): the task applies on this site although the scenario makes it N/A. A Change Control record named here must
-- be approved or applied and belong to the same site. Only for a task that a scenario rule makes N/A. Returns the exception id.
CREATE OR REPLACE FUNCTION admin_save_scope_exception(p_site uuid, p_task_code text, p_change uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.sites%ROWTYPE; nid uuid; errs jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  IF NOT public.app_actor_is_admin('task_definitions', 'edit', ARRAY[s.region_id]) THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering task_definitions.edit in the site region required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF NOT EXISTS (SELECT 1 FROM public.scenario_task_rules r WHERE r.workflow_id = s.workflow_version_id AND r.task_code = p_task_code AND r.is_active
                 AND r.rule = 'na' AND r.scenario = s.delivery_scenario) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/task_code', 'code', 'not_na_by_scenario', 'message', 'The scenario of this site does not make this task N/A.'));
  END IF;
  IF p_change IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.change_requests c WHERE c.id = p_change AND c.site_id = p_site AND c.status IN ('approved', 'applied')) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/change_request_id', 'code', 'change_not_approved', 'message', 'Name an approved Change Control record of this site.'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.site_scope_exceptions e WHERE e.site_id = p_site AND e.task_code = p_task_code AND e.revoked_at IS NULL) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/task_code', 'code', 'duplicate', 'message', 'An exception for this task is already in force.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  INSERT INTO public.site_scope_exceptions (site_id, region_id, task_code, reason, change_request_id, approved_by)
  VALUES (p_site, s.region_id, p_task_code, p_reason, p_change, public.app_actor()) RETURNING id INTO nid;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES ('scope_exception_approve', 'site', p_site::text, p_site, s.region_id, NULL,
          jsonb_build_object('exception_id', nid, 'task_code', p_task_code, 'change_request_id', p_change, 'scenario', s.delivery_scenario), p_reason, public.app_actor());
  RETURN nid;
END $$;

CREATE OR REPLACE FUNCTION admin_revoke_scope_exception(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public.site_scope_exceptions%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.site_scope_exceptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  IF NOT public.app_actor_is_admin('task_definitions', 'edit', ARRAY[e.region_id]) THEN
    RAISE EXCEPTION 'admin path: System Admin or a delegation covering task_definitions.edit in the site region required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF e.revoked_at IS NOT NULL THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'The exception is already revoked.')); END IF;
  UPDATE public.site_scope_exceptions SET revoked_at = now(), revoked_by = public.app_actor(), revoke_reason = p_reason WHERE id = p_id;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES ('scope_exception_revoke', 'site', e.site_id::text, e.site_id, e.region_id, jsonb_build_object('exception_id', e.id, 'task_code', e.task_code),
          jsonb_build_object('exception_id', e.id, 'revoked', true), p_reason, public.app_actor());
END $$;

-- Replaces the active rule list (Settings, Scenario rules). p_rules: [{task_code, scenario|null, rule, flag_expr|null, reason}]. System Admin or a
-- delegate of task_definitions edit for all regions; reason; If-Match on the list version. Old rows are retired, never deleted. Rules apply to the
-- tasks of a site when admin_apply_applicability runs for it (never silently).
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
       OR (r ->> 'flag_expr' IS NOT NULL AND r ->> 'flag_expr' NOT IN ('cw', 'tower', 'adaption_only', 'gecol', 'hlc', 'rfi', 'te')) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/flag_expr', 'code', 'invalid', 'message', 'A flag rule needs a flag expression (cw, tower, adaption_only, gecol, hlc, rfi, te); other rules have none.'));
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. SLA start and end events (Q2, Q13, Q136) and the pending flag (Q135)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE sla_rules ADD COLUMN IF NOT EXISTS pending_confirmation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sla_rule_set_items ADD COLUMN IF NOT EXISTS pending_confirmation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sla_rules DROP CONSTRAINT sla_rules_end_ref_chk;
ALTER TABLE sla_rules ADD CONSTRAINT sla_rules_end_ref_chk CHECK (end_ref IS NULL OR end_ref IN ('gecol.installation_finish', 'hlc.installation_date', 'hlc.in_service_date', 'task.layout_submitted_date'));
ALTER TABLE sla_rule_set_items ADD CONSTRAINT sla_rule_set_items_end_ref_chk CHECK (end_ref IS NULL OR end_ref IN ('gecol.installation_finish', 'hlc.installation_date', 'hlc.in_service_date', 'task.layout_submitted_date'));

-- The end events an admin may give a rule (NULL = the actual date of the task).
CREATE OR REPLACE FUNCTION sla_end_ref_valid(p_ref text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT p_ref IS NULL OR p_ref IN ('gecol.installation_finish', 'hlc.installation_date', 'hlc.in_service_date', 'task.layout_submitted_date')
$$;

-- Start event grammar gains "A|B" (Q2): the first code whose task is not N/A or skipped on the site; each part is a code of the workflow.
CREATE OR REPLACE FUNCTION sla_start_ref_valid(p_ref text, p_workflow uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_ref IS NULL THEN false
    WHEN p_ref IN ('PRED', 'OPEN') THEN true
    WHEN p_ref LIKE '%|%' THEN
      NOT EXISTS (SELECT 1 FROM unnest(string_to_array(p_ref, '|')) AS part(c)
                  WHERE NOT EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = part.c))
    WHEN p_ref LIKE 'DLP:%:%' OR p_ref LIKE 'DLPD:%:%' THEN
      EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = split_part(p_ref, ':', 2)) AND split_part(p_ref, ':', 3) <> ''
    WHEN p_ref LIKE 'PR:%' THEN
      EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = 'procurement' AND f.code = 'scope' AND jsonb_typeof(f.options) = 'array'
              AND f.options ? substr(p_ref, 4))
    WHEN p_ref ~ '^G[0-9]+$' THEN EXISTS (SELECT 1 FROM public.phase_gate_rules g WHERE g.workflow_id = p_workflow AND g.link_code = p_ref)
    ELSE EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.workflow_id = p_workflow AND td.code = p_ref)
  END
$$;

CREATE OR REPLACE FUNCTION sla_resolve_start(p_task uuid, p_ref text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; d date; months integer; days integer; key text; today date := public.cal_today(); part text; st text;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_ref IS NULL OR p_ref = 'PRED' THEN
    SELECT max(public.sla_task_date(t.site_id, pd.code)) INTO d
    FROM public.task_predecessors tp JOIN public.task_definitions pd ON pd.id = tp.predecessor_id WHERE tp.task_def_id = t.task_def_id;
    RETURN coalesce(d, today);
  ELSIF p_ref = 'OPEN' THEN
    RETURN today;
  ELSIF p_ref LIKE '%|%' THEN
    -- Q2: the first event that applies on this site (D-1: MS4, or MS1 when the Site RFI is N/A). Its date may still be missing: the clock waits.
    FOREACH part IN ARRAY string_to_array(p_ref, '|') LOOP
      SELECT ti.state::text INTO st FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
      WHERE ti.site_id = t.site_id AND td.code = part;
      CONTINUE WHEN st IS NULL OR st IN ('na', 'skipped');
      RETURN public.sla_task_date(t.site_id, part);
    END LOOP;
    RETURN NULL;
  ELSIF p_ref ~ '^G[0-9]+$' THEN
    RETURN (SELECT g.gate_date FROM public.gate_eval(t.site_id, p_ref) g);
  ELSIF p_ref LIKE 'PR:%' THEN
    RETURN (SELECT min(p.pr_date) FROM public.procurement_records p WHERE p.site_id = t.site_id AND p.scope = substr(p_ref, 4));
  ELSIF p_ref LIKE 'DLPD:%:%' THEN
    key := split_part(p_ref, ':', 3);
    days := coalesce((public.calc_setting(key, 'null'::jsonb) #>> '{}')::integer, 90);
    d := public.sla_task_date(t.site_id, split_part(p_ref, ':', 2));
    RETURN CASE WHEN d IS NULL THEN NULL ELSE d + days END;
  ELSIF p_ref LIKE 'DLP:%:%' THEN
    key := split_part(p_ref, ':', 3);
    months := coalesce((public.calc_setting(key, 'null'::jsonb) #>> '{}')::integer, CASE WHEN key = 'dlp.months.cw' THEN 3 ELSE 12 END);
    d := public.sla_task_date(t.site_id, split_part(p_ref, ':', 2));
    RETURN CASE WHEN d IS NULL THEN NULL ELSE (d + make_interval(months => months))::date END;
  END IF;
  RETURN public.sla_task_date(t.site_id, p_ref);
END $$;

-- Q2: is the SLA of this task measured on its site? False when a sla_not_measured rule of the site's scenario holds (D-1 for Swap).
CREATE OR REPLACE FUNCTION sla_task_measured(p_task uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT x.sla_measured FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
                   CROSS JOIN LATERAL public.site_task_rule(ti.site_id, td.code) x WHERE ti.id = p_task), true)
$$;

-- As 0017, plus Q2: a task whose SLA is not measured on its site gets no clock (no rule, no start, no due date).
CREATE OR REPLACE FUNCTION sla_task_open(p_task uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; s public.sites%ROWTYPE; r public.sla_rules%ROWTYPE; rid uuid; st date;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR t.sla_start_date IS NOT NULL THEN RETURN; END IF;
  IF NOT public.sla_task_measured(p_task) THEN RETURN; END IF;
  SELECT * INTO s FROM public.sites WHERE id = t.site_id;
  rid := public.sla_rule_for(t.task_def_id, s.delivery_scenario, t.region_id, public.cal_today());
  IF rid IS NULL THEN rid := t.sla_rule_id; END IF;
  IF rid IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.sla_rules WHERE id = rid;
  st := public.sla_resolve_start(p_task, r.start_ref);
  UPDATE public.task_instances SET sla_rule_id = rid, sla_start_date = st,
    sla_target_date = CASE WHEN st IS NULL THEN NULL ELSE public.cal_add_workdays(st, r.min_working_days, r.calendar_id) END,
    due_date = CASE WHEN st IS NULL THEN due_date ELSE public.cal_add_workdays(st, r.max_working_days, r.calendar_id) END,
    sla_end_date = NULL, sla_elapsed_wd = NULL, updated_at = now()
  WHERE id = p_task;
END $$;

-- A typed date kept in task values (YYYY-MM-DD), or NULL.
CREATE OR REPLACE FUNCTION task_value_date(p_values jsonb, p_key text) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_typeof(p_values -> p_key) = 'string' AND (p_values ->> p_key) ~ '^\d{4}-\d{2}-\d{2}$' THEN (p_values ->> p_key)::date END
$$;

-- As 0018 (Q82 kept), plus the end events hlc.in_service_date (Q136) and task.layout_submitted_date (Q13). The Layout Submitted Date is never
-- taken from another date: without it the clock closes with no end and no duration (a data gap), never at the actual date.
CREATE OR REPLACE FUNCTION sla_task_close(p_task uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; r public.sla_rules%ROWTYPE; e date; el integer;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN; END IF;
  IF t.state IN ('na', 'skipped') THEN
    UPDATE public.task_instances SET due_date = NULL, sla_target_date = NULL, sla_start_date = NULL, sla_end_date = NULL, sla_elapsed_wd = NULL WHERE id = p_task;
    RETURN;
  END IF;
  IF t.sla_start_date IS NULL OR t.sla_rule_id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM public.sla_rules WHERE id = t.sla_rule_id;
  e := CASE r.end_ref
         WHEN 'gecol.installation_finish' THEN coalesce((SELECT g.installation_finish FROM public.gecol_records g WHERE g.site_id = t.site_id), t.actual_date, t.approved_date)
         WHEN 'hlc.installation_date' THEN coalesce((SELECT h.installation_date FROM public.hlc_records h WHERE h.site_id = t.site_id), t.actual_date, t.approved_date)
         WHEN 'hlc.in_service_date' THEN coalesce((SELECT h.in_service_date FROM public.hlc_records h WHERE h.site_id = t.site_id), t.actual_date, t.approved_date)
         WHEN 'task.layout_submitted_date' THEN public.task_value_date(t.values, 'layout_submitted_date')
         ELSE coalesce(t.actual_date, t.approved_date) END;
  el := public.cal_workdays_between(t.sla_start_date, e, r.calendar_id);
  UPDATE public.task_instances SET sla_end_date = e, sla_elapsed_wd = el WHERE id = p_task;
  IF el < 0 THEN
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
    VALUES ('sla_negative_duration', 'task', p_task::text, t.site_id, t.region_id,
            jsonb_build_object('sla_start_date', t.sla_start_date, 'sla_end_date', e),
            jsonb_build_object('sla_elapsed_wd', el), 'data quality: the actual date is before the SLA start (Q82)', public.app_actor());
    PERFORM public.calc_alert(p_task, 'sla_negative_duration', 'SLA duration is negative',
      public.wf_label(p_task) || ': the actual date ' || e::text || ' is before the SLA start ' || t.sla_start_date::text || ' (' || el::text || ' working days). Please review the dates.');
  END IF;
END $$;

-- Q13: the Layout Submitted Date is a typed date (never in the future, inside the date range of the PMIS). Checked on every write path.
CREATE OR REPLACE FUNCTION task_values_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v jsonb := NEW.values -> 'layout_submitted_date'; d date;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND v IS NOT DISTINCT FROM (OLD.values -> 'layout_submitted_date') THEN RETURN NEW; END IF;
  d := public.task_value_date(NEW.values, 'layout_submitted_date');
  IF d IS NULL OR d < DATE '2020-01-01' OR d > DATE '2035-12-31' OR d > public.cal_today() THEN
    PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/values/layout_submitted_date',
      'code', CASE WHEN d IS NULL OR d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN 'invalid_date' ELSE 'future_date' END,
      'message', 'The Layout Submitted Date must be a date between 2020-01-01 and today.'))));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_task_values_guard BEFORE INSERT OR UPDATE OF values ON task_instances FOR EACH ROW EXECUTE FUNCTION task_values_guard();

-- Q2: D-1 starts from the Site RFI (MS4), or from Site Release (MS1) when the Site RFI is N/A. The rule rows are updated in place (a D1 task that
-- already started keeps its stored start date), as 0018 and 0042 did; the freeze trigger is suspended for this one statement. The items of every
-- rule-set version follow. The change is audited.
ALTER TABLE sla_rules DISABLE TRIGGER sla_rules_frozen;
UPDATE sla_rules r SET start_ref = 'MS4|MS1' FROM task_definitions td WHERE td.id = r.task_def_id AND td.code = 'D1' AND r.start_ref = 'MS4';
ALTER TABLE sla_rules ENABLE TRIGGER sla_rules_frozen;
UPDATE sla_rule_set_items i SET start_ref = 'MS4|MS1' FROM task_definitions td WHERE td.id = i.task_def_id AND td.code = 'D1' AND i.start_ref = 'MS4';
-- Q135: C-3 (PR issue -> HLC approval) keeps 0 / 1 working day as an inherited value, pending the PM's and the HLC owner's confirmation.
UPDATE sla_rules r SET pending_confirmation = true FROM task_definitions td WHERE td.id = r.task_def_id AND td.code = 'C3' AND r.effective_to IS NULL;
UPDATE sla_rule_set_items i SET pending_confirmation = true FROM task_definitions td, sla_rule_sets s
WHERE td.id = i.task_def_id AND td.code = 'C3' AND s.id = i.set_id AND (s.status = 'draft' OR s.effective_to IS NULL);
INSERT INTO audit_log (action, entity_type, entity_id, before, after, reason)
VALUES ('sla_rule_migrated', 'sla_rule', 'D1', jsonb_build_object('start_event', 'MS4'), jsonb_build_object('start_event', 'MS4|MS1'),
        'owner answer Q2 (2026-11-04): D-1 starts at MS4 when the Site RFI applies and at MS1 when it is N/A; migration 0052'),
       ('sla_rule_migrated', 'sla_rule', 'C3', jsonb_build_object('pending_confirmation', false), jsonb_build_object('pending_confirmation', true),
        'owner answer Q135 (2026-11-04): 0 / 1 working day kept as an inherited value, Pending SLA Confirmation; migration 0052');

-- Rule-set drafts carry the end event and the pending flag (Q13, Q136, Q135). As 0017, plus end_event and pending_confirmation in p_rules
-- (omitted = kept from the draft) and the error unknown_end_event.
CREATE OR REPLACE FUNCTION admin_save_sla_rule_set(p_set uuid, p_reason text, p_rules jsonb DEFAULT NULL, p_version integer DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sla_rule_sets%ROWTYPE; base public.sla_rule_sets%ROWTYPE; wf uuid := public.sla_workflow(); r jsonb; idx integer; errs jsonb := '[]'::jsonb;
  td uuid; cal uuid; o jsonb; oidx integer; seen text[] := ARRAY[]::text[]; seen_o text[]; norm jsonb; v_code text; before jsonb;
BEGIN
  PERFORM public.calc_require_admin('sla_rules');
  PERFORM public.calc_require_reason(p_reason);
  IF p_set IS NULL THEN
    SELECT * INTO base FROM public.sla_rule_sets WHERE id = public.sla_set_in_force();
    INSERT INTO public.sla_rule_sets (version, status, base_version, reason, created_by)
    VALUES ((SELECT coalesce(max(version), 0) + 1 FROM public.sla_rule_sets), 'draft', base.version, p_reason, public.app_actor()) RETURNING * INTO s;
    INSERT INTO public.sla_rule_set_items (set_id, task_def_id, min_working_days, max_working_days, start_ref, end_ref, calendar_id, code, overrides, pending_confirmation)
    SELECT s.id, i.task_def_id, i.min_working_days, i.max_working_days, i.start_ref, i.end_ref, i.calendar_id, i.code, i.overrides, i.pending_confirmation
    FROM public.sla_rule_set_items i WHERE i.set_id = base.id;
    PERFORM public.calc_audit('sla_rule_set_draft', 'sla_rule_set', s.id::text, NULL, jsonb_build_object('version', s.version, 'base_version', base.version), p_reason);
    RETURN s.id;
  END IF;
  SELECT * INTO s FROM public.sla_rule_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  IF s.status <> 'draft' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'Only the draft rule set can be changed.')); END IF;
  IF p_version IS NOT NULL AND p_version <> s.row_version THEN PERFORM public.calc_err('precondition_failed'); END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array' THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rules', 'code', 'required', 'message', 'rules is required.')))); END IF;
  FOR r, idx IN SELECT value, ordinality - 1 FROM jsonb_array_elements(p_rules) WITH ORDINALITY LOOP
    v_code := r ->> 'task_code';
    IF v_code = ANY (seen) THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/task_code', 'code', 'duplicate_task_code', 'message', 'The task appears twice.')); END IF;
    seen := seen || v_code;
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions WHERE workflow_id = wf AND code = v_code) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/task_code', 'code', 'unknown_task_code', 'message', 'Unknown task code.'));
    END IF;
    IF (r ->> 'min_working_days')::integer > (r ->> 'max_working_days')::integer THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/max_working_days', 'code', 'min_exceeds_max', 'message', 'The minimum cannot exceed the maximum.'));
    END IF;
    IF NOT public.sla_start_ref_valid(r ->> 'start_event', wf) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/start_event', 'code', 'unknown_start_event', 'message', 'Unknown start event.'));
    END IF;
    IF r ? 'end_event' AND NOT public.sla_end_ref_valid(r ->> 'end_event') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/end_event', 'code', 'unknown_end_event', 'message', 'Unknown end event.'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.work_calendars WHERE code = r ->> 'calendar_code') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/calendar_code', 'code', 'unknown_calendar', 'message', 'Unknown calendar.'));
    END IF;
    seen_o := ARRAY[]::text[];
    FOR o, oidx IN SELECT value, ordinality - 1 FROM jsonb_array_elements(coalesce(r -> 'overrides', '[]'::jsonb)) WITH ORDINALITY LOOP
      IF (o ->> 'min_working_days')::integer > (o ->> 'max_working_days')::integer THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/overrides/' || oidx || '/max_working_days', 'code', 'min_exceeds_max', 'message', 'The minimum cannot exceed the maximum.'));
      END IF;
      IF coalesce(o ->> 'scenario', '') || '|' || coalesce(o ->> 'region_id', '') = ANY (seen_o) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/rules/' || idx || '/overrides/' || oidx, 'code', 'duplicate_override', 'message', 'The same scenario and region appear twice.'));
      END IF;
      seen_o := seen_o || (coalesce(o ->> 'scenario', '') || '|' || coalesce(o ->> 'region_id', ''));
    END LOOP;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := (SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', d.code, 'min', i.min_working_days, 'max', i.max_working_days, 'start', i.start_ref, 'end', i.end_ref, 'pending_confirmation', i.pending_confirmation) ORDER BY d.code), '[]'::jsonb)
             FROM public.sla_rule_set_items i JOIN public.task_definitions d ON d.id = i.task_def_id
             WHERE i.set_id = s.id AND d.code IN (SELECT value ->> 'task_code' FROM jsonb_array_elements(p_rules)));
  FOR r IN SELECT value FROM jsonb_array_elements(p_rules) LOOP
    SELECT id INTO td FROM public.task_definitions WHERE workflow_id = wf AND code = r ->> 'task_code';
    SELECT id INTO cal FROM public.work_calendars WHERE code = r ->> 'calendar_code';
    SELECT coalesce(jsonb_agg(e ORDER BY coalesce(e ->> 'scenario', ''), coalesce((e ->> 'region_id')::integer, 0)), '[]'::jsonb) INTO norm
    FROM jsonb_array_elements(coalesce(r -> 'overrides', '[]'::jsonb)) e;
    INSERT INTO public.sla_rule_set_items (set_id, task_def_id, min_working_days, max_working_days, start_ref, end_ref, calendar_id, code, overrides, pending_confirmation)
    VALUES (s.id, td, (r ->> 'min_working_days')::integer, (r ->> 'max_working_days')::integer, r ->> 'start_event',
            CASE WHEN r ? 'end_event' THEN r ->> 'end_event' ELSE (SELECT i.end_ref FROM public.sla_rule_set_items i WHERE i.set_id = s.id AND i.task_def_id = td) END, cal,
            (SELECT i.code FROM public.sla_rule_set_items i WHERE i.set_id = s.id AND i.task_def_id = td), norm,
            CASE WHEN r ? 'pending_confirmation' THEN coalesce((r ->> 'pending_confirmation')::boolean, false)
                 ELSE coalesce((SELECT i.pending_confirmation FROM public.sla_rule_set_items i WHERE i.set_id = s.id AND i.task_def_id = td), false) END)
    ON CONFLICT (set_id, task_def_id) DO UPDATE SET min_working_days = EXCLUDED.min_working_days, max_working_days = EXCLUDED.max_working_days,
      start_ref = EXCLUDED.start_ref, end_ref = EXCLUDED.end_ref, calendar_id = EXCLUDED.calendar_id, overrides = EXCLUDED.overrides,
      pending_confirmation = EXCLUDED.pending_confirmation;
  END LOOP;
  UPDATE public.sla_rule_sets SET reason = p_reason, row_version = row_version + 1 WHERE id = s.id;
  PERFORM public.calc_audit('sla_rule_set_update', 'sla_rule_set', s.id::text, jsonb_build_object('rules', before),
    jsonb_build_object('rules', (SELECT coalesce(jsonb_agg(jsonb_build_object('task_code', value ->> 'task_code', 'min', value -> 'min_working_days', 'max', value -> 'max_working_days', 'start', value -> 'start_event', 'end', value -> 'end_event', 'pending_confirmation', value -> 'pending_confirmation')), '[]'::jsonb) FROM jsonb_array_elements(p_rules))), p_reason);
  RETURN s.id;
END $$;

CREATE OR REPLACE FUNCTION sla_item_changed(p_item public.sla_rule_set_items, p_against uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.sla_rule_set_items o
    WHERE o.set_id = p_against AND o.task_def_id = p_item.task_def_id AND o.min_working_days = p_item.min_working_days AND o.max_working_days = p_item.max_working_days
      AND o.start_ref = p_item.start_ref AND o.end_ref IS NOT DISTINCT FROM p_item.end_ref AND o.calendar_id = p_item.calendar_id AND o.overrides = p_item.overrides
      AND o.pending_confirmation = p_item.pending_confirmation)
$$;

-- As 0017, plus the pending flag copied to the rule rows.
CREATE OR REPLACE FUNCTION admin_publish_sla_rule_set(p_set uuid, p_effective date, p_reason text, p_apply boolean DEFAULT false, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sla_rule_sets%ROWTYPE; latest public.sla_rule_sets%ROWTYPE; today date := public.cal_today(); errs jsonb := '[]'::jsonb; regs integer[];
  i public.sla_rule_set_items%ROWTYPE; changed integer := 0; n integer := 0; o jsonb; actor uuid := public.app_actor();
BEGIN
  PERFORM public.calc_require_admin('sla_rules', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO s FROM public.sla_rule_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.calc_err('not_found'); END IF;
  IF s.status <> 'draft' THEN PERFORM public.calc_err('invalid_transition', jsonb_build_object('detail', 'Only the draft rule set can be published.')); END IF;
  IF p_version IS NOT NULL AND p_version <> s.row_version THEN PERFORM public.calc_err('precondition_failed'); END IF;
  SELECT * INTO latest FROM public.sla_rule_sets WHERE status = 'published' ORDER BY effective_from DESC, version DESC LIMIT 1;
  IF p_effective IS NULL OR p_effective < today THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'effective_date_in_past', 'message', 'The effective date cannot be earlier than today.'));
  ELSIF latest.id IS NOT NULL AND p_effective <= latest.effective_from THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/effective_date', 'code', 'effective_date_not_after_current', 'message', 'The effective date must be later than that of the latest published version.'));
  END IF;
  SELECT count(*) INTO changed FROM public.sla_rule_set_items x WHERE x.set_id = s.id AND (latest.id IS NULL OR public.sla_item_changed(x, latest.id));
  IF changed = 0 THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/', 'code', 'no_changes', 'message', 'The draft is equal to the version in force.')); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.calc_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  regs := public.app_actor_region_filter('sla_rules', 'edit');
  IF p_apply AND regs IS NOT NULL AND EXISTS (SELECT 1 FROM public.task_instances ti
       WHERE ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') AND NOT (ti.region_id = ANY (regs))
         AND EXISTS (SELECT 1 FROM public.sla_rule_set_items x WHERE x.set_id = s.id AND x.task_def_id = ti.task_def_id)) THEN
    RAISE EXCEPTION 'the change would be applied to open tasks outside your delegated regions' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.sla_rules SET effective_to = p_effective WHERE effective_to IS NULL AND task_def_id IN (SELECT task_def_id FROM public.sla_rule_set_items WHERE set_id = s.id);
  FOR i IN SELECT * FROM public.sla_rule_set_items WHERE set_id = s.id LOOP
    INSERT INTO public.sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, reason, changed_by, start_ref, end_ref, code, rule_set_id, pending_confirmation)
    VALUES (i.task_def_id, i.min_working_days, i.max_working_days, i.start_ref, NULL, NULL, i.calendar_id, p_effective, p_reason, actor, i.start_ref, i.end_ref, i.code, s.id, i.pending_confirmation);
    FOR o IN SELECT value FROM jsonb_array_elements(i.overrides) LOOP
      INSERT INTO public.sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, reason, changed_by, start_ref, end_ref, code, rule_set_id, pending_confirmation)
      VALUES (i.task_def_id, (o ->> 'min_working_days')::integer, (o ->> 'max_working_days')::integer, i.start_ref, (o ->> 'scenario')::"DeliveryScenario",
              (o ->> 'region_id')::integer, i.calendar_id, p_effective, p_reason, actor, i.start_ref, i.end_ref, i.code, s.id, i.pending_confirmation);
    END LOOP;
  END LOOP;
  IF latest.id IS NOT NULL THEN UPDATE public.sla_rule_sets SET effective_to = p_effective WHERE id = latest.id AND effective_to IS NULL; END IF;
  UPDATE public.sla_rule_sets SET status = 'published', effective_from = p_effective, published_by = actor, published_at = now(), reason = p_reason,
    apply_to_open_tasks = coalesce(p_apply, false), apply_pending = coalesce(p_apply, false) AND p_effective > today, row_version = row_version + 1
  WHERE id = s.id;
  IF coalesce(p_apply, false) AND p_effective <= today THEN n := public.sla_apply_set(s.id); END IF;
  UPDATE public.sla_rule_sets SET affected_open_tasks = n WHERE id = s.id;
  PERFORM public.calc_audit('sla_rule_set_publish', 'sla_rule_set', s.id::text, jsonb_build_object('version_in_force', latest.version),
    jsonb_build_object('version', s.version, 'effective_date', p_effective, 'apply_to_open_tasks', coalesce(p_apply, false), 'changed_tasks', changed, 'affected_open_tasks', n), p_reason);
  RETURN jsonb_build_object('set_id', s.id, 'version', s.version, 'affected_open_tasks', n);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q14: the 45 SLA sheet columns D:AV and the PMIS task that measures each one
-- ---------------------------------------------------------------------------------------------------------------------
-- task_code NULL = the column has no task of its own in the PMIS (an end-to-end figure or a Change Control window), the comparison computes it.
-- flag_condition: an extra site condition for the column (B-10a / B-10b split B10 by the Master O value RT / GF). inherited: the Master value is
-- kept for compatibility only and does not measure a real cycle (Q13: B-6 runs AR -> AR on analysis sites).
CREATE TABLE sla_master_columns (
  seq            INTEGER PRIMARY KEY,
  master_column  TEXT NOT NULL UNIQUE,
  sla_code       TEXT NOT NULL UNIQUE,
  name_en        TEXT NOT NULL,
  from_to        TEXT NOT NULL,
  applies_when   TEXT NOT NULL,
  task_code      TEXT,
  flag_condition TEXT,
  inherited      BOOLEAN NOT NULL DEFAULT false,
  note           TEXT
);
INSERT INTO sla_master_columns (seq, master_column, sla_code, name_en, from_to, applies_when, task_code, flag_condition, inherited, note) VALUES
  (1, 'D', 'A-1', 'Site Search (First SAR)', 'Search Ring Received → first Candidate Submitted (SAR)', 'Sites with a search ring', 'A1', NULL, false, NULL),
  (2, 'E', 'A-3', 'TSSR Approval', 'TSSR Submitted → TSSR Approved', 'All sites', 'A2', NULL, false, NULL),
  (3, 'F', 'B-2', 'PO / WO (Procurement Lead Time)', 'PR-PO: PR Date → PR-PO: PO / WO Date', 'CW scope · Outsourced', 'B2', NULL, false, NULL),
  (4, 'G', 'B-3', 'CW Access Permission', 'PR-PO: PO / WO Date → CW Access Date', 'CW scope', 'B3', NULL, false, NULL),
  (5, 'H', 'B-4', 'CW Survey', 'CW Access → CW Survey Actual', 'CW scope', 'B4', NULL, false, NULL),
  (6, 'I', 'B-5', 'STA / ST Analysis', 'CW Survey Actual → Report Submitted (Master AR)', 'CW scope and Analysis Type STA / ST', 'B5', NULL, false, NULL),
  (7, 'J', 'B-6', 'Layout Submission', 'Report Submitted (analysis sites) or CW Survey → Layout Submission (AR)', 'CW scope', 'B6', NULL, true,
     'Q13: the Master has one date (AR) for the report and the layout, so B-6 is 0 on analysis sites. Kept as a Master-compatible inherited value; the PMIS measures the Layout Submitted Date (end event task.layout_submitted_date) once a rule set uses it.'),
  (8, 'K', 'B-7', 'Layout Approval', 'Layout Submission → Approval', 'CW scope', 'B7', NULL, false, NULL),
  (9, 'L', 'B-8', 'Tower MOS', 'Layout Approval → CW MOS', 'Tower = Yes', 'B8', NULL, false, NULL),
  (10, 'M', 'B-9', 'Adaption MOS', 'Layout Approval → CW MOS', 'Adaption only', 'B9', NULL, false, NULL),
  (11, 'N', 'B-10a', 'Tower Erection RT (GMT)', 'CW MOS → CW Actual End', 'Tower = Yes and RT', 'B10', 'rt_or_gf=RT', false, 'Q14: one PMIS task (B10, rule B-10), two Master columns split by Master O.'),
  (12, 'O', 'B-10b', 'Tower Erection GF (SST)', 'CW MOS → CW Actual End', 'Tower = Yes and GF', 'B10', 'rt_or_gf=GF', false, 'Q14: one PMIS task (B10, rule B-10), two Master columns split by Master O.'),
  (13, 'P', 'B-11', 'Site Adaption', 'CW MOS → CW Actual End', 'Adaption only', 'B11', NULL, false, NULL),
  (14, 'Q', 'B-13', 'CW PAC', 'CW Completion Date → CW PAC Actual', 'CW scope', 'B13', NULL, false, NULL),
  (15, 'R', 'B-15', 'FAC', 'CW DLP End → CW FAC Actual', 'CW scope', 'B15', NULL, false, NULL),
  (16, 'S', 'C-2', 'GECOL (Power)', 'GECOL PR Date → GECOL Installation Finish', 'GECOL = Yes', 'C2', NULL, false, NULL),
  (17, 'T', 'C-4', 'HLC (Fiber)', 'HLC Request Date → HLC Installation Date', 'HLC = Yes', 'C4', NULL, false, 'Q136: ends at the installation date during the parallel run; hlc.in_service_date afterwards under a new rule-set version.'),
  (18, 'U', 'RFI', 'Site RFI', 'RFI Readiness → Site RFI', 'RFI applies; not Cold / Hot Swap', 'MS4', NULL, false, 'Q3: N/A for Hot / Cold Swap by scenario.'),
  (19, 'V', 'E2E-B1', 'Full CW · Adaption only', 'PR Date (Outsourced) / PO / WO Date (In-House) → CW PAC Actual', 'Adaption only', NULL, 'adaption_only', false, 'End to end, from B1 / B2 to B13.'),
  (20, 'W', 'E2E-B2', 'Full CW · with Tower RT', 'PR Date (Outsourced) / PO / WO Date (In-House) → CW PAC Actual', 'Tower = Yes and RT', NULL, 'rt_or_gf=RT', false, 'End to end, from B1 / B2 to B13.'),
  (21, 'X', 'E2E-B3', 'Full CW · with Tower GF', 'PR Date (Outsourced) / PO / WO Date (In-House) → CW PAC Actual', 'Tower = Yes and GF', NULL, 'rt_or_gf=GF', false, 'End to end, from B1 / B2 to B13.'),
  (22, 'Y', 'D-1', 'TE Access Permission', 'Site Release → TE Access Date', 'TE scope', 'D1', NULL, false, 'Q2: the PMIS starts D-1 at MS4, or MS1 when the Site RFI is N/A; not measured for Hot / Cold Swap. The comparison applies the same documented change.'),
  (23, 'Z', 'D-2', 'TE Survey', 'TE Access → TE Survey', 'TE scope', 'D2', NULL, false, NULL),
  (24, 'AA', 'D-3', 'DN Submission', 'TE Survey → DN Submitted', 'TE scope', 'D3', NULL, false, NULL),
  (25, 'AB', 'D-4', 'DN Approval', 'DN Submitted → DN Approved', 'TE scope', 'D4', NULL, false, NULL),
  (26, 'AC', 'D-5', 'TE MOS', 'TE Dispatch Complete → TE MOS Actual', 'TE scope', 'D5', NULL, false, NULL),
  (27, 'AD', 'D-6', 'TE Installation', 'TE MOS → TE Actual End', 'TE scope', 'D6', NULL, false, NULL),
  (28, 'AE', 'D-7', 'Commissioning', 'TE Actual End → Commissioning', 'TE scope', 'D7', NULL, false, NULL),
  (29, 'AF', 'D-8', 'MW Alignment', 'Commissioning → MW Alignment', 'TE scope with MW', 'D8', NULL, false, NULL),
  (30, 'AG', 'D-9', 'Integration', 'MW Alignment (Commissioning if no MW) → Integration', 'TE scope', 'D9', NULL, false, NULL),
  (31, 'AH', 'D-10', 'On-Air', 'Integration → On-Air Actual', 'TE scope', 'D10', NULL, false, NULL),
  (32, 'AI', 'D-11', 'SSV', 'On-Air → SSV', 'TE scope', 'D11', NULL, false, NULL),
  (33, 'AJ', 'D-12', 'HWID', 'On-Air → HWID', 'TE scope', 'D12', NULL, false, NULL),
  (34, 'AK', 'D-13', 'EIR', 'HWID → EIR', 'TE scope', 'D13', NULL, false, NULL),
  (35, 'AL', 'D-14', 'PAT', 'EIR → PAT', 'TE scope', 'D14', NULL, false, NULL),
  (36, 'AM', 'D-15', 'As-Built', 'PAT → As-Built', 'TE scope', 'D15', NULL, false, NULL),
  (37, 'AN', 'D-16', 'TE PAC', 'As-Built (and SSV) → TE PAC Actual', 'TE scope', 'D16', NULL, false, NULL),
  (38, 'AO', 'D-17', 'O&M Handover', 'KPI Acceptance → O&M Handover (HOTO)', 'TE scope', 'D17', NULL, false, NULL),
  (39, 'AP', 'E2E-D1', 'TE MOS to On-Air', 'TE MOS → On-Air Actual', 'TE scope', 'MS6', NULL, false, NULL),
  (40, 'AQ', 'E2E-D2', 'TE Access to O&M Handover', 'TE Access → O&M Handover', 'TE scope', 'MS9', NULL, false, NULL),
  (41, 'AR', 'S-1', 'MOP Approval', 'MOP Submitted → MOP Approved', 'Cold / Hot Swap', 'D10a', NULL, false, NULL),
  (42, 'AS', 'S-2', 'Window Approval', 'Change Control (Cutover Window): Request Date → Approval Date', 'Cold / Hot Swap', 'D10b', NULL, false, NULL),
  (43, 'AT', 'S-3', 'Hot Swap Window', 'Window Start → Window End', 'Hot Swap', NULL, NULL, false, 'A Change Control window, no task of its own.'),
  (44, 'AU', 'S-4', 'Cold Swap Window', 'Window Start → Window End', 'Cold Swap', NULL, NULL, false, 'A Change Control window, no task of its own.'),
  (45, 'AV', 'S-5', 'Legacy Dismantle', 'On-Air (cutover) → TE Dismantle Actual', 'Cold Swap', 'E2', NULL, false, NULL)
ON CONFLICT (seq) DO NOTHING;
ALTER TABLE sla_master_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_master_columns FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON sla_master_columns FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON sla_master_columns FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. D4b: tentative holidays inside an SLA period (the "tentative date" badge on the due date)
-- ---------------------------------------------------------------------------------------------------------------------
-- The tentative (not yet confirmed) holidays on working weekdays in (p_from, p_to] of the calendar. Empty when none. They count as holidays now.
CREATE OR REPLACE FUNCTION sla_tentative_holidays(p_cal uuid, p_from date, p_to date) RETURNS date[]
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(h.date ORDER BY h.date), ARRAY[]::date[])
  FROM public.holidays h
  WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND h.calendar_id = coalesce(p_cal, public.cal_default()) AND h.tentative AND h.confirmed_at IS NULL
    AND h.date > p_from AND h.date <= p_to AND NOT (extract(dow FROM h.date)::integer = ANY (public.cal_weekend(p_cal)))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Q180: suspension windows from the effective dates; gate_eval uses them
-- ---------------------------------------------------------------------------------------------------------------------
-- Every approved or applied suspension of the site, with the first approved or applied resumption whose effective date is later. Effective date =
-- suspension_start / resumption_date, else the approval date. The window is [suspended_from, resumed_on): the resumption day is a working day again.
-- retroactive: the effective date is earlier than the approval date (both dates are kept on the record). p_ref limits to suspensions that started
-- on or before it (NULL = all). Drafts and rejected requests never count.
CREATE OR REPLACE FUNCTION cc_suspension_windows(p_site uuid, p_ref date DEFAULT NULL)
RETURNS TABLE (suspension_id uuid, suspended_from date, suspension_approved date, resumption_id uuid, resumed_on date, resumption_approved date, retroactive boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH s AS (
    SELECT c.id, coalesce(c.suspension_start, c.approval_date) AS d, c.approval_date AS a
    FROM public.change_requests c
    WHERE c.site_id = p_site AND c.kind = 'suspension' AND c.status IN ('approved', 'applied') AND coalesce(c.suspension_start, c.approval_date) IS NOT NULL
  ), r AS (
    SELECT c.id, coalesce(c.resumption_date, c.approval_date) AS d, c.approval_date AS a
    FROM public.change_requests c
    WHERE c.site_id = p_site AND c.kind = 'resumption' AND c.status IN ('approved', 'applied') AND coalesce(c.resumption_date, c.approval_date) IS NOT NULL
  )
  SELECT s.id, s.d, s.a, rr.id, rr.d, rr.a, (s.a IS NOT NULL AND s.d < s.a) OR (rr.a IS NOT NULL AND rr.d < rr.a)
  FROM s LEFT JOIN LATERAL (SELECT r.id, r.d, r.a FROM r WHERE r.d > s.d ORDER BY r.d, r.id LIMIT 1) rr ON true
  WHERE p_ref IS NULL OR s.d <= p_ref
  ORDER BY s.d, s.id
$$;

-- As 0017, with the Change Control part on the effective-date windows (Q180): a candidate date inside a window moves to the resumption date (the
-- next window is checked again from there); inside a window that has no resumption the gate stays blocked.
CREATE OR REPLACE FUNCTION gate_eval(p_site uuid, p_gate text, OUT status text, OUT gate_date date, OUT base_date date, OUT shifted boolean, OUT reasons jsonb)
RETURNS record LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sites%ROWTYPE; g public.phase_gate_rules%ROWTYPE; m record; cond jsonb; g0 date; d date; nd date; i integer; rs jsonb; blocked boolean;
  ptype text; best date; b date; w record; k integer;
BEGIN
  reasons := '[]'::jsonb; shifted := false;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN status := 'na'; RETURN; END IF;
  SELECT * INTO g FROM public.phase_gate_rules WHERE workflow_id = s.workflow_version_id AND link_code = p_gate AND is_active;
  IF NOT FOUND THEN status := 'na'; RETURN; END IF;
  SELECT * INTO m FROM public.ms_resolve(p_site, g.from_code);
  IF m.state = 'na' THEN status := 'na'; RETURN; END IF;
  IF m.state = 'pending' THEN
    status := 'pending';
    reasons := jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', coalesce(m.stage_code, g.from_code),
      'message', 'The milestone ' || coalesce(m.stage_code, g.from_code) || ' has no date yet.', 'count', NULL));
    RETURN;
  END IF;
  g0 := m.ms_date; base_date := g0; d := g0;
  FOR i IN 1..20 LOOP
    nd := g0; blocked := false; rs := '[]'::jsonb;
    FOR cond IN SELECT * FROM jsonb_array_elements(coalesce(g.conditions, '[]'::jsonb)) LOOP
      ptype := cond ->> 'ref';
      IF cond ->> 'type' = 'permit' THEN
        IF coalesce((cond ->> 'accept_na')::boolean, true)
           AND EXISTS (SELECT 1 FROM public.permit_records pr WHERE pr.site_id = p_site AND pr.permit_type = ptype AND public.permit_na_ok(pr)) THEN
          CONTINUE;
        END IF;
        SELECT min(public.permit_start(pr)) INTO best FROM public.permit_records pr
        WHERE pr.site_id = p_site AND pr.permit_type = ptype AND public.permit_start(pr) IS NOT NULL
          AND public.permit_valid_on(pr, greatest(d, public.permit_start(pr)));
        IF best IS NULL THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', ptype,
            'message', ptype || ' must be approved and valid on the gate date.', 'count', NULL));
        ELSE
          nd := greatest(nd, best);
        END IF;
      ELSIF cond ->> 'type' = 'stop_work_blocks' THEN
        IF EXISTS (SELECT 1 FROM public.permit_records pr WHERE pr.site_id = p_site AND pr.permit_type = ptype AND pr.stop_work AND pr.stop_lifted_date IS NULL) THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'stop_work', 'ref_code', ptype, 'message', 'Stop work is active on ' || ptype || '.', 'count', NULL));
        END IF;
      ELSIF cond ->> 'type' = 'milestone' THEN
        SELECT * INTO m FROM public.ms_resolve(p_site, ptype);
        IF m.state = 'approved' THEN nd := greatest(nd, m.ms_date);
        ELSIF m.state = 'pending' THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', ptype, 'message', 'The milestone ' || ptype || ' has no date yet.', 'count', NULL));
        END IF;
      ELSIF cond ->> 'type' = 'task' THEN
        b := public.sla_task_date(p_site, ptype);
        IF b IS NULL THEN
          blocked := true;
          rs := rs || jsonb_build_array(jsonb_build_object('kind', 'predecessor_not_approved', 'ref_code', ptype, 'message', 'Task ' || ptype || ' is not approved yet.', 'count', NULL));
        ELSE nd := greatest(nd, b); END IF;
      ELSE
        blocked := true;
        rs := rs || jsonb_build_array(jsonb_build_object('kind', 'condition_not_met', 'ref_code', ptype, 'message', 'The condition type ' || coalesce(cond ->> 'type', '?') || ' is not supported.', 'count', NULL));
      END IF;
    END LOOP;
    EXIT WHEN nd = d;
    d := nd;
  END LOOP;
  reasons := rs;
  IF blocked THEN status := 'blocked'; RETURN; END IF;

  -- Change Control (rules.md section 2.3, Q180): the effective-date windows [suspended_from, resumed_on).
  FOR k IN 1..20 LOOP
    SELECT * INTO w FROM public.cc_suspension_windows(p_site, d) x
    WHERE x.suspended_from <= d AND (x.resumed_on IS NULL OR d < x.resumed_on)
    ORDER BY x.suspended_from DESC LIMIT 1;
    EXIT WHEN NOT FOUND;
    IF w.resumed_on IS NULL THEN
      status := 'blocked';
      reasons := reasons || jsonb_build_array(jsonb_build_object('kind', 'suspension', 'ref_code', NULL, 'message', 'The site is suspended since ' || w.suspended_from::text || ' and has no approved resumption.', 'count', NULL));
      RETURN;
    END IF;
    d := w.resumed_on; shifted := true;
  END LOOP;
  gate_date := d;
  status := 'open';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q9: the gate history (site_gate_events), written by calc_gate_watch
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE site_gate_state ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE site_gate_state ADD COLUMN IF NOT EXISTS gate_date DATE;

-- event  opened      the gate became open on gate_date
--        closed      an open gate is blocked or pending again (cause = the lock reasons); its earlier opening stays in the history
--        date_moved  an open gate has a new date (a condition date moved, a suspension shifted it); previous_date is the old one
CREATE TABLE site_gate_events (
  id            BIGSERIAL PRIMARY KEY,
  site_id       UUID NOT NULL REFERENCES sites (id) ON DELETE CASCADE ON UPDATE CASCADE,
  region_id     INTEGER NOT NULL,
  gate_code     TEXT NOT NULL,
  event         TEXT NOT NULL CHECK (event IN ('opened', 'closed', 'date_moved')),
  status        TEXT NOT NULL,
  gate_date     DATE,
  previous_date DATE,
  shifted       BOOLEAN NOT NULL DEFAULT false,
  cause         JSONB NOT NULL DEFAULT '[]'::jsonb,
  at            TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX site_gate_events_site ON site_gate_events (site_id, gate_code, id);
ALTER TABLE site_gate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_gate_events FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON site_gate_events FOR SELECT USING (app_region_check(region_id));
CREATE POLICY rls_seed_write ON site_gate_events FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- As 0018 (the Q81 alert when an open gate closes again is unchanged), plus the history of openings, closings and date moves (Q9).
CREATE OR REPLACE FUNCTION calc_gate_watch(p_site uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sites%ROWTYPE; g record; ev record; st record; is_open_ boolean; n integer := 0; rep uuid; open_n integer; site_code_ text; msgs text; found_ boolean;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR g IN SELECT r.link_code, r.to_code FROM public.phase_gate_rules r WHERE r.workflow_id = s.workflow_version_id AND r.is_active ORDER BY r.seq LOOP
    SELECT * INTO ev FROM public.gate_eval(p_site, g.link_code);
    is_open_ := ev.status IS DISTINCT FROM 'blocked';
    SELECT x.is_open, x.status, x.gate_date INTO st FROM public.site_gate_state x WHERE x.site_id = p_site AND x.gate_code = g.link_code;
    found_ := FOUND;
    -- Q9: the history
    IF ev.status = 'open' AND (NOT found_ OR st.status IS DISTINCT FROM 'open') THEN
      INSERT INTO public.site_gate_events (site_id, region_id, gate_code, event, status, gate_date, previous_date, shifted, cause)
      VALUES (p_site, s.region_id, g.link_code, 'opened', ev.status, ev.gate_date, CASE WHEN found_ THEN st.gate_date END, coalesce(ev.shifted, false), '[]'::jsonb);
    ELSIF ev.status = 'open' AND st.gate_date IS DISTINCT FROM ev.gate_date THEN
      INSERT INTO public.site_gate_events (site_id, region_id, gate_code, event, status, gate_date, previous_date, shifted, cause)
      VALUES (p_site, s.region_id, g.link_code, 'date_moved', ev.status, ev.gate_date, st.gate_date, coalesce(ev.shifted, false), '[]'::jsonb);
    ELSIF found_ AND st.status = 'open' AND ev.status IN ('blocked', 'pending') THEN
      INSERT INTO public.site_gate_events (site_id, region_id, gate_code, event, status, gate_date, previous_date, shifted, cause)
      VALUES (p_site, s.region_id, g.link_code, 'closed', ev.status, NULL, st.gate_date, false, coalesce(ev.reasons, '[]'::jsonb));
    END IF;
    IF NOT found_ THEN
      INSERT INTO public.site_gate_state (site_id, gate_code, is_open, status, gate_date) VALUES (p_site, g.link_code, is_open_, ev.status, ev.gate_date)
      ON CONFLICT (site_id, gate_code) DO NOTHING;
      CONTINUE;
    END IF;
    IF st.status IS DISTINCT FROM ev.status OR st.gate_date IS DISTINCT FROM ev.gate_date THEN
      UPDATE public.site_gate_state SET status = ev.status, gate_date = ev.gate_date WHERE site_id = p_site AND gate_code = g.link_code;
    END IF;
    CONTINUE WHEN st.is_open = is_open_;
    UPDATE public.site_gate_state SET is_open = is_open_, since = now() WHERE site_id = p_site AND gate_code = g.link_code;
    IF st.is_open AND NOT is_open_ THEN
      SELECT count(*), (array_agg(ti.id ORDER BY td.code))[1] INTO open_n, rep
      FROM public.task_instances ti
      JOIN public.task_definitions td ON td.id = ti.task_def_id
      JOIN public.stage_definitions sd ON sd.id = td.stage_id AND sd.workflow_id = s.workflow_version_id AND sd.code = g.to_code
      WHERE ti.site_id = p_site AND ti.state IN ('open', 'entry', 'in_review', 'in_approval', 'rejected', 'suspended') AND NOT public.gate_lock_exempt(td.code);
      IF open_n > 0 THEN
        SELECT string_agg(e ->> 'message', ' ') INTO msgs FROM jsonb_array_elements(coalesce(ev.reasons, '[]'::jsonb)) e;
        site_code_ := s.site_code;
        PERFORM public.calc_alert(rep, 'gate_closed_again', 'Gate ' || g.link_code || ' closed again on ' || site_code_,
          'Gate ' || g.link_code || ' closed again: ' || coalesce(msgs, ev.status) || ' ' || open_n || ' task(s) of the next stage are already open and stay open.');
        INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
        VALUES ('gate_closed_again', 'site', p_site::text, p_site, s.region_id, jsonb_build_object('gate', g.link_code, 'open', true),
                jsonb_build_object('gate', g.link_code, 'status', ev.status, 'reasons', coalesce(ev.reasons, '[]'::jsonb), 'open_tasks_kept_open', open_n),
                'the gate closed after it opened: open tasks are not re-locked (Q81)', public.app_actor());
        n := n + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Q3: the baseline proposal follows the scenario for the Site RFI (as 0017 otherwise)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION baseline_proposal(p_site uuid) RETURNS TABLE (milestone_code text, proposed_date date, d1_added boolean)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  s public.sites%ROWTYPE; c date; cal uuid := public.cal_default(); cw boolean; te boolean; rfi boolean; gecol boolean; hlc boolean; tower boolean; mw boolean; outsourced boolean; sta boolean;
  inc_d1 boolean; dd date; ee date; ff date; gg date; hh date; ii date; jj date; kk date; ll date; cwdlp integer; tedlp integer;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN; END IF;
  c := coalesce(
    (SELECT t.actual_date FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id
       WHERE t.site_id = p_site AND td.code = 'MS1' AND t.state = 'approved'),
    (SELECT t.planned_date FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE t.site_id = p_site AND td.code = 'MS1'),
    (SELECT be.baseline_date FROM public.baseline_entries be JOIN public.baseline_versions bv ON bv.id = be.version_id
       WHERE be.site_id = p_site AND be.milestone_code = 'MS1' AND be.baseline_date IS NOT NULL ORDER BY bv.version DESC LIMIT 1));
  IF c IS NULL THEN RETURN; END IF;
  tower := s.scope_tower_erection = 'yes';
  cw := tower OR s.scope_site_adaption = 'yes';
  gecol := s.scope_gecol_power = 'yes';
  hlc := s.scope_hlc_fiber = 'yes';
  rfi := public.site_rfi_applies(p_site);             -- Q3: the scenario first (N/A for Hot / Cold Swap), then the flags
  te := s.scope_te_full = 'yes' OR s.scope_te_ip_router_only = 'yes';
  outsourced := lower(coalesce(s.cw_delivery_model, '')) = 'outsourced';
  sta := EXISTS (SELECT 1 FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE t.site_id = p_site AND td.code = 'B5' AND t.state NOT IN ('na', 'skipped'));
  mw := EXISTS (SELECT 1 FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE t.site_id = p_site AND td.code = 'D8' AND t.state NOT IN ('na', 'skipped'));
  inc_d1 := coalesce((public.calc_setting('calc.baseline_include_d1', 'true'::jsonb) #>> '{}')::boolean, true);
  cwdlp := coalesce((public.calc_setting('dlp.months.cw', 'null'::jsonb) #>> '{}')::integer, 3);
  tedlp := coalesce((public.calc_setting('dlp.months.te', 'null'::jsonb) #>> '{}')::integer, 12);

  IF cw THEN dd := public.cal_add_workdays(c, coalesce(public.sla_max_wd(p_site, 'B1'), 0) + CASE WHEN outsourced THEN coalesce(public.sla_max_wd(p_site, 'B2'), 0) ELSE 0 END
      + coalesce(public.sla_max_wd(p_site, 'B3'), 0) + coalesce(public.sla_max_wd(p_site, 'B4'), 0) + CASE WHEN sta THEN coalesce(public.sla_max_wd(p_site, 'B5'), 0) ELSE 0 END
      + coalesce(public.sla_max_wd(p_site, 'B6'), 0) + coalesce(public.sla_max_wd(p_site, 'B7'), 0), cal);
  ELSE dd := c; END IF;
  IF cw THEN ee := public.cal_add_workdays(dd, CASE WHEN tower THEN coalesce(public.sla_max_wd(p_site, 'B8'), 0) + coalesce(public.sla_max_wd(p_site, 'B10'), 0)
                                                    ELSE coalesce(public.sla_max_wd(p_site, 'B9'), 0) + coalesce(public.sla_max_wd(p_site, 'B11'), 0) END, cal); END IF;
  IF rfi THEN
    ff := public.cal_add_workdays(greatest(
        CASE WHEN cw THEN public.cal_add_workdays(ee, coalesce(public.sla_max_wd(p_site, 'B13'), 0), cal) ELSE c END,
        CASE WHEN gecol THEN public.cal_add_workdays(c, coalesce(public.sla_max_wd(p_site, 'B1'), 0) + coalesce(public.sla_max_wd(p_site, 'C1'), 0) + coalesce(public.sla_max_wd(p_site, 'C2'), 0), cal) END,
        CASE WHEN hlc THEN public.cal_add_workdays(c, coalesce(public.sla_max_wd(p_site, 'B1'), 0) + coalesce(public.sla_max_wd(p_site, 'C3'), 0) + coalesce(public.sla_max_wd(p_site, 'C4'), 0), cal) END),
      coalesce(public.sla_max_wd(p_site, 'MS4'), 0), cal);
  END IF;
  IF te THEN
    gg := public.cal_add_workdays(CASE WHEN rfi THEN ff ELSE c END,
      CASE WHEN inc_d1 THEN coalesce(public.sla_max_wd(p_site, 'D1'), 0) ELSE 0 END + coalesce(public.sla_max_wd(p_site, 'D2'), 0) + coalesce(public.sla_max_wd(p_site, 'D3'), 0)
      + coalesce(public.sla_max_wd(p_site, 'D4'), 0) + coalesce(public.sla_max_wd(p_site, 'D4b'), 0) + coalesce(public.sla_max_wd(p_site, 'D5'), 0) + coalesce(public.sla_max_wd(p_site, 'D6'), 0), cal);
    hh := public.cal_add_workdays(gg, coalesce(public.sla_max_wd(p_site, 'D7'), 0) + CASE WHEN mw THEN coalesce(public.sla_max_wd(p_site, 'D8'), 0) ELSE 0 END
      + coalesce(public.sla_max_wd(p_site, 'D9'), 0) + coalesce(public.sla_max_wd(p_site, 'D10'), 0), cal);
    ii := public.cal_add_workdays(hh, greatest(coalesce(public.sla_max_wd(p_site, 'D11'), 0),
      coalesce(public.sla_max_wd(p_site, 'D12'), 0) + coalesce(public.sla_max_wd(p_site, 'D13'), 0) + coalesce(public.sla_max_wd(p_site, 'D14'), 0) + coalesce(public.sla_max_wd(p_site, 'D15'), 0))
      + coalesce(public.sla_max_wd(p_site, 'D16'), 0), cal);
    jj := public.cal_add_workdays(ii, coalesce(public.sla_max_wd(p_site, 'F1'), 0), cal);
    kk := public.cal_add_workdays(jj, coalesce(public.sla_max_wd(p_site, 'D17'), 0), cal);
  END IF;
  ll := public.cal_add_workdays(greatest(
      CASE WHEN cw THEN public.cal_add_workdays((public.cal_add_workdays(ee, coalesce(public.sla_max_wd(p_site, 'B13'), 0), cal) + make_interval(months => cwdlp))::date, coalesce(public.sla_max_wd(p_site, 'B15'), 0), cal) END,
      CASE WHEN te THEN public.cal_add_workdays((ii + make_interval(months => tedlp))::date, coalesce(public.sla_max_wd(p_site, 'D18'), 0), cal) END,
      kk), coalesce(public.sla_max_wd(p_site, 'Z1'), 0), cal);
  RETURN QUERY VALUES ('MS2', dd, false), ('MS3', ee, false), ('MS4', ff, false),
    ('MS5', gg, te AND inc_d1), ('MS6', hh, te AND inc_d1), ('MS7', ii, te AND inc_d1), ('MS8', jj, te AND inc_d1), ('MS9', kk, te AND inc_d1), ('MS10', ll, te AND inc_d1);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Ownership and rights. Writers are owned by pmis_definer (SECURITY DEFINER, fixed search_path); nothing new is executable by PUBLIC.
-- pmis_app reads the new tables and calls the readers and the audited admin functions only; it never writes the new tables.
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON scenario_task_rules, scenario_rule_state, site_scope_exceptions, sla_master_columns, site_gate_events, site_gate_state, change_requests,
  holidays, work_calendars, settings, sites, task_instances, task_definitions, stage_definitions, task_predecessors, workflow_definitions, hlc_records TO pmis_definer;
GRANT INSERT, UPDATE ON scenario_task_rules, scenario_rule_state, site_scope_exceptions TO pmis_definer;
GRANT INSERT ON site_gate_events TO pmis_definer;
GRANT USAGE ON SEQUENCE site_gate_events_id_seq TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON site_gate_state TO pmis_definer;
GRANT INSERT ON audit_log TO pmis_definer;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
             'site_flag', 'site_task_rule', 'site_rfi_applies', 'scope_scenario_conflicts', 'site_applicability', 'wf_apply_applicability_core',
             'admin_apply_applicability', 'admin_save_scope_exception', 'admin_revoke_scope_exception', 'admin_save_scenario_rules', 'sla_end_ref_valid',
             'sla_task_measured', 'task_value_date', 'task_values_guard', 'sla_tentative_holidays', 'cc_suspension_windows'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF f.proname = ANY (ARRAY['wf_apply_applicability_core', 'admin_apply_applicability', 'admin_save_scope_exception', 'admin_revoke_scope_exception',
                              'admin_save_scenario_rules']) THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
               'site_flag', 'site_task_rule', 'site_rfi_applies', 'scope_scenario_conflicts', 'site_applicability', 'admin_apply_applicability',
               'admin_save_scope_exception', 'admin_revoke_scope_exception', 'admin_save_scenario_rules', 'sla_end_ref_valid', 'sla_task_measured',
               'task_value_date', 'sla_tentative_holidays', 'cc_suspension_windows'])
    LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig); END LOOP;
    GRANT SELECT ON scenario_task_rules, scenario_rule_state, site_scope_exceptions, sla_master_columns, site_gate_events TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON scenario_task_rules, scenario_rule_state, site_scope_exceptions, sla_master_columns, site_gate_events FROM pmis_app;
    REVOKE ALL ON SEQUENCE site_gate_events_id_seq FROM pmis_app;
  END IF;
END $$;
