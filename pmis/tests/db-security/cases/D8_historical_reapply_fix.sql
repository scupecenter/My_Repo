-- The historical re-apply fix (migration 0125, owner report 2026-11-18): in the historical Master load approved directly, the Matrix entry holder (L1) does not
-- stop a row of the System Admin, a dated row whose task already holds its values is sent, and a register value outside its list is kept as typed. The
-- override is decided only by definer code: the staging mark (hrf_stage_marks, written only by mi_apply_run) and the checks hrf_staging / hrf_override_ok /
-- hrf_note_batches are internal (owner pmis_definer, PUBLIC revoked, nothing granted to pmis_app). Alice: CW Team Lead in Tripoli, not a System Admin.
-- ADMIN: the System Admin. Each case is rolled back.

-- @case HRF-01
-- @title The System Admin with a step-up asks the staging check through the internal function
-- @category historical-reapply-fix
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hrf_staging();
-- @end

-- @case HRF-02
-- @title The System Admin asks the entry-holder override for a task through the internal function
-- @category historical-reapply-fix
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hrf_override_ok((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), NULL, NULL);
-- @end

-- @case HRF-03
-- @title Alice notes and audits batches as overrides through the internal function
-- @category historical-reapply-fix
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT hrf_note_batches(ARRAY[gen_random_uuid()], 'a forged note');
-- @end

-- @case HRF-04
-- @title The System Admin plants a staging mark for the current transaction to lift the entry-holder check
-- @category historical-reapply-fix
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
INSERT INTO hrf_stage_marks (xid, actor_id, run_id) SELECT txid_current(), u.id, gen_random_uuid() FROM users u LIMIT 1;
-- @end

-- @case HRF-05
-- @title Alice reads the staging marks
-- @category historical-reapply-fix
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM hrf_stage_marks;
-- @end

-- @case HRF-06
-- @title The shape: the new functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the mark table (row security forced, no right for pmis_app), the redefined checks (search_path ending in pg_temp, grants kept)
-- @category historical-reapply-fix
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('hrf_staging', 'hrf_override_ok', 'hrf_note_batches')
), r AS (
  SELECT p.oid, p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg FROM pg_proc p
  WHERE p.oid IN ('public.wf_require_actor(uuid,text,uuid)'::regprocedure, 'public.reg_require_actor(uuid,text,uuid)'::regprocedure,
                  'public.reg_save_record(text,uuid,integer,uuid,text,jsonb,jsonb,uuid,boolean)'::regprocedure, 'public.reg_new_version(uuid,integer)'::regprocedure,
                  'public.reg_list_value(text,text)'::regprocedure, 'public.p5_record_rules()'::regprocedure, 'public.reg_scope_entry_guard()'::regprocedure,
                  'public.reg_permit_submit_guard()'::regprocedure,
                  'public.imp_stage_register_row(text,jsonb,jsonb,jsonb,uuid,text,integer[],integer[],integer[],integer[])'::regprocedure,
                  'public.imp_stage_task_row(jsonb,jsonb,uuid,integer[],integer[],integer[],text,date)'::regprocedure,
                  'public.mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)'::regprocedure)
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 3 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN (SELECT count(*) FROM r) <> 11 THEN 'redefined: ' || (SELECT count(*) FROM r)::text
  WHEN EXISTS (SELECT 1 FROM r WHERE NOT prosecdef OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'redefined search_path: '
    || (SELECT string_agg(proname, ',') FROM r WHERE NOT prosecdef OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%')
  WHEN has_function_privilege('pmis_app', 'public.wf_require_actor(uuid,text,uuid)', 'EXECUTE') THEN 'wf_require_actor granted'
  WHEN NOT has_function_privilege('pmis_app', 'public.mi_apply_run(uuid,integer,text,text,boolean,jsonb,jsonb)', 'EXECUTE') THEN 'door'
  WHEN NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.hrf_stage_marks'::regclass) THEN 'row security'
  WHEN has_table_privilege('pmis_app', 'public.hrf_stage_marks', 'SELECT') OR has_table_privilege('pmis_app', 'public.hrf_stage_marks', 'INSERT') THEN 'mark table granted'
  ELSE 'ok' END;
-- @end
