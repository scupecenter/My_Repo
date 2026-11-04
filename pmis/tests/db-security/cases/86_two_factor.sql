-- Two-factor (TOTP) for local accounts (migrations 0033 and 0034, ADR 0014). The application role never reads the encrypted secrets, the
-- recovery-code hashes or the pending sign-ins; it reaches them only through the auth_totp_* / auth_pending_* functions, each of
-- which works for the signed-in user's own row. Only a System Admin, or a delegate holding users.administer, turns two-factor on,
-- off or resets it, never for themselves. A session for a user whose two-factor is on needs a code success in the database.

-- @case TF-01
-- @title Alice reads the encrypted TOTP secrets directly
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT secret_enc FROM user_totp;
-- @end

-- @case TF-02
-- @title Alice reads the recovery-code hashes directly
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT code_hash FROM user_recovery_codes;
-- @end

-- @case TF-03
-- @title Alice reads the pending sign-ins directly (the token hashes of other people)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT token_hash FROM auth_pending;
-- @end

-- @case TF-04
-- @title Alice writes a two-factor row for herself (switching it off, or planting a secret)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO user_totp (user_id, required) VALUES ('{{ALICE}}', false);
-- @end

-- @case TF-05
-- @title Alice deletes the recovery codes of every user
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM user_recovery_codes;
-- @end

-- @case TF-06
-- @title Alice reads Bob's encrypted secret through auth_totp_secret
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own two-factor secret
SELECT count(*) FROM auth_totp_secret('{{BOB}}');
-- @end

-- @case TF-07
-- @title Anonymous session reads Bob's encrypted secret (no signed-in user)
-- @category two-factor
-- @expect error 42501 only your own two-factor secret
SELECT count(*) FROM auth_totp_secret('{{BOB}}');
-- @end

-- @case TF-08
-- @title Alice tries a recovery code against Bob's account
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own recovery code
SELECT auth_totp_use_recovery('{{BOB}}', repeat('a', 64));
-- @end

-- @case TF-09
-- @title Alice records a successful code for Bob (to open the session guard for him)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own two-factor code
SELECT auth_totp_result('{{BOB}}', true, 1);
-- @end

-- @case TF-10
-- @title Alice starts an enrolment for Bob (planting her own secret on his account)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own enrolment
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('a', 64), repeat('c', 64));
-- @end

-- @case TF-11
-- @title Alice makes a pending sign-in for Bob
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 pending sign-in must be created for the signing-in user
SELECT auth_pending_create('{{BOB}}', repeat('b', 64), 'two_factor', NULL);
-- @end

-- @case TF-12
-- @title Alice replaces Bob's recovery codes
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own recovery codes
SELECT auth_totp_regenerate_recovery('{{BOB}}', ARRAY(SELECT repeat(to_hex(g), 64)::text FROM generate_series(1, 10) g));
-- @end

-- @case TF-13
-- @title Alice calls the internal failure counter (it can lock any account)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT auth_totp_note_failure('{{BOB}}');
-- @end

-- @case TF-14
-- @title Alice calls the installer-only reset
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT idm_installer_reset_two_factor('bob.sec@example.test', true);
-- @end

-- @case TF-15
-- @title Alice, who is not an admin, turns off Bob's two-factor
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.administer required
SELECT idm_set_two_factor('{{BOB}}', false, 'Let me in');
-- @end

-- @case TF-16
-- @title Alice resets Bob's two-factor
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.administer required
SELECT idm_reset_two_factor('{{BOB}}', 'Let me in');
-- @end

-- @case TF-17
-- @title A delegate with users.edit and users.delete, but not users.administer, turns on Bob's two-factor
-- @category two-factor
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 System Admin or a delegation covering users.administer required
SELECT idm_set_two_factor('{{BOB}}', true, 'Not my right');
-- @end

-- @case TF-18
-- @title The System Admin turns on, off or resets his own two-factor
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect error 42501 you cannot change your own account
SELECT idm_set_two_factor('{{ADMIN}}', true, 'Myself');
-- @end

-- @case TF-19
-- @title The System Admin resets his own two-factor
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect error 42501 you cannot change your own account
SELECT idm_reset_two_factor('{{ADMIN}}', 'Myself');
-- @end

-- @case TF-20
-- @title The System Admin turns on Bob's two-factor without a reason
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect error P0001 a reason is required
SELECT idm_set_two_factor('{{BOB}}', true, '   ');
-- @end

-- @case TF-21
-- @title Positive control: Alice may read the non-secret state of Bob's two-factor (a count of recovery codes left, never a secret)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT recovery_remaining FROM auth_totp_state('{{BOB}}');
-- @end

-- @case TF-22
-- @title Positive control: the System Admin turns on Bob's two-factor (rolled back by the runner)
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect output pending_enrolment
SELECT r_state FROM idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
-- @end

-- @case TF-23
-- @title Session guard: Bob's two-factor is on, his password check is fresh, and the session is minted without a code
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect error 42501 no recent successful sign-in with a code
SELECT idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
\ctx BOB
SELECT auth_local_result('{{BOB}}', true);
SELECT auth_session_create('{{BOB}}', repeat('a', 64), 'local'::"AuthMethod", repeat('c', 43), NULL, 'guard test');
-- @end

-- @case TF-24
-- @title Session guard: the same without two-factor still works (positive control for TF-23, rolled back)
-- @category two-factor
-- @actor BOB
-- @region 1
-- @expect output 1
SELECT auth_local_result('{{BOB}}', true);
SELECT count(*) FROM (SELECT auth_session_create('{{BOB}}', repeat('a', 64), 'local'::"AuthMethod", repeat('c', 43), NULL, 'guard test')) s;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Migration 0034: the one-time enrolment code. A password alone must never enrol a phone: the hash of the code is unreadable
-- for the application role, the code is matched and used up inside the database, and a miss counts toward the lock.
-- ---------------------------------------------------------------------------------------------------------------------

