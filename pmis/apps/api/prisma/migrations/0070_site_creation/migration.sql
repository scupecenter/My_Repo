-- 0070_site_creation: bulk and manual site creation (gap G1 of docs/plans/2026-11-04-master-template-data-load.md, owner question Q460 answered by the
-- technical decisions) and the three small load fixes G2, G8 and G9. Contract 0.14.0, CHANGELOG 98.
-- Mirror: db/sql/069_site_creation.sql (kept byte-identical).
--
--   1. G1 / Q460  GSDN Workspace creates sites. The identity of a site comes from the Master sheet (Site ID, region, cluster, delivery scenario, scope flags AA:AF,
--                 names, coordinates); RF & Design enriches the site later through its feed (P4a, 0062). There are two entry ways, both ending at L2:
--                   (a) manual:  site_draft_create / _save / _submit / _decide / _discard (POST /sites creates a draft, L1 submits, L2 decides);
--                   (b) bulk:    the approved template TPL-SITE-NEW ("New sites": an issued file with the hidden _tpl sheet), staged by imp_stage_site_batch,
--                                sent by imp_submit_site_batch (the uploader is L1), decided row by row or all at once by imp_decide_site_batch (L2).
--                 Both use one writer, site_create_apply, and a site exists only when L2 approves.
--                 Who: there is no fitting Matrix row (the stage rows belong to tasks of a workflow version, and a site has no task before it exists), so the
--                 Matrix gets a row "Site creation" (register key site_creation, not an enabled register: it only carries cells), L1 and L2 seeded to the
--                 System Admins group, editable like every other row (decision B11). Region-scoped grants apply: sites create in the row's region for L1,
--                 sites approve for L2, and the holder of the level in the Matrix. A person who holds both levels approves their own submission at once
--                 (B5): it needs step-up and is flagged in the audit row. Approval needs step-up (the verified context, app_ctx_stepup()).
--   2. On approval site_create_apply: creates the site on the workflow version in force with all its task instances (the pattern of
--                 admin_migrate_sites_to_workflow: every task locked with its levels and SLA rule; the root tasks of the first stage are opened by the engine's own
--                 wf_open_locked), creates a new cluster of the row in the site's region (decision: a cluster named by a row is created when it does not exist yet;
--                 an existing cluster of another region is refused), runs the scenario applicability of P1 (wf_apply_applicability_core), recalculates the site
--                 and audits the creation with the draft, batch and batch row. Q466: a row whose Overall Status is Cancelled creates the site and then sets it
--                 cancelled (audited), so its history exists.
--   3. Validation site_new_clean (one function for both entry ways): Site ID unique and never reused (any site, also a cancelled one, and any waiting draft),
--                 region through the region aliases of P3, delivery scenario from the DeliveryScenario list, Site Scenario and Site Type from their lists,
--                 scope flags Yes / No (N/A) or blank, ISO dates, coordinates in range. Landlord and contact columns do not exist (Q469): an unknown field is refused.
--                 A probe in a rolled-back subtransaction applies the scenario rules, so a Hot or Cold Swap with scope flags Yes is refused at entry.
--   4. wf_apply_applicability(uuid): the small wrapper that P4a's p4a_hook (0062) has been looking for. A site with a scenario and scope conflict is not touched
--                 (P4a reports the conflict itself).
--   5. G8         rf_design.site_scenario had the DeliveryScenario list while the file holds Indoor / Outdoor. It gets its own list, SiteScenario (Indoor, Outdoor, pending
--                 the owner's confirmation). Saved values that are unambiguously Indoor or Outdoor are mapped; every other saved value stays as an inactive value of
--                 the list (readable, never offered again), like the Severity list in 0068.
--   6. G9         sites.name_ar: the Arabic site name (the English name stays name). Loaded by the new template, shown on the site page and in the Site Register.
--   7. G2         API only (apps/api/src/master-import): a known header alias for a typed column.
--
-- Every function is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked. The actor and the regions come only
-- from the verified context accessors (app_actor(), wf_actor_regions, app_ctx_stepup()). pmis_app stays read-only on the new table (db/sql/app_grants.sql) and
-- can no longer insert a site; audit rows go through log_audit_write.

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. G9: the Arabic site name
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE sites ADD COLUMN name_ar TEXT CHECK (name_ar IS NULL OR char_length(name_ar) <= 200);
COMMENT ON COLUMN sites.name_ar IS 'G9 / Q469 (0070): the Arabic site name. The English name stays in name. Loaded by the New sites template, shown on the site page and in the Site Register.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. G8: the Site Scenario (Indoor / Outdoor) has its own list
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO list_catalogues (code, name_en, name_ar, description, critical, status, allow_other) VALUES
  ('SiteScenario', 'Site scenario (Indoor / Outdoor)', 'سيناريو الموقع (داخلي / خارجي)',
   'G8 (0070): the Master list tblScenario, used by the Site Scenario of RF & Design and of the New sites template. It is not the Delivery Scenario. Pending the owner''s confirmation.', false, 'pending', false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('SiteScenario', 'Indoor', 'Indoor', 'داخلي', 10), ('SiteScenario', 'Outdoor', 'Outdoor', 'خارجي', 20)
ON CONFLICT (catalogue_code, code) DO NOTHING;

DO $$
DECLARE mapped int := 0; kept jsonb; n int := 0;
BEGIN
  -- the saved values of the field (every version of every record): Indoor and Outdoor in any spelling become the code; the rest stay as they are
  WITH m AS (
    SELECT x.id, (SELECT v.code FROM list_values v WHERE v.catalogue_code = 'SiteScenario' AND lower(v.code) = lower(btrim(x.data ->> 'site_scenario'))) AS code
    FROM register_records x WHERE x.register_key = 'rf_design' AND jsonb_typeof(x.data -> 'site_scenario') = 'string'
  )
  UPDATE register_records r SET data = jsonb_set(r.data, '{site_scenario}', to_jsonb(m.code))
  FROM m WHERE m.id = r.id AND m.code IS NOT NULL AND r.data ->> 'site_scenario' <> m.code;
  GET DIAGNOSTICS mapped = ROW_COUNT;
  -- any other saved value (the old Delivery Scenario names) is kept as an inactive value: readable, never offered
  WITH other AS (
    SELECT DISTINCT btrim(r.data ->> 'site_scenario') AS v FROM register_records r
    WHERE r.register_key = 'rf_design' AND jsonb_typeof(r.data -> 'site_scenario') = 'string' AND btrim(r.data ->> 'site_scenario') <> ''
      AND NOT EXISTS (SELECT 1 FROM list_values x WHERE x.catalogue_code = 'SiteScenario' AND lower(x.code) = lower(btrim(r.data ->> 'site_scenario')))
  ), ins AS (
    INSERT INTO list_values (catalogue_code, code, label_en, sort_order, is_active)
    SELECT 'SiteScenario', o.v, o.v, 900, false FROM other o WHERE char_length(o.v) <= 80 AND o.v !~ '[[:cntrl:];]'
    ON CONFLICT (catalogue_code, code) DO NOTHING RETURNING code)
  SELECT count(*), coalesce(jsonb_agg(code ORDER BY code), '[]'::jsonb) INTO n, kept FROM ins;
  UPDATE register_fields SET list_catalogue = 'SiteScenario', options = list_active_codes('SiteScenario')
  WHERE register_key = 'rf_design' AND code = 'site_scenario';
  INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
  VALUES ('site_scenario_list_linked', 'list_catalogue', 'SiteScenario',
          jsonb_build_object('records_rewritten', mapped, 'inactive_values_kept', kept, 'field', 'rf_design.site_scenario'),
          'G8 (migration 0070): the RF & Design Site Scenario is Indoor / Outdoor (pending the owner''s confirmation, Q470), no longer the Delivery Scenario list.');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The Matrix row "Site creation" (L1 and L2), not an enabled register
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('site_creation', 'Site creation', 'إنشاء المواقع', 'sites', 'register', false, true, ARRAY[]::text[], 2, '{}'::jsonb, false, 5)
ON CONFLICT (register_key) DO NOTHING;

-- The default holders: the System Admins group, global cells (L1 = cell level 1, L2 = cell level 3). Only missing cells are seeded and nothing is overwritten.
-- The group is created by the installer after the migrations, so a trigger on groups seeds the row when the group appears (and this migration seeds it now
-- when the group exists already).
CREATE OR REPLACE FUNCTION site_creation_seed_cells() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE gid uuid; lvl int; cid uuid; n int := 0;
BEGIN
  SELECT g.id INTO gid FROM public.groups g WHERE g.is_system_admins AND g.is_active ORDER BY g.created_at, g.id LIMIT 1;
  IF gid IS NULL THEN RETURN 0; END IF;
  FOREACH lvl IN ARRAY ARRAY[1, 3] LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.matrix_cells c WHERE c.register_key = 'site_creation' AND c.level = lvl AND c.region_id IS NULL);
    INSERT INTO public.matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('site_creation', lvl, 'any_one', NULL, true, now()) RETURNING id INTO cid;
    INSERT INTO public.matrix_cell_assignees (cell_id, kind, ref_id) VALUES (cid, 'group', gid) ON CONFLICT (cell_id, kind, ref_id) DO NOTHING;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    UPDATE public.matrix_state SET revision = revision + 1, updated_at = now();
    INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason)
    VALUES ('site_creation_matrix_seeded', 'matrix', 'site_creation', jsonb_build_object('cells_seeded', n, 'holder', 'System Admins'),
            'Owner question Q460 (2026-11-04): L1 and L2 of site creation seeded to the System Admins, editable in the Responsibility Matrix.');
  END IF;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION site_creation_seed_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.site_creation_seed_cells();
  RETURN NULL;
END $$;
CREATE TRIGGER z_site_creation_seed AFTER INSERT ON groups FOR EACH ROW WHEN (NEW.is_system_admins) EXECUTE FUNCTION site_creation_seed_trg();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The drafts
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE site_drafts (
  id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  site_code      TEXT           NOT NULL CHECK (site_code = upper(btrim(site_code)) AND char_length(site_code) BETWEEN 1 AND 40),
  region_id      INTEGER        NOT NULL REFERENCES regions (id),
  data           JSONB          NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  status         TEXT           NOT NULL DEFAULT 'entry' CHECK (status IN ('entry', 'in_approval', 'approved', 'rejected', 'discarded')),
  version        INTEGER        NOT NULL DEFAULT 1,
  created_by     UUID           NOT NULL REFERENCES users (id),
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  submitted_by   UUID           REFERENCES users (id),
  submitted_at   TIMESTAMPTZ(6),
  decided_by     UUID           REFERENCES users (id),
  decided_at     TIMESTAMPTZ(6),
  decision_note  TEXT           CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  return_count   INTEGER        NOT NULL DEFAULT 0,
  last_return_note TEXT,
  self_approval  BOOLEAN        NOT NULL DEFAULT false,
  site_id        UUID           REFERENCES sites (id),
  batch_id       UUID           REFERENCES import_batches (id),
  batch_row_id   UUID           REFERENCES import_batch_rows (id),
  CHECK ((status = 'approved') = (site_id IS NOT NULL))
);
CREATE INDEX site_drafts_status_region_idx ON site_drafts (status, region_id, created_at DESC);
CREATE UNIQUE INDEX site_drafts_open_code_key ON site_drafts (site_code) WHERE status IN ('entry', 'in_approval');
CREATE INDEX site_drafts_batch_idx ON site_drafts (batch_id) WHERE batch_id IS NOT NULL;
COMMENT ON TABLE site_drafts IS 'G1 / Q460 (0070): a proposed site (manual entry, or one row of a New sites batch). It becomes a site only when L2 approves (site_create_apply). Written only by the site_draft_* and imp_*_site_batch functions.';
ALTER TABLE site_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_drafts FORCE ROW LEVEL SECURITY;
-- the same form as the policies that 0069 rewrote: the region test over (SELECT app_ctx_rset()), evaluated once per statement
CREATE POLICY rls_select ON site_drafts FOR SELECT USING (COALESCE((SELECT app_ctx_rset()) && ARRAY[region_id, -1], false));

