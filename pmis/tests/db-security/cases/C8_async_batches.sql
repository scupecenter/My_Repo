-- Big New sites batches in the background (migration 0074, technical decision of 2026-11-05; contract 0.14.4). A send or an approval of a New sites batch with
-- more rows than imports.async_rows (50) is asked by the request (imp_async_start, every check of the request, the step-up read from the verified context)
-- and done chunk by chunk (imp_async_step) under a signed context of the same person. The run table import_batch_jobs has no right for pmis_app; the step-up of
-- the run is the one stored at the request; nobody else can continue or stop the run of a person who can still act; the internal parts are closed.
-- ADMIN holds L1 and L2 of the Matrix row site_creation (the System Admins group), so his own send of a New sites batch is a self-approval (B5).
-- Every case stages its own batch of 60 Tripoli rows in its own transaction, which the runner rolls back.

-- ---------------------------------------------------------------------------------------------------------------------
-- The run table and the internal parts are closed to the application role
-- ---------------------------------------------------------------------------------------------------------------------
-- @case AB-01
-- @title Alice reads the run table directly
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM import_batch_jobs;
-- @end

-- @case AB-02
-- @title The System Admin inserts a run directly (with a step-up claimed in the row)
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO import_batch_jobs (batch_id, kind, actor_id, stepup_verified, prev_status, rows_total)
SELECT b.id, 'submit', '{{ADMIN}}', true, 'validated', 1 FROM import_batches b LIMIT 1;
-- @end

-- @case AB-03
-- @title Alice updates a run directly (to take it over or to claim a step-up)
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_batch_jobs SET actor_id = '{{ALICE}}', stepup_verified = true;
-- @end

-- @case AB-04
-- @title Alice deletes the runs
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM import_batch_jobs;
-- @end

-- @case AB-05
-- @title The System Admin sends rows with a step-up passed as a parameter (the internal rows part of the send)
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT imp_submit_site_rows('00000000-0000-4000-8000-0000000b0001', 10, true, true);
-- @end

-- @case AB-06
-- @title The System Admin decides rows with a step-up passed as a parameter (the internal rows part of the decision)
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT imp_decide_site_rows('00000000-0000-4000-8000-0000000b0001', 'approve', 'all', NULL, NULL, true);
-- @end

-- @case AB-07
-- @title Alice writes the end of a send or of a decision (status, audit row, notices) without doing it
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_submit_site_finish('00000000-0000-4000-8000-0000000b0001', 'validated', 0, 0);
-- @end

-- @case AB-08
-- @title Alice writes the end of a decision
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_decide_site_finish('00000000-0000-4000-8000-0000000b0001', 'approve', 'all', NULL, 1, 1, 0, 0);
-- @end

-- @case AB-09
-- @title Alice closes a run as done (the internal close)
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_async_close('00000000-0000-4000-8000-0000000b0001', 'done', NULL);
-- @end

-- @case AB-10
-- @title Alice runs the fast applicability of a new site on an existing site, and the audit context reader
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT wf_apply_applicability_run((SELECT id FROM sites WHERE region_id = 1 LIMIT 1), 'forged', true);
-- @end

-- @case AB-11
-- @title Alice calls the audit context reader of audit_log_fill
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT log_ctx_values();
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Asking for a run: the checks of the request
-- ---------------------------------------------------------------------------------------------------------------------
-- @case AB-20
-- @title No signed context: a run cannot be asked
-- @category async-batches
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SET app.stepup = 'true';
SELECT imp_async_start('00000000-0000-4000-8000-0000000b0001', 1, 'submit', NULL, NULL, NULL, NULL, now() + interval '1 hour');
-- @end

-- @case AB-21
-- @title The System Admin sends his own batch of 60 rows (a self-approval) without a step-up: refused before anything is queued
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB21' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '1 hour');
-- @end

-- @case AB-22
-- @title The same with a forged plain step-up setting (not signed): still refused, and the step-up "until" of the API is not a step-up either
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB22' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
SET app.stepup = 'true';
SET app.stepup_until = '2999-01-01';
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, '2999-01-01'::timestamptz);
-- @end

-- @case AB-23
-- @title Alice asks for the send of the System Admin's batch: she is not the uploader (and the batch of another region is not visible to her)
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 not_found|not_eligible_holder
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB23' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
SELECT version AS ver FROM import_batches WHERE id = :'bid' \gset
\ctx ALICE stepup=300
SELECT imp_async_start(:'bid'::uuid, :ver, 'submit', NULL, NULL, NULL, NULL, now() + interval '1 hour');
-- @end

-- @case AB-24
-- @title A stale If-Match: refused (412), nothing queued
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 precondition_failed
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB24' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version + 7 FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '1 hour');
-- @end

-- @case AB-25
-- @title Control: with a verified step-up the run is queued, the batch shows processing, the step-up is the verified one
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect output true|processing|true|60
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB25' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') ->> 'queued' AS q \gset
SELECT :'q' || '|' || imp_status_of(:'bid'::uuid) || '|' || (imp_async_pending(0)).actor_active::text || '|' || (imp_batch_job_json(:'bid'::uuid) ->> 'rows_total');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- A run in progress: nobody else continues it, nothing else touches the batch
-- ---------------------------------------------------------------------------------------------------------------------
-- @case AB-30
-- @title Alice continues the run of the System Admin under her own name
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 only the person who asked
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB30' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
\ctx ALICE stepup=300
SELECT imp_async_step(:'jid'::uuid, 25);
-- @end

