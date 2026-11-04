-- 0056_p6_documents_snags: work package P6 of the owner answers of 2026-11-04 (documents, QC snags and storage; contract 0.12.4; CHANGELOG 82).
-- Mirrored byte-identically as db/sql/055_p6_documents_snags.sql.
--
-- What this adds (every write is a SECURITY DEFINER function with a fixed search_path; the audit rows go through log_audit_write):
--   Q195  storage_scan_states: the scan state of a list of stored objects, so the zip export leaves out every file that has not passed the virus scan
--         (pending_rescan or infected). The quarantine itself stays as 0048 built it (an infected object stays infected for ever).
--   Q226  doc_procurement_delivery reads the approved version in force of each Procurement order of the site (never a draft, never a voided one):
--         Outsourced when any covering order is Outsourced, the common delivery when every order has the same one, and `pending` otherwise (no
--         approved order, an order without a delivery, or mixed values). A conditional slot whose rule waits for that answer is flagged
--         determination_pending (doc_mark_pending); a task cannot be approved while one of its slots is pending (trigger doc_task_pending_gate),
--         unless Data Entry declared that the document applies.
--   Q227  One requirement per purpose: a document type placed on a task and on the register of a record that is the source of that task is one logical
--         requirement. doc_slot_twin names the other slot; wf_missing_slots and doc_record_missing_core count a missing slot as filled when its twin
--         holds a current file that is uploaded, in review or approved.
--   Q228  Slots on global register records (no site, no region: Contractors, Risks, Meetings): document_slots.is_global; the slot's visibility comes
--         from the record (RLS app_region_read, as register_records); the API adds the register's module.
--   Q229  Setting documents.new_version_inherit (default false = as built: a new version reopens the approved slots for L2). When true, the approved
--         slots of the record keep their approval in the new version (inherited_at, audited); a replaced or withdrawn file sends the slot back to L2.
--         Voiding a correction draft brings back the approved files the draft replaced, keeps a real withdrawal, and never makes up an approval.
--   Q230  The QC snag records the finder, the fixer and the approver separately (found_by, fixed_by, approved_by). The Matrix gets the row
--         `quality_te` (Quality - TE stream; seeded as a copy of the Quality row's global cells so nothing changes until the admin edits it): a TE
--         snag takes L1 and L2 from its region cell, else the Quality region cell, else its global cell, else the Quality global cell.
--   D230b Self-approval is forbidden for QC snags only: whoever raised, found or fixed a snag (submitted it, or uploaded one of its photos) may not
--         approve its closure (self_approval_forbidden). B5 stays for every other task and record.
--   Q231  An L2 cell set to "all members" is honoured for snags: every eligible approver (except the people above) votes; the last vote closes.
--   Q232  Setting qc.exif_tolerance_hours (default 24). EXIF wall-clock times are read in Africa/Tripoli by the API. A fix photo dated before the raise
--         beyond the tolerance is refused (as before); one dated in the future beyond the tolerance is kept as pending_evidence: it is not counted
--         as proof of the fix until L2 accepts it (qc_decide_evidence).
--   Q233  The snag type catalogue is fully editable: stream (CW, TE or both) and blocking_rule (always, by_severity, never); a severity catalogue
--         (snag_severities, codes with EN/AR names and a blocks flag, deactivated, never deleted). A snag needs a severity when it is raised.
--         The PAC / FAC block counts an open snag whose type always blocks, or blocks by severity and the severity blocks (a legacy snag
--         without a severity blocks, conservatively). QC_GENERAL stays the default type and keeps blocking (always).
--   Q234 / Q103 (Quality)  The Quality register's record of type `snag` and the QC snag are one work item through a managed 1:1 link
--         (snags.register_entity_id): the final approval of the record creates (or updates) its QC snag, idempotently; the snag is closed only by the
--         QC photo flow, never by the record. A record whose last approved version is voided cancels its open snag. qc_link_backfill links the
--         existing records once (an unlinked QC snag of the same site, stream and title is linked instead of duplicated; ambiguous ones are listed).
--   Settings: admin_save_documents_qc (document_types edit, reason, If-Match, audited) and admin_save_snag_severities.
--   pmis_app is read-only on every new table (db/sql/app_grants.sql).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 0. Audit helper: log_audit_write when there is a signed-in actor; a migration-time run (no actor) writes the row itself.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION p6_audit(p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_reason text, p_site uuid, p_region integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_actor() IS NOT NULL THEN
    PERFORM public.log_audit_write(p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason, p_site, p_region);
  ELSE
    INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason)
    VALUES (p_action, p_entity_type, left(p_entity_id, 200), p_site, p_region, p_before, p_after, left(p_reason, 2000));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Settings (Q229, Q232)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('documents.new_version_inherit', 'false', 'Q229: a new version of an approved register record keeps the approval of its unchanged document slots (true), or sends every approved slot back to L2 (false, as built).', now()),
  ('qc.exif_tolerance_hours', '24', 'Q232: hours of tolerance of the EXIF date of a fix photo, before the raise of the snag and after the upload (EXIF has no time zone; read in Africa/Tripoli).', now()),
  ('documents.qc_settings_version', '1', 'Version (If-Match) of the documents and QC settings screen.', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION documents_qc_settings_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'new_version_inherit', coalesce((public.calc_setting('documents.new_version_inherit', 'false'::jsonb) #>> '{}')::boolean, false),
    'exif_tolerance_hours', coalesce((public.calc_setting('qc.exif_tolerance_hours', '24'::jsonb) #>> '{}')::int, 24),
    'version', coalesce((public.calc_setting('documents.qc_settings_version', '1'::jsonb) #>> '{}')::int, 1),
    'updated_at', (SELECT max(s.updated_at) FROM public.settings s WHERE s.key IN ('documents.new_version_inherit', 'qc.exif_tolerance_hours', 'documents.qc_settings_version')),
    'updated_by', (SELECT s.updated_by FROM public.settings s WHERE s.key = 'documents.qc_settings_version'))
$$;

-- p_patch keys: new_version_inherit (boolean), exif_tolerance_hours (0 to 168). Unknown keys are refused with field errors.
CREATE OR REPLACE FUNCTION admin_save_documents_qc(p_patch jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; k text; nv int; actor uuid := public.app_actor();
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/', 'code', 'required', 'message', 'Send at least one setting.'));
  ELSE
    FOR k IN SELECT jsonb_object_keys(p_patch) ORDER BY 1 LOOP
      IF k NOT IN ('new_version_inherit', 'exif_tolerance_hours') THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || k, 'code', 'unknown_key', 'message', 'Unknown setting.'));
      END IF;
    END LOOP;
    IF p_patch ? 'new_version_inherit' AND jsonb_typeof(p_patch -> 'new_version_inherit') <> 'boolean' THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/new_version_inherit', 'code', 'invalid', 'message', 'true or false.'));
    END IF;
    IF p_patch ? 'exif_tolerance_hours' AND (jsonb_typeof(p_patch -> 'exif_tolerance_hours') <> 'number'
        OR (p_patch ->> 'exif_tolerance_hours')::numeric NOT BETWEEN 0 AND 168 OR (p_patch ->> 'exif_tolerance_hours')::numeric <> trunc((p_patch ->> 'exif_tolerance_hours')::numeric)) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/exif_tolerance_hours', 'code', 'out_of_range', 'message', 'A whole number of hours from 0 to 168.'));
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  PERFORM 1 FROM public.settings WHERE key = 'documents.qc_settings_version' FOR UPDATE;
  cur := public.documents_qc_settings_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::int THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The settings changed since you read them. Reload and try again.'));
  END IF;
  nv := (cur ->> 'version')::int + 1;
  IF p_patch ? 'new_version_inherit' THEN
    INSERT INTO public.settings (key, value, updated_by, updated_at) VALUES ('documents.new_version_inherit', p_patch -> 'new_version_inherit', actor, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  IF p_patch ? 'exif_tolerance_hours' THEN
    INSERT INTO public.settings (key, value, updated_by, updated_at) VALUES ('qc.exif_tolerance_hours', to_jsonb((p_patch ->> 'exif_tolerance_hours')::int), actor, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  INSERT INTO public.settings (key, value, updated_by, updated_at) VALUES ('documents.qc_settings_version', to_jsonb(nv), actor, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM public.log_audit_write('settings.documents_qc_set', 'setting', 'documents.qc',
    cur - 'updated_at' - 'updated_by', public.documents_qc_settings_json() - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN public.documents_qc_settings_json();
END $$;

-- The tolerance of the EXIF check (Q132, now a setting: Q232).
CREATE OR REPLACE FUNCTION qc_exif_tolerance() RETURNS interval
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT make_interval(hours => greatest(0, least(168, coalesce((public.calc_setting('qc.exif_tolerance_hours', '24'::jsonb) #>> '{}')::int, 24))))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q195: the scan state of stored objects (zip exports leave out what has not passed the scan)
-- ---------------------------------------------------------------------------------------------------------------------
-- A key without an envelope row is a legacy plaintext object (stored before 0048, scanned at upload when the scan was on): reported as `legacy`.
CREATE OR REPLACE FUNCTION storage_scan_states(p_keys text[]) RETURNS TABLE (storage_key text, scan_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k, coalesce(m.scan_status, 'legacy') FROM unnest(coalesce(p_keys, ARRAY[]::text[])) AS k LEFT JOIN public.stored_object_meta m ON m.storage_key = k
  WHERE cardinality(coalesce(p_keys, ARRAY[]::text[])) <= 10000
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q228: slots on global register records
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE document_slots
  ADD COLUMN IF NOT EXISTS is_global boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS determination_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inherited_at timestamptz;
ALTER TABLE document_slots ALTER COLUMN site_id DROP NOT NULL, ALTER COLUMN region_id DROP NOT NULL;
ALTER TABLE document_slots ADD CONSTRAINT document_slots_global_check CHECK (
  (is_global AND site_id IS NULL AND region_id IS NULL AND register_entity_id IS NOT NULL AND task_id IS NULL)
  OR (NOT is_global AND site_id IS NOT NULL AND region_id IS NOT NULL));
DROP POLICY IF EXISTS rls_select ON document_slots;
CREATE POLICY rls_select ON document_slots FOR SELECT USING (app_region_read(is_global, region_id));

-- The slot set of a logical record (0047), now also for a global record (no site, no region).
CREATE OR REPLACE FUNCTION doc_sync_record_slots_core(p_entity uuid, p_true uuid[] DEFAULT ARRAY[]::uuid[], p_false uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d record; made int := 0; ex record; nfiles int; snap_at timestamptz;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE entity_id = p_entity AND state = 'entry' ORDER BY version_no DESC LIMIT 1;
  IF NOT FOUND OR (NOT r.is_global AND (r.site_id IS NULL OR r.region_id IS NULL)) THEN RETURN 0; END IF;
  SELECT taken_at INTO snap_at FROM public.document_record_snapshots WHERE entity_id = p_entity;
  FOR d IN
    SELECT dt.id, dt.condition_rule, v.id AS vid FROM public.document_types dt
    JOIN public.document_type_versions v ON v.doc_type_id = dt.id AND v.version_no = dt.published_version
    WHERE dt.lib_managed AND dt.is_active AND dt.published_version > 0
      AND EXISTS (SELECT 1 FROM public.document_type_placements pl
                  WHERE pl.doc_type_id = dt.id AND pl.kind = 'register' AND pl.register_key = r.register_key
                    AND (pl.record_type IS NULL OR pl.record_type = r.record_type))
      AND (snap_at IS NULL OR EXISTS (SELECT 1 FROM public.document_type_versions pv WHERE pv.doc_type_id = dt.id AND (pv.published_at <= snap_at OR pv.apply_to = 'open_too')))
  LOOP
    IF d.condition_rule IS NULL OR d.id = ANY (p_true) THEN
      IF NOT EXISTS (SELECT 1 FROM public.document_slots s WHERE s.register_entity_id = p_entity AND s.doc_type_id = d.id) THEN
        INSERT INTO public.document_slots (register_entity_id, register_key, site_id, region_id, is_global, doc_type_id, status, doc_type_version_id)
        VALUES (p_entity, r.register_key, r.site_id, r.region_id, r.is_global, d.id, 'missing', d.vid);
        made := made + 1;
      ELSIF d.condition_rule IS NOT NULL THEN
        FOR ex IN SELECT s.id FROM public.document_slots s WHERE s.register_entity_id = p_entity AND s.doc_type_id = d.id AND s.status::text = 'not_required' LOOP
          SELECT count(*) INTO nfiles FROM public.document_files f WHERE f.slot_id = ex.id AND f.is_current;
          UPDATE public.document_slots SET status = (CASE WHEN nfiles > 0 THEN 'uploaded' ELSE 'missing' END)::public."DocStatus", updated_at = now() WHERE id = ex.id;
        END LOOP;
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public.document_slots s WHERE s.register_entity_id = p_entity AND s.doc_type_id = d.id) THEN
      INSERT INTO public.document_slots (register_entity_id, register_key, site_id, region_id, is_global, doc_type_id, status, doc_type_version_id)
      VALUES (p_entity, r.register_key, r.site_id, r.region_id, r.is_global, d.id, 'not_required'::public."DocStatus", d.vid);
      made := made + 1;
    ELSIF d.id = ANY (p_false) THEN
      UPDATE public.document_slots s SET status = 'not_required'::public."DocStatus", updated_at = now()
      WHERE s.register_entity_id = p_entity AND s.doc_type_id = d.id AND s.status IN ('missing', 'rejected') AND NOT s.conditional_declared
        AND NOT EXISTS (SELECT 1 FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current);
    END IF;
  END LOOP;
  INSERT INTO public.document_record_snapshots (entity_id) VALUES (p_entity) ON CONFLICT DO NOTHING;
  RETURN made;
END $$;

CREATE OR REPLACE FUNCTION doc_record_submit_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE miss text[];
BEGIN
  PERFORM public.doc_sync_record_slots_core(NEW.entity_id);
  miss := public.doc_record_missing_core(NEW.entity_id);
  IF cardinality(miss) > 0 THEN PERFORM public.wf_err('mandatory_slots_missing', jsonb_build_object('missing', to_jsonb(miss))); END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION doc_add_record_slot(p_record uuid, p_doc_code text, p_label text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; d record; sid uuid; lbl text := nullif(btrim(coalesce(p_label, '')), ''); ex public.document_slots%ROWTYPE; nfiles int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  r := public.reg_lock(p_record, NULL);
  IF r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Slots can be added only while the record is in Data Entry.'));
  END IF;
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'edit');
  PERFORM public.reg_require_actor(r.id, 'entry', actor);
  SELECT dt.id, dt.condition_rule, v.id AS vid INTO d FROM public.document_types dt
    JOIN public.document_type_versions v ON v.doc_type_id = dt.id AND v.version_no = dt.published_version
  WHERE dt.code = p_doc_code AND dt.lib_managed AND dt.is_active AND dt.published_version > 0
    AND EXISTS (SELECT 1 FROM public.document_type_placements pl WHERE pl.doc_type_id = dt.id AND pl.kind = 'register' AND pl.register_key = r.register_key
                  AND (pl.record_type IS NULL OR pl.record_type = r.record_type));
  IF NOT FOUND THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/doc_code', 'code', 'unknown_document', 'message', 'This document is not placed on the record''s register.'))));
  END IF;
  SELECT * INTO ex FROM public.document_slots s WHERE s.register_entity_id = r.entity_id AND s.doc_type_id = d.id AND coalesce(s.candidate_label, '') = coalesce(lbl, '');
  IF FOUND THEN
    IF ex.status::text = 'not_required' THEN
      SELECT count(*) INTO nfiles FROM public.document_files f WHERE f.slot_id = ex.id AND f.is_current;
      UPDATE public.document_slots SET status = (CASE WHEN nfiles > 0 THEN 'uploaded' ELSE 'missing' END)::public."DocStatus", conditional_declared = true,
        determination_pending = false, updated_at = now() WHERE id = ex.id;
      PERFORM public.reg_audit('document_slot_add', r.id, NULL, jsonb_build_object('slot_id', ex.id, 'doc_code', p_doc_code, 'candidate_label', lbl, 'reactivated', true), NULL);
      RETURN ex.id;
    END IF;
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'The record has this slot already.', 'existing_id', ex.id));
  END IF;
  INSERT INTO public.document_slots (register_entity_id, register_key, site_id, region_id, is_global, doc_type_id, candidate_label, status, doc_type_version_id, conditional_declared)
  VALUES (r.entity_id, r.register_key, r.site_id, r.region_id, r.is_global, d.id, lbl, 'missing', d.vid, d.condition_rule IS NOT NULL) RETURNING id INTO sid;
  INSERT INTO public.document_record_snapshots (entity_id) VALUES (r.entity_id) ON CONFLICT DO NOTHING;
  PERFORM public.reg_audit('document_slot_add', r.id, NULL, jsonb_build_object('slot_id', sid, 'doc_code', p_doc_code, 'candidate_label', lbl), NULL);
  RETURN sid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Q227: one requirement per purpose (the twin slot of a task and of its source record)
-- ---------------------------------------------------------------------------------------------------------------------
-- The other slot of the same document type: for a task slot, the slot of a register record of the same site that is the source of the task (linked by
-- task_id, or matching the task's source rule); for a record slot, the slot of the task the record is the source of. Null when there is none.
-- Internal (no region gate): the readers below gate on the slot.
CREATE OR REPLACE FUNCTION doc_slot_twin_core(p_slot uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.document_slots%ROWTYPE; tc text; tw record;
BEGIN
  SELECT * INTO s FROM public.document_slots WHERE id = p_slot;
  IF NOT FOUND OR s.site_id IS NULL THEN RETURN NULL; END IF;
  IF s.task_id IS NOT NULL THEN
    SELECT td.code INTO tc FROM public.task_instances t JOIN public.task_definitions td ON td.id = t.task_def_id WHERE t.id = s.task_id;
    SELECT x.id, x.status::text AS status, x.register_key, x.register_entity_id,
           EXISTS (SELECT 1 FROM public.document_files f WHERE f.slot_id = x.id AND f.is_current) AS has_file
      INTO tw
    FROM public.document_slots x
    JOIN LATERAL (SELECT r.* FROM public.register_records r WHERE r.entity_id = x.register_entity_id AND r.state <> 'voided' ORDER BY r.version_no DESC LIMIT 1) r ON true
    WHERE x.register_entity_id IS NOT NULL AND x.site_id = s.site_id AND x.doc_type_id = s.doc_type_id
      AND EXISTS (SELECT 1 FROM public.register_task_sources ts WHERE ts.register_key = x.register_key AND ts.task_code = tc AND ts.is_active)
      AND (EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = x.register_entity_id AND o.task_id = s.task_id) OR public.reg_source_matches(r.id, tc))
    ORDER BY (x.status::text IN ('approved', 'in_review', 'uploaded')) DESC, x.id LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('slot_id', tw.id, 'owner', 'register_record', 'register_key', tw.register_key, 'register_entity_id', tw.register_entity_id,
                              'status', tw.status, 'has_file', tw.has_file);
  END IF;
  IF s.register_entity_id IS NOT NULL THEN
    SELECT x.id, x.status::text AS status, x.task_id, td.code AS task_code,
           EXISTS (SELECT 1 FROM public.document_files f WHERE f.slot_id = x.id AND f.is_current) AS has_file
      INTO tw
    FROM public.document_slots x
    JOIN public.task_instances t ON t.id = x.task_id
    JOIN public.task_definitions td ON td.id = t.task_def_id
    JOIN public.register_task_sources ts ON ts.register_key = s.register_key AND ts.task_code = td.code AND ts.is_active
    JOIN LATERAL (SELECT r.* FROM public.register_records r WHERE r.entity_id = s.register_entity_id AND r.state <> 'voided' ORDER BY r.version_no DESC LIMIT 1) r ON true
    WHERE x.site_id = s.site_id AND x.doc_type_id = s.doc_type_id
      AND (EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = s.register_entity_id AND o.task_id = x.task_id) OR public.reg_source_matches(r.id, td.code))
    ORDER BY (x.status::text IN ('approved', 'in_review', 'uploaded')) DESC, x.id LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('slot_id', tw.id, 'owner', 'task', 'task_id', tw.task_id, 'task_code', tw.task_code, 'status', tw.status, 'has_file', tw.has_file);
  END IF;
  RETURN NULL;
END $$;

-- The twin holds the requirement: a current file in a slot that is uploaded, in review or approved.
CREATE OR REPLACE FUNCTION doc_twin_holds(p_slot uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((x ->> 'has_file')::boolean AND (x ->> 'status') IN ('uploaded', 'in_review', 'approved'), false) FROM (SELECT public.doc_slot_twin_core(p_slot) AS x) y
$$;

-- Read helper (granted): the twins of the slots the caller can see.
CREATE OR REPLACE FUNCTION doc_slot_twins(p_slots uuid[]) RETURNS TABLE (slot_id uuid, twin jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id, public.doc_slot_twin_core(s.id) FROM public.document_slots s
  WHERE s.id = ANY (coalesce(p_slots, ARRAY[]::uuid[])) AND public.app_region_read(s.is_global, s.region_id) AND cardinality(p_slots) <= 500
$$;

CREATE OR REPLACE FUNCTION wf_missing_slots(p_task uuid) RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r text[]; reg int;
BEGIN
  SELECT region_id INTO reg FROM public.task_instances WHERE id = p_task;
  IF reg IS NULL OR NOT public.app_region_check(reg) THEN RETURN ARRAY[]::text[]; END IF;
  PERFORM public.doc_sync_task_slots_core(p_task);
  SELECT coalesce(array_agg(DISTINCT x.code ORDER BY x.code), ARRAY[]::text[]) INTO r FROM (
    SELECT dt.code FROM public.document_slots s
      JOIN public.document_types dt ON dt.id = s.doc_type_id
      LEFT JOIN public.document_type_versions v ON v.id = s.doc_type_version_id
    WHERE s.task_id = p_task AND s.status::text IN ('missing', 'rejected') AND coalesce(v.is_mandatory, dt.is_mandatory)
      AND NOT public.doc_twin_holds(s.id)   -- Q227: the same requirement filled on the source record
    UNION
    SELECT dt.code FROM public.task_instances t
      JOIN public.document_type_placements pl ON pl.task_def_id = t.task_def_id AND pl.kind = 'task'
      JOIN public.document_types dt ON dt.id = pl.doc_type_id AND dt.is_active AND dt.is_mandatory AND NOT dt.lib_managed
    WHERE t.id = p_task
      AND NOT EXISTS (SELECT 1 FROM public.document_slots s WHERE s.task_id = t.id AND s.doc_type_id = dt.id AND s.status IN ('uploaded', 'in_review', 'approved'))
      AND (dt.condition_rule IS NULL OR EXISTS (SELECT 1 FROM public.document_slots s WHERE s.task_id = t.id AND s.doc_type_id = dt.id))
  ) x;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION doc_record_missing_core(p_entity uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT dt.code ORDER BY dt.code), ARRAY[]::text[])
  FROM public.document_slots s
  JOIN public.document_types dt ON dt.id = s.doc_type_id
  LEFT JOIN public.document_type_versions v ON v.id = s.doc_type_version_id
  WHERE s.register_entity_id = p_entity AND s.status::text IN ('missing', 'rejected') AND coalesce(v.is_mandatory, dt.is_mandatory)
    AND NOT public.doc_twin_holds(s.id)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Q226: the Procurement delivery of a site, from the approved orders only; a rule that waits for it is pending
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION doc_procurement_delivery(p_site uuid, p_task_code text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH scopes AS (
    SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::text[]) AS list
    FROM public.register_task_sources ts, jsonb_array_elements_text(coalesce(ts.data_in -> 'scope', '[]'::jsonb)) x
    WHERE ts.register_key = 'procurement' AND ts.task_code = p_task_code AND ts.is_active
  ), cand AS (
    -- the approved version in force of each order (is_current); a draft or a voided version never decides
    SELECT nullif(btrim(coalesce(r.data ->> 'delivery', '')), '') AS delivery
    FROM public.register_records r, scopes
    WHERE r.register_key = 'procurement' AND r.site_id = p_site AND r.is_current AND r.state = 'approved'
      AND (cardinality(scopes.list) = 0 OR (r.data ->> 'scope') = ANY (scopes.list))
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM cand WHERE lower(delivery) = 'outsourced') THEN 'Outsourced'
    WHEN NOT EXISTS (SELECT 1 FROM cand) OR EXISTS (SELECT 1 FROM cand WHERE delivery IS NULL) THEN 'pending'
    WHEN (SELECT count(DISTINCT lower(delivery)) FROM cand) = 1 THEN (SELECT min(delivery) FROM cand)
    ELSE 'pending' END
  WHERE EXISTS (SELECT 1 FROM public.sites s WHERE s.id = p_site AND public.app_region_check(s.region_id))
$$;

-- The API door (granted): the conditional slots of a task whose rule waits for a pending determination (p_pending: document type ids). Any state
-- before approval; the flag is cleared on the other slots of the task.
CREATE OR REPLACE FUNCTION doc_mark_pending(p_task uuid, p_pending uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; n int;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR NOT public.app_region_check(t.region_id) OR t.state::text IN ('approved', 'na', 'skipped') THEN RETURN 0; END IF;
  UPDATE public.document_slots s SET determination_pending = (s.doc_type_id = ANY (coalesce(p_pending, ARRAY[]::uuid[])) AND NOT s.conditional_declared), updated_at = now()
  WHERE s.task_id = p_task AND s.determination_pending IS DISTINCT FROM (s.doc_type_id = ANY (coalesce(p_pending, ARRAY[]::uuid[])) AND NOT s.conditional_declared);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- A task is not approved while one of its slots waits for the determination of its rule (Data Entry may still upload the document early).
CREATE OR REPLACE FUNCTION doc_task_pending_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE codes text[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT dt.code ORDER BY dt.code), ARRAY[]::text[]) INTO codes
  FROM public.document_slots s JOIN public.document_types dt ON dt.id = s.doc_type_id
  WHERE s.task_id = NEW.id AND s.determination_pending AND NOT s.conditional_declared;
  IF cardinality(codes) > 0 THEN
    PERFORM public.wf_err('document_rule_pending', jsonb_build_object('missing', to_jsonb(codes),
      'detail', 'The rule of ' || array_to_string(codes, ', ') || ' cannot be decided yet (no approved Procurement order with a delivery): the task cannot be approved until it is.'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER doc_task_pending_gate BEFORE UPDATE OF state ON task_instances FOR EACH ROW
  WHEN (NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved') EXECUTE FUNCTION doc_task_pending_gate();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Q229: a new version of an approved record and the files of its slots
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION doc_record_opened() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE inherit boolean := coalesce((public.calc_setting('documents.new_version_inherit', 'false'::jsonb) #>> '{}')::boolean, false); ids uuid[];
BEGIN
  IF NEW.version_no > 1 THEN
    IF inherit THEN
      WITH u AS (UPDATE public.document_slots SET inherited_at = now(), updated_at = now() WHERE register_entity_id = NEW.entity_id AND status = 'approved' RETURNING id)
      SELECT array_agg(u.id ORDER BY u.id) INTO ids FROM u;
      IF ids IS NOT NULL THEN
        PERFORM public.p6_audit('document_slot_approval_inherited', 'register_record', NEW.id::text, NULL,
          jsonb_build_object('slot_ids', to_jsonb(ids), 'version_no', NEW.version_no, 'policy', 'documents.new_version_inherit'),
          'The unchanged documents keep their approval in the new version (setting documents.new_version_inherit).', NEW.site_id, NEW.region_id);
      END IF;
    ELSE
      UPDATE public.document_slots SET status = 'uploaded', updated_at = now() WHERE register_entity_id = NEW.entity_id AND status = 'approved';
    END IF;
  END IF;
  PERFORM public.doc_sync_record_slots_core(NEW.entity_id);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION doc_record_state_moved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fr record; n_restored int := 0; n_dropped int := 0;
BEGIN
  IF NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved' THEN
    UPDATE public.document_slots SET status = 'approved', reject_reason = NULL, inherited_at = NULL, updated_at = now()
    WHERE register_entity_id = NEW.entity_id AND status IN ('uploaded', 'in_review');
    UPDATE public.document_slots SET inherited_at = NULL WHERE register_entity_id = NEW.entity_id AND inherited_at IS NOT NULL;
    UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
    WHERE f.slot_id = s.id AND s.register_entity_id = NEW.entity_id AND f.is_current AND f.approved_date IS NULL;
  ELSIF OLD.state = 'entry' AND NEW.state IN ('in_review', 'in_approval') THEN
    UPDATE public.document_slots SET status = 'in_review', reject_reason = NULL, updated_at = now()
    WHERE register_entity_id = NEW.entity_id AND status = 'uploaded';
  ELSIF OLD.state IN ('in_review', 'in_approval') AND NEW.state = 'entry' THEN
    UPDATE public.document_slots SET status = 'uploaded', updated_at = now()
    WHERE register_entity_id = NEW.entity_id AND status = 'in_review';
  ELSIF NEW.state = 'voided' AND OLD.state <> 'voided' THEN
    -- Q229: a voided correction draft brings the record back to its approved version: a file the draft uploaded in place of an approved one gives
    -- way to it again, a file the draft added is set aside (kept on record); a real withdrawal keeps its effect; no approval is made up.
    IF EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = NEW.entity_id AND o.is_current) THEN
      FOR fr IN SELECT n.id, n.slot_id FROM public.document_files n JOIN public.document_slots s ON s.id = n.slot_id
               WHERE s.register_entity_id = NEW.entity_id AND n.is_current AND n.approved_date IS NULL AND n.uploaded_at >= NEW.created_at ORDER BY n.id LOOP
        UPDATE public.document_files SET is_current = false WHERE id = fr.id;
        UPDATE public.document_files o SET is_current = true, superseded_by = NULL
        WHERE o.superseded_by = fr.id AND o.approved_date IS NOT NULL AND o.withdrawn_at IS NULL;
        IF FOUND THEN n_restored := n_restored + 1; ELSE n_dropped := n_dropped + 1; END IF;
      END LOOP;
      UPDATE public.document_slots s SET status = (CASE WHEN EXISTS (SELECT 1 FROM public.document_files x WHERE x.slot_id = s.id AND x.is_current) THEN 'uploaded' ELSE 'missing' END)::public."DocStatus",
        updated_at = now()
      WHERE s.register_entity_id = NEW.entity_id AND s.status IN ('uploaded', 'in_review', 'rejected', 'missing');
      UPDATE public.document_slots s SET status = 'approved', inherited_at = NULL, updated_at = now()
      WHERE s.register_entity_id = NEW.entity_id AND s.status IN ('uploaded', 'in_review')
        AND EXISTS (SELECT 1 FROM public.document_files f2 WHERE f2.slot_id = s.id AND f2.is_current)
        AND NOT EXISTS (SELECT 1 FROM public.document_files f2 WHERE f2.slot_id = s.id AND f2.is_current AND f2.approved_date IS NULL);
      UPDATE public.document_slots SET inherited_at = NULL WHERE register_entity_id = NEW.entity_id AND inherited_at IS NOT NULL;
      IF n_restored + n_dropped > 0 THEN
        PERFORM public.p6_audit('document_files_restored_on_void', 'register_record', NEW.id::text, NULL,
          jsonb_build_object('restored', n_restored, 'set_aside', n_dropped), NEW.void_reason, NEW.site_id, NEW.region_id);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Who may change the files of a slot (0047), now also a global record; an approved slot that only inherited its approval (Q229) takes a replacement.
CREATE OR REPLACE FUNCTION doc_attach_file(p_slot uuid, p_file jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.document_slots%ROWTYPE; owner_ jsonb; spec jsonb; ext text; sz bigint;
  grp uuid; ver int; cur int; maxf int; minf int; fid uuid; prev public.document_files%ROWTYPE; newstatus text; allowed text[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.document_slots WHERE id = p_slot FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_read(s.is_global, s.region_id) THEN PERFORM public.wf_err('not_found'); END IF;
  owner_ := public.doc_slot_owner_for_write(s, actor, 'uploaded');
  IF s.status::text IN ('in_review', 'not_required') OR (s.status::text = 'approved' AND s.inherited_at IS NULL) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This slot is ' || s.status::text || ' and takes no new file.'));
  END IF;
  spec := public.doc_slot_spec(p_slot);
  ext := lower(p_file ->> 'ext'); sz := (p_file ->> 'size_bytes')::bigint;
  allowed := ARRAY(SELECT CASE WHEN f = 'jpeg' THEN 'jpg' ELSE f END FROM jsonb_array_elements_text(spec -> 'formats') f);
  IF ext IS NULL OR NOT ((CASE WHEN ext = 'jpeg' THEN 'jpg' ELSE ext END) = ANY (allowed)) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'format_not_allowed', 'message', 'This format is not allowed for the document.'))));
  END IF;
  IF sz IS NULL OR sz <= 0 OR sz > (spec ->> 'max_size_mb')::bigint * 1048576 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'file_too_large', 'message', 'The file is empty or larger than the document allows.'))));
  END IF;
  SELECT count(*) INTO cur FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current;
  maxf := (spec ->> 'max_files')::int; minf := greatest(coalesce((spec ->> 'min_files')::int, 1), 1);
  grp := (p_file ->> 'replaces_file_group_id')::uuid;
  IF grp IS NOT NULL THEN
    SELECT * INTO prev FROM public.document_files f WHERE f.slot_id = s.id AND f.file_group_id = grp AND f.is_current;
    IF NOT FOUND THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/replaces_file_group_id', 'code', 'unknown_file', 'message', 'No current file of this slot has this id.'))));
    END IF;
    ver := (SELECT max(f.version) FROM public.document_files f WHERE f.file_group_id = grp) + 1;
  ELSE
    IF maxf IS NOT NULL AND cur >= maxf THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'too_many_files', 'message', 'The slot holds ' || maxf || ' file(s) at most: replace one.'))));
    END IF;
    grp := gen_random_uuid(); ver := 1;
  END IF;
  INSERT INTO public.document_files (slot_id, file_group_id, version, is_current, original_name, stored_name, storage_key, mime_type, size_bytes, sha256, uploaded_by,
                                     ext, capture_date, unknown_capture_date)
  VALUES (s.id, grp, ver, true, left(p_file ->> 'original_name', 255), coalesce(p_file ->> 'stored_name', p_file ->> 'original_name'), p_file ->> 'storage_key',
          p_file ->> 'mime_type', sz, p_file ->> 'sha256', actor, ext, (p_file ->> 'capture_date')::timestamptz, coalesce((p_file ->> 'unknown_capture_date')::boolean, false))
  RETURNING id INTO fid;
  IF prev.id IS NOT NULL THEN UPDATE public.document_files SET is_current = false, superseded_by = fid WHERE id = prev.id; END IF;
  SELECT count(*) INTO cur FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current;
  newstatus := CASE WHEN cur >= minf THEN 'uploaded' WHEN s.status::text = 'rejected' THEN 'rejected' ELSE 'missing' END;
  UPDATE public.document_slots SET status = newstatus::public."DocStatus", reject_reason = CASE WHEN newstatus = 'uploaded' THEN NULL ELSE reject_reason END,
    inherited_at = NULL, updated_at = now() WHERE id = s.id;
  PERFORM public.doc_slot_audit(owner_, 'document_file_upload',
    jsonb_build_object('slot_id', s.id, 'slot_status', s.status, 'inherited_approval', s.inherited_at IS NOT NULL),
    jsonb_build_object('slot_id', s.id, 'slot_status', newstatus, 'file_id', fid, 'file_group_id', grp, 'version', ver, 'original_name', left(p_file ->> 'original_name', 255),
                       'size_bytes', sz, 'sha256', p_file ->> 'sha256', 'mime_type', p_file ->> 'mime_type', 'replaced_file_id', prev.id));
  RETURN jsonb_build_object('file_id', fid, 'file_group_id', grp, 'version', ver, 'slot_status', newstatus);
END $$;

CREATE OR REPLACE FUNCTION doc_withdraw_file(p_slot uuid, p_file uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); s public.document_slots%ROWTYPE; owner_ jsonb; f public.document_files%ROWTYPE; cur int; minf int; newstatus text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.document_slots WHERE id = p_slot FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_read(s.is_global, s.region_id) OR (s.task_id IS NULL AND s.register_entity_id IS NULL) THEN PERFORM public.wf_err('not_found'); END IF;
  SELECT * INTO f FROM public.document_files WHERE id = p_file AND slot_id = s.id;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The file is not in this slot.')); END IF;
  owner_ := public.doc_slot_owner_for_write(s, actor, 'withdrawn');
  IF s.status::text IN ('in_review', 'not_required') OR (s.status::text = 'approved' AND s.inherited_at IS NULL) THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Files can be withdrawn only while the slot is not under review or approved.'));
  END IF;
  IF NOT f.is_current THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This version is already superseded or withdrawn.')); END IF;
  UPDATE public.document_files SET is_current = false, withdrawn_at = now(), withdrawn_by = actor WHERE id = f.id;
  SELECT count(*) INTO cur FROM public.document_files x WHERE x.slot_id = s.id AND x.is_current;
  minf := greatest(coalesce((public.doc_slot_spec(s.id) ->> 'min_files')::int, 1), 1);
  newstatus := CASE WHEN cur >= minf THEN 'uploaded' ELSE 'missing' END;
  UPDATE public.document_slots SET status = newstatus::public."DocStatus", inherited_at = NULL, updated_at = now() WHERE id = s.id;
  PERFORM public.doc_slot_audit(owner_, 'document_file_withdraw', jsonb_build_object('slot_id', s.id, 'slot_status', s.status, 'file_id', f.id, 'version', f.version),
    jsonb_build_object('slot_id', s.id, 'slot_status', newstatus, 'file_id', f.id));
  RETURN jsonb_build_object('slot_status', newstatus);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Q233: the severity catalogue, the stream and the blocking rule of a snag type
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE snag_severities (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name_en     text NOT NULL CHECK (char_length(btrim(name_en)) BETWEEN 2 AND 100),
  name_ar     text CHECK (name_ar IS NULL OR char_length(name_ar) <= 100),
  blocks      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE snag_severities IS '0056 (Q233): the severities of a QC snag. Written only by admin_save_snag_severities; a used code is deactivated, never removed.';
ALTER TABLE snag_severities ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON snag_severities FOR SELECT USING (true);
CREATE POLICY rls_seed_write ON snag_severities FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
INSERT INTO snag_severities (code, name_en, name_ar, blocks, sort_order) VALUES
  ('CRITICAL', 'Critical', 'حرجة', true, 10),
  ('MAJOR', 'Major', 'رئيسية', true, 20),
  ('MINOR', 'Minor', 'ثانوية', false, 30)
ON CONFLICT (code) DO NOTHING;
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('qc.snag_severities_version', '1', 'Version (If-Match) of the snag severity catalogue (Q233).', now())
ON CONFLICT (key) DO NOTHING;

ALTER TABLE snag_types
  ADD COLUMN IF NOT EXISTS stream text CHECK (stream IN ('CW', 'TE')),
  ADD COLUMN IF NOT EXISTS blocking_rule text NOT NULL DEFAULT 'by_severity' CHECK (blocking_rule IN ('always', 'by_severity', 'never'));
-- the types that exist keep what they did: blocking or not, whatever the severity
UPDATE snag_types SET blocking_rule = CASE WHEN blocks_preliminary_acceptance THEN 'always' ELSE 'never' END;

-- Does an open snag of this type and severity block the PAC / FAC of its stream? A snag without a severity (legacy data) blocks, conservatively (Q109).
-- The old flag blocks_preliminary_acceptance = false still means never (admin_save_snag_type keeps the two in step).
CREATE OR REPLACE FUNCTION qc_blocks(p_type uuid, p_severity text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN NOT st.blocks_preliminary_acceptance THEN false
              WHEN coalesce(st.blocking_rule, 'always') = 'always' THEN true
              WHEN st.blocking_rule = 'never' THEN false
              ELSE p_severity IS NULL OR coalesce((SELECT v.blocks FROM public.snag_severities v WHERE v.code = upper(btrim(p_severity))), true) END
  FROM public.snag_types st WHERE st.id = p_type
$$;

CREATE OR REPLACE FUNCTION wf_open_snags_of(p_task uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*)::int
  FROM public.task_instances t
  JOIN public.snags s ON s.site_id = t.site_id
  WHERE t.id = p_task
    AND upper(btrim(s.scope)) = public.wf_snag_scope_of(p_task)
    AND s.status IN ('open', 'fix_uploaded', 'in_review')
    AND coalesce(public.qc_blocks(s.snag_type_id, s.severity), true)
$$;

-- The severity code of a text: a code, or the English name of an active severity (case-insensitive); null when it matches none.
CREATE OR REPLACE FUNCTION qc_severity_code(p_text text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT v.code FROM public.snag_severities v
  WHERE v.is_active AND (v.code = upper(btrim(p_text)) OR lower(v.name_en) = lower(btrim(p_text)))
  ORDER BY (v.code = upper(btrim(p_text))) DESC, v.code COLLATE "C" LIMIT 1
$$;

CREATE OR REPLACE FUNCTION snag_severities_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('code', v.code, 'name_en', v.name_en, 'name_ar', v.name_ar, 'blocks', v.blocks, 'is_active', v.is_active,
                                                         'in_use', EXISTS (SELECT 1 FROM public.snags s WHERE upper(s.severity) = v.code))
                                      ORDER BY v.sort_order, v.code COLLATE "C") FROM public.snag_severities v), '[]'::jsonb),
    'version', coalesce((public.calc_setting('qc.snag_severities_version', '1'::jsonb) #>> '{}')::int, 1))
$$;

-- p_items: the whole list [{code, name_en, name_ar, blocks, is_active}] in display order. A code in use cannot leave the list (deactivate it).
CREATE OR REPLACE FUNCTION admin_save_snag_severities(p_items jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; it jsonb; idx int := 0; k text; codes text[] := ARRAY[]::text[]; c text; nv int;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/items', 'code', 'required', 'message', 'At least one severity.'));
  ELSE
    FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      IF jsonb_typeof(it) <> 'object' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/items/' || idx, 'code', 'invalid', 'message', 'A severity is an object.'));
      ELSE
        FOR k IN SELECT jsonb_object_keys(it) LOOP
          IF k NOT IN ('code', 'name_en', 'name_ar', 'blocks', 'is_active') THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/items/' || idx || '/' || k, 'code', 'unknown_key', 'message', 'Unknown field.'));
          END IF;
        END LOOP;
        c := it ->> 'code';
        IF c IS NULL OR c !~ '^[A-Z][A-Z0-9_]{1,30}$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/items/' || idx || '/code', 'code', 'invalid', 'message', 'The code is capital letters, digits and underscores.'));
        ELSIF c = ANY (codes) THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/items/' || idx || '/code', 'code', 'duplicate', 'message', 'This code is listed twice.'));
        ELSE
          codes := codes || c;
        END IF;
        IF char_length(btrim(coalesce(it ->> 'name_en', ''))) NOT BETWEEN 2 AND 100 THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/items/' || idx || '/name_en', 'code', 'required', 'message', 'The English name is 2 to 100 characters.'));
        END IF;
        IF it ? 'blocks' AND jsonb_typeof(it -> 'blocks') <> 'boolean' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/items/' || idx || '/blocks', 'code', 'invalid', 'message', 'true or false.'));
        END IF;
        IF it ? 'is_active' AND jsonb_typeof(it -> 'is_active') <> 'boolean' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/items/' || idx || '/is_active', 'code', 'invalid', 'message', 'true or false.'));
        END IF;
      END IF;
      idx := idx + 1;
    END LOOP;
    FOR c IN SELECT v.code FROM public.snag_severities v WHERE NOT (v.code = ANY (codes)) ORDER BY v.code COLLATE "C" LOOP
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/items', 'code', 'cannot_remove', 'message', 'The severity ' || c || ' cannot be removed: deactivate it (is_active false).'));
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  PERFORM 1 FROM public.settings WHERE key = 'qc.snag_severities_version' FOR UPDATE;
  cur := public.snag_severities_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::int THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The severities changed since you read them. Reload and try again.'));
  END IF;
  idx := 0;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.snag_severities (code, name_en, name_ar, blocks, sort_order, is_active, updated_at)
    VALUES (it ->> 'code', btrim(it ->> 'name_en'), nullif(btrim(coalesce(it ->> 'name_ar', '')), ''), coalesce((it ->> 'blocks')::boolean, true), (idx + 1) * 10,
            coalesce((it ->> 'is_active')::boolean, true), now())
    ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, blocks = EXCLUDED.blocks, sort_order = EXCLUDED.sort_order,
      is_active = EXCLUDED.is_active, updated_at = now();
    idx := idx + 1;
  END LOOP;
  nv := (cur ->> 'version')::int + 1;
  INSERT INTO public.settings (key, value, updated_by, updated_at) VALUES ('qc.snag_severities_version', to_jsonb(nv), public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM public.log_audit_write('snag_severities.set', 'snag_severity', NULL, cur, public.snag_severities_json(), btrim(p_reason));
  RETURN public.snag_severities_json();
END $$;

-- Snag types (0047), with the stream and the blocking rule (Q233). p_patch keys: code (create only), name_en, name_ar, photo_rules
-- {min_count, shot_types, formats, max_size_mb}, stream (CW, TE or null = both), blocking_rule (always, by_severity, never),
-- blocks_preliminary_acceptance (the old flag: false = never, true = always, unless blocking_rule is sent), is_active.
CREATE OR REPLACE FUNCTION admin_save_snag_type(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE st public.snag_types%ROWTYPE; pr jsonb := p_patch -> 'photo_rules'; errs jsonb := '[]'::jsonb; f text; before_ jsonb; nid uuid; ver int; rule_ text; k text;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  FOR k IN SELECT jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) LOOP
    IF k NOT IN ('code', 'name_en', 'name_ar', 'photo_rules', 'stream', 'blocking_rule', 'blocks_preliminary_acceptance', 'is_active') THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || k, 'code', 'unknown_key', 'message', 'Unknown field.'));
    END IF;
  END LOOP;
  IF pr IS NOT NULL AND jsonb_typeof(pr) = 'object' THEN
    IF pr ? 'min_count' AND (jsonb_typeof(pr -> 'min_count') <> 'number' OR (pr ->> 'min_count')::numeric NOT BETWEEN 0 AND 50) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/min_count', 'code', 'invalid', 'message', 'min_count is 0 to 50.'));
    END IF;
    IF pr ? 'max_size_mb' AND (jsonb_typeof(pr -> 'max_size_mb') <> 'number' OR (pr ->> 'max_size_mb')::numeric NOT BETWEEN 1 AND 200) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/max_size_mb', 'code', 'invalid', 'message', 'max_size_mb is 1 to 200.'));
    END IF;
    IF pr ? 'formats' THEN
      IF jsonb_typeof(pr -> 'formats') <> 'array' OR jsonb_array_length(pr -> 'formats') = 0 THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/formats', 'code', 'invalid', 'message', 'At least one format: JPG, PNG or HEIC.'));
      ELSE
        FOR f IN SELECT jsonb_array_elements_text(pr -> 'formats') LOOP
          IF upper(f) NOT IN ('JPG', 'PNG', 'HEIC') THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/formats', 'code', 'invalid', 'message', 'Formats are JPG, PNG and HEIC.'));
          END IF;
        END LOOP;
      END IF;
    END IF;
    IF pr ? 'shot_types' AND (jsonb_typeof(pr -> 'shot_types') <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(pr -> 'shot_types') x WHERE jsonb_typeof(x) <> 'string' OR char_length(x #>> '{}') NOT BETWEEN 1 AND 40)) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules/shot_types', 'code', 'invalid', 'message', 'Shot types are short names.'));
    END IF;
  ELSIF pr IS NOT NULL AND pr <> 'null'::jsonb THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/photo_rules', 'code', 'invalid', 'message', 'photo_rules is an object.'));
  END IF;
  IF p_patch ? 'name_en' AND char_length(btrim(coalesce(p_patch ->> 'name_en', ''))) < 2 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/name_en', 'code', 'required', 'message', 'The English name is required.'));
  END IF;
  IF p_patch ? 'stream' AND p_patch -> 'stream' <> 'null'::jsonb AND coalesce(p_patch ->> 'stream', '') NOT IN ('CW', 'TE') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/stream', 'code', 'invalid', 'message', 'The stream is CW, TE or null (both).'));
  END IF;
  IF p_patch ? 'blocking_rule' AND coalesce(p_patch ->> 'blocking_rule', '') NOT IN ('always', 'by_severity', 'never') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/blocking_rule', 'code', 'invalid', 'message', 'always, by_severity or never.'));
  END IF;
  IF p_id IS NULL THEN
    IF coalesce(p_patch ->> 'code', '') !~ '^[A-Z][A-Z0-9_]{1,30}$' THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/code', 'code', 'invalid', 'message', 'The code is capital letters, digits and underscores.'));
    ELSIF EXISTS (SELECT 1 FROM public.snag_types x WHERE x.code = p_patch ->> 'code') THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A snag type with this code exists already.'));
    END IF;
    IF NOT (p_patch ? 'name_en') THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/name_en', 'code', 'required', 'message', 'The English name is required.')); END IF;
  ELSIF p_patch ? 'code' THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/code', 'code', 'immutable', 'message', 'The code never changes.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  rule_ := CASE WHEN p_patch ? 'blocking_rule' THEN p_patch ->> 'blocking_rule'
                WHEN p_patch ? 'blocks_preliminary_acceptance' THEN CASE WHEN (p_patch ->> 'blocks_preliminary_acceptance')::boolean THEN 'always' ELSE 'never' END END;
  IF p_id IS NULL THEN
    INSERT INTO public.snag_types (code, name_en, name_ar, min_photos, required_shots, formats, max_size_mb, blocks_preliminary_acceptance, is_active, stream, blocking_rule)
    VALUES (p_patch ->> 'code', btrim(p_patch ->> 'name_en'), p_patch ->> 'name_ar', coalesce((pr ->> 'min_count')::int, 1), coalesce(pr -> 'shot_types', '[]'::jsonb),
            coalesce(ARRAY(SELECT lower(x) FROM jsonb_array_elements_text(pr -> 'formats') x), ARRAY['jpg', 'png', 'heic']), coalesce((pr ->> 'max_size_mb')::int, 20),
            coalesce(rule_, 'by_severity') <> 'never', coalesce((p_patch ->> 'is_active')::boolean, true), nullif(p_patch ->> 'stream', ''), coalesce(rule_, 'by_severity'))
    RETURNING id, version INTO nid, ver;
    PERFORM public.log_audit_write('snag_type_create', 'snag_type', nid::text, NULL, (SELECT to_jsonb(x) FROM public.snag_types x WHERE x.id = nid), btrim(p_reason));
    RETURN jsonb_build_object('id', nid, 'version', ver);
  END IF;
  SELECT * INTO st FROM public.snag_types WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The snag type does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> st.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  before_ := to_jsonb(st);
  UPDATE public.snag_types SET
    name_en = CASE WHEN p_patch ? 'name_en' THEN btrim(p_patch ->> 'name_en') ELSE name_en END,
    name_ar = CASE WHEN p_patch ? 'name_ar' THEN p_patch ->> 'name_ar' ELSE name_ar END,
    min_photos = CASE WHEN pr ? 'min_count' THEN (pr ->> 'min_count')::int ELSE min_photos END,
    required_shots = CASE WHEN pr ? 'shot_types' THEN pr -> 'shot_types' ELSE required_shots END,
    formats = CASE WHEN pr ? 'formats' THEN ARRAY(SELECT lower(x) FROM jsonb_array_elements_text(pr -> 'formats') x) ELSE formats END,
    max_size_mb = CASE WHEN pr ? 'max_size_mb' THEN (pr ->> 'max_size_mb')::int ELSE max_size_mb END,
    blocking_rule = coalesce(rule_, blocking_rule),
    blocks_preliminary_acceptance = coalesce(rule_, blocking_rule) <> 'never',
    stream = CASE WHEN p_patch ? 'stream' THEN nullif(p_patch ->> 'stream', '') ELSE stream END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::boolean ELSE is_active END,
    version = version + 1
  WHERE id = p_id RETURNING version INTO ver;
  PERFORM public.log_audit_write(CASE WHEN st.is_active AND p_patch ? 'is_active' AND NOT (p_patch ->> 'is_active')::boolean THEN 'snag_type_deactivate' ELSE 'snag_type_update' END,
    'snag_type', p_id::text, before_, (SELECT to_jsonb(x) FROM public.snag_types x WHERE x.id = p_id), btrim(p_reason));
  RETURN jsonb_build_object('id', p_id, 'version', ver);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Q230 / D230b / Q231 / Q232 / Q234: the snag, its people, its votes, its evidence and its register record
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE snags
  ADD COLUMN IF NOT EXISTS found_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS fixed_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS level_round integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS register_entity_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS snags_register_entity_key ON snags (register_entity_id) WHERE register_entity_id IS NOT NULL;
UPDATE snags SET found_by = raised_by WHERE found_by IS NULL;
UPDATE snags SET fixed_by = submitted_by WHERE fixed_by IS NULL AND submitted_by IS NOT NULL;
UPDATE snags SET approved_by = closed_by WHERE approved_by IS NULL AND closed_by IS NOT NULL AND status = 'closed';

ALTER TABLE snag_photos
  ADD COLUMN IF NOT EXISTS evidence_status text NOT NULL DEFAULT 'accepted' CHECK (evidence_status IN ('accepted', 'pending_evidence')),
  ADD COLUMN IF NOT EXISTS evidence_note text,
  ADD COLUMN IF NOT EXISTS evidence_decided_by uuid,
  ADD COLUMN IF NOT EXISTS evidence_decided_at timestamptz;

-- A stored photo keeps its content for ever (0047); its evidence status moves only from pending to accepted, by L2.
CREATE OR REPLACE FUNCTION snag_photos_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a stored snag photo is never deleted (withdraw it)' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (to_jsonb(NEW) - 'withdrawn_at' - 'withdrawn_by' - 'rejected_at' - 'review_note' - 'evidence_status' - 'evidence_note' - 'evidence_decided_by' - 'evidence_decided_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'withdrawn_at' - 'withdrawn_by' - 'rejected_at' - 'review_note' - 'evidence_status' - 'evidence_note' - 'evidence_decided_by' - 'evidence_decided_at') THEN
    RAISE EXCEPTION 'the content columns of a stored snag photo never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.evidence_status = 'accepted' AND NEW.evidence_status <> 'accepted' THEN
    RAISE EXCEPTION 'an accepted snag photo stays accepted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- All-members votes on the L2 of a snag (Q231): one row per eligible approver and round.
CREATE TABLE snag_level_voters (
  snag_id   uuid NOT NULL REFERENCES snags (id) ON DELETE CASCADE,
  round     integer NOT NULL,
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  voted_at  timestamptz,
  PRIMARY KEY (snag_id, round, user_id)
);
ALTER TABLE snag_level_voters ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON snag_level_voters FOR SELECT USING (EXISTS (SELECT 1 FROM snags p WHERE p.id = snag_id));

-- The Matrix row of the TE stream of Quality (Q230), a register_definitions row that is not enabled (the pattern of permits_hse_te, 0050).
-- Listed right after the Quality row (the same sort order; the key orders it second).
INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order)
SELECT 'quality_te', 'Quality - TE stream (QC snags)', 'الجودة - مسار TE (ملاحظات الجودة)', 'quality', 'register', true, true, ARRAY[]::text[], 2,
       '{"scope_of": "quality", "scope": "TE", "applies_to": "qc_snags"}'::jsonb, false, coalesce((SELECT d.sort_order FROM register_definitions d WHERE d.register_key = 'quality'), 91)
ON CONFLICT (register_key) DO NOTHING;
-- Seeded as a copy of the global cells of the Quality row (L1 = level 1, L2 = level 3; the retired level 2 is copied too, as every row has it), so who
-- acts on a TE snag does not change until the admin edits it.
DO $$
DECLARE c record; nid uuid; n int := 0;
BEGIN
  FOR c IN SELECT * FROM matrix_cells x WHERE x.register_key = 'quality' AND x.region_id IS NULL AND x.task_def_id IS NULL AND x.level IN (1, 2, 3) ORDER BY x.level, x.id LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM matrix_cells y WHERE y.register_key = 'quality_te' AND y.level = c.level AND y.region_id IS NULL);
    INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('quality_te', c.level, c.rule, NULL, true, now()) RETURNING id INTO nid;
    INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT nid, a.kind, a.ref_id FROM matrix_cell_assignees a WHERE a.cell_id = c.id ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN UPDATE matrix_state SET revision = revision + 1, updated_at = now(); END IF;
  INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
  VALUES ('quality_te_row_seeded', 'workflow', NULL, jsonb_build_object('matrix_row', 'quality_te', 'cells_copied', n),
          'Owner answer Q230 (2026-11-04): separate CW and TE rows for QC snags; seeded as a copy of the Quality row (migration 0056).');
END $$;

-- The Matrix cell that decides a level of a snag. A CW snag: the Quality row (region cell, else global). A TE snag: the Quality - TE row's region cell,
-- else the Quality row's region cell (a region set-up made before 0056 keeps working), else the Quality - TE global cell, else the Quality global cell.
CREATE OR REPLACE FUNCTION qc_snag_cell(p_snag uuid, p_kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN upper(btrim(s.scope)) = 'TE' THEN (
           SELECT c.id FROM public.matrix_cells c
           WHERE c.register_key IN ('quality_te', 'quality') AND c.task_def_id IS NULL AND c.retired_at IS NULL
             AND c.level = CASE p_kind WHEN 'entry' THEN 1 WHEN 'review' THEN 2 ELSE 3 END
             AND (c.region_id IS NULL OR c.region_id = s.region_id)
           ORDER BY (c.region_id IS NOT NULL)::int DESC, (c.register_key = 'quality_te')::int DESC, c.id LIMIT 1)
         ELSE public.reg_cell_row('quality', s.region_id, p_kind) END
  FROM public.snags s WHERE s.id = p_snag
$$;

CREATE OR REPLACE FUNCTION qc_snag_row(p_snag uuid, p_kind text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.register_key FROM public.matrix_cells c WHERE c.id = public.qc_snag_cell(p_snag, p_kind)
$$;

CREATE OR REPLACE FUNCTION qc_snag_eligible(p_snag uuid, p_kind text) RETURNS TABLE (user_id uuid, via_group uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; cell uuid;
BEGIN
  SELECT * INTO s FROM public.snags WHERE id = p_snag;
  IF NOT FOUND THEN RETURN; END IF;
  cell := public.qc_snag_cell(p_snag, p_kind);
  IF cell IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT * FROM public.reg_eligible_cell(cell, s.region_id, public.reg_module('quality'), p_kind::public."PermissionLevel");
END $$;

-- D230b: the people who may not approve the closure of a snag: who raised it, who found it, who fixed it (submitted the fix or uploaded a photo).
CREATE OR REPLACE FUNCTION qc_snag_excluded(p_snag uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT u) FILTER (WHERE u IS NOT NULL), ARRAY[]::uuid[]) FROM (
    SELECT s.raised_by AS u FROM public.snags s WHERE s.id = p_snag
    UNION ALL SELECT s.found_by FROM public.snags s WHERE s.id = p_snag
    UNION ALL SELECT s.fixed_by FROM public.snags s WHERE s.id = p_snag
    UNION ALL SELECT s.submitted_by FROM public.snags s WHERE s.id = p_snag
    UNION ALL SELECT p.uploaded_by FROM public.snag_photos p WHERE p.snag_id = p_snag AND p.withdrawn_at IS NULL) x
$$;

-- The holders of a level. For approve: the eligible L2 holders less the excluded people (D230b).
CREATE OR REPLACE FUNCTION qc_snag_actors(p_snag uuid, p_kind text) RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.user_id FROM public.qc_snag_eligible(p_snag, p_kind) e
  WHERE p_kind <> 'approve' OR NOT (e.user_id = ANY (public.qc_snag_excluded(p_snag)))
$$;

CREATE OR REPLACE FUNCTION qc_snag_is_eligible(p_snag uuid, p_kind text, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.qc_snag_actors(p_snag, p_kind) e WHERE e.user_id = p_user)
$$;

CREATE OR REPLACE FUNCTION qc_snag_has_holder(p_snag uuid, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.qc_snag_actors(p_snag, p_kind))
$$;

-- The voters of the current round (Q231), empty when the L2 cell is any-one.
CREATE OR REPLACE FUNCTION qc_snag_has_votes(p_snag uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.snag_level_voters v JOIN public.snags s ON s.id = v.snag_id AND v.round = s.level_round WHERE v.snag_id = p_snag)
$$;

-- Read helper (granted): may the caller act at this level of a snag in a region the caller can see?
CREATE OR REPLACE FUNCTION qc_snag_can(p_snag uuid, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.snags s WHERE s.id = p_snag AND public.app_region_check(s.region_id))
     AND CASE
       WHEN p_kind = 'approve' AND public.app_actor() = ANY (public.qc_snag_excluded(p_snag)) THEN false
       WHEN p_kind = 'approve' AND public.qc_snag_has_votes(p_snag) THEN EXISTS (
         SELECT 1 FROM public.snag_level_voters v JOIN public.snags s ON s.id = v.snag_id AND v.round = s.level_round
         WHERE v.snag_id = p_snag AND v.user_id = public.app_actor() AND v.voted_at IS NULL)
       ELSE public.qc_snag_is_eligible(p_snag, p_kind, public.app_actor())
            OR (public.app_actor_is_system_admin() AND NOT public.qc_snag_has_holder(p_snag, p_kind)) END
$$;

CREATE OR REPLACE FUNCTION qc_snag_holders(p_snag uuid, p_kind text) RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.user_id FROM public.qc_snag_actors(p_snag, p_kind) e
  WHERE EXISTS (SELECT 1 FROM public.snags s WHERE s.id = p_snag AND public.app_region_check(s.region_id))
$$;

-- Read helper (granted): the votes of the current round of a snag the caller can see.
CREATE OR REPLACE FUNCTION qc_snag_votes(p_snag uuid) RETURNS TABLE (user_id uuid, voted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT v.user_id, v.voted_at FROM public.snag_level_voters v JOIN public.snags s ON s.id = v.snag_id AND v.round = s.level_round
  WHERE v.snag_id = p_snag AND public.app_region_check(s.region_id)
$$;

CREATE OR REPLACE FUNCTION qc_snag_snap(p_snag uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('status', s.status, 'scope', s.scope, 'title', s.title, 'description', s.description, 'task_id', s.task_id, 'snag_type_id', s.snag_type_id,
    'severity', s.severity, 'found_by', s.found_by, 'fixed_by', s.fixed_by, 'approved_by', s.approved_by, 'register_entity_id', s.register_entity_id,
    'return_count', s.return_count, 'pinned_to', s.ball_in_court_user_id, 'self_approval', s.self_approval, 'version', s.version, 'level_round', s.level_round,
    'photos', (SELECT count(*) FROM public.snag_photos p WHERE p.snag_id = s.id AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL AND p.evidence_status = 'accepted'),
    'pending_evidence', (SELECT count(*) FROM public.snag_photos p WHERE p.snag_id = s.id AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL AND p.evidence_status = 'pending_evidence'))
  FROM public.snags s WHERE s.id = p_snag
$$;

CREATE OR REPLACE FUNCTION qc_audit(p_action text, p_snag uuid, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.snags WHERE id = p_snag;
  PERFORM public.p6_audit(p_action, 'snag', p_snag::text, p_before, p_after, p_reason, s.site_id, s.region_id);
END $$;

-- A level's holders are notified, or the System Admins when nobody holds it (B10).
CREATE OR REPLACE FUNCTION qc_notify_level(p_snag uuid, p_kind text, p_except uuid, p_note_kind text, p_title text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h record; lbl text;
BEGIN
  SELECT coalesce(si.site_code, '') || ' / ' || coalesce(s.title, s.description) INTO lbl FROM public.snags s JOIN public.sites si ON si.id = s.site_id WHERE s.id = p_snag;
  IF NOT public.qc_snag_has_holder(p_snag, p_kind) THEN
    FOR h IN SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
             JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND NOT x.is_break_glass ORDER BY gm.user_id LOOP
      PERFORM public.qc_notify(h.user_id, 'no_eligible_holder', 'No holder for a snag level', lbl || ': nobody can act on the ' || p_kind || ' level.', p_snag);
    END LOOP;
    RETURN;
  END IF;
  FOR h IN SELECT e.user_id FROM public.qc_snag_actors(p_snag, p_kind) e WHERE e.user_id IS DISTINCT FROM p_except ORDER BY e.user_id LIMIT 20 LOOP
    PERFORM public.qc_notify(h.user_id, p_note_kind, p_title, lbl, p_snag);
  END LOOP;
END $$;

-- May the caller act at the level the snag is at? (0047) For approve, D230b first: a raiser, finder or fixer is refused.
CREATE OR REPLACE FUNCTION qc_require_actor(p_snag uuid, p_kind text, p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; elig boolean;
BEGIN
  SELECT * INTO s FROM public.snags WHERE id = p_snag;
  IF p_kind = 'approve' AND p_actor = ANY (public.qc_snag_excluded(p_snag)) THEN
    PERFORM public.wf_err('self_approval_forbidden', jsonb_build_object('detail',
      'You raised, found or fixed this snag: somebody else must approve its closure (owner decision D230b).'));
  END IF;
  elig := public.qc_snag_is_eligible(p_snag, p_kind, p_actor);
  IF NOT (elig OR (public.app_user_is_system_admin(p_actor) AND NOT public.qc_snag_has_holder(p_snag, p_kind))) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a holder of the level the snag is at (Quality row of the Responsibility Matrix, or Quality - TE for a TE snag).'));
  END IF;
  IF p_kind = 'entry' AND s.ball_in_court_user_id IS NOT NULL AND s.ball_in_court_user_id <> p_actor AND public.qc_snag_is_eligible(p_snag, 'entry', s.ball_in_court_user_id) THEN
    PERFORM public.wf_err('already_claimed', jsonb_build_object('claimed_by', s.ball_in_court_user_id));
  END IF;
  RETURN CASE WHEN elig THEN 'holder' ELSE 'admin' END;
END $$;

-- What the photos of a snag still lack: only accepted evidence counts (a pending_evidence photo is not proof yet, Q232).
CREATE OR REPLACE FUNCTION qc_photos_missing(p_snag uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; st public.snag_types%ROWTYPE; n int; shot text; errs jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM public.snags WHERE id = p_snag;
  SELECT * INTO st FROM public.snag_types WHERE id = s.snag_type_id;
  SELECT count(*) INTO n FROM public.snag_photos p WHERE p.snag_id = p_snag AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL AND p.evidence_status = 'accepted';
  IF n < greatest(st.min_photos, 1) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/photos', 'code', 'min_count', 'message', 'At least ' || greatest(st.min_photos, 1) || ' photo(s) of the fix are needed (' || n || ' now).'));
  END IF;
  IF jsonb_typeof(st.required_shots) = 'array' THEN
    FOR shot IN SELECT jsonb_array_elements_text(st.required_shots) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.snag_photos p WHERE p.snag_id = p_snag AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL AND p.evidence_status = 'accepted'
                     AND lower(p.shot_type) = lower(shot)) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/photos', 'code', 'shot_type_missing', 'message', 'A "' || shot || '" photo is needed.', 'shot_type', shot));
      END IF;
    END LOOP;
  END IF;
  RETURN errs;
END $$;

-- Raise a snag (Q230: Quality `create` in the region). The severity is required (Q109 / Q233); the finder defaults to the caller; the type must allow
-- the stream. The stream comes from p_scope or from the task.
CREATE OR REPLACE FUNCTION qc_raise_snag(p_site uuid, p_type uuid, p_task uuid, p_scope text, p_title text, p_description text, p_severity text, p_found_by uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); si public.sites%ROWTYPE; st public.snag_types%ROWTYPE; t public.task_instances%ROWTYPE; sc text; sid uuid; regs int[];
  errs jsonb := '[]'::jsonb; sev text; finder uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO si FROM public.sites WHERE id = p_site;
  regs := public.wf_actor_regions(public.reg_module('quality'), 'view');
  IF NOT FOUND OR (regs IS NOT NULL AND NOT (si.region_id = ANY (regs))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
  END IF;
  PERFORM public.reg_require_grant('quality', si.region_id, 'create');
  SELECT * INTO st FROM public.snag_types WHERE id = p_type;
  IF NOT FOUND OR NOT st.is_active THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/snag_type_id', 'code', 'unknown_snag_type', 'message', 'No active snag type has this id.'));
  END IF;
  IF char_length(btrim(coalesce(p_title, ''))) NOT BETWEEN 3 AND 200 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/title', 'code', 'invalid', 'message', 'The title is 3 to 200 characters.'));
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT * INTO t FROM public.task_instances WHERE id = p_task AND site_id = p_site;
    IF NOT FOUND THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/task_id', 'code', 'unknown_task', 'message', 'The task is not on this site.'));
    END IF;
  END IF;
  sc := upper(btrim(coalesce(p_scope, '')));
  IF sc = '' AND t.id IS NOT NULL THEN
    sc := coalesce(public.wf_snag_scope_of(t.id),
                   (SELECT upper(sd.stream_code) FROM public.task_definitions td JOIN public.stage_definitions sd ON sd.id = td.stage_id WHERE td.id = t.task_def_id), '');
  END IF;
  IF sc NOT IN ('CW', 'TE') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/scope', 'code', 'required', 'message', 'The stream of the snag is CW or TE (or name a CW or TE task).'));
  ELSIF st.id IS NOT NULL AND st.stream IS NOT NULL AND st.stream <> sc THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/snag_type_id', 'code', 'wrong_stream', 'message', 'This snag type is for the ' || st.stream || ' stream.'));
  END IF;
  IF nullif(btrim(coalesce(p_severity, '')), '') IS NULL THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/severity', 'code', 'required', 'message', 'A snag needs a severity.'));
  ELSE
    sev := public.qc_severity_code(p_severity);
    IF sev IS NULL THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/severity', 'code', 'unknown_severity', 'message', 'No active severity has this code.'));
    END IF;
  END IF;
  finder := coalesce(p_found_by, actor);
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = finder AND u.status = 'active' AND u.deleted_at IS NULL) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/found_by', 'code', 'unknown_user', 'message', 'The finder must be an active user.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  INSERT INTO public.snags (site_id, region_id, task_id, snag_type_id, scope, description, title, severity, status, raised_by, found_by, raised_at, updated_at)
  VALUES (si.id, si.region_id, t.id, st.id, sc, coalesce(nullif(btrim(coalesce(p_description, '')), ''), ''), btrim(p_title), sev, 'open', actor, finder, clock_timestamp(), clock_timestamp())
  RETURNING id INTO sid;
  PERFORM public.qc_audit('snag_raise', sid, NULL, public.qc_snag_snap(sid), NULL);
  PERFORM public.qc_notify_level(sid, 'entry', actor, 'snag_raised', 'A snag waits for photos of the fix');
  RETURN sid;
END $$;
DROP FUNCTION IF EXISTS qc_raise_snag(uuid, uuid, uuid, text, text, text);

-- Edit the title, the description or the severity while the snag is open (Quality `edit` in the region). A snag that comes from a Quality
-- register record is edited there (Q234: one work item).
CREATE OR REPLACE FUNCTION qc_save_snag(p_snag uuid, p_version int, p_patch jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; before_ jsonb; sev text;
BEGIN
  s := public.qc_lock_snag(p_snag, p_version);
  IF s.status NOT IN ('open', 'fix_uploaded') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A snag in review or closed cannot be edited.'));
  END IF;
  IF s.register_entity_id IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This snag comes from a Quality register record: change the record (a new version) instead.'));
  END IF;
  PERFORM public.reg_require_grant('quality', s.region_id, 'edit');
  IF p_patch ? 'title' AND char_length(btrim(coalesce(p_patch ->> 'title', ''))) NOT BETWEEN 3 AND 200 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/title', 'code', 'invalid', 'message', 'The title is 3 to 200 characters.'))));
  END IF;
  IF p_patch ? 'severity' THEN
    sev := public.qc_severity_code(p_patch ->> 'severity');
    IF sev IS NULL THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/severity', 'code', 'unknown_severity', 'message', 'No active severity has this code.'))));
    END IF;
  END IF;
  before_ := public.qc_snag_snap(p_snag);
  UPDATE public.snags SET title = CASE WHEN p_patch ? 'title' THEN btrim(p_patch ->> 'title') ELSE title END,
    description = CASE WHEN p_patch ? 'description' THEN coalesce(p_patch ->> 'description', '') ELSE description END,
    severity = CASE WHEN p_patch ? 'severity' THEN sev ELSE severity END,
    version = version + 1, updated_at = now() WHERE id = p_snag;
  PERFORM public.qc_audit('snag_update', p_snag, before_, public.qc_snag_snap(p_snag), NULL);
END $$;

-- p_meta as 0047; exif_date is an instant (the API reads the EXIF wall clock in Africa/Tripoli). Before the raise beyond the tolerance: refused. In the
-- future beyond the tolerance: kept as pending_evidence (Q232).
CREATE OR REPLACE FUNCTION qc_attach_photo(p_snag uuid, p_meta jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.snags%ROWTYPE; st public.snag_types%ROWTYPE; ext text; sz bigint; shot text; ex timestamptz; pid uuid; before_ jsonb;
  allowed text[]; tol interval := public.qc_exif_tolerance(); ev text := 'accepted';
BEGIN
  s := public.qc_lock_snag(p_snag, NULL);
  IF s.status NOT IN ('open', 'fix_uploaded') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Photos can be added only while the snag waits for the fix (it is ' || s.status::text || ').'));
  END IF;
  PERFORM public.reg_require_grant('quality', s.region_id, 'edit');
  PERFORM public.qc_require_actor(p_snag, 'entry', actor);
  SELECT * INTO st FROM public.snag_types WHERE id = s.snag_type_id;
  ext := lower(coalesce(p_meta ->> 'ext', '')); IF ext = 'jpeg' THEN ext := 'jpg'; END IF;
  sz := (p_meta ->> 'size_bytes')::bigint;
  allowed := ARRAY(SELECT CASE WHEN lower(f) = 'jpeg' THEN 'jpg' ELSE lower(f) END FROM unnest(coalesce(st.formats, ARRAY['jpg', 'png', 'heic'])) f);
  IF NOT (ext = ANY (allowed)) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'format_not_allowed', 'message', 'Photos of this snag type are ' || array_to_string(allowed, ', ') || '.'))));
  END IF;
  IF sz IS NULL OR sz <= 0 OR sz > st.max_size_mb::bigint * 1048576 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'file_too_large', 'message', 'The photo is empty or larger than ' || st.max_size_mb || ' MB.'))));
  END IF;
  shot := nullif(btrim(coalesce(p_meta ->> 'shot_type', '')), '');
  IF jsonb_typeof(st.required_shots) = 'array' AND jsonb_array_length(st.required_shots) > 0 THEN
    IF shot IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(st.required_shots) x WHERE lower(x) = lower(shot)) THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/shot_type', 'code', 'unknown_shot_type',
        'message', 'The shot type is one of ' || (SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(st.required_shots) x) || '.'))));
    END IF;
  END IF;
  ex := (p_meta ->> 'exif_date')::timestamptz;
  IF ex IS NOT NULL AND ex < s.raised_at - tol THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'before_snag_raised',
      'message', 'The photo was taken before the snag was raised (EXIF date, ' || extract(epoch FROM tol)::bigint / 3600 || ' hour(s) of tolerance).'))));
  END IF;
  IF ex IS NOT NULL AND ex > clock_timestamp() + tol THEN ev := 'pending_evidence'; END IF;
  before_ := public.qc_snag_snap(p_snag);
  INSERT INTO public.snag_photos (snag_id, shot_type, storage_key, mime_type, ext, size_bytes, sha256, exif_date, unknown_capture_date, before_snag_raised,
                                  gps_lat, gps_lon, captured_in_app, uploaded_by, uploaded_at, evidence_status, evidence_note)
  VALUES (p_snag, shot, p_meta ->> 'storage_key', p_meta ->> 'mime_type', ext, sz, p_meta ->> 'sha256', ex, ex IS NULL, false,
          (p_meta ->> 'device_lat')::numeric, (p_meta ->> 'device_lon')::numeric, coalesce((p_meta ->> 'in_app_camera')::boolean, false), actor, clock_timestamp(), ev,
          CASE WHEN ev = 'pending_evidence' THEN 'EXIF date in the future beyond the tolerance' END)
  RETURNING id INTO pid;
  PERFORM public.qc_refresh_status(p_snag);
  UPDATE public.snags SET version = version + 1, updated_at = now() WHERE id = p_snag;
  PERFORM public.qc_audit('snag_photo_upload', p_snag, before_, public.qc_snag_snap(p_snag) || jsonb_build_object('photo_id', pid, 'sha256', p_meta ->> 'sha256',
    'size_bytes', sz, 'shot_type', shot, 'exif_date', ex, 'unknown_capture_date', ex IS NULL, 'evidence_status', ev), NULL);
  RETURN pid;
