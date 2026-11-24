-- Project data reset in Settings (migration 0146, contract 0.15.62): the most destructive function of the system. The plan, the deletes and the checks live in
-- data_reset_core (owner pmis_reset_owner, executed only by pmis_definer and the superuser); the doors admin_data_reset_* (owner pmis_definer) need a System
-- Admin acting without delegation, in a live session of their own, with a step-up; four eyes are checked in the database. pmis_app has no right on
-- data_reset_requests, data_reset_request_files and data_reset_marker (the marker that lets the reset role through the delete guards). The System Log source
-- backup (the backup precondition) is never written by pmis_app. Alice: CW Team Lead in Tripoli, not a System Admin. DEL_ALL: a delegate of the System Admin.
-- ADMIN: the System Admin (the fixtures have no signed-in session for it, so every door stops at the session check). Each case is rolled back.

-- @case DR-01
-- @title The System Admin reads the reset requests directly
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT count(*) FROM data_reset_requests;
-- @end

-- @case DR-02
-- @title The System Admin inserts an approved request directly (four eyes skipped)
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO data_reset_requests (status, database_name, requested_by, requested_session, request_reason, expires_at, approved_by)
VALUES ('approved', current_database(), '{{ADMIN}}', gen_random_uuid(), 'Forged approved request', now() + interval '1 hour', '{{ALICE}}');
-- @end

-- @case DR-03
-- @title Alice writes the reset marker to open the delete guards for herself
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO data_reset_marker (txid) VALUES (txid_current());
-- @end

-- @case DR-04
-- @title The System Admin deletes stored document files directly
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM document_files;
-- @end

-- @case DR-05
-- @title The System Admin calls the reset core directly (no request, no second admin, no backup check)
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT data_reset_core(true, 'Reset without the doors', '{}'::jsonb, NULL, NULL);
-- @end

-- @case DR-06
-- @title The System Admin calls the internal delete helper of the reset role
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT data_reset_delete_unkept('register_records');
-- @end

-- @case DR-07
-- @title Alice requests the reset with a forged all-regions setting
-- @category settings-data-reset
-- @actor ALICE
-- @region *
-- @expect error P0001 wf:data_reset.*action_forbidden
SELECT admin_data_reset_request('A forged request of Alice', 'RESET ' || current_database());
-- @end

-- @case DR-08
-- @title A delegate of the System Admin (all regions) requests the reset
-- @category settings-data-reset
-- @actor DEL_ALL
-- @region *
-- @expect error P0001 wf:data_reset.*(action_forbidden|delegate_forbidden)
SELECT admin_data_reset_request('A delegate asks for the reset', 'RESET ' || current_database());
-- @end

-- @case DR-09
-- @title The System Admin with a step-up but without a live session of their own requests the reset (a context naming a session that does not exist)
-- @category settings-data-reset
-- @expect error P0001 wf:data_reset.*signed-in session
\ctx ADMIN stepup=300 session=00000000-0000-4000-8000-00000000dead
SELECT admin_data_reset_request('A request with a forged session id', 'RESET ' || current_database());
-- @end

-- @case DR-10
-- @title Alice reads the state of the reset (plan, backup, requests)
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:data_reset.*action_forbidden
SELECT data_reset_state_json();
-- @end

-- @case DR-11
-- @title Alice approves, starts, runs or records files of a request by id
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:data_reset.*action_forbidden
SELECT admin_data_reset_approve(gen_random_uuid(), 'Alice approves a reset', 1),
       admin_data_reset_start(gen_random_uuid(), 'RESET ' || current_database(), 1, '/tmp/x'),
       admin_data_reset_execute(gen_random_uuid()),
       admin_data_reset_files_record(gen_random_uuid(), '[]'::jsonb);
-- @end

-- @case DR-12
-- @title pmis_app writes a successful backup into the System Log (the backup precondition of the run)
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 backup scripts only
SELECT log_system_write('info', 'backup', 'Database backup completed', '{"script":"db-backup","event":"backup_ok","type":"full","repos":"1"}'::jsonb, NULL, NULL);
-- @end

-- @case DR-13
-- @title The System Admin widens the backup window or the request expiry directly in the settings table
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = '{"request_expiry_minutes": 240, "backup_max_age_hours": 10000, "version": 99}'::jsonb WHERE key = 'data_reset.settings';
-- @end

-- @case DR-14
-- @title The System Admin calls the internal helpers (the actor check, the audit writer, the request lock)
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT data_reset_require_admin(false), data_reset_log('data_reset_request', gen_random_uuid(), NULL, NULL, 'forged'), data_reset_lock_request(gen_random_uuid(), NULL);
-- @end

-- @case DR-15
-- @title Control: outside a running reset the delete guards stay shut (data_reset_deleting is false) and no reset is running
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect output f|f
SELECT concat_ws('|', data_reset_deleting(), data_reset_maintenance());
-- @end

