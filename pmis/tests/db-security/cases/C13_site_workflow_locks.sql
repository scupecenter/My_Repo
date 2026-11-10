-- Per-site workflow locks (migration 0085, owner request 2026-11-10; contract 0.15.4). sites.workflow_locks and the lock bypass of a task
-- (task_instances.lock_bypassed and its reason) change only inside the definer functions of 0085; the switch site_workflow_locks_set is for a System Admin or a holder
-- of the delegable right "unlock" (overrides.unlock administer) for the site's region, with a reason and a verified step-up.
-- Alice: CW Team Lead in Tripoli, not a System Admin. DLG_TRI: a delegate limited to Tripoli without the right to unlock. ADMIN: the System Admin.

-- ---------------------------------------------------------------------------------------------------------------------
-- Direct writes
-- ---------------------------------------------------------------------------------------------------------------------
-- @case WL-01
-- @title Alice opens the locks of a Tripoli site by a direct update
-- @category workflow-locks
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE sites SET workflow_locks = false WHERE id = '{{SITE_TRI}}';
-- @end

-- @case WL-02
-- @title The System Admin opens the locks of a site by a direct update
-- @category workflow-locks
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE sites SET workflow_locks = false, workflow_locks_reason = 'direct' WHERE id = '{{SITE_TRI}}';
-- @end

-- @case WL-03
-- @title The System Admin with a step-up writes the who/when/why of the locks directly
-- @category workflow-locks
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
UPDATE sites SET workflow_locks_changed_at = now() WHERE id = '{{SITE_TRI}}';
-- @end

-- @case WL-04
-- @title The System Admin sets the lock bypass of a task directly
-- @category workflow-locks
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE task_instances SET lock_bypassed = true, lock_bypass_reason = 'predecessor_open:A1', lock_bypassed_at = now() WHERE site_id = '{{SITE_TRI}}';
-- @end

-- @case WL-05
-- @title Alice clears the pending lock of a task directly
-- @category workflow-locks
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE task_instances SET lock_bypass_pending = NULL WHERE site_id = '{{SITE_TRI}}';
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The switch: who, and with what
-- ---------------------------------------------------------------------------------------------------------------------
-- @case WL-10
-- @title Alice, without the right to unlock, opens the locks of a Tripoli site through the function
-- @category workflow-locks
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT site_workflow_locks_set(ARRAY['{{SITE_TRI}}']::uuid[], false, 'Alice tries to open the locks');
-- @end

-- @case WL-11
-- @title Alice opens the locks of a Benghazi site (outside her region): the site is not visible
-- @category workflow-locks
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT site_workflow_locks_set(ARRAY['{{SITE_BEN}}']::uuid[], false, 'Alice tries another region');
-- @end

-- @case WL-12
-- @title A delegate limited to Tripoli, without the right to unlock, opens the locks of a Tripoli site
-- @category workflow-locks
-- @actor DEL_TRI
-- @region 1
-- @expect error P0001 action_forbidden
SELECT site_workflow_locks_set(ARRAY['{{SITE_TRI}}']::uuid[], false, 'A region-limited delegate tries');
-- @end

-- @case WL-13
-- @title No signed context (a forged user id of the System Admin, all regions, a step-up): the actor does not exist
-- @category workflow-locks
-- @expect error 42501 no signed-in actor
SET app.user_id = '{{ADMIN}}';
SET app.region_ids = '*';
SET app.stepup = 'true';
SELECT site_workflow_locks_set(ARRAY['{{SITE_TRI}}']::uuid[], false, 'Forged context');
-- @end

-- @case WL-14
-- @title The System Admin without a step-up opens the locks
-- @category workflow-locks
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SELECT site_workflow_locks_set(ARRAY['{{SITE_TRI}}']::uuid[], false, 'No step-up');
-- @end

-- @case WL-15
-- @title The System Admin with a forged plain step-up setting (not signed) opens the locks
-- @category workflow-locks
-- @actor ADMIN
-- @region *
-- @expect error P0001 step_up_required
SET app.stepup = 'true';
SET app.stepup_until = '2999-01-01';
SELECT site_workflow_locks_set(ARRAY['{{SITE_TRI}}']::uuid[], false, 'Forged step-up');
-- @end

-- @case WL-16
-- @title The System Admin with a step-up opens the locks without a reason
-- @category workflow-locks
-- @expect error P0001 reason of 3 to 2000
\ctx ADMIN stepup=300
SELECT site_workflow_locks_set(ARRAY['{{SITE_TRI}}']::uuid[], false, ' ');
-- @end

-- @case WL-17
-- @title The System Admin with a step-up names no site
-- @category workflow-locks
-- @expect error P0001 Choose 1 to 5000 sites
\ctx ADMIN stepup=300
SELECT site_workflow_locks_set(ARRAY[]::uuid[], false, 'Nothing chosen');
-- @end