ALTER TABLE import_batches ADD COLUMN entity TEXT CHECK (entity IS NULL OR entity = 'site');
ALTER TABLE import_batch_rows ADD COLUMN site_draft_id UUID REFERENCES site_drafts (id);
COMMENT ON COLUMN import_batches.entity IS '0070: site = a New sites batch (rows become site drafts, then sites when L2 approves).';
COMMENT ON COLUMN import_batch_rows.site_draft_id IS '0070: the site draft this row created when the batch was sent.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The template kind "sites" and the template TPL-SITE-NEW
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_kind_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_kind_check CHECK (kind IN ('register', 'stream', 'master', 'sites'));
ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_scope_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_scope_check CHECK (
  (kind = 'register' AND register_key IS NOT NULL AND stream_code IS NULL)
  OR (kind = 'stream' AND stream_code IS NOT NULL AND register_key IS NULL)
  OR (kind IN ('master', 'sites') AND register_key IS NULL AND stream_code IS NULL));

-- The columns of the New sites template: the identity and scope of a site (Master B, C:S, X:AG). No landlord, contact, phone or e-mail column (Q469).
CREATE OR REPLACE FUNCTION tpl_sites_columns() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH c (ord, code, header, type, kind, required, options, allow_other) AS (VALUES
    (1,  'site_code',         'Site ID',                'text',   'site',  true,  NULL::jsonb, NULL::boolean),
    (2,  'region',            'Region',                 'text',   'field', true,  (SELECT jsonb_agg(r.name_en ORDER BY r.id) FROM public.regions r), true),
    (3,  'name',              'Site Name (EN)',         'text',   'field', true,  NULL, NULL),
    (4,  'name_ar',           'Site Name (AR)',         'text',   'field', false, NULL, NULL),
    (5,  'owner_site_id',     'Site Owner ID',          'text',   'field', false, NULL, NULL),
    (6,  'cluster_code',      'Cluster',                'text',   'field', false, NULL, NULL),
    (7,  'delivery_scenario', 'Delivery Scenario',      'list',   'field', true,  public.list_active_codes('DeliveryScenario'), NULL),
    (8,  'site_scenario',     'Site Scenario',          'list',   'field', false, public.list_active_codes('SiteScenario'), NULL),
    (9,  'site_type',         'Site Type',              'list',   'field', false, public.list_active_codes('SiteType'), NULL),
    (10, 'project_phase',     'Project Phase',          'text',   'field', false, NULL, NULL),
    (11, 'delivery_batch',    'Delivery Batch',         'text',   'field', false, NULL, NULL),
    (12, 'cw_delivery_model', 'CW Delivery Model',      'text',   'field', false, NULL, NULL),
    (13, 'scope_tower_erection',    'Tower Erection',   'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (14, 'scope_site_adaption',     'Site Adaption',    'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (15, 'scope_gecol_power',       'GECOL Power',      'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (16, 'scope_hlc_fiber',         'HLC Fiber',        'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (17, 'scope_te_full',           'TE Full',          'list',   'field', false, '["Yes", "No"]'::jsonb, NULL),
    (18, 'scope_te_ip_router_only', 'TE IP Router Only', 'list',  'field', false, '["Yes", "No"]'::jsonb, NULL),
    (19, 'overall_status',    'Overall Status',         'list',   'field', false, '["Not Started", "Cancelled"]'::jsonb, NULL),
    (20, 'sub_region',        'Sub-region',             'text',   'field', false, NULL, NULL),
    (21, 'latitude',          'Latitude',               'number', 'field', false, NULL, NULL),
    (22, 'longitude',         'Longitude',              'number', 'field', false, NULL, NULL),
    (23, 'address',           'Address',                'text',   'field', false, NULL, NULL),
    (24, 'rf_survey_date',    'RF Survey Date',         'date',   'field', false, NULL, NULL))
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('code', c.code, 'header', c.header, 'type', c.type, 'kind', c.kind, 'required', c.required, 'derived', false,
           'options', c.options, 'allow_other', c.allow_other)) ORDER BY c.ord) FROM c
$$;

-- tpl_sync as built in 0051, with the kind sites
CREATE OR REPLACE FUNCTION tpl_sync(p_template text, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.template_definitions%ROWTYPE; cols jsonb; h text; cs text; cur public.template_versions%ROWTYPE; fsv integer; nv integer; why text;
BEGIN
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF d.kind = 'register' THEN
    cols := public.tpl_columns(d.register_key); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'register fields changed';
  ELSIF d.kind = 'stream' THEN
    cols := public.tpl_stream_columns(d.stream_code); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'stream tasks or fields changed';
  ELSIF d.kind = 'sites' THEN
    cols := public.tpl_sites_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'site template columns or lists changed';
  ELSE
    cols := public.tpl_master_parts(); h := public.tpl_master_hash(cols); cs := public.tpl_master_checksum(cols); why := 'Master columns, tasks or register fields changed';
  END IF;
  SELECT version INTO fsv FROM public.field_set_versions WHERE entity_type::text = d.custom_entity;
  SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  -- nothing changed (the usual case): no lock is taken, so the saves of other screens never wait for this check
  IF FOUND AND cur.field_set_hash IS NOT DISTINCT FROM h THEN RETURN cur.version; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE id = d.id FOR UPDATE;
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
    VALUES (d.id, nv, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, why), public.app_actor());
    UPDATE public.template_definitions SET current_version = nv, updated_at = now() WHERE id = d.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('template_version_issued', 'template', p_template, jsonb_build_object('version', cur.version, 'field_set_hash', cur.field_set_hash),
            jsonb_build_object('version', nv, 'field_set_hash', h, 'columns', jsonb_array_length(cols)), coalesce(p_reason, why), public.app_actor());
    RETURN nv;
  END IF;
  RETURN cur.version;
END $$;

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, module_key, match_keys, sort_order, is_master_format) VALUES
  ('TPL-SITE-NEW', 'New sites', 'مواقع جديدة', 'site', 'sites', 'sites', '[["site_code"]]', 2, false)
