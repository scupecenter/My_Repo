-- Settings screens (migration 0072, Q440 and Q441; contract 0.14.2). The setting calendar.official_confirmed is confirmed and withdrawn only through
-- admin_set_calendar_confirmation (a System Admin, or a delegate of settings edit for all regions; reason, If-Match, audited); the setting mail.notification_kinds
-- only through admin_save_mail_kinds (a System Admin only, reason, step-up, If-Match, audited; unknown and security-reserved kinds refused). The application role writes
-- neither setting directly, cannot call the internal helpers (the ETag, the catalogue, the reserved-kind test, the lead finder and the region-move notice), and the new
-- functions have the same shape as every other writer. Alice: CW Team Lead in Tripoli, not a System Admin. DEL_ALL: a delegate of users and assignments rights for all
-- regions, without any settings right.

-- ---------------------------------------------------------------------------------------------------------------------
-- No direct write to the two settings
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SCR-01
-- @title Alice switches the official calendar confirmation on by a direct update (the settings policies keep her out: no row changes)
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = 'true'::jsonb WHERE key = 'calendar.official_confirmed' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case SCR-02
-- @title The System Admin sets the mail notification kinds by a direct update: the policies allow an administrator, the trigger of 0072 does not (no reason, no step-up, no audit row)
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = '["task_assigned"]'::jsonb WHERE key = 'mail.notification_kinds';
-- @end

-- @case SCR-03
-- @title The System Admin confirms the official calendar by a direct update
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = 'true'::jsonb, updated_by = NULL WHERE key = 'calendar.official_confirmed';
-- @end

-- @case SCR-04
-- @title The System Admin deletes the setting of the calendar confirmation
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM settings WHERE key = 'calendar.official_confirmed';
-- @end

-- @case SCR-05
-- @title The System Admin inserts the mail notification kinds row again with another value (a conflict path)
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO settings (key, value, updated_at) VALUES ('mail.notification_kinds', '["mention"]'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case SCR-05R
-- @title The System Admin renames the mail notification kinds row away (the default then applies with no reason, step-up or audit row): the update trigger looks at the old key too
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET key = 'mail.notification_kinds_old' WHERE key = 'mail.notification_kinds';
-- @end

-- @case SCR-06
-- @title Alice inserts a settings row
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 row-level security
INSERT INTO settings (key, value, updated_at) VALUES ('mail.notification_kinds_copy', '[]'::jsonb, now());
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The calendar confirmation: who may, and what is checked
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SCR-10
-- @title Alice confirms the official calendar: she holds no settings right
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_set_calendar_confirmation(true, 'I am sure the dates are official', NULL);
-- @end

-- @case SCR-11
-- @title A delegate without a settings right confirms the official calendar
-- @category settings-screens
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 admin path
SELECT admin_set_calendar_confirmation(true, 'Delegate without the right', NULL);
-- @end

-- @case SCR-12
-- @title Alice forges app.user_id with the System Admin's id and an all-regions setting: she stays Alice
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT admin_set_calendar_confirmation(true, 'Forged administrator', NULL);
-- @end

-- @case SCR-13
-- @title Nobody signed in confirms the calendar
-- @category settings-screens
-- @expect error 42501 admin path
SELECT admin_set_calendar_confirmation(true, 'Nobody is signed in', NULL);
-- @end

-- @case SCR-14
-- @title With no context, a forged user id of the System Admin confirms nothing
-- @category settings-screens
-- @actor none
-- @region *
-- @expect error 42501 admin path
SET app.user_id = '{{ADMIN}}';
SELECT admin_set_calendar_confirmation(true, 'Forged user id', NULL);
-- @end

-- @case SCR-15
-- @title The System Admin confirms without a reason
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT admin_set_calendar_confirmation(true, '  ', NULL);
-- @end

-- @case SCR-16
-- @title The System Admin withdraws a confirmation that does not exist (the calendar is not confirmed)
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error P0001 invalid_transition
SELECT admin_set_calendar_confirmation(false, 'Nothing to withdraw', NULL);
-- @end

-- @case SCR-17
-- @title The System Admin confirms with a stale version
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT admin_set_calendar_confirmation(true, 'Stale tag', 2147483647);
-- @end

-- @case SCR-18
-- @title The System Admin confirms while the fixture holidays are tentative or missing for the current or the next year: refused with the blocker
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error P0001 (tentative_remaining|no_holidays)
SELECT admin_set_calendar_confirmation(true, 'Too early to confirm', NULL);
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The mail notification kinds: System Admin only, step-up, reason
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SCR-20
-- @title Alice reads the mail notification kinds
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SELECT mail_kinds_json();
-- @end

-- @case SCR-21
-- @title Alice saves the mail notification kinds
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, 'I would like the mails', NULL);
-- @end