-- @case WL-18
-- @title Positive control: the System Admin with a step-up opens the locks of a site (rolled back); one audit row, flagged as an override
-- @category workflow-locks
-- @expect output false|1|true
\ctx ADMIN stepup=300
SELECT site_workflow_locks_set(ARRAY['{{SITE_TRI}}']::uuid[], false, 'Control: open the locks') IS NOT NULL;
SELECT (SELECT workflow_locks FROM sites WHERE id = '{{SITE_TRI}}')::text || '|'
    || (SELECT count(*) FROM audit_log WHERE action = 'site_workflow_locks_set' AND entity_id = '{{SITE_TRI}}')::text || '|'
    || (SELECT bool_and(is_admin_override) FROM audit_log WHERE action = 'site_workflow_locks_set' AND entity_id = '{{SITE_TRI}}')::text;
-- @end

-- @case WL-19
-- @title Positive control: Alice may not switch the locks of her site, the System Admin may
-- @category workflow-locks
-- @expect output false|true
\ctx ALICE
SELECT set_config('wl.alice', swl_can_manage('{{SITE_TRI}}')::text, true) IS NOT NULL;
\ctx ADMIN
SELECT current_setting('wl.alice') || '|' || swl_can_manage('{{SITE_TRI}}')::text;
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- The internal functions are closed to the application role
-- ---------------------------------------------------------------------------------------------------------------------
-- @case WL-20
-- @title The System Admin calls the internal writer swl_apply directly
-- @category workflow-locks
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function swl_apply
SELECT swl_apply('{{SITE_TRI}}', false, 'Around the right check', 'manual');
-- @end

-- @case WL-21
-- @title The System Admin calls the historical opening directly
-- @category workflow-locks
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied for function swl_open_for_load
SELECT swl_open_for_load(ARRAY['{{SITE_TRI}}']::uuid[], 'Around the historical load', 'historical_template');
-- @end

-- @case WL-22
-- @title Alice opens one locked task directly through the internal function
-- @category workflow-locks
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function swl_open_task
SELECT swl_open_task((SELECT id FROM task_instances WHERE site_id = '{{SITE_TRI}}' LIMIT 1), false);
-- @end

-- @case WL-23
-- @title Alice writes an audit row of the migration (an admin override) through the internal writer
-- @category workflow-locks
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function swl_audit
SELECT swl_audit('task_lock_bypassed', 'task', 'x', NULL, NULL, 'forged', NULL, 1, true);
-- @end

-- @case WL-24
-- @title Alice calls the guard trigger function, the bypass decision and the re-locking
-- @category workflow-locks
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function swl_bypass_reason
SELECT swl_bypass_reason((SELECT id FROM task_instances WHERE site_id = '{{SITE_TRI}}' LIMIT 1), '{{SITE_TRI}}', 'predecessor_open:A1');
-- @end

-- ---------------------------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------------------------
-- @case WL-30
-- @title Every function of 0085 is SECURITY DEFINER (but the two guard triggers), search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked; the application role holds the four doors only
-- @category workflow-locks
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
         has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (p.proname LIKE 'swl\_%' OR p.proname IN ('site_workflow_locks_set', 'site_data_gaps', 'site_data_gap_count'))
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) < 19 THEN 'too few functions'
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef AND proname NOT IN ('swl_task_trg', 'swl_sites_guard')) THEN 'not SECURITY DEFINER: ' || (SELECT min(proname) FROM f WHERE NOT prosecdef AND proname NOT IN ('swl_task_trg', 'swl_sites_guard'))
  WHEN EXISTS (SELECT 1 FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'search_path: ' || (SELECT min(proname) FROM f WHERE proconfig IS NULL OR NOT (proconfig::text ILIKE '%search_path=pg_catalog, public, pg_temp%'))
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner: ' || (SELECT min(proname) FROM f WHERE owner <> 'pmis_definer')
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC: ' || (SELECT min(proname) FROM f WHERE pub)
  WHEN (SELECT string_agg(proname, ',' ORDER BY proname) FROM f WHERE app) <> 'site_data_gap_count,site_data_gaps,site_workflow_locks_set,swl_can_manage' THEN 'doors: ' || (SELECT string_agg(proname, ',' ORDER BY proname) FROM f WHERE app)
  ELSE 'ok' END;
-- @end

-- @case WL-31
-- @title The guards are in place and the application role has no update right on the new columns
-- @category workflow-locks
-- @expect output 5|false|false
SELECT (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('b_swl_sites_guard_ins', 'b_swl_sites_guard_upd', 'swl_task_trg_ins', 'swl_task_trg_upd', 'swl_site_created'))::text || '|'
    || has_column_privilege('pmis_app', 'sites', 'workflow_locks', 'UPDATE')::text || '|'
    || has_column_privilege('pmis_app', 'task_instances', 'lock_bypassed', 'UPDATE')::text;
-- @end
