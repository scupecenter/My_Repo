-- Approved-template entry (migration 0037). The application role only reads the template catalogue, the versions, the batches and
-- their rows; it reaches them through imp_stage_batch, imp_submit_batch and imp_decide_batch. The batch overloads of the register
-- writers (reg_save_record, reg_new_version, reg_transition_record with an import row) and the version issuing (tpl_sync*) are not
-- callable by it at all. A batch is visible to its uploader and to people who see one of its regions; a row only to those who see
-- its region. Nobody sends a batch that someone else uploaded.

-- @case TI-01
-- @title Alice inserts an import batch directly
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO import_batches (template_version_id, file_name, file_sha256, uploaded_by)
SELECT id, 'forged.xlsx', 'x', '{{ALICE}}' FROM template_versions WHERE is_current LIMIT 1;
-- @end

-- @case TI-02
-- @title Alice approves every row of every batch by updating the table
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_batch_rows SET decision = 'approved';
-- @end

-- @case TI-03
-- @title Alice deletes the batches
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM import_batches;
-- @end

-- @case TI-04
-- @title Alice retires the current template version (every upload would then be refused, or an old file accepted)
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE template_versions SET is_current = false;
-- @end

-- @case TI-05
-- @title Alice plants a template of her own
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO template_definitions (template_id, name, target_entity) VALUES ('TPL-FORGED', 'Forged', 'gecol');
-- @end

-- @case TI-06
-- @title Alice changes the header checksum of the GECOL template
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE template_versions SET header_checksum = repeat('0', 64);
-- @end

-- @case TI-07
-- @title Alice issues template versions herself
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT tpl_sync_all();
-- @end

-- @case TI-08
-- @title Alice creates a register record "via batch" for an import row that is not hers
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT reg_save_record('gecol', NULL, NULL, NULL, NULL, '{}'::jsonb, NULL, NULL, false, '{{BATCH_ROW_BEN}}'::uuid);
-- @end

-- @case TI-09
-- @title Alice approves a record "via batch" without the batch path
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT reg_transition_record(gen_random_uuid(), 1, 'approve', NULL, true, '{{BATCH_ROW_BEN}}'::uuid);
-- @end

-- @case TI-10
-- @title Alice stages a file for a register she has no import right on (the database refuses it, whatever the API did)
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error P0001 import_not_allowed
SELECT imp_stage_batch('TPL-GECOL',
  (SELECT d.current_version FROM template_definitions d WHERE d.template_id = 'TPL-GECOL'),
  (SELECT v.header_checksum FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-GECOL' AND v.is_current),
  'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TI-11
-- @title Alice stages a file made from a template version that was retired
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error P0001 outdated_version
SELECT imp_stage_batch('TPL-GECOL', 0, repeat('0', 64), 'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TI-12
-- @title Alice stages a file whose header row was changed
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error P0001 checksum_mismatch
SELECT imp_stage_batch('TPL-GECOL',
  (SELECT d.current_version FROM template_definitions d WHERE d.template_id = 'TPL-GECOL'), repeat('0', 64), 'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TI-13
-- @title An anonymous session stages a file
-- @category templates
-- @expect error 42501 no signed-in actor
SELECT imp_stage_batch('TPL-GECOL', 1, repeat('0', 64), 'x.xlsx', 'x', NULL, '[]'::jsonb);
-- @end

-- @case TI-14
-- @title Alice sends a batch that Carol uploaded (Tripoli, visible to her)
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error P0001 Only the person who uploaded
SELECT imp_submit_batch('{{BATCH_TRI}}', NULL, false);
-- @end

-- @case TI-15
-- @title Alice discards a batch that Carol uploaded
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error P0001 Only the person who uploaded
SELECT imp_decide_batch('{{BATCH_TRI}}', NULL, 'discard', 'all', NULL, NULL, false);
-- @end

-- @case TI-16
-- @title Alice sends the Benghazi batch (outside her region): it does not exist for her
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error P0001 does not exist or is not visible
SELECT imp_submit_batch('{{BATCH_BEN}}', NULL, false);
-- @end

-- @case TI-17
-- @title Alice decides the rows of the Benghazi batch
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect error P0001 does not exist or is not visible
SELECT imp_decide_batch('{{BATCH_BEN}}', NULL, 'approve', 'all', NULL, NULL, true);
-- @end

-- @case TI-18
-- @title A Tripoli session does not see the Benghazi batch
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM import_batches WHERE file_name = 'sec-ben.xlsx';
-- @end

-- @case TI-19
-- @title A Tripoli session does not read the rows of the Benghazi batch
-- @category templates
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM import_batch_rows WHERE batch_id = '{{BATCH_BEN}}';
-- @end

-- @case TI-20
-- @title Alice reads the Tripoli batch of her region
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output 1
SELECT count(*) FROM import_batches WHERE file_name = 'sec-tri.xlsx';
-- @end

-- @case TI-21
-- @title Bob, who uploaded the Benghazi batch, sees it from a Tripoli session, but only its rows he can see (the unreadable region stays hidden)
-- @category templates
-- @actor BOB
-- @region 1
-- @expect output 1
SELECT count(*) FROM import_batch_rows WHERE batch_id = '{{BATCH_BEN}}';
-- @end

-- @case TI-22
-- @title Bob reads the template versions and the batch (positive control: reads are open to the application role)
-- @category positive-controls
-- @actor BOB
-- @region 1
-- @expect output>= 16
SELECT count(*) FROM templates WHERE status = 'active';
-- @end
