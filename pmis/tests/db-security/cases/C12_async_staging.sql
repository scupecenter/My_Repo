-- Big template uploads staged in the background (migration 0083, technical decision of 2026-11-09; contract 0.15.3). The request records the upload
-- (imp_upload_start: every check the staging makes before its rows) and the parsed rows wait in import_uploads; imp_upload_step stages them part by part under a
-- signed context of the same person. The legacy Master comparison does the same (mi_stage_start, then imp_upload_step). The table has no right for pmis_app;
-- nobody but the uploader sees, continues or stops an upload; a session without a signed person can do nothing; the internal parts are closed.
-- Every case runs in its own transaction, which the runner rolls back.

-- ---------------------------------------------------------------------------------------------------------------------
-- The upload table and the internal parts are closed to the application role
-- ---------------------------------------------------------------------------------------------------------------------
-- @case AU-01
-- @title Alice reads the stored uploads (the parsed rows of other people's files) directly
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM import_uploads;
-- @end

-- @case AU-02
-- @title The System Admin inserts an upload directly (to have rows staged under another person's name)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO import_uploads (actor_id, kind, template_id, template_version, file_name, file_sha256, mode, units, units_total, file_rows, unit_rows_total)
VALUES ('{{ALICE}}', 'single', 'TPL-SITE-CW', 1, 'forged.xlsx', repeat('d', 64), 'submit', '[]'::jsonb, 1, 1, 1);
-- @end

-- @case AU-03
-- @title Alice takes over the uploads directly
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_uploads SET actor_id = '{{ALICE}}';
-- @end

-- @case AU-04
-- @title Alice deletes the uploads
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM import_uploads;
-- @end

-- @case AU-05
-- @title The System Admin evaluates rows of a stream batch with a forged context (regions and historical cutoff passed as a parameter)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT imp_stream_eval('{"version_id": "00000000-0000-4000-8000-0000000c0001", "r_view": null, "r_import": null, "r_edit": null, "hw_cutoff": "2999-01-01"}'::jsonb, '[]'::jsonb, 'submit', 'Data');
-- @end

-- @case AU-06
-- @title The System Admin writes a stream batch from forged results (the internal end of the staging)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT imp_stream_close('{"version_id": "00000000-0000-4000-8000-0000000c0001", "hw_cutoff": "2999-01-01"}'::jsonb, '[]'::jsonb, 'f.xlsx', repeat('e', 64), NULL, 'template', 'Data', 'submit',
  '{"reason": "forged"}'::jsonb, NULL);
-- @end

-- @case AU-07
-- @title Alice writes the rows of a task batch directly (the flattening of 0083)
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_insert_task_batch('00000000-0000-4000-8000-0000000c0001', 'TPL-SITE-CW', 'CW', 'f.xlsx', repeat('e', 64), NULL, 'Data', '[]'::jsonb, NULL, NULL, 'template');
-- @end

-- @case AU-08
-- @title Alice stages one unit of a Master file (with a historical mark passed as a parameter)
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_master_unit('{"kind": "skip", "sheet": "X"}'::jsonb, 'f.xlsx', repeat('e', 64), 'submit', 'master_template', NULL, '{"reason": "forged"}'::jsonb, NULL);
-- @end

-- @case AU-09
-- @title Alice ends an upload (the internal close) or writes the audit row of a Master group
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_upload_close('00000000-0000-4000-8000-0000000c0002', 'done', NULL, NULL, NULL);
-- @end

-- @case AU-10
-- @title Alice writes the old-version note of a batch (the internal post-step of imp_stage_batch)
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_batch_post('00000000-0000-4000-8000-0000000c0003', 'TPL-SITE-CW', '{"file_v": 1, "version": 2}'::jsonb);
-- @end

-- @case AU-11
-- @title The System Admin compares rows of a legacy run with a forged column map and counters (the internal rows part of the comparison)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mi_stage_rows('{"run_id": "00000000-0000-4000-8000-0000000c0004", "fmap": {}, "cmeta": []}'::jsonb, '[]'::jsonb, '{}'::jsonb);
-- @end

-- @case AU-12
-- @title The System Admin ends a legacy comparison he did not run (the internal end: summary, status, audit)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mi_stage_close('{"run_id": "00000000-0000-4000-8000-0000000c0004"}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'f.xlsx', repeat('e', 64), 1, NULL);
-- @end

-- @case AU-13
-- @title The System Admin opens a legacy run in a status he chooses (the internal structure part)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mi_stage_open('f.xlsx', repeat('e', 64), 1, NULL, '["Master"]'::jsonb, '[]'::jsonb, 0, 'previewed');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- No signed person: nothing
-- ---------------------------------------------------------------------------------------------------------------------
-- @case AU-20
-- @title No signed context (plain settings naming the System Admin): an upload cannot be recorded
-- @category async-staging
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT imp_upload_start('TPL-SITE-CW', 1, NULL, 'single', 'f.xlsx', repeat('a', 64), NULL, 'submit', NULL, '[]'::jsonb, '[]'::jsonb, 60, NULL);
-- @end

-- @case AU-21
-- @title No signed context: an upload cannot be continued
-- @category async-staging
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SELECT imp_upload_step('00000000-0000-4000-8000-0000000c0002', 100);
-- @end

-- @case AU-22
-- @title No signed context: a legacy comparison cannot be started
-- @category async-staging
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SELECT mi_stage_start('f.xlsx', repeat('a', 64), 1, NULL, '["Master"]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL);
-- @end

-- @case AU-23
-- @title No signed context: the upload list and the comparison progress are empty
-- @category async-staging
-- @expect output []|none
SET app.user_id = '{{ADMIN}}';
SELECT imp_uploads_running_json()::text || '|' || coalesce((SELECT mi_run_staging_json(id)::text FROM master_reconciliation_runs LIMIT 1), 'none');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- An upload of the System Admin: only he sees, continues or stops it; the same file twice is refused
-- ---------------------------------------------------------------------------------------------------------------------
-- @case AU-30
-- @title Control: the System Admin records the upload of a stream file; it is running and only its uploader reads it
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect output running|1|1
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('a', 64), NULL, 'submit', NULL,
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL) ->> 'upload_id' AS uid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current \gset
SELECT (imp_upload_json(:'uid'::uuid) ->> 'state') || '|' || jsonb_array_length(imp_uploads_running_json()) || '|' || (SELECT count(*) FROM imp_upload_pending(0) WHERE upload_id = :'uid'::uuid);
-- @end

-- @case AU-31
-- @title Alice reads the System Admin's upload: nothing (not even its progress)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect output none|0
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('a', 64), NULL, 'submit', NULL,
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL) ->> 'upload_id' AS uid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current \gset
\ctx ALICE
SELECT coalesce(imp_upload_json(:'uid'::uuid)::text, 'none') || '|' || jsonb_array_length(imp_uploads_running_json());
-- @end

-- @case AU-32
-- @title Alice continues the System Admin's upload under her own name
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error 42501 only the person who uploaded the file
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('a', 64), NULL, 'submit', NULL,
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL) ->> 'upload_id' AS uid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current \gset
\ctx ALICE
SELECT imp_upload_step(:'uid'::uuid, 100);
-- @end

-- @case AU-33
-- @title Alice stops the System Admin's upload (who can still act)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error 42501 only the person who uploaded the file
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('a', 64), NULL, 'submit', NULL,
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL) ->> 'upload_id' AS uid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current \gset
\ctx ALICE
SELECT imp_upload_abandon(:'uid'::uuid, 'not mine');
-- @end

