-- Follow-up group A of the technical decisions of 2026-11-04 (migration 0066): Q300 the database refuses an overlapping assignment, Q303 an approved
-- email change ends the user's sessions, Q307 log_audit_write takes the admin-override flag, Q292 the list TeamSpecialization mirrors the table of
-- team specializations. Alice holds one assignment (CW Team Lead, entry, Tripoli, module sites); Bob and Carol hold none.
-- A refusal comes from the deferred trigger at "SET CONSTRAINTS ALL IMMEDIATE", exactly as a commit would fire it.

-- ---------------------------------------------------------------------------------------------------------------------
-- Q300: overlapping assignments
-- ---------------------------------------------------------------------------------------------------------------------
-- @case FA-01
-- @title The System Admin gives Alice the same role again for the same region and module (open dates)
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect error 23P01 overlaps assignment
SELECT idm_assign('{{ALICE}}', '{{ROLE_CW}}', 'approve', 'cw', NULL, NULL, false, false, ARRAY[1], false, ARRAY['sites'], NULL, 'Same scope again');
-- @end

-- @case FA-02
-- @title The same role in another region is independent (a second row is allowed)
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output 2
SELECT idm_assign('{{ALICE}}', '{{ROLE_CW}}', 'entry', 'cw', NULL, NULL, false, false, ARRAY[5], false, ARRAY['sites'], NULL, 'Other region');
SELECT count(*) FROM user_role_assignments WHERE user_id = '{{ALICE}}' AND role_id = '{{ROLE_CW}}';
-- @end

-- @case FA-03
-- @title The same role in the same region for another module is independent
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output 2
SELECT idm_assign('{{ALICE}}', '{{ROLE_CW}}', 'entry', 'cw', NULL, NULL, false, false, ARRAY[1], false, ARRAY['procurement'], NULL, 'Other module');
SELECT count(*) FROM user_role_assignments WHERE user_id = '{{ALICE}}' AND role_id = '{{ROLE_CW}}';
-- @end

-- @case FA-04
-- @title Two rows of Bob for the same scope with dates that do not overlap are allowed
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output 2
SELECT idm_assign('{{BOB}}', '{{ROLE_CW}}', 'entry', 'cw', now(), now() + interval '10 days', false, false, ARRAY[1], false, ARRAY['sites'], NULL, 'First period');
SELECT idm_assign('{{BOB}}', '{{ROLE_CW}}', 'entry', 'cw', now() + interval '10 days', now() + interval '20 days', false, false, ARRAY[1], false, ARRAY['sites'], NULL, 'Next period');
SELECT count(*) FROM user_role_assignments WHERE user_id = '{{BOB}}' AND role_id = '{{ROLE_CW}}';
-- @end

-- @case FA-05
-- @title Two rows of Bob for the same scope with overlapping dates
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect error 23P01 overlaps assignment
SELECT idm_assign('{{BOB}}', '{{ROLE_CW}}', 'entry', 'cw', now(), now() + interval '10 days', false, false, ARRAY[1], false, ARRAY['sites'], NULL, 'First period');
SELECT idm_assign('{{BOB}}', '{{ROLE_CW}}', 'view', 'cw', now() + interval '5 days', now() + interval '20 days', false, false, ARRAY[1, 5], false, ARRAY['sites'], NULL, 'Overlapping period');
-- @end

-- @case FA-06
-- @title A sub-module key counts as its top-level module (sites.tasks shares sites)
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect error 23P01 overlaps assignment
SELECT idm_assign('{{ALICE}}', '{{ROLE_CW}}', 'entry', 'cw', NULL, NULL, false, false, ARRAY[1], false, ARRAY['sites.tasks'], NULL, 'Sub-module of the held module');
-- @end

-- @case FA-07
-- @title A row with all regions and all modules shares everything with Alice's row
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect error 23P01 overlaps assignment
SELECT idm_assign('{{ALICE}}', '{{ROLE_CW}}', 'entry', 'cw', NULL, NULL, false, true, NULL, true, NULL, NULL, 'Everything');
-- @end

