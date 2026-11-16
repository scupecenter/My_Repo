-- 0114: the list of import batches answers fast after a big load (owner report 2026-11-16, CHANGELOG 151).
--
-- WHY. After the historical load of the Master, GET /import-batches answered 500: the request transaction was closed after 30 s (P2028). The list counted
-- the rows of every visible batch through v_import_rows (security_invoker: the joins to task_instances and register_records go through their row
-- security, row by row), then counted them again in imp_status_of, and only then sorted and kept one page. MEASURED (470 synthetic sites, a historical
-- apply, 3 batches, 10,340 rows): 3.5 to 5.8 s for the list of 3 batches; the owner's server has more batches and the register rows too.
--
-- WHAT. imp_batch_counts(batch) gives the status and every count of a batch in one pass over its rows, by the batch_id index, with the same rules as
-- v_import_rows (eff_decision) and imp_status_of (status). It is a definer function, as imp_status_of already is, so the counts are those of the batch
-- (imp_status_of never saw them through row security either; the per-row lists still do). It answers only for a batch the caller may see
-- (imp_batch_visible), NULL otherwise. The API now reads the page of batches first and counts only those.
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, PUBLIC revoked, EXECUTE for pmis_app.

CREATE OR REPLACE FUNCTION imp_batch_counts(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.import_batches%ROWTYPE; c record; st text;
BEGIN
  IF NOT public.imp_batch_visible(p_batch) THEN RETURN NULL; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND THEN RETURN NULL; END IF;
  WITH x AS (
    SELECT r.action, r.admin_approved, r.incomplete,
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
  SELECT count(*) FILTER (WHERE action = 'create') AS c_create, count(*) FILTER (WHERE action = 'update') AS c_update,
         count(*) FILTER (WHERE action = 'unchanged') AS c_unchanged, count(*) FILTER (WHERE action = 'error') AS c_error,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'pending') AS c_pending,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'approved') AS c_approved,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'rejected') AS c_rejected,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'pending_previous_approval') AS c_held,
         count(*) FILTER (WHERE action IN ('create', 'update') AND eff = 'saved') AS c_saved,
         count(*) FILTER (WHERE admin_approved) AS c_admin_approved, count(*) FILTER (WHERE admin_approved AND incomplete) AS c_incomplete
    INTO c FROM x;
  -- the status, as imp_status_of (0074) decides it
  IF EXISTS (SELECT 1 FROM public.import_batch_jobs j WHERE j.batch_id = p_batch AND j.state = 'running') THEN st := 'processing';
  ELSIF b.status NOT IN ('in_approval', 'partially_approved', 'approved', 'rejected') THEN st := b.status;
  ELSE
    st := CASE WHEN c.c_pending + c.c_held > 0 AND c.c_approved + c.c_rejected = 0 THEN 'in_approval' WHEN c.c_pending + c.c_held > 0 THEN 'partially_approved'
               WHEN c.c_approved > 0 THEN 'approved' ELSE 'rejected' END;
  END IF;
  RETURN jsonb_build_object('status', st, 'c_create', c.c_create, 'c_update', c.c_update, 'c_unchanged', c.c_unchanged, 'c_error', c.c_error,
    'c_pending', c.c_pending, 'c_approved', c.c_approved, 'c_rejected', c.c_rejected, 'c_held', c.c_held, 'c_saved', c.c_saved,
    'c_admin_approved', c.c_admin_approved, 'c_incomplete', c.c_incomplete);
END $$;

ALTER FUNCTION imp_batch_counts(uuid) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION imp_batch_counts(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN GRANT EXECUTE ON FUNCTION imp_batch_counts(uuid) TO pmis_app; END IF;
END $$;
