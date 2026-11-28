-- 0491_workflow_lock_mode: the sequence lock mode of a workflow version, Strict or Open (D49 part 1, owner approval relayed 2026-11-27). Additive.
-- Mirror: db/sql/490_workflow_lock_mode.sql (kept identical to prisma/migrations/0491_workflow_lock_mode/migration.sql).
--
-- WHY. The sequencing locks (a task waits for its predecessors and for the gate in front of its stage) are switched per site (0085, sites.workflow_locks).
-- The owner wants the default to be chosen once per workflow version, Strict (as today) or Open, and the site switch to stay as the override.
--
--   1. workflow_definitions.lock_mode: 'strict' (default) or 'open'. Every existing version keeps 'strict': no behaviour changes for any site.
--   2. admin_wf_lock_mode(version, etag, mode, reason): a draft only; the right of the publish door (workflow_versions administer, a System Admin or an
--      all-regions delegate), reason, ETag, audit row with before and after. It does NOT touch any site: the mode is the default that the new-site form offers.
--   3. wfe_summary_json lists lock_mode and admin_wf_create_draft copies it to a new draft. Both are patched by their stored text (idempotent, anchored,
--      they raise when the anchor is missing).
-- The per-site switch (0085) and the engine are unchanged. No permission, role, grant or default-value change. No new table.

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS lock_mode text NOT NULL DEFAULT 'strict' CHECK (lock_mode IN ('strict', 'open'));

CREATE OR REPLACE FUNCTION admin_wf_lock_mode(p_version integer, p_etag integer, p_mode text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE w public.workflow_definitions%ROWTYPE;
BEGIN
  PERFORM public.wfe_require('workflow_versions', 'administer');
  PERFORM public.calc_require_reason(p_reason);
  IF p_mode IS NULL OR p_mode NOT IN ('strict', 'open') THEN PERFORM public.wfe_err1('/lock_mode', 'invalid', 'The lock mode is strict or open.'); END IF;
  w := public.wfe_lock(p_version, p_etag);
  IF w.status <> 'draft' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The lock mode is changed in a draft version: copy the published version to a draft first.')); END IF;
  IF w.lock_mode = p_mode THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Nothing changes.')); END IF;
  UPDATE public.workflow_definitions SET lock_mode = p_mode WHERE id = w.id;
  PERFORM public.wfe_bump(w.id);
  PERFORM public.wfe_audit('workflow_lock_mode', 'workflow_definition', p_version::text, jsonb_build_object('lock_mode', w.lock_mode), jsonb_build_object('lock_mode', p_mode), p_reason);
  RETURN jsonb_build_object('version', public.wfe_version_json(w.id));
END $$;

DO $$
DECLARE def text; anchor text;
BEGIN
  def := pg_get_functiondef('public.wfe_summary_json(public.workflow_definitions)'::regprocedure);
  IF position('''lock_mode'', w.lock_mode' IN def) = 0 THEN
    anchor := '''effective_from'', w.effective_from)';
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'wfe_summary_json: the anchor was not found'; END IF;
    EXECUTE replace(def, anchor, '''effective_from'', w.effective_from, ''lock_mode'', w.lock_mode)');
  END IF;
  def := pg_get_functiondef('public.admin_wf_create_draft(integer,text)'::regprocedure);
  IF position('lock_mode = w.lock_mode' IN def) = 0 THEN
    anchor := 'UPDATE public.workflow_definitions SET parent_version = p_parent WHERE id = nid;';
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'admin_wf_create_draft: the anchor was not found'; END IF;
    EXECUTE replace(def, anchor, 'UPDATE public.workflow_definitions SET parent_version = p_parent, lock_mode = w.lock_mode WHERE id = nid;');
  END IF;
END $$;

DO $$
BEGIN
  ALTER FUNCTION admin_wf_lock_mode(integer,integer,text,text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION admin_wf_lock_mode(integer,integer,text,text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION admin_wf_lock_mode(integer,integer,text,text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_wf_lock_mode(integer,integer,text,text) TO pmis_app;
  END IF;
END $$;
