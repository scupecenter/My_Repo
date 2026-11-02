-- Synthetic sites for the dashboard suites (fictional data only). Run as the superuser, outside the application.
-- dash_seed_sites(n, prefix): n sites spread over the 7 regions, each with every task of workflow v1 at a different progress level (0 to 10 milestones
-- done), baselines, a few issues, snags and blocked gates. Triggers are off while it loads (the calculation layer is not under test here).
-- All dates are relative to cal_today(), so the data never depends on the weekday of the run.
CREATE OR REPLACE FUNCTION dash_seed_sites(p_n integer, p_prefix text) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  wf uuid; bv uuid; today date := cal_today(); n integer := 0; i integer; lvl integer; reg integer; sid uuid; code_ text; st_date date; d0 date;
  ver integer; party uuid;
BEGIN
  SET LOCAL session_replication_role = replica;
  SELECT id INTO wf FROM workflow_definitions WHERE version = 1;
  SELECT coalesce(max(version), 0) + 1 INTO ver FROM baseline_versions;
  INSERT INTO baseline_versions (version, label, status, approved_at) VALUES (ver, p_prefix || ' baseline', 'approved', now()) RETURNING id INTO bv;
  SELECT id INTO party FROM external_parties ORDER BY name LIMIT 1;
  IF party IS NULL THEN INSERT INTO external_parties (name, type) VALUES ('A&T Global (test)', 'te_vendor') RETURNING id INTO party; END IF;
  FOR i IN 1..p_n LOOP
    reg := 1 + (i % 7);
    lvl := i % 11;
    code_ := p_prefix || '-' || lpad(i::text, 5, '0');
    INSERT INTO sites (site_code, name, region_id, workflow_version_id, delivery_scenario, overall_status, scope_tower_erection, scope_site_adaption, scope_gecol_power, scope_hlc_fiber, scope_te_full, updated_at)
    VALUES (code_, 'Site ' || code_, reg, wf, CASE WHEN i % 10 = 0 THEN 'expansion' ELSE 'new_build' END::"DeliveryScenario",
            CASE WHEN i % 37 = 0 THEN 'cancelled' ELSE 'in_progress' END::"OverallStatus", 'yes', 'yes', 'yes', 'yes', 'yes', now()) RETURNING id INTO sid;
    -- stage s is done on day (today - (11 - s) * 7 - 3)
    INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, due_date, sla_rule_id, sla_start_date, sla_target_date, sla_end_date, sla_elapsed_wd,
                                return_count, is_na, external_party_id, updated_at)
    SELECT sid, reg, td.id,
      (CASE WHEN sd.seq <= lvl THEN 'approved' WHEN sd.seq = lvl + 1 THEN (CASE WHEN td.sort_order % 20 = 0 THEN 'in_review' ELSE 'open' END) ELSE 'locked' END)::"TaskState",
      CASE WHEN sd.seq = lvl + 1 THEN 1 ELSE 0 END, 3,
      CASE WHEN sd.seq <= lvl THEN today - (11 - sd.seq) * 7 - 3 END,
      CASE WHEN sd.seq <= lvl THEN today - (11 - sd.seq) * 7 - 3 END,
      CASE WHEN sd.seq = lvl + 1 THEN today + ((i % 9) - 6) END,
      (SELECT r.id FROM sla_rules r WHERE r.task_def_id = td.id LIMIT 1),
      CASE WHEN sd.seq <= lvl + 1 THEN today - (11 - greatest(sd.seq - 1, 0)) * 7 - 3 END,
      CASE WHEN sd.seq = lvl + 1 THEN today + ((i % 9) - 8) END,
      CASE WHEN sd.seq <= lvl THEN today - (11 - sd.seq) * 7 - 3 END,
      CASE WHEN sd.seq <= lvl THEN (i + td.sort_order) % 9 END,
      CASE WHEN sd.seq <= lvl THEN (i % 4 = 0)::int ELSE 0 END,
      false, CASE WHEN td.code IN ('D2', 'D3', 'D5') THEN party END, now()
    FROM task_definitions td JOIN stage_definitions sd ON sd.id = td.stage_id WHERE td.workflow_id = wf AND td.is_active;
    -- expansion sites: PRE-CW and CW do not apply
    IF i % 10 = 0 THEN
      UPDATE task_instances t SET state = 'na', is_na = true, actual_date = NULL, approved_date = NULL, sla_start_date = NULL, due_date = NULL, sla_elapsed_wd = NULL, sla_end_date = NULL
      FROM task_definitions td JOIN stage_definitions sd ON sd.id = td.stage_id WHERE t.site_id = sid AND td.id = t.task_def_id AND sd.seq IN (2, 3);
    END IF;
    -- baselines: the milestone date shifted by -2..+2 days; every 13th site has none
    IF i % 13 <> 0 THEN
      INSERT INTO baseline_entries (version_id, site_id, region_id, milestone_code, baseline_date)
      SELECT bv, sid, reg, sd.code, today - (11 - sd.seq) * 7 - 3 + ((i + sd.seq) % 5) - 2 FROM stage_definitions sd WHERE sd.workflow_id = wf;
    END IF;
    -- an issue on every 8th site, owned by a person or a party
    IF i % 8 = 0 THEN
      INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, external_party_id, approved_at, current_level)
      VALUES (gen_random_uuid(), 1, 'issues', sid, reg, 'approved', true,
        jsonb_build_object('pending_issue', 'Test issue ' || i, 'raised_date', (today - (i % 40))::text, 'issue_status', CASE WHEN i % 16 = 0 THEN 'Closed' ELSE 'Open' END,
                           'blocked_gate_or_task', CASE WHEN i % 24 = 0 THEN 'G4' ELSE '' END),
        CASE WHEN i % 3 = 0 THEN party END, now(), 3);
    END IF;
    -- a blocked gate on every 17th site that sits between milestones 2 and 8
    IF i % 17 = 0 AND lvl BETWEEN 2 AND 8 THEN
      INSERT INTO site_gate_state (site_id, gate_code, is_open, since) VALUES (sid, 'G' || (lvl + 1), false, now() - make_interval(days => i % 20));
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
