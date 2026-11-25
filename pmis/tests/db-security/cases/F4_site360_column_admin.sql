-- Site 360 column administration (migration 0133, Workflow Studio S2, CHANGELOG 177): the doors site_master_column_create, site_master_column_update,
-- site_master_column_delete, site_master_column_set_active, site_master_column_type_preview, site_master_columns_list, site_master_column_get and site_master_set_sections, and
-- their helpers. Rights: the System Admin, or a delegate of `fields` edit for ALL regions; everyone else is refused; a reason; the ETag; audit with before
-- and after; protected columns; a column that held a value is never deleted; master_columns and template_task_fields are not writable by pmis_app.
-- ADMIN: the System Admin. ALICE: CW Team Lead in Tripoli, no `fields` right. DEL_TRI: a Tripoli-only delegate. DEL_ALL: an all-regions delegate whose fixture
-- grants are users, assignments and groups (no `fields`). The cases that need a `fields` delegation make it in the transaction (the System Admin delegates, then
-- the delegate acts). Every case is rolled back. site_master_set_sections uses the same right as the other doors (owner decision 2026-11-22, was admin.settings.edit).

-- @case SCA-01
-- @title Even the System Admin cannot INSERT into master_columns directly
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO master_columns (ord, letter, header, owner) VALUES (900, 'ZY', 'Forged', 'task');
-- @end

-- @case SCA-02
-- @title UPDATE master_columns directly (the type, the version) is refused
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE master_columns SET value_type = 'number', version = version + 1 WHERE ord = 1;
-- @end

-- @case SCA-03
-- @title DELETE from master_columns directly is refused
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM master_columns WHERE is_added;
-- @end

-- @case SCA-04
-- @title TRUNCATE master_columns is refused
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
TRUNCATE master_columns;
-- @end

-- @case SCA-05
-- @title INSERT into template_task_fields directly is refused
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO template_task_fields (task_code, field_key, label, field_type) VALUES ('A1', 'v:forged', 'Forged', 'text');
-- @end

-- @case SCA-06
-- @title UPDATE template_task_fields directly (master_col) is refused
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE template_task_fields SET master_col = 'ZZ';
-- @end

-- @case SCA-07
-- @title DELETE from template_task_fields directly is refused
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM template_task_fields WHERE field_key LIKE 'v:%';
-- @end

-- @case SCA-08
-- @title Alice cannot write master_columns directly
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE master_columns SET is_active = false WHERE ord = 1;
-- @end

