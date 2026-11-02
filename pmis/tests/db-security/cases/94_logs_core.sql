-- Logs core (migration 0045). pmis_app writes no log at all: the Audit Log, the field change log, the System Log, the security log, the hash
-- chains, the alerts, the job runs and the deployments are written only by triggers and SECURITY DEFINER functions. The security log and the
-- field change log are not readable directly; the readers check the grant (view_security_log) and the Audit Log scope (B4). A hash cannot be
-- forged and the chain head cannot be moved. Alice holds one CW entry assignment and no Audit Log, security log or Settings right.

-- @case LOG-01
-- @title Alice writes an audit row of her choosing straight into the Audit Log
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO audit_log (action, entity_type, entity_id, actor_id) VALUES ('forged', 'user', 'x', '{{ADMIN}}');
-- @end

-- @case LOG-02
-- @title Alice rewrites the reason of an existing audit row
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE audit_log SET reason = 'forged';
-- @end

-- @case LOG-03
-- @title Alice deletes the Audit Log
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM audit_log;
-- @end

-- @case LOG-04
-- @title Alice plants a field change
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO audit_field_changes (audit_id, at, action, entity_type, field) SELECT min(id), now(), 'forged', 'user', 'x' FROM audit_log;
-- @end

-- @case LOG-05
-- @title Alice edits a field change
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE audit_field_changes SET new_value = '"forged"';
-- @end

-- @case LOG-06
-- @title Alice deletes the field change log
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM audit_field_changes;
-- @end

-- @case LOG-07
-- @title Alice reads the field change log directly, outside her Audit Log scope
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM audit_field_changes;
-- @end

-- @case LOG-08
-- @title Alice reads the security log directly
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM security_log;
-- @end

-- @case LOG-09
-- @title Alice, without view_security_log, reads the security log through its reader
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or view_security_log required
SELECT count(*) FROM sec_log_read('{}'::jsonb, 10);
-- @end

-- @case LOG-10
-- @title Alice writes a sign-in success for the admin straight into the security log
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO security_log (event, outcome, user_id) VALUES ('sign_in_succeeded', 'success', '{{ADMIN}}');
-- @end

-- @case LOG-11
-- @title Alice deletes the security log
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM security_log;
-- @end

-- @case LOG-12
-- @title Alice stores a typed identifier as is through the writer
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 23514 security_log_identifier_hash_check
SELECT sec_log_write('sign_in_failed', 'failure', NULL, 'my-secret-password', NULL, '{}'::jsonb);
-- @end

-- @case LOG-13
-- @title Alice writes the System Log directly
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO system_log (level, source, message) VALUES ('info', 'api', 'forged');
-- @end

-- @case LOG-14
-- @title Alice deletes the System Log
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM system_log;
-- @end

-- @case LOG-15
-- @title Alice forges a hash chain entry
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO audit_log_chain (seq, audit_id, prev_hash, hash) SELECT 999999, min(id), repeat('0', 64), repeat('0', 64) FROM audit_log;
-- @end

-- @case LOG-16
-- @title Alice moves the head of the chain to hide a break
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE log_chain_heads SET hash = repeat('f', 64);
-- @end

-- @case LOG-17
-- @title Alice forges a security chain entry
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO security_log_chain (seq, security_id, prev_hash, hash) VALUES (999999, 1, repeat('0', 64), repeat('0', 64));
-- @end

-- @case LOG-18
-- @title Alice runs the integrity check, which only a System Admin may run
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SELECT log_verify_chain('audit', NULL, NULL);
-- @end

-- @case LOG-19
-- @title Alice acknowledges security alerts by writing the table
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE security_alerts SET status = 'acknowledged';
-- @end

-- @case LOG-20
-- @title Alice acknowledges an alert through the function
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SELECT sec_alert_ack(gen_random_uuid(), 'nothing to see');
-- @end

-- @case LOG-21
-- @title Alice reduces the log retention below the minimum
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin.settings edit required
SELECT log_set_retention(1, 1, 'Forged by SQL', NULL);
-- @end

-- @case LOG-23
-- @title Alice deletes job runs
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM job_runs;
-- @end

-- @case LOG-24
-- @title Alice records a fake deployment
-- @category logs-core
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT log_deployment('9.9.9', 'deadbeef', ARRAY['x'], 'alice', 'host');
-- @end

-- @case LOG-25
-- @title A session with no signed-in user writes an audit row through the writer
-- @category logs-core
-- @region 1
-- @expect error 42501 no signed-in actor
SELECT log_audit_write('forged', 'user', NULL, NULL, NULL, NULL);
-- @end