-- @case FA-08
-- @title Adding a region to a row so that it reaches the region of another row of the same role
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect error 23P01 overlaps assignment
DO $$
DECLARE x uuid;
BEGIN
  x := idm_assign('{{ALICE}}', '{{ROLE_CW}}', 'entry', 'cw', NULL, NULL, false, false, ARRAY[5], false, ARRAY['sites'], NULL, 'Other region');
  PERFORM idm_update_assignment(x, NULL, NULL, NULL, NULL, ARRAY[1, 5], NULL, NULL, NULL, 'Widened to Tripoli');
END $$;
-- @end

-- @case FA-09
-- @title An ended row is not checked: end Alice's row, then give her the same scope again
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output 2
SELECT idm_end_assignment((SELECT id FROM user_role_assignments WHERE user_id = '{{ALICE}}' AND role_id = '{{ROLE_CW}}'), 'Replaced');
SELECT idm_assign('{{ALICE}}', '{{ROLE_CW}}', 'approve', 'cw', NULL, NULL, false, false, ARRAY[1], false, ARRAY['sites'], NULL, 'Replacement');
SELECT count(*) FROM user_role_assignments WHERE user_id = '{{ALICE}}' AND role_id = '{{ROLE_CW}}';
-- @end

-- @case FA-10
-- @title A different role of the same person does not overlap (Carol holds two roles with the same scope)
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output 2
SELECT idm_assign('{{CAROL}}', '{{ROLE_CW}}', 'entry', 'cw', NULL, NULL, false, false, ARRAY[1], false, ARRAY['sites'], NULL, 'Role one');
SELECT idm_assign('{{CAROL}}', '{{ROLE_TE}}', 'entry', 'te', NULL, NULL, false, false, ARRAY[1], false, ARRAY['sites'], NULL, 'Role two');
SELECT count(*) FROM user_role_assignments WHERE user_id = '{{CAROL}}';
-- @end

-- @case FA-11
-- @title Alice runs the overlap report (internal, not granted to the application role)
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT assignment_overlaps_log();
-- @end

-- @case FA-12
-- @title Alice calls the overlap test of two rows directly
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT assignment_rows_overlap(gen_random_uuid(), gen_random_uuid());
-- @end

-- @case FA-13
-- @title Alice calls the trigger function directly
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT assignment_overlap_check();
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Q307: log_audit_write with the admin-override flag
-- ---------------------------------------------------------------------------------------------------------------------
-- @case FA-20
-- @title Alice marks an audit row as an admin override
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect error 42501 only a System Admin or a delegate
SELECT log_audit_write('fa_probe', 'setting', 'x', NULL, NULL, 'probe', NULL, NULL, NULL, true);
-- @end

-- @case FA-21
-- @title The System Admin writes an audit row with the flag: it is listed as an admin override
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output t
SELECT log_audit_write('fa_probe', 'setting', 'x', NULL, NULL, 'probe', NULL, NULL, NULL, true) AS nid \gset
SELECT is_admin_override FROM audit_log WHERE id = :nid;
-- @end

-- @case FA-22
-- @title The nine-argument call still works and leaves the flag off
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output f
SELECT log_audit_write('fa_probe', 'setting', 'x', NULL, NULL, 'probe', NULL, NULL, NULL) AS nid \gset
SELECT is_admin_override FROM audit_log WHERE id = :nid;
-- @end

-- @case FA-23
-- @title Alice's own audit row through the six-argument call keeps working (flag off)
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect output f
SELECT log_audit_write('fa_probe', 'setting', 'x', NULL, NULL, 'probe') AS nid \gset
SELECT is_admin_override FROM audit_log WHERE id = :nid;
-- @end

-- @case FA-24
-- @title A delegate may set the flag
-- @category followup-a
-- @actor DEL_ALL
-- @region *
-- @expect output t
SELECT log_audit_write('fa_probe', 'setting', 'x', NULL, NULL, 'probe', NULL, NULL, NULL, true) AS nid \gset
SELECT is_admin_override FROM audit_log WHERE id = :nid;
-- @end

