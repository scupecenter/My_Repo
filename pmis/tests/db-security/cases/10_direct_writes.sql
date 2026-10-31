-- Direct writes from the application role. The application role must not write identity, credential, department,
-- message or announcement tables directly, whatever the session says. Every case runs as Alice (an ordinary, active user)
-- with her normal region. Every refusal is SQLSTATE 42501 (insufficient privilege, from a missing grant or a backstop).

-- Identity: users
-- @case DW-01
-- @title INSERT a new user row
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO users (email, display_name, status) VALUES ('forged.admin@example.test', 'Forged Admin (synthetic)', 'active');
-- @end

-- @case DW-02
-- @title UPDATE a user's status (reactivate the disabled account)
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE users SET status = 'active' WHERE id = '{{DISABLED}}';
-- @end

-- @case DW-03
-- @title DELETE a user row
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM users WHERE id = '{{CAROL}}';
-- @end

-- @case DW-04
-- @title UPDATE the manager link of another user (a route to message and visibility rights)
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE users SET manager_id = '{{ALICE}}' WHERE id = '{{CAROL}}';
-- @end

-- @case DW-05
-- @title UPDATE is_break_glass on her own row
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE users SET is_break_glass = true WHERE id = '{{ALICE}}';
-- @end

-- @case DW-06
-- @title TRUNCATE users
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
TRUNCATE users;
-- @end

-- Identity: user_role_assignments
-- @case DW-07
-- @title INSERT an admin-level assignment for herself
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO user_role_assignments (user_id, role_id, permission_level, team, all_regions, all_modules)
VALUES ('{{ALICE}}', '{{ROLE_CW}}', 'admin', 'cw', true, true);
-- @end

-- @case DW-08
-- @title UPDATE an assignment's level to admin
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE user_role_assignments SET permission_level = 'admin';
-- @end

-- @case DW-09
-- @title DELETE every assignment
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM user_role_assignments;
-- @end

-- @case DW-10
-- @title INSERT a permission profile link for herself (user_role_assignment_profiles)
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO user_role_assignment_profiles (assignment_id, profile_id) VALUES (gen_random_uuid(), gen_random_uuid());
-- @end

-- Identity: groups and group_members
-- @case DW-11
-- @title INSERT herself into the System Admins group
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO group_members (group_id, user_id) VALUES ('{{SYSADMINS}}', '{{ALICE}}');
-- @end

-- @case DW-12
-- @title DELETE the System Admins members
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM group_members WHERE group_id = '{{SYSADMINS}}';
-- @end

-- @case DW-13
-- @title INSERT a new System Admins group
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO groups (name, is_system_admins, is_active) VALUES ('Forged admins', true, true);
-- @end

-- @case DW-14
-- @title UPDATE an ordinary group into the admin group
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE groups SET is_system_admins = true WHERE id = '{{REVIEWERS}}';
-- @end

-- @case DW-15
-- @title DELETE a group
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM groups WHERE id = '{{REVIEWERS}}';
-- @end

-- Identity: delegations and delegation_grants
-- @case DW-16
-- @title INSERT a full delegation to herself
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO delegations (from_user_id, target_kind, target_user_id, is_full, all_regions)
VALUES ('{{ALICE}}', 'user', '{{ALICE}}', true, true);
-- @end

-- @case DW-17
-- @title UPDATE a delegation back to not revoked
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE delegations SET revoked = false;
-- @end

-- @case DW-18
-- @title DELETE a delegation
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM delegations;
-- @end

-- @case DW-19
-- @title INSERT a delegation grant for another delegate
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO delegation_grants (delegation_id, module_key, action) VALUES ('{{DLG_TRI}}', 'users', 'delete');
-- @end

-- Identity: roles, permission_profiles, permission_grants
-- @case DW-20
-- @title INSERT a role
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO roles (code, name_en, team) VALUES ('FORGED_ROLE', 'Forged role', 'none');
-- @end

-- @case DW-21
-- @title UPDATE a role to inactive or to a new default profile
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE roles SET is_active = false;
-- @end

-- @case DW-22
-- @title DELETE a role
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM roles;
-- @end

-- @case DW-23
-- @title INSERT a permission profile
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO permission_profiles (code, name_en) VALUES ('FORGED_PROFILE', 'Forged profile');
-- @end