ON CONFLICT (template_id) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Validation: one function for the manual form and the template
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_new_code(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT upper(btrim(regexp_replace(coalesce(p_code, ''), '[[:space:]]+', ' ', 'g')))
$$;

CREATE OR REPLACE FUNCTION site_new_err(p_field text, p_code text, p_message text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_array(jsonb_build_object('field', p_field, 'code', p_code, 'message', p_message))
$$;

-- The canonical code of a value of an active list (case-insensitive, spaces and underscores alike), or NULL.
CREATE OR REPLACE FUNCTION site_new_list(p_catalogue text, p_value text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT v.code FROM public.list_values v
  WHERE v.catalogue_code = p_catalogue AND v.is_active
    AND (lower(v.code) = lower(btrim(p_value)) OR replace(lower(v.code), '_', ' ') = replace(lower(btrim(p_value)), '_', ' ')
         OR lower(btrim(p_value)) = ANY (SELECT lower(a) FROM unnest(v.aliases) a))
  ORDER BY v.sort_order, v.code COLLATE "C" LIMIT 1
$$;

-- The clean values of a site proposal and everything wrong with it. p_draft is the draft being re-checked (its own Site ID is not a duplicate).
-- Returns {clean, errors: [{field, code, message}], warnings: [{field, code, message}]}. The checks of the database are the only ones that count.
CREATE OR REPLACE FUNCTION site_new_clean(p_raw jsonb, p_draft uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  raw jsonb := CASE WHEN jsonb_typeof(p_raw) = 'object' THEN p_raw ELSE '{}'::jsonb END;
  allowed text[] := ARRAY['site_code', 'region', 'region_id', 'name', 'name_ar', 'owner_site_id', 'cluster_code', 'delivery_scenario', 'site_scenario', 'site_type',
    'project_phase', 'delivery_batch', 'cw_delivery_model', 'scope_tower_erection', 'scope_site_adaption', 'scope_gecol_power', 'scope_hlc_fiber', 'scope_te_full',
    'scope_te_ip_router_only', 'overall_status', 'sub_region', 'latitude', 'longitude', 'address', 'rf_survey_date'];
  flags text[] := ARRAY['scope_tower_erection', 'scope_site_adaption', 'scope_gecol_power', 'scope_hlc_fiber', 'scope_te_full', 'scope_te_ip_router_only'];
  errs jsonb := '[]'::jsonb; warns jsonb := '[]'::jsonb; clean jsonb := '{}'::jsonb; k text; v text; code text; rid integer; rid2 integer; rtext text; canon text; lat numeric; lon numeric;
  d date; wf uuid; probe uuid; conf jsonb; allow_other boolean; msg text; cl public.clusters%ROWTYPE; short text; lim int;
BEGIN
  -- only the known fields; anything else (a landlord, a phone, an e-mail) is refused: those columns are not loaded (Q469)
  FOR k IN SELECT jsonb_object_keys(raw) LOOP
    IF NOT (k = ANY (allowed)) THEN
      errs := errs || public.site_new_err(left(k, 60), 'unknown_field', 'This field is not accepted. A new site carries its identity and scope only; landlord and contact data are not loaded.');
    ELSIF jsonb_typeof(raw -> k) NOT IN ('string', 'number', 'boolean', 'null') THEN
      errs := errs || public.site_new_err(k, 'invalid', 'A single value is expected.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN RETURN jsonb_build_object('clean', clean, 'errors', errs, 'warnings', warns); END IF;

  -- Site ID: required, a plain code, never used before (a cancelled or voided site keeps its ID), not waiting in another draft
  code := public.site_new_code(raw ->> 'site_code');
  IF code = '' THEN
    errs := errs || public.site_new_err('site_code', 'required', 'The Site ID is required.');
  ELSIF code !~ '^[A-Z0-9]([A-Z0-9 ._/-]{0,38}[A-Z0-9])?$' THEN
    errs := errs || public.site_new_err('site_code', 'invalid', 'A Site ID uses Latin letters, digits, space, dot, dash, underscore or slash (for example TR001).');
  ELSE
    clean := clean || jsonb_build_object('site_code', code);
    IF EXISTS (SELECT 1 FROM public.sites s WHERE public.site_new_code(s.site_code) = code) THEN
      errs := errs || public.site_new_err('site_code', 'duplicate', 'This Site ID exists already. A Site ID is never reused, also when the site is cancelled or voided.');
    ELSIF EXISTS (SELECT 1 FROM public.site_drafts d WHERE d.site_code = code AND d.status IN ('entry', 'in_approval') AND d.id IS DISTINCT FROM p_draft) THEN
      errs := errs || public.site_new_err('site_code', 'duplicate', 'A site with this Site ID is already waiting for approval.');
    END IF;
  END IF;

  -- Region: an id, or a name, code or alias (region_aliases, P3)
  rtext := nullif(btrim(raw ->> 'region'), '');
  IF nullif(btrim(raw ->> 'region_id'), '') IS NOT NULL THEN
    IF (raw ->> 'region_id') ~ '^[0-9]{1,3}$' THEN
      SELECT id INTO rid FROM public.regions WHERE id = (raw ->> 'region_id')::int;
    END IF;
    IF rid IS NULL THEN errs := errs || public.site_new_err('region', 'unknown_region', 'Unknown region.'); END IF;
  END IF;
  IF rtext IS NOT NULL THEN
    rid2 := public.imp_region_resolve(rtext);
    IF rid2 IS NULL THEN
      errs := errs || public.site_new_err('region', 'unknown_region', 'Unknown region. Use a region name, its code or a known alias (Settings, region aliases).');
    ELSIF rid IS NOT NULL AND rid <> rid2 THEN
      errs := errs || public.site_new_err('region', 'region_mismatch', 'Region and region ID name different regions.');
    ELSE rid := rid2; END IF;
  END IF;
  IF rid IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(errs) e WHERE e ->> 'field' = 'region') THEN
    errs := errs || public.site_new_err('region', 'required', 'The region is required.');
  END IF;
  IF rid IS NOT NULL THEN clean := clean || jsonb_build_object('region_id', rid); END IF;

  -- names and plain text fields
  FOREACH k IN ARRAY ARRAY['name', 'name_ar', 'owner_site_id', 'sub_region', 'project_phase', 'delivery_batch', 'cw_delivery_model', 'address'] LOOP
    v := nullif(btrim(regexp_replace(coalesce(raw ->> k, ''), '[[:cntrl:]]', '', 'g')), '');
    IF v IS NULL THEN
      IF k = 'name' THEN errs := errs || public.site_new_err('name', 'required', 'The English site name is required.'); END IF;
      CONTINUE;
    END IF;
    lim := CASE WHEN k = 'address' THEN 500 WHEN k IN ('name', 'name_ar') THEN 200 ELSE 80 END;
    IF char_length(v) > lim THEN
      errs := errs || public.site_new_err(k, 'too_long', 'This text is too long.');
    ELSE clean := clean || jsonb_build_object(k, v); END IF;
  END LOOP;

  -- cluster: it must exist in the site's region (or be global), or it is created when L2 approves (a warning tells the reviewer)
  v := nullif(btrim(regexp_replace(coalesce(raw ->> 'cluster_code', ''), '[[:space:]]+', ' ', 'g')), '');
  IF v IS NOT NULL THEN
    IF v !~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,38}$' THEN
      errs := errs || public.site_new_err('cluster_code', 'invalid', 'A cluster code uses letters, digits, space, dot, dash or underscore.');
    ELSE
      SELECT * INTO cl FROM public.clusters c WHERE upper(c.cluster_code) = upper(v);
      IF FOUND THEN
        IF NOT cl.is_global AND rid IS NOT NULL AND cl.region_id IS DISTINCT FROM rid THEN
          errs := errs || public.site_new_err('cluster_code', 'cluster_other_region', 'This cluster belongs to another region.');
        ELSE clean := clean || jsonb_build_object('cluster_code', cl.cluster_code); END IF;
      ELSE
        clean := clean || jsonb_build_object('cluster_code', upper(v));
        warns := warns || public.site_new_err('cluster_code', 'cluster_will_be_created', 'This cluster does not exist yet: it is created in the region of the site when L2 approves.');
      END IF;
    END IF;
  END IF;

  -- delivery scenario: the DeliveryScenario list (stored as its code)
  v := nullif(btrim(raw ->> 'delivery_scenario'), '');
  IF v IS NULL THEN
    errs := errs || public.site_new_err('delivery_scenario', 'required', 'The delivery scenario is required.');
  ELSIF NOT (replace(lower(v), ' ', '_') = ANY (enum_range(NULL::"DeliveryScenario")::text[]))
        OR public.site_new_list('DeliveryScenario', v) IS NULL THEN
    errs := errs || public.site_new_err('delivery_scenario', 'not_in_list', 'Not a delivery scenario: New Build, Expansion, Hot Swap, Cold Swap or Relocation.');
  ELSE clean := clean || jsonb_build_object('delivery_scenario', replace(lower(v), ' ', '_')); END IF;

  -- the other lists
  FOREACH k IN ARRAY ARRAY['site_scenario', 'site_type'] LOOP
    v := nullif(btrim(raw ->> k), '');
    CONTINUE WHEN v IS NULL;
    canon := public.site_new_list(CASE k WHEN 'site_scenario' THEN 'SiteScenario' ELSE 'SiteType' END, v);
    IF canon IS NOT NULL THEN clean := clean || jsonb_build_object(k, canon);
    ELSE
      SELECT c.allow_other INTO allow_other FROM public.list_catalogues c WHERE c.code = CASE k WHEN 'site_scenario' THEN 'SiteScenario' ELSE 'SiteType' END;
      IF coalesce(allow_other, false) AND char_length(v) <= 80 THEN
        clean := clean || jsonb_build_object(k, v);
        warns := warns || public.site_new_err(k, 'list_other', 'This value is not in the list; the list allows another value.');
      ELSE errs := errs || public.site_new_err(k, 'not_in_list', 'Not a value of the list.'); END IF;
    END IF;
  END LOOP;

  -- scope flags: Yes, No (N/A) or blank
  FOREACH k IN ARRAY flags LOOP
    v := lower(btrim(coalesce(raw ->> k, '')));
    CONTINUE WHEN v = '';
    IF v IN ('yes', 'y', 'true', '1') THEN clean := clean || jsonb_build_object(k, 'yes');
    ELSIF v IN ('no', 'n', 'n/a', 'na', 'false', '0') THEN clean := clean || jsonb_build_object(k, 'na');
    ELSE errs := errs || public.site_new_err(k, 'invalid', 'Yes, No or blank.'); END IF;
  END LOOP;

  -- the overall status of a new site: Not Started, or Cancelled (a cancelled site of the Master still has its history, Q466)
  v := nullif(replace(lower(btrim(coalesce(raw ->> 'overall_status', ''))), ' ', '_'), '');
  IF v IS NOT NULL THEN
    IF v IN ('not_started', 'cancelled') THEN clean := clean || jsonb_build_object('overall_status', v);
    ELSE errs := errs || public.site_new_err('overall_status', 'invalid', 'A new site is Not Started, or Cancelled. Other statuses follow the work.'); END IF;
  END IF;

  -- coordinates: both or none, in range
  lat := NULL; lon := NULL;
  IF nullif(btrim(coalesce(raw ->> 'latitude', '')), '') IS NOT NULL THEN
    IF btrim(raw ->> 'latitude') ~ '^-?[0-9]{1,2}(\.[0-9]+)?$' AND abs((btrim(raw ->> 'latitude'))::numeric) <= 90 THEN lat := round((btrim(raw ->> 'latitude'))::numeric, 6);
    ELSE errs := errs || public.site_new_err('latitude', 'invalid', 'A latitude is a number from -90 to 90.'); END IF;
  END IF;
  IF nullif(btrim(coalesce(raw ->> 'longitude', '')), '') IS NOT NULL THEN
    IF btrim(raw ->> 'longitude') ~ '^-?[0-9]{1,3}(\.[0-9]+)?$' AND abs((btrim(raw ->> 'longitude'))::numeric) <= 180 THEN lon := round((btrim(raw ->> 'longitude'))::numeric, 6);
    ELSE errs := errs || public.site_new_err('longitude', 'invalid', 'A longitude is a number from -180 to 180.'); END IF;
  END IF;
  IF (nullif(btrim(coalesce(raw ->> 'latitude', '')), '') IS NULL) <> (nullif(btrim(coalesce(raw ->> 'longitude', '')), '') IS NULL) THEN
    errs := errs || public.site_new_err(CASE WHEN nullif(btrim(coalesce(raw ->> 'latitude', '')), '') IS NULL THEN 'latitude' ELSE 'longitude' END, 'pair_required', 'Latitude and longitude go together.');
  ELSIF lat IS NOT NULL AND lon IS NOT NULL THEN
    clean := clean || jsonb_build_object('latitude', lat, 'longitude', lon);
    IF lat NOT BETWEEN 19 AND 34 OR lon NOT BETWEEN 9 AND 26 THEN
      warns := warns || public.site_new_err('latitude', 'outside_libya', 'These coordinates are outside Libya. Check them.');
    END IF;
  END IF;

  -- date
  v := nullif(btrim(coalesce(raw ->> 'rf_survey_date', '')), '');
  IF v IS NOT NULL THEN
    d := NULL;
    IF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN BEGIN d := v::date; EXCEPTION WHEN others THEN d := NULL; END; END IF;
    IF d IS NULL OR d < DATE '2000-01-01' THEN errs := errs || public.site_new_err('rf_survey_date', 'invalid', 'A date as yyyy-mm-dd, from 2000-01-01.');
    ELSIF d > public.cal_today() THEN errs := errs || public.site_new_err('rf_survey_date', 'future_date', 'An actual date cannot be in the future.');
    ELSE clean := clean || jsonb_build_object('rf_survey_date', d::text); END IF;
  END IF;

  -- the scenario rules (P1, Q3): a probe site in a subtransaction that is rolled back says whether the scope and the scenario conflict
  IF jsonb_array_length(errs) = 0 THEN
    wf := public.active_workflow_id();
    IF wf IS NULL OR NOT public.wf_is_published(wf) THEN
      errs := errs || public.site_new_err('delivery_scenario', 'no_workflow', 'There is no published workflow version to create a site on.');
    ELSE
      BEGIN
        INSERT INTO public.sites (site_code, name, region_id, workflow_version_id, delivery_scenario, scope_tower_erection, scope_site_adaption, scope_gecol_power, scope_hlc_fiber,
          scope_te_full, scope_te_ip_router_only, updated_at)
        VALUES ('PROBE-' || gen_random_uuid()::text, 'probe', rid, wf, (clean ->> 'delivery_scenario')::"DeliveryScenario",
          coalesce((clean ->> 'scope_tower_erection')::"ScopeFlag", 'na'), coalesce((clean ->> 'scope_site_adaption')::"ScopeFlag", 'na'),
          coalesce((clean ->> 'scope_gecol_power')::"ScopeFlag", 'na'), coalesce((clean ->> 'scope_hlc_fiber')::"ScopeFlag", 'na'),
          coalesce((clean ->> 'scope_te_full')::"ScopeFlag", 'na'), coalesce((clean ->> 'scope_te_ip_router_only')::"ScopeFlag", 'na'), now()) RETURNING id INTO probe;
        conf := public.scope_scenario_conflicts(probe);
        RAISE EXCEPTION 'site_new:probe_done';
      EXCEPTION WHEN others THEN
        IF SQLERRM <> 'site_new:probe_done' THEN
          errs := errs || public.site_new_err('delivery_scenario', 'invalid', 'The site could not be checked against the scenario rules.');
          conf := NULL;
        END IF;
      END;
      IF conf IS NOT NULL AND jsonb_array_length(conf) > 0 THEN
        short := left(coalesce(conf -> 0 ->> 'message', 'The scenario and the scope flags disagree.'), 300);
        errs := errs || public.site_new_err('delivery_scenario', 'scope_scenario_conflict', short);
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('clean', clean, 'errors', errs, 'warnings', warns);
END $$;

-- Is the actor (or p_user) a holder of the Entry (L1) or Approve (L2) level of the Site creation row of the Matrix in this region?
CREATE OR REPLACE FUNCTION site_new_holds(p_region integer, p_kind text, p_user uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.reg_eligible_cell(public.reg_cell_row('site_creation', p_region, p_kind), p_region, 'sites', p_kind::"PermissionLevel") e
                 WHERE e.user_id = coalesce(p_user, public.app_actor()))
$$;

-- The right of the grid in the region (null = every region): create for L1, approve for L2.
CREATE OR REPLACE FUNCTION site_new_may(p_action text, p_region integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r int[];
BEGIN
  IF public.app_actor() IS NULL THEN RETURN false; END IF;
  r := public.wf_actor_regions('sites', p_action::"PermissionAction");
  RETURN r IS NULL OR p_region = ANY (r);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. wf_apply_applicability: the wrapper that p4a_hook looks for
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wf_apply_applicability(p_site uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sites WHERE id = p_site) THEN RETURN NULL; END IF;
  -- a scope and scenario conflict is reported by the caller (P4a answers 422 scope_scenario_conflict); nothing is changed while it stands
  IF jsonb_array_length(public.scope_scenario_conflicts(p_site)) > 0 THEN
    RETURN jsonb_build_object('site_id', p_site, 'skipped', 'scope_scenario_conflict', 'changed', '[]'::jsonb, 'kept', '[]'::jsonb);
  END IF;
  RETURN public.wf_apply_applicability_core(p_site, 'the scenario or the scope of the site changed (approved change)');
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The one writer: a site is created only here, when L2 approves
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_create_apply(p_draft uuid, p_self boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d public.site_drafts%ROWTYPE; v jsonb; c jsonb; wf uuid := public.active_workflow_id(); sid uuid; cid uuid; ccode text; created_cluster boolean := false; t record; s jsonb;
  actor uuid := public.app_actor(); first_seq int; applied jsonb; errs jsonb := '[]'::jsonb; e jsonb; why text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.site_drafts WHERE id = p_draft FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The draft does not exist.')); END IF;
  IF d.status NOT IN ('entry', 'in_approval') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The draft is ' || d.status || '.'));
  END IF;
  -- checked again now: a Site ID, a list or a rule may have changed since the draft was entered
  v := public.site_new_clean(d.data, d.id);
  IF jsonb_array_length(v -> 'errors') > 0 THEN
    FOR e IN SELECT * FROM jsonb_array_elements(v -> 'errors') LOOP
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || (e ->> 'field'), 'code', e ->> 'code', 'message', e ->> 'message'));
    END LOOP;
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs, 'detail', 'The site cannot be created: ' || coalesce(errs -> 0 ->> 'message', 'a value is not valid') ));
  END IF;
  c := v -> 'clean';
  IF wf IS NULL OR NOT public.wf_is_published(wf) THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'There is no published workflow version.')); END IF;

  -- the cluster of the row: an existing one, or a new one in the site's region
  IF c ->> 'cluster_code' IS NOT NULL THEN
    SELECT id INTO cid FROM public.clusters WHERE upper(cluster_code) = upper(c ->> 'cluster_code');
    IF cid IS NULL THEN
      INSERT INTO public.clusters (cluster_code, region_id, is_global) VALUES (c ->> 'cluster_code', (c ->> 'region_id')::int, false) RETURNING id INTO cid;
      created_cluster := true;
      PERFORM public.log_audit_write('cluster_create', 'cluster', cid::text, NULL, jsonb_build_object('cluster_code', c ->> 'cluster_code', 'region_id', (c ->> 'region_id')::int),
        'created with the first site of the cluster (site creation, draft ' || d.id::text || ')', NULL, (c ->> 'region_id')::int);
    END IF;
  END IF;

  INSERT INTO public.sites (site_code, owner_site_id, name, name_ar, region_id, workflow_version_id, sub_region, cluster_id, latitude, longitude, address, site_type, site_scenario,
    project_phase, delivery_batch, delivery_scenario, cw_delivery_model, rf_survey_date, scope_tower_erection, scope_site_adaption, scope_gecol_power, scope_hlc_fiber,
    scope_te_full, scope_te_ip_router_only, overall_status, updated_at)
  VALUES (c ->> 'site_code', c ->> 'owner_site_id', c ->> 'name', c ->> 'name_ar', (c ->> 'region_id')::int, wf, c ->> 'sub_region', cid,
    (c ->> 'latitude')::numeric, (c ->> 'longitude')::numeric, c ->> 'address', c ->> 'site_type', c ->> 'site_scenario', c ->> 'project_phase', c ->> 'delivery_batch',
    (c ->> 'delivery_scenario')::"DeliveryScenario", c ->> 'cw_delivery_model', (c ->> 'rf_survey_date')::date,
    coalesce((c ->> 'scope_tower_erection')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_site_adaption')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_gecol_power')::"ScopeFlag", 'na'),
    coalesce((c ->> 'scope_hlc_fiber')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_te_full')::"ScopeFlag", 'na'), coalesce((c ->> 'scope_te_ip_router_only')::"ScopeFlag", 'na'),
    'not_started', clock_timestamp())
  RETURNING id INTO sid;

  -- every task of the workflow version in force, locked, with its levels and SLA rule (the pattern of admin_migrate_sites_to_workflow)
  INSERT INTO public.task_instances (site_id, region_id, task_def_id, state, levels_required, sla_rule_id, updated_at)
  SELECT s2.id, s2.region_id, td.id, 'locked', coalesce(td.approval_levels, st.approval_levels), public.sla_rule_for(td.id, s2.delivery_scenario, s2.region_id, current_date), now()
  FROM public.sites s2 JOIN public.task_definitions td ON td.workflow_id = wf AND td.is_active JOIN public.stage_definitions st ON st.id = td.stage_id AND st.is_active
  WHERE s2.id = sid;

  -- the engine opens the first tasks: those of the first stage that wait for no predecessor (a dismantle task is opened by hand, Q382)
  SELECT min(st.seq) INTO first_seq FROM public.stage_definitions st WHERE st.workflow_id = wf AND st.is_active;
  FOR t IN SELECT ti.id FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.stage_definitions st ON st.id = td.stage_id
           WHERE ti.site_id = sid AND st.seq = first_seq AND NOT EXISTS (SELECT 1 FROM public.task_predecessors p WHERE p.task_def_id = td.id) ORDER BY td.sort_order, td.code LOOP
    PERFORM public.wf_open_locked(t.id, 'site created');
  END LOOP;

  why := 'site created (' || CASE WHEN d.batch_id IS NOT NULL THEN 'batch ' || d.batch_id::text || ' row ' || coalesce(d.batch_row_id::text, '?') ELSE 'draft ' || d.id::text END || ')';
  -- the scenario applicability of P1: tasks that the scenario and the scope flags make N/A, and the chain that follows
  applied := public.wf_apply_applicability_core(sid, why);

  UPDATE public.site_drafts SET status = 'approved', site_id = sid, decided_by = actor, decided_at = clock_timestamp(), self_approval = p_self, version = version + 1, updated_at = clock_timestamp()
  WHERE id = d.id;

  SELECT jsonb_build_object('site_code', s3.site_code, 'name', s3.name, 'name_ar', s3.name_ar, 'region_id', s3.region_id, 'cluster_code', c ->> 'cluster_code',
           'cluster_created', created_cluster, 'delivery_scenario', s3.delivery_scenario, 'workflow_version_id', s3.workflow_version_id, 'tasks', (SELECT count(*) FROM public.task_instances WHERE site_id = sid),
           'applicability_changed', jsonb_array_length(applied -> 'changed'), 'draft_id', d.id, 'batch_id', d.batch_id, 'batch_row_id', d.batch_row_id,
           'self_approval', p_self, 'created_by', d.created_by)
    INTO s FROM public.sites s3 WHERE s3.id = sid;
  PERFORM public.log_audit_write('site_create', 'site', sid::text, NULL, s, why, sid, (c ->> 'region_id')::int);

  -- Q466: a Cancelled row creates the site and then cancels it, so its history exists
  IF c ->> 'overall_status' = 'cancelled' THEN
    UPDATE public.sites SET overall_status = 'cancelled', updated_at = clock_timestamp() WHERE id = sid;
    PERFORM public.log_audit_write('site_cancelled', 'site', sid::text, jsonb_build_object('overall_status', 'not_started'), jsonb_build_object('overall_status', 'cancelled'),
      'created as Cancelled (Q466): ' || why, sid, (c ->> 'region_id')::int);
  END IF;
  PERFORM public.calc_refresh_site(sid);
  RETURN sid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. The manual way: draft, edit, submit to L2, decide, discard
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION site_draft_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT to_jsonb(d) FROM public.site_drafts d WHERE d.id = p_id
$$;

