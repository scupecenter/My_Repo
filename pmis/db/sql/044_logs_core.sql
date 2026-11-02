-- 0045_logs_core: enterprise logging core (contract 0.10.0). Mirrored byte-identically as db/sql/044_logs_core.sql.
--   1. Request context reaches the database: the API sets app.ip, app.user_agent, app.request_id, app.session_id, app.auth_method, app.mfa,
--      app.stepup, app.via, app.device and app.job_name next to app.user_id (set_config(..., true)). A BEFORE INSERT trigger on audit_log fills
--      ip, user_agent, request_id and the new columns from them when the row leaves them null, so every SECURITY DEFINER function, existing or
--      future, records the device without being edited. module_key is derived from the entity (Audit Log readers, decision B4).
--   2. Field-level change log: audit_field_changes, filled by an AFTER INSERT trigger on audit_log that diffs before and after (one level of
--      nesting flattened: data.x is field x), with labels from the register fields and the custom-field definitions. Append-only.
--   3. Hash chains: audit_log and security_log are sealed at commit (deferred constraint trigger, advisory lock) into audit_log_chain and
--      security_log_chain: hash = sha256(prev_hash || canonical row). The rows already present are chained here in id order.
--      log_verify_chain verifies a chain and lists the breaks; every check is audited.
--   4. Sign-in and security log: security_log (append-only, chained), written by sec_log_write (owner pmis_identity_owner) and by triggers on
--      user_sessions, local_credentials, user_totp and user_recovery_codes (session ended, lockout, password changed or reset, 2FA enrolment,
--      recovery code used). Identifiers are stored only in the masked keyed form `?x***#<12 hex>`; the function refuses anything else.
--   5. job_runs, deployments, security_alerts (rules, job, notifications to the System Admins), retention and its purge, alert thresholds,
--      the monthly activity report and the readers (B4 scope), all through SECURITY DEFINER functions.
--   6. pmis_app reads none of the new tables directly and writes no log at all: audit_log, system_log and security_log are written only through
--      log_audit_write, log_system_write, sec_log_write, the triggers and the existing definer functions (db/sql/app_grants.sql).

