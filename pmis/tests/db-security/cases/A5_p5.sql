-- Work package P5 (migration 0057, owner answers Q12, Q104, Q111): the list catalogue, the new field types and Meetings. The lists are configuration:
-- the application role only reads them, and only the System Admin (or a delegate of fields.edit for all regions) writes them through
-- admin_save_list_catalogue / admin_save_list_value. The resolvers, the field refresh, the submit trigger and the file check of a record are not callable
-- by the application role; the Meetings conversion needs a signed-in L1 holder.

-- @case P5-01
-- @title Alice adds a value to a critical list straight in the table (so a record could carry an unreviewed value)
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO list_values (catalogue_code, code, label_en) VALUES ('Severity', 'Cosmetic', 'Cosmetic');
-- @end

-- @case P5-02
-- @title Alice turns the critical flag of Severity off, so its approval guard no longer applies
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE list_catalogues SET critical = false WHERE code = 'Severity';
-- @end

-- @case P5-03
-- @title Alice deletes the values of a list
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM list_values WHERE catalogue_code = 'IssueStatus';
-- @end

-- @case P5-04
-- @title Alice unlinks the Issue Status field from its catalogue (back to free text)
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE register_fields SET list_catalogue = NULL, options = NULL WHERE register_key = 'issues' AND code = 'issue_status';
-- @end

-- @case P5-05
-- @title Alice (no fields grant) adds a list value through the admin function
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 delegation covering fields.edit required
SELECT admin_save_list_value('Severity', NULL, '{"code": "Cosmetic"}'::jsonb, 'Security case P5-05', NULL);
-- @end

-- @case P5-06
-- @title Alice (no fields grant) confirms a pending list through the admin function
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 delegation covering fields.edit required
SELECT admin_save_list_catalogue('RiskStatus', false, '{"status": "confirmed"}'::jsonb, 'Security case P5-06', NULL);
-- @end

-- @case P5-07
-- @title Alice re-materialises the options of the linked fields herself
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT list_refresh_fields('Severity');
-- @end

-- @case P5-08
-- @title Alice probes whether a file id belongs to a record of another region through the file check
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT reg_record_file_ok(gen_random_uuid(), gen_random_uuid());
-- @end

-- @case P5-09
-- @title Alice resolves a site code of another region through the site resolver (it reads every region)
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT reg_pick_site('{{SITE_BEN}}');
-- @end

-- @case P5-10
-- @title Alice calls the submit trigger function directly
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT p5_record_rules();
-- @end

-- @case P5-11
-- @title The Meetings conversion with no signed-in user
-- @category p5_lists
-- @actor none
-- @region *
-- @expect error 42501 no signed-in actor
SELECT reg_meeting_convert(gen_random_uuid(), 1, '{}'::jsonb, 'Security case P5-11');
-- @end

-- @case P5-12
-- @title The System Admin renames the code of a value (records store the code): refused by the database
-- @category p5_lists
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT admin_save_list_value('Severity', (SELECT id FROM list_values WHERE catalogue_code = 'Severity' AND code = 'Major'), '{"code": "Big"}'::jsonb, 'Security case P5-12', NULL);
-- @end

-- @case P5-13
-- @title The System Admin deactivates the last active value of a critical list: refused (it would block every approval)
-- @category p5_lists
-- @actor ADMIN
-- @region *
-- @expect error P0001 last_active_value
SELECT admin_save_list_value('StaffStatus', (SELECT id FROM list_values WHERE catalogue_code = 'StaffStatus' AND code = 'Active'), '{"is_active": false}'::jsonb, 'Security case P5-13', NULL);
SELECT admin_save_list_value('StaffStatus', (SELECT id FROM list_values WHERE catalogue_code = 'StaffStatus' AND code = 'Inactive'), '{"is_active": false}'::jsonb, 'Security case P5-13', NULL);
-- @end

-- @case P5-14
-- @title Control: the System Admin adds a value with a reason (allowed; committed through the admin function)
-- @category p5_lists
-- @actor ADMIN
-- @region *
-- @expect ok
SELECT admin_save_list_value('MeetingType', NULL, '{"code": "Security review", "label_ar": "مراجعة أمنية"}'::jsonb, 'Security case P5-14', NULL);
-- @end

-- @case P5-15
-- @title Control: the application role reads the active codes of a list
-- @category p5_lists
-- @actor ALICE
-- @region 1
-- @expect output 3
SELECT jsonb_array_length(list_active_codes('Severity'));
-- @end
