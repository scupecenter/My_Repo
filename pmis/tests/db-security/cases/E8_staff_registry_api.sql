-- The staff registry and the visibility of email and phone (migration 0142, B13, contract 0.15.56). The registry and its settings are never read or written
-- by pmis_app directly: the card goes through people_staff_card, which applies the visibility in the database, and every write goes through
-- people_save_staff / people_save_staff_visibility (System Admin or an all-regions holder of users.edit, a reason, a step-up in the verified context,
-- the version; audited). The helpers that decide visibility are internal. Rows are never deleted. Alice: CW Team Lead in Tripoli, not a System Admin.
-- ADMIN: the System Admin. DEL_TRI: a Tripoli-only delegate. The draft row 1103 (Ali Barka, synthetic) is seeded by the migration. Each case is rolled back.

-- @case SR-01
-- @title Alice reads the phone and email of the whole registry straight from the table, around the visibility settings
-- @category staff-registry
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT employee_id, email, phone FROM staff_registry;
-- @end

-- @case SR-02
-- @title Alice clears the per-employee hide of a colleague straight in the table
-- @category staff-registry
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE staff_registry SET hidden_fields = '{}' WHERE employee_id = '1103';
-- @end

-- @case SR-03
-- @title The System Admin deletes a registry row (rows are deactivated, never deleted)
-- @category staff-registry
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM staff_registry WHERE employee_id = '1103';
-- @end

-- @case SR-04
-- @title Alice adds herself to the allow list of the phone straight in the settings table
-- @category staff-registry
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO staff_registry_visibility_entries (field, mode, kind, ref_id) VALUES ('phone', 'allow', 'user', '{{ALICE}}'::uuid);
-- @end

-- @case SR-05
-- @title Alice switches the default visibility of the email straight in the settings table
-- @category staff-registry
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE staff_registry_visibility_fields SET default_visible = true;
-- @end

-- @case SR-06
-- @title Alice edits a registry row through the door, with a forged all-regions setting
-- @category staff-registry
-- @actor ALICE
-- @region *
-- @expect error P0001 action_forbidden
SELECT people_save_staff('1103', '{"hidden_fields": []}'::jsonb, 'forged edit', NULL);
-- @end

-- @case SR-07
-- @title A Tripoli-only delegate of users.edit changes who sees the email (the registry is global configuration)
-- @category staff-registry
-- @actor DEL_TRI
-- @region 1
-- @expect error P0001 action_forbidden
SELECT people_save_staff_visibility('{"email": {"default_visible": true, "allow": [], "deny": []}}'::jsonb, 'regional delegate', NULL);
-- @end

-- @case SR-08
-- @title The System Admin edits a registry row without a step-up
-- @category staff-registry
-- @expect error P0001 step_up_required
\ctx ADMIN
SELECT people_save_staff('1103', '{"position": "RF Engineer (senior)"}'::jsonb, 'no step-up', NULL);
-- @end

-- @case SR-09
-- @title The System Admin changes the visibility settings without a step-up
-- @category staff-registry
-- @expect error P0001 step_up_required
\ctx ADMIN
SELECT people_save_staff_visibility('{"phone": {"default_visible": false, "allow": [], "deny": []}}'::jsonb, 'no step-up', NULL);
-- @end

-- @case SR-10
-- @title Alice reads the full row (email and phone) through the internal JSON helper
-- @category staff-registry
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT people_staff_json('1103');
-- @end

-- @case SR-11
-- @title Alice asks the internal visibility helper to treat her as a registry administrator
-- @category staff-registry
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT people_staff_sees('{{ALICE}}'::uuid, true, 'phone', '{phone}');
-- @end

-- @case SR-12
-- @title Alice reads the visibility settings (who is allowed and denied)
-- @category staff-registry
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT people_staff_visibility_get();
-- @end

-- @case SR-13
-- @title Control: after the System Admin (with a step-up) hides the email of 1103, Alice's card carries no email, while the admin's card still does
-- @category staff-registry
-- @expect output ok
\ctx ADMIN stepup=300
SELECT people_save_staff('1103', '{"hidden_fields": ["email"]}'::jsonb, 'privacy request (control)', NULL) IS NOT NULL;
\ctx ALICE
SELECT set_config('secsuite.sr13', people_staff_card('1103')::text, true) IS NOT NULL;
\ctx ADMIN
SELECT CASE
  WHEN current_setting('secsuite.sr13')::jsonb ->> 'email' IS NOT NULL THEN 'email leaked'
  WHEN current_setting('secsuite.sr13')::jsonb -> 'hidden_fields' <> '["email"]'::jsonb THEN 'hidden_fields: ' || (current_setting('secsuite.sr13')::jsonb -> 'hidden_fields')::text
  WHEN current_setting('secsuite.sr13')::jsonb ->> 'phone' IS NULL THEN 'phone hidden too'
  WHEN people_staff_card('1103') ->> 'email' IS NULL THEN 'admin lost the email'
  ELSE 'ok' END;
-- @end

-- @case SR-14
-- @title Control: the shape of the doors and helpers (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked; only the five doors granted to pmis_app), the four tables closed to pmis_app, and the no-delete triggers
-- @category staff-registry
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('people_staff_can_admin', 'people_staff_card', 'people_staff_visibility_get', 'people_save_staff_visibility',
    'people_save_staff', 'people_staff_on_behalf', 'people_staff_json', 'people_staff_assignee_json', 'people_staff_visibility_json', 'people_staff_matches',
    'people_staff_sees')
), t AS (
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('staff_registry', 'staff_registry_visibility_state', 'staff_registry_visibility_fields', 'staff_registry_visibility_entries')
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 11 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN (SELECT array_agg(proname ORDER BY proname) FROM f WHERE app)
       <> ARRAY['people_save_staff', 'people_save_staff_visibility', 'people_staff_can_admin', 'people_staff_card', 'people_staff_visibility_get']::name[] THEN 'granted to pmis_app'
  WHEN (SELECT count(*) FROM t) <> 4 THEN 'tables'
  WHEN EXISTS (SELECT 1 FROM t WHERE has_table_privilege('pmis_app', 'public.' || relname, 'SELECT') OR has_table_privilege('pmis_app', 'public.' || relname, 'INSERT')
               OR has_table_privilege('pmis_app', 'public.' || relname, 'UPDATE') OR has_table_privilege('pmis_app', 'public.' || relname, 'DELETE')) THEN 'table rights'
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.staff_registry'::regclass AND tgname IN ('staff_registry_no_delete', 'staff_registry_no_truncate')) <> 2 THEN 'no-delete triggers'
  ELSE 'ok' END;
-- @end
