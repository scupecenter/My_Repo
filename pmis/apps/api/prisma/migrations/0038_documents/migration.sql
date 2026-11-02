-- 0038_documents: the document upload module (owner rules "Document Library" and "Documents and QC", ADR 0007 section 4, ADR 0008).
-- Mirror: db/sql/037_documents.sql (kept identical to prisma/migrations/0038_documents/migration.sql).
--
-- What this adds.
--   1. The Document Library as versioned data. document_types holds the PUBLISHED (live) definition of a library-managed document and what tasks
--      snapshot; edits go to document_type_drafts and reach tasks only on publish (admin_publish_document_type), which writes an immutable
--      document_type_versions row, with "new tasks only" or "also open tasks" (approved tasks and tasks in review or approval never change).
--      Documents are deactivated, never deleted. A generated form is a document with form_kind (CW DN, RN, PAC, FAC, snag list).
--   2. Slots follow the task. A task snapshots its slot set when it opens (trigger on task_instances -> doc_sync_task_slots_core, table
--      document_task_snapshots); each slot points at the published version it was created from (document_slots.doc_type_version_id), which decides
--      mandatory, formats, size and file counts for that slot. wf_missing_slots now reads the slots (and keeps the old rule for document types that
--      were never published through the library, so existing fixtures keep working).
--   3. Files: doc_attach_file / doc_withdraw_file / doc_add_slot (Data Entry L1 of the task, region checked, audited). Superseded versions are kept
--      (document_files.is_current, superseded_by); a file row is never deleted and its content columns never change (trigger).
--   4. Reads: audit of every download (doc_audit), the bulk zip job table (document_export_jobs) with doc_job_create / doc_job_update, blank forms.
--   5. Seed: stages 1 to 3 as listed in CLAUDE.md ("Seed content of the library") are published; stages 4 to 10 come from docs/spec/task-catalogue.csv
--      as drafts "to review by the product owner" (needs_review) and are not on any task until an admin publishes them.
--   6. pmis_app is read-only on all of these tables; every write goes through the SECURITY DEFINER functions below (see also db/sql/app_grants.sql).
--
-- The file bytes are not in the database: storage_key names an object in S3-compatible storage (MinIO) or on local disk, under a random key.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Enum, columns, constraints
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TYPE "DocStatus" ADD VALUE IF NOT EXISTS 'not_required';

ALTER TABLE document_types
  ADD COLUMN IF NOT EXISTS form_kind text,
  ADD COLUMN IF NOT EXISTS published_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lib_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE document_types ADD CONSTRAINT document_types_form_kind_check CHECK (form_kind IS NULL OR form_kind IN ('dn', 'rn', 'pac', 'fac', 'snag_list'));

ALTER TABLE document_slots
  ADD COLUMN IF NOT EXISTS doc_type_version_id uuid,
  ADD COLUMN IF NOT EXISTS conditional_declared boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS document_slots_task_type_label ON document_slots (task_id, doc_type_id, coalesce(candidate_label, '')) WHERE task_id IS NOT NULL;

ALTER TABLE document_files
  ADD COLUMN IF NOT EXISTS ext text,
  ADD COLUMN IF NOT EXISTS capture_date timestamptz,
  ADD COLUMN IF NOT EXISTS unknown_capture_date boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS superseded_by uuid,
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_by uuid;

CREATE TABLE document_type_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type_id   uuid NOT NULL REFERENCES document_types(id),
  version_no    integer NOT NULL,
  spec          jsonb NOT NULL,                       -- the full definition as published (see doc_live_spec)
  is_mandatory  boolean NOT NULL,
  is_active     boolean NOT NULL,
  effective_from date NOT NULL DEFAULT current_date,
  apply_to      text NOT NULL DEFAULT 'new_only' CHECK (apply_to IN ('new_only', 'open_too')),
  reason        text NOT NULL,
  affected_open_tasks integer NOT NULL DEFAULT 0,
  published_by  uuid,
  published_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_type_id, version_no)
);
ALTER TABLE document_slots ADD CONSTRAINT document_slots_version_fk FOREIGN KEY (doc_type_version_id) REFERENCES document_type_versions(id);
ALTER TABLE document_files ADD CONSTRAINT document_files_superseded_fk FOREIGN KEY (superseded_by) REFERENCES document_files(id);
CREATE INDEX document_slots_version_idx ON document_slots (doc_type_version_id);

CREATE TABLE document_type_drafts (
  doc_type_id uuid PRIMARY KEY REFERENCES document_types(id),
  spec        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

CREATE TABLE document_blank_forms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type_id   uuid NOT NULL REFERENCES document_types(id),
  original_name text NOT NULL,
  storage_key   text NOT NULL,
  mime_type     text NOT NULL,
  ext           text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  uploaded_by   uuid NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- The slot set of a task is frozen when the task opens (snapshot-on-open, ADR 0007 section 2): a row here means "slots were built".
CREATE TABLE document_task_snapshots (
  task_id  uuid PRIMARY KEY REFERENCES task_instances(id),
  taken_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_export_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by  uuid NOT NULL,
  scope         jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  progress      numeric NOT NULL DEFAULT 0,
  file_count    integer,
  size_bytes    bigint,
  storage_key   text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  expires_at    timestamptz
);
CREATE INDEX document_export_jobs_user_idx ON document_export_jobs (requested_by, created_at DESC);

-- Row-level security: configuration is readable by every session; drafts by the people who may edit the library; jobs by their owner and the System Admins.
ALTER TABLE document_type_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_type_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON document_type_versions FOR SELECT USING (app_has_session() OR app_is_seeding());
ALTER TABLE document_blank_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_blank_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON document_blank_forms FOR SELECT USING (app_has_session() OR app_is_seeding());
ALTER TABLE document_type_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_type_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON document_type_drafts FOR SELECT USING (app_can('document_types', 'view') OR app_can('document_types', 'edit') OR app_is_seeding());
ALTER TABLE document_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON document_export_jobs FOR SELECT USING (requested_by = app_actor() OR app_actor_is_system_admin() OR app_is_seeding());
ALTER TABLE document_task_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_task_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON document_task_snapshots FOR SELECT USING (app_is_seeding());

-- Immutability. A published version never changes. A stored file keeps its content columns for ever and is never deleted; only the version
-- bookkeeping (is_current, superseded_by, withdrawn_*) and the approved date move.
CREATE OR REPLACE FUNCTION doc_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE OR REPLACE FUNCTION doc_type_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- only the count of tasks the publish reached is written after the row exists (by admin_publish_document_type)
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'affected_open_tasks') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'affected_open_tasks') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'document_type_versions rows are immutable' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER document_type_versions_immutable BEFORE UPDATE OR DELETE ON document_type_versions FOR EACH ROW EXECUTE FUNCTION doc_type_versions_guard();
CREATE TRIGGER document_blank_forms_immutable BEFORE UPDATE OR DELETE ON document_blank_forms FOR EACH ROW EXECUTE FUNCTION doc_versions_immutable();

