-- 0655_link_orphans_report: the orphan counts of the declared links, for the badge in the Settings links editor (D60 follow-up, contract 0.15.512).
-- Mirror: db/sql/654_link_orphans_report.sql (kept identical to prisma/migrations/0655_link_orphans_report/migration.sql). Additive; no table, no column, no change to an existing grant.
--
-- WHY. register_link_orphans() (0409) is a read-only report that no one can call but the database owner. The Settings links editor shows, next to each link, how many current
-- rows hold an id that is not a current record of the target, so an admin sees whether the check ("enforce") can be switched on. This adds one read door:
--   register_link_orphans_report(): System Admin only; one object per active link {register_key, field_code, target_register, rows_with_value, orphan_rows}. It reads, it never writes.
-- A new function is granted to the app role; nothing existing is widened.
CREATE OR REPLACE FUNCTION register_link_orphans_report() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT coalesce(public.app_actor_is_system_admin(), false) THEN
    RAISE EXCEPTION 'Only a System Admin reads the orphan report of the links.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(jsonb_build_object('register_key', o.register_key, 'field_code', o.field_code, 'target_register', o.target_register,
                                        'rows_with_value', o.rows_with_value, 'orphan_rows', o.orphan_rows))
      FROM public.register_link_orphans() o), '[]'::jsonb));
END $$;

DO $$
BEGIN
  ALTER FUNCTION register_link_orphans_report() OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION register_link_orphans_report() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION register_link_orphans_report() TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION register_link_orphans_report() TO pmis_app;
  END IF;
END $$;
