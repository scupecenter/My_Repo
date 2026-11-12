-- The register sheets of the historical Master load (migration 0088, owner decision 2026-11-12 "Everything from the one file"; contract 0.15.7).
-- The direct-approval flag of a register record and the parsed register rows of a background apply are written only by the definer functions of 0088; the staging
-- of the sheets, the direct approval and the helpers are internal; the only door is mi_apply_run(..., p_registers), which checks the run's file and the
-- historical load. Alice: CW Team Lead in Tripoli, not a System Admin. ADMIN: the System Admin.

-- @case HRG-01
-- @title The System Admin sets the direct-approval flag of a register record directly
-- @category historical-registers
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
UPDATE register_records SET historical_direct_approved = true, historical_direct_approved_at = now();
-- @end

-- @case HRG-02
-- @title Alice reads the parsed register rows of a background apply
-- @category historical-registers
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT registers FROM mi_apply_jobs;
-- @end

-- @case HRG-03
-- @title The System Admin with a step-up approves a register record directly through the internal function
-- @category historical-registers
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hda_approve_record(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), true);
-- @end

-- @case HRG-04
-- @title The System Admin stages register rows of their own through the internal staging
-- @category historical-registers
-- @expect error 42501 permission denied
\ctx ADMIN stepup=300
SELECT hrg_stage_registers('{"parts": []}'::jsonb, NULL::master_reconciliation_runs, 'submit', gen_random_uuid(), 'a forged load');
-- @end

-- @case HRG-05
-- @title Alice, not a System Admin, calls the door with register rows
-- @category historical-registers
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT mi_apply_run(gen_random_uuid(), NULL, 'submit', 'forged load', true, '{"reason": "forged load", "registers": true}'::jsonb, '{"file_sha256": "0", "parts": []}'::jsonb);
-- @end

-- @case HRG-06
-- @title The marker of the quiet notices, set by the caller, writes nothing it may not write (the helper of the link is internal)
-- @category historical-registers
-- @actor ADMIN
-- @region *
-- @expect error 42501 permission denied
SELECT hrg_row_historical();
-- @end
