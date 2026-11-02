-- Self-service profile (migration 0044, ADR 0014 amendment 2). A user changes only their own display name, phone, language and theme,
-- only through idm_update_own_profile; an email change is a request that only a System Admin, or a delegate holding users.edit for all
-- regions, decides, never on their own account and a delegate never for an admin; two-factor self enrolment and self disable work on the
-- signed-in user's own row and session only, and self disable is refused while an admin enforces it. pmis_app has no right on
-- email_change_requests or user_totp.

-- @case SP-01
-- @title Alice reads every email change request directly
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT new_email FROM email_change_requests;
-- @end

-- @case SP-02
-- @title Alice writes an approved email change request for herself directly
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO email_change_requests (user_id, old_email, new_email, status, decided_at, decision_reason)
VALUES ('{{ALICE}}', 'alice.sec@example.test', 'alice.new@example.test', 'approved', now(), 'self');
-- @end

-- @case SP-03
-- @title Alice changes Bob's display name directly
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE users SET display_name = 'Hacked' WHERE id = '{{BOB}}';
-- @end

-- @case SP-04
-- @title Alice changes her own login email directly (skipping the approval)
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE users SET email = 'alice.mine@example.test' WHERE id = '{{ALICE}}';
-- @end

-- @case SP-05
-- @title Alice changes her own display name directly (skipping the audited function)
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE users SET display_name = 'Alice Unaudited' WHERE id = '{{ALICE}}';
-- @end

-- @case SP-06
-- @title Alice clears the "enforced by admin" flag on her own two-factor row
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE user_totp SET enforced = false WHERE user_id = '{{ALICE}}';
-- @end

-- @case SP-07
-- @title Alice changes her own employee ID through the profile function
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 cannot be changed on your own account
SELECT idm_update_own_profile('{"employee_id": "9999"}'::jsonb);
-- @end

-- @case SP-08
-- @title Alice changes her own email and status through the profile function
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 cannot be changed on your own account
SELECT idm_update_own_profile('{"display_name": "Alice", "email": "alice.mine@example.test", "status": "active"}'::jsonb);
-- @end

-- @case SP-09
-- @title An anonymous session changes a profile
-- @category self-service
-- @expect error 42501 no signed-in actor
SELECT idm_update_own_profile('{"display_name": "Nobody"}'::jsonb);
-- @end

-- @case SP-10
-- @title Alice takes Bob's phone number through the profile function (uniqueness)
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error P0001 phone: already used by another account
SELECT idm_update_own_profile('{"phone": "+218910000003"}'::jsonb);
-- @end

-- @case SP-11
-- @title Alice asks for an email change without having re-entered her password
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 confirm your password first
SELECT idm_request_email_change('alice.new@example.test');
-- @end

-- @case SP-12
-- @title Alice asks for Bob's email address (uniqueness)
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error P0001 email: already used by another account
SELECT auth_local_result('{{ALICE}}', true);
SELECT idm_request_email_change('bob.sec@example.test');
-- @end

-- @case SP-13
-- @title Alice, who is not an admin, approves her own pending email change
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT auth_local_result('{{ALICE}}', true);
SELECT idm_decide_email_change(idm_request_email_change('alice.new@example.test'), true, 'Approving myself');
-- @end

-- @case SP-14
-- @title The System Admin approves his own email change
-- @category self-service
-- @actor ADMIN
-- @region *
-- @expect error 42501 you cannot decide an email change on your own account
SELECT auth_local_result('{{ADMIN}}', true);
SELECT idm_decide_email_change(idm_request_email_change('admin.new@example.test'), true, 'Approving myself');
-- @end

-- @case SP-15
-- @title A delegate holding users.edit approves an email change of the System Admin
-- @category self-service
-- @actor ADMIN
-- @region *
-- @expect error 42501 this user is an admin or a delegate
SELECT auth_local_result('{{ADMIN}}', true);
CREATE TEMP TABLE sp15 AS SELECT idm_request_email_change('admin.other@example.test') AS id;
SET app.user_id = '{{DEL_ALL}}';
SELECT idm_decide_email_change((SELECT id FROM sp15), true, 'For the admin');
-- @end

-- @case SP-16
-- @title A delegate limited to Tripoli decides Bob's email change (the change is global)
-- @category self-service
-- @actor BOB
-- @region 1
-- @expect error 42501 this change is global
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE sp16 AS SELECT idm_request_email_change('bob.new@example.test') AS id;
SET app.user_id = '{{DEL_TRI}}';
SELECT idm_decide_email_change((SELECT id FROM sp16), true, 'Regional delegate');
-- @end

