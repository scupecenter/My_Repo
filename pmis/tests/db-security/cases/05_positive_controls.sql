-- Positive controls. Each one shows that the same harness lets the legitimate path through, so that a refusal below
-- is a real refusal and not a broken fixture. They run first. "ok" cases commit; the others roll back.

-- @case OK-01
-- @title Alice reads the two messages of her own thread
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output>= 2
SELECT count(*) FROM messages WHERE thread_id = '{{T_ALICE_BOB}}';
-- @end

-- @case OK-02
-- @title Alice sees her own answer to notice A, and only that one
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output 1
SELECT count(*) FROM announcement_responses WHERE announcement_id = '{{ANN_A}}' AND user_id = '{{ALICE}}';
-- @end

-- @case OK-03
-- @title The System Admin reads all answers to notice A
-- @category positive-controls
-- @actor ADMIN
-- @region *
-- @expect output>= 2
SELECT count(*) FROM announcement_responses WHERE announcement_id = '{{ANN_A}}';
-- @end

-- @case OK-04
-- @title Alice may look herself up by employee ID (the sign-in lookup works for an active account)
-- @category positive-controls
-- @expect output 1
SELECT count(*) FROM auth_local_lookup('1001');
-- @end

-- @case OK-05
-- @title Alice reads her own credential row through auth_local_own_hash
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output 1
SELECT count(*) FROM auth_local_own_hash('{{ALICE}}');
-- @end

-- @case OK-06
-- @title Alice replies in her own thread
-- @category positive-controls
-- @actor ALICE
-- @region 1
-- @expect output t
SELECT msg_reply('{{T_ALICE_BOB}}', 'Synthetic follow-up') IS NOT NULL;
-- @end

-- @case OK-07
-- @title A session in Benghazi sees the Benghazi cluster (the region filter works for a real region)
-- @category positive-controls
-- @actor ALICE
-- @region 5
-- @expect output 1
SELECT count(*) FROM clusters WHERE cluster_code = 'SEC-BEN-01';
-- @end

-- @case OK-08
-- @title The System Admin adds a department through idm_department_save
-- @category positive-controls
-- @actor ADMIN
-- @region *
-- @expect ok
SELECT idm_department_save(NULL, 'OPS', 'Operations (synthetic)', NULL, true, 'Synthetic department for the suite');
-- @end

-- @case OK-09
-- @title A delegate with users.edit for all regions resets the password of an account with no assignments
-- @category positive-controls
-- @actor DEL_ALL
-- @region *
-- @expect ok
SELECT idm_reset_local_password('{{CAROL}}', '{{HASH}}', 'Synthetic reset by a delegate');
-- @end

-- @case OK-10
-- @title The System Admin sends notice D to Carol through ann_send
-- @category positive-controls
-- @actor ADMIN
-- @region *
-- @expect ok
SELECT ann_send('Synthetic notice D', 'Synthetic body D', false, ARRAY['{{CAROL}}']::uuid[], NULL, NULL, NULL);
-- @end