END $$;

-- L2 decides a photo kept as pending evidence (Q232): accept it as proof of the fix, or reject it (it leaves the set). A note is required.
CREATE OR REPLACE FUNCTION qc_decide_evidence(p_snag uuid, p_photo uuid, p_accept boolean, p_note text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); s public.snags%ROWTYPE; p public.snag_photos%ROWTYPE; before_ jsonb;
BEGIN
  s := public.qc_lock_snag(p_snag, NULL);
  SELECT * INTO p FROM public.snag_photos WHERE id = p_photo AND snag_id = p_snag;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The photo is not on this snag.')); END IF;
  IF s.status NOT IN ('open', 'fix_uploaded', 'in_review') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The snag is ' || s.status::text || '.'));
  END IF;
  IF p.evidence_status <> 'pending_evidence' OR p.withdrawn_at IS NOT NULL OR p.rejected_at IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a photo kept as pending evidence is decided.'));
  END IF;
  IF char_length(btrim(coalesce(p_note, ''))) < 3 THEN PERFORM public.wf_err('note_required'); END IF;
  IF actor = ANY (public.qc_snag_excluded(p_snag)) THEN
    PERFORM public.wf_err('self_approval_forbidden', jsonb_build_object('detail', 'You raised, found or fixed this snag: somebody else decides its evidence (owner decision D230b).'));
  END IF;
  PERFORM public.reg_require_grant('quality', s.region_id, 'approve');
  IF NOT (public.qc_snag_is_eligible(p_snag, 'approve', actor) OR (public.app_user_is_system_admin(actor) AND NOT public.qc_snag_has_holder(p_snag, 'approve'))) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only L2 of the snag decides pending evidence.'));
  END IF;
  before_ := public.qc_snag_snap(p_snag);
  IF p_accept THEN
    UPDATE public.snag_photos SET evidence_status = 'accepted', evidence_note = left(btrim(p_note), 500), evidence_decided_by = actor, evidence_decided_at = now() WHERE id = p_photo;
  ELSE
    UPDATE public.snag_photos SET rejected_at = now(), review_note = left(btrim(p_note), 500), evidence_note = left(btrim(p_note), 500), evidence_decided_by = actor, evidence_decided_at = now()
    WHERE id = p_photo;
  END IF;
  PERFORM public.qc_refresh_status(p_snag);
  UPDATE public.snags SET version = version + 1, updated_at = now() WHERE id = p_snag;
  PERFORM public.qc_audit(CASE WHEN p_accept THEN 'snag_evidence_accept' ELSE 'snag_evidence_reject' END, p_snag, before_,
    public.qc_snag_snap(p_snag) || jsonb_build_object('photo_id', p_photo), btrim(p_note));
