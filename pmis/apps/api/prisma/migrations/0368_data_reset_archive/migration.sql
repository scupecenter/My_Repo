-- 0368_data_reset_archive: an archive of the rows a project data reset deletes, made before the delete (Data entry proposal P2, contract 0.15.266).
-- Mirror: db/sql/367_data_reset_archive.sql (kept byte-identical). The contract of the reset is docs/ops/data-reset.md.
--
-- The request chooses an archive mode: none (as today), download (the archive is kept until it was downloaded once, 7 days at most) or keep_90 (kept 90 days, any
-- number of downloads). The mode is immutable with the request. When it is not none, the run is refused until an archive of the request is ready (download: and
-- downloaded once). The archive itself (an .xlsx on the current template per register plus a zip of the files) is built by the API from the selection this
-- migration lets the dry run return: the records and stored objects the scope deletes. Downloading needs a System Admin with a step-up and writes a security-log
-- entry. Restoring is the template upload again (rows enter the normal L1 to L2 path). The archive row survives the reset (KEEP in data_reset_plan).
-- Everything that exists is patched in place from the stored text (idempotent): other migrations patch the same functions.

-- 1. The choice on the request, and the archive of a request.
ALTER TABLE data_reset_requests ADD COLUMN IF NOT EXISTS archive_mode text NOT NULL DEFAULT 'none';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'data_reset_requests_archive_mode_chk') THEN
    ALTER TABLE data_reset_requests ADD CONSTRAINT data_reset_requests_archive_mode_chk CHECK (archive_mode IN ('none', 'download', 'keep_90'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS data_reset_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES data_reset_requests(id),
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready', 'failed', 'purged')),
  storage_key text,
  sha256 text,
  bytes bigint,
  entries jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  keep_until timestamptz,
  downloads integer NOT NULL DEFAULT 0,
  first_downloaded_at timestamptz,
  purged_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS data_reset_archives_one_live ON data_reset_archives (request_id) WHERE status IN ('building', 'ready');
ALTER TABLE data_reset_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_reset_archives FORCE ROW LEVEL SECURITY;
ALTER TABLE data_reset_archives OWNER TO pmis_reset_owner;
REVOKE ALL ON data_reset_archives FROM PUBLIC;
GRANT ALL ON data_reset_archives TO pmis_reset_owner;
GRANT SELECT, INSERT, UPDATE ON data_reset_archives TO pmis_definer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'data_reset_archives' AND policyname = 'data_reset_archives_owner') THEN
    CREATE POLICY data_reset_archives_owner ON data_reset_archives FOR ALL TO pmis_reset_owner USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'data_reset_archives' AND policyname = 'data_reset_archives_door') THEN
    CREATE POLICY data_reset_archives_door ON data_reset_archives FOR ALL TO pmis_definer USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 2. The new table has a decision in the plan: KEEP (it is the record of the reset itself, like the requests).
