-- Identity and profile follow-up (migration 0058, work package P8: D156, Q158, Q161). A phone change is a request that only a System Admin, or
-- a delegate holding users.edit for all regions, decides, never on their own account and a delegate never for an admin; the phone is no
-- longer self-edited. An email change is approved only once the new address is verified (mailed code) or the admin records the identity
-- check. pmis_app has no right on phone_change_requests or email_change_requests; the internal helpers are not callable.

-- @case P8-01
-- @title Alice reads every phone change request directly
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT new_phone FROM phone_change_requests;
-- @end

-- @case P8-02
-- @title Alice writes an approved phone change request for herself directly
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO phone_change_requests (user_id, old_phone, new_phone, status, decided_at, decision_reason)
VALUES ('{{ALICE}}', '+218910000002', '+218910000099', 'approved', now(), 'self');
-- @end

-- @case P8-03
-- @title Alice changes her own phone directly (skipping the request)
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE users SET phone = '+218910000099' WHERE id = '{{ALICE}}';
-- @end

-- @case P8-04
-- @title Alice changes her own phone through the profile function (no longer self-edited)
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 ask for a phone change
SELECT idm_update_own_profile('{"phone": "+218910000099"}'::jsonb);
-- @end

-- @case P8-05
-- @title Alice asks for a phone change without having re-entered her password
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 confirm your password first
SELECT idm_request_phone_change('+218910000099');
-- @end

-- @case P8-06
-- @title Alice asks for Bob's phone number (uniqueness)
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error P0001 new_phone: already used or requested by another account
SELECT auth_local_result('{{ALICE}}', true);
SELECT idm_request_phone_change('+218910000003');
-- @end

-- @case P8-07
-- @title Alice asks for a number that Bob already asked for in a pending request
-- @category p8-identity
-- @actor BOB
-- @region 1
-- @expect error P0001 new_phone: already used or requested by another account
SELECT auth_local_result('{{BOB}}', true);
SELECT idm_request_phone_change('+218910000077');
SET app.user_id = '{{ALICE}}';
SELECT auth_local_result('{{ALICE}}', true);
SELECT idm_request_phone_change('+218910000077');
-- @end

-- @case P8-08
-- @title Alice asks for a second phone change while one is pending
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error P0001 a phone change is already pending
SELECT auth_local_result('{{ALICE}}', true);
SELECT idm_request_phone_change('+218910000088');
SELECT idm_request_phone_change('+218910000089');
-- @end

-- @case P8-09
-- @title Alice, who is not an admin, approves her own pending phone change
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT auth_local_result('{{ALICE}}', true);
SELECT idm_decide_phone_change(idm_request_phone_change('+218910000088'), true, 'Approving myself');
-- @end

-- @case P8-10
-- @title The System Admin approves his own phone change
-- @category p8-identity
-- @actor ADMIN
-- @region *
-- @expect error 42501 you cannot decide a phone change on your own account
SELECT auth_local_result('{{ADMIN}}', true);
SELECT idm_decide_phone_change(idm_request_phone_change('+218910000066'), true, 'Approving myself');
-- @end

-- @case P8-11
-- @title A delegate holding users.edit approves a phone change of the System Admin
-- @category p8-identity
-- @actor ADMIN
-- @region *
-- @expect error 42501 this user is an admin or a delegate
SELECT auth_local_result('{{ADMIN}}', true);
CREATE TEMP TABLE p811 AS SELECT idm_request_phone_change('+218910000065') AS id;
SET app.user_id = '{{DEL_ALL}}';
SELECT idm_decide_phone_change((SELECT id FROM p811), true, 'For the admin');
-- @end

-- @case P8-12
-- @title A delegate limited to Tripoli decides Bob's phone change (the change is global)
-- @category p8-identity
-- @actor BOB
-- @region 1
-- @expect error 42501 this change is global
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE p812 AS SELECT idm_request_phone_change('+218910000064') AS id;
SET app.user_id = '{{DEL_TRI}}';
SELECT idm_decide_phone_change((SELECT id FROM p812), true, 'Regional delegate');
-- @end