END $$;

-- submit (L1 fixes), approve (L2 closes; all members vote when the cell says so), reject (L2, back to L1). No self-approval for a snag (D230b).
CREATE OR REPLACE FUNCTION qc_transition_snag(p_snag uuid, p_version int, p_action text, p_note text, p_stepup boolean, p_rejected_photos jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.snags%ROWTYPE; before_ jsonb; miss jsonb; rl public."MatrixRule"; x jsonb; pin uuid; st text; n_left int; nround int;
BEGIN
  s := public.qc_lock_snag(p_snag, p_version);
  before_ := public.qc_snag_snap(p_snag);
  IF p_action = 'submit' THEN
    IF s.status NOT IN ('open', 'fix_uploaded') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The snag is ' || s.status::text || ': it cannot be submitted now.'));
    END IF;
    PERFORM public.reg_require_grant('quality', s.region_id, 'edit');
    PERFORM public.qc_require_actor(p_snag, 'entry', actor);
    miss := public.qc_photos_missing(p_snag);
    IF jsonb_array_length(miss) > 0 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The photos of the fix do not meet the rules of the snag type yet.', 'errors', miss));
    END IF;
    nround := s.level_round + 1;
    UPDATE public.snags SET status = 'in_review', submitted_at = now(), submitted_by = actor, fixed_by = actor, ball_in_court_user_id = NULL, level_round = nround,
      version = version + 1, updated_at = now() WHERE id = p_snag;
    -- Q231: an all-members L2 asks every eligible approver except the raiser, finder and fixer (D230b)
    SELECT c.rule INTO rl FROM public.matrix_cells c WHERE c.id = public.qc_snag_cell(p_snag, 'approve');
    IF coalesce(rl, 'any_one') = 'all_members' THEN
      INSERT INTO public.snag_level_voters (snag_id, round, user_id) SELECT p_snag, nround, e.user_id FROM public.qc_snag_actors(p_snag, 'approve') e ON CONFLICT DO NOTHING;
    END IF;
    PERFORM public.qc_audit('snag_submit', p_snag, before_, public.qc_snag_snap(p_snag) || jsonb_build_object('rule', coalesce(rl, 'any_one')), p_note);
    PERFORM public.qc_notify_level(p_snag, 'approve', actor, 'snag_review', 'Photos of a snag fix wait for your approval');
  ELSIF p_action = 'approve' THEN
    IF s.status <> 'in_review' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a snag in review can be approved (it is ' || s.status::text || ').'));
    END IF;
    PERFORM public.reg_require_grant('quality', s.region_id, 'approve');
    IF public.qc_snag_has_votes(p_snag) THEN
      IF actor = ANY (public.qc_snag_excluded(p_snag)) THEN
        PERFORM public.wf_err('self_approval_forbidden', jsonb_build_object('detail', 'You raised, found or fixed this snag: somebody else must approve its closure (owner decision D230b).'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.snag_level_voters v WHERE v.snag_id = p_snag AND v.round = s.level_round AND v.user_id = actor AND v.voted_at IS NULL) THEN
        PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a voter of this snag''s L2 (all members), or you have voted already.'));
      END IF;
      IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
      UPDATE public.snag_level_voters SET voted_at = now() WHERE snag_id = p_snag AND round = s.level_round AND user_id = actor;
      SELECT count(*) INTO n_left FROM public.snag_level_voters v WHERE v.snag_id = p_snag AND v.round = s.level_round AND v.voted_at IS NULL;
      IF n_left > 0 THEN
        UPDATE public.snags SET version = version + 1, updated_at = now() WHERE id = p_snag;
        PERFORM public.qc_audit('snag_vote', p_snag, before_, public.qc_snag_snap(p_snag) || jsonb_build_object('votes_left', n_left, 'stepup_verified', true), p_note);
        RETURN jsonb_build_object('id', p_snag, 'self_approval', false, 'votes_left', n_left);
      END IF;
    ELSE
      PERFORM public.qc_require_actor(p_snag, 'approve', actor);
      IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
    END IF;
    UPDATE public.snags SET status = 'closed', closed_at = now(), closed_by = actor, approved_by = actor, ball_in_court_user_id = NULL, version = version + 1, updated_at = now()
    WHERE id = p_snag;
    PERFORM public.qc_audit('snag_close', p_snag, before_, public.qc_snag_snap(p_snag) || jsonb_build_object('stepup_verified', true), p_note);
    IF s.submitted_by IS NOT NULL AND s.submitted_by <> actor THEN
      PERFORM public.qc_notify(s.submitted_by, 'snag_closed', 'A snag you fixed was approved and closed', coalesce(s.title, s.description), p_snag);
    END IF;
  ELSIF p_action = 'reject' THEN
    IF coalesce(btrim(p_note), '') = '' THEN PERFORM public.wf_err('note_required'); END IF;
    IF s.status <> 'in_review' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a snag in review can be rejected (it is ' || s.status::text || ').'));
    END IF;
    PERFORM public.reg_require_grant('quality', s.region_id, 'approve');
    IF public.qc_snag_has_votes(p_snag) THEN
      IF NOT EXISTS (SELECT 1 FROM public.snag_level_voters v WHERE v.snag_id = p_snag AND v.round = s.level_round AND v.user_id = actor AND v.voted_at IS NULL)
         OR actor = ANY (public.qc_snag_excluded(p_snag)) THEN
        PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a voter of this snag''s L2 (all members), or you have voted already.'));
      END IF;
    ELSE
      PERFORM public.qc_require_actor(p_snag, 'approve', actor);
    END IF;
    IF p_rejected_photos IS NOT NULL AND jsonb_typeof(p_rejected_photos) = 'array' THEN
      FOR x IN SELECT * FROM jsonb_array_elements(p_rejected_photos) LOOP
        UPDATE public.snag_photos SET rejected_at = now(), review_note = left(x ->> 'reason', 500)
        WHERE id = (x ->> 'photo_id')::uuid AND snag_id = p_snag AND withdrawn_at IS NULL AND rejected_at IS NULL;
        IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'A rejected photo is not a current photo of this snag.')); END IF;
      END LOOP;
    END IF;
    pin := CASE WHEN s.submitted_by IS NOT NULL AND public.qc_snag_is_eligible(p_snag, 'entry', s.submitted_by) THEN s.submitted_by END;
    st := CASE WHEN jsonb_array_length(public.qc_photos_missing(p_snag)) = 0 THEN 'fix_uploaded' ELSE 'open' END;
    UPDATE public.snags SET status = st::public."SnagStatus", return_count = return_count + 1, last_return_note = p_note, ball_in_court_user_id = pin,
      version = version + 1, updated_at = now() WHERE id = p_snag;
    PERFORM public.qc_audit('snag_reject', p_snag, before_, public.qc_snag_snap(p_snag) || jsonb_build_object('rejected_photos', coalesce(p_rejected_photos, '[]'::jsonb)), p_note);
    IF pin IS NOT NULL THEN
      PERFORM public.qc_notify(pin, 'snag_rejected', 'A snag fix was returned to you', coalesce(s.title, s.description) || ': ' || p_note, p_snag);
    ELSE
      PERFORM public.qc_notify_level(p_snag, 'entry', actor, 'snag_rejected', 'A snag fix was returned');
    END IF;
  ELSIF p_action = 'review' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A snag has two levels: L1 submits the fix, L2 approves or rejects it.'));
  ELSE
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Unknown action.'));
  END IF;
  RETURN jsonb_build_object('id', p_snag, 'self_approval', false);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Q234 / Q103 (Quality): the Quality register's snag record and the QC snag are one work item
