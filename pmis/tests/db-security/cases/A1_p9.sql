-- Work package P9 (migration 0055): the mail outbox, the role capabilities, the alert severities and the integrity runs. pmis_app reads none of the new
-- tables directly and changes them only through the SECURITY DEFINER functions; the functions check the actor (System Admin, view on
-- admin.system_log, reports view and the Audit Log scope). Alice holds one CW entry assignment and no admin, log or settings right.

-- @case P9-01
-- @title Alice reads the mail outbox directly (addresses and bodies)
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM mail_outbox;
-- @end

-- @case P9-02
-- @title Alice plants a mail straight into the outbox
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO mail_outbox (kind, to_address, subject, body_text) VALUES ('identity.notice', 'victim@example.test', 'Reset your password', 'http://evil.test');
-- @end

-- @case P9-03
-- @title Alice marks every mail as sent
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE mail_outbox SET status = 'sent';
-- @end

-- @case P9-04
-- @title Alice empties the outbox
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
DELETE FROM mail_outbox;
-- @end

-- @case P9-05
-- @title Alice reads the outbox through its reader
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or view on admin.system_log required
SELECT count(*) FROM mail_outbox_read('{}'::jsonb, 10);
-- @end

-- @case P9-06
-- @title Alice reads the mail status as a signed-in user
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or view on admin.system_log required
SELECT mail_stats('x');
-- @end

-- @case P9-07
-- @title Alice forges a security alert mail to the admin
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 reserved
SELECT mail_send_to_user('security_alert', '{{ADMIN}}', 'Critical: sign in here', 'http://evil.test', NULL, false);
-- @end

-- @case P9-08
-- @title Alice calls the internal writer of the queue (no cap, any kind)
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT mail_enqueue_internal('security_alert', 'victim@example.test', NULL, 's', 'b', NULL, false, '{"mandatory": true}'::jsonb);
-- @end

-- @case P9-09
-- @title Alice mails every System Admin through the internal fan-out
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT mail_to_system_admins('security_alert', 's', 'b', 'x', NULL);
-- @end

-- @case P9-10
-- @title Alice injects a Bcc header through the subject
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 23514 the subject is one line
SELECT mail_send_to_address('identity.notice', 'someone@example.test', E'Hello\r\nBcc: everyone@example.test', 'body', NULL, false);
-- @end

-- @case P9-11
-- @title Alice injects a second recipient through the address
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 23514 not a valid address
SELECT mail_send_to_address('identity.notice', E'someone@example.test>\r\nRCPT TO:<other@example.test', 'Hello', 'body', NULL, false);
-- @end

-- @case P9-12
-- @title Alice gives a mail that was given up another try
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SELECT mail_retry('00000000-0000-4000-8000-000000000001', 'try again');
-- @end

-- @case P9-13
-- @title Alice records a test mail as the proof that the channel works
-- @category p9-mail
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SELECT mail_test_enqueue('fp', 'test', 'test');
-- @end

-- @case P9-14
-- @title Alice gives the Project Manager role away to herself: audit_full_reader on a role
-- @category p9-capabilities
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SELECT idm_role_set_capabilities((SELECT id FROM roles WHERE code = 'CW_TL'), ARRAY['audit_full_reader'], 'I want to read everything');
-- @end

-- @case P9-15
-- @title Alice writes the capabilities column directly
-- @category p9-capabilities
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied|idm_
UPDATE roles SET capabilities = ARRAY['audit_full_reader'] WHERE code = 'CW_TL';
-- @end

-- @case P9-16
-- @title Alice sets the alert severities (lowers break-glass to info)
-- @category p9-alerts
-- @actor ALICE
-- @region 1
-- @expect error 42501 admin.settings edit required
SELECT log_set_alert_settings('{"failed_sign_ins": {"count": 5, "minutes": 15}, "failed_by_ip": {"count": 20, "minutes": 15}, "large_export_rows": 5000, "new_ip": true, "severity": {"break_glass_used": "info"}}'::jsonb, 'quiet please', NULL);
-- @end

-- @case P9-17
-- @title Alice raises an alert with a severity of her choosing
-- @category p9-alerts
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT sec_alert_raise_at('admin_set_changed', 'info', 'nothing to see', NULL, 'p9-forged', NULL, NULL);
-- @end

-- @case P9-18
-- @title Alice counts the Audit Log rows of an export she may not read
-- @category p9-export
-- @actor ALICE
-- @region 1
-- @expect error 42501 no reader right
SELECT log_audit_count('{}'::jsonb);
-- @end

-- @case P9-19
-- @title Alice counts the security log rows
-- @category p9-export
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin or view_security_log required
SELECT sec_log_count('{}'::jsonb);
-- @end

-- @case P9-20
-- @title Alice builds the monthly activity workbook
-- @category p9-export
-- @actor ALICE
-- @region 1
-- @expect error 42501 reports view required
SELECT log_activity_workbook(date '2026-11-01');
-- @end

-- @case P9-21
-- @title Alice reads the integrity runs directly
-- @category p9-integrity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT count(*) FROM log_integrity_runs;
-- @end

-- @case P9-22
-- @title Alice records a forged intact check
-- @category p9-integrity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO log_integrity_runs (log, trigger, status, from_seq, to_seq, checked_through) VALUES ('audit', 'manual', 'ok', 1, 1, 1);
-- @end

-- @case P9-23
-- @title Alice starts a check on demand
-- @category p9-integrity
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin only
SELECT log_integrity_start('audit', 'manual');
-- @end

-- @case P9-24
-- @title Alice, signed in, starts the nightly check (only the job may)
-- @category p9-integrity
-- @actor ALICE
-- @region 1
-- @expect error 42501 started by the job only
SELECT log_integrity_start('audit', 'nightly');
-- @end

-- @case P9-25
-- @title Alice reads the integrity results through the reader
-- @category p9-integrity
-- @actor ALICE
-- @region 1
-- @expect error 42501 System Admin required
SELECT count(*) FROM log_integrity_runs_read('{}'::jsonb, 10);
-- @end

-- @case P9-26
-- @title Alice verifies a slice of the chain without being audited (internal helper)
-- @category p9-integrity
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
SELECT * FROM log_chain_verify_slice('audit', 0, 10, repeat('0', 64));
-- @end

-- @case P9-27
-- @title The System Admin reads the outbox through its reader (positive control)
-- @category p9-mail
-- @actor ADMIN
-- @region *
-- @expect output >= 0
SELECT count(*) FROM mail_outbox_read('{}'::jsonb, 10);
-- @end
