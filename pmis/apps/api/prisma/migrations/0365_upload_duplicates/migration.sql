-- 0365 (P4 + P8, data-entry review 2026-11-27): the duplicates category of an upload.
--
-- WHAT. imp_batch_counts gains one number, c_duplicate: the rows of the batch that were refused because the same record is already in the file
-- (error code duplicate_in_file, written by every staging door since 0037). They are still `error` rows (nothing about staging, approval or export changes);
-- the count lets the upload dialog and the batch review show "duplicates" as a category of its own beside valid and rejected, from the server counts.
-- Additive: CREATE OR REPLACE keeps the owner, the search_path and the grants; every other key of the answer is unchanged.

CREATE OR REPLACE FUNCTION imp_batch_counts(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; c record; st text;
BEGIN
  IF NOT public.imp_batch_visible(p_batch) THEN RETURN NULL; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND THEN RETURN NULL; END IF;
  WITH x AS (
    SELECT r.action, (r.action = 'error' AND coalesce(r.errors, '[]'::jsonb) @> '[{"code": "duplicate_in_file"}]'::jsonb) AS dup, r.admin_approved, r.incomplete, (r.region_id IS NULL OR public.app_region_check(r.region_id)) AS vis,   -- the row rule of 0037
      CASE WHEN r.action IN ('error', 'unchanged') THEN r.decision
           WHEN r.task_instance_id IS NOT NULL THEN
             CASE WHEN r.decision = 'pending' AND r.task_submitted_at IS NOT NULL AND ti.state = 'approved' THEN 'approved'
                  WHEN r.decision = 'pending' AND r.task_submitted_at IS NOT NULL AND ti.state IN ('open', 'entry', 'na', 'skipped') THEN 'rejected'
                  ELSE r.decision END
           WHEN r.decision = 'pending' AND rr.state = 'approved' THEN 'approved'
           WHEN r.decision = 'pending' AND rr.state = 'voided' THEN 'rejected'
           WHEN r.decision = 'pending' AND rr.state = 'entry' AND rr.submitted_at IS NOT NULL THEN 'rejected'
           ELSE r.decision END AS eff
    FROM public.import_batch_rows r
    LEFT JOIN public.register_records rr ON rr.id = r.register_record_id
    LEFT JOIN public.task_instances ti ON ti.id = r.task_instance_id
    WHERE r.batch_id = p_batch)
  SELECT count(*) FILTER (WHERE vis AND action = 'create') AS c_create, count(*) FILTER (WHERE vis AND action = 'update') AS c_update,
         count(*) FILTER (WHERE vis AND action = 'unchanged') AS c_unchanged, count(*) FILTER (WHERE vis AND action = 'error') AS c_error,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'pending') AS c_pending,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'approved') AS c_approved,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'rejected') AS c_rejected,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'pending_previous_approval') AS c_held,
         count(*) FILTER (WHERE vis AND action IN ('create', 'update') AND eff = 'saved') AS c_saved,
         count(*) FILTER (WHERE vis AND dup) AS c_duplicate,
         count(*) FILTER (WHERE vis AND admin_approved) AS c_admin_approved, count(*) FILTER (WHERE vis AND admin_approved AND incomplete) AS c_incomplete,
         -- the status of the batch, from every row (as imp_status_of)
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff IN ('pending', 'pending_previous_approval')) AS s_open,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'approved') AS s_ok,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'rejected') AS s_rej
    INTO c FROM x;
  -- the status, as imp_status_of (0074) decides it
  IF EXISTS (SELECT 1 FROM public.import_batch_jobs j WHERE j.batch_id = p_batch AND j.state = 'running') THEN st := 'processing';
  ELSIF b.status NOT IN ('in_approval', 'partially_approved', 'approved', 'rejected') THEN st := b.status;
  ELSE
    st := CASE WHEN c.s_open > 0 AND c.s_ok + c.s_rej = 0 THEN 'in_approval' WHEN c.s_open > 0 THEN 'partially_approved'
               WHEN c.s_ok > 0 THEN 'approved' ELSE 'rejected' END;
  END IF;
  RETURN jsonb_build_object('status', st, 'c_create', c.c_create, 'c_update', c.c_update, 'c_unchanged', c.c_unchanged, 'c_error', c.c_error,
    'c_pending', c.c_pending, 'c_approved', c.c_approved, 'c_rejected', c.c_rejected, 'c_held', c.c_held, 'c_saved', c.c_saved,
    'c_duplicate', c.c_duplicate, 'c_admin_approved', c.c_admin_approved, 'c_incomplete', c.c_incomplete);
END $$;

ALTER FUNCTION imp_batch_counts(uuid) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION imp_batch_counts(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN GRANT EXECUTE ON FUNCTION imp_batch_counts(uuid) TO pmis_app; END IF;
END $$;
