-- 0037_templates_import: approved-template entry (CLAUDE.md "Approved templates only", "Two entry ways everywhere", "Data entry works three ways", Q73).
-- Mirror: db/sql/036_templates_import.sql (kept identical).
--
-- What it builds
--   1. The template catalogue. template_definitions gets the kind (register, stream, master), the register it enters, the keys that match a row to a record
--      and the custom-field entity; template_versions gets the field-set hash and the retirement time. One version is current; older ones are retired.
--      The view `templates` shows every version of every template (template_id, version, field_set_hash, created_at, status active or retired).
--   2. Versions are issued by the database, never by hand: tpl_sync_all() runs after every change of register_fields, field_definitions and
--      register_definitions, compares the hash of the columns a template would have now with the hash of the current version, and issues the next version when
--      they differ. A file made from an older version is rejected on upload with a clear message (the API reads the version in the hidden `_tpl` sheet).
--   3. The staging of an upload (imp_stage_batch). The API only reads the cells of the xlsx and passes them as JSON. The database decides: it checks the
--      template, the version and the header checksum again, resolves each row's site inside the caller's regions, matches the row to a record by `record_id`
--      or by the register's natural keys, validates it with the same functions as manual entry (reg_clean_data, custom_check_value, and reg_validate on a probe
--      record that is rolled back), builds the per-cell diff and classifies the row: create, update, unchanged or error (with the reasons per cell).
--   4. The batch is an ENTRY into the normal flow, not a shortcut. imp_submit_batch (the uploader) creates every valid row as a register record and submits it
--      through reg_save_record, reg_new_version and reg_transition_record (the overloads with p_batch_row, which only these functions can call), so the record
--      follows the Responsibility Matrix row of its register: L1 Data Entry (the uploader) then L2 Data Reviewer & Approver. imp_decide_batch lets L2 approve rows
--      one by one or all at once (the same reg_transition_record, same grants, same step-up), return rows to the uploader with a note, or discard an unsent batch.
--      A row whose logical record still has an open version is held "pending previous approval"; "approve all" never touches held rows and lists them.
--   5. The audit and the record history show "via batch": reg_step stores the import row (it already had the column) and reg_audit adds via = batch,
--      batch_id and batch_row_id to the audit row.
--   6. pmis_app only reads these tables. Every write goes through the functions above (owner pmis_definer, search_path set).
--
-- Stream templates (TPL-SITE-DA, -CW, -TE, -CL, Q73) and TPL-MASTER are not built here: the catalogue, the version rule and the batch tables are ready for
-- them (kind = stream or master), and imp_stage_batch refuses a template of those kinds until their row stage exists.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Catalogue
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE template_definitions
  ADD COLUMN kind          TEXT NOT NULL DEFAULT 'register' CHECK (kind IN ('register', 'stream', 'master')),
  ADD COLUMN register_key  TEXT REFERENCES register_definitions (register_key) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN stream_code   TEXT,
  ADD COLUMN name_ar       TEXT,
  ADD COLUMN module_key    TEXT,
  ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN match_keys    JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN custom_entity TEXT,
  ADD COLUMN sort_order    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  ADD COLUMN updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now();
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_scope_check CHECK (
  (kind = 'register' AND register_key IS NOT NULL AND stream_code IS NULL)
  OR (kind = 'stream' AND stream_code IS NOT NULL AND register_key IS NULL)
  OR (kind = 'master' AND register_key IS NULL AND stream_code IS NULL));
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_id_format CHECK (template_id ~ '^TPL-[A-Z0-9_-]{2,40}$');
COMMENT ON COLUMN template_definitions.match_keys IS 'Natural keys of a register row (spec registers-and-streams.md section 3): an array of key sets, tried in order; a set is usable when every code in it has a value in the row. site_code and record_type name the Site ID and Record Type columns.';

ALTER TABLE template_versions
  ADD COLUMN field_set_hash TEXT,
  ADD COLUMN retired_at     TIMESTAMPTZ(6),
  ADD COLUMN reason         TEXT;
CREATE UNIQUE INDEX template_versions_one_current_idx ON template_versions (template_def_id) WHERE is_current;
COMMENT ON COLUMN template_versions.field_set_hash IS 'sha256 of the ordered column specification (code, header, type, kind, required, derived, static list values). A different hash issues the next version.';
COMMENT ON COLUMN template_versions.header_checksum IS 'sha256 of the header row (the header texts joined by the unit separator 0x1f). The upload recomputes it from the file; a mismatch rejects the file.';

CREATE VIEW templates WITH (security_invoker = true) AS
  SELECT d.template_id, v.version, v.field_set_hash, v.published_at AS created_at,
         CASE WHEN d.is_active AND v.is_current THEN 'active' ELSE 'retired' END AS status,
         v.header_checksum, d.kind, d.register_key, d.stream_code, d.name AS name_en, d.name_ar
  FROM template_definitions d JOIN template_versions v ON v.template_def_id = d.id;
COMMENT ON VIEW templates IS 'Every version of every approved template: template_id, version, field_set_hash, created_at, and status active (current version of an active template) or retired.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Batches and rows
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE import_batches ALTER COLUMN status DROP DEFAULT;
ALTER TABLE import_batches ALTER COLUMN status TYPE TEXT USING status::text;
ALTER TABLE import_batches ALTER COLUMN status SET DEFAULT 'validated';
ALTER TABLE import_batches ADD CONSTRAINT import_batches_status_check
  CHECK (status IN ('parsing', 'validated', 'in_review', 'in_approval', 'partially_approved', 'approved', 'rejected', 'applied', 'undone', 'failed', 'discarded'));
ALTER TABLE import_batches ALTER COLUMN source SET DEFAULT 'template';
ALTER TABLE import_batches
  ADD COLUMN register_key TEXT REFERENCES register_definitions (register_key) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN task_id      UUID,
  ADD COLUMN site_id      UUID,
  ADD COLUMN version      INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN note         TEXT,
  ADD COLUMN submitted_at TIMESTAMPTZ(6),
  ADD COLUMN submitted_by UUID,
  ADD COLUMN closed_at    TIMESTAMPTZ(6);

ALTER TABLE import_batch_rows ALTER COLUMN action DROP DEFAULT;
ALTER TABLE import_batch_rows ALTER COLUMN action TYPE TEXT USING action::text;
ALTER TABLE import_batch_rows ALTER COLUMN action SET DEFAULT 'create';
ALTER TABLE import_batch_rows ALTER COLUMN decision DROP DEFAULT;
ALTER TABLE import_batch_rows ALTER COLUMN decision TYPE TEXT USING decision::text;
ALTER TABLE import_batch_rows ALTER COLUMN decision SET DEFAULT 'pending';
ALTER TABLE import_batch_rows ADD CONSTRAINT import_batch_rows_action_check CHECK (action IN ('create', 'update', 'unchanged', 'error'));
ALTER TABLE import_batch_rows ADD CONSTRAINT import_batch_rows_decision_check CHECK (decision IN ('pending', 'approved', 'rejected', 'pending_previous_approval'));
ALTER TABLE import_batch_rows
  ADD COLUMN sheet              TEXT NOT NULL DEFAULT 'Data',
  ADD COLUMN row_key            TEXT,                    -- the human key shown in the preview (site code, document number ...)
  ADD COLUMN site_id            UUID,
  ADD COLUMN record_type        TEXT,
  ADD COLUMN matched_entity_id  UUID,                    -- the logical record the row was matched to (update, unchanged)
  ADD COLUMN base_record_id     UUID,                    -- the version the diff was built against
  ADD COLUMN register_record_id UUID,                    -- the register record this row created (a draft that follows the normal flow)
  ADD COLUMN hold_reason        TEXT,
  ADD COLUMN decided_role       TEXT;
CREATE INDEX import_batch_rows_record_idx ON import_batch_rows (register_record_id) WHERE register_record_id IS NOT NULL;
CREATE INDEX import_batch_rows_matched_idx ON import_batch_rows (matched_entity_id) WHERE matched_entity_id IS NOT NULL;

