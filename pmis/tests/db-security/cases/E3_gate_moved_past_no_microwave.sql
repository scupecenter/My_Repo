-- A gate the site moved past is open, and MW alignment (D8) is N/A on a site without microwave, on any site (migration 0134, owner decisions 2026-11-22,
-- contract 0.15.43). Both rules are admin overrides made by GSDN Workspace (kinds gate_moved_past_open and no_microwave_na, acted_by NULL), decided only by
-- definer code: gmp_* and nmw_* are internal (owner pmis_definer, PUBLIC revoked, nothing granted to pmis_app); the flag task_instances.no_microwave_na is
-- written only under the definer AND its definer-only marker row (guard nmw_guard_task; a GUC alone never passes); the gate column is the one of 0127 (guard
-- hgd_guard_gate); the markers (nmw_task, nmw_restore, hist_load) are rows of hgd_marks written only through hgd_mark; the overrides are taken back only through
-- the existing door admin_override_revert. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin. Each case is rolled back.

-- @case GMP-01
-- @title The System Admin with a step-up runs the one-time backfill through the internal function
-- @category gate-moved-past
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT gmp_backfill();
-- @end

-- @case GMP-02
-- @title The System Admin runs the hook of the calculation on a site through the internal function
-- @category gate-moved-past
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT gmp_apply_site('{{SITE_BEN}}'::uuid);
-- @end

-- @case GMP-03
-- @title Alice opens the gates of a site through the internal rule, with a forged all-regions setting
-- @category gate-moved-past
-- @actor ALICE
-- @region *
-- @expect error 42501 permission denied
SELECT gmp_open_gates('{{SITE_BEN}}'::uuid, true);
-- @end

-- @case GMP-04
-- @title Alice makes MW alignment N/A on a site through the internal rule
-- @category gate-moved-past
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT nmw_mark_site('{{SITE_TRI}}'::uuid, false);
-- @end

-- @case GMP-05
-- @title The System Admin restores a D8 without the revert door (no step-up check) through the internal function
-- @category gate-moved-past
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT nmw_restore_task((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), '{{ADMIN}}'::uuid, 'forged restore', 'x', true);
-- @end

-- @case GMP-06
-- @title The System Admin forges the marker of the rule in a session setting and flags a task N/A "no microwave"
-- @category gate-moved-past
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.nmw_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), true);
UPDATE task_instances SET state = 'na', is_na = true, no_microwave_na = true, no_microwave_na_at = now() WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case GMP-07
-- @title Alice writes the marker of a historical load in the marker table, to make the hook stand aside
-- @category gate-moved-past
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO hgd_marks (xid, kind, key) VALUES (txid_current(), 'hist_load', '1');
-- @end

-- @case GMP-08
-- @title Alice writes the marker of the rule through the marker function
-- @category gate-moved-past
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hgd_mark('nmw_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_TRI}}'::uuid LIMIT 1));
-- @end

-- @case GMP-09
-- @title Alice plants a rule override row with no acting person to make a gate revertible
-- @category gate-moved-past
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO admin_overrides (entity, site_id, kind, reason, before, after, acted_by)
VALUES ('site', '{{SITE_TRI}}'::uuid, 'gate_moved_past_open', 'forged override', '{"gate":"G5","status":"blocked"}', '{"gate":"G5","status":"open"}', NULL);
-- @end

-- @case GMP-10
-- @title The System Admin opens the workflow locks for a forged historical load (the function that writes the marker hist_load)
-- @category gate-moved-past
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT swl_open_for_load(ARRAY['{{SITE_BEN}}'::uuid], 'forged load', 'historical_master_import');
-- @end

-- @case GMP-11
-- @title The calculation itself, which runs the two rules, is not callable by the application role
-- @category gate-moved-past
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT calc_refresh_site('{{SITE_BEN}}'::uuid);
-- @end

-- @case GMP-12
-- @title The shape: the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the guard (runs as its writer) and its triggers, the redefined functions kept internal and the revert door kept, the rule-actor and revert checks, the flag columns, the override table and the marker table unwritable
-- @category gate-moved-past
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('nmw_mw_absent', 'nmw_blank', 'gmp_site_deferred', 'gmp_open_gates', 'nmw_mark_site', 'gmp_apply_site',
                                              'nmw_restore_task', 'gmp_backfill')
), g AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.oid = 'public.nmw_guard_task()'::regprocedure
), r AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.oid IN ('public.calc_refresh_site(uuid)'::regprocedure, 'public.swl_open_for_load(uuid[],text,text)'::regprocedure,
                                 'public.hgd_restore_gate(uuid,uuid,text,text,boolean)'::regprocedure, 'public.hgd_settle_site(uuid,uuid,text,boolean)'::regprocedure,
                                 'public.ao_current_matches(uuid)'::regprocedure)
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 8 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN (SELECT count(*) FROM g) <> 1
    OR EXISTS (SELECT 1 FROM g WHERE prosecdef OR app OR owner <> 'pmis_definer' OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'guard'
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.task_instances'::regclass AND tgname IN ('nmw_guard_task_ins', 'nmw_guard_task_upd')) <> 2 THEN 'guard triggers'
  WHEN (SELECT count(*) FROM r) <> 5
    OR EXISTS (SELECT 1 FROM r WHERE NOT prosecdef OR app OR owner <> 'pmis_definer' OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'redefined'
  WHEN NOT has_function_privilege('pmis_app', 'public.admin_override_revert(uuid,text)', 'EXECUTE') THEN 'revert door'
  WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_overrides_rule_actor_check' AND conrelid = 'public.admin_overrides'::regclass)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_overrides_revert_check' AND conrelid = 'public.admin_overrides'::regclass) THEN 'override checks'
  WHEN has_column_privilege('pmis_app', 'public.task_instances', 'no_microwave_na', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'no_microwave_na_at', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'no_microwave_na', 'INSERT') THEN 'flag writable'
  WHEN has_table_privilege('pmis_app', 'public.admin_overrides', 'INSERT') OR has_table_privilege('pmis_app', 'public.hgd_marks', 'INSERT') THEN 'tables writable'
  ELSE 'ok' END;
-- @end