-- @case SP-17
-- @title Alice cancels Bob's pending email change
-- @category self-service
-- @actor BOB
-- @region 1
-- @expect error P0001 email change request not found
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE sp17 AS SELECT idm_request_email_change('bob.other@example.test') AS id;
SET app.user_id = '{{ALICE}}';
SELECT idm_cancel_email_change((SELECT id FROM sp17));
-- @end

-- @case SP-18
-- @title Alice lists the email change requests of everyone
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT count(*) FROM idm_email_change_list(NULL);
-- @end

-- @case SP-19
-- @title Alice starts a self enrolment on Bob's account (planting her own authenticator)
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own two-factor
SELECT auth_totp_self_begin_enrol('{{BOB}}', gen_random_uuid(), 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
-- @end

-- @case SP-20
-- @title Alice starts her own self enrolment from a session without a fresh step-up
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 a fresh step-up of this session is required
SELECT auth_totp_self_begin_enrol('{{ALICE}}', gen_random_uuid(), 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
-- @end

-- @case SP-21
-- @title Alice confirms a self enrolment for Bob
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own two-factor
SELECT auth_totp_self_confirm_enrol('{{BOB}}', gen_random_uuid(), 1, ARRAY(SELECT repeat(to_hex(g), 64)::text FROM generate_series(1, 10) g));
-- @end

-- @case SP-22
-- @title Alice confirms her own self enrolment with nothing started from that session
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 only the session that started the enrolment
SELECT auth_totp_self_confirm_enrol('{{ALICE}}', gen_random_uuid(), 1, ARRAY(SELECT repeat(to_hex(g), 64)::text FROM generate_series(1, 10) g));
-- @end

-- @case SP-23
-- @title Alice records wrong self-enrolment codes for Bob (to lock his account)
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own two-factor
SELECT auth_totp_self_enrol_failed('{{BOB}}');
-- @end

-- @case SP-24
-- @title Alice turns off Bob's two-factor through the self path
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own two-factor
SELECT auth_totp_self_disable('{{BOB}}', gen_random_uuid());
-- @end

-- @case SP-25
-- @title Alice turns off her own two-factor that the System Admin enforces
-- @category self-service
-- @actor ADMIN
-- @region *
-- @expect error 42501 two_factor_enforced
SELECT count(*) FROM idm_set_two_factor('{{ALICE}}', true, 'Policy', repeat('c', 64));
SET app.user_id = '{{ALICE}}';
SELECT auth_totp_self_disable('{{ALICE}}', gen_random_uuid());
-- @end

-- @case SP-26
-- @title Alice, who is not an admin, removes the enforced mark from her own two-factor
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.administer required
SELECT idm_set_two_factor_enforced('{{ALICE}}', false, 'Let me turn it off');
-- @end

-- @case SP-27
-- @title The System Admin removes the enforced mark from his own two-factor
-- @category self-service
-- @actor ADMIN
-- @region *
-- @expect error 42501 you cannot change your own account
SELECT idm_set_two_factor_enforced('{{ADMIN}}', false, 'Myself');
-- @end

-- @case SP-28
-- @title A delegate with users.edit, not users.administer, removes the enforced mark from Bob
-- @category self-service
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 System Admin or a delegation covering users.administer required
SELECT idm_set_two_factor_enforced('{{BOB}}', false, 'Not my right');
-- @end

-- @case SP-29
-- @title Alice calls the internal session check (it reads other people's sessions)
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT auth_self_session_ok('{{BOB}}', gen_random_uuid(), false);
-- @end

-- @case SP-30
-- @title Alice calls the internal list of email-change deciders
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT count(*) FROM idm_email_change_deciders();
-- @end

-- @case SP-OK1
-- @title Positive control: Alice changes her own display name and language through the profile function
-- @category self-service
-- @actor ALICE
-- @region 1
-- @expect output 2
SELECT idm_update_own_profile('{"display_name": "Alice Renamed", "locale": "ar"}'::jsonb);
-- @end

-- @case SP-OK2
-- @title Positive control: the System Admin approves Bob's email change
-- @category self-service
-- @actor BOB
-- @region 1
-- @expect output approved
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE spok2 AS SELECT idm_request_email_change('bob.approved@example.test') AS id;
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_email_change((SELECT id FROM spok2), true, 'Verified by phone');
-- @end