-- Visibility. A batch is visible to its uploader, to a full-access session, and to anyone who can see one of its regions; a row only to those who see its
-- region (a row without a region, an error row, follows the batch). The check is one definer function so that the two tables do not recurse into each other.
CREATE OR REPLACE FUNCTION imp_batch_visible(p_batch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.app_has_session() AND EXISTS (
    SELECT 1 FROM public.import_batches b
    WHERE b.id = p_batch
      AND (public.app_is_full_access() OR b.uploaded_by = public.app_actor() OR public.app_regions_check(b.region_scope)
           OR EXISTS (SELECT 1 FROM public.import_batch_rows r WHERE r.batch_id = b.id AND r.region_id IS NOT NULL AND public.app_region_check(r.region_id))
           -- rows of a register without a site are global rows (Q69): visible to any session; the API narrows them to the register's module
           OR EXISTS (SELECT 1 FROM public.import_batch_rows r WHERE r.batch_id = b.id AND r.region_id IS NULL AND r.action IN ('create', 'update', 'unchanged'))))
$$;

DROP POLICY IF EXISTS region_filter ON import_batches;
DROP POLICY IF EXISTS rls_select ON import_batches;
DROP POLICY IF EXISTS rls_insert ON import_batches;
DROP POLICY IF EXISTS rls_update ON import_batches;
DROP POLICY IF EXISTS rls_delete ON import_batches;
CREATE POLICY rls_select ON import_batches FOR SELECT USING (imp_batch_visible(id));
CREATE POLICY rls_seed_write ON import_batches FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());
DROP POLICY IF EXISTS region_filter ON import_batch_rows;
DROP POLICY IF EXISTS rls_select ON import_batch_rows;
DROP POLICY IF EXISTS rls_insert ON import_batch_rows;
DROP POLICY IF EXISTS rls_update ON import_batch_rows;
DROP POLICY IF EXISTS rls_delete ON import_batch_rows;
CREATE POLICY rls_select ON import_batch_rows FOR SELECT USING (imp_batch_visible(batch_id) AND (region_id IS NULL OR app_region_check(region_id)));
CREATE POLICY rls_seed_write ON import_batch_rows FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

-- The row as the screens read it: its decision follows the record it created (an approval made in the register screen counts too).
CREATE VIEW v_import_rows WITH (security_invoker = true) AS
  SELECT r.*,
    CASE WHEN r.action IN ('error', 'unchanged') THEN r.decision
         WHEN r.decision = 'pending' AND rr.state = 'approved' THEN 'approved'
         WHEN r.decision = 'pending' AND rr.state = 'voided' THEN 'rejected'
         WHEN r.decision = 'pending' AND rr.state = 'entry' AND rr.submitted_at IS NOT NULL THEN 'rejected'
         ELSE r.decision END AS eff_decision,
    rr.state AS record_state, rr.version AS record_version
  FROM import_batch_rows r LEFT JOIN register_records rr ON rr.id = r.register_record_id;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Columns, hash, versions
-- ---------------------------------------------------------------------------------------------------------------------
-- The columns of a register template, in order: Site ID, Record Type, the register fields (Master order), the custom fields that appear in templates, Record ID.
-- Each: code, header, type, kind (site, record_type, field, custom, record_id), required, derived (grey, locked, never read), options (the list values).
CREATE OR REPLACE FUNCTION tpl_columns(p_register text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.register_definitions%ROWTYPE; ent text; out jsonb;
BEGIN
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_register;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  SELECT t.custom_entity INTO ent FROM public.template_definitions t WHERE t.register_key = p_register LIMIT 1;
  WITH cols AS (
    SELECT 10 AS grp, 0 AS ord, 'site_code'::text AS code, 'Site ID'::text AS label, 'text'::text AS type, 'site'::text AS kind, false AS required, false AS derived, NULL::jsonb AS options
      WHERE d.site_scoped
    UNION ALL
    SELECT 20, 0, 'record_type', 'Record Type', 'list', 'record_type', false, false, to_jsonb(d.record_types) WHERE cardinality(d.record_types) > 0
    UNION ALL
    SELECT 30, f.sort_order, f.code, f.label_en, f.field_type, 'field', f.required, f.derived,
           CASE WHEN jsonb_typeof(f.options) = 'array' THEN f.options
                WHEN jsonb_typeof(f.options) = 'object' AND f.options ->> 'source' = 'permit_types'
                  THEN (SELECT coalesce(jsonb_agg(pt.code ORDER BY pt.sort_order, pt.code), '[]'::jsonb) FROM public.permit_types pt WHERE pt.is_active)
                WHEN f.field_type = 'yes_no' THEN '["Yes", "No"]'::jsonb END
      FROM public.register_fields f WHERE f.register_key = p_register AND f.is_active
    UNION ALL
    SELECT 40, c.sort_order, c.code, c.label_en,
           CASE c.data_type::text WHEN 'multi_list' THEN 'text' WHEN 'file' THEN 'text' WHEN 'external_party' THEN 'text' ELSE c.data_type::text END,
           'custom', c.required, false,
           CASE WHEN c.data_type::text = 'list' THEN (SELECT coalesce(jsonb_agg(l.code ORDER BY l.sort_order, l.code), '[]'::jsonb) FROM public.field_list_values l WHERE l.field_id = c.id AND l.is_active)
                WHEN c.data_type::text = 'yes_no' THEN '["Yes", "No"]'::jsonb END
      FROM public.field_definitions c
      WHERE ent IS NOT NULL AND c.entity_type::text = ent AND c.is_active AND c.in_templates AND c.task_code IS NULL
        AND c.data_type::text NOT IN ('file', 'multi_list', 'user', 'external_party')
    UNION ALL
    SELECT 90, 0, 'record_id', 'Record ID', 'text', 'record_id', false, false, NULL::jsonb
  ), numbered AS (
    SELECT c.*, count(*) OVER (PARTITION BY lower(c.label)) AS same
    FROM cols c
  )
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'code', n.code, 'header', CASE WHEN n.same > 1 THEN n.label || ' [' || n.code || ']' ELSE n.label END, 'type', n.type, 'kind', n.kind,
      'required', n.required, 'derived', n.derived, 'options', n.options)) ORDER BY n.grp, n.ord, n.code COLLATE "C"), '[]'::jsonb)
  INTO out FROM numbered n;
  RETURN out;
END $$;

-- sha256 helpers. The hash covers everything that changes what a user types or what a file means; list values that come from Setting lists or custom
-- list fields are not in it (the database checks every value again on upload), but the fixed lists of a register field are.
CREATE OR REPLACE FUNCTION tpl_field_hash(p_cols jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(coalesce((
    SELECT jsonb_agg(jsonb_build_array(c ->> 'code', c ->> 'header', c ->> 'type', c ->> 'kind', coalesce((c ->> 'required')::boolean, false), coalesce((c ->> 'derived')::boolean, false),
      CASE WHEN c ->> 'kind' = 'field' AND c ->> 'type' = 'list' THEN c -> 'options' END) ORDER BY ord)
    FROM jsonb_array_elements(p_cols) WITH ORDINALITY AS t(c, ord)), '[]'::jsonb)::text, 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION tpl_header_checksum(p_cols jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(c ->> 'header', E'\x1f' ORDER BY ord) FROM jsonb_array_elements(p_cols) WITH ORDINALITY AS t(c, ord)), ''), 'UTF8')), 'hex')
$$;

