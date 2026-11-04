-- Migration 0054 (P11, owner answers Q215-Q222 and D220b of 2026-11-04): the conversion record, the one-off notices and the hold of converted items are
-- written only by the definer functions; permits are entered on the stream row their type (or the chosen stream) decides, rechecked at every save and
-- submit; a draft moves to a qualified holder only through reg_permit_transfer.

-- @case P11-01
-- @title Alice writes a conversion record herself (to hide an item's old path or release its hold)
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO levels_conversions (entity_type, entity_id, converted_at, levels_before, migration, reason) VALUES ('task', gen_random_uuid(), now(), 3, '0054', 'forged');
-- @end

-- @case P11-02
-- @title Alice releases the hold of a converted item by updating the conversion record
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE levels_conversions SET hold_released_at = now();
-- @end

-- @case P11-03
-- @title Alice runs the extended conversion (it rewrites every open 1-level and 3-level item)
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT levels_convert_two(false);
-- @end

-- @case P11-04
-- @title Alice sends the conversion notice of an item again (spam, or notices about items of other regions)
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT levels_conversion_notify('task', gen_random_uuid());
-- @end

-- @case P11-05
-- @title Alice moves every open permit draft (the migration-only recheck)
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT permit_drafts_recheck(false);
-- @end

-- @case P11-06
-- @title Alice calls the internal mover to pin somebody else's draft to herself
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT reg_permit_move(gen_random_uuid(), NULL, '{{ALICE}}', ARRAY['{{ALICE}}']::uuid[], NULL, 'forged');
-- @end

-- @case P11-07
-- @title Alice makes the purpose-based permit types fixed to her own stream
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE permit_types SET stream_options = NULL, stream = 'CW' WHERE code = 'Access - Dismantle';
-- @end

-- @case P11-08
-- @title Alice removes the O&M and Acquisition stream rows from the Permits & HSE mapping
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE register_definitions SET rules = jsonb_set(rules, '{scope_rows}', '{"TE": "permits_hse_te"}') WHERE register_key = 'permits_hse';
-- @end

-- @case P11-09
-- @title Alice writes a fake "transfer" step into a permit's history
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO register_steps (record_id, level, action, acted_by) SELECT r.id, 1, 'transfer', '{{ALICE}}' FROM register_records r LIMIT 1;
-- @end

-- @case P11-10
-- @title A CW Site Engineer enters an Access - Dismantle permit without choosing its stream: refused by the database (D220b)
-- @category levels_permits_p11
-- @actor ADMIN
-- @region *
-- @expect error P0001 stream_required
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_CW'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case P11-10');
\ctx CAROL
SELECT reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "Access - Dismantle", "status": "Applied"}'::jsonb, NULL, NULL, false);
-- @end

-- @case P11-11
-- @title A CW Site Engineer enters a Dismantle permit and chooses the TE stream (the TE team's row): refused by the database
-- @category levels_permits_p11
-- @actor ADMIN
-- @region *
-- @expect error P0001 not_eligible_holder
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_CW'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case P11-11');
\ctx CAROL
SELECT reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "PTW - Dismantle", "permit_stream": "TE", "status": "Applied"}'::jsonb, NULL, NULL, false);
-- @end

-- @case P11-12
-- @title A CW Site Engineer enters a City Council permit (Acquisition / RF & Design stream, Q220): refused by the database
-- @category levels_permits_p11
-- @actor ADMIN
-- @region *
-- @expect error P0001 not_eligible_holder
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_CW'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case P11-12');
\ctx CAROL
SELECT reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "City Council Permit", "status": "Applied"}'::jsonb, NULL, NULL, false);
-- @end

-- @case P11-13
-- @title A CW Site Engineer stamps a fixed CW permit with another stream, to move it to another row
-- @category levels_permits_p11
-- @actor ADMIN
-- @region *
-- @expect error P0001 stream_fixed
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_CW'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case P11-13');
\ctx CAROL
SELECT reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "Access - CW", "permit_stream": "TE", "status": "Applied"}'::jsonb, NULL, NULL, false);
-- @end

-- @case P11-14
-- @title Control: the CW Site Engineer enters a Dismantle permit on the CW stream (allowed; rolled back)
-- @category levels_permits_p11
-- @actor ADMIN
-- @region *
-- @expect output true
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_CW'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case P11-14');
\ctx CAROL
SELECT (reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "Access - Dismantle", "permit_stream": "CW", "status": "Applied"}'::jsonb, NULL, NULL, false) IS NOT NULL)::text;
-- @end

-- @case P11-15
-- @title Bob (a TE engineer who can see the permit, not an entry holder of its CW row and not its holder) transfers a permit draft of the CW engineer to himself
-- @category levels_permits_p11
-- @actor ADMIN
-- @region *
-- @expect error P0001 not_eligible_holder
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_CW'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case P11-15');
SELECT idm_assign('{{BOB}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_TE'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case P11-15');
\ctx CAROL
CREATE TEMP TABLE p11_rec ON COMMIT DROP AS
  SELECT reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "Access - CW", "status": "Applied"}'::jsonb, NULL, NULL, false) AS id;
\ctx BOB
SELECT reg_permit_transfer((SELECT id FROM p11_rec), NULL, 'mine now');
-- @end

-- @case P11-16
-- @title Control: the application role reads the conversion record and the permit types it may enter
-- @category levels_permits_p11
-- @actor ALICE
-- @region 1
-- @expect output true
SELECT ((SELECT count(*) FROM levels_conversions) >= 0 AND jsonb_typeof(reg_entry_permit_types()) = 'array')::text;
-- @end
