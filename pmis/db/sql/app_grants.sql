-- Deployment step (not a migration): table rights of the application role. Run as the migration role or a superuser
-- after every `migrate deploy`. Blanket grants first, then the narrowing that 001, 008 and 009 require.
GRANT USAGE ON SCHEMA public TO pmis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pmis_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pmis_app;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM pmis_app;      -- 001: append-only
SELECT idm_revoke_app_writes('pmis_app');                         -- 008: identity tables only through idm_*
REVOKE ALL ON local_credentials FROM pmis_app;                    -- 009: password hashes only through auth_local_*
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON user_sessions FROM pmis_app;  -- 013: created only by auth_session_create, never deleted
GRANT UPDATE (last_activity_at, stepup_at, current_screen, revoked_at, revoked_by, revoke_reason) ON user_sessions TO pmis_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON departments, message_threads, message_participants, messages, announcements,
  announcement_targets, announcement_recipients, announcement_responses FROM pmis_app;  -- 010: only through idm_*, msg_*, ann_*
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON task_instances, workflow_steps, comments, task_level_actors, task_level_voters, comment_mentions FROM pmis_app;  -- 014: the approval engine writes only through wf_* functions
