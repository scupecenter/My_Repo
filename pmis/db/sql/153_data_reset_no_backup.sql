-- 0154_data_reset_no_backup: the backup precondition of the Settings data reset becomes a choice of each request (owner decision 2026-11-25; contract 0.15.72,
-- CHANGELOG 209). Mirror: db/sql/153_data_reset_no_backup.sql (kept byte-identical). The contract of the reset is docs/ops/data-reset.md.
--
-- Owner decision 2026-11-25: "I need an option to choose if I need to take a backup or not; if I do not need a backup I can clean and reset the data."
--
--   1. The choice. data_reset_requests.require_backup (boolean, NOT NULL, default true). The requesting System Admin chooses "Require a recent backup"
--      (true, the default and the behaviour before 0154) or "Run without a backup" (false). False needs the extra typed phrase NO BACKUP (422
--      confirmation_mismatch at /no_backup_confirm otherwise); the reason of the request (10 characters or more, as before) is the reason of the choice.
--      Every request open when this migration runs keeps require_backup = true (the column default).
--   2. The binding. The choice is part of what the approver approves: the request's scope_hash is data_reset_request_hash(closure, require_backup), which is
--      the 0152 hash of the closure when a backup is required (so a request made before 0154 and every request that requires a backup keep their hash) and a
--      different, domain-separated SHA-256 when it is not. data_reset_check_scope (approve, start, execute) recomputes it from the stored parts and the
--      stored choice: an approver who saw the other choice, or a request whose choice would differ, is refused with 409 scope_changed. The choice never
--      changes after the request (the row guard, also for the superuser); pmis_app has no right on the table (app_grants.sql).
--   3. The run. admin_data_reset_start skips ONLY the backup check when require_backup is false; the two admins, the step-up, the typed phrase, the expiry,
--      "not running", the scope hash, the maintenance mode and the coverage check of the plan stay. The choice is written into the audit rows of the request,
--      the approval, the start and the reset itself (data_reset_core's detail), into the result and into the security log row of the completion.
--   4. data_reset_core, data_reset_plan and the operator script are unchanged (the script keeps --yes-i-have-a-backup and its own pg_dump).
--
-- Every door is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp; owners as in 0152 (pmis_definer for the doors and their helpers,
-- pmis_reset_owner for the pure hash), PUBLIC revoked, the grants re-applied. No new table. Each function is redefined from its latest definition (0152).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE data_reset_requests ADD COLUMN require_backup boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The hash an approval binds to: the closure and the backup choice
-- ---------------------------------------------------------------------------------------------------------------------
-- With a backup required it is the 0152 hash of the closure (data_reset_scope_hash), so nothing made before 0154 changes; without, its own domain.
CREATE OR REPLACE FUNCTION data_reset_request_hash(p_closure text[], p_require_backup boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_require_backup IS NOT FALSE THEN public.data_reset_scope_hash(p_closure)
    ELSE encode(sha256(convert_to('pmis-data-reset-scope:2:no-backup:' || array_to_string(ARRAY(SELECT x FROM unnest(p_closure) x ORDER BY x), ','), 'UTF8')), 'hex') END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The row guard (latest 0152): the backup choice never changes either
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION data_reset_rows_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END IF;
  -- one table per branch: PL/pgSQL resolves the fields of OLD and NEW only in the branch it runs
  IF TG_TABLE_NAME = 'data_reset_request_files' THEN
    IF OLD.outcome <> 'pending' OR NEW.request_id <> OLD.request_id OR NEW.storage_key <> OLD.storage_key THEN
      RAISE EXCEPTION 'a decided file outcome of a data reset never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at OR NEW.request_reason <> OLD.request_reason
       OR NEW.database_name <> OLD.database_name OR OLD.status IN ('completed', 'failed', 'cancelled', 'expired')
       OR NEW.requested_parts IS DISTINCT FROM OLD.requested_parts OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.scope_hash IS DISTINCT FROM OLD.scope_hash
       OR NEW.require_backup IS DISTINCT FROM OLD.require_backup
       OR (OLD.approved_scope_hash IS NOT NULL AND NEW.approved_scope_hash IS DISTINCT FROM OLD.approved_scope_hash) THEN
      RAISE EXCEPTION 'a closed data reset request, or who, why, for which scope and with which backup choice it was requested, never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The doors (redefined from 0152 where the backup choice enters; the others are unchanged)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION data_reset_req_json(r public.data_reset_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'version', r.version, 'database_name', r.database_name,
    'requested_by', public.data_reset_user_json(r.requested_by), 'requested_at', r.requested_at, 'request_reason', r.request_reason,
    'expires_at', r.expires_at, 'expired', r.status IN ('requested', 'approved') AND r.expires_at <= clock_timestamp(),
    'approved_by', public.data_reset_user_json(r.approved_by), 'approved_at', r.approved_at, 'approve_reason', r.approve_reason,
    'cancelled_by', public.data_reset_user_json(r.cancelled_by), 'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
    'run_by', public.data_reset_user_json(r.run_by), 'run_started_at', r.run_started_at, 'db_committed_at', r.db_committed_at, 'finished_at', r.finished_at,
    'stalled', public.data_reset_stalled(r),
    -- before 0152 a request had no scope: it was everything as it was then
    'scope', coalesce(r.scope, jsonb_build_object('version', 0, 'legacy', true, 'everything', true)), 'scope_hash', r.scope_hash,
    'approved_scope_hash', r.approved_scope_hash,
    -- 0154: the backup choice of the request (true: the run needs a recent successful backup)
    'require_backup', r.require_backup,
    'backup', r.backup, 'plan_at_request', r.plan_at_request, 'result', r.result, 'quarantine_dir', r.quarantine_dir, 'error', r.error,
    'files', jsonb_build_object(
      'total', coalesce(r.files_total, 0),
      'moved', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'moved'),
      'missing', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'missing'),
      'refused', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'refused'),
      'pending', (SELECT count(*) FROM public.data_reset_request_files f WHERE f.request_id = r.id AND f.outcome = 'pending'),
      'problems', (SELECT coalesce(jsonb_agg(jsonb_build_object('storage_key', x.storage_key, 'outcome', x.outcome, 'detail', x.detail) ORDER BY x.storage_key), '[]'::jsonb)
                   FROM (SELECT f.storage_key, f.outcome, f.detail FROM public.data_reset_request_files f
                         WHERE f.request_id = r.id AND f.outcome IN ('missing', 'refused') ORDER BY f.storage_key LIMIT 200) x)))
