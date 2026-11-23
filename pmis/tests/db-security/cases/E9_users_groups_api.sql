-- The last users, groups and sign-in routes on the real API (migration 0143, contract 0.15.57): the per-user MFA exemption (user_mfa_exemptions, written only
-- by idm_set_mfa_exempt; read through idm_mfa_exemption_state and auth_mfa_required), group creation (idm_group_create, through the ceilings of
-- idm_group_add_member) and the request of a user to the System Admins (me_admin_requests, written only by me_notify_admins). The settings require_mfa and
-- notify_admins.cooldown_minutes are guarded keys. Alice: CW Team Lead in Tripoli, no admin right. DEL_ALL: delegate of users create/edit/delete and groups
-- create/edit for all regions, without users.administer. ADMIN: the System Admin. Each case is rolled back.

-- @case USR-01
-- @title pmis_app reads the MFA exemptions directly, with no context
-- @category users-groups-api
-- @expect error 42501 permission denied
SELECT * FROM user_mfa_exemptions;
-- @end

-- @case USR-02
-- @title The System Admin writes an exemption for Bob directly, around the door (no step-up, no audit)
-- @category users-groups-api
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO user_mfa_exemptions (user_id, until, reason, granted_by) VALUES ('{{BOB}}'::uuid, NULL, 'forged exemption', '{{ADMIN}}'::uuid);
-- @end

-- @case USR-03
-- @title Alice, with no admin right, exempts Bob from MFA through the door
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation
SELECT idm_set_mfa_exempt('{{BOB}}'::uuid, true, NULL, 'Alice exempts Bob');
-- @end

-- @case USR-04
-- @title A delegate without users.administer (DEL_ALL) exempts Bob
-- @category users-groups-api
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 System Admin or a delegation
SELECT idm_set_mfa_exempt('{{BOB}}'::uuid, true, NULL, 'delegate without the right');
-- @end

-- @case USR-05
-- @title The System Admin exempts Bob without a step-up in the signed context
-- @category users-groups-api
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT idm_set_mfa_exempt('{{BOB}}'::uuid, true, NULL, 'no step-up');
-- @end

-- @case USR-06
-- @title The System Admin with a step-up exempts themselves
-- @category users-groups-api
-- @expect error 42501 yourself
\ctx ADMIN stepup=300
SELECT idm_set_mfa_exempt('{{ADMIN}}'::uuid, true, NULL, 'my own account');
-- @end

-- @case USR-07
-- @title The System Admin with a step-up exempts Bob with an end date in the past
-- @category users-groups-api
-- @expect error P0001 must_be_future
\ctx ADMIN stepup=300
SELECT idm_set_mfa_exempt('{{BOB}}'::uuid, true, now() - interval '1 day', 'already over');
-- @end

-- @case USR-08
-- @title The System Admin with a step-up revokes an exemption Bob does not have
-- @category users-groups-api
-- @expect error P0001 invalid_transition
\ctx ADMIN stepup=300
SELECT idm_set_mfa_exempt('{{BOB}}'::uuid, false, NULL, 'nothing to revoke');
-- @end

-- @case USR-09
-- @title The System Admin with a step-up and no reason exempts Bob
-- @category users-groups-api
-- @expect error P0001 reason
\ctx ADMIN stepup=300
SELECT idm_set_mfa_exempt('{{BOB}}'::uuid, true, NULL, '  ');
-- @end

