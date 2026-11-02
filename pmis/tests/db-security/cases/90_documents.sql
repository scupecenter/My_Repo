-- The document upload module (migration 0038). The application role is read-only on the Document Library, the slots, the files, the versions
-- and the zip jobs; every write goes through a SECURITY DEFINER function that names the actor, checks the right and writes the audit row. A stored
-- file never changes and is never deleted. Download and zip audit rows cannot be forged for other actions.

-- @case DOC-01
-- @title Alice approves a document slot directly (marking a mandatory document as done)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE document_slots SET status = 'approved';
-- @end

-- @case DOC-02
-- @title Alice plants a slot row directly
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO document_slots (site_id, region_id, doc_type_id, status) SELECT site_id, region_id, doc_type_id, 'uploaded' FROM document_slots LIMIT 1;
-- @end

-- @case DOC-03
-- @title Alice rewrites the checksum of a stored file
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE document_files SET sha256 = repeat('0', 64);
-- @end

-- @case DOC-04
-- @title Alice deletes the stored files
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM document_files;
-- @end

-- @case DOC-05
-- @title Alice makes every library document optional
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE document_types SET is_mandatory = false;
-- @end

-- @case DOC-06
-- @title Alice removes the placements of the library documents
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM document_type_placements;
-- @end

-- @case DOC-07
-- @title Alice rewrites a published version of a document
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE document_type_versions SET is_mandatory = false;
-- @end

-- @case DOC-08
-- @title Alice edits the drafts of the library
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE document_type_drafts SET spec = '{}';
-- @end

-- @case DOC-09
-- @title Alice writes a zip job for someone else
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO document_export_jobs (requested_by, scope) VALUES ('{{BOB}}', '{}');
-- @end

-- @case DOC-10
-- @title Alice reads the internal snapshot table of the slot sets
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM document_task_snapshots;
-- @end

-- @case DOC-11
-- @title Alice, who is not an admin, defines a document in the library
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering document_types.edit required
SELECT admin_save_document_type(NULL, '{"code":"SEC_X","kind":"scanned_document","name_en":"Sec test","placements":[{"target":"task","ref":"A2"}]}'::jsonb, 'Not allowed');
-- @end

-- @case DOC-12
-- @title Alice, who is not an admin, publishes a document to the open tasks
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering document_types.edit required
SELECT admin_publish_document_type((SELECT id FROM document_types WHERE code = 'A2'), NULL, 'open_too', current_date, 'Not allowed');
-- @end

-- @case DOC-13
-- @title Alice attaches a file to a slot that does not exist (no way to probe which slots exist)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT doc_attach_file(gen_random_uuid(), '{"ext":"pdf","size_bytes":10}'::jsonb);
-- @end

-- @case DOC-14
-- @title Nobody signed in attaches a file
-- @category documents
-- @expect error 42501 no signed-in actor
SELECT doc_attach_file(gen_random_uuid(), '{}'::jsonb);
-- @end

-- @case DOC-15
-- @title Nobody signed in withdraws a file
-- @category documents
-- @expect error 42501 no signed-in actor
SELECT doc_withdraw_file(gen_random_uuid(), gen_random_uuid());
-- @end

-- @case DOC-16
-- @title Alice writes a task approval into the audit log through the download audit function
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 unknown action
SELECT doc_audit('task_approve', 'task', 'x', NULL, NULL, '{}'::jsonb);
-- @end

-- @case DOC-17
-- @title Alice audits a download in a region she cannot see
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 region not visible
SELECT doc_audit('document_file_download', 'document_file', 'x', NULL, 6, '{}'::jsonb);
-- @end

-- @case DOC-18
-- @title Alice calls the internal slot builder directly (it ignores the region of the caller)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT doc_sync_task_slots_core(gen_random_uuid());
-- @end

-- @case DOC-19
-- @title Alice applies a specification to a library document directly
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT doc_apply_spec((SELECT id FROM document_types WHERE code = 'A2'), '{}'::jsonb);
-- @end

-- @case DOC-20
-- @title Alice finishes a zip job that is not hers
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 job not found
SELECT doc_job_update(gen_random_uuid(), 'done', 1, 1, 1, 'exports/2026/11/x', NULL);
-- @end

-- @case DOC-21
-- @title Alice attaches a blank form to a library document
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering document_types.edit required
SELECT doc_blank_form_attach((SELECT id FROM document_types WHERE code = 'A2'), NULL, '{"original_name":"x.pdf","storage_key":"forms/2026/11/x","mime_type":"application/pdf","ext":"pdf","size_bytes":1,"sha256":"x"}'::jsonb, 'Not allowed');
-- @end

-- @case DOC-22
-- @title The System Admin adds a document to the library through admin_save_document_type
-- @category documents
-- @actor ADMIN
-- @region *
-- @expect ok
SELECT admin_save_document_type(NULL, '{"code":"SEC_DOC","kind":"scanned_document","name_en":"Synthetic security test document","placements":[{"target":"task","ref":"A2"}]}'::jsonb, 'Synthetic document for the suite');
-- @end

-- @case DOC-23
-- @title The System Admin lists the documents of the library through the read path
-- @category documents
-- @actor ADMIN
-- @region *
-- @expect output>= 13
SELECT count(*) FROM document_types WHERE lib_managed AND published_version > 0;
-- @end
