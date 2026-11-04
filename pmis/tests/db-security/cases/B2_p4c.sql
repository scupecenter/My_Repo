-- Work package P4c (migration 0063, owner answers 2026-11-04 Q114, Q139, Q148, Q150, Q151). The HLC record <-> purchase request links, the legacy HLC
-- migration links and the GECOL order setting are written only by their definer functions; the C3 closing helpers and the wrapped originals of
-- reg_validate / reg_warnings / reg_complete_task are not callable by the application role; the readers check the region.

-- @case P4C-01
-- @title Alice links an HLC record to a purchase request by writing the link table directly (to complete the C3 scope without the L1 holder)
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO hlc_pr_links (hlc_record_id, procurement_entity_id, site_id, region_id) VALUES (gen_random_uuid(), gen_random_uuid(), '{{SITE_TRI}}', 1);
-- @end

-- @case P4C-02
-- @title Alice removes the record of a legacy HLC migration, so a second run creates a duplicate draft
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM hlc_legacy_migrations;
-- @end

-- @case P4C-03
-- @title Alice closes C3 with a date of her choice through the internal closer
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hlc_c3_close(gen_random_uuid(), gen_random_uuid(), DATE '2026-01-01', '{{ALICE}}', true, false, 'forged');
-- @end

-- @case P4C-04
-- @title Alice runs the C3 completeness check herself (closes C3 as if she had approved the last request)
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hlc_c3_sync(gen_random_uuid(), '{{ALICE}}', true, false);
-- @end

-- @case P4C-05
-- @title Alice calls the original task closer that the Q150 wrapper replaced (closes C3 on the first request alone)
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT reg_complete_task_pre_0063(gen_random_uuid(), '{{ALICE}}', true, false);
-- @end

-- @case P4C-06
-- @title Alice reads the reviewer warnings through the original function (no longer granted, the wrapper is the reader)
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT reg_warnings_pre_0063(gen_random_uuid());
-- @end

-- @case P4C-07
-- @title Alice probes who may give an emergency exception (internal helper)
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT hlc_exception_allowed('{{ADMIN}}', 1);
-- @end

-- @case P4C-08
-- @title Alice (no admin right) runs the one-time legacy HLC migration
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT hlc_legacy_to_drafts(false, 'Security case P4C-08');
-- @end

-- @case P4C-09
-- @title Alice (no admin right) switches the GECOL order warnings off with the writer
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin path
SELECT admin_save_gecol_order_warnings('{"enabled": false, "chains": [], "billing_after": null}'::jsonb, 'Security case P4C-09', NULL);
-- @end

-- @case P4C-10
-- @title A System Admin saves the GECOL setting with a key the schema does not know: refused with field errors
-- @category p4c
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT admin_save_gecol_order_warnings('{"enabled": true, "chains": [], "billing_after": null, "script": "x"}'::jsonb, 'Security case P4C-10', NULL);
-- @end

-- @case P4C-11
-- @title Alice (Tripoli) lists the Dismantle orders of a Benghazi site
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT dismantle_order_options('{{SITE_BEN}}', 'cw');
-- @end

-- @case P4C-12
-- @title Alice names purchase requests on a record she cannot see
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT hlc_set_pr_links(gen_random_uuid(), 1, ARRAY[gen_random_uuid()]);
-- @end

-- @case P4C-13
-- @title Alice reads the purchase request view of a record she cannot see: nothing comes back
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect output true
SELECT (hlc_pr_view(gen_random_uuid()) IS NULL)::text;
-- @end

-- @case P4C-14
-- @title Control: the GECOL order warnings are off by default (Q151 keeps the current behaviour)
-- @category p4c
-- @actor ALICE
-- @region 1
-- @expect output false
SELECT (gecol_order_warnings_json() ->> 'enabled');
-- @end