DO $$
DECLARE def text; n text := '''data_reset_requests'', ''data_reset_request_files''';
BEGIN
  def := pg_get_functiondef('public.data_reset_plan()'::regprocedure);
  IF position('data_reset_archives' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_plan: the request tables were not found'; END IF;
    EXECUTE replace(def, n, n || ', ''data_reset_archives''');
  END IF;
END $$;

-- 3. The mode never changes with the request (the guard), and the request JSON says it with the archive state.
DO $$
DECLARE def text; n text := 'OR NEW.require_backup IS DISTINCT FROM OLD.require_backup';
BEGIN
  def := pg_get_functiondef('public.data_reset_rows_guard()'::regprocedure);
  IF position('archive_mode' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_rows_guard: require_backup line not found'; END IF;
    EXECUTE replace(def, n, n || E'\n       OR NEW.archive_mode IS DISTINCT FROM OLD.archive_mode');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION data_reset_archive_json(r data_reset_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('mode', r.archive_mode, 'archive',
    (SELECT jsonb_build_object('id', a.id, 'status', a.status, 'bytes', a.bytes, 'sha256', a.sha256, 'entries', a.entries, 'error', a.error,
                               'created_at', a.created_at, 'ready_at', a.ready_at, 'keep_until', a.keep_until, 'downloads', a.downloads,
                               'first_downloaded_at', a.first_downloaded_at)
     FROM public.data_reset_archives a WHERE a.request_id = r.id ORDER BY (a.status IN ('building', 'ready')) DESC, a.created_at DESC LIMIT 1))
$$;

DO $$
DECLARE def text; n text := '''require_backup'', r.require_backup,';
BEGIN
  def := pg_get_functiondef('public.data_reset_req_json(public.data_reset_requests)'::regprocedure);
  IF position('data_reset_archive_json' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_req_json: require_backup line not found'; END IF;
    EXECUTE replace(def, n, n || E'\n    ''archive'', public.data_reset_archive_json(r),');
  END IF;
END $$;

-- 4. The request door takes the mode (the previous door is dropped, its identity changes).
DO $$
DECLARE def text; old regprocedure := to_regprocedure('public.admin_data_reset_request(text,text,text[],boolean,text,jsonb)'); n text;
BEGIN
  IF old IS NULL THEN RETURN; END IF;   -- already the seven-argument door
  def := pg_get_functiondef(old);
  n := 'p_narrow jsonb DEFAULT NULL::jsonb)';
  IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_request: signature not found'; END IF;
  def := replace(def, n, 'p_narrow jsonb DEFAULT NULL::jsonb, p_archive text DEFAULT ''none''::text)');
  n := 'parts := public.data_reset_require_parts(p_parts);';
  IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_request: parts line not found'; END IF;
  def := replace(def, n, n || E'\n  IF coalesce(p_archive, ''none'') NOT IN (''none'', ''download'', ''keep_90'') THEN\n    PERFORM public.data_reset_err(422, ''validation_failed'', ''The archive choice is none, download or keep_90.'', jsonb_build_object(''errors'', public.reg_err_item(''/archive'', ''invalid'', ''none, download or keep_90.'')));\n  END IF;');
  n := E'requested_parts, scope, scope_hash, require_backup)';
  IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_request: insert columns not found'; END IF;
  def := replace(def, n, 'requested_parts, scope, scope_hash, require_backup, archive_mode)');
  n := 'need), need)';
  IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_request: values tail not found'; END IF;
  def := replace(def, n, 'need), need, coalesce(p_archive, ''none''))');
  DROP FUNCTION public.admin_data_reset_request(text,text,text[],boolean,text,jsonb);
  EXECUTE def;
END $$;

-- 5. The run is refused until the archive the request asked for is ready (download: and downloaded once).
DO $$
DECLARE def text; n text := E'  IF public.data_reset_lock_held() THEN PERFORM public.data_reset_err(409, ''reset_running'', ''A reset is running.''); END IF;\n  IF p_quarantine IS NULL';
BEGIN
  def := pg_get_functiondef('public.admin_data_reset_start(uuid,text,integer,text)'::regprocedure);
  IF position('archive_required' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'admin_data_reset_start: the lock line was not found'; END IF;
    EXECUTE replace(def, n, E'  IF r.archive_mode <> ''none'' AND NOT EXISTS (SELECT 1 FROM public.data_reset_archives a WHERE a.request_id = r.id AND a.status = ''ready''\n         AND (r.archive_mode = ''keep_90'' OR a.first_downloaded_at IS NOT NULL)) THEN\n    PERFORM public.data_reset_err(409, ''archive_required'', CASE WHEN r.archive_mode = ''keep_90'' THEN ''The archive of this request is not ready. Make it first.'' ELSE ''Make the archive and download it first.'' END);\n  END IF;\n' || n);
  END IF;
END $$;

-- 6. The dry run leaves the selection in a transaction-local setting: the records and the stored objects that the scope deletes. Only the archive door reads it.
DO $$
DECLARE def text; n text := E'    DROP TABLE pg_temp.reset_part_rows, pg_temp.reset_files, pg_temp.reset_files_raw, pg_temp.reset_plan, pg_temp.reset_batch, pg_temp.reset_comment,\n      pg_temp.reset_slot, pg_temp.reset_rec, pg_temp.reset_ent, pg_temp.reset_keep_users;';
BEGIN
  def := pg_get_functiondef('public.data_reset_core(boolean,text,jsonb,uuid,uuid,text[],uuid[])'::regprocedure);
  IF position('pmis.reset_archive' IN def) = 0 THEN
    IF position(n IN def) = 0 THEN RAISE EXCEPTION 'data_reset_core: the dry-run drop was not found'; END IF;
    EXECUTE replace(def, n, E'    PERFORM set_config(''pmis.reset_archive'', jsonb_build_object(\n      ''records'', (SELECT coalesce(jsonb_agg(jsonb_build_object(''id'', rc.id, ''entity_id'', rc.entity_id, ''register_key'', rr.register_key) ORDER BY rr.register_key, rc.id), ''[]''::jsonb)\n                   FROM pg_temp.reset_rec rc JOIN public.register_records rr ON rr.id = rc.id WHERE rc.parts && scope),\n      ''files'', (SELECT coalesce(jsonb_agg(jsonb_build_object(''storage_key'', f.storage_key,\n                     ''name'', coalesce((SELECT min(df.original_name) FROM public.document_files df WHERE df.storage_key = f.storage_key), regexp_replace(f.storage_key, ''^.*/'', ''''))) ORDER BY f.storage_key), ''[]''::jsonb)\n                  FROM pg_temp.reset_files f))::text, true);\n' || n);
  END IF;
END $$;

-- 7. The doors of the API. Every one needs a System Admin who is the requester or the approver of an approved request, with a step-up.
CREATE OR REPLACE FUNCTION admin_data_reset_archive_begin(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; r public.data_reset_requests; sel jsonb; aid uuid;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  PERFORM public.data_reset_expire();
  SELECT * INTO r FROM public.data_reset_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.data_reset_err(404, 'not_found', 'No such request.'); END IF;
  IF who.actor NOT IN (r.requested_by, coalesce(r.approved_by, r.requested_by)) THEN
    PERFORM public.data_reset_err(403, 'action_forbidden', 'Only the System Admin who requested the reset or the one who approved it may make its archive.');
  END IF;
  IF r.archive_mode = 'none' THEN PERFORM public.data_reset_err(409, 'invalid_transition', 'This request did not ask for an archive.'); END IF;
  IF r.status <> 'approved' THEN PERFORM public.data_reset_err(409, 'invalid_transition', format('The request is %s: the archive is made while it is approved.', r.status)); END IF;
  IF EXISTS (SELECT 1 FROM public.data_reset_archives a WHERE a.request_id = r.id AND a.status IN ('building', 'ready')) THEN
    PERFORM public.data_reset_err(409, 'invalid_transition', 'The archive of this request exists already.');
  END IF;
  PERFORM public.data_reset_check_scope(r, NULL);
  BEGIN
    PERFORM public.data_reset_core(false, NULL, NULL, NULL, NULL, r.requested_parts, NULL);
  EXCEPTION WHEN others THEN
    PERFORM public.data_reset_err(409, 'plan_incomplete', SQLERRM);
  END;
  sel := coalesce(nullif(current_setting('pmis.reset_archive', true), ''), '{}')::jsonb;
  INSERT INTO public.data_reset_archives (request_id, created_by) VALUES (r.id, who.actor) RETURNING id INTO aid;
  PERFORM public.data_reset_log('data_reset_archive_begin', r.id, NULL,
    jsonb_build_object('archive_id', aid, 'mode', r.archive_mode, 'records', jsonb_array_length(coalesce(sel -> 'records', '[]'::jsonb)),
                       'files', jsonb_array_length(coalesce(sel -> 'files', '[]'::jsonb))), 'archive before the delete');
  RETURN jsonb_build_object('archive_id', aid, 'mode', r.archive_mode, 'records', coalesce(sel -> 'records', '[]'::jsonb), 'files', coalesce(sel -> 'files', '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION admin_data_reset_archive_done(p_archive uuid, p_key text, p_sha text, p_bytes bigint, p_entries jsonb, p_error text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; a public.data_reset_archives; r public.data_reset_requests;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  SELECT * INTO a FROM public.data_reset_archives WHERE id = p_archive FOR UPDATE;
  IF NOT FOUND OR a.status <> 'building' THEN PERFORM public.data_reset_err(409, 'invalid_transition', 'The archive is not being built.'); END IF;
  IF a.created_by <> who.actor THEN PERFORM public.data_reset_err(403, 'action_forbidden', 'Only the System Admin who started the archive may finish it.'); END IF;
  SELECT * INTO r FROM public.data_reset_requests WHERE id = a.request_id;
  IF p_error IS NOT NULL THEN
    UPDATE public.data_reset_archives SET status = 'failed', error = left(p_error, 1000) WHERE id = a.id RETURNING * INTO a;
    PERFORM public.data_reset_log('data_reset_archive_failed', r.id, NULL, jsonb_build_object('archive_id', a.id), left(p_error, 500));
  ELSE
    UPDATE public.data_reset_archives SET status = 'ready', storage_key = p_key, sha256 = p_sha, bytes = p_bytes, entries = coalesce(p_entries, '{}'::jsonb),
           ready_at = clock_timestamp(),
           keep_until = clock_timestamp() + CASE WHEN r.archive_mode = 'keep_90' THEN interval '90 days' ELSE interval '7 days' END
    WHERE id = a.id RETURNING * INTO a;
    PERFORM public.data_reset_log('data_reset_archive_ready', r.id, NULL, jsonb_build_object('archive_id', a.id, 'bytes', a.bytes, 'sha256', a.sha256, 'keep_until', a.keep_until), 'archive before the delete');
  END IF;
  RETURN public.data_reset_archive_json(r);
END $$;

-- The download door: System Admin, step-up, the archive of the request while it is ready. It writes the security-log entry before it hands out the key.
CREATE OR REPLACE FUNCTION admin_data_reset_archive_download(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE who record; a public.data_reset_archives; r public.data_reset_requests;
BEGIN
  SELECT * INTO who FROM public.data_reset_require_admin(true);
  SELECT * INTO r FROM public.data_reset_requests WHERE id = p_id;
  IF NOT FOUND THEN PERFORM public.data_reset_err(404, 'not_found', 'No such request.'); END IF;
  SELECT * INTO a FROM public.data_reset_archives WHERE request_id = r.id AND status = 'ready' FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.data_reset_err(404, 'not_found', 'This request has no archive to download (not made, failed, or no longer kept).'); END IF;
  IF a.keep_until <= clock_timestamp() THEN PERFORM public.data_reset_err(410, 'archive_expired', 'The archive is no longer kept.'); END IF;
  UPDATE public.data_reset_archives SET downloads = downloads + 1, first_downloaded_at = coalesce(first_downloaded_at, clock_timestamp()) WHERE id = a.id;
  PERFORM public.data_reset_log('data_reset_archive_download', r.id, NULL, jsonb_build_object('archive_id', a.id, 'by', who.actor, 'sha256', a.sha256, 'bytes', a.bytes), 'archive download');  -- the audit row and the security-log entry (step archive_download)
  RETURN jsonb_build_object('storage_key', a.storage_key, 'bytes', a.bytes, 'sha256', a.sha256, 'request_id', r.id, 'archive_id', a.id);
END $$;

-- Expiry: archives past keep_until. The API removes the stored object, then marks it purged.
CREATE OR REPLACE FUNCTION admin_data_reset_archive_due() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('archive_id', a.id, 'storage_key', a.storage_key)), '[]'::jsonb)
  FROM public.data_reset_archives a WHERE a.status = 'ready' AND a.keep_until <= clock_timestamp()
$$;

CREATE OR REPLACE FUNCTION admin_data_reset_archive_purged(p_archive uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.data_reset_archives SET status = 'purged', purged_at = clock_timestamp() WHERE id = p_archive AND status = 'ready' AND keep_until <= clock_timestamp();
END $$;

-- 8. Owners and rights (as 0152 and 0366 gave the family).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['data_reset_archive_json(data_reset_requests)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_reset_owner', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_reset_owner, pmis_definer, pmis_identity_owner', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['admin_data_reset_request(text,text,text[],boolean,text,jsonb,text)', 'admin_data_reset_archive_begin(uuid)',
                           'admin_data_reset_archive_done(uuid,text,text,bigint,jsonb,text)', 'admin_data_reset_archive_download(uuid)',
                           'admin_data_reset_archive_due()', 'admin_data_reset_archive_purged(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
  END LOOP;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('data_reset_archive_applied', 'workflow', NULL,
        jsonb_build_object('modes', jsonb_build_array('none', 'download', 'keep_90'), 'download', 'System Admin, step-up, security-log entry per download',
                           'gate', 'admin_data_reset_start refuses (409 archive_required) until the archive of the request is ready (download: and downloaded once)',
                           'doors', 'admin_data_reset_archive_begin, _done, _download, _due, _purged'),
        'Archive before the project data reset deletes (migration 0368, Data entry proposal P2).');
