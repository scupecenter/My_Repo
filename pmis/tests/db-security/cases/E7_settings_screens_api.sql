-- Settings screens on the real API (migration 0145, contract 0.15.59): DLP versions, the idle-task alert, the notification policy and the holidays import.
-- dlp_versions is written only by admin_publish_dlp; the settings notifications.policy and tasks.idle_alert only by their doors (settings_guarded_keys of 0072);
-- every door needs a System Admin or a delegate of admin.settings (calendars for the holidays) edit for all regions and a reason; the DLP door and the security
-- and system rows of the policy need a step-up. Alice: CW Team Lead in Tripoli, not a System Admin. DEL_ALL: a delegate of the System Admin for users, assignments
-- and groups (not settings). ADMIN: the System Admin. "\ctx ADMIN stepup=300" is a System Admin whose step-up is valid for five minutes. Each case is rolled back.

-- @case SSA-01
-- @title The System Admin writes the notification policy directly (no reason, no checks, no audit row)
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO settings (key, value, updated_at) VALUES ('notifications.policy', '{"enabled": false, "version": 99}'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case SSA-02
-- @title The System Admin writes the idle-task alert switch directly
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO settings (key, value, updated_at) VALUES ('tasks.idle_alert', '{"enabled": false, "version": 99}'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case SSA-03
-- @title The System Admin renames the saved policy row away after a legitimate save: the update trigger looks at the old key too
-- @category settings-screens-api
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT admin_set_notification_policy((p - 'version' - 'updated_at' - 'updated_by') || '{"digest_hour": 9}'::jsonb, 'A legitimate save first', NULL)
FROM notification_policy_json() p;
UPDATE settings SET key = 'notifications.policy_old' WHERE key = 'notifications.policy';
-- @end

-- @case SSA-04
-- @title Alice inserts a DLP version directly
-- @category settings-screens-api
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO dlp_versions (version, cw_months, te_months, effective_from) VALUES (99, 0, 0, DATE '2020-01-01');
-- @end

-- @case SSA-05
-- @title The System Admin rewrites the seeded DLP version directly (it would change the DLP of PACs already issued)
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE dlp_versions SET te_months = 1 WHERE version = 1;
-- @end

-- @case SSA-06
-- @title Alice publishes a DLP version with a forged all-regions setting
-- @category settings-screens-api
-- @actor ALICE
-- @region *
-- @expect error 42501
SELECT admin_publish_dlp('{"cw_months": 1, "te_months": 1, "effective_from": "2035-01-01"}'::jsonb, 'Forged change');
-- @end

-- @case SSA-07
-- @title The System Admin publishes a DLP version without a step-up
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT admin_publish_dlp(jsonb_build_object('cw_months', 4, 'te_months', 12, 'effective_from', cal_today()), 'No step-up');
-- @end

-- @case SSA-08
-- @title The System Admin with a step-up back-dates a DLP version (it would change PACs already issued)
-- @category settings-screens-api
-- @expect error P0001 wf:validation_failed.*in_the_past
\ctx ADMIN stepup=300
SELECT admin_publish_dlp(jsonb_build_object('cw_months', 4, 'te_months', 12, 'effective_from', cal_today() - 1), 'Back-dated');
-- @end

-- @case SSA-09
-- @title A delegate without a settings right saves the notification policy
-- @category settings-screens-api
-- @actor DEL_ALL
-- @region *
-- @expect error 42501
SELECT admin_set_notification_policy('{"enabled": true}'::jsonb, 'Not my right', NULL);
-- @end

-- @case SSA-10
-- @title Alice reads the notification policy and its catalogue
-- @category settings-screens-api
-- @actor ALICE
-- @region 1
-- @expect error 42501
SELECT notification_catalogue_json();
SELECT notification_policy_json();
-- @end

-- @case SSA-11
-- @title The System Admin saves the policy with an unknown key
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:validation_failed.*"unknown_key", "path": "/colour"
SELECT admin_set_notification_policy((p - 'version' - 'updated_at' - 'updated_by') || '{"colour": "red"}'::jsonb, 'Unknown key', NULL)
FROM notification_policy_json() p;
-- @end

-- @case SSA-12
-- @title The System Admin puts the escalation before the reminder (cross-field rule)
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:validation_failed.*must_exceed_remind_hours
SELECT admin_set_notification_policy((p - 'version' - 'updated_at' - 'updated_by')
  || jsonb_build_object('thresholds', (p -> 'thresholds') || '{"approval_remind_hours": 120, "approval_escalate_days": 5}'::jsonb), 'Escalate first', NULL)
FROM notification_policy_json() p;
-- @end

-- @case SSA-13
-- @title The System Admin without a step-up raises the rate cap that feeds the security types
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT admin_set_notification_policy((p - 'version' - 'updated_at' - 'updated_by')
  || jsonb_build_object('thresholds', (p -> 'thresholds') || '{"rate_cap_per_hour": 99}'::jsonb), 'Raise the cap', NULL)
FROM notification_policy_json() p;
-- @end

-- @case SSA-14
-- @title The System Admin with a step-up switches off the e-mail of a mandatory security type
-- @category settings-screens-api
-- @expect error P0001 wf:validation_failed.*mandatory_locked
\ctx ADMIN stepup=300
SELECT admin_set_notification_policy((p - 'version' - 'updated_at' - 'updated_by')
  || jsonb_build_object('matrix', (SELECT jsonb_agg(CASE WHEN r ->> 'type_code' = 'audit_integrity_failure'
                                                         THEN jsonb_set(r, '{channels,email}', 'false'::jsonb) ELSE r END) FROM jsonb_array_elements(p -> 'matrix') r)),
  'Silence the integrity alert', NULL)
FROM notification_policy_json() p;
-- @end

-- @case SSA-15
-- @title Alice changes the idle-task alert and imports holidays with a forged all-regions setting
-- @category settings-screens-api
-- @actor ALICE
-- @region *
-- @expect error 42501
SELECT admin_set_idle_task_alert('{"enabled": false, "working_days": 30}'::jsonb, 'Forged change', NULL);
SELECT admin_import_holidays('[{"line": 2, "date": "2034-01-01", "name_en": "Forged", "kind": "national"}]'::jsonb, 'Forged import', '{}'::jsonb);
-- @end

-- @case SSA-16
-- @title Alice calls the internal helpers of the policy and of the DLP
-- @category settings-screens-api
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT notif_policy_view(NULL), notif_catalogue(), notif_admins_group(), sla_resolve_start_pre_0145(gen_random_uuid(), 'OPEN');
-- @end

-- @case SSA-17
-- @title A session without a verified context reads the DLP settings and the idle-task alert
-- @category settings-screens-api
-- @actor none
-- @expect error 42501
SET LOCAL app.user_id = '00000000-0000-4000-8000-00000000a001';
SELECT dlp_settings_json();
SELECT idle_task_alert_json();
-- @end

-- @case SSA-18
-- @title The System Admin imports a holiday file with a bad row: nothing is added
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error P0001 wf:validation_failed.*/rows/3/date
SELECT admin_import_holidays('[{"line": 2, "date": "2034-01-01", "name_en": "Good row", "kind": "national", "tentative": "no"},
                               {"line": 3, "date": "2034-02-30", "name_en": "Bad date", "kind": "national", "tentative": "no"}]'::jsonb, 'Bad file', '{}'::jsonb);
-- @end

-- @case SSA-21
-- @title The System Admin without a step-up switches the whole policy off (security review 2026-11-23: the switch is protected)
-- @category settings-screens-api
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT admin_set_notification_policy((p - 'version' - 'updated_at' - 'updated_by') || '{"enabled": false}'::jsonb, 'Silence everything', NULL)
FROM notification_policy_json() p;
-- @end

-- @case SSA-22
-- @title A delegate of settings edit for all regions switches the policy off or moves the digest hour: only a System Admin may
-- @category settings-screens-api
-- @expect error P0001 delegate_forbidden
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"admin.settings","action":"edit"}]'::jsonb, true, NULL, NULL, NULL, false, NULL, 'Settings delegate');
\ctx DEL_TRI stepup=300
SELECT admin_set_notification_policy((p - 'version' - 'updated_at' - 'updated_by') || '{"enabled": false, "digest_hour": 3}'::jsonb, 'Delegate silences it', NULL)
FROM notification_policy_json() p;
-- @end

