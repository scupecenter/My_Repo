-- Gates and milestone dates of the historical load (migration 0127, owner decisions 2026-11-19, contract 0.15.39): on a site of a historical Master load
-- approved directly, a gate the site moved past is open and a milestone with no date takes the date of the earliest later task approved, both as admin
-- overrides. The rule, the restores and the catch-up are decided only by definer code: hgd_* are internal (owner pmis_definer, PUBLIC revoked, nothing granted
-- to pmis_app); the flags task_instances.historical_inferred_date and site_gate_state.historical_open_override are written only under the definer AND its
-- transaction marker (guards hgd_guard_task and hgd_guard_gate; a GUC alone never passes); the overrides are admin_overrides rows (no right for pmis_app),
-- taken back only through the existing door admin_override_revert. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin. Each case is
-- rolled back.

-- @case HGD-01
-- @title The System Admin with a step-up runs the one-time catch-up through the internal function
-- @category historical-gates-dates
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hgd_catch_up();
-- @end

-- @case HGD-02
-- @title The System Admin runs the gates and dates rule on a set of sites through the internal function
-- @category historical-gates-dates
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hgd_apply_sites(ARRAY['{{SITE_BEN}}'::uuid], 'forged run', false, NULL);
-- @end

-- @case HGD-03
-- @title Alice opens the gates and infers the milestones of a site through the internal function, naming another user as the actor
-- @category historical-gates-dates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hgd_settle_site('{{SITE_BEN}}'::uuid, gen_random_uuid(), 'forged settle', true);
-- @end

-- @case HGD-04
-- @title The System Admin closes a gate without the revert door (no step-up check) through the internal function
-- @category historical-gates-dates
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hgd_restore_gate(gen_random_uuid(), gen_random_uuid(), 'forged restore', 'x', true);
-- @end

-- @case HGD-05
-- @title The System Admin reopens a milestone without the revert door (no step-up check) through the internal function
-- @category historical-gates-dates
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hgd_restore_milestone((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), gen_random_uuid(), 'forged restore', 'x', true);
-- @end

-- @case HGD-06
-- @title The System Admin forges the marker of the rule and flags a milestone with an inferred date
-- @category historical-gates-dates
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.hgd_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), true);
UPDATE task_instances SET state = 'approved', actual_date = DATE '2026-01-01', historical_inferred_date = true, historical_inferred_at = now() WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case HGD-07
-- @title The System Admin forges the marker of the rule and opens a gate of a site
-- @category historical-gates-dates
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.hgd_gate', '{{SITE_BEN}}:G3', true);
INSERT INTO site_gate_state (site_id, gate_code, is_open, historical_open_override, historical_open_at) VALUES ('{{SITE_BEN}}'::uuid, 'G3', true, gen_random_uuid(), now());
-- @end

-- @case HGD-08
-- @title Alice plants a gate override row to make a gate revertible
-- @category historical-gates-dates
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO admin_overrides (entity, site_id, kind, reason, before, after, acted_by)
VALUES ('site', '{{SITE_BEN}}'::uuid, 'historical_gate_open', 'forged override', '{"gate":"G3","status":"blocked"}', '{"gate":"G3","status":"open"}', gen_random_uuid());
-- @end

-- @case HGD-09
-- @title The shape: the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the two guards (run as their writer) and their triggers, the revert door kept and gate_eval still readable, the flag columns and the override table unwritable, the catch-up recorded
-- @category historical-gates-dates
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('hgd_after_defs', 'hgd_evidence', 'hgd_waiting', 'hgd_restore_milestone', 'hgd_restore_gate',
                                              'hgd_settle_site', 'hgd_apply_sites', 'hgd_catch_up')
), g AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.oid IN ('public.hgd_guard_task()'::regprocedure, 'public.hgd_guard_gate()'::regprocedure)
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 8 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN (SELECT count(*) FROM g) <> 2
    OR EXISTS (SELECT 1 FROM g WHERE prosecdef OR app OR owner <> 'pmis_definer' OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'guards'
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.task_instances'::regclass AND tgname IN ('hgd_guard_task_ins', 'hgd_guard_task_upd')) <> 2 THEN 'task guard triggers'
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.site_gate_state'::regclass AND tgname IN ('hgd_guard_gate_ins', 'hgd_guard_gate_upd')) <> 2 THEN 'gate guard triggers'
  WHEN NOT has_function_privilege('pmis_app', 'public.admin_override_revert(uuid,text)', 'EXECUTE') THEN 'revert door'
  WHEN NOT has_function_privilege('pmis_app', 'public.gate_eval(uuid,text)', 'EXECUTE') THEN 'gate_eval'
  WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.admin_override_revert(uuid,text)'::regprocedure, 'public.ao_current_matches(uuid)'::regprocedure,
                 'public.hns_apply_sites(uuid[],text,boolean,uuid)'::regprocedure)
               AND (NOT p.prosecdef OR coalesce(p.proconfig::text, '') NOT ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'redefined'
  WHEN has_column_privilege('pmis_app', 'public.task_instances', 'historical_inferred_date', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'historical_inferred_at', 'UPDATE') THEN 'task flag writable'
  WHEN has_column_privilege('pmis_app', 'public.site_gate_state', 'historical_open_override', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.site_gate_state', 'historical_open_override', 'INSERT') THEN 'gate flag writable'
  WHEN has_table_privilege('pmis_app', 'public.admin_overrides', 'INSERT') THEN 'overrides writable'
  WHEN NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'historical_gates_dates_catch_up') THEN 'catch-up'
  ELSE 'ok' END;
-- @end
