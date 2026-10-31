-- Forged session settings. A session sets app.region_ids = '*' (all regions) without being an admin. Every identity
-- write must still be refused, because the functions re-derive the actor's rights from the tables, not from the setting.
-- The first case has no actor at all. Refusals name the missing right (see the message fragment).

-- @case FS-01
-- @title Forged all-regions setting with no signed-in user: INSERT into users
-- @category forged-settings
-- @region *
-- @expect error 42501 permission denied
INSERT INTO users (email, display_name, status) VALUES ('forged.anon@example.test', 'Forged anonymous (synthetic)', 'active');
-- @end

-- @case FS-02
-- @title Forged all-regions setting as Alice: idm_assign of an admin-level role to Carol
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 System Admin or a delegation covering assignments.create required
SELECT idm_assign('{{CAROL}}', '{{ROLE_CW}}', 'admin', 'cw', NULL, NULL, false, true, NULL, true, NULL, NULL, 'Forged by SQL');
-- @end

-- @case FS-03
-- @title Forged all-regions setting as Alice: suspend Carol
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT idm_set_user_status('{{CAROL}}', 'suspended', 'Forged by SQL');
-- @end

-- @case FS-04
-- @title Forged all-regions setting as Alice: soft-delete Carol
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 System Admin or a delegation covering users.delete required
SELECT idm_delete_user('{{CAROL}}', 'Forged by SQL');
-- @end

-- @case FS-05
-- @title Forged all-regions setting as Alice: add herself to the System Admins group
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 System Admin or a delegation covering groups.edit required
SELECT idm_group_add_member('{{SYSADMINS}}', '{{ALICE}}', 'Forged by SQL');
-- @end

-- @case FS-06
-- @title Forged all-regions setting as Alice: create a local account
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 System Admin or a delegation covering users.create required
SELECT idm_create_local_user('forged.user@example.test', 'Forged user (synthetic)', '1099', NULL, '{{HASH}}', 'Forged by SQL');
-- @end

-- @case FS-07
-- @title Forged all-regions setting as Alice: send an announcement to everyone
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 System Admin or a delegation of announcements.create required
SELECT ann_send('Forged notice', 'Forged body', true, NULL, NULL, NULL, NULL);
-- @end

-- @case FS-08
-- @title Forged all-regions setting as Alice: change Alice's manager link (identity org data)
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT idm_set_user_org('{{ALICE}}', NULL, NULL, 'Forged by SQL');
-- @end

-- @case FS-09
-- @title Forged all-regions setting as Alice: create a department
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT idm_department_save(NULL, 'FORGED', 'Forged department', NULL, true, 'Forged by SQL');
-- @end

-- @case FS-10
-- @title Forged all-regions setting with no signed-in user: idm_set_user_status
-- @category forged-settings
-- @region *
-- @expect error 42501 no signed-in actor
SELECT idm_set_user_status('{{CAROL}}', 'suspended', 'Forged by SQL');
-- @end

-- @case FS-11
-- @title The installer function is not granted to the application role
-- @category forged-settings
-- @actor ALICE
-- @region *
-- @expect error 42501 permission denied
SELECT idm_bootstrap_admin('forged.root@example.test', 'Forged root (synthetic)', '1098', NULL, '{{HASH}}');
-- @end
