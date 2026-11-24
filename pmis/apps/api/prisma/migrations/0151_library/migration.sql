-- 0151_library: the Library menu, Forms and Archive (W5 of plan 2026-11-23-next-ui-cleanup, contract 0.15.69, CHANGELOG 205).
-- Mirror: db/sql/150_library.sql (kept byte-identical).
--
-- WHAT THIS ADDS.
--   1. library_form_templates (configuration, KEEP in the data reset): the approved document forms. One row per version of a form (code, version), an HTML
--      template with {{placeholders}}, the Document Library type it produces, the task that triggers it (the document is due when that task opens), the
--      numbering pattern and the field bindings. A new version is a draft; approving it retires the version in force. Written only through
--      lib_form_template_save, lib_form_template_approve and lib_form_template_retire (System Admin or an all-regions delegate of document_types edit,
--      a reason, audited with before and after). Readable by every session (the Forms page lists the approved ones).
--   2. library_generated_docs (project data, DELETE in the data reset): one row per filled document generated for a site, with its number, the template
--      version, the site, the task and the data it was filled with. The number comes from the existing numbering service (doc_sequences, doc_next_number,
--      migration 0053), so a number is never issued twice, also after a void. Written only through lib_generate, lib_generated_attach and
--      lib_generated_void; the rendered file is read only through lib_generated_read, which writes the audit row of every download, print and preview.
--      Region row security; pmis_app reads the list columns only (never the file).
--   3. doc_sequences.form_code: a sequence may now belong to a form template (one per form code), beside the warehouse kinds and the CW form kinds.
--   4. The setting library.archive (guarded key): which Archive cards are hidden, their order, the default columns of the Archive list and the bulk zip
--      limit. Read by every signed-in user; written only through admin_set_library_archive (System Admin or an all-regions delegate of admin.settings,
--      a reason, If-Match, closed body with field errors, audited with before and after).
--   5. sv_screen_module (latest definition 0138): the saved views of the screen library-archive belong to the module sites.documents.
--   6. nav_item_catalogue: the menu keys library.forms and library.archive (default heading library).
--
-- WHO GENERATES (owner decision W5-1): the L1 holder of the task the document belongs to (wf_is_eligible entry), or anyone who holds "Documents: generate"
-- (the grant library.forms create of the permission grid) for the site's region; a System Admin always may. The task must be open (open, entry or
-- returned). The L2 holder approves the signed upload as today: the signed scan goes into the task's own document slot (doc_attach_file) and is approved
-- with the task.
--
-- Function rules: SECURITY DEFINER, search_path = pg_catalog, public, pg_temp, owner pmis_definer, EXECUTE revoked from PUBLIC; pmis_app executes the doors
-- and the readers only. The new tables are narrowed in db/sql/app_grants.sql.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE doc_sequences ADD COLUMN IF NOT EXISTS form_code text CHECK (form_code IS NULL OR form_code ~ '^[A-Z0-9][A-Z0-9-]{1,40}$');
ALTER TABLE doc_sequences DROP CONSTRAINT IF EXISTS doc_sequences_target;
ALTER TABLE doc_sequences ADD CONSTRAINT doc_sequences_target CHECK (form_kind IS NOT NULL OR record_type IS NOT NULL OR form_code IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS doc_sequences_one_form_code ON doc_sequences (form_code) WHERE form_code IS NOT NULL;

CREATE TABLE library_form_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,40}$'),
  version           integer NOT NULL CHECK (version >= 1),
  name_en           text NOT NULL CHECK (char_length(btrim(name_en)) BETWEEN 1 AND 200),
  name_ar           text CHECK (name_ar IS NULL OR char_length(name_ar) <= 200),
  doc_type_id       uuid NOT NULL REFERENCES document_types (id) ON DELETE RESTRICT,
  trigger_task_code text NOT NULL CHECK (trigger_task_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
  numbering_pattern text NOT NULL CHECK (char_length(numbering_pattern) BETWEEN 6 AND 80),
  numbering_reset   text NOT NULL DEFAULT 'yearly' CHECK (numbering_reset IN ('never', 'yearly')),
  html              text NOT NULL CHECK (octet_length(html) BETWEEN 1 AND 3000000),
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bindings          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(bindings) = 'object'),
  placeholders      text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  reason            text,
  created_by        uuid NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  approved_by       uuid REFERENCES users (id),
  approved_at       timestamptz,
  approve_reason    text,
  retired_by        uuid REFERENCES users (id),
  retired_at        timestamptz,
  retire_reason     text,
  UNIQUE (code, version)
);
COMMENT ON TABLE library_form_templates IS '0151 (W5): the document forms of Library > Forms, one row per version (HTML with placeholders, the Document Library type it produces, the triggering task, the numbering). Configuration: written only by lib_form_template_save / _approve / _retire.';
CREATE UNIQUE INDEX library_form_templates_one_approved ON library_form_templates (code) WHERE status = 'approved';
CREATE INDEX library_form_templates_doc_idx ON library_form_templates (doc_type_id);