CREATE OR REPLACE FUNCTION site_draft_errors(p_errs jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('path', '/' || (e ->> 'field'), 'code', e ->> 'code', 'message', e ->> 'message')), '[]'::jsonb) FROM jsonb_array_elements(p_errs) e
$$;

-- Notifies the L2 holders of the row in the region (in-app), at most 20.
CREATE OR REPLACE FUNCTION site_draft_notify_l2(p_region integer, p_code text, p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE h record;
BEGIN
  FOR h IN SELECT e.user_id FROM public.reg_eligible_cell(public.reg_cell_row('site_creation', p_region, 'approve'), p_region, 'sites', 'approve') e WHERE e.user_id <> public.app_actor() LIMIT 20 LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, region_id, module_key)
    VALUES (h.user_id, 'in_app', 'site_draft_assigned', 'A new site waits for approval', p_code, '/sites/new/' || p_id::text, p_region, 'sites');
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION site_draft_create(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); v jsonb; c jsonb; rid int; nid uuid; r int[];
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  r := public.wf_actor_regions('sites', 'create');
  IF r IS NOT NULL AND cardinality(r) = 0 THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You need create on sites to propose a new site.'));
  END IF;
  v := public.site_new_clean(p_data, NULL);
  IF jsonb_array_length(v -> 'errors') > 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.site_draft_errors(v -> 'errors'), 'detail', 'The new site is not valid.'));
  END IF;
  c := v -> 'clean'; rid := (c ->> 'region_id')::int;
  IF NOT public.site_new_may('create', rid) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You may not create sites in this region.'));
  END IF;
  IF NOT public.site_new_holds(rid, 'entry') THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Data Entry holder (L1) of the Site creation row of the Responsibility Matrix in this region.'));
  END IF;
  INSERT INTO public.site_drafts (site_code, region_id, data, created_by) VALUES (c ->> 'site_code', rid, c, actor) RETURNING id INTO nid;
  PERFORM public.log_audit_write('site_draft_create', 'site_draft', nid::text, NULL, jsonb_build_object('data', c, 'warnings', v -> 'warnings'), NULL, NULL, rid);
  RETURN public.site_draft_json(nid) || jsonb_build_object('warnings', v -> 'warnings');
END $$;

CREATE OR REPLACE FUNCTION site_draft_save(p_id uuid, p_version integer, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); d public.site_drafts%ROWTYPE; v jsonb; c jsonb; rid int; before_ jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.site_drafts x WHERE x.id = p_id AND public.app_region_check(x.region_id) FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The draft does not exist or is not visible to you.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The draft changed since you read it. Reload and try again.')); END IF;
  IF d.status <> 'entry' OR d.batch_id IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN d.batch_id IS NOT NULL THEN 'A row of an uploaded file is changed in the file, not here.' ELSE 'The draft is ' || d.status || ': only a draft in entry can be changed.' END));
  END IF;
  IF NOT (public.site_new_may('create', d.region_id) AND public.site_new_holds(d.region_id, 'entry')) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Data Entry holder (L1) of the Site creation row in this region.'));
  END IF;
  v := public.site_new_clean(p_data, d.id);
  IF jsonb_array_length(v -> 'errors') > 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.site_draft_errors(v -> 'errors'), 'detail', 'The new site is not valid.'));
  END IF;
  c := v -> 'clean'; rid := (c ->> 'region_id')::int;
  IF rid <> d.region_id AND NOT (public.site_new_may('create', rid) AND public.site_new_holds(rid, 'entry')) THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'You may not create sites in this region.'));
  END IF;
  before_ := jsonb_build_object('data', d.data);
  UPDATE public.site_drafts SET site_code = c ->> 'site_code', region_id = rid, data = c, version = version + 1, updated_at = clock_timestamp() WHERE id = d.id;
  PERFORM public.log_audit_write('site_draft_update', 'site_draft', d.id::text, before_, jsonb_build_object('data', c), NULL, NULL, rid);
  RETURN public.site_draft_json(d.id) || jsonb_build_object('warnings', v -> 'warnings');
