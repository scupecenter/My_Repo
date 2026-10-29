-- Synthetic baseline for the security suite (run as the superuser, a member of pmis_migrator, in the scratch database).
-- Every name, e-mail (example.test), phone (+218910000001 ...) and employee ID here is fictional.
-- Direct inserts use the seeding role (0003). Everything else goes through the real functions as the System Admin
-- (bootstrap, idm_*, msg_*, ann_*), so the baseline is produced by the paths the application uses.
--
-- Fixed user ids: the cases refer to them through the {{NAME}} placeholders recorded in secsuite_ids.

-- Regions (the reference seed is not part of the migrations).
INSERT INTO regions (id, code, name_en) VALUES
  (1, 'TRI', 'Tripoli'), (2, 'MID', 'Middle'), (3, 'WM', 'WM'), (4, 'ZAW', 'Zawia'),
  (5, 'BEN', 'Benghazi'), (6, 'GM', 'GM'), (7, 'SEB', 'Sebha')
ON CONFLICT (id) DO NOTHING;

-- Synthetic password hash (a PHC string with the argon2id prefix, which the table check requires). Nothing in this suite
-- verifies it; the cases never log in with it.
INSERT INTO secsuite_ids (name, value) VALUES ('HASH', '$argon2id$v=19$m=65536,t=3,p=1$c2VjLXN1aXRlLXNhbHQ$c2VjLXN1aXRlLWZpeHR1cmUtaGFzaA');

INSERT INTO secsuite_ids (name, value) VALUES
  ('ADMIN',    '00000000-0000-4000-8000-00000000a001'),
  ('ALICE',    '00000000-0000-4000-8000-00000000a002'),
  ('BOB',      '00000000-0000-4000-8000-00000000a003'),
  ('CAROL',    '00000000-0000-4000-8000-00000000a004'),
  ('DEL_ALL',  '00000000-0000-4000-8000-00000000a005'),
  ('DEL_TRI',  '00000000-0000-4000-8000-00000000a006'),
  ('DEL_RD',   '00000000-0000-4000-8000-00000000a007'),
  ('ANN_TRI',  '00000000-0000-4000-8000-00000000a008'),
  ('DISABLED', '00000000-0000-4000-8000-00000000a009'),
  ('DELETED',  '00000000-0000-4000-8000-00000000a010');

-- The installer's System Admin starts as a pending row; idm_bootstrap_admin activates it and adds it to System Admins.
INSERT INTO users (id, email, display_name, employee_id, phone, status, updated_at) VALUES
  ('00000000-0000-4000-8000-00000000a001', 'admin.sec@example.test', 'Sec Admin (synthetic)', '0001', '+218910000001', 'pending_assignment', now());

INSERT INTO users (id, email, display_name, employee_id, phone, status, updated_at) VALUES
  ('00000000-0000-4000-8000-00000000a002', 'alice.sec@example.test',  'Alice Synthetic',   '1001', '+218910000002', 'active', now()),
  ('00000000-0000-4000-8000-00000000a003', 'bob.sec@example.test',    'Bob Synthetic',     '1002', '+218910000003', 'active', now()),
  ('00000000-0000-4000-8000-00000000a004', 'carol.sec@example.test',  'Carol Synthetic',   '1003', '+218910000004', 'active', now()),
  ('00000000-0000-4000-8000-00000000a005', 'delall.sec@example.test', 'Delegate All',      '1004', '+218910000005', 'active', now()),
  ('00000000-0000-4000-8000-00000000a006', 'deltri.sec@example.test', 'Delegate Tripoli',  '1005', '+218910000006', 'active', now()),
  ('00000000-0000-4000-8000-00000000a007', 'delrd.sec@example.test',  'Delegate Redeleg.', '1006', '+218910000007', 'active', now()),
  ('00000000-0000-4000-8000-00000000a008', 'anntri.sec@example.test', 'Announce Tripoli',  '1007', '+218910000008', 'active', now()),
  ('00000000-0000-4000-8000-00000000a009', 'disabled.sec@example.test', 'Disabled Synthetic', '1008', '+218910000009', 'active', now()),
  ('00000000-0000-4000-8000-00000000a010', 'deleted.sec@example.test',  'Deleted Synthetic',  '1009', '+218910000010', 'active', now());

INSERT INTO local_credentials (user_id, password_hash, must_change, enabled)
SELECT id, (SELECT value FROM secsuite_ids WHERE name = 'HASH'), false, true
FROM users WHERE id <> '00000000-0000-4000-8000-00000000a001';

-- The installer path. Only a member of pmis_migrator may call it (the function checks session_user).
SELECT idm_bootstrap_admin('admin.sec@example.test', 'Sec Admin (synthetic)', '0001', '+218910000001',
  (SELECT value FROM secsuite_ids WHERE name = 'HASH'));

-- From here on the System Admin acts through the application path.
SET app.user_id = '00000000-0000-4000-8000-00000000a001';

INSERT INTO secsuite_ids SELECT 'SYSADMINS', id::text FROM groups WHERE is_system_admins;
INSERT INTO secsuite_ids SELECT 'REVIEWERS',
  idm_group_save(NULL, 'Test Reviewers (synthetic)', 'Synthetic group for the security suite', true, 'Fixture group')::text;

