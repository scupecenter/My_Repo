-- Work package P3 (migration 0060): the legacy Master import, the comparison report of the parallel run, the role and region aliases, the template mapping
-- screen, the batch mode and the scenario-aware Master columns. The application role only reads the new tables; every write goes through the definer
-- functions, which check the actor's own right (templates administer for the legacy path and the report, templates edit for aliases and the mapping).
-- The staging internals behind the dispatchers are not callable by it, and the readers it may call answer nothing about a site outside the caller's regions.

-- @case P3-01
-- @title Alice records a legacy Master import run of her own
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO master_reconciliation_runs (file_name, file_sha256, file_size, structure, created_by)
VALUES ('forged.xlsx', repeat('a', 64), 10, '{}', '{{ALICE}}');
-- @end

-- @case P3-02
-- @title Alice marks every difference of the comparison report as resolved
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE master_reconciliation_diffs SET resolution = 'ignored', resolution_note = 'forged';
-- @end

-- @case P3-03
-- @title Alice deletes the rows of an import run (the original data of the report)
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM master_reconciliation_rows;
-- @end

-- @case P3-04
-- @title Alice maps a Master staff role to a PMIS role directly (Q8)
-- @category p3-aliases
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE role_aliases SET role_id = '{{ROLE_CW}}', status = 'mapped' WHERE alias = 'site engineer';
-- @end

-- @case P3-05
-- @title Alice points a region alias at another region (Q10)
-- @category p3-aliases
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE region_aliases SET region_id = 5 WHERE alias = 'tripoli area';
-- @end

-- @case P3-06
-- @title Alice stages a legacy Master run through the function without templates administer
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_stage_run('x.xlsx', repeat('a', 64), 10, NULL, '["Master"]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
-- @end

-- @case P3-07
-- @title Alice applies a run (enters task dates as the import)
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_apply_run(gen_random_uuid(), NULL, 'submit', 'forged apply', true);
-- @end

-- @case P3-08
-- @title Alice resolves a difference of the report
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_resolve_diff(gen_random_uuid(), 'ignored', 'not mine');
-- @end

-- @case P3-09
-- @title Alice saves an alias through the function without templates edit
-- @category p3-aliases
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT imp_alias_save('region', 'my zone', 'My zone', '1', NULL, true, NULL, 'forged alias');
-- @end

-- @case P3-10
-- @title Alice changes the template mapping without templates edit (Q207)
-- @category p3-mapping
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT tpl_mapping_save('[{"op": "upsert", "task_code": "B7", "field_key": "submitted_date", "label": "x", "read_only": false}]'::jsonb, 'forged', false);
-- @end

-- @case P3-11
-- @title Alice stages a Master file as the legacy import source, around the dispatcher (source master_import)
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_stage_master_core('TPL-MASTER', 1, 'x.xlsx', 'x', '[]'::jsonb, 'submit', 'master_import', NULL);
-- @end

-- @case P3-12
-- @title Alice stages one task row with her own mode, around the batch staging
-- @category p3-mapping
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_stage_task_row('[]'::jsonb, '{}'::jsonb, NULL, NULL, NULL, NULL, 'draft');
-- @end

-- @case P3-13
-- @title Alice decides a batch through the draft function, around the dispatcher
-- @category p3-mapping
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_decide_draft_batch('{{BATCH_STREAM_TRI}}', NULL, 'reject', 'all', NULL, 'x', false);
-- @end

-- @case P3-14
-- @title Alice turns a submitted stream batch into a draft batch (no L2 decision) by updating the table
-- @category p3-mapping
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_batches SET mode = 'draft' WHERE id = '{{BATCH_STREAM_TRI}}';
-- @end

-- @case P3-15
-- @title Alice reads what the PMIS holds for a site through the comparison reader
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT mi_pmis_row('{{SITE_BEN}}');
-- @end

-- @case P3-16
-- @title Alice reads the Issue Log projection of a Benghazi site from Tripoli (Q11)
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect output hidden
SELECT coalesce(mx_issue_cells('{{SITE_BEN}}')::text, 'hidden');
-- @end

-- @case P3-17
-- @title Alice learns which tasks apply on a Benghazi site from Tripoli (Q205)
-- @category p3-mapping
-- @actor ALICE
-- @region 1
-- @expect output hidden
SELECT coalesce(tpl_master_candidates('{{SITE_BEN}}', 'AZ')::text, 'hidden');
-- @end

-- @case P3-18
-- @title Alice lists the legacy import runs (no templates administer): the report is not visible
-- @category p3-master-import
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM master_reconciliation_runs;
-- @end

-- @case P3-19
-- @title Positive control: the System Admin may use the legacy path
-- @category p3-master-import
-- @actor ADMIN
-- @region *
-- @expect output t
SELECT mi_can_use();
-- @end
