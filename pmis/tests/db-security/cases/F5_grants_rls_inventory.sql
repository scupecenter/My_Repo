-- Grants and row-level security inventory (QA request of the security review, 2026-11-26). Test only: nothing here changes behaviour.
--
-- Two questions, answered from the catalogue as pmis_app:
--   1. RLS coverage. Every ordinary table of the public schema has row-level security enabled, or is listed below as an explicit exemption with its reason.
--      A table added later without RLS fails RL-INV-01 until its author either enables RLS or adds it to the list (and says why). A listed table that
--      gets RLS, or is dropped, fails RL-INV-02, so the list cannot rot.
--   2. pmis_app grants. The application role never holds TRUNCATE, REFERENCES or TRIGGER on any table (RL-INV-03); the account tables (local_credentials,
--      user_totp, user_recovery_codes, auth_pending, the two change-request tables and the context keys) have no RLS and rely on the ABSENCE of any direct
--      grant, so every privilege, also at column level, is tested absent (RL-INV-04); and the set of tables pmis_app may write directly is an explicit allowlist
--      (RL-INV-05), so a new INSERT, UPDATE or DELETE grant fails until it is reviewed and added here.
-- When a case fails, the output names the tables. The exemption and allowlist texts are inline in each case on purpose (one case = one statement).

-- @case RL-INV-01
-- @title Every public table has RLS enabled or is a listed exemption (no table is silently unprotected)
-- @category grants-rls
-- @expect output none
SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), 'none')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND NOT c.relrowsecurity
  AND c.relname NOT IN (SELECT t FROM (VALUES
  -- account tables: no RLS and NO direct grant to pmis_app (they are reached only through SECURITY DEFINER doors; see RL-INV-04)
    ('local_credentials'),
    ('user_totp'),
    ('user_recovery_codes'),
    ('auth_pending'),
    ('email_change_requests'),
    ('phone_change_requests'),
  -- closed tables: no RLS and no grant at all for pmis_app (written and read by owner-side functions only)
    ('audit_field_changes'),
    ('audit_log_chain'),
    ('contractor_alerts_sent'),
    ('data_reset_marker'),
    ('data_reset_request_files'),
    ('data_reset_requests'),
    ('deployments'),
    ('job_runs'),
    ('log_chain_heads'),
    ('log_integrity_runs'),
    ('mail_outbox'),
    ('security_alert_state'),
    ('security_alerts'),
    ('security_log'),
    ('security_log_chain'),
    ('staff_registry'),
    ('staff_registry_visibility_entries'),
    ('staff_registry_visibility_fields'),
    ('staff_registry_visibility_state'),
    ('stored_object_meta'),
    ('team_scope_checks'),
  -- global reference, identity and log tables: read-only for pmis_app (SELECT only), no regional scope to enforce
    ('audit_log'),
    ('contractor_rules'),
    ('delegation_grants'),
    ('delegation_regions'),
    ('delegations'),
    ('departments'),
    ('dlp_versions'),
    ('document_site_overrides'),
    ('external_party_contracts'),
    ('external_party_type_map'),
    ('external_team_specializations'),
    ('group_members'),
    ('groups'),
    ('master_columns'),
    ('nav_item_catalogue'),
    ('system_log'),
    ('team_scope_match'),
    ('team_scope_match_groups'),
    ('team_scope_match_meta'),
    ('team_scope_match_scopes'),
    ('team_specializations'),
    ('template_parts'),
    ('template_task_fields'),
    ('template_task_rules'),
    ('user_role_assignment_modules'),
    ('user_role_assignment_profiles'),
    ('user_role_assignment_regions'),
    ('user_role_assignments'),
    ('user_sessions'),
    ('users'),
  -- register locks: no RLS, written by pmis_app through the lock doors and the register service (listed in the write allowlist too)
    ('register_column_locks'),
    ('register_record_locks')
  ) AS ex(t));
-- @end