-- @case SSA-23
-- @title The System Admin with a step-up removes the System Admins column (the mandatory types would lose their recipients)
-- @category settings-screens-api
-- @expect error P0001 wf:validation_failed.*mandatory_locked
\ctx ADMIN stepup=300
SELECT admin_set_notification_policy((p - 'version' - 'updated_at' - 'updated_by')
  || jsonb_build_object('columns', (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements(p -> 'columns') c WHERE c ->> 'kind' <> 'group'),
                        'matrix', (SELECT jsonb_agg(r || jsonb_build_object('cells', '[]'::jsonb)) FROM jsonb_array_elements(p -> 'matrix') r)),
  'Drop the System Admins', NULL)
FROM notification_policy_json() p;
-- @end

-- @case SSA-19
-- @title Control: Alice reads the DLP in force (version 1, CW 3, TE 12) and the idle-task alert (on, 2 working days)
-- @category settings-screens-api
-- @actor ALICE
-- @region 1
-- @expect output 1|3|12|true|2
SELECT concat_ws('|', d -> 'current' ->> 'version', d -> 'current' ->> 'cw_months', d -> 'current' ->> 'te_months', i ->> 'enabled', i ->> 'working_days')
FROM dlp_settings_json() d, idle_task_alert_json() i;
-- @end

-- @case SSA-20
-- @title Control: the shape of the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked), the doors of pmis_app, the table rights
-- @category settings-screens-api
-- @actor ALICE
-- @region 1
-- @expect output 18|10|0
SELECT concat_ws('|',
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('ssa_iso_date', 'dlp_months_at', 'dlp_version_json', 'dlp_settings_json', 'admin_publish_dlp', 'sla_resolve_start',
       'idle_task_alert_json', 'admin_set_idle_task_alert', 'notif_catalogue', 'notif_require_reader', 'notification_catalogue_json', 'notif_admins_group', 'notif_policy_view',
       'notification_policy_json', 'notif_int_err', 'admin_set_notification_policy', 'tpl_holidays_columns', 'admin_import_holidays')
     AND (p.prosecdef OR p.proname = 'tpl_holidays_columns') AND pg_get_userbyid(p.proowner) = 'pmis_definer'
     AND (p.proconfig::text LIKE '%pg_temp%' OR p.proname = 'tpl_holidays_columns') AND NOT has_function_privilege('public', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('dlp_months_at', 'dlp_settings_json', 'admin_publish_dlp', 'sla_resolve_start', 'idle_task_alert_json',
       'admin_set_idle_task_alert', 'notification_catalogue_json', 'notification_policy_json', 'admin_set_notification_policy', 'admin_import_holidays')
     AND has_function_privilege('pmis_app', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM information_schema.table_privileges WHERE grantee = 'pmis_app' AND table_name = 'dlp_versions' AND privilege_type <> 'SELECT'));
-- @end
