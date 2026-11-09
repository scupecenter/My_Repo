-- The editable side menu (migration 0081, owner request of 2026-11-09; contract 0.15.1). The setting nav.layout changes only through admin_set_nav_layout (a System
-- Admin or a delegate of settings edit for all regions, a reason, a valid layout, the version), audited as nav_layout_update / nav_layout_reset with before and after.
-- A direct write, a rename, an insert and a delete of the key are refused for every session (also a System Admin's); the catalogue of the menu entries is read-only for
-- the application role; the internal validation helpers are closed to it; a session without a verified context reads and writes nothing.

-- ---------------------------------------------------------------------------------------------------------------------
-- Direct writes of the key
-- ---------------------------------------------------------------------------------------------------------------------
-- @case NL-01
-- @title Alice rewrites the menu layout by a direct update (the settings policies keep her out: no row changes)
-- @category nav-layout
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = '{"headings": []}'::jsonb WHERE key = 'nav.layout' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case NL-02
-- @title The System Admin inserts the menu layout directly (no reason, no validation, no audit row)
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO settings (key, value, updated_at) VALUES ('nav.layout', '{"headings": [{"id": "x", "name_en": "X", "name_ar": "س", "icon": null, "children": []}]}'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case NL-03
-- @title The System Admin updates the menu layout directly after a proper save (the row exists)
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, 'A first layout', NULL) IS NOT NULL;
UPDATE settings SET value = '{"headings": []}'::jsonb WHERE key = 'nav.layout';
-- @end

-- @case NL-04
-- @title The System Admin renames the layout row away (the update trigger looks at the old key too)
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, 'A first layout', NULL) IS NOT NULL;
UPDATE settings SET key = 'nav.layout_old' WHERE key = 'nav.layout';
-- @end

-- @case NL-05
-- @title The System Admin renames another row to the layout key (the update trigger looks at the new key)
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET key = 'nav.layout' WHERE key = (SELECT s.key FROM settings s WHERE s.key NOT IN ('nav.layout', 'imports.async_rows', 'calendar.official_confirmed',
  'mail.notification_kinds', 'load.historical_waiver') ORDER BY s.key LIMIT 1);
-- @end

-- @case NL-06
-- @title The System Admin deletes the layout row (the default would then apply without an audit row)
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, 'A first layout', NULL) IS NOT NULL;
DELETE FROM settings WHERE key = 'nav.layout';
-- @end

-- @case NL-07
-- @title Nobody signed in (a forged plain user id of the System Admin) writes the layout directly: no row changes
-- @category nav-layout
-- @expect output 0
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
WITH u AS (UPDATE settings SET value = '{"headings": []}'::jsonb WHERE key = 'nav.layout' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case NL-08
-- @title The System Admin adds a menu entry (a link of their own) to the catalogue
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO nav_item_catalogue (key, default_group, ord, added_in) VALUES ('evil_link', 'work', 999, 'case');
-- @end

-- @case NL-09
-- @title The System Admin removes a screen from the catalogue
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM nav_item_catalogue WHERE key = 'audit';
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The function
-- ---------------------------------------------------------------------------------------------------------------------
-- @case NL-20
-- @title Alice (no settings right) saves a layout through the function
-- @category nav-layout
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, 'Alice wants her order', NULL);
-- @end

-- @case NL-21
-- @title A delegate without a settings right saves a layout
-- @category nav-layout
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 admin path
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, 'Delegate without the right', NULL);
-- @end

-- @case NL-22
-- @title Alice resets the layout to the default through the function
-- @category nav-layout
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_set_nav_layout(NULL, 'Alice resets the menu', NULL);
-- @end

-- @case NL-23
-- @title Nobody signed in saves a layout (forged plain user id of the System Admin)
-- @category nav-layout
-- @expect error 42501 admin path
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, 'forged', NULL);
-- @end

-- @case NL-24
-- @title Nobody signed in reads the layout (forged plain user id of the System Admin)
-- @category nav-layout
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT nav_layout_json();
-- @end

-- @case NL-25
-- @title The System Admin saves a layout without a reason
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, ' ', NULL);
-- @end

-- @case NL-26
-- @title The System Admin puts a URL (a key outside the catalogue) in the menu
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error P0001 unknown_item
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["https://example.invalid/phish"]}]}'::jsonb, 'A link', NULL);
-- @end

