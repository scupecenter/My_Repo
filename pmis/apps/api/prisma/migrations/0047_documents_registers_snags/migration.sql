-- 0047_documents_registers_snags: the documents follow-up of the owner answers of 2026-11-02 (Q130, Q131, Q132; contract 0.11.1; CHANGELOG 76).
-- Mirrored byte-identically as db/sql/046_documents_registers_snags.sql.
--
-- What this adds.
--   1. Q130, conditional documents that judge themselves.
--      * The yes/no site field near_airport (Site Register) is a custom field of the site (data, not a column), edited through the normal
--        custom-field rules: site_save_custom checks `sites` edit in the site's region and the field-level rule of each field (hidden / read / edit),
--        validates the value like every custom field, and writes the audit row with before and after. The A3 civil aviation permit rule
--        (site.custom.near_airport) reads it as it is.
--      * B1's rule (procurement.delivery = outsourced) is judged by the API from the site's Procurement records (doc_procurement_delivery).
--   2. Q131, document slots on register records. A slot belongs to a task (task_id) or to a register record (register_entity_id = the logical
--      record, so the slots and their files follow every version). Slots are built from the Document Library placements whose target is
--      `register` (and, where the register has record types, optionally one record type: document_type_placements.record_type) when the
--      record is created (snapshot on open, like a task) and refreshed while a version is in Data Entry. A trigger on register_records refuses
--      the move out of Data Entry while a mandatory slot is missing or rejected (mandatory_slots_missing); a second trigger moves the slot
--      statuses with the record exactly as the engine moves a task's slots (submit: uploaded -> in review; final approval: approved and the
--      approved date of the files; rejection: in review -> uploaded, plus the slots the reviewer names -> rejected). doc_attach_file and
--      doc_withdraw_file serve both owners (the record's Data Entry holder of the open version, `edit` on the register's module). A record linked
--      to a task (Q43) keeps the task's slots; its own register slots, when the library places any, are checked as well.
--   3. Q132, QC snag photos (the `snags` table that blocks PAC / FAC, 0016). qc_raise_snag, qc_save_snag, qc_attach_photo, qc_withdraw_photo,
--      qc_transition_snag (submit, approve, reject; two levels, L1 Data Entry and L2 Data Reviewer & Approver from the Quality register's
--      Matrix row, B5 self-approval with step-up, B6 return to the submitter with a note, B10 no holder), admin_save_snag_type. Photo rules of
--      the snag type: min_count, shot types, formats, size. A photo whose EXIF date is more than one day before the snag was raised is refused
--      (EXIF has no time zone); no EXIF date is accepted with unknown_capture_date for L2. L2 approval closes the snag; the PAC / FAC block of
--      0016 (open, fix uploaded or in review snags of the stream) is unchanged.
--   4. pmis_app is read-only on every new table and on snags, snag_photos and snag_types (db/sql/app_grants.sql).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Q130: the site field near_airport, the site custom-field write, the Procurement delivery of a site
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO field_definitions (entity_type, code, label_en, label_ar, data_type, required, section, sort_order, in_templates, in_exports, in_list_filters, reason)
VALUES ('site', 'near_airport', 'Near an airport', 'قريب من مطار', 'bool', false, 'Site', 100, true, true, true,
        'Q130 (owner answer 2026-11-02): the civil aviation permit of A3 applies when the site is near an airport')
ON CONFLICT (entity_type, code) DO NOTHING;

-- p_patch: {code: value | null}; null clears. p_seen: the updated_at the caller read (If-Match); null = any.
CREATE OR REPLACE FUNCTION site_save_custom(p_site uuid, p_seen timestamptz, p_patch jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.sites%ROWTYPE; k text; fd public.field_definitions%ROWTYPE; acc text; err text; v jsonb;
  errs jsonb := '[]'::jsonb; before_ jsonb := '{}'::jsonb; after_ jsonb := '{}'::jsonb; newc jsonb; regs int[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.sites WHERE id = p_site FOR UPDATE;
  regs := public.wf_actor_regions('sites', 'view');
  IF NOT FOUND OR (regs IS NOT NULL AND NOT (s.region_id = ANY (regs))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
  END IF;
  PERFORM public.wf_require_grant(s.region_id, 'edit');
  IF p_seen IS NOT NULL AND s.updated_at IS DISTINCT FROM p_seen THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The site changed since you read it. Reload and try again.'));
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/custom', 'code', 'required', 'message', 'Send at least one field.'))));
  END IF;
  newc := coalesce(s.custom, '{}'::jsonb);
  FOR k IN SELECT jsonb_object_keys(p_patch) ORDER BY 1 LOOP
    SELECT * INTO fd FROM public.field_definitions d WHERE d.entity_type = 'site' AND d.code = k AND d.task_code IS NULL;
    v := p_patch -> k;
    IF NOT FOUND OR NOT fd.is_active THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'unknown_field', 'message', 'No active site field has this code.'));
      CONTINUE;
    END IF;
    acc := coalesce(public.app_resolve_field_access(actor, fd.id)::text, 'edit');
    IF acc <> 'edit' THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'field_read_only', 'message', 'You may not edit this field.'));
      CONTINUE;
    END IF;
    IF v IS NULL OR v = 'null'::jsonb THEN
      IF fd.required THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'required', 'message', 'This field is required.'));
        CONTINUE;
      END IF;
      before_ := before_ || jsonb_build_object(k, newc -> k);
      after_ := after_ || jsonb_build_object(k, NULL);
      newc := newc - k;
    ELSE
      err := public.custom_check_value(fd, v);
      IF err IS NOT NULL THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/custom/' || k, 'code', 'invalid', 'message', err));
        CONTINUE;
      END IF;
      before_ := before_ || jsonb_build_object(k, newc -> k);
      after_ := after_ || jsonb_build_object(k, v);
      newc := newc || jsonb_build_object(k, v);
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  IF newc IS NOT DISTINCT FROM coalesce(s.custom, '{}'::jsonb) THEN
    RETURN jsonb_build_object('updated_at', s.updated_at, 'changed', false);
  END IF;
  UPDATE public.sites SET custom = newc, updated_at = clock_timestamp() WHERE id = p_site RETURNING * INTO s;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES ('site_custom_update', 'site', p_site::text, p_site, s.region_id, jsonb_build_object('custom', before_), jsonb_build_object('custom', after_),
          nullif(btrim(coalesce(p_reason, '')), ''), actor);
  RETURN jsonb_build_object('updated_at', s.updated_at, 'changed', true);
END $$;

