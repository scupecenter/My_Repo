-- 002: row-level security for the region filter (defence in depth; the API also filters).
-- Per transaction the API sets:  SELECT set_config('app.region_ids', '1,3,5', true);   -- '*' = all regions
-- Unset/empty = no rows (fail closed). The table owner/migration role is also subject to the policies (FORCE),
-- so seed and migration jobs must set app.region_ids = '*'. The app role must not own the tables.
--
-- Two predicates:
--   app_region_check(r)        strict: NULL region is allowed only for '*'. Used for USING on site-bound tables
--                              and for WITH CHECK everywhere.
--   app_region_using_global(r) NULL region means a truly global row, visible to any session. USING only.

CREATE OR REPLACE FUNCTION app_region_check(r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.region_ids', true), '') = '' THEN false
    WHEN current_setting('app.region_ids', true) = '*' THEN true
    WHEN r IS NULL THEN false
    ELSE r = ANY (string_to_array(current_setting('app.region_ids', true), ',')::int[])
  END
$$;

CREATE OR REPLACE FUNCTION app_region_using_global(r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.region_ids', true), '') = '' THEN false
    WHEN r IS NULL THEN true
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

CREATE OR REPLACE FUNCTION app_regions_using_global(a integer[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.region_ids', true), '') = '' THEN false
    WHEN a IS NULL OR cardinality(a) = 0 THEN true
    ELSE app_regions_check(a)
  END
$$;

-- Integrity: a row with a site must carry the region (the composite FK only fires when both columns are non-null).
ALTER TABLE change_requests   ADD CONSTRAINT change_requests_site_region_both   CHECK ((site_id IS NULL) = (region_id IS NULL));
ALTER TABLE warehouse_serials ADD CONSTRAINT warehouse_serials_site_region_both CHECK ((site_id IS NULL) = (region_id IS NULL));

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

-- (2) Region-optional tables: NULL region = global row, readable by any session, writable only by '*'.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['change_requests','warehouse_serials','risks','meetings','clusters','matrix_cells'] LOOP
    PERFORM _rls_apply(t, 'app_region_using_global(region_id)', 'app_region_check(region_id)');
  END LOOP;
END $$;

-- (3) Children without region_id: inherit the parent's policy through EXISTS (the sub-select is itself filtered by RLS).
SELECT _rls_apply('workflow_steps',
  'EXISTS (SELECT 1 FROM task_instances p WHERE p.id = task_id)',
  'EXISTS (SELECT 1 FROM task_instances p WHERE p.id = task_id)');
SELECT _rls_apply('document_files',
  'EXISTS (SELECT 1 FROM document_slots p WHERE p.id = slot_id)',
  'EXISTS (SELECT 1 FROM document_slots p WHERE p.id = slot_id)');
SELECT _rls_apply('snag_photos',
  'EXISTS (SELECT 1 FROM snags p WHERE p.id = snag_id)',
  'EXISTS (SELECT 1 FROM snags p WHERE p.id = snag_id)');
SELECT _rls_apply('matrix_cell_assignees',
  'EXISTS (SELECT 1 FROM matrix_cells p WHERE p.id = cell_id)',
  'EXISTS (SELECT 1 FROM matrix_cells p WHERE p.id = cell_id)');
SELECT _rls_apply('meeting_actions',
  'EXISTS (SELECT 1 FROM meetings p WHERE p.id = meeting_id)',
  'EXISTS (SELECT 1 FROM meetings p WHERE p.id = meeting_id)');
-- Comments: task comments follow the task; register comments carry their own region_id.
SELECT _rls_apply('comments',
  '(task_id IS NOT NULL AND EXISTS (SELECT 1 FROM task_instances p WHERE p.id = task_id)) OR (task_id IS NULL AND app_region_using_global(region_id))',
  '(task_id IS NOT NULL AND EXISTS (SELECT 1 FROM task_instances p WHERE p.id = task_id)) OR (task_id IS NULL AND app_region_check(region_id))');
-- Import: batches by region_scope array; rows through their batch plus their own region_id when set.
SELECT _rls_apply('import_batches', 'app_regions_using_global(region_scope)', 'app_regions_check(region_scope)');
SELECT _rls_apply('import_batch_rows',
  'EXISTS (SELECT 1 FROM import_batches p WHERE p.id = batch_id) AND (region_id IS NULL OR app_region_check(region_id))',
  'EXISTS (SELECT 1 FROM import_batches p WHERE p.id = batch_id) AND (region_id IS NULL OR app_region_check(region_id))');

DROP FUNCTION _rls_apply(text, text, text);

-- Not region-filtered, by design: users, roles, sub_roles, user_*, groups, delegations, stage/task/document/snag/template
-- definitions, template_versions, external_parties/teams, warehouse_items, holidays, baseline_versions, phase_gate_rules,
-- settings (configuration, no site data); notifications (owner-scoped in the API); audit_log and system_log (admin only,
-- append-only); document_type_placements; baseline of other config. These carry no site data.

-- (4) Changing a site's region. Children carrying (site_id, region_id) follow automatically because the composite FKs are
-- ON UPDATE CASCADE. Direct changes are blocked unless the admin-only path sets app.allow_region_change = 'on'
-- (the API does so only after step-up MFA, with a reason, and writes an audit_log row). Snapshots that are not FK-bound
-- (import_batch_rows.region_id, audit_log.region_id, risks/meetings/clusters/comments region_id) are not rewritten.
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