-- @case NL-27
-- @title The System Admin nests a third level (a heading inside a sub-heading)
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error P0001 too_deep
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": [{"id": "s1", "name_en": "S", "name_ar": "س", "children": [
  {"id": "s2", "name_en": "T", "name_ar": "ت", "children": []}]}]}]}'::jsonb, 'Too deep', NULL);
-- @end

-- @case NL-28
-- @title The System Admin lists a screen twice and gives two headings the same id
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error P0001 duplicate_item.*duplicate_id|duplicate_id.*duplicate_item
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work", "my_work"]},
  {"id": "work", "name_en": "Again", "name_ar": "ثانية", "children": []}]}'::jsonb, 'Duplicates', NULL);
-- @end

-- @case NL-29
-- @title The System Admin saves with a stale version
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "Work", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, 'Stale version',
  (nav_layout_json() ->> 'version')::int + 1);
-- @end

-- @case NL-30
-- @title Alice calls the internal validation helpers directly
-- @category nav-layout
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT nav_layout_clean('{"headings": []}'::jsonb);
-- @end

-- @case NL-31
-- @title Control: Alice reads the layout (the default: null), the catalogue (42 keys of 0081 and logs.system of 0082), and may not edit it
-- @category nav-layout
-- @actor ALICE
-- @region 1
-- @expect output true|false|43
SELECT (nav_layout_json() ->> 'is_default') || '|' || (nav_layout_json() ->> 'can_edit') || '|' || jsonb_array_length(nav_layout_json() -> 'catalogue');
-- @end

-- @case NL-32
-- @title Control: the System Admin saves a layout and resets it; two audit rows with before and after
-- @category nav-layout
-- @actor ADMIN
-- @region *
-- @expect output Work|true|false|false|true|1|1
SELECT admin_set_nav_layout('{"headings": [{"id": "work", "name_en": "  Work  ", "name_ar": "العمل", "children": ["my_work"]}]}'::jsonb, 'A first layout',
  (nav_layout_json() ->> 'version')::int) -> 'layout' -> 'headings' -> 0 ->> 'name_en' AS n \gset
SELECT admin_set_nav_layout(NULL, 'Back to the default', (nav_layout_json() ->> 'version')::int) IS NOT NULL;
SELECT :'n' || '|' || (SELECT (before ->> 'is_default') || '|' || (after ->> 'is_default') FROM audit_log WHERE action = 'nav_layout_update' ORDER BY id DESC LIMIT 1)
  || '|' || (SELECT (before ->> 'is_default') || '|' || (after ->> 'is_default') FROM audit_log WHERE action = 'nav_layout_reset' ORDER BY id DESC LIMIT 1)
  || '|' || (SELECT count(*) FROM audit_log WHERE action = 'nav_layout_update') || '|' || (SELECT count(*) FROM audit_log WHERE action = 'nav_layout_reset');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The shape of the functions and the rights
-- ---------------------------------------------------------------------------------------------------------------------
-- @case NL-40
-- @title Every new function is SECURITY DEFINER with search_path pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked
-- @category nav-layout
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT 4 - count(*) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('nav_layout_clean', 'nav_layout_heading', 'nav_layout_json', 'admin_set_nav_layout')
  AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer'
  AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, public, pg_temp')
  AND NOT has_function_privilege('public', p.oid, 'EXECUTE');
-- @end

-- @case NL-41
-- @title The application role holds only the two doors, reads the catalogue and writes nothing in it
-- @category nav-layout
-- @actor ALICE
-- @region 1
-- @expect output admin_set_nav_layout,nav_layout_json|true|false|false|false
SELECT (SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('nav_layout_clean', 'nav_layout_heading', 'nav_layout_json', 'admin_set_nav_layout')
          AND has_function_privilege('pmis_app', p.oid, 'EXECUTE'))
  || '|' || has_table_privilege('pmis_app', 'nav_item_catalogue', 'SELECT') || '|' || has_table_privilege('pmis_app', 'nav_item_catalogue', 'INSERT')
  || '|' || has_table_privilege('pmis_app', 'nav_item_catalogue', 'UPDATE') || '|' || has_table_privilege('pmis_app', 'nav_item_catalogue', 'DELETE');
-- @end
