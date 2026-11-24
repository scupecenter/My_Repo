-- The Library menu, Forms and Archive (W5, migration 0151, contract 0.15.69): the form templates (library_form_templates, written only by
-- lib_form_template_save / _approve / _retire with the Document Library right for all regions), the documents generated for sites
-- (library_generated_docs, written only by lib_generate, lib_generated_attach and lib_generated_void; the file read only through lib_generated_read,
-- which audits every read) and the guarded setting library.archive (admin_set_library_archive). Who generates: the L1 holder of the task, or
-- "Documents: generate" (library.forms create) for the region; a System Admin always may. Alice: CW Team Lead in Tripoli, no Document Library or
-- generate right and not the L1 holder of A1. DEL_ALL: a delegate for users, assignments and groups. ADMIN: the System Admin. Each case is rolled back.

-- @case LIB-01
-- @title pmis_app reads the file and the data of the generated documents directly, with no context
-- @category library
-- @expect error 42501 permission denied
SELECT html, data FROM library_generated_docs;
-- @end

-- @case LIB-02
-- @title The System Admin inserts an approved form template directly, around the door (no checks, no audit)
-- @category library
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO library_form_templates (code, version, name_en, doc_type_id, trigger_task_code, numbering_pattern, html, sha256, status, created_by)
SELECT 'SEC-FORGED', 1, 'Forged', id, 'A1', 'F-{YYYY}-{SEQ:4}', '<p>forged</p>', repeat('0', 64), 'approved', '{{ADMIN}}'::uuid FROM document_types WHERE code = 'A1';
-- @end

-- @case LIB-03
-- @title The System Admin writes a generated document directly (a number that the numbering service never issued)
-- @category library
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE library_generated_docs SET number = 'FORGED-1';
-- @end

-- @case LIB-04
-- @title Alice, with no Document Library right, uploads a form template through the door
-- @category library
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Alice tries');
-- @end

-- @case LIB-05
-- @title Alice, with a forged all-regions setting, approves a form template
-- @category library
-- @actor ALICE
-- @region *
-- @expect error 42501
SELECT lib_form_template_approve(gen_random_uuid(), 'Forged approval');
-- @end

-- @case LIB-06
-- @title A delegate for users and groups (not the Document Library) uploads a form template
-- @category library
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 System Admin or a delegation
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Delegate tries');
-- @end

-- @case LIB-07
-- @title The System Admin uploads a form with a script and an event handler
-- @category library
-- @expect error P0001 wf:validation_failed.*unsafe_html
\ctx ADMIN stepup=300
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}}</p><script>fetch(1)</script>"}'::jsonb, 'Script in a form');
-- @end

-- @case LIB-08
-- @title Alice generates the document of a Tripoli task she does not hold at L1 and has no "Documents: generate" right for
-- @category library
-- @expect error P0001 not_eligible_holder
\ctx ADMIN stepup=300
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Sec form');
SELECT lib_form_template_approve((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), 'Approved');
\ctx ALICE
SELECT lib_generate((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), '{{SITE_TRI}}'::uuid, NULL);
-- @end

-- @case LIB-09
-- @title Alice (Tripoli) generates for the Benghazi site with a forged all-regions setting: the site stays invisible
-- @category library
-- @expect error P0001 not_found
\ctx ADMIN stepup=300
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Sec form');
SELECT lib_form_template_approve((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), 'Approved');
\ctx ALICE
SET LOCAL app.region_ids = '*';
SELECT lib_generate((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), '{{SITE_BEN}}'::uuid, NULL);
-- @end

-- @case LIB-10
-- @title Alice attaches her own file to a document the System Admin generated (only the generator, once, in the same request)
-- @category library
-- @expect error 42501 attached once
\ctx ADMIN stepup=300
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Sec form');
SELECT lib_form_template_approve((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), 'Approved');
SELECT lib_generate((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), '{{SITE_TRI}}'::uuid, NULL);
\ctx ALICE
SELECT lib_generated_attach((SELECT id FROM library_generated_docs WHERE site_id = '{{SITE_TRI}}'::uuid), '<p>replaced by Alice</p>');
-- @end

