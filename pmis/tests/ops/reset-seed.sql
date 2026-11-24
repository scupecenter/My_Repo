-- Synthetic data for tests/ops/reset-project-data.test.mjs (fictional names only). Run as the superuser on a scratch database built from every
-- migration, after idm_bootstrap_admin. The project data is loaded with the triggers off (session_replication_role = replica, as
-- apps/api/test/dash-seed.sql does: the calculation layer is not under test); the identifiers are fixed so the test can name them. The audit and
-- security rows at the end are written with the triggers on, so they are sealed on the hash chains like real rows.
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

BEGIN;
SET LOCAL session_replication_role = replica;

CREATE TEMP TABLE ids (name text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO ids VALUES
  ('admin', (SELECT id FROM users WHERE email = 'reset.admin@example.test')),
  ('user2', 'a0000000-0000-4000-8000-000000000002'),
  ('dept', 'a0000000-0000-4000-8000-000000000010'),
  ('group', 'a0000000-0000-4000-8000-000000000011'),
  ('thread', 'a0000000-0000-4000-8000-000000000012'),
  ('wf', (SELECT id FROM workflow_definitions WHERE version = 1)),
  ('party', 'a0000000-0000-4000-8000-000000000020'),
  ('company_e', 'a0000000-0000-4000-8000-000000000021'),
  ('company_r', 'a0000000-0000-4000-8000-000000000022'),
  ('vehicle_e', 'a0000000-0000-4000-8000-000000000023'),
  ('vehicle_r', 'a0000000-0000-4000-8000-000000000024'),
  ('booking_e', 'a0000000-0000-4000-8000-000000000025'),
  ('booking_r', 'a0000000-0000-4000-8000-000000000026'),
  ('proc_e', 'a0000000-0000-4000-8000-000000000027'),
  ('proc_r', 'a0000000-0000-4000-8000-000000000028'),
  ('risk_r', 'a0000000-0000-4000-8000-000000000029'),
  ('adv_r', 'a0000000-0000-4000-8000-00000000002a'),
  ('cluster', 'a0000000-0000-4000-8000-000000000030'),
  ('site1', 'a0000000-0000-4000-8000-000000000031'),
  ('site2', 'a0000000-0000-4000-8000-000000000032'),
  ('baseline', 'a0000000-0000-4000-8000-000000000033'),
  ('cr', 'a0000000-0000-4000-8000-000000000034'),
  ('slot_task', 'a0000000-0000-4000-8000-000000000040'),
  ('slot_company', 'a0000000-0000-4000-8000-000000000041'),
  ('snag', 'a0000000-0000-4000-8000-000000000042'),
  ('kept_batch', 'a0000000-0000-4000-8000-000000000050'),
  ('proj_batch', 'a0000000-0000-4000-8000-000000000051'),
  ('proj_row', 'a0000000-0000-4000-8000-000000000052'),
  ('kept_row', 'a0000000-0000-4000-8000-000000000053'),
  ('draft', 'a0000000-0000-4000-8000-000000000054'),
  ('mi_run', 'a0000000-0000-4000-8000-000000000055'),
  ('mov', 'a0000000-0000-4000-8000-000000000060'),
  ('saved_view', 'a0000000-0000-4000-8000-000000000070'),
  ('user3', 'a0000000-0000-4000-8000-000000000003'),
  ('group_matrix', 'a0000000-0000-4000-8000-000000000013'),
  ('assignment', 'a0000000-0000-4000-8000-000000000014'),
  ('delegation', 'a0000000-0000-4000-8000-000000000015');
CREATE FUNCTION pg_temp.i(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM pg_temp.ids WHERE name = p $$;

-- ---- identity (KEEP) ---------------------------------------------------------------------------------------------------------------------
INSERT INTO departments (id, code, name_en) VALUES (pg_temp.i('dept'), 'RST_OPS', 'Operations (synthetic)');
INSERT INTO users (id, email, display_name, employee_id, status, phone, department_id, manager_id, updated_at)
VALUES (pg_temp.i('user2'), 'reset.engineer@example.test', 'Reset Engineer (synthetic)', '9102', 'active', '+218910000102', pg_temp.i('dept'), pg_temp.i('admin'), now());
INSERT INTO local_credentials (user_id, password_hash, must_change) VALUES (pg_temp.i('user2'), '$argon2id$v=19$m=4096,t=2,p=1$c3ludGhldGlj$c3ludGhldGljaGFzaHN5bnRoZXRpYw', false);
INSERT INTO user_totp (user_id, required) VALUES (pg_temp.i('user2'), true);
INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (pg_temp.i('user2'), repeat('ab', 32)), (pg_temp.i('user2'), repeat('cd', 32));
INSERT INTO groups (id, name) VALUES (pg_temp.i('group'), 'CW Approvers Tripoli (synthetic)');
INSERT INTO group_members (group_id, user_id) VALUES (pg_temp.i('group'), pg_temp.i('user2'));
INSERT INTO absences (user_id, kind, from_date, to_date, recorded_by) VALUES (pg_temp.i('user2'), 'annual', date '2026-12-01', date '2026-12-05', pg_temp.i('user2'));
-- the identity parts of migration 0152 (KEEP unless chosen): a pending account, a role assignment, a delegation, a group the Responsibility Matrix names,
-- a staff registry card
INSERT INTO users (id, email, display_name, employee_id, status, updated_at)
VALUES (pg_temp.i('user3'), 'reset.pending@example.test', 'Reset Pending (synthetic)', '9103', 'pending_assignment', now());
INSERT INTO groups (id, name) VALUES (pg_temp.i('group_matrix'), 'TE Approvers Tripoli (synthetic)');
INSERT INTO group_members (group_id, user_id) VALUES (pg_temp.i('group_matrix'), pg_temp.i('user2'));
INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT id, 'group', pg_temp.i('group_matrix') FROM matrix_cells ORDER BY id LIMIT 1;
INSERT INTO user_role_assignments (id, user_id, role_id, permission_level, all_regions, all_modules, assigned_by)
VALUES (pg_temp.i('assignment'), pg_temp.i('user2'), (SELECT id FROM roles WHERE code = 'CW_TL'), 'entry', false, true, pg_temp.i('admin'));
INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES (pg_temp.i('assignment'), 1);
INSERT INTO delegations (id, from_user_id, target_kind, target_user_id, is_full, all_regions, valid_from, reason)
VALUES (pg_temp.i('delegation'), pg_temp.i('admin'), 'user', pg_temp.i('user2'), false, true, now() - interval '1 day', 'synthetic delegation');
INSERT INTO delegation_grants (delegation_id, module_key, action) VALUES (pg_temp.i('delegation'), 'sites', 'view');
INSERT INTO staff_registry (employee_id, name_en, name_ar, email, phone, position, region)
VALUES ('9102', 'Reset Engineer (synthetic)', 'مهندس تجريبي', 'reset.engineer@example.test', '+218 91 000 0102', 'Site Engineer', 'Tripoli');
INSERT INTO user_sessions (token_hash, user_id, auth_method, csrf_token, expires_at) VALUES
  (repeat('1', 64), pg_temp.i('admin'), 'local', 'csrf-1', now() + interval '1 hour'),
  (repeat('2', 64), pg_temp.i('user2'), 'local', 'csrf-2', now() + interval '1 hour');
INSERT INTO user_sessions (token_hash, user_id, auth_method, csrf_token, expires_at, revoked_at, revoke_reason) VALUES
  (repeat('3', 64), pg_temp.i('user2'), 'local', 'csrf-3', now() + interval '1 hour', now() - interval '1 day', 'logout');

-- ---- between users and preferences (KEEP) ------------------------------------------------------------------------------------------------
INSERT INTO message_threads (id, subject, created_by) VALUES (pg_temp.i('thread'), 'Weekly plan (synthetic)', pg_temp.i('user2'));
INSERT INTO message_participants (thread_id, user_id) VALUES (pg_temp.i('thread'), pg_temp.i('user2')), (pg_temp.i('thread'), pg_temp.i('admin'));
INSERT INTO messages (thread_id, author_id, body, is_original) VALUES (pg_temp.i('thread'), pg_temp.i('user2'), 'Synthetic message', true);
INSERT INTO saved_views (id, owner_id, screen_key, name, created_by, updated_by) VALUES (pg_temp.i('saved_view'), pg_temp.i('user2'), 'sites', 'My sites (synthetic)', pg_temp.i('user2'), pg_temp.i('user2'));
INSERT INTO status_updates (scope, region_id, week_start, health, summary, author_id) VALUES ('region', 1, date '2026-11-22', 'on_track', 'Synthetic weekly update', pg_temp.i('admin'));

-- ---- master data in the generic register table (KEEP): a company and a vehicle ----------------------------------------------------------
INSERT INTO external_parties (id, name, type, source_record_id) VALUES (pg_temp.i('party'), 'Synthetic Civil Works Co', 'cw_contractor', pg_temp.i('company_r'));
INSERT INTO import_batches (id, template_version_id, file_name, file_sha256, uploaded_by, register_key)
VALUES (pg_temp.i('kept_batch'), (SELECT id FROM template_versions ORDER BY id LIMIT 1), 'contractors.xlsx', repeat('a', 64), pg_temp.i('admin'), 'contractors');
INSERT INTO import_batch_rows (id, batch_id, row_no, target_entity, payload, action) VALUES (pg_temp.i('kept_row'), pg_temp.i('kept_batch'), 1, 'register_record', '{}', 'create');
INSERT INTO register_records (id, entity_id, version_no, is_current, register_key, record_type, is_global, state, data, approved_at, historical_direct_batch_id)
VALUES (pg_temp.i('company_r'), pg_temp.i('company_e'), 1, true, 'contractors', 'company', true, 'approved', '{"company_name":"Synthetic Civil Works Co"}', now(), pg_temp.i('kept_batch')),
       (pg_temp.i('vehicle_r'), pg_temp.i('vehicle_e'), 1, true, 'car_dispatcher', 'vehicle', true, 'approved', '{"plate":"SYN-001"}', now(), NULL);
INSERT INTO register_steps (record_id, level, action, acted_by) VALUES (pg_temp.i('company_r'), 1, 'submit', pg_temp.i('admin')), (pg_temp.i('vehicle_r'), 1, 'submit', pg_temp.i('admin'));
INSERT INTO document_slots (id, register_entity_id, register_key, is_global, doc_type_id)
VALUES (pg_temp.i('slot_company'), pg_temp.i('company_e'), 'contractors', true, (SELECT id FROM document_types ORDER BY code LIMIT 1));
INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, size_bytes, sha256, uploaded_by)
VALUES (pg_temp.i('slot_company'), gen_random_uuid(), 'licence.pdf', 'licence.pdf', 'docs/2026/11/kept-company-file', 'application/pdf', 10, repeat('b', 64), pg_temp.i('admin'));
INSERT INTO comments (region_id, entity_type, entity_id, author_id, body) VALUES (1, 'register_record', pg_temp.i('company_e'), pg_temp.i('admin'), 'Company comment (kept)');
INSERT INTO levels_conversions (entity_type, entity_id, converted_at, levels_before, migration, reason)
VALUES ('register_record', pg_temp.i('company_r'), now(), 3, '0054', 'synthetic kept conversion');

-- ---- project data (DELETE) ---------------------------------------------------------------------------------------------------------------
INSERT INTO clusters (id, cluster_code, region_id) VALUES (pg_temp.i('cluster'), 'RST-CL1', 1);
INSERT INTO workflow_definitions (version, status, effective_from, reason) VALUES (99, 'draft', date '2026-12-01', 'synthetic draft version');
INSERT INTO sites (id, site_code, name, region_id, workflow_version_id, cluster_id, updated_at) VALUES
  (pg_temp.i('site1'), 'RST-00001', 'Synthetic Site 1', 1, pg_temp.i('wf'), pg_temp.i('cluster'), now()),
  (pg_temp.i('site2'), 'RST-00002', 'Synthetic Site 2', 1, pg_temp.i('wf'), NULL, now());
INSERT INTO task_instances (site_id, region_id, task_def_id, updated_at)
SELECT s.id, 1, td.id, now() FROM task_definitions td CROSS JOIN (VALUES (pg_temp.i('site1')), (pg_temp.i('site2'))) s(id) WHERE td.workflow_id = pg_temp.i('wf') AND td.is_active;
CREATE TEMP TABLE t1 ON COMMIT DROP AS SELECT id FROM task_instances WHERE site_id = pg_temp.i('site1') ORDER BY id LIMIT 1;
INSERT INTO workflow_steps (task_id, level, action, acted_by) SELECT id, 1, 'submit', pg_temp.i('user2') FROM t1;
INSERT INTO task_level_actors (task_id, level, user_id, how) SELECT id, 1, pg_temp.i('user2'), 'acted' FROM t1;
INSERT INTO comments (task_id, region_id, author_id, body) SELECT id, 1, pg_temp.i('user2'), 'Task comment (synthetic)' FROM t1;
INSERT INTO comment_mentions (comment_id, user_id) SELECT id, pg_temp.i('admin') FROM comments WHERE task_id IS NOT NULL;
INSERT INTO site_gate_state (site_id, gate_code, is_open) VALUES (pg_temp.i('site1'), 'G1', true);
INSERT INTO site_gate_events (site_id, region_id, gate_code, event, status) VALUES (pg_temp.i('site1'), 1, 'G1', 'opened', 'open');
INSERT INTO admin_overrides (entity, site_id, kind, reason, before, after, acted_by) VALUES ('site', pg_temp.i('site1'), 'edit_field', 'synthetic override', '{}', '{}', pg_temp.i('admin'));
INSERT INTO change_requests (id, change_code, site_id, region_id, kind, requested_by) VALUES (pg_temp.i('cr'), 'CR-RST-1', pg_temp.i('site1'), 1, 'other', pg_temp.i('admin'));
INSERT INTO site_scope_exceptions (site_id, region_id, task_code, reason, change_request_id, approved_by) VALUES (pg_temp.i('site1'), 1, 'B5', 'synthetic', pg_temp.i('cr'), pg_temp.i('admin'));
INSERT INTO task_delay_periods (task_id, site_id, region_id, from_date, to_date, party, reason, created_by)
SELECT id, pg_temp.i('site1'), 1, date '2026-11-01', date '2026-11-05', 'client', 'synthetic delay', pg_temp.i('admin') FROM t1;
INSERT INTO ps_manual_values (item_code, version, value_pct, effective_date, reason, entered_by, source) VALUES ('A1', 1, 12.5, date '2026-11-01', 'synthetic', pg_temp.i('admin'), 'manual');
INSERT INTO ps_manual_plans (item_code, version, points, reason, source, entered_by) VALUES ('A1', 1, '[{"date":"2026-11-01","pct":1}]', 'synthetic', 'manual', pg_temp.i('admin'));
INSERT INTO dash_snapshot_runs (snapshot_date, kind, source) VALUES (date '2026-11-16', 'weekly', 'schedule');
INSERT INTO site_snapshots (snapshot_date, site_id, region_id, overall_status, ms, streams, items) VALUES (date '2026-11-16', pg_temp.i('site1'), 1, 'in_progress', '{}', '{}', '{}');
INSERT INTO progress_snapshots (snapshot_date, weight_set_id, is_global, actual_pct, values) VALUES (date '2026-11-16', (SELECT id FROM weight_sets ORDER BY id LIMIT 1), true, 10, '{}');
INSERT INTO baseline_versions (id, version) VALUES (pg_temp.i('baseline'), 1);
INSERT INTO baseline_entries (version_id, site_id, region_id, milestone_code, baseline_date) VALUES (pg_temp.i('baseline'), pg_temp.i('site1'), 1, 'MS1', date '2026-12-01');
INSERT INTO site_workflow_migrations (site_id, from_version_id, to_version_id, reason) VALUES (pg_temp.i('site2'), (SELECT id FROM workflow_definitions WHERE version = 99), pg_temp.i('wf'), 'synthetic');

-- registers: a procurement order, a risk, a financial advance, a vehicle booking (with its reservation), the typed tables
INSERT INTO register_records (id, entity_id, version_no, is_current, register_key, record_type, site_id, region_id, state, data) VALUES
  (pg_temp.i('proc_r'), pg_temp.i('proc_e'), 1, true, 'procurement', 'po', pg_temp.i('site1'), 1, 'approved', '{"po_wo_no":"PO-RST-1"}'),
  (pg_temp.i('adv_r'), gen_random_uuid(), 1, true, 'financial_advances', 'advance', pg_temp.i('site1'), 1, 'entry', '{}');
INSERT INTO register_records (id, entity_id, version_no, is_current, register_key, is_global, state, data) VALUES
  (pg_temp.i('risk_r'), gen_random_uuid(), 1, true, 'risks', true, 'entry', '{"statement":"synthetic risk"}');
INSERT INTO register_records (id, entity_id, version_no, is_current, register_key, record_type, is_global, state, data) VALUES
  (pg_temp.i('booking_r'), pg_temp.i('booking_e'), 1, true, 'car_dispatcher', 'booking', true, 'approved', '{}');
INSERT INTO register_steps (record_id, level, action, acted_by) VALUES (pg_temp.i('proc_r'), 1, 'submit', pg_temp.i('user2'));
INSERT INTO register_level_actors (record_id, level, user_id, how) VALUES (pg_temp.i('proc_r'), 1, pg_temp.i('user2'), 'acted');
INSERT INTO register_record_locks (record_id, register_key, reason, locked_by) VALUES (pg_temp.i('proc_r'), 'procurement', 'synthetic lock', pg_temp.i('admin'));
INSERT INTO vehicle_reservations (vehicle_entity_id, booking_entity_id, booking_record_id, period) VALUES (pg_temp.i('vehicle_e'), pg_temp.i('booking_e'), pg_temp.i('booking_r'), daterange('2026-11-20', '2026-11-22'));
INSERT INTO assignment_readiness (procurement_entity_id, readiness) VALUES (pg_temp.i('proc_e'), 'not_ready');
INSERT INTO procurement_records (site_id, region_id, scope, register_record_id) VALUES (pg_temp.i('site1'), 1, 'CW', pg_temp.i('proc_r'));
INSERT INTO issues (site_id, region_id, title, raised_date) VALUES (pg_temp.i('site1'), 1, 'Synthetic issue', date '2026-11-10');
INSERT INTO risks (risk_code, statement, probability, impact, is_global) VALUES ('R-RST-1', 'Synthetic risk', 2, 3, true);
INSERT INTO meetings (id, title, meeting_date, is_global) VALUES ('a0000000-0000-4000-8000-000000000080', 'Synthetic meeting', now(), true);
INSERT INTO meeting_actions (meeting_id, description) VALUES ('a0000000-0000-4000-8000-000000000080', 'Synthetic action');
INSERT INTO register_records (id, entity_id, version_no, is_current, register_key, site_id, region_id, state, data) VALUES
  ('a0000000-0000-4000-8000-00000000002b', gen_random_uuid(), 1, true, 'hlc', pg_temp.i('site1'), 1, 'entry', '{}');
INSERT INTO hlc_pr_links (hlc_record_id, procurement_entity_id, site_id, region_id) VALUES ('a0000000-0000-4000-8000-00000000002b', pg_temp.i('proc_e'), pg_temp.i('site1'), 1);
INSERT INTO hlc_legacy_migrations (hlc_entity_id, hlc_record_id, procurement_entity_id, procurement_record_id, outcome, site_id, region_id, migrated_by, reason)
VALUES (gen_random_uuid(), 'a0000000-0000-4000-8000-00000000002b', pg_temp.i('proc_e'), pg_temp.i('proc_r'), 'created', pg_temp.i('site1'), 1, pg_temp.i('admin'), 'synthetic');
INSERT INTO rf_design_records (site_id, region_id) VALUES (pg_temp.i('site1'), 1);
INSERT INTO acquisition_candidates (site_id, region_id, candidate_no) VALUES (pg_temp.i('site1'), 1, 'C1');
INSERT INTO gecol_records (site_id, region_id) VALUES (pg_temp.i('site1'), 1);
INSERT INTO hlc_records (site_id, region_id) VALUES (pg_temp.i('site1'), 1);
INSERT INTO permit_records (site_id, region_id, permit_type) VALUES (pg_temp.i('site1'), 1, (SELECT code FROM permit_types ORDER BY code LIMIT 1));
INSERT INTO quality_inspections (record_code, record_type, site_id, region_id) VALUES ('QC-RST-1', 'qc', pg_temp.i('site1'), 1);
INSERT INTO readiness_handover (site_id, region_id) VALUES (pg_temp.i('site1'), 1);
INSERT INTO as_built_records (site_id, region_id, quantities) VALUES (pg_temp.i('site1'), 1, '{}');
INSERT INTO task_level_voters (task_id, level, round, user_id) SELECT id, 2, 1, pg_temp.i('admin') FROM t1;
INSERT INTO task_cover_decisions (bulk_action_id, task_id, region_id, decision, level, from_user_id, to_user_id, decided_by, reason)
SELECT gen_random_uuid(), id, 1, 'reassign', 1, pg_temp.i('user2'), pg_temp.i('admin'), pg_temp.i('admin'), 'synthetic cover' FROM t1;
-- the Daily Plan of a day (0149): a header and a row with a manual value (project data)
INSERT INTO daily_plans (id, region_id, plan_date, created_by) VALUES ('a0000000-0000-4000-8000-0000000000d1', 1, date '2026-11-22', pg_temp.i('admin'));
INSERT INTO daily_plan_rows (plan_id, region_id, site_id, origin, overrides, reason) VALUES ('a0000000-0000-4000-8000-0000000000d1', 1, pg_temp.i('site1'), 'added', '{"tower_owner": "Synthetic Owner"}', 'synthetic reason');
INSERT INTO levels_conversions (entity_type, entity_id, converted_at, levels_before, migration, reason) SELECT 'task', id, now(), 3, '0054', 'synthetic' FROM t1;

-- warehouse movements and stock (the item master stays)
INSERT INTO wh_movements (id, entity_id, record_id, record_type, kind, site_id, region_id) VALUES (pg_temp.i('mov'), gen_random_uuid(), gen_random_uuid(), 'cw_dn', 'issue', pg_temp.i('site1'), 1);
INSERT INTO wh_movement_lines (movement_id, item_id, qty) VALUES (pg_temp.i('mov'), (SELECT id FROM warehouse_items ORDER BY item_code LIMIT 1), 2);
INSERT INTO warehouse_serials (item_id, serial_no, site_id, region_id) VALUES ((SELECT id FROM warehouse_items ORDER BY item_code LIMIT 1), 'SN-RST-1', pg_temp.i('site1'), 1);
INSERT INTO warehouse_site_qty (site_id, region_id, item_id, required) VALUES (pg_temp.i('site1'), 1, (SELECT id FROM warehouse_items ORDER BY item_code LIMIT 1), 4);

-- documents of a task, a QC snag with a photo, the envelopes of every stored object
INSERT INTO document_slots (id, task_id, site_id, region_id, doc_type_id) SELECT pg_temp.i('slot_task'), id, pg_temp.i('site1'), 1, (SELECT id FROM document_types ORDER BY code LIMIT 1) FROM t1;
INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, size_bytes, sha256, uploaded_by)
VALUES (pg_temp.i('slot_task'), gen_random_uuid(), 'tssr.pdf', 'RST_A2_TSSR.pdf', 'docs/2026/11/project-task-file', 'application/pdf', 10, repeat('c', 64), pg_temp.i('user2'));
INSERT INTO document_task_snapshots (task_id, taken_at) SELECT id, now() FROM t1;
INSERT INTO document_record_snapshots (entity_id, taken_at) VALUES (pg_temp.i('proc_e'), now()), (pg_temp.i('company_e'), now());
INSERT INTO document_site_overrides (site_id, region_id, doc_type_id, kind, reason, created_by)
VALUES (pg_temp.i('site1'), 1, (SELECT id FROM document_types ORDER BY code LIMIT 1), 'not_required', 'synthetic', pg_temp.i('admin'));
INSERT INTO snags (id, site_id, region_id, snag_type_id, scope, description, raised_by) VALUES (pg_temp.i('snag'), pg_temp.i('site1'), 1, (SELECT id FROM snag_types LIMIT 1), 'cw', 'Synthetic snag', pg_temp.i('user2'));
INSERT INTO snag_photos (snag_id, storage_key, mime_type, size_bytes, sha256, uploaded_by) VALUES (pg_temp.i('snag'), 'docs/2026/11/project-snag-photo', 'image/jpeg', 10, repeat('d', 64), pg_temp.i('user2'));
INSERT INTO snag_level_voters (snag_id, round, user_id) VALUES (pg_temp.i('snag'), 1, pg_temp.i('admin'));
INSERT INTO document_export_jobs (requested_by, scope, status, storage_key) VALUES (pg_temp.i('admin'), '{"kind":"master_export"}', 'done', 'exports/2026/11/project-export-file');
INSERT INTO stored_object_meta (storage_key, driver, key_id, wrapped_key, nonce, tag, plain_sha256, size_bytes)
SELECT k, 'local', 'k1', decode(repeat('00', 60), 'hex'), decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'), repeat('e', 64), 10
FROM unnest(ARRAY['docs/2026/11/kept-company-file', 'docs/2026/11/project-task-file', 'docs/2026/11/project-snag-photo', 'exports/2026/11/project-export-file',
                  'imports/2026/11/project-master-file']) k;

