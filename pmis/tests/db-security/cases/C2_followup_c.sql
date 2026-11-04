-- Follow-up group C of the technical decisions of 2026-11-04 (migration 0068; Q260, Q265, Q267, Q291, Q296, Q330, Q393). The Severity list is written only by its
-- mirror of the snag severities; accepting pending evidence needs the step-up flag and the old four-argument function is gone; only a System Admin cancels an
-- approved Quality snag record (the check comes before the record is read); the task field lists and the certificate alert counters are not written, and the delay
-- section is not called, by the application role.

-- @case FUC-01
-- @title Alice, who is not a System Admin, cancels an approved Quality snag record with the step-up flag already set
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:action_forbidden
SELECT qc_cancel_snag_record(gen_random_uuid(), 1, 'entered by mistake', true);
-- @end

-- @case FUC-02
-- @title Alice cancels a snag record without a reason or step-up (the admin check still comes first)
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error P0001 wf:action_forbidden
SELECT qc_cancel_snag_record(gen_random_uuid(), NULL, '', false);
-- @end

-- @case FUC-03
-- @title Control: the old four-argument evidence function is gone (one function is left, with the step-up flag)
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect output 1,5
SELECT count(*)::text || ',' || max(pronargs)::text FROM pg_proc WHERE proname = 'qc_decide_evidence';
-- @end

-- @case FUC-04
-- @title Alice deactivates the values of the Severity list directly, so every Quality snag record stops being approvable
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for table list_values
UPDATE list_values SET is_active = false WHERE catalogue_code = 'Severity';
-- @end

-- @case FUC-05
-- @title Alice adds a value to the Severity list of the Quality register directly
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for table list_values
INSERT INTO list_values (catalogue_code, code, label_en) VALUES ('Severity', 'TRIVIAL', 'Trivial');
-- @end

-- @case FUC-06
-- @title Alice runs the mirror of the snag severities herself
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function sync_severity_catalogue
SELECT sync_severity_catalogue();
-- @end

-- @case FUC-07
-- @title Alice calls the guard trigger function of the Severity list directly
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function severity_catalogue_guard
SELECT severity_catalogue_guard();
-- @end

-- @case FUC-08
-- @title Alice points a task field of the stream templates at another list, to change what a template accepts
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for table template_task_fields
UPDATE template_task_fields SET list_catalogue = NULL, options = '["Done"]'::jsonb WHERE list_catalogue = 'CompletionStatus';
-- @end

-- @case FUC-09
-- @title Alice refreshes the options of the task fields herself
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function tpl_task_fields_refresh
SELECT tpl_task_fields_refresh();
-- @end

-- @case FUC-10
-- @title Alice resets the counter of the certificate alerts, so every team is alerted again (or never again)
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for table contractor_alerts_sent
UPDATE contractor_alerts_sent SET last_sent_on = DATE '2000-01-01';
-- @end

-- @case FUC-11
-- @title Control: the daily contractor alerts (where the weekly certificate reminder lives) are the job's function; the application role may call it, and it only returns how many it sent
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect output t
SELECT (contractors_daily_alerts() >= 0);
-- @end

-- @case FUC-12
-- @title Alice calls the delay section of the dashboard directly (the scorecard with the pending SLA rules left out)
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect error 42501 permission denied for function dash_sec_delay
SELECT dash_sec_delay(cal_today());
-- @end

-- @case FUC-13
-- @title Control: the Severity list holds the three snag severity codes in order, from the mirror
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect output CRITICAL,MAJOR,MINOR
SELECT string_agg(code, ',' ORDER BY sort_order) FROM list_values WHERE catalogue_code = 'Severity' AND is_active;
-- @end

-- @case FUC-14
-- @title Control: the Meetings register has the optional text field external_attendees
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect output text,false
SELECT field_type || ',' || required::text FROM register_fields WHERE register_key = 'meetings' AND code = 'external_attendees';
-- @end

-- @case FUC-15
-- @title Control: the Done / Pending / N/A task fields of the stream templates read the CompletionStatus list and carry its codes
-- @category followup_c
-- @actor ALICE
-- @region 1
-- @expect output t
SELECT bool_and(options = '["Done", "Pending", "N/A"]'::jsonb) AND count(*) >= 12 FROM template_task_fields WHERE list_catalogue = 'CompletionStatus';
-- @end
