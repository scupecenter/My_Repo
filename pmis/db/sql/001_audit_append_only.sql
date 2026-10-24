-- 001: audit_log is append-only. Apply through a Prisma migration (migrate dev --create-only, paste, migrate deploy).
-- Two layers: (1) triggers that raise on UPDATE/DELETE/TRUNCATE, (2) REVOKE for the application role.

CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

-- The application connects as role pmis_app (created by the deployment, not by Prisma).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM pmis_app;
    GRANT SELECT, INSERT ON audit_log TO pmis_app;
    GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO pmis_app;
  END IF;
END $$;

-- Retention: audit_log is never purged (10 years minimum). system_log purge job runs as the owner role
-- and deletes only system_log rows older than 12 months; it has no access path to audit_log.
