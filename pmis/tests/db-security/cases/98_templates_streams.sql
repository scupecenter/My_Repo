-- Site Register stream templates and TPL-MASTER (migration 0051). The application role only reads the Master columns, the task fields of the stream
-- templates, their rules and the TPL-MASTER sheet names; it reaches the batches only through the dispatchers imp_stage_batch, imp_stage_master,
-- imp_submit_batch and imp_decide_batch. The register functions behind the dispatchers, the task staging and the task flow are not callable by it, so
-- a stream batch cannot be staged, sent or decided around the checks. A stream batch is visible like any batch: to its uploader and to people who see
-- one of its regions. Nobody sends a stream batch that someone else uploaded, and a file of a retired version or with a changed header is refused by the
-- database whatever the API did.

-- @case TS-01
-- @title Alice writes a task row into a stream batch directly
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO import_batch_rows (batch_id, row_no, region_id, target_entity, action, payload, decision, task_code, ord)
VALUES ('{{BATCH_STREAM_TRI}}', 9, 1, 'task', 'update', '{}', 'approved', 'B4', 9);
-- @end

-- @case TS-02
-- @title Alice marks every task row as submitted by updating the table
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_batch_rows SET task_submitted_at = now() WHERE task_instance_id IS NOT NULL OR task_code IS NOT NULL;
-- @end

-- @case TS-03
-- @title Alice plants a Master column of her own
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO master_columns (ord, letter, header, owner) VALUES (500, 'ZZ', 'Forged', 'task');
-- @end

-- @case TS-04
-- @title Alice makes a read-only task field writable through the template
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE template_task_fields SET read_only = false WHERE read_only;
-- @end

-- @case TS-05
-- @title Alice writes a task field of her own into a stream template
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO template_task_fields (task_code, field_key, label, field_type) VALUES ('B4', 'v:forged', 'Forged', 'text');
-- @end

-- @case TS-06
-- @title Alice takes the Dismantle tasks into the stream templates (deletes the exclusion rules)
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM template_task_rules;
-- @end

-- @case TS-07
-- @title Alice renames a sheet of TPL-MASTER (every file in use would be refused)
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE template_parts SET sheet_name = 'Renamed';
-- @end

