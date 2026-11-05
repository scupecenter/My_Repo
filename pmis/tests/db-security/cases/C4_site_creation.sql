-- Site creation (migration 0070, G1 / Q460; contract 0.14.0). A site is created only by site_create_apply, when L2 approves, through the site_draft_* and
-- imp_*_site_batch functions (owner pmis_definer). The application role cannot insert sites or tasks, cannot write the drafts, and cannot call the
-- internal writers; the functions it may call refuse without the grid right, the Matrix holder and the step-up, and none of them reads a plain session setting.
-- The Matrix row `site_creation` is seeded to the System Admins group (the fixtures create the group with idm_bootstrap_admin, so the trigger of 0070 seeds it).
-- Alice: CW Team Lead in Tripoli, no `sites` create right. The System Admin holds L1 and L2 of the row (the group), so his own submission is a self-approval (B5).

-- ---------------------------------------------------------------------------------------------------------------------
-- Positive controls (they commit; the later cases use the drafts)
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SC-01
-- @title The System Admin proposes a site in Tripoli: a draft in entry, not a site
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect ok
SELECT 1 / (CASE WHEN site_draft_create('{"site_code":"SECSC001","region_id":1,"name":"Sec site Tripoli","delivery_scenario":"new_build"}'::jsonb) ->> 'status' = 'entry'
                  AND NOT EXISTS (SELECT 1 FROM sites WHERE site_code = 'SECSC001') THEN 1 ELSE 0 END);
-- @end

-- @case SC-02
-- @title The System Admin proposes a second site, in Benghazi
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect ok
SELECT 1 / (CASE WHEN site_draft_create('{"site_code":"SECSC002","region":"Benghazi Area","name":"Sec site Benghazi","delivery_scenario":"Expansion"}'::jsonb) ->> 'status' = 'entry' THEN 1 ELSE 0 END);
-- @end

-- @case SC-03
-- @title The Matrix row Site creation has an L1 and an L2 cell, seeded to the System Admins group
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect output 2
SELECT count(*) FROM matrix_cells c JOIN matrix_cell_assignees a ON a.cell_id = c.id AND a.kind = 'group' AND a.ref_id = '{{SYSADMINS}}'
WHERE c.register_key = 'site_creation' AND c.region_id IS NULL AND c.level IN (1, 3);
-- @end

-- @case SC-04
-- @title Alice reads the draft of her own region and not the one of Benghazi (row-level security)
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect output 1
SELECT count(*) FROM site_drafts WHERE site_code LIKE 'SECSC%';
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The application role cannot create sites, tasks or drafts directly
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SC-10
-- @title Alice inserts a site directly
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO sites (site_code, name, region_id, workflow_version_id, updated_at)
SELECT 'SECFORGED1', 'Forged site', 1, id, now() FROM workflow_definitions WHERE id = active_workflow_id();
-- @end

-- @case SC-11
-- @title The System Admin inserts a site directly (an admin has no direct path either)
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO sites (site_code, name, region_id, workflow_version_id, updated_at)
SELECT 'SECFORGED2', 'Forged site', 1, id, now() FROM workflow_definitions WHERE id = active_workflow_id();
-- @end

-- @case SC-12
-- @title Alice inserts a task instance directly
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO task_instances (site_id, region_id, task_def_id, state, levels_required, updated_at)
SELECT s.id, s.region_id, (SELECT id FROM task_definitions WHERE workflow_id = s.workflow_version_id AND code = 'A1'), 'open', 2, now() FROM sites s WHERE s.region_id = 1 LIMIT 1;
-- @end

-- @case SC-13
-- @title Alice deletes a site
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM sites WHERE region_id = 1;
-- @end

-- @case SC-14
-- @title Alice writes a site draft directly (insert, update, delete)
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE site_drafts SET status = 'approved', decided_by = '{{ALICE}}' WHERE site_code = 'SECSC001';
-- @end

-- @case SC-15
-- @title Alice inserts a draft of her own
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO site_drafts (site_code, region_id, data, created_by) VALUES ('SECFORGED3', 1, '{}', '{{ALICE}}');
-- @end

-- @case SC-16
-- @title Alice adds a known header alias for the legacy Master import
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO master_header_aliases (letter, alias) VALUES ('B', 'Any other name');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The internal writers and checks are not callable by the application role
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SC-20
-- @title Alice calls the one writer of a site, site_create_apply, for a draft
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT site_create_apply(id, false) FROM site_drafts WHERE site_code = 'SECSC001';
-- @end

-- @case SC-21
-- @title The System Admin calls site_create_apply directly: no path around L1, L2 and the step-up
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT site_create_apply(id, true) FROM site_drafts WHERE site_code = 'SECSC001';
-- @end

-- @case SC-22
-- @title Alice stages, sends and decides a New sites batch through the internal functions
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT imp_decide_site_batch('00000000-0000-4000-8000-0000000b0001', 1, 'approve', 'all', NULL, NULL, true);
-- @end

-- @case SC-23
-- @title Alice calls the site validation function and the applicability wrapper
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT wf_apply_applicability(id) FROM sites LIMIT 1;
-- @end

-- @case SC-24
-- @title Alice runs the Matrix seeding of the site creation row
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT site_creation_seed_cells();
-- @end