-- @case SCR-22
-- @title A delegate (users and assignments rights for all regions) saves the mail notification kinds: only a System Admin may
-- @category settings-screens
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 System Admin only
SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, 'Delegate', NULL);
-- @end

-- @case SCR-23
-- @title Alice forges app.user_id with the System Admin's id and a step-up: she stays Alice
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SET app.stepup = 'true';
SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, 'Forged administrator', NULL);
-- @end

-- @case SCR-24
-- @title Nobody signed in saves the mail notification kinds
-- @category settings-screens
-- @expect error 42501 System Admin only
SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, 'Nobody is signed in', NULL);
-- @end

-- @case SCR-25
-- @title The System Admin saves without a reason
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, '', NULL);
-- @end

-- @case SCR-26
-- @title The System Admin saves without a verified step-up; a forged step-up setting does not give one
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SET app.stepup = 'true';
SET app.stepup_until = '2999-01-01';
SELECT admin_save_mail_kinds('["task_assigned"]'::jsonb, 'No verified step-up', NULL);
-- @end

-- @case SCR-27
-- @title Control: the System Admin reads the setting with its catalogue (28 kinds, 6 recommended, no reserved kind) and the ETag
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect output 28|6|0|true
SELECT jsonb_array_length(j -> 'catalogue') || '|'
  || (SELECT count(*) FROM jsonb_array_elements(j -> 'catalogue') c WHERE (c ->> 'recommended')::boolean) || '|'
  || (SELECT count(*) FROM jsonb_array_elements(j -> 'catalogue') c WHERE c ->> 'kind' ~ '^(security_|integrity_|audit_integrity|break_glass|retention_)') || '|'
  || ((j ->> 'version')::int >= 0)::text
FROM (SELECT mail_kinds_json() AS j) x;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The helpers are closed to the application role
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SCR-30
-- @title Alice calls the ETag helper
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT settings_etag('mail.notification_kinds');
-- @end

-- @case SCR-31
-- @title Alice calls the kind catalogue
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT mail_kind_catalogue();
-- @end

-- @case SCR-32
-- @title Alice calls the reserved-kind test
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT mail_kind_reserved('task_assigned');
-- @end

-- @case SCR-33
-- @title Alice asks who holds the reassign grant of a region
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT ss_holds_reassign('{{ALICE}}', 1);
-- @end

-- @case SCR-34
-- @title The System Admin sends the region-move notice by hand: no path around the approved Change Control proposal
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT ss_notify_region_move('{{SITE_TRI}}', 1, 5, '00000000-0000-4000-8000-000000000999');
-- @end

-- @case SCR-35
-- @title The System Admin runs the RF & Design feed by hand on a record: the feed runs only when a record is approved
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT p4a_feed_rf('00000000-0000-4000-8000-000000000999');
-- @end

-- @case SCR-36
-- @title Alice writes a notice of the new kind into the inbox of the Team Lead by hand
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO notifications (user_id, channel, kind, title, body) VALUES ('{{BOB}}', 'in_app', 'site_region_moved', 'Forged notice', 'x');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Controls and the shape of the functions
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SCR-90
-- @title Control: Alice reads the confirmation state (she may not edit); the banner is shown to everybody
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect output false|false
SELECT (cal_confirmation_json() ->> 'can_edit') || '|' || (cal_confirmation_json() ->> 'confirmed');
-- @end

-- @case SCR-91
-- @title Control: for the System Admin the same state says can_edit
-- @category settings-screens
-- @actor ADMIN
-- @region *
-- @expect output true
SELECT cal_confirmation_json() ->> 'can_edit';
-- @end

-- @case SCR-92
-- @title Every function of migration 0072 is SECURITY DEFINER with a fixed search path, owned by pmis_definer, closed to PUBLIC; the application role has the four entry points only
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('settings_etag', 'cal_confirmation_json', 'admin_set_calendar_confirmation', 'mail_kind_catalogue', 'mail_kind_reserved', 'mail_kinds_json',
                    'admin_save_mail_kinds', 'p4a_feed_rf', 'ss_holds_reassign', 'ss_notify_region_move', 'si_apply_identity')
  AND NOT (p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer' AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
           AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
           AND (has_function_privilege('pmis_app', p.oid, 'EXECUTE')
                = (p.proname IN ('cal_confirmation_json', 'admin_set_calendar_confirmation', 'mail_kinds_json', 'admin_save_mail_kinds'))));
-- @end

-- @case SCR-93
-- @title Control: Alice's direct update of the mail notification kinds changes no row (the settings policies keep her out)
-- @category settings-screens
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = '["mention"]'::jsonb WHERE key = 'mail.notification_kinds' RETURNING 1) SELECT count(*) FROM u;
-- @end