-- @case USR-10
-- @title Alice asks whether Bob must pass MFA (another person's state through the sign-in check)
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect error 42501 only for the user of the signed context
SELECT auth_mfa_required('{{BOB}}'::uuid);
-- @end

-- @case USR-11
-- @title Alice reads Bob's exemption through the reader: no row
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM idm_mfa_exemption_state('{{BOB}}'::uuid);
-- @end

-- @case USR-12
-- @title Alice calls the internal helper idm_mfa_exempt_now
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT idm_mfa_exempt_now('{{BOB}}'::uuid);
-- @end

-- @case USR-13
-- @title The System Admin switches require_mfa off around a door (guarded key)
-- @category users-groups-api
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = 'false'::jsonb WHERE key = 'require_mfa';
-- @end

-- @case USR-14
-- @title The System Admin shortens the cooldown of the request to the System Admins around a door (guarded key)
-- @category users-groups-api
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = '1'::jsonb WHERE key = 'notify_admins.cooldown_minutes';
-- @end

-- @case USR-15
-- @title Alice, with no groups right, creates a group
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation
SELECT idm_group_create('Alice crew', NULL, ARRAY[]::uuid[], 'my own group');
-- @end

-- @case USR-16
-- @title The delegate with groups rights (DEL_ALL) creates a group without a step-up
-- @category users-groups-api
-- @actor DEL_ALL
-- @region *
-- @expect error P0001 step_up_required
SELECT idm_group_create('Delegate crew', NULL, ARRAY[]::uuid[], 'no step-up');
-- @end

-- @case USR-17
-- @title The delegate with groups rights and a step-up creates a group with themselves as a member
-- @category users-groups-api
-- @expect error 42501 yourself
\ctx DEL_ALL stepup=300
SELECT idm_group_create('Delegate crew', NULL, ARRAY['{{DEL_ALL}}'::uuid, '{{BOB}}'::uuid], 'join through a new group');
-- @end

-- @case USR-18
-- @title The regional delegate (DEL_TRI, no groups right) with a step-up creates a group
-- @category users-groups-api
-- @expect error 42501 System Admin or a delegation
\ctx DEL_TRI stepup=300
SELECT idm_group_create('Tripoli crew', NULL, ARRAY[]::uuid[], 'regional delegate');
-- @end

-- @case USR-19
-- @title The System Admin with a step-up creates a second "system admins" group (same name, other case)
-- @category users-groups-api
-- @expect error P0001 duplicate
\ctx ADMIN stepup=300
SELECT idm_group_create('system admins', 'look-alike', ARRAY[]::uuid[], 'look-alike group');
-- @end

-- @case USR-20
-- @title The System Admin with a step-up creates a group with a deleted member
-- @category users-groups-api
-- @expect error P0001 not_found
\ctx ADMIN stepup=300
SELECT idm_group_create('Crew with a ghost', NULL, ARRAY['{{DELETED}}'::uuid], 'deleted member');
-- @end

-- @case USR-21
-- @title pmis_app inserts a request row directly, as the System Admin (forges or resets the cooldown)
-- @category users-groups-api
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO me_admin_requests (user_id, message) VALUES ('{{ALICE}}'::uuid, 'forged');
-- @end

-- @case USR-22
-- @title Alice deletes her own request rows to reset the cooldown
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM me_admin_requests WHERE user_id = '{{ALICE}}'::uuid;
-- @end

-- @case USR-23
-- @title A request to the System Admins with no signed-in user
-- @category users-groups-api
-- @expect error 42501 no signed-in user
SET app.user_id = '00000000-0000-4000-8000-00000000a002';
SELECT me_notify_admins('forged user id');
-- @end

-- @case USR-24
-- @title Alice sends markup to the System Admins
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect error P0001 markup_not_allowed
SELECT me_notify_admins('<img src=x onerror=alert(1)>');
-- @end

-- @case USR-25
-- @title Alice asks the System Admins twice within the cooldown
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect error P0001 rate_limited
SELECT me_notify_admins('first request');
SELECT me_notify_admins('second request');
-- @end

-- @case USR-26
-- @title The disabled account asks the System Admins for an assignment
-- @category users-groups-api
-- @actor DISABLED
-- @expect error 28000|42501 inactive user|no signed-in user
SELECT me_notify_admins('let me back in');
-- @end

-- @case USR-27
-- @title The shape of the new functions: SECURITY DEFINER, owner, fixed search_path, PUBLIC revoked, pmis_app only on the entry functions
-- @category users-groups-api
-- @actor ALICE
-- @region 1
-- @expect output 6
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
  AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
  AND ((p.proname IN ('idm_mfa_exempt_now', 'idm_mfa_exemption_state', 'auth_mfa_required', 'idm_set_mfa_exempt', 'idm_group_create')
        AND pg_get_userbyid(p.proowner) = 'pmis_identity_owner')
    OR (p.proname = 'me_notify_admins' AND pg_get_userbyid(p.proowner) = 'pmis_definer'))
  AND has_function_privilege('pmis_app', p.oid, 'EXECUTE') = (p.proname <> 'idm_mfa_exempt_now');
-- @end