-- ---------------------------------------------------------------------------------------------------------------------
-- 0. Permission actions of the contract that the enum lacked (manage_users, view_security_log). Not used in this transaction.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TYPE "PermissionAction" ADD VALUE IF NOT EXISTS 'manage_users';
ALTER TYPE "PermissionAction" ADD VALUE IF NOT EXISTS 'view_security_log';

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Settings (data, editable through the settings functions below)
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, description, updated_at) VALUES
  ('logs.field_changes.ignore_keys', '["version", "version_no", "updated_at", "created_at", "changed_at", "etag", "hash", "prev_hash", "*_hash", "via", "batch_id", "batch_row_id", "level_round", "path_frozen"]'::jsonb,
   'Keys never written to the field change log (technical). A * matches any characters.', now()),
  ('logs.field_changes.ignore_actions', '["%.read", "%download%", "%export%", "%integrity%", "local_sign_in%", "%_locked"]'::jsonb,
   'Audit actions that never produce field changes (LIKE patterns).', now()),
  ('logs.audit.full_reader_roles', '["PM"]'::jsonb, 'Role codes that read the whole Audit Log (B4: the Project Manager).', now()),
  ('logs.audit.team_lead_roles', '["RFD_ACQ_TL", "CW_TL", "TE_TL"]'::jsonb, 'Role codes of the Team Leads (B4: their own modules and regions).', now()),
  ('logs.audit.entity_modules', '{"task": "sites", "task_instance": "sites", "site": "sites", "milestone": "sites", "gate": "sites", "comment": "sites",
      "document_file": "sites", "document_slot": "sites", "document_zip_export": "sites", "status_update": "sites", "snag": "quality",
      "dismantle": "dismantle", "wh_movement": "warehouse", "warehouse_item": "warehouse", "as_built_item": "as_built",
      "import_batch": "templates", "template": "templates", "user": "users", "user_role_assignment": "assignments", "role": "roles",
      "group": "groups", "delegation": "admin.delegation", "permission_profile": "permission_profiles", "matrix": "admin.matrix",
      "matrix_cell": "admin.matrix", "setting": "settings", "workflow": "workflow_versions", "workflow_version": "workflow_versions",
      "holiday": "calendars", "work_calendar": "calendars", "sla_rule_set": "sla_rules", "weight_set": "weights", "document_type": "document_types",
      "announcement": "announcements", "message_thread": "messages", "department": "users", "field_definition": "fields",
      "team_scope_match": "settings", "export": "reports", "dashboard": "dashboard"}'::jsonb,
   'Module of an audit row by entity type (B4 scope). Register records use their register module.', now()),
  ('logs.retention', '{"system_log_days": 365, "security_log_days": 730, "version": 1}'::jsonb,
   'Retention of the System Log and the security log (minimum 90 and 365 days). The Audit Log is kept 10 years and is not settable.', now()),
  ('security_alerts', '{"failed_sign_ins": {"count": 5, "minutes": 15}, "failed_by_ip": {"count": 20, "minutes": 15}, "large_export_rows": 5000, "new_ip": true, "version": 1}'::jsonb,
   'Security alert thresholds (ranges: count 3..100 and 5..1000, minutes 1..1440, rows 100..1000000).', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Context helpers (read the transaction-local app.* settings the API sets; never trusted for rights)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_ctx(p_name text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$ SELECT nullif(current_setting('app.' || p_name, true), '') $$;

CREATE OR REPLACE FUNCTION log_ctx_inet(p_name text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN host(public.log_ctx(p_name)::inet);
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION log_ctx_uuid(p_name text) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.log_ctx(p_name)::uuid;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- The parsed device ({browser, os, type}) the API passes as app.device; anything else is dropped.
CREATE OR REPLACE FUNCTION log_clean_device(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
    'browser', left(p ->> 'browser', 40), 'os', left(p ->> 'os', 40), 'type', CASE WHEN p ->> 'type' IN ('desktop', 'mobile', 'tablet', 'bot', 'other') THEN p ->> 'type' END)) END
$$;

CREATE OR REPLACE FUNCTION log_ctx_device() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE v text := public.log_ctx('device');
BEGIN
  IF v IS NULL OR length(v) > 400 THEN RETURN NULL; END IF;
  RETURN nullif(public.log_clean_device(v::jsonb), '{}'::jsonb);
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION log_jsonb_uuid(p jsonb, p_key text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN (p ->> p_key)::uuid;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION log_setting(p_key text, p_default jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT value FROM public.settings WHERE key = p_key), p_default)
$$;

-- The session's step-up is recent (defence in depth; the API checks it first). Reads the caller's own session row only.
CREATE OR REPLACE FUNCTION log_actor_stepped_up() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s uuid := public.log_ctx_uuid('session_id'); age int;
BEGIN
  IF s IS NULL OR public.app_actor() IS NULL THEN RETURN false; END IF;
  age := coalesce((SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::int END FROM public.settings WHERE key = 'stepup_max_age_seconds'), 300);
  RETURN EXISTS (SELECT 1 FROM public.user_sessions WHERE id = s AND user_id = public.app_actor() AND revoked_at IS NULL
                 AND stepup_at IS NOT NULL AND stepup_at > now() - make_interval(secs => age));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. audit_log: new columns, module of the row, context fill
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE audit_log
  ADD COLUMN module_key text,
  ADD COLUMN session_id uuid,
  ADD COLUMN auth_method text CHECK (auth_method IN ('local', 'oidc', 'break_glass')),
  ADD COLUMN mfa boolean,
  ADD COLUMN stepup_verified boolean,
  ADD COLUMN via text CHECK (via IN ('manual', 'template', 'bulk', 'api', 'job')),
  ADD COLUMN batch_id uuid,
  ADD COLUMN batch_row uuid,
  ADD COLUMN device jsonb,
  ADD COLUMN job_name text;

CREATE INDEX audit_log_module_region_at ON audit_log (module_key, region_id, at);
CREATE INDEX audit_log_action_at ON audit_log (action, at);
CREATE INDEX audit_log_ip_at ON audit_log (ip, at) WHERE ip IS NOT NULL;
CREATE INDEX audit_log_session ON audit_log (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX audit_log_at_id ON audit_log (at DESC, id DESC);

CREATE OR REPLACE FUNCTION log_audit_module(p_type text, p_id text, p_before jsonb, p_after jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE k text;
BEGIN
  IF p_type = 'register_record' THEN
    k := coalesce(p_after ->> 'register', p_before ->> 'register');
    IF k IS NULL AND p_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT r.register_key INTO k FROM public.register_records r WHERE r.id = p_id::uuid;
    END IF;
    RETURN (SELECT d.module_key FROM public.register_definitions d WHERE d.register_key = k);
  END IF;
  RETURN public.log_setting('logs.audit.entity_modules', '{}'::jsonb) ->> p_type;
END $$;

CREATE OR REPLACE FUNCTION audit_log_fill() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v text;
BEGIN
  IF NEW.ip IS NULL THEN NEW.ip := public.log_ctx_inet('ip'); END IF;
  IF NEW.user_agent IS NULL THEN NEW.user_agent := left(public.log_ctx('user_agent'), 400); END IF;
  IF NEW.request_id IS NULL THEN NEW.request_id := left(public.log_ctx('request_id'), 64); END IF;
  IF NEW.session_id IS NULL THEN NEW.session_id := public.log_ctx_uuid('session_id'); END IF;
  IF NEW.auth_method IS NULL THEN
    v := public.log_ctx('auth_method');
    NEW.auth_method := CASE WHEN v IN ('local', 'oidc', 'break_glass') THEN v END;
  END IF;
  IF NEW.mfa IS NULL THEN NEW.mfa := CASE public.log_ctx('mfa') WHEN 'true' THEN true WHEN 'false' THEN false END; END IF;
  IF NEW.stepup_verified IS NULL THEN NEW.stepup_verified := CASE public.log_ctx('stepup') WHEN 'true' THEN true WHEN 'false' THEN false END; END IF;
  IF NEW.device IS NULL THEN NEW.device := public.log_ctx_device(); END IF;
  IF NEW.job_name IS NULL THEN NEW.job_name := left(public.log_ctx('job_name'), 80); END IF;
  IF NEW.batch_row IS NULL THEN NEW.batch_row := coalesce(public.log_jsonb_uuid(NEW.after, 'batch_row_id'), public.imp_current_row()); END IF;
  IF NEW.batch_id IS NULL THEN
    NEW.batch_id := coalesce(public.log_jsonb_uuid(NEW.after, 'batch_id'), (SELECT x.batch_id FROM public.import_batch_rows x WHERE x.id = NEW.batch_row));
  END IF;
  IF NEW.via IS NULL THEN
    v := public.log_ctx('via');
    NEW.via := CASE
      WHEN NEW.batch_row IS NOT NULL OR NEW.batch_id IS NOT NULL OR NEW.after ->> 'via' = 'batch' THEN 'template'
      WHEN v = 'job' THEN 'job'
      WHEN v = 'api' THEN 'api'
      WHEN v = 'bulk' OR NEW.after ->> 'via' = 'bulk' THEN 'bulk'
      WHEN v IN ('manual', 'button', 'drag') THEN 'manual'
      ELSE NULL END;
  END IF;
  IF NEW.module_key IS NULL THEN NEW.module_key := public.log_audit_module(NEW.entity_type, NEW.entity_id, NEW.before, NEW.after); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_audit_log_fill BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_fill();

-- Existing rows get their module (B4 scope over history). The append-only guard is lifted for this statement only, inside the migration.
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete;
UPDATE audit_log SET module_key = log_audit_module(entity_type, entity_id, before, after) WHERE module_key IS NULL;
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete;

-- Generic append-only guard of the new log tables. The security log loses rows only to its purge (owner pmis_identity_owner, older than the
-- 365-day floor, inside log_purge_security_log); the System Log only to its purge (owner pmis_definer, older than the 90-day floor).
CREATE OR REPLACE FUNCTION log_block_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN
    IF TG_TABLE_NAME = 'security_log' AND current_user = 'pmis_identity_owner' AND current_setting('pmis.log_purge', true) = 'security_log'
       AND OLD.at < now() - interval '365 days' THEN RETURN OLD; END IF;
    IF TG_TABLE_NAME = 'system_log' AND current_user = 'pmis_definer' AND current_setting('pmis.log_purge', true) = 'system_log'
       AND OLD.at < now() - interval '90 days' THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Field-level change log
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE audit_field_changes (
  id              bigserial PRIMARY KEY,
  audit_id        bigint NOT NULL REFERENCES audit_log (id),
  at              timestamptz NOT NULL,
  actor_id        uuid,
  on_behalf_of    uuid,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text,
  record_id       text,
  site_id         uuid,
  region_id       integer,
  module_key      text,
  field           text NOT NULL,
  field_label_en  text,
  field_label_ar  text,
  old_value       jsonb,
  new_value       jsonb,
  ip              text,
  user_agent      text,
  device          jsonb,
  session_id      uuid,
  via             text,
  batch_id        uuid,
  request_id      text
);
CREATE INDEX audit_field_changes_entity ON audit_field_changes (entity_type, entity_id, field, at DESC);
CREATE INDEX audit_field_changes_actor ON audit_field_changes (actor_id, at);
CREATE INDEX audit_field_changes_site ON audit_field_changes (site_id, at);
CREATE INDEX audit_field_changes_at ON audit_field_changes (at DESC, id DESC);
CREATE INDEX audit_field_changes_audit ON audit_field_changes (audit_id);

CREATE TRIGGER audit_field_changes_no_update_delete BEFORE UPDATE OR DELETE ON audit_field_changes FOR EACH ROW EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER audit_field_changes_no_truncate BEFORE TRUNCATE ON audit_field_changes FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();

-- One level of nesting: top-level scalars keep their key; data.x and custom.x become x (custom.x when data has x too); other objects parent.child.
CREATE OR REPLACE FUNCTION log_flatten(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE res jsonb := '{}'::jsonb; k text; v jsonb; ck text; cv jsonb; name text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN res; END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p) WHERE jsonb_typeof(value) <> 'object' LOOP
    res := res || jsonb_build_object(k, v);
  END LOOP;
  FOR k, v IN SELECT key, value FROM jsonb_each(p) WHERE jsonb_typeof(value) = 'object' ORDER BY CASE key WHEN 'data' THEN 0 WHEN 'custom' THEN 1 ELSE 2 END, key LOOP
    FOR ck, cv IN SELECT key, value FROM jsonb_each(v) LOOP
      name := CASE WHEN k IN ('data', 'custom') AND NOT res ? ck THEN ck ELSE k || '.' || ck END;
      res := res || jsonb_build_object(name, cv);
    END LOOP;
  END LOOP;
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION log_key_ignored(p_field text, p_patterns jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(p_patterns, '[]'::jsonb)) pat
                 WHERE regexp_replace(p_field, '^.*\.', '') LIKE replace(replace(pat, '_', '\_'), '*', '%')
                    OR p_field LIKE replace(replace(pat, '_', '\_'), '*', '%'))
$$;

CREATE OR REPLACE FUNCTION audit_log_field_diff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fb jsonb; fa jsonb; ign jsonb; reg text; f text; o jsonb; n jsonb; leaf text; le text; la text; eid text := NEW.entity_id;
BEGIN
  IF NEW.before IS NULL AND NEW.after IS NULL THEN RETURN NULL; END IF;
  IF NEW.before IS NULL AND NEW.action !~ '(create|new_version|registered|_added)' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(public.log_setting('logs.field_changes.ignore_actions', '[]'::jsonb)) pat WHERE NEW.action LIKE pat) THEN
    RETURN NULL;
  END IF;
  fb := public.log_flatten(NEW.before);
  fa := public.log_flatten(NEW.after);
  ign := public.log_setting('logs.field_changes.ignore_keys', '[]'::jsonb);
  reg := coalesce(NEW.after ->> 'register', NEW.before ->> 'register');
  -- A register record is followed by its logical id (entity_id of reg_snap); record_id keeps the version the audit row names.
  IF NEW.entity_type = 'register_record' THEN eid := coalesce(NEW.after ->> 'entity_id', NEW.before ->> 'entity_id', NEW.entity_id); END IF;
  FOR f, o, n IN
    SELECT coalesce(a.key, b.key), nullif(b.value, 'null'::jsonb), nullif(a.value, 'null'::jsonb)
    FROM jsonb_each(fa) a FULL JOIN jsonb_each(fb) b ON a.key = b.key
    WHERE nullif(a.value, 'null'::jsonb) IS DISTINCT FROM nullif(b.value, 'null'::jsonb)
  LOOP
    IF public.log_key_ignored(f, ign) THEN CONTINUE; END IF;
    leaf := regexp_replace(f, '^(data|custom)\.', '');
    le := NULL; la := NULL;
    IF reg IS NOT NULL THEN
      SELECT rf.label_en, rf.label_ar INTO le, la FROM public.register_fields rf WHERE rf.register_key = reg AND rf.code = leaf;
    END IF;
    IF le IS NULL THEN
      SELECT fd.label_en, fd.label_ar INTO le, la FROM public.field_definitions fd
      WHERE fd.code = leaf AND fd.entity_type::text IN (coalesce(reg, ''), NEW.entity_type, CASE NEW.entity_type WHEN 'task' THEN 'task_instance' ELSE '' END)
      ORDER BY fd.is_active DESC LIMIT 1;
    END IF;
    INSERT INTO public.audit_field_changes (audit_id, at, actor_id, on_behalf_of, action, entity_type, entity_id, record_id, site_id, region_id, module_key,
      field, field_label_en, field_label_ar, old_value, new_value, ip, user_agent, device, session_id, via, batch_id, request_id)
    VALUES (NEW.id, NEW.at, NEW.actor_id, NEW.on_behalf_of, NEW.action, NEW.entity_type, eid, NEW.entity_id, NEW.site_id, NEW.region_id, NEW.module_key,
      f, le, la, o, n, NEW.ip, NEW.user_agent, NEW.device, NEW.session_id, NEW.via, NEW.batch_id, NEW.request_id);
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER b_audit_log_field_diff AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_field_diff();

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Security log
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE security_log (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  event            text NOT NULL CHECK (event IN ('sign_in_started', 'sign_in_succeeded', 'callback_account_mismatch', 'sign_in_failed', 'sign_in_locked',
                     'sign_in_rate_limited', 'signed_out', 'session_expired', 'session_ended', 'session_revoked_by_admin', 'mfa_exemption_granted',
                     'mfa_exemption_revoked', 'step_up_passed', 'step_up_failed', 'break_glass_used', 'two_factor_passed', 'two_factor_failed',
                     'recovery_code_used', 'two_factor_enrolled', 'password_changed', 'password_reset')),
  outcome          text NOT NULL CHECK (outcome IN ('success', 'failure', 'info')),
  user_id          uuid,
  actor_id         uuid,
  identifier_hash  text CHECK (identifier_hash ~ '^\?[A-Za-z0-9+]?\*\*\*#[0-9a-f]{12}$'),
  client_type      text NOT NULL DEFAULT 'web' CHECK (client_type IN ('web', 'mobile', 'break_glass')),
  ip               text,
  user_agent       text,
  device           jsonb,
  session_id       uuid,
  request_id       text,
  detail           jsonb
);
CREATE INDEX security_log_at ON security_log (at DESC, id DESC);
CREATE INDEX security_log_user_at ON security_log (user_id, at);
CREATE INDEX security_log_identifier_at ON security_log (identifier_hash, at) WHERE identifier_hash IS NOT NULL;
CREATE INDEX security_log_ip_at ON security_log (ip, at) WHERE ip IS NOT NULL;
CREATE INDEX security_log_event_at ON security_log (event, at);
CREATE INDEX security_log_session ON security_log (session_id) WHERE session_id IS NOT NULL;

CREATE TRIGGER security_log_no_update_delete BEFORE UPDATE OR DELETE ON security_log FOR EACH ROW EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER security_log_no_truncate BEFORE TRUNCATE ON security_log FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();

-- The one writer. The identifier must already be masked (the API masks it with a keyed HMAC); the raw text is refused by the CHECK.
-- p_ctx may carry ip, user_agent, device, session_id, request_id, client_type; anything missing comes from the app.* settings.
CREATE OR REPLACE FUNCTION sec_log_write(p_event text, p_outcome text, p_user uuid, p_identifier text, p_detail jsonb, p_ctx jsonb DEFAULT '{}'::jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE nid bigint; c jsonb := coalesce(p_ctx, '{}'::jsonb); ipv text; ct text;
BEGIN
  IF p_detail IS NOT NULL AND (jsonb_typeof(p_detail) <> 'object' OR length(p_detail::text) > 4000) THEN
    RAISE EXCEPTION 'security log: detail must be a small object' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN ipv := host((c ->> 'ip')::inet); EXCEPTION WHEN others THEN ipv := NULL; END;
  ct := coalesce(c ->> 'client_type', 'web');
  INSERT INTO public.security_log (event, outcome, user_id, actor_id, identifier_hash, client_type, ip, user_agent, device, session_id, request_id, detail)
  VALUES (p_event, p_outcome, p_user, public.app_actor(), p_identifier, ct,
    coalesce(ipv, public.log_ctx_inet('ip')),
    left(coalesce(c ->> 'user_agent', public.log_ctx('user_agent')), 400),
    coalesce(nullif(public.log_clean_device(c -> 'device'), '{}'::jsonb), public.log_ctx_device()),
    coalesce(public.log_jsonb_uuid(c, 'session_id'), public.log_ctx_uuid('session_id')),
    left(coalesce(c ->> 'request_id', public.log_ctx('request_id')), 64),
    p_detail)
  RETURNING security_log.id INTO nid;
  RETURN nid;
END $$;

-- Generic capture on the identity tables: whoever ends a session, changes a password, locks an account, enrols a phone or spends a recovery code
-- (the auth functions of today and of migration 0044) leaves a security log row without being edited.
CREATE OR REPLACE FUNCTION sec_log_session_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ev text;
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    ev := CASE WHEN NEW.revoke_reason = 'logout' THEN 'signed_out'
               WHEN NEW.revoked_by IS NOT NULL AND NEW.revoked_by <> NEW.user_id THEN 'session_revoked_by_admin'
               ELSE 'session_ended' END;
    PERFORM public.sec_log_write(ev, 'info', NEW.user_id, NULL, jsonb_build_object('reason', left(NEW.revoke_reason, 200), 'revoked_by', NEW.revoked_by),
      jsonb_build_object('session_id', CASE WHEN ev = 'session_revoked_by_admin' THEN NEW.id::text ELSE coalesce(public.log_ctx('session_id'), NEW.id::text) END));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_sec_log_session AFTER UPDATE OF revoked_at ON user_sessions FOR EACH ROW EXECUTE FUNCTION sec_log_session_change();

CREATE OR REPLACE FUNCTION sec_log_credential_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    IF coalesce(NEW.set_by, a) IS NOT NULL AND coalesce(NEW.set_by, a) <> NEW.user_id THEN
      PERFORM public.sec_log_write('password_reset', 'info', NEW.user_id, NULL, jsonb_build_object('by', coalesce(NEW.set_by, a), 'must_change', NEW.must_change));
    ELSE
      PERFORM public.sec_log_write('password_changed', 'success', NEW.user_id, NULL, NULL);
    END IF;
  END IF;
  IF NEW.locked_until IS NOT NULL AND NEW.locked_until > now() AND (OLD.locked_until IS NULL OR OLD.locked_until <= now()) THEN
    PERFORM public.sec_log_write('sign_in_locked', 'failure', NEW.user_id, NULL, jsonb_build_object('locked_until', NEW.locked_until));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_sec_log_credentials AFTER UPDATE ON local_credentials FOR EACH ROW EXECUTE FUNCTION sec_log_credential_change();

CREATE OR REPLACE FUNCTION sec_log_totp_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.enrolled_at IS NOT NULL AND OLD.enrolled_at IS DISTINCT FROM NEW.enrolled_at THEN
    PERFORM public.sec_log_write('two_factor_enrolled', 'success', NEW.user_id, NULL, NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_sec_log_totp AFTER UPDATE ON user_totp FOR EACH ROW EXECUTE FUNCTION sec_log_totp_change();

CREATE OR REPLACE FUNCTION sec_log_recovery_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL THEN
    PERFORM public.sec_log_write('recovery_code_used', 'success', NEW.user_id, NULL,
      jsonb_build_object('remaining', (SELECT count(*) FROM public.user_recovery_codes r WHERE r.user_id = NEW.user_id AND r.used_at IS NULL)));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_sec_log_recovery AFTER UPDATE OF used_at ON user_recovery_codes FOR EACH ROW EXECUTE FUNCTION sec_log_recovery_change();

-- A session found past its idle or absolute limit is logged once as session_expired (called by the API when a cookie maps to it).
CREATE OR REPLACE FUNCTION sec_log_session_expired(p_session uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.user_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.user_sessions WHERE id = p_session;
  IF NOT FOUND OR s.revoked_at IS NOT NULL THEN RETURN; END IF;
  IF s.expires_at > now() AND s.last_activity_at > now() - interval '8 hours' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pmis.session_expired'), hashtext(p_session::text));
  IF EXISTS (SELECT 1 FROM public.security_log WHERE session_id = p_session AND event = 'session_expired') THEN RETURN; END IF;
  PERFORM public.sec_log_write('session_expired', 'info', s.user_id, NULL,
    jsonb_build_object('limit', CASE WHEN s.expires_at <= now() THEN 'absolute' ELSE 'idle' END), jsonb_build_object('session_id', p_session::text));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Hash chains (sealed at commit)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE log_chain_heads (
  log             text PRIMARY KEY CHECK (log IN ('audit', 'security')),
  seq             bigint NOT NULL DEFAULT 0,
  hash            char(64) NOT NULL DEFAULT repeat('0', 64),
  purged_through  bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz
);
INSERT INTO log_chain_heads (log) VALUES ('audit'), ('security');

CREATE TABLE audit_log_chain (
  seq            bigint PRIMARY KEY,
  audit_id       bigint NOT NULL UNIQUE REFERENCES audit_log (id),
  prev_hash      char(64) NOT NULL,
  hash           char(64) NOT NULL,
  canon_version  smallint NOT NULL DEFAULT 1,
  sealed_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE security_log_chain (
  seq            bigint PRIMARY KEY,
  security_id    bigint NOT NULL UNIQUE,
  prev_hash      char(64) NOT NULL,
  hash           char(64) NOT NULL,
  canon_version  smallint NOT NULL DEFAULT 1,
  sealed_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER audit_log_chain_no_update_delete BEFORE UPDATE OR DELETE ON audit_log_chain FOR EACH ROW EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER audit_log_chain_no_truncate BEFORE TRUNCATE ON audit_log_chain FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER security_log_chain_no_update_delete BEFORE UPDATE OR DELETE ON security_log_chain FOR EACH ROW EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER security_log_chain_no_truncate BEFORE TRUNCATE ON security_log_chain FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();

CREATE OR REPLACE FUNCTION log_ts_text(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$ SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') $$;

CREATE OR REPLACE FUNCTION log_chain_hash(p_prev text, p_canon text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$ SELECT encode(sha256(convert_to(p_prev || p_canon, 'UTF8')), 'hex') $$;

-- Canonical forms (version 1): an explicit field list, instants in UTC with microseconds, jsonb text (keys in a fixed order). Independent of the
-- session time zone, the collation and the column order.
CREATE OR REPLACE FUNCTION audit_log_canonical(r audit_log) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('v', 1, 'id', r.id, 'at', public.log_ts_text(r.at), 'actor_id', r.actor_id, 'on_behalf_of', r.on_behalf_of, 'action', r.action,
    'entity_type', r.entity_type, 'entity_id', r.entity_id, 'site_id', r.site_id, 'region_id', r.region_id, 'before', r.before, 'after', r.after,
    'reason', r.reason, 'is_admin_override', r.is_admin_override, 'ip', r.ip, 'user_agent', r.user_agent, 'request_id', r.request_id,
    'module_key', r.module_key, 'session_id', r.session_id, 'auth_method', r.auth_method, 'mfa', r.mfa, 'stepup_verified', r.stepup_verified,
    'via', r.via, 'batch_id', r.batch_id, 'batch_row', r.batch_row, 'device', r.device, 'job_name', r.job_name)::text
$$;

CREATE OR REPLACE FUNCTION security_log_canonical(r security_log) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('v', 1, 'id', r.id, 'at', public.log_ts_text(r.at), 'event', r.event, 'outcome', r.outcome, 'user_id', r.user_id,
    'actor_id', r.actor_id, 'identifier_hash', r.identifier_hash, 'client_type', r.client_type, 'ip', r.ip, 'user_agent', r.user_agent,
    'device', r.device, 'session_id', r.session_id, 'request_id', r.request_id, 'detail', r.detail)::text
$$;

CREATE OR REPLACE FUNCTION audit_log_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h public.log_chain_heads%ROWTYPE; r public.audit_log%ROWTYPE; nh text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pmis.log_chain.audit'));
  IF EXISTS (SELECT 1 FROM public.audit_log_chain c WHERE c.audit_id = NEW.id) THEN RETURN NULL; END IF;
  SELECT * INTO r FROM public.audit_log WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.log_chain_heads WHERE log = 'audit' FOR UPDATE;
  nh := public.log_chain_hash(h.hash, public.audit_log_canonical(r));
  INSERT INTO public.audit_log_chain (seq, audit_id, prev_hash, hash) VALUES (h.seq + 1, r.id, h.hash, nh);
  UPDATE public.log_chain_heads SET seq = h.seq + 1, hash = nh, updated_at = clock_timestamp() WHERE log = 'audit';
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION security_log_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h public.log_chain_heads%ROWTYPE; r public.security_log%ROWTYPE; nh text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pmis.log_chain.security'));
  IF EXISTS (SELECT 1 FROM public.security_log_chain c WHERE c.security_id = NEW.id) THEN RETURN NULL; END IF;
  SELECT * INTO r FROM public.security_log WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.log_chain_heads WHERE log = 'security' FOR UPDATE;
  nh := public.log_chain_hash(h.hash, public.security_log_canonical(r));
  INSERT INTO public.security_log_chain (seq, security_id, prev_hash, hash) VALUES (h.seq + 1, r.id, h.hash, nh);
  UPDATE public.log_chain_heads SET seq = h.seq + 1, hash = nh, updated_at = clock_timestamp() WHERE log = 'security';
  RETURN NULL;
END $$;

-- Rows already present are chained in id order (before the seal trigger exists, so nothing is chained twice).
DO $$
DECLARE r audit_log%ROWTYPE; prev text := repeat('0', 64); n bigint := 0; nh text;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    n := n + 1;
    nh := log_chain_hash(prev, audit_log_canonical(r));
    INSERT INTO audit_log_chain (seq, audit_id, prev_hash, hash) VALUES (n, r.id, prev, nh);
    prev := nh;
  END LOOP;
  UPDATE log_chain_heads SET seq = n, hash = prev, updated_at = now() WHERE log = 'audit';
END $$;

CREATE CONSTRAINT TRIGGER zz_audit_log_seal AFTER INSERT ON audit_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION audit_log_seal();
CREATE CONSTRAINT TRIGGER zz_security_log_seal AFTER INSERT ON security_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION security_log_seal();

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Writers that replace the direct inserts of pmis_app (audit rows of the API, System Log)
-- ---------------------------------------------------------------------------------------------------------------------
-- The actor is always the verified actor; reads, downloads and exports of the API use it. on_behalf_of is accepted only as the actor's own
-- "lead on behalf of" marker (any user id), never as the actor.
CREATE OR REPLACE FUNCTION log_audit_write(p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_reason text,
  p_site uuid DEFAULT NULL, p_region integer DEFAULT NULL, p_on_behalf uuid DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); nid bigint;
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_action IS NULL OR p_action !~ '^[a-z][a-z0-9_.]{1,79}$' OR p_entity_type IS NULL OR p_entity_type !~ '^[a-z][a-z0-9_]{1,59}$' THEN
    RAISE EXCEPTION 'audit: action and entity type are lower-case codes' USING ERRCODE = 'check_violation';
  END IF;
  IF p_region IS NOT NULL AND NOT public.app_region_check(p_region) THEN RAISE EXCEPTION 'audit: region not visible' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.audit_log (action, entity_type, entity_id, site_id, region_id, before, after, reason, actor_id, on_behalf_of)
  VALUES (p_action, p_entity_type, left(p_entity_id, 200), p_site, p_region, p_before, p_after, left(p_reason, 2000), a, p_on_behalf)
  RETURNING audit_log.id INTO nid;
  RETURN nid;
END $$;

CREATE OR REPLACE FUNCTION log_system_write(p_level text, p_source text, p_message text, p_context jsonb, p_user uuid, p_request_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.system_log (level, source, message, context, user_id, request_id)
  VALUES (p_level::"LogLevel", left(coalesce(p_source, 'api'), 40), left(coalesce(p_message, ''), 2000),
    CASE WHEN p_context IS NULL OR length(p_context::text) <= 20000 THEN p_context ELSE jsonb_build_object('truncated', true) END,
    p_user, left(coalesce(p_request_id, public.log_ctx('request_id')), 64));
END $$;

CREATE TRIGGER system_log_no_update BEFORE UPDATE OR DELETE ON system_log FOR EACH ROW EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER system_log_no_truncate BEFORE TRUNCATE ON system_log FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Job runs and deployments
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE job_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_.-]{1,59}$'),
  started_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at  timestamptz,
  outcome      text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'ok', 'failed', 'skipped')),
  rows         bigint,
  error        text,
  detail       jsonb,
  host         text
);
CREATE INDEX job_runs_name_started ON job_runs (name, started_at DESC);
CREATE INDEX job_runs_started ON job_runs (started_at DESC, id);

CREATE OR REPLACE FUNCTION job_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.outcome = 'running' AND current_user = 'pmis_definer'
     AND NEW.id = OLD.id AND NEW.name = OLD.name AND NEW.started_at = OLD.started_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'job_runs is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER job_runs_guard BEFORE UPDATE OR DELETE ON job_runs FOR EACH ROW EXECUTE FUNCTION job_runs_guard();

CREATE OR REPLACE FUNCTION job_run_start(p_name text, p_host text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE nid uuid;
BEGIN
  INSERT INTO public.job_runs (name, host) VALUES (p_name, left(p_host, 100)) RETURNING job_runs.id INTO nid;
  RETURN nid;
END $$;

CREATE OR REPLACE FUNCTION job_run_finish(p_id uuid, p_outcome text, p_rows bigint, p_error text, p_detail jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_outcome NOT IN ('ok', 'failed', 'skipped') THEN RAISE EXCEPTION 'job run: unknown outcome' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.job_runs SET finished_at = clock_timestamp(), outcome = p_outcome, rows = p_rows, error = left(p_error, 1000),
    detail = CASE WHEN p_detail IS NULL OR length(p_detail::text) <= 4000 THEN p_detail END
  WHERE id = p_id AND outcome = 'running';
END $$;

CREATE TABLE deployments (
  id            bigserial PRIMARY KEY,
  deployed_at   timestamptz NOT NULL DEFAULT now(),
  version       text NOT NULL,
  git_sha       text CHECK (git_sha IS NULL OR git_sha ~ '^[0-9a-f]{7,40}$'),
  migrations    text[] NOT NULL DEFAULT '{}',
  deployed_by   text,
  host          text,
  detail        jsonb
);
CREATE TRIGGER deployments_no_update_delete BEFORE UPDATE OR DELETE ON deployments FOR EACH ROW EXECUTE FUNCTION log_block_mutation();

-- Called by tools/install/install-ubuntu.sh (and so update.sh) after migrating, as the database superuser. pmis_app cannot call it.
CREATE OR REPLACE FUNCTION log_deployment(p_version text, p_git_sha text, p_migrations text[], p_by text, p_host text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE nid bigint;
BEGIN
  INSERT INTO public.deployments (version, git_sha, migrations, deployed_by, host)
  VALUES (left(coalesce(nullif(p_version, ''), 'unknown'), 40), lower(nullif(p_git_sha, '')), coalesce(p_migrations, '{}'), left(p_by, 100), left(p_host, 100))
  RETURNING deployments.id INTO nid;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, via, job_name)
  VALUES ('deployment_recorded', 'deployment', nid::text, jsonb_build_object('version', p_version, 'git_sha', p_git_sha, 'migrations', to_jsonb(coalesce(p_migrations, '{}')), 'by', p_by), 'job', 'installer');
  RETURN nid;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Readers: Audit Log scope (decision B4) and the read functions (every read is audited)
-- ---------------------------------------------------------------------------------------------------------------------
-- Tuples (module_key, region_id) the user may read; NULL = all. System Admins and the full-reader roles (Project Manager): (NULL, NULL).
-- Team Leads: the modules and regions of their Team Lead assignments. Anyone else: their view_audit grants, scoped like any grant (B3);
-- a view_audit grant on the module `audit` covers every module of the assignment.
CREATE OR REPLACE FUNCTION log_audit_scope(p_user uuid) RETURNS TABLE (module_key text, region_id integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE fullr text[]; leads text[];
BEGIN
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.status = 'active') THEN RETURN; END IF;
  IF public.app_user_is_system_admin(p_user) THEN RETURN QUERY SELECT NULL::text, NULL::int; RETURN; END IF;
  SELECT array_agg(x) INTO fullr FROM jsonb_array_elements_text(public.log_setting('logs.audit.full_reader_roles', '["PM"]'::jsonb)) x;
  SELECT array_agg(x) INTO leads FROM jsonb_array_elements_text(public.log_setting('logs.audit.team_lead_roles', '[]'::jsonb)) x;
  IF EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.is_active
             WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()) AND r.code = ANY (coalesce(fullr, '{}'))) THEN
    RETURN QUERY SELECT NULL::text, NULL::int; RETURN;
  END IF;
  RETURN QUERY
  WITH act AS (
    SELECT a.id, a.all_modules, a.all_regions, r.code
    FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.is_active
    WHERE a.user_id = p_user AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
  ), regs AS (
    SELECT act.id, NULL::int AS region_id FROM act WHERE act.all_regions
    UNION ALL SELECT ar.assignment_id, ar.region_id FROM public.user_role_assignment_regions ar JOIN act ON act.id = ar.assignment_id AND NOT act.all_regions
  ), mods AS (
    SELECT act.id, NULL::text AS module_key FROM act WHERE act.all_modules
    UNION ALL SELECT am.assignment_id, am.module_key FROM public.user_role_assignment_modules am JOIN act ON act.id = am.assignment_id AND NOT act.all_modules
  ), lead AS (
    SELECT m.module_key, g.region_id FROM act JOIN mods m ON m.id = act.id JOIN regs g ON g.id = act.id WHERE act.code = ANY (coalesce(leads, '{}'))
  ), granted AS (
    SELECT CASE WHEN pg.module_key = 'audit' THEN m.module_key ELSE pg.module_key END AS module_key, g.region_id
    FROM act
    JOIN public.user_role_assignment_profiles ap ON ap.assignment_id = act.id
    JOIN public.permission_profiles pp ON pp.id = ap.profile_id AND pp.is_active
    JOIN public.permission_grants pg ON pg.profile_id = pp.id AND pg.action = 'view_audit'
    JOIN mods m ON m.id = act.id
    JOIN regs g ON g.id = act.id
    WHERE pg.module_key = 'audit' OR m.module_key IS NULL OR m.module_key = split_part(pg.module_key, '.', 1)
  ), deleg AS (
    SELECT CASE WHEN d.is_full OR dg.module_key = 'audit' THEN NULL ELSE dg.module_key END AS module_key, dr.region_id
    FROM public.app_user_delegations(p_user) x(id)
    JOIN public.delegations d ON d.id = x.id
    LEFT JOIN public.delegation_grants dg ON dg.delegation_id = d.id AND dg.action = 'view_audit'
    LEFT JOIN LATERAL (SELECT NULL::int AS region_id WHERE d.all_regions
                       UNION ALL SELECT r.region_id FROM public.delegation_regions r WHERE r.delegation_id = d.id AND NOT d.all_regions) dr ON true
    WHERE d.is_full OR dg.module_key IS NOT NULL
  )
  SELECT DISTINCT s.module_key, s.region_id FROM (SELECT * FROM lead UNION ALL SELECT * FROM granted UNION ALL SELECT * FROM deleg) s;
END $$;

CREATE OR REPLACE FUNCTION log_in_scope(p_scope jsonb, p_module text, p_region integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(p_scope) s
    WHERE (s ->> 'm' IS NULL OR p_module = s ->> 'm' OR p_module LIKE (s ->> 'm') || '.%' OR split_part(p_module, '.', 1) = s ->> 'm')
      AND (s ->> 'r' IS NULL OR p_region = (s ->> 'r')::int))
$$;

CREATE OR REPLACE FUNCTION log_audit_scope_json() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE j jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('m', s.module_key, 'r', s.region_id)), '[]'::jsonb) INTO j FROM public.log_audit_scope(public.app_actor()) s;
  RETURN j;
END $$;

-- One page of the Audit Log for the caller (B4). p: from, to, actor_id, site_id, region_id, entity_type, entity_id, action, via, ip, bulk_action_id,
-- admin_override, privileged, q, cursor_at, cursor_id. 403 (42501) when the caller reads nothing. The read is audited unless p.no_audit (export
-- worker: the export is audited once by its own row).
CREATE OR REPLACE FUNCTION log_audit_read(p jsonb, p_limit integer) RETURNS SETOF audit_log
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sc jsonb := public.log_audit_scope_json(); isfull boolean; lim int := least(greatest(coalesce(p_limit, 50), 1), 100001);
BEGIN
  IF jsonb_array_length(sc) = 0 THEN RAISE EXCEPTION 'audit log: no reader right' USING ERRCODE = 'insufficient_privilege'; END IF;
  isfull := EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'm' IS NULL AND s ->> 'r' IS NULL);
  IF NOT coalesce((p ->> 'no_audit')::boolean, false) THEN
    PERFORM public.log_audit_write('audit_log.read', 'audit_log', NULL, NULL, p - 'cursor_at' - 'cursor_id' - 'no_audit', NULL);
  END IF;
  RETURN QUERY
  SELECT a.* FROM public.audit_log a
  WHERE (isfull OR (a.module_key IS NOT NULL AND public.log_in_scope(sc, a.module_key, a.region_id) AND (a.region_id IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'r' IS NULL))))
    AND (p ->> 'from' IS NULL OR a.at >= (p ->> 'from')::timestamptz)
    AND (p ->> 'to' IS NULL OR a.at < (p ->> 'to')::timestamptz)
    AND (p ->> 'actor_id' IS NULL OR a.actor_id = (p ->> 'actor_id')::uuid OR a.on_behalf_of = (p ->> 'actor_id')::uuid)
    AND (p ->> 'site_id' IS NULL OR a.site_id = (p ->> 'site_id')::uuid)
    AND (p ->> 'region_id' IS NULL OR a.region_id = (p ->> 'region_id')::int)
    AND (p ->> 'entity_type' IS NULL OR a.entity_type = p ->> 'entity_type')
    AND (p ->> 'entity_id' IS NULL OR a.entity_id = p ->> 'entity_id')
    AND (p ->> 'action' IS NULL OR a.action = p ->> 'action')
    AND (p ->> 'module_key' IS NULL OR a.module_key = p ->> 'module_key')
    AND (p ->> 'via' IS NULL OR a.via = p ->> 'via')
    AND (p ->> 'ip' IS NULL OR a.ip = p ->> 'ip')
    AND (p ->> 'session_id' IS NULL OR a.session_id = (p ->> 'session_id')::uuid)
    AND (p ->> 'batch_id' IS NULL OR a.batch_id = (p ->> 'batch_id')::uuid)
    AND (p ->> 'bulk_action_id' IS NULL OR a.after ->> 'bulk_action_id' = p ->> 'bulk_action_id')
    AND (p ->> 'admin_override' IS NULL OR a.is_admin_override = (p ->> 'admin_override')::boolean)
    AND (p ->> 'privileged' IS NULL OR public.log_is_privileged(a.action, a.entity_type, a.is_admin_override) = (p ->> 'privileged')::boolean)
    AND (p ->> 'q' IS NULL OR a.action ILIKE '%' || (p ->> 'q') || '%' OR a.entity_id ILIKE '%' || (p ->> 'q') || '%' OR a.reason ILIKE '%' || (p ->> 'q') || '%'
         OR a.request_id = p ->> 'q')
    AND (p ->> 'cursor_at' IS NULL OR (a.at, a.id) < ((p ->> 'cursor_at')::timestamptz, (p ->> 'cursor_id')::bigint))
  ORDER BY a.at DESC, a.id DESC
  LIMIT lim;
END $$;

-- The chain position of an audit row (shown beside the row; the chain table itself is not readable by pmis_app).
CREATE OR REPLACE FUNCTION log_audit_chain_seq(p_id bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT seq FROM public.audit_log_chain WHERE audit_id = p_id $$;

-- Sensitive changes: roles, assignments, groups, delegations, profiles, the matrix, settings, workflow versions, overrides.
CREATE OR REPLACE FUNCTION log_is_privileged(p_action text, p_entity text, p_override boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(p_override, false)
      OR p_entity IN ('role', 'user_role_assignment', 'group', 'delegation', 'permission_profile', 'matrix', 'matrix_cell', 'setting', 'workflow',
                      'workflow_version', 'team_scope_match', 'sla_rule_set', 'weight_set', 'field_definition', 'document_type')
      OR p_action ~ '(override|log_retention|two_factor|mfa_exemption|password_reset|user_status|user_deleted|freeze|self_approval|security_alert)'
$$;

CREATE OR REPLACE FUNCTION log_field_changes_read(p jsonb, p_limit integer) RETURNS SETOF audit_field_changes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sc jsonb := public.log_audit_scope_json(); isfull boolean; lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  IF jsonb_array_length(sc) = 0 THEN RAISE EXCEPTION 'audit log: no reader right' USING ERRCODE = 'insufficient_privilege'; END IF;
  isfull := EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'm' IS NULL AND s ->> 'r' IS NULL);
  PERFORM public.log_audit_write('audit_log.field_changes_read', 'audit_log', NULL, NULL, p - 'cursor_at' - 'cursor_id', NULL);
  RETURN QUERY
  SELECT c.* FROM public.audit_field_changes c
  WHERE (isfull OR (c.module_key IS NOT NULL AND public.log_in_scope(sc, c.module_key, c.region_id) AND (c.region_id IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'r' IS NULL))))
    AND (p ->> 'entity_type' IS NULL OR c.entity_type = p ->> 'entity_type')
    AND (p ->> 'entity_id' IS NULL OR c.entity_id = p ->> 'entity_id')
    AND (p ->> 'site_id' IS NULL OR c.site_id = (p ->> 'site_id')::uuid)
    AND (p ->> 'field' IS NULL OR c.field = p ->> 'field')
    AND (p ->> 'actor_id' IS NULL OR c.actor_id = (p ->> 'actor_id')::uuid)
    AND (p ->> 'from' IS NULL OR c.at >= (p ->> 'from')::timestamptz)
    AND (p ->> 'to' IS NULL OR c.at < (p ->> 'to')::timestamptz)
    AND (p ->> 'ip' IS NULL OR c.ip = p ->> 'ip')
    AND (p ->> 'via' IS NULL OR c.via = p ->> 'via')
    AND (p ->> 'cursor_at' IS NULL OR (c.at, c.id) < ((p ->> 'cursor_at')::timestamptz, (p ->> 'cursor_id')::bigint))
  ORDER BY c.at DESC, c.id DESC
  LIMIT lim;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Security alerts
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE security_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  rule             text NOT NULL CHECK (rule IN ('failed_sign_ins', 'failed_sign_ins_ip', 'new_ip', 'large_export', 'admin_set_changed', 'retention_reduced', 'audit_integrity_failure')),
  severity         text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged')),
  title            text NOT NULL,
  detail           jsonb,
  dedup_key        text NOT NULL UNIQUE,
  user_id          uuid,
  ip               text,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid,
  ack_note         text
);
CREATE INDEX security_alerts_status_created ON security_alerts (status, created_at DESC);
CREATE INDEX security_alerts_created ON security_alerts (created_at DESC, id);

CREATE OR REPLACE FUNCTION security_alerts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_user = 'pmis_definer' AND OLD.status = 'open' AND NEW.status = 'acknowledged'
     AND NEW.rule = OLD.rule AND NEW.dedup_key = OLD.dedup_key AND NEW.created_at = OLD.created_at AND NEW.detail IS NOT DISTINCT FROM OLD.detail THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'security_alerts: % blocked', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER security_alerts_guard BEFORE UPDATE OR DELETE ON security_alerts FOR EACH ROW EXECUTE FUNCTION security_alerts_guard();

CREATE TABLE security_alert_state (key text PRIMARY KEY, value bigint NOT NULL DEFAULT 0);
INSERT INTO security_alert_state (key, value) SELECT 'audit_seq', seq FROM log_chain_heads WHERE log = 'audit';
INSERT INTO security_alert_state (key, value) VALUES ('security_seq', 0);

-- Raises one alert (once per dedup key) and tells every active System Admin in-app. Returns true when the alert is new.
CREATE OR REPLACE FUNCTION sec_alert_raise(p_rule text, p_severity text, p_title text, p_detail jsonb, p_dedup text, p_user uuid DEFAULT NULL, p_ip text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE aid uuid; u uuid;
BEGIN
  INSERT INTO public.security_alerts (rule, severity, title, detail, dedup_key, user_id, ip)
  VALUES (p_rule, p_severity, left(p_title, 300), p_detail, p_dedup, p_user, p_ip)
  ON CONFLICT (dedup_key) DO NOTHING RETURNING id INTO aid;
  IF aid IS NULL THEN RETURN false; END IF;
  FOR u IN SELECT DISTINCT gm.user_id FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
           JOIN public.users x ON x.id = gm.user_id AND x.status = 'active' LOOP
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link, module_key)
    VALUES (u, 'in_app', 'security_alert', left(p_title, 300), p_rule, '/admin/security-alerts?id=' || aid::text, 'admin.security_log');
  END LOOP;
  RETURN true;
END $$;

-- The rules, over the rows sealed since the last run (chain sequence = commit order, so nothing committed late is missed). Idempotent.
CREATE OR REPLACE FUNCTION sec_alerts_evaluate() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cfg jsonb := public.log_setting('security_alerts', '{}'::jsonb); n int := 0; wa bigint; ws bigint; ha bigint; hs bigint; r record;
  fc int := coalesce((cfg #>> '{failed_sign_ins,count}')::int, 5); fm int := coalesce((cfg #>> '{failed_sign_ins,minutes}')::int, 15);
  ic int := coalesce((cfg #>> '{failed_by_ip,count}')::int, 20); im int := coalesce((cfg #>> '{failed_by_ip,minutes}')::int, 15);
  big numeric := coalesce((cfg ->> 'large_export_rows')::numeric, 5000); newip boolean := coalesce((cfg ->> 'new_ip')::boolean, true);
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('pmis.security_alerts')) THEN RETURN 0; END IF;
  SELECT value INTO wa FROM public.security_alert_state WHERE key = 'audit_seq' FOR UPDATE;
  SELECT value INTO ws FROM public.security_alert_state WHERE key = 'security_seq' FOR UPDATE;
  SELECT seq INTO ha FROM public.log_chain_heads WHERE log = 'audit';
  SELECT seq INTO hs FROM public.log_chain_heads WHERE log = 'security';

  -- failed sign-ins per masked identifier (or matched user), and per ip
  FOR r IN
    SELECT 'id' AS k, coalesce(s.user_id::text, s.identifier_hash) AS key, max(s.at) AS last_at, max(s.user_id::text) AS uid
    FROM public.security_log_chain c JOIN public.security_log s ON s.id = c.security_id
    WHERE c.seq > ws AND c.seq <= hs AND s.event IN ('sign_in_failed', 'two_factor_failed') AND coalesce(s.user_id::text, s.identifier_hash) IS NOT NULL
    GROUP BY 2
    UNION ALL
    SELECT 'ip', s.ip, max(s.at), NULL FROM public.security_log_chain c JOIN public.security_log s ON s.id = c.security_id
    WHERE c.seq > ws AND c.seq <= hs AND s.event IN ('sign_in_failed', 'two_factor_failed') AND s.ip IS NOT NULL GROUP BY 2
  LOOP
    IF r.k = 'id' AND (SELECT count(*) FROM public.security_log s WHERE s.event IN ('sign_in_failed', 'two_factor_failed')
          AND coalesce(s.user_id::text, s.identifier_hash) = r.key AND s.at > r.last_at - make_interval(mins => fm) AND s.at <= r.last_at) >= fc THEN
      IF public.sec_alert_raise('failed_sign_ins', 'medium', 'Repeated failed sign-ins for one account or identifier',
           jsonb_build_object('key', r.key, 'count_at_least', fc, 'minutes', fm, 'last_at', r.last_at),
           'failed_sign_ins:' || r.key || ':' || floor(extract(epoch FROM r.last_at) / (fm * 60))::text, r.uid::uuid, NULL) THEN n := n + 1; END IF;
    ELSIF r.k = 'ip' AND (SELECT count(*) FROM public.security_log s WHERE s.event IN ('sign_in_failed', 'two_factor_failed')
          AND s.ip = r.key AND s.at > r.last_at - make_interval(mins => im) AND s.at <= r.last_at) >= ic THEN
      IF public.sec_alert_raise('failed_sign_ins_ip', 'medium', 'Repeated failed sign-ins from one address',
           jsonb_build_object('ip', r.key, 'count_at_least', ic, 'minutes', im, 'last_at', r.last_at),
           'failed_sign_ins_ip:' || r.key || ':' || floor(extract(epoch FROM r.last_at) / (im * 60))::text, NULL, r.key) THEN n := n + 1; END IF;
    END IF;
  END LOOP;

  -- a sign-in from an address the user never signed in from before (only once the user has a history)
  IF newip THEN
    FOR r IN
      SELECT s.id, s.user_id, s.ip, s.at FROM public.security_log_chain c JOIN public.security_log s ON s.id = c.security_id
      WHERE c.seq > ws AND c.seq <= hs AND s.event = 'sign_in_succeeded' AND s.user_id IS NOT NULL AND s.ip IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.security_log p WHERE p.user_id = s.user_id AND p.event = 'sign_in_succeeded' AND p.id < s.id)
        AND NOT EXISTS (SELECT 1 FROM public.security_log p WHERE p.user_id = s.user_id AND p.event = 'sign_in_succeeded' AND p.id < s.id AND p.ip = s.ip)
    LOOP
      IF public.sec_alert_raise('new_ip', 'low', 'Sign-in from a new address', jsonb_build_object('ip', r.ip, 'at', r.at, 'security_log_id', r.id),
           'new_ip:' || r.user_id::text || ':' || r.ip, r.user_id, r.ip) THEN n := n + 1; END IF;
    END LOOP;
  END IF;

  -- large exports, changes of the admin set, retention reduced
  FOR r IN
    SELECT a.* FROM public.audit_log_chain c JOIN public.audit_log a ON a.id = c.audit_id WHERE c.seq > wa AND c.seq <= ha
      AND (a.action LIKE '%export%' OR a.action IN ('group_member_added', 'group_member_removed', 'admin_bootstrapped', 'log_retention_reduced'))
  LOOP
    IF r.action LIKE '%export%' AND coalesce(public.log_num(r.after, 'row_count'), public.log_num(r.after, 'file_count'), public.log_num(r.after, 'rows'),
         public.log_num(r.after, 'site_count'), 0) > big THEN
      IF public.sec_alert_raise('large_export', 'medium', 'A large export was started',
           jsonb_build_object('audit_id', r.id, 'action', r.action, 'rows', coalesce(public.log_num(r.after, 'row_count'), public.log_num(r.after, 'file_count'), public.log_num(r.after, 'rows'), public.log_num(r.after, 'site_count')), 'threshold', big),
           'large_export:' || r.id::text, r.actor_id, r.ip) THEN n := n + 1; END IF;
    ELSIF r.action = 'admin_bootstrapped' OR (r.action IN ('group_member_added', 'group_member_removed')
          AND EXISTS (SELECT 1 FROM public.groups g WHERE g.id::text = r.entity_id AND g.is_system_admins)) THEN
      IF public.sec_alert_raise('admin_set_changed', 'high', 'The System Admins changed', jsonb_build_object('audit_id', r.id, 'action', r.action, 'after', r.after),
           'admin_set_changed:' || r.id::text, r.actor_id, r.ip) THEN n := n + 1; END IF;
    ELSIF r.action = 'log_retention_reduced' THEN
      IF public.sec_alert_raise('retention_reduced', 'critical', 'Log retention was reduced', jsonb_build_object('audit_id', r.id, 'before', r.before, 'after', r.after),
           'retention_reduced:' || r.id::text, r.actor_id, r.ip) THEN n := n + 1; END IF;
    END IF;
  END LOOP;

  UPDATE public.security_alert_state SET value = ha WHERE key = 'audit_seq';
  UPDATE public.security_alert_state SET value = hs WHERE key = 'security_seq';
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION log_num(p jsonb, p_key text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN (p ->> p_key)::numeric;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION sec_can_read() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  IF a IS NULL THEN RETURN false; END IF;
  RETURN public.app_user_is_system_admin(a) OR public.app_has_permission(a, 'admin.security_log', 'view_security_log'::"PermissionAction");
END $$;

CREATE OR REPLACE FUNCTION sec_alerts_read(p jsonb, p_limit integer) RETURNS SETOF security_alerts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.sec_can_read() THEN RAISE EXCEPTION 'security alerts: System Admin or view_security_log required' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY SELECT x.* FROM public.security_alerts x
  WHERE (p ->> 'status' IS NULL OR x.status = p ->> 'status')
    AND (p ->> 'rule' IS NULL OR x.rule = p ->> 'rule')
    AND (p ->> 'cursor_at' IS NULL OR (x.created_at, x.id) < ((p ->> 'cursor_at')::timestamptz, (p ->> 'cursor_id')::uuid))
  ORDER BY x.created_at DESC, x.id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END $$;

CREATE OR REPLACE FUNCTION sec_alerts_count(p jsonb) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.sec_can_read() THEN RAISE EXCEPTION 'security alerts: System Admin or view_security_log required' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN (SELECT count(*) FROM public.security_alerts x WHERE (p ->> 'status' IS NULL OR x.status = p ->> 'status') AND (p ->> 'rule' IS NULL OR x.rule = p ->> 'rule'));
END $$;

CREATE OR REPLACE FUNCTION sec_alert_ack(p_id uuid, p_note text) RETURNS security_alerts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.security_alerts%ROWTYPE;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'security alerts: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_note IS NULL OR length(trim(p_note)) < 3 THEN PERFORM public.wf_err('note_required', '{}'::jsonb); END IF;
  SELECT * INTO r FROM public.security_alerts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The alert does not exist.')); END IF;
  IF r.status <> 'open' THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'The alert is already acknowledged.')); END IF;
  UPDATE public.security_alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = public.app_actor(), ack_note = left(trim(p_note), 1000)
  WHERE id = p_id RETURNING * INTO r;
  PERFORM public.log_audit_write('security_alert_ack', 'security_alert', p_id::text, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'acknowledged', 'rule', r.rule), p_note);
  RETURN r;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Security log readers and the integrity check
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sec_log_read(p jsonb, p_limit integer) RETURNS SETOF security_log
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE adm boolean := public.app_actor_is_system_admin(); lim int := least(greatest(coalesce(p_limit, 50), 1), 100001); ev text[];
BEGIN
  IF NOT public.sec_can_read() THEN RAISE EXCEPTION 'security log: System Admin or view_security_log required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF jsonb_typeof(p -> 'event') = 'array' THEN SELECT array_agg(x) INTO ev FROM jsonb_array_elements_text(p -> 'event') x; END IF;
  IF NOT coalesce((p ->> 'no_audit')::boolean, false) THEN
    PERFORM public.log_audit_write('security_log.read', 'security_log', NULL, NULL, p - 'cursor_at' - 'cursor_id' - 'no_audit', NULL);
  END IF;
  RETURN QUERY
  SELECT s.id, s.at, s.event, s.outcome, s.user_id, s.actor_id, s.identifier_hash, s.client_type,
         CASE WHEN adm THEN s.ip END, s.user_agent, s.device, s.session_id, s.request_id, s.detail
  FROM public.security_log s
  WHERE (p ->> 'from' IS NULL OR s.at >= (p ->> 'from')::timestamptz)
    AND (p ->> 'to' IS NULL OR s.at < (p ->> 'to')::timestamptz)
    AND (ev IS NULL OR s.event = ANY (ev))
    AND (p ->> 'outcome' IS NULL OR s.outcome = p ->> 'outcome')
    AND (p ->> 'user_id' IS NULL OR s.user_id = (p ->> 'user_id')::uuid)
    AND (p ->> 'ip' IS NULL OR (adm AND s.ip = p ->> 'ip'))
    AND (p ->> 'q' IS NULL OR s.identifier_hash = p ->> 'q' OR s.request_id = p ->> 'q'
         OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = s.user_id AND (u.display_name ILIKE '%' || (p ->> 'q') || '%' OR trim(u.employee_id) = p ->> 'q')))
    AND (p ->> 'cursor_at' IS NULL OR (s.at, s.id) < ((p ->> 'cursor_at')::timestamptz, (p ->> 'cursor_id')::bigint))
  ORDER BY s.at DESC, s.id DESC LIMIT lim;