$$;

-- The screen (latest 0152): also the phrase that confirms a request without a backup.
CREATE OR REPLACE FUNCTION data_reset_state_json() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; plan jsonb; open_r public.data_reset_requests; last_r public.data_reset_requests; admins integer; me uuid;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(false);
  me := who.actor;
  PERFORM public.data_reset_expire();
  plan := public.data_reset_plan_json(NULL);
  SELECT * INTO open_r FROM public.data_reset_requests WHERE status IN ('requested', 'approved', 'running', 'files_pending') ORDER BY requested_at DESC LIMIT 1;
  SELECT * INTO last_r FROM public.data_reset_requests WHERE status NOT IN ('requested', 'approved', 'running', 'files_pending') ORDER BY requested_at DESC LIMIT 1;
  admins := public.data_reset_admin_count();
  RETURN jsonb_build_object(
    'database', current_database(),
    'confirmation_phrase', 'RESET ' || current_database(),
    'no_backup_phrase', 'NO BACKUP',
    'settings', public.data_reset_cfg(),
    'system_admins_active', admins,
    'single_admin', admins < 2,
    'script_running', public.data_reset_lock_held(),
    'maintenance', public.data_reset_maintenance(),
    'backup', public.data_reset_backup(),
    'plan', plan,
    'everything', to_jsonb(public.data_reset_project_parts()),
    'request', CASE WHEN open_r.id IS NULL THEN NULL ELSE public.data_reset_req_json(open_r) END,
    'last_request', CASE WHEN last_r.id IS NULL THEN NULL ELSE public.data_reset_req_json(last_r) END,
    'can', jsonb_build_object(
      'request', open_r.id IS NULL AND admins >= 2,
      'approve', coalesce(open_r.status = 'requested' AND open_r.requested_by <> me AND open_r.expires_at > clock_timestamp(), false),
      'start', coalesce(open_r.status = 'approved' AND me IN (open_r.requested_by, open_r.approved_by) AND open_r.expires_at > clock_timestamp(), false),
      'cancel', coalesce(open_r.status IN ('requested', 'approved') OR public.data_reset_stalled(open_r), false),
      'retry_files', coalesce(open_r.status = 'files_pending' AND NOT public.data_reset_lock_held(), false)));
