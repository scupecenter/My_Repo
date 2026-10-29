-- Delegate limits. A delegate's rights are the delegation's grants, regions and modules. Whoever sets a password can sign in
-- as that person, so a delegate may reset a password only for an account that holds no rights (ADR 0012). A region-limited
-- delegate cannot make a global change, and cannot send an announcement, which reaches every region.

-- @case PR-01
-- @title Delegate with all regions resets the password of Alice, who holds an assignment
-- @category delegate-limits
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this user holds assignments: System Admin only
SELECT idm_reset_local_password('{{ALICE}}', '{{HASH}}', 'Reset an account with assignments');
-- @end

-- @case PR-02
-- @title Region-limited delegate resets the password of Carol (a global change, refused for a regional delegate)
-- @category delegate-limits
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 this change is global
SELECT idm_reset_local_password('{{CAROL}}', '{{HASH}}', 'Regional reset');
-- @end

-- @case PR-03
-- @title Delegate resets the password of another delegate (delegates are privileged)
-- @category delegate-limits
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this user is an admin or a delegate
SELECT idm_reset_local_password('{{DEL_TRI}}', '{{HASH}}', 'Reset a delegate');
-- @end

-- @case PR-04
-- @title Delegate resets the password of the System Admin
-- @category delegate-limits
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 this user is an admin or a delegate
SELECT idm_reset_local_password('{{ADMIN}}', '{{HASH}}', 'Reset the admin');
-- @end

-- @case PR-05
-- @title Alice (no users.edit) resets the password of Carol
-- @category delegate-limits
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.edit required
SELECT idm_reset_local_password('{{CAROL}}', '{{HASH}}', 'No right');
-- @end

-- @case AN-01
-- @title Region-limited delegate sends an announcement to everyone
-- @category delegate-limits
-- @actor ANN_TRI
-- @region 1
-- @expect error 42501 sending announcements needs an all-regions delegation
SELECT ann_send('Synthetic notice E', 'Synthetic body E', true, NULL, NULL, NULL, NULL);
-- @end

-- @case AN-02
-- @title Region-limited delegate sends an announcement to Carol
-- @category delegate-limits
-- @actor ANN_TRI
-- @region 1
-- @expect error 42501 sending announcements needs an all-regions delegation
SELECT ann_send('Synthetic notice F', 'Synthetic body F', false, ARRAY['{{CAROL}}']::uuid[], NULL, NULL, NULL);
-- @end

-- @case AN-03
-- @title Alice (no announcements right) sends an announcement to everyone
-- @category delegate-limits
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or a delegation of announcements.create required
SELECT ann_send('Synthetic notice G', 'Synthetic body G', true, NULL, NULL, NULL, NULL);
-- @end

-- @case AN-04
-- @title Delegate with all regions but no announcements right sends an announcement
-- @category delegate-limits
-- @actor DEL_ALL
-- @region *
-- @expect error 42501 System Admin or a delegation of announcements.create required
SELECT ann_send('Synthetic notice H', 'Synthetic body H', true, NULL, NULL, NULL, NULL);
-- @end

-- @case DT-01
-- @title Region-limited delegate moves Carol's manager (a global change)
-- @category delegate-limits
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 this change is global
SELECT idm_set_user_org('{{CAROL}}', NULL, NULL, 'Regional org change');
-- @end

-- @case DT-02
-- @title Region-limited delegate soft-deletes Carol (no users.delete right)
-- @category delegate-limits
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 System Admin or a delegation covering users.delete required
SELECT idm_delete_user('{{CAROL}}', 'Regional delete');
-- @end

-- @case DT-03
-- @title Region-limited delegate creates an ordinary group (no groups.create right)
-- @category delegate-limits
-- @actor DEL_TRI
-- @region 1
-- @expect error 42501 this change is global
SELECT idm_group_save(NULL, 'Forged group', 'Forged', true, 'Forged by SQL');
-- @end