CREATE TABLE library_generated_docs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES library_form_templates (id) ON DELETE RESTRICT,
  number       text NOT NULL UNIQUE,
  site_id      uuid NOT NULL,
  region_id    integer NOT NULL,
  task_id      uuid NOT NULL REFERENCES task_instances (id) ON DELETE RESTRICT,
  doc_type_id  uuid NOT NULL REFERENCES document_types (id) ON DELETE RESTRICT,
  status       text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'voided')),
  remarks      text CHECK (remarks IS NULL OR char_length(remarks) <= 1000),
  data         jsonb NOT NULL,
  html         text CHECK (html IS NULL OR octet_length(html) <= 8000000),
  sha256       text,
  created_txid bigint NOT NULL DEFAULT txid_current(),
  generated_by uuid NOT NULL REFERENCES users (id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  void_reason  text,
  voided_by    uuid REFERENCES users (id),
  voided_at    timestamptz,
  FOREIGN KEY (site_id, region_id) REFERENCES sites (id, region_id) ON UPDATE CASCADE ON DELETE RESTRICT
);
COMMENT ON TABLE library_generated_docs IS '0151 (W5): the filled documents generated for a site (Archive status "generated"). Project data: written only by lib_generate, lib_generated_attach and lib_generated_void; the file is read only through lib_generated_read (audited).';
CREATE INDEX library_generated_docs_task_idx ON library_generated_docs (task_id, doc_type_id, generated_at DESC);
CREATE INDEX library_generated_docs_site_idx ON library_generated_docs (site_id);
CREATE INDEX library_generated_docs_region_idx ON library_generated_docs (region_id);

ALTER TABLE library_form_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_form_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON library_form_templates FOR SELECT USING (app_has_session() OR app_is_seeding());
ALTER TABLE library_generated_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_generated_docs FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON library_generated_docs FOR SELECT USING (app_region_read(false, region_id));

GRANT SELECT, INSERT, UPDATE ON library_form_templates, library_generated_docs TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON doc_sequences, doc_sequence_counters, doc_number_issues TO pmis_definer;
GRANT SELECT ON document_types, document_slots, task_instances, task_definitions, sites, regions, clusters, users, settings TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON library_form_templates, library_generated_docs FROM pmis_app;
    GRANT SELECT ON library_form_templates TO pmis_app;
    GRANT SELECT (id, template_id, number, site_id, region_id, task_id, doc_type_id, status, remarks, generated_by, generated_at, void_reason, voided_by, voided_at)
      ON library_generated_docs TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Helpers (internal: no grant to pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lib_err(p_status_code text, p_detail text, p_errors jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_errors IS NOT NULL THEN PERFORM public.wf_err(p_status_code, jsonb_build_object('detail', p_detail, 'errors', p_errors)); END IF;
  PERFORM public.wf_err(p_status_code, jsonb_build_object('detail', p_detail));
END $$;

-- The configuration right of the forms: the Document Library right (documents.edit delegates it), for all regions.
CREATE OR REPLACE FUNCTION lib_require_config() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_admin('document_types', true);
END $$;

CREATE OR REPLACE FUNCTION lib_form_template_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', t.id, 'code', t.code, 'version', t.version, 'name_en', t.name_en, 'name_ar', t.name_ar,
    'doc_type_id', t.doc_type_id, 'doc_code', dt.code, 'doc_name_en', dt.name_en, 'doc_name_ar', dt.name_ar,
    'trigger_task_code', t.trigger_task_code,
    'trigger_task_name_en', (SELECT td.name_en FROM public.task_definitions td WHERE td.code = t.trigger_task_code ORDER BY td.is_active DESC, td.id LIMIT 1),
    'trigger_task_name_ar', (SELECT td.name_ar FROM public.task_definitions td WHERE td.code = t.trigger_task_code ORDER BY td.is_active DESC, td.id LIMIT 1),
    'numbering_pattern', t.numbering_pattern, 'numbering_reset', t.numbering_reset, 'bindings', t.bindings, 'placeholders', to_jsonb(t.placeholders),
    'status', t.status, 'sha256', t.sha256, 'size_bytes', octet_length(t.html), 'reason', t.reason,
    'created_by', public.wfe_user_ref(t.created_by), 'created_at', t.created_at,
    'approved_by', public.wfe_user_ref(t.approved_by), 'approved_at', t.approved_at,
    'retired_at', t.retired_at,
    'updated_at', greatest(t.created_at, coalesce(t.approved_at, t.created_at), coalesce(t.retired_at, t.created_at)))
  FROM public.library_form_templates t JOIN public.document_types dt ON dt.id = t.doc_type_id WHERE t.id = p_id
$$;

CREATE OR REPLACE FUNCTION lib_generated_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', g.id, 'number', g.number, 'status', g.status, 'template_id', g.template_id, 'template_code', t.code, 'template_version', t.version,
    'site_id', g.site_id, 'site_code', s.site_code, 'region_id', g.region_id, 'task_id', g.task_id, 'task_code', td.code,
    'doc_code', dt.code, 'remarks', g.remarks, 'sha256', g.sha256, 'size_bytes', coalesce(octet_length(g.html), 0),
    'generated_by', public.wfe_user_ref(g.generated_by), 'generated_at', g.generated_at,
    'void_reason', g.void_reason, 'voided_by', public.wfe_user_ref(g.voided_by), 'voided_at', g.voided_at)
  FROM public.library_generated_docs g
  JOIN public.library_form_templates t ON t.id = g.template_id
  JOIN public.sites s ON s.id = g.site_id
  JOIN public.task_instances ti ON ti.id = g.task_id JOIN public.task_definitions td ON td.id = ti.task_def_id
  JOIN public.document_types dt ON dt.id = g.doc_type_id
  WHERE g.id = p_id
