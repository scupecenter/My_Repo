-- Work package P7, migration 0053 (owner answers Q105, Q106, Q107, decision D6). The application role only reads the numbering sequences, their counters,
-- the issued numbers and the region WL vendors. It cannot issue a number around wh_create_movement, reset a counter so a number is issued twice, take a
-- return out of quarantine, confirm a pending need, or unlock the Doc No. of a posted movement. The admin writers check the actor's own rights.

-- @case P7-01
-- @title Alice plants a numbering sequence of her own
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO doc_sequences (key, record_type, region_id, region_code, pattern) VALUES ('DN-CW-ZZ', 'cw_dn', 4, 'ZZ', 'DN-{YYYY}-{SEQ:4}');
-- @end

-- @case P7-02
-- @title Alice resets a counter so the next numbers are issued again
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE doc_sequence_counters SET next_value = 1;
-- @end

-- @case P7-03
-- @title Alice deletes the record of the issued numbers so one can be typed again
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM doc_number_issues;
-- @end

-- @case P7-04
-- @title Alice issues a number directly, outside a document
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT doc_next_number('DN-CW-TR', DATE '2026-01-10', 'wh_movement', NULL);
-- @end

-- @case P7-05
-- @title Alice (not an admin, no delegation) changes the pattern of a sequence through the admin writer
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 settings
SELECT admin_save_doc_sequence('DN-CW-TR', false, '{"pattern": "X-{YYYY}-{SEQ:2}"}'::jsonb, 'Security case P7-05', NULL);
-- @end

-- @case P7-06
-- @title Alice sets the WL vendor of a region directly
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO warehouse_region_vendors (region_id, wl_vendor) VALUES (1, 'Cambium');
-- @end

-- @case P7-07
-- @title Alice sets the WL vendor of a region through the admin writer
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 warehouse_items
SELECT admin_save_region_vendor(1, 'Cambium', 'Security case P7-07', NULL);
-- @end

-- @case P7-08
-- @title Alice turns every Faulty return line into Good, releasing the quarantine into the available stock
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE wh_movement_lines SET condition = 'Good' WHERE condition IN ('Faulty', 'Damaged');
-- @end

-- @case P7-09
-- @title Alice confirms the pending need rules directly, so sites can show "complete"
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE warehouse_item_need_rules SET status = 'confirmed' WHERE status = 'pending_configuration';
-- @end

-- @case P7-10
-- @title Alice unlocks the Doc No. of the posted movements
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE wh_movements SET doc_no = NULL WHERE status = 'posted';
-- @end

-- @case P7-11
-- @title Alice marks the Master codes as internal (or the reverse) directly
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE warehouse_items SET code_source = 'master';
-- @end

-- @case P7-12
-- @title Alice reads the need lines of a site through the internal function (only wh_site_dispatch is callable)
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT * FROM wh_site_need_lines('{{SITE_TRI}}');
-- @end

-- @case P7-13
-- @title The dispatch of a site outside Alice's regions answers nothing
-- @category p7-warehouse
-- @actor ALICE
-- @region 1
-- @expect output 1
SELECT count(*) FROM (SELECT wh_site_dispatch('{{SITE_BEN}}') AS d) x WHERE x.d IS NULL;
-- @end