-- @case DW-24
-- @title INSERT a permission grant
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO permission_grants (profile_id, module_key, action) VALUES (gen_random_uuid(), 'users', 'delete');
-- @end

-- @case DW-25
-- @title UPDATE a permission grant
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE permission_grants SET action = 'delete';
-- @end

-- @case DW-26
-- @title DELETE field permission rules
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM field_permissions;
-- @end

-- Local credentials
-- @case DW-27
-- @title INSERT a password row for herself
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO local_credentials (user_id, password_hash, must_change) VALUES ('{{ALICE}}', '{{HASH}}', false);
-- @end

-- @case DW-28
-- @title UPDATE the password hash of another user
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE local_credentials SET password_hash = '{{HASH}}', must_change = false WHERE user_id = '{{CAROL}}';
-- @end

-- @case DW-29
-- @title DELETE a password row
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM local_credentials WHERE user_id = '{{CAROL}}';
-- @end

-- Departments
-- @case DW-30
-- @title INSERT a department
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO departments (code, name_en) VALUES ('FORGED', 'Forged department');
-- @end

-- @case DW-31
-- @title UPDATE a department
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE departments SET is_active = false;
-- @end

-- @case DW-32
-- @title DELETE a department
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM departments;
-- @end

-- Messages
-- @case DW-33
-- @title INSERT a thread
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO message_threads (subject, created_by) VALUES ('Forged thread', '{{ALICE}}');
-- @end

-- @case DW-34
-- @title INSERT a participant into Alice's thread, so that Carol could read it
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO message_participants (thread_id, user_id) VALUES ('{{T_ALICE_BOB}}', '{{CAROL}}');
-- @end

-- @case DW-35
-- @title INSERT a message into a thread directly
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO messages (thread_id, author_id, body, is_original) VALUES ('{{T_ALICE_BOB}}', '{{ALICE}}', 'Forged', false);
-- @end

-- @case DW-36
-- @title UPDATE the body of a message after it was sent
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE messages SET body = 'Edited after sending';
-- @end

-- @case DW-37
-- @title DELETE messages
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM messages;
-- @end

-- @case DW-38
-- @title DELETE a thread
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM message_threads;
-- @end

-- Announcements
-- @case DW-39
-- @title INSERT an announcement
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO announcements (title, body, audience_all, created_by) VALUES ('Forged notice', 'Forged body', true, '{{ALICE}}');
-- @end

-- @case DW-40
-- @title UPDATE an announcement
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE announcements SET title = 'Edited';
-- @end

-- @case DW-41
-- @title DELETE an announcement
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM announcements;
-- @end

-- @case DW-42
-- @title INSERT a target on an announcement
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO announcement_targets (announcement_id, kind, target_id) VALUES ('{{ANN_A}}', 'user', '{{ALICE}}');
-- @end

-- @case DW-43
-- @title INSERT herself as a recipient of notice B, which was not sent to her
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO announcement_recipients (announcement_id, user_id) VALUES ('{{ANN_B}}', '{{ALICE}}');
-- @end

-- @case DW-44
-- @title DELETE recipients of an announcement
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM announcement_recipients;
-- @end

-- @case DW-45
-- @title INSERT an answer to notice B directly, bypassing ann_respond
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO announcement_responses (announcement_id, user_id, decision, note) VALUES ('{{ANN_B}}', '{{ALICE}}', 'agree', NULL);
-- @end

-- @case DW-46
-- @title UPDATE an answer (Carol's disagreement with note) to agree
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE announcement_responses SET decision = 'agree', note = NULL WHERE announcement_id = '{{ANN_A}}';
-- @end

-- @case DW-47
-- @title DELETE an answer
-- @category direct-writes
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM announcement_responses WHERE announcement_id = '{{ANN_A}}';
-- @end

-- Audit log (append-only, LG-02)
-- @case AL-01
-- @title UPDATE an audit row
-- @category audit-log
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE audit_log SET reason = 'rewritten by an admin';
-- @end

-- @case AL-02
-- @title DELETE audit rows
-- @category audit-log
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
DELETE FROM audit_log;
-- @end

-- @case AL-03
-- @title TRUNCATE the audit log
-- @category audit-log
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
TRUNCATE audit_log;
-- @end

-- @case AL-04
-- @title Hide the bootstrap row by clearing its actor
-- @category audit-log
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE audit_log SET actor_id = NULL WHERE action = 'admin_bootstrapped';
-- @end