$$;

-- The site's task of a form (the task the document belongs to): the task of the trigger code on the site, or NULL.
CREATE OR REPLACE FUNCTION lib_site_task(p_site uuid, p_code text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ti.id FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
  WHERE ti.site_id = p_site AND td.code = p_code
  ORDER BY (ti.state::text IN ('open', 'entry', 'rejected')) DESC, ti.id LIMIT 1
$$;

-- May the signed-in actor generate the document of this task? The L1 holder of the task, or "Documents: generate" (library.forms create) for its region.
CREATE OR REPLACE FUNCTION lib_can_generate(p_task uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.app_actor(); r integer; regs int[];
BEGIN
  IF a IS NULL OR p_task IS NULL THEN RETURN false; END IF;
  SELECT ti.region_id INTO r FROM public.task_instances ti WHERE ti.id = p_task;
  IF r IS NULL OR NOT public.app_region_check(r) THEN RETURN false; END IF;
  regs := public.wf_actor_regions('library.forms', 'create'::"PermissionAction");
  IF regs IS NULL OR r = ANY (regs) THEN RETURN true; END IF;
  RETURN public.wf_is_eligible(p_task, 'entry', a);
END $$;

-- The data a form is filled with (the contract of the placeholders, see design/forms/bindings.md for the CW forms): site, region, task, document,
-- template and the person who generates. Dates are YYYY-MM-DD strings; region_is has one key set to true.
CREATE OR REPLACE FUNCTION lib_form_context(p_template uuid, p_site uuid, p_task uuid, p_number text, p_remarks text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.library_form_templates%ROWTYPE; s public.sites%ROWTYPE; rg public.regions%ROWTYPE; cl text; tk jsonb := '{}'::jsonb; me jsonb;
BEGIN
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_template;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  SELECT * INTO rg FROM public.regions WHERE id = s.region_id;
  SELECT c.cluster_code INTO cl FROM public.clusters c WHERE c.id = s.cluster_id;
  IF p_task IS NOT NULL THEN
    SELECT jsonb_build_object('code', td.code, 'name', td.name_en, 'name_ar', td.name_ar, 'state', ti.state::text,
             'planned_date', to_char(ti.planned_date, 'YYYY-MM-DD'), 'actual_date', to_char(ti.actual_date, 'YYYY-MM-DD'), 'due_date', to_char(ti.due_date, 'YYYY-MM-DD'))
      INTO tk FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id WHERE ti.id = p_task;
  END IF;
  SELECT jsonb_build_object('name', u.display_name, 'employee_id', nullif(btrim(u.employee_id), '')) INTO me FROM public.users u WHERE u.id = public.app_actor();
  RETURN jsonb_build_object(
    'site', jsonb_build_object('id', s.site_code, 'code', s.site_code, 'name', s.name, 'name_ar', s.name_ar, 'owner_site_id', s.owner_site_id,
              'region_code', rg.code, 'region_name', rg.name_en, 'region_name_ar', rg.name_ar, 'region_is', jsonb_build_object(rg.code, true),
              'cluster', cl, 'latitude', s.latitude::text, 'longitude', s.longitude::text, 'address', s.address, 'site_type', s.site_type,
              'tower_owner', s.tower_owner, 'tower_type', s.tower_type, 'tower_height_m', s.tower_height_m::text,
              'delivery_scenario', s.delivery_scenario::text, 'sub_region', s.sub_region),
    'region', jsonb_build_object('code', rg.code, 'name', rg.name_en, 'name_ar', rg.name_ar),
    'task', coalesce(tk, '{}'::jsonb),
    'doc', jsonb_build_object('ref_no', p_number, 'date', to_char(public.doc_today(), 'YYYY-MM-DD'), 'remarks', coalesce(p_remarks, '')),
    'template', jsonb_build_object('code', t.code, 'version', t.version, 'name', t.name_en, 'name_ar', t.name_ar),
    'generated_by', coalesce(me, '{}'::jsonb));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Form templates (Settings > Documents > Form templates)
-- ---------------------------------------------------------------------------------------------------------------------
-- p_body = {code, name_en, name_ar?, doc_code, trigger_task_code, numbering_pattern, numbering_reset?, html, bindings?} (closed). A new draft version.
CREATE OR REPLACE FUNCTION lib_form_template_save(p_body jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE errs jsonb := '[]'::jsonb; k text; v jsonb; v_code text; dtid uuid; v_html text; v_reset text; pat text; nv integer; nid uuid; ph text[]; res jsonb;
BEGIN
  PERFORM public.lib_require_config();
  PERFORM public.calc_require_reason(p_reason);
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN PERFORM public.lib_err('validation_failed', 'An object.', public.reg_err_item('/', 'invalid', 'An object.')); END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('code', 'name_en', 'name_ar', 'doc_code', 'trigger_task_code', 'numbering_pattern', 'numbering_reset', 'html', 'bindings') THEN
      errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.');
    END IF;
  END LOOP;
  v_code := upper(btrim(coalesce(p_body ->> 'code', '')));
  IF v_code !~ '^[A-Z0-9][A-Z0-9-]{1,40}$' THEN errs := errs || public.reg_err_item('/code', 'invalid', 'Letters A-Z, digits and hyphens, 2 to 41 characters.'); END IF;
  IF char_length(btrim(coalesce(p_body ->> 'name_en', ''))) NOT BETWEEN 1 AND 200 THEN errs := errs || public.reg_err_item('/name_en', 'required', 'The English name (1 to 200 characters).'); END IF;
  IF p_body ? 'name_ar' AND jsonb_typeof(p_body -> 'name_ar') NOT IN ('string', 'null') THEN errs := errs || public.reg_err_item('/name_ar', 'invalid', 'Text or null.'); END IF;
  IF char_length(coalesce(p_body ->> 'name_ar', '')) > 200 THEN errs := errs || public.reg_err_item('/name_ar', 'invalid', 'At most 200 characters.'); END IF;
  SELECT dt.id INTO dtid FROM public.document_types dt WHERE dt.code = p_body ->> 'doc_code' AND dt.is_active;
  IF dtid IS NULL THEN errs := errs || public.reg_err_item('/doc_code', 'unknown_document', 'An active document type of the Document Library.'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.code = p_body ->> 'trigger_task_code' AND td.is_active) THEN
    errs := errs || public.reg_err_item('/trigger_task_code', 'unknown_task', 'An active task code of the workflow.');
  END IF;
  v_reset := coalesce(p_body ->> 'numbering_reset', 'yearly');
  IF v_reset NOT IN ('never', 'yearly') THEN errs := errs || public.reg_err_item('/numbering_reset', 'invalid', 'never or yearly.'); v_reset := 'yearly'; END IF;
  pat := btrim(coalesce(p_body ->> 'numbering_pattern', ''));
  FOR v IN SELECT jsonb_array_elements(public.doc_pattern_errors(pat, v_reset, NULL)) LOOP
    errs := errs || jsonb_build_array(jsonb_set(v, '{path}', to_jsonb('/numbering_pattern'::text)));
  END LOOP;
  v_html := p_body ->> 'html';
  IF v_html IS NULL OR octet_length(v_html) NOT BETWEEN 20 AND 3000000 THEN
    errs := errs || public.reg_err_item('/html', 'invalid', 'The HTML template (20 bytes to 3 MB).');
  ELSIF v_html ~* '<\s*(script|iframe|object|embed|frame|frameset|base|meta[^>]*http-equiv)\y' OR v_html ~* '\son[a-z]+\s*=' OR v_html ~* 'javascript:' THEN
    errs := errs || public.reg_err_item('/html', 'unsafe_html', 'Scripts, frames, event handlers and javascript: links are not allowed in a form.');
  END IF;
  IF p_body ? 'bindings' THEN
    IF jsonb_typeof(p_body -> 'bindings') <> 'object' THEN
      errs := errs || public.reg_err_item('/bindings', 'invalid', 'An object of name to data path.');
    ELSE
      IF (SELECT count(*) FROM jsonb_object_keys(p_body -> 'bindings')) > 100 THEN errs := errs || public.reg_err_item('/bindings', 'invalid', 'At most 100 bindings.'); END IF;
      FOR k, v IN SELECT * FROM jsonb_each(p_body -> 'bindings') LOOP
        IF k !~ '^[a-z][a-z0-9_]{0,40}$' THEN errs := errs || public.reg_err_item('/bindings/' || k, 'invalid', 'A lower-case name.');
        ELSIF jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^(site|region|task|doc|template|generated_by)(\.[a-z_][a-z0-9_]{0,40}){1,3}$' THEN
          errs := errs || public.reg_err_item('/bindings/' || k, 'invalid_path', 'A data path such as site.tower_owner (site, region, task, doc, template or generated_by).');
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.lib_err('validation_failed', 'The form template is not valid.', errs); END IF;

  PERFORM pg_advisory_xact_lock(hashtext('lib_form_template:' || v_code));
  SELECT coalesce(max(version), 0) + 1 INTO nv FROM public.library_form_templates WHERE library_form_templates.code = v_code;
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), '{}') INTO ph FROM regexp_matches(v_html, '\{\{\{?\s*[#/]?(?:each |if )?\s*([A-Za-z_][A-Za-z0-9_.]{0,80})', 'g') m;
  INSERT INTO public.library_form_templates (code, version, name_en, name_ar, doc_type_id, trigger_task_code, numbering_pattern, numbering_reset, html, sha256,
                                             bindings, placeholders, status, reason, created_by)
  VALUES (v_code, nv, btrim(p_body ->> 'name_en'), nullif(btrim(coalesce(p_body ->> 'name_ar', '')), ''), dtid, p_body ->> 'trigger_task_code', pat, v_reset, v_html,
          encode(sha256(convert_to(v_html, 'UTF8')), 'hex'), coalesce(p_body -> 'bindings', '{}'::jsonb), ph, 'draft', btrim(p_reason), public.app_actor())
  RETURNING id INTO nid;
  res := public.lib_form_template_json(nid);
  PERFORM public.log_audit_write('library_form_template_save', 'library_form_template', nid::text, NULL, res - 'reason', btrim(p_reason));
  RETURN res;
END $$;

-- Approve a draft version: it becomes the version in force (the previous approved version of the code is retired) and its numbering pattern is the
-- pattern of the form's sequence (doc_sequences.form_code; the counter keeps running, so numbers are never reused).
CREATE OR REPLACE FUNCTION lib_form_template_approve(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.library_form_templates%ROWTYPE; prev uuid; before jsonb; res jsonb; sk text;
BEGIN
  PERFORM public.lib_require_config();
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.lib_err('not_found', 'The form template does not exist.'); END IF;
  IF t.status <> 'draft' THEN PERFORM public.lib_err('invalid_transition', format('Only a draft is approved (this version is %s).', t.status)); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('lib_form_template:' || t.code));
  SELECT id INTO prev FROM public.library_form_templates WHERE code = t.code AND status = 'approved' FOR UPDATE;
  before := CASE WHEN prev IS NULL THEN NULL ELSE public.lib_form_template_json(prev) END;
  IF prev IS NOT NULL THEN
    UPDATE public.library_form_templates SET status = 'retired', retired_by = public.app_actor(), retired_at = clock_timestamp(), retire_reason = 'replaced by version ' || t.version
    WHERE id = prev;
  END IF;
  UPDATE public.library_form_templates SET status = 'approved', approved_by = public.app_actor(), approved_at = clock_timestamp(), approve_reason = btrim(p_reason) WHERE id = p_id;
  SELECT key INTO sk FROM public.doc_sequences WHERE form_code = t.code;
  IF sk IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.doc_sequences WHERE key = t.code) THEN
      PERFORM public.lib_err('duplicate', format('A numbering sequence named %s exists already for another document: choose another form code.', t.code));
    END IF;
    INSERT INTO public.doc_sequences (key, form_code, pattern, reset, is_active, updated_by) VALUES (t.code, t.code, t.numbering_pattern, t.numbering_reset, true, public.app_actor());
  ELSE
    UPDATE public.doc_sequences SET pattern = t.numbering_pattern, reset = t.numbering_reset, is_active = true, version = version + 1, updated_at = now(), updated_by = public.app_actor()
    WHERE key = sk;
  END IF;
  res := public.lib_form_template_json(p_id);
  PERFORM public.log_audit_write('library_form_template_approve', 'library_form_template', p_id::text, before - 'reason', res - 'reason', btrim(p_reason));
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION lib_form_template_retire(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.library_form_templates%ROWTYPE; before jsonb; res jsonb;
BEGIN
  PERFORM public.lib_require_config();
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.lib_err('not_found', 'The form template does not exist.'); END IF;
  IF t.status = 'retired' THEN PERFORM public.lib_err('invalid_transition', 'This version is retired already.'); END IF;
  before := public.lib_form_template_json(p_id);
  UPDATE public.library_form_templates SET status = 'retired', retired_by = public.app_actor(), retired_at = clock_timestamp(), retire_reason = btrim(p_reason) WHERE id = p_id;
  res := public.lib_form_template_json(p_id);
  PERFORM public.log_audit_write('library_form_template_retire', 'library_form_template', p_id::text, before - 'reason', res - 'reason', btrim(p_reason));
  RETURN res;
END $$;

-- The HTML of a template version, for the form editor (configuration right only).
CREATE OR REPLACE FUNCTION lib_form_template_html(p_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE h text;
BEGIN
  PERFORM public.lib_require_config();
  SELECT html INTO h FROM public.library_form_templates WHERE id = p_id;
  IF h IS NULL THEN PERFORM public.lib_err('not_found', 'The form template does not exist.'); END IF;
  RETURN h;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Generate, preview, read, void (Library > Forms)
-- ---------------------------------------------------------------------------------------------------------------------
-- The checks shared by the preview and the generation: the form (approved; a draft only for the configuration right), the site (visible), the task
-- (open) and the right to generate. Returns {template, site, region_id, task}.
CREATE OR REPLACE FUNCTION lib_check_generate(p_template uuid, p_site uuid, p_preview boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.library_form_templates%ROWTYPE; s public.sites%ROWTYPE; tid uuid; st text; cfg boolean;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  cfg := public.app_actor_is_admin('document_types', 'edit'::"PermissionAction") AND public.app_actor_region_filter('document_types', 'edit'::"PermissionAction") IS NULL;
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_template;
  IF NOT FOUND OR (t.status <> 'approved' AND NOT (p_preview AND cfg AND t.status = 'draft')) THEN
    PERFORM public.lib_err('not_found', 'The form does not exist or is not approved.');
  END IF;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND OR NOT public.app_region_check(s.region_id) THEN PERFORM public.lib_err('not_found', 'The site does not exist or is not visible to you.'); END IF;
  tid := public.lib_site_task(s.id, t.trigger_task_code);
  IF tid IS NULL THEN
    IF p_preview AND cfg THEN RETURN jsonb_build_object('template', t.id, 'site', s.id, 'region_id', s.region_id, 'task', NULL); END IF;
    PERFORM public.lib_err('invalid_transition', format('The site has no task %s: this document does not apply to it.', t.trigger_task_code));
  END IF;
  SELECT ti.state::text INTO st FROM public.task_instances ti WHERE ti.id = tid;
  IF NOT public.lib_can_generate(tid) AND NOT (p_preview AND cfg) THEN
    PERFORM public.lib_err('not_eligible_holder', format('Only the L1 holder of task %s, or a holder of "Documents: generate" for the region, generates this document.', t.trigger_task_code));
  END IF;
  IF st NOT IN ('open', 'entry', 'rejected') AND NOT (p_preview AND cfg) THEN
    PERFORM public.lib_err('invalid_transition', format('The document is due when task %s opens; the task is %s.', t.trigger_task_code, st));
  END IF;
  RETURN jsonb_build_object('template', t.id, 'site', s.id, 'region_id', s.region_id, 'task', tid);
END $$;

-- The preview: the data and the template, no number taken (doc.ref_no is a placeholder). Nothing is written but the audit row.
CREATE OR REPLACE FUNCTION lib_preview(p_template uuid, p_site uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb; t public.library_form_templates%ROWTYPE;
BEGIN
  c := public.lib_check_generate(p_template, p_site, true);
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_template;
  RETURN jsonb_build_object('data', public.lib_form_context(p_template, p_site, (c ->> 'task')::uuid, 'PREVIEW', NULL),
                            'html', t.html, 'bindings', t.bindings, 'task_id', c -> 'task', 'template', public.lib_form_template_json(p_template));
END $$;

-- Generate: takes the next number of the form's sequence, keeps the data, and returns the template so the API renders it (lib_generated_attach stores the
-- file in the same transaction). Audited.
CREATE OR REPLACE FUNCTION lib_generate(p_template uuid, p_site uuid, p_remarks text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c jsonb; t public.library_form_templates%ROWTYPE; gid uuid := gen_random_uuid(); num text; ctx jsonb; tid uuid; rid integer;
BEGIN
  IF p_remarks IS NOT NULL AND char_length(p_remarks) > 1000 THEN
    PERFORM public.lib_err('validation_failed', 'Remarks are at most 1000 characters.', public.reg_err_item('/remarks', 'invalid', 'At most 1000 characters.'));
  END IF;
  c := public.lib_check_generate(p_template, p_site, false);
  tid := (c ->> 'task')::uuid; rid := (c ->> 'region_id')::integer;
  SELECT * INTO t FROM public.library_form_templates WHERE id = p_template;
  num := public.doc_next_number((SELECT key FROM public.doc_sequences WHERE form_code = t.code AND is_active), NULL, 'library_generated_doc', gid);
  IF num IS NULL THEN PERFORM public.lib_err('invalid_transition', 'The form has no active numbering sequence: approve the form again in Settings > Documents > Form templates.'); END IF;
  ctx := public.lib_form_context(p_template, p_site, tid, num, nullif(btrim(coalesce(p_remarks, '')), ''));
  INSERT INTO public.library_generated_docs (id, template_id, number, site_id, region_id, task_id, doc_type_id, status, remarks, data, generated_by)
  VALUES (gid, t.id, num, p_site, rid, tid, t.doc_type_id, 'generated', nullif(btrim(coalesce(p_remarks, '')), ''), ctx, public.app_actor());
  PERFORM public.log_audit_write('library_document_generate', 'library_generated_doc', gid::text, NULL,
    jsonb_build_object('number', num, 'template', t.code, 'template_version', t.version, 'task_id', tid, 'doc_type_id', t.doc_type_id), NULL, p_site, rid);
  RETURN jsonb_build_object('id', gid, 'number', num, 'data', ctx, 'html', t.html, 'bindings', t.bindings);
END $$;

-- The rendered file of a document generated in this very transaction by this actor (once).
CREATE OR REPLACE FUNCTION lib_generated_attach(p_id uuid, p_html text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_html IS NULL OR octet_length(p_html) > 8000000 THEN PERFORM public.lib_err('validation_failed', 'The rendered document is too large.'); END IF;
  UPDATE public.library_generated_docs SET html = p_html, sha256 = encode(sha256(convert_to(p_html, 'UTF8')), 'hex')
  WHERE id = p_id AND html IS NULL AND generated_by = public.app_actor() AND created_txid = txid_current();
  IF NOT FOUND THEN RAISE EXCEPTION 'library: the file of a generated document is attached once, by its generator, in the same request' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN public.lib_generated_json(p_id);
END $$;

-- The file of a generated document (download, print or preview of the stored copy). Who: the region's download right (sites.documents download_documents),
-- the person who generated it, or anyone who may generate the document of its task. Every read writes an audit row.
CREATE OR REPLACE FUNCTION lib_generated_read(p_id uuid, p_purpose text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g public.library_generated_docs%ROWTYPE; regs int[]; ok boolean; v_name text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_purpose NOT IN ('download', 'print', 'view') THEN PERFORM public.lib_err('validation_failed', 'purpose is download, print or view.'); END IF;
  SELECT * INTO g FROM public.library_generated_docs WHERE id = p_id;
  IF NOT FOUND OR NOT public.app_region_check(g.region_id) OR g.html IS NULL THEN PERFORM public.lib_err('not_found', 'The document does not exist or is not visible to you.'); END IF;
  regs := public.wf_actor_regions('sites.documents', 'download_documents'::"PermissionAction");
  ok := regs IS NULL OR g.region_id = ANY (regs) OR g.generated_by = public.app_actor() OR public.lib_can_generate(g.task_id);
  IF NOT ok THEN PERFORM public.lib_err('action_forbidden', 'You may not download documents of this region.'); END IF;
  v_name := regexp_replace((SELECT s.site_code FROM public.sites s WHERE s.id = g.site_id) || '_' || g.number, '[^A-Za-z0-9_.-]', '-', 'g') || '.html';
  PERFORM public.log_audit_write('library_document_download', 'library_generated_doc', g.id::text, NULL,
    jsonb_build_object('number', g.number, 'purpose', p_purpose, 'download_name', v_name, 'sha256', g.sha256, 'status', g.status), NULL, g.site_id, g.region_id);
  RETURN jsonb_build_object('html', g.html, 'download_name', v_name, 'number', g.number, 'status', g.status, 'sha256', g.sha256);
END $$;

-- Void a wrong document with a reason (the number stays issued; a new generation takes a new number). The generator, anyone who may generate it, or a
-- System Admin.
CREATE OR REPLACE FUNCTION lib_generated_void(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g public.library_generated_docs%ROWTYPE; before jsonb; res jsonb;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_reason(p_reason);
  SELECT * INTO g FROM public.library_generated_docs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT public.app_region_check(g.region_id) THEN PERFORM public.lib_err('not_found', 'The document does not exist or is not visible to you.'); END IF;
  IF NOT (g.generated_by = public.app_actor() OR public.lib_can_generate(g.task_id) OR public.app_actor_is_system_admin()) THEN
    PERFORM public.lib_err('not_eligible_holder', 'Only the person who generated it, or a holder of the right to generate it, voids this document.');
  END IF;
  IF g.status = 'voided' THEN PERFORM public.lib_err('invalid_transition', 'The document is voided already.'); END IF;
  before := public.lib_generated_json(p_id);
  UPDATE public.library_generated_docs SET status = 'voided', void_reason = btrim(p_reason), voided_by = public.app_actor(), voided_at = clock_timestamp() WHERE id = p_id;
  res := public.lib_generated_json(p_id);
  PERFORM public.log_audit_write('library_document_void', 'library_generated_doc', p_id::text, before, res, btrim(p_reason), g.site_id, g.region_id);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The setting library.archive (Settings > Documents > Archive)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION library_archive_columns() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['site', 'site_name', 'region', 'cluster', 'doc_type', 'doc_number', 'version', 'status', 'task', 'uploaded_by', 'uploaded_at', 'approved_by', 'approved_at']
$$;

CREATE OR REPLACE FUNCTION library_archive_seed() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('hidden', '[]'::jsonb, 'order', '[]'::jsonb, 'default_columns', to_jsonb(public.library_archive_columns()), 'zip_limit', 500)
$$;

-- GET /settings/library-archive: {hidden, order, default_columns, zip_limit, version, updated_at?, updated_by?}
CREATE OR REPLACE FUNCTION library_archive_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'library archive: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'library.archive';
  RETURN public.library_archive_seed() || coalesce(s.value -> 'config', '{}'::jsonb) || jsonb_build_object('version', coalesce((s.value ->> 'version')::integer, 0))
    || CASE WHEN s.key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_at', s.updated_at) END
    || CASE WHEN s.updated_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_by', public.wfe_user_ref(s.updated_by)) END;
END $$;

-- PUT /settings/library-archive. p_body = {hidden: [doc_code], order: [doc_code], default_columns: [column], zip_limit: 1..5000} (closed, every key required).
CREATE OR REPLACE FUNCTION admin_set_library_archive(p_body jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; k text; e jsonb; iv integer; res jsonb; cfg jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('library.archive', jsonb_build_object('config', public.library_archive_seed(), 'version', 0),
          'W5: the cards of Library > Archive (hidden, order), the default columns of the Archive list and the bulk zip limit (migration 0151).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key = 'library.archive' FOR UPDATE;
  cur := public.library_archive_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('hidden', 'order', 'default_columns', 'zip_limit') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['hidden', 'order'] LOOP
    IF jsonb_typeof(p_body -> k) IS DISTINCT FROM 'array' THEN
      errs := errs || public.reg_err_item('/' || k, 'required', 'A list of document codes.');
    ELSIF jsonb_array_length(p_body -> k) > 500 THEN
      errs := errs || public.reg_err_item('/' || k, 'invalid', 'At most 500 document codes.');
    ELSE
      FOR e IN SELECT jsonb_array_elements(p_body -> k) LOOP
        IF jsonb_typeof(e) <> 'string' OR NOT EXISTS (SELECT 1 FROM public.document_types d WHERE d.code = e #>> '{}') THEN
          errs := errs || public.reg_err_item('/' || k, 'unknown_document', format('%s is not a document type of the Document Library.', e #>> '{}'));
        END IF;
      END LOOP;
      IF (SELECT count(*) FROM jsonb_array_elements_text(p_body -> k)) <> (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(p_body -> k) x) THEN
        errs := errs || public.reg_err_item('/' || k, 'duplicate', 'A document code is listed twice.');
      END IF;
    END IF;
  END LOOP;
  IF jsonb_typeof(p_body -> 'default_columns') IS DISTINCT FROM 'array' OR jsonb_array_length(p_body -> 'default_columns') = 0 THEN
    errs := errs || public.reg_err_item('/default_columns', 'required', 'At least one column.');
  ELSE
    FOR e IN SELECT jsonb_array_elements(p_body -> 'default_columns') LOOP
      IF jsonb_typeof(e) <> 'string' OR NOT ((e #>> '{}') = ANY (public.library_archive_columns())) THEN
        errs := errs || public.reg_err_item('/default_columns', 'unknown_column', format('%s is not a column of the Archive list.', e #>> '{}'));
      END IF;
    END LOOP;
  END IF;
  IF jsonb_typeof(p_body -> 'zip_limit') IS DISTINCT FROM 'number' OR (p_body ->> 'zip_limit') !~ '^[0-9]{1,4}$' OR (p_body ->> 'zip_limit')::integer NOT BETWEEN 1 AND 5000 THEN
    errs := errs || public.reg_err_item('/zip_limit', 'out_of_range', 'A whole number of files from 1 to 5000.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  cfg := jsonb_build_object('hidden', p_body -> 'hidden', 'order', p_body -> 'order', 'default_columns', p_body -> 'default_columns', 'zip_limit', (p_body ->> 'zip_limit')::integer);
  SELECT coalesce((value ->> 'version')::integer, 0) INTO iv FROM public.settings WHERE key = 'library.archive';
  UPDATE public.settings SET value = jsonb_build_object('config', cfg, 'version', iv + 1), updated_by = public.app_actor(), updated_at = clock_timestamp()
  WHERE key = 'library.archive';
  res := public.library_archive_json();
  PERFORM public.log_audit_write('library_archive_update', 'setting', 'library.archive',
    cur - 'version' - 'updated_at' - 'updated_by', res - 'version' - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN res;
END $$;

CREATE TRIGGER b_settings_libarch_insert BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key = 'library.archive') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_libarch_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key = 'library.archive' OR NEW.key = 'library.archive') EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_libarch_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key = 'library.archive') EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Saved views of the Archive list and the menu keys
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sv_screen_module(p_screen text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_screen IS NULL THEN RETURN NULL; END IF;
  IF p_screen ~ '^register-[a-z0-9_]{2,60}$' THEN
    RETURN (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = substr(p_screen, 10) AND d.is_active);
  END IF;
  RETURN CASE p_screen
    WHEN 'sites' THEN 'sites'
    WHEN 'sites-stream' THEN 'sites'
    WHEN 'site-tasks' THEN 'sites'
    WHEN 'tasks-board' THEN 'sites' -- 0118 (F5)
    WHEN 'site360-master' THEN 'sites' -- 0138
    WHEN 'site360-design_acq' THEN 'sites' -- 0138
    WHEN 'site360-sow' THEN 'sites' -- 0138
    WHEN 'site360-cw' THEN 'sites' -- 0138
    WHEN 'site360-te' THEN 'sites' -- 0138
    WHEN 'site360-hoto' THEN 'sites' -- 0138
    WHEN 'site360-dismantle' THEN 'sites' -- 0138
    WHEN 'site360-om' THEN 'sites' -- 0138
    WHEN 'dashboard' THEN 'dashboard' -- 0138
    WHEN 'library-archive' THEN 'sites.documents' -- 0151 (W5)
    WHEN 'audit-log' THEN 'audit'
    WHEN 'field-changes' THEN 'audit'
    WHEN 'security-log' THEN 'admin.security_log'
    WHEN 'system-log' THEN 'admin.system_log'
    ELSE NULL END;
END $$;

INSERT INTO nav_item_catalogue (key, default_group, ord, added_in) VALUES
  ('library.forms', 'library', 100, '0151'),
  ('library.archive', 'library', 101, '0151')
ON CONFLICT (key) DO NOTHING;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('library_applied', 'workflow', NULL,
        jsonb_build_object('tables', jsonb_build_array('library_form_templates', 'library_generated_docs'), 'setting', 'library.archive',
                           'generate_grant', 'library.forms create', 'saved_view_screen', 'library-archive'),
        'Library menu: Forms and Archive (migration 0151, contract 0.15.69).');

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'lib_err(text,text,jsonb)', 'lib_require_config()', 'lib_form_template_json(uuid)', 'lib_generated_json(uuid)', 'lib_site_task(uuid,text)', 'lib_can_generate(uuid)',
    'lib_form_context(uuid,uuid,uuid,text,text)', 'lib_form_template_save(jsonb,text)', 'lib_form_template_approve(uuid,text)', 'lib_form_template_retire(uuid,text)',
    'lib_form_template_html(uuid)', 'lib_check_generate(uuid,uuid,boolean)', 'lib_preview(uuid,uuid)', 'lib_generate(uuid,uuid,text)', 'lib_generated_attach(uuid,text)',
    'lib_generated_read(uuid,text)', 'lib_generated_void(uuid,text)', 'library_archive_columns()', 'library_archive_seed()', 'library_archive_json()',
    'admin_set_library_archive(jsonb,text,integer)', 'sv_screen_module(text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  GRANT EXECUTE ON FUNCTION sv_screen_module(text) TO pmis_identity_owner;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'lib_can_generate(uuid)', 'lib_form_template_json(uuid)', 'lib_generated_json(uuid)', 'lib_form_template_save(jsonb,text)', 'lib_form_template_approve(uuid,text)',
      'lib_form_template_retire(uuid,text)', 'lib_form_template_html(uuid)', 'lib_preview(uuid,uuid)', 'lib_generate(uuid,uuid,text)', 'lib_generated_attach(uuid,text)',
      'lib_generated_read(uuid,text)', 'lib_generated_void(uuid,text)', 'library_archive_columns()', 'library_archive_json()', 'admin_set_library_archive(jsonb,text,integer)',
      'sv_screen_module(text)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