-- Issues the next version of one template when its columns changed (or the first one). Returns the current version.
CREATE OR REPLACE FUNCTION tpl_sync(p_template text, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public.template_definitions%ROWTYPE; cols jsonb; h text; cs text; cur public.template_versions%ROWTYPE; fsv integer; nv integer;
BEGIN
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF d.kind <> 'register' THEN RETURN d.current_version; END IF;
  cols := public.tpl_columns(d.register_key);
  h := public.tpl_field_hash(cols);
  cs := public.tpl_header_checksum(cols);
  SELECT version INTO fsv FROM public.field_set_versions WHERE entity_type::text = d.custom_entity;
  SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF NOT FOUND THEN
    INSERT INTO public.template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason)
    VALUES (d.id, 1, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, 'first version'));
    UPDATE public.template_definitions SET current_version = 1, updated_at = now() WHERE id = d.id;
    RETURN 1;
  END IF;
  IF cur.field_set_hash IS DISTINCT FROM h THEN
    nv := cur.version + 1;
    UPDATE public.template_versions SET is_current = false, retired_at = now() WHERE id = cur.id;
    INSERT INTO public.template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason, published_by)
    VALUES (d.id, nv, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, 'register fields changed'), public.app_actor());
    UPDATE public.template_definitions SET current_version = nv, updated_at = now() WHERE id = d.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('template_version_issued', 'template', p_template, jsonb_build_object('version', cur.version, 'field_set_hash', cur.field_set_hash),
            jsonb_build_object('version', nv, 'field_set_hash', h, 'columns', jsonb_array_length(cols)), coalesce(p_reason, 'register fields changed'), public.app_actor());
    RETURN nv;
  END IF;
  RETURN cur.version;
END $$;

-- Every enabled register has a template; a register that appears later (another migration) gets one named TPL-<KEY>. Then every template is synced.
CREATE OR REPLACE FUNCTION tpl_sync_all() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rd record; tr record; tid text;
BEGIN
  FOR rd IN SELECT r.register_key, r.name_en, r.name_ar, r.module_key, r.sort_order FROM public.register_definitions r
            WHERE r.is_active AND r.enabled AND NOT EXISTS (SELECT 1 FROM public.template_definitions t WHERE t.register_key = r.register_key) LOOP
    tid := 'TPL-' || upper(replace(rd.register_key, '_', '-'));
    IF NOT EXISTS (SELECT 1 FROM public.template_definitions t WHERE t.template_id = tid) THEN
      INSERT INTO public.template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, sort_order)
      VALUES (tid, rd.name_en, rd.name_ar, rd.register_key, 'register', rd.register_key, rd.module_key, rd.sort_order);
    END IF;
  END LOOP;
  UPDATE public.template_definitions t SET is_active = (r.is_active AND r.enabled), updated_at = now()
    FROM public.register_definitions r WHERE t.register_key = r.register_key AND t.is_active IS DISTINCT FROM (r.is_active AND r.enabled);
  FOR tr IN SELECT x.template_id FROM public.template_definitions x WHERE x.kind = 'register' ORDER BY x.sort_order, x.template_id LOOP
    PERFORM public.tpl_sync(tr.template_id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION tpl_fields_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.tpl_sync_all();
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Seed the catalogue (data, not code): one template per register, with the natural keys of the spec (section 3)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, custom_entity, match_keys, sort_order)
SELECT v.tid, r.name_en, r.name_ar, r.register_key, 'register', r.register_key, r.module_key, v.ent, v.keys::jsonb, r.sort_order
FROM (VALUES
  ('procurement',        'TPL-PO',    'procurement',    '[["site_code","scope","pr_no"],["site_code","scope","po_wo_no"]]'),
  ('contractors',        'TPL-CTR',    'external_party', '[["record_type","contractor_name"],["record_type","team_name"]]'),
  ('rf_design',          'TPL-RF',     'rf_design',      '[["site_code"]]'),
  ('acquisition',        'TPL-ACQ',    'acquisition',    '[["site_code","candidate"]]'),
  ('gecol',              'TPL-GECOL',  'gecol',          '[["site_code"]]'),
  ('hlc',                'TPL-HLC',    'hlc',            '[["site_code"]]'),
  ('permits_hse',        'TPL-PRM',    'permit',         '[["site_code","permit_type","valid_from"]]'),
  ('warehouse',          'TPL-WH',     'warehouse_item', '[["doc_no"]]'),
  ('quality',            'TPL-QLT',    'quality',        '[["record_code"]]'),
  ('issues',             'TPL-ISS',    'issue',          '[["site_code","pending_issue"]]'),
  ('risks',              'TPL-RSK',    'risk',           '[["risk_id"]]'),
  ('change_control',     'TPL-CHG',    'change_request', '[["change_id"]]'),
  ('readiness_handover', 'TPL-RDY',    'readiness',      '[["site_code"]]'),
  ('as_built',           'TPL-ASB',    'as_built',       '[["site_code"]]'),
  ('meetings',           'TPL-MTG',    'meeting',        '[["meeting_date","title"]]'),
  ('dismantle',          'TPL-DIS',    NULL,             '[["site_code","record_type"]]')
) AS v(rk, tid, ent, keys)
JOIN register_definitions r ON r.register_key = v.rk
ON CONFLICT (template_id) DO NOTHING;
UPDATE template_definitions SET name = 'Procurement (PR / PO / WO)' WHERE template_id = 'TPL-PO' AND name = 'Procurement';

-- the statement-level triggers come after the seed, so the first versions are issued by tpl_sync_all() below
SELECT tpl_sync_all();
CREATE TRIGGER tpl_register_fields_changed AFTER INSERT OR UPDATE OR DELETE ON register_fields FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();
CREATE TRIGGER tpl_register_definitions_changed AFTER INSERT OR UPDATE OR DELETE ON register_definitions FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();
CREATE TRIGGER tpl_field_definitions_changed AFTER INSERT OR UPDATE OR DELETE ON field_definitions FOR EACH STATEMENT EXECUTE FUNCTION tpl_fields_changed();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. "via batch": the step and the audit row know the import row
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION imp_current_row() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v uuid;
BEGIN
  BEGIN v := nullif(current_setting('app.batch_row', true), '')::uuid; EXCEPTION WHEN others THEN RETURN NULL; END;
  IF v IS NULL THEN RETURN NULL; END IF;
  RETURN (SELECT r.id FROM public.import_batch_rows r WHERE r.id = v);
END $$;

CREATE OR REPLACE FUNCTION reg_step(p_record uuid, p_level int, p_action text, p_actor uuid, p_note text, p_before text, p_after text, p_stepup boolean, p_self boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sid uuid;
BEGIN
  INSERT INTO public.register_steps (record_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, batch_row_id, created_at)
  VALUES (p_record, p_level, p_action, p_actor, p_note, p_before, p_after, coalesce(p_stepup, false), coalesce(p_self, false),
          coalesce(public.imp_current_row(), (SELECT r.batch_row_id FROM public.register_records r WHERE r.id = p_record)), clock_timestamp())
  RETURNING id INTO sid;
  RETURN sid;
END $$;

CREATE OR REPLACE FUNCTION reg_audit(p_action text, p_record uuid, p_before jsonb, p_after jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; v text := nullif(current_setting('app.via', true), ''); a jsonb := p_after; br uuid := public.imp_current_row(); bid uuid;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF br IS NOT NULL THEN
    SELECT x.batch_id INTO bid FROM public.import_batch_rows x WHERE x.id = br;
    a := coalesce(p_after, '{}'::jsonb) || jsonb_build_object('via', 'batch', 'batch_id', bid, 'batch_row_id', br);
  ELSIF v IN ('button', 'drag', 'bulk') THEN
    a := coalesce(p_after, '{}'::jsonb) || jsonb_build_object('via', v);
  END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id)
  VALUES (p_action, 'register_record', p_record::text, r.site_id, r.region_id, p_before, a, p_reason, public.app_actor());
  IF p_action IN ('register_record_create', 'register_record_submit', 'register_record_review', 'register_record_approve', 'register_record_reject',
                  'register_record_void', 'register_record_new_version') THEN
    PERFORM public.x_notify_watchers(r.site_id, r.entity_id, public.app_actor(), 'A followed record changed', public.reg_label(p_record) || ': ' || substr(p_action, 17),
      '/registers/' || r.register_key || '/records/' || p_record::text, NULL, r.region_id, public.reg_module(r.register_key));
  END IF;
END $$;

-- The batch overloads of the register writers: the same function, with the import row set for the length of the call. Only the imp_* functions call them.
CREATE OR REPLACE FUNCTION reg_save_record(p_key text, p_id uuid, p_version int, p_site uuid, p_record_type text, p_data jsonb, p_custom jsonb, p_party uuid, p_clear_party boolean, p_batch_row uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.import_batch_rows r JOIN public.import_batches b ON b.id = r.batch_id WHERE r.id = p_batch_row AND b.uploaded_by = public.app_actor()) THEN
    RAISE EXCEPTION 'the import row is not yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.batch_row', p_batch_row::text, true);
  rid := public.reg_save_record(p_key, p_id, p_version, p_site, p_record_type, p_data, p_custom, p_party, p_clear_party);
  UPDATE public.register_records SET source = 'template', batch_row_id = p_batch_row WHERE id = rid;
  PERFORM set_config('app.batch_row', '', true);
  RETURN rid;