-- @case P8-13
-- @title Alice cancels Bob's pending phone change
-- @category p8-identity
-- @actor BOB
-- @region 1
-- @expect error P0001 phone change request not found
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE p813 AS SELECT idm_request_phone_change('+218910000063') AS id;
SET app.user_id = '{{ALICE}}';
SELECT idm_cancel_phone_change((SELECT id FROM p813));
-- @end

-- @case P8-14
-- @title Alice lists the phone change requests of everyone
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT count(*) FROM idm_phone_change_list(NULL);
-- @end

-- @case P8-15
-- @title The System Admin approves an email change whose new address was never verified and records no identity check
-- @category p8-identity
-- @actor BOB
-- @region 1
-- @expect error P0001 email_not_verified
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE p815 AS SELECT idm_request_email_change('bob.unverified@example.test') AS id;
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_email_change((SELECT id FROM p815), true, 'Looks fine', NULL);
-- @end

-- @case P8-16
-- @title The 0044 three-argument decision is used to approve an unverified email change
-- @category p8-identity
-- @actor BOB
-- @region 1
-- @expect error P0001 email_not_verified
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE p816 AS SELECT idm_request_email_change('bob.unverified2@example.test') AS id;
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_email_change((SELECT id FROM p816), true, 'Looks fine');
-- @end

-- @case P8-17
-- @title Alice sets the verification code of Bob's email change (to verify an address she controls)
-- @category p8-identity
-- @actor BOB
-- @region 1
-- @expect error P0001 email change request not found
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE p817 AS SELECT idm_request_email_change('bob.target@example.test') AS id;
SET app.user_id = '{{ALICE}}';
SELECT idm_email_change_set_verification((SELECT id FROM p817), repeat('a', 64));
-- @end

-- @case P8-18
-- @title Alice writes verified_at on her own email change directly
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE email_change_requests SET verified_at = now(), verified_via = 'code' WHERE user_id = '{{ALICE}}';
-- @end

-- @case P8-19
-- @title Alice guesses the code of her own email change a sixth time after five wrong codes (the code is spent)
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect output locked
SELECT auth_local_result('{{ALICE}}', true);
CREATE TEMP TABLE p819 AS SELECT idm_request_email_change('alice.guess@example.test') AS id;
SELECT idm_email_change_set_verification((SELECT id FROM p819), repeat('a', 64));
SELECT idm_email_change_verify(repeat('b', 64)) FROM generate_series(1, 5);
SELECT idm_email_change_verify(repeat('a', 64));
-- @end

-- @case P8-20
-- @title Alice calls the internal security notice writer to plant a notice in Bob's inbox
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT idm_security_notice('{{BOB}}', 'Fake notice', 'Click here');
-- @end

-- @case P8-21
-- @title Alice calls the internal on-behalf helper
-- @category p8-identity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT idm_on_behalf();
-- @end

-- @case P8-22
-- @title An anonymous session asks for a phone change
-- @category p8-identity
-- @expect error 42501 no signed-in actor
SELECT idm_request_phone_change('+218910000061');
-- @end

-- @case P8-OK1
-- @title Positive control: the System Admin approves Bob's phone change; Bob's phone changes
-- @category p8-identity
-- @actor BOB
-- @region 1
-- @expect output +218910000062
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE p8ok1 AS SELECT idm_request_phone_change('+218910000062') AS id;
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_phone_change((SELECT id FROM p8ok1), true, 'Confirmed in person');
SELECT phone FROM users WHERE id = '{{BOB}}';
-- @end

-- @case P8-OK2
-- @title Positive control: Bob verifies the mailed code; the System Admin approves without an identity check
-- @category p8-identity
-- @actor BOB
-- @region 1
-- @expect output approved
SELECT auth_local_result('{{BOB}}', true);
CREATE TEMP TABLE p8ok2 AS SELECT idm_request_email_change('bob.verified@example.test') AS id;
SELECT idm_email_change_set_verification((SELECT id FROM p8ok2), repeat('c', 64));
SELECT idm_email_change_verify(repeat('c', 64));
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT idm_decide_email_change((SELECT id FROM p8ok2), true, 'Verified address', NULL);
-- @end
