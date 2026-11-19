-- Switchable UI designs (migration 0130, owner decision 2026-11-19, contract 0.15.41). The setting ui.identity (the organization default design and whether users
-- may choose their own) changes only through admin_set_ui_identity (a System Admin or a delegate of settings edit for all regions, a reason, the version, audited);
-- a direct write, a delete and a rename are refused for every session (settings_guarded_keys of 0072). users.ui_brand is written only by idm_update_own_profile
-- (no column right for pmis_app; the users backstop of 0009), which refuses a personal design while the admin does not allow one. The helpers ui_brands and
-- ui_identity_cfg are internal. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin. Each case is rolled back.

-- @case UB-01
-- @title The System Admin changes the default design by a direct update (no reason, no audit row)
-- @category ui-brand
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = '{"default_brand": "field", "allow_user_choice": false}'::jsonb WHERE key = 'ui.identity';
-- @end

-- @case UB-02
-- @title The System Admin deletes the identity setting
-- @category ui-brand
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM settings WHERE key = 'ui.identity';
-- @end

-- @case UB-03
-- @title The System Admin renames the identity row away: the update trigger looks at the old key too
-- @category ui-brand
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET key = 'ui.identity_old' WHERE key = 'ui.identity';
-- @end

-- @case UB-04
-- @title Alice writes her own design directly, around the profile door
-- @category ui-brand
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE users SET ui_brand = 'field' WHERE id = '{{ALICE}}'::uuid;
-- @end

-- @case UB-05
-- @title Alice (not an admin, no settings right) sets the default design through the door, with a forged all-regions setting
-- @category ui-brand
-- @actor ALICE
-- @region *
-- @expect error 42501
SELECT admin_set_ui_identity('aljeel', false, 'Forged change', NULL);
-- @end

-- @case UB-06
-- @title A session without a verified context reads or changes the identity settings
-- @category ui-brand
-- @actor none
-- @expect error 42501
SET LOCAL app.user_id = '00000000-0000-4000-8000-00000000a001';
SELECT ui_identity_state();
-- @end

-- @case UB-07
-- @title Alice calls the internal helpers
-- @category ui-brand
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT ui_identity_cfg(), ui_brands();
-- @end

-- @case UB-08
-- @title Alice chooses her own design while the System Admin set one design for everyone
-- @category ui-brand
-- @expect error 42501 ui_brand_locked
\ctx ADMIN
SELECT admin_set_ui_identity('aljeel', false, 'One design for everyone', NULL);
\ctx ALICE
SELECT idm_update_own_profile('{"ui_brand": "field"}'::jsonb);
-- @end

-- @case UB-09
-- @title Alice sets a design that does not exist
-- @category ui-brand
-- @actor ALICE
-- @region 1
-- @expect error P0001 ui_brand must be null or one of
SELECT idm_update_own_profile('{"ui_brand": "neon"}'::jsonb);
-- @end

-- @case UB-10
-- @title Control: Alice reads the identity settings (the default design, no right to edit)
-- @category ui-brand
-- @actor ALICE
-- @region 1
-- @expect output current|true|false
SELECT concat_ws('|', s ->> 'default_brand', s ->> 'allow_user_choice', s ->> 'can_edit') FROM ui_identity_state() s;
-- @end

-- @case UB-11
-- @title Control: the shape of the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked) and the doors of pmis_app
-- @category ui-brand
-- @actor ALICE
-- @region 1
-- @expect output 5|3|0
SELECT concat_ws('|',
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('ui_brands', 'ui_identity_cfg', 'ui_effective_brand', 'ui_identity_state', 'admin_set_ui_identity')
     AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer' AND p.proconfig::text LIKE '%pg_temp%'
     AND NOT has_function_privilege('public', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('ui_brands', 'ui_identity_cfg', 'ui_effective_brand', 'ui_identity_state', 'admin_set_ui_identity')
     AND has_function_privilege('pmis_app', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM information_schema.column_privileges WHERE grantee = 'pmis_app' AND table_name = 'users' AND column_name = 'ui_brand' AND privilege_type <> 'SELECT'));
-- @end