END $$;

-- Verifies a chain (System Admins only; a delegate is not enough). Breaks: sequence_gap, previous_hash_mismatch, hash_mismatch, row_missing,
-- unsealed (a committed row without a chain entry: its trigger was bypassed). The check is audited; a break raises audit_integrity_failure.
CREATE OR REPLACE FUNCTION log_verify_chain(p_log text, p_from bigint DEFAULT NULL, p_to bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h public.log_chain_heads%ROWTYPE; start bigint; prev text; expected bigint; cnt bigint := 0; first_s bigint; last_s bigint; head text;
  brk jsonb := '[]'::jsonb; nb int := 0; c record; calc text; ar public.audit_log%ROWTYPE; sr public.security_log%ROWTYPE; res jsonb; u record;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'log integrity: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_log NOT IN ('audit', 'security') THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'Unknown log.')); END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_to < p_from THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('detail', 'to_seq must not be smaller than from_seq.', 'errors',
      jsonb_build_array(jsonb_build_object('path', '/to_seq', 'code', 'invalid', 'message', 'to_seq must not be smaller than from_seq.'))));
  END IF;
  SELECT * INTO h FROM public.log_chain_heads WHERE log = p_log;
  start := greatest(coalesce(p_from, 1), h.purged_through + 1);
  IF start = 1 THEN prev := repeat('0', 64);
  ELSIF p_log = 'audit' THEN SELECT x.hash INTO prev FROM public.audit_log_chain x WHERE x.seq = start - 1;
  ELSE SELECT x.hash INTO prev FROM public.security_log_chain x WHERE x.seq = start - 1; END IF;
  expected := start;
  FOR c IN
    SELECT x.seq, x.audit_id AS row_id, x.prev_hash, x.hash FROM public.audit_log_chain x WHERE p_log = 'audit' AND x.seq >= start AND (p_to IS NULL OR x.seq <= p_to)
    UNION ALL
    SELECT x.seq, x.security_id, x.prev_hash, x.hash FROM public.security_log_chain x WHERE p_log = 'security' AND x.seq >= start AND (p_to IS NULL OR x.seq <= p_to)
    ORDER BY 1
  LOOP
    cnt := cnt + 1;
    first_s := coalesce(first_s, c.seq);
    last_s := c.seq;
    IF c.seq <> expected AND nb < 100 THEN
      brk := brk || jsonb_build_object('seq', expected, 'kind', 'sequence_gap', 'row_id', NULL, 'expected_hash', NULL, 'found_hash', NULL); nb := nb + 1;
    END IF;
    IF prev IS NOT NULL AND c.prev_hash <> prev AND nb < 100 THEN
      brk := brk || jsonb_build_object('seq', c.seq, 'kind', 'previous_hash_mismatch', 'row_id', c.row_id, 'expected_hash', prev, 'found_hash', c.prev_hash); nb := nb + 1;
    END IF;
    calc := NULL;
    IF p_log = 'audit' THEN
      SELECT * INTO ar FROM public.audit_log WHERE id = c.row_id;
      IF FOUND THEN calc := public.log_chain_hash(c.prev_hash, public.audit_log_canonical(ar)); END IF;
    ELSE
      SELECT * INTO sr FROM public.security_log WHERE id = c.row_id;
      IF FOUND THEN calc := public.log_chain_hash(c.prev_hash, public.security_log_canonical(sr)); END IF;
    END IF;
    IF calc IS NULL AND nb < 100 THEN
      brk := brk || jsonb_build_object('seq', c.seq, 'kind', 'row_missing', 'row_id', c.row_id, 'expected_hash', c.hash, 'found_hash', NULL); nb := nb + 1;
    ELSIF calc <> c.hash AND nb < 100 THEN
      brk := brk || jsonb_build_object('seq', c.seq, 'kind', 'hash_mismatch', 'row_id', c.row_id, 'expected_hash', c.hash, 'found_hash', calc); nb := nb + 1;
    END IF;
    prev := c.hash;
    head := c.hash;
    expected := c.seq + 1;
  END LOOP;
  IF p_from IS NULL AND p_to IS NULL THEN
    FOR u IN
      SELECT a.id FROM public.audit_log a WHERE p_log = 'audit' AND NOT EXISTS (SELECT 1 FROM public.audit_log_chain x WHERE x.audit_id = a.id)
      UNION ALL
      SELECT s.id FROM public.security_log s WHERE p_log = 'security' AND NOT EXISTS (SELECT 1 FROM public.security_log_chain x WHERE x.security_id = s.id)
      ORDER BY 1 LIMIT 100
    LOOP
      IF nb < 100 THEN brk := brk || jsonb_build_object('seq', NULL, 'kind', 'unsealed', 'row_id', u.id, 'expected_hash', NULL, 'found_hash', NULL); nb := nb + 1; END IF;
    END LOOP;
  END IF;
  res := jsonb_build_object('log', p_log, 'status', CASE WHEN nb = 0 THEN 'ok' ELSE 'broken' END, 'row_count', cnt, 'first_seq', first_s, 'last_seq', last_s,
    'head_hash', head, 'checked_at', public.log_ts_text(clock_timestamp()), 'purged_through', h.purged_through, 'breaks', brk);
  PERFORM public.log_audit_write(CASE p_log WHEN 'audit' THEN 'audit_log.integrity_check' ELSE 'security_log.integrity_check' END,
    CASE p_log WHEN 'audit' THEN 'audit_log' ELSE 'security_log' END, NULL, NULL,
    jsonb_build_object('status', res ->> 'status', 'row_count', cnt, 'first_seq', first_s, 'last_seq', last_s, 'head_hash', head, 'break_count', nb,
      'from_seq', p_from, 'to_seq', p_to), NULL);
  IF nb > 0 THEN
    PERFORM public.sec_alert_raise('audit_integrity_failure', 'critical', 'Log integrity check found a break', jsonb_build_object('log', p_log, 'breaks', brk -> 0, 'break_count', nb),
      'audit_integrity_failure:' || p_log || ':' || coalesce(brk -> 0 ->> 'seq', brk -> 0 ->> 'row_id', '') || ':' || coalesce(brk -> 0 ->> 'kind', ''), NULL, NULL);
  END IF;
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 12. Settings: retention (minimum 90 / 365 days; reducing needs a reason, step-up and raises the mandatory alert) and alert thresholds
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_retention_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('system_log_days', coalesce((v ->> 'system_log_days')::int, 365), 'security_log_days', coalesce((v ->> 'security_log_days')::int, 730),
    'audit_log_years', 10, 'version', coalesce((v ->> 'version')::int, 1), 'updated_at', s.updated_at, 'updated_by', s.updated_by)
  FROM (SELECT coalesce((SELECT value FROM public.settings WHERE key = 'logs.retention'), '{}'::jsonb) AS v) x
  LEFT JOIN public.settings s ON s.key = 'logs.retention'
