-- P4b (migration 0061): contractors, contracts and the team / scope match (owner answers Q110, Q142 to Q147 of 2026-11-04, decision D145b).
-- The application role reads the catalogue, the allowed groups, the team specializations, the contracts, the type map and the contractor rules, and
-- writes none of them: the writers are admin_save_team_scope_match, admin_save_contractor_rules (System Admin or a delegation of admin.settings edit
-- for all regions, a reason, the version, a fresh step-up when eligibility changes, audited) and the approval of a Contractors record. The parties and
-- teams are the projection of approved Contractors records only. The submit checks and the sent alerts are internal.
-- Alice holds one CW entry assignment (module sites): no Settings, no Contractors, no Procurement right.

-- @case P4B-01
-- @title Alice adds a specialization of her own to the catalogue
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO team_specializations (code, label_en, func_groups) VALUES ('ANYTHING', 'Anything', ARRAY['CW']);
-- @end

-- @case P4B-02
-- @title Alice gives her team every specialization directly
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO external_team_specializations (team_id, code) SELECT t.id, s.code FROM external_teams t CROSS JOIN team_specializations s;
-- @end

-- @case P4B-03
-- @title Alice lets the TE Installation scope accept every CW-group team
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO team_scope_match_groups (scope, func_group) VALUES ('TE Installation', 'CW');
-- @end

-- @case P4B-04
-- @title Alice extends an expired contract so its company is eligible again
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE external_party_contracts SET end_date = DATE '2035-12-31', status = 'active', scopes = NULL;
-- @end

-- @case P4B-05
-- @title Alice plants a contract covering every scope for a company of her choosing
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO external_party_contracts (id, party_id, contract_ref, scopes, status, origin) SELECT gen_random_uuid(), p.id, 'FORGED', NULL, 'active', 'contract' FROM external_parties p;
-- @end

-- @case P4B-06
-- @title Alice plants an external party without a Contractors record (the projection is the only writer)
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO external_parties (name, type) VALUES ('Forged Contractor', 'cw_contractor');
-- @end

-- @case P4B-07
-- @title Alice clears the safety certificate date of every team so no alert is sent
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE external_teams SET safety_cert_expiry = NULL, lead_user_id = NULL;
-- @end

-- @case P4B-08
-- @title Alice maps an unknown company type to cw_contractor so no review alert is raised
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO external_party_type_map (source, party_type) VALUES ('anything', 'cw_contractor');
-- @end

-- @case P4B-09
-- @title Alice turns the CW Delivery Model off by emptying its scopes in the rules row
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE contractor_rules SET cw_delivery_scopes = ARRAY[]::text[], safety_cert_lead_days = 0;
-- @end

-- @case P4B-10
-- @title Alice reads the internal record of the submit checks
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM team_scope_checks;
-- @end

-- @case P4B-11
-- @title Alice deletes the sent-alert bookkeeping so every alert is sent again
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM contractor_alerts_sent;
-- @end

-- @case P4B-12
-- @title Alice, who has no Settings right, saves the contractor rules through the admin function
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 delegation covering admin.settings.edit required
SELECT admin_save_contractor_rules('{"safety_cert_lead_days": 0, "recipient_roles": [], "cw_delivery_scopes": [], "internal_team_types": [], "closed_order_statuses": []}'::jsonb, 'Forged by SQL', NULL);
-- @end

-- @case P4B-13
-- @title The System Admin narrows the CW Delivery Model scopes without a fresh step-up (Q147): refused
-- @category p4b-contractors
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT admin_save_contractor_rules('{"safety_cert_lead_days": 30, "recipient_roles": ["PROC_TEAM"], "cw_delivery_scopes": ["CW"], "internal_team_types": ["Internal", "In-House"], "closed_order_statuses": ["Closed"]}'::jsonb, 'No step-up', NULL);
-- @end

-- @case P4B-14
-- @title The System Admin changes who may take CW orders without a fresh step-up (Q147): refused
-- @category p4b-contractors
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT admin_save_team_scope_match(jsonb_set(team_scope_match_json() - 'groups' - 'catalogue' - 'version' - 'updated_at' - 'updated_by', '{scopes,0,allowed_groups}', '[]'::jsonb), 'No step-up', NULL);
-- @end

-- @case P4B-15
-- @title Alice calls the internal contract check of the Procurement trigger
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT party_contract_for(gen_random_uuid(), 'CW', current_date);
-- @end

-- @case P4B-16
-- @title Alice, who has no Contractors right, reads the completeness report
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect error 42501 contractors view required
SELECT contractors_completeness_report();
-- @end

-- @case P4B-17
-- @title Alice, who has no Procurement right, reads the mismatch report: no order of any region is shown
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT jsonb_array_length(team_scope_mismatch_report() -> 'items');
-- @end

-- @case P4B-18
-- @title Alice reads the specialization catalogue (read-only for everyone signed in)
-- @category p4b-contractors
-- @actor ALICE
-- @region 1
-- @expect output >= 8
SELECT count(*) FROM team_specializations WHERE is_active;
-- @end
