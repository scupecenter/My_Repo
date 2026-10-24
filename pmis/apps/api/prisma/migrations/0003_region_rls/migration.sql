-- 002: row-level security for the region filter (defence in depth; the API also filters).
-- The API sets, per transaction:   SELECT set_config('app.region_ids', '1,3,5', true);   -- or '*' for all regions
-- Missing/empty variable = no rows (fail closed). Table owner/migration role bypasses RLS; the app role must not own tables.
-- The audit and system logs are not region-filtered here (admin-only endpoints); audit_log.region_id is for reporting.

CREATE OR REPLACE FUNCTION app_region_visible(r integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.region_ids', true), '') = '' THEN false
    WHEN current_setting('app.region_ids', true) = '*' THEN true
    WHEN r IS NULL THEN true   -- region-less rows (global risks, meetings) are visible to everyone with a session
    ELSE r = ANY (string_to_array(current_setting('app.region_ids', true), ',')::int[])
  END
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'task_instances','document_slots','snags','baseline_entries','change_requests',
    'rf_design_records','acquisition_candidates','procurement_records','gecol_records','hlc_records',
    'permit_records','warehouse_serials','warehouse_site_qty','quality_inspections','issues','risks',
    'readiness_handover','as_built_records','meetings','import_batch_rows'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS region_filter ON %I', t);
    EXECUTE format('CREATE POLICY region_filter ON %I USING (app_region_visible(region_id)) WITH CHECK (app_region_visible(region_id))', t);
  END LOOP;
END $$;

-- sites is keyed by region_id too.
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS region_filter ON sites;
CREATE POLICY region_filter ON sites USING (app_region_visible(region_id)) WITH CHECK (app_region_visible(region_id));
