-- The Master import reads "Pending" and "N/A" as the owner means them, skips placeholder rows, routes the GECOL requests of PR-PO to GECOL, derives an empty
-- Order Status and selects the one candidate with a contract sign-off (migration 0144, owner decisions 2026-11-22, contract 0.15.58). The rules live only in
-- definer code: mina_* and the wrapped staging functions are internal (owner pmis_definer, PUBLIC revoked, nothing granted to pmis_app); the flag
-- task_instances.master_na is written only under the definer AND its definer-only marker row (guard mina_guard_task; a GUC alone never passes); the batch notes
-- (import_batches.import_notes) and the rule setting (imports.master_order_status_derived, guarded by settings_guarded_keys) are not writable by pmis_app; the
-- override is taken back only through the existing door admin_override_revert. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin.
-- Each case is rolled back.

-- @case MINA-01
-- @title The System Admin makes a task N/A through the internal rule of the Master import
-- @category master-import-na
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mina_mark_task((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), gen_random_uuid(), gen_random_uuid(), 'Master!5');
-- @end

-- @case MINA-02
-- @title Alice applies the N/A rows of a batch through the internal function, with a forged all-regions setting
-- @category master-import-na
-- @actor ALICE
-- @region *
-- @expect error 42501 permission denied
SELECT mina_apply_batch(gen_random_uuid());
-- @end

-- @case MINA-03
-- @title The System Admin restores a task without the revert door (no step-up check) through the internal function
-- @category master-import-na
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT mina_restore_task((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), '{{ADMIN}}'::uuid, 'forged restore', 'x', true);
-- @end

-- @case MINA-04
-- @title Alice calls a wrapped staging function or its renamed original directly (a register unit of a Master file staged outside the import)
-- @category master-import-na
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_master_unit('{"kind": "register", "rows": []}'::jsonb, 'x.xlsx', repeat('a', 64), 'submit', 'master_template', NULL, NULL, NULL);
-- @end

-- @case MINA-05
-- @title Alice calls the renamed original of the unit staging
-- @category master-import-na
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT imp_master_unit_pre_0144('{"kind": "register", "rows": []}'::jsonb, 'x.xlsx', repeat('a', 64), 'submit', 'master_template', NULL, NULL, NULL);
-- @end

-- @case MINA-06
-- @title The System Admin forges the marker of the rule in a session setting and flags a task N/A "Master file"
-- @category master-import-na
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT set_config('pmis.mina_task', (SELECT id::text FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), true);
UPDATE task_instances SET state = 'na', is_na = true, master_na = true, master_na_at = now() WHERE site_id = '{{SITE_BEN}}'::uuid;
-- @end

-- @case MINA-07
-- @title Alice writes the notes of a batch
-- @category master-import-na
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE import_batches SET import_notes = '[{"code": "na_task_marked", "count": 1}]'::jsonb;
-- @end

-- @case MINA-08
-- @title The System Admin turns on the Order Status rule by writing the setting directly
-- @category master-import-na
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE settings SET value = '{"po_wo_issued": "Active", "pr_raised": "Active"}'::jsonb WHERE key = 'imports.master_order_status_derived';
-- @end

-- @case MINA-09
-- @title Alice plants a rule override row of the Master import with no acting person
-- @category master-import-na
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by)
VALUES ('task', '{{SITE_TRI}}'::uuid, (SELECT id FROM task_instances WHERE site_id = '{{SITE_TRI}}'::uuid LIMIT 1), 'master_na', 'forged override', '{"state":"open"}', '{"state":"na"}', NULL);
-- @end

-- @case MINA-11
-- @title Alice asks the internal rights check of the rule to pass her for a task outside her regions (a forged all-regions setting and the override flag)
-- @category master-import-na
-- @actor ALICE
-- @region *
-- @expect error 42501 permission denied
SELECT mina_rights_check((SELECT id FROM task_instances WHERE site_id = '{{SITE_BEN}}'::uuid LIMIT 1), '{{ALICE}}'::uuid, NULL, NULL, true);
-- @end

