-- 0115: the counts of an import batch keep the region rule of its rows (security review of 0114, CHANGELOG 152).
--
-- WHY. imp_batch_counts (0114) counted every row of a visible batch. Before 0114 the list counted through v_import_rows, so the row rule of
-- import_batch_rows (rls_select, 0037: a row of a region outside the caller's regions is not visible) applied: a person who may see a batch never
-- learnt how many rows it had in another region. 0114 was merged before this fix, so the fix is its own migration (an applied migration never changes).
--
-- WHAT. imp_batch_counts counts only the rows whose region is NULL or passes app_region_check, as rls_select does. The status of the batch is still decided
-- from every row, as imp_status_of always did. CREATE OR REPLACE keeps the owner (pmis_definer), the search_path and the grants of 0114.

CREATE OR REPLACE FUNCTION imp_batch_counts(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; c record; st text;
BEGIN
  IF NOT public.imp_batch_visible(p_batch) THEN RETURN NULL; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND THEN RETURN NULL; END IF;
  WITH x AS (
    SELECT r.action, r.admin_approved, r.incomplete, (r.region_id IS NULL OR public.app_region_check(r.region_id)) AS vis,   -- the row rule of 0037
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
    'c_admin_approved', c.c_admin_approved, 'c_incomplete', c.c_incomplete);
END $$;
