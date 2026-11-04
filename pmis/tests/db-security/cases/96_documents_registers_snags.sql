-- Migration 0047 (owner answers Q130 to Q132): the site field near_airport, document slots on register records and QC snag photos. The application role
-- is read-only on snags, snag photos, snag types, the slots and the record-slot snapshots; every write goes through a SECURITY DEFINER function that
-- names the actor, checks the right and the level, and writes the audit row. A snag cannot be closed, and a PAC / FAC unblocked, by a direct write.

-- @case RSN-01
-- @title Alice closes an open snag directly (it would unblock the CW PAC of the site)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE snags SET status = 'closed', closed_at = now();
-- @end

-- @case RSN-02
-- @title Alice plants a snag directly
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO snags (site_id, region_id, snag_type_id, scope, description, raised_by) SELECT '{{SITE_TRI}}', 1, id, 'CW', 'x', '{{ALICE}}' FROM snag_types LIMIT 1;
-- @end

-- @case RSN-03
-- @title Alice rewrites the EXIF date of a stored snag photo
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE snag_photos SET exif_date = now(), unknown_capture_date = false;
-- @end

-- @case RSN-04
-- @title Alice lowers the photo rules of every snag type
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE snag_types SET min_photos = 0, blocks_preliminary_acceptance = false;
-- @end

-- @case RSN-05
-- @title Alice, who is not an admin, changes a snag type through the admin path
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering document_types.edit required
SELECT admin_save_snag_type((SELECT id FROM snag_types WHERE code = 'QC_GENERAL'), '{"photo_rules":{"min_count":0}}'::jsonb, 'Not allowed', NULL);
-- @end

-- @case RSN-06
-- @title Alice plants a slot on a register record directly
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO document_slots (register_entity_id, register_key, site_id, region_id, doc_type_id, status)
SELECT gen_random_uuid(), 'quality', '{{SITE_TRI}}', 1, id, 'approved' FROM document_types LIMIT 1;
-- @end

-- @case RSN-07
-- @title Alice reads the internal snapshot table of the record slot sets
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM document_record_snapshots;
-- @end

-- @case RSN-08
-- @title Alice calls the internal record slot builder directly (it ignores the region of the caller)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT doc_sync_record_slots_core(gen_random_uuid());
-- @end

-- @case RSN-09
-- @title Alice calls the internal holder check of a snag directly
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT qc_require_actor(gen_random_uuid(), 'approve', '{{ALICE}}');
-- @end

-- @case RSN-10
-- @title Alice runs the Submit gate of register records as a plain function
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error 0A000|42501 trigger functions can only be called as triggers|permission denied
SELECT doc_record_submit_gate();
-- @end

-- @case RSN-11
-- @title Nobody signed in raises a snag
-- @category documents
-- @expect error 42501 no signed-in actor
SELECT qc_raise_snag('{{SITE_TRI}}', gen_random_uuid(), NULL, 'CW', 'Synthetic snag', NULL, 'MAJOR', NULL);
-- @end

-- @case RSN-12
-- @title Nobody signed in sets near_airport on a site
-- @category documents
-- @expect error 42501 no signed-in actor
SELECT site_save_custom('{{SITE_TRI}}', NULL, '{"near_airport": true}'::jsonb, NULL);
-- @end

-- @case RSN-13
-- @title Alice sets near_airport on a site of a region she cannot see (no way to probe the site)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT site_save_custom('{{SITE_BEN}}', NULL, '{"near_airport": true}'::jsonb, NULL);
-- @end

-- @case RSN-14
-- @title Alice approves a snag that does not exist (no way to probe which snags exist)
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT qc_transition_snag(gen_random_uuid(), NULL, 'approve', NULL, true, NULL);
-- @end

-- @case RSN-15
-- @title Alice rejects the slots of a register record that does not exist
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT doc_record_reject(gen_random_uuid(), NULL, 'note', '[]'::jsonb);
-- @end

-- @case RSN-16
-- @title Alice attaches a photo to a snag that does not exist
-- @category documents
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT qc_attach_photo(gen_random_uuid(), '{"ext":"jpg","size_bytes":10}'::jsonb);
-- @end

-- @case RSN-17
-- @title The System Admin adds a snag type with its photo rules through admin_save_snag_type
-- @category documents
-- @actor ADMIN
-- @region *
-- @expect ok
SELECT admin_save_snag_type(NULL, '{"code":"SEC_SNAG","name_en":"Synthetic security snag","photo_rules":{"min_count":2,"shot_types":["wide"],"formats":["JPG"],"max_size_mb":5}}'::jsonb, 'Synthetic snag type for the suite', NULL);
-- @end