-- @case TS-08
-- @title Alice stages a register file through the register function, around the dispatcher
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_stage_register_batch('TPL-GECOL', 1, repeat('0', 64), 'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TS-09
-- @title Alice sends a batch through the register function, around the dispatcher
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_submit_register_batch('{{BATCH_TRI}}', NULL, false);
-- @end

-- @case TS-10
-- @title Alice decides a batch through the register function, around the dispatcher
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_decide_register_batch('{{BATCH_TRI}}', NULL, 'approve', 'all', NULL, NULL, true);
-- @end

-- @case TS-11
-- @title Alice stages task rows through the staging function, without the template checks
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_stage_task_row('[]'::jsonb, '{}'::jsonb, NULL, NULL, NULL, NULL, NULL);  -- 0060 added the mode
-- @end

-- @case TS-12
-- @title Alice inserts a batch of task rows she built herself
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_insert_task_batch((SELECT id FROM template_versions WHERE is_current LIMIT 1), 'TPL-SITE-CW', 'CW', 'x.xlsx', 'x', NULL, 'Data', '[]'::jsonb, NULL, NULL, 'template');
-- @end

-- @case TS-13
-- @title Alice sends a stream batch through the task function, around the dispatcher
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_submit_stream_batch('{{BATCH_STREAM_TRI}}', NULL, false);
-- @end

-- @case TS-14
-- @title Alice decides a stream batch through the task function, around the dispatcher
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_decide_stream_batch('{{BATCH_STREAM_TRI}}', NULL, 'approve', 'all', NULL, NULL, true);
-- @end

-- @case TS-15
-- @title Alice stages a stream file through the stream function, skipping the header check
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_stage_stream_batch('TPL-SITE-CW', 1, NULL, 'x.xlsx', 'x', NULL, '[]'::jsonb, NULL, NULL, NULL, NULL);  -- 0060 signature
-- @end

-- @case TS-16
-- @title Alice issues a template version herself
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT tpl_sync('TPL-SITE-CW', 'forged');
-- @end

-- @case TS-17
-- @title Alice writes a task history step with an import row through the step function
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT wf_step(gen_random_uuid(), 1, 'submit', '{{ALICE}}', NULL, 'open', 'entry', false, false);
-- @end

-- @case TS-18
-- @title Alice stages a stream file made from a template version that was retired
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 outdated_version
SELECT imp_stage_batch('TPL-SITE-CW', 0, repeat('0', 64), 'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TS-19
-- @title Alice stages a stream file whose header row was changed
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 checksum_mismatch
SELECT imp_stage_batch('TPL-SITE-CW',
  (SELECT d.current_version FROM template_definitions d WHERE d.template_id = 'TPL-SITE-CW'), repeat('0', 64), 'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TS-20
-- @title Alice stages a stream file with the right header but no right to import tasks of the Site Register (the database refuses it, whatever the API did)
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 import_not_allowed
SELECT imp_stage_batch('TPL-SITE-CW',
  (SELECT d.current_version FROM template_definitions d WHERE d.template_id = 'TPL-SITE-CW'),
  (SELECT v.header_checksum FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW' AND v.is_current),
  'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TS-21
-- @title An anonymous session stages a stream file
-- @category templates-streams
-- @expect error 42501 no signed-in actor
SELECT imp_stage_batch('TPL-SITE-CW', 1, repeat('0', 64), 'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TS-22
-- @title An anonymous session stages a TPL-MASTER file
-- @category templates-streams
-- @expect error 42501 no signed-in actor
SELECT imp_stage_master('TPL-MASTER', 1, 'x.xlsx', 'x', '[]'::jsonb);
-- @end

-- @case TS-23
-- @title Alice stages a TPL-MASTER file of a retired version
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 outdated_version
SELECT imp_stage_master('TPL-MASTER', 0, 'x.xlsx', 'x', '[]'::jsonb);
-- @end

-- @case TS-24
-- @title Alice stages a TPL-MASTER file whose sheet has another header row than the issued one
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 checksum_mismatch
SELECT imp_stage_master('TPL-MASTER',
  (SELECT d.current_version FROM template_definitions d WHERE d.template_id = 'TPL-MASTER'), 'x.xlsx', 'x',
  '[{"sheet": "Master", "header_checksum": "0000", "rows": []}]'::jsonb);
-- @end

-- @case TS-25
-- @title Alice stages a stream template through the Master path (a stream template is not the Master)
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 template does not exist
SELECT imp_stage_master('TPL-SITE-CW', 1, 'x.xlsx', 'x', '[]'::jsonb);
-- @end

-- @case TS-26
-- @title Alice sends the Benghazi stream batch (outside her region): it does not exist for her
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 does not exist or is not visible
SELECT imp_submit_batch('{{BATCH_STREAM_BEN}}', NULL, false);
-- @end

-- @case TS-27
-- @title Alice decides the task rows of the Benghazi stream batch
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 does not exist or is not visible
SELECT imp_decide_batch('{{BATCH_STREAM_BEN}}', NULL, 'approve', 'all', NULL, NULL, true);
-- @end

-- @case TS-28
-- @title Alice sends a stream batch that Carol uploaded (Tripoli, visible to her)
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 Only the person who uploaded
SELECT imp_submit_batch('{{BATCH_STREAM_TRI}}', NULL, false);
-- @end

-- @case TS-29
-- @title Alice discards a stream batch that Carol uploaded
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect error P0001 Only the person who uploaded
SELECT imp_decide_batch('{{BATCH_STREAM_TRI}}', NULL, 'discard', 'all', NULL, NULL, false);
-- @end

-- @case TS-30
-- @title A Tripoli session does not see the Benghazi stream batch
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM import_batches WHERE file_name = 'sec-stream-ben.xlsx';
-- @end

-- @case TS-31
-- @title A Tripoli session does not read the task rows of the Benghazi stream batch
-- @category templates-streams
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM v_import_rows WHERE batch_id = '{{BATCH_STREAM_BEN}}';
-- @end

-- @case TS-32
-- @title Bob, who uploaded the Benghazi stream batch, sees the batch from a Tripoli session but not its Benghazi task row
-- @category templates-streams
-- @actor BOB
-- @region 1
-- @expect output 1|0
SELECT (SELECT count(*) FROM import_batches WHERE file_name = 'sec-stream-ben.xlsx') || '|' || (SELECT count(*) FROM import_batch_rows WHERE batch_id = '{{BATCH_STREAM_BEN}}');
-- @end

-- @case TS-33
-- @title Alice reads the stream batch of her region (positive control)
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output 1
SELECT count(*) FROM import_batches WHERE file_name = 'sec-stream-tri.xlsx' AND stream_code = 'CW';
-- @end

-- @case TS-34
-- @title The application role reads the Master columns and the task fields (positive control: reads are open)
-- @category positive-controls
-- @actor BOB
-- @region 1
-- @expect output 187
SELECT count(*) FROM master_columns;
-- @end

-- @case TS-35
-- @title The four stream templates and TPL-MASTER are active templates (positive control)
-- @category positive-controls
-- @actor BOB
-- @region 1
-- @expect output 5
SELECT count(*) FROM templates WHERE status = 'active' AND template_id IN ('TPL-SITE-DA', 'TPL-SITE-CW', 'TPL-SITE-TE', 'TPL-SITE-CL', 'TPL-MASTER');
-- @end

-- @case TS-36
-- @title The stream columns are built by the database: the CW template has task columns in Master order and no Dismantle task (positive control)
-- @category positive-controls
-- @actor BOB
-- @region 1
-- @expect output t
SELECT (jsonb_array_length(tpl_stream_columns('CW')) > 40) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tpl_stream_columns('CW')) c WHERE c ->> 'task' IN ('E1', 'E2', 'E3'));
-- @end
