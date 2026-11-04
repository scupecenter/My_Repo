-- Migration 0056 (work package P6 of the owner answers of 2026-11-04): the severity catalogue, the all-members votes of a snag, the documents and
-- QC settings, the pending determination of a document rule, the pending evidence of a snag photo and the link between the Quality snag record and
-- the QC snag. The application role is read-only on every new table and column; every write goes through a SECURITY DEFINER function that names
-- the actor, checks the right and writes the audit row through log_audit_write.

-- @case P6-01
-- @title Alice makes every severity non-blocking directly (it would unblock the PAC / FAC of every site)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE snag_severities SET blocks = false;
-- @end

-- @case P6-02
-- @title Alice records a vote on the all-members L2 of a snag directly
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO snag_level_voters (snag_id, round, user_id, voted_at) SELECT id, 1, '{{ALICE}}', now() FROM snags LIMIT 1;
-- @end

-- @case P6-03
-- @title Alice, who is not an admin, edits the severity catalogue through the admin path
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering document_types.edit required
SELECT admin_save_snag_severities('[{"code":"MAJOR","name_en":"Major","blocks":false}]'::jsonb, 'Not allowed', NULL);
-- @end

-- @case P6-04
-- @title Alice, who is not an admin, widens the EXIF tolerance through the admin path
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering document_types.edit required
SELECT admin_save_documents_qc('{"exif_tolerance_hours": 168}'::jsonb, 'Not allowed', NULL);
-- @end

-- @case P6-05
-- @title Alice writes the documents and QC settings directly (row-level security on settings lets no row through without the settings edit right)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = 'true' WHERE key IN ('documents.new_version_inherit', 'qc.exif_tolerance_hours') RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case P6-06
-- @title Alice clears the pending determination of a document rule directly (it would let the task be approved)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE document_slots SET determination_pending = false;
-- @end

-- @case P6-07
-- @title Alice turns a pending-evidence snag photo into accepted proof directly
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE snag_photos SET evidence_status = 'accepted';
-- @end

-- @case P6-08
-- @title Alice links a QC snag to a Quality register record directly
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE snags SET register_entity_id = gen_random_uuid();
-- @end

-- @case P6-09
-- @title Alice runs the one-off link of Quality snag records (internal)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT qc_link_backfill();
-- @end

-- @case P6-10
-- @title Alice creates a QC snag from a register record through the internal link function
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT qc_link_from_record(gen_random_uuid());
-- @end

-- @case P6-11
-- @title Alice calls the internal twin-slot core (it ignores the region of the caller)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT doc_slot_twin_core(gen_random_uuid());
-- @end

-- @case P6-12
-- @title Alice writes an audit row through the internal audit helper of 0056 (it can write without an actor)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT p6_audit('snag_close', 'snag', 'x', NULL, NULL, NULL, NULL, NULL);
-- @end

-- @case P6-13
-- @title Alice calls the internal list of people who may not approve a snag
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT qc_snag_excluded(gen_random_uuid());
-- @end

-- @case P6-14
-- @title Nobody signed in decides the pending evidence of a snag photo
-- @category documents
-- @expect error 42501 no signed-in actor
SELECT qc_decide_evidence(gen_random_uuid(), gen_random_uuid(), true, 'accepted');
-- @end

-- @case P6-15
-- @title Nobody signed in clears the pending determination of a task's document rule
-- @category documents
-- @expect error 42501 no signed-in actor
SELECT doc_mark_pending(gen_random_uuid(), ARRAY[]::uuid[]);
-- @end

-- @case P6-16
-- @title Alice decides the evidence of a snag that does not exist (no way to probe which snags exist)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT qc_decide_evidence(gen_random_uuid(), gen_random_uuid(), true, 'accepted');
-- @end

-- @case P6-17
-- @title The System Admin saves the documents and QC settings with an unknown key: refused with a field error
-- @category documents
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT admin_save_documents_qc('{"exif_tolerance_hours": 24, "scan_off": true}'::jsonb, 'Synthetic settings change', NULL);
-- @end

-- @case P6-18
-- @title The System Admin removes a severity from the catalogue: refused (deactivate it)
-- @category documents
-- @actor ADMIN
-- @region *
-- @expect error P0001 cannot_remove
SELECT admin_save_snag_severities('[{"code":"MAJOR","name_en":"Major","blocks":true},{"code":"MINOR","name_en":"Minor","blocks":false}]'::jsonb, 'Synthetic removal', NULL);
-- @end

-- @case P6-19
-- @title The System Admin sets a valid EXIF tolerance through admin_save_documents_qc
-- @category documents
-- @actor ADMIN
-- @region *
-- @expect ok
SELECT admin_save_documents_qc('{"exif_tolerance_hours": 24}'::jsonb, 'Synthetic settings change for the suite', NULL);
-- @end
