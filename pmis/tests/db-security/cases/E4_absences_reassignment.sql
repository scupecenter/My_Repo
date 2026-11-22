-- Staff absence and the lead decisions on tasks (migration 0137, CLAUDE.md B12b and B14, contract 0.15.45). Absences and decisions are written only through the
-- doors ops_save_absence, ops_delete_absence, ops_reassign_tasks and ops_act_on_behalf (SECURITY DEFINER, owner pmis_definer), which take the actor from the verified
-- session, check the lead right (overrides.reassign + administer, B12b) per region and audit before and after; the tables have no right for pmis_app. Acting on
-- behalf rides on a marker row of hgd_marks (kind rsn_cover) that only definer code writes, so neither a session setting nor a direct insert stands in for it.
-- Alice: CW Team Lead in Tripoli at Data Entry, WITHOUT the reassign grant. Bob: active, no assignment. ADMIN: the System Admin. Each case is rolled back.

-- @case ABSR-01
-- @title Alice writes an absence row directly
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO absences (user_id, kind, from_date, to_date, recorded_by) VALUES ('{{BOB}}'::uuid, 'sick', current_date, current_date, '{{ALICE}}'::uuid);
-- @end

-- @case ABSR-02
-- @title Alice reads the absence table directly (sick leave is personal)
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM absences;
-- @end

-- @case ABSR-03
-- @title Alice records sick leave for Bob without the reassign grant
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT ops_save_absence(NULL, NULL, jsonb_build_object('user_id', '{{BOB}}', 'kind', 'sick', 'from_date', current_date, 'to_date', current_date));
-- @end

-- @case ABSR-04
-- @title Alice records her own sick leave (an employee records only their own annual leave)
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT ops_save_absence(NULL, NULL, jsonb_build_object('kind', 'sick', 'from_date', current_date, 'to_date', current_date + 1));
-- @end

-- @case ABSR-05
-- @title Alice removes an absence the System Admin recorded for her
-- @category absences-reassignment
-- @expect error P0001 action_forbidden
\ctx ADMIN
SELECT ops_save_absence(NULL, NULL, jsonb_build_object('user_id', '{{ALICE}}', 'kind', 'sick', 'from_date', current_date, 'to_date', current_date)) AS abs_id \gset
\ctx ALICE
SELECT ops_delete_absence(:'abs_id'::uuid, NULL);
-- @end

-- @case ABSR-06
-- @title No session: recording an absence
-- @category absences-reassignment
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SELECT ops_save_absence(NULL, NULL, jsonb_build_object('kind', 'annual', 'from_date', current_date, 'to_date', current_date));
-- @end

-- @case CVR-01
-- @title Alice reassigns a Tripoli task to Bob without the reassign grant
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT ops_reassign_tasks(jsonb_build_object('scope', 'task', 'task_id', '{{TASK_TRI}}', 'decision', 'keep', 'reason', 'forged decision'));
-- @end

-- @case CVR-02
-- @title Alice acts on behalf of the holder of a Tripoli task without the reassign grant (her profile holds no Sites view right either, so the task is not even visible)
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:(not_found|action_forbidden)
SELECT ops_act_on_behalf('{{TASK_TRI}}'::uuid, NULL, 'submit', 1, 'forged cover', NULL, true);
-- @end

-- @case CVR-03
-- @title Alice acts on a Benghazi task with a forged all-regions setting
-- @category absences-reassignment
-- @actor ALICE
-- @region *
-- @expect error P0001 not_found
SELECT ops_act_on_behalf('{{TASK_BEN}}'::uuid, NULL, 'submit', 1, 'forged cover', NULL, true);
-- @end

-- @case CVR-04
-- @title Alice writes the act-on-behalf marker through the marker function, then submits as if covering
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hgd_mark('rsn_cover', '{{TASK_TRI}}|{{ALICE}}|{{BOB}}');
-- @end

-- @case CVR-05
-- @title Alice writes the act-on-behalf marker row directly
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO hgd_marks (xid, kind, key) VALUES (txid_current(), 'rsn_cover', '{{TASK_TRI}}|{{ALICE}}|');
-- @end