-- @case RL-INV-02
-- @title Every exempt table still exists and still has no RLS (a table that gains RLS or is dropped leaves the list)
-- @category grants-rls
-- @expect output none
SELECT coalesce(string_agg(ex.t, ', ' ORDER BY ex.t), 'none')
FROM (VALUES
  ('local_credentials'),
  ('user_totp'),
  ('user_recovery_codes'),
  ('auth_pending'),
  ('email_change_requests'),
  ('phone_change_requests'),
  ('audit_field_changes'),
  ('audit_log_chain'),
  ('contractor_alerts_sent'),
  ('data_reset_marker'),
  ('data_reset_request_files'),
  ('data_reset_requests'),
  ('deployments'),
  ('job_runs'),
  ('log_chain_heads'),
  ('log_integrity_runs'),
  ('mail_outbox'),
  ('security_alert_state'),
  ('security_alerts'),
  ('security_log'),
  ('security_log_chain'),
  ('staff_registry'),
  ('staff_registry_visibility_entries'),
  ('staff_registry_visibility_fields'),
  ('staff_registry_visibility_state'),
  ('stored_object_meta'),
  ('team_scope_checks'),
  ('audit_log'),
  ('contractor_rules'),
  ('delegation_grants'),
  ('delegation_regions'),
  ('delegations'),
  ('departments'),
  ('dlp_versions'),
  ('document_site_overrides'),
  ('external_party_contracts'),
  ('external_party_type_map'),
  ('external_team_specializations'),
  ('group_members'),
  ('groups'),
  ('master_columns'),
  ('nav_item_catalogue'),
  ('system_log'),
  ('team_scope_match'),
  ('team_scope_match_groups'),
  ('team_scope_match_meta'),
  ('team_scope_match_scopes'),
  ('team_specializations'),
  ('template_parts'),
  ('template_task_fields'),
  ('template_task_rules'),
  ('user_role_assignment_modules'),
  ('user_role_assignment_profiles'),
  ('user_role_assignment_regions'),
  ('user_role_assignments'),
  ('user_sessions'),
  ('users'),
  ('register_column_locks'),
  ('register_record_locks')
) AS ex(t)
WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = ex.t AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity);
-- @end

-- @case RL-INV-03
-- @title pmis_app holds no TRUNCATE, REFERENCES or TRIGGER privilege on any table
-- @category grants-rls
-- @expect output none
SELECT coalesce(string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p), 'none')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS pr(p)
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege('pmis_app', c.oid, p);
-- @end

-- @case RL-INV-04
-- @title The account tables have no RLS and no grant at all for pmis_app (table or column level, every privilege): the absence of the grant is the protection
-- @category grants-rls
-- @expect output none
SELECT coalesce(string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p), 'none')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS pr(p)
WHERE n.nspname = 'public' AND c.relname IN ('local_credentials', 'user_totp', 'user_recovery_codes', 'auth_pending', 'email_change_requests', 'phone_change_requests', 'pmis_context_keys')
  AND (has_table_privilege('pmis_app', c.oid, p) OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege('pmis_app', c.oid, p)));
-- @end

-- @case RL-INV-05
-- @title The tables on which pmis_app holds a table-level INSERT, UPDATE or DELETE are within the reviewed allowlist; a new write grant fails until reviewed
-- @category grants-rls
-- @expect output none
SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), 'none')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND (has_table_privilege('pmis_app', c.oid, 'INSERT') OR has_table_privilege('pmis_app', c.oid, 'UPDATE') OR has_table_privilege('pmis_app', c.oid, 'DELETE'))
  AND c.relname NOT IN ('assignment_readiness', 'baseline_entries', 'baseline_versions', 'clusters', 'field_definitions', 'field_list_values', 'field_set_versions', 'meeting_actions', 'meetings', 'quality_inspections', 'regions', 'register_column_locks', 'register_record_locks', 'settings', 'task_field_sources', 'vehicle_reservations', 'workflow_streams', 'workflow_view_members', 'workflow_views');
-- @end

-- @case RL-INV-06
-- @title Every table pmis_app may write has RLS (or is one of the two register lock tables, whose writes go through the lock doors and are guarded there)
-- @category grants-rls
-- @expect output none
SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), 'none')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND NOT c.relrowsecurity
  AND (has_table_privilege('pmis_app', c.oid, 'INSERT') OR has_table_privilege('pmis_app', c.oid, 'UPDATE') OR has_table_privilege('pmis_app', c.oid, 'DELETE'))
  AND c.relname NOT IN ('register_column_locks', 'register_record_locks');
-- @end

-- @case RL-INV-07
-- @title Column-level write grants (INSERT or UPDATE on named columns only) exist on the four reviewed tables only: notifications, sites, user_sessions, users
-- @category grants-rls
-- @expect output none
SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), 'none')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND (has_any_column_privilege('pmis_app', c.oid, 'INSERT') OR has_any_column_privilege('pmis_app', c.oid, 'UPDATE'))
  AND NOT (has_table_privilege('pmis_app', c.oid, 'INSERT') OR has_table_privilege('pmis_app', c.oid, 'UPDATE'))
  AND c.relname NOT IN ('notifications', 'sites', 'user_sessions', 'users');
-- @end