-- @case SCA-10
-- @title The nine doors: SECURITY DEFINER, owner pmis_definer, search_path fixed, PUBLIC revoked, EXECUTE for pmis_app and no other grantee
-- @category site360-columns
-- @expect output ok
WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('site_master_col_can_admin','site_master_columns_list','site_master_column_get','site_master_column_type_preview','site_master_column_create','site_master_column_update','site_master_column_set_active','site_master_column_delete','site_master_set_sections')
), bad AS (
  SELECT proname || ':' || CASE
    WHEN NOT prosecdef THEN 'not definer'
    WHEN owner <> 'pmis_definer' THEN 'owner'
    WHEN NOT (coalesce(proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN 'search_path'
    WHEN has_function_privilege('public', oid, 'EXECUTE') THEN 'public'
    WHEN NOT has_function_privilege('pmis_app', oid, 'EXECUTE') THEN 'door'
    WHEN EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN ('pmis_definer', 'pmis_app')) THEN 'other grantee'
    END AS why FROM f
)
SELECT CASE WHEN (SELECT count(*) FROM f) <> 9 THEN 'doors: ' || (SELECT count(*) FROM f)::text
            WHEN EXISTS (SELECT 1 FROM bad WHERE why IS NOT NULL) THEN (SELECT string_agg(why, ', ') FROM bad WHERE why IS NOT NULL)
            ELSE 'ok' END;
-- @end

-- @case SCA-11
-- @title The twelve helpers: owner pmis_definer, search_path fixed, PUBLIC revoked, EXECUTE for pmis_definer only (not pmis_app)
-- @category site360-columns
-- @expect output ok
WITH f AS (
  SELECT p.oid, p.proname, p.proconfig, p.proacl, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('site_master_col_letter','site_master_col_header','site_master_col_slug','site_master_col_err','site_master_value_misfit','site_master_col_effective','site_master_col_json','site_master_col_values','site_master_col_other_source','site_master_col_detail','site_master_col_conversion','site_master_col_place_errors')
), bad AS (
  SELECT proname || ':' || CASE
    WHEN owner <> 'pmis_definer' THEN 'owner'
    WHEN NOT EXISTS (SELECT 1 FROM unnest(coalesce(proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=pg_catalog%') THEN 'search_path'
    WHEN has_function_privilege('public', oid, 'EXECUTE') THEN 'public'
    WHEN has_function_privilege('pmis_app', oid, 'EXECUTE') THEN 'pmis_app can execute'
    WHEN EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0 OR pg_get_userbyid(a.grantee) <> 'pmis_definer') THEN 'other grantee'
    END AS why FROM f
)
SELECT CASE WHEN (SELECT count(*) FROM f) <> 12 THEN 'helpers: ' || (SELECT count(*) FROM f)::text
            WHEN EXISTS (SELECT 1 FROM bad WHERE why IS NOT NULL) THEN (SELECT string_agg(why, ', ') FROM bad WHERE why IS NOT NULL)
            ELSE 'ok' END;
-- @end

-- @case SCA-12
-- @title Registry by catalogue: no SECURITY DEFINER function of the site360 column family lacks a fixed search_path, is open to PUBLIC or has another owner
-- @category site360-columns
-- @expect output ok
SELECT coalesce(string_agg(p.proname, ', '), 'ok') FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
  AND (p.proname LIKE 'site360\_col%' OR p.proname LIKE 'site360\_column%' OR p.proname = 'site_master_set_sections')
  AND (pg_get_userbyid(p.proowner) <> 'pmis_definer' OR has_function_privilege('public', p.oid, 'EXECUTE')
       OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=pg_catalog%'));
-- @end

-- @case SCA-13
-- @title Alice calls the value reader helper directly (it reads every site without the region filter): no EXECUTE
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM site_master_col_values(1);
-- @end

-- @case SCA-14
-- @title Alice calls the detail helper directly: no EXECUTE
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT site_master_col_detail(1);
-- @end

-- @case SCA-15
-- @title The System Admin calls the JSON helper directly: the helpers are not doors
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT site_master_col_json(1);
-- @end

-- @case SCA-20
-- @title A plain user (Alice) is refused by site_master_column create
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite refusal');
-- @end

-- @case SCA-21
-- @title A plain user (Alice) is refused by site_master_column update
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT site_master_column_update(1, NULL, '{"name_en":"Forged"}'::jsonb, false, 'Sec suite refusal');
-- @end

-- @case SCA-22
-- @title A plain user (Alice) is refused by site_master_column set_active
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT site_master_column_set_active(1, NULL, false, 'Sec suite refusal');
-- @end

-- @case SCA-23
-- @title A plain user (Alice) is refused by site_master_column delete
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT site_master_column_delete(188, NULL, 'Sec suite refusal');
-- @end

-- @case SCA-24
-- @title A plain user (Alice) is refused by site_master_column type_preview
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT site_master_column_type_preview(1, 'text', NULL);
-- @end

-- @case SCA-25
-- @title A plain user (Alice) is refused by site_master_column list
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT site_master_columns_list(true);
-- @end

-- @case SCA-26
-- @title A plain user (Alice) is refused by site_master_column get
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT site_master_column_get(1);
-- @end

-- @case SCA-27
-- @title A delegate of fields edit for Tripoli only is refused by site_master_column create (the change is global)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 admin path
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_TRI
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite refusal');
-- @end

-- @case SCA-28
-- @title A delegate of fields edit for Tripoli only is refused by site_master_column update (the change is global)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 admin path
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_TRI
SELECT site_master_column_update(1, NULL, '{"name_en":"Forged"}'::jsonb, false, 'Sec suite refusal');
-- @end

-- @case SCA-29
-- @title A delegate of fields edit for Tripoli only is refused by site_master_column set_active (the change is global)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 admin path
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_TRI
SELECT site_master_column_set_active(1, NULL, false, 'Sec suite refusal');
-- @end

-- @case SCA-30
-- @title A delegate of fields edit for Tripoli only is refused by site_master_column delete (the change is global)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 admin path
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_TRI
SELECT site_master_column_delete(188, NULL, 'Sec suite refusal');
-- @end

-- @case SCA-31
-- @title A delegate of fields edit for Tripoli only is refused by site_master_column type_preview (the change is global)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 admin path
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_TRI
SELECT site_master_column_type_preview(1, 'text', NULL);
-- @end

-- @case SCA-32
-- @title A delegate of fields edit for Tripoli only is refused by site_master_column list (the change is global)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 admin path
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_TRI
SELECT site_master_columns_list(true);
-- @end

-- @case SCA-33
-- @title A delegate of fields edit for Tripoli only is refused by site_master_column get (the change is global)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 admin path
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_TRI
SELECT site_master_column_get(1);
-- @end

-- @case SCA-34
-- @title A plain user is refused by site_master_set_sections
-- @category site360-columns
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT site_master_set_sections(1, ARRAY['cw'], 'Sec suite refusal');
-- @end

-- @case SCA-35
-- @title A Tripoli-only delegate of fields is refused by site_master_set_sections (the right must cover every region)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 action_forbidden
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_TRI}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_TRI
SELECT site_master_set_sections(1, ARRAY['cw'], 'Sec suite refusal');
-- @end

-- @case SCA-36
-- @title A request with no signed-in context is refused by site_master_column_create
-- @category site360-columns
-- @expect error 42501
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite refusal');
-- @end

-- @case SCA-37
-- @title A request with no signed-in context is refused by site_master_columns_list
-- @category site360-columns
-- @expect error 42501
SELECT site_master_columns_list(true);
-- @end

-- @case SCA-38
-- @title Alice forges app.region_ids = '*' and calls site_master_column_create: still refused
-- @category site360-columns
-- @actor ALICE
-- @region *
-- @expect error 42501 admin path
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite refusal');
-- @end

-- @case SCA-39
-- @title A delegate whose delegation is for another module (users, all regions) is refused by site_master_column_create
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error 42501 admin path
\ctx DEL_ALL
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite refusal');
-- @end

-- @case SCA-40
-- @title The System Admin creates, reads, updates, deactivates, reactivates, sets the menus of and deletes a column; the ETag moves with each write
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect output ok
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT site_master_column_update(:o, :v, '{"name_en":"Sec Col 2"}'::jsonb, false, 'Sec suite update')::jsonb ->> 'version' AS v2 \gset
SELECT site_master_column_set_active(:o, :v2, false, 'Sec suite deactivate')::jsonb ->> 'version' AS v3 \gset
SELECT site_master_column_set_active(:o, :v3, true, 'Sec suite reactivate')::jsonb ->> 'version' AS v4 \gset
SELECT site_master_set_sections(:o, ARRAY['te'], 'Sec suite menus') IS NOT NULL AS s \gset
SELECT (site_master_column_get(:o) ->> 'version')::int AS v5 \gset
SELECT jsonb_array_length(site_master_columns_list(true)) AS ln \gset
SELECT (site_master_column_type_preview(:o, 'number', NULL) ->> 'not_convertible')::int AS pv \gset
SELECT site_master_column_delete(:o, :v5, 'Sec suite delete') ->> 'deleted' AS dl \gset
SELECT CASE WHEN :v <> 1 THEN 'create version' WHEN :v2 <> 2 OR :v3 <> 3 OR :v4 <> 4 OR :v5 <> 5 THEN 'etag moves' WHEN :ln < 188 THEN 'list' WHEN :pv <> 0 THEN 'preview'
       WHEN :'dl' <> 'true' THEN 'delete' WHEN EXISTS (SELECT 1 FROM master_columns WHERE ord = :o) THEN 'row left'
       WHEN EXISTS (SELECT 1 FROM template_task_fields WHERE field_key = 'v:sec_col') THEN 'input left' ELSE 'ok' END;
-- @end

-- @case SCA-41
-- @title A delegate of fields edit for all regions creates, updates, deactivates and deletes a column; the audit rows carry the delegate as actor
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect output ok
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_ALL}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, true, NULL, NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_ALL
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT site_master_column_update(:o, :v, '{"name_en":"Sec Col 2"}'::jsonb, false, 'Sec suite update')::jsonb ->> 'version' AS v2 \gset
SELECT site_master_column_set_active(:o, :v2, false, 'Sec suite deactivate')::jsonb ->> 'version' AS v3 \gset
SELECT site_master_column_set_active(:o, :v3, true, 'Sec suite reactivate')::jsonb ->> 'version' AS v4 \gset
SELECT site_master_column_delete(:o, :v4, 'Sec suite delete') ->> 'deleted' AS dl \gset
\ctx ADMIN
SELECT CASE WHEN :'dl' <> 'true' THEN 'delete'
  WHEN (SELECT count(*) FROM audit_log WHERE entity_type = 'master_column' AND entity_id = :'lt' AND actor_id = '{{DEL_ALL}}') <> 5 THEN 'audit rows of the delegate'
  ELSE 'ok' END;
-- @end

-- @case SCA-42
-- @title A delegate of fields edit for all regions reads the list, one column and a type preview
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect output ok
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_ALL}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, true, NULL, NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_ALL
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT jsonb_array_length(site_master_columns_list(true)) AS ln \gset
SELECT site_master_column_get(:o) ->> 'letter' AS gl \gset
SELECT (site_master_column_type_preview(:o, 'date', NULL) ->> 'not_convertible')::int AS pv \gset
SELECT CASE WHEN :ln < 188 THEN 'list' WHEN :'gl' <> :'lt' THEN 'get' WHEN :pv <> 0 THEN 'preview' ELSE 'ok' END;
-- @end

-- @case SCA-43
-- @title Every successful write leaves one audit row with the reason, and before and after as the action requires
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect output ok
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT site_master_column_update(:o, :v, '{"name_en":"Sec Col 2"}'::jsonb, false, 'Sec suite audit')::jsonb ->> 'version' AS v2 \gset
SELECT site_master_column_set_active(:o, :v2, false, 'Sec suite audit')::jsonb ->> 'version' AS v3 \gset
SELECT site_master_column_set_active(:o, :v3, true, 'Sec suite audit')::jsonb ->> 'version' AS v4 \gset
SELECT site_master_set_sections(:o, ARRAY['te'], 'Sec suite audit') IS NOT NULL AS s \gset
SELECT (site_master_column_get(:o) ->> 'version')::int AS v5 \gset
SELECT site_master_column_delete(:o, :v5, 'Sec suite audit') ->> 'deleted' AS dl \gset
WITH a AS (SELECT action, "before" AS b, "after" AS f, reason, actor_id FROM audit_log WHERE entity_type = 'master_column' AND entity_id = :'lt')
SELECT CASE
  WHEN (SELECT count(*) FROM a) <> 6 THEN 'rows: ' || (SELECT count(*) FROM a)::text
  WHEN EXISTS (SELECT 1 FROM a WHERE actor_id IS DISTINCT FROM '{{ADMIN}}'::uuid) THEN 'actor'
  WHEN EXISTS (SELECT 1 FROM a WHERE reason IS NULL OR char_length(reason) < 3) THEN 'reason'
  WHEN NOT EXISTS (SELECT 1 FROM a WHERE action = 'site_master.column_created' AND b IS NULL AND f IS NOT NULL) THEN 'created'
  WHEN NOT EXISTS (SELECT 1 FROM a WHERE action = 'site_master.column_updated' AND b IS NOT NULL AND f IS NOT NULL AND b <> f) THEN 'updated'
  WHEN NOT EXISTS (SELECT 1 FROM a WHERE action = 'site_master.column_deactivated' AND b IS NOT NULL AND f IS NOT NULL AND b <> f) THEN 'deactivated'
  WHEN NOT EXISTS (SELECT 1 FROM a WHERE action = 'site_master.column_reactivated' AND b IS NOT NULL AND f IS NOT NULL AND b <> f) THEN 'reactivated'
  WHEN NOT EXISTS (SELECT 1 FROM a WHERE action = 'site_master.column_sections_changed' AND b IS NOT NULL AND f IS NOT NULL AND b <> f) THEN 'sections'
  WHEN NOT EXISTS (SELECT 1 FROM a WHERE action = 'site_master.column_deleted' AND b IS NOT NULL AND f IS NULL) THEN 'deleted'
  ELSE 'ok' END;
-- @end

-- @case SCA-44
-- @title The System Admin calls site360 create with no reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, NULL);
-- @end