END $$;

CREATE OR REPLACE FUNCTION site_draft_submit(p_id uuid, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); d public.site_drafts%ROWTYPE; v jsonb; self boolean; sid uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.site_drafts x WHERE x.id = p_id AND public.app_region_check(x.region_id) FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The draft does not exist or is not visible to you.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The draft changed since you read it. Reload and try again.')); END IF;
  IF d.status <> 'entry' OR d.batch_id IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The draft is ' || d.status || ': it cannot be submitted.'));
  END IF;
  IF NOT (public.site_new_may('create', d.region_id) AND public.site_new_holds(d.region_id, 'entry')) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Data Entry holder (L1) of the Site creation row in this region.'));
  END IF;
  v := public.site_new_clean(d.data, d.id);
  IF jsonb_array_length(v -> 'errors') > 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.site_draft_errors(v -> 'errors'), 'detail', 'The new site is not valid.'));
  END IF;
  self := public.site_new_holds(d.region_id, 'approve') AND public.site_new_may('approve', d.region_id);
  UPDATE public.site_drafts SET status = 'in_approval', submitted_by = actor, submitted_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp() WHERE id = d.id;
  PERFORM public.log_audit_write('site_draft_submit', 'site_draft', d.id::text, jsonb_build_object('status', 'entry'), jsonb_build_object('status', 'in_approval', 'self_approval', self), NULL, NULL, d.region_id);
  IF self THEN
    -- the same person holds L1 and L2: the submission is the final approval (B5), with step-up, flagged
    IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
    sid := public.site_create_apply(d.id, true);
  ELSE
    PERFORM public.site_draft_notify_l2(d.region_id, d.site_code, d.id);
  END IF;
  RETURN public.site_draft_json(d.id);
END $$;

-- L2: approve (the site is created; step-up) or reject (back to L1 with a note)
CREATE OR REPLACE FUNCTION site_draft_decide(p_id uuid, p_version integer, p_action text, p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); d public.site_drafts%ROWTYPE; sid uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_action NOT IN ('approve', 'reject') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'approve or reject.'))));
  END IF;
  SELECT * INTO d FROM public.site_drafts x WHERE x.id = p_id AND public.app_region_check(x.region_id) FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The draft does not exist or is not visible to you.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The draft changed since you read it. Reload and try again.')); END IF;
  IF d.status <> 'in_approval' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The draft is ' || d.status || ': it is not waiting for a decision.'));
  END IF;
  IF d.batch_id IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'This site comes from an uploaded file: decide it in its batch.'));
  END IF;
  IF NOT (public.site_new_may('approve', d.region_id) AND public.site_new_holds(d.region_id, 'approve')) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Review and Approve holder (L2) of the Site creation row of the Responsibility Matrix in this region.'));
  END IF;
  IF p_action = 'reject' THEN
    IF coalesce(btrim(p_note), '') = '' THEN PERFORM public.wf_err('note_required'); END IF;
    UPDATE public.site_drafts SET status = 'entry', return_count = return_count + 1, last_return_note = left(btrim(p_note), 2000), decision_note = left(btrim(p_note), 2000),
      decided_by = actor, decided_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp() WHERE id = d.id;
    PERFORM public.log_audit_write('site_draft_return', 'site_draft', d.id::text, jsonb_build_object('status', 'in_approval'), jsonb_build_object('status', 'entry', 'note', left(btrim(p_note), 2000)), p_note, NULL, d.region_id);
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, region_id, module_key)
    VALUES (d.created_by, 'in_app', 'site_draft_returned', 'A new site was returned to you', d.site_code || ': ' || left(btrim(p_note), 200), '/sites/new/' || d.id::text, d.region_id, 'sites');
  ELSE
    IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
    sid := public.site_create_apply(d.id, d.created_by = actor);
    IF d.created_by <> actor THEN
      INSERT INTO public.notifications (user_id, channel, kind, title, body, link, region_id, module_key)
      VALUES (d.created_by, 'in_app', 'site_draft_approved', 'A new site was approved', d.site_code, '/sites/' || sid::text, d.region_id, 'sites');
    END IF;
  END IF;
  RETURN public.site_draft_json(d.id);
END $$;

CREATE OR REPLACE FUNCTION site_draft_discard(p_id uuid, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor uuid := public.app_actor(); d public.site_drafts%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.site_drafts x WHERE x.id = p_id AND public.app_region_check(x.region_id) FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The draft does not exist or is not visible to you.')); END IF;
  IF p_version IS NOT NULL AND p_version <> d.version THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The draft changed since you read it. Reload and try again.')); END IF;
  IF d.status <> 'entry' OR d.batch_id IS NOT NULL THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a draft in entry can be discarded.'));
  END IF;
  IF d.created_by <> actor AND NOT public.app_actor_is_system_admin() THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who entered the draft (or a System Admin) can discard it.'));
  END IF;
  UPDATE public.site_drafts SET status = 'discarded', decided_by = actor, decided_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp() WHERE id = d.id;
  PERFORM public.log_audit_write('site_draft_discard', 'site_draft', d.id::text, jsonb_build_object('status', 'entry'), jsonb_build_object('status', 'discarded'), NULL, NULL, d.region_id);
  RETURN public.site_draft_json(d.id);
END $$;

-- What the caller may do with a draft now (for the screens), and the warnings of a draft (a cluster that will be created ...).
CREATE OR REPLACE FUNCTION site_draft_actions(p_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.site_drafts%ROWTYPE; a uuid := public.app_actor(); acts text[] := ARRAY[]::text[];
BEGIN
  IF a IS NULL THEN RETURN acts; END IF;
  SELECT * INTO d FROM public.site_drafts x WHERE x.id = p_id AND public.app_region_check(x.region_id);
  IF NOT FOUND OR d.batch_id IS NOT NULL THEN RETURN acts; END IF;
  IF d.status = 'entry' AND public.site_new_may('create', d.region_id) AND public.site_new_holds(d.region_id, 'entry') THEN
    acts := ARRAY['edit', 'submit'];
    IF d.created_by = a OR public.app_actor_is_system_admin() THEN acts := acts || ARRAY['discard']; END IF;
  ELSIF d.status = 'in_approval' AND public.site_new_may('approve', d.region_id) AND public.site_new_holds(d.region_id, 'approve') THEN
    acts := ARRAY['approve', 'reject'];
  END IF;
  RETURN acts;
END $$;

CREATE OR REPLACE FUNCTION site_draft_warnings(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.site_drafts%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT * INTO d FROM public.site_drafts x WHERE x.id = p_id AND public.app_region_check(x.region_id);
  IF NOT FOUND OR d.status NOT IN ('entry', 'in_approval') THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce(public.site_new_clean(d.data, d.id) -> 'warnings', '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. The bulk way: stage, send, decide
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION imp_stage_site_batch(p_template text, p_version integer, p_checksum text, p_file_name text, p_sha text, p_rows jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); d public.template_definitions%ROWTYPE; v public.template_versions%ROWTYPE; cols jsonb; r_import int[]; r_create int[]; el jsonb; raw jsonb;
  res jsonb; errs jsonb; e jsonb; region int; ckey text; seen jsonb := '{}'::jsonb; results jsonb := '[]'::jsonb; bid uuid := gen_random_uuid(); n_rows int; n_err int; regions int[];
  diffj jsonb; k text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active AND kind = 'sites';
  IF NOT FOUND THEN PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'template_unknown_or_inactive', 'detail', 'This template does not exist or is no longer in use.')); END IF;
  SELECT * INTO v FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF v.version <> p_version THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file was made from version ' || p_version || ' of ' || p_template || '; the current version is ' || v.version || '. Download the template again.'));
  END IF;
  IF v.header_checksum <> p_checksum THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
  END IF;
  r_import := public.wf_actor_regions('templates', 'import');
  r_create := public.wf_actor_regions('sites', 'create');
  IF (r_import IS NOT NULL AND cardinality(r_import) = 0) OR (r_create IS NOT NULL AND cardinality(r_create) = 0) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'import_not_allowed', 'detail', 'You may not create sites from a file.'));
  END IF;
  cols := v.columns;

  FOR el IN SELECT x FROM jsonb_array_elements(p_rows) x LOOP
    raw := coalesce(el -> 'data', '{}'::jsonb) || CASE WHEN nullif(el ->> 'site_code', '') IS NOT NULL THEN jsonb_build_object('site_code', el ->> 'site_code') ELSE '{}'::jsonb END;
    errs := coalesce(el -> 'pre_errors', '[]'::jsonb);
    res := public.site_new_clean(raw, NULL);
    FOR e IN SELECT * FROM jsonb_array_elements(res -> 'errors') LOOP
      errs := errs || jsonb_build_array(public.imp_cell_err(cols, e ->> 'field', e ->> 'code', e ->> 'message'));
    END LOOP;
    region := (res -> 'clean' ->> 'region_id')::int;
    ckey := res -> 'clean' ->> 'site_code';
    IF ckey IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(errs) x WHERE x ->> 'field' = 'site_code') THEN
      IF seen ? ckey THEN
        errs := errs || jsonb_build_array(public.imp_cell_err(cols, 'site_code', 'duplicate_in_file', 'Row ' || (seen ->> ckey) || ' of this file has the same Site ID.'));
      ELSE seen := seen || jsonb_build_object(ckey, el ->> 'row_no'); END IF;
    END IF;
    IF jsonb_array_length(errs) = 0 AND region IS NOT NULL THEN
      IF NOT public.imp_region_ok(r_import, region) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('code', 'region_forbidden', 'message', 'You may not import in this region.'));
      ELSIF NOT public.imp_region_ok(r_create, region) THEN
        errs := errs || jsonb_build_array(jsonb_build_object('code', 'action_forbidden', 'message', 'You may not create sites in this region.'));
      ELSIF NOT public.site_new_holds(region, 'entry') THEN
        errs := errs || jsonb_build_array(jsonb_build_object('code', 'not_entry_holder', 'message', 'You are not a Data Entry holder (L1) of the Site creation row of the Matrix in this region.'));
      END IF;
    END IF;
    diffj := '{}'::jsonb;
    IF jsonb_array_length(errs) = 0 THEN
      FOR k IN SELECT jsonb_object_keys(res -> 'clean') LOOP
        diffj := diffj || jsonb_build_object(k, jsonb_build_object('old', NULL, 'new', res -> 'clean' -> k));
      END LOOP;
    END IF;
    results := results || jsonb_build_array(jsonb_build_object('row_no', (el ->> 'row_no')::int, 'sheet', coalesce(el ->> 'sheet', 'Data'), 'site_code', ckey, 'region', region,
      'action', CASE WHEN jsonb_array_length(errs) = 0 THEN 'create' ELSE 'error' END, 'errors', errs, 'diff', diffj, 'payload', jsonb_build_object('data', res -> 'clean'), 'warnings', res -> 'warnings'));
  END LOOP;

  SELECT coalesce(array_agg(DISTINCT (t ->> 'region')::int) FILTER (WHERE t ->> 'action' <> 'error' AND t ->> 'region' IS NOT NULL), ARRAY[]::int[]), count(*), count(*) FILTER (WHERE t ->> 'action' = 'error')
    INTO regions, n_rows, n_err FROM jsonb_array_elements(results) t;
  INSERT INTO public.import_batches (id, template_version_id, source, file_name, file_sha256, status, uploaded_by, region_scope, rows_total, rows_error, entity)
  VALUES (bid, v.id, 'template', left(p_file_name, 200), p_sha, 'validated', actor, regions, n_rows, n_err, 'site');
  INSERT INTO public.import_batch_rows (batch_id, row_no, sheet, site_code, region_id, target_entity, action, payload, diff, errors, decision, row_key, warnings)
  SELECT bid, (t ->> 'row_no')::int, t ->> 'sheet', t ->> 'site_code', (t ->> 'region')::int, 'site', t ->> 'action', t -> 'payload', CASE WHEN t ->> 'action' = 'error' THEN '{}'::jsonb ELSE t -> 'diff' END,
         t -> 'errors', 'pending', t ->> 'site_code', CASE WHEN jsonb_array_length(t -> 'warnings') > 0 THEN t -> 'warnings' END
  FROM jsonb_array_elements(results) t ORDER BY (t ->> 'row_no')::int;
  PERFORM public.log_audit_write('import_batch_create', 'import_batch', bid::text, NULL,
    jsonb_build_object('template_id', p_template, 'template_version', v.version, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'rows', n_rows, 'errors', n_err,
      'create', n_rows - n_err), NULL);
  RETURN bid;