END $$;

-- 1. Request (latest 0152): as before, and the backup choice. p_require_backup NULL or true: the run needs a recent backup (as before 0154). False: the
-- typed phrase NO BACKUP in p_no_backup_confirm; the reason of the request is the reason of the choice. The hash binds the scope and the choice.
DROP FUNCTION IF EXISTS admin_data_reset_request(text, text, text[]);
CREATE FUNCTION admin_data_reset_request(p_reason text, p_confirm text, p_parts text[] DEFAULT NULL, p_require_backup boolean DEFAULT true,
                                         p_no_backup_confirm text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; r public.data_reset_requests; plan jsonb; parts text[]; sj jsonb; labels text; need boolean := coalesce(p_require_backup, true);
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  why := public.data_reset_require_reason(p_reason, 10);
  PERFORM public.data_reset_require_phrase(p_confirm);
  IF NOT need AND p_no_backup_confirm IS DISTINCT FROM 'NO BACKUP' THEN
    PERFORM public.data_reset_err(422, 'confirmation_mismatch', 'Type NO BACKUP to request the reset without a backup.',
      jsonb_build_object('errors', public.reg_err_item('/no_backup_confirm', 'confirmation_mismatch', 'Type NO BACKUP.'), 'confirmation_phrase', 'NO BACKUP'));
  END IF;
  parts := public.data_reset_require_parts(p_parts);
  IF public.data_reset_admin_count() < 2 THEN
    PERFORM public.data_reset_err(409, 'single_admin', 'A second active System Admin must approve the reset. With one System Admin, the reset is done on the server with the operator script (infra/scripts/reset-project-data.sh).');
  END IF;
  IF public.data_reset_lock_held() THEN PERFORM public.data_reset_err(409, 'reset_running', 'A reset is running.'); END IF;
  PERFORM public.data_reset_expire();
  IF EXISTS (SELECT 1 FROM public.data_reset_requests WHERE status IN ('requested', 'approved', 'running', 'files_pending')) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'Another data reset request is open. Cancel it or let it finish first.');
  END IF;
  sj := public.data_reset_scope_json(parts);
  plan := public.data_reset_plan_json(parts);
  INSERT INTO public.data_reset_requests (database_name, requested_by, requested_session, request_reason, expires_at, plan_at_request,
                                          requested_parts, scope, scope_hash, require_backup)
  VALUES (current_database(), who.actor, who.sid, why,
          clock_timestamp() + make_interval(mins => (public.data_reset_cfg() ->> 'request_expiry_minutes')::integer),
          jsonb_build_object('delete_rows', (plan ->> 'delete_rows')::bigint, 'files', (plan ->> 'files')::bigint,
                             'accounts_to_deactivate', (plan ->> 'accounts_to_deactivate')::bigint,
                             'sites', (SELECT (e ->> 'delete')::bigint FROM jsonb_array_elements(plan -> 'tables') e WHERE e ->> 'table' = 'sites'),
                             'parts', (SELECT coalesce(jsonb_object_agg(e ->> 'code', (e ->> 'rows')::bigint), '{}'::jsonb) FROM jsonb_array_elements(plan -> 'parts') e
                                       WHERE (e ->> 'selected')::boolean)),
          ARRAY(SELECT x FROM jsonb_array_elements_text(sj -> 'requested') x), sj,
          public.data_reset_request_hash(ARRAY(SELECT x FROM jsonb_array_elements_text(sj -> 'parts') x), need), need)
  RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_request', r.id, NULL,
    jsonb_build_object('status', r.status, 'expires_at', r.expires_at, 'plan', r.plan_at_request, 'database', r.database_name, 'scope', r.scope,
                       'scope_hash', r.scope_hash, 'require_backup', r.require_backup), why);
  SELECT string_agg(p.label_en, '; ' ORDER BY p.ord) INTO labels FROM public.data_reset_parts() p WHERE p.code IN (SELECT jsonb_array_elements_text(sj -> 'parts'));
  -- every other active System Admin is told in-app (the inbox is project data: the reset itself may empty it)
  INSERT INTO public.notifications (user_id, kind, title, body, link)
  SELECT DISTINCT gm.user_id, 'data_reset_request', 'A project data reset waits for your approval',
         format('%s asked to reset %s of %s%s. Reason: %s', (SELECT u.display_name FROM public.users u WHERE u.id = who.actor),
                CASE WHEN (sj ->> 'everything')::boolean AND jsonb_array_length(sj -> 'identity') = 0 THEN 'the project data' ELSE left(labels, 400) END,
                current_database(), CASE WHEN need THEN '' ELSE ' WITHOUT a backup (the deleted data cannot be restored)' END, left(why, 300)),
         '/admin/settings/data/reset'
  FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id AND g.is_system_admins AND g.is_active
  JOIN public.users u ON u.id = gm.user_id AND u.status = 'active' AND u.deleted_at IS NULL
  WHERE gm.user_id <> who.actor;
  RETURN public.data_reset_req_json(r);