-- @case SCA-45
-- @title The System Admin calls site360 create with a blank reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, '   ');
-- @end

-- @case SCA-46
-- @title The System Admin calls site360 create with a two-letter reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'ab');
-- @end

-- @case SCA-47
-- @title The System Admin calls site360 update with no reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_update(:o, :v, '{"name_en":"Sec Col 2"}'::jsonb, false, NULL);
-- @end

-- @case SCA-48
-- @title The System Admin calls site360 update with a blank reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_update(:o, :v, '{"name_en":"Sec Col 2"}'::jsonb, false, '   ');
-- @end

-- @case SCA-49
-- @title The System Admin calls site360 update with a two-letter reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_update(:o, :v, '{"name_en":"Sec Col 2"}'::jsonb, false, 'ab');
-- @end

-- @case SCA-50
-- @title The System Admin calls site360 set_active with no reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_set_active(:o, :v, false, NULL);
-- @end

-- @case SCA-51
-- @title The System Admin calls site360 set_active with a blank reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_set_active(:o, :v, false, '   ');
-- @end

-- @case SCA-52
-- @title The System Admin calls site360 set_active with a two-letter reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_set_active(:o, :v, false, 'ab');
-- @end

-- @case SCA-53
-- @title The System Admin calls site360 delete with no reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_delete(:o, :v, NULL);
-- @end

