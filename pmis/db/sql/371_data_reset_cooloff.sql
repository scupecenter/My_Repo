-- 0372_data_reset_cooloff: a waiting period between the approval and the run of a project data reset (Data entry proposal P6, contract 0.15.267).
-- Mirror: db/sql/371_data_reset_cooloff.sql (kept byte-identical). The contract of the reset is docs/ops/data-reset.md.
--
-- The waiting period is a setting of the reset (Settings > Data > Data reset, next to the request expiry and the backup age): immediately (0), 30 minutes,
-- 24 hours (default) or any number of minutes up to 30 days. A request inherits the value when it is made, the approver sees it, and it cannot change afterwards
-- (guard). The approval starts the wait: `run_after` is the approval plus the wait, and the request stays open for the usual request expiry after that moment (so a
-- long wait does not expire the request). Until `run_after` the start door refuses (409 cooloff_active); either System Admin can cancel while waiting (the cancel
-- door is open to any System Admin in requested and approved). Both admins get an in-app notice at the approval and another shortly before the wait ends.
-- Everything that exists is patched in place from the stored text (idempotent): other migrations patch the same functions.

-- 1. The wait on the request.
ALTER TABLE data_reset_requests ADD COLUMN IF NOT EXISTS cooloff_minutes integer NOT NULL DEFAULT 0;
ALTER TABLE data_reset_requests ADD COLUMN IF NOT EXISTS run_after timestamptz;
ALTER TABLE data_reset_requests ADD COLUMN IF NOT EXISTS cooloff_notified_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'data_reset_requests_cooloff_chk') THEN
    ALTER TABLE data_reset_requests ADD CONSTRAINT data_reset_requests_cooloff_chk CHECK (cooloff_minutes BETWEEN 0 AND 43200);
  END IF;
END $$;