-- ---------------------------------------------------------------------------------------------------------------------
-- The stream of a Quality record from its Stage (CW QC, CW PAC, CW FAC -> CW; TE QC, TE PAC, TE FAC -> TE); null when it cannot be read.
CREATE OR REPLACE FUNCTION qc_stream_of_stage(p_stage text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN upper(btrim(coalesce(p_stage, ''))) LIKE 'CW%' THEN 'CW' WHEN upper(btrim(coalesce(p_stage, ''))) LIKE 'TE%' THEN 'TE' END
$$;

-- Submit gate of a Quality snag record: the stream (Stage) and an active severity are needed, so the approval can create the QC snag.
CREATE OR REPLACE FUNCTION qc_record_submit_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE errs jsonb := '[]'::jsonb;
BEGIN
  IF public.qc_stream_of_stage(NEW.data ->> 'stage') IS NULL THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/stage', 'code', 'stream_required',
      'message', 'A snag record needs its Stage (CW QC, CW PAC, CW FAC, TE QC, TE PAC or TE FAC): it decides the stream whose PAC / FAC the snag blocks.'));
  END IF;
  IF public.qc_severity_code(NEW.data ->> 'severity') IS NULL THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/severity', 'code', 'unknown_severity', 'message', 'The severity must be one of the active snag severities.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qc_record_submit_gate BEFORE UPDATE OF state ON register_records FOR EACH ROW
  WHEN (NEW.register_key = 'quality' AND NEW.record_type = 'snag' AND OLD.state = 'entry' AND NEW.state IN ('in_review', 'in_approval', 'approved'))
  EXECUTE FUNCTION qc_record_submit_gate();