END $$;

-- The uploader (L1) sends the valid rows: each becomes a draft waiting for L2. A person who holds both levels approves at once (B5, step-up).
CREATE OR REPLACE FUNCTION imp_submit_site_batch(p_batch uuid, p_version integer, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.import_batch_rows%ROWTYPE; v jsonb; c jsonb; rid int; did uuid; sid uuid; self boolean; submitted int := 0;
  held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; msg text; new_st text; code text;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF b.uploaded_by <> actor THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can send it into the flow.'));
  END IF;
  IF b.status NOT IN ('validated', 'in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The batch is ' || b.status || ': it cannot be sent.'));
  END IF;
  FOR r IN SELECT * FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.action = 'create' AND x.decision = 'pending' AND x.site_draft_id IS NULL ORDER BY x.row_no LOOP
    BEGIN
      v := public.site_new_clean(r.payload -> 'data', NULL);
      IF jsonb_array_length(v -> 'errors') > 0 THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.site_draft_errors(v -> 'errors'), 'detail', coalesce(v -> 'errors' -> 0 ->> 'message', 'The row is not valid.')));
      END IF;
      c := v -> 'clean'; rid := (c ->> 'region_id')::int;
      IF NOT (public.site_new_may('create', rid) AND public.site_new_holds(rid, 'entry')) THEN
        PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Data Entry holder (L1) of the Site creation row of the Matrix in this region.'));
      END IF;
      INSERT INTO public.site_drafts (site_code, region_id, data, status, created_by, submitted_by, submitted_at, batch_id, batch_row_id)
      VALUES (c ->> 'site_code', rid, c, 'in_approval', actor, actor, clock_timestamp(), p_batch, r.id) RETURNING id INTO did;
      UPDATE public.import_batch_rows SET site_draft_id = did WHERE id = r.id;
      self := public.site_new_holds(rid, 'approve') AND public.site_new_may('approve', rid);
      IF self THEN
        IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
        sid := public.site_create_apply(did, true);
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), site_id = sid WHERE id = r.id;
      END IF;
      submitted := submitted + 1;
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be sent', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The row could not be sent. See the System Log (template-check) for the technical reason.' END;
      code := coalesce(j ->> 'code', 'row_failed');
      UPDATE public.import_batch_rows SET action = 'error', decision = 'pending', site_draft_id = NULL, diff = '{}'::jsonb,
        errors = jsonb_build_array(jsonb_build_object('code', code, 'message', left(msg, 300))) WHERE id = r.id;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', code, 'message', left(msg, 300)));
    END;
  END LOOP;
  new_st := CASE WHEN submitted > 0 OR b.status <> 'validated' THEN public.imp_status_of_after(p_batch) ELSE b.status END;
  UPDATE public.import_batches SET status = new_st, version = version + 1, submitted_at = coalesce(submitted_at, now()), submitted_by = coalesce(submitted_by, actor),
    rows_error = (SELECT count(*) FROM public.import_batch_rows WHERE batch_id = p_batch AND action = 'error') WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_submit', 'import_batch', p_batch::text, NULL,
    jsonb_build_object('submitted', submitted, 'held', 0, 'failed', jsonb_array_length(failed), 'status', new_st), NULL);
  -- the L2 holders are told once per region of the batch
  IF submitted > 0 THEN
    FOR rid IN SELECT DISTINCT x.region_id FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.site_draft_id IS NOT NULL AND x.decision = 'pending' AND x.region_id IS NOT NULL LOOP
      PERFORM public.site_draft_notify_l2(rid, b.file_name, (SELECT x.site_draft_id FROM public.import_batch_rows x WHERE x.batch_id = p_batch AND x.region_id = rid AND x.site_draft_id IS NOT NULL LIMIT 1));
    END LOOP;
  END IF;
  RETURN jsonb_build_object('submitted', submitted, 'held', held, 'failed', failed);
END $$;

-- L2 decides the rows of a New sites batch one by one or all at once; approval creates the site (step-up), a return needs a note.
CREATE OR REPLACE FUNCTION imp_decide_site_batch(p_batch uuid, p_version integer, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.v_import_rows%ROWTYPE; dr public.site_drafts%ROWTYPE; item jsonb; act text; rnote text;
  decided int := 0; approved int := 0; rejected int := 0; held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; first_forbidden text; new_st text; msg text; sid uuid;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF p_action NOT IN ('approve', 'reject', 'discard') OR p_scope NOT IN ('all', 'rows') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope: a site has two levels, approve or reject.'))));
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
    PERFORM public.log_audit_write('import_batch_discard', 'import_batch', p_batch::text, NULL, jsonb_build_object('status', 'discarded'), p_note);
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
           WHERE x.batch_id = p_batch AND x.action = 'create' AND EXISTS (SELECT 1 FROM public.import_batch_rows q WHERE q.id = x.id AND q.site_draft_id IS NOT NULL)
             AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
             AND ((p_scope = 'all' AND x.eff_decision = 'pending') OR (p_scope = 'rows' AND x.id IN (SELECT (e ->> 'row_id')::uuid FROM jsonb_array_elements(p_rows) e)))
           ORDER BY x.row_no LOOP
    item := CASE WHEN p_scope = 'rows' THEN (SELECT e FROM jsonb_array_elements(p_rows) e WHERE (e ->> 'row_id')::uuid = r.id LIMIT 1) END;
    act := CASE WHEN p_action = 'reject' THEN 'reject' WHEN p_scope = 'rows' AND item ->> 'decision' = 'rejected' THEN 'reject' ELSE p_action END;
    rnote := coalesce(nullif(btrim(item ->> 'note'), ''), nullif(btrim(p_note), ''));
    IF r.eff_decision IN ('approved', 'rejected') THEN CONTINUE; END IF;
    IF act = 'reject' AND rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
    BEGIN
      SELECT * INTO dr FROM public.site_drafts WHERE id = (SELECT q.site_draft_id FROM public.import_batch_rows q WHERE q.id = r.id) FOR UPDATE;
      IF dr.status <> 'in_approval' THEN
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'invalid_transition', 'message', 'The site draft is ' || dr.status || '.'));
        CONTINUE;
      END IF;
      -- the same authority as the manual draft: L2 of the Site creation row in the row's region, with the approve right of the grid there
      IF NOT (public.site_new_may('approve', dr.region_id) AND public.site_new_holds(dr.region_id, 'approve')) THEN
        BEGIN
          PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not a Review and Approve holder (L2) of the Site creation row in this region.'));
        EXCEPTION WHEN others THEN first_forbidden := coalesce(first_forbidden, SQLERRM);
        END;
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'not_eligible_holder',
          'message', 'You are not a Review and Approve holder (L2) of the Site creation row in this region.'));
        CONTINUE;
      END IF;
      IF act = 'reject' THEN
        UPDATE public.site_drafts SET status = 'rejected', decided_by = actor, decided_at = clock_timestamp(), decision_note = left(rnote, 2000), version = version + 1, updated_at = clock_timestamp() WHERE id = dr.id;
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = 'reject' WHERE id = r.id;
        PERFORM public.log_audit_write('site_draft_return', 'site_draft', dr.id::text, jsonb_build_object('status', 'in_approval'), jsonb_build_object('status', 'rejected', 'note', left(rnote, 2000)), rnote, NULL, dr.region_id);
        rejected := rejected + 1; decided := decided + 1;
      ELSE
        IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
        sid := public.site_create_apply(dr.id, dr.created_by = actor);
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = 'approve', site_id = sid WHERE id = r.id;
        approved := approved + 1; decided := decided + 1;
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
  IF decided = 0 AND first_forbidden IS NOT NULL THEN RAISE EXCEPTION '%', first_forbidden USING ERRCODE = 'P0001'; END IF;
  new_st := public.imp_status_of_after(p_batch);
  UPDATE public.import_batches SET status = new_st, version = version + 1, note = CASE WHEN p_action = 'reject' THEN coalesce(nullif(btrim(p_note), ''), note) ELSE note END,
    closed_at = CASE WHEN new_st IN ('approved', 'rejected') THEN now() ELSE closed_at END WHERE id = p_batch;
  PERFORM public.log_audit_write('import_batch_' || p_action, 'import_batch', p_batch::text, NULL,
    jsonb_build_object('scope', p_scope, 'decided', decided, 'approved', approved, 'rejected', rejected, 'held', 0, 'failed', jsonb_array_length(failed), 'status', new_st), p_note);
  IF b.uploaded_by <> actor AND decided > 0 THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
    VALUES (b.uploaded_by, 'in_app', 'import_batch', CASE WHEN p_action = 'reject' THEN 'Rows of your upload were returned' ELSE 'Rows of your upload were decided' END,
            b.file_name || ': ' || approved || ' approved, ' || rejected || ' returned' || CASE WHEN p_action = 'reject' AND p_note IS NOT NULL THEN '. ' || left(p_note, 200) ELSE '' END,
            '/templates/batches/' || p_batch::text, 'sites');
  END IF;
  RETURN jsonb_build_object('decided', decided, 'approved', approved, 'rejected', rejected, 'held', held, 'failed', failed);
END $$;