$$;

CREATE OR REPLACE FUNCTION log_set_retention(p_system integer, p_security integer, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; reduced boolean; nv int; aid bigint;
BEGIN
  IF NOT public.app_actor_is_admin('admin.settings', 'edit') THEN RAISE EXCEPTION 'retention: admin.settings edit required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN errs := errs || jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason is required.'); END IF;
  IF p_system IS NULL OR p_system < 90 OR p_system > 3650 THEN errs := errs || jsonb_build_object('path', '/system_log_days', 'code', 'out_of_range', 'message', 'From 90 to 3650 days.'); END IF;
  IF p_security IS NULL OR p_security < 365 OR p_security > 3650 THEN errs := errs || jsonb_build_object('path', '/security_log_days', 'code', 'out_of_range', 'message', 'From 365 to 3650 days.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  PERFORM 1 FROM public.settings WHERE key = 'logs.retention' FOR UPDATE;
  cur := public.log_retention_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::int THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The retention changed since you read it.')); END IF;
  reduced := p_system < (cur ->> 'system_log_days')::int OR p_security < (cur ->> 'security_log_days')::int;
  IF reduced AND NOT public.log_actor_stepped_up() THEN PERFORM public.wf_err('step_up_required', '{}'::jsonb); END IF;
  nv := (cur ->> 'version')::int + 1;
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('logs.retention', jsonb_build_object('system_log_days', p_system, 'security_log_days', p_security, 'version', nv), 'Log retention', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  aid := public.log_audit_write(CASE WHEN reduced THEN 'log_retention_reduced' ELSE 'log_retention_set' END, 'setting', 'logs.retention',
    jsonb_build_object('system_log_days', (cur ->> 'system_log_days')::int, 'security_log_days', (cur ->> 'security_log_days')::int, 'version', (cur ->> 'version')::int),
    jsonb_build_object('system_log_days', p_system, 'security_log_days', p_security, 'version', nv), p_reason);
  IF reduced THEN
    PERFORM public.sec_alert_raise('retention_reduced', 'critical', 'Log retention was reduced',
      jsonb_build_object('audit_id', aid, 'before', cur - 'updated_at' - 'updated_by', 'after', jsonb_build_object('system_log_days', p_system, 'security_log_days', p_security), 'reason', p_reason),
      'retention_reduced:' || aid::text, public.app_actor(), public.log_ctx_inet('ip'));
  END IF;
  RETURN public.log_retention_json();
END $$;

CREATE OR REPLACE FUNCTION log_alert_settings_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'failed_sign_ins', coalesce(v -> 'failed_sign_ins', '{"count": 5, "minutes": 15}'::jsonb),
    'failed_by_ip', coalesce(v -> 'failed_by_ip', '{"count": 20, "minutes": 15}'::jsonb),
    'large_export_rows', coalesce((v ->> 'large_export_rows')::int, 5000),
    'new_ip', coalesce((v ->> 'new_ip')::boolean, true),
    'version', coalesce((v ->> 'version')::int, 1), 'updated_at', s.updated_at, 'updated_by', s.updated_by)
  FROM (SELECT coalesce((SELECT value FROM public.settings WHERE key = 'security_alerts'), '{}'::jsonb) AS v) x
  LEFT JOIN public.settings s ON s.key = 'security_alerts'
$$;

CREATE OR REPLACE FUNCTION log_set_alert_settings(p jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cur jsonb; errs jsonb := '[]'::jsonb; nv int; fc int; fm int; ic int; im int; big int;
BEGIN
  IF NOT public.app_actor_is_admin('admin.settings', 'edit') THEN RAISE EXCEPTION 'alert settings: admin.settings edit required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN errs := errs || jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason is required.'); END IF;
  fc := public.log_num(p -> 'failed_sign_ins', 'count'); fm := public.log_num(p -> 'failed_sign_ins', 'minutes');
  ic := public.log_num(p -> 'failed_by_ip', 'count'); im := public.log_num(p -> 'failed_by_ip', 'minutes'); big := public.log_num(p, 'large_export_rows');
  IF fc IS NULL OR fc < 3 OR fc > 100 THEN errs := errs || jsonb_build_object('path', '/failed_sign_ins/count', 'code', 'out_of_range', 'message', 'From 3 to 100.'); END IF;
  IF fm IS NULL OR fm < 1 OR fm > 1440 THEN errs := errs || jsonb_build_object('path', '/failed_sign_ins/minutes', 'code', 'out_of_range', 'message', 'From 1 to 1440 minutes.'); END IF;
  IF ic IS NULL OR ic < 5 OR ic > 1000 THEN errs := errs || jsonb_build_object('path', '/failed_by_ip/count', 'code', 'out_of_range', 'message', 'From 5 to 1000.'); END IF;
  IF im IS NULL OR im < 1 OR im > 1440 THEN errs := errs || jsonb_build_object('path', '/failed_by_ip/minutes', 'code', 'out_of_range', 'message', 'From 1 to 1440 minutes.'); END IF;
  IF big IS NULL OR big < 100 OR big > 1000000 THEN errs := errs || jsonb_build_object('path', '/large_export_rows', 'code', 'out_of_range', 'message', 'From 100 to 1000000 rows.'); END IF;
  IF jsonb_typeof(p -> 'new_ip') IS DISTINCT FROM 'boolean' THEN errs := errs || jsonb_build_object('path', '/new_ip', 'code', 'invalid', 'message', 'true or false.'); END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  PERFORM 1 FROM public.settings WHERE key = 'security_alerts' FOR UPDATE;
  cur := public.log_alert_settings_json();
  IF p_version IS NOT NULL AND p_version <> (cur ->> 'version')::int THEN PERFORM public.wf_err('precondition_failed', jsonb_build_object('detail', 'The settings changed since you read them.')); END IF;
  nv := (cur ->> 'version')::int + 1;
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('security_alerts', jsonb_build_object('failed_sign_ins', jsonb_build_object('count', fc, 'minutes', fm), 'failed_by_ip', jsonb_build_object('count', ic, 'minutes', im),
    'large_export_rows', big, 'new_ip', (p ->> 'new_ip')::boolean, 'version', nv), 'Security alert thresholds', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM public.log_audit_write('security_alert_settings_set', 'setting', 'security_alerts', cur - 'updated_at' - 'updated_by',
    public.log_alert_settings_json() - 'updated_at' - 'updated_by', p_reason);
  RETURN public.log_alert_settings_json();
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 13. Retention purge (job). The Audit Log and the field changes are never purged.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_purge_system_log() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE days int := greatest(coalesce((public.log_setting('logs.retention', '{}'::jsonb) ->> 'system_log_days')::int, 365), 90); n bigint;
BEGIN
  PERFORM set_config('pmis.log_purge', 'system_log', true);
  DELETE FROM public.system_log WHERE at < now() - make_interval(days => days);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('pmis.log_purge', '', true);
  RETURN n;
END $$;

-- Deletes a prefix of the security chain: every row of the prefix is older than the retention. The chain entries stay, so the remaining rows
-- still verify from the anchor (log_chain_heads.purged_through).
CREATE OR REPLACE FUNCTION log_purge_security_log() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE days int := greatest(coalesce((public.log_setting('logs.retention', '{}'::jsonb) ->> 'security_log_days')::int, 730), 365); upto bigint; n bigint := 0; h bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pmis.log_chain.security'));
  SELECT seq, purged_through INTO h, upto FROM public.log_chain_heads WHERE log = 'security' FOR UPDATE;
  SELECT coalesce(min(c.seq) - 1, h) INTO upto FROM public.security_log_chain c JOIN public.security_log s ON s.id = c.security_id
  WHERE c.seq > (SELECT purged_through FROM public.log_chain_heads WHERE log = 'security') AND s.at >= now() - make_interval(days => days);
  IF upto <= (SELECT purged_through FROM public.log_chain_heads WHERE log = 'security') THEN RETURN 0; END IF;
  PERFORM set_config('pmis.log_purge', 'security_log', true);
  DELETE FROM public.security_log s USING public.security_log_chain c WHERE c.security_id = s.id AND c.seq <= upto;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('pmis.log_purge', '', true);
  UPDATE public.log_chain_heads SET purged_through = upto, updated_at = clock_timestamp() WHERE log = 'security';
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 14. Readers of job runs and deployments (System Admin or view on admin.system_log), monthly activity report
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_can_read_ops() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor();
BEGIN
  RETURN a IS NOT NULL AND (public.app_user_is_system_admin(a) OR public.app_has_permission(a, 'admin.system_log', 'view'::"PermissionAction"));
END $$;

CREATE OR REPLACE FUNCTION log_job_runs_read(p jsonb, p_limit integer) RETURNS SETOF job_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.log_can_read_ops() THEN RAISE EXCEPTION 'job runs: System Admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY SELECT j.* FROM public.job_runs j
  WHERE (p ->> 'name' IS NULL OR j.name = p ->> 'name') AND (p ->> 'outcome' IS NULL OR j.outcome = p ->> 'outcome')
    AND (p ->> 'from' IS NULL OR j.started_at >= (p ->> 'from')::timestamptz) AND (p ->> 'to' IS NULL OR j.started_at < (p ->> 'to')::timestamptz)
    AND (p ->> 'cursor_at' IS NULL OR (j.started_at, j.id) < ((p ->> 'cursor_at')::timestamptz, (p ->> 'cursor_id')::uuid))
  ORDER BY j.started_at DESC, j.id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END $$;

CREATE OR REPLACE FUNCTION log_deployments_read(p_cursor bigint, p_limit integer) RETURNS SETOF deployments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.log_can_read_ops() THEN RAISE EXCEPTION 'deployments: System Admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY SELECT d.* FROM public.deployments d WHERE p_cursor IS NULL OR d.id < p_cursor ORDER BY d.id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END $$;

-- Per-user counts of one month (Africa/Tripoli calendar month) within the caller's Audit Log scope, plus the sensitive changes. Needs the reports
-- grant (reports view) and the Audit Log reader rules (B4). Sign-ins and failures come from the security log and are shown only to a reader who
-- may read the security log too (otherwise null).
CREATE OR REPLACE FUNCTION log_activity_report(p_month date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a uuid := public.app_actor(); sc jsonb; isfull boolean; t0 timestamptz; t1 timestamptz; sec boolean; users jsonb; sens jsonb;
  tz text := coalesce(public.log_setting('calc.timezone', '"Africa/Tripoli"'::jsonb) #>> '{}', 'Africa/Tripoli');
BEGIN
  IF a IS NULL OR NOT public.app_has_permission(a, 'reports', 'view'::"PermissionAction") THEN
    RAISE EXCEPTION 'activity report: reports view required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  sc := public.log_audit_scope_json();
  IF jsonb_array_length(sc) = 0 THEN RAISE EXCEPTION 'activity report: no Audit Log reader right' USING ERRCODE = 'insufficient_privilege'; END IF;
  isfull := EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'm' IS NULL AND s ->> 'r' IS NULL);
  sec := public.sec_can_read();
  t0 := (date_trunc('month', p_month)::timestamp) AT TIME ZONE tz;
  t1 := ((date_trunc('month', p_month) + interval '1 month')::timestamp) AT TIME ZONE tz;
  PERFORM public.log_audit_write('report.activity_read', 'report', to_char(p_month, 'YYYY-MM'), NULL, jsonb_build_object('month', to_char(p_month, 'YYYY-MM')), NULL);
  WITH vis AS (
    SELECT al.* FROM public.audit_log al WHERE al.at >= t0 AND al.at < t1 AND al.actor_id IS NOT NULL
      AND (isfull OR (al.module_key IS NOT NULL AND public.log_in_scope(sc, al.module_key, al.region_id) AND (al.region_id IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'r' IS NULL))))
      AND al.action NOT IN ('audit_log.read', 'audit_log.field_changes_read', 'security_log.read', 'report.activity_read')
  ), fc AS (
    SELECT c.actor_id, count(*) AS n FROM public.audit_field_changes c WHERE c.at >= t0 AND c.at < t1 AND c.actor_id IS NOT NULL
      AND (isfull OR (c.module_key IS NOT NULL AND public.log_in_scope(sc, c.module_key, c.region_id) AND (c.region_id IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'r' IS NULL))))
    GROUP BY 1
  ), act AS (
    SELECT v.actor_id, count(*) AS actions, count(*) FILTER (WHERE v.action ~ 'approve') AS approvals FROM vis v GROUP BY 1
  ), si AS (
    SELECT s.user_id, count(*) FILTER (WHERE s.event = 'sign_in_succeeded') AS ok, count(*) FILTER (WHERE s.outcome = 'failure') AS bad
    FROM public.security_log s WHERE sec AND s.at >= t0 AND s.at < t1 AND s.user_id IS NOT NULL GROUP BY 1
  ), ids AS (SELECT actor_id AS id FROM act UNION SELECT actor_id FROM fc UNION SELECT user_id FROM si)
  SELECT coalesce(jsonb_agg(jsonb_build_object('user', jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', nullif(trim(u.employee_id), '')),
           'actions', coalesce(act.actions, 0), 'field_changes', coalesce(fc.n, 0), 'approvals', coalesce(act.approvals, 0),
           'sign_ins', CASE WHEN sec THEN coalesce(si.ok, 0) END, 'failures', CASE WHEN sec THEN coalesce(si.bad, 0) END)
         ORDER BY coalesce(act.actions, 0) DESC, u.display_name, u.id), '[]'::jsonb)
  INTO users
  FROM ids JOIN public.users u ON u.id = ids.id LEFT JOIN act ON act.actor_id = ids.id LEFT JOIN fc ON fc.actor_id = ids.id LEFT JOIN si ON si.user_id = ids.id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', al.id, 'at', al.at, 'action', al.action, 'entity_type', al.entity_type, 'entity_id', al.entity_id,
           'actor_id', al.actor_id, 'reason', al.reason, 'is_admin_override', al.is_admin_override,
           'kind', CASE WHEN al.is_admin_override THEN 'override' WHEN al.entity_type IN ('role', 'user_role_assignment', 'group', 'delegation', 'permission_profile') THEN 'roles'
                        WHEN al.entity_type IN ('matrix', 'matrix_cell') THEN 'matrix' WHEN al.entity_type = 'setting' OR al.action LIKE '%setting%' OR al.action LIKE 'log_retention%' THEN 'settings'
                        ELSE 'other' END) ORDER BY al.at, al.id), '[]'::jsonb)
  INTO sens
  FROM (SELECT * FROM public.audit_log x WHERE x.at >= t0 AND x.at < t1 AND public.log_is_privileged(x.action, x.entity_type, x.is_admin_override)
          AND (isfull OR (x.module_key IS NOT NULL AND public.log_in_scope(sc, x.module_key, x.region_id) AND (x.region_id IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(sc) s WHERE s ->> 'r' IS NULL))))
        ORDER BY x.at, x.id LIMIT 2000) al;

  RETURN jsonb_build_object('month', to_char(p_month, 'YYYY-MM'), 'from', t0, 'to', t1, 'scope', CASE WHEN isfull THEN 'all' ELSE 'limited' END,
    'includes_security_log', sec, 'users', users, 'sensitive_changes', sens);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 15. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON audit_log, audit_field_changes, audit_log_chain, job_runs, deployments, security_alerts, security_alert_state TO pmis_definer;