-- Creates or updates the QC snag of an approved Quality snag record (idempotent: one snag per logical record). Returns the snag id, or null when the
-- record cannot be linked (no site, no stream, no active snag type); the reason is in the audit row.
CREATE OR REPLACE FUNCTION qc_link_from_record(p_record uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; s public.snags%ROWTYPE; sc text; sev text; tid uuid; ttl text; sid uuid; raised timestamptz; who uuid; before_ jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF NOT FOUND OR r.register_key <> 'quality' OR r.record_type IS DISTINCT FROM 'snag' OR r.state <> 'approved' THEN RETURN NULL; END IF;
  sc := public.qc_stream_of_stage(r.data ->> 'stage');
  sev := public.qc_severity_code(r.data ->> 'severity');
  ttl := left(btrim(coalesce(nullif(btrim(r.data ->> 'record_code'), '') || ': ', '') || coalesce(nullif(btrim(r.data ->> 'description'), ''), 'Quality snag')), 200);
  IF char_length(ttl) < 3 THEN ttl := 'Quality snag'; END IF;
  SELECT * INTO s FROM public.snags WHERE register_entity_id = r.entity_id FOR UPDATE;
  IF FOUND THEN
    IF s.status IN ('open', 'fix_uploaded') AND (s.title IS DISTINCT FROM ttl OR s.severity IS DISTINCT FROM coalesce(sev, s.severity) OR s.scope IS DISTINCT FROM coalesce(sc, s.scope)
                                                 OR s.description IS DISTINCT FROM coalesce(r.data ->> 'description', '')) THEN
      before_ := public.qc_snag_snap(s.id);
      UPDATE public.snags SET title = ttl, description = coalesce(r.data ->> 'description', ''), severity = coalesce(sev, severity), scope = coalesce(sc, scope),
        version = version + 1, updated_at = now() WHERE id = s.id;
      PERFORM public.qc_audit('snag_record_update', s.id, before_, public.qc_snag_snap(s.id) || jsonb_build_object('register_record_id', r.id), NULL);
    END IF;
    RETURN s.id;
  END IF;
  SELECT id INTO tid FROM public.snag_types WHERE is_active AND (stream IS NULL OR stream = sc) ORDER BY (code = 'QC_GENERAL') DESC, code COLLATE "C" LIMIT 1;
  IF r.site_id IS NULL OR sc IS NULL OR tid IS NULL THEN
    PERFORM public.p6_audit('snag_link_needs_review', 'register_record', r.id::text, NULL,
      jsonb_build_object('entity_id', r.entity_id, 'stage', r.data ->> 'stage', 'severity', r.data ->> 'severity', 'has_type', tid IS NOT NULL),
      'The Quality snag record could not be linked to a QC snag (no site, no stream from its Stage, or no active snag type).', r.site_id, r.region_id);
    RETURN NULL;
  END IF;
  SELECT min(x.created_at) INTO raised FROM public.register_records x WHERE x.entity_id = r.entity_id;
  SELECT x.created_by INTO who FROM public.register_records x WHERE x.entity_id = r.entity_id ORDER BY x.version_no LIMIT 1;
  who := coalesce(who, r.created_by, r.approved_by, public.app_actor());
  IF who IS NULL THEN
    PERFORM public.p6_audit('snag_link_needs_review', 'register_record', r.id::text, NULL, jsonb_build_object('entity_id', r.entity_id, 'reason', 'no_author'),
      'The Quality snag record has no author to raise its QC snag.', r.site_id, r.region_id);
    RETURN NULL;
  END IF;
  INSERT INTO public.snags (site_id, region_id, snag_type_id, scope, description, title, severity, status, raised_by, found_by, raised_at, updated_at, register_entity_id)
  VALUES (r.site_id, r.region_id, tid, sc, coalesce(r.data ->> 'description', ''), ttl, sev, 'open', who, who, coalesce(raised, now()), now(), r.entity_id)
  RETURNING id INTO sid;
  PERFORM public.qc_audit('snag_linked_from_record', sid, NULL, public.qc_snag_snap(sid) || jsonb_build_object('register_record_id', r.id, 'record_code', r.data ->> 'record_code'), NULL);
  PERFORM public.qc_notify_level(sid, 'entry', public.app_actor(), 'snag_raised', 'A snag waits for photos of the fix');
  RETURN sid;
END $$;

CREATE OR REPLACE FUNCTION qc_record_moved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; before_ jsonb;
BEGIN
  IF NEW.state = 'approved' THEN
    PERFORM public.qc_link_from_record(NEW.id);
  ELSIF NEW.state = 'voided' AND NOT EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = NEW.entity_id AND o.is_current) THEN
    -- the record has no approved version left: its snag, while not closed, is cancelled (it no longer blocks the PAC / FAC)
    SELECT * INTO s FROM public.snags WHERE register_entity_id = NEW.entity_id FOR UPDATE;
    IF FOUND AND s.status IN ('open', 'fix_uploaded', 'in_review') THEN
      before_ := public.qc_snag_snap(s.id);
      UPDATE public.snags SET status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(NEW.void_reason, 'The Quality record was voided'), ball_in_court_user_id = NULL,
        version = version + 1, updated_at = now() WHERE id = s.id;
      PERFORM public.qc_audit('snag_cancel', s.id, before_, public.qc_snag_snap(s.id) || jsonb_build_object('register_record_id', NEW.id), NEW.void_reason);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_qc_record_moved AFTER UPDATE OF state ON register_records FOR EACH ROW
  WHEN (NEW.register_key = 'quality' AND NEW.record_type = 'snag' AND OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('approved', 'voided'))
  EXECUTE FUNCTION qc_record_moved();