-- The dispatchers (0037, 0051, 0060) know the New sites batch
CREATE OR REPLACE FUNCTION imp_stage_batch(p_template text, p_version integer, p_checksum text, p_file_name text, p_sha text, p_task uuid, p_rows jsonb, p_mode text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.template_definitions%ROWTYPE; cur public.template_versions%ROWTYPE; o public.template_versions%ROWTYPE; compat jsonb; ver int := p_version; cs text := p_checksum;
  file_v int; bid uuid;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF coalesce(p_mode, 'submit') NOT IN ('submit', 'draft') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid', 'message', 'mode is submit or draft.'))));
  END IF;
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template AND is_active;
  IF FOUND THEN
    SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
    IF p_version <> cur.version THEN
      compat := public.tpl_version_compat(p_template, p_version);
      IF compat IS NULL THEN
        PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'outdated_version', 'detail', 'This file names version ' || p_version || ' of ' || p_template || ', which is not an issued version. Download the template again.'));
      END IF;
      IF NOT (compat ->> 'compatible')::boolean THEN PERFORM public.tpl_refuse_outdated(compat); END IF;
      SELECT * INTO o FROM public.template_versions WHERE template_def_id = d.id AND version = p_version;
      IF p_checksum IS NOT NULL AND o.header_checksum <> p_checksum THEN
        PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'checksum_mismatch', 'detail', 'The header row of the file was changed. Use the template as it was issued.'));
      END IF;
      ver := cur.version; cs := CASE WHEN p_checksum IS NULL THEN NULL ELSE cur.header_checksum END; file_v := p_version;
    END IF;
    IF coalesce(p_mode, 'submit') = 'draft' AND d.kind <> 'stream' THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/mode', 'code', 'invalid',
        'message', 'Save Draft / Planning is for the Site Register stream templates and the Master sheet; a register file and a New sites file are always submitted.'))));
    END IF;
  END IF;
  IF d.kind = 'stream' THEN
    bid := public.imp_stage_stream_batch(p_template, ver, cs, p_file_name, p_sha, p_task, p_rows, NULL, 'template', 'Data', coalesce(p_mode, 'submit'));
  ELSIF d.kind = 'sites' THEN
    IF p_task IS NOT NULL THEN
      PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'wrong_template', 'detail', 'The New sites template is not used from a task.'));
    END IF;
    bid := public.imp_stage_site_batch(p_template, ver, cs, p_file_name, p_sha, p_rows);
  ELSE
    bid := public.imp_stage_register_batch(p_template, ver, cs, p_file_name, p_sha, p_task, p_rows);
  END IF;
  IF bid IS NOT NULL AND file_v IS NOT NULL THEN
    UPDATE public.import_batches SET file_template_version = file_v WHERE id = bid;
    PERFORM public.log_audit_write('template.old_version_accepted', 'import_batch', bid::text, NULL,
      jsonb_build_object('template_id', p_template, 'file_version', file_v, 'current_version', ver, 'other_changes', jsonb_array_length(compat -> 'other_changes')), NULL);
  END IF;
  RETURN bid;
END $$;

CREATE OR REPLACE FUNCTION imp_submit_batch(p_batch uuid, p_version integer, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.entity = 'site') THEN
    RETURN public.imp_submit_site_batch(p_batch, p_version, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL) THEN
    RETURN public.imp_submit_stream_batch(p_batch, p_version, p_stepup);
  END IF;
  RETURN public.imp_submit_register_batch(p_batch, p_version, p_stepup);
END $$;

CREATE OR REPLACE FUNCTION imp_decide_batch(p_batch uuid, p_version integer, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.entity = 'site') THEN
    RETURN public.imp_decide_site_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL AND b.mode = 'draft') THEN
    RETURN public.imp_decide_draft_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  IF EXISTS (SELECT 1 FROM public.import_batches b WHERE b.id = p_batch AND b.stream_code IS NOT NULL) THEN
    RETURN public.imp_decide_stream_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
  END IF;
  RETURN public.imp_decide_register_batch(p_batch, p_version, p_action, p_scope, p_rows, p_note, p_stepup);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10b. G2: a known header alias for a typed column of the legacy Master import (P3)
-- ---------------------------------------------------------------------------------------------------------------------
-- The owner file renamed CL3 "Indoor IP Router" to "IP Router". The check stays exact: mi_stage_run accepts a header only when it is the Master header or an
-- alias listed here for the same column; every other renamed header is still refused (structure_mismatch). An alias used is reported in the run structure
-- (structure.aliased), never silent.
CREATE TABLE master_header_aliases (
  letter     TEXT           NOT NULL REFERENCES master_columns (letter),
  alias      TEXT           NOT NULL CHECK (alias = btrim(alias) AND char_length(alias) BETWEEN 1 AND 120),
  note       TEXT,
  is_active  BOOLEAN        NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (letter, alias)
);
COMMENT ON TABLE master_header_aliases IS 'G2 (0070): known renamed headers of typed Master columns that the legacy Master import accepts (the check stays exact). Written only by migrations and the System Admin through SQL; pmis_app reads.';
ALTER TABLE master_header_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_header_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON master_header_aliases FOR SELECT USING (true);
INSERT INTO master_header_aliases (letter, alias, note) VALUES
  ('CL', 'IP Router', 'G2: the owner file of 2026-11-04 names CL3 "IP Router"; the Master and master_columns say "Indoor IP Router".');
GRANT SELECT ON master_header_aliases TO pmis_definer;