-- @case AU-34
-- @title The same file of the same person while it is staged: refused (409 upload_processing)
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect error P0001 upload_processing
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('a', 64), NULL, 'submit', NULL,
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL)
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current;
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('a', 64), NULL, 'submit', NULL,
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL)
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current;
-- @end

-- @case AU-35
-- @title Control: the uploader's step stages the batch (the same staging as the request), records it on the upload and clears the parsed rows
-- @category async-staging
-- @actor ADMIN
-- @region *
-- @expect output done|1|1|true
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('a', 64), NULL, 'submit', NULL,
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL) ->> 'upload_id' AS uid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current \gset
SELECT imp_upload_step(:'uid'::uuid, 100) ->> 'state' AS st \gset
SELECT :'st' || '|' || jsonb_array_length(imp_upload_json(:'uid'::uuid) -> 'batches') || '|'
  || (SELECT count(*) FROM import_batch_rows r WHERE r.batch_id = (imp_upload_json(:'uid'::uuid) -> 'batches' -> 0 ->> 'id')::uuid AND r.action = 'error') || '|'
  || ((SELECT b.uploaded_by FROM import_batches b WHERE b.id = (imp_upload_json(:'uid'::uuid) -> 'batches' -> 0 ->> 'id')::uuid) = '{{ADMIN}}'::uuid)::text;
-- @end

-- @case AU-36
-- @title A person without the import right records an upload: refused by the checks of the staging (nothing stored)
-- @category async-staging
-- @actor BOB
-- @region 1
-- @expect error P0001 template_rejected|action_forbidden|not_found
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('b', 64), NULL, 'submit', NULL,
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL)
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current;
-- @end

-- @case AU-37
-- @title Alice marks her upload "historical load: accept without documents": only a System Admin with a step-up (checked at the request)
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden|template_rejected
SELECT imp_upload_start('TPL-SITE-CW', v.version, v.header_checksum, 'single', 'sec-up.xlsx', repeat('c', 64), NULL, 'submit', 'forged historical load',
  '[{"row_no": 2, "sheet": "Data", "site_code": "NO-SUCH-SITE", "cells": {}, "pre_errors": []}]'::jsonb, '[]'::jsonb, 1, NULL)
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current;
-- @end

-- @case AU-38
-- @title Alice starts a legacy Master comparison: the legacy import is for a System Admin or a delegate of templates administer
-- @category async-staging
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_stage_start('GSDN_Site_Master.xlsx', repeat('a', 64), 1, NULL, '["Master"]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL);
-- @end