END $$;

CREATE OR REPLACE FUNCTION reg_new_version(p_record uuid, p_version int, p_batch_row uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE rid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.import_batch_rows r JOIN public.import_batches b ON b.id = r.batch_id WHERE r.id = p_batch_row AND b.uploaded_by = public.app_actor()) THEN
    RAISE EXCEPTION 'the import row is not yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.batch_row', p_batch_row::text, true);
  rid := public.reg_new_version(p_record, p_version);
  UPDATE public.register_records SET source = 'template', batch_row_id = p_batch_row WHERE id = rid;
  PERFORM set_config('app.batch_row', '', true);
  RETURN rid;
END $$;

CREATE OR REPLACE FUNCTION reg_transition_record(p_record uuid, p_version int, p_action text, p_note text, p_stepup boolean, p_batch_row uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE res jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.import_batch_rows r WHERE r.id = p_batch_row AND r.register_record_id = p_record)
     AND NOT EXISTS (SELECT 1 FROM public.import_batch_rows r JOIN public.register_records x ON x.id = p_record WHERE r.id = p_batch_row AND r.matched_entity_id = x.entity_id) THEN
    RAISE EXCEPTION 'the import row does not belong to this record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.batch_row', p_batch_row::text, true);
  res := public.reg_transition_record(p_record, p_version, p_action, p_note, p_stepup);
  PERFORM set_config('app.batch_row', '', true);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Staging an upload
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION imp_wf_json(p_msg text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_msg ~ '^wf:[a-z_]+:\{' THEN jsonb_build_object('code', split_part(p_msg, ':', 2), 'extra', substring(p_msg from '^wf:[a-z_]+:(\{.*\})$')::jsonb) END
$$;

-- Is region p_region inside the regions p_regs (NULL = every region; empty = none)? A row without a region needs at least one region (reg_require_grant).
CREATE OR REPLACE FUNCTION imp_region_ok(p_regs int[], p_region int) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT p_regs IS NULL OR (cardinality(p_regs) > 0 AND (p_region IS NULL OR p_region = ANY (p_regs)))
$$;

CREATE OR REPLACE FUNCTION imp_hdr(p_cols jsonb, p_code text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT c ->> 'header' FROM jsonb_array_elements(p_cols) c WHERE c ->> 'code' = p_code LIMIT 1), p_code)
$$;

