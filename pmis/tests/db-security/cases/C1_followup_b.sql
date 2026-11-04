-- Follow-up group B of the technical decisions of 2026-11-04, migration 0067 (Q245, Q253, Q257, Q270). The application role cannot reset the calendar
-- confirmation outside the daily job, write an audit row of its own, forge the anchor mail to the System Admins, move quarantined stock out of
-- quarantine around a document (direct rows, serial status, the posting trigger), or create a quarantine exit without the Warehouse create right.
-- Positive controls: the job (no signed-in person) may run the reset; a reader still reads the stock with the new pending quarantine column.

-- @case FB-01
-- @title Alice, signed in, resets the calendar confirmation (only the daily job may)
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 daily job only
SELECT cal_official_confirmed_reset();
-- @end

-- @case FB-02
-- @title Alice switches the calendar confirmation on by a direct update
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = 'true' WHERE key = 'calendar.official_confirmed' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case FB-03
-- @title Alice shortens the mail retention by a direct update, so the outbox is purged earlier
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect output 0
WITH u AS (UPDATE settings SET value = '7' WHERE key = 'mail.retention_days' RETURNING 1) SELECT count(*) FROM u;
-- @end

-- @case FB-04
-- @title Alice writes an audit row of her own through the job audit helper
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT followup_audit('calendar_official_confirmed_reset', 'setting', 'calendar.official_confirmed', NULL, NULL, 'forged');
-- @end

-- @case FB-05
-- @title Alice mails a forged integrity head to a System Admin (the kind is reserved for the database)
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 reserved
SELECT mail_send_to_user('integrity_head', '{{ADMIN}}'::uuid, 'Integrity check ok: head 000000000000', 'Head hash: 0000', NULL, false);
-- @end

-- @case FB-06
-- @title Alice mails a forged integrity head to an outside address
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 reserved
SELECT mail_send_to_address('integrity_head', 'someone@example.test', 'Integrity check ok: head 000000000000', 'Head hash: 0000', NULL, false);
-- @end

-- @case FB-07
-- @title Alice queues the anchor mail directly in the outbox
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO mail_outbox (kind, to_address, subject, body_text) VALUES ('integrity_head', 'a@example.test', 'head', 'x');
-- @end

-- @case FB-08
-- @title Alice finishes an integrity check that does not exist (the function checks the run before it mails anything)
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error P0001 not_found
SELECT log_integrity_finish(gen_random_uuid(), NULL);
-- @end

-- @case FB-09
-- @title Alice inserts a quarantine exit movement directly
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
INSERT INTO wh_movements (entity_id, record_id, record_type, kind, exit_kind, is_global) VALUES (gen_random_uuid(), gen_random_uuid(), 'adj', 'quarantine_exit', 'repaired', true);
-- @end

-- @case FB-10
-- @title Alice puts a quarantined serial back In Stock by a direct update, without a document
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE warehouse_serials SET status = 'In Stock' WHERE status = 'Returned';
-- @end

-- @case FB-11
-- @title Alice calls the posting trigger function of the warehouse documents
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function
SELECT wh_on_state();
-- @end

-- @case FB-12
-- @title Alice, without the Warehouse create right, creates a quarantine exit
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error P0001 action_forbidden
SELECT wh_create_quarantine_exit('written_off', '{"exit_reason": "Scrapped without a right"}'::jsonb, '[{"item_id": "00000000-0000-4000-8000-000000000001", "qty": 1}]'::jsonb);
-- @end

-- @case FB-13
-- @title A quarantine exit with an unknown kind is refused
-- @category followup-b
-- @actor ADMIN
-- @region 1
-- @expect error P0001 validation_failed
SELECT wh_create_quarantine_exit('melted', '{"exit_reason": "No such kind"}'::jsonb, '[{"item_id": "00000000-0000-4000-8000-000000000001", "qty": 1}]'::jsonb);
-- @end

-- @case FB-14
-- @title A quarantine exit without a reason is refused
-- @category followup-b
-- @actor ADMIN
-- @region 1
-- @expect error P0001 validation_failed
SELECT wh_create_quarantine_exit('repaired', '{}'::jsonb, '[{"item_id": "00000000-0000-4000-8000-000000000001", "qty": 1}]'::jsonb);
-- @end

-- @case FB-15
-- @title Alice writes the sequence of the supplier DN directly, to reuse a number
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied
UPDATE doc_sequence_counters SET next_value = 1 WHERE seq_key = 'DN-SUP-WH';
-- @end

-- @case FB-16
-- @title The daily job (no signed-in person) may run the reset: nothing to reset on a fresh database
-- @category followup-b
-- @actor none
-- @expect output 0
SELECT cal_official_confirmed_reset();
-- @end

-- @case FB-17
-- @title A reader sees the stock with the quarantine columns
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect output >= 0
SELECT count(*) FROM wh_stock_levels() WHERE quarantine >= 0 AND quarantine_pending >= 0;
-- @end

-- @case FB-18
-- @title The default of the mail retention is 30 days
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect output 30
SELECT value::text FROM settings WHERE key = 'mail.retention_days';
-- @end

-- @case FB-19
-- @title The supplier DN has its own sequence
-- @category followup-b
-- @actor ALICE
-- @region 1
-- @expect output 1
SELECT count(*) FROM doc_sequences WHERE key = 'DN-SUP-WH' AND record_type = 'sup_dn' AND region_id IS NULL;
-- @end
