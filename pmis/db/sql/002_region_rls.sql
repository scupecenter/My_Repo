-- 002: row-level security for the region filter (defence in depth; the API also filters).
-- Per transaction the API sets:  SELECT set_config('app.region_ids', '1,3,5', true);   -- '*' = all regions
-- Unset/empty = no rows (fail closed). The table owner/migration role is also subject to the policies (FORCE),
-- so seed and migration jobs must set app.region_ids = '*'. The app role must not own the tables.
--
-- Global rows are explicit: a boolean is_global column (never "region_id IS NULL"). CHECK constraints tie the flag to the
-- region columns. Predicates:
--   app_region_check(r)        strict: NULL region passes only for '*'.
--   app_region_read(g, r)      USING on region-optional tables: session set AND (is_global OR region visible).
--   app_region_write(g, r)     WITH CHECK: is_global rows can be written only by '*'; others need a visible, non-null region.

CREATE OR REPLACE FUNCTION app_region_check(r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.region_ids', true), '') = '' THEN false
    WHEN current_setting('app.region_ids', true) = '*' THEN true
    WHEN r IS NULL THEN false
    ELSE r = ANY (string_to_array(current_setting('app.region_ids', true), ',')::int[])
  END
$$;

CREATE OR REPLACE FUNCTION app_region_read(g boolean, r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.region_ids', true), '') <> '' AND (coalesce(g, false) OR app_region_check(r))
$$;

CREATE OR REPLACE FUNCTION app_region_write(g boolean, r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.region_ids', true), '') = '' THEN false
    WHEN coalesce(g, false) THEN current_setting('app.region_ids', true) = '*'
    ELSE app_region_check(r)
  END
$$;

-- Region arrays (import_batches.region_scope): every region in the array must be visible; empty array = global.
CREATE OR REPLACE FUNCTION app_regions_check(a integer[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.region_ids', true), '') = '' THEN false
    WHEN current_setting('app.region_ids', true) = '*' THEN true
    WHEN a IS NULL OR cardinality(a) = 0 THEN false
    ELSE a <@ string_to_array(current_setting('app.region_ids', true), ',')::int[]
  END
$$;

-- import_batches: an empty region_scope is NOT global; only '*' sees/writes such batches.

-- Integrity: is_global <=> no site/region; otherwise a region is mandatory (the composite FK only fires when both are non-null).
ALTER TABLE change_requests   ADD CONSTRAINT change_requests_global_xor_region   CHECK ((is_global AND site_id IS NULL AND region_id IS NULL) OR (NOT is_global AND region_id IS NOT NULL));
ALTER TABLE warehouse_serials ADD CONSTRAINT warehouse_serials_global_xor_region CHECK ((is_global AND site_id IS NULL AND region_id IS NULL) OR (NOT is_global AND region_id IS NOT NULL));
ALTER TABLE risks             ADD CONSTRAINT risks_global_xor_region             CHECK ((is_global AND region_id IS NULL) OR (NOT is_global AND region_id IS NOT NULL));
ALTER TABLE meetings          ADD CONSTRAINT meetings_global_xor_region          CHECK ((is_global AND region_id IS NULL) OR (NOT is_global AND region_id IS NOT NULL));
ALTER TABLE clusters          ADD CONSTRAINT clusters_global_xor_region          CHECK ((is_global AND region_id IS NULL) OR (NOT is_global AND region_id IS NOT NULL));
ALTER TABLE progress_snapshots ADD CONSTRAINT progress_snapshots_global_xor_region CHECK ((is_global AND region_id IS NULL) OR (NOT is_global AND region_id IS NOT NULL));
ALTER TABLE matrix_cells      ADD CONSTRAINT matrix_cells_global_xor_region      CHECK ((is_global AND region_id IS NULL) OR (NOT is_global AND region_id IS NOT NULL));

-- Helper to apply a policy.
CREATE OR REPLACE FUNCTION _rls_apply(t text, using_expr text, check_expr text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS region_filter ON %I', t);
  EXECUTE format('CREATE POLICY region_filter ON %I USING (%s) WITH CHECK (%s)', t, using_expr, check_expr);
END $$;

-- (1) Site-bound tables: region_id NOT NULL, tied to sites(id, region_id) by composite FK. Strict.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sites','task_instances','document_slots','snags','baseline_entries','rf_design_records',
    'acquisition_candidates','procurement_records','gecol_records','hlc_records','permit_records',
    'warehouse_site_qty','quality_inspections','issues','readiness_handover','as_built_records'
  ] LOOP
    PERFORM _rls_apply(t, 'app_region_check(region_id)', 'app_region_check(region_id)');
  END LOOP;
END $$;

-- (2) Region-optional tables: explicit is_global rows are readable by any session with a region value, writable only by '*'.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['change_requests','warehouse_serials','risks','meetings','clusters','matrix_cells','progress_snapshots'] LOOP
    PERFORM _rls_apply(t, 'app_region_read(is_global, region_id)', 'app_region_write(is_global, region_id)');
  END LOOP;
END $$;

-- (3) Children without region_id: USING = EXISTS on the parent (the sub-select is itself filtered by RLS, so reads follow the
-- parent). WITH CHECK = the parent's WRITE predicate, so a region user who can read a global parent cannot add children to it.
SELECT _rls_apply('workflow_steps',
  'EXISTS (SELECT 1 FROM task_instances p WHERE p.id = task_id)',
  'EXISTS (SELECT 1 FROM task_instances p WHERE p.id = task_id AND app_region_check(p.region_id))');
SELECT _rls_apply('document_files',
  'EXISTS (SELECT 1 FROM document_slots p WHERE p.id = slot_id)',
  'EXISTS (SELECT 1 FROM document_slots p WHERE p.id = slot_id AND app_region_check(p.region_id))');
SELECT _rls_apply('snag_photos',
  'EXISTS (SELECT 1 FROM snags p WHERE p.id = snag_id)',
  'EXISTS (SELECT 1 FROM snags p WHERE p.id = snag_id AND app_region_check(p.region_id))');
SELECT _rls_apply('matrix_cell_assignees',
  'EXISTS (SELECT 1 FROM matrix_cells p WHERE p.id = cell_id)',
  'EXISTS (SELECT 1 FROM matrix_cells p WHERE p.id = cell_id AND app_region_write(p.is_global, p.region_id))');
SELECT _rls_apply('meeting_actions',
  'EXISTS (SELECT 1 FROM meetings p WHERE p.id = meeting_id)',
  'EXISTS (SELECT 1 FROM meetings p WHERE p.id = meeting_id AND app_region_write(p.is_global, p.region_id))');
-- Comments: region_id NOT NULL, tied to the task by composite FK (task_id, region_id) ON DELETE CASCADE; register comments
-- carry their own region. No global comments.
SELECT _rls_apply('comments', 'app_region_check(region_id)', 'app_region_check(region_id)');
-- Import: batches by region_scope array; rows through their batch plus their own region_id when set.
SELECT _rls_apply('import_batches', 'app_regions_check(region_scope)', 'app_regions_check(region_scope)');
SELECT _rls_apply('import_batch_rows',
  'EXISTS (SELECT 1 FROM import_batches p WHERE p.id = batch_id) AND (region_id IS NULL OR app_region_check(region_id))',
  'EXISTS (SELECT 1 FROM import_batches p WHERE p.id = batch_id AND app_regions_check(p.region_scope)) AND (region_id IS NULL OR app_region_check(region_id))');

DROP FUNCTION _rls_apply(text, text, text);

-- Not region-filtered, by design: users, roles, sub_roles, user_*, groups, delegations, stage/task/document/snag/template
-- definitions, template_versions, external_parties/teams, warehouse_items, holidays, baseline_versions, phase_gate_rules,
-- settings (configuration, no site data); notifications (owner-scoped in the API); audit_log and system_log (admin only,
-- append-only); document_type_placements; baseline of other config. These carry no site data.

-- (4) Changing a site's region. Children carrying (site_id, region_id) follow automatically because the composite FKs are
-- ON UPDATE CASCADE. Direct changes are blocked unless the admin-only path sets app.allow_region_change = 'on'
-- (the API does so only after step-up MFA, with a reason, and writes an audit_log row). Snapshots that are not FK-bound
-- (import_batch_rows.region_id, audit_log.region_id, risks/meetings/clusters region_id) are not rewritten.
CREATE OR REPLACE FUNCTION sites_block_region_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.region_id IS DISTINCT FROM OLD.region_id
     AND coalesce(current_setting('app.allow_region_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'sites.region_id is immutable; use the admin region-transfer path' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sites_region_immutable ON sites;
CREATE TRIGGER sites_region_immutable BEFORE UPDATE OF region_id ON sites
  FOR EACH ROW EXECUTE FUNCTION sites_block_region_change();