-- One-off link of the Quality snag records approved before 0056 (also safe to run again: it links only what is not linked). An unlinked QC snag of the
-- same site and stream whose title is the record's code or description is linked instead of creating a second one; two or more such snags are listed
-- for review, as are records without a site or a stream.
CREATE OR REPLACE FUNCTION qc_link_backfill() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; n_linked int := 0; n_created int := 0; review jsonb := '[]'::jsonb; sc text; m uuid[]; sid uuid;
BEGIN
  FOR r IN SELECT x.* FROM public.register_records x WHERE x.register_key = 'quality' AND x.record_type = 'snag' AND x.is_current AND x.state = 'approved'
             AND NOT EXISTS (SELECT 1 FROM public.snags s WHERE s.register_entity_id = x.entity_id) ORDER BY x.created_at, x.id LOOP
    sc := public.qc_stream_of_stage(r.data ->> 'stage');
    IF r.site_id IS NULL OR sc IS NULL THEN
      review := review || jsonb_build_array(jsonb_build_object('record_id', r.id, 'reason', 'no_stream'));
      CONTINUE;
    END IF;
    SELECT coalesce(array_agg(s.id ORDER BY s.id), ARRAY[]::uuid[]) INTO m FROM public.snags s
    WHERE s.site_id = r.site_id AND s.register_entity_id IS NULL AND upper(s.scope) = sc
      AND lower(btrim(coalesce(s.title, s.description))) IN (lower(btrim(coalesce(r.data ->> 'record_code', ''))), lower(btrim(coalesce(r.data ->> 'description', ''))));
    IF cardinality(m) = 1 THEN
      UPDATE public.snags SET register_entity_id = r.entity_id, severity = coalesce(severity, public.qc_severity_code(r.data ->> 'severity')), version = version + 1, updated_at = now()
      WHERE id = m[1];
      PERFORM public.qc_audit('snag_linked_from_record', m[1], NULL, public.qc_snag_snap(m[1]) || jsonb_build_object('register_record_id', r.id, 'matched', true), 'qc_link_backfill');
      n_linked := n_linked + 1;
    ELSIF cardinality(m) > 1 THEN
      review := review || jsonb_build_array(jsonb_build_object('record_id', r.id, 'reason', 'several_matching_snags', 'snag_ids', to_jsonb(m)));
    ELSE
      sid := public.qc_link_from_record(r.id);
      IF sid IS NULL THEN review := review || jsonb_build_array(jsonb_build_object('record_id', r.id, 'reason', 'not_linked'));
      ELSE n_created := n_created + 1; END IF;
    END IF;
  END LOOP;
  PERFORM public.p6_audit('snag_link_backfill', 'workflow', NULL, NULL, jsonb_build_object('linked', n_linked, 'created', n_created, 'needs_review', review),
    'Owner answer Q234 (2026-11-04): the Quality snag records and the QC snags are one work item.', NULL, NULL);
  RETURN jsonb_build_object('linked', n_linked, 'created', n_created, 'needs_review', review);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Ownership, rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON snag_severities, snag_level_voters TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
