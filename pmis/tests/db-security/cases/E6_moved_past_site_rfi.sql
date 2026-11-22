-- Site RFI the site moved past is approved automatically, on any site (migration 0135, owner decision 2026-11-22, contract 0.15.47). The rule is an admin
-- override made by GSDN Workspace (kind manual_ms_moved_past, acted_by NULL), decided only by definer code: mmp_* are internal (owner pmis_definer, PUBLIC
-- revoked, nothing granted to pmis_app); the flags task_instances.manual_ms_moved_past (+ _at, _inferred) are written only under the definer AND its
-- definer-only marker row (guard mmp_guard_task; a GUC alone never passes); the markers (mmp_task, mmp_restore) are rows of hgd_marks written only through
-- hgd_mark; the hook stands aside only while a Master import apply job runs (mi_apply_jobs, unwritable by pmis_app); the override is taken back only through
-- the existing door admin_override_revert. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin. Each case is rolled back.

-- @case MMP-01
-- @title The System Admin with a step-up runs the one-time backfill through the internal function
-- @category moved-past-site-rfi
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT mmp_backfill();
-- @end

-- @case MMP-02
-- @title The System Admin approves the Site RFI of a site through the internal rule, with an all-regions setting
-- @category moved-past-site-rfi
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mmp_approve_site('{{SITE_BEN}}'::uuid, false);
-- @end

-- @case MMP-03
-- @title Alice runs the three rules of a site (manual milestone, gates, D8) through the internal function, with a forged all-regions setting
-- @category moved-past-site-rfi
-- @actor ALICE
-- @region *
-- @expect error 42501 permission denied
SELECT mmp_rules_site('{{SITE_BEN}}'::uuid, true);
-- @end

-- @case MMP-04
-- @title The System Admin takes a direct approval back without the revert door (no step-up check) through the internal function
-- @category moved-past-site-rfi
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mmp_restore_task((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), '{{ADMIN}}'::uuid, 'forged restore', 'x', true);
-- @end

-- @case MMP-05
-- @title The System Admin forges the marker of the rule in a session setting and flags a Site RFI approved because the site moved past it
-- @category moved-past-site-rfi
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.mmp_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), true);
UPDATE task_instances SET state = 'approved', manual_ms_moved_past = true, manual_ms_moved_past_at = now() WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case MMP-06
-- @title Alice marks the date of her Site RFI as inferred by the rule
-- @category moved-past-site-rfi
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE task_instances SET manual_ms_moved_past_inferred = true WHERE site_id = '{{SITE_TRI}}'::uuid;
-- @end

-- @case MMP-07
-- @title Alice writes the marker of the rule through the marker function
-- @category moved-past-site-rfi
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hgd_mark('mmp_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_TRI}}'::uuid LIMIT 1));
-- @end

-- @case MMP-08
-- @title Alice plants a rule override row with no acting person to make a Site RFI revertible
-- @category moved-past-site-rfi
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
VALUES ('task', '{{SITE_TRI}}'::uuid, (SELECT id FROM task_instances WHERE site_id = '{{SITE_TRI}}'::uuid LIMIT 1), 'manual_ms_moved_past', 'forged override',
        '{"state":"open"}', '{"state":"approved"}', NULL);
-- @end

-- @case MMP-09
-- @title The System Admin writes a running Master import apply job, to make the hook stand aside on every site
-- @category moved-past-site-rfi
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO mi_apply_jobs (run_id, actor_id, mode, reason, sites_total, state)
VALUES (gen_random_uuid(), '{{ADMIN}}'::uuid, 'submit', 'forged running job', 1, 'running');
-- @end

-- @case MMP-10
-- @title Alice asks whether the hook stands aside on a site (the internal deferral check)
-- @category moved-past-site-rfi
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT gmp_site_deferred('{{SITE_TRI}}'::uuid);
-- @end

-- @case MMP-11
-- @title The shape: the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the guard (runs as its writer) and its triggers, the redefined functions kept internal and the revert door kept, the rule-actor and revert checks naming the new kind, the flag columns, the override table and the job table unwritable
-- @category moved-past-site-rfi
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('mmp_approve_site', 'mmp_rules_site', 'mmp_restore_task', 'mmp_backfill')
), g AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.oid = 'public.mmp_guard_task()'::regprocedure
), r AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.oid IN ('public.gmp_site_deferred(uuid)'::regprocedure, 'public.gmp_apply_site(uuid)'::regprocedure,
                                 'public.hgd_settle_site(uuid,uuid,text,boolean)'::regprocedure, 'public.ao_current_matches(uuid)'::regprocedure)
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 4 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN (SELECT count(*) FROM g) <> 1
    OR EXISTS (SELECT 1 FROM g WHERE prosecdef OR app OR owner <> 'pmis_definer' OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'guard'
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.task_instances'::regclass AND tgname IN ('mmp_guard_task_ins', 'mmp_guard_task_upd')) <> 2 THEN 'guard triggers'
  WHEN (SELECT count(*) FROM r) <> 4
    OR EXISTS (SELECT 1 FROM r WHERE NOT prosecdef OR app OR owner <> 'pmis_definer' OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'redefined'
  WHEN NOT has_function_privilege('pmis_app', 'public.admin_override_revert(uuid,text)', 'EXECUTE') THEN 'revert door'
  WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_overrides_rule_actor_check' AND conrelid = 'public.admin_overrides'::regclass
                   AND pg_get_constraintdef(oid) LIKE '%manual_ms_moved_past%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_overrides_revert_check' AND conrelid = 'public.admin_overrides'::regclass
                   AND pg_get_constraintdef(oid) LIKE '%manual_ms_moved_past%') THEN 'override checks'
  WHEN has_column_privilege('pmis_app', 'public.task_instances', 'manual_ms_moved_past', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'manual_ms_moved_past_at', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'manual_ms_moved_past_inferred', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'manual_ms_moved_past', 'INSERT') THEN 'flag writable'
  WHEN has_table_privilege('pmis_app', 'public.admin_overrides', 'INSERT') OR has_table_privilege('pmis_app', 'public.hgd_marks', 'INSERT')
    OR has_table_privilege('pmis_app', 'public.mi_apply_jobs', 'INSERT') OR has_table_privilege('pmis_app', 'public.mi_apply_jobs', 'SELECT') THEN 'tables writable'
  ELSE 'ok' END;
-- @end