GRANT SELECT, INSERT, DELETE ON system_log TO pmis_definer;
GRANT UPDATE ON job_runs, security_alerts, security_alert_state TO pmis_definer;
GRANT SELECT, UPDATE ON log_chain_heads TO pmis_definer, pmis_identity_owner;
GRANT SELECT ON security_log, security_log_chain TO pmis_definer;
GRANT SELECT, INSERT, DELETE ON security_log TO pmis_identity_owner;
GRANT SELECT, INSERT ON security_log_chain TO pmis_identity_owner;
GRANT SELECT ON user_sessions, user_recovery_codes, settings, users TO pmis_identity_owner;
GRANT SELECT ON settings, register_records, register_definitions, register_fields, field_definitions, import_batch_rows, users, groups, group_members,
  roles, user_role_assignments, user_role_assignment_regions, user_role_assignment_modules, user_role_assignment_profiles, permission_profiles,
  permission_grants, delegations, delegation_grants, delegation_regions, user_sessions TO pmis_definer;
GRANT INSERT ON notifications TO pmis_definer;
GRANT INSERT, UPDATE ON settings TO pmis_definer;  -- logs.retention and security_alerts, through log_set_retention / log_set_alert_settings only
GRANT USAGE, SELECT ON SEQUENCE audit_field_changes_id_seq, deployments_id_seq, system_log_id_seq, audit_log_id_seq TO pmis_definer;
GRANT USAGE, SELECT ON SEQUENCE security_log_id_seq TO pmis_identity_owner;