-- @case DR-16
-- @title Control: the shape of the functions (owners, SECURITY DEFINER, search_path ending in pg_temp, PUBLIC revoked), the doors of pmis_app, no table right of pmis_app (0152: two data_reset_core, the scope doors)
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect output 4|30|12|0|0
SELECT concat_ws('|',
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('data_reset_core', 'data_reset_delete_unkept', 'data_reset_deleting')
     AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_reset_owner' AND p.proconfig::text LIKE '%pg_temp%'),
  (SELECT count(*) FROM pg_proc p WHERE p.proname LIKE ANY (ARRAY['data_reset\_%', 'admin_data_reset\_%', 'admin_set_data_reset_settings'])
     AND p.proname NOT IN ('data_reset_core', 'data_reset_delete_unkept', 'data_reset_deleting', 'data_reset_plan', 'data_reset_rows_guard', 'data_reset_no_truncate')
     AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'pmis_definer' AND p.proconfig::text LIKE '%pg_temp%' AND NOT has_function_privilege('public', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('data_reset_maintenance', 'data_reset_state_json', 'data_reset_request_get', 'admin_data_reset_request',
       'admin_data_reset_approve', 'admin_data_reset_cancel', 'admin_data_reset_start', 'admin_data_reset_execute', 'admin_data_reset_fail',
       'admin_data_reset_files_claim', 'admin_data_reset_files_record', 'admin_set_data_reset_settings')
     AND has_function_privilege('pmis_app', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('data_reset_core', 'data_reset_delete_unkept', 'data_reset_plan', 'data_reset_require_admin', 'data_reset_log',
       'data_reset_lock_request', 'data_reset_backup', 'data_reset_err') AND has_function_privilege('pmis_app', p.oid, 'EXECUTE')),
  (SELECT count(*) FROM information_schema.table_privileges WHERE grantee = 'pmis_app'
     AND table_name IN ('data_reset_requests', 'data_reset_request_files', 'data_reset_marker')));
-- @end

-- Migration 0152 (contract 0.15.71): the selectable reset. The closure of the chosen parts is computed by the database; the scoped core and the identity
-- writes (deactivating accounts, removing assignments, groups and delegations) are never callable by pmis_app.

-- @case DR-17
-- @title The System Admin calls the scoped reset core directly with one part (no request, no second admin, no backup check)
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT data_reset_core(true, 'Reset of one part without the doors', '{}'::jsonb, NULL, NULL, ARRAY['issues'], NULL);
-- @end

-- @case DR-18
-- @title The System Admin calls the identity writes of the reset directly to deactivate every account, admins included
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function
SELECT idm_data_reset_identity(ARRAY['users', 'roles'], NULL);
-- @end

-- @case DR-19
-- @title Alice calls the identity writes of the reset to empty the System Admins group
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT idm_data_reset_identity(ARRAY['roles'], ARRAY['{{ALICE}}'::uuid]);
-- @end

-- @case DR-20
-- @title A client-supplied scope cannot skip dependents: choosing the sites takes every site-scoped part along
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect output acquisition,as_built,car_dispatcher,change_control,daily_plan,deliverables,dismantle,documents,financial_advances,gecol,hlc,imports,issues,kpi,meetings,permits,procurement,quality,readiness,rf_design,risks,sites,warehouse
SELECT array_to_string(data_reset_closure(ARRAY['sites']), ',');
-- @end

-- @case DR-21
-- @title A client-supplied scope cannot skip dependents: procurement takes the bookings and the advances along; the identity parts stay out of everything
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect output car_dispatcher,financial_advances,procurement|false
SELECT array_to_string(data_reset_closure(ARRAY['procurement']), ',') || '|' || (data_reset_closure(NULL) && ARRAY['users', 'roles', 'staff'])::text;
-- @end

-- @case DR-22
-- @title An unknown part code is refused by the closure
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect error 22023 unknown part
SELECT data_reset_closure(ARRAY['sites', 'audit_log']);
-- @end

-- @case DR-23
-- @title Alice runs the dry run of a scope (the counts are for System Admins only)
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:data_reset.*action_forbidden
SELECT data_reset_dry_run(ARRAY['users']);
-- @end

-- @case DR-24
-- @title A delegate of the System Admin (all regions) requests a scoped reset of the users, or approves with a scope hash
-- @category settings-data-reset
-- @actor DEL_ALL
-- @region *
-- @expect error P0001 wf:data_reset.*(action_forbidden|delegate_forbidden)
SELECT admin_data_reset_request('A delegate asks to deactivate everyone', 'RESET ' || current_database(), ARRAY['users']),
       admin_data_reset_approve(gen_random_uuid(), 'A delegate approves a scope', 1, repeat('a', 64));
-- @end

-- @case DR-25
-- @title The System Admin rewrites the scope or the approved hash of a request directly (an approval of a changed scope)
-- @category settings-data-reset
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE data_reset_requests SET requested_parts = ARRAY['users'], scope_hash = repeat('b', 64), approved_scope_hash = repeat('b', 64);
-- @end

-- @case DR-26
-- @title Control: the scoped core and the identity writes have the right owners and callers (reset role and identity owner only), the guard of an approved scope is in place
-- @category settings-data-reset
-- @actor ALICE
-- @region 1
-- @expect output t|t|f|f|t|3
SELECT concat_ws('|',
  (SELECT pg_get_userbyid(p.proowner) = 'pmis_identity_owner' AND p.prosecdef AND p.proconfig::text LIKE '%pg_temp%' FROM pg_proc p WHERE p.proname = 'idm_data_reset_identity'),
  (SELECT has_function_privilege('pmis_reset_owner', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.proname = 'idm_data_reset_identity'),
  (SELECT has_function_privilege('pmis_definer', p.oid, 'EXECUTE') OR has_function_privilege('pmis_app', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.proname = 'idm_data_reset_identity'),
  (SELECT bool_or(has_function_privilege('pmis_app', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.proname IN ('data_reset_core', 'data_reset_user_kept', 'data_reset_group_kept', 'data_reset_check_scope', 'data_reset_plan_json')),
  (SELECT has_function_privilege('pmis_app', 'data_reset_dry_run(text[])', 'EXECUTE')),
  (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'data_reset_requests'::regclass AND c.conname IN ('data_reset_scope_shape', 'data_reset_scope_bound', 'data_reset_scope_approved')));
-- @end
