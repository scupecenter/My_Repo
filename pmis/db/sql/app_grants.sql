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
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON wh_movements, wh_movement_lines, warehouse_item_need_rules, warehouse_items, warehouse_serials, warehouse_site_qty, as_built_items FROM pmis_app;  -- 0026, 0027: warehouse and As-Built items only through admin_save_* and wh_* / reg_* functions
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON notifications FROM pmis_app;  -- 0031: rows are created only by the definer functions; the owner of a row changes only read_at and snoozed_until (RLS limits them to their own rows)
GRANT UPDATE (read_at, snoozed_until) ON notifications TO pmis_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON watches, status_updates FROM pmis_app;  -- 0031: only through x_follow, x_unfollow, x_status_post and x_status_edit
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON template_definitions, template_versions, import_batches, import_batch_rows FROM pmis_app;  -- 0037: templates, versions, batches and rows are written only by tpl_sync*, imp_stage_batch, imp_submit_batch and imp_decide_batch
REVOKE ALL ON user_totp, user_recovery_codes, auth_pending FROM pmis_app;  -- 0033: encrypted TOTP secrets, recovery-code hashes and pending sign-ins only through auth_totp_*, auth_pending_* and idm_*_two_factor
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON weight_sets, weight_activities, weight_items, progress_snapshots, site_snapshots FROM pmis_app;  -- 0039: weights only through admin_save_weight_set / admin_publish_weight_set, snapshots only through dash_snapshot_take (never rewritten)
