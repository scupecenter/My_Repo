-- 0474_archive_marks: the signed and stamped markers (0555) in the Archive. Two read-only columns and two filter fields on Library > Archive, and the same two
-- columns in the zip index. Additive and idempotent. No table: the markers stay append-only audit rows.
--   * doc_file_marked(file, what): whether the latest marker of one file says signed or stamped (what = 'signed' | 'stamped'). SECURITY DEFINER, as doc_file_marks.
--   * library_archive_columns() lists the two new columns, so Settings > Documents > Archive can switch them on. A project that already saved its column list keeps
--     it as it is (the new columns are off until an administrator turns them on); a project that never saved one gets them in the default order.
-- Nothing blocks: no status, gate or approval reads the markers.
-- Mirror: db/sql/473_archive_marks.sql (kept identical to prisma/migrations/0474_archive_marks/migration.sql).

GRANT SELECT ON audit_log TO pmis_definer;

CREATE OR REPLACE FUNCTION doc_file_marked(p_file uuid, p_what text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v text;
BEGIN
  IF public.app_actor() IS NULL OR p_file IS NULL OR p_what NOT IN ('signed', 'stamped') THEN RETURN false; END IF;
  SELECT a.after ->> p_what INTO v FROM public.audit_log a
   WHERE a.action = 'document_file_marked' AND a.entity_id = p_file::text ORDER BY a.id DESC LIMIT 1;
  RETURN coalesce(v = 'true', false);
END $$;

CREATE OR REPLACE FUNCTION library_archive_columns() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['site', 'site_name', 'region', 'cluster', 'doc_type', 'doc_number', 'version', 'status', 'task', 'uploaded_by', 'uploaded_at', 'approved_by', 'approved_at', 'signed', 'stamped']
$$;

DO $$
BEGIN
  ALTER FUNCTION doc_file_marked(uuid, text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION doc_file_marked(uuid, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION doc_file_marked(uuid, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION doc_file_marked(uuid, text) TO pmis_app;
  END IF;
END $$;