-- @case MINA-10
-- @title The shape: the new and wrapped functions (SECURITY DEFINER, search_path ending in pg_temp, owner pmis_definer, PUBLIC revoked, nothing for pmis_app), the renamed originals kept internal, the guard (runs as its writer) and its triggers, the revert door kept, the override checks naming master_na, the new columns and the setting guard
-- @category master-import-na
-- @expect output ok
WITH f AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, pg_get_userbyid(p.proowner) AS owner,
         has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('mina_token', 'mina_list_has', 'mina_blank', 'mina_cnt', 'mina_clean_row', 'mina_notes_add', 'mina_na_check',
    'mina_reason_text', 'mina_rights_check', 'mina_prep_task_row', 'mina_route_gecol', 'mina_route_regs', 'mina_prep_register_unit', 'mina_mark_task', 'mina_apply_batch',
    'mina_restore_task', 'imp_master_plan', 'imp_master_unit', 'imp_stream_eval', 'imp_stream_close', 'imp_submit_stream_finish',
    'imp_master_plan_pre_0144', 'imp_master_unit_pre_0144', 'imp_stream_eval_pre_0144', 'imp_stream_close_pre_0144', 'imp_submit_stream_finish_pre_0144',
    'hrg_stage_registers')
), g AS (
  SELECT p.prosecdef, coalesce(p.proconfig::text, '') AS cfg, has_function_privilege('pmis_app', p.oid, 'EXECUTE') AS app, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p WHERE p.oid = 'public.mina_guard_task()'::regprocedure
)
SELECT CASE
  WHEN (SELECT count(*) FROM f) <> 27 THEN 'functions: ' || (SELECT count(*) FROM f)::text
  WHEN EXISTS (SELECT 1 FROM f WHERE NOT prosecdef) THEN 'not SECURITY DEFINER'
  WHEN EXISTS (SELECT 1 FROM f WHERE cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'search_path'
  WHEN EXISTS (SELECT 1 FROM f WHERE owner <> 'pmis_definer') THEN 'owner'
  WHEN EXISTS (SELECT 1 FROM f WHERE pub) THEN 'PUBLIC'
  WHEN EXISTS (SELECT 1 FROM f WHERE app) THEN 'granted to pmis_app'
  WHEN (SELECT count(*) FROM g) <> 1
    OR EXISTS (SELECT 1 FROM g WHERE prosecdef OR app OR owner <> 'pmis_definer' OR cfg NOT ILIKE '%search_path=pg_catalog, public, pg_temp%') THEN 'guard'
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.task_instances'::regclass AND tgname IN ('mina_guard_task_ins', 'mina_guard_task_upd')) <> 2 THEN 'guard triggers'
  WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.settings'::regclass AND tgname LIKE 'b_settings_mina_status%') <> 3 THEN 'setting guard'
  WHEN NOT has_function_privilege('pmis_app', 'public.admin_override_revert(uuid,text)', 'EXECUTE') THEN 'revert door'
  WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_overrides_rule_actor_check' AND conrelid = 'public.admin_overrides'::regclass
                   AND pg_get_constraintdef(oid) LIKE '%master_na%') THEN 'override checks'
  WHEN has_column_privilege('pmis_app', 'public.task_instances', 'master_na', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'master_na_at', 'UPDATE')
    OR has_column_privilege('pmis_app', 'public.task_instances', 'master_na', 'INSERT') THEN 'flag writable'
  WHEN has_column_privilege('pmis_app', 'public.import_batches', 'import_notes', 'UPDATE') OR has_column_privilege('pmis_app', 'public.import_batches', 'import_notes', 'INSERT') THEN 'notes writable'
  WHEN has_table_privilege('pmis_app', 'public.admin_overrides', 'INSERT') THEN 'overrides writable'
  ELSE 'ok' END;
-- @end