GRANT SELECT ON stored_object_meta TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON matrix_cells, matrix_cell_assignees TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'p6_audit(text,text,text,jsonb,jsonb,text,uuid,integer)', 'documents_qc_settings_json()', 'admin_save_documents_qc(jsonb,text,integer)', 'qc_exif_tolerance()',
    'storage_scan_states(text[])', 'doc_sync_record_slots_core(uuid,uuid[],uuid[])', 'doc_record_submit_gate()', 'doc_add_record_slot(uuid,text,text)',
    'doc_slot_twin_core(uuid)', 'doc_twin_holds(uuid)', 'doc_slot_twins(uuid[])', 'wf_missing_slots(uuid)', 'doc_record_missing_core(uuid)',
    'doc_procurement_delivery(uuid,text)', 'doc_mark_pending(uuid,uuid[])', 'doc_task_pending_gate()', 'doc_record_opened()', 'doc_record_state_moved()',
    'doc_attach_file(uuid,jsonb)', 'doc_withdraw_file(uuid,uuid)',
    'qc_blocks(uuid,text)', 'wf_open_snags_of(uuid)', 'qc_severity_code(text)', 'snag_severities_json()', 'admin_save_snag_severities(jsonb,text,integer)',
    'admin_save_snag_type(uuid,jsonb,text,integer)', 'snag_photos_guard()',
    'qc_snag_cell(uuid,text)', 'qc_snag_row(uuid,text)', 'qc_snag_eligible(uuid,text)', 'qc_snag_excluded(uuid)', 'qc_snag_actors(uuid,text)', 'qc_snag_is_eligible(uuid,text,uuid)',
    'qc_snag_has_holder(uuid,text)', 'qc_snag_has_votes(uuid)', 'qc_snag_can(uuid,text)', 'qc_snag_holders(uuid,text)', 'qc_snag_votes(uuid)', 'qc_snag_snap(uuid)',
    'qc_audit(text,uuid,jsonb,jsonb,text)', 'qc_notify_level(uuid,text,uuid,text,text)', 'qc_require_actor(uuid,text,uuid)', 'qc_photos_missing(uuid)',
    'qc_raise_snag(uuid,uuid,uuid,text,text,text,text,uuid)', 'qc_save_snag(uuid,integer,jsonb)', 'qc_attach_photo(uuid,jsonb)', 'qc_decide_evidence(uuid,uuid,boolean,text)',
    'qc_transition_snag(uuid,integer,text,text,boolean,jsonb)', 'qc_stream_of_stage(text)', 'qc_record_submit_gate()', 'qc_link_from_record(uuid)', 'qc_record_moved()',
    'qc_link_backfill()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- granted: the API doors and the read helpers. Not granted: the cores, the triggers, the audit helper, the eligibility internals, the link and the backfill.
    FOREACH f IN ARRAY ARRAY[
      'documents_qc_settings_json()', 'admin_save_documents_qc(jsonb,text,integer)', 'storage_scan_states(text[])', 'doc_slot_twins(uuid[])', 'doc_add_record_slot(uuid,text,text)',
      'doc_procurement_delivery(uuid,text)', 'doc_mark_pending(uuid,uuid[])', 'doc_attach_file(uuid,jsonb)', 'doc_withdraw_file(uuid,uuid)',
      'qc_severity_code(text)', 'snag_severities_json()', 'admin_save_snag_severities(jsonb,text,integer)', 'admin_save_snag_type(uuid,jsonb,text,integer)',
      'qc_snag_cell(uuid,text)', 'qc_snag_can(uuid,text)', 'qc_snag_holders(uuid,text)', 'qc_snag_votes(uuid)', 'qc_photos_missing(uuid)', 'qc_blocks(uuid,text)',
      'qc_raise_snag(uuid,uuid,uuid,text,text,text,text,uuid)', 'qc_save_snag(uuid,integer,jsonb)', 'qc_attach_photo(uuid,jsonb)', 'qc_decide_evidence(uuid,uuid,boolean,text)',
      'qc_transition_snag(uuid,integer,text,text,boolean,jsonb)', 'qc_exif_tolerance()', 'wf_missing_slots(uuid)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON snag_severities, snag_level_voters FROM pmis_app;
  END IF;
END $$;

-- 11. Link what exists now (a database without Quality snag records links nothing and writes one summary row).
SELECT qc_link_backfill();