-- imports: a project batch with a row and the site draft they point at (both ways), an upload, the legacy Master reconciliation
INSERT INTO import_batches (id, template_version_id, file_name, file_sha256, uploaded_by, register_key)
VALUES (pg_temp.i('proj_batch'), (SELECT id FROM template_versions ORDER BY id LIMIT 1), 'sites.xlsx', repeat('f', 64), pg_temp.i('user2'), 'site_creation');
INSERT INTO import_batch_rows (id, batch_id, row_no, target_entity, payload, action, site_draft_id) VALUES (pg_temp.i('proj_row'), pg_temp.i('proj_batch'), 1, 'site', '{}', 'create', pg_temp.i('draft'));
INSERT INTO site_drafts (id, site_code, region_id, data, created_by, batch_id, batch_row_id) VALUES (pg_temp.i('draft'), 'RST-00003', 1, '{}', pg_temp.i('user2'), pg_temp.i('proj_batch'), pg_temp.i('proj_row'));
INSERT INTO import_batch_jobs (batch_id, kind, action, actor_id, stepup_verified, prev_status, rows_total) VALUES (pg_temp.i('proj_batch'), 'submit', NULL, pg_temp.i('user2'), false, 'validated', 1);
INSERT INTO master_reconciliation_runs (id, file_name, file_sha256, file_size, structure, created_by, storage_key)
VALUES (pg_temp.i('mi_run'), 'GSDN_Site_Master.xlsx', repeat('9', 64), 100, '{}', pg_temp.i('admin'), 'imports/2026/11/project-master-file');
INSERT INTO master_reconciliation_rows (run_id, row_no, cells) VALUES (pg_temp.i('mi_run'), 1, '{}');
INSERT INTO master_reconciliation_diffs (run_id, ord, sheet, row_no, kind, reason) VALUES (pg_temp.i('mi_run'), 1, 'Master', 1, 'missing_in_pmis', 'synthetic');
INSERT INTO mi_apply_jobs (run_id, actor_id, mode, reason, sites_total) VALUES (pg_temp.i('mi_run'), pg_temp.i('admin'), 'submit', 'synthetic', 1);
INSERT INTO import_uploads (actor_id, kind, file_name, file_sha256, mode, units_total, file_rows, unit_rows_total, run_id)
VALUES (pg_temp.i('admin'), 'legacy', 'GSDN_Site_Master.xlsx', repeat('8', 64), 'submit', 1, 1, 1, pg_temp.i('mi_run'));
INSERT INTO hrf_stage_marks (xid, actor_id, run_id) VALUES (1, pg_temp.i('admin'), pg_temp.i('mi_run'));
INSERT INTO hgd_marks (xid, kind, key) VALUES (1, 'synthetic', 'k');

