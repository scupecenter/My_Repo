-- Register and stream batches in the background, the Master import apply, and the Settings field of the threshold (migration 0075, technical decision of
-- 2026-11-05 (6); contract 0.14.6). A send or a decision of a register or a stream batch with more rows than imports.async_rows is asked by the request
-- (imp_async_start, every check of the request, the step-up read from the verified context) and done chunk by chunk (imp_async_step) under a signed context of the same
-- person. The internal parts (the rows and the end of each send and decision, the checks of a decision, the kind and chunk size, the start of a register or stream
-- run) are closed to the application role; nobody else continues, stops or reads the tasks of the run of a person who can still act, and a session without a verified
-- context touches nothing. The setting imports.async_rows changes only through admin_set_imports_async_rows (a System Admin or a delegate of settings edit for all
-- regions, a reason, range 10 to 500, audited); a direct write, a delete, an insert and a rename are refused for every session. The helpers rewritten in PL/pgSQL
-- (the hot spot) keep their owner, search_path and grants.
-- The register batches are Meetings (a register without a site: global rows, the System Admin is the holder of last resort). Every case stages its own batch of 60
-- rows in its own transaction, which the runner rolls back.

-- ---------------------------------------------------------------------------------------------------------------------
-- The internal parts are closed to the application role
-- ---------------------------------------------------------------------------------------------------------------------
-- @case RB-01
-- @title The System Admin sends register rows with a step-up passed as a parameter (the internal rows part of the send)
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT imp_submit_register_rows('00000000-0000-4000-8000-0000000b0002', NULL, true, true);
-- @end

-- @case RB-02
-- @title The System Admin decides register rows with a step-up passed as a parameter
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT imp_decide_register_rows('00000000-0000-4000-8000-0000000b0002', 'approve', 'all', NULL, NULL, true, true);
-- @end

-- @case RB-03
-- @title The System Admin sends stream rows with a step-up passed as a parameter
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT imp_submit_stream_rows('00000000-0000-4000-8000-0000000b0004', NULL, true, true);
-- @end

-- @case RB-04
-- @title The System Admin decides stream rows with a step-up passed as a parameter
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT imp_decide_stream_rows('00000000-0000-4000-8000-0000000b0004', 'approve', 'all', NULL, NULL, true, true);
-- @end

-- @case RB-05
-- @title Alice writes the end of a register send (status, audit row) without doing it
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_submit_register_finish('00000000-0000-4000-8000-0000000b0002', 'validated', 0, 0, 0);
-- @end

-- @case RB-06
-- @title Alice writes the end of a stream decision (status, audit row, notice)
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_decide_stream_finish('00000000-0000-4000-8000-0000000b0004', 'approve', 'all', NULL, 1, 1, 0, 0, 0);
-- @end

-- @case RB-07
-- @title Alice calls the start of a register run directly (around the guard of imp_async_start)
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_async_start_rs('00000000-0000-4000-8000-0000000b0002', NULL, 'submit', NULL, NULL, NULL, NULL, now() + interval '1 hour');
-- @end

-- @case RB-08
-- @title Alice calls the checks of a decision (which discard a batch)
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_decide_checks((SELECT b FROM import_batches b WHERE b.id = '00000000-0000-4000-8000-0000000b0002'), 'discard', 'all', NULL, 'gone');
-- @end

-- @case RB-09
-- @title Alice (not a System Admin, no templates administer) calls the Master import apply through the old signature: refused before anything is staged
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_apply_run('00000000-0000-4000-8000-0000000b0009', NULL, 'submit', 'forged apply', true);
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- A register run: the checks of the request, and nobody else continues it
-- ---------------------------------------------------------------------------------------------------------------------
-- @case RB-20
-- @title No signed context: a register run cannot be asked (forged plain settings of the System Admin)
-- @category async-register-batches
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SET app.stepup = 'true';
SELECT imp_async_start('00000000-0000-4000-8000-0000000b0002', NULL, 'submit', NULL, NULL, NULL, NULL, now() + interval '1 hour');
-- @end