END $$;

-- The scope of a request (latest 0152) is still the one it was made for, with its backup choice: the closure of its requested parts is the stored one, the
-- stored scope's own hash is the hash of that closure, and the request's hash is the hash of the closure and the choice. Otherwise 409 scope_changed.
CREATE OR REPLACE FUNCTION data_reset_check_scope(r public.data_reset_requests, p_seen_hash text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c text[];
BEGIN
  IF r.scope_hash IS NULL THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'The request was made before the reset had a scope. Cancel it and make a new request.');
  END IF;
  c := public.data_reset_closure(r.requested_parts);
  IF public.data_reset_request_hash(c, r.require_backup) <> r.scope_hash OR to_jsonb(c) <> (r.scope -> 'parts')
     OR (r.scope ->> 'hash') IS DISTINCT FROM public.data_reset_scope_hash(c) THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'What the requested parts take along, or the backup choice, changed since the request (a newer version of the reset). Cancel it and make a new request.');
  END IF;
  IF p_seen_hash IS NOT NULL AND p_seen_hash <> r.scope_hash THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'The scope or the backup choice you approve is not the one of this request. Read the request again.');
  END IF;
  IF r.approved_scope_hash IS NOT NULL AND r.approved_scope_hash <> r.scope_hash THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'The approval was given for another scope. Cancel the request and make a new one.');
  END IF;
END $$;

-- 2. Approve (latest 0152): unchanged rules; the audit row carries the backup choice the approval covers.
CREATE OR REPLACE FUNCTION admin_data_reset_approve(p_id uuid, p_reason text, p_version integer, p_scope_hash text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; why text; r public.data_reset_requests;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  why := public.data_reset_require_reason(p_reason, 10);
  IF p_scope_hash IS NOT NULL AND p_scope_hash !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/scope_hash', 'invalid', 'The scope_hash of the request you read.')));
  END IF;
  PERFORM public.data_reset_expire();
  r := public.data_reset_lock_request(p_id, p_version);
  IF r.requested_by = who.actor OR r.requested_session = who.sid THEN
    PERFORM public.data_reset_err(403, 'self_approval_forbidden', 'A different System Admin must approve the reset; nobody approves their own request.');
  END IF;
  IF r.status = 'expired' THEN PERFORM public.data_reset_err(409, 'request_expired', 'The request expired. Make a new request.'); END IF;
  IF r.status <> 'requested' THEN PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s, not waiting for approval.', r.status)); END IF;
  IF NOT public.app_user_is_system_admin(r.requested_by) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'The admin who made the request is no longer an active System Admin. Cancel the request.');
  END IF;
  PERFORM public.data_reset_check_scope(r, p_scope_hash);
  UPDATE public.data_reset_requests SET status = 'approved', version = version + 1, approved_by = who.actor, approved_session = who.sid,
         approved_at = clock_timestamp(), approve_reason = why, approved_scope_hash = r.scope_hash
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_approve', r.id, jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', r.status, 'requested_by', r.requested_by, 'expires_at', r.expires_at, 'scope_hash', r.approved_scope_hash,
                       'scope', r.scope -> 'parts', 'require_backup', r.require_backup), why);
  RETURN public.data_reset_req_json(r);
