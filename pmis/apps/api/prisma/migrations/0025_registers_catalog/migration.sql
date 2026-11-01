-- 0025_registers_catalog: nine more registers on the generic register framework of 0019 (no new endpoint, no new table; Dismantle 0021 is the pattern).
-- Mirror: db/sql/024_registers_catalog.sql (kept identical).
--
--   Enabled here: contractors, quality, issues, risks, change_control, readiness_handover, meetings, rf_design, acquisition.
--   Warehouse comes with its own tables in 0026 and As-Built with its editable item list in 0027. Deliverables (Q71) stays disabled.
--   Fields are ONLY those of docs/spec/registers-and-streams.md section 3 (codes follow the spec column names). Types map to the framework types:
--     int -> number, ref:X and party -> text, list:Name -> list (free text where the owner has not fixed the values, as Q95), calc columns are not fields.
--   Required flags: only what the spec says (Validation sections). Rules the spec lists as blocking are checked at submit by reg_validate_catalog,
--   which reg_validate now calls beside the 0019 rules. Matrix cells stay as seeded in 0020. Matrix and permission modules were seeded in 0020 / 0009.
--   Approved records stay in register_records (like Dismantle); two typed effects are built: Contractors -> external_parties / external_teams
--   (so Procurement can pick them) and the approver fields of Q45 (Change Control L:N, Quality Q and U, Readiness I).
--   Meetings: multi-user, multi-site, file and child-list fields cannot be expressed in the framework types (follow-up question).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Definitions (site_scoped / multiple_per_site as the spec says: Q55, Q69)
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE register_definitions SET enabled = true, record_types = ARRAY['company', 'team'], site_scoped = false, multiple_per_site = true WHERE register_key = 'contractors';
UPDATE register_definitions SET enabled = true, record_types = ARRAY['qc', 'snag', 'itp', 'ncr'], site_scoped = true, multiple_per_site = true WHERE register_key = 'quality';
UPDATE register_definitions SET enabled = true, site_scoped = true, multiple_per_site = true WHERE register_key = 'issues';
UPDATE register_definitions SET enabled = true, site_scoped = false, multiple_per_site = true WHERE register_key = 'risks';
UPDATE register_definitions SET enabled = true, site_scoped = true, multiple_per_site = true WHERE register_key = 'change_control';
UPDATE register_definitions SET enabled = true, site_scoped = true, multiple_per_site = false WHERE register_key = 'readiness_handover';
UPDATE register_definitions SET enabled = true, site_scoped = false, multiple_per_site = true WHERE register_key = 'meetings';
UPDATE register_definitions SET enabled = true, site_scoped = true, multiple_per_site = false WHERE register_key = 'rf_design';
UPDATE register_definitions SET enabled = true, site_scoped = true, multiple_per_site = true WHERE register_key = 'acquisition';   -- one row per candidate (A-D), exactly one Selected

