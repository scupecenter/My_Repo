-- 0097: documents hub (owner request 2026-11-14, spec section 1): Excel-like grid, saved columns, site-level settings, Library delete rule.
--
-- WHY. The Documents screen listed uploaded files only. The owner wants one grid: sites in rows, document types in columns, one status per cell,
-- a saved column set per user, site-level exceptions with a reason, a misplaced file moved to its slot, and a Library rule that frees unused types.
--
-- WHAT THIS ADDS
--   document_grid_views          one saved column set per user (the grid's visible columns); each user reads only their own row
--   document_site_overrides      "not required for this site" with a reason, one active row per (site, type); ended by docs_site_override_revert
--   docs_require_site_edit       internal: sites.edit for the site's region (app_has_permission + region filter); no grant to pmis_app
--   docs_grid_view_save          the signed-in user saves the columns of their own grid view
--   docs_site_override_set       marks a document type not required for one site; the site's open slots of that type become not_required (as a placement change does)
--   docs_site_override_revert    ends the override; the slots go back to missing or uploaded from their files
--   docs_file_move               moves a file (all its versions) to another slot of the SAME site; approved files are refused; both slots are recomputed
--   admin_delete_document_type   System Admin: hard delete when no file and no blank form was ever uploaded for the type, otherwise deactivation with the reason
-- Every write is audited with before and after and the reason (log via wfe_audit). Decision B14 (never a hard delete) is amended for document types only:
-- a type with no file ever uploaded may be deleted; a type with a file is deactivated, as before.

CREATE TABLE IF NOT EXISTS document_grid_views (
  user_id    uuid PRIMARY KEY REFERENCES users(id),
  columns    text[] NOT NULL CHECK (cardinality(columns) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_site_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES sites(id),
  region_id     integer NOT NULL,
  doc_type_id   uuid NOT NULL REFERENCES document_types(id),
  kind          text NOT NULL CHECK (kind = 'not_required'),
  reason        text NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reverted_by   uuid,
  reverted_at   timestamptz,
  revert_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS document_site_overrides_active ON document_site_overrides (site_id, doc_type_id) WHERE reverted_at IS NULL;
CREATE INDEX IF NOT EXISTS document_site_overrides_site ON document_site_overrides (site_id);

ALTER TABLE document_grid_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_select ON document_grid_views;
CREATE POLICY rls_select ON document_grid_views FOR SELECT USING (user_id = app_actor());

CREATE OR REPLACE FUNCTION docs_require_site_edit(p_site uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r integer; f int[]; a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT region_id INTO r FROM public.sites WHERE id = p_site;
  IF r IS NULL THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.')); END IF;
  IF NOT public.app_has_permission(a, 'sites', 'edit'::"PermissionAction") THEN
    RAISE EXCEPTION 'sites.edit required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  f := public.app_actor_region_filter('sites', 'edit'::"PermissionAction");
  IF f IS NOT NULL AND NOT (r = ANY (f)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
  END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION docs_grid_view_save(p_columns text[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF cardinality(coalesce(p_columns, ARRAY[]::text[])) > 300 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/columns', 'code', 'too_many', 'message', 'At most 300 columns.'))));
  END IF;
  INSERT INTO public.document_grid_views (user_id, columns, updated_at) VALUES (public.app_actor(), coalesce(p_columns, ARRAY[]::text[]), now())
  ON CONFLICT (user_id) DO UPDATE SET columns = EXCLUDED.columns, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION docs_site_override_set(p_site uuid, p_doc text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r integer; dt public.document_types%ROWTYPE; oid uuid; n integer;
BEGIN
  r := public.docs_require_site_edit(p_site);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO dt FROM public.document_types WHERE code = p_doc AND is_active;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The document type does not exist or is inactive.')); END IF;
  IF EXISTS (SELECT 1 FROM public.document_site_overrides WHERE site_id = p_site AND doc_type_id = dt.id AND reverted_at IS NULL) THEN
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'This document is already marked not required for the site.'));
  END IF;
  INSERT INTO public.document_site_overrides (site_id, region_id, doc_type_id, kind, reason, created_by)
    VALUES (p_site, r, dt.id, 'not_required', btrim(p_reason), public.app_actor()) RETURNING id INTO oid;
  -- open slots of this type on the site follow the same rule as a placement change: only slots without an approved or in-review file
  UPDATE public.document_slots SET status = 'not_required'::public."DocStatus", updated_at = now()
    WHERE site_id = p_site AND doc_type_id = dt.id AND status IN ('missing', 'rejected', 'uploaded');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.wfe_audit('documents_site_override_set', 'site', p_site::text, NULL,
    jsonb_build_object('override_id', oid, 'doc_code', dt.code, 'kind', 'not_required', 'slots_changed', n), p_reason);
  RETURN jsonb_build_object('id', oid, 'slots_changed', n);
END $$;

CREATE OR REPLACE FUNCTION docs_site_override_revert(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.document_site_overrides%ROWTYPE; dc text; n integer;
BEGIN
  SELECT * INTO o FROM public.document_site_overrides WHERE id = p_id;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The override does not exist.')); END IF;
  PERFORM public.docs_require_site_edit(o.site_id);
  PERFORM public.calc_require_reason(p_reason);
  IF o.reverted_at IS NOT NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The override was already ended.')); END IF;
  UPDATE public.document_site_overrides SET reverted_at = now(), reverted_by = public.app_actor(), revert_reason = btrim(p_reason) WHERE id = p_id;
  SELECT code INTO dc FROM public.document_types WHERE id = o.doc_type_id;
  -- the slots return to the status their files give (uploaded when a current file exists, otherwise missing)
  UPDATE public.document_slots s SET status = (CASE WHEN EXISTS (SELECT 1 FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current AND f.withdrawn_at IS NULL)
      THEN 'uploaded' ELSE 'missing' END)::public."DocStatus", updated_at = now()
    WHERE s.site_id = o.site_id AND s.doc_type_id = o.doc_type_id AND s.status = 'not_required';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.wfe_audit('documents_site_override_revert', 'site', o.site_id::text, jsonb_build_object('override_id', p_id, 'doc_code', dc, 'kind', 'not_required'),
    jsonb_build_object('override_id', p_id, 'slots_changed', n), p_reason);
  RETURN jsonb_build_object('id', p_id, 'slots_changed', n);
END $$;

CREATE OR REPLACE FUNCTION docs_file_move(p_file uuid, p_target uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.document_files%ROWTYPE; src public.document_slots%ROWTYPE; tgt public.document_slots%ROWTYPE; tdt public.document_types%ROWTYPE;
  n integer; ntgt integer; nsrc integer;
BEGIN
  SELECT * INTO f FROM public.document_files WHERE id = p_file AND withdrawn_at IS NULL;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The file does not exist or was withdrawn.')); END IF;
  SELECT * INTO src FROM public.document_slots WHERE id = f.slot_id;
  PERFORM public.docs_require_site_edit(src.site_id);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO tgt FROM public.document_slots WHERE id = p_target;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The target slot does not exist.')); END IF;
  IF tgt.id = src.id THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/target_slot_id', 'code', 'same_slot', 'message', 'The file is already in this slot.')))); END IF;
  IF tgt.site_id <> src.site_id THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/target_slot_id', 'code', 'other_site', 'message', 'A file moves only within its own site.')))); END IF;
  IF src.status = 'approved' OR tgt.status = 'approved' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'An approved file or slot cannot be moved. Revert the approval first.'));
  END IF;
  SELECT * INTO tdt FROM public.document_types WHERE id = tgt.doc_type_id;
  IF NOT (coalesce(f.ext, '') = ANY (tdt.formats)) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/target_slot_id', 'code', 'format', 'message', 'The target document does not accept this file format.'))));
  END IF;
  UPDATE public.document_files SET slot_id = tgt.id WHERE file_group_id = f.file_group_id AND slot_id = src.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT count(*) INTO nsrc FROM public.document_files WHERE slot_id = src.id AND is_current AND withdrawn_at IS NULL;
  SELECT count(*) INTO ntgt FROM public.document_files WHERE slot_id = tgt.id AND is_current AND withdrawn_at IS NULL;
  UPDATE public.document_slots SET status = (CASE WHEN nsrc > 0 THEN status::text ELSE 'missing' END)::public."DocStatus", updated_at = now() WHERE id = src.id;
  UPDATE public.document_slots SET status = (CASE WHEN status = 'missing' THEN 'uploaded' ELSE status::text END)::public."DocStatus", updated_at = now() WHERE id = tgt.id;
  PERFORM public.wfe_audit('documents_file_move', 'document_file', p_file::text,
    jsonb_build_object('slot_id', src.id, 'doc_type_id', src.doc_type_id), jsonb_build_object('slot_id', tgt.id, 'doc_type_id', tgt.doc_type_id, 'versions_moved', n), p_reason);
  RETURN jsonb_build_object('file_id', p_file, 'source_slot_id', src.id, 'target_slot_id', tgt.id, 'versions_moved', n, 'target_current_files', ntgt);
END $$;

CREATE OR REPLACE FUNCTION admin_delete_document_type(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.document_types%ROWTYPE;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO d FROM public.document_types WHERE id = p_id;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The document type does not exist.')); END IF;
  IF EXISTS (SELECT 1 FROM public.document_files f JOIN public.document_slots s ON s.id = f.slot_id WHERE s.doc_type_id = p_id)
     OR EXISTS (SELECT 1 FROM public.document_blank_forms b WHERE b.doc_type_id = p_id) THEN
    UPDATE public.document_types SET is_active = false, updated_at = now() WHERE id = p_id;
    PERFORM public.wfe_audit('document_type_deactivate', 'document_type', d.code, jsonb_build_object('is_active', d.is_active), jsonb_build_object('is_active', false), p_reason);
    RETURN jsonb_build_object('mode', 'deactivated');
  END IF;
  PERFORM public.wfe_audit('document_type_delete', 'document_type', d.code, jsonb_build_object('name_en', d.name_en, 'name_ar', d.name_ar, 'is_active', d.is_active), NULL, p_reason);
  DELETE FROM public.document_slots WHERE doc_type_id = p_id;
  DELETE FROM public.document_type_placements WHERE doc_type_id = p_id;
  DELETE FROM public.document_type_versions WHERE doc_type_id = p_id;
  DELETE FROM public.document_type_drafts WHERE doc_type_id = p_id;
  DELETE FROM public.document_site_overrides WHERE doc_type_id = p_id;
  DELETE FROM public.document_types WHERE id = p_id;
  RETURN jsonb_build_object('mode', 'deleted');
END $$;

-- Table rights: the application role reads, and writes only through the functions above (see db/sql/app_grants.sql for the narrowing).
DO $$
DECLARE f text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON document_grid_views, document_site_overrides FROM pmis_app;
    FOREACH f IN ARRAY ARRAY['docs_require_site_edit(uuid)', 'docs_grid_view_save(text[])', 'docs_site_override_set(uuid,text,text)', 'docs_site_override_revert(uuid,text)',
                             'docs_file_move(uuid,uuid,text)', 'admin_delete_document_type(uuid,text)'] LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
