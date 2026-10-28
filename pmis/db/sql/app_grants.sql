-- Deployment step (not a migration): table rights of the application role. Run as the migration role or a superuser
-- after every `migrate deploy`. Blanket grants first, then the narrowing that 001, 008 and 009 require.
GRANT USAGE ON SCHEMA public TO pmis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pmis_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pmis_app;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM pmis_app;      -- 001: append-only
SELECT idm_revoke_app_writes('pmis_app');                         -- 008: identity tables only through idm_*
REVOKE ALL ON local_credentials FROM pmis_app;                    -- 009: password hashes only through auth_local_*
REVOKE DELETE, TRUNCATE ON user_sessions FROM pmis_app;           -- 009: sessions are revoked, never deleted