END $$;

-- 4. Start (latest 0152): as before; the backup check only when the request requires a backup. Every other check stays.
CREATE OR REPLACE FUNCTION admin_data_reset_start(p_id uuid, p_confirm text, p_version integer, p_quarantine text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; r public.data_reset_requests; bk jsonb;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  PERFORM public.data_reset_require_phrase(p_confirm);
  PERFORM public.data_reset_expire();
  r := public.data_reset_lock_request(p_id, p_version);
  IF who.actor NOT IN (r.requested_by, coalesce(r.approved_by, r.requested_by)) THEN
    PERFORM public.data_reset_err(403, 'action_forbidden', 'Only the System Admin who requested the reset or the one who approved it may start it.');
  END IF;
  IF r.status = 'expired' THEN PERFORM public.data_reset_err(409, 'request_expired', 'The request expired. Make a new request.'); END IF;
  IF r.status <> 'approved' THEN PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s, not approved.', r.status)); END IF;
  IF NOT public.app_user_is_system_admin(r.requested_by) OR NOT public.app_user_is_system_admin(r.approved_by) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'The requester or the approver is no longer an active System Admin. Cancel the request.');
  END IF;
  PERFORM public.data_reset_check_scope(r, NULL);
  IF r.approved_scope_hash IS DISTINCT FROM r.scope_hash THEN
    PERFORM public.data_reset_err(409, 'scope_changed', 'The approval does not cover the scope of this request. Cancel it and make a new request.');
  END IF;
  bk := public.data_reset_backup();
  -- 0154: the only check a request without a backup skips
  IF r.require_backup AND NOT (bk ->> 'ok')::boolean THEN
    PERFORM public.data_reset_err(409, 'backup_missing', format('No successful database backup is recorded in the System Log within the last %s hours. Run a backup first (db-backup.sh full), or cancel this request and make a new one without the backup requirement.', bk ->> 'max_age_hours'),
      jsonb_build_object('backup', bk));
  END IF;
  IF public.data_reset_lock_held() THEN PERFORM public.data_reset_err(409, 'reset_running', 'A reset is running.'); END IF;
  IF p_quarantine IS NULL OR p_quarantine !~ '^/' OR char_length(p_quarantine) > 1000 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/quarantine_dir', 'invalid', 'An absolute path.')));
  END IF;
  BEGIN
    PERFORM public.data_reset_core(false, NULL, NULL, NULL, NULL, r.requested_parts, NULL);
  EXCEPTION WHEN others THEN
    PERFORM public.data_reset_err(409, 'plan_incomplete', SQLERRM);
  END;
  -- the backup the run relies on; without the requirement, the last success only when it is within the window (else none)
  UPDATE public.data_reset_requests SET status = 'running', version = version + 1, run_by = who.actor, run_session = who.sid,
         run_started_at = clock_timestamp(), backup = CASE WHEN (bk ->> 'ok')::boolean THEN bk -> 'last_success' END, quarantine_dir = p_quarantine
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.data_reset_log('data_reset_start', r.id, jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', r.status, 'backup', r.backup, 'requested_by', r.requested_by, 'approved_by', r.approved_by, 'scope_hash', r.scope_hash,
                       'require_backup', r.require_backup, 'backup_ok', (bk ->> 'ok')::boolean), r.request_reason);
  RETURN public.data_reset_req_json(r);
END $$;

