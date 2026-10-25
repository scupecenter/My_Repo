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

-- Role that bypasses RLS and owns the SECURITY DEFINER integrity functions (see 004 and the sweep notes below).
-- Cross-table integrity checks must see ALL rows, not just the caller's region, so they run as this role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_definer') THEN
    CREATE ROLE pmis_definer NOLOGIN BYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO pmis_definer;

-- Owner of the identity/permission SECURITY DEFINER functions (idm_*, app_actor_*, app_has_permission). BYPASSRLS so that its
-- checks see every row. The app role gets no write privilege on identity tables; only these functions write them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_identity_owner') THEN
    CREATE ROLE pmis_identity_owner NOLOGIN BYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO pmis_identity_owner;

-- Functions created by (or later owned by) the definer roles are not executable by PUBLIC unless granted. Functions that the
-- migration role creates and then hands over (ALTER FUNCTION ... OWNER TO) are covered by the explicit REVOKE loop at the end of
-- 008_identity_writes.sql. Helper predicates used by RLS policies (app_region_check ...) deliberately stay PUBLIC-executable.
DO $$ BEGIN
  ALTER DEFAULT PRIVILEGES FOR ROLE pmis_identity_owner, pmis_definer REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not set default privileges for the definer roles; the explicit REVOKE loop in 008 still applies';
END $$;

-- The migration/seed role. Protected-row bypass depends on THIS ROLE, never on a session setting (a setting can be set by the
-- app role or by SQL injection). Deployment: run migrations and the seed as a login role that is pmis_migrator or a member of
-- it (GRANT pmis_migrator TO <deploy_login>); pmis_app must never be a member. Superusers also qualify.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_migrator') THEN
    CREATE ROLE pmis_migrator NOLOGIN;
  END IF;
END $$;

-- True only for the migration/seed role (checked on current_user, so SET ROLE tricks by the app role do not help it).
CREATE OR REPLACE FUNCTION app_is_seeding() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT pg_has_role(current_user, 'pmis_migrator', 'member') $$;

-- True inside the admin SECURITY DEFINER functions (their owner is pmis_definer) and for the migration role.
CREATE OR REPLACE FUNCTION app_in_admin_path() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_user = 'pmis_definer' OR app_is_seeding() $$;

CREATE OR REPLACE FUNCTION app_is_full_access() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.region_ids', true), '') = '*' $$;

CREATE OR REPLACE FUNCTION app_has_session() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.region_ids', true), '') <> '' $$;

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

-- Policy helper: one policy per command. READ predicate for SELECT; WRITE predicate for INSERT (check), UPDATE (using and check)
-- and DELETE (using). Using the read predicate for DELETE/UPDATE would let a region user delete or edit global rows or
-- children of global parents that they can merely see.
CREATE OR REPLACE FUNCTION _rls_apply(t text, read_expr text, write_expr text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE pol text;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  FOREACH pol IN ARRAY ARRAY['region_filter','rls_select','rls_insert','rls_update','rls_delete'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, t);
  END LOOP;
  EXECUTE format('CREATE POLICY rls_select ON %I FOR SELECT USING (%s)', t, read_expr);
  EXECUTE format('CREATE POLICY rls_insert ON %I FOR INSERT WITH CHECK (%s)', t, write_expr);
  EXECUTE format('CREATE POLICY rls_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t, write_expr, write_expr);
  EXECUTE format('CREATE POLICY rls_delete ON %I FOR DELETE USING (%s)', t, write_expr);
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

-- (3b) Configuration, definition and identity-configuration tables get their policies in 008_identity_writes.sql, after the
-- permission functions (app_can) exist: read for everyone, write by delegated/admin permission through app_can().

DROP FUNCTION _rls_apply(text, text, text);

-- Not RLS-protected, by design (no site data): identity tables (users, user_role_assignments + children, groups, group_members,
-- delegations + children), which are write-protected by privileges, backstop triggers and idm_* functions (008); notifications;
-- audit_log and system_log (append-only triggers).
-- Every other table is covered: site/region tables (1)(2), children (3), config and shared master data (008).

-- (4) Changing a site's region. Children carrying (site_id, region_id) follow automatically because the composite FKs are
-- ON UPDATE CASCADE. Direct changes are blocked unless they run inside admin_transfer_site_region() (SECURITY DEFINER, owner
-- pmis_definer, below) or as the migration role. No session setting can open this path. Snapshots that are not FK-bound
-- (import_batch_rows.region_id, audit_log.region_id, risks/meetings/clusters region_id) are not rewritten.
CREATE OR REPLACE FUNCTION sites_block_region_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.region_id IS DISTINCT FROM OLD.region_id
     AND NOT app_in_admin_path() THEN
    RAISE EXCEPTION 'sites.region_id is immutable; use the admin region-transfer path' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sites_region_immutable ON sites;
CREATE TRIGGER sites_region_immutable BEFORE UPDATE OF region_id ON sites
  FOR EACH ROW EXECUTE FUNCTION sites_block_region_change();

-- admin_transfer_site_region() lives in 008_identity_writes.sql (it needs the verified-admin check).