CREATE OR REPLACE FUNCTION imp_cell_err(p_cols jsonb, p_code text, p_err text, p_msg text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('column', public.imp_hdr(p_cols, p_code), 'field', p_code, 'code', p_err, 'message', p_msg)
$$;

-- One row of a register template: resolve, match, validate, diff, classify. Returns everything the staging inserts.
CREATE OR REPLACE FUNCTION imp_stage_register_row(
  p_key text, p_keysets jsonb, p_cols jsonb, p_row jsonb, p_task_site uuid, p_entity text,
  p_view int[], p_imp int[], p_create int[], p_edit int[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); d public.register_definitions%ROWTYPE; s public.sites%ROWTYPE;
  errs jsonb := coalesce(p_row -> 'pre_errors', '[]'::jsonb); data jsonb := coalesce(p_row -> 'data', '{}'::jsonb); custom jsonb := coalesce(p_row -> 'custom', '{}'::jsonb);
  clean jsonb := '{}'::jsonb; cclean jsonb := '{}'::jsonb; scode text := nullif(btrim(p_row ->> 'site_code'), ''); rtype text := nullif(btrim(p_row ->> 'record_type'), '');
  rid text := nullif(btrim(p_row ->> 'record_id'), ''); no_site boolean; ent uuid; ents uuid[]; n int; col record; k text; v jsonb; tid uuid; msg text; j jsonb; e jsonb;
  cur public.register_records%ROWTYPE; opn public.register_records%ROWTYPE; base_data jsonb := '{}'::jsonb; base_custom jsonb := '{}'::jsonb; diff jsonb := '{}'::jsonb;
  action text; decision text := 'pending'; hold text; base_id uuid; region int; rkey text; sig text; ks jsonb; usable boolean; kc text; fd public.field_definitions%ROWTYPE;
  merged jsonb; mcustom jsonb; probe uuid; perrs jsonb := '[]'::jsonb; perr text; item jsonb; glob boolean; keyparts text[] := ARRAY[]::text[]; used_set jsonb;
  has_entry boolean;
BEGIN
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_key;

  -- record type
  IF rtype IS NOT NULL THEN
    SELECT x INTO rtype FROM unnest(d.record_types) x WHERE lower(x) = lower(rtype) LIMIT 1;
    IF rtype IS NULL THEN
      errs := errs || public.imp_cell_err(p_cols, 'record_type', 'not_in_list', 'Not a record type of this register.');
      rtype := '?';
    END IF;
  END IF;
  no_site := NOT d.site_scoped OR coalesce(rtype = ANY (d.site_optional_types), false);

  -- site, inside the caller's regions (unknown and out-of-scope sites answer the same)
  IF NOT no_site THEN
    IF scode IS NULL THEN
      errs := errs || public.imp_cell_err(p_cols, 'site_code', 'required', 'The Site ID is required.');
    ELSE
      SELECT * INTO s FROM public.sites x WHERE upper(x.site_code) = upper(scode) AND public.app_region_check(x.region_id) AND public.imp_region_ok(p_view, x.region_id);
      IF NOT FOUND THEN
        errs := errs || public.imp_cell_err(p_cols, 'site_code', 'site_not_in_scope', 'Unknown site, or a site outside your regions.');
      ELSIF p_task_site IS NOT NULL AND s.id <> p_task_site THEN
        errs := errs || public.imp_cell_err(p_cols, 'site_code', 'not_task_site', 'This file was uploaded from a task: only the rows of the task''s site are accepted.');
      END IF;
    END IF;
  ELSIF scode IS NOT NULL THEN
    errs := errs || public.imp_cell_err(p_cols, 'site_code', 'not_site_scoped', 'This record has no site: leave Site ID empty.');
  END IF;
  region := s.region_id;
  glob := no_site;

  -- the values: names and employee IDs become ids, then the same cleaning as manual entry
  FOR col IN SELECT c ->> 'code' AS code, c ->> 'type' AS type, c ->> 'kind' AS kind, coalesce((c ->> 'derived')::boolean, false) AS derived
             FROM jsonb_array_elements(p_cols) c WHERE c ->> 'kind' = 'field' LOOP
    IF col.derived THEN data := data - col.code; CONTINUE; END IF;
    IF NOT (data ? col.code) THEN CONTINUE; END IF;
    v := data -> col.code;
    IF col.type = 'external_team' THEN
      SELECT count(*), min(t.id::text) INTO n, msg FROM public.external_teams t WHERE lower(t.name) = lower(btrim(v #>> '{}')) AND t.is_active;
      IF n = 1 THEN data := data || jsonb_build_object(col.code, msg);
      ELSE errs := errs || public.imp_cell_err(p_cols, col.code, CASE WHEN n = 0 THEN 'unknown_team' ELSE 'ambiguous_team' END, CASE WHEN n = 0 THEN 'Unknown or inactive team.' ELSE 'More than one team has this name.' END);
           data := data - col.code; END IF;
    ELSIF col.type = 'user' THEN
      SELECT count(*), min(u.id::text) INTO n, msg FROM public.users u WHERE u.deleted_at IS NULL AND (btrim(u.employee_id) = btrim(v #>> '{}') OR lower(u.email) = lower(btrim(v #>> '{}')));
      IF n = 1 THEN data := data || jsonb_build_object(col.code, msg);
      ELSE errs := errs || public.imp_cell_err(p_cols, col.code, 'unknown_user', 'Type the 4-digit employee ID or the e-mail of an existing user.');
           data := data - col.code; END IF;
    END IF;
  END LOOP;
  BEGIN
    clean := public.reg_clean_data(p_key, data);
  EXCEPTION WHEN others THEN
    j := public.imp_wf_json(SQLERRM);
    IF j ->> 'code' = 'validation_failed' THEN
      FOR e IN SELECT * FROM jsonb_array_elements(j -> 'extra' -> 'errors') LOOP
        errs := errs || public.imp_cell_err(p_cols, regexp_replace(e ->> 'path', '^/data/', ''), e ->> 'code', e ->> 'message');
      END LOOP;
    ELSE
      errs := errs || jsonb_build_array(jsonb_build_object('code', 'row_failed', 'message', 'The row could not be read.'));
    END IF;
  END;
  -- Excel type mistakes arrive as text: the cleaning reports them. Blank cells never clear a value (they are not sent).
  clean := jsonb_strip_nulls(clean);

  -- custom fields (the admin-added columns)
  FOR k, v IN SELECT * FROM jsonb_each(custom) LOOP
    SELECT * INTO fd FROM public.field_definitions x WHERE x.entity_type::text = p_entity AND x.code = k AND x.is_active AND x.in_templates AND x.task_code IS NULL;
    IF NOT FOUND THEN CONTINUE; END IF;
    msg := public.custom_check_value(fd, v);
    IF msg IS NOT NULL THEN errs := errs || public.imp_cell_err(p_cols, k, 'invalid', initcap(msg) || '.');
    ELSE cclean := cclean || jsonb_build_object(k, v); END IF;
  END LOOP;

  -- match: Record ID first, then the natural keys
  IF rid IS NOT NULL THEN
    BEGIN
      SELECT x.entity_id INTO ent FROM public.register_records x
      WHERE x.entity_id = rid::uuid AND x.register_key = p_key AND x.state <> 'voided' AND public.app_region_read(x.is_global, x.region_id) LIMIT 1;
    EXCEPTION WHEN others THEN ent := NULL;
    END;
    IF ent IS NULL THEN errs := errs || public.imp_cell_err(p_cols, 'record_id', 'record_not_found', 'No record of this register has this Record ID, or it is outside your regions.'); END IF;
  END IF;
  IF ent IS NULL AND rid IS NULL AND jsonb_array_length(errs) = 0 THEN
    FOR ks IN SELECT * FROM jsonb_array_elements(p_keysets) LOOP
      usable := true;
      FOR kc IN SELECT * FROM jsonb_array_elements_text(ks) LOOP
        IF kc = 'site_code' THEN usable := usable AND s.id IS NOT NULL;
        ELSIF kc = 'record_type' THEN usable := usable AND rtype IS NOT NULL;
        ELSE usable := usable AND clean ->> kc IS NOT NULL; END IF;
      END LOOP;
      CONTINUE WHEN NOT usable;
      used_set := ks;
      SELECT array_agg(DISTINCT x.entity_id) INTO ents FROM public.register_records x
      WHERE x.register_key = p_key AND x.state <> 'voided' AND public.app_region_read(x.is_global, x.region_id)
        AND x.version_no = (SELECT max(y.version_no) FROM public.register_records y WHERE y.entity_id = x.entity_id AND y.state <> 'voided')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(ks) k2(code) WHERE
              CASE k2.code WHEN 'site_code' THEN x.site_id IS DISTINCT FROM s.id
                           WHEN 'record_type' THEN x.record_type IS DISTINCT FROM rtype
                           ELSE lower(coalesce(x.data ->> k2.code, '')) <> lower(coalesce(clean ->> k2.code, '')) END);
      IF ents IS NOT NULL AND cardinality(ents) > 1 THEN
        errs := errs || jsonb_build_array(jsonb_build_object('code', 'ambiguous_match', 'message', 'More than one record has these key values: use the Record ID.'));
      ELSIF ents IS NOT NULL THEN ent := ents[1]; END IF;
      EXIT;
    END LOOP;
  END IF;
  -- the human key
  IF used_set IS NOT NULL THEN
    FOR kc IN SELECT * FROM jsonb_array_elements_text(used_set) LOOP
      keyparts := keyparts || CASE kc WHEN 'site_code' THEN s.site_code WHEN 'record_type' THEN upper(rtype) ELSE clean ->> kc END;
    END LOOP;
  ELSE
    keyparts := ARRAY[coalesce(s.site_code, scode), CASE WHEN rtype IS NOT NULL AND rtype <> '?' THEN upper(rtype) END];
  END IF;
  rkey := nullif(array_to_string(array_remove(keyparts, NULL), ' / '), '');
  sig := CASE WHEN ent IS NOT NULL THEN 'e:' || ent::text WHEN used_set IS NOT NULL THEN 'k:' || md5(array_to_string(keyparts, '|')) END;

  -- the version to compare with
  IF ent IS NOT NULL THEN
    SELECT * INTO cur FROM public.register_records x WHERE x.entity_id = ent AND x.state = 'approved' AND x.is_current;
    SELECT * INTO opn FROM public.register_records x WHERE x.entity_id = ent AND x.state IN ('entry', 'in_review', 'in_approval');
    IF cur.id IS NOT NULL THEN base_data := cur.data; base_custom := cur.custom; base_id := cur.id;
    ELSIF opn.id IS NOT NULL THEN base_data := opn.data; base_custom := opn.custom; base_id := opn.id; END IF;
    IF opn.id IS NOT NULL THEN decision := 'pending_previous_approval'; hold := 'open_version'; END IF;
    IF jsonb_array_length(errs) = 0 AND coalesce(s.id, cur.site_id, opn.site_id) IS NOT NULL AND s.id IS NOT NULL
       AND coalesce(cur.site_id, opn.site_id) IS DISTINCT FROM s.id THEN
      errs := errs || public.imp_cell_err(p_cols, 'site_code', 'site_mismatch', 'The Record ID belongs to another site.');
    END IF;
    IF jsonb_array_length(errs) = 0 AND rtype IS NOT NULL AND coalesce(cur.record_type, opn.record_type) IS DISTINCT FROM rtype THEN
      errs := errs || public.imp_cell_err(p_cols, 'record_type', 'type_mismatch', 'The Record ID belongs to a record of another type.');
    END IF;
    IF jsonb_array_length(errs) = 0 AND s.id IS NULL AND coalesce(cur.site_id, opn.site_id) IS NOT NULL THEN
      SELECT * INTO s FROM public.sites x WHERE x.id = coalesce(cur.site_id, opn.site_id);
      region := s.region_id;
    END IF;
  END IF;

  -- the diff
  IF jsonb_array_length(errs) = 0 THEN
    FOR k, v IN SELECT * FROM jsonb_each(clean) LOOP
      IF ent IS NULL THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', NULL, 'new', v));
      ELSIF base_data -> k IS DISTINCT FROM v THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', base_data -> k, 'new', v)); END IF;
    END LOOP;
    FOR k, v IN SELECT * FROM jsonb_each(cclean) LOOP
      IF ent IS NULL THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', NULL, 'new', v));
      ELSIF base_custom -> k IS DISTINCT FROM v THEN diff := diff || jsonb_build_object(k, jsonb_build_object('old', base_custom -> k, 'new', v)); END IF;
    END LOOP;
    action := CASE WHEN ent IS NULL THEN 'create' WHEN diff = '{}'::jsonb THEN 'unchanged' ELSE 'update' END;
    IF action = 'unchanged' THEN decision := 'pending'; hold := NULL; END IF;
    IF action = 'create' AND NOT no_site AND s.id IS NULL THEN action := 'error'; END IF;
  END IF;

  -- the caller's rights on this row: import, create or edit, and the entry level of the register row
  IF jsonb_array_length(errs) = 0 AND action IN ('create', 'update') THEN
    IF NOT public.imp_region_ok(p_imp, region) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('code', 'region_forbidden', 'message', 'You may not import in this region.'));
    ELSIF NOT public.imp_region_ok(CASE action WHEN 'create' THEN p_create ELSE p_edit END, region) THEN
      errs := errs || jsonb_build_array(jsonb_build_object('code', 'action_forbidden', 'message', 'You may not ' || CASE action WHEN 'create' THEN 'create' ELSE 'edit' END || ' records of this register in this region.'));
    ELSE
      has_entry := EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, region) h WHERE h.user_id = actor)
                   OR (public.app_user_is_system_admin(actor) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders(p_key, region)));
      IF NOT has_entry THEN
        errs := errs || jsonb_build_array(jsonb_build_object('code', 'not_entry_holder', 'message', 'You are not an entry holder (L1) of the ' || d.name_en || ' row of the Matrix.'));
      END IF;
    END IF;
  END IF;

  -- the register's own rules (reg_validate) on a probe record that is rolled back at once
  IF jsonb_array_length(errs) = 0 AND action IN ('create', 'update') THEN
    merged := jsonb_strip_nulls(base_data || clean);
    mcustom := jsonb_strip_nulls(base_custom || cclean);
    BEGIN
      INSERT INTO public.register_records (entity_id, version_no, register_key, record_type, site_id, region_id, is_global, levels_required, data, custom, created_by)
      VALUES (gen_random_uuid(), 2, p_key, nullif(rtype, '?'), s.id, region, glob AND s.id IS NULL, 2, merged, mcustom, actor) RETURNING id INTO probe;
      perrs := public.reg_validate(probe);
      RAISE EXCEPTION 'imp:probe_done';
    EXCEPTION WHEN others THEN
      IF SQLERRM <> 'imp:probe_done' THEN
        j := public.imp_wf_json(SQLERRM);
        IF j IS NOT NULL THEN perr := coalesce(j -> 'extra' ->> 'detail', 'The row is not valid.'); ELSE perr := SQLERRM; END IF;
        perrs := jsonb_build_array(jsonb_build_object('path', '/row', 'code', 'invalid', 'message', left(perr, 300)));
      END IF;
    END;
    FOR item IN SELECT * FROM jsonb_array_elements(perrs) LOOP
      errs := errs || public.imp_cell_err(p_cols, CASE WHEN item ->> 'path' LIKE '/data/%' THEN regexp_replace(item ->> 'path', '^/data/', '') WHEN item ->> 'path' = '/site_id' THEN 'site_code' ELSE 'record_id' END,
                                          item ->> 'code', item ->> 'message');
    END LOOP;
  END IF;

  IF jsonb_array_length(errs) > 0 THEN action := 'error'; diff := '{}'::jsonb; decision := 'pending'; hold := NULL; END IF;
  RETURN jsonb_build_object('action', action, 'decision', decision, 'hold_reason', hold, 'errors', errs, 'diff', diff,
    'payload', jsonb_build_object('data', clean, 'custom', cclean), 'region_id', region, 'site_id', s.id, 'site_code', coalesce(s.site_code, scode),
    'record_type', nullif(rtype, '?'), 'key', rkey, 'matched_entity_id', ent, 'base_record_id', base_id, 'sig', sig);
END $$;

-- The upload: template, version and header checksum are checked again here; then every row is staged. Returns the batch id.
CREATE OR REPLACE FUNCTION imp_stage_batch(p_template text, p_version int, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; rd public.register_definitions%ROWTYPE; cols jsonb;
  r_import int[]; r_view int[]; r_create int[]; r_edit int[]; bid uuid := gen_random_uuid(); el jsonb; res jsonb; seen jsonb := '{}'::jsonb; results jsonb := '[]'::jsonb; task_site uuid; n_err int := 0; n_rows int := 0;
  regions int[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active;
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file was made from version ' || p_version || ' of ' || p_template || '; the current version is ' || v.version || '. Download the template again.'));
  END IF;
  IF v.header_checksum <> p_checksum THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
  END IF;
  IF d.kind <> 'register' THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'Uploads of this template are not available yet.'));
  END IF;
  SELECT * INTO rd FROM public.register_definitions WHERE register_key = d.register_key AND is_active AND enabled;
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'The register of this template is not available.')); END IF;
  r_import := public.wf_actor_regions('templates', 'import');
  r_view := public.wf_actor_regions(rd.module_key, 'view');
  r_create := public.wf_actor_regions(rd.module_key, 'create');
  r_edit := public.wf_actor_regions(rd.module_key, 'edit');
  IF (r_import IS NOT NULL AND cardinality(r_import) = 0) OR (r_view IS NOT NULL AND cardinality(r_view) = 0)
     OR (r_create IS NOT NULL AND cardinality(r_create) = 0 AND r_edit IS NOT NULL AND cardinality(r_edit) = 0) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'import_not_allowed', 'detail', 'You may not import into this register.'));
  END IF;
  IF p_task IS NOT NULL THEN
    SELECT t.site_id INTO task_site FROM public.task_instances t WHERE t.id = p_task AND public.app_region_check(t.region_id);
    IF task_site IS NULL THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The task does not exist or is not visible to you.')); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id
                   JOIN public.register_task_sources s ON s.task_code = td.code AND s.register_key = d.register_key WHERE ti.id = p_task AND s.is_active) THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'This task does not use this template.'));
    END IF;
  END IF;
  cols := v.columns;

  FOR el IN SELECT x FROM jsonb_array_elements(p_rows) x LOOP
    res := public.imp_stage_register_row(d.register_key, d.match_keys, cols, el, task_site, d.custom_entity, r_view, r_import, r_create, r_edit);
    IF res ->> 'sig' IS NOT NULL AND res ->> 'action' <> 'error' THEN
      IF seen ? (res ->> 'sig') THEN
        res := res || jsonb_build_object('action', 'error', 'diff', '{}'::jsonb, 'decision', 'pending', 'hold_reason', NULL,
          'errors', coalesce(res -> 'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('code', 'duplicate_in_file', 'message', 'Row ' || (seen ->> (res ->> 'sig')) || ' of this file is the same record.')));
      ELSE seen := seen || jsonb_build_object(res ->> 'sig', el ->> 'row_no'); END IF;
    END IF;
    results := results || jsonb_build_array(jsonb_build_object('row_no', (el ->> 'row_no')::int, 'sheet', coalesce(el ->> 'sheet', 'Data'), 'res', res));
  END LOOP;

  SELECT coalesce(array_agg(DISTINCT (t -> 'res' ->> 'region_id')::int) FILTER (WHERE t -> 'res' ->> 'action' <> 'error' AND t -> 'res' ->> 'region_id' IS NOT NULL), ARRAY[]::int[]),
         count(*), count(*) FILTER (WHERE t -> 'res' ->> 'action' = 'error')
    INTO regions, n_rows, n_err FROM jsonb_array_elements(results) t;

  INSERT INTO public.import_batches (id, template_version_id, source, file_name, file_sha256, status, uploaded_by, region_scope, rows_total, rows_error, register_key, task_id, site_id)
  VALUES (bid, v.id, 'template', left(p_file_name, 200), p_sha, 'validated', actor, regions, n_rows, n_err, d.register_key, p_task, task_site);
  INSERT INTO public.import_batch_rows (batch_id, row_no, sheet, site_code, region_id, target_entity, target_id, action, payload, diff, errors, decision, row_key, site_id, record_type,
    matched_entity_id, base_record_id, hold_reason)
  SELECT bid, (t ->> 'row_no')::int, t ->> 'sheet', t -> 'res' ->> 'site_code', (t -> 'res' ->> 'region_id')::int, d.register_key, (t -> 'res' ->> 'matched_entity_id')::uuid, t -> 'res' ->> 'action',
         t -> 'res' -> 'payload', t -> 'res' -> 'diff', t -> 'res' -> 'errors', t -> 'res' ->> 'decision', t -> 'res' ->> 'key', (t -> 'res' ->> 'site_id')::uuid, t -> 'res' ->> 'record_type',
         (t -> 'res' ->> 'matched_entity_id')::uuid, (t -> 'res' ->> 'base_record_id')::uuid, t -> 'res' ->> 'hold_reason'
  FROM jsonb_array_elements(results) t ORDER BY (t ->> 'row_no')::int;

  INSERT INTO public.audit_log (action, entity_type, entity_id, region_id, after, actor_id)
  VALUES ('import_batch_create', 'import_batch', bid::text, NULL,
          jsonb_build_object('template_id', p_template, 'template_version', v.version, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'rows', n_rows, 'errors', n_err,
            'create', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'create'),
            'update', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'update'),
            'unchanged', (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = bid AND action = 'unchanged')), actor);
  RETURN bid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Status of a batch, sending it into the flow, deciding its rows
