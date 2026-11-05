-- The one-time historical-load document waiver (migration 0073, decision on owner question Q462; contract 0.14.3). Only a System Admin (never a delegate) opens or closes
-- the setting `load.historical_waiver`, with a step-up; only a System Admin with a step-up marks a batch "accept without documents" while the waiver is open; the
-- flag `task_instances.historical_no_documents` and the mark of a batch are written by the definer functions and by nobody else; the setting has no other writer.
-- Alice: CW Team Lead in Tripoli, not a System Admin. DEL_ALL: a delegate of the System Admin, DEL_RD: a delegate who may re-delegate. ADMIN: the System Admin.
-- "\ctx ADMIN stepup=300" is a System Admin whose step-up is valid for five minutes (the runner signs the context with the test key).

-- ---------------------------------------------------------------------------------------------------------------------
-- Opening and closing: who, and with what
-- ---------------------------------------------------------------------------------------------------------------------
-- @case HW-01
-- @title Alice, who is not a System Admin, opens the waiver
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT hw_waiver_set(true, cal_today() - 30, 'Alice tries to open the waiver');
-- @end

-- @case HW-02
-- @title A delegate of the System Admin (every right delegated) opens the waiver: it cannot be delegated
-- @category historical-waiver
-- @actor DEL_ALL
-- @region *
-- @expect error P0001 action_forbidden
SELECT hw_waiver_set(true, cal_today() - 30, 'A delegate tries to open the waiver');
-- @end

-- @case HW-03
-- @title A delegate who may re-delegate opens the waiver
-- @category historical-waiver
-- @actor DEL_RD
-- @region *
-- @expect error P0001 action_forbidden
SELECT hw_waiver_set(true, cal_today() - 30, 'A re-delegating delegate tries to open the waiver');
-- @end

-- @case HW-04
-- @title The System Admin opens the waiver without a step-up
-- @category historical-waiver
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT hw_waiver_set(true, cal_today() - 30, 'No step-up');
-- @end

-- @case HW-05
-- @title The System Admin with a forged plain step-up setting (not signed) opens the waiver
-- @category historical-waiver
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SET app.stepup = 'true';
SET app.stepup_until = '2999-01-01';
SELECT hw_waiver_set(true, cal_today() - 30, 'Forged step-up');
-- @end

-- @case HW-06
-- @title No signed context at all (a forged user id of the System Admin, all regions, a step-up): the actor does not exist
-- @category historical-waiver
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SET app.stepup = 'true';
SELECT hw_waiver_set(true, cal_today() - 30, 'Forged context');
-- @end

-- @case HW-07
-- @title The System Admin with a step-up opens the waiver with a cutoff date in the future
-- @category historical-waiver
-- @expect error P0001 in_the_future
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() + 1, 'Cutoff in the future');
-- @end

-- @case HW-08
-- @title The System Admin with a step-up opens the waiver without a cutoff date
-- @category historical-waiver
-- @expect error P0001 cutoff date is required
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, NULL, 'No cutoff date');
-- @end

-- @case HW-09
-- @title The System Admin with a step-up opens the waiver without a reason
-- @category historical-waiver
-- @expect error P0001 reason of 3 to 1000
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, '  ');
-- @end

-- @case HW-10
-- @title The System Admin with a step-up closes a waiver that is not open
-- @category historical-waiver
-- @expect error P0001 invalid_transition
\ctx ADMIN stepup=300
SELECT hw_waiver_set(false, NULL, 'Close what is closed');
-- @end

-- @case HW-11
-- @title The System Admin with a step-up opens the waiver twice
-- @category historical-waiver
-- @expect error P0001 already open
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Open once') IS NOT NULL;
SELECT hw_waiver_set(true, cal_today() - 20, 'Open twice');
-- @end

-- @case HW-12
-- @title Positive control: the System Admin with a step-up opens the waiver; the effective state is open with a 30-day window (rolled back)
-- @category historical-waiver
-- @expect output true|30
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
SELECT (hw_waiver_state() ->> 'open') || '|' || (hw_waiver_state() ->> 'days_left');
-- @end

-- @case HW-13
-- @title Positive control: the state is readable by Alice, who cannot manage it, and the reason stays hidden from her
-- @category historical-waiver
-- @expect output false|true
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
\ctx ALICE
SELECT (hw_waiver_state() ->> 'can_manage') || '|' || ((hw_waiver_state() -> 'reason') = 'null'::jsonb)::text;
-- @end

-- @case HW-14
-- @title The state of the waiver is not readable without a signed-in actor
-- @category historical-waiver
-- @expect error 42501 no signed-in actor
SELECT hw_waiver_state();
-- @end