-- @case LIB-11
-- @title The System Admin replaces the file of a generated document after it was attached
-- @category library
-- @expect error 42501 attached once
\ctx ADMIN stepup=300
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Sec form');
SELECT lib_form_template_approve((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), 'Approved');
SELECT lib_generate((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), '{{SITE_TRI}}'::uuid, NULL);
SELECT lib_generated_attach((SELECT id FROM library_generated_docs WHERE site_id = '{{SITE_TRI}}'::uuid), '<p>first</p>');
SELECT lib_generated_attach((SELECT id FROM library_generated_docs WHERE site_id = '{{SITE_TRI}}'::uuid), '<p>second</p>');
-- @end

-- @case LIB-12
-- @title Alice (Tripoli) downloads a document generated for the Benghazi site
-- @category library
-- @expect error P0001 not_found
\ctx ADMIN stepup=300
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Sec form');
SELECT lib_form_template_approve((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), 'Approved');
SELECT lib_generate((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), '{{SITE_BEN}}'::uuid, NULL);
SELECT lib_generated_attach((SELECT id FROM library_generated_docs WHERE site_id = '{{SITE_BEN}}'::uuid), '<p>Benghazi</p>');
\ctx ALICE
SELECT lib_generated_read((SELECT id FROM library_generated_docs WHERE site_id = '{{SITE_BEN}}'::uuid), 'download');
-- @end

-- @case LIB-13
-- @title Alice voids a document the System Admin generated for a Tripoli task she does not hold
-- @category library
-- @expect error P0001 not_eligible_holder
\ctx ADMIN stepup=300
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Sec form');
SELECT lib_form_template_approve((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), 'Approved');
SELECT lib_generate((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), '{{SITE_TRI}}'::uuid, NULL);
\ctx ALICE
SELECT lib_generated_void((SELECT id FROM library_generated_docs WHERE site_id = '{{SITE_TRI}}'::uuid), 'Alice voids it');
-- @end

-- @case LIB-14
-- @title The System Admin writes the setting library.archive directly (no reason, no checks, no audit row)
-- @category library
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO settings (key, value, updated_at) VALUES ('library.archive', '{"config": {"zip_limit": 999999}, "version": 9}'::jsonb, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case LIB-15
-- @title Alice changes the Archive cards and the zip limit through the door
-- @category library
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation
SELECT admin_set_library_archive('{"hidden": [], "order": [], "default_columns": ["site"], "zip_limit": 5000}'::jsonb, 'Alice tries', NULL);
-- @end

-- @case LIB-16
-- @title Alice calls the internal checks and the data builder of the forms
-- @category library
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT lib_form_context(gen_random_uuid(), '{{SITE_TRI}}'::uuid, NULL, 'X', NULL);
-- @end

-- @case LIB-17
-- @title Positive control: the System Admin generates a numbered document for the open Tripoli task
-- @category library
-- @expect output t
\ctx ADMIN stepup=300
SELECT lib_form_template_save('{"code": "SEC-F1", "name_en": "Sec form", "doc_code": "A1", "trigger_task_code": "A1", "numbering_pattern": "SECF-{YYYY}-{SEQ:4}", "html": "<p>{{site.id}} filled form</p>"}'::jsonb, 'Sec form');
SELECT lib_form_template_approve((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), 'Approved');
SELECT (lib_generate((SELECT id FROM library_form_templates WHERE code = 'SEC-F1'), '{{SITE_TRI}}'::uuid, NULL) ->> 'number') LIKE 'SECF-%';
-- @end

-- @case LIB-18
-- @title The shape of the new functions: SECURITY DEFINER, owner pmis_definer, fixed search_path, PUBLIC revoked; pmis_app only on the doors and readers
-- @category library
-- @actor ALICE
-- @region 1
-- @expect output 18
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer'
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
  AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
  AND p.proname IN ('lib_require_config', 'lib_form_template_json', 'lib_generated_json', 'lib_site_task', 'lib_can_generate', 'lib_form_context', 'lib_form_template_save',
                    'lib_form_template_approve', 'lib_form_template_retire', 'lib_form_template_html', 'lib_check_generate', 'lib_preview', 'lib_generate', 'lib_generated_attach',
                    'lib_generated_read', 'lib_generated_void', 'library_archive_json', 'admin_set_library_archive')
  AND has_function_privilege('pmis_app', p.oid, 'EXECUTE') = (p.proname NOT IN ('lib_require_config', 'lib_site_task', 'lib_form_context', 'lib_check_generate'));
-- @end
