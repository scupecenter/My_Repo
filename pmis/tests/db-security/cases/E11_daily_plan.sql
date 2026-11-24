-- My Work > Daily Plan (plan W7, migration 0149, contract 0.15.67): daily_plans and daily_plan_rows have row security by region and no right for pmis_app; every
-- write goes through the doors dp_save_row, dp_add_site, dp_remove_site, dp_lock, dp_unlock (admin override: reason and step-up) and
-- admin_set_daily_plan_settings; the setting daily_plan.settings is a guarded key. Alice: CW Team Lead in Tripoli with an entry assignment on the Site Register,
-- not a holder of the Matrix row daily_plan (its seed names the roles Site Engineers CW/TE and CW/TE Team Lead, which Alice's fixture role is not). ADMIN: the
-- System Admin. "\ctx ADMIN stepup=300" is a System Admin whose step-up is valid for five minutes. Each case is rolled back.

-- @case DP-01
-- @title Alice inserts a plan of Tripoli directly (around the doors, no audit)
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO daily_plans (region_id, plan_date) VALUES (1, DATE '2026-03-01');
-- @end

-- @case DP-02
-- @title The System Admin unlocks a plan by a direct update of the table
-- @category daily-plan
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE daily_plans SET locked_at = NULL, lock_kind = NULL;
-- @end

-- @case DP-03
-- @title Alice reads the stored rows of the plans directly
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT * FROM daily_plan_rows;
-- @end

-- @case DP-04
-- @title The System Admin rewrites a row of a plan directly (a manual value without its audit row)
-- @category daily-plan
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE daily_plan_rows SET reason = 'forged';
-- @end

-- @case DP-05
-- @title Alice, with no view right and not an L1 holder of the Daily Plan, changes a row of the Tripoli plan through the door
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:action_forbidden
SELECT dp_save_row(1, DATE '2026-03-01', gen_random_uuid(), '{"remark": "forged"}'::jsonb, NULL);
-- @end

-- @case DP-06
-- @title Alice adds a site to the Tripoli plan
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:action_forbidden
SELECT dp_add_site(1, DATE '2026-03-01', 'ANY-SITE', NULL);
-- @end

-- @case DP-07
-- @title Alice, not an L2 holder, locks the Tripoli plan
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:action_forbidden
SELECT dp_lock(1, DATE '2026-03-01', NULL);
-- @end

-- @case DP-08
-- @title Alice reopens a day locked by the System Admin (the unlock is an admin override)
-- @category daily-plan
-- @expect error P0001 wf:action_forbidden
\ctx ADMIN stepup=300
SELECT dp_lock(1, DATE '2026-03-01', NULL);
\ctx ALICE
SELECT dp_unlock(1, DATE '2026-03-01', 'Alice reopens it', NULL);
-- @end

-- @case DP-09
-- @title The System Admin reopens a locked day without a step-up
-- @category daily-plan
-- @expect error P0001 step_up_required
\ctx ADMIN stepup=300
SELECT dp_lock(1, DATE '2026-03-01', NULL);
\ctx ADMIN
SELECT dp_unlock(1, DATE '2026-03-01', 'No step-up', NULL);
-- @end

-- @case DP-10
-- @title The System Admin with a step-up reopens a locked day without a reason
-- @category daily-plan
-- @expect error P0001 wf:validation_failed.*reason
\ctx ADMIN stepup=300
SELECT dp_lock(1, DATE '2026-03-01', NULL);
SELECT dp_unlock(1, DATE '2026-03-01', ' ', NULL);
-- @end

-- @case DP-11
-- @title The System Admin changes a row of a locked day (read-only except through the override)
-- @category daily-plan
-- @expect error P0001 wf:plan_locked
\ctx ADMIN stepup=300
SELECT dp_lock(1, DATE '2026-03-01', NULL);
SELECT dp_add_site(1, DATE '2026-03-01', 'ANY-SITE', NULL);
-- @end

-- @case DP-12
-- @title Alice with a forged all-regions setting changes the Benghazi plan (not visible: answered as not found)
-- @category daily-plan
-- @actor ALICE
-- @region *
-- @expect error P0001 wf:not_found
SELECT dp_lock(5, DATE '2026-03-01', NULL);
-- @end

-- @case DP-13
-- @title A stale version is refused under the row lock
-- @category daily-plan
-- @expect error P0001 wf:precondition_failed
\ctx ADMIN stepup=300
SELECT dp_lock(1, DATE '2026-03-02', 0);
SELECT dp_unlock(1, DATE '2026-03-02', 'Reopen with an old version', 0);
-- @end

-- @case DP-14
-- @title The System Admin writes the setting daily_plan.settings directly (no reason, no checks, no audit row)
-- @category daily-plan
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO settings (key, value, updated_at) VALUES ('daily_plan.settings', '{"auto_lock_time": "00:00", "version": 99}'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case DP-15
-- @title Alice changes the Daily Plan settings with a forged all-regions setting
-- @category daily-plan
-- @actor ALICE
-- @region *
-- @expect error 42501
SELECT admin_set_daily_plan_settings('{"columns": {"progress": ["site_code"], "tomorrow": ["site_code"]}, "default_region_scope": "all", "auto_lock_time": null, "reminder_hour": null}'::jsonb,
  'Forged change', NULL);
-- @end

-- @case DP-16
-- @title The settings with an unknown key and a column that does not exist
-- @category daily-plan
-- @expect error P0001 wf:validation_failed.*unknown_key.*unknown_column|wf:validation_failed.*unknown_column.*unknown_key
\ctx ADMIN stepup=300
SELECT admin_set_daily_plan_settings('{"columns": {"progress": ["site_code", "salary"], "tomorrow": ["site_code"]}, "default_region_scope": "all", "auto_lock_time": null, "reminder_hour": null, "send_mail": true}'::jsonb,
  'Bad body', NULL);
-- @end

-- @case DP-17
-- @title Alice calls the internal helpers (freeze, the auto values, the holders, the header for a change)
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT dp_freeze(gen_random_uuid(), 1, DATE '2026-03-01');
-- @end

-- @case DP-18
-- @title Alice reads the holders of the Daily Plan row of a region through the internal helper
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT * FROM dp_holders(1, 'entry');
-- @end

-- @case DP-19
-- @title A session without a verified context reads the plans
-- @category daily-plan
-- @expect error 42501 no signed-in actor
SELECT daily_plan_json(DATE '2026-03-01', NULL);
-- @end

-- @case DP-20
-- @title Alice, with Tripoli in her scope but no view on Daily Plan or Sites (her assignment has no profile), reads the Tripoli plan (security review 2026-11-24: gate parity)
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:action_forbidden
SELECT daily_plan_json(DATE '2026-03-01', ARRAY[1]);
-- @end

-- @case DP-23
-- @title Alice, with no view on Daily Plan or Sites, exports the Tripoli plan
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:action_forbidden
SELECT dp_export_json(DATE '2026-03-01', ARRAY[1], NULL);
-- @end

-- @case DP-24
-- @title Alice, once given Sites view for Tripoli only (a delegation, no export), exports the Tripoli plan
-- @category daily-plan
-- @expect error P0001 wf:action_forbidden.*export
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{ALICE}}', NULL, NULL, false, '[{"module":"sites","action":"view"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sites view, Tripoli');
\ctx ALICE
SELECT dp_export_json(DATE '2026-03-01', ARRAY[1], NULL);
-- @end

-- @case DP-25
-- @title Control: Alice with Sites view for Tripoli reads the Tripoli plan (version 0, not editable: no L1 of the Matrix row) and the default columns of the settings
-- @category daily-plan
-- @expect output 1|1|0|false|14
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{ALICE}}', NULL, NULL, false, '[{"module":"sites","action":"view"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sites view, Tripoli');
\ctx ALICE
SELECT concat_ws('|', jsonb_array_length(d -> 'plans'), d -> 'plans' -> 0 ->> 'region_id', d -> 'plans' -> 0 ->> 'version', d -> 'plans' -> 0 ->> 'can_edit',
  jsonb_array_length(s -> 'columns' -> 'progress'))
FROM daily_plan_json(DATE '2026-03-01', ARRAY[1]) d, dp_settings_json() s;
-- @end

-- @case DP-26
-- @title Alice with Sites view for Tripoli (the read is open to her) but not an L1 holder of the Matrix row changes a row
-- @category daily-plan
-- @expect error P0001 wf:action_forbidden.*L1 holders
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{ALICE}}', NULL, NULL, false, '[{"module":"sites","action":"view"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sites view, Tripoli');
\ctx ALICE
SELECT dp_save_row(1, DATE '2026-03-01', gen_random_uuid(), '{"remark": "forged"}'::jsonb, NULL);
-- @end

-- @case DP-21
-- @title Control: the System Admin with a step-up locks and reopens a day (one audit row flagged admin override)
-- @category daily-plan
-- @expect output false|1|manual
\ctx ADMIN stepup=300
SELECT dp_lock(1, DATE '2026-03-03', 0) -> 'plans' -> 0 ->> 'locked';
SELECT dp_unlock(1, DATE '2026-03-03', 'Control reopen', 1) -> 'plans' -> 0 ->> 'locked';
SELECT concat_ws('|', daily_plan_json(DATE '2026-03-03', ARRAY[1]) -> 'plans' -> 0 ->> 'locked',
  (SELECT count(*) FROM audit_log WHERE action = 'daily_plan.unlocked' AND is_admin_override AND reason = 'Control reopen'),
  (SELECT after ->> 'lock_kind' FROM audit_log WHERE action = 'daily_plan.locked' AND region_id = 1 AND after ->> 'plan_date' = '2026-03-03' ORDER BY id DESC LIMIT 1));
-- @end

-- @case DP-22
-- @title Control: the shape of the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked), the doors of pmis_app, no table right
-- @category daily-plan
-- @actor ALICE
-- @region 1
-- @expect output 32|10|0
SELECT concat_ws('|',
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('dp_right', 'dp_columns_default', 'dp_columns_known', 'dp_override_keys', 'dp_cfg', 'dp_settings_json', 'admin_set_daily_plan_settings',
       'dp_holders', 'dp_holds', 'dp_may_unlock', 'dp_count_lines', 'dp_site_auto', 'dp_auto_sites', 'dp_row_json', 'dp_live_rows', 'dp_rows', 'dp_plan_head', 'daily_plan_json',
       'dp_for_change', 'dp_require_entry', 'dp_stored', 'dp_touch', 'dp_audit_row', 'dp_save_row', 'dp_add_site', 'dp_remove_site', 'dp_freeze', 'dp_lock', 'dp_unlock',
       'dp_export_json', 'dp_local_now', 'dp_tick')
     AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer' AND p.proconfig::text LIKE '%pg_temp%' AND NOT has_function_privilege('public', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('dp_settings_json', 'admin_set_daily_plan_settings', 'daily_plan_json', 'dp_save_row', 'dp_add_site', 'dp_remove_site',
       'dp_lock', 'dp_unlock', 'dp_export_json', 'dp_tick') AND has_function_privilege('pmis_app', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM information_schema.table_privileges WHERE grantee = 'pmis_app' AND table_name IN ('daily_plans', 'daily_plan_rows')));
-- @end