-- ---------------------------------------------------------------------------------------------------------------------
-- The status the rows say (the stored status moves only through imp_submit_batch and imp_decide_batch).
CREATE OR REPLACE FUNCTION imp_status_of(p_batch uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE b public.import_batches%ROWTYPE; n_open int; n_ok int; n_rej int;
BEGIN
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF b.status NOT IN ('in_approval', 'partially_approved', 'approved', 'rejected') THEN RETURN b.status; END IF;
  SELECT count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision IN ('pending', 'pending_previous_approval')),
         count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'approved'),
         count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'rejected')
    INTO n_open, n_ok, n_rej FROM public.v_import_rows x WHERE x.batch_id = p_batch;
  RETURN CASE WHEN n_open > 0 AND n_ok + n_rej = 0 THEN 'in_approval' WHEN n_open > 0 THEN 'partially_approved' WHEN n_ok > 0 THEN 'approved' ELSE 'rejected' END;
END $$;

CREATE OR REPLACE FUNCTION imp_lock_batch(p_batch uuid, p_version int) RETURNS public.import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE b public.import_batches%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO b FROM public.import_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR NOT public.imp_batch_visible(p_batch) THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The batch does not exist or is not visible to you.')); END IF;
  IF p_version IS NOT NULL AND p_version <> b.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The batch changed since you read it. Reload and try again.')); END IF;
  RETURN b;
