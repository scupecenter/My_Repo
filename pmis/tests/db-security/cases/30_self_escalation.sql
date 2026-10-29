-- Self-escalation. A user, or a delegate, tries to grant themselves rights, to add themselves to the admin group, to delegate
-- to themselves, or to hand a delegate more than the delegate holds. Each attempt must be refused.

-- @case SE-01
-- @title Alice gives herself an admin-level CW Team Lead assignment
-- @category self-escalation
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering assignments.create required
SELECT idm_assign('{{ALICE}}', '{{ROLE_CW}}', 'admin', 'cw', NULL, NULL, false, true, NULL, true, NULL, NULL, 'Self grant');
-- @end

-- @case SE-02
-- @title Delegate with all regions gives himself a TE role
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 you cannot assign roles to yourself
SELECT idm_assign('{{DEL_ALL}}', '{{ROLE_TE}}', 'approve', 'te', NULL, NULL, false, true, NULL, true, NULL, NULL, 'Self grant');
-- @end

-- @case SE-03
-- @title Delegate with all regions adds himself to the System Admins group
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 you cannot add yourself to a group
SELECT idm_group_add_member('{{SYSADMINS}}', '{{DEL_ALL}}', 'Self grant');
-- @end

-- @case SE-04
-- @title Delegate with all regions adds Carol to the System Admins group
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this group is the admin group or carries delegations
SELECT idm_group_add_member('{{SYSADMINS}}', '{{CAROL}}', 'Delegate makes an admin');
-- @end

-- @case SE-05
-- @title Delegate with all regions adds himself to an ordinary group
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 you cannot add yourself to a group
SELECT idm_group_add_member('{{REVIEWERS}}', '{{DEL_ALL}}', 'Self grant');
-- @end

-- @case SE-06
-- @title Delegate creates a root delegation to himself (only the System Admin may create roots)
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 only a System Admin can create a delegation
SELECT idm_delegate('user', '{{DEL_ALL}}', NULL, NULL, true, NULL, true, NULL, NULL, NULL, true, NULL, 'Self delegation');
-- @end

-- @case SE-07
-- @title Re-delegation: Delegate Redelegate delegates to himself under his own delegation
-- @category self-escalation
-- @actor DEL_RD
-- @region *
-- @expect error 42501 you cannot delegate to yourself
SELECT idm_delegate('user', '{{DEL_RD}}', NULL, NULL, false, '[{"module":"users","action":"edit"}]'::jsonb, true, NULL, NULL, NULL,
  false, '{{DLG_RD}}', 'Self re-delegation');
-- @end

-- @case SE-08
-- @title A delegate without the re-delegation flag delegates to Carol under his delegation
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 re-delegation needs an active parent delegation to you with allow_redelegate
SELECT idm_delegate('user', '{{CAROL}}', NULL, NULL, false, '[{"module":"users","action":"edit"}]'::jsonb, false, ARRAY[1], NULL,
  NULL, false, '{{DLG_ALL}}', 'Re-delegation without the flag');
-- @end

-- @case SE-09
-- @title Region-limited delegate assigns Carol a role in Benghazi, outside his regions
-- @category self-escalation
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 region 5 is outside your delegated regions
SELECT idm_assign('{{CAROL}}', '{{ROLE_CW}}', 'entry', 'cw', NULL, NULL, false, false, ARRAY[5], false, ARRAY['sites'], NULL,
  'Outside the delegate regions');
-- @end

-- @case SE-10
-- @title Region-limited delegate gives Carol an assignment with all regions
-- @category self-escalation
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 resulting assignment has all regions
SELECT idm_assign('{{CAROL}}', '{{ROLE_CW}}', 'entry', 'cw', NULL, NULL, false, true, NULL, false, ARRAY['sites'], NULL,
  'Wider than the delegate regions');
-- @end

-- @case SE-11
-- @title Delegate with all regions grants Carol admin level
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 only a System Admin can hold or grant admin level
SELECT idm_assign('{{CAROL}}', '{{ROLE_CW}}', 'admin', 'cw', NULL, NULL, false, false, ARRAY[1], false, ARRAY['sites'], NULL,
  'Delegate grants admin');
-- @end

-- @case SE-12
-- @title Alice changes her own status to active through the status function
-- @category self-escalation
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT idm_set_user_status('{{ALICE}}', 'active', 'Self change');
-- @end

-- @case SE-13
-- @title Delegate with all regions moves his own manager (a delegate is privileged and cannot change his own row)
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this user is an admin or a delegate
SELECT idm_set_user_org('{{DEL_ALL}}', '{{BOB}}', NULL, 'Self promotion');
-- @end

-- @case SE-14
-- @title Delegate with all regions resets his own password
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 use change password for your own account
SELECT idm_reset_local_password('{{DEL_ALL}}', '{{HASH}}', 'Self reset');
-- @end

-- @case SE-15
-- @title Delegate with all regions soft-deletes himself
-- @category self-escalation
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 you cannot delete yourself
SELECT idm_delete_user('{{DEL_ALL}}', 'Self delete');
-- @end

-- @case SE-16
-- @title Alice removes an admin from the System Admins group
-- @category self-escalation
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering groups.edit required
SELECT idm_group_remove_member('{{SYSADMINS}}', '{{ADMIN}}', 'Remove the admin');
-- @end

-- @case SE-17
-- @title Alice creates a delegation in her own name
-- @category self-escalation
-- @actor ALICE
-- @region 1
-- @expect error 42501 only a System Admin can create a delegation
SELECT idm_delegate('user', '{{ALICE}}', NULL, NULL, true, NULL, true, NULL, NULL, NULL, true, NULL, 'Self delegation');
-- @end
