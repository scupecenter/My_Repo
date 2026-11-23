-- 0145_settings_screens_api: the system-settings routes the web calls that no controller served (contract 0.15.59, CHANGELOG 197).
-- Mirror: db/sql/144_settings_screens_api.sql (kept byte-identical).
--
--   1. DLP (CLAUDE.md "Defects Liability Period"): dlp_versions holds the versions of dlp.months.cw (default 3) and dlp.months.te (default 12), each with an
--      effective date, a reason and who published it. Version 1 is seeded from the values in force (the settings rows, else the defaults). dlp_months_at(key, date)
--      is the value in force on a date. A PAC keeps the value in force when it was issued: sla_resolve_start (latest 0076) is wrapped so that the start event
--      DLP:<task>:<key> adds the months in force on the PAC date (the date of <task>), not today's. calc_setting (latest 0017) answers the two keys from the versions
--      (the version in force today), so every reader of the current value (the baseline proposal, the Master DLP end column) follows the versions table.
--      admin_publish_dlp: System Admin or a delegate of admin.settings edit for all regions, reason, step-up, effective date not in the past and not before the
--      latest version (a PAC already issued never changes, Q600); one audit row with before and after.
--   2. Idle-task alert (CLAUDE.md B12b, default 2 working days, a setting): the working days ARE the existing dashboard setting stale_idle_days (migration 0113,
--      Q523: the same concept, one limit for every task), so they are not duplicated: the door writes that key. Only the on/off switch is new (setting
--      tasks.idle_alert, guarded). The version (ETag) is the sum of the two settings' versions, so a change made from either screen moves it.
--   3. Notification policy (CLAUDE.md "Administration screens"): the catalogue of the governed types (notif_catalogue, system-defined) and the policy in the setting
--      notifications.policy (guarded): on/off, timezone (Africa/Tripoli), digest hour, thresholds with their ranges, the type x role/group matrix with channels.
--      admin_set_notification_policy validates the whole body in the database: an unknown key anywhere is a field error (unknown_key), the ranges, the cross-field rule
--      (approval_escalate_days * 24 > approval_remind_hours, must_exceed_remind_hours on both paths), the IANA timezone (invalid_timezone), mandatory types
--      (mandatory_locked; the System Admins group must stay a column and keep the mandatory types on), recipients the type does not allow (not_eligible_recipient).
--      A change of a security or system row, of rate_cap_per_hour, of the switch, the timezone, the digest hour or the working days needs a System Admin (a delegate
--      gets delegate_forbidden) and a step-up, and tells the System Admins in-app. Versioned and audited with before and after.
--   4. Holidays import (B12, ADR 0011: the approved xlsx template TPL-HOLIDAYS only): the template kind holidays and its first version; tpl_sync (latest 0105)
--      knows the kind; admin_import_holidays inserts the rows of one file in one statement (all or nothing, field errors per line), so the SLA due dates of open
--      tasks are recalculated once (the statement trigger of 0017); one audit row per holiday and one for the import.
--
-- Every new function is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked. pmis_app executes the entry points
-- only (the readers, the four doors, and dlp_months_at, which calc_setting calls in the session of the reader). pmis_app never writes dlp_versions (app_grants.sql).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 0. Rights of the definer role
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON settings, holidays, work_calendars, users, groups, group_members, roles, task_instances, task_definitions TO pmis_definer;
GRANT INSERT, UPDATE ON settings TO pmis_definer;
GRANT INSERT ON holidays, notifications TO pmis_definer;
GRANT SELECT ON template_definitions, template_versions TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. DLP versions
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE dlp_versions (
  version        integer PRIMARY KEY CHECK (version >= 1),
  cw_months      integer NOT NULL CHECK (cw_months BETWEEN 0 AND 120),
  te_months      integer NOT NULL CHECK (te_months BETWEEN 0 AND 120),
  effective_from date    NOT NULL,
  reason         text,
  changed_by     uuid REFERENCES users(id),
  changed_at     timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX dlp_versions_effective ON dlp_versions (effective_from, version);
GRANT SELECT, INSERT ON dlp_versions TO pmis_definer;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON dlp_versions FROM pmis_app;
  END IF;
END $$;

-- version 1: the values in force before this migration (the settings rows of 0017 when an installer set them, else the defaults of CLAUDE.md)
INSERT INTO dlp_versions (version, cw_months, te_months, effective_from, reason)
SELECT 1,
  coalesce((SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric::integer END FROM settings WHERE key = 'dlp.months.cw'), 3),
  coalesce((SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric::integer END FROM settings WHERE key = 'dlp.months.te'), 12),
  DATE '2020-01-01', 'seed: the defaults of CLAUDE.md (CW 3 months, TE 12 months), migration 0145'
ON CONFLICT (version) DO NOTHING;

-- A text that is an ISO date (YYYY-MM-DD, a real day) as a date, else NULL (never an error).
CREATE OR REPLACE FUNCTION ssa_iso_date(p text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN NULL; END IF;
  IF to_char(p::date, 'YYYY-MM-DD') <> p THEN RETURN NULL; END IF;
  RETURN p::date;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- The months of dlp.months.cw or dlp.months.te in force on a date (NULL date = today): the highest version whose effective date is on or before it; before the
-- first version, the first version. NULL for another key or when the table is empty.
CREATE OR REPLACE FUNCTION dlp_months_at(p_key text, p_on date DEFAULT NULL) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_key WHEN 'dlp.months.cw' THEN v.cw_months WHEN 'dlp.months.te' THEN v.te_months END
  FROM (SELECT * FROM public.dlp_versions
        ORDER BY (effective_from <= coalesce(p_on, public.cal_today())) DESC,
                 CASE WHEN effective_from <= coalesce(p_on, public.cal_today()) THEN version END DESC NULLS LAST, version
        LIMIT 1) v
  WHERE p_key IN ('dlp.months.cw', 'dlp.months.te')
$$;

-- calc_setting as built in 0017, plus: the two DLP keys come from the versions (the version in force today). It is plpgsql so that the helper is called only for
-- those two keys.
CREATE OR REPLACE FUNCTION calc_setting(p_key text, p_default jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE m integer;
BEGIN
  IF p_key IN ('dlp.months.cw', 'dlp.months.te') THEN
    m := public.dlp_months_at(p_key, NULL);
    IF m IS NOT NULL THEN RETURN to_jsonb(m); END IF;
  END IF;
  RETURN coalesce((SELECT value FROM public.settings WHERE key = p_key), p_default);
END $$;

-- One DLP version as the API returns it (DlpVersion).
CREATE OR REPLACE FUNCTION dlp_version_json(v public.dlp_versions) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('version', v.version, 'cw_months', v.cw_months, 'te_months', v.te_months, 'effective_from', v.effective_from,
           'reason', v.reason, 'changed_at', v.changed_at)
         || CASE WHEN v.changed_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('changed_by', public.wfe_user_ref(v.changed_by)) END
$$;

-- GET /settings/dlp: every signed-in user (the DLP end is shown on the site and the forms). current = the version in force today; history newest first.
CREATE OR REPLACE FUNCTION dlp_settings_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur public.dlp_versions%ROWTYPE;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'dlp settings: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO cur FROM public.dlp_versions
  ORDER BY (effective_from <= public.cal_today()) DESC, CASE WHEN effective_from <= public.cal_today() THEN version END DESC NULLS LAST, version LIMIT 1;
  RETURN jsonb_build_object(
    'current', CASE WHEN cur.version IS NULL THEN NULL ELSE public.dlp_version_json(cur) END,
    'history', coalesce((SELECT jsonb_agg(public.dlp_version_json(v) ORDER BY v.version DESC) FROM public.dlp_versions v), '[]'::jsonb));
END $$;

-- POST /settings/dlp/versions. p_body = {cw_months, te_months, effective_from} (closed); the reason apart.
CREATE OR REPLACE FUNCTION admin_publish_dlp(p_body jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  errs jsonb := '[]'::jsonb; k text; x text; n numeric; eff date; latest public.dlp_versions%ROWTYPE; before_v public.dlp_versions%ROWTYPE;
  nv public.dlp_versions%ROWTYPE; today date := public.cal_today();
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with cw_months, te_months and effective_from.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('cw_months', 'te_months', 'effective_from') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  FOREACH x IN ARRAY ARRAY['cw_months', 'te_months'] LOOP
    IF NOT (p_body ? x) OR jsonb_typeof(p_body -> x) = 'null' THEN
      errs := errs || public.reg_err_item('/' || x, 'required', 'A whole number of months from 0 to 120 is required.');
    ELSIF jsonb_typeof(p_body -> x) <> 'number' OR (p_body ->> x)::numeric <> trunc((p_body ->> x)::numeric) THEN
      errs := errs || public.reg_err_item('/' || x, 'invalid', 'A whole number of months.');
    ELSE
      n := (p_body ->> x)::numeric;
      IF n < 0 OR n > 120 THEN errs := errs || public.reg_err_item('/' || x, 'out_of_range', 'From 0 to 120 months.'); END IF;
    END IF;
  END LOOP;
  IF jsonb_typeof(p_body -> 'effective_from') IS DISTINCT FROM 'string' THEN
    errs := errs || public.reg_err_item('/effective_from', 'required', 'The date the version takes effect (YYYY-MM-DD) is required.');
  ELSIF public.ssa_iso_date(p_body ->> 'effective_from') IS NULL THEN
    errs := errs || public.reg_err_item('/effective_from', 'invalid', 'Use YYYY-MM-DD.');
  ELSE
    eff := (p_body ->> 'effective_from')::date;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('dlp_versions'));  -- one publisher at a time (the definer has no UPDATE right to lock the table)
    SELECT * INTO latest FROM public.dlp_versions ORDER BY version DESC LIMIT 1;
    -- Q600: a version never reaches back: a PAC issued before today keeps the version in force on its date
    IF eff < today THEN
      errs := errs || public.reg_err_item('/effective_from', 'in_the_past', 'A DLP version takes effect today or later; a PAC already issued keeps the version in force on its date.');
    ELSIF latest.version IS NOT NULL AND eff < latest.effective_from THEN
      errs := errs || public.reg_err_item('/effective_from', 'before_latest_version', 'The date is before the effective date of the latest version (' || latest.effective_from || ').');
    END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  SELECT * INTO before_v FROM public.dlp_versions
  ORDER BY (effective_from <= eff) DESC, CASE WHEN effective_from <= eff THEN version END DESC NULLS LAST, version LIMIT 1;
  INSERT INTO public.dlp_versions (version, cw_months, te_months, effective_from, reason, changed_by, changed_at)
  VALUES (coalesce(latest.version, 0) + 1, (p_body ->> 'cw_months')::numeric::integer, (p_body ->> 'te_months')::numeric::integer, eff, btrim(p_reason), public.app_actor(), clock_timestamp())
  RETURNING * INTO nv;
  -- the settings rows keep the value in force today, for anyone who reads the table itself
  IF eff <= today THEN
    INSERT INTO public.settings (key, value, description, updated_by, updated_at) VALUES
      ('dlp.months.cw', to_jsonb(nv.cw_months), 'CW Defects Liability Period in months, from the PAC date (versioned in dlp_versions, migration 0145).', public.app_actor(), now()),
      ('dlp.months.te', to_jsonb(nv.te_months), 'TE Defects Liability Period in months, from the PAC date (versioned in dlp_versions, migration 0145).', public.app_actor(), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  END IF;
  PERFORM public.log_audit_write('dlp_version_publish', 'setting', 'dlp', CASE WHEN before_v.version IS NULL THEN NULL ELSE public.dlp_version_json(before_v) - 'changed_by' END,
    public.dlp_version_json(nv) - 'changed_by', btrim(p_reason));
  RETURN public.dlp_version_json(nv);
END $$;

-- sla_resolve_start (latest 0076) with the DLP start event in force on the PAC date. Every other start event is the earlier function's.
ALTER FUNCTION sla_resolve_start(uuid, text) RENAME TO sla_resolve_start_pre_0145;
CREATE FUNCTION sla_resolve_start(p_task uuid, p_ref text) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t public.task_instances%ROWTYPE; d date; key text; months integer;
BEGIN
  IF p_ref IS NULL OR p_ref NOT LIKE 'DLP:%:%' OR split_part(p_ref, ':', 3) NOT IN ('dlp.months.cw', 'dlp.months.te') THEN
    RETURN public.sla_resolve_start_pre_0145(p_task, p_ref);
  END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN NULL; END IF;
  key := split_part(p_ref, ':', 3);
  d := public.sla_task_date(t.site_id, split_part(p_ref, ':', 2));
  IF d IS NULL THEN RETURN NULL; END IF;
  months := coalesce(public.dlp_months_at(key, d), CASE WHEN key = 'dlp.months.cw' THEN 3 ELSE 12 END);
  RETURN (d + make_interval(months => months))::date;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Idle-task alert (B12b): the switch tasks.idle_alert, the working days shared with dashboard.settings.stale_idle_days (0113)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION idle_task_alert_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE; dv integer;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'idle-task alert: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO s FROM public.settings WHERE key = 'tasks.idle_alert';
  dv := coalesce((public.dashboard_settings_cfg() ->> 'version')::integer, 0);
  RETURN jsonb_build_object(
    'enabled', coalesce(CASE WHEN jsonb_typeof(s.value -> 'enabled') = 'boolean' THEN (s.value ->> 'enabled')::boolean END, true),
    'working_days', public.task_stale_idle_days(),
    'version', coalesce((s.value ->> 'version')::integer, 0) + dv)
    || CASE WHEN s.key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_at', s.updated_at) END
    || CASE WHEN s.updated_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_by', public.wfe_user_ref(s.updated_by)) END;
END $$;

-- PUT /settings/idle-task-alert. p_body = {enabled, working_days} (closed); the reason apart; p_version = If-Match (NULL = *).
CREATE OR REPLACE FUNCTION admin_set_idle_task_alert(p_body jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; k text; n numeric; iv integer; dash jsonb; res jsonb;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('tasks.idle_alert', '{"enabled": true, "version": 0}'::jsonb,
          'B12b: alert the Team Lead when a task is idle for N working days; N is dashboard.settings.stale_idle_days (migration 0145).', now())
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM public.settings WHERE key IN ('tasks.idle_alert', 'dashboard.settings') ORDER BY key FOR UPDATE;
  cur := public.idle_task_alert_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::integer THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with enabled and working_days.')));
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('enabled', 'working_days') THEN errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_body -> 'enabled') IS DISTINCT FROM 'boolean' THEN
    errs := errs || public.reg_err_item('/enabled', 'required', 'true or false.');
  END IF;
  IF NOT (p_body ? 'working_days') OR jsonb_typeof(p_body -> 'working_days') = 'null' THEN
    errs := errs || public.reg_err_item('/working_days', 'required', 'A whole number of working days from 1 to 30 is required.');
  ELSIF jsonb_typeof(p_body -> 'working_days') <> 'number' OR (p_body ->> 'working_days')::numeric <> trunc((p_body ->> 'working_days')::numeric) THEN
    errs := errs || public.reg_err_item('/working_days', 'invalid', 'A whole number of working days.');
  ELSE
    n := (p_body ->> 'working_days')::numeric;
    IF n < 1 OR n > 30 THEN errs := errs || public.reg_err_item('/working_days', 'out_of_range', 'From 1 to 30 working days.'); END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  SELECT coalesce((value ->> 'version')::integer, 0) INTO iv FROM public.settings WHERE key = 'tasks.idle_alert';
  UPDATE public.settings SET value = jsonb_build_object('enabled', (p_body ->> 'enabled')::boolean, 'version', iv + 1),
         updated_by = public.app_actor(), updated_at = clock_timestamp()
  WHERE key = 'tasks.idle_alert';
  -- the working days are the dashboard's stale_idle_days (one limit for every task, Q523): written there when they change, with its version moved
  IF n::integer IS DISTINCT FROM (cur ->> 'working_days')::integer THEN
    dash := public.dashboard_settings_cfg();
    INSERT INTO public.settings (key, value, description, updated_by, updated_at)
    VALUES ('dashboard.settings', dash || jsonb_build_object('stale_idle_days', n::integer, 'version', coalesce((dash ->> 'version')::integer, 0) + 1),
            'F20 (migration 0108): dashboard targets, KPI thresholds and the cards of each tab.', public.app_actor(), clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  END IF;
  res := public.idle_task_alert_json();
  PERFORM public.log_audit_write('idle_task_alert_update', 'setting', 'tasks.idle_alert',
    jsonb_build_object('enabled', cur -> 'enabled', 'working_days', cur -> 'working_days'),
    jsonb_build_object('enabled', res -> 'enabled', 'working_days', res -> 'working_days', 'working_days_setting', 'dashboard.settings.stale_idle_days'),
    btrim(p_reason));
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Notification policy
-- ---------------------------------------------------------------------------------------------------------------------
-- The governed types (contract NotificationTypeDef). The recipients, channels and the immediate flag of each type are seed defaults (Q603); security types are
-- mandatory for the System Admins, in-app and email; no_holder (B10) is mandatory and immediate; system and security types go to the System Admins only.
CREATE OR REPLACE FUNCTION notif_catalogue() RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_agg(jsonb_build_object(
           'code', t.code, 'category', t.category, 'label_en', t.label_en, 'label_ar', t.label_ar, 'kind', t.kind,
           'default_recipients', to_jsonb(t.recipients),
           'eligible_roles', CASE WHEN t.admins_only THEN '[]'::jsonb ELSE '"all"'::jsonb END,
           'system_admins_only', t.admins_only, 'mandatory', t.mandatory, 'immediate', t.immediate,
           'default_channels', jsonb_build_object('in_app', true, 'email', t.email)) ORDER BY t.ord)
  FROM (VALUES
    (1,  'task_submitted_review',       'approvals', 'Task submitted for review',            'مهمة مقدَّمة للمراجعة',              'task_assigned',     ARRAY['holder'],                  false, false, false, true),
    (2,  'task_submitted_approval',     'approvals', 'Task waiting for approval',            'مهمة بانتظار الاعتماد',              'task_assigned',     ARRAY['holder'],                  false, false, false, true),
    (3,  'approval_overdue_reminder',   'approvals', 'Approval reminder',                    'تذكير بالاعتماد',                    'approval_due',      ARRAY['holder'],                  false, false, false, true),
    (4,  'approval_overdue_escalation', 'approvals', 'Approval escalated to the Team Lead',  'تصعيد الاعتماد إلى قائد الفريق',     'approval_due',      ARRAY['team_lead'],               false, false, false, true),
    (5,  'no_holder',                   'approvals', 'Level has no holder',                  'مستوى بلا صاحب صلاحية',              'no_holder',         ARRAY['system_admins'],           false, true,  true,  true),
    (6,  'task_rejected',               'tasks',     'Task returned with a note',            'مهمة مُرجعة مع ملاحظة',              'task_rejected',     ARRAY['holder'],                  false, false, false, false),
    (7,  'task_idle',                   'tasks',     'Task idle',                            'مهمة خاملة',                         'idle_task_alert',   ARRAY['team_lead'],               false, false, false, false),
    (8,  'assignee_absent',             'tasks',     'Assignee absent',                      'المكلَّف غائب',                      'absence_alert',     ARRAY['team_lead'],               false, false, false, false),
    (9,  'holder_deactivated',          'tasks',     'Holder deactivated',                   'حساب صاحب الصلاحية معطَّل',          'absence_alert',     ARRAY['team_lead'],               false, false, true,  false),
    (10, 'sla_near_max',                'sla',       'SLA near its maximum',                 'اقتراب SLA من حدّه الأقصى',          'system',            ARRAY['holder'],                  false, false, false, false),
    (11, 'sla_exceeded',                'sla',       'SLA exceeded',                         'تجاوز SLA',                          'system',            ARRAY['holder', 'team_lead'],     false, false, false, false),
    (12, 'batch_upload_pending',        'registers', 'Upload batch waiting for review',      'دفعة رفع بانتظار المراجعة',          'import_batch',      ARRAY['holder'],                  false, false, false, false),
    (13, 'batch_upload_result',         'registers', 'Upload batch decided',                 'تم البتّ في دفعة الرفع',             'import_batch',      ARRAY['affected_user'],           false, false, false, false),
    (14, 'snag_opened',                 'registers', 'Snag opened',                          'فتح ملاحظة جودة',                    'snag_raised',       ARRAY['holder'],                  false, false, false, false),
    (15, 'snag_closed',                 'registers', 'Snag closed',                          'إغلاق ملاحظة جودة',                  'snag_closed',       ARRAY['affected_user'],           false, false, false, false),
    (16, 'pac_blocked_by_snags',        'registers', 'PAC blocked by open snags',            'PAC محجوب بملاحظات مفتوحة',          'snag_review',       ARRAY['team_lead'],               false, false, false, false),
    (17, 'holiday_tentative_reminder',  'system',    'Tentative holiday in 14 days',         'عطلة مبدئية خلال 14 يوماً',          'holiday_tentative', ARRAY['system_admins'],           true,  false, false, false),
    (18, 'structural_freeze_lifted',    'system',    'Structural freeze lifted',             'رفع تجميد التغييرات الهيكلية',       'system',            ARRAY['system_admins'],           true,  false, false, false),
    (19, 'repeated_failed_sign_in',     'security',  'Repeated failed sign-in',              'محاولات دخول فاشلة متكررة',          'security_alert',    ARRAY['system_admins'],           true,  true,  true,  true),
    (20, 'callback_account_mismatch',   'security',  'Sign-in account mismatch',             'عدم تطابق حساب الدخول',              'security_alert',    ARRAY['system_admins'],           true,  true,  true,  true),
    (21, 'audit_integrity_failure',     'security',  'Audit log integrity failure',          'فشل سلامة سجل التدقيق',              'security_alert',    ARRAY['system_admins'],           true,  true,  true,  true),
    (22, 'retention_reduced',           'security',  'Log retention reduced',                'تقليص مدة الاحتفاظ بالسجلات',        'security_alert',    ARRAY['system_admins'],           true,  true,  true,  true),
    (23, 'mfa_exemption_granted',       'security',  'MFA exemption granted',                'منح إعفاء من التحقق الثنائي',        'mfa_exemption',     ARRAY['system_admins'],           true,  true,  true,  true),
    (24, 'mfa_exemption_revoked',       'security',  'MFA exemption revoked',                'إلغاء إعفاء من التحقق الثنائي',      'mfa_exemption',     ARRAY['system_admins'],           true,  true,  true,  true),
    (25, 'admin_override_used',         'security',  'Admin override used',                  'استخدام تجاوز إداري',                'security_alert',    ARRAY['system_admins'],           true,  true,  true,  true)
  ) AS t(ord, code, category, label_en, label_ar, kind, recipients, admins_only, mandatory, immediate, email)
$$;

-- Who may read the policy and its catalogue: view (or edit) on admin.settings, a System Admin or a delegate.
CREATE OR REPLACE FUNCTION notif_require_reader() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (public.app_actor_is_admin('admin.settings', 'view') OR public.app_actor_is_admin('admin.settings', 'edit')) THEN
    RAISE EXCEPTION 'notification policy: System Admin or a delegation covering admin.settings required' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- GET /settings/notification-policy/catalogue
CREATE OR REPLACE FUNCTION notification_catalogue_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.notif_require_reader();
  RETURN jsonb_build_object('items', public.notif_catalogue());
END $$;

-- The System Admins group (the first active one).
CREATE OR REPLACE FUNCTION notif_admins_group() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT id FROM public.groups WHERE is_system_admins AND is_active ORDER BY created_at, id LIMIT 1
$$;

-- The policy as the API returns it, from a stored value (NULL = nothing stored: the defaults). The matrix has one row per type of the catalogue: the stored row,
-- else the catalogue defaults. Each row has a cell for every column the type allows: the stored cell, else the default (on for the System Admins group when the
-- type goes to the System Admins, off otherwise: a column without a cell adds no recipient).
CREATE OR REPLACE FUNCTION notif_policy_view(p_cfg jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c jsonb := coalesce(p_cfg, '{}'::jsonb); sa uuid := public.notif_admins_group(); cols jsonb; th jsonb; follow boolean; wd jsonb; wk int[];
  matrix jsonb := '[]'::jsonb; t jsonb; r jsonb; col jsonb; cells jsonb; sc jsonb; is_sa boolean;
BEGIN
  -- columns: the stored ones that still exist, with their names; by default the System Admins group and the Project Manager role
  IF jsonb_typeof(c -> 'columns') = 'array' THEN
    SELECT coalesce(jsonb_agg(x.j ORDER BY x.o), '[]'::jsonb) INTO cols FROM (
      SELECT e.o, CASE WHEN e.v ->> 'kind' = 'group' THEN (SELECT jsonb_build_object('kind', 'group', 'id', g.id, 'name', g.name) FROM public.groups g WHERE g.id::text = e.v ->> 'id')
                       ELSE (SELECT jsonb_build_object('kind', 'role', 'id', ro.id, 'name', ro.name_en) FROM public.roles ro WHERE ro.id::text = e.v ->> 'id') END AS j
      FROM jsonb_array_elements(c -> 'columns') WITH ORDINALITY AS e(v, o)) x WHERE x.j IS NOT NULL;
  ELSE
    SELECT coalesce(jsonb_agg(j ORDER BY o), '[]'::jsonb) INTO cols FROM (
      SELECT 1 AS o, jsonb_build_object('kind', 'group', 'id', g.id, 'name', g.name) AS j FROM public.groups g WHERE g.id = sa
      UNION ALL
      SELECT 2, jsonb_build_object('kind', 'role', 'id', ro.id, 'name', ro.name_en) FROM public.roles ro WHERE ro.code = 'PM') d;
  END IF;
  th := jsonb_build_object('approval_remind_hours', 48, 'approval_escalate_days', 5, 'sla_warning_days_before_max', 2, 'rate_cap_per_hour', 50, 'retention_days', 180)
        || CASE WHEN jsonb_typeof(c -> 'thresholds') = 'object' THEN c -> 'thresholds' ELSE '{}'::jsonb END;
  follow := coalesce(CASE WHEN jsonb_typeof(c -> 'work_days_follow_calendar') = 'boolean' THEN (c ->> 'work_days_follow_calendar')::boolean END, true);
  IF follow OR jsonb_typeof(c -> 'work_days') IS DISTINCT FROM 'array' THEN
    SELECT coalesce(w.weekend_days, ARRAY[5, 6]) INTO wk FROM public.work_calendars w WHERE w.is_default LIMIT 1;
    wk := coalesce(wk, ARRAY[5, 6]);
    SELECT coalesce(jsonb_agg(d ORDER BY d), '[]'::jsonb) INTO wd FROM generate_series(0, 6) d WHERE NOT (d = ANY (wk));
  ELSE
    wd := c -> 'work_days';
  END IF;
  FOR t IN SELECT * FROM jsonb_array_elements(public.notif_catalogue()) LOOP
    SELECT e INTO r FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c -> 'matrix') = 'array' THEN c -> 'matrix' ELSE '[]'::jsonb END) e
    WHERE e ->> 'type_code' = t ->> 'code' LIMIT 1;
    cells := '[]'::jsonb;
    FOR col IN SELECT * FROM jsonb_array_elements(cols) LOOP
      is_sa := col ->> 'kind' = 'group' AND (col ->> 'id') = sa::text;
      CONTINUE WHEN (t ->> 'system_admins_only')::boolean AND NOT is_sa;
      SELECT e INTO sc FROM jsonb_array_elements(coalesce(r -> 'cells', '[]'::jsonb)) e WHERE e ->> 'id' = col ->> 'id' AND e ->> 'kind' = col ->> 'kind' LIMIT 1;
      cells := cells || jsonb_build_object('kind', col ->> 'kind', 'id', col ->> 'id',
        'on', coalesce((sc ->> 'on')::boolean, is_sa AND (t -> 'default_recipients') ? 'system_admins'));
      sc := NULL;
    END LOOP;
    matrix := matrix || jsonb_build_object('type_code', t ->> 'code', 'channels', coalesce(r -> 'channels', t -> 'default_channels'),
      'mandatory', (t ->> 'mandatory')::boolean, 'cells', cells);
    r := NULL;
  END LOOP;
  RETURN jsonb_build_object(
    'enabled', coalesce(CASE WHEN jsonb_typeof(c -> 'enabled') = 'boolean' THEN (c ->> 'enabled')::boolean END, true),
    'timezone', coalesce(c ->> 'timezone', 'Africa/Tripoli'),
    'digest_hour', coalesce((c ->> 'digest_hour')::integer, 8),
    'work_days_follow_calendar', follow,
    'work_days', wd,
    'thresholds', th,
    'columns', cols,
    'matrix', matrix,
    'version', coalesce((c ->> 'version')::integer, 0));
END $$;

-- GET /settings/notification-policy
CREATE OR REPLACE FUNCTION notification_policy_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.settings%ROWTYPE;
BEGIN
  PERFORM public.notif_require_reader();
  SELECT * INTO s FROM public.settings WHERE key = 'notifications.policy';
  RETURN public.notif_policy_view(s.value)
    || CASE WHEN s.key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_at', s.updated_at) END
    || CASE WHEN s.updated_by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('updated_by', public.wfe_user_ref(s.updated_by)) END;
END $$;

-- Is a value a whole number within a range?
CREATE OR REPLACE FUNCTION notif_int_err(p_v jsonb, p_path text, p_lo integer, p_hi integer) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_v IS NULL OR jsonb_typeof(p_v) = 'null' THEN public.reg_err_item(p_path, 'required', 'A whole number from ' || p_lo || ' to ' || p_hi || ' is required.')
    WHEN jsonb_typeof(p_v) <> 'number' OR (p_v #>> '{}')::numeric <> trunc((p_v #>> '{}')::numeric) THEN public.reg_err_item(p_path, 'invalid', 'A whole number.')
    WHEN (p_v #>> '{}')::numeric < p_lo OR (p_v #>> '{}')::numeric > p_hi THEN public.reg_err_item(p_path, 'out_of_range', 'From ' || p_lo || ' to ' || p_hi || '.')
    ELSE '[]'::jsonb END
$$;

-- PUT /settings/notification-policy. p_body = NotificationPolicyInput without the reason (closed schema); p_version = If-Match (NULL = *).
CREATE OR REPLACE FUNCTION admin_set_notification_policy(p_body jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s public.settings%ROWTYPE; cur jsonb; nxt jsonb; stored jsonb; errs jsonb := '[]'::jsonb; k text; x text; el jsonb; row_ jsonb; cell jsonb; t jsonb;
  cat jsonb := public.notif_catalogue(); sa uuid := public.notif_admins_group(); i integer; j integer; v integer; lim jsonb;
  cols jsonb; col_keys text[] := ARRAY[]::text[]; seen text[]; seen_cells text[]; th jsonb; follow boolean; rows_ jsonb := '[]'::jsonb; cells_ jsonb;
  sensitive boolean := false; ch text; actor uuid := public.app_actor(); who text; u uuid;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  INSERT INTO public.settings (key, value, description, updated_at)
  VALUES ('notifications.policy', '{"version": 0}'::jsonb, 'The notification policy (switch, timezone, digest hour, thresholds, type x role/group matrix), migration 0145.', now())
  ON CONFLICT (key) DO NOTHING;
  SELECT * INTO s FROM public.settings WHERE key = 'notifications.policy' FOR UPDATE;
  cur := public.notif_policy_view(s.value);
  v := (cur ->> 'version')::integer;
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'A notification policy object.')));
  END IF;

  -- the top level: closed, required keys
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('enabled', 'timezone', 'digest_hour', 'work_days_follow_calendar', 'work_days', 'thresholds', 'columns', 'matrix') THEN
      errs := errs || public.reg_err_item('/' || k, 'unknown_key', 'Unknown key.');
    END IF;
  END LOOP;
  IF jsonb_typeof(p_body -> 'enabled') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/enabled', 'required', 'true or false.'); END IF;
  IF jsonb_typeof(p_body -> 'timezone') IS DISTINCT FROM 'string' THEN
    errs := errs || public.reg_err_item('/timezone', 'required', 'An IANA time zone, for example Africa/Tripoli.');
  ELSIF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = p_body ->> 'timezone' AND z.name !~ '^(posix|right)/' AND z.name <> 'posixrules') THEN
    errs := errs || public.reg_err_item('/timezone', 'invalid_timezone', 'Not an IANA time zone.');
  END IF;
  errs := errs || public.notif_int_err(p_body -> 'digest_hour', '/digest_hour', 0, 23);
  IF jsonb_typeof(p_body -> 'work_days_follow_calendar') IS DISTINCT FROM 'boolean' THEN
    errs := errs || public.reg_err_item('/work_days_follow_calendar', 'required', 'true or false.');
  END IF;
  follow := coalesce(CASE WHEN jsonb_typeof(p_body -> 'work_days_follow_calendar') = 'boolean' THEN (p_body ->> 'work_days_follow_calendar')::boolean END, true);
  IF p_body ? 'work_days' OR NOT follow THEN
    IF jsonb_typeof(p_body -> 'work_days') IS DISTINCT FROM 'array' THEN
      IF NOT follow THEN errs := errs || public.reg_err_item('/work_days', 'required', 'The working days (0 = Sunday) are required when they do not follow the calendar.'); END IF;
    ELSIF jsonb_array_length(p_body -> 'work_days') < 1 OR jsonb_array_length(p_body -> 'work_days') > 7 THEN
      errs := errs || public.reg_err_item('/work_days', 'invalid', 'From 1 to 7 days.');
    ELSE
      seen := ARRAY[]::text[]; i := 0;
      FOR el IN SELECT * FROM jsonb_array_elements(p_body -> 'work_days') LOOP
        IF jsonb_typeof(el) <> 'number' OR (el #>> '{}') !~ '^[0-6]$' THEN errs := errs || public.reg_err_item('/work_days/' || i, 'invalid', 'A day from 0 (Sunday) to 6 (Saturday).');
        ELSIF (el #>> '{}') = ANY (seen) THEN errs := errs || public.reg_err_item('/work_days/' || i, 'duplicate', 'This day is listed twice.');
        ELSE seen := seen || (el #>> '{}'); END IF;
        i := i + 1;
      END LOOP;
    END IF;
  END IF;

  -- thresholds: closed, each in its range, and the escalation after the reminder
  th := p_body -> 'thresholds';
  IF jsonb_typeof(th) IS DISTINCT FROM 'object' THEN
    errs := errs || public.reg_err_item('/thresholds', 'required', 'The thresholds are required.');
  ELSE
    lim := '{"approval_remind_hours": [4, 168], "approval_escalate_days": [1, 30], "sla_warning_days_before_max": [0, 30], "rate_cap_per_hour": [5, 500], "retention_days": [30, 730]}'::jsonb;
    FOR k IN SELECT jsonb_object_keys(th) LOOP
      IF NOT (lim ? k) THEN errs := errs || public.reg_err_item('/thresholds/' || k, 'unknown_key', 'Unknown threshold.'); END IF;
    END LOOP;
    FOR k IN SELECT jsonb_object_keys(lim) LOOP
      errs := errs || public.notif_int_err(th -> k, '/thresholds/' || k, (lim -> k ->> 0)::integer, (lim -> k ->> 1)::integer);
    END LOOP;
    IF jsonb_array_length(public.notif_int_err(th -> 'approval_remind_hours', '', 4, 168)) = 0
       AND jsonb_array_length(public.notif_int_err(th -> 'approval_escalate_days', '', 1, 30)) = 0
       AND (th ->> 'approval_escalate_days')::integer * 24 <= (th ->> 'approval_remind_hours')::integer THEN
      errs := errs || public.reg_err_item('/thresholds/approval_escalate_days', 'must_exceed_remind_hours', 'The escalation must come after the reminder (days x 24 > hours).')
                   || public.reg_err_item('/thresholds/approval_remind_hours', 'must_exceed_remind_hours', 'The reminder must come before the escalation.');
    END IF;
  END IF;

  -- columns: optional (absent = keep the current ones); each a role or a group that exists, once
  IF p_body ? 'columns' THEN
    IF jsonb_typeof(p_body -> 'columns') <> 'array' THEN
      errs := errs || public.reg_err_item('/columns', 'invalid', 'A list of roles and groups.');
      cols := cur -> 'columns';
    ELSIF jsonb_array_length(p_body -> 'columns') > 50 THEN
      errs := errs || public.reg_err_item('/columns', 'too_many', 'At most 50 columns.');
      cols := cur -> 'columns';
    ELSE
      cols := '[]'::jsonb; i := 0;
      FOR el IN SELECT * FROM jsonb_array_elements(p_body -> 'columns') LOOP
        IF jsonb_typeof(el) <> 'object' THEN
          errs := errs || public.reg_err_item('/columns/' || i, 'invalid', 'A column is {kind, id}.');
        ELSE
          FOR k IN SELECT jsonb_object_keys(el) LOOP
            IF k NOT IN ('kind', 'id', 'name') THEN errs := errs || public.reg_err_item('/columns/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
          END LOOP;
          IF el ->> 'kind' IS NULL OR el ->> 'kind' NOT IN ('role', 'group') THEN
            errs := errs || public.reg_err_item('/columns/' || i || '/kind', 'invalid', 'role or group.');
          ELSIF coalesce(el ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
            errs := errs || public.reg_err_item('/columns/' || i || '/id', 'invalid', 'A uuid.');
          ELSIF (el ->> 'kind' = 'role' AND NOT EXISTS (SELECT 1 FROM public.roles ro WHERE ro.id = (el ->> 'id')::uuid))
             OR (el ->> 'kind' = 'group' AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = (el ->> 'id')::uuid AND g.is_active)) THEN
            errs := errs || public.reg_err_item('/columns/' || i || '/id', 'unknown_column', 'No such ' || (el ->> 'kind') || '.');
          ELSIF (el ->> 'kind') || ':' || lower(el ->> 'id') = ANY (col_keys) THEN
            errs := errs || public.reg_err_item('/columns/' || i, 'duplicate', 'This column is listed twice.');
          ELSE
            col_keys := col_keys || ((el ->> 'kind') || ':' || lower(el ->> 'id'));
            cols := cols || jsonb_build_object('kind', el ->> 'kind', 'id', lower(el ->> 'id'));
          END IF;
        END IF;
        i := i + 1;
      END LOOP;
    END IF;
  ELSE
    cols := cur -> 'columns';
  END IF;
  IF NOT (p_body ? 'columns') OR jsonb_typeof(p_body -> 'columns') <> 'array' OR jsonb_array_length(p_body -> 'columns') > 50 THEN
    SELECT coalesce(array_agg((e ->> 'kind') || ':' || lower(e ->> 'id')), ARRAY[]::text[]) INTO col_keys FROM jsonb_array_elements(cols) e;
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', e ->> 'kind', 'id', lower(e ->> 'id'))), '[]'::jsonb) INTO cols FROM jsonb_array_elements(cols) e;
  END IF;
  -- the mandatory types go to the System Admins: their group must stay a column (security review 2026-11-23), whether or not the body names the columns
  IF sa IS NOT NULL AND NOT (('group:' || sa::text) = ANY (col_keys)) THEN
    errs := errs || public.reg_err_item('/columns', 'mandatory_locked', 'The System Admins group must stay a column: the mandatory types go to it.');
  END IF;

  -- matrix: one row per type at most; channels closed; cells for the columns, allowed by the type; mandatory types locked
  IF jsonb_typeof(p_body -> 'matrix') IS DISTINCT FROM 'array' THEN
    errs := errs || public.reg_err_item('/matrix', 'required', 'The matrix is required.');
  ELSIF jsonb_array_length(p_body -> 'matrix') > 100 THEN
    errs := errs || public.reg_err_item('/matrix', 'too_many', 'At most 100 rows.');
  ELSE
    seen := ARRAY[]::text[]; i := 0;
    FOR row_ IN SELECT * FROM jsonb_array_elements(p_body -> 'matrix') LOOP
      IF jsonb_typeof(row_) <> 'object' THEN
        errs := errs || public.reg_err_item('/matrix/' || i, 'invalid', 'A row is {type_code, channels, cells}.');
        i := i + 1; CONTINUE;
      END IF;
      FOR k IN SELECT jsonb_object_keys(row_) LOOP
        IF k NOT IN ('type_code', 'channels', 'cells', 'mandatory') THEN errs := errs || public.reg_err_item('/matrix/' || i || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      SELECT e INTO t FROM jsonb_array_elements(cat) e WHERE e ->> 'code' = row_ ->> 'type_code';
      IF t IS NULL THEN
        errs := errs || public.reg_err_item('/matrix/' || i || '/type_code', 'unknown_type', 'Not a notification type of the catalogue.');
        i := i + 1; CONTINUE;
      END IF;
      IF (row_ ->> 'type_code') = ANY (seen) THEN
        errs := errs || public.reg_err_item('/matrix/' || i || '/type_code', 'duplicate', 'This type is listed twice.');
        i := i + 1; t := NULL; CONTINUE;
      END IF;
      seen := seen || (row_ ->> 'type_code');
      -- channels
      IF jsonb_typeof(row_ -> 'channels') IS DISTINCT FROM 'object' THEN
        errs := errs || public.reg_err_item('/matrix/' || i || '/channels', 'required', 'in_app and email are required.');
      ELSE
        FOR k IN SELECT jsonb_object_keys(row_ -> 'channels') LOOP
          IF k NOT IN ('in_app', 'email') THEN errs := errs || public.reg_err_item('/matrix/' || i || '/channels/' || k, 'unknown_key', 'Unknown channel.'); END IF;
        END LOOP;
        FOREACH ch IN ARRAY ARRAY['in_app', 'email'] LOOP
          IF jsonb_typeof(row_ -> 'channels' -> ch) IS DISTINCT FROM 'boolean' THEN
            errs := errs || public.reg_err_item('/matrix/' || i || '/channels/' || ch, 'required', 'true or false.');
          ELSIF (t ->> 'mandatory')::boolean AND (t -> 'default_channels' ->> ch)::boolean AND NOT (row_ -> 'channels' ->> ch)::boolean THEN
            errs := errs || public.reg_err_item('/matrix/' || i || '/channels/' || ch, 'mandatory_locked', 'This type is mandatory: the channel cannot be switched off.');
          END IF;
        END LOOP;
      END IF;
      -- cells
      cells_ := '[]'::jsonb;
      IF row_ ? 'cells' AND jsonb_typeof(row_ -> 'cells') <> 'array' THEN
        errs := errs || public.reg_err_item('/matrix/' || i || '/cells', 'invalid', 'A list of cells.');
      ELSIF jsonb_array_length(coalesce(row_ -> 'cells', '[]'::jsonb)) > 50 THEN
        errs := errs || public.reg_err_item('/matrix/' || i || '/cells', 'too_many', 'At most 50 cells.');
      ELSE
        seen_cells := ARRAY[]::text[]; j := 0;
        FOR cell IN SELECT * FROM jsonb_array_elements(coalesce(row_ -> 'cells', '[]'::jsonb)) LOOP
          IF jsonb_typeof(cell) <> 'object' THEN
            errs := errs || public.reg_err_item('/matrix/' || i || '/cells/' || j, 'invalid', 'A cell is {kind, id, on}.');
            j := j + 1; CONTINUE;
          END IF;
          FOR k IN SELECT jsonb_object_keys(cell) LOOP
            IF k NOT IN ('kind', 'id', 'on') THEN errs := errs || public.reg_err_item('/matrix/' || i || '/cells/' || j || '/' || k, 'unknown_key', 'Unknown key.'); END IF;
          END LOOP;
          IF jsonb_typeof(cell -> 'on') IS DISTINCT FROM 'boolean' THEN
            errs := errs || public.reg_err_item('/matrix/' || i || '/cells/' || j || '/on', 'required', 'true or false.');
          ELSIF NOT ((cell ->> 'kind') || ':' || lower(coalesce(cell ->> 'id', '')) = ANY (col_keys)) THEN
            errs := errs || public.reg_err_item('/matrix/' || i || '/cells/' || j || '/id', 'unknown_column', 'The cell must name one of the columns.');
          ELSIF (t ->> 'system_admins_only')::boolean AND NOT (cell ->> 'kind' = 'group' AND lower(cell ->> 'id') = sa::text) THEN
            errs := errs || public.reg_err_item('/matrix/' || i || '/cells/' || j, 'not_eligible_recipient', 'This type goes to the System Admins only.');
          ELSIF (cell ->> 'kind') || ':' || lower(cell ->> 'id') = ANY (seen_cells) THEN
            errs := errs || public.reg_err_item('/matrix/' || i || '/cells/' || j, 'duplicate', 'This column has two cells.');
          ELSIF (t ->> 'mandatory')::boolean AND NOT (cell ->> 'on')::boolean AND cell ->> 'kind' = 'group' AND lower(cell ->> 'id') = sa::text
                AND (t -> 'default_recipients') ? 'system_admins' THEN
            errs := errs || public.reg_err_item('/matrix/' || i || '/cells/' || j, 'mandatory_locked', 'This type is mandatory for the System Admins.');
          ELSE
            seen_cells := seen_cells || ((cell ->> 'kind') || ':' || lower(cell ->> 'id'));
            cells_ := cells_ || jsonb_build_object('kind', cell ->> 'kind', 'id', lower(cell ->> 'id'), 'on', (cell ->> 'on')::boolean);
          END IF;
          j := j + 1;
        END LOOP;
      END IF;
      rows_ := rows_ || jsonb_build_object('type_code', row_ ->> 'type_code',
        'channels', jsonb_build_object('in_app', coalesce((row_ -> 'channels' ->> 'in_app')::boolean, true), 'email', coalesce((row_ -> 'channels' ->> 'email')::boolean, false)),
        'cells', cells_);
      t := NULL;
      i := i + 1;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  stored := jsonb_build_object('version', v + 1, 'enabled', (p_body ->> 'enabled')::boolean, 'timezone', p_body ->> 'timezone',
    'digest_hour', (p_body ->> 'digest_hour')::integer, 'work_days_follow_calendar', follow,
    'work_days', CASE WHEN follow THEN NULL ELSE (SELECT jsonb_agg(d ORDER BY d) FROM (SELECT (e #>> '{}')::integer AS d FROM jsonb_array_elements(p_body -> 'work_days') e) z) END,
    'thresholds', jsonb_build_object('approval_remind_hours', (th ->> 'approval_remind_hours')::integer, 'approval_escalate_days', (th ->> 'approval_escalate_days')::integer,
      'sla_warning_days_before_max', (th ->> 'sla_warning_days_before_max')::integer, 'rate_cap_per_hour', (th ->> 'rate_cap_per_hour')::integer,
      'retention_days', (th ->> 'retention_days')::integer),
    'columns', cols, 'matrix', rows_);
  nxt := public.notif_policy_view(stored);

  -- every mandatory type that goes to the System Admins keeps their cell on in the resulting policy, not only when the body names the cell
  IF sa IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(public.reg_err_item('/matrix', 'mandatory_locked', 'The mandatory type ' || (e ->> 'type_code') || ' must stay on for the System Admins.') -> 0), '[]'::jsonb)
    INTO errs
    FROM jsonb_array_elements(nxt -> 'matrix') e
    JOIN LATERAL (SELECT cd FROM jsonb_array_elements(cat) cd WHERE cd ->> 'code' = e ->> 'type_code') tdef ON true
    WHERE (tdef.cd ->> 'mandatory')::boolean AND (tdef.cd -> 'default_recipients') ? 'system_admins'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e -> 'cells') xc WHERE xc ->> 'kind' = 'group' AND xc ->> 'id' = sa::text AND (xc ->> 'on')::boolean);
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  END IF;

  -- a System Admin (never a delegate) with a step-up, and the System Admins are told, for: the security and system rows, the rate cap that feeds them,
  -- the master switch, the timezone, the digest hour and the working days (security review 2026-11-23: a delegate must not silence or reshape the policy)
  sensitive := (cur -> 'thresholds' -> 'rate_cap_per_hour') IS DISTINCT FROM (nxt -> 'thresholds' -> 'rate_cap_per_hour')
    OR (cur -> 'enabled') IS DISTINCT FROM (nxt -> 'enabled')
    OR (cur -> 'timezone') IS DISTINCT FROM (nxt -> 'timezone')
    OR (cur -> 'digest_hour') IS DISTINCT FROM (nxt -> 'digest_hour')
    OR (cur -> 'work_days_follow_calendar') IS DISTINCT FROM (nxt -> 'work_days_follow_calendar')
    OR (cur -> 'work_days') IS DISTINCT FROM (nxt -> 'work_days')
    OR (SELECT coalesce(jsonb_agg(e ORDER BY e ->> 'type_code'), '[]'::jsonb) FROM jsonb_array_elements(cur -> 'matrix') e
         WHERE (SELECT c ->> 'category' FROM jsonb_array_elements(cat) c WHERE c ->> 'code' = e ->> 'type_code') IN ('security', 'system'))
       IS DISTINCT FROM
       (SELECT coalesce(jsonb_agg(e ORDER BY e ->> 'type_code'), '[]'::jsonb) FROM jsonb_array_elements(nxt -> 'matrix') e
         WHERE (SELECT c ->> 'category' FROM jsonb_array_elements(cat) c WHERE c ->> 'code' = e ->> 'type_code') IN ('security', 'system'));
  IF sensitive THEN
    IF NOT public.app_actor_is_system_admin() THEN
      PERFORM public.wf_err('delegate_forbidden', jsonb_build_object('detail', 'Only a System Admin acting without delegation may change the security and system types, the rate cap, the switch, the timezone, the digest hour or the working days.'));
    END IF;
    IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
  END IF;

  UPDATE public.settings SET value = stored, updated_by = actor, updated_at = clock_timestamp() WHERE key = 'notifications.policy';
  PERFORM public.log_audit_write('notification_policy_update', 'setting', 'notifications.policy', cur, nxt || jsonb_build_object('protected_change', sensitive), btrim(p_reason));
  IF sensitive THEN
    SELECT u2.display_name || coalesce(' (' || nullif(btrim(u2.employee_id), '') || ')', '') INTO who FROM public.users u2 WHERE u2.id = actor;
    FOR u IN SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
             JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' AND NOT x.is_break_glass LOOP
      INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
      VALUES (u, 'in_app', 'security_alert', 'Notification policy: a protected setting changed',
              'Changed by ' || coalesce(who, 'a System Admin') || '. Reason: ' || left(btrim(p_reason), 500), '/admin/settings/alerts');
    END LOOP;
  END IF;
  RETURN public.notification_policy_json();
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Holidays: the approved template TPL-HOLIDAYS and its import
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_kind_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_kind_check
  CHECK (kind IN ('register', 'stream', 'master', 'sites', 'list_values', 'holidays'));
ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_scope_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_scope_check CHECK (
  (kind = 'register' AND register_key IS NOT NULL AND stream_code IS NULL)
  OR (kind = 'stream' AND stream_code IS NOT NULL AND register_key IS NULL)
  OR (kind IN ('master', 'sites', 'list_values', 'holidays') AND register_key IS NULL AND stream_code IS NULL));

-- The columns of the holidays template: the columns of the seed file db/seed/holidays-2026-2027.csv.
CREATE OR REPLACE FUNCTION tpl_holidays_columns() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('code', 'date',      'header', 'Date (YYYY-MM-DD)',          'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'name_en',   'header', 'Name EN',                    'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'name_ar',   'header', 'Name AR',                    'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'kind',      'header', 'Kind (national / religious)', 'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'tentative', 'header', 'Tentative (yes / no)',       'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'note',      'header', 'Note',                       'type', 'text', 'kind', 'field', 'required', false, 'derived', false))
$$;

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, module_key, match_keys, sort_order, is_master_format)
VALUES ('TPL-HOLIDAYS', 'Holidays', 'العطل الرسمية', 'holiday', 'holidays', NULL, '[["date"]]', 4, false)
ON CONFLICT (template_id) DO NOTHING;

INSERT INTO template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason)
SELECT d.id, 1, public.tpl_header_checksum(public.tpl_holidays_columns()), 1, public.tpl_holidays_columns(), true,
       public.tpl_field_hash(public.tpl_holidays_columns()), 'first version'
FROM template_definitions d
WHERE d.template_id = 'TPL-HOLIDAYS' AND NOT EXISTS (SELECT 1 FROM template_versions v WHERE v.template_def_id = d.id);
UPDATE template_definitions SET current_version = 1, updated_at = now() WHERE template_id = 'TPL-HOLIDAYS' AND current_version < 1;

-- tpl_sync as built in 0105, with the kind holidays (0145): an unknown kind must never fall through to the Master columns.
CREATE OR REPLACE FUNCTION tpl_sync(p_template text, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.template_definitions%ROWTYPE; cols jsonb; h text; cs text; cur public.template_versions%ROWTYPE; fsv integer; nv integer; why text;
BEGIN
  SELECT * INTO d FROM public.template_definitions WHERE template_id = p_template;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF d.kind = 'register' THEN
    cols := public.tpl_columns(d.register_key); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'register fields changed';
  ELSIF d.kind = 'stream' THEN
    cols := public.tpl_stream_columns(d.stream_code); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'stream tasks or fields changed';
  ELSIF d.kind = 'sites' THEN
    cols := public.tpl_sites_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'site template columns or lists changed';
  ELSIF d.kind = 'list_values' THEN
    cols := public.tpl_list_values_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'list values template changed';
  ELSIF d.kind = 'holidays' THEN
    cols := public.tpl_holidays_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := 'holidays template changed';
  ELSE
    cols := public.tpl_master_parts(); h := public.tpl_master_hash(cols); cs := public.tpl_master_checksum(cols); why := 'Master columns, tasks or register fields changed';
  END IF;
  SELECT version INTO fsv FROM public.field_set_versions WHERE entity_type::text = d.custom_entity;
  SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  -- nothing changed (the usual case): no lock is taken, so the saves of other screens never wait for this check
  IF FOUND AND cur.field_set_hash IS NOT DISTINCT FROM h THEN RETURN cur.version; END IF;
  SELECT * INTO d FROM public.template_definitions WHERE id = d.id FOR UPDATE;
  SELECT * INTO cur FROM public.template_versions WHERE template_def_id = d.id AND is_current;
  IF NOT FOUND THEN
    INSERT INTO public.template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason)
    VALUES (d.id, 1, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, 'first version'));
    UPDATE public.template_definitions SET current_version = 1, updated_at = now() WHERE id = d.id;
    RETURN 1;
  END IF;
  IF cur.field_set_hash IS DISTINCT FROM h THEN
    nv := cur.version + 1;
    UPDATE public.template_versions SET is_current = false, retired_at = now() WHERE id = cur.id;
    INSERT INTO public.template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason, published_by)
    VALUES (d.id, nv, cs, coalesce(fsv, 1), cols, true, h, coalesce(p_reason, why), public.app_actor());
    UPDATE public.template_definitions SET current_version = nv, updated_at = now() WHERE id = d.id;
    INSERT INTO public.audit_log (action, entity_type, entity_id, before, after, reason, actor_id)
    VALUES ('template_version_issued', 'template', p_template, jsonb_build_object('version', cur.version, 'field_set_hash', cur.field_set_hash),
            jsonb_build_object('version', nv, 'field_set_hash', h, 'columns', jsonb_array_length(cols)), coalesce(p_reason, why), public.app_actor());
    RETURN nv;
  END IF;
  RETURN cur.version;
END $$;

-- POST /settings/holidays/import, after the API checked the file (size, xlsx guard, the _tpl sheet naming TPL-HOLIDAYS and its current version, the header row).
-- p_rows = [{line, date, name_en, name_ar, kind, tentative, note}] as read from the Data sheet; p_meta = {file_name, template_version}. Every row is checked; one bad
-- row refuses the whole file (field errors /rows/<line>/<field>). A date the calendar already holds with the same values is unchanged; with other values it is
-- refused (setting calendar.holiday_import_existing = "reject", the default) or left as it is (= "skip"), Q602. The new rows go in one statement, so the open tasks
-- are recalculated once (cal_holidays_changed, 0017); closed tasks keep their values.
CREATE OR REPLACE FUNCTION admin_import_holidays(p_rows jsonb, p_reason text, p_meta jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cal uuid := public.cal_default(); errs jsonb := '[]'::jsonb; r jsonb; p text; ln text; d date; nm text; nmar text; kd text; tent text; tb boolean; nt text;
  ex public.holidays%ROWTYPE; seen date[] := ARRAY[]::date[]; ins jsonb := '[]'::jsonb; unchanged integer := 0; import_id uuid := gen_random_uuid();
  mode text := coalesce(public.calc_setting('calendar.holiday_import_existing', '"reject"'::jsonb) #>> '{}', 'reject'); h public.holidays%ROWTYPE; affected integer; k text;
BEGIN
  PERFORM public.calc_require_admin('calendars', true);
  PERFORM public.calc_require_reason(p_reason);
  IF cal IS NULL THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/calendar_code', 'unknown_calendar', 'No default calendar.'))); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/file', 'empty', 'The file has no holiday row.')));
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/file', 'too_many', 'At most 2000 rows per file.')));
  END IF;
  PERFORM 1 FROM public.work_calendars WHERE id = cal FOR UPDATE;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    ln := coalesce(r ->> 'line', '?');
    p := '/rows/' || ln;
    IF jsonb_typeof(r) <> 'object' THEN errs := errs || public.reg_err_item(p, 'invalid', 'A row.'); CONTINUE; END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF k NOT IN ('line', 'date', 'name_en', 'name_ar', 'kind', 'tentative', 'note') THEN errs := errs || public.reg_err_item(p || '/' || k, 'unknown_key', 'Unknown column.'); END IF;
    END LOOP;
    d := NULL;
    IF coalesce(btrim(r ->> 'date'), '') = '' THEN
      errs := errs || public.reg_err_item(p || '/date', 'required', 'The date is required.');
    ELSIF public.ssa_iso_date(btrim(r ->> 'date')) IS NULL THEN
      errs := errs || public.reg_err_item(p || '/date', 'invalid', 'Use YYYY-MM-DD.');
    ELSIF btrim(r ->> 'date')::date NOT BETWEEN DATE '2020-01-01' AND DATE '2035-12-31' THEN
      errs := errs || public.reg_err_item(p || '/date', 'out_of_range', 'The date must be between 2020-01-01 and 2035-12-31.');
    ELSE
      d := btrim(r ->> 'date')::date;
    END IF;
    nm := btrim(coalesce(r ->> 'name_en', ''));
    IF char_length(nm) < 2 THEN errs := errs || public.reg_err_item(p || '/name_en', 'required', 'The English name (2 characters or more) is required.');
    ELSIF char_length(nm) > 200 THEN errs := errs || public.reg_err_item(p || '/name_en', 'too_long', 'At most 200 characters.'); END IF;
    nmar := nullif(btrim(coalesce(r ->> 'name_ar', '')), '');
    IF char_length(nmar) > 200 THEN errs := errs || public.reg_err_item(p || '/name_ar', 'too_long', 'At most 200 characters.'); END IF;
    kd := lower(btrim(coalesce(r ->> 'kind', '')));
    IF kd NOT IN ('national', 'religious') THEN errs := errs || public.reg_err_item(p || '/kind', 'invalid', 'national or religious.'); END IF;
    tent := lower(btrim(coalesce(r ->> 'tentative', '')));
    tb := CASE WHEN tent IN ('yes', 'true', 'y', '1') THEN true WHEN tent IN ('', 'no', 'false', 'n', '0') THEN false END;
    IF tb IS NULL THEN errs := errs || public.reg_err_item(p || '/tentative', 'invalid', 'yes or no.'); END IF;
    nt := nullif(btrim(coalesce(r ->> 'note', '')), '');
    IF char_length(nt) > 500 THEN errs := errs || public.reg_err_item(p || '/note', 'too_long', 'At most 500 characters.'); END IF;
    IF d IS NOT NULL THEN
      IF d = ANY (seen) THEN
        errs := errs || public.reg_err_item(p || '/date', 'duplicate_in_file', 'This date is in the file twice.');
      ELSE
        seen := seen || d;
        SELECT * INTO ex FROM public.holidays WHERE calendar_id = cal AND date = d;
        IF FOUND THEN
          IF ex.name = nm AND ex.name_ar IS NOT DISTINCT FROM nmar AND ex.kind = kd AND ex.tentative = coalesce(tb, ex.tentative) THEN
            unchanged := unchanged + 1;
          ELSIF mode = 'skip' THEN
            unchanged := unchanged + 1;
          ELSE
            errs := errs || public.reg_err_item(p || '/date', 'duplicate', 'The calendar already has another holiday on ' || d || ': edit it on the Calendar screen.');
          END IF;
        ELSIF kd IN ('national', 'religious') AND tb IS NOT NULL AND char_length(nm) BETWEEN 2 AND 200 THEN
          ins := ins || jsonb_build_object('date', d, 'name', nm, 'name_ar', nmar, 'kind', kd, 'tentative', tb, 'note', nt);
        END IF;
        ex := NULL;
      END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'The file was not imported: correct the rows listed and upload it again.',
      'errors', (SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements(errs) e LIMIT 50) z)));
  END IF;

  PERFORM set_config('pmis.sla_affected', '0', true);
  INSERT INTO public.holidays (calendar_id, date, name, name_ar, kind, tentative, note)
  SELECT cal, (e ->> 'date')::date, e ->> 'name', e ->> 'name_ar', e ->> 'kind', (e ->> 'tentative')::boolean, e ->> 'note' FROM jsonb_array_elements(ins) e;
  affected := coalesce(nullif(current_setting('pmis.sla_affected', true), '')::integer, 0);
  FOR h IN SELECT * FROM public.holidays WHERE calendar_id = cal AND date IN (SELECT (e ->> 'date')::date FROM jsonb_array_elements(ins) e) ORDER BY date LOOP
    PERFORM public.log_audit_write('holiday_create', 'holiday', h.id::text, NULL, public.calc_holiday_json(h) || jsonb_build_object('import_id', import_id, 'template_id', 'TPL-HOLIDAYS'),
      btrim(p_reason));
  END LOOP;
  PERFORM public.log_audit_write('holidays_import', 'holiday_import', import_id::text, NULL,
    jsonb_build_object('template_id', 'TPL-HOLIDAYS', 'template_version', p_meta -> 'template_version', 'file_name', left(coalesce(p_meta ->> 'file_name', ''), 200),
      'rows', jsonb_array_length(p_rows), 'created', jsonb_array_length(ins), 'unchanged', unchanged, 'affected_open_tasks', affected,
      'dates', (SELECT coalesce(jsonb_agg(e -> 'date' ORDER BY e ->> 'date'), '[]'::jsonb) FROM jsonb_array_elements(ins) e)),
    btrim(p_reason));
  RETURN jsonb_build_object('id', import_id, 'created', jsonb_array_length(ins), 'unchanged', unchanged, 'affected_open_tasks', affected);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The new settings change only through their doors (settings_guarded_keys of 0072, its own triggers as 0130 did)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TRIGGER b_settings_ssa BEFORE INSERT ON settings FOR EACH ROW
  WHEN (NEW.key IN ('notifications.policy', 'tasks.idle_alert')) EXECUTE FUNCTION settings_guarded_keys();
-- an UPDATE is guarded on the old and the new key, so the row cannot be renamed away (security review 2026-11-05)
CREATE TRIGGER b_settings_ssa_update BEFORE UPDATE ON settings FOR EACH ROW
  WHEN (OLD.key IN ('notifications.policy', 'tasks.idle_alert') OR NEW.key IN ('notifications.policy', 'tasks.idle_alert')) EXECUTE FUNCTION settings_guarded_keys();
CREATE TRIGGER b_settings_ssa_delete BEFORE DELETE ON settings FOR EACH ROW
  WHEN (OLD.key IN ('notifications.policy', 'tasks.idle_alert')) EXECUTE FUNCTION settings_guarded_keys();

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('settings_screens_api_applied', 'workflow', NULL,
        jsonb_build_object('dlp', 'dlp_versions with admin_publish_dlp; a PAC keeps the version in force on its date',
                           'idle_task_alert', 'tasks.idle_alert (switch); the working days are dashboard.settings.stale_idle_days',
                           'notification_policy', 'notifications.policy with admin_set_notification_policy and notif_catalogue',
                           'holidays_import', 'TPL-HOLIDAYS with admin_import_holidays'),
        'Settings screens on the real API (migration 0145, contract 0.15.59).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'ssa_iso_date(text)', 'dlp_months_at(text,date)', 'dlp_version_json(dlp_versions)', 'dlp_settings_json()', 'admin_publish_dlp(jsonb,text)', 'sla_resolve_start(uuid,text)',
    'idle_task_alert_json()', 'admin_set_idle_task_alert(jsonb,text,integer)', 'notif_catalogue()', 'notif_require_reader()', 'notification_catalogue_json()',
    'notif_admins_group()', 'notif_policy_view(jsonb)', 'notification_policy_json()', 'notif_int_err(jsonb,text,integer,integer)',
    'admin_set_notification_policy(jsonb,text,integer)', 'tpl_holidays_columns()', 'admin_import_holidays(jsonb,text,jsonb)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY[
      'dlp_months_at(text,date)', 'dlp_settings_json()', 'admin_publish_dlp(jsonb,text)', 'sla_resolve_start(uuid,text)', 'idle_task_alert_json()',
      'admin_set_idle_task_alert(jsonb,text,integer)', 'notification_catalogue_json()', 'notification_policy_json()', 'admin_set_notification_policy(jsonb,text,integer)',
      'admin_import_holidays(jsonb,text,jsonb)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
