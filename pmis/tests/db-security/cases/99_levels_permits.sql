-- Migration 0050 (owner decisions 2026-11-02): old 3-level items become L1 / L2, and Permits & HSE is entered per stream. The conversion function and
-- the Matrix-only row are closed to the application role; the database refuses a TE permit from a CW-only member whatever the API does.

-- @case LV-01
-- @title Alice runs the 3-level conversion herself (rewrites every open item and writes audit rows)
-- @category levels_permits
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT levels_convert_two(false);
-- @end

-- @case LV-02
-- @title Alice un-retires the old review cells of the Matrix
-- @category levels_permits
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE matrix_cells SET retired_at = NULL WHERE level = 2;
-- @end

-- @case LV-03
-- @title Alice moves the permit type Access - TE to the CW stream (so the CW team could enter TE permits)
-- @category levels_permits
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE permit_types SET stream = 'CW' WHERE code = 'Access - TE';
-- @end

-- @case LV-04
-- @title Alice removes the stream mapping of Permits & HSE, so the one row decides every permit again
-- @category levels_permits
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE register_definitions SET rules = rules - 'scope_rows' WHERE register_key = 'permits_hse';
-- @end

-- @case LV-05
-- @title Alice names herself L1 of the TE stream row of Permits & HSE
-- @category levels_permits
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id)
SELECT c.id, 'user', '{{ALICE}}' FROM matrix_cells c WHERE c.register_key = 'permits_hse_te' AND c.level = 1 LIMIT 1;
-- @end

-- @case LV-06
-- @title A CW Site Engineer (L1 of the CW row only) enters a TE permit: refused by the database
-- @category levels_permits
-- @actor ADMIN
-- @region *
-- @expect error P0001 not_eligible_holder
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_CW'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case LV-06');
\ctx CAROL
SELECT reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "Access - TE", "status": "Applied"}'::jsonb, NULL, NULL, false);
-- @end

-- @case LV-07
-- @title Control: the same CW Site Engineer enters a CW permit (allowed; rolled back)
-- @category levels_permits
-- @actor ADMIN
-- @region *
-- @expect output true
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_CW'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case LV-07');
\ctx CAROL
SELECT (reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "Access - CW", "status": "Applied"}'::jsonb, NULL, NULL, false) IS NOT NULL)::text;
-- @end

-- @case LV-08
-- @title Control: a TE Site Engineer (L1 of the TE row) enters a TE permit (allowed; rolled back), and the TE Team Lead is the L2 of that row
-- @category levels_permits
-- @actor ADMIN
-- @region *
-- @expect output true
SELECT idm_assign('{{CAROL}}', (SELECT id FROM roles WHERE code = 'SITE_ENG_TE'), 'entry', NULL, NULL, NULL, false, true, NULL, true, NULL,
  ARRAY[(SELECT id FROM permission_profiles WHERE code = 'data_entry')], 'Security case LV-08');
\ctx CAROL
SELECT (reg_save_record('permits_hse', NULL, NULL, '{{SITE_TRI}}', NULL, '{"permit_type": "Access - TE", "status": "Applied"}'::jsonb, NULL, NULL, false) IS NOT NULL
  AND EXISTS (SELECT 1 FROM matrix_cells c JOIN matrix_cell_assignees a ON a.cell_id = c.id JOIN roles r ON r.id = a.ref_id
              WHERE c.register_key = 'permits_hse_te' AND c.level = 3 AND r.code = 'TE_TL'))::text;
-- @end