-- @case FA-25
-- @title The System Admin's phone decision on Bob is listed as an admin override
-- @category followup-a
-- @actor BOB
-- @region 1
-- @expect output t
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE fa25 AS SELECT idm_request_phone_change('+218910000071') AS id;
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_phone_change((SELECT id FROM fa25), true, 'Confirmed in person');
SELECT is_admin_override FROM audit_log WHERE action = 'phone_changed' AND entity_id = '{{BOB}}' ORDER BY id DESC LIMIT 1;
-- @end

-- @case FA-26
-- @title The System Admin's email decision on Bob is listed as an admin override
-- @category followup-a
-- @actor BOB
-- @region 1
-- @expect output t
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE fa26 AS SELECT idm_request_email_change('bob.override@example.test') AS id;
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_email_change((SELECT id FROM fa26), false, 'Not this address');
SELECT is_admin_override FROM audit_log WHERE action = 'email_change_rejected' AND entity_id = '{{BOB}}' ORDER BY id DESC LIMIT 1;
-- @end

-- @case FA-27
-- @title Turning two-factor off for Bob as an admin is listed as an admin override
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output t
SELECT idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
SELECT idm_set_two_factor('{{BOB}}', false, 'Policy test');
SELECT is_admin_override FROM audit_log WHERE action = 'two_factor_disabled' AND entity_id = '{{BOB}}' ORDER BY id DESC LIMIT 1;
-- @end

-- @case FA-28
-- @title Bob's own profile change is not an admin override
-- @category followup-a
-- @actor BOB
-- @region 1
-- @expect output f
SELECT idm_update_own_profile('{"display_name": "Bob Synthetic Two"}'::jsonb);
SELECT is_admin_override FROM audit_log WHERE action = 'profile_updated' AND entity_id = '{{BOB}}' ORDER BY id DESC LIMIT 1;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Q303: an approved email change ends the sessions; a phone change keeps them
-- ---------------------------------------------------------------------------------------------------------------------
-- @case FA-30
-- @title An approved email change signs Bob out everywhere
-- @category followup-a
-- @actor BOB
-- @region 1
-- @expect output 0
SELECT auth_local_result('{{BOB}}', true);
SELECT auth_session_create('{{BOB}}', repeat('a', 64), 'local'::"AuthMethod", repeat('c', 43), NULL, 'fa test');
CREATE TEMP TABLE fa30 AS SELECT idm_request_email_change('bob.sessions@example.test') AS id;
SELECT idm_email_change_set_verification((SELECT id FROM fa30), repeat('d', 64));
SELECT idm_email_change_verify(repeat('d', 64));
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_email_change((SELECT id FROM fa30), true, 'Verified address', NULL);
SET app.user_id = '{{BOB}}';
SELECT count(*) FROM user_sessions WHERE user_id = '{{BOB}}' AND revoked_at IS NULL;
-- @end

-- @case FA-31
-- @title The same approval gives Bob a security notice
-- @category followup-a
-- @actor BOB
-- @region 1
-- @expect output 1
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE fa31 AS SELECT idm_request_email_change('bob.notice@example.test') AS id;
SELECT idm_email_change_set_verification((SELECT id FROM fa31), repeat('e', 64));
SELECT idm_email_change_verify(repeat('e', 64));
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_email_change((SELECT id FROM fa31), true, 'Verified address', NULL);
SET app.user_id = '{{BOB}}';
SELECT count(*) FROM notifications WHERE user_id = '{{BOB}}' AND kind = 'security_notice';
-- @end

-- @case FA-32
-- @title A rejected email change keeps Bob's session
-- @category followup-a
-- @actor BOB
-- @region 1
-- @expect output 1
SELECT auth_local_result('{{BOB}}', true);
SELECT auth_session_create('{{BOB}}', repeat('a', 64), 'local'::"AuthMethod", repeat('c', 43), NULL, 'fa test');
CREATE TEMP TABLE fa32 AS SELECT idm_request_email_change('bob.rejected@example.test') AS id;
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_email_change((SELECT id FROM fa32), false, 'Not this address');
SELECT count(*) FROM user_sessions WHERE user_id = '{{BOB}}' AND revoked_at IS NULL;
-- @end

