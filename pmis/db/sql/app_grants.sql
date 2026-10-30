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
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON register_records, register_steps, register_level_actors, register_level_voters, register_definitions, register_fields, register_task_sources, procurement_records, gecol_records, hlc_records, permit_records FROM pmis_app;  -- 0019: register records and their approved projections only through reg_* functions
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON holidays, work_calendars, sla_rules, sla_rule_sets, sla_rule_set_items, permit_types FROM pmis_app;  -- 0017: calendar and SLA configuration only through admin_save_holiday, admin_delete_holiday, admin_save_weekend_days and the admin_*_sla_rule_set functions (audited, with a reason)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON site_gate_state FROM pmis_app;  -- 0018: written only by calc_gate_watch (the calculation layer, owner pmis_definer)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON matrix_cells, matrix_cell_assignees, matrix_state FROM pmis_app;  -- 0020: the Responsibility Matrix is written only through matrix_save (audited, with a reason, If-Match)