-- The Procurement delivery of a site, as B1's rule (procurement.delivery) reads it: 'Outsourced' when any Procurement record of the site whose scope
-- is a source scope of the task (register_task_sources: B1 and B2 = CW, Tower Erection, Site Adaption) is outsourced; otherwise the delivery of the
-- latest such record; null when no record has a delivery (the rule cannot judge and Data Entry may declare that the document applies). The latest
-- version of each logical record counts, draft or approved (a voided version does not), so the PR e-mail slot appears while the PR is entered.
CREATE OR REPLACE FUNCTION doc_procurement_delivery(p_site uuid, p_task_code text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH scopes AS (
    SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::text[]) AS list
    FROM public.register_task_sources ts, jsonb_array_elements_text(coalesce(ts.data_in -> 'scope', '[]'::jsonb)) x
    WHERE ts.register_key = 'procurement' AND ts.task_code = p_task_code AND ts.is_active
  ), latest AS (
    SELECT DISTINCT ON (r.entity_id) r.entity_id, r.state, r.data, r.created_at
    FROM public.register_records r
    WHERE r.register_key = 'procurement' AND r.site_id = p_site
    ORDER BY r.entity_id, r.version_no DESC
  ), cand AS (
    SELECT l.data ->> 'delivery' AS delivery, l.created_at FROM latest l, scopes
    WHERE l.state <> 'voided' AND nullif(btrim(coalesce(l.data ->> 'delivery', '')), '') IS NOT NULL
      AND (cardinality(scopes.list) = 0 OR (l.data ->> 'scope') = ANY (scopes.list))
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM cand WHERE lower(btrim(delivery)) = 'outsourced') THEN 'Outsourced'
              ELSE (SELECT c.delivery FROM cand c ORDER BY c.created_at DESC LIMIT 1) END
  WHERE EXISTS (SELECT 1 FROM public.sites s WHERE s.id = p_site AND public.app_region_check(s.region_id))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Q131: document slots on register records
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE document_slots
  ADD COLUMN IF NOT EXISTS register_entity_id uuid,
  ADD COLUMN IF NOT EXISTS register_key text;
ALTER TABLE document_slots ADD CONSTRAINT document_slots_one_owner CHECK (register_entity_id IS NULL OR task_id IS NULL);
ALTER TABLE document_slots ADD CONSTRAINT document_slots_register_key_check CHECK ((register_entity_id IS NULL) = (register_key IS NULL));
CREATE UNIQUE INDEX document_slots_record_type_label ON document_slots (register_entity_id, doc_type_id, coalesce(candidate_label, '')) WHERE register_entity_id IS NOT NULL;
CREATE INDEX document_slots_record_idx ON document_slots (register_entity_id, status) WHERE register_entity_id IS NOT NULL;

ALTER TABLE document_type_placements ADD COLUMN IF NOT EXISTS record_type text;
ALTER TABLE document_type_placements ADD CONSTRAINT document_type_placements_record_type_check CHECK (record_type IS NULL OR kind = 'register');

-- A row here means "the slot set of this logical record was built" (snapshot on open, as document_task_snapshots for tasks).
CREATE TABLE document_record_snapshots (
  entity_id uuid PRIMARY KEY,
  taken_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE document_record_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_record_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON document_record_snapshots FOR SELECT USING (app_is_seeding());

-- 2a. The library: a register placement may name one record type of the register.
CREATE OR REPLACE FUNCTION doc_live_spec(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.document_types%ROWTYPE; pl jsonb;
BEGIN
  SELECT * INTO d FROM public.document_types WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(x.p ORDER BY x.k), '[]'::jsonb) INTO pl FROM (
    SELECT p.kind::text || ':' || coalesce(td.code, st.code, p.register_key, '') || ':' || coalesce(p.record_type, '') AS k,
           jsonb_build_object('target', p.kind::text, 'ref', coalesce(td.code, st.code, p.register_key))
             || CASE WHEN p.record_type IS NOT NULL THEN jsonb_build_object('record_type', p.record_type) ELSE '{}'::jsonb END AS p
    FROM public.document_type_placements p
    LEFT JOIN public.task_definitions td ON td.id = p.task_def_id
    LEFT JOIN public.snag_types st ON st.id = p.snag_type_id
    WHERE p.doc_type_id = p_id) x;
  RETURN jsonb_build_object(
    'kind', CASE WHEN d.form_kind IS NOT NULL THEN 'generated_form' ELSE d.kind::text END, 'form_kind', d.form_kind,
    'name_en', d.name_en, 'name_ar', d.name_ar, 'placements', pl, 'mandatory', d.is_mandatory, 'condition_rule', d.condition_rule,
    'formats', to_jsonb(coalesce(d.formats, ARRAY[]::text[])), 'max_size_mb', d.max_size_mb, 'min_files', d.min_files, 'max_files', d.max_files,
    'photo_rules', d.photo_rules, 'expiry_tracked', d.has_expiry, 'blank_form_file_id', d.blank_form_file_id, 'is_active', d.is_active);
END $$;

CREATE OR REPLACE FUNCTION doc_validate_spec(p_spec jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  errs jsonb := '[]'::jsonb; f text; pl jsonb; idx int := 0; k text; fk text; maxf int; minf int; rt text[];
  denied text[] := ARRAY['exe', 'dll', 'bat', 'cmd', 'com', 'msi', 'scr', 'js', 'vbs', 'ps1', 'sh', 'jar', 'html', 'htm', 'mht', 'mhtml', 'zip', 'rar', '7z', 'gz', 'tar', 'xlsm', 'docm', 'pptm', 'xlam'];
BEGIN
  k := p_spec ->> 'kind';
  IF k IS NULL OR k NOT IN ('scanned_document', 'photo', 'email', 'report', 'excel_template', 'generated_form') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/kind', 'code', 'invalid', 'message', 'Unknown kind.'));
  END IF;
  fk := p_spec ->> 'form_kind';
  IF k = 'generated_form' AND (fk IS NULL OR fk NOT IN ('dn', 'rn', 'pac', 'fac', 'snag_list')) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/form_kind', 'code', 'required', 'message', 'A generated form needs form_kind (dn, rn, pac, fac or snag_list).'));
  ELSIF k <> 'generated_form' AND fk IS NOT NULL THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/form_kind', 'code', 'invalid', 'message', 'form_kind is only for the kind generated_form.'));
  END IF;
  IF char_length(btrim(coalesce(p_spec ->> 'name_en', ''))) < 2 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/name_en', 'code', 'required', 'message', 'The English name is required (2 characters or more).'));
  END IF;
  IF jsonb_typeof(p_spec -> 'formats') IS DISTINCT FROM 'array' OR jsonb_array_length(p_spec -> 'formats') = 0 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/formats', 'code', 'required', 'message', 'At least one format is required.'));
  ELSE
    FOR f IN SELECT jsonb_array_elements_text(p_spec -> 'formats') LOOP
      IF f !~ '^[a-z0-9]{2,5}$' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/formats', 'code', 'invalid', 'message', 'A format is a lower-case extension such as pdf.'));
      ELSIF f = ANY (denied) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/formats', 'code', 'not_allowed', 'message', f || ' files are never accepted (executables, scripts, web pages, archives and macro documents).'));
      END IF;
    END LOOP;
  END IF;
  IF (p_spec ->> 'max_size_mb') IS NULL OR (p_spec ->> 'max_size_mb')::int NOT BETWEEN 1 AND 200 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/max_size_mb', 'code', 'invalid', 'message', 'The size limit is 1 to 200 MB.'));
  END IF;
  minf := coalesce((p_spec ->> 'min_files')::int, 1);
  maxf := (p_spec ->> 'max_files')::int;
  IF minf < 0 OR (maxf IS NOT NULL AND maxf < greatest(minf, 1)) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/max_files', 'code', 'invalid', 'message', 'max_files must be at least min_files and at least 1.'));
  END IF;
  IF jsonb_typeof(p_spec -> 'placements') IS DISTINCT FROM 'array' OR jsonb_array_length(p_spec -> 'placements') = 0 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/placements', 'code', 'required', 'message', 'Place the document on at least one task, QC type or register.'));
  ELSE
    FOR pl IN SELECT jsonb_array_elements(p_spec -> 'placements') LOOP
      IF pl ->> 'target' = 'task' AND public.doc_task_def_of_code(pl ->> 'ref') IS NULL THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/placements/' || idx, 'code', 'unknown_task', 'message', 'No task has the code ' || coalesce(pl ->> 'ref', '') || '.'));
      ELSIF pl ->> 'target' = 'qc' AND NOT EXISTS (SELECT 1 FROM public.snag_types WHERE code = pl ->> 'ref') THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/placements/' || idx, 'code', 'unknown_snag_type', 'message', 'No snag type has the code ' || coalesce(pl ->> 'ref', '') || '.'));
      ELSIF pl ->> 'target' = 'register' AND NOT EXISTS (SELECT 1 FROM public.register_definitions WHERE register_key = pl ->> 'ref') THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/placements/' || idx, 'code', 'unknown_register', 'message', 'No register has the key ' || coalesce(pl ->> 'ref', '') || '.'));
      ELSIF coalesce(pl ->> 'target', '') NOT IN ('task', 'qc', 'register') THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/placements/' || idx, 'code', 'invalid', 'message', 'target is task, qc or register.'));
      ELSIF pl ? 'record_type' AND pl ->> 'record_type' IS NOT NULL THEN
        IF pl ->> 'target' <> 'register' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/placements/' || idx || '/record_type', 'code', 'invalid', 'message', 'A record type is only for a register placement.'));
        ELSE
          SELECT d.record_types INTO rt FROM public.register_definitions d WHERE d.register_key = pl ->> 'ref';
          IF NOT ((pl ->> 'record_type') = ANY (coalesce(rt, ARRAY[]::text[]))) THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/placements/' || idx || '/record_type', 'code', 'unknown_record_type',
              'message', 'The register ' || (pl ->> 'ref') || ' has no record type ' || (pl ->> 'record_type') || '.'));
          END IF;
        END IF;
      END IF;
      idx := idx + 1;
    END LOOP;
  END IF;
  IF p_spec ? 'condition_rule' AND jsonb_typeof(p_spec -> 'condition_rule') NOT IN ('object', 'null') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/condition_rule', 'code', 'invalid', 'message', 'A rule is an object or null.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