-- @case FA-33
-- @title An approved phone change keeps Bob's session
-- @category followup-a
-- @actor BOB
-- @region 1
-- @expect output 1
SELECT auth_local_result('{{BOB}}', true);
SELECT auth_session_create('{{BOB}}', repeat('a', 64), 'local'::"AuthMethod", repeat('c', 43), NULL, 'fa test');
CREATE TEMP TABLE fa33 AS SELECT idm_request_phone_change('+218910000072') AS id;
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_phone_change((SELECT id FROM fa33), true, 'Confirmed in person');
SELECT count(*) FROM user_sessions WHERE user_id = '{{BOB}}' AND revoked_at IS NULL;
-- @end

-- @case FA-34
-- @title Alice approves Bob's email change (no right to decide)
-- @category followup-a
-- @actor BOB
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE fa34 AS SELECT idm_request_email_change('bob.alice@example.test') AS id;
SET app.user_id = '{{ALICE}}';
SELECT idm_decide_email_change((SELECT id FROM fa34), true, 'Looks fine', 'I know Bob');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Q292: the list TeamSpecialization mirrors team_specializations
-- ---------------------------------------------------------------------------------------------------------------------
-- @case FA-40
-- @title The System Admin adds a value to the mirrored list
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect error P0001 managed_elsewhere
SELECT admin_save_list_value('TeamSpecialization', NULL, '{"code": "Civil"}'::jsonb, 'A new specialization');
-- @end

-- @case FA-41
-- @title The System Admin renames a value of the mirrored list
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect error P0001 managed_elsewhere
SELECT admin_save_list_value('TeamSpecialization', (SELECT id FROM list_values WHERE catalogue_code = 'TeamSpecialization' AND code = 'Fiber'),
  '{"label_en": "Fibre"}'::jsonb, 'Spelling');
-- @end

-- @case FA-42
-- @title Alice (no right on lists) edits a value of the mirrored list
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering fields.edit required
SELECT admin_save_list_value('TeamSpecialization', NULL, '{"code": "Civil"}'::jsonb, 'A new specialization');
-- @end

-- @case FA-43
-- @title Alice writes the values of the mirrored list directly
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE list_values SET is_active = false WHERE catalogue_code = 'TeamSpecialization';
-- @end

-- @case FA-44
-- @title Alice writes the table of team specializations directly
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE team_specializations SET func_groups = ARRAY['TE'] WHERE code = 'TOWER_RT';
-- @end

-- @case FA-45
-- @title Alice runs the sync of the mirrored list
-- @category followup-a
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT team_spec_sync_list();
-- @end

-- @case FA-46
-- @title The groups are as decided: Dismantle is CW and TE, Fiber has none, Tower RT is CW, TE is TE
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output DISMANTLE:CW,TE|FIBER:|TE:TE|TOWER_RT:CW
SELECT string_agg(code || ':' || array_to_string(func_groups, ','), '|' ORDER BY code) FROM team_specializations WHERE code IN ('DISMANTLE', 'FIBER', 'TOWER_RT', 'TE');
-- @end

-- @case FA-47
-- @title The list mirrors the table (no value differs from its specialization)
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output 0
SELECT count(*) FROM team_specializations t JOIN list_values v ON v.catalogue_code = 'TeamSpecialization' AND v.code = t.list_code
WHERE (v.label_en, v.groups, v.is_active, v.sort_order) IS DISTINCT FROM (t.label_en, t.func_groups, t.is_active, t.sort_order);
-- @end

-- @case FA-48
-- @title Another list is still edited as before (positive control)
-- @category followup-a
-- @actor ADMIN
-- @region *
-- @expect output 1
SELECT (admin_save_list_value('ActionStatus', NULL, '{"code": "Parked"}'::jsonb, 'Probe of the follow-up'))->>'version';
-- @end