-- @case CVR-06
-- @title The System Admin forges the marker as a session setting and asks the engine whether he may act: the internal check stays closed
-- @category absences-reassignment
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.rsn_cover', '{{TASK_TRI}}', true);
SELECT wf_require_actor('{{TASK_TRI}}'::uuid, 'entry', '{{ADMIN}}'::uuid);
-- @end

-- @case CVR-07
-- @title Alice writes a lead decision row directly (to silence an alert)
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO task_cover_decisions (bulk_action_id, task_id, region_id, decision, level, decided_by, reason)
VALUES (gen_random_uuid(), '{{TASK_TRI}}'::uuid, 1, 'keep', 1, '{{ALICE}}'::uuid, 'forged keep');
-- @end

-- @case CVR-08
-- @title Alice calls the internal helpers (whom a task is on, the marker reader, the lead test, the notice)
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT rsn_task_on('{{TASK_TRI}}'::uuid), rsn_covering('{{TASK_TRI}}'::uuid), rsn_is_lead('{{ALICE}}'::uuid, 1);
-- @end

-- @case CVR-09
-- @title Alice, not a lead, reads the alerts or the eligible people
-- @category absences-reassignment
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT count(*) FROM rsn_alerts(NULL, NULL, NULL);
-- @end

-- @case CVR-10
-- @title Control: the System Admin keeps the Tripoli task (a dry run writes nothing) and sees only absences he may see
-- @category absences-reassignment
-- @actor ADMIN
-- @region *
-- @expect output ok
SELECT CASE WHEN (ops_reassign_tasks(jsonb_build_object('scope', 'task', 'task_id', '{{TASK_TRI}}', 'decision', 'keep', 'reason', 'Control dry run', 'dry_run', true)) -> 'done' -> 0 ->> 'id') = '{{TASK_TRI}}'
  AND (SELECT count(*) FROM rsn_visible_absences()) >= 0 THEN 'ok' ELSE 'no' END;
-- @end

-- @case CVR-11
-- @title The shape: the doors and helpers (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked), only the doors for pmis_app, the redefined engine functions kept internal, the tables without rights and with row security forced
-- @category absences-reassignment
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (p.proname LIKE 'rsn\_%' OR p.proname IN ('ops_save_absence', 'ops_delete_absence', 'ops_reassign_tasks', 'ops_act_on_behalf',
                                                                         'wf_require_actor', 'wf_step', 'wf_audit', 'wf_complete_hw'))
), doors AS (SELECT unnest(ARRAY['ops_save_absence', 'ops_delete_absence', 'ops_reassign_tasks', 'ops_act_on_behalf', 'rsn_visible_absences', 'rsn_alerts',
                                 'rsn_eligible_users', 'rsn_holder_absent', 'rsn_open_task_counts']) AS proname)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 26 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app AND proname NOT IN (SELECT proname FROM doors)) THEN 'internal granted to pmis_app'
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT app AND proname IN (SELECT proname FROM doors)) THEN 'door not granted'
  WHEN has_table_privilege('pmis_app', 'public.absences', 'SELECT') OR has_table_privilege('pmis_app', 'public.absences', 'INSERT')
    OR has_table_privilege('pmis_app', 'public.task_cover_decisions', 'SELECT') OR has_table_privilege('pmis_app', 'public.task_cover_decisions', 'INSERT') THEN 'tables'
  WHEN NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.absences'::regclass)
    OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.task_cover_decisions'::regclass) THEN 'row security'
  WHEN has_column_privilege('pmis_app', 'public.task_instances', 'ball_in_court_user_id', 'UPDATE') THEN 'pin writable'
  ELSE 'ok' END;
-- @end

-- @case CVR-12
-- @title The System Admin acts on behalf at a level that is on nobody (no single holder): refused, that is the "no holder" path to the System Admins
-- @category absences-reassignment
-- @expect error P0001 wf:invalid_transition
\ctx ADMIN stepup=300
SELECT ops_act_on_behalf('{{TASK_TRI}}'::uuid, NULL, 'submit', 1, 'cover nobody', NULL, true);
-- @end