-- @case SCA-54
-- @title The System Admin calls site360 delete with a blank reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_delete(:o, :v, '   ');
-- @end

-- @case SCA-55
-- @title The System Admin calls site360 delete with a two-letter reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_delete(:o, :v, 'ab');
-- @end

-- @case SCA-56
-- @title The System Admin calls site360 set_sections with no reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_set_sections(:o, ARRAY['te'], NULL);
-- @end

-- @case SCA-57
-- @title The System Admin calls site360 set_sections with a blank reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_set_sections(:o, ARRAY['te'], '   ');
-- @end

-- @case SCA-58
-- @title The System Admin calls site360 set_sections with a two-letter reason: refused, nothing changes
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|required
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_set_sections(:o, ARRAY['te'], 'ab');
-- @end

-- @case SCA-59
-- @title A stale version (ETag) is refused by site_master_column_update
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_update(:o, :v + 7, '{"name_en":"Sec Col 2"}'::jsonb, false, 'Sec suite stale');
-- @end

-- @case SCA-60
-- @title A stale version is refused by site_master_column_set_active
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_set_active(:o, :v + 7, false, 'Sec suite stale');
-- @end

-- @case SCA-61
-- @title A stale version is refused by site_master_column_delete
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_delete(:o, :v + 7, 'Sec suite stale');
-- @end