INSERT INTO secsuite_ids SELECT 'ROLE_CW',
  idm_role_save(NULL, 'SEC_CW_TL', 'CW Team Lead (synthetic)', NULL, NULL, NULL, NULL, 'cw', NULL, false, false, true, 1, true,
    'Fixture role')::text;
INSERT INTO secsuite_ids SELECT 'ROLE_TE',
  idm_role_save(NULL, 'SEC_TE_ENG', 'Site Engineers TE (synthetic)', NULL, NULL, NULL, NULL, 'te', NULL, false, false, true, 2, true,
    'Fixture role')::text;

SELECT idm_set_user_org('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-00000000a003', NULL,
  'Fixture reporting line');

-- Alice holds one assignment: CW Team Lead, entry, Tripoli, module sites.
SELECT idm_assign('00000000-0000-4000-8000-00000000a002', (SELECT value::uuid FROM secsuite_ids WHERE name = 'ROLE_CW'),
  'entry', 'cw', NULL, NULL, true, false, ARRAY[1], false, ARRAY['sites'], NULL, 'Fixture assignment');

-- Delegations, all made by the System Admin.
INSERT INTO secsuite_ids SELECT 'DLG_ALL', idm_delegate('user', '00000000-0000-4000-8000-00000000a005', NULL, NULL, false,
  '[{"module":"users","action":"create"},{"module":"users","action":"edit"},{"module":"users","action":"delete"},
    {"module":"assignments","action":"create"},{"module":"assignments","action":"edit"},{"module":"assignments","action":"delete"},
    {"module":"groups","action":"create"},{"module":"groups","action":"edit"}]'::jsonb,
  true, NULL, NULL, NULL, false, NULL, 'Fixture delegation, all regions')::text;

INSERT INTO secsuite_ids SELECT 'DLG_RD', idm_delegate('user', '00000000-0000-4000-8000-00000000a007', NULL, NULL, false,
  '[{"module":"users","action":"edit"}]'::jsonb, true, NULL, NULL, NULL, true, NULL,
  'Fixture delegation that may re-delegate')::text;

INSERT INTO secsuite_ids SELECT 'DLG_TRI', idm_delegate('user', '00000000-0000-4000-8000-00000000a006', NULL, NULL, false,
  '[{"module":"users","action":"edit"},{"module":"assignments","action":"create"},{"module":"assignments","action":"edit"}]'::jsonb,
  false, ARRAY[1], NULL, NULL, false, NULL, 'Fixture delegation, Tripoli only')::text;

INSERT INTO secsuite_ids SELECT 'DLG_ANN', idm_delegate('user', '00000000-0000-4000-8000-00000000a008', NULL, NULL, false,
  '[{"module":"announcements","action":"create"}]'::jsonb, false, ARRAY[1], NULL, NULL, false, NULL,
  'Fixture delegation, Tripoli only, announcements')::text;

-- Two accounts used by the lookup and the deletion cases. Both start active, then the admin changes them.
SELECT idm_set_user_status('00000000-0000-4000-8000-00000000a009', 'disabled', 'Fixture: disabled account');
SELECT idm_delete_user('00000000-0000-4000-8000-00000000a010', 'Fixture: deleted account');

-- Messages: Alice may write to her manager, Bob. Bob replies. Carol is not part of this thread.
SET app.user_id = '00000000-0000-4000-8000-00000000a002';
INSERT INTO secsuite_ids SELECT 'T_ALICE_BOB',
  msg_start('00000000-0000-4000-8000-00000000a003', 'Synthetic thread', 'Synthetic opening message')::text;
SET app.user_id = '00000000-0000-4000-8000-00000000a003';
SELECT msg_reply((SELECT value::uuid FROM secsuite_ids WHERE name = 'T_ALICE_BOB'), 'Synthetic reply');

-- Announcements: A goes to Alice and Carol, B to Carol only, C to Alice and Carol (nobody has answered C).
SET app.user_id = '00000000-0000-4000-8000-00000000a001';
INSERT INTO secsuite_ids SELECT 'ANN_A', ann_send('Synthetic notice A', 'Synthetic body A', false,
  ARRAY['00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-00000000a004']::uuid[], NULL, NULL, NULL)::text;
INSERT INTO secsuite_ids SELECT 'ANN_B', ann_send('Synthetic notice B', 'Synthetic body B', false,
  ARRAY['00000000-0000-4000-8000-00000000a004']::uuid[], NULL, NULL, NULL)::text;
INSERT INTO secsuite_ids SELECT 'ANN_C', ann_send('Synthetic notice C', 'Synthetic body C', false,
  ARRAY['00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-00000000a004']::uuid[], NULL, NULL, NULL)::text;

SET app.user_id = '00000000-0000-4000-8000-00000000a002';
SELECT ann_respond((SELECT value::uuid FROM secsuite_ids WHERE name = 'ANN_A'), 'agree', NULL);
SET app.user_id = '00000000-0000-4000-8000-00000000a004';
SELECT ann_respond((SELECT value::uuid FROM secsuite_ids WHERE name = 'ANN_A'), 'disagree', 'Synthetic note from Carol');

-- Region-scoped rows for the row-level security cases: one cluster in Tripoli, one in Benghazi (seeding path).
INSERT INTO clusters (cluster_code, region_id, is_global) VALUES ('SEC-TRI-01', 1, false), ('SEC-BEN-01', 5, false);

RESET app.user_id;
