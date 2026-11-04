-- Migration 0052 (work package P1, owner answers of 2026-11-04): scenario applicability rules, scope exceptions, the Master SLA sheet column map, the
-- gate history, the pending flag of an SLA rule and the Layout Submitted Date. The application role reads the new tables but never writes them; the
-- writers are admin_save_scenario_rules, admin_save_scope_exception, admin_revoke_scope_exception, admin_apply_applicability (System Admin or a delegate
-- of task_definitions edit, a reason, audited) and calc_gate_watch (the calculation layer). The core applicability function is not callable at all.
-- Alice holds one CW entry assignment in Tripoli (region 1); she is not an admin and holds no delegation.

-- @case P1-01
-- @title Alice plants a scenario rule that makes every CW task N/A on New Build sites
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO scenario_task_rules (workflow_id, task_code, scenario, rule, reason)
SELECT id, 'B1', 'new_build', 'na', 'security case' FROM workflow_definitions LIMIT 1;
-- @end

-- @case P1-02
-- @title Alice retires every scenario rule, so a Swap site keeps A1, A3 and the Site RFI
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE scenario_task_rules SET is_active = false;
-- @end

-- @case P1-03
-- @title Alice bumps the version counter of the rule list (a stale screen could then overwrite the rules)
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE scenario_rule_state SET version = version + 1;
-- @end

-- @case P1-04
-- @title Alice replaces the scenario rules through the admin function
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_save_scenario_rules('[]'::jsonb, 'security case P1-04', NULL);
-- @end

-- @case P1-05
-- @title Alice writes a scope exception for her own site directly (enabling a task the scenario makes N/A)
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO site_scope_exceptions (site_id, region_id, task_code, reason, approved_by)
VALUES ('{{SITE_TRI}}', 1, 'A1', 'security case', '{{ALICE}}');
-- @end

-- @case P1-06
-- @title Alice approves a scope exception through the admin function
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_save_scope_exception('{{SITE_TRI}}', 'MS4', NULL, 'security case P1-06');
-- @end

-- @case P1-07
-- @title Alice applies the scope of her site (sets tasks N/A) without being an admin
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_apply_applicability('{{SITE_TRI}}', 'security case P1-07');
-- @end

-- @case P1-08
-- @title Alice calls the core applicability function, which has no admin check of its own
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT wf_apply_applicability_core('{{SITE_TRI}}', 'security case P1-08');
-- @end

-- @case P1-09
-- @title Alice forges a gate opening in the history
-- @category p1-gates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO site_gate_events (site_id, region_id, gate_code, event, status, gate_date) VALUES ('{{SITE_TRI}}', 1, 'G3', 'opened', 'open', DATE '2026-01-01');
-- @end

-- @case P1-10
-- @title Alice erases the gate history of her site (an earlier opening must stay)
-- @category p1-gates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM site_gate_events WHERE site_id = '{{SITE_TRI}}';
-- @end

-- @case P1-11
-- @title Alice takes the next id of the gate history sequence
-- @category p1-gates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT nextval('site_gate_events_id_seq');
-- @end

-- @case P1-12
-- @title Alice reads the gate history of a Benghazi site (her assignment covers Tripoli only)
-- @category p1-gates
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM site_gate_events WHERE site_id = '{{SITE_BEN}}';
-- @end

-- @case P1-13
-- @title Alice reads the scope exceptions of a Benghazi site
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM site_scope_exceptions WHERE site_id = '{{SITE_BEN}}';
-- @end

-- @case P1-14
-- @title Alice runs the gate watch herself (it writes the history and the alerts as the definer)
-- @category p1-gates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT calc_gate_watch('{{SITE_TRI}}');
-- @end

-- @case P1-15
-- @title Alice untags B-6 as inherited in the SLA sheet column map (the parallel run would compare it as a real cycle)
-- @category p1-sla
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sla_master_columns SET inherited = false WHERE sla_code = 'B-6';
-- @end

-- @case P1-16
-- @title Alice clears "Pending SLA Confirmation" on C-3, so the inherited value counts in the scorecard
-- @category p1-sla
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sla_rules SET pending_confirmation = false WHERE pending_confirmation;
-- @end

-- @case P1-17
-- @title Alice moves the end event of C-4 to the in-service date in the rule-set items directly
-- @category p1-sla
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sla_rule_set_items SET end_ref = 'hlc.in_service_date';
-- @end

-- @case P1-18
-- @title Alice writes a Layout Submitted Date on a task directly (task values are written only by the engine)
-- @category p1-sla
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE task_instances SET values = jsonb_build_object('layout_submitted_date', '2026-01-02') WHERE site_id = '{{SITE_TRI}}';
-- @end

-- @case P1-19
-- @title Alice marks the official holiday calendar confirmed (the settings policies keep her out: no row changes)
-- @category p1-calendar
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = 'true' WHERE key = 'calendar.official_confirmed' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case P1-20
-- @title The application role can read the scenario rules and the column map (read-only, not hidden)
-- @category p1-scenario
-- @actor ALICE
-- @region 1
-- @expect output >= 1
SELECT count(*) FROM scenario_task_rules s JOIN sla_master_columns c ON c.task_code = s.task_code WHERE s.is_active;
-- @end