-- @case SCA-62
-- @title A version read before another admin's write is refused (the write bumped it)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT site_master_column_update(:o, :v, '{"name_en":"Sec Col 2"}'::jsonb, false, 'Sec suite first') IS NOT NULL AS first \gset
SELECT site_master_column_update(:o, :v, '{"name_en":"Sec Col 3"}'::jsonb, false, 'Sec suite second');
-- @end

-- @case SCA-63
-- @title A stale version is refused after site_master_set_sections bumped it
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT site_master_set_sections(:o, ARRAY['te'], 'Sec suite menus') IS NOT NULL AS s \gset
SELECT site_master_column_set_active(:o, :v, false, 'Sec suite stale');
-- @end

-- @case SCA-64
-- @title A protected column refuses a type change
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 system_field
SELECT site_master_column_update((SELECT ord FROM master_columns WHERE is_protected AND ord <= 187 ORDER BY ord LIMIT 1), NULL, '{"value_type":"number"}'::jsonb, true, 'Sec suite protected');
-- @end

-- @case SCA-65
-- @title A protected column refuses a list change
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 system_field
SELECT site_master_column_update((SELECT ord FROM master_columns WHERE is_protected AND ord <= 187 ORDER BY ord LIMIT 1), NULL, '{"value_type":"list","list_catalogue":"regions"}'::jsonb, true, 'Sec suite protected');
-- @end