-- 2. The setting: read with the others (default 24 hours), written by the settings door (validated, optional so a client of the two-value form keeps working).
DO $$
DECLARE def text; n text := E'    \'version\', coalesce(';
BEGIN
  def := pg_get_functiondef('public.data_reset_cfg()'::regprocedure);
  IF position('cooloff_minutes' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_cfg: the version line was not found'; END IF;
    EXECUTE replace(def, n, E'    \'cooloff_minutes\', coalesce((SELECT (s.value ->> \'cooloff_minutes\')::integer FROM public.settings s WHERE s.key = \'data_reset.settings\'), 1440),\n' || n);
  END IF;
END $$;

DO $$
DECLARE def text; n text;
BEGIN
  def := pg_get_functiondef('public.admin_set_data_reset_settings(jsonb,text,integer)'::regprocedure);
  IF position('cooloff_minutes' IN def) = 0 THEN
    n := 'IF k NOT IN (''request_expiry_minutes'', ''backup_max_age_hours'') THEN';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_set_data_reset_settings: the key list was not found'; END IF;
    def := replace(def, n, 'IF k NOT IN (''request_expiry_minutes'', ''backup_max_age_hours'', ''cooloff_minutes'') THEN');
    n := E'  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err(\'validation_failed\', jsonb_build_object(\'errors\', errs)); END IF;\n  nxt :=';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_set_data_reset_settings: the validation line was not found'; END IF;
    def := replace(def, n, E'  IF p_body ? \'cooloff_minutes\' THEN\n    v := p_body -> \'cooloff_minutes\';\n    IF jsonb_typeof(v) <> \'number\' OR (v #>> \'{}\')::numeric <> trunc((v #>> \'{}\')::numeric) THEN\n      errs := errs || public.reg_err_item(\'/cooloff_minutes\', \'required\', \'A whole number of minutes.\');\n    ELSIF (v #>> \'{}\')::numeric NOT BETWEEN 0 AND 43200 THEN\n      errs := errs || public.reg_err_item(\'/cooloff_minutes\', \'out_of_range\', \'From 0 (immediately) to 43200 minutes (30 days).\');\n    END IF;\n  END IF;\n' || n);
    n := '''backup_max_age_hours'', (p_body ->> ''backup_max_age_hours'')::integer, ''version''';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_set_data_reset_settings: the new value was not found'; END IF;
    def := replace(def, n, '''backup_max_age_hours'', (p_body ->> ''backup_max_age_hours'')::integer, ''cooloff_minutes'', coalesce((p_body ->> ''cooloff_minutes'')::integer, (cur ->> ''cooloff_minutes'')::integer), ''version''');
    EXECUTE def;
  END IF;
END $$;

-- 3. The request takes the value as it is now; it never changes with the request (the guard: the wait, and the moment once set).
DO $$
DECLARE def text; n text;
BEGIN
  def := pg_get_functiondef('public.admin_data_reset_request(text,text,text[],boolean,text,jsonb,text)'::regprocedure);
  IF position('cooloff_minutes' IN def) = 0 THEN
    n := 'require_backup, archive_mode)';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_request: insert columns not found'; END IF;
    def := replace(def, n, 'require_backup, archive_mode, cooloff_minutes)');
    n := 'need, coalesce(p_archive, ''none''))';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_request: values tail not found'; END IF;
    def := replace(def, n, 'need, coalesce(p_archive, ''none''), (public.data_reset_cfg() ->> ''cooloff_minutes'')::integer)');
    EXECUTE def;
  END IF;
END $$;

DO $$
DECLARE def text; n text := E'OR NEW.archive_mode IS DISTINCT FROM OLD.archive_mode';
BEGIN
  def := pg_get_functiondef('public.data_reset_rows_guard()'::regprocedure);
  IF position('cooloff_minutes' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_rows_guard: archive_mode line not found'; END IF;
    EXECUTE replace(def, n, n || E'\n       OR NEW.cooloff_minutes IS DISTINCT FROM OLD.cooloff_minutes\n       OR (OLD.run_after IS NOT NULL AND NEW.run_after IS DISTINCT FROM OLD.run_after)');
  END IF;
END $$;

-- 4. The approval starts the wait: the moment the run opens, the request stays open for the usual expiry after it, and both admins are told.
DO $$
DECLARE def text; n text;
BEGIN
  def := pg_get_functiondef('public.admin_data_reset_approve(uuid,text,integer,text)'::regprocedure);
  IF position('run_after' IN def) = 0 THEN
    n := 'approved_at = clock_timestamp(), approve_reason = why, approved_scope_hash = r.scope_hash';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_approve: the update was not found'; END IF;
    def := replace(def, n, n || E',\n         run_after = clock_timestamp() + make_interval(mins => r.cooloff_minutes),\n         expires_at = CASE WHEN r.cooloff_minutes > 0 THEN clock_timestamp() + make_interval(mins => r.cooloff_minutes + (public.data_reset_cfg() ->> ''request_expiry_minutes'')::integer) ELSE expires_at END');
    n := E'  RETURN public.data_reset_req_json(r);\nEND';
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_approve: the return was not found'; END IF;
    def := replace(def, n, E'  IF r.cooloff_minutes > 0 THEN\n    INSERT INTO public.notifications (user_id, kind, title, body, link)\n    SELECT u.id, \'data_reset_request\', \'The project data reset is waiting before it can run\',\n           format(\'The reset of %s was approved. It can run from %s (waiting period %s minutes). Either System Admin can cancel it until then. Reason: %s\',\n                  current_database(), to_char(r.run_after AT TIME ZONE \'UTC\', \'YYYY-MM-DD HH24:MI\') || \' UTC\', r.cooloff_minutes, left(r.request_reason, 300)),\n           \'/admin/settings/data/reset\'\n    FROM public.users u WHERE u.id IN (r.requested_by, r.approved_by) AND u.status = \'active\' AND u.deleted_at IS NULL;\n  END IF;\n' || n);
    EXECUTE def;
  END IF;
END $$;

-- 5. The run is refused until the wait is over.
DO $$
DECLARE def text; n text := E'  IF public.data_reset_lock_held() THEN PERFORM public.data_reset_err(409, \'\'reset_running\'\', \'\'A reset is running.\'\'); END IF;\n  IF p_quarantine IS NULL';
BEGIN
  def := pg_get_functiondef('public.admin_data_reset_start(uuid,text,integer,text)'::regprocedure);
  IF position('cooloff_active' IN def) = 0 THEN
    n := replace(n, '''''', '''');
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_start: the lock line was not found'; END IF;
    EXECUTE replace(def, n, E'  IF r.run_after IS NOT NULL AND r.run_after > clock_timestamp() THEN\n    PERFORM public.data_reset_err(409, \'cooloff_active\', format(\'The waiting period is not over: the reset can run from %s. Either System Admin can cancel it until then.\', to_char(r.run_after AT TIME ZONE \'UTC\', \'YYYY-MM-DD HH24:MI\') || \' UTC\'),\n      jsonb_build_object(\'run_after\', r.run_after, \'cooloff_minutes\', r.cooloff_minutes));\n  END IF;\n' || n);
  END IF;
END $$;

-- 6. The request JSON says the wait.
DO $$
DECLARE def text; n text := E'    \'archive\', public.data_reset_archive_json(r),';
BEGIN
  def := pg_get_functiondef('public.data_reset_req_json(data_reset_requests)'::regprocedure);
  IF position('cooloff' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_req_json: the archive line was not found'; END IF;
    EXECUTE replace(def, n, n || E'\n    \'cooloff\', jsonb_build_object(\'minutes\', r.cooloff_minutes, \'run_after\', r.run_after,\n      \'active\', r.status = \'approved\' AND r.run_after IS NOT NULL AND r.run_after > clock_timestamp(),\n      \'remaining_seconds\', CASE WHEN r.status = \'approved\' AND r.run_after IS NOT NULL THEN greatest(0, ceil(extract(epoch FROM r.run_after - clock_timestamp())))::bigint END),');
  END IF;
END $$;

-- 7. The notice before the run: when the wait is nearly over (an hour before, or half way for a short wait) both admins get one in-app notice. Called by a
-- one-minute job of the API; also safe to call by hand.
CREATE OR REPLACE FUNCTION data_reset_cooloff_notify() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.data_reset_requests; n integer := 0;
BEGIN
  PERFORM public.data_reset_expire();
  FOR r IN SELECT * FROM public.data_reset_requests
           WHERE status = 'approved' AND cooloff_minutes > 0 AND cooloff_notified_at IS NULL AND run_after IS NOT NULL
             AND expires_at > clock_timestamp()
             AND run_after - least(interval '60 minutes', make_interval(mins => cooloff_minutes / 2)) <= clock_timestamp()
           FOR UPDATE LOOP
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    SELECT u.id, 'data_reset_request', 'The project data reset can run soon',
           format('The reset of %s can run from %s. Either System Admin can still cancel it until it runs.', current_database(),
                  to_char(r.run_after AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'),
           '/admin/settings/data/reset'
    FROM public.users u WHERE u.id IN (r.requested_by, r.approved_by) AND u.status = 'active' AND u.deleted_at IS NULL;
    UPDATE public.data_reset_requests SET cooloff_notified_at = clock_timestamp() WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

DO $$
DECLARE f text := 'data_reset_cooloff_notify()';
BEGIN
  EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('data_reset_cooloff_applied', 'workflow', NULL,
        jsonb_build_object('setting', 'data_reset.settings.cooloff_minutes (default 1440; 0 = immediately; 0 to 43200)',
                           'gate', 'admin_data_reset_start refuses (409 cooloff_active) until run_after (approval plus the wait)',
                           'notices', 'in-app to the requester and the approver at the approval and before the wait ends (data_reset_cooloff_notify)',
                           'immutable', 'cooloff_minutes and run_after never change with the request (data_reset_rows_guard)'),
        'Waiting period before the project data reset runs (migration 0372, Data entry proposal P6).');