CREATE OR REPLACE FUNCTION public.mi_stage_run(p_file_name text, p_sha text, p_size bigint, p_storage_key text, p_sheets jsonb, p_headers jsonb, p_rows jsonb, p_staff jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  actor uuid := public.app_actor(); rid uuid := gen_random_uuid(); cols record; fmap jsonb := '{}'::jsonb; missing jsonb := '[]'::jsonb; moved jsonb := '[]'::jsonb;
  extra jsonb := '[]'::jsonb; found int := 0; total int := 0; miss_input jsonb := '[]'::jsonb; h jsonb; el jsonb; cells jsonb; k text; val jsonb; site public.sites%ROWTYPE;
  scode text; pm jsonb; mv text; pv text; nm text; np text; ord int := 0; matches int := 0; compared int := 0; n_rows int := 0; n_sites int := 0; n_unknown int := 0;
  seen jsonb := '{}'::jsonb; cmeta jsonb := '[]'::jsonb; c jsonb; reason text; kind text; appl boolean; isf boolean; regs int[] := ARRAY[]::int[]; st jsonb; rr jsonb;
  rg int; v_structure jsonb; v_summary jsonb; cst text; staff_mapped int := 0; expected_sheets jsonb; sheets_missing jsonb; ignored int := 0; aliased jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.mi_can_use() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'The legacy Master import is for a System Admin or a delegate of templates administer.'));
  END IF;
  IF p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/file', 'code', 'invalid', 'message', 'The file hash is missing.'))));
  END IF;
  -- 1. identification: the sheet Master and the Master headers
  IF NOT coalesce(p_sheets ? 'Master', false) THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'not_a_master', 'detail', 'This file is not the Site Master: it has no sheet "Master". Upload the real Master, or a PMIS template through Upload.'));
  END IF;
  FOR cols IN SELECT * FROM public.mi_columns() ORDER BY 1 LOOP
    total := total + 1;
    -- the header as master_columns stores it, or as the three header rows of the Master compose it (group / name: "Identification / Site ID")
    SELECT x INTO h FROM jsonb_array_elements(coalesce(p_headers, '[]'::jsonb)) x
      WHERE btrim(x ->> 'header') = cols.header
         OR btrim(x ->> 'header') = (SELECT m.group_mid || ' / ' || m.name FROM public.master_columns m WHERE m.letter = cols.letter AND m.name IS NOT NULL)
         -- G2 (0070): a known renamed header of this column (master_header_aliases), alone or under the group of the column
         OR btrim(x ->> 'header') IN (SELECT m.group_mid || ' / ' || a.alias FROM public.master_columns m JOIN public.master_header_aliases a ON a.letter = m.letter AND a.is_active
                                      WHERE m.letter = cols.letter AND m.group_mid IS NOT NULL)
         OR btrim(x ->> 'header') IN (SELECT a.alias FROM public.master_header_aliases a WHERE a.letter = cols.letter AND a.is_active)
      ORDER BY (btrim(x ->> 'header') = cols.header) DESC LIMIT 1;
    IF h IS NULL THEN
      missing := missing || jsonb_build_array(jsonb_build_object('letter', cols.letter, 'header', cols.header, 'typed', coalesce(cols.typed, false)));
      IF coalesce(cols.typed, false) OR cols.owner = 'key' THEN miss_input := miss_input || jsonb_build_array(cols.header); END IF;
    ELSE
      found := found + 1;
      IF btrim(h ->> 'header') <> cols.header AND btrim(h ->> 'header') IS DISTINCT FROM (SELECT m.group_mid || ' / ' || m.name FROM public.master_columns m WHERE m.letter = cols.letter AND m.name IS NOT NULL) THEN
        aliased := aliased || jsonb_build_array(jsonb_build_object('letter', cols.letter, 'header', cols.header, 'in_file', btrim(h ->> 'header')));
      END IF;
      fmap := fmap || jsonb_build_object(h ->> 'col', cols.letter);
      IF h ->> 'col' <> cols.letter THEN moved := moved || jsonb_build_array(jsonb_build_object('header', cols.header, 'expected', cols.letter, 'found', h ->> 'col')); END IF;
    END IF;
    cmeta := cmeta || jsonb_build_array(jsonb_build_object('letter', cols.letter, 'header', cols.header, 'owner', cols.owner, 'field', cols.field, 'typed', coalesce(cols.typed, false), 'shared', coalesce(cols.shared, false)));
  END LOOP;
  SELECT coalesce(jsonb_agg(x ->> 'header'), '[]'::jsonb) INTO extra FROM jsonb_array_elements(coalesce(p_headers, '[]'::jsonb)) x
    WHERE coalesce(btrim(x ->> 'header'), '') <> '' AND NOT EXISTS (SELECT 1 FROM public.master_columns m WHERE m.is_active AND m.header = btrim(x ->> 'header'))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(aliased) a WHERE a ->> 'in_file' = btrim(x ->> 'header'));
  SELECT coalesce(jsonb_agg(tp.sheet_name ORDER BY tp.sort_order), '[]'::jsonb) INTO expected_sheets FROM public.template_parts tp WHERE tp.template_id = 'TPL-MASTER';
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO sheets_missing FROM jsonb_array_elements_text(expected_sheets) x WHERE NOT (p_sheets ? x);
  v_structure := jsonb_build_object('identified', NOT (fmap ? '') AND fmap <> '{}'::jsonb AND found * 10 >= total * 9 AND EXISTS (SELECT 1 FROM jsonb_each_text(fmap) e WHERE e.value = 'B'),
    'columns_expected', total, 'columns_found', found, 'aliased', aliased, 'missing', missing, 'moved', moved, 'extra', extra, 'missing_typed', miss_input,
    'sheets', p_sheets, 'register_sheets_missing', sheets_missing, 'has_tpl', p_sheets ? '_tpl');
  IF NOT (v_structure ->> 'identified')::boolean THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'not_a_master', 'detail', 'This file is not the Site Master: only ' || found || ' of the ' || total ||
      ' Master column headers were found (the Site ID column is required). Upload the real Master as it is, without changing its header rows.'));
  END IF;
  IF jsonb_array_length(miss_input) > 0 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'structure_mismatch', 'detail', 'The Master sheet lacks typed column(s): ' ||
      (SELECT string_agg(x, ', ') FROM (SELECT jsonb_array_elements_text(miss_input) x LIMIT 6) q) || CASE WHEN jsonb_array_length(miss_input) > 6 THEN ' ...' ELSE '' END ||
      '. The file cannot be compared or applied.'));
  END IF;
  IF jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 THEN
    PERFORM public.wf_err('template_rejected', jsonb_build_object('reason', 'size_or_rows_exceeded', 'detail', 'The Master sheet has more than 5000 rows.'));
  END IF;

  INSERT INTO public.master_reconciliation_runs (id, file_name, file_sha256, file_size, storage_key, structure, created_by)
  VALUES (rid, left(p_file_name, 200), p_sha, p_size, p_storage_key, v_structure, actor);

  -- 2. every row: the cells in Master letters, the site, the comparison with what GSDN Workspace holds
  FOR el IN SELECT x FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x LOOP
    cells := '{}'::jsonb;
    FOR k, val IN SELECT * FROM jsonb_each(coalesce(el -> 'cells', '{}'::jsonb)) LOOP
      IF fmap ? k THEN cells := cells || jsonb_build_object(fmap ->> k, val); END IF;
    END LOOP;
    scode := nullif(btrim(cells -> 'B' ->> 'v'), '');
    CONTINUE WHEN scode IS NULL;
    n_rows := n_rows + 1;
    SELECT * INTO site FROM public.sites x WHERE upper(x.site_code) = upper(scode) AND public.app_region_check(x.region_id);
    INSERT INTO public.master_reconciliation_rows (run_id, row_no, site_code, site_id, region_id, cells)
    VALUES (rid, (el ->> 'row_no')::int, scode, site.id, site.region_id, cells) ON CONFLICT DO NOTHING;
    IF seen ? upper(scode) THEN
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, site_id, region_id, master_col, header, field, master_value, kind, reason)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), scode, site.id, site.region_id, 'B', 'Site ID', 'site', scode, 'exception', 'duplicate_in_file');
      CONTINUE;
    END IF;
    seen := seen || jsonb_build_object(upper(scode), el ->> 'row_no');
    IF site.id IS NULL THEN
      n_unknown := n_unknown + 1; ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, master_col, header, field, master_value, kind, reason)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), scode, 'B', 'Site ID', 'site', scode, 'missing_in_pmis', 'site_not_in_pmis');
      CONTINUE;
    END IF;
    n_sites := n_sites + 1;
    IF NOT (site.region_id = ANY (regs)) THEN regs := regs || site.region_id; END IF;
    pm := public.mi_pmis_row(site.id);
    FOR c IN SELECT x FROM jsonb_array_elements(cmeta) x LOOP
      CONTINUE WHEN c ->> 'letter' IN ('A', 'B');
      isf := coalesce((cells -> (c ->> 'letter') ->> 'f')::boolean, false);
      mv := cells -> (c ->> 'letter') ->> 'v';
      IF NOT (pm ? (c ->> 'letter')) THEN
        IF mv IS NOT NULL THEN ignored := ignored + 1; END IF;
        CONTINUE;                                                        -- a column GSDN Workspace does not compare (calculated gates, SLA, Dismantle ...)
      END IF;
      pv := pm ->> (c ->> 'letter');
      compared := compared + 1;
      reason := NULL; kind := 'diff'; appl := false;
      IF c ->> 'letter' = 'E' THEN
        IF mv IS NOT NULL THEN
          rg := public.imp_region_resolve(mv);
          IF rg IS NULL THEN kind := 'exception'; reason := 'region_alias_unknown';
          ELSIF rg = site.region_id THEN matches := matches + 1; CONTINUE;
          ELSE reason := 'owned_elsewhere'; END IF;
        ELSE matches := matches + 1; CONTINUE;
        END IF;
      ELSE
        nm := public.mi_norm(mv); np := public.mi_norm(pv);
        cst := CASE WHEN coalesce((c ->> 'shared')::boolean, false) THEN public.tpl_master_candidates(site.id, c ->> 'letter') ->> 'status' END;
        IF cst = 'ambiguous' AND nm IS NULL THEN matches := matches + 1; CONTINUE; END IF;
        IF cst IS DISTINCT FROM 'ambiguous' AND nm IS NOT DISTINCT FROM np THEN matches := matches + 1; CONTINUE; END IF;
        IF cst = 'ambiguous' THEN
          kind := 'exception'; reason := 'ambiguous_mapping';
        ELSIF c ->> 'owner' = 'task' AND coalesce((c ->> 'typed')::boolean, false) THEN
          IF isf THEN kind := 'exception'; reason := 'formula_in_input';
          ELSIF mv IS NULL THEN reason := 'empty_in_master';
          ELSE reason := 'value_differs'; appl := true; END IF;
        ELSIF c ->> 'owner' IN ('task', 'calc') THEN reason := 'calculated';
        ELSIF c ->> 'owner' = 'issues' THEN reason := 'issue_projection';
        ELSE reason := 'owned_elsewhere'; END IF;
      END IF;
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, site_code, site_id, region_id, master_col, header, field, master_value, pmis_value, kind, reason, applicable)
      VALUES (rid, ord, 'Master', (el ->> 'row_no')::int, 'Master!' || (el ->> 'row_no'), site.site_code, site.id, site.region_id, c ->> 'letter', c ->> 'header',
              coalesce(c ->> 'field', c ->> 'owner'), left(mv, 1000), left(pv, 1000), kind, reason, appl);
    END LOOP;
  END LOOP;

  -- 3. the sites of the regions the file covers that the file does not hold
  IF cardinality(regs) > 0 THEN
    FOR site IN SELECT x.* FROM public.sites x WHERE x.is_active AND x.overall_status::text <> 'cancelled' AND x.region_id = ANY (regs) AND public.app_region_check(x.region_id)
                  AND NOT (seen ? upper(x.site_code)) ORDER BY x.site_code LOOP
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, site_code, site_id, region_id, master_col, header, field, pmis_value, kind, reason)
      VALUES (rid, ord, 'Master', site.site_code, site.id, site.region_id, 'B', 'Site ID', 'site', site.site_code, 'missing_in_master', 'site_not_in_master');
    END LOOP;
  END IF;

  -- 4. Q8 / Q10: the Project Staff of the Setting sheet. A mapped role is a suggestion only; nothing is granted.
  FOR st IN SELECT x FROM jsonb_array_elements(coalesce(p_staff, '[]'::jsonb)) x LOOP
    CONTINUE WHEN coalesce(btrim(st ->> 'name'), '') = '' AND coalesce(btrim(st ->> 'role'), '') = '';
    IF coalesce(btrim(st ->> 'role'), '') <> '' THEN
      rr := public.imp_role_resolve(st ->> 'role');
      IF rr ->> 'status' = 'mapped' THEN staff_mapped := staff_mapped + 1;
      ELSE
        ord := ord + 1;
        INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, master_col, header, field, master_value, pmis_value, kind, reason)
        VALUES (rid, ord, 'Setting', (st ->> 'row_no')::int, 'Setting!' || (st ->> 'row_no'), 'J', 'Project Staff / Role', 'role_aliases', left(st ->> 'role', 200), left(st ->> 'name', 200), 'exception',
                CASE rr ->> 'status' WHEN 'ambiguous' THEN 'role_ambiguous' WHEN 'unmapped' THEN 'role_unmapped' ELSE 'role_unknown' END);
      END IF;
    END IF;
    IF coalesce(btrim(st ->> 'region'), '') <> '' AND public.imp_region_resolve(st ->> 'region') IS NULL THEN
      ord := ord + 1;
      INSERT INTO public.master_reconciliation_diffs (run_id, ord, sheet, row_no, source_ref, master_col, header, field, master_value, pmis_value, kind, reason)
      VALUES (rid, ord, 'Setting', (st ->> 'row_no')::int, 'Setting!' || (st ->> 'row_no'), 'K', 'Project Staff / Region', 'region_aliases', left(st ->> 'region', 200), left(st ->> 'name', 200), 'exception', 'region_alias_unknown');
    END IF;
  END LOOP;

  SELECT jsonb_build_object('rows', n_rows, 'sites_matched', n_sites, 'sites_unknown', n_unknown, 'cells_compared', compared, 'matches', matches, 'cells_not_compared', ignored,
    'diffs', count(*) FILTER (WHERE d.kind = 'diff'), 'missing_in_pmis', count(*) FILTER (WHERE d.kind = 'missing_in_pmis'),
    'missing_in_master', count(*) FILTER (WHERE d.kind = 'missing_in_master'), 'exceptions', count(*) FILTER (WHERE d.kind = 'exception'),
    'applicable', count(*) FILTER (WHERE d.applicable), 'staff_mapped', staff_mapped, 'staff_rows', jsonb_array_length(coalesce(p_staff, '[]'::jsonb)),
    'by_reason', coalesce((SELECT jsonb_object_agg(q.reason, q.n) FROM (SELECT x.reason, count(*) AS n FROM public.master_reconciliation_diffs x WHERE x.run_id = rid GROUP BY x.reason) q), '{}'::jsonb))
    INTO v_summary FROM public.master_reconciliation_diffs d WHERE d.run_id = rid;
  UPDATE public.master_reconciliation_runs SET summary = v_summary WHERE id = rid;
  PERFORM public.log_audit_write('master_import.preview', 'master_reconciliation_run', rid::text, NULL,
    jsonb_build_object('file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'file_size', p_size, 'storage_key', p_storage_key, 'summary', v_summary, 'structure_moved', jsonb_array_length(moved)), NULL);
  PERFORM public.log_system_write('info', 'master-import', 'legacy Master import: previewed',
    jsonb_build_object('run_id', rid, 'file_name', left(p_file_name, 200), 'file_sha256', p_sha, 'rows', n_rows, 'diffs', v_summary -> 'diffs', 'exceptions', v_summary -> 'exceptions'), actor, NULL);
  RETURN rid;
END $function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Rights and ownership (PUBLIC revoked, owner pmis_definer; only the API entry points reach pmis_app)
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON site_drafts TO pmis_definer;
GRANT INSERT ON sites TO pmis_definer;
GRANT SELECT ON sites TO pmis_definer;
GRANT INSERT ON clusters, task_instances, notifications TO pmis_definer;
GRANT SELECT ON clusters, regions, region_aliases, list_values, list_catalogues, task_definitions, stage_definitions, task_predecessors, template_definitions, template_versions,
  groups, matrix_cells, matrix_cell_assignees TO pmis_definer;
GRANT INSERT ON matrix_cells, matrix_cell_assignees TO pmis_definer;
GRANT UPDATE ON matrix_state TO pmis_definer;
GRANT SELECT, INSERT, UPDATE ON import_batches, import_batch_rows TO pmis_definer;
GRANT INSERT ON system_log, audit_log TO pmis_definer;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['site_creation_seed_cells', 'site_creation_seed_trg', 'tpl_sites_columns', 'site_new_code', 'site_new_err', 'site_new_list',
             'site_new_clean', 'site_new_holds', 'site_new_may', 'wf_apply_applicability', 'site_create_apply', 'site_draft_json', 'site_draft_errors', 'site_draft_notify_l2',
             'site_draft_create', 'site_draft_save', 'site_draft_submit', 'site_draft_decide', 'site_draft_discard', 'site_draft_actions', 'site_draft_warnings', 'imp_stage_site_batch', 'imp_submit_site_batch',
             'imp_decide_site_batch', 'tpl_sync', 'imp_stage_batch', 'imp_submit_batch', 'imp_decide_batch'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f.sig);
    IF f.proname IN ('site_draft_create', 'site_draft_save', 'site_draft_submit', 'site_draft_decide', 'site_draft_discard', 'site_draft_actions', 'site_draft_warnings', 'imp_stage_batch', 'imp_submit_batch', 'imp_decide_batch')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f.sig);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT SELECT ON site_drafts, master_header_aliases TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON site_drafts, master_header_aliases FROM pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 12. The template is issued, the Matrix row is seeded when the group exists
-- ---------------------------------------------------------------------------------------------------------------------
SELECT tpl_sync('TPL-SITE-NEW', 'first version (0070)');
SELECT site_creation_seed_cells();

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('site_creation_applied', 'workflow', NULL,
        jsonb_build_object('template', 'TPL-SITE-NEW', 'matrix_row', 'site_creation', 'list', 'SiteScenario', 'sites_name_ar', true, 'wf_apply_applicability', true),
        'Owner question Q460 (technical decisions of 2026-11-04): site creation, manual and bulk, both ending at L2 (migration 0070); G8, G9.');
