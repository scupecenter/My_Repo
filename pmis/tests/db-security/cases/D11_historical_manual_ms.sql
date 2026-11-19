-- Site RFI of the historical load (migration 0129, owner decision "Option 2" 2026-11-19, contract 0.15.40): on a site of a historical Master load approved
-- directly, a manual milestone the site moved past is approved directly with its pre-filled date, as an admin override (kind historical_manual_ms_approved),
-- and the historical path sends no per-task notice. The rule, the restore and the catch-up are decided only by definer code: hmm_* are internal (owner
-- pmis_definer, PUBLIC revoked, nothing granted to pmis_app); the flags task_instances.historical_manual_ms / _at / _inferred are written only under the
-- definer AND its marker in hgd_marks (guard hmm_guard_task; a GUC alone never passes); the quiet markers of wf_notify (hda_quiet, hist_quiet) are rows of
-- hgd_marks, which pmis_app can neither read nor write; the overrides are admin_overrides rows (no right for pmis_app), taken back only through the existing
-- door admin_override_revert. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin. Each case is rolled back.

-- @case HMM-01
-- @title The System Admin with a step-up runs the one-time catch-up through the internal function
-- @category historical-manual-ms
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hmm_catch_up();
-- @end

-- @case HMM-02
-- @title The System Admin reopens a Site RFI without the revert door (no step-up check) through the internal function
-- @category historical-manual-ms
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hmm_restore_task((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), gen_random_uuid(), 'forged restore', 'x', true);
-- @end

-- @case HMM-03
-- @title The System Admin forges the marker of the rule and approves a Site RFI directly
-- @category historical-manual-ms
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.hmm_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), true);
UPDATE task_instances SET state = 'approved', actual_date = DATE '2026-01-01', historical_manual_ms = true, historical_manual_ms_at = now() WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case HMM-04
-- @title Alice writes a quiet marker row to silence the notices of a site
-- @category historical-manual-ms
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO hgd_marks (xid, kind, key) VALUES (txid_current(), 'hist_quiet', '{{SITE_BEN}}');
-- @end

-- @case HMM-05
-- @title Alice sets the quiet marker of a site through the marker function
-- @category historical-manual-ms
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hgd_mark('hist_quiet', '{{SITE_BEN}}');
-- @end

-- @case HMM-06
-- @title Alice reads the markers of the historical rules
-- @category historical-manual-ms
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM hgd_marks;
-- @end

-- @case HMM-07
-- @title Alice plants a Site RFI override row to make a milestone revertible
-- @category historical-manual-ms
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
SELECT 'task', '{{SITE_BEN}}'::uuid, id, 'historical_manual_ms_approved', 'forged override', '{"state":"open"}', '{"state":"approved"}', gen_random_uuid()
FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1;
-- @end

-- @case HMM-08
-- @title The shape: the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the guard (runs as its writer) and its triggers, the redefined functions kept definer with the safe search_path, the revert door kept, the flag columns, the markers and the override table unwritable, the catch-up recorded
-- @category historical-manual-ms
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('hmm_restore_task', 'hmm_catch_up', 'hgd_mark', 'hgd_unmark')
), g AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.oid = 'public.hmm_guard_task()'::regprocedure
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
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.task_instances'::regclass AND tgname IN ('hmm_guard_task_ins', 'hmm_guard_task_upd')) <> 2 THEN 'guard triggers'
  WHEN NOT has_function_privilege('pmis_app', 'public.admin_override_revert(uuid,text)', 'EXECUTE') THEN 'revert door'
  WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.admin_override_revert(uuid,text)'::regprocedure, 'public.ao_current_matches(uuid)'::regprocedure,
                 'public.hgd_settle_site(uuid,uuid,text,boolean)'::regprocedure, 'public.hgd_apply_sites(uuid[],text,boolean,uuid)'::regprocedure,
                 'public.hns_apply_sites(uuid[],text,boolean,uuid)'::regprocedure, 'public.wf_notify(uuid,text,text,text,uuid)'::regprocedure,
                 'public.imp_submit_stream_rows(uuid,uuid[],boolean,boolean)'::regprocedure)
               AND (NOT p.prosecdef OR pg_get_userbyid(p.proowner) <> 'pmis_definer' OR coalesce(p.proconfig::text, '') NOT ILIKE '%search_path=pg_catalog, public, pg_temp%')) THEN 'redefined'
  WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.wf_notify(uuid,text,text,text,uuid)'::regprocedure, 'public.imp_submit_stream_rows(uuid,uuid[],boolean,boolean)'::regprocedure)
               AND pg_get_functiondef(p.oid) ILIKE '%pmis.hda_quiet%') THEN 'quiet marker still a session setting'
  WHEN has_column_privilege('pmis_app', 'public.task_instances', 'historical_manual_ms', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'historical_manual_ms_at', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'historical_manual_ms_inferred', 'UPDATE') THEN 'task flag writable'
  WHEN has_table_privilege('pmis_app', 'public.hgd_marks', 'SELECT') OR has_table_privilege('pmis_app', 'public.hgd_marks', 'INSERT')
    OR has_table_privilege('pmis_app', 'public.hgd_marks', 'UPDATE') OR has_table_privilege('pmis_app', 'public.hgd_marks', 'DELETE') THEN 'markers reachable'
  WHEN has_table_privilege('pmis_app', 'public.admin_overrides', 'INSERT') THEN 'overrides writable'
  WHEN NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'historical_manual_ms_catch_up') THEN 'catch-up'
  ELSE 'ok' END;
-- @end