END $$;

CREATE OR REPLACE FUNCTION doc_apply_spec(p_id uuid, p_spec jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pl jsonb; tdid uuid; sid uuid;
BEGIN
  UPDATE public.document_types SET
    kind = (CASE WHEN p_spec ->> 'kind' = 'generated_form' THEN 'scanned_document' ELSE p_spec ->> 'kind' END)::public."DocKind",
    form_kind = CASE WHEN p_spec ->> 'kind' = 'generated_form' THEN p_spec ->> 'form_kind' ELSE NULL END,
    name_en = p_spec ->> 'name_en', name_ar = p_spec ->> 'name_ar',
    is_mandatory = coalesce((p_spec ->> 'mandatory')::boolean, true),
    condition_rule = CASE WHEN jsonb_typeof(p_spec -> 'condition_rule') = 'object' THEN p_spec -> 'condition_rule' ELSE NULL END,
    formats = ARRAY(SELECT jsonb_array_elements_text(p_spec -> 'formats')),
    max_size_mb = coalesce((p_spec ->> 'max_size_mb')::int, 20), min_files = coalesce((p_spec ->> 'min_files')::int, 1),
    max_files = (p_spec ->> 'max_files')::int,
    photo_rules = CASE WHEN jsonb_typeof(p_spec -> 'photo_rules') = 'object' THEN p_spec -> 'photo_rules' ELSE NULL END,
    has_expiry = coalesce((p_spec ->> 'expiry_tracked')::boolean, false),
    blank_form_file_id = (p_spec ->> 'blank_form_file_id')::uuid,
    is_active = coalesce((p_spec ->> 'is_active')::boolean, true), updated_at = now()
  WHERE id = p_id;
  DELETE FROM public.document_type_placements WHERE doc_type_id = p_id;
  FOR pl IN SELECT jsonb_array_elements(p_spec -> 'placements') LOOP
    IF pl ->> 'target' = 'task' THEN
      tdid := public.doc_task_def_of_code(pl ->> 'ref');
      IF tdid IS NOT NULL THEN INSERT INTO public.document_type_placements (doc_type_id, kind, task_def_id) VALUES (p_id, 'task', tdid); END IF;
    ELSIF pl ->> 'target' = 'qc' THEN
      SELECT id INTO sid FROM public.snag_types WHERE code = pl ->> 'ref';
      IF sid IS NOT NULL THEN INSERT INTO public.document_type_placements (doc_type_id, kind, snag_type_id) VALUES (p_id, 'qc', sid); END IF;
    ELSE
      INSERT INTO public.document_type_placements (doc_type_id, kind, register_key, record_type) VALUES (p_id, 'register', pl ->> 'ref', nullif(pl ->> 'record_type', ''));
    END IF;
  END LOOP;
END $$;

-- 2b. Building the slot set of a logical record. p_true / p_false: conditional documents the API judged as holding / not holding (ADR 0009 section 7).
-- The version in Data Entry is the one slots are built for; a record that is not site-scoped (global) has no slots (the slots need a site and a region).
CREATE OR REPLACE FUNCTION doc_sync_record_slots_core(p_entity uuid, p_true uuid[] DEFAULT ARRAY[]::uuid[], p_false uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; d record; made int := 0; ex record; nfiles int; snap_at timestamptz;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE entity_id = p_entity AND state = 'entry' ORDER BY version_no DESC LIMIT 1;
  IF NOT FOUND OR r.site_id IS NULL OR r.region_id IS NULL THEN RETURN 0; END IF;
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
        INSERT INTO public.document_slots (register_entity_id, register_key, site_id, region_id, doc_type_id, status, doc_type_version_id)
        VALUES (p_entity, r.register_key, r.site_id, r.region_id, d.id, 'missing', d.vid);
        made := made + 1;
      ELSIF d.condition_rule IS NOT NULL THEN
        FOR ex IN SELECT s.id FROM public.document_slots s WHERE s.register_entity_id = p_entity AND s.doc_type_id = d.id AND s.status::text = 'not_required' LOOP
          SELECT count(*) INTO nfiles FROM public.document_files f WHERE f.slot_id = ex.id AND f.is_current;
          UPDATE public.document_slots SET status = (CASE WHEN nfiles > 0 THEN 'uploaded' ELSE 'missing' END)::public."DocStatus", updated_at = now() WHERE id = ex.id;
        END LOOP;
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public.document_slots s WHERE s.register_entity_id = p_entity AND s.doc_type_id = d.id) THEN
      INSERT INTO public.document_slots (register_entity_id, register_key, site_id, region_id, doc_type_id, status, doc_type_version_id)
      VALUES (p_entity, r.register_key, r.site_id, r.region_id, d.id, 'not_required'::public."DocStatus", d.vid);
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

-- The API's door (granted): the record version must be visible to the caller.
CREATE OR REPLACE FUNCTION doc_sync_record_slots(p_record uuid, p_true uuid[] DEFAULT ARRAY[]::uuid[], p_false uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF NOT FOUND OR NOT public.app_region_read(r.is_global, r.region_id) THEN RETURN 0; END IF;
  RETURN public.doc_sync_record_slots_core(r.entity_id, p_true, p_false);
END $$;

-- Mandatory slots of a logical record that are missing or rejected (the version a slot was built from decides "mandatory").
CREATE OR REPLACE FUNCTION doc_record_missing_core(p_entity uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT dt.code ORDER BY dt.code), ARRAY[]::text[])
  FROM public.document_slots s
  JOIN public.document_types dt ON dt.id = s.doc_type_id
  LEFT JOIN public.document_type_versions v ON v.id = s.doc_type_version_id
  WHERE s.register_entity_id = p_entity AND s.status::text IN ('missing', 'rejected') AND coalesce(v.is_mandatory, dt.is_mandatory)
$$;

-- Read helper for the record view (granted): the codes still missing before Submit, for a version the caller can see.
CREATE OR REPLACE FUNCTION doc_record_missing(p_record uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF NOT FOUND OR NOT public.app_region_read(r.is_global, r.region_id) THEN RETURN ARRAY[]::text[]; END IF;
  RETURN public.doc_record_missing_core(r.entity_id);
END $$;

-- 2c. Triggers on register_records.
-- A new logical record (or a new version) builds its slot set; a new version opens the approved slots again (the files stay, Data Entry may replace one).
CREATE OR REPLACE FUNCTION doc_record_opened() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.version_no > 1 THEN
    UPDATE public.document_slots SET status = 'uploaded', updated_at = now() WHERE register_entity_id = NEW.entity_id AND status = 'approved';
  END IF;
  PERFORM public.doc_sync_record_slots_core(NEW.entity_id);
  RETURN NULL;
END $$;
CREATE TRIGGER doc_record_opened AFTER INSERT ON register_records FOR EACH ROW WHEN (NEW.state = 'entry') EXECUTE FUNCTION doc_record_opened();

-- Submit gate: leaving Data Entry needs every mandatory slot filled (the engine's own check for a linked task stays in reg_complete).
CREATE OR REPLACE FUNCTION doc_record_submit_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE miss text[];
BEGIN
  IF NEW.site_id IS NULL THEN RETURN NEW; END IF;
  PERFORM public.doc_sync_record_slots_core(NEW.entity_id);
  miss := public.doc_record_missing_core(NEW.entity_id);
  IF cardinality(miss) > 0 THEN PERFORM public.wf_err('mandatory_slots_missing', jsonb_build_object('missing', to_jsonb(miss))); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER doc_record_submit_gate BEFORE UPDATE OF state ON register_records FOR EACH ROW
  WHEN (OLD.state = 'entry' AND NEW.state IN ('in_review', 'in_approval', 'approved')) EXECUTE FUNCTION doc_record_submit_gate();

-- Slot statuses follow the record (the same moves as the engine makes on a task's slots, 0015 / 0016 / 0019).
CREATE OR REPLACE FUNCTION doc_record_state_moved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'approved' AND OLD.state IS DISTINCT FROM 'approved' THEN
    UPDATE public.document_slots SET status = 'approved', reject_reason = NULL, updated_at = now()
    WHERE register_entity_id = NEW.entity_id AND status IN ('uploaded', 'in_review');
    UPDATE public.document_files f SET approved_date = current_date FROM public.document_slots s
    WHERE f.slot_id = s.id AND s.register_entity_id = NEW.entity_id AND f.is_current AND f.approved_date IS NULL;
  ELSIF OLD.state = 'entry' AND NEW.state IN ('in_review', 'in_approval') THEN
    UPDATE public.document_slots SET status = 'in_review', reject_reason = NULL, updated_at = now()
    WHERE register_entity_id = NEW.entity_id AND status = 'uploaded';
  ELSIF OLD.state IN ('in_review', 'in_approval') AND NEW.state = 'entry' THEN
    UPDATE public.document_slots SET status = 'uploaded', updated_at = now()
    WHERE register_entity_id = NEW.entity_id AND status = 'in_review';
  ELSIF NEW.state = 'voided' AND OLD.state <> 'voided' THEN
    -- a voided correction gives the slots of the approved version back their approval (every current file approved before); a voided first version keeps them as they are
    UPDATE public.document_slots s SET status = 'approved', updated_at = now()
    WHERE s.register_entity_id = NEW.entity_id AND s.status IN ('uploaded', 'in_review')
      AND EXISTS (SELECT 1 FROM public.register_records o WHERE o.entity_id = NEW.entity_id AND o.is_current)
      AND EXISTS (SELECT 1 FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current)
      AND NOT EXISTS (SELECT 1 FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current AND f.approved_date IS NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER doc_record_state_moved AFTER UPDATE OF state ON register_records FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION doc_record_state_moved();

-- 2d. Who may change the files of a slot. Task slot: Data Entry of the task (0038). Record slot: Data Entry (L1) of the version in entry, `edit` on the
-- register's module in its region. Returns the owner as {kind, id} for the audit row.
CREATE OR REPLACE FUNCTION doc_slot_owner_for_write(p_slot public.document_slots, p_actor uuid, p_verb text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; r public.register_records%ROWTYPE;
BEGIN
  IF p_slot.task_id IS NOT NULL THEN
    t := public.wf_lock_task(p_slot.task_id, NULL);
    IF t.state NOT IN ('open', 'entry') THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Documents can be ' || p_verb || ' only while the task is pending or ongoing (it is ' || t.state::text || ').'));
    END IF;
    PERFORM public.wf_require_grant(t.region_id, 'edit');
    PERFORM public.wf_require_actor(t.id, 'entry', p_actor);
    RETURN jsonb_build_object('kind', 'task', 'id', t.id);
  END IF;
  IF p_slot.register_entity_id IS NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This slot belongs to no task and no register record.'));
  END IF;
  SELECT * INTO r FROM public.register_records WHERE entity_id = p_slot.register_entity_id AND state IN ('entry', 'in_review', 'in_approval') ORDER BY version_no DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Documents can be ' || p_verb || ' only while a version of the record is in Data Entry (start a new version of an approved record).'));
  END IF;
  r := public.reg_lock(r.id, NULL);
  PERFORM public.reg_require_grant(r.register_key, r.region_id, 'edit');
  PERFORM public.reg_require_actor(r.id, 'entry', p_actor);
  RETURN jsonb_build_object('kind', 'register_record', 'id', r.id);
END $$;

CREATE OR REPLACE FUNCTION doc_slot_audit(p_owner jsonb, p_action text, p_before jsonb, p_after jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_owner ->> 'kind' = 'task' THEN
    PERFORM public.wf_audit(p_action, (p_owner ->> 'id')::uuid, p_before, p_after, NULL);
  ELSE
    PERFORM public.reg_audit(p_action, (p_owner ->> 'id')::uuid, p_before, p_after, NULL);
  END IF;
END $$;

-- p_file keys as in 0038. Same checks for both owners.
CREATE OR REPLACE FUNCTION doc_attach_file(p_slot uuid, p_file jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.document_slots%ROWTYPE; owner_ jsonb; spec jsonb; ext text; sz bigint;
  grp uuid; ver int; cur int; maxf int; minf int; fid uuid; prev public.document_files%ROWTYPE; newstatus text; allowed text[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.document_slots WHERE id = p_slot FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(s.region_id) THEN PERFORM public.wf_err('not_found'); END IF;
  owner_ := public.doc_slot_owner_for_write(s, actor, 'uploaded');
  IF s.status::text IN ('approved', 'in_review', 'not_required') THEN
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
  UPDATE public.document_slots SET status = newstatus::public."DocStatus", reject_reason = CASE WHEN newstatus = 'uploaded' THEN NULL ELSE reject_reason END, updated_at = now() WHERE id = s.id;
  PERFORM public.doc_slot_audit(owner_, 'document_file_upload',
    jsonb_build_object('slot_id', s.id, 'slot_status', s.status),
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
  IF NOT FOUND OR NOT public.app_region_check(s.region_id) OR (s.task_id IS NULL AND s.register_entity_id IS NULL) THEN PERFORM public.wf_err('not_found'); END IF;
  SELECT * INTO f FROM public.document_files WHERE id = p_file AND slot_id = s.id;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The file is not in this slot.')); END IF;
  owner_ := public.doc_slot_owner_for_write(s, actor, 'withdrawn');
  IF s.status::text IN ('approved', 'in_review', 'not_required') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Files can be withdrawn only while the slot is not under review or approved.'));
  END IF;
  IF NOT f.is_current THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This version is already superseded or withdrawn.')); END IF;
  UPDATE public.document_files SET is_current = false, withdrawn_at = now(), withdrawn_by = actor WHERE id = f.id;
  SELECT count(*) INTO cur FROM public.document_files x WHERE x.slot_id = s.id AND x.is_current;
  minf := greatest(coalesce((public.doc_slot_spec(s.id) ->> 'min_files')::int, 1), 1);
  newstatus := CASE WHEN cur >= minf THEN 'uploaded' ELSE 'missing' END;
  UPDATE public.document_slots SET status = newstatus::public."DocStatus", updated_at = now() WHERE id = s.id;
  PERFORM public.doc_slot_audit(owner_, 'document_file_withdraw', jsonb_build_object('slot_id', s.id, 'slot_status', s.status, 'file_id', f.id, 'version', f.version),
    jsonb_build_object('slot_id', s.id, 'slot_status', newstatus, 'file_id', f.id));
  RETURN jsonb_build_object('slot_status', newstatus);
END $$;

-- One more slot on a record: a conditional document that applies ("this document applies"), or another candidate (candidate_label).
CREATE OR REPLACE FUNCTION doc_add_record_slot(p_record uuid, p_doc_code text, p_label text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); r public.register_records%ROWTYPE; d record; sid uuid; lbl text := nullif(btrim(coalesce(p_label, '')), ''); ex public.document_slots%ROWTYPE; nfiles int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  r := public.reg_lock(p_record, NULL);
  IF r.state <> 'entry' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Slots can be added only while the record is in Data Entry.'));
  END IF;
  IF r.site_id IS NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A record that is not tied to a site has no document slots.'));
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
      UPDATE public.document_slots SET status = (CASE WHEN nfiles > 0 THEN 'uploaded' ELSE 'missing' END)::public."DocStatus", conditional_declared = true, updated_at = now() WHERE id = ex.id;
      PERFORM public.reg_audit('document_slot_add', r.id, NULL, jsonb_build_object('slot_id', ex.id, 'doc_code', p_doc_code, 'candidate_label', lbl, 'reactivated', true), NULL);
      RETURN ex.id;
    END IF;
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'The record has this slot already.', 'existing_id', ex.id));
  END IF;
  INSERT INTO public.document_slots (register_entity_id, register_key, site_id, region_id, doc_type_id, candidate_label, status, doc_type_version_id, conditional_declared)
  VALUES (r.entity_id, r.register_key, r.site_id, r.region_id, d.id, lbl, 'missing', d.vid, d.condition_rule IS NOT NULL) RETURNING id INTO sid;
  INSERT INTO public.document_record_snapshots (entity_id) VALUES (r.entity_id) ON CONFLICT DO NOTHING;
  PERFORM public.reg_audit('document_slot_add', r.id, NULL, jsonb_build_object('slot_id', sid, 'doc_code', p_doc_code, 'candidate_label', lbl), NULL);
  RETURN sid;
END $$;

-- Rejection with named slots (RejectRequest.rejected_slots), as wf_reject does for a task: the record goes back one level with the note, the named slots
-- become rejected with their reason and the other slots under review go back to uploaded.
CREATE OR REPLACE FUNCTION doc_record_reject(p_record uuid, p_version int, p_note text, p_rejected_slots jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; res jsonb; x jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  res := public.reg_reject(p_record, p_version, p_note);
  IF p_rejected_slots IS NOT NULL AND jsonb_typeof(p_rejected_slots) = 'array' THEN
    FOR x IN SELECT * FROM jsonb_array_elements(p_rejected_slots) LOOP
      UPDATE public.document_slots SET status = 'rejected', reject_reason = left(x ->> 'reason', 500), updated_at = now()
      WHERE id = (x ->> 'slot_id')::uuid AND register_entity_id = r.entity_id;
      IF NOT FOUND THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'A rejected slot does not belong to this record.')); END IF;
    END LOOP;
    IF jsonb_array_length(p_rejected_slots) > 0 THEN
      PERFORM public.reg_audit('document_slots_reject', p_record, NULL, jsonb_build_object('rejected_slots', p_rejected_slots), p_note);
    END IF;
  END IF;
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Q132: QC snag photos and the snag flow (two levels from the Quality register's Matrix row)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE snag_types ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE snags
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS return_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_return_note text,
  ADD COLUMN IF NOT EXISTS ball_in_court_user_id uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_by uuid,
  ADD COLUMN IF NOT EXISTS self_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE snag_photos
  ADD COLUMN IF NOT EXISTS ext text,
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

-- A stored photo keeps its content for ever and is never deleted (it is withdrawn, or rejected by L2 with a note).
CREATE OR REPLACE FUNCTION snag_photos_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a stored snag photo is never deleted (withdraw it)' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (to_jsonb(NEW) - 'withdrawn_at' - 'withdrawn_by' - 'rejected_at' - 'review_note') IS DISTINCT FROM (to_jsonb(OLD) - 'withdrawn_at' - 'withdrawn_by' - 'rejected_at' - 'review_note') THEN
    RAISE EXCEPTION 'the content columns of a stored snag photo never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER snag_photos_guard BEFORE UPDATE OR DELETE ON snag_photos FOR EACH ROW EXECUTE FUNCTION snag_photos_guard();

-- The default snag type (seed data, editable in Settings): one photo, JPG / PNG / HEIC, 20 MB, blocks the PAC / FAC of its stream.
INSERT INTO snag_types (code, name_en, name_ar, min_photos, required_shots, formats, max_size_mb, blocks_preliminary_acceptance)
VALUES ('QC_GENERAL', 'General QC snag', 'ملاحظة جودة عامة', 1, '[]'::jsonb, ARRAY['jpg', 'png', 'heic'], 20, true)
ON CONFLICT (code) DO NOTHING;

-- The one-day tolerance of the EXIF check (owner answer Q132): EXIF has no time zone.
CREATE OR REPLACE FUNCTION qc_exif_tolerance() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '1 day' $$;

CREATE OR REPLACE FUNCTION qc_snag_cell(p_snag uuid, p_kind text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.reg_cell_row('quality', s.region_id, p_kind) FROM public.snags s WHERE s.id = p_snag
$$;

CREATE OR REPLACE FUNCTION qc_snag_eligible(p_snag uuid, p_kind text) RETURNS TABLE (user_id uuid, via_group uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; cell uuid;
BEGIN
  SELECT * INTO s FROM public.snags WHERE id = p_snag;
  IF NOT FOUND THEN RETURN; END IF;
  cell := public.reg_cell_row('quality', s.region_id, p_kind);
  IF cell IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT * FROM public.reg_eligible_cell(cell, s.region_id, public.reg_module('quality'), p_kind::public."PermissionLevel");
END $$;

CREATE OR REPLACE FUNCTION qc_snag_is_eligible(p_snag uuid, p_kind text, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.qc_snag_eligible(p_snag, p_kind) e WHERE e.user_id = p_user)
$$;

CREATE OR REPLACE FUNCTION qc_snag_has_holder(p_snag uuid, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.qc_snag_eligible(p_snag, p_kind))
$$;

-- Read helper for the snag view (granted): may the user act at this level of a snag in a region the caller can see?
CREATE OR REPLACE FUNCTION qc_snag_can(p_snag uuid, p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.snags s WHERE s.id = p_snag AND public.app_region_check(s.region_id))
     AND (public.qc_snag_is_eligible(p_snag, p_kind, public.app_actor())
          OR (public.app_actor_is_system_admin() AND NOT public.qc_snag_has_holder(p_snag, p_kind)))
$$;

CREATE OR REPLACE FUNCTION qc_snag_holders(p_snag uuid, p_kind text) RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.user_id FROM public.qc_snag_eligible(p_snag, p_kind) e
  WHERE EXISTS (SELECT 1 FROM public.snags s WHERE s.id = p_snag AND public.app_region_check(s.region_id))
$$;

CREATE OR REPLACE FUNCTION qc_snag_snap(p_snag uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('status', s.status, 'scope', s.scope, 'title', s.title, 'description', s.description, 'task_id', s.task_id, 'snag_type_id', s.snag_type_id,
    'return_count', s.return_count, 'pinned_to', s.ball_in_court_user_id, 'self_approval', s.self_approval, 'version', s.version,
    'photos', (SELECT count(*) FROM public.snag_photos p WHERE p.snag_id = s.id AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL))
  FROM public.snags s WHERE s.id = p_snag
$$;

CREATE OR REPLACE FUNCTION qc_audit(p_action text, p_snag uuid, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.snags WHERE id = p_snag;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, 'snag', p_snag::text, s.site_id, s.region_id, p_before, p_after, p_reason, public.app_actor());
END $$;

CREATE OR REPLACE FUNCTION qc_notify(p_user uuid, p_kind text, p_title text, p_body text, p_snag uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
  SELECT p_user, 'in_app', p_kind, p_title, p_body, '/sites/' || s.site_id::text || '?tab=snags&snag=' || s.id::text FROM public.snags s WHERE s.id = p_snag
$$;

-- Notifies the holders of a level, or the System Admins when nobody holds it (B10).
CREATE OR REPLACE FUNCTION qc_notify_level(p_snag uuid, p_kind text, p_except uuid, p_note_kind text, p_title text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h record; lbl text;
BEGIN
  SELECT coalesce(si.site_code, '') || ' / ' || coalesce(s.title, s.description) INTO lbl FROM public.snags s JOIN public.sites si ON si.id = s.site_id WHERE s.id = p_snag;
  IF NOT public.qc_snag_has_holder(p_snag, p_kind) THEN
    FOR h IN SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
             JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND NOT x.is_break_glass LOOP
      PERFORM public.qc_notify(h.user_id, 'no_eligible_holder', 'No holder for a snag level', lbl || ': nobody can act on the ' || p_kind || ' level.', p_snag);
    END LOOP;
    RETURN;
  END IF;
  FOR h IN SELECT e.user_id FROM public.qc_snag_eligible(p_snag, p_kind) e WHERE e.user_id IS DISTINCT FROM p_except LIMIT 20 LOOP
    PERFORM public.qc_notify(h.user_id, p_note_kind, p_title, lbl, p_snag);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION qc_lock_snag(p_snag uuid, p_version int) RETURNS public.snags
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; regs int[];
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.snags WHERE id = p_snag FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The snag does not exist or is not visible to you.')); END IF;
  regs := public.wf_actor_regions(public.reg_module('quality'), 'view');
  IF regs IS NOT NULL AND NOT (s.region_id = ANY (regs)) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The snag does not exist or is not visible to you.'));
  END IF;
  IF p_version IS NOT NULL AND p_version <> s.version THEN
    PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The snag changed since you read it. Reload and try again.'));
  END IF;
  RETURN s;
END $$;

-- May the caller act at the level the snag is at? Holder of the cell, or a System Admin when nobody holds it (B10). A snag returned by L2 is pinned to the
-- person who submitted it while they are still eligible (B6).
CREATE OR REPLACE FUNCTION qc_require_actor(p_snag uuid, p_kind text, p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; elig boolean := public.qc_snag_is_eligible(p_snag, p_kind, p_actor);
BEGIN
  SELECT * INTO s FROM public.snags WHERE id = p_snag;
  IF NOT (elig OR (public.app_user_is_system_admin(p_actor) AND NOT public.qc_snag_has_holder(p_snag, p_kind))) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a holder of the level the snag is at (Quality register row of the Responsibility Matrix).'));
  END IF;
  IF p_kind = 'entry' AND s.ball_in_court_user_id IS NOT NULL AND s.ball_in_court_user_id <> p_actor AND public.qc_snag_is_eligible(p_snag, 'entry', s.ball_in_court_user_id) THEN
    PERFORM public.wf_err('already_claimed', jsonb_build_object('claimed_by', s.ball_in_court_user_id));
  END IF;
  RETURN CASE WHEN elig THEN 'holder' ELSE 'admin' END;
END $$;

-- What the photos of a snag still lack against its type's rules: [] when the fix can be submitted.
CREATE OR REPLACE FUNCTION qc_photos_missing(p_snag uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; st public.snag_types%ROWTYPE; n int; shot text; errs jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM public.snags WHERE id = p_snag;
  SELECT * INTO st FROM public.snag_types WHERE id = s.snag_type_id;
  SELECT count(*) INTO n FROM public.snag_photos p WHERE p.snag_id = p_snag AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL;
  IF n < greatest(st.min_photos, 1) THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/photos', 'code', 'min_count', 'message', 'At least ' || greatest(st.min_photos, 1) || ' photo(s) of the fix are needed (' || n || ' now).'));
  END IF;
  IF jsonb_typeof(st.required_shots) = 'array' THEN
    FOR shot IN SELECT jsonb_array_elements_text(st.required_shots) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.snag_photos p WHERE p.snag_id = p_snag AND p.withdrawn_at IS NULL AND p.rejected_at IS NULL AND lower(p.shot_type) = lower(shot)) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/photos', 'code', 'shot_type_missing', 'message', 'A "' || shot || '" photo is needed.', 'shot_type', shot));
      END IF;
    END LOOP;
  END IF;
  RETURN errs;
END $$;

CREATE OR REPLACE FUNCTION qc_refresh_status(p_snag uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE st text;
BEGIN
  st := CASE WHEN jsonb_array_length(public.qc_photos_missing(p_snag)) = 0 THEN 'fix_uploaded' ELSE 'open' END;
  UPDATE public.snags SET status = st::public."SnagStatus" WHERE id = p_snag AND status IN ('open', 'fix_uploaded');
  RETURN st;
END $$;

-- Raise a snag (Quality `create` in the site's region). The stream (CW or TE) blocks the PAC / FAC of that stream (0016): it comes from p_scope or from the task.
CREATE OR REPLACE FUNCTION qc_raise_snag(p_site uuid, p_type uuid, p_task uuid, p_scope text, p_title text, p_description text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); si public.sites%ROWTYPE; st public.snag_types%ROWTYPE; t public.task_instances%ROWTYPE; sc text; sid uuid; regs int[]; errs jsonb := '[]'::jsonb;
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
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  INSERT INTO public.snags (site_id, region_id, task_id, snag_type_id, scope, description, title, status, raised_by, raised_at, updated_at)
  VALUES (si.id, si.region_id, t.id, st.id, sc, coalesce(nullif(btrim(coalesce(p_description, '')), ''), ''), btrim(p_title), 'open', actor, clock_timestamp(), clock_timestamp())
  RETURNING id INTO sid;
  PERFORM public.qc_audit('snag_raise', sid, NULL, public.qc_snag_snap(sid), NULL);
  PERFORM public.qc_notify_level(sid, 'entry', actor, 'snag_raised', 'A snag waits for photos of the fix');
  RETURN sid;
END $$;

-- Edit the title or the description while the snag is open (Quality `edit` in the region).
CREATE OR REPLACE FUNCTION qc_save_snag(p_snag uuid, p_version int, p_patch jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.snags%ROWTYPE; before_ jsonb;
BEGIN
  s := public.qc_lock_snag(p_snag, p_version);
  IF s.status NOT IN ('open', 'fix_uploaded') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'A snag in review or closed cannot be edited.'));
  END IF;
  PERFORM public.reg_require_grant('quality', s.region_id, 'edit');
  IF p_patch ? 'title' AND char_length(btrim(coalesce(p_patch ->> 'title', ''))) NOT BETWEEN 3 AND 200 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/title', 'code', 'invalid', 'message', 'The title is 3 to 200 characters.'))));
  END IF;
  before_ := public.qc_snag_snap(p_snag);
  UPDATE public.snags SET title = CASE WHEN p_patch ? 'title' THEN btrim(p_patch ->> 'title') ELSE title END,
    description = CASE WHEN p_patch ? 'description' THEN coalesce(p_patch ->> 'description', '') ELSE description END,
    version = version + 1, updated_at = now() WHERE id = p_snag;
  PERFORM public.qc_audit('snag_update', p_snag, before_, public.qc_snag_snap(p_snag), NULL);
END $$;

-- p_meta: storage_key, mime_type, ext, size_bytes, sha256, shot_type, exif_date, in_app_camera, device_lat, device_lon. The API has sniffed the bytes and read
-- the EXIF date; the database repeats every rule it can judge (who, when, format, size, shot type, the EXIF date against the raise time).
CREATE OR REPLACE FUNCTION qc_attach_photo(p_snag uuid, p_meta jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.snags%ROWTYPE; st public.snag_types%ROWTYPE; ext text; sz bigint; shot text; ex timestamptz; pid uuid; before_ jsonb;
  allowed text[];
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
  IF ex IS NOT NULL AND ex < s.raised_at - public.qc_exif_tolerance() THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'before_snag_raised',
      'message', 'The photo was taken before the snag was raised (EXIF date, one day of tolerance).'))));
  END IF;
  before_ := public.qc_snag_snap(p_snag);
  INSERT INTO public.snag_photos (snag_id, shot_type, storage_key, mime_type, ext, size_bytes, sha256, exif_date, unknown_capture_date, before_snag_raised,
                                  gps_lat, gps_lon, captured_in_app, uploaded_by, uploaded_at)
  VALUES (p_snag, shot, p_meta ->> 'storage_key', p_meta ->> 'mime_type', ext, sz, p_meta ->> 'sha256', ex, ex IS NULL, false,
          (p_meta ->> 'device_lat')::numeric, (p_meta ->> 'device_lon')::numeric, coalesce((p_meta ->> 'in_app_camera')::boolean, false), actor, clock_timestamp())
  RETURNING id INTO pid;
  PERFORM public.qc_refresh_status(p_snag);
  UPDATE public.snags SET version = version + 1, updated_at = now() WHERE id = p_snag;
  PERFORM public.qc_audit('snag_photo_upload', p_snag, before_, public.qc_snag_snap(p_snag) || jsonb_build_object('photo_id', pid, 'sha256', p_meta ->> 'sha256',
    'size_bytes', sz, 'shot_type', shot, 'exif_date', ex, 'unknown_capture_date', ex IS NULL), NULL);
  RETURN pid;
END $$;

CREATE OR REPLACE FUNCTION qc_withdraw_photo(p_snag uuid, p_photo uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); s public.snags%ROWTYPE; p public.snag_photos%ROWTYPE; before_ jsonb;
BEGIN
  s := public.qc_lock_snag(p_snag, NULL);
  SELECT * INTO p FROM public.snag_photos WHERE id = p_photo AND snag_id = p_snag;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The photo is not on this snag.')); END IF;
  IF s.status NOT IN ('open', 'fix_uploaded') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Photos can be withdrawn only while the snag waits for the fix.'));
  END IF;
  IF p.withdrawn_at IS NOT NULL OR p.rejected_at IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This photo is already withdrawn or rejected.'));
  END IF;
  PERFORM public.reg_require_grant('quality', s.region_id, 'edit');
  PERFORM public.qc_require_actor(p_snag, 'entry', actor);
  before_ := public.qc_snag_snap(p_snag);
  UPDATE public.snag_photos SET withdrawn_at = now(), withdrawn_by = actor WHERE id = p_photo;
  PERFORM public.qc_refresh_status(p_snag);
  UPDATE public.snags SET version = version + 1, updated_at = now() WHERE id = p_snag;
  PERFORM public.qc_audit('snag_photo_withdraw', p_snag, before_, public.qc_snag_snap(p_snag) || jsonb_build_object('photo_id', p_photo), NULL);
END $$;

-- submit (L1, the site engineer), approve (L2, closes the snag), reject (L2, back to L1 with a note). review answers invalid_transition: a snag has two levels.
-- p_rejected_photos: [{photo_id, reason}] for a rejection; those photos leave the set (kept on record) and the snag needs new ones.
CREATE OR REPLACE FUNCTION qc_transition_snag(p_snag uuid, p_version int, p_action text, p_note text, p_stepup boolean, p_rejected_photos jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.snags%ROWTYPE; before_ jsonb; miss jsonb; self boolean := false; rl public."MatrixRule"; x jsonb; pin uuid; st text;
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
    -- B5: the submitter who also holds L2 (any one member) makes the final approval with the submission
    SELECT c.rule INTO rl FROM public.matrix_cells c WHERE c.id = public.qc_snag_cell(p_snag, 'approve');
    self := coalesce(rl, 'any_one') = 'any_one' AND public.qc_snag_is_eligible(p_snag, 'approve', actor);
    IF self THEN
      PERFORM public.reg_require_grant('quality', s.region_id, 'approve');
      IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
      UPDATE public.snags SET status = 'closed', closed_at = now(), closed_by = actor, submitted_at = now(), submitted_by = actor, self_approval = true,
        ball_in_court_user_id = NULL, version = version + 1, updated_at = now() WHERE id = p_snag;
      PERFORM public.qc_audit('snag_close', p_snag, before_, public.qc_snag_snap(p_snag) || jsonb_build_object('self_approval_flag', true, 'stepup_verified', true), p_note);
    ELSE
      UPDATE public.snags SET status = 'in_review', submitted_at = now(), submitted_by = actor, ball_in_court_user_id = NULL, version = version + 1, updated_at = now() WHERE id = p_snag;
      PERFORM public.qc_audit('snag_submit', p_snag, before_, public.qc_snag_snap(p_snag), p_note);
      PERFORM public.qc_notify_level(p_snag, 'approve', actor, 'snag_review', 'Photos of a snag fix wait for your approval');
    END IF;
  ELSIF p_action = 'approve' THEN
    IF s.status <> 'in_review' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a snag in review can be approved (it is ' || s.status::text || ').'));
    END IF;
    PERFORM public.reg_require_grant('quality', s.region_id, 'approve');
    PERFORM public.qc_require_actor(p_snag, 'approve', actor);
    IF NOT coalesce(p_stepup, false) THEN PERFORM public.wf_err('step_up_required'); END IF;
    UPDATE public.snags SET status = 'closed', closed_at = now(), closed_by = actor, ball_in_court_user_id = NULL, version = version + 1, updated_at = now() WHERE id = p_snag;
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
    PERFORM public.qc_require_actor(p_snag, 'approve', actor);
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
  RETURN jsonb_build_object('id', p_snag, 'self_approval', self);
END $$;

-- Snag types (QC photo rules, CLAUDE.md "Admin overrides ... QC photo rules"): System Admin or a delegate of the Document Library configuration.
-- p_patch keys: code (create only), name_en, name_ar, photo_rules {min_count, shot_types, formats, max_size_mb}, blocks_preliminary_acceptance, is_active.
CREATE OR REPLACE FUNCTION admin_save_snag_type(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE st public.snag_types%ROWTYPE; pr jsonb := p_patch -> 'photo_rules'; errs jsonb := '[]'::jsonb; f text; before_ jsonb; nid uuid; ver int;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
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
  IF p_id IS NULL THEN
    INSERT INTO public.snag_types (code, name_en, name_ar, min_photos, required_shots, formats, max_size_mb, blocks_preliminary_acceptance, is_active)
    VALUES (p_patch ->> 'code', btrim(p_patch ->> 'name_en'), p_patch ->> 'name_ar', coalesce((pr ->> 'min_count')::int, 1), coalesce(pr -> 'shot_types', '[]'::jsonb),
            coalesce(ARRAY(SELECT lower(x) FROM jsonb_array_elements_text(pr -> 'formats') x), ARRAY['jpg', 'png', 'heic']), coalesce((pr ->> 'max_size_mb')::int, 20),
            coalesce((p_patch ->> 'blocks_preliminary_acceptance')::boolean, true), coalesce((p_patch ->> 'is_active')::boolean, true))
    RETURNING id, version INTO nid, ver;
    PERFORM public.calc_audit('snag_type_create', 'snag_type', nid::text, NULL, p_patch, p_reason);
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
    blocks_preliminary_acceptance = CASE WHEN p_patch ? 'blocks_preliminary_acceptance' THEN (p_patch ->> 'blocks_preliminary_acceptance')::boolean ELSE blocks_preliminary_acceptance END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::boolean ELSE is_active END,
    version = version + 1
  WHERE id = p_id RETURNING version INTO ver;
  PERFORM public.calc_audit(CASE WHEN st.is_active AND p_patch ? 'is_active' AND NOT (p_patch ->> 'is_active')::boolean THEN 'snag_type_deactivate' ELSE 'snag_type_update' END,
    'snag_type', p_id::text, before_, (SELECT to_jsonb(x) FROM public.snag_types x WHERE x.id = p_id), p_reason);
  RETURN jsonb_build_object('id', p_id, 'version', ver);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Ownership, rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON document_record_snapshots TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON snags, snag_photos, snag_types TO pmis_definer;
GRANT SELECT, UPDATE ON sites TO pmis_definer;
GRANT SELECT ON field_definitions, register_task_sources TO pmis_definer;
GRANT SELECT, INSERT, DELETE ON document_type_placements TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON document_slots, document_files TO pmis_definer;
GRANT INSERT ON notifications TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'site_save_custom(uuid,timestamptz,jsonb,text)', 'doc_procurement_delivery(uuid,text)',
    'doc_live_spec(uuid)', 'doc_validate_spec(jsonb)', 'doc_apply_spec(uuid,jsonb)',
    'doc_sync_record_slots_core(uuid,uuid[],uuid[])', 'doc_sync_record_slots(uuid,uuid[],uuid[])', 'doc_record_missing_core(uuid)', 'doc_record_missing(uuid)',
    'doc_record_opened()', 'doc_record_submit_gate()', 'doc_record_state_moved()', 'doc_slot_owner_for_write(document_slots,uuid,text)', 'doc_slot_audit(jsonb,text,jsonb,jsonb)',
    'doc_attach_file(uuid,jsonb)', 'doc_withdraw_file(uuid,uuid)', 'doc_add_record_slot(uuid,text,text)', 'doc_record_reject(uuid,integer,text,jsonb)',
    'qc_snag_cell(uuid,text)', 'qc_snag_eligible(uuid,text)', 'qc_snag_is_eligible(uuid,text,uuid)', 'qc_snag_has_holder(uuid,text)', 'qc_snag_can(uuid,text)',
    'qc_snag_holders(uuid,text)', 'qc_snag_snap(uuid)', 'qc_audit(text,uuid,jsonb,jsonb,text)', 'qc_notify(uuid,text,text,text,uuid)',
    'qc_notify_level(uuid,text,uuid,text,text)', 'qc_lock_snag(uuid,integer)', 'qc_require_actor(uuid,text,uuid)', 'qc_photos_missing(uuid)', 'qc_refresh_status(uuid)',
    'qc_raise_snag(uuid,uuid,uuid,text,text,text)', 'qc_save_snag(uuid,integer,jsonb)', 'qc_attach_photo(uuid,jsonb)', 'qc_withdraw_photo(uuid,uuid)',
    'qc_transition_snag(uuid,integer,text,text,boolean,jsonb)', 'admin_save_snag_type(uuid,jsonb,text,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- not granted: the cores, the triggers, the owner and audit helpers, the lock, the eligibility internals and the notification helpers
    -- (qc_snag_cell only names the Quality row's matrix cell, which every session reads in the matrix anyway)
    FOREACH f IN ARRAY ARRAY[
      'site_save_custom(uuid,timestamptz,jsonb,text)', 'doc_procurement_delivery(uuid,text)', 'doc_sync_record_slots(uuid,uuid[],uuid[])', 'doc_record_missing(uuid)',
      'doc_attach_file(uuid,jsonb)', 'doc_withdraw_file(uuid,uuid)', 'doc_add_record_slot(uuid,text,text)', 'doc_record_reject(uuid,integer,text,jsonb)',
      'qc_snag_can(uuid,text)', 'qc_snag_holders(uuid,text)', 'qc_photos_missing(uuid)', 'qc_snag_cell(uuid,text)',
      'qc_raise_snag(uuid,uuid,uuid,text,text,text)', 'qc_save_snag(uuid,integer,jsonb)', 'qc_attach_photo(uuid,jsonb)', 'qc_withdraw_photo(uuid,uuid)',
      'qc_transition_snag(uuid,integer,text,text,boolean,jsonb)', 'admin_save_snag_type(uuid,jsonb,text,integer)', 'doc_live_spec(uuid)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON snags, snag_photos, snag_types, document_slots, document_files, document_type_placements FROM pmis_app;
    REVOKE ALL ON document_record_snapshots FROM pmis_app;
  END IF;
END $$;