END $$;

-- The uploader confirms the preview: every valid row becomes a register record (a draft) that is submitted at once. From here the normal flow decides.
CREATE OR REPLACE FUNCTION imp_submit_batch(p_batch uuid, p_version int, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; key text; cur public.register_records%ROWTYPE; opn public.register_records%ROWTYPE;
  rid uuid; rver int; st text; submitted int := 0; held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; patch jsonb; cpatch jsonb; k text; new_st text; msg text;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  -- the records are created and submitted as the uploader (L1 Data Entry): nobody else, not even an admin, enters them in the uploader's name
  IF b.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
  END IF;
  IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
  END IF;
  key := b.register_key;
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action IN ('create', 'update') AND x.decision IN ('pending', 'pending_previous_approval')
             AND x.register_record_id IS NULL ORDER BY x.row_no LOOP
    BEGIN
      IF r.action = 'update' THEN
        SELECT * INTO opn FROM public.register_records x WHERE x.entity_id = r.matched_entity_id AND x.state IN ('entry', 'in_review', 'in_approval');
        IF opn.id IS NOT NULL THEN
          UPDATE public.import_batch_rows SET decision = 'pending_previous_approval', hold_reason = 'open_version' WHERE id = r.id;
          held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', 'open_version', 'record_id', opn.id));
          CONTINUE;
        END IF;
        SELECT * INTO cur FROM public.register_records x WHERE x.entity_id = r.matched_entity_id AND x.state = 'approved' AND x.is_current;
        IF NOT FOUND OR cur.id IS DISTINCT FROM r.base_record_id THEN
          UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', hold_reason = NULL, diff = '{}'::jsonb,
            errors = jsonb_build_array(jsonb_build_object('code', 'stale_base', 'message', 'The record changed after the file was uploaded. Download the template again.')) WHERE id = r.id;
          failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'stale_base'));
          CONTINUE;
        END IF;
        rid := public.reg_new_version(cur.id, cur.version, r.id);
        SELECT version INTO rver FROM public.register_records WHERE id = rid;
        patch := '{}'::jsonb; cpatch := '{}'::jsonb;
        FOR k IN SELECT jsonb_object_keys(r.diff) LOOP
          IF r.payload -> 'data' ? k THEN patch := patch || jsonb_build_object(k, r.payload -> 'data' -> k);
          ELSIF r.payload -> 'custom' ? k THEN cpatch := cpatch || jsonb_build_object(k, r.payload -> 'custom' -> k); END IF;
        END LOOP;
        PERFORM public.reg_save_record(key, rid, rver, NULL, NULL, patch, nullif(cpatch, '{}'::jsonb), NULL, false, r.id);
      ELSE
        rid := public.reg_save_record(key, NULL, NULL, r.site_id, r.record_type, r.payload -> 'data', nullif(r.payload -> 'custom', '{}'::jsonb), NULL, false, r.id);
      END IF;
      SELECT version INTO rver FROM public.register_records WHERE id = rid;
      UPDATE public.import_batch_rows SET register_record_id = rid WHERE id = r.id;      -- the overload below checks that the row belongs to the record
      PERFORM public.reg_transition_record(rid, rver, 'submit', NULL, p_stepup, r.id);
      SELECT state INTO st FROM public.register_records WHERE id = rid;
      UPDATE public.import_batch_rows SET register_record_id = rid, hold_reason = NULL,
        decision = CASE WHEN st = 'approved' THEN 'approved' ELSE 'pending' END,
        decided_by = CASE WHEN st = 'approved' THEN actor END, decided_at = CASE WHEN st = 'approved' THEN now() END WHERE id = r.id;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be sent', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The register refused this row. See the System Log (template-check) for the technical reason.' END;
      IF j ->> 'code' = 'validation_failed' THEN
        msg := coalesce((SELECT string_agg(e ->> 'message', ' ') FROM jsonb_array_elements(j -> 'extra' -> 'errors') e), msg);
      END IF;
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', register_record_id = NULL, hold_reason = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  new_st := CASE WHEN submitted > 0 OR b.status <> 'validated' THEN public.imp_status_of_after(p_batch) ELSE b.status END;
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, actor_id)
  VALUES ('import_batch_submit', 'import_batch', p_batch::text, jsonb_build_object('submitted', submitted, 'held', jsonb_array_length(held), 'failed', jsonb_array_length(failed), 'status', new_st), actor);
  RETURN jsonb_build_object('submitted', submitted, 'held', held, 'failed', failed);
END $$;

-- The status after a submit: in_approval while anything is open, otherwise what the rows say.
CREATE OR REPLACE FUNCTION imp_status_of_after(p_batch uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n_open int; n_ok int; n_rej int;
BEGIN
  SELECT count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision IN ('pending', 'pending_previous_approval')),
         count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'approved'),
         count(*) FILTER (WHERE x.action IN ('create', 'update') AND x.eff_decision = 'rejected')
    INTO n_open, n_ok, n_rej FROM public.v_import_rows x WHERE x.batch_id = p_batch;
  RETURN CASE WHEN n_open > 0 AND n_ok + n_rej = 0 THEN 'in_approval' WHEN n_open > 0 THEN 'partially_approved' WHEN n_ok > 0 THEN 'approved' WHEN n_rej > 0 THEN 'rejected' ELSE 'validated' END;
END $$;