-- @case SCA-66
-- @title A protected column refuses a place change (band, group, position)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 system_field
SELECT site_master_column_update((SELECT ord FROM master_columns WHERE is_protected AND ord <= 187 ORDER BY ord LIMIT 1), NULL, '{"after_ord":187}'::jsonb, true, 'Sec suite protected');
-- @end

-- @case SCA-67
-- @title A protected column refuses deactivation
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 system_field
SELECT site_master_column_set_active((SELECT ord FROM master_columns WHERE is_protected AND ord <= 187 ORDER BY ord LIMIT 1), NULL, false, 'Sec suite protected');
-- @end

-- @case SCA-68
-- @title A protected column refuses deletion
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 system_field
SELECT site_master_column_delete((SELECT ord FROM master_columns WHERE is_protected AND ord <= 187 ORDER BY ord LIMIT 1), NULL, 'Sec suite protected');
-- @end

-- @case SCA-69
-- @title A protected column refuses a type preview
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 system_field
SELECT site_master_column_type_preview((SELECT ord FROM master_columns WHERE is_protected AND ord <= 187 ORDER BY ord LIMIT 1), 'number', NULL);
-- @end

-- @case SCA-70
-- @title A protected column still takes a rename (the one change it allows)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect output ok
SELECT (SELECT ord FROM master_columns WHERE is_protected AND ord <= 187 ORDER BY ord LIMIT 1) AS po \gset
SELECT site_master_column_update(:po, NULL, '{"name_ar":"Sec Ar"}'::jsonb, false, 'Sec suite rename') ->> 'name_ar' AS nm \gset
SELECT CASE WHEN :'nm' = 'Sec Ar' THEN 'ok' ELSE 'rename' END;
-- @end

-- @case SCA-71
-- @title An original column that is not protected keeps its place: band, group and position changes are refused
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 system_field
SELECT site_master_column_update((SELECT ord FROM master_columns WHERE NOT is_protected AND NOT is_added AND ord <= 187 ORDER BY ord LIMIT 1), NULL, '{"group_top":"SEC BAND"}'::jsonb, false, 'Sec suite original');
-- @end

-- @case SCA-72
-- @title An original column is never deleted
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 system_field
SELECT site_master_column_delete((SELECT ord FROM master_columns WHERE NOT is_protected AND NOT is_added AND ord <= 187 ORDER BY ord LIMIT 1), NULL, 'Sec suite original');
-- @end