-- @case HW-15
-- @title The expiry function changes nothing while the waiver is closed, whoever calls it
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect output f
SELECT hw_waiver_expire();
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The setting has no other writer
-- ---------------------------------------------------------------------------------------------------------------------
-- @case HW-20
-- @title The System Admin (a step-up, every right) updates the setting directly
-- @category historical-waiver
-- @expect error 42501 written only by hw_waiver_set
\ctx ADMIN stepup=300
UPDATE settings SET value = '{"open": true, "cutoff_date": "2026-01-31", "expires_at": "2999-01-01T00:00:00Z"}'::jsonb WHERE key = 'load.historical_waiver';
-- @end

-- @case HW-21
-- @title The System Admin inserts the setting directly (an upsert over the existing row)
-- @category historical-waiver
-- @expect error 42501 written only by hw_waiver_set
\ctx ADMIN stepup=300
INSERT INTO settings (key, value, updated_at) VALUES ('load.historical_waiver', '{"open": true, "cutoff_date": "2026-01-31", "expires_at": "2999-01-01T00:00:00Z"}'::jsonb, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case HW-22
-- @title The System Admin deletes the setting
-- @category historical-waiver
-- @expect error 42501 written only by hw_waiver_set
\ctx ADMIN stepup=300
DELETE FROM settings WHERE key = 'load.historical_waiver';
-- @end

-- @case HW-23
-- @title The System Admin renames another setting into the waiver key
-- @category historical-waiver
-- @expect error 42501 written only by hw_waiver_set
\ctx ADMIN stepup=300
UPDATE settings SET key = 'load.historical_waiver' WHERE key = (SELECT min(key) FROM settings WHERE key <> 'load.historical_waiver');
-- @end

-- @case HW-24
-- @title The System Admin renames the waiver key into another one (the waiver would vanish)
-- @category historical-waiver
-- @expect error 42501 written only by hw_waiver_set
\ctx ADMIN stepup=300
UPDATE settings SET key = 'load.historical_waiver_old' WHERE key = 'load.historical_waiver';
-- @end

-- @case HW-25
-- @title Positive control: another setting is still written the usual way by the application role (the guard names one key)
-- @category historical-waiver
-- @expect output 1
\ctx ADMIN stepup=300
UPDATE settings SET description = description WHERE key = (SELECT min(key) FROM settings WHERE key <> 'load.historical_waiver');
SELECT count(*) FROM settings WHERE key = 'load.historical_waiver';
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The flag and the mark have no direct path
-- ---------------------------------------------------------------------------------------------------------------------
-- @case HW-30
-- @title Alice sets the flag on a task directly
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE task_instances SET historical_no_documents = true WHERE id = '00000000-0000-4000-8000-000000000000';
-- @end

-- @case HW-31
-- @title The System Admin sets the flag on a task directly
-- @category historical-waiver
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE task_instances SET historical_no_documents = true, historical_batch_id = '{{BATCH_STREAM_TRI}}', historical_flagged_at = now() WHERE id = '00000000-0000-4000-8000-000000000000';
-- @end

-- @case HW-32
-- @title Alice clears the flag of a task directly
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE task_instances SET historical_no_documents = false WHERE historical_no_documents;
-- @end

-- @case HW-33
-- @title Alice marks a stream batch directly
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_batches SET historical_load = true, historical_cutoff = cal_today() - 30, historical_reason = 'Alice marks it', historical_marked_by = '{{ALICE}}', historical_marked_at = now()
  WHERE id = '{{BATCH_STREAM_TRI}}';
-- @end

-- @case HW-34
-- @title The System Admin (a step-up) marks a stream batch directly
-- @category historical-waiver
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
UPDATE import_batches SET historical_load = true, historical_cutoff = cal_today() - 30, historical_reason = 'Admin marks it', historical_marked_by = '{{ADMIN}}', historical_marked_at = now()
  WHERE id = '{{BATCH_STREAM_TRI}}';
-- @end

-- @case HW-35
-- @title Alice inserts a batch that is already marked
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO import_batches (template_version_id, file_name, file_sha256, uploaded_by, stream_code, historical_load, historical_cutoff, historical_reason, historical_marked_by, historical_marked_at)
SELECT v.id, 'forged.xlsx', 'x', '{{ALICE}}', 'CW', true, cal_today() - 30, 'Forged', '{{ALICE}}', now()
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The marking of a batch through the doors that exist: staging a template file and applying a Master run
-- ---------------------------------------------------------------------------------------------------------------------
-- @case HW-40
-- @title Alice stages a stream file marked "accept without documents" while the waiver is open
-- @category historical-waiver
-- @expect error P0001 action_forbidden
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
\ctx ALICE
SELECT imp_stage_batch('TPL-SITE-CW', (SELECT v.version FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current),
  NULL, 'forged.xlsx', 'x', NULL, '[]'::jsonb, 'submit', '{"reason": "Alice wants no documents"}'::jsonb);
-- @end

-- @case HW-41
-- @title A delegate stages a stream file marked "accept without documents" while the waiver is open
-- @category historical-waiver
-- @expect error P0001 action_forbidden
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
\ctx DEL_ALL
SELECT imp_stage_batch('TPL-SITE-CW', (SELECT v.version FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current),
  NULL, 'forged.xlsx', 'x', NULL, '[]'::jsonb, 'submit', '{"reason": "A delegate wants no documents"}'::jsonb);
-- @end

-- @case HW-42
-- @title The System Admin without a fresh step-up stages a stream file marked "accept without documents"
-- @category historical-waiver
-- @expect error P0001 step_up_required
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
\ctx ADMIN
SELECT imp_stage_batch('TPL-SITE-CW', (SELECT v.version FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current),
  NULL, 'forged.xlsx', 'x', NULL, '[]'::jsonb, 'submit', '{"reason": "No step-up"}'::jsonb);
-- @end

-- @case HW-43
-- @title The System Admin with a step-up stages a marked stream file while the waiver is closed
-- @category historical-waiver
-- @expect error P0001 waiver is closed
\ctx ADMIN stepup=300
SELECT imp_stage_batch('TPL-SITE-CW', (SELECT v.version FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current),
  NULL, 'forged.xlsx', 'x', NULL, '[]'::jsonb, 'submit', '{"reason": "The waiver is closed"}'::jsonb);
-- @end

-- @case HW-44
-- @title The System Admin with a step-up stages a marked stream file in draft mode (a draft has no document check)
-- @category historical-waiver
-- @expect error P0001 draft has no document check
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
SELECT imp_stage_batch('TPL-SITE-CW', (SELECT v.version FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current),
  NULL, 'forged.xlsx', 'x', NULL, '[]'::jsonb, 'draft', '{"reason": "A draft"}'::jsonb);
-- @end

-- @case HW-45
-- @title The System Admin with a step-up marks a register template file: only the stream templates take the mark
-- @category historical-waiver
-- @expect error P0001 stream templates only
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
SELECT imp_stage_batch('TPL-GECOL', (SELECT v.version FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-GECOL' AND v.is_current),
  NULL, 'forged.xlsx', 'x', NULL, '[]'::jsonb, 'submit', '{"reason": "A register file"}'::jsonb);
-- @end

-- @case HW-46
-- @title Alice applies a Master run with the historical option (the legacy import is closed to her first)
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_apply_run('00000000-0000-4000-8000-000000000000'::uuid, NULL, 'submit', 'Alice wants no documents', true, '{"reason": "Alice wants no documents"}'::jsonb);
-- @end

-- @case HW-47
-- @title Alice applies a Master run with the historical option and a forged step-up flag: still the legacy import is not hers
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SET app.stepup = 'true';
SELECT mi_apply_run('00000000-0000-4000-8000-000000000000'::uuid, NULL, 'submit', 'Forged', true, '{"reason": "Forged"}'::jsonb);
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The internal functions are closed to the application role, and the new functions are made the way the rules say
-- ---------------------------------------------------------------------------------------------------------------------
-- @case HW-50
-- @title Alice calls the batch marking function
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hw_mark_batch('{{BATCH_STREAM_TRI}}'::uuid, 'Alice marks it', cal_today() - 30);
-- @end

-- @case HW-51
-- @title The System Admin (a step-up, the waiver open) calls the batch marking function
-- @category historical-waiver
-- @expect error 42501 permission denied for function
\ctx ADMIN stepup=300
SELECT hw_waiver_set(true, cal_today() - 30, 'Control: open for the case') IS NOT NULL;
SELECT hw_mark_batch('{{BATCH_STREAM_TRI}}'::uuid, 'Admin marks it', cal_today() - 30);
-- @end

-- @case HW-52
-- @title Alice calls the task flagging function
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hw_flag_task('00000000-0000-4000-8000-000000000000'::uuid, '{{BATCH_STREAM_TRI}}'::uuid, NULL, ARRAY['B6']);
-- @end

-- @case HW-53
-- @title Alice calls the function that clears the flag
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hw_recheck_task('00000000-0000-4000-8000-000000000000'::uuid);
-- @end

-- @case HW-54
-- @title Alice asks which batch covers a row (the row check is internal)
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hw_row_waiver('00000000-0000-4000-8000-000000000000'::uuid, '00000000-0000-4000-8000-000000000001'::uuid);
-- @end

-- @case HW-55
-- @title Alice calls the marking authorization (internal)
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hw_mark_authorize('A reason');
-- @end

-- @case HW-56
-- @title Alice calls the task submit with a batch row (wf_complete_hw takes the import row; only the definer functions call it)
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT wf_complete_hw('00000000-0000-4000-8000-000000000000'::uuid, NULL, 'submit', NULL, true, '00000000-0000-4000-8000-000000000001'::uuid);
-- @end

-- @case HW-57
-- @title Alice reads the raw setting through the internal reader
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hw_waiver_cfg();
-- @end

-- @case HW-58
-- @title Alice calls the guard trigger function of the tasks as a plain function
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hw_guard_task();
-- @end

-- @case HW-59
-- @title Alice calls the staging of a row with the cutoff parameter (the 8-argument form is internal)
-- @category historical-waiver
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_stage_task_row('[]'::jsonb, '{}'::jsonb, NULL, NULL, NULL, NULL, 'submit', cal_today());
-- @end

-- @case HW-60
-- @title Every function of migration 0073 is SECURITY DEFINER with a fixed search_path that ends in pg_temp, owned by pmis_definer, with PUBLIC revoked (the application role holds only the doors)
-- @category historical-waiver
-- @expect output ok
WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
         has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (p.proname LIKE 'hw\_%' OR p.proname = 'wf_complete_hw')
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) < 17 THEN 'too few functions'
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef AND proname <> 'hw_guard_settings') THEN 'not SECURITY DEFINER: ' || (SELECT min(proname) FROM f WHERE NOT prosecdef AND proname <> 'hw_guard_settings')
  WHEN EXISTS (SELECT 1 FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'search_path: ' || (SELECT min(proname) FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%'))
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner: ' || (SELECT min(proname) FROM f WHERE owner <> 'pmis_definer')
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC: ' || (SELECT min(proname) FROM f WHERE pub)
  WHEN (SELECT string_agg(proname, ',' ORDER BY proname) FROM f WHERE app) <> 'hw_waiver_expire,hw_waiver_set,hw_waiver_state' THEN 'doors: ' || (SELECT string_agg(proname, ',' ORDER BY proname) FROM f WHERE app)
  ELSE 'ok' END;
-- @end

-- @case HW-61
-- @title The new overloads of the staging and the apply keep owner pmis_definer and PUBLIC revoked; the application role holds the 9-argument staging and the 6-argument apply
-- @category historical-waiver
-- @expect output ok
WITH f AS (
  SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('imp_stage_batch', 'imp_stage_task_row', 'imp_stage_stream_batch', 'imp_stage_master_core', 'mi_apply_run', 'imp_submit_stream_batch',
                                               'wf_complete', 'doc_slot_owner_for_write', 'dash_build_tasks', 'dash_core')
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer' OR NOT prosecdef OR pub) THEN 'shape'
  WHEN (SELECT count(*) FROM f WHERE proname = 'imp_stage_task_row') <> 2 OR (SELECT count(*) FROM f WHERE proname = 'imp_stage_stream_batch') <> 2
       OR (SELECT count(*) FROM f WHERE proname = 'mi_apply_run') <> 2 OR (SELECT count(*) FROM f WHERE proname = 'imp_stage_master_core') <> 2 THEN 'overloads'
  WHEN EXISTS (SELECT 1 FROM f WHERE proname IN ('imp_stage_task_row', 'imp_stage_stream_batch', 'imp_stage_master_core', 'imp_submit_stream_batch', 'wf_complete') AND app) THEN 'internal granted'
  WHEN (SELECT count(*) FROM f WHERE proname = 'mi_apply_run' AND app) <> 2 OR (SELECT count(*) FROM f WHERE proname = 'imp_stage_batch' AND app) <> 3 THEN 'doors'
  ELSE 'ok' END;
-- @end

-- @case HW-62
-- @title The guards are in place: the triggers of the settings, the batches, the tasks and the slots, and the setting exists, closed
-- @category historical-waiver
-- @expect output 4|2|true
SELECT (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('hw_guard_settings', 'hw_guard_batch', 'hw_slot_filled', 'hw_guard_task_upd'))
  || '|' || (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('hw_guard_task_ins', 'hw_guard_task_upd'))
  || '|' || (SELECT (value ->> 'open')::boolean = false AND value -> 'cutoff_date' = 'null'::jsonb FROM settings WHERE key = 'load.historical_waiver');
-- @end