-- Decisions. p_action: review, approve, reject, discard. p_scope: all (every open row) or rows (p_rows = [{row_id, decision, note}]).
-- A row is decided by the same transition a person makes on the record, with the same grants, level holders and step-up.
CREATE OR REPLACE FUNCTION imp_decide_batch(p_batch uuid, p_version int, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.v_import_rows%ROWTYPE; want jsonb; ids uuid[]; act text; rnote text; decided int := 0; approved int := 0; rejected int := 0;
  held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; first_forbidden text; st text; new_st text; msg text; rec public.register_records%ROWTYPE; item jsonb; uploader uuid;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF p_action NOT IN ('review', 'approve', 'reject', 'discard') OR p_scope NOT IN ('all', 'rows') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope.'))));
  END IF;

  IF p_action = 'discard' THEN
    IF b.uploaded_by <> actor AND NOT public.app_user_is_system_admin(actor) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can discard it.'));
    END IF;
    IF b.status <> 'validated' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a batch that has not been sent can be discarded. Return the rows with a note instead.'));
    END IF;
    UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = coalesce(nullif(btrim(p_note), ''), 'discarded') WHERE batch_id = p_batch;
    UPDATE public.import_batches SET status = 'discarded', note = nullif(btrim(p_note), ''), closed_at = now(), version = version + 1 WHERE id = p_batch;
    INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id) VALUES ('import_batch_discard', 'import_batch', p_batch::text, jsonb_build_object('status', 'discarded'), p_note, actor);
    RETURN jsonb_build_object('decided', 0, 'approved', 0, 'rejected', 0, 'held', held, 'failed', failed);
  END IF;

  IF b.status NOT IN ('in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN b.status = 'validated' THEN 'The batch has not been sent into the flow yet.' ELSE 'The batch is ' || b.status || '.' END));
  END IF;
  IF p_action = 'reject' AND coalesce(btrim(p_note), '') = '' AND p_scope = 'all' THEN PERFORM public.wf_err('note_required'); END IF;
  IF p_scope = 'rows' AND (p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rows', 'code', 'required', 'message', 'Name the rows to decide.'))));
  END IF;

  FOR r IN SELECT x.* FROM public.v_import_rows x
           WHERE x.batch_id = p_batch AND x.action IN ('create', 'update') AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
             AND ((p_scope = 'all' AND x.eff_decision IN ('pending', 'pending_previous_approval'))
                  OR (p_scope = 'rows' AND x.id IN (SELECT (e ->> 'row_id')::uuid FROM jsonb_array_elements(p_rows) e)))
           ORDER BY x.row_no LOOP
    item := CASE WHEN p_scope = 'rows' THEN (SELECT e FROM jsonb_array_elements(p_rows) e WHERE (e ->> 'row_id')::uuid = r.id LIMIT 1) END;
    act := CASE WHEN p_action = 'reject' THEN 'reject' WHEN p_scope = 'rows' AND item ->> 'decision' = 'rejected' THEN 'reject' ELSE p_action END;
    rnote := coalesce(nullif(btrim(item ->> 'note'), ''), nullif(btrim(p_note), ''));
    IF r.eff_decision = 'approved' OR r.eff_decision = 'rejected' THEN CONTINUE; END IF;
    -- a held row has no record yet: "approve all" lists it and leaves it; a return takes it back to the uploader
    IF r.register_record_id IS NULL THEN
      IF act = 'reject' THEN
        IF rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, hold_reason = NULL WHERE id = r.id;
        decided := decided + 1; rejected := rejected + 1;
      ELSE
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', coalesce(r.hold_reason, 'open_version'),
          'record_id', (SELECT x.id FROM public.register_records x WHERE x.entity_id = r.matched_entity_id AND x.state IN ('entry', 'in_review', 'in_approval') LIMIT 1)));
      END IF;
      CONTINUE;
    END IF;
    IF act = 'reject' AND rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
    BEGIN
      SELECT * INTO rec FROM public.register_records WHERE id = r.register_record_id;
      IF act <> 'reject' AND ((act = 'approve' AND rec.state <> 'in_approval') OR (act = 'review' AND rec.state <> 'in_review')) THEN
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'invalid_transition',
          'message', 'The record is ' || rec.state || ': ' || act || ' is not possible now.'));
        CONTINUE;
      END IF;
      PERFORM public.reg_transition_record(rec.id, rec.version, act, rnote, p_stepup, r.id);
      SELECT state INTO st FROM public.register_records WHERE id = rec.id;
      IF act = 'reject' THEN
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        rejected := rejected + 1; decided := decided + 1;
      ELSIF st = 'approved' THEN
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        approved := approved + 1; decided := decided + 1;
      ELSE
        decided := decided + 1;     -- passed a level; the row stays open
      END IF;
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j ->> 'code' IN ('not_eligible_holder', 'action_forbidden') AND first_forbidden IS NULL THEN first_forbidden := SQLERRM; END IF;
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be decided', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The row could not be decided. See the System Log (template-check) for the technical reason.' END;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  IF decided = 0 AND first_forbidden IS NOT NULL THEN RAISE EXCEPTION '%', first_forbidden USING ERRCODE = 'P0001'; END IF;

  new_st := public.imp_status_of_after(p_batch);
  UPDATE public.import_batches SET status = new_st, version = version + 1, note = CASE WHEN p_action = 'reject' THEN coalesce(nullif(btrim(p_note), ''), note) ELSE note END,
    closed_at = CASE WHEN new_st IN ('approved', 'rejected') THEN now() ELSE closed_at END WHERE id = p_batch;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id)
  VALUES ('import_batch_' || p_action, 'import_batch', p_batch::text,
          jsonb_build_object('scope', p_scope, 'decided', decided, 'approved', approved, 'rejected', rejected, 'held', jsonb_array_length(held), 'failed', jsonb_array_length(failed), 'status', new_st), p_note, actor);
  -- tell the uploader
  uploader := b.uploaded_by;
  IF uploader <> actor AND decided > 0 THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (uploader, 'in_app', 'import_batch', CASE WHEN p_action = 'reject' THEN 'Rows of your upload were returned' ELSE 'Rows of your upload were decided' END,
            b.file_name || ': ' || approved || ' approved, ' || rejected || ' returned' || CASE WHEN p_action = 'reject' AND p_note IS NOT NULL THEN '. ' || left(p_note, 200) ELSE '' END,
            '/registers/' || b.register_key || '/batches/' || p_batch::text);
  END IF;
  RETURN jsonb_build_object('decided', decided, 'approved', approved, 'rejected', rejected, 'held', held, 'failed', failed);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Ownership, grants
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON template_definitions, template_versions TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON import_batches, import_batch_rows TO pmis_definer;
GRANT SELECT ON field_list_values, field_set_versions, task_instances, task_definitions TO pmis_definer;
GRANT INSERT ON system_log TO pmis_definer;                 -- a row the register refuses for a technical reason is logged (the user sees a plain message)
GRANT USAGE, SELECT ON SEQUENCE system_log_id_seq TO pmis_definer;
GRANT SELECT ON v_import_rows TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'imp_batch_visible(uuid)', 'tpl_columns(text)', 'tpl_field_hash(jsonb)', 'tpl_header_checksum(jsonb)', 'tpl_sync(text,text)', 'tpl_sync_all()', 'tpl_fields_changed()',
    'imp_current_row()', 'imp_wf_json(text)', 'imp_region_ok(int[],int)', 'imp_hdr(jsonb,text)', 'imp_cell_err(jsonb,text,text,text)',
    'imp_stage_register_row(text,jsonb,jsonb,jsonb,uuid,text,int[],int[],int[],int[])', 'imp_stage_batch(text,int,text,text,text,uuid,jsonb)',
    'imp_status_of(uuid)', 'imp_status_of_after(uuid)', 'imp_lock_batch(uuid,int)', 'imp_submit_batch(uuid,int,boolean)', 'imp_decide_batch(uuid,int,text,text,jsonb,text,boolean)',
    'reg_step(uuid,int,text,uuid,text,text,text,boolean,boolean)', 'reg_audit(text,uuid,jsonb,jsonb,text)',
    'reg_save_record(text,uuid,int,uuid,text,jsonb,jsonb,uuid,boolean,uuid)', 'reg_new_version(uuid,int,uuid)', 'reg_transition_record(uuid,int,text,text,boolean,uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON template_definitions, template_versions, import_batches, import_batch_rows FROM pmis_app;
    GRANT SELECT ON template_definitions, template_versions, import_batches, import_batch_rows, v_import_rows, templates TO pmis_app;
    -- what the API calls: the reads of the download and of the batch screens, the three writers
    FOREACH f IN ARRAY ARRAY[
      'imp_batch_visible(uuid)', 'tpl_columns(text)', 'tpl_header_checksum(jsonb)', 'imp_status_of(uuid)',
      'imp_stage_batch(text,int,text,text,text,uuid,jsonb)', 'imp_submit_batch(uuid,int,boolean)', 'imp_decide_batch(uuid,int,text,text,jsonb,text,boolean)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