-- @case SC-25
-- @title Alice calls the validation function directly (it reads sites of every region)
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT site_new_clean('{"site_code":"X1"}'::jsonb, NULL);
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The functions the application role may call refuse without the rights
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SC-30
-- @title Alice has no create right on sites: site_draft_create refuses (action_forbidden)
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT site_draft_create('{"site_code":"SECSC030","region_id":1,"name":"Alice site","delivery_scenario":"new_build"}'::jsonb);
-- @end

-- @case SC-31
-- @title Alice is not an L1 holder of the Site creation row: she cannot send the System Admin's draft
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_eligible_holder
SELECT site_draft_submit(id, NULL) FROM site_drafts WHERE site_code = 'SECSC001';
-- @end

-- @case SC-32
-- @title Alice is not an L2 holder: she cannot decide a draft either (a draft in entry is not waiting)
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error P0001 invalid_transition
SELECT site_draft_decide(id, NULL, 'approve', NULL) FROM site_drafts WHERE site_code = 'SECSC001';
-- @end

-- @case SC-33
-- @title Alice cannot see a draft of Benghazi: it does not exist for her (not_found)
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT site_draft_discard(id, NULL) FROM site_drafts WHERE site_code = 'SECSC002' UNION ALL SELECT site_draft_discard('00000000-0000-4000-8000-000000000999', NULL) LIMIT 1;
-- @end

-- @case SC-34
-- @title No session at all: nobody creates a draft (no signed-in actor)
-- @category site-creation
-- @expect error 42501 no signed-in actor
SELECT site_draft_create('{"site_code":"SECSC034","region_id":1,"name":"Nobody","delivery_scenario":"new_build"}'::jsonb);
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The context cannot be forged
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SC-40
-- @title With no context, a forged user id of the System Admin and an all-regions setting still create nothing
-- @category site-creation
-- @actor none
-- @region *
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SELECT site_draft_create('{"site_code":"SECSC040","region_id":1,"name":"Forged","delivery_scenario":"new_build"}'::jsonb);
-- @end

-- @case SC-41
-- @title Alice forges app.user_id with the System Admin's id: she stays Alice and is refused
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SELECT site_draft_create('{"site_code":"SECSC041","region_id":1,"name":"Forged","delivery_scenario":"new_build"}'::jsonb);
-- @end

-- @case SC-42
-- @title The System Admin holds L1 and L2: sending his own draft is a self-approval and needs a step-up; a forged step-up setting does not give one
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SET app.stepup = 'true';
SET app.stepup_until = '2999-01-01';
SELECT site_draft_submit(id, NULL) FROM site_drafts WHERE site_code = 'SECSC001';
-- @end

-- @case SC-43
-- @title Sending the Benghazi draft is also a self-approval of the System Admin and needs a step-up
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT site_draft_submit(id, NULL) FROM site_drafts WHERE site_code = 'SECSC002';
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- What the database refuses in the proposal
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SC-50
-- @title A landlord or contact field is not accepted (Q469): those data are not loaded
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT site_draft_create('{"site_code":"SECSC050","region_id":1,"name":"Personal data","delivery_scenario":"new_build","landlord_phone":"+218910000000"}'::jsonb);
-- @end

-- @case SC-51
-- @title A Site ID that a draft or a site holds is refused (never reused)
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT site_draft_create('{"site_code":" secsc001 ","region_id":1,"name":"Again","delivery_scenario":"new_build"}'::jsonb);
-- @end

-- @case SC-52
-- @title An unknown region is refused; an alias is not enough when it names no region
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT site_draft_create('{"site_code":"SECSC052","region":"Atlantis","name":"Nowhere","delivery_scenario":"new_build"}'::jsonb);
-- @end

-- @case SC-53
-- @title A Hot Swap with a scope flag Yes is refused at entry (the scenario rules)
-- @category site-creation
-- @actor ADMIN
-- @region *
-- @expect error P0001 validation_failed
SELECT site_draft_create('{"site_code":"SECSC053","region_id":1,"name":"Swap","delivery_scenario":"Hot Swap","scope_gecol_power":"Yes"}'::jsonb);
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The wrapper that P4a looks for, and the closed hook
-- ---------------------------------------------------------------------------------------------------------------------
-- @case SC-60
-- @title The hook of P4a finds wf_apply_applicability: it exists, owned by pmis_definer, and PUBLIC cannot execute it
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect output pmis_definer|false
SELECT pg_get_userbyid(p.proowner) || '|' || has_function_privilege('pmis_app', p.oid, 'EXECUTE')::text
FROM pg_proc p WHERE p.proname = 'wf_apply_applicability' AND p.pronargs = 1;
-- @end

-- @case SC-61
-- @title Every function of the site creation is SECURITY DEFINER with a fixed search path, owned by pmis_definer
-- @category site-creation
-- @actor ALICE
-- @region 1
-- @expect output 0
SELECT count(*) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND (p.proname LIKE 'site\_draft\_%' OR p.proname LIKE 'site\_new\_%' OR p.proname IN ('site_create_apply', 'wf_apply_applicability', 'imp_stage_site_batch', 'imp_submit_site_batch', 'imp_decide_site_batch',
       'tpl_sites_columns', 'site_creation_seed_cells'))
  AND NOT (p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer'
           AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, public, pg_temp')
           AND NOT has_function_privilege('public', p.oid, 'EXECUTE'));
-- @end
