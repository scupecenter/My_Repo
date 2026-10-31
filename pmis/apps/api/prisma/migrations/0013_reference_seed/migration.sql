-- 0013_reference_seed: reference data the rest of P1 needs (P1-DB-01, P1-DB-07). Mirror: db/sql/012_reference_seed.sql (kept identical).
--
-- Runs as the migration role (pmis_migrator or a superuser): app_is_seeding() is true, so the guards that demand a reason,
-- changed_by or draft-first publishing step aside. It is IDEMPOTENT and NON-DESTRUCTIVE: every row is inserted by its natural key
-- with ON CONFLICT DO NOTHING (an admin's later edit is never overwritten); children of a new parent (grants of a new profile, the
-- tasks of workflow version 1) are written only when the parent is created by this run.
--
-- Contents: 1 holiday columns (name_ar, kind, tentative, note)  2 regions  3 permission profiles and grid  4 roles
--           5 default work calendar and holidays  6 workflow definition v1 (10 milestones, 9 gates, tasks, predecessors, SLA rule-set v1).
-- Sources: CLAUDE.md, docs/spec/task-catalogue.csv (50 task rows + 10 milestone rows + 9 gate rows = 69 catalogue rows), db/seed/holidays-2026-2027.csv.
-- Arabic texts are PROPOSALS (tentative) until the product owner reviews them in the admin screens.

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Holidays: Arabic name, kind, tentative flag, note (CLAUDE.md decision B12; seed-plan 10c "P1 migration").
-- ---------------------------------------------------------------------------------------------------------------------------
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS name_ar   TEXT;
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS kind      TEXT    NOT NULL DEFAULT 'national';
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS tentative BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS note      TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'holidays_kind_check' AND conrelid = 'holidays'::regclass) THEN
    ALTER TABLE holidays ADD CONSTRAINT holidays_kind_check CHECK (kind IN ('national', 'religious'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Regions 1..7 (codes as used by the API tests; Arabic names tentative).
-- ---------------------------------------------------------------------------------------------------------------------------
INSERT INTO regions (id, code, name_en, name_ar) VALUES
  (1, 'TRIPOLI', 'Tripoli', 'طرابلس'),
  (2, 'MIDDLE', 'Middle', 'الوسطى'),
  (3, 'WM', 'WM', 'الجبل الغربي'),
  (4, 'ZAWIA', 'Zawia', 'الزاوية'),
  (5, 'BENGHAZI', 'Benghazi', 'بنغازي'),
  (6, 'GM', 'GM', 'الجبل الأخضر'),
  (7, 'SEBHA', 'Sebha', 'سبها')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Permission profiles (named, reusable) and their grid (module_key x action).
--
-- Module keys: the ModuleKey seed of contracts/openapi.yaml, plus messages, announcements, absence, dismantle, reports and the
-- admin.* screens, plus the configuration modules that app_can() checks on config tables (regions, workflow_versions,
-- task_definitions, document_types, templates, calendars, sla_rules, weights, baseline, settings, fields, lists, warehouse_items).
-- Actions: the PermissionAction enum of the database (view, create, edit, delete, approve, export, import, download_documents,
-- view_audit, administer). manage_users and view_security_log exist in the contract but not in the enum (see report).
--
-- Grid (X = granted; every profile also has view on messages/announcements, and create on messages):
--   profile              view  create/edit/import  export/download  approve  view_audit  other
--   viewer                all-ops  -                -                -        -           -
--   management_readonly   all-ops  -                dashboard,reports only  -  -        -
--   data_entry            all-ops  registers, sites, site docs, templates (import)  registers, sites, site docs  -  -  -
--   reviewer              all-ops  -                registers, sites, site docs, reports  -  -  -
--   approver              all-ops  -                as reviewer      registers, sites, site docs, approvals  -  -
--   team_lead             all-ops  as data_entry    as reviewer      as approver  registers, sites, audit  absence create/edit, admin.matrix view
--   project_manager       as team_lead + audit screen + admin.matrix/workflow/settings view
--   inventory_supervisor  as data_entry + warehouse approve and view_audit (item master edits only by delegation)
--   system_admin          every module x every action
-- "all-ops" = sites, sites.documents, approvals, my_work, templates, dashboard, reports, absence, messages, announcements and the 16
-- registers (procurement, contractors, rf_design, acquisition, gecol, hlc, permits_hse, warehouse, quality, issues, risks,
-- change_control, readiness, as_built, meetings, dismantle). The effective right is still limited per assignment by its regions
-- and modules (decision B3). Admins are decided by membership of the System Admins group, not by this grid.
-- ---------------------------------------------------------------------------------------------------------------------------
DROP TABLE IF EXISTS pg_temp._seed_new_profile;
DROP TABLE IF EXISTS pg_temp._seed_grid;
DROP TABLE IF EXISTS pg_temp._seed_mod;
-- _seed_new_profile = profiles created by THIS run: only their grants are written, so an existing profile keeps what the admin made of it
CREATE TEMP TABLE _seed_new_profile AS
  WITH i AS (
    INSERT INTO permission_profiles (code, name_en, name_ar, description, reason) VALUES
      ('viewer', 'Viewer', 'مشاهد', 'View on every operational module; no entry, no approval.', 'seed'),
      ('data_entry', 'Data entry', 'إدخال بيانات', 'Viewer plus create, edit, import and export on the registers, sites and site documents.', 'seed'),
      ('reviewer', 'Reviewer', 'مراجع', 'Viewer plus export and document download; review itself comes from the Responsibility Matrix.', 'seed'),
      ('approver', 'Approver', 'معتمد', 'Reviewer plus the approve action on registers, sites, site documents and the Approvals screen.', 'seed'),
      ('team_lead', 'Team lead', 'قائد فريق', 'Approver plus entry, import, absence records and the audit log for own modules and regions.', 'seed'),
      ('project_manager', 'Project Manager', 'مدير المشروع', 'Team lead plus the whole audit log and read access to the workflow, matrix and settings screens.', 'seed'),
      ('inventory_supervisor', 'Inventory Supervisor', 'مشرف المخزون', 'Data entry plus approve and audit on the Warehouse module. Item master edits only by delegation (warehouse_items).', 'seed'),
      ('management_readonly', 'Management (read-only)', 'الإدارة (للقراءة فقط)', 'View the dashboard and progress reports and every operational module; export of dashboard and reports. No entry, no approval.', 'seed'),
      ('system_admin', 'System Admin', 'مسؤول النظام', 'Every module and every action. Administration itself is decided by membership of the System Admins group.', 'seed')
    ON CONFLICT (code) DO NOTHING RETURNING id, code)
  SELECT id, code FROM i;
CREATE TEMP TABLE _seed_mod (grp text, module_key text);
INSERT INTO _seed_mod VALUES
  ('sites', 'sites'),
  ('sites_docs', 'sites.documents'),
  ('approvals', 'approvals'),
  ('my_work', 'my_work'),
  ('templates', 'templates'),
  ('dash_reports', 'dashboard'),
  ('dash_reports', 'reports'),
  ('absence', 'absence'),
  ('messages', 'messages'),
  ('announcements', 'announcements'),
  ('registers', 'procurement'),
  ('registers', 'contractors'),
  ('registers', 'rf_design'),
  ('registers', 'acquisition'),
  ('registers', 'gecol'),
  ('registers', 'hlc'),
  ('registers', 'permits_hse'),
  ('registers', 'warehouse'),
  ('registers', 'quality'),
  ('registers', 'issues'),
  ('registers', 'risks'),
  ('registers', 'change_control'),
  ('registers', 'readiness'),
  ('registers', 'as_built'),
  ('registers', 'meetings'),
  ('registers', 'dismantle'),
  ('warehouse', 'warehouse'),
  ('audit', 'audit'),
  ('admin_view', 'admin.matrix'),
  ('admin_view', 'admin.workflow'),
  ('admin_view', 'admin.settings'),
  ('admin_screens', 'admin.users'),
  ('admin_screens', 'admin.roles'),
  ('admin_screens', 'admin.groups'),
  ('admin_screens', 'admin.delegation'),
  ('admin_screens', 'admin.matrix'),
  ('admin_screens', 'admin.workflow'),
  ('admin_screens', 'admin.settings'),
  ('admin_screens', 'admin.security_log'),
  ('admin_screens', 'admin.online'),
  ('admin_screens', 'admin.announcements'),
  ('config', 'regions'),
  ('config', 'workflow_versions'),
  ('config', 'task_definitions'),
  ('config', 'document_types'),
  ('config', 'calendars'),
  ('config', 'sla_rules'),
  ('config', 'weights'),
  ('config', 'baseline'),
  ('config', 'settings'),
  ('config', 'fields'),
  ('config', 'lists'),
  ('config', 'warehouse_items'),
  ('admin_matrix', 'admin.matrix');
CREATE TEMP TABLE _seed_grid (profile text, grp text, action "PermissionAction");
INSERT INTO _seed_grid VALUES
  ('viewer', 'sites', 'view'),
  ('viewer', 'sites_docs', 'view'),
  ('viewer', 'approvals', 'view'),
  ('viewer', 'my_work', 'view'),
  ('viewer', 'templates', 'view'),
  ('viewer', 'dash_reports', 'view'),
  ('viewer', 'absence', 'view'),
  ('viewer', 'messages', 'view'),
  ('viewer', 'messages', 'create'),
  ('viewer', 'announcements', 'view'),
  ('viewer', 'registers', 'view'),
  ('data_entry', 'sites', 'view'),
  ('data_entry', 'sites', 'edit'),
  ('data_entry', 'sites', 'import'),
  ('data_entry', 'sites', 'export'),
  ('data_entry', 'sites', 'download_documents'),
  ('data_entry', 'sites_docs', 'view'),
  ('data_entry', 'sites_docs', 'create'),
  ('data_entry', 'sites_docs', 'edit'),
  ('data_entry', 'sites_docs', 'download_documents'),
  ('data_entry', 'approvals', 'view'),
  ('data_entry', 'my_work', 'view'),
  ('data_entry', 'templates', 'view'),
  ('data_entry', 'templates', 'import'),
  ('data_entry', 'templates', 'download_documents'),
  ('data_entry', 'dash_reports', 'view'),
  ('data_entry', 'absence', 'view'),
  ('data_entry', 'messages', 'view'),
  ('data_entry', 'messages', 'create'),
  ('data_entry', 'announcements', 'view'),
  ('data_entry', 'registers', 'view'),
  ('data_entry', 'registers', 'create'),
  ('data_entry', 'registers', 'edit'),
  ('data_entry', 'registers', 'import'),
  ('data_entry', 'registers', 'export'),
  ('data_entry', 'registers', 'download_documents'),
  ('reviewer', 'sites', 'view'),
  ('reviewer', 'sites', 'export'),
  ('reviewer', 'sites', 'download_documents'),
  ('reviewer', 'sites_docs', 'view'),
  ('reviewer', 'sites_docs', 'export'),
  ('reviewer', 'sites_docs', 'download_documents'),
  ('reviewer', 'approvals', 'view'),
  ('reviewer', 'my_work', 'view'),
  ('reviewer', 'templates', 'view'),
  ('reviewer', 'dash_reports', 'view'),
  ('reviewer', 'dash_reports', 'export'),
  ('reviewer', 'absence', 'view'),
  ('reviewer', 'messages', 'view'),
  ('reviewer', 'messages', 'create'),
  ('reviewer', 'announcements', 'view'),
  ('reviewer', 'registers', 'view'),
  ('reviewer', 'registers', 'export'),
  ('reviewer', 'registers', 'download_documents'),
  ('approver', 'sites', 'view'),
  ('approver', 'sites', 'export'),
  ('approver', 'sites', 'download_documents'),
  ('approver', 'sites', 'approve'),
  ('approver', 'sites_docs', 'view'),
  ('approver', 'sites_docs', 'export'),
  ('approver', 'sites_docs', 'download_documents'),
  ('approver', 'sites_docs', 'approve'),
  ('approver', 'approvals', 'view'),
  ('approver', 'approvals', 'approve'),
  ('approver', 'my_work', 'view'),
  ('approver', 'templates', 'view'),
  ('approver', 'dash_reports', 'view'),
  ('approver', 'dash_reports', 'export'),
  ('approver', 'absence', 'view'),
  ('approver', 'messages', 'view'),
  ('approver', 'messages', 'create'),
  ('approver', 'announcements', 'view'),
  ('approver', 'registers', 'view'),
  ('approver', 'registers', 'export'),
  ('approver', 'registers', 'download_documents'),
  ('approver', 'registers', 'approve'),
  ('team_lead', 'sites', 'view'),
  ('team_lead', 'sites', 'export'),
  ('team_lead', 'sites', 'download_documents'),
  ('team_lead', 'sites', 'approve'),
  ('team_lead', 'sites', 'edit'),
  ('team_lead', 'sites', 'import'),
  ('team_lead', 'sites', 'view_audit'),
  ('team_lead', 'sites_docs', 'view'),
  ('team_lead', 'sites_docs', 'export'),
  ('team_lead', 'sites_docs', 'download_documents'),
  ('team_lead', 'sites_docs', 'approve'),
  ('team_lead', 'sites_docs', 'create'),
  ('team_lead', 'sites_docs', 'edit'),
  ('team_lead', 'approvals', 'view'),
  ('team_lead', 'approvals', 'approve'),
  ('team_lead', 'my_work', 'view'),
  ('team_lead', 'templates', 'view'),
  ('team_lead', 'templates', 'import'),
  ('team_lead', 'templates', 'download_documents'),
  ('team_lead', 'dash_reports', 'view'),
  ('team_lead', 'dash_reports', 'export'),
  ('team_lead', 'absence', 'view'),
  ('team_lead', 'absence', 'create'),
  ('team_lead', 'absence', 'edit'),
  ('team_lead', 'messages', 'view'),
  ('team_lead', 'messages', 'create'),
  ('team_lead', 'announcements', 'view'),
  ('team_lead', 'registers', 'view'),
  ('team_lead', 'registers', 'export'),
  ('team_lead', 'registers', 'download_documents'),
  ('team_lead', 'registers', 'approve'),
  ('team_lead', 'registers', 'create'),
  ('team_lead', 'registers', 'edit'),
  ('team_lead', 'registers', 'import'),
  ('team_lead', 'registers', 'view_audit'),
  ('team_lead', 'audit', 'view'),
  ('team_lead', 'audit', 'view_audit'),
  ('team_lead', 'admin_matrix', 'view'),
  ('project_manager', 'sites', 'view'),
  ('project_manager', 'sites', 'export'),
  ('project_manager', 'sites', 'download_documents'),
  ('project_manager', 'sites', 'approve'),
  ('project_manager', 'sites', 'edit'),
  ('project_manager', 'sites', 'import'),
  ('project_manager', 'sites', 'view_audit'),
  ('project_manager', 'sites_docs', 'view'),
  ('project_manager', 'sites_docs', 'export'),
  ('project_manager', 'sites_docs', 'download_documents'),
  ('project_manager', 'sites_docs', 'approve'),
  ('project_manager', 'sites_docs', 'create'),
  ('project_manager', 'sites_docs', 'edit'),
  ('project_manager', 'sites_docs', 'view_audit'),
  ('project_manager', 'approvals', 'view'),
  ('project_manager', 'approvals', 'approve'),
  ('project_manager', 'approvals', 'view_audit'),
  ('project_manager', 'my_work', 'view'),
  ('project_manager', 'templates', 'view'),
  ('project_manager', 'templates', 'import'),
  ('project_manager', 'templates', 'download_documents'),
  ('project_manager', 'dash_reports', 'view'),
  ('project_manager', 'dash_reports', 'export'),
  ('project_manager', 'absence', 'view'),
  ('project_manager', 'absence', 'create'),
  ('project_manager', 'absence', 'edit'),
  ('project_manager', 'messages', 'view'),
  ('project_manager', 'messages', 'create'),
  ('project_manager', 'announcements', 'view'),
  ('project_manager', 'registers', 'view'),
  ('project_manager', 'registers', 'export'),
  ('project_manager', 'registers', 'download_documents'),
  ('project_manager', 'registers', 'approve'),
  ('project_manager', 'registers', 'create'),
  ('project_manager', 'registers', 'edit'),
  ('project_manager', 'registers', 'import'),
  ('project_manager', 'registers', 'view_audit'),
  ('project_manager', 'audit', 'view'),
  ('project_manager', 'audit', 'view_audit'),
  ('project_manager', 'admin_matrix', 'view'),
  ('project_manager', 'admin_view', 'view'),
  ('inventory_supervisor', 'sites', 'view'),
  ('inventory_supervisor', 'sites', 'edit'),
  ('inventory_supervisor', 'sites', 'import'),
  ('inventory_supervisor', 'sites', 'export'),
  ('inventory_supervisor', 'sites', 'download_documents'),
  ('inventory_supervisor', 'sites_docs', 'view'),
  ('inventory_supervisor', 'sites_docs', 'create'),
  ('inventory_supervisor', 'sites_docs', 'edit'),
  ('inventory_supervisor', 'sites_docs', 'download_documents'),
  ('inventory_supervisor', 'approvals', 'view'),
  ('inventory_supervisor', 'my_work', 'view'),
  ('inventory_supervisor', 'templates', 'view'),
  ('inventory_supervisor', 'templates', 'import'),
  ('inventory_supervisor', 'templates', 'download_documents'),
  ('inventory_supervisor', 'dash_reports', 'view'),
  ('inventory_supervisor', 'absence', 'view'),
  ('inventory_supervisor', 'messages', 'view'),
  ('inventory_supervisor', 'messages', 'create'),
  ('inventory_supervisor', 'announcements', 'view'),
  ('inventory_supervisor', 'registers', 'view'),
  ('inventory_supervisor', 'registers', 'create'),
  ('inventory_supervisor', 'registers', 'edit'),
  ('inventory_supervisor', 'registers', 'import'),
  ('inventory_supervisor', 'registers', 'export'),
  ('inventory_supervisor', 'registers', 'download_documents'),
  ('inventory_supervisor', 'warehouse', 'approve'),
  ('inventory_supervisor', 'warehouse', 'view_audit'),
  ('management_readonly', 'sites', 'view'),
  ('management_readonly', 'sites_docs', 'view'),
  ('management_readonly', 'approvals', 'view'),
  ('management_readonly', 'my_work', 'view'),
  ('management_readonly', 'templates', 'view'),
  ('management_readonly', 'dash_reports', 'view'),
  ('management_readonly', 'dash_reports', 'export'),
  ('management_readonly', 'absence', 'view'),
  ('management_readonly', 'messages', 'view'),
  ('management_readonly', 'messages', 'create'),
  ('management_readonly', 'announcements', 'view'),
  ('management_readonly', 'registers', 'view'),
  ('system_admin', 'sites', 'view'),
  ('system_admin', 'sites', 'create'),
  ('system_admin', 'sites', 'edit'),
  ('system_admin', 'sites', 'delete'),
  ('system_admin', 'sites', 'approve'),
  ('system_admin', 'sites', 'export'),
  ('system_admin', 'sites', 'import'),
  ('system_admin', 'sites', 'download_documents'),
  ('system_admin', 'sites', 'view_audit'),
  ('system_admin', 'sites', 'administer'),
  ('system_admin', 'sites_docs', 'view'),
  ('system_admin', 'sites_docs', 'create'),
  ('system_admin', 'sites_docs', 'edit'),
  ('system_admin', 'sites_docs', 'delete'),
  ('system_admin', 'sites_docs', 'approve'),
  ('system_admin', 'sites_docs', 'export'),
  ('system_admin', 'sites_docs', 'import'),
  ('system_admin', 'sites_docs', 'download_documents'),
  ('system_admin', 'sites_docs', 'view_audit'),
  ('system_admin', 'sites_docs', 'administer'),
  ('system_admin', 'approvals', 'view'),
  ('system_admin', 'approvals', 'create'),
  ('system_admin', 'approvals', 'edit'),
  ('system_admin', 'approvals', 'delete'),
  ('system_admin', 'approvals', 'approve'),
  ('system_admin', 'approvals', 'export'),
  ('system_admin', 'approvals', 'import'),
  ('system_admin', 'approvals', 'download_documents'),
  ('system_admin', 'approvals', 'view_audit'),
  ('system_admin', 'approvals', 'administer'),
  ('system_admin', 'my_work', 'view'),
  ('system_admin', 'my_work', 'create'),
  ('system_admin', 'my_work', 'edit'),
  ('system_admin', 'my_work', 'delete'),
  ('system_admin', 'my_work', 'approve'),
  ('system_admin', 'my_work', 'export'),
  ('system_admin', 'my_work', 'import'),
  ('system_admin', 'my_work', 'download_documents'),
  ('system_admin', 'my_work', 'view_audit'),
  ('system_admin', 'my_work', 'administer'),
  ('system_admin', 'templates', 'view'),
  ('system_admin', 'templates', 'create'),
  ('system_admin', 'templates', 'edit'),
  ('system_admin', 'templates', 'delete'),
  ('system_admin', 'templates', 'approve'),
  ('system_admin', 'templates', 'export'),
  ('system_admin', 'templates', 'import'),
  ('system_admin', 'templates', 'download_documents'),
  ('system_admin', 'templates', 'view_audit'),
  ('system_admin', 'templates', 'administer'),
  ('system_admin', 'dash_reports', 'view'),
  ('system_admin', 'dash_reports', 'create'),
  ('system_admin', 'dash_reports', 'edit'),
  ('system_admin', 'dash_reports', 'delete'),
  ('system_admin', 'dash_reports', 'approve'),
  ('system_admin', 'dash_reports', 'export'),
  ('system_admin', 'dash_reports', 'import'),
  ('system_admin', 'dash_reports', 'download_documents'),
  ('system_admin', 'dash_reports', 'view_audit'),
  ('system_admin', 'dash_reports', 'administer'),
  ('system_admin', 'absence', 'view'),
  ('system_admin', 'absence', 'create'),
  ('system_admin', 'absence', 'edit'),
  ('system_admin', 'absence', 'delete'),
  ('system_admin', 'absence', 'approve'),
  ('system_admin', 'absence', 'export'),
  ('system_admin', 'absence', 'import'),
  ('system_admin', 'absence', 'download_documents'),
  ('system_admin', 'absence', 'view_audit'),
  ('system_admin', 'absence', 'administer'),
  ('system_admin', 'messages', 'view'),
  ('system_admin', 'messages', 'create'),
  ('system_admin', 'messages', 'edit'),
  ('system_admin', 'messages', 'delete'),
  ('system_admin', 'messages', 'approve'),
  ('system_admin', 'messages', 'export'),
  ('system_admin', 'messages', 'import'),
  ('system_admin', 'messages', 'download_documents'),
  ('system_admin', 'messages', 'view_audit'),
  ('system_admin', 'messages', 'administer'),
  ('system_admin', 'announcements', 'view'),
  ('system_admin', 'announcements', 'create'),
  ('system_admin', 'announcements', 'edit'),
  ('system_admin', 'announcements', 'delete'),
  ('system_admin', 'announcements', 'approve'),
  ('system_admin', 'announcements', 'export'),
  ('system_admin', 'announcements', 'import'),
  ('system_admin', 'announcements', 'download_documents'),
  ('system_admin', 'announcements', 'view_audit'),
  ('system_admin', 'announcements', 'administer'),
  ('system_admin', 'registers', 'view'),
  ('system_admin', 'registers', 'create'),
  ('system_admin', 'registers', 'edit'),
  ('system_admin', 'registers', 'delete'),
  ('system_admin', 'registers', 'approve'),
  ('system_admin', 'registers', 'export'),
  ('system_admin', 'registers', 'import'),
  ('system_admin', 'registers', 'download_documents'),
  ('system_admin', 'registers', 'view_audit'),
  ('system_admin', 'registers', 'administer'),
  ('system_admin', 'warehouse', 'view'),
  ('system_admin', 'warehouse', 'create'),
  ('system_admin', 'warehouse', 'edit'),
  ('system_admin', 'warehouse', 'delete'),
  ('system_admin', 'warehouse', 'approve'),
  ('system_admin', 'warehouse', 'export'),
  ('system_admin', 'warehouse', 'import'),
  ('system_admin', 'warehouse', 'download_documents'),
  ('system_admin', 'warehouse', 'view_audit'),
  ('system_admin', 'warehouse', 'administer'),
  ('system_admin', 'audit', 'view'),
  ('system_admin', 'audit', 'create'),
  ('system_admin', 'audit', 'edit'),
  ('system_admin', 'audit', 'delete'),
  ('system_admin', 'audit', 'approve'),
  ('system_admin', 'audit', 'export'),
  ('system_admin', 'audit', 'import'),
  ('system_admin', 'audit', 'download_documents'),
  ('system_admin', 'audit', 'view_audit'),
  ('system_admin', 'audit', 'administer'),
  ('system_admin', 'admin_view', 'view'),
  ('system_admin', 'admin_view', 'create'),
  ('system_admin', 'admin_view', 'edit'),
  ('system_admin', 'admin_view', 'delete'),
  ('system_admin', 'admin_view', 'approve'),
  ('system_admin', 'admin_view', 'export'),
  ('system_admin', 'admin_view', 'import'),
  ('system_admin', 'admin_view', 'download_documents'),
  ('system_admin', 'admin_view', 'view_audit'),
  ('system_admin', 'admin_view', 'administer'),
  ('system_admin', 'admin_screens', 'view'),
  ('system_admin', 'admin_screens', 'create'),
  ('system_admin', 'admin_screens', 'edit'),
  ('system_admin', 'admin_screens', 'delete'),
  ('system_admin', 'admin_screens', 'approve'),
  ('system_admin', 'admin_screens', 'export'),
  ('system_admin', 'admin_screens', 'import'),
  ('system_admin', 'admin_screens', 'download_documents'),
  ('system_admin', 'admin_screens', 'view_audit'),
  ('system_admin', 'admin_screens', 'administer'),
  ('system_admin', 'config', 'view'),
  ('system_admin', 'config', 'create'),
  ('system_admin', 'config', 'edit'),
  ('system_admin', 'config', 'delete'),
  ('system_admin', 'config', 'approve'),
  ('system_admin', 'config', 'export'),
  ('system_admin', 'config', 'import'),
  ('system_admin', 'config', 'download_documents'),
  ('system_admin', 'config', 'view_audit'),
  ('system_admin', 'config', 'administer'),
  ('system_admin', 'admin_matrix', 'view'),
  ('system_admin', 'admin_matrix', 'create'),
  ('system_admin', 'admin_matrix', 'edit'),
  ('system_admin', 'admin_matrix', 'delete'),
  ('system_admin', 'admin_matrix', 'approve'),
  ('system_admin', 'admin_matrix', 'export'),
  ('system_admin', 'admin_matrix', 'import'),
  ('system_admin', 'admin_matrix', 'download_documents'),
  ('system_admin', 'admin_matrix', 'view_audit'),
  ('system_admin', 'admin_matrix', 'administer');
INSERT INTO permission_grants (profile_id, module_key, action)
  SELECT DISTINCT np.id, m.module_key, g.action
  FROM _seed_grid g JOIN _seed_new_profile np ON np.code = g.profile JOIN _seed_mod m ON m.grp = g.grp
ON CONFLICT DO NOTHING;
DROP TABLE pg_temp._seed_grid;
DROP TABLE pg_temp._seed_mod;
DROP TABLE pg_temp._seed_new_profile;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Roles: 6 main roles, 10 sub-roles (CLAUDE.md says 9 but lists 10 names; all 10 are seeded, see report) and the demo role
-- MANAGEMENT (read-only, all regions and modules, cannot hold matrix levels). Sub-roles point at their main role.
-- Defaults: all regions and all modules (visibility defaults to everything; the profile limits the actions).
-- ---------------------------------------------------------------------------------------------------------------------------
INSERT INTO roles (code, name_en, name_ar, description_en, description_ar, parent_role_id, team, default_profile_id,
                   default_all_regions, default_all_modules, can_hold_matrix_levels, sort)
SELECT v.code, v.name_en, v.name_ar, v.desc_en, v.desc_ar, NULL, v.team::"TeamKind",
       (SELECT id FROM permission_profiles WHERE code = v.profile), true, true, v.can_hold, v.sort
FROM (VALUES
  ('PM', 'Project Manager', 'مدير المشروع', 'Owns the project plan, approves Final Closure and sees the whole audit log.', 'يملك خطة المشروع ويعتمد الإغلاق النهائي ويطلع على سجل التدقيق كاملاً.', 'none', 'project_manager', true, 10),
  ('RFD_ACQ_TL', 'RF & Design / Acquisition Team Lead', 'قائد فريق التصميم RF والاستحواذ', 'Leads RF design, microwave and site acquisition; approves Stage 1 and PRE-CW work.', 'يقود تصميم RF والميكروويف واستحواذ المواقع ويعتمد أعمال المرحلة الأولى وما قبل الأعمال المدنية.', 'none', 'team_lead', true, 20),
  ('CW_TL', 'CW Team Lead', 'قائد فريق الأعمال المدنية', 'Leads civil works, power, GECOL and HLC fiber; approves the CW stages.', 'يقود الأعمال المدنية والطاقة والكهرباء والألياف الضوئية ويعتمد مراحل الأعمال المدنية.', 'cw', 'team_lead', true, 30),
  ('TE_TL', 'TE Team Lead', 'قائد فريق التركيبات الفنية (TE)', 'Leads TE installation, integration and handover; approves the TE stages.', 'يقود تركيب المعدات الفنية والتكامل والتسليم ويعتمد مراحل TE.', 'te', 'team_lead', true, 40),
  ('INV_SUP', 'Inventory Supervisor', 'مشرف المخزون', 'Runs the warehouse: delivery notes, returns and stock.', 'يدير المخزن: إشعارات التسليم والمرتجعات والأرصدة.', 'none', 'inventory_supervisor', true, 50),
  ('PROJ_SUPPORT', 'Project Support', 'دعم المشروع', 'Coordinates procurement, registers and project closure paperwork.', 'ينسق المشتريات والسجلات ومستندات إغلاق المشروع.', 'none', 'data_entry', true, 60),
  ('MANAGEMENT', 'Management', 'الإدارة', 'Views the dashboard and progress reports; read-only on all modules and regions. Demo of an admin-defined role.', 'يطلع على لوحة المؤشرات وتقارير التقدم؛ للقراءة فقط على جميع الوحدات والمناطق. مثال على دور يعرّفه المسؤول.', 'none', 'management_readonly', false, 900)
) AS v(code, name_en, name_ar, desc_en, desc_ar, team, profile, can_hold, sort)
ON CONFLICT (code) DO NOTHING;

INSERT INTO roles (code, name_en, name_ar, description_en, description_ar, parent_role_id, team, default_profile_id,
                   default_all_regions, default_all_modules, can_hold_matrix_levels, sort)
SELECT v.code, v.name_en, v.name_ar, v.desc_en, v.desc_ar, (SELECT id FROM roles WHERE code = v.parent), v.team::"TeamKind",
       (SELECT id FROM permission_profiles WHERE code = v.profile), true, true, v.can_hold, v.sort
FROM (VALUES
  ('RF_ENG', 'RF Engineer', 'مهندس RF', 'RF survey, TSSR and LLD.', 'مسح RF وTSSR وLLD.', 'RFD_ACQ_TL', 'none', 'data_entry', true, 110),
  ('MW_ENG', 'MW Engineer', 'مهندس الميكروويف', 'Microwave links, commissioning and alignment.', 'وصلات الميكروويف والتشغيل والمحاذاة.', 'RFD_ACQ_TL', 'none', 'data_entry', true, 120),
  ('ACQ_TEAM', 'Acquisition Team', 'فريق الاستحواذ', 'Site search, candidates, owner contracts and permits.', 'البحث عن المواقع والمرشحين وعقود الملاك والتصاريح.', 'RFD_ACQ_TL', 'none', 'data_entry', true, 130),
  ('POWER_ENG', 'Power Engineer', 'مهندس الطاقة', 'Power design and power-on at site.', 'تصميم الطاقة وتشغيلها في الموقع.', 'CW_TL', 'cw', 'data_entry', true, 210),
  ('GECOL_TEAM', 'GECOL Power Team', 'فريق الكهرباء (GECOL)', 'Requests and follows up the GECOL power connection.', 'طلب ومتابعة توصيل الكهرباء من الشركة العامة للكهرباء.', 'CW_TL', 'cw', 'data_entry', true, 220),
  ('HLC_TEAM', 'HLC Fiber Team', 'فريق الألياف الضوئية (HLC)', 'Requests and follows up the HLC fiber link.', 'طلب ومتابعة وصلة الألياف الضوئية.', 'CW_TL', 'cw', 'data_entry', true, 230),
  ('SITE_ENG_CW', 'Site Engineers (CW)', 'مهندسو المواقع (الأعمال المدنية)', 'Civil works engineers on site; CW MOS, PAC and FAC.', 'مهندسو الأعمال المدنية في الموقع؛ MOS وPAC وFAC.', 'CW_TL', 'cw', 'data_entry', true, 240),
  ('SITE_ENG_TE', 'Site Engineers (TE)', 'مهندسو المواقع (TE)', 'TE engineers on site; installation, integration and on-air follow-up.', 'مهندسو TE في الموقع؛ التركيب والتكامل ومتابعة التشغيل.', 'TE_TL', 'te', 'data_entry', true, 310),
  ('HOTO_ENG', 'HOTO Engineer', 'مهندس التسليم (HOTO)', 'Handover to operations and KPI acceptance follow-up.', 'التسليم للتشغيل ومتابعة قبول مؤشرات الأداء.', 'TE_TL', 'te', 'data_entry', true, 320),
  ('PROC_TEAM', 'Project Procurement Team', 'فريق مشتريات المشروع', 'PR, PO and WO handling for the project.', 'معالجة طلبات الشراء وأوامر الشراء وأوامر العمل.', 'PROJ_SUPPORT', 'none', 'data_entry', true, 410)
) AS v(code, name_en, name_ar, desc_en, desc_ar, parent, team, profile, can_hold, sort)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Default work calendar (weekend Friday + Saturday = NETWORKDAYS.INTL code 7; weekend_days 5,6 with 0 = Sunday) and holidays
-- from db/seed/holidays-2026-2027.csv. Religious dates are tentative until the admin confirms them (CLAUDE.md B12).
-- ---------------------------------------------------------------------------------------------------------------------------
INSERT INTO work_calendars (code, name, weekend_days, is_default, is_active)
SELECT 'std', 'Standard calendar (Friday and Saturday weekend)', ARRAY[5, 6], true, true
WHERE NOT EXISTS (SELECT 1 FROM work_calendars WHERE is_default OR code = 'std')
ON CONFLICT (code) DO NOTHING;

INSERT INTO holidays (calendar_id, date, name, name_ar, kind, tentative, note)
SELECT (SELECT id FROM work_calendars WHERE code = 'std'), v.d::date, v.name_en, v.name_ar, v.kind, v.tentative, v.note
FROM (VALUES
  ('2026-02-17', 'Revolution Day', 'ذكرى ثورة 17 فبراير', 'national', false, NULL),
  ('2026-03-20', 'Eid al-Fitr (day 1)', 'عيد الفطر (اليوم 1)', 'religious', true, '1 Shawwal 1447; confirm on official announcement'),
  ('2026-03-21', 'Eid al-Fitr (day 2)', 'عيد الفطر (اليوم 2)', 'religious', true, 'number of days set by government decree'),
  ('2026-03-22', 'Eid al-Fitr (day 3)', 'عيد الفطر (اليوم 3)', 'religious', true, 'number of days set by government decree'),
  ('2026-05-01', 'Labour Day', 'عيد العمال', 'national', false, NULL),
  ('2026-05-26', 'Day of Arafah', 'يوم عرفة', 'religious', true, '9 Dhu al-Hijjah 1447'),
  ('2026-05-27', 'Eid al-Adha (day 1)', 'عيد الأضحى (اليوم 1)', 'religious', true, '10 Dhu al-Hijjah 1447'),
  ('2026-05-28', 'Eid al-Adha (day 2)', 'عيد الأضحى (اليوم 2)', 'religious', true, NULL),
  ('2026-05-29', 'Eid al-Adha (day 3)', 'عيد الأضحى (اليوم 3)', 'religious', true, NULL),
  ('2026-06-16', 'Islamic New Year', 'رأس السنة الهجرية', 'religious', true, '1 Muharram 1448'),
  ('2026-08-25', 'Prophet''s Birthday', 'المولد النبوي الشريف', 'religious', true, '12 Rabi al-Awwal 1448'),
  ('2026-09-16', 'Martyrs'' Day', 'يوم الشهيد', 'national', false, NULL),
  ('2026-10-23', 'Liberation Day', 'عيد التحرير', 'national', false, NULL),
  ('2026-12-24', 'Independence Day', 'عيد الاستقلال', 'national', false, NULL),
  ('2027-02-17', 'Revolution Day', 'ذكرى ثورة 17 فبراير', 'national', false, NULL),
  ('2027-03-09', 'Eid al-Fitr (day 1)', 'عيد الفطر (اليوم 1)', 'religious', true, '1 Shawwal 1448; confirm on official announcement'),
  ('2027-03-10', 'Eid al-Fitr (day 2)', 'عيد الفطر (اليوم 2)', 'religious', true, NULL),
  ('2027-03-11', 'Eid al-Fitr (day 3)', 'عيد الفطر (اليوم 3)', 'religious', true, NULL),
  ('2027-05-01', 'Labour Day', 'عيد العمال', 'national', false, NULL),
  ('2027-05-15', 'Day of Arafah', 'يوم عرفة', 'religious', true, '9 Dhu al-Hijjah 1448'),
  ('2027-05-16', 'Eid al-Adha (day 1)', 'عيد الأضحى (اليوم 1)', 'religious', true, NULL),
  ('2027-05-17', 'Eid al-Adha (day 2)', 'عيد الأضحى (اليوم 2)', 'religious', true, NULL),
  ('2027-05-18', 'Eid al-Adha (day 3)', 'عيد الأضحى (اليوم 3)', 'religious', true, NULL),
  ('2027-06-06', 'Islamic New Year', 'رأس السنة الهجرية', 'religious', true, '1 Muharram 1449'),
  ('2027-08-14', 'Prophet''s Birthday', 'المولد النبوي الشريف', 'religious', true, '12 Rabi al-Awwal 1449'),
  ('2027-09-16', 'Martyrs'' Day', 'يوم الشهيد', 'national', false, NULL),
  ('2027-10-23', 'Liberation Day', 'عيد التحرير', 'national', false, NULL),
  ('2027-12-24', 'Independence Day', 'عيد الاستقلال', 'national', false, NULL)
) AS v(d, name_en, name_ar, kind, tentative, note)
WHERE EXISTS (SELECT 1 FROM work_calendars WHERE code = 'std')
ON CONFLICT (calendar_id, date) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Workflow definition v1 (ADR 0010). Stable codes: milestones MS1..MS10, gates G2..G10 (gate Gn sits between MS(n-1) and MSn;
-- its date is the previous milestone date, shifted by Suspension/Resumption). master_export_column = Master column of the
-- milestone date / gate date. A task belongs to the stage (milestone) whose number the catalogue gives; Dismantle (track E) is
-- attached to MS10 and does not count toward it. Created as a draft, filled, then published in this transaction.
-- Gate conditions are left NULL: only the default "previous milestone date" rule applies until the condition items are authored.
-- Task condition_rule is left NULL (applies to every site): the catalogue text rules are not in the ADR 0009 rule language yet.
-- SLA rule-set version 1: one sla_rules row per catalogue row that has a min/max, effective 2024-01-01, calendar std, reason 'seed'.
-- changed_by is the nil UUID (no user exists at migration time; sla_rules.changed_by is NOT NULL and has no foreign key).
-- ---------------------------------------------------------------------------------------------------------------------------
DO $seed$
DECLARE wf uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM workflow_definitions WHERE version = 1) THEN
    RAISE NOTICE 'workflow version 1 already exists: workflow seed skipped';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM work_calendars WHERE code = 'std') THEN
    RAISE EXCEPTION 'default work calendar std is missing';
  END IF;

  INSERT INTO workflow_definitions (version, status, effective_from, reason)
  VALUES (1, 'draft', DATE '2024-01-01', 'seed: default workflow (10 milestones, 9 gates)') RETURNING id INTO wf;

  INSERT INTO stage_definitions (workflow_id, code, seq, name_en, name_ar, milestone_name, master_export_column, counts_in_project_status, approval_levels)
  VALUES
    (wf, 'MS1', 1, 'Site Release', 'إطلاق الموقع', 'Site Release', 'V', true, 3),
    (wf, 'MS2', 2, 'PRE-CW Completion', 'اكتمال ما قبل الأعمال المدنية', 'PRE-CW Completion', 'AW', true, 3),
    (wf, 'MS3', 3, 'CW Completion', 'اكتمال الأعمال المدنية', 'CW Completion', 'BP', true, 3),
    (wf, 'MS4', 4, 'Site RFI', 'جاهزية الموقع للتركيب (RFI)', 'Site RFI', 'BZ', true, 3),
    (wf, 'MS5', 5, 'TE Completion', 'اكتمال تركيب TE', 'TE Completion', 'CU', true, 3),
    (wf, 'MS6', 6, 'On-Air', 'التشغيل (On-Air)', 'On-Air', 'DP', true, 3),
    (wf, 'MS7', 7, 'TE PAC', 'القبول الأولي لـ TE (PAC)', 'TE PAC', 'EL', true, 3),
    (wf, 'MS8', 8, 'KPI Acceptance', 'قبول مؤشرات الأداء (KPI)', 'KPI Acceptance', 'ES', true, 3),
    (wf, 'MS9', 9, 'HOTO', 'التسليم والاستلام (HOTO)', 'HOTO', 'EY', true, 3),
    (wf, 'MS10', 10, 'Final Closure', 'الإغلاق النهائي', 'Final Closure', 'FM', false, 3);

  INSERT INTO phase_gate_rules (workflow_id, link_code, seq, name_en, name_ar, from_code, to_code, conditions, min_wd, max_wd, master_export_column)
  VALUES
    (wf, 'G2', 2, 'Pre-CW Readiness', 'جاهزية ما قبل الأعمال المدنية', 'MS1', 'MS2', NULL, 0, 0, 'W'),
    (wf, 'G3', 3, 'CW Readiness', 'جاهزية الأعمال المدنية', 'MS2', 'MS3', NULL, 0, 0, 'AX'),
    (wf, 'G4', 4, 'RFI Readiness', 'جاهزية RFI', 'MS3', 'MS4', NULL, 0, 0, 'BQ'),
    (wf, 'G5', 5, 'TE Installation Readiness', 'جاهزية تركيب TE', 'MS4', 'MS5', NULL, 0, 0, 'CA'),
    (wf, 'G6', 6, 'On-Air Readiness', 'جاهزية التشغيل', 'MS5', 'MS6', NULL, 0, 0, 'CV'),
    (wf, 'G7', 7, 'TE PAC Readiness', 'جاهزية القبول الأولي لـ TE', 'MS6', 'MS7', NULL, 0, 0, 'DQ'),
    (wf, 'G8', 8, 'Cluster Optimization Readiness', 'جاهزية تحسين المجموعة', 'MS7', 'MS8', NULL, 0, 0, 'EM'),
    (wf, 'G9', 9, 'HOTO Readiness', 'جاهزية التسليم والاستلام (HOTO)', 'MS8', 'MS9', NULL, 0, 0, 'ET'),
    (wf, 'G10', 10, 'Final Closure Readiness', 'جاهزية الإغلاق النهائي', 'MS9', 'MS10', NULL, 0, 0, 'EZ');

  INSERT INTO task_definitions (workflow_id, code, stage_id, sort_order, name_en, has_documents, is_milestone_task, counts_toward_milestone,
                                default_external_party, effective_from, reason)
  SELECT wf, v.code, st.id, v.sort_order, v.name_en, v.has_docs, v.is_mile, v.counts, v.party::"ExternalPartyType", DATE '2024-01-01', 'seed'
  FROM (VALUES
    ('A1', 1, 10, 'Site search and first candidate (SAR)', true, false, true, NULL),
    ('A2', 1, 20, 'TSSR approval', true, false, true, NULL),
    ('A3', 1, 30, 'Site acquisition (selected candidate + contract sign-off)', true, false, true, NULL),
    ('A4', 1, 40, 'LLD approval', true, false, true, NULL),
    ('A5', 1, 50, 'MW LOS survey and link budget (HUB / Terminal only)', false, false, true, NULL),
    ('MS1', 1, 60, 'Site Release', false, true, false, NULL),
    ('B1', 2, 10, 'CW PR issued', true, false, true, NULL),
    ('B2', 2, 20, 'PO / WO issued and contractor assigned', true, false, true, NULL),
    ('B3', 2, 30, 'CW access permission', true, false, true, NULL),
    ('B4', 2, 40, 'CW survey', false, false, true, 'cw_contractor'),
    ('B5', 2, 50, 'STA / ST analysis report', true, false, true, 'cw_contractor'),
    ('B6', 2, 60, 'Layout submission', true, false, true, 'cw_contractor'),
    ('B7', 2, 70, 'Layout approval and CW DN', true, false, true, NULL),
    ('MS2', 2, 80, 'PRE-CW Completion', false, true, false, NULL),
    ('B8', 3, 10, 'Tower MOS', true, false, true, 'cw_contractor'),
    ('B9', 3, 20, 'Adaption MOS', true, false, true, 'cw_contractor'),
    ('B10', 3, 30, 'Tower erection items', false, false, true, 'cw_contractor'),
    ('B11', 3, 40, 'Site adaption items', false, false, true, 'cw_contractor'),
    ('MS3', 3, 50, 'CW Completion', false, true, false, NULL),
    ('B13', 4, 10, 'CW PAC (snags cleared)', true, false, true, NULL),
    ('C1', 4, 20, 'GECOL request (PR)', true, false, true, NULL),
    ('C2', 4, 30, 'GECOL Power-On', true, false, true, 'gecol'),
    ('C3', 4, 40, 'HLC fiber request', true, false, true, NULL),
    ('C4', 4, 50, 'HLC fiber installation and TX link test', true, false, true, 'hlc'),
    ('MS4', 4, 60, 'Site RFI', false, true, false, NULL),
    ('D1', 5, 10, 'TE access permission', true, false, true, NULL),
    ('D2', 5, 20, 'TE survey and vendor assignment', true, false, true, 'te_vendor'),
    ('D3', 5, 30, 'TE DN submission', true, false, true, 'te_vendor'),
    ('D4', 5, 40, 'TE DN approval', true, false, true, NULL),
    ('D4b', 5, 50, 'TE dispatch complete', false, false, true, NULL),
    ('D5', 5, 60, 'TE MOS', true, false, true, 'te_vendor'),
    ('D6', 5, 70, 'TE installation items', false, false, true, 'te_vendor'),
    ('MS5', 5, 80, 'TE Completion', false, true, false, NULL),
    ('D7', 6, 10, 'Commissioning', true, false, true, 'te_vendor'),
    ('D8', 6, 20, 'MW alignment', true, false, true, 'te_vendor'),
    ('D9', 6, 30, 'Integration', true, false, true, 'te_vendor'),
    ('D10a', 6, 40, 'MOP approval', true, false, true, 'te_vendor'),
    ('D10b', 6, 50, 'Cutover window approval', true, false, true, NULL),
    ('D10', 6, 60, 'On-Air (cutover for Swap)', true, false, true, 'te_vendor'),
    ('MS6', 6, 70, 'On-Air', false, true, false, NULL),
    ('D11', 7, 10, 'SSV', true, false, true, 'te_vendor'),
    ('D12', 7, 20, 'HWID', true, false, true, 'te_vendor'),
    ('D13', 7, 30, 'EIR (site standalone test)', true, false, true, 'te_vendor'),
    ('D14', 7, 40, 'PAT (network test) and NOC alarm verification', true, false, true, 'te_vendor'),
    ('D15', 7, 50, 'As-Built', true, false, true, 'te_vendor'),
    ('D16', 7, 60, 'TE PAC', true, false, true, NULL),
    ('MS7', 7, 70, 'TE PAC', false, true, false, NULL),
    ('F1', 8, 10, 'Cluster optimization', true, false, true, NULL),
    ('F2', 8, 20, 'KPI acceptance source', true, false, true, NULL),
    ('MS8', 8, 30, 'KPI Acceptance', false, true, false, NULL),
    ('D17', 9, 10, 'Launch, material reconciliation, HOTO package, O&M acceptance', true, false, true, NULL),
    ('MS9', 9, 20, 'HOTO', false, true, false, NULL),
    ('B14', 10, 10, 'CW DLP (warranty) period', false, false, false, NULL),
    ('B15', 10, 20, 'CW FAC', true, false, true, NULL),
    ('D18', 10, 30, 'TE FAC', true, false, true, NULL),
    ('Z1', 10, 40, 'Contractual obligations closure and closure approval', true, false, true, NULL),
    ('MS10', 10, 50, 'Final Closure', false, true, false, NULL),
    ('E1', 10, 60, 'Ready for dismantle (RFD)', false, false, false, NULL),
    ('E2', 10, 70, 'Dismantle (CW and TE)', true, false, false, NULL),
    ('E3', 10, 80, 'Return to warehouse (CW RN / TE RN)', true, false, false, NULL)
  ) AS v(code, stage_seq, sort_order, name_en, has_docs, is_mile, counts, party)
  JOIN stage_definitions st ON st.workflow_id = wf AND st.seq = v.stage_seq;

  -- Predecessors (a gate named as predecessor in the catalogue is replaced by the milestone it follows).
  INSERT INTO task_predecessors (task_def_id, predecessor_id)
  SELECT t.id, p.id
  FROM (VALUES
    ('A2', 'A1'),
    ('A3', 'A1'),
    ('A4', 'A2'),
    ('A5', 'A2'),
    ('MS1', 'A2'),
    ('MS1', 'A3'),
    ('MS1', 'A4'),
    ('MS1', 'A5'),
    ('B1', 'MS1'),
    ('B2', 'B1'),
    ('B3', 'B2'),
    ('B4', 'B3'),
    ('B5', 'B4'),
    ('B6', 'B4'),
    ('B6', 'B5'),
    ('B7', 'B6'),
    ('MS2', 'B1'),
    ('MS2', 'B2'),
    ('MS2', 'B3'),
    ('MS2', 'B4'),
    ('MS2', 'B5'),
    ('MS2', 'B6'),
    ('MS2', 'B7'),
    ('B8', 'B7'),
    ('B9', 'B7'),
    ('B10', 'B8'),
    ('B11', 'B9'),
    ('MS3', 'B10'),
    ('MS3', 'B11'),
    ('B13', 'MS3'),
    ('C1', 'B1'),
    ('C2', 'C1'),
    ('C3', 'B1'),
    ('C4', 'C3'),
    ('MS4', 'MS3'),
    ('MS4', 'B13'),
    ('MS4', 'C2'),
    ('MS4', 'C4'),
    ('D1', 'MS4'),
    ('D2', 'D1'),
    ('D3', 'D2'),
    ('D4', 'D3'),
    ('D4b', 'D4'),
    ('D5', 'D4b'),
    ('D6', 'D5'),
    ('MS5', 'D6'),
    ('D7', 'MS5'),
    ('D8', 'D7'),
    ('D9', 'D8'),
    ('D10a', 'D9'),
    ('D10b', 'D10a'),
    ('D10', 'D9'),
    ('D10', 'D10b'),
    ('MS6', 'D7'),
    ('MS6', 'D8'),
    ('MS6', 'D9'),
    ('MS6', 'D10'),
    ('D11', 'MS6'),
    ('D12', 'MS6'),
    ('D13', 'D12'),
    ('D14', 'D13'),
    ('D15', 'D14'),
    ('D16', 'D15'),
    ('D16', 'D11'),
    ('MS7', 'D11'),
    ('MS7', 'D12'),
    ('MS7', 'D13'),
    ('MS7', 'D14'),
    ('MS7', 'D15'),
    ('MS7', 'D16'),
    ('F1', 'MS7'),
    ('F2', 'F1'),
    ('MS8', 'F2'),
    ('D17', 'MS8'),
    ('MS9', 'D17'),
    ('B14', 'B13'),
    ('B15', 'B14'),
    ('D18', 'MS7'),
    ('Z1', 'B15'),
    ('Z1', 'D18'),
    ('Z1', 'MS9'),
    ('MS10', 'Z1'),
    ('E2', 'E1'),
    ('E3', 'E2')
  ) AS v(code, pred)
  JOIN task_definitions t ON t.workflow_id = wf AND t.code = v.code
  JOIN task_definitions p ON p.workflow_id = wf AND p.code = v.pred;

  -- SLA rule-set v1 (min = target/green, max = limit, working days of calendar std).
  INSERT INTO sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, reason, changed_by)
  SELECT t.id, v.mn, v.mx, v.start_event, NULL, NULL, (SELECT id FROM work_calendars WHERE code = 'std'), DATE '2024-01-01',
         'seed: SLA rule-set v1 (' || v.sla_code || ')', '00000000-0000-0000-0000-000000000000'::uuid
  FROM (VALUES
    ('A1', 10, 20, 'Search Ring Received Date (RF & Design)', 'A-1'),
    ('A2', 1, 2, 'TSSR Submitted Date (RF & Design)', 'A-3'),
    ('B1', 0, 1, 'Site Release (MS1)', 'B01 (planning link)'),
    ('B2', 1, 2, 'PR Date (PR-PO); In-House: none (ASSUMPTION)', 'B-2'),
    ('B3', 1, 2, 'PO / WO Date (PR-PO)', 'B-3'),
    ('B4', 1, 2, 'CW Access Date (AL)', 'B-4'),
    ('B5', 1, 2, 'CW Survey Actual (AO)', 'B-5'),
    ('B6', 1, 2, 'Master AR if analysis exists, else AO (D47)', 'B-6'),
    ('B7', 1, 2, 'Layout Submission (AR)', 'B-7'),
    ('B8', 1, 2, 'Layout Approval (AS)', 'B-8'),
    ('B9', 1, 2, 'Layout Approval (AS)', 'B-9'),
    ('B10', 14, 21, 'CW MOS Actual (AZ)', 'B-10a | B-10b'),
    ('B11', 4, 8, 'CW MOS Actual (AZ)', 'B-11'),
    ('B13', 1, 3, 'CW Completion (BP)', 'B-13'),
    ('C1', 0, 1, 'CW PR / WO date (D38); Site Release if no CW', 'B02 (planning link)'),
    ('C2', 7, 10, 'GECOL PR Date', 'C-2'),
    ('C3', 0, 1, 'CW PR / WO date (D38); Site Release if no CW', 'B03 (planning link)'),
    ('C4', 7, 10, 'HLC Request Date', 'C-4'),
    ('MS4', 1, 1, 'RFI Readiness (BQ)', 'RFI'),
    ('D1', 3, 5, 'Site RFI date (MS4)', 'D-1'),
    ('D2', 1, 2, 'TE Access Date (CB)', 'D-2'),
    ('D3', 1, 2, 'TE Survey Date (CC)', 'D-3'),
    ('D4', 1, 2, 'TE DN Submitted (CG)', 'D-4'),
    ('D4b', 0, 1, 'TE DN Approved (CH)', 'B04 (planning link)'),
    ('D5', 1, 1, 'TE Dispatch Complete Date (D59)', 'D-5'),
    ('D6', 3, 5, 'TE MOS Actual (CJ)', 'D-6'),
    ('D7', 1, 1, 'TE Actual End (CS)', 'D-7'),
    ('D8', 1, 1, 'Commissioning Date (CW)', 'D-8'),
    ('D9', 1, 1, 'MW Alignment Date (Commissioning if no MW)', 'D-9'),
    ('D10a', 1, 1, 'MOP Submitted Date (DB)', 'S-1'),
    ('D10b', 1, 1, 'Change Control Cutover Window Request Date', 'S-2'),
    ('D10', 1, 1, 'Integration Date (DA)', 'D-10'),
    ('MS6', 8, 12, 'TE MOS Actual (CJ)', 'E2E-D1'),
    ('D11', 3, 5, 'On-Air Actual', 'D-11'),
    ('D12', 1, 1, 'On-Air Actual', 'D-12'),
    ('D13', 3, 5, 'HWID Date (DT)', 'D-13'),
    ('D14', 3, 5, 'EIR Date (DY)', 'D-14'),
    ('D15', 1, 2, 'PAT Date (EE)', 'D-15'),
    ('D16', 5, 10, 'MAX(As-Built Date EF, SSV Date DR)', 'D-16'),
    ('F1', 1, 5, 'TE PAC (MS7)', 'B05 (planning link)'),
    ('D17', 3, 5, 'KPI Acceptance (MS8)', 'D-17'),
    ('MS9', 30, 51, 'TE Access Date (CB)', 'E2E-D2'),
    ('B15', 3, 10, 'CW DLP End (FB)', 'B-15'),
    ('D18', 3, 10, 'TE DLP End (FG = EDATE(TE PAC, 12))', 'B06 (planning link)'),
    ('Z1', 1, 3, 'Latest of FAC / HOTO', 'B07 (planning link)'),
    ('E2', 1, 1, 'On-Air (cutover) for Cold Swap', 'S-5 (Cold Swap only)')
  ) AS v(code, mn, mx, start_event, sla_code)
  JOIN task_definitions t ON t.workflow_id = wf AND t.code = v.code;

  UPDATE workflow_definitions SET status = 'published' WHERE id = wf;
END $seed$;