-- @case AB-31
-- @title Alice stops the run of the System Admin (who can still act)
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 only the person who asked
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB31' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
\ctx ALICE
SELECT imp_async_abandon(:'jid'::uuid, 'Alice stops it');
-- @end

-- @case AB-32
-- @title No signed context: the run of an active person cannot be stopped or continued
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error 42501 only the person who asked
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB32' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
SELECT set_config('app.ctx', '', true), set_config('app.ctx_mac', '', true);
SET app.user_id = '{{ADMIN}}';
SELECT imp_async_abandon(:'jid'::uuid, 'forged');
-- @end

-- @case AB-33
-- @title A second send while the run is active: 409 batch_processing
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 batch_processing
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB33' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes');
SELECT imp_submit_batch(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), true);
-- @end

-- @case AB-34
-- @title A discard (a decision) while the run is active: 409 batch_processing
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect error P0001 batch_processing
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB34' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes');
SELECT imp_decide_batch(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'discard', 'all', NULL, 'gone', false);
-- @end

-- @case AB-35
-- @title Control: the person continues the run in a later transaction without a step-up of their own (the stored one counts); one chunk is 25 rows
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect output running|25|25
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB35' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Tripoli', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes') -> 'job' ->> 'job_id' AS jid \gset
\ctx ADMIN
SELECT imp_async_step(:'jid'::uuid, 25) AS p \gset
SELECT (:'p'::jsonb ->> 'state') || '|' || (:'p'::jsonb ->> 'rows_done') || '|' || (SELECT count(*) FROM sites WHERE site_code LIKE 'SECAB35%');
-- @end

-- @case AB-36
-- @title Alice reads the progress of a batch she cannot see: nothing
-- @category async-batches
-- @actor ADMIN
-- @region *
-- @expect output none
SELECT imp_stage_batch('TPL-SITE-NEW', v.version, v.header_checksum, 'sec-async.xlsx', repeat('c', 64), NULL::uuid,
  (SELECT jsonb_agg(jsonb_build_object('row_no', i + 1, 'sheet', 'Data', 'site_code', 'SECAB36' || lpad(i::text, 3, '0'),
     'data', jsonb_build_object('region', 'Benghazi', 'name', 'Async ' || i, 'delivery_scenario', 'New Build'))) FROM generate_series(1, 60) i), 'submit')::text AS bid
FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current \gset
\ctx ADMIN stepup=300
SELECT imp_async_start(:'bid'::uuid, (SELECT version FROM import_batches WHERE id = :'bid'), 'submit', NULL, NULL, NULL, NULL, now() + interval '5 minutes');
\ctx ALICE
SELECT coalesce(imp_batch_job_json(:'bid'::uuid)::text, 'none');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The shape of the functions
-- ---------------------------------------------------------------------------------------------------------------------
-- @case AB-50
-- @title Every new function is SECURITY DEFINER with search_path pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('wf_apply_applicability_run', 'log_ctx_values', 'imp_batch_job_json', 'imp_async_guard', 'imp_submit_site_rows', 'imp_submit_site_finish', 'imp_decide_site_rows',
    'imp_decide_site_finish', 'imp_async_start', 'imp_async_step', 'imp_async_close', 'imp_async_pending', 'imp_async_abandon', 'imp_submit_site_batch', 'imp_decide_site_batch',
    'imp_submit_batch', 'imp_decide_batch', 'site_create_apply')
  AND NOT (p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer'
           AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, public, pg_temp')
           AND NOT has_function_privilege('public', p.oid, 'EXECUTE'));
-- @end

-- @case AB-51
-- @title The application role holds only the doors of the run (and none of the internal parts)
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect output imp_async_abandon,imp_async_pending,imp_async_start,imp_async_step,imp_batch_job_json
SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('wf_apply_applicability_run', 'log_ctx_values', 'imp_batch_job_json', 'imp_async_guard', 'imp_submit_site_rows', 'imp_submit_site_finish', 'imp_decide_site_rows',
    'imp_decide_site_finish', 'imp_async_start', 'imp_async_step', 'imp_async_close', 'imp_async_pending', 'imp_async_abandon')
  AND has_function_privilege('pmis_app', p.oid, 'EXECUTE');
-- @end

-- @case AB-52
-- @title The application role has no right at all on the run table, and row security is forced on it
-- @category async-batches
-- @actor ALICE
-- @region 1
-- @expect output false|false|false|false|true
SELECT has_table_privilege('pmis_app', 'import_batch_jobs', 'SELECT')::text || '|' || has_table_privilege('pmis_app', 'import_batch_jobs', 'INSERT')::text || '|' ||
       has_table_privilege('pmis_app', 'import_batch_jobs', 'UPDATE')::text || '|' || has_table_privilege('pmis_app', 'import_batch_jobs', 'DELETE')::text || '|' ||
       (SELECT relforcerowsecurity::text FROM pg_class WHERE oid = 'import_batch_jobs'::regclass);
-- @end
