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
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON document_types, document_type_placements, document_slots, document_files, document_type_versions, document_type_drafts, document_blank_forms, document_export_jobs, document_task_snapshots FROM pmis_app;  -- 0038: the Document Library, slots, files and zip jobs only through admin_save_document_type, admin_publish_document_type, doc_attach_file, doc_withdraw_file, doc_add_slot, doc_blank_form_attach, doc_job_* (audited)
REVOKE ALL ON document_task_snapshots FROM pmis_app;  -- 0038: internal bookkeeping of the slot snapshot
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_log, system_log FROM pmis_app;  -- 0045: no log is written by pmis_app; audit rows of the API go through log_audit_write, the System Log through log_system_write
REVOKE ALL ON audit_field_changes, audit_log_chain, security_log, security_log_chain, log_chain_heads, job_runs, deployments, security_alerts, security_alert_state FROM pmis_app;  -- 0045: read only through log_*_read / sec_*_read (B4 scope, view_security_log); written only by the triggers, sec_log_write, job_run_*, sec_alert_* and log_deployment
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON team_scope_match_meta, team_scope_match_scopes, team_scope_match FROM pmis_app;  -- 0043: the team / scope match of Procurement (Q97) only through admin_save_team_scope_match (admin.settings edit, reason, If-Match, audited)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON snags, snag_photos, snag_types FROM pmis_app;  -- 0047: QC snags, their photos and the snag types only through qc_raise_snag, qc_save_snag, qc_attach_photo, qc_withdraw_photo, qc_transition_snag and admin_save_snag_type (audited)
REVOKE ALL ON document_record_snapshots FROM pmis_app;  -- 0047: internal bookkeeping of the slot snapshot of a register record (record slots only through doc_attach_file, doc_withdraw_file, doc_add_record_slot, doc_record_reject)
REVOKE ALL ON email_change_requests FROM pmis_app;  -- 0044: email change requests (self-service profile) only through idm_request_email_change, idm_cancel_email_change, idm_decide_email_change, idm_my_email_changes and idm_email_change_list
REVOKE ALL ON stored_object_meta FROM pmis_app;  -- 0048: envelopes and scan state of stored objects only through the storage_* functions (owner pmis_definer); the API never reads or writes the table
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ps_manual_values, task_delay_periods, dash_snapshot_runs FROM pmis_app;  -- 0046: manual Project Status values only through ps_manual_set, delay periods only through delay_period_add / delay_period_void, snapshot runs only through dash_snapshot_scheduled