-- @case SCA-73
-- @title A reserved band (Phase Gate) is refused for a new column
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|reserved_band
SELECT site_master_column_create(replace('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb::text, 'SEC BAND', 'Phase Gate')::jsonb, 'Sec suite reserved');
-- @end

-- @case SCA-74
-- @title An unknown key in the create body is refused (no way to set is_protected, version or ord)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|unknown_field
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb || '{"is_protected":false,"ord":5,"version":9}'::jsonb, 'Sec suite keys');
-- @end

-- @case SCA-75
-- @title An unknown key in the update patch is refused
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed|unknown_field
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_update(:o, :v, '{"version":99,"is_added":false}'::jsonb, false, 'Sec suite keys');
-- @end

-- @case SCA-76
-- @title A column that held a value cannot be deleted (the deactivate path is the answer)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 column_in_use
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT version AS tv FROM task_instances WHERE id = '{{TASK_TRI}}' \gset
SELECT wf_save_entry('{{TASK_TRI}}'::uuid, :tv, '{"values":{"sec_col":"synthetic value"}}'::jsonb) IS NOT NULL AS saved \gset
SELECT site_master_column_delete(:o, :v, 'Sec suite in use');
-- @end

-- @case SCA-77
-- @title A column that holds a value reports value_count 1 and delete_mode deactivate, and can still be deactivated
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect output ok
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT version AS tv FROM task_instances WHERE id = '{{TASK_TRI}}' \gset
SELECT wf_save_entry('{{TASK_TRI}}'::uuid, :tv, '{"values":{"sec_col":"synthetic value"}}'::jsonb) IS NOT NULL AS saved \gset

SELECT site_master_column_get(:o) ->> 'delete_mode' AS dm, (site_master_column_get(:o) ->> 'value_count')::int AS vc \gset
SELECT site_master_column_set_active(:o, :v, false, 'Sec suite deactivate') ->> 'is_active' AS ia \gset
SELECT CASE WHEN :'dm' <> 'deactivate' THEN 'delete_mode' WHEN :vc <> 1 THEN 'value_count' WHEN :'ia' <> 'false' THEN 'deactivate' ELSE 'ok' END;
-- @end

-- @case SCA-78
-- @title A column with a stored value refuses a type change to a type the value does not fit unless confirmed
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 conversion_unconfirmed
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset

SELECT version AS tv FROM task_instances WHERE id = '{{TASK_TRI}}' \gset
SELECT wf_save_entry('{{TASK_TRI}}'::uuid, :tv, '{"values":{"sec_col":"synthetic value"}}'::jsonb) IS NOT NULL AS saved \gset
SELECT site_master_column_update(:o, :v, '{"value_type":"number"}'::jsonb, false, 'Sec suite convert');
-- @end

-- @case SCA-79
-- @title The type preview refuses a list type without a dropdown list
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT site_master_column_create('{"name_en":"Sec Col","name_ar":"Sec Ar","group_top":"SEC BAND","after_ord":187,"value_type":"text","source":{"kind":"task_input","task_code":"A1"},"sections":["cw"]}'::jsonb, 'Sec suite create')::text AS cr \gset
SELECT (:'cr'::jsonb ->> 'ord')::int AS o, (:'cr'::jsonb ->> 'version')::int AS v, :'cr'::jsonb ->> 'letter' AS lt \gset
SELECT site_master_column_type_preview(:o, 'list', NULL);
-- @end

-- @case SCA-80
-- @title A delegate of admin.settings edit (no fields right) is refused by site_master_set_sections (one right since 2026-11-22)
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect error P0001 action_forbidden
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_ALL}}', NULL, NULL, false, '[{"module":"admin.settings","action":"edit"}]'::jsonb, true, NULL, NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_ALL
SELECT site_master_set_sections(1, ARRAY['cw'], 'Sec suite refusal');
-- @end

-- @case SCA-81
-- @title A delegate of fields edit for all regions changes the menus of a column with site_master_set_sections, audited as the delegate
-- @category site360-columns
-- @actor ADMIN
-- @region *
-- @expect output ok
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{DEL_ALL}}', NULL, NULL, false, '[{"module":"fields","action":"edit"}]'::jsonb, true, NULL, NULL, NULL, false, NULL, 'Sec suite delegation') AS dlg \gset
\ctx DEL_ALL
SELECT site_master_set_sections(1, ARRAY['cw', 'te'], 'Sec suite sections')::text AS r \gset
\ctx ADMIN
SELECT CASE WHEN NOT (SELECT site_master_sections @> ARRAY['cw', 'te'] FROM master_columns WHERE ord = 1) THEN 'sections'
  WHEN (SELECT count(*) FROM audit_log WHERE action = 'site_master.column_sections_changed' AND actor_id = '{{DEL_ALL}}') <> 1 THEN 'audit row of the delegate'
  ELSE 'ok' END;
-- @end