CREATE OR REPLACE FUNCTION doc_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a stored document file is never deleted (withdraw or supersede it)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'is_current' - 'superseded_by' - 'withdrawn_at' - 'withdrawn_by' - 'approved_date' - 'stored_name')
     IS DISTINCT FROM (to_jsonb(OLD) - 'is_current' - 'superseded_by' - 'withdrawn_at' - 'withdrawn_by' - 'approved_date' - 'stored_name') THEN
    RAISE EXCEPTION 'the content columns of a stored document file never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_files_guard BEFORE UPDATE OR DELETE ON document_files FOR EACH ROW EXECUTE FUNCTION doc_files_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Helpers: the live definition as a spec, applying a spec, validation
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION doc_live_spec(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.document_types%ROWTYPE; pl jsonb;
BEGIN
  SELECT * INTO d FROM public.document_types WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(x.p ORDER BY x.k), '[]'::jsonb) INTO pl FROM (
    SELECT p.kind::text || ':' || coalesce(td.code, st.code, p.register_key, '') AS k,
           jsonb_build_object('target', p.kind::text, 'ref', coalesce(td.code, st.code, p.register_key)) AS p
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

-- The task definition a placement by task code stands for (the latest published workflow version that has the code).
CREATE OR REPLACE FUNCTION doc_task_def_of_code(p_code text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT td.id FROM public.task_definitions td JOIN public.workflow_definitions w ON w.id = td.workflow_id
  WHERE td.code = p_code AND w.status = 'published' ORDER BY w.version DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION doc_validate_spec(p_spec jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  errs jsonb := '[]'::jsonb; f text; pl jsonb; idx int := 0; k text; fk text; maxf int; minf int;
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
      END IF;
      idx := idx + 1;
    END LOOP;
  END IF;
  IF p_spec ? 'condition_rule' AND jsonb_typeof(p_spec -> 'condition_rule') NOT IN ('object', 'null') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/condition_rule', 'code', 'invalid', 'message', 'A rule is an object or null.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
END $$;

-- Writes a spec into the live columns and placements of a document type (publish, seed, adopt). Does not touch versions or drafts.
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
      INSERT INTO public.document_type_placements (doc_type_id, kind, register_key) VALUES (p_id, 'register', pl ->> 'ref');
    END IF;
  END LOOP;
END $$;

-- Publishes the live definition as the next immutable version. Returns the version id.
CREATE OR REPLACE FUNCTION doc_snapshot_version(p_id uuid, p_apply text, p_from date, p_reason text, p_affected int) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int; vid uuid; spec jsonb := public.doc_live_spec(p_id);
BEGIN
  UPDATE public.document_types SET published_version = published_version + 1 WHERE id = p_id RETURNING published_version INTO n;
  INSERT INTO public.document_type_versions (doc_type_id, version_no, spec, is_mandatory, is_active, effective_from, apply_to, reason, affected_open_tasks, published_by)
  VALUES (p_id, n, spec, coalesce((spec ->> 'mandatory')::boolean, true), coalesce((spec ->> 'is_active')::boolean, true), coalesce(p_from, current_date), p_apply,
          coalesce(p_reason, 'seed'), coalesce(p_affected, 0), public.app_actor())
  RETURNING id INTO vid;
  RETURN vid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Slots on tasks: build the slot set of a task (snapshot on open), refresh it on an "also open tasks" publish
-- ---------------------------------------------------------------------------------------------------------------------
-- p_true / p_false: conditional document types whose rule the API evaluated as holding / not holding for this task (the rule language is
-- evaluated in the API, ADR 0009 section 7). Returns the number of slots created.
CREATE OR REPLACE FUNCTION doc_sync_task_slots_core(p_task uuid, p_true uuid[] DEFAULT ARRAY[]::uuid[], p_false uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; tcode text; d record; made int := 0; ex record; nfiles int; snap_at timestamptz;
BEGIN
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND OR t.state NOT IN ('open', 'entry') THEN RETURN 0; END IF;
  SELECT taken_at INTO snap_at FROM public.document_task_snapshots WHERE task_id = p_task;
  SELECT code INTO tcode FROM public.task_definitions WHERE id = t.task_def_id;
  FOR d IN
    SELECT dt.id, dt.condition_rule, v.id AS vid, v.is_mandatory FROM public.document_types dt
    JOIN public.document_type_versions v ON v.doc_type_id = dt.id AND v.version_no = dt.published_version
    WHERE dt.lib_managed AND dt.is_active AND dt.published_version > 0
      AND EXISTS (SELECT 1 FROM public.document_type_placements pl JOIN public.task_definitions pd ON pd.id = pl.task_def_id
                  WHERE pl.doc_type_id = dt.id AND pl.kind = 'task' AND pd.code = tcode)
      -- snapshot on open: a task that has its slot set takes a document only if it was published before the snapshot, or for open tasks too
      AND (snap_at IS NULL OR EXISTS (SELECT 1 FROM public.document_type_versions pv WHERE pv.doc_type_id = dt.id AND (pv.published_at <= snap_at OR pv.apply_to = 'open_too')))
  LOOP
    IF d.condition_rule IS NULL OR d.id = ANY (p_true) THEN
      IF NOT EXISTS (SELECT 1 FROM public.document_slots s WHERE s.task_id = p_task AND s.doc_type_id = d.id) THEN
        INSERT INTO public.document_slots (task_id, site_id, region_id, doc_type_id, status, doc_type_version_id) VALUES (p_task, t.site_id, t.region_id, d.id, 'missing', d.vid);
        made := made + 1;
      ELSIF d.condition_rule IS NOT NULL THEN
        FOR ex IN SELECT s.id FROM public.document_slots s WHERE s.task_id = p_task AND s.doc_type_id = d.id AND s.status::text = 'not_required' LOOP
          SELECT count(*) INTO nfiles FROM public.document_files f WHERE f.slot_id = ex.id AND f.is_current;
          UPDATE public.document_slots SET status = (CASE WHEN nfiles > 0 THEN 'uploaded' ELSE 'missing' END)::public."DocStatus", updated_at = now() WHERE id = ex.id;
        END LOOP;
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public.document_slots s WHERE s.task_id = p_task AND s.doc_type_id = d.id) THEN
      -- a conditional document whose rule does not hold (or cannot be judged): the slot is on the task as "not required", and Data Entry can declare that it applies
      INSERT INTO public.document_slots (task_id, site_id, region_id, doc_type_id, status, doc_type_version_id) VALUES (p_task, t.site_id, t.region_id, d.id, 'not_required'::public."DocStatus", d.vid);
      made := made + 1;
    ELSIF d.id = ANY (p_false) THEN
      UPDATE public.document_slots s SET status = 'not_required'::public."DocStatus", updated_at = now()
      WHERE s.task_id = p_task AND s.doc_type_id = d.id AND s.status IN ('missing', 'rejected') AND NOT s.conditional_declared
        AND NOT EXISTS (SELECT 1 FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current);
    END IF;
  END LOOP;
  INSERT INTO public.document_task_snapshots (task_id) VALUES (p_task) ON CONFLICT DO NOTHING;
  RETURN made;
END $$;

CREATE OR REPLACE FUNCTION doc_sync_task_slots(p_task uuid, p_true uuid[] DEFAULT ARRAY[]::uuid[], p_false uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r int;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT region_id INTO r FROM public.task_instances WHERE id = p_task;
  IF r IS NULL OR NOT public.app_region_check(r) THEN RETURN 0; END IF;
  RETURN public.doc_sync_task_slots_core(p_task, p_true, p_false);
END $$;

CREATE OR REPLACE FUNCTION doc_task_opened() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.doc_sync_task_slots_core(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER doc_task_opened_ins AFTER INSERT ON task_instances FOR EACH ROW WHEN (NEW.state IN ('open', 'entry')) EXECUTE FUNCTION doc_task_opened();
CREATE TRIGGER doc_task_opened_upd AFTER UPDATE OF state ON task_instances FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('open', 'entry')) EXECUTE FUNCTION doc_task_opened();

-- Slots the task still needs before it can be submitted. (1) its slots: missing or rejected, and mandatory in the version the slot was built from;
-- (2) the old rule for document types that were never published through the library (lib_managed = false): placed on the task, active, mandatory,
-- without a usable slot.
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

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Files: attach, withdraw, add a slot (Data Entry of the task)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION doc_slot_spec(p_slot uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(v.spec, public.doc_live_spec(s.doc_type_id)) FROM public.document_slots s
  LEFT JOIN public.document_type_versions v ON v.id = s.doc_type_version_id WHERE s.id = p_slot
$$;

-- p_file keys: storage_key, original_name, stored_name, mime_type, ext, size_bytes, sha256, replaces_file_group_id, capture_date, unknown_capture_date.
-- The API has already sniffed the bytes; the database repeats the rules it can judge from the metadata (format, size, file count, who, when).
CREATE OR REPLACE FUNCTION doc_attach_file(p_slot uuid, p_file jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); s public.document_slots%ROWTYPE; t public.task_instances%ROWTYPE; spec jsonb; ext text; sz bigint;
  grp uuid; ver int; cur int; maxf int; minf int; fid uuid; prev public.document_files%ROWTYPE; newstatus text; allowed text[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.document_slots WHERE id = p_slot FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(s.region_id) THEN PERFORM public.wf_err('not_found'); END IF;
  IF s.task_id IS NULL THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This slot does not belong to a task.')); END IF;
  t := public.wf_lock_task(s.task_id, NULL);
  IF t.state NOT IN ('open', 'entry') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Documents can be uploaded only while the task is pending or ongoing (it is ' || t.state::text || ').'));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(t.id, 'entry', actor);
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
  PERFORM public.wf_audit('document_file_upload', t.id,
    jsonb_build_object('slot_id', s.id, 'slot_status', s.status),
    jsonb_build_object('slot_id', s.id, 'slot_status', newstatus, 'file_id', fid, 'file_group_id', grp, 'version', ver, 'original_name', left(p_file ->> 'original_name', 255),
                       'size_bytes', sz, 'sha256', p_file ->> 'sha256', 'mime_type', p_file ->> 'mime_type', 'replaced_file_id', prev.id), NULL);
  RETURN jsonb_build_object('file_id', fid, 'file_group_id', grp, 'version', ver, 'slot_status', newstatus);
END $$;

CREATE OR REPLACE FUNCTION doc_withdraw_file(p_slot uuid, p_file uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); s public.document_slots%ROWTYPE; t public.task_instances%ROWTYPE; f public.document_files%ROWTYPE; cur int; minf int; newstatus text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.document_slots WHERE id = p_slot FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(s.region_id) OR s.task_id IS NULL THEN PERFORM public.wf_err('not_found'); END IF;
  t := public.wf_lock_task(s.task_id, NULL);
  SELECT * INTO f FROM public.document_files WHERE id = p_file AND slot_id = s.id;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The file is not in this slot.')); END IF;
  IF t.state NOT IN ('open', 'entry') OR s.status::text IN ('approved', 'in_review', 'not_required') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Files can be withdrawn only while the task is pending or ongoing and the slot is not under review.'));
  END IF;
  IF NOT f.is_current THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This version is already superseded or withdrawn.')); END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(t.id, 'entry', actor);
  UPDATE public.document_files SET is_current = false, withdrawn_at = now(), withdrawn_by = actor WHERE id = f.id;
  SELECT count(*) INTO cur FROM public.document_files x WHERE x.slot_id = s.id AND x.is_current;
  minf := greatest(coalesce((public.doc_slot_spec(s.id) ->> 'min_files')::int, 1), 1);
  newstatus := CASE WHEN cur >= minf THEN 'uploaded' ELSE 'missing' END;
  UPDATE public.document_slots SET status = newstatus::public."DocStatus", updated_at = now() WHERE id = s.id;
  PERFORM public.wf_audit('document_file_withdraw', t.id, jsonb_build_object('slot_id', s.id, 'slot_status', s.status, 'file_id', f.id, 'version', f.version),
    jsonb_build_object('slot_id', s.id, 'slot_status', newstatus, 'file_id', f.id), NULL);
  RETURN jsonb_build_object('slot_status', newstatus);
END $$;

-- One more slot: a conditional document the rule engine cannot judge yet ("this applies"), or another candidate (candidate_label).
CREATE OR REPLACE FUNCTION doc_add_slot(p_task uuid, p_doc_code text, p_label text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; d record; sid uuid; lbl text := nullif(btrim(coalesce(p_label, '')), ''); ex public.document_slots%ROWTYPE; nfiles int; tcode text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  t := public.wf_lock_task(p_task, NULL);
  IF t.state NOT IN ('open', 'entry') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Slots can be added only while the task is pending or ongoing.'));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(t.id, 'entry', actor);
  SELECT code INTO tcode FROM public.task_definitions WHERE id = t.task_def_id;
  SELECT dt.id, dt.condition_rule, v.id AS vid INTO d FROM public.document_types dt
    JOIN public.document_type_versions v ON v.doc_type_id = dt.id AND v.version_no = dt.published_version
  WHERE dt.code = p_doc_code AND dt.lib_managed AND dt.is_active AND dt.published_version > 0
    AND EXISTS (SELECT 1 FROM public.document_type_placements pl JOIN public.task_definitions pd ON pd.id = pl.task_def_id WHERE pl.doc_type_id = dt.id AND pl.kind = 'task' AND pd.code = tcode);
  IF NOT FOUND THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/doc_code', 'code', 'unknown_document', 'message', 'This document is not placed on the task.'))));
  END IF;
  SELECT * INTO ex FROM public.document_slots s WHERE s.task_id = p_task AND s.doc_type_id = d.id AND coalesce(s.candidate_label, '') = coalesce(lbl, '');
  IF FOUND THEN
    IF ex.status::text = 'not_required' THEN
      SELECT count(*) INTO nfiles FROM public.document_files f WHERE f.slot_id = ex.id AND f.is_current;
      UPDATE public.document_slots SET status = (CASE WHEN nfiles > 0 THEN 'uploaded' ELSE 'missing' END)::public."DocStatus", conditional_declared = true, updated_at = now() WHERE id = ex.id;
      PERFORM public.wf_audit('document_slot_add', p_task, NULL, jsonb_build_object('slot_id', ex.id, 'doc_code', p_doc_code, 'candidate_label', lbl, 'reactivated', true), NULL);
      RETURN ex.id;
    END IF;
    PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'The task has this slot already.', 'existing_id', ex.id));
  END IF;
  INSERT INTO public.document_slots (task_id, site_id, region_id, doc_type_id, candidate_label, status, doc_type_version_id, conditional_declared)
  VALUES (p_task, t.site_id, t.region_id, d.id, lbl, 'missing', d.vid, d.condition_rule IS NOT NULL) RETURNING id INTO sid;
  INSERT INTO public.document_task_snapshots (task_id) VALUES (p_task) ON CONFLICT DO NOTHING;
  PERFORM public.wf_audit('document_slot_add', p_task, NULL, jsonb_build_object('slot_id', sid, 'doc_code', p_doc_code, 'candidate_label', lbl), NULL);
  RETURN sid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Audit of reads, zip jobs, blank forms
-- ---------------------------------------------------------------------------------------------------------------------
-- Every download is written before the first byte is served. Allow-listed actions only; the file must be visible to the caller.
CREATE OR REPLACE FUNCTION doc_audit(p_action text, p_entity text, p_id text, p_site uuid, p_region int, p_after jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_action NOT IN ('document_file_download', 'document_blank_form_download', 'document_zip_start', 'document_zip_download') THEN
    RAISE EXCEPTION 'document audit: unknown action %', p_action USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_region IS NOT NULL AND NOT public.app_region_check(p_region) THEN RAISE EXCEPTION 'document audit: region not visible' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, p_entity, p_id, p_site, p_region, NULL, p_after, NULL, public.app_actor());
END $$;

CREATE OR REPLACE FUNCTION doc_job_create(p_scope jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE jid uuid;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.document_export_jobs (requested_by, scope) VALUES (public.app_actor(), p_scope) RETURNING id INTO jid;
  RETURN jid;
END $$;

-- The worker runs with the requester's own context (app.user_id), so only the requester's job can be moved.
CREATE OR REPLACE FUNCTION doc_job_update(p_job uuid, p_status text, p_progress numeric, p_files integer, p_size bigint, p_key text, p_error text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_status NOT IN ('queued', 'running', 'done', 'failed') THEN RAISE EXCEPTION 'unknown job status' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.document_export_jobs SET status = p_status, progress = coalesce(p_progress, progress), file_count = coalesce(p_files, file_count),
    size_bytes = coalesce(p_size, size_bytes), storage_key = coalesce(p_key, storage_key), error = p_error,
    finished_at = CASE WHEN p_status IN ('done', 'failed') THEN now() ELSE finished_at END,
    expires_at = CASE WHEN p_status = 'done' THEN now() + interval '7 days' ELSE expires_at END
  WHERE id = p_job AND requested_by = public.app_actor();
  IF NOT FOUND THEN RAISE EXCEPTION 'job not found' USING ERRCODE = 'insufficient_privilege'; END IF;
END $$;

-- A job left queued or running by a stopped API process is failed at start-up (it only touches jobs older than 2 minutes, so it is safe to call from the application role).
CREATE OR REPLACE FUNCTION doc_job_fail_stale() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int;
BEGIN
  UPDATE public.document_export_jobs SET status = 'failed', error = 'interrupted', finished_at = now() WHERE status IN ('queued', 'running') AND created_at < now() - interval '2 minutes';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Draft handling of the blank form: the file row is immutable; the draft names it, and a publish makes it live.
CREATE OR REPLACE FUNCTION doc_blank_form_attach(p_doc_type uuid, p_version integer, p_meta jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.document_types%ROWTYPE; bid uuid; draft jsonb; before_ jsonb; ver int;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO d FROM public.document_types WHERE id = p_doc_type FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The document does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  INSERT INTO public.document_blank_forms (doc_type_id, original_name, storage_key, mime_type, ext, size_bytes, sha256, uploaded_by)
  VALUES (p_doc_type, left(p_meta ->> 'original_name', 255), p_meta ->> 'storage_key', p_meta ->> 'mime_type', p_meta ->> 'ext', (p_meta ->> 'size_bytes')::bigint, p_meta ->> 'sha256', public.app_actor())
  RETURNING id INTO bid;
  SELECT spec INTO draft FROM public.document_type_drafts WHERE doc_type_id = p_doc_type;
  before_ := coalesce(draft, public.doc_live_spec(p_doc_type));
  draft := before_ || jsonb_build_object('blank_form_file_id', bid);
  INSERT INTO public.document_type_drafts (doc_type_id, spec, updated_by) VALUES (p_doc_type, draft, public.app_actor())
  ON CONFLICT (doc_type_id) DO UPDATE SET spec = EXCLUDED.spec, updated_at = now(), updated_by = EXCLUDED.updated_by;
  UPDATE public.document_types SET version = version + 1, updated_at = now() WHERE id = p_doc_type RETURNING version INTO ver;
  PERFORM public.calc_audit('document_type_blank_form', 'document_type', p_doc_type::text, jsonb_build_object('blank_form_file_id', before_ -> 'blank_form_file_id'),
    jsonb_build_object('blank_form_file_id', bid, 'original_name', p_meta ->> 'original_name', 'sha256', p_meta ->> 'sha256'), p_reason);
  RETURN jsonb_build_object('id', p_doc_type, 'version', ver, 'blank_form_file_id', bid);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. The Document Library (admin): save a draft, publish
-- ---------------------------------------------------------------------------------------------------------------------
-- p_patch: any of the DocumentTypeFields; on create also code. Saves to the draft; nothing reaches tasks until admin_publish_document_type.
-- A document type that was never managed here (lib_managed = false: inserted directly) is adopted: its live definition becomes version 1.
CREATE OR REPLACE FUNCTION admin_save_document_type(p_id uuid, p_patch jsonb, p_reason text, p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.document_types%ROWTYPE; base jsonb; draft_ jsonb; merged jsonb; did uuid; ver int; k text; act text;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_id IS NULL THEN
    IF coalesce(p_patch ->> 'code', '') !~ '^[A-Z][A-Z0-9_]{0,30}$' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/code', 'code', 'invalid', 'message', 'The code is capital letters, digits and underscores, starting with a letter.'))));
    END IF;
    IF EXISTS (SELECT 1 FROM public.document_types x WHERE x.code = p_patch ->> 'code') THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('detail', 'A document with this code exists already.', 'errors', jsonb_build_array(jsonb_build_object('path', '/code', 'code', 'duplicate', 'message', 'This code is in use.'))));
    END IF;
    merged := jsonb_build_object('kind', 'scanned_document', 'form_kind', NULL, 'name_ar', NULL, 'mandatory', true, 'condition_rule', NULL,
      'formats', jsonb_build_array('pdf', 'jpg', 'jpeg', 'png'), 'max_size_mb', 20, 'min_files', 1, 'max_files', NULL, 'photo_rules', NULL, 'expiry_tracked', false,
      'blank_form_file_id', NULL, 'is_active', true) || (p_patch - 'code');
    PERFORM public.doc_validate_spec(merged);
    INSERT INTO public.document_types (code, name_en, kind, is_active, lib_managed, published_version, updated_at)
    VALUES (p_patch ->> 'code', merged ->> 'name_en', 'scanned_document', false, true, 0, now()) RETURNING id, version INTO did, ver;
    INSERT INTO public.document_type_drafts (doc_type_id, spec, updated_by) VALUES (did, merged, public.app_actor());
    PERFORM public.calc_audit('document_type_create', 'document_type', did::text, NULL, merged || jsonb_build_object('code', p_patch ->> 'code'), p_reason);
    RETURN jsonb_build_object('id', did, 'version', ver);
  END IF;
  SELECT * INTO d FROM public.document_types WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The document does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_patch ? 'code' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/code', 'code', 'immutable', 'message', 'The code never changes.'))));
  END IF;
  IF NOT d.lib_managed THEN
    UPDATE public.document_types SET lib_managed = true WHERE id = p_id;
    PERFORM public.doc_snapshot_version(p_id, 'new_only', current_date, 'adopted by the Document Library', 0);
  END IF;
  SELECT spec INTO draft_ FROM public.document_type_drafts WHERE doc_type_id = p_id;
  base := coalesce(draft_, public.doc_live_spec(p_id));
  merged := base || p_patch;
  PERFORM public.doc_validate_spec(merged);
  INSERT INTO public.document_type_drafts (doc_type_id, spec, updated_by) VALUES (p_id, merged, public.app_actor())
  ON CONFLICT (doc_type_id) DO UPDATE SET spec = EXCLUDED.spec, updated_at = now(), updated_by = EXCLUDED.updated_by;
  UPDATE public.document_types SET version = version + 1, updated_at = now() WHERE id = p_id RETURNING version INTO ver;
  act := CASE WHEN (base ->> 'is_active')::boolean AND NOT (merged ->> 'is_active')::boolean THEN 'document_type_deactivate' ELSE 'document_type_update' END;
  PERFORM public.calc_audit(act, 'document_type', p_id::text, base || jsonb_build_object('code', d.code), merged || jsonb_build_object('code', d.code), p_reason);
  RETURN jsonb_build_object('id', p_id, 'version', ver);
END $$;

-- Publish the draft. apply_to: new_only (tasks that open from now on) or open_too (also pending and ongoing tasks). Tasks in review or approval, and approved
-- tasks, are never touched. Returns {published_version, affected_open_tasks}.
CREATE OR REPLACE FUNCTION admin_publish_document_type(p_id uuid, p_version integer, p_apply_to text, p_from date, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d public.document_types%ROWTYPE; draft_ jsonb; old_spec jsonb; new_spec jsonb; codes text[]; t record; vid uuid; affected int := 0; changed boolean; n int;
  s record; still_placed boolean; pv int; nfiles int; ver int;
BEGIN
  PERFORM public.calc_require_admin('document_types', true);
  PERFORM public.calc_require_reason(p_reason);
  IF p_apply_to NOT IN ('new_only', 'open_too') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/apply_to', 'code', 'invalid', 'message', 'apply_to is new_only or open_too.'))));
  END IF;
  SELECT * INTO d FROM public.document_types WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The document does not exist.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN PERFORM public.wf_err('precondition_failed'); END IF;
  SELECT spec INTO draft_ FROM public.document_type_drafts WHERE doc_type_id = p_id;
  IF draft_ IS NULL THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'There is nothing to publish.', 'errors', jsonb_build_array(jsonb_build_object('path', '/', 'code', 'nothing_to_publish', 'message', 'The document has no unpublished changes.'))));
  END IF;
  PERFORM public.doc_validate_spec(draft_);
  old_spec := public.doc_live_spec(p_id);
  IF d.published_version = 0 AND d.lib_managed THEN old_spec := NULL; END IF;
  -- The task codes the old and the new definition reach.
  codes := ARRAY(SELECT DISTINCT x FROM (
      SELECT p ->> 'ref' AS x FROM jsonb_array_elements(coalesce(old_spec -> 'placements', '[]'::jsonb)) p WHERE p ->> 'target' = 'task'
      UNION SELECT p ->> 'ref' FROM jsonb_array_elements(draft_ -> 'placements') p WHERE p ->> 'target' = 'task') y);
  -- Freeze the pending and ongoing tasks that have no slot set yet under the OLD definition, so "new tasks only" stays true.
  FOR t IN SELECT ti.id FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
           WHERE td.code = ANY (codes) AND ti.state IN ('open', 'entry') AND NOT EXISTS (SELECT 1 FROM public.document_task_snapshots sn WHERE sn.task_id = ti.id) LOOP
    PERFORM public.doc_sync_task_slots_core(t.id);
  END LOOP;
  PERFORM public.doc_apply_spec(p_id, draft_);
  UPDATE public.document_types SET lib_managed = true, needs_review = false WHERE id = p_id;
  DELETE FROM public.document_type_drafts WHERE doc_type_id = p_id;
  vid := public.doc_snapshot_version(p_id, p_apply_to, p_from, p_reason, 0);
  IF p_apply_to = 'open_too' THEN
    new_spec := public.doc_live_spec(p_id);
    FOR t IN SELECT ti.id, td.code FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
             WHERE td.code = ANY (codes) AND ti.state IN ('open', 'entry') LOOP
      changed := false;
      still_placed := (new_spec ->> 'is_active')::boolean AND EXISTS (SELECT 1 FROM jsonb_array_elements(new_spec -> 'placements') p WHERE p ->> 'target' = 'task' AND p ->> 'ref' = t.code);
      -- slots of this document on the task
      FOR s IN SELECT * FROM public.document_slots WHERE task_id = t.id AND doc_type_id = p_id LOOP
        IF NOT still_placed THEN
          IF s.status::text IN ('missing', 'rejected', 'uploaded') THEN
            UPDATE public.document_slots SET status = 'not_required'::public."DocStatus", doc_type_version_id = vid, updated_at = now() WHERE id = s.id;
            changed := true;
          END IF;
        ELSIF s.status::text NOT IN ('approved', 'in_review') THEN
          SELECT count(*) INTO nfiles FROM public.document_files f WHERE f.slot_id = s.id AND f.is_current;
          UPDATE public.document_slots SET doc_type_version_id = vid,
            status = (CASE WHEN s.status::text = 'not_required' THEN (CASE WHEN nfiles > 0 THEN 'uploaded' ELSE 'missing' END) ELSE s.status::text END)::public."DocStatus",
            updated_at = now() WHERE id = s.id;
          changed := true;
        END IF;
      END LOOP;
      IF still_placed AND (new_spec -> 'condition_rule') IS NOT DISTINCT FROM 'null'::jsonb AND NOT EXISTS (SELECT 1 FROM public.document_slots WHERE task_id = t.id AND doc_type_id = p_id) THEN
        INSERT INTO public.document_slots (task_id, site_id, region_id, doc_type_id, status, doc_type_version_id)
        SELECT t.id, ti.site_id, ti.region_id, p_id, 'missing', vid FROM public.task_instances ti WHERE ti.id = t.id;
        changed := true;
      END IF;
      IF changed THEN affected := affected + 1; END IF;
    END LOOP;
    UPDATE public.document_type_versions SET affected_open_tasks = affected WHERE id = vid;
  END IF;
  UPDATE public.document_types SET version = version + 1, updated_at = now() WHERE id = p_id RETURNING version, published_version INTO ver, pv;
  PERFORM public.calc_audit('document_type_publish', 'document_type', p_id::text,
    CASE WHEN old_spec IS NULL THEN NULL ELSE old_spec || jsonb_build_object('code', d.code, 'published_version', d.published_version) END,
    draft_ || jsonb_build_object('code', d.code, 'published_version', pv, 'apply_to', p_apply_to, 'affected_open_tasks', affected), p_reason);
  RETURN jsonb_build_object('id', p_id, 'published_version', pv, 'affected_open_tasks', affected, 'version', ver);
END $$;

-- How many pending and ongoing tasks an "also open tasks" publish of this document would reach (the confirmation dialog).
CREATE OR REPLACE FUNCTION doc_open_task_count(p_id uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE draft_ jsonb; old_spec jsonb; codes text[];
BEGIN
  IF public.app_actor() IS NULL THEN RETURN 0; END IF;
  SELECT spec INTO draft_ FROM public.document_type_drafts WHERE doc_type_id = p_id;
  old_spec := public.doc_live_spec(p_id);
  codes := ARRAY(SELECT DISTINCT x FROM (
      SELECT p ->> 'ref' AS x FROM jsonb_array_elements(coalesce(old_spec -> 'placements', '[]'::jsonb)) p WHERE p ->> 'target' = 'task'
      UNION SELECT p ->> 'ref' FROM jsonb_array_elements(coalesce(draft_ -> 'placements', '[]'::jsonb)) p WHERE p ->> 'target' = 'task') y);
  RETURN (SELECT count(*) FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
          WHERE td.code = ANY (codes) AND ti.state IN ('open', 'entry') AND public.app_region_check(ti.region_id));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Seed (CLAUDE.md "Seed content of the library"). Idempotent: a document that exists (by code) is never overwritten.
--    Stages 1 to 3: published, version 1. Stages 4 to 10 (docs/spec/task-catalogue.csv): drafts to review, not on any task until published.
--    Arabic names are proposals for the product owner to review.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  r record; spec jsonb; did uuid; fm_doc text[] := ARRAY['pdf', 'jpg', 'jpeg', 'png']; fm_mail text[] := ARRAY['pdf', 'jpg', 'jpeg', 'png', 'eml', 'msg']; fm_photo text[] := ARRAY['jpg', 'jpeg', 'png', 'heic'];
  fm text[]; pr jsonb; pl jsonb;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- code, kind, form_kind, name_en, name_ar, tasks, mandatory, rule, published
    ('A1', 'scanned_document', NULL, 'A1 SAR (one per candidate)', 'A1 طلب قبول الموقع (SAR) لكل مرشح', ARRAY['A1'], true, NULL::jsonb, true),
    ('A2', 'scanned_document', NULL, 'A2 TSSR', 'A2 تقرير مسح موقع TSSR', ARRAY['A2'], true, NULL, true),
    ('A3', 'scanned_document', NULL, 'A3 Owner contract (or contract with the tower owner for an existing third-party tower)', 'A3 عقد المالك (أو عقد مع مالك البرج لبرج قائم تابع لطرف ثالث)', ARRAY['A3'], true, NULL, true),
    ('A3_CAA', 'scanned_document', NULL, 'A3 Civil aviation permit (when the site is near an airport)', 'A3 تصريح الطيران المدني (عند قرب الموقع من مطار)', ARRAY['A3'], true, '{"is_yes": "site.custom.near_airport"}'::jsonb, true),
    ('A4', 'scanned_document', NULL, 'A4 LLD', 'A4 التصميم التفصيلي LLD', ARRAY['A4'], true, NULL, true),
    ('B1', 'email', NULL, 'B1 PR email (outsourced work only)', 'B1 بريد طلب الشراء PR (للعمل المسند لمقاول فقط)', ARRAY['B1'], true, '{"eq": ["procurement.delivery", "outsourced"]}'::jsonb, true),
    ('B2', 'email', NULL, 'B2 PO/WO email or internal work order', 'B2 بريد أمر الشراء/العمل أو أمر عمل داخلي', ARRAY['B2'], true, NULL, true),
    ('B3', 'scanned_document', NULL, 'B3 CW access permission', 'B3 تصريح دخول الموقع للأعمال المدنية', ARRAY['B3'], true, NULL, true),
    ('B4', 'report', NULL, 'B4 STA/ST report (when tower analysis is required)', 'B4 تقرير تحليل البرج STA/ST (عند اشتراط التحليل)', ARRAY['B5'], true, '{"in": ["task.values.analysis_type", ["STA", "ST"]]}'::jsonb, true),
    ('B6', 'scanned_document', NULL, 'B6 Layout', 'B6 المخطط (Layout)', ARRAY['B6'], true, NULL, true),
    ('B7', 'email', NULL, 'B7 Layout approval email', 'B7 بريد اعتماد المخطط', ARRAY['B7'], true, NULL, true),
    ('B7_DN', 'generated_form', 'dn', 'B7 CW DN (signed scan)', 'B7 إشعار تسليم CW DN (نسخة موقعة)', ARRAY['B7'], true, NULL, true),
    ('B9', 'photo', NULL, 'B9 MOS proof', 'B9 إثبات MOS', ARRAY['B8', 'B9'], true, NULL, true),
    -- stages 4 to 10: drafts, to review by the product owner
    ('B13_PAC', 'generated_form', 'pac', 'CW PAC certificate (signed and scanned)', 'شهادة القبول الأولي CW PAC (موقعة ممسوحة)', ARRAY['B13'], true, NULL, false),
    ('B13_SNAGLIST', 'generated_form', 'snag_list', 'CW snag list', 'قائمة ملاحظات CW', ARRAY['B13'], true, NULL, false),
    ('B13_SNAGCLOSE', 'photo', NULL, 'CW snag closure evidence', 'دليل إغلاق ملاحظات CW', ARRAY['B13'], true, NULL, false),
    ('B13_ASBUILT', 'report', NULL, 'CW As-Built', 'مخططات التنفيذ CW As-Built', ARRAY['B13'], true, NULL, false),
    ('C1_REQ', 'email', NULL, 'GECOL PR / request email', 'بريد طلب/PR الشركة العامة للكهرباء', ARRAY['C1'], true, NULL, false),
    ('C2_PROOF', 'scanned_document', NULL, 'GECOL Power-On / meter charging proof', 'إثبات تشغيل الكهرباء/شحن العداد', ARRAY['C2'], true, NULL, false),
    ('C3_REQ', 'email', NULL, 'HLC request email', 'بريد طلب الألياف HLC', ARRAY['C3'], true, NULL, false),
    ('C4_TXTEST', 'report', NULL, 'TX link test report', 'تقرير اختبار وصلة TX', ARRAY['C4'], true, NULL, false),
    ('D1_ACCESS', 'scanned_document', NULL, 'TE access permission', 'تصريح دخول الموقع لأعمال TE', ARRAY['D1'], true, NULL, false),
    ('D2_SURVEY', 'report', NULL, 'TE survey report', 'تقرير مسح TE', ARRAY['D2'], true, NULL, false),
    ('D3_DN', 'scanned_document', NULL, 'TE DN (signed scan)', 'إشعار تسليم TE DN (نسخة موقعة)', ARRAY['D3'], true, NULL, false),
    ('D4_APPROVAL', 'email', NULL, 'TE DN approval email', 'بريد اعتماد إشعار تسليم TE', ARRAY['D4'], true, NULL, false),
    ('D5_MOS', 'photo', NULL, 'TE MOS proof (photos)', 'إثبات MOS لـ TE (صور)', ARRAY['D5'], true, NULL, false),
    ('D7_COMM', 'report', NULL, 'Commissioning report', 'تقرير التشغيل التجريبي', ARRAY['D7'], true, NULL, false),
    ('D8_RSL', 'report', NULL, 'MW alignment / RSL record', 'سجل محاذاة المايكروويف / RSL', ARRAY['D8'], true, NULL, false),
    ('D9_INTEG', 'scanned_document', NULL, 'Integration confirmation', 'تأكيد التكامل', ARRAY['D9'], true, NULL, false),
    ('D10A_MOP', 'scanned_document', NULL, 'MOP document', 'وثيقة MOP', ARRAY['D10a'], true, NULL, false),
    ('D10B_WINDOW', 'email', NULL, 'Cutover window approval email', 'بريد اعتماد نافذة التحويل', ARRAY['D10b'], true, NULL, false),
    ('D10_ONAIR', 'scanned_document', NULL, 'On-Air confirmation', 'تأكيد التشغيل (On-Air)', ARRAY['D10'], true, NULL, false),
    ('D11_SSV', 'report', NULL, 'SSV report', 'تقرير SSV', ARRAY['D11'], true, NULL, false),
    ('D12_HWID', 'scanned_document', NULL, 'HW installation document (HWID)', 'وثيقة تركيب العتاد HWID', ARRAY['D12'], true, NULL, false),
    ('D13_EIR', 'report', NULL, 'EIR report (site standalone test)', 'تقرير EIR (اختبار الموقع المستقل)', ARRAY['D13'], true, NULL, false),
    ('D14_PAT', 'report', NULL, 'PAT report including NOC alarm verification', 'تقرير PAT مع التحقق من إنذارات NOC', ARRAY['D14'], true, NULL, false),
    ('D15_ASBUILT', 'report', NULL, 'TE As-Built', 'مخططات التنفيذ TE As-Built', ARRAY['D15'], true, NULL, false),
    ('D16_PAC', 'scanned_document', NULL, 'TE PAC certificate (signed and scanned)', 'شهادة القبول الأولي TE PAC (موقعة ممسوحة)', ARRAY['D16'], true, NULL, false),
    ('D16_SNAGLIST', 'scanned_document', NULL, 'TE snag list', 'قائمة ملاحظات TE', ARRAY['D16'], true, NULL, false),
    ('F1_REPORT', 'report', NULL, 'Cluster optimization report', 'تقرير تحسين المجموعة', ARRAY['F1'], true, NULL, false),
    ('F2_KPI', 'report', NULL, 'KPI acceptance evidence', 'دليل قبول مؤشرات الأداء', ARRAY['F2'], true, NULL, false),
    ('D17_LAUNCH', 'scanned_document', NULL, 'Launch confirmation', 'تأكيد الإطلاق', ARRAY['D17'], true, NULL, false),
    ('D17_RECON', 'report', NULL, 'Material reconciliation report', 'تقرير مطابقة المواد', ARRAY['D17'], true, NULL, false),
    ('D17_HOTO', 'scanned_document', NULL, 'HOTO package (signed and scanned)', 'حزمة التسليم HOTO (موقعة ممسوحة)', ARRAY['D17'], true, NULL, false),
    ('D17_OMCHK', 'scanned_document', NULL, 'O&M acceptance checklist (14 items)', 'قائمة قبول التشغيل والصيانة (14 بندًا)', ARRAY['D17'], true, NULL, false),
    ('B15_FAC', 'generated_form', 'fac', 'CW FAC certificate (signed and scanned)', 'شهادة القبول النهائي CW FAC (موقعة ممسوحة)', ARRAY['B15'], true, NULL, false),
    ('B15_SNAGCLOSE', 'photo', NULL, 'CW FAC snag closure evidence', 'دليل إغلاق ملاحظات القبول النهائي CW', ARRAY['B15'], true, NULL, false),
    ('D18_FAC', 'scanned_document', NULL, 'TE FAC certificate (signed and scanned)', 'شهادة القبول النهائي TE FAC (موقعة ممسوحة)', ARRAY['D18'], true, NULL, false),
    ('Z1_CLOSURE', 'scanned_document', NULL, 'Obligations closure approval', 'اعتماد إغلاق الالتزامات', ARRAY['Z1'], true, NULL, false),
    ('E2_RECORD', 'scanned_document', NULL, 'Dismantle record', 'سجل الفك', ARRAY['E2'], true, NULL, false),
    ('E3_CWRN', 'scanned_document', NULL, 'CW RN (signed return note)', 'إشعار إرجاع CW RN (موقع)', ARRAY['E3'], true, NULL, false),
    ('E3_TERN', 'scanned_document', NULL, 'TE RN (signed return note)', 'إشعار إرجاع TE RN (موقع)', ARRAY['E3'], true, NULL, false)
  ) AS v(code, kind, form_kind, name_en, name_ar, tasks, mandatory, rule, published) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM document_types WHERE code = r.code);
    fm := CASE WHEN r.kind = 'email' THEN fm_mail WHEN r.kind = 'photo' THEN fm_photo ELSE fm_doc END;
    pr := CASE WHEN r.kind = 'photo' THEN jsonb_build_object('min_count', 1, 'formats', jsonb_build_array('JPG', 'PNG', 'HEIC'), 'max_size_mb', 20) ELSE NULL END;
    pl := (SELECT coalesce(jsonb_agg(jsonb_build_object('target', 'task', 'ref', x)), '[]'::jsonb) FROM unnest(r.tasks) x);
    spec := jsonb_build_object('kind', r.kind, 'form_kind', r.form_kind, 'name_en', r.name_en, 'name_ar', r.name_ar, 'placements', pl, 'mandatory', r.mandatory,
      'condition_rule', r.rule, 'formats', to_jsonb(fm), 'max_size_mb', 20, 'min_files', 1, 'max_files', NULL, 'photo_rules', pr, 'expiry_tracked', false,
      'blank_form_file_id', NULL, 'is_active', true);
    INSERT INTO document_types (code, name_en, kind, is_active, lib_managed, published_version, needs_review, updated_at)
    VALUES (r.code, r.name_en, 'scanned_document', false, true, 0, NOT r.published, now()) RETURNING id INTO did;
    IF r.published THEN
      PERFORM doc_apply_spec(did, spec);
      PERFORM doc_snapshot_version(did, 'new_only', DATE '2024-01-01', 'seed: CLAUDE.md "Seed content of the library"', 0);
    ELSE
      INSERT INTO document_type_drafts (doc_type_id, spec) VALUES (did, spec);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership, rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON document_types, document_slots, document_files TO pmis_definer;
GRANT SELECT, INSERT, DELETE ON document_type_placements TO pmis_definer;
GRANT SELECT, INSERT ON document_blank_forms, document_task_snapshots TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON document_type_versions TO pmis_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_type_drafts TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON document_export_jobs TO pmis_definer;
GRANT SELECT ON task_definitions, workflow_definitions, snag_types, register_definitions, task_instances TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'doc_live_spec(uuid)', 'doc_task_def_of_code(text)', 'doc_validate_spec(jsonb)', 'doc_apply_spec(uuid,jsonb)', 'doc_snapshot_version(uuid,text,date,text,integer)',
    'doc_sync_task_slots_core(uuid,uuid[],uuid[])', 'doc_sync_task_slots(uuid,uuid[],uuid[])', 'doc_task_opened()', 'wf_missing_slots(uuid)', 'doc_slot_spec(uuid)',
    'doc_attach_file(uuid,jsonb)', 'doc_withdraw_file(uuid,uuid)', 'doc_add_slot(uuid,text,text)', 'doc_audit(text,text,text,uuid,integer,jsonb)',
    'doc_job_create(jsonb)', 'doc_job_update(uuid,text,numeric,integer,bigint,text,text)', 'doc_job_fail_stale()', 'doc_blank_form_attach(uuid,integer,jsonb,text)',
    'admin_save_document_type(uuid,jsonb,text,integer)', 'admin_publish_document_type(uuid,integer,text,date,text)', 'doc_open_task_count(uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- not granted: the core sync (trigger and engine only) and the spec helpers (doc_validate_spec, doc_apply_spec, doc_snapshot_version, doc_task_def_of_code)
    FOREACH f IN ARRAY ARRAY[
      'wf_missing_slots(uuid)', 'doc_slot_spec(uuid)', 'doc_sync_task_slots(uuid,uuid[],uuid[])', 'doc_attach_file(uuid,jsonb)', 'doc_withdraw_file(uuid,uuid)',
      'doc_add_slot(uuid,text,text)', 'doc_audit(text,text,text,uuid,integer,jsonb)', 'doc_job_create(jsonb)', 'doc_job_update(uuid,text,numeric,integer,bigint,text,text)',
      'doc_blank_form_attach(uuid,integer,jsonb,text)', 'admin_save_document_type(uuid,jsonb,text,integer)', 'admin_publish_document_type(uuid,integer,text,date,text)',
      'doc_open_task_count(uuid)', 'doc_live_spec(uuid)', 'doc_job_fail_stale()'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON document_types, document_type_placements, document_slots, document_files, document_type_versions, document_type_drafts,
      document_blank_forms, document_export_jobs, document_task_snapshots FROM pmis_app;
    REVOKE ALL ON document_task_snapshots FROM pmis_app;
  END IF;
END $$;
