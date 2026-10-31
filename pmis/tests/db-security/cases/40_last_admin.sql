-- The last active System Admin. The fixture has exactly one active admin: the System Admin. The cases try to remove that
-- last admin by a status change, a group removal, deactivating the admin group, or a soft delete, both as the admin (the
-- database trigger is the backstop) and as a delegate (refused before the trigger). SET CONSTRAINTS ALL IMMEDIATE makes
-- the trigger fire at the statement. The message names the backstop when it is the trigger that refuses.

-- @case LA-01
-- @title The only admin removes himself from the System Admins group (trigger: at least one admin must remain)
-- @category last-admin
-- @actor ADMIN
-- @region *
-- @expect error 23514 at least one active System Admin must remain
SELECT idm_group_remove_member('{{SYSADMINS}}', '{{ADMIN}}', 'Remove the last admin');
-- @end

-- @case LA-02
-- @title The only admin deactivates the System Admins group (refused by the admin-group check, or by the trigger at commit)
-- @category last-admin
-- @actor ADMIN
-- @region *
-- @expect error 23514|42501 this group is the admin group|at least one active System Admin must remain
SELECT idm_group_save('{{SYSADMINS}}', 'System Admins', 'Deactivated by the suite', false, 'Deactivate the admin group');
-- @end

-- @case LA-03
-- @title The only admin suspends himself (self-change refused)
-- @category last-admin
-- @actor ADMIN
-- @region *
-- @expect error 42501 you cannot change your own status
SELECT idm_set_user_status('{{ADMIN}}', 'suspended', 'Self suspend');
-- @end

-- @case LA-04
-- @title The only admin soft-deletes himself (self-delete refused)
-- @category last-admin
-- @actor ADMIN
-- @region *
-- @expect error 42501 you cannot delete yourself
SELECT idm_delete_user('{{ADMIN}}', 'Self delete');
-- @end

-- @case LA-05
-- @title Direct status change of the last admin
-- @category last-admin
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE users SET status = 'suspended' WHERE id = '{{ADMIN}}';
-- @end

-- @case LA-06
-- @title Delegate with all regions suspends the last admin
-- @category last-admin
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this user is an admin or a delegate
SELECT idm_set_user_status('{{ADMIN}}', 'suspended', 'Delegate removes the last admin');
-- @end

-- @case LA-07
-- @title Delegate with all regions soft-deletes the last admin
-- @category last-admin
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this user is an admin or a delegate
SELECT idm_delete_user('{{ADMIN}}', 'Delegate deletes the last admin');
-- @end

-- @case LA-08
-- @title Delegate with all regions removes the last admin from the group
-- @category last-admin
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 a delegate cannot remove an admin
SELECT idm_group_remove_member('{{SYSADMINS}}', '{{ADMIN}}', 'Delegate removes the admin');
-- @end

-- @case LA-09
-- @title Delegate with all regions deactivates the admin group
-- @category last-admin
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this group is the admin group or carries delegations
SELECT idm_group_save('{{SYSADMINS}}', 'System Admins', 'Delegate edits the admin group', false, 'Delegate deactivates the admin group');
-- @end

-- @case LA-10
-- @title Delegate with all regions grants a role to the admin (admins are System Admin territory)
-- @category last-admin
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this user is an admin or a delegate
SELECT idm_assign('{{ADMIN}}', '{{ROLE_CW}}', 'view', 'none', NULL, NULL, false, true, NULL, true, NULL, NULL, 'Delegate edits an admin');
-- @end

-- @case LA-11
-- @title Region-limited delegate suspends the admin (the change is global)
-- @category last-admin
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 this change is global
SELECT idm_set_user_status('{{ADMIN}}', 'suspended', 'Tripoli delegate');
-- @end