-- @case RB-21
-- @title Alice asks for the send of the System Admin's register batch: she is not the uploader
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 not_found|not_eligible_holder
SELECT imp_stage_batch('TPL-MTG', v.version, v.header_checksum, 'sec-async-reg.xlsx', repeat('d', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'data', jsonb_build_object('meeting_date', '2026-02-03', 'title', 'SECAR21 meeting ' || i),
     'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb)) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG' AND v.is_current \gset
SELECT version AS ver FROM import_batches WHERE id = :'bid' \gset
\ctx ALICE stepup=300
SELECT imp_async_start(:'bid'::uuid, :ver, 'submit', NULL, NULL, NULL, NULL, now() + interval '1 hour');
-- @end

-- @case RB-22
-- @title Control: the System Admin's send of 60 register rows is queued; the batch shows processing; the progress names the register kind
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect output true|processing|register|60
SELECT imp_stage_batch('TPL-MTG', v.version, v.header_checksum, 'sec-async-reg.xlsx', repeat('d', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'data', jsonb_build_object('meeting_date', '2026-02-03', 'title', 'SECAR22 meeting ' || i),
     'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb)) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') ->> 'queued' AS q \gset
SELECT :'q' || '|' || imp_status_of(:'bid'::uuid) || '|' || (imp_batch_job_json(:'bid'::uuid) ->> 'batch_kind') || '|' || (imp_batch_job_json(:'bid'::uuid) ->> 'rows_total');
-- @end

-- @case RB-23
-- @title Alice continues the System Admin's register run under her own name
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 only the person who asked
SELECT imp_stage_batch('TPL-MTG', v.version, v.header_checksum, 'sec-async-reg.xlsx', repeat('d', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'data', jsonb_build_object('meeting_date', '2026-02-03', 'title', 'SECAR23 meeting ' || i),
     'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb)) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
\ctx ALICE stepup=300
SELECT imp_async_step(:'jid'::uuid, NULL);
-- @end

-- @case RB-24
-- @title No signed context: the register run of an active person cannot be stopped (forged plain user id)
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 only the person who asked
SELECT imp_stage_batch('TPL-MTG', v.version, v.header_checksum, 'sec-async-reg.xlsx', repeat('d', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'data', jsonb_build_object('meeting_date', '2026-02-03', 'title', 'SECAR24 meeting ' || i),
     'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb)) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
SELECT set_config('app.ctx', '', true), set_config('app.ctx_mac', '', true);
SET app.user_id = '{{ADMIN}}';
SELECT imp_async_abandon(:'jid'::uuid, 'forged');
-- @end

-- @case RB-25
-- @title No signed context: the tasks of the next chunk of a run cannot be read
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 no signed-in actor
SELECT imp_stage_batch('TPL-MTG', v.version, v.header_checksum, 'sec-async-reg.xlsx', repeat('d', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'data', jsonb_build_object('meeting_date', '2026-02-03', 'title', 'SECAR25 meeting ' || i),
     'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb)) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
SELECT set_config('app.ctx', '', true), set_config('app.ctx_mac', '', true);
SET app.user_id = '{{ADMIN}}';
SELECT count(*) FROM imp_async_chunk_tasks(:'jid'::uuid, NULL);
-- @end

-- @case RB-26
-- @title A discard while the register run is active: 409 batch_processing
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 batch_processing
SELECT imp_stage_batch('TPL-MTG', v.version, v.header_checksum, 'sec-async-reg.xlsx', repeat('d', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'data', jsonb_build_object('meeting_date', '2026-02-03', 'title', 'SECAR26 meeting ' || i),
     'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb)) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes');
SELECT imp_decide_batch(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'discard', 'all', NULL, 'gone', false);
-- @end

-- @case RB-27
-- @title Control: the System Admin continues the register run in a later transaction (the stored step-up counts); a register chunk is 50 rows
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect output running|50|60
SELECT imp_stage_batch('TPL-MTG', v.version, v.header_checksum, 'sec-async-reg.xlsx', repeat('d', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'data', jsonb_build_object('meeting_date', '2026-02-03', 'title', 'SECAR27 meeting ' || i),
     'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb)) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
\ctx ADMIN
SELECT imp_async_step(:'jid'::uuid, NULL) AS p \gset
SELECT (:'p'::jsonb ->> 'state') || '|' || (:'p'::jsonb ->> 'rows_done') || '|' || (:'p'::jsonb ->> 'rows_total');
-- @end

-- @case RB-28
-- @title Alice reads the tasks of the next chunk of the System Admin's run: nothing
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect output 0
SELECT imp_stage_batch('TPL-MTG', v.version, v.header_checksum, 'sec-async-reg.xlsx', repeat('d', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'data', jsonb_build_object('meeting_date', '2026-02-03', 'title', 'SECAR28 meeting ' || i),
     'custom', '{}'::jsonb, 'pre_errors', '[]'::jsonb)) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
\ctx ALICE
SELECT count(*) FROM imp_async_chunk_tasks(:'jid'::uuid, NULL);
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The setting imports.async_rows: only through its audited function
-- ---------------------------------------------------------------------------------------------------------------------
-- @case RB-40
-- @title Alice lowers the threshold by a direct update (the settings policies keep her out: no row changes)
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = '10'::jsonb WHERE key = 'imports.async_rows' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case RB-41
-- @title The System Admin sets the threshold by a direct update (no reason, no audit row)
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = '10'::jsonb WHERE key = 'imports.async_rows';
-- @end

-- @case RB-42
-- @title The System Admin deletes the threshold (the default would then apply silently)
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM settings WHERE key = 'imports.async_rows';
-- @end

-- @case RB-43
-- @title The System Admin renames the threshold row away: the update trigger looks at the old key too
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET key = 'imports.async_rows_old' WHERE key = 'imports.async_rows';
-- @end

-- @case RB-44
-- @title The System Admin renames another row to the threshold key (the update trigger looks at the new key)
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET key = 'imports.async_rows' WHERE key = (SELECT s.key FROM settings s WHERE s.key NOT IN ('imports.async_rows', 'calendar.official_confirmed',
  'mail.notification_kinds', 'load.historical_waiver') ORDER BY s.key LIMIT 1);
-- @end

-- @case RB-45
-- @title The System Admin inserts the threshold row again with another value (a conflict path)
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO settings (key, value, updated_at) VALUES ('imports.async_rows', '5'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- @end

-- @case RB-46
-- @title Nobody signed in (a forged plain user id of the System Admin) lowers the threshold by a direct update: no row changes
-- @category async-register-batches
-- @expect output 0
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
WITH u AS (UPDATE settings SET value = '10'::jsonb WHERE key = 'imports.async_rows' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case RB-47
-- @title Alice changes the threshold through the function: she holds no settings right
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_set_imports_async_rows(20, 'Alice wants it smaller', NULL);
-- @end

-- @case RB-48
-- @title A delegate without a settings right changes the threshold
-- @category async-register-batches
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 admin path
SELECT admin_set_imports_async_rows(20, 'Delegate without the right', NULL);
-- @end

-- @case RB-49
-- @title Nobody signed in changes the threshold (forged plain user id of the System Admin)
-- @category async-register-batches
-- @expect error 42501 admin path
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT admin_set_imports_async_rows(20, 'forged', NULL);
-- @end

-- @case RB-50
-- @title The System Admin sets a value out of the range 10 to 500
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT admin_set_imports_async_rows(5, 'Too small a threshold', NULL);
-- @end

-- @case RB-51
-- @title The System Admin changes the threshold without a reason
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT admin_set_imports_async_rows(20, ' ', NULL);
-- @end

-- @case RB-52
-- @title The System Admin changes the threshold with a stale version
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT admin_set_imports_async_rows(20, 'Stale version', (imports_async_json() ->> 'version')::int + 1);
-- @end

-- @case RB-53
-- @title Control: the System Admin changes the threshold with a reason; one audit row with before and after
-- @category async-register-batches
-- @actor ADMIN
-- @region *
-- @expect output 20|50|20|1
SELECT admin_set_imports_async_rows(20, 'Smaller batches go to the background', (imports_async_json() ->> 'version')::int) ->> 'async_rows' AS v \gset
SELECT :'v' || '|' || (SELECT before ->> 'async_rows' || '|' || (after ->> 'async_rows') FROM audit_log WHERE action = 'imports_async_rows_update' ORDER BY id DESC LIMIT 1)
  || '|' || (SELECT count(*) FROM audit_log WHERE action = 'imports_async_rows_update');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The shape of the functions
-- ---------------------------------------------------------------------------------------------------------------------
-- @case RB-60
-- @title Every new or rewritten function is SECURITY DEFINER with search_path pg_catalog, public, pg_temp, owned by a definer role, PUBLIC revoked (the identity helpers keep their 0004 rights)
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('imp_submit_register_rows', 'imp_submit_register_finish', 'imp_submit_register_batch', 'imp_decide_register_rows', 'imp_decide_register_finish',
    'imp_decide_checks', 'imp_decide_register_batch', 'imp_submit_stream_rows', 'imp_stream_status_after_send', 'imp_submit_stream_finish', 'imp_submit_stream_batch',
    'imp_decide_stream_rows', 'imp_decide_stream_finish', 'imp_decide_stream_batch', 'imp_batch_kind', 'imp_async_start_rs', 'imp_async_start', 'imp_async_chunk_tasks',
    'imp_async_step', 'imp_async_close', 'imp_batch_job_json', 'imports_async_json', 'admin_set_imports_async_rows', 'mi_run_progress_json', 'mi_apply_run',
    'wf_user_in_scope', 'reg_user_in_scope', 'reg_eligible_cell', 'reg_cell_row', 'wf_cell', 'reg_module', 'reg_row_key', 'reg_cell')
  AND NOT (p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer'
           AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, public, pg_temp')
           AND NOT has_function_privilege('public', p.oid, 'EXECUTE'));
-- @end

-- @case RB-61
-- @title The application role holds only the doors (and none of the internal parts)
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect output admin_set_imports_async_rows,imp_async_chunk_tasks,imp_async_start,imp_async_step,imp_batch_job_json,imports_async_json,mi_run_progress_json
SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('imp_submit_register_rows', 'imp_submit_register_finish', 'imp_decide_register_rows', 'imp_decide_register_finish', 'imp_decide_checks',
    'imp_submit_stream_rows', 'imp_stream_status_after_send', 'imp_submit_stream_finish', 'imp_decide_stream_rows', 'imp_decide_stream_finish', 'imp_batch_kind',
    'imp_async_chunk_size', 'imp_async_start_rs', 'imp_async_start', 'imp_async_chunk_tasks', 'imp_async_step', 'imp_async_close', 'imp_batch_job_json', 'imports_async_json',
    'admin_set_imports_async_rows', 'mi_run_progress_json')
  AND has_function_privilege('pmis_app', p.oid, 'EXECUTE');
-- @end

-- @case RB-62
-- @title The Master import apply keeps its two signatures and their grants of 0060 / 0073 (no new door)
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect output 5,6
SELECT string_agg(p.pronargs::text, ',' ORDER BY p.pronargs) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'mi_apply_run' AND has_function_privilege('pmis_app', p.oid, 'EXECUTE');
-- @end

-- @case RB-63
-- @title The application role still has no right on the run table, and no new right on settings
-- @category async-register-batches
-- @actor ALICE
-- @region 1
-- @expect output false|false|false|false
SELECT has_table_privilege('pmis_app', 'import_batch_jobs', 'SELECT')::text || '|' || has_table_privilege('pmis_app', 'import_batch_jobs', 'INSERT')::text || '|' ||
       has_table_privilege('pmis_app', 'import_batch_jobs', 'UPDATE')::text || '|' || has_table_privilege('pmis_app', 'import_batch_jobs', 'DELETE')::text;
-- @end