-- A second first-version record of a site in a one-per-site register is refused by reg_save_record; this index is the race backstop (same as GECOL and HLC, 0019).
CREATE UNIQUE INDEX register_records_one_per_site_catalog_idx ON register_records (register_key, site_id)
  WHERE version_no = 1 AND state <> 'voided' AND register_key IN ('rf_design', 'readiness_handover');

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Fields (idempotent)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_fields (register_key, code, label_en, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  -- 3.4 Contractors: record type company (tblContractors Q:V) or team (tblTeams Z:AD). Not site-scoped (anyone holding the module sees them, Q69).
  ('contractors', 'contractor_name',  'Contractor',            'text', false, false, false, NULL, true,  'Company', 10),
  ('contractors', 'company_type',     'Company Type',          'list', false, false, false, NULL, true,  'Company', 20),
  ('contractors', 'contract_ref',     'Contract Ref',          'text', false, false, false, NULL, false, 'Contract', 30),
  ('contractors', 'contract_start',   'Contract Start',        'date', false, false, false, NULL, false, 'Contract', 40),
  ('contractors', 'contract_end',     'Contract End',          'date', false, false, false, NULL, true,  'Contract', 50),
  ('contractors', 'company_status',   'Status',                'list', false, false, false, NULL, true,  'Contract', 60),
  ('contractors', 'team_name',        'Team',                  'text', false, false, false, NULL, true,  'Teams', 70),
  ('contractors', 'team_type',        'Team Type',             'list', false, false, false, NULL, false, 'Teams', 80),
  ('contractors', 'contractor',       'Contractor (of the team)', 'text', false, false, false, NULL, true, 'Teams', 90),
  ('contractors', 'specialization',   'Specialization',        'list', false, false, false, NULL, true,  'Teams', 100),
  ('contractors', 'team_status',      'Team Status',           'list', false, false, false, NULL, false, 'Teams', 110),

  -- 3.9 Quality Inspections (record types qc / snag / itp / ncr = Record Type)
  ('quality', 'record_code',       'Record ID',               'text', true,  false, false, NULL, true,  'Record', 10),
  ('quality', 'stage',             'Stage',                   'list', false, false, false, '["CW QC", "TE QC", "CW PAC", "CW FAC", "TE PAC", "TE FAC"]'::jsonb, true, 'Record', 20),
  ('quality', 'activity',          'Activity',                'list', false, false, false, NULL, false, 'Record', 30),
  ('quality', 'point_type',        'Point Type',              'list', false, false, false, '["Hold", "Witness", "Review"]'::jsonb, false, 'Record', 40),
  ('quality', 'description',       'Description',             'text', false, false, false, NULL, true,  'Description and severity', 50),
  ('quality', 'severity',          'Severity',                'list', false, false, false, NULL, true,  'Description and severity', 60),
  ('quality', 'team_id',           'Team',                    'external_team', false, false, false, NULL, false, 'Party', 70),
  ('quality', 'raised_date',       'Raised / Submitted Date', 'date', false, true,  false, NULL, true,  'Dates', 80),
  ('quality', 'target_date',       'Target Date',             'date', false, false, false, NULL, false, 'Dates', 90),
  ('quality', 'result',            'Result',                  'list', false, false, false, NULL, true,  'Result and closure', 100),
  ('quality', 'closed_date',       'Closed / Released Date',  'date', false, true,  false, NULL, false, 'Result and closure', 110),
  ('quality', 'approved_by',       'Approved / Released By',  'user', false, false, true,  NULL, false, 'Result and closure', 120),
  ('quality', 'root_cause',        'Root Cause & Corrective Action', 'text', false, false, false, NULL, false, 'Root cause', 130),
  ('quality', 'linked_record',     'Linked Record ID',        'text', false, false, false, NULL, false, 'Root cause', 140),
  ('quality', 'na_reason',         'N/A Reason',              'text', false, false, false, NULL, false, 'N/A', 150),
  ('quality', 'na_approved_by',    'N/A Approved By',         'user', false, false, true,  NULL, false, 'N/A', 160),
  ('quality', 'remark',            'Remark',                  'text', false, false, false, NULL, false, 'Remark', 170),

  -- 3.12 Issue Log (several per site). The owner is a user or the record's external party (Q70).
  ('issues', 'pending_issue',          'Pending Issue',        'text', true,  false, false, NULL, true,  'Issue', 10),
  ('issues', 'owner_user',             'Issue Owner (Aljeel)', 'user', false, false, false, NULL, true,  'Ownership and dates', 20),
  ('issues', 'raised_date',            'Issue Raised Date',    'date', true,  true,  false, NULL, true,  'Ownership and dates', 30),
  ('issues', 'issue_status',           'Issue Status',         'list', true,  false, false, NULL, true,  'Ownership and dates', 40),
  ('issues', 'blocked_gate_or_task',   'Blocked Gate / Task',  'text', false, false, false, NULL, false, 'Issue', 50),
  ('issues', 'due_date',               'Due Date',             'date', false, false, false, NULL, true,  'Ownership and dates', 60),
  ('issues', 'resolution_date',        'Resolution Date',      'date', false, true,  false, NULL, false, 'Resolution', 70),
  ('issues', 'root_cause',             'Root Cause',           'text', false, false, false, NULL, false, 'Resolution', 80),
  ('issues', 'corrective_action',      'Corrective Action',    'text', false, false, false, NULL, false, 'Resolution', 90),
  ('issues', 'remark',                 'Remark',               'text', false, false, false, NULL, false, 'Resolution', 100),

  -- 3.13 Risk Register (no site; the optional Affected Site IDs is a text list of site codes, Q69)
  ('risks', 'risk_id',          'Risk ID',            'text',   true,  false, false, NULL, true,  'Risk', 10),
  ('risks', 'risk_statement',   'Risk Statement',     'text',   true,  false, false, NULL, true,  'Risk', 20),
  ('risks', 'category',         'Category',           'list',   false, false, false, NULL, true,  'Risk', 30),
  ('risks', 'scope',            'Scope',              'list',   false, false, false, NULL, false, 'Risk', 40),
  ('risks', 'affected_sites',   'Affected Sites',     'number', false, false, false, NULL, false, 'Risk', 50),
  ('risks', 'affected_site_ids','Affected Site IDs',  'text',   false, false, false, NULL, false, 'Risk', 55),
  ('risks', 'probability',      'Probability (1-5)',  'number', false, false, false, NULL, true,  'Assessment', 60),
  ('risks', 'impact',           'Impact (1-5)',       'number', false, false, false, NULL, true,  'Assessment', 70),
  ('risks', 'response',         'Response',           'list',   false, false, false, NULL, false, 'Response', 80),
  ('risks', 'mitigation_action','Mitigation Action',  'text',   false, false, false, NULL, false, 'Response', 90),
  ('risks', 'risk_owner',       'Risk Owner',         'text',   false, false, false, NULL, false, 'Response', 100),
  ('risks', 'action_owner',     'Action Owner',       'user',   false, false, false, NULL, false, 'Response', 110),
  ('risks', 'target_date',      'Target Date',        'date',   false, false, false, NULL, false, 'Tracking', 120),
  ('risks', 'status',           'Status',             'list',   false, false, false, NULL, true,  'Tracking', 130),
  ('risks', 'trend',            'Trend',              'list',   false, false, false, NULL, false, 'Tracking', 140),
  ('risks', 'last_review_date', 'Last Review Date',   'date',   false, true,  false, NULL, false, 'Tracking', 150),
  ('risks', 'next_review_date', 'Next Review Date',   'date',   false, false, false, NULL, false, 'Tracking', 160),

  -- 3.10 Change Control. L:N (Approval, Approved By, Approval Date) are filled by the final approval (Q45).
  ('change_control', 'change_id',        'Change ID',          'text', true,  false, false, NULL, true,  'Change', 10),
  ('change_control', 'change_type',      'Change Type',        'list', true,  false, false,
     '["Suspension", "Resumption", "Cancellation", "Cutover Window", "Cutover Rollback", "Scope Change", "Relocation", "Baseline Re-plan", "Data Correction"]'::jsonb, true, 'Change', 20),
  ('change_control', 'change_scope',     'Change Scope',       'list', false, false, false, '["Field", "Part", "Site"]'::jsonb, false, 'Change', 30),
  ('change_control', 'field_item',       'Field / Scope Item', 'text', false, false, false, NULL, false, 'Change', 40),
  ('change_control', 'old_value',        'Old Value',          'text', false, false, false, NULL, false, 'Values', 50),
  ('change_control', 'new_value',        'New Value',          'text', false, false, false, NULL, false, 'Values', 60),
  ('change_control', 'reason',           'Reason / Remark',    'text', false, false, false, NULL, false, 'Reason', 70),
  ('change_control', 'request_date',     'Request Date',       'date', false, true,  false, NULL, true,  'Request', 80),
  ('change_control', 'change_ticket_id', 'Change Ticket ID',   'text', false, false, false, NULL, false, 'Request', 90),
  ('change_control', 'approval',         'Approval',           'list', false, false, true,  '["Approved"]'::jsonb, true, 'Approval', 100),
  ('change_control', 'approved_by',      'Approved By',        'user', false, false, true,  NULL, false, 'Approval', 110),
  ('change_control', 'approval_date',    'Approval Date',      'date', false, false, true,  NULL, true,  'Approval', 120),

  -- 3.11 Readiness & Handover (one per site). Control Status, Ops Acceptance Valid, HOTO Package Valid, Closure Ready, Final Closure are calc and not fields.
  ('readiness_handover', 'commissioning_power_safe_date', 'Commissioning Power Safe Date', 'date', false, true,  false, NULL, false, 'On-Air controls', 10),
  ('readiness_handover', 'uplink_ready_date',             'Uplink Ready Date',             'date', false, true,  false, NULL, false, 'On-Air controls', 20),
  ('readiness_handover', 'om_checklist',                  'O&M Checklist',                 'list', false, false, false, NULL, true,  'O&M acceptance', 30),
  ('readiness_handover', 'na_reason',                     'N/A Reason',                    'text', false, false, false, NULL, false, 'O&M acceptance', 40),
  ('readiness_handover', 'na_approved_by',                'N/A Approved By',               'user', false, false, true,  NULL, false, 'O&M acceptance', 50),
  ('readiness_handover', 'om_accepted_by',                'O&M Accepted By',               'text', false, false, false, NULL, false, 'O&M acceptance', 60),
  ('readiness_handover', 'om_acceptance_date',            'O&M Acceptance Date',           'date', false, true,  false, NULL, true,  'O&M acceptance', 70),
  ('readiness_handover', 'access_keys_handover_date',     'Site Access & Keys Handover Date', 'date', false, true, false, NULL, false, 'HOTO package', 80),
  ('readiness_handover', 'hoto_package_actual_date',      'HOTO Package Actual Date',      'date', false, true,  false, NULL, false, 'HOTO package', 90),
  ('readiness_handover', 'legacy_handover_date',          'Legacy Handover Date',          'date', false, true,  false, NULL, false, 'Legacy handover', 100),
  ('readiness_handover', 'obligations_closure_date',      'Obligations Closure Date',      'date', false, true,  false, NULL, false, 'Closure', 110),
  ('readiness_handover', 'closure_approved_by',           'Closure Approved By',           'user', false, false, false, NULL, false, 'Closure', 120),
  ('readiness_handover', 'closure_approval_date',         'Closure Approval Date',         'date', false, true,  false, NULL, false, 'Closure', 130),

  -- 3.15 Meetings (Q12 default). Attendees and linked sites are text lists; the minutes file and the action items are a follow-up (see the open questions).
  ('meetings', 'meeting_date',  'Date',          'date', true,  false, false, NULL, true,  'Meeting', 10),
  ('meetings', 'title',         'Title',         'text', true,  false, false, NULL, true,  'Meeting', 20),
  ('meetings', 'meeting_type',  'Type',          'list', false, false, false, NULL, true,  'Meeting', 30),
  ('meetings', 'attendees',     'Attendees',     'text', false, false, false, NULL, false, 'Attendees and sites', 40),
  ('meetings', 'linked_sites',  'Linked sites',  'text', false, false, false, NULL, false, 'Attendees and sites', 50),
  ('meetings', 'minutes_ref',   'Minutes (reference)', 'text', false, false, false, NULL, false, 'Minutes', 60),
  ('meetings', 'action_items',  'Action items',  'text', false, false, false, NULL, false, 'Action items', 70),

  -- 3.1 RF & Design (one per site). Calc columns K, V, AC, AL are not fields. Site ID, Site Name and Region are the site's own.
  ('rf_design', 'site_owner_id',          'Site Owner ID',              'text',   false, false, false, NULL, false, 'Identity', 10),
  ('rf_design', 'sub_region',             'Sub Region',                 'text',   false, false, false, NULL, false, 'Identity', 20),
  ('rf_design', 'latitude',               'Latitude',                   'number', false, false, false, NULL, false, 'Identity', 30),
  ('rf_design', 'longitude',              'Longitude',                  'number', false, false, false, NULL, false, 'Identity', 40),
  ('rf_design', 'site_type',              'Site Type',                  'list',   false, false, false, NULL, true,  'Identity', 50),
  ('rf_design', 'site_scenario',          'Site Scenario',              'list',   false, false, false, '["New Build", "Expansion", "Hot Swap", "Cold Swap", "Relocation"]'::jsonb, true, 'Identity', 60),
  ('rf_design', 'tower_owner',            'Tower Owner',                'list',   false, false, false, NULL, false, 'Tower', 70),
  ('rf_design', 'existing_or_new',        'Existing or New',            'list',   false, false, false, '["Existing", "New"]'::jsonb, false, 'Tower', 80),
  ('rf_design', 'rt_or_gf',               'RT or GF',                   'list',   false, false, false, '["RT", "GF"]'::jsonb, false, 'Tower', 90),
  ('rf_design', 'tower_type',             'Tower Type',                 'list',   false, false, false, NULL, false, 'Tower', 100),
  ('rf_design', 'tower_height',           'Tower Height (m)',           'number', false, false, false, NULL, false, 'Tower', 110),
  ('rf_design', 'nominal_plan_issue_date','Nominal Plan Issue Date',    'date',   false, false, false, NULL, false, 'Nominal and search ring', 120),
  ('rf_design', 'nominal_latitude',       'Nominal Latitude',           'number', false, false, false, NULL, false, 'Nominal and search ring', 130),
  ('rf_design', 'nominal_longitude',      'Nominal Longitude',          'number', false, false, false, NULL, false, 'Nominal and search ring', 140),
  ('rf_design', 'search_ring_radius',     'Search Ring Radius (m)',     'number', false, false, false, NULL, false, 'Nominal and search ring', 150),
  ('rf_design', 'search_ring_received',   'Search Ring Received Date',  'date',   false, true,  false, NULL, true,  'Nominal and search ring', 160),
  ('rf_design', 'cluster_id',             'Cluster ID',                 'text',   false, false, false, NULL, true,  'RF design', 170),
  ('rf_design', 'antenna_height',         'Antenna Height',             'number', false, false, false, NULL, false, 'RF design', 180),
  ('rf_design', 'sectors',                'Sectors',                    'number', false, false, false, NULL, false, 'RF design', 190),
  ('rf_design', 'azimuths',               'Azimuths',                   'text',   false, false, false, NULL, false, 'RF design', 200),
  ('rf_design', 'tilt',                   'M-Tilt / E-Tilt',            'text',   false, false, false, NULL, false, 'RF design', 210),
  ('rf_design', 'rf_survey_actual_date',  'RF Survey Actual Date',      'date',   false, true,  false, NULL, true,  'RF design', 220),
  ('rf_design', 'tss_plan',               'TSS Plan',                   'date',   false, false, false, NULL, false, 'TSS / TSSR', 230),
  ('rf_design', 'tss_actual',             'TSS Actual',                 'date',   false, true,  false, NULL, false, 'TSS / TSSR', 240),
  ('rf_design', 'tssr_submitted',         'TSSR Submitted',             'date',   false, true,  false, NULL, true,  'TSS / TSSR', 250),
  ('rf_design', 'tssr_approved',          'TSSR Approved',              'date',   false, true,  false, NULL, true,  'TSS / TSSR', 260),
  ('rf_design', 'tssr_status',            'TSSR Status',                'list',   false, false, false, NULL, false, 'TSS / TSSR', 270),
  ('rf_design', 'tssr_rev_no',            'TSSR Rev No.',               'number', false, false, false, NULL, false, 'TSS / TSSR', 280),
  ('rf_design', 'rf_data_sheet_issued',   'RF Data Sheet Issued',       'date',   false, true,  false, NULL, false, 'MW', 290),
  ('rf_design', 'mw_los_survey_date',     'MW LOS Survey Date',         'date',   false, true,  false, NULL, false, 'MW', 300),
  ('rf_design', 'mw_far_end_site',        'MW Far-end Site',            'text',   false, false, false, NULL, false, 'MW', 310),
  ('rf_design', 'link_budget_date',       'Link Budget Date',           'date',   false, true,  false, NULL, false, 'MW', 320),
  ('rf_design', 'frequency_license_date', 'Frequency License Date',     'date',   false, false, false, NULL, false, 'MW', 330),
  ('rf_design', 'frequency_license_ref',  'Frequency License Ref',      'text',   false, false, false, NULL, false, 'MW', 340),
  ('rf_design', 'building_height',        'Building Height',            'number', false, false, false, NULL, false, 'Civil inputs', 350),
  ('rf_design', 'cabinet_foundation',     'Cabinet Foundation (Existing / New)', 'list', false, false, false, '["Existing", "New"]'::jsonb, false, 'Civil inputs', 360),
  ('rf_design', 'cabinet_foundation_dims','Cabinet Foundation Dimensions', 'text', false, false, false, NULL, false, 'Civil inputs', 370),
  ('rf_design', 'backup_site',            'Backup Site',                'text',   false, false, false, NULL, false, 'Topology', 380),
  ('rf_design', 'belong_to_fn',           'Belong to FN',               'text',   false, false, false, NULL, false, 'Topology', 390),
  ('rf_design', 'primary_mfn',            'Primary MFN',                'text',   false, false, false, NULL, false, 'Topology', 400),
  ('rf_design', 'secondary_mfn',          'Secondary MFN',              'text',   false, false, false, NULL, false, 'Topology', 410),
  ('rf_design', 'hld_ref',                'HLD Ref #',                  'text',   false, false, false, NULL, false, 'LLD and remark', 420),
  ('rf_design', 'lld_approved_date',      'LLD Approved Date',          'date',   false, true,  false, NULL, false, 'LLD and remark', 430),
  ('rf_design', 'remark',                 'Remark',                     'text',   false, false, false, NULL, false, 'LLD and remark', 440),

  -- 3.2 Acquisition (one row per candidate; exactly one Selected = Yes per site). Calc columns C, D, I, J, AC, AD, AE and the helpers AG, AH are not fields.
  ('acquisition', 'candidate',               'Candidate',                       'list', true,  false, false, '["A", "B", "C", "D"]'::jsonb, true, 'Candidate', 10),
  ('acquisition', 'latitude',                'Latitude',                        'number', false, false, false, NULL, false, 'Candidate', 20),
  ('acquisition', 'longitude',               'Longitude',                       'number', false, false, false, NULL, false, 'Candidate', 30),
  ('acquisition', 'address',                 'Address',                         'text', false, false, false, NULL, false, 'Candidate', 40),
  ('acquisition', 'candidate_submitted_date','Candidate Submitted Date (SAR)',  'date', false, true,  false, NULL, true,  'Survey', 50),
  ('acquisition', 'mw_los_check',            'MW LOS Check',                    'list', false, false, false, '["Pass", "Fail"]'::jsonb, false, 'Survey', 60),
  ('acquisition', 'test_pit_result',         'Test Pit Result',                 'list', false, false, false, NULL, false, 'Survey', 70),
  ('acquisition', 'tss_date',                'TSS Date',                        'date', false, true,  false, NULL, false, 'Survey', 80),
  ('acquisition', 'selected',                'Selected',                        'list', false, false, false, '["Yes", "No"]'::jsonb, true, 'Selection', 90),
  ('acquisition', 'selection_date',          'Selection Date',                  'date', false, true,  false, NULL, true,  'Selection', 100),
  ('acquisition', 'owner_landlord',          'Owner / Landlord',                'text', false, false, false, NULL, false, 'Owner and contact', 110),
  ('acquisition', 'ownership_type',          'Ownership Type',                  'list', false, false, false, NULL, false, 'Owner and contact', 120),
  ('acquisition', 'contact_person',          'Contact Person',                  'text', false, false, false, NULL, false, 'Owner and contact', 130),
  ('acquisition', 'phone',                   'Phone',                           'text', false, false, false, NULL, false, 'Owner and contact', 140),
  ('acquisition', 'email',                   'E-mail',                          'text', false, false, false, NULL, false, 'Owner and contact', 150),
  ('acquisition', 'negotiation_start_date',  'Negotiation Start Date',          'date', false, true,  false, NULL, false, 'Contract and lease', 160),
  ('acquisition', 'contract_no',             'Contract No.',                    'text', false, false, false, NULL, false, 'Contract and lease', 170),
  ('acquisition', 'contract_signoff_date',   'Contract Sign-off Date',          'date', false, true,  false, NULL, true,  'Contract and lease', 180),
  ('acquisition', 'lease_expiry_date',       'Lease Expiry Date',               'date', false, false, false, NULL, true,  'Contract and lease', 190),
  ('acquisition', 'title_verified',          'Title Verified',                  'list', false, false, false, '["Yes", "No"]'::jsonb, false, 'Contract and lease', 200),
  ('acquisition', 'lease_termination_notice_date','Lease Termination Notice Date','date', false, true, false, NULL, false, 'Contract and lease', 210),
  ('acquisition', 'site_handback_date',      'Site Handback Date (Restored)',   'date', false, true,  false, NULL, false, 'Contract and lease', 220),
  ('acquisition', 'remark',                  'Remark',                          'text', false, false, false, NULL, false, 'Remark', 230)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The rules of the spec (Validation sections), checked at submit beside the 0019 rules. Returns an array of field errors.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION reg_validate(uuid) RENAME TO reg_validate_core;

CREATE OR REPLACE FUNCTION reg_validate_catalog(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.register_records%ROWTYPE; d jsonb; errs jsonb := '[]'::jsonb; k text; own_fields text[]; num numeric; other uuid; sc text;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  d := r.data;

  IF r.register_key = 'contractors' THEN
    IF r.record_type IS NULL THEN
      errs := errs || public.reg_err_item('/record_type', 'required', 'The kind (company or team) is required.');
    ELSE
      own_fields := CASE r.record_type WHEN 'company' THEN ARRAY['contractor_name', 'company_type', 'contract_ref', 'contract_start', 'contract_end', 'company_status']
                                       ELSE ARRAY['team_name', 'team_type', 'contractor', 'specialization', 'team_status'] END;
      FOR k IN SELECT jsonb_object_keys(d) LOOP
        IF NOT (k = ANY (own_fields)) THEN errs := errs || public.reg_err_item('/data/' || k, 'not_applicable', 'This field does not belong to a ' || r.record_type || '.'); END IF;
      END LOOP;
      IF r.record_type = 'company' THEN
        IF NOT (d ? 'contractor_name') THEN errs := errs || public.reg_err_item('/data/contractor_name', 'required', 'The company name is required.'); END IF;
        IF d ? 'contract_end' AND NOT (d ? 'contract_start') THEN errs := errs || public.reg_err_item('/data/contract_start', 'missing_start', 'Missing start (DQ21).'); END IF;
        IF d ? 'contract_start' AND d ? 'contract_end' AND (d ->> 'contract_end')::date < (d ->> 'contract_start')::date THEN
          errs := errs || public.reg_err_item('/data/contract_end', 'date_error', 'The contract end is before its start.');
        END IF;
        -- one contract per company (D26 simplification 1): the company name is unique
        SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'contractors' AND x.record_type = 'company' AND x.entity_id <> r.entity_id AND x.state <> 'voided'
          AND lower(x.data ->> 'contractor_name') = lower(d ->> 'contractor_name') LIMIT 1;
        IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/contractor_name', 'duplicate', 'This company is registered already.'); END IF;
      ELSE
        IF NOT (d ? 'team_name') THEN errs := errs || public.reg_err_item('/data/team_name', 'required', 'The team name is required.'); END IF;
        IF NOT (d ? 'contractor') THEN errs := errs || public.reg_err_item('/data/contractor', 'required', 'The team needs its contractor.');
        ELSIF NOT EXISTS (SELECT 1 FROM public.register_records c WHERE c.register_key = 'contractors' AND c.record_type = 'company' AND c.is_current AND lower(c.data ->> 'contractor_name') = lower(d ->> 'contractor'))
              AND NOT EXISTS (SELECT 1 FROM public.external_parties p WHERE lower(p.name) = lower(d ->> 'contractor')) THEN
          errs := errs || public.reg_err_item('/data/contractor', 'unknown_contractor', 'The contractor of a team must exist (DQ21): register and approve the company first.');
        END IF;
        SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'contractors' AND x.record_type = 'team' AND x.entity_id <> r.entity_id AND x.state <> 'voided'
          AND lower(x.data ->> 'team_name') = lower(d ->> 'team_name') AND lower(x.data ->> 'contractor') = lower(d ->> 'contractor') LIMIT 1;
        IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/team_name', 'duplicate', 'This contractor has a team of that name already.'); END IF;
      END IF;
    END IF;

  ELSIF r.register_key = 'quality' THEN
    IF r.record_type IS NULL THEN errs := errs || public.reg_err_item('/record_type', 'required', 'The record type (qc, snag, itp, ncr) is required.'); END IF;
    SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'quality' AND x.entity_id <> r.entity_id AND x.state <> 'voided' AND x.data ->> 'record_code' = d ->> 'record_code' LIMIT 1;
    IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/record_code', 'duplicate', 'This Record ID exists already.'); END IF;   -- ASSUMPTION: unique (the Master does not check)
    IF r.record_type = 'snag' AND NOT (d ? 'severity') THEN errs := errs || public.reg_err_item('/data/severity', 'required', 'A snag needs a severity.'); END IF;
    IF lower(coalesce(d ->> 'result', '')) = 'n/a' AND btrim(coalesce(d ->> 'na_reason', '')) = '' THEN errs := errs || public.reg_err_item('/data/na_reason', 'required', 'N/A needs a reason (V5, D36).'); END IF;
    IF lower(coalesce(d ->> 'result', '')) <> 'n/a' AND d ? 'na_reason' THEN errs := errs || public.reg_err_item('/data/na_reason', 'not_applicable', 'An N/A reason belongs to result N/A only.'); END IF;
    IF d ? 'raised_date' AND d ? 'closed_date' AND (d ->> 'closed_date')::date < (d ->> 'raised_date')::date THEN errs := errs || public.reg_err_item('/data/closed_date', 'before_raised', 'The closing date is before the raised date.'); END IF;

  ELSIF r.register_key = 'issues' THEN
    IF NOT (d ? 'owner_user') AND r.external_party_id IS NULL THEN errs := errs || public.reg_err_item('/data/owner_user', 'required', 'The issue needs an owner: an Aljeel person or an external party (Q70).'); END IF;
    IF d ? 'raised_date' AND d ? 'resolution_date' AND (d ->> 'resolution_date')::date < (d ->> 'raised_date')::date THEN errs := errs || public.reg_err_item('/data/resolution_date', 'before_raised', 'The resolution date is before the raised date.'); END IF;

  ELSIF r.register_key = 'risks' THEN
    SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'risks' AND x.entity_id <> r.entity_id AND x.state <> 'voided' AND lower(x.data ->> 'risk_id') = lower(d ->> 'risk_id') LIMIT 1;
    IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/risk_id', 'duplicate', 'This Risk ID exists already (DQ25).'); END IF;
    FOREACH k IN ARRAY ARRAY['probability', 'impact'] LOOP
      IF d ? k THEN
        num := (d ->> k)::numeric;
        IF num < 1 OR num > 5 OR num <> trunc(num) THEN errs := errs || public.reg_err_item('/data/' || k, 'out_of_range', 'A whole number from 1 to 5.'); END IF;
      END IF;
    END LOOP;
    IF d ? 'last_review_date' AND d ? 'next_review_date' AND (d ->> 'next_review_date')::date < (d ->> 'last_review_date')::date THEN
      errs := errs || public.reg_err_item('/data/next_review_date', 'before_last_review', 'The next review is before the last review.');
    END IF;

  ELSIF r.register_key = 'change_control' THEN
    SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'change_control' AND x.entity_id <> r.entity_id AND x.state <> 'voided' AND lower(x.data ->> 'change_id') = lower(d ->> 'change_id') LIMIT 1;
    IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/change_id', 'duplicate', 'This Change ID exists already.'); END IF;
    IF d ->> 'change_type' IN ('Scope Change', 'Data Correction') THEN
      FOREACH k IN ARRAY ARRAY['field_item', 'old_value', 'new_value'] LOOP
        IF NOT (d ? k) THEN errs := errs || public.reg_err_item('/data/' || k, 'required', 'A scope change or data correction needs the field, the old value and the new value.'); END IF;
      END LOOP;
    END IF;
    -- ASSUMPTION (spec 3.10): a Resumption needs an earlier approved Suspension of the same site
    IF d ->> 'change_type' = 'Resumption' AND NOT EXISTS (
         SELECT 1 FROM public.register_records s WHERE s.register_key = 'change_control' AND s.site_id = r.site_id AND s.is_current AND s.data ->> 'change_type' = 'Suspension') THEN
      errs := errs || public.reg_err_item('/data/change_type', 'no_suspension', 'A resumption needs an approved suspension of the site.');
    END IF;

  ELSIF r.register_key = 'readiness_handover' THEN
    IF lower(coalesce(d ->> 'om_checklist', '')) = 'n/a' AND btrim(coalesce(d ->> 'na_reason', '')) = '' THEN errs := errs || public.reg_err_item('/data/na_reason', 'required', 'N/A needs a reason (DQ17).'); END IF;
    IF lower(coalesce(d ->> 'om_checklist', '')) <> 'n/a' AND d ? 'na_reason' THEN errs := errs || public.reg_err_item('/data/na_reason', 'not_applicable', 'An N/A reason belongs to checklist N/A only.'); END IF;

  ELSIF r.register_key = 'rf_design' THEN
    FOREACH k IN ARRAY ARRAY['latitude', 'nominal_latitude'] LOOP
      IF d ? k AND ((d ->> k)::numeric < -90 OR (d ->> k)::numeric > 90) THEN errs := errs || public.reg_err_item('/data/' || k, 'out_of_range', 'Latitude is between -90 and 90.'); END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY['longitude', 'nominal_longitude'] LOOP
      IF d ? k AND ((d ->> k)::numeric < -180 OR (d ->> k)::numeric > 180) THEN errs := errs || public.reg_err_item('/data/' || k, 'out_of_range', 'Longitude is between -180 and 180.'); END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY['tower_height', 'search_ring_radius', 'antenna_height', 'building_height', 'sectors', 'tssr_rev_no'] LOOP
      IF d ? k AND (d ->> k)::numeric < 0 THEN errs := errs || public.reg_err_item('/data/' || k, 'negative', 'Not below zero.'); END IF;
    END LOOP;
    IF d ? 'tssr_submitted' AND d ? 'tssr_approved' AND (d ->> 'tssr_approved')::date < (d ->> 'tssr_submitted')::date THEN
      errs := errs || public.reg_err_item('/data/tssr_approved', 'negative_duration', 'TSSR Approved is before TSSR Submitted (DQ10).');
    END IF;
    IF d ? 'mw_far_end_site' AND upper(d ->> 'mw_far_end_site') <> 'N/A' THEN
      SELECT s.site_code INTO sc FROM public.sites s WHERE s.id = r.site_id;
      IF sc IS NOT DISTINCT FROM (d ->> 'mw_far_end_site') THEN errs := errs || public.reg_err_item('/data/mw_far_end_site', 'self_link', 'The far-end must be another site (DQ04).');
      ELSIF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.site_code = d ->> 'mw_far_end_site') THEN errs := errs || public.reg_err_item('/data/mw_far_end_site', 'unknown_site', 'The far-end must be an existing site or N/A (DQ04).'); END IF;
    END IF;

  ELSIF r.register_key = 'acquisition' THEN
    SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'acquisition' AND x.site_id = r.site_id AND x.entity_id <> r.entity_id AND x.state <> 'voided'
      AND x.data ->> 'candidate' = d ->> 'candidate' LIMIT 1;
    IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/candidate', 'duplicate', 'This site has a record for that candidate already.'); END IF;
    IF d ->> 'selected' = 'Yes' THEN
      IF NOT (d ? 'selection_date') THEN errs := errs || public.reg_err_item('/data/selection_date', 'required', 'A selected candidate needs a Selection Date.'); END IF;
      SELECT x.id INTO other FROM public.register_records x WHERE x.register_key = 'acquisition' AND x.site_id = r.site_id AND x.entity_id <> r.entity_id AND x.state <> 'voided' AND x.data ->> 'selected' = 'Yes' LIMIT 1;
      IF other IS NOT NULL THEN errs := errs || public.reg_err_item('/data/selected', 'second_selected', 'Another candidate of this site is selected already (DQ05).'); END IF;
    ELSIF d ? 'contract_signoff_date' THEN
      errs := errs || public.reg_err_item('/data/contract_signoff_date', 'not_selected', 'A contract sign-off needs the candidate to be Selected = Yes (D35).');
    END IF;
  END IF;
  RETURN errs;
END $$;

CREATE OR REPLACE FUNCTION reg_validate(p_record uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.reg_validate_core(p_record) || public.reg_validate_catalog(p_record)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. After the final approval: the approver fields of Q45 and the Contractors projection
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog_on_approved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := NEW.data; party uuid; ptype text; active boolean;
BEGIN
  -- Q45: the approver and the approval date come from this approval, never typed
  IF NEW.register_key = 'change_control' THEN
    UPDATE public.register_records SET data = data || jsonb_build_object('approval', 'Approved', 'approved_by', NEW.approved_by::text, 'approval_date', current_date::text) WHERE id = NEW.id;
  ELSIF NEW.register_key = 'quality' THEN
    UPDATE public.register_records SET data = data || jsonb_build_object('approved_by', NEW.approved_by::text)
      || CASE WHEN lower(coalesce(d ->> 'result', '')) = 'n/a' THEN jsonb_build_object('na_approved_by', NEW.approved_by::text) ELSE '{}'::jsonb END WHERE id = NEW.id;
  ELSIF NEW.register_key = 'readiness_handover' AND lower(coalesce(d ->> 'om_checklist', '')) = 'n/a' THEN
    UPDATE public.register_records SET data = data || jsonb_build_object('na_approved_by', NEW.approved_by::text) WHERE id = NEW.id;
  ELSIF NEW.register_key = 'contractors' THEN
    -- the approved companies and teams are the external parties and teams that Procurement picks (id = the logical record)
    IF NEW.record_type = 'company' THEN
      ptype := lower(regexp_replace(coalesce(d ->> 'company_type', ''), '[^A-Za-z]+', '_', 'g'));
      IF ptype NOT IN ('cw_contractor', 'te_vendor', 'gecol', 'hlc', 'supplier', 'landlord') THEN ptype := 'other'; END IF;
      active := lower(coalesce(d ->> 'company_status', 'active')) NOT IN ('inactive', 'terminated', 'expired', 'closed');
      INSERT INTO public.external_parties (id, name, type, company_type, contract_ref, contract_start, contract_end, is_active)
      VALUES (NEW.entity_id, d ->> 'contractor_name', ptype::"ExternalPartyType", d ->> 'company_type', d ->> 'contract_ref', (d ->> 'contract_start')::date, (d ->> 'contract_end')::date, active)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, company_type = EXCLUDED.company_type, contract_ref = EXCLUDED.contract_ref,
        contract_start = EXCLUDED.contract_start, contract_end = EXCLUDED.contract_end, is_active = EXCLUDED.is_active;
    ELSIF NEW.record_type = 'team' THEN
      SELECT p.id INTO party FROM public.external_parties p WHERE lower(p.name) = lower(d ->> 'contractor') ORDER BY p.is_active DESC LIMIT 1;
      IF party IS NOT NULL THEN
        active := lower(coalesce(d ->> 'team_status', 'active')) NOT IN ('inactive', 'closed');
        INSERT INTO public.external_teams (id, party_id, name, team_type, specialization, is_active)
        VALUES (NEW.entity_id, party, d ->> 'team_name', d ->> 'team_type', d ->> 'specialization', active)
        ON CONFLICT (id) DO UPDATE SET party_id = EXCLUDED.party_id, name = EXCLUDED.name, team_type = EXCLUDED.team_type, specialization = EXCLUDED.specialization, is_active = EXCLUDED.is_active;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER z_catalog_on_approved AFTER UPDATE OF state ON register_records
  FOR EACH ROW WHEN (NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved' AND NEW.register_key IN ('change_control', 'quality', 'readiness_handover', 'contractors'))
  EXECUTE FUNCTION catalog_on_approved();

-- The projection writes the shared master data; the definer needs the rights (0019 gave it SELECT only).
GRANT INSERT, UPDATE ON external_parties, external_teams TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION reg_validate_core(uuid) OWNER TO pmis_definer;
ALTER FUNCTION reg_validate_catalog(uuid) OWNER TO pmis_definer;
ALTER FUNCTION reg_validate(uuid) OWNER TO pmis_definer;
ALTER FUNCTION catalog_on_approved() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION reg_validate_core(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reg_validate_catalog(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reg_validate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog_on_approved() FROM PUBLIC;