-- inbox, follows, drafts (a task draft and a project record draft go; a form draft and a draft of the kept company stay)
INSERT INTO notifications (user_id, kind, title, region_id) VALUES (pg_temp.i('user2'), 'task_assigned', 'Synthetic notice', 1);
INSERT INTO watches (user_id, entity_type, entity_id, site_id, region_id) VALUES (pg_temp.i('user2'), 'site', pg_temp.i('site1'), pg_temp.i('site1'), 1);
INSERT INTO user_drafts (user_id, draft_key, payload) SELECT pg_temp.i('user2'), 'task.' || id, '{}' FROM t1;
INSERT INTO user_drafts (user_id, draft_key, payload) VALUES
  (pg_temp.i('user2'), 'record.procurement.' || pg_temp.i('proc_e'), '{}'),
  (pg_temp.i('user2'), 'record.contractors.' || pg_temp.i('company_e'), '{}'),
  (pg_temp.i('user2'), 'form.profile', '{}');

-- a used form number (KEEP: numbers are never reused)
INSERT INTO doc_number_issues (number, seq_key, target_kind, target_id) SELECT 'DN-CW-TR-2026-0001', key, 'wh_movement', pg_temp.i('mov') FROM doc_sequences ORDER BY key LIMIT 1;

COMMIT;

-- ---- logs, with the triggers on: sealed on the chains like real rows -----------------------------------------------------------------------
INSERT INTO audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
VALUES ('task.submit', 'task', 'synthetic', 'a0000000-0000-4000-8000-000000000031', 1, '{"state":"open"}', '{"state":"in_review"}', 'synthetic audit row'),
       ('site.create', 'site', 'RST-00001', 'a0000000-0000-4000-8000-000000000031', 1, NULL, '{"site_code":"RST-00001"}', 'synthetic audit row');
SELECT sec_log_write('sign_in_succeeded', 'success', 'a0000000-0000-4000-8000-000000000002', NULL, '{"method":"local"}') \g /dev/null
SELECT sec_log_write('sign_in_failed', 'failure', NULL, '?s***#0123456789ab', '{"method":"local"}') \g /dev/null
INSERT INTO system_log (level, source, message) VALUES ('info', 'test', 'synthetic system log row');