DO $$
DECLARE f text;
BEGIN
  -- Definer functions owned by pmis_definer (the Audit Log side, alerts, jobs, settings, readers).
  FOREACH f IN ARRAY ARRAY[
    'log_setting(text,jsonb)', 'log_actor_stepped_up()', 'log_audit_module(text,text,jsonb,jsonb)', 'audit_log_fill()', 'audit_log_field_diff()',
    'audit_log_seal()', 'log_audit_write(text,text,text,jsonb,jsonb,text,uuid,integer,uuid)', 'log_system_write(text,text,text,jsonb,uuid,text)',
    'job_run_start(text,text)', 'job_run_finish(uuid,text,bigint,text,jsonb)', 'log_deployment(text,text,text[],text,text)',
    'log_audit_scope_json()', 'log_audit_read(jsonb,integer)', 'log_field_changes_read(jsonb,integer)', 'log_audit_chain_seq(bigint)',
    'sec_alert_raise(text,text,text,jsonb,text,uuid,text)', 'sec_alerts_evaluate()', 'sec_alerts_read(jsonb,integer)', 'sec_alerts_count(jsonb)', 'sec_alert_ack(uuid,text)',
    'log_verify_chain(text,bigint,bigint)', 'log_retention_json()', 'log_set_retention(integer,integer,text,integer)',
    'log_alert_settings_json()', 'log_set_alert_settings(jsonb,text,integer)', 'log_purge_system_log()', 'log_can_read_ops()',
    'log_job_runs_read(jsonb,integer)', 'log_deployments_read(bigint,integer)', 'log_activity_report(date)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  -- The security log side, owned by pmis_identity_owner.
  FOREACH f IN ARRAY ARRAY[
    'sec_log_write(text,text,uuid,text,jsonb,jsonb)', 'sec_log_session_change()', 'sec_log_credential_change()', 'sec_log_totp_change()',
    'sec_log_recovery_change()', 'sec_log_session_expired(uuid)', 'security_log_seal()', 'log_purge_security_log()',
    'log_audit_scope(uuid)', 'sec_can_read()', 'sec_log_read(jsonb,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_identity_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_identity_owner, pmis_definer', f);
  END LOOP;
  -- Shared helpers the security-log side calls.
  GRANT EXECUTE ON FUNCTION log_setting(text,jsonb), log_audit_write(text,text,text,jsonb,jsonb,text,uuid,integer,uuid) TO pmis_identity_owner;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE ALL ON audit_field_changes, audit_log_chain, security_log, security_log_chain, log_chain_heads, job_runs, deployments,
      security_alerts, security_alert_state FROM pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_log, system_log FROM pmis_app;
    FOREACH f IN ARRAY ARRAY[
      'log_audit_write(text,text,text,jsonb,jsonb,text,uuid,integer,uuid)', 'log_system_write(text,text,text,jsonb,uuid,text)',
      'job_run_start(text,text)', 'job_run_finish(uuid,text,bigint,text,jsonb)', 'log_audit_read(jsonb,integer)', 'log_field_changes_read(jsonb,integer)', 'log_audit_chain_seq(bigint)',
      'log_audit_scope_json()', 'sec_alerts_evaluate()', 'sec_alerts_read(jsonb,integer)', 'sec_alerts_count(jsonb)', 'sec_alert_ack(uuid,text)', 'log_verify_chain(text,bigint,bigint)',
      'log_retention_json()', 'log_set_retention(integer,integer,text,integer)', 'log_alert_settings_json()', 'log_set_alert_settings(jsonb,text,integer)',
      'log_purge_system_log()', 'log_can_read_ops()', 'log_job_runs_read(jsonb,integer)', 'log_deployments_read(bigint,integer)', 'log_activity_report(date)',
      'sec_log_write(text,text,uuid,text,jsonb,jsonb)', 'sec_log_session_expired(uuid)', 'log_purge_security_log()', 'sec_can_read()', 'sec_log_read(jsonb,integer)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