-- @case TF-25
-- @title Alice reads the enrolment-code hashes directly
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT enrol_code_hash FROM user_totp;
-- @end

-- @case TF-26
-- @title Alice reads when the enrolment codes end (the whole table is closed to her)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT enrol_code_expires_at FROM user_totp;
-- @end

-- @case TF-27
-- @title Alice plants her own enrolment-code hash on Bob's account
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE user_totp SET enrol_code_hash = repeat('a', 64), enrol_code_expires_at = now() + interval '1 day' WHERE user_id = '{{BOB}}';
-- @end

-- @case TF-28
-- @title Alice calls the internal code matcher (a miss counts toward Bob's lock, a hit would confirm a guess)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT auth_totp_check_enrol_code('{{BOB}}', repeat('a', 64));
-- @end

-- @case TF-29
-- @title Alice, who is not an admin, issues a new enrolment code for Bob
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.administer required
SELECT idm_issue_two_factor_enrol_code('{{BOB}}', 'Let me in', repeat('a', 64));
-- @end

-- @case TF-30
-- @title A delegate with users.edit and users.delete, but not users.administer, issues a new enrolment code
-- @category two-factor
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 System Admin or a delegation covering users.administer required
SELECT idm_issue_two_factor_enrol_code('{{BOB}}', 'Not my right', repeat('a', 64));
-- @end

-- @case TF-31
-- @title The System Admin issues an enrolment code for himself
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect error 42501 you cannot change your own account
SELECT idm_issue_two_factor_enrol_code('{{ADMIN}}', 'Myself', repeat('a', 64));
-- @end

-- @case TF-32
-- @title The System Admin issues a code for a user whose two-factor is off (nothing to enrol)
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect error P0001 no enrolment code can be issued
SELECT idm_issue_two_factor_enrol_code('{{BOB}}', 'Not waiting', repeat('a', 64));
-- @end

-- @case TF-33
-- @title The System Admin turns on Bob's two-factor without a code hash (the old behaviour: enrolment with a password alone)
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect error 22023 an enrolment code hash is required
SELECT idm_set_two_factor('{{BOB}}', true, 'Policy test');
-- @end

-- @case TF-34
-- @title The old three-argument enrolment start (no code) no longer exists
-- @category two-factor
-- @actor BOB
-- @region 1
-- @expect error 42883 does not exist
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('a', 64));
-- @end

-- @case TF-35
-- @title Alice starts an enrolment for Bob with a code hash (planting her own secret on his account)
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own enrolment
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('a', 64), repeat('c', 64));
-- @end

-- @case TF-36
-- @title Alice confirms an enrolment for Bob
-- @category two-factor
-- @actor ALICE
-- @region 1
-- @expect error 42501 only your own enrolment
SELECT auth_totp_confirm_enrol('{{BOB}}', 1, ARRAY(SELECT repeat(to_hex(g), 64)::text FROM generate_series(1, 10) g), repeat('a', 64), repeat('c', 64));
-- @end

-- @case TF-37
-- @title Bob, waiting for enrolment, starts it with a wrong code: refused ('bad'), and no secret is stored
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect output bad
SELECT r_state FROM idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
\ctx BOB
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('b', 64), repeat('c', 64));
-- @end

-- @case TF-38
-- @title Positive control for TF-37: with the right code hash the enrolment starts ('ok')
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect output ok
SELECT r_state FROM idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
\ctx BOB
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('b', 64), repeat('a', 64));
-- @end

-- @case TF-39
-- @title Bob confirms with a wrong enrolment code even after a right start: refused ('bad'), nothing is activated
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect output bad
SELECT r_state FROM idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
\ctx BOB
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('b', 64), repeat('a', 64));
SELECT auth_totp_confirm_enrol('{{BOB}}', 1, ARRAY(SELECT repeat(to_hex(g), 64)::text FROM generate_series(1, 10) g), repeat('b', 64), repeat('c', 64));
-- @end

-- @case TF-40
-- @title Positive control for TF-39: with the right enrolment code the enrolment is confirmed ('ok')
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect output ok
SELECT r_state FROM idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
\ctx BOB
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('b', 64), repeat('a', 64));
SELECT auth_totp_confirm_enrol('{{BOB}}', 1, ARRAY(SELECT repeat(to_hex(g), 64)::text FROM generate_series(1, 10) g), repeat('b', 64), repeat('a', 64));
-- @end

-- @case TF-42
-- @title Once confirmed, the same code (and the same sign-in) opens nothing: Bob cannot start a second enrolment
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect error 42501 not waiting for enrolment
SELECT r_state FROM idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
\ctx BOB
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('b', 64), repeat('a', 64));
SELECT auth_totp_confirm_enrol('{{BOB}}', 1, ARRAY(SELECT repeat(to_hex(g), 64)::text FROM generate_series(1, 10) g), repeat('b', 64), repeat('a', 64));
SELECT auth_totp_begin_enrol('{{BOB}}', 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repeat('b', 64), repeat('a', 64));
-- @end

-- @case TF-41
-- @title Positive control: the System Admin issues a new enrolment code for Bob who is waiting (rolled back by the runner)
-- @category two-factor
-- @actor ADMIN
-- @region *
-- @expect output t
SELECT r_state FROM idm_set_two_factor('{{BOB}}', true, 'Policy test', repeat('a', 64));
SELECT idm_issue_two_factor_enrol_code('{{BOB}}', 'Code lost', repeat('b', 64)) > now();
-- @end