-- 5. Execute (latest 0152): as before; the backup choice goes into the reset's audit row (the detail), the result and the security log. The scope that ran is
-- compared with the scope's own hash (the closure), the request's hash having been checked by data_reset_check_scope.
CREATE OR REPLACE FUNCTION admin_data_reset_execute(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; r public.data_reset_requests; res jsonb; n integer;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(false);
  r := public.data_reset_lock_request(p_id, NULL);
  IF r.status <> 'running' OR r.db_committed_at IS NOT NULL THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s: the database part runs once, after a start.', r.status));
  END IF;
  IF r.run_by <> who.actor OR r.run_session <> who.sid THEN
    PERFORM public.data_reset_err(403, 'action_forbidden', 'Only the session that started the reset runs it.');
  END IF;
  IF r.run_started_at < clock_timestamp() - interval '2 minutes' THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'The start is too old: cancel it and start again.');
  END IF;
  PERFORM public.data_reset_check_scope(r, NULL);
  res := public.data_reset_core(true, r.request_reason,
    jsonb_build_object('via', 'settings', 'request_id', r.id, 'requested_by', r.requested_by, 'approved_by', r.approved_by, 'run_by', r.run_by,
                       'approve_reason', r.approve_reason, 'backup', r.backup, 'quarantine_dir', r.quarantine_dir, 'scope_hash', r.scope_hash,
                       'require_backup', r.require_backup),
    r.run_session, r.id, r.requested_parts, ARRAY[r.requested_by, r.approved_by, r.run_by]);
  IF res -> 'scope' ->> 'hash' IS DISTINCT FROM r.scope ->> 'hash' THEN
    RAISE EXCEPTION 'reset-project-data: the scope that ran is not the approved one, nothing was reset';
  END IF;
  INSERT INTO public.data_reset_request_files (request_id, storage_key)
  SELECT r.id, k FROM jsonb_array_elements_text(res -> 'files') k;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.data_reset_requests SET
    status = CASE WHEN n = 0 THEN 'completed' ELSE 'files_pending' END, version = version + 1, db_committed_at = clock_timestamp(),
    finished_at = CASE WHEN n = 0 THEN clock_timestamp() END, files_total = n,
    result = jsonb_build_object('audit_id', res -> 'audit_id', 'sessions_ended', res -> 'sessions_ended', 'deleted', res -> 'deleted',
                                'identity', res -> 'identity', 'scope', res -> 'scope' -> 'parts', 'require_backup', r.require_backup)
  WHERE id = r.id RETURNING * INTO r;
  PERFORM public.sec_log_write('project_data_reset', 'success', who.actor, NULL,
    jsonb_build_object('step', 'completed', 'request_id', r.id, 'audit_id', res -> 'audit_id', 'sessions_ended', res -> 'sessions_ended', 'files', n,
                       'scope_hash', r.scope_hash, 'require_backup', r.require_backup), '{}'::jsonb);
  RETURN public.data_reset_req_json(r);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('settings_data_reset_no_backup_applied', 'workflow', NULL,
        jsonb_build_object('column', 'data_reset_requests.require_backup (boolean, NOT NULL, default true; open requests keep true)',
                           'binding', 'scope_hash = data_reset_request_hash(closure, require_backup), checked by data_reset_check_scope at approve, start and execute',
                           'without_backup', 'the typed phrase NO BACKUP at the request; only the backup check of admin_data_reset_start is skipped'),
        'The backup precondition of the Settings data reset is a choice of each request (migration 0154, contract 0.15.72).');

DO $$
DECLARE f text;
BEGIN
  -- the pure hash: the reset role, like data_reset_scope_hash
  EXECUTE 'ALTER FUNCTION data_reset_request_hash(text[],boolean) OWNER TO pmis_reset_owner';
  EXECUTE 'REVOKE ALL ON FUNCTION data_reset_request_hash(text[],boolean) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION data_reset_request_hash(text[],boolean) TO pmis_reset_owner, pmis_definer, pmis_identity_owner';
  -- the doors and their helpers: the definer
  FOREACH f IN ARRAY ARRAY[
    'data_reset_rows_guard()', 'data_reset_req_json(data_reset_requests)', 'data_reset_state_json()', 'admin_data_reset_request(text,text,text[],boolean,text)',
    'data_reset_check_scope(data_reset_requests,text)', 'admin_data_reset_approve(uuid,text,integer,text)', 'admin_data_reset_start(uuid,text,integer,text)',
    'admin_data_reset_execute(uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    FOREACH f IN ARRAY ARRAY['data_reset_state_json()', 'admin_data_reset_request(text,text,text[],boolean,text)', 'admin_data_reset_approve(uuid,text,integer,text)',
                             'admin_data_reset_start(uuid,text,integer,text)', 'admin_data_reset_execute(uuid)'] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
    END LOOP;
  END IF;
END $$;