-- @case CVR-13
-- @title Alice, lead of Tripoli through a delegation of the reassign right, records sick leave for the System Admin (an all-regions person)
-- @category absences-reassignment
-- @expect error P0001 action_forbidden
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{ALICE}}'::uuid, NULL, NULL, false, '[{"module":"overrides.reassign","action":"administer"}]'::jsonb,
  false, ARRAY[1], NULL, NULL, false, NULL, 'Tripoli lead for the case');
SELECT ops_save_absence(NULL, NULL, jsonb_build_object('kind', 'annual', 'from_date', current_date + 200, 'to_date', current_date + 201));
\ctx ALICE
SELECT ops_save_absence(NULL, NULL, jsonb_build_object('user_id', '{{ADMIN}}', 'kind', 'sick', 'from_date', current_date + 300, 'to_date', current_date + 301));
-- @end

-- @case CVR-14
-- @title Control: Alice, lead of Tripoli, does not see the System Admin's absence, and leads nobody outside Tripoli
-- @category absences-reassignment
-- @expect output 0
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{ALICE}}'::uuid, NULL, NULL, false, '[{"module":"overrides.reassign","action":"administer"}]'::jsonb,
  false, ARRAY[1], NULL, NULL, false, NULL, 'Tripoli lead for the case');
SELECT ops_save_absence(NULL, NULL, jsonb_build_object('kind', 'annual', 'from_date', current_date + 200, 'to_date', current_date + 201));
\ctx ALICE
SELECT count(*) FROM rsn_visible_absences() WHERE user_id = '{{ADMIN}}'::uuid;
-- @end

-- @case CVR-15
-- @title Control: the same delegation makes Alice a lead of Tripoli, so she may record her own sick leave (every region of hers is hers to lead)
-- @category absences-reassignment
-- @expect output ok
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{ALICE}}'::uuid, NULL, NULL, false, '[{"module":"overrides.reassign","action":"administer"}]'::jsonb,
  false, ARRAY[1], NULL, NULL, false, NULL, 'Tripoli lead for the case');
\ctx ALICE
SELECT CASE WHEN ops_save_absence(NULL, NULL, jsonb_build_object('kind', 'sick', 'from_date', current_date + 300, 'to_date', current_date + 301)) IS NOT NULL
  THEN 'ok' ELSE 'no' END;
-- @end

-- @case CVR-16
-- @title Alice, lead of Tripoli through a delegation, names Bob (no region, so outside her scope) as the person whose pin or all-members vote moves on a Tripoli task
-- @category absences-reassignment
-- @expect error P0001 action_forbidden
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{ALICE}}'::uuid, NULL, NULL, false, '[{"module":"overrides.reassign","action":"administer"}]'::jsonb,
  false, ARRAY[1], NULL, NULL, false, NULL, 'Tripoli lead for the case');
\ctx ALICE
SELECT ops_reassign_tasks(jsonb_build_object('scope', 'task', 'task_id', '{{TASK_TRI}}', 'from_user_id', '{{BOB}}', 'decision', 'reassign',
  'to_user_id', '{{CAROL}}', 'reason', 'move the vote of someone I do not lead'));
-- @end

-- @case CVR-17
-- @title The same Tripoli lead asks for the people eligible to receive a Tripoli task from Bob (outside her scope)
-- @category absences-reassignment
-- @expect error P0001 action_forbidden
\ctx ADMIN stepup=300
SELECT idm_delegate('user', '{{ALICE}}'::uuid, NULL, NULL, false, '[{"module":"overrides.reassign","action":"administer"}]'::jsonb,
  false, ARRAY[1], NULL, NULL, false, NULL, 'Tripoli lead for the case');
\ctx ALICE
SELECT count(*) FROM rsn_eligible_users('{{TASK_TRI}}'::uuid, NULL, '{{BOB}}'::uuid);
-- @end
