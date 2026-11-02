-- 0048_storage_protection: encryption at rest, virus scan, expired zip cleanup and the backup of stored files (ADR 0008 amendment 2026-11-02,
-- owner answer Q134). Mirror: db/sql/047_storage_protection.sql (kept byte-identical to this file).
--
-- What this migration adds, and only through the functions below (SECURITY DEFINER, owner pmis_definer):
--   1. stored_object_meta: one row per encrypted object. It holds the envelope (the data key wrapped with the master key FILE_ENC_KEY, its id,
--      the content nonce and the GCM tag), the SHA-256 of the plaintext and the scan status. An object without a row is a legacy plaintext
--      object and stays readable. The master key itself is never stored here.
--   2. The security alert rule `malware_upload` (ClamAV refused an upload, or a rescan found malware).
--   3. document_export_jobs.purged_at: the zip export was deleted from storage after expires_at (the row stays, marked purged).
--   4. pmis_app has no access to the new table (db/sql/app_grants.sql revokes it); the API uses only these functions.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Security alert rule for malware
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE security_alerts DROP CONSTRAINT IF EXISTS security_alerts_rule_check;
ALTER TABLE security_alerts ADD CONSTRAINT security_alerts_rule_check CHECK (rule IN ('failed_sign_ins', 'failed_sign_ins_ip', 'new_ip', 'large_export',
  'admin_set_changed', 'retention_reduced', 'alert_settings_weakened', 'audit_integrity_failure', 'malware_upload'));

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Export jobs: purged after expiry
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE document_export_jobs ADD COLUMN IF NOT EXISTS purged_at timestamptz;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Envelope and scan state of stored objects
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE stored_object_meta (
  storage_key   text PRIMARY KEY CHECK (char_length(storage_key) BETWEEN 5 AND 300),
  driver        text NOT NULL CHECK (driver IN ('local', 's3')),
  key_id        text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{1,40}$'),   -- which master key wrapped the data key
  wrapped_key   bytea NOT NULL CHECK (octet_length(wrapped_key) = 60),   -- iv(12) | tag(16) | data key(32), AES-256-GCM under the master key
  nonce         bytea NOT NULL CHECK (octet_length(nonce) = 12),         -- nonce of the content (a fresh random one per object)
  tag           bytea NOT NULL CHECK (octet_length(tag) = 16),           -- GCM tag of the content
  plain_sha256  text NOT NULL CHECK (plain_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),                 -- plaintext size (the ciphertext has the same size)
  scan_status   text NOT NULL DEFAULT 'clean' CHECK (scan_status IN ('clean', 'pending_rescan', 'infected')),
  scanned_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX stored_object_meta_scan ON stored_object_meta (scan_status) WHERE scan_status <> 'clean';
CREATE INDEX stored_object_meta_key ON stored_object_meta (key_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Functions used by the API (pmis_app calls them; the table is not granted to it)
-- ---------------------------------------------------------------------------------------------------------------------
-- Writes the envelope of an object. p_replace = false refuses a second row for the same key (uploads, keys are random);
-- p_replace = true is for the one-off re-encrypt of a legacy object (storage:encrypt-legacy).
CREATE OR REPLACE FUNCTION storage_meta_put(p_key text, p_driver text, p_key_id text, p_wrapped bytea, p_nonce bytea, p_tag bytea,
  p_sha256 text, p_size bigint, p_scan_status text, p_replace boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_scan_status NOT IN ('clean', 'pending_rescan') THEN RAISE EXCEPTION 'storage meta: a new object is clean or pending a rescan' USING ERRCODE = 'check_violation'; END IF;
  IF p_replace THEN
    INSERT INTO public.stored_object_meta (storage_key, driver, key_id, wrapped_key, nonce, tag, plain_sha256, size_bytes, scan_status, scanned_at)
    VALUES (p_key, p_driver, p_key_id, p_wrapped, p_nonce, p_tag, p_sha256, p_size, p_scan_status, CASE WHEN p_scan_status = 'clean' THEN now() END)
    ON CONFLICT (storage_key) DO UPDATE SET driver = EXCLUDED.driver, key_id = EXCLUDED.key_id, wrapped_key = EXCLUDED.wrapped_key,
      nonce = EXCLUDED.nonce, tag = EXCLUDED.tag, plain_sha256 = EXCLUDED.plain_sha256, size_bytes = EXCLUDED.size_bytes
      -- the scan state is never changed by a replace (security review of 0048): an infected or pending object keeps its status,
      -- and an infected one cannot be replaced at all
      WHERE public.stored_object_meta.scan_status <> 'infected';
    IF EXISTS (SELECT 1 FROM public.stored_object_meta m WHERE m.storage_key = p_key AND m.scan_status = 'infected') THEN
      RAISE EXCEPTION 'storage meta: an infected object stays quarantined' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    INSERT INTO public.stored_object_meta (storage_key, driver, key_id, wrapped_key, nonce, tag, plain_sha256, size_bytes, scan_status, scanned_at)
    VALUES (p_key, p_driver, p_key_id, p_wrapped, p_nonce, p_tag, p_sha256, p_size, p_scan_status, CASE WHEN p_scan_status = 'clean' THEN now() END);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION storage_meta_get(p_key text) RETURNS SETOF stored_object_meta
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE AS $$
  SELECT m.* FROM public.stored_object_meta m WHERE m.storage_key = p_key;
$$;

-- An infected object stays infected: the status can only move out of pending_rescan, or to infected.
CREATE OR REPLACE FUNCTION storage_meta_set_scan(p_key text, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_status NOT IN ('clean', 'infected', 'pending_rescan') THEN RAISE EXCEPTION 'storage meta: unknown scan status' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.stored_object_meta SET scan_status = p_status, scanned_at = CASE WHEN p_status = 'pending_rescan' THEN scanned_at ELSE now() END
  WHERE storage_key = p_key AND scan_status <> 'infected';
END $$;

CREATE OR REPLACE FUNCTION storage_meta_pending(p_limit integer) RETURNS SETOF text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE AS $$
  SELECT m.storage_key FROM public.stored_object_meta m WHERE m.scan_status = 'pending_rescan' ORDER BY m.created_at, m.storage_key LIMIT greatest(1, least(p_limit, 500));
$$;

-- Lists the envelopes in key order, after a key (the verify command of the restore drill walks the whole store).
CREATE OR REPLACE FUNCTION storage_meta_list(p_after text, p_limit integer) RETURNS SETOF stored_object_meta
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE AS $$
  SELECT m.* FROM public.stored_object_meta m WHERE m.storage_key > coalesce(p_after, '') ORDER BY m.storage_key LIMIT greatest(1, least(p_limit, 500));
$$;

-- An infected object's envelope is never deleted: without it the object would read as a legacy plaintext file and leave quarantine.
CREATE OR REPLACE FUNCTION storage_meta_delete(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.stored_object_meta m WHERE m.storage_key = p_key AND m.scan_status = 'infected') THEN
    RAISE EXCEPTION 'storage meta: an infected object stays quarantined' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM public.stored_object_meta WHERE storage_key = p_key;
END $$;

-- Key rotation: the envelopes that are not wrapped with the active master key (rewrap only the data keys; the content is not touched).
CREATE OR REPLACE FUNCTION storage_meta_rotation_batch(p_active_key_id text, p_limit integer) RETURNS SETOF stored_object_meta
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE AS $$
  SELECT m.* FROM public.stored_object_meta m WHERE m.key_id <> p_active_key_id ORDER BY m.storage_key LIMIT greatest(1, least(p_limit, 500));
$$;

CREATE OR REPLACE FUNCTION storage_meta_rewrap(p_key text, p_from_key_id text, p_key_id text, p_wrapped bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int;
BEGIN
  IF octet_length(p_wrapped) <> 60 THEN RAISE EXCEPTION 'storage meta: wrapped key has the wrong size' USING ERRCODE = 'check_violation'; END IF;
  UPDATE public.stored_object_meta SET key_id = p_key_id, wrapped_key = p_wrapped WHERE storage_key = p_key AND key_id = p_from_key_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- Legacy plaintext objects still to encrypt: the stored files, blank forms and zip exports that have no envelope row. The expected SHA-256
-- is the one recorded with the file (null for a zip export, which has none).
CREATE OR REPLACE FUNCTION storage_legacy_candidates(p_limit integer) RETURNS TABLE (storage_key text, expected_sha256 text, size_bytes bigint, source text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE AS $$
  SELECT x.* FROM (
    SELECT f.storage_key, f.sha256, f.size_bytes, 'document_file'::text AS source FROM public.document_files f
    UNION ALL SELECT b.storage_key, b.sha256, b.size_bytes, 'blank_form' FROM public.document_blank_forms b
    UNION ALL SELECT j.storage_key, NULL::text, j.size_bytes, 'export_job' FROM public.document_export_jobs j
      WHERE j.storage_key IS NOT NULL AND j.purged_at IS NULL
  ) x
  WHERE x.storage_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.stored_object_meta m WHERE m.storage_key = x.storage_key)
  ORDER BY x.storage_key LIMIT greatest(1, least(p_limit, 500));
$$;

-- Zip exports past expires_at whose stored object is still there.
CREATE OR REPLACE FUNCTION storage_expired_exports(p_limit integer) RETURNS TABLE (export_id uuid, storage_key text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public STABLE AS $$
  SELECT j.id, j.storage_key, j.expires_at FROM public.document_export_jobs j
  WHERE j.storage_key IS NOT NULL AND j.purged_at IS NULL AND j.expires_at IS NOT NULL AND j.expires_at < now()
  ORDER BY j.expires_at, j.id LIMIT greatest(1, least(p_limit, 500));
$$;

CREATE OR REPLACE FUNCTION storage_export_purged(p_export_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.document_export_jobs SET purged_at = now() WHERE id = p_export_id AND purged_at IS NULL;
$$;

-- A malware refusal or a rescan finding raises one alert (rule malware_upload, High, to the System Admins). Once per dedup key.
CREATE OR REPLACE FUNCTION storage_malware_alert(p_title text, p_detail jsonb, p_dedup text, p_user uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN public.sec_alert_raise('malware_upload', 'high', left(p_title, 300), CASE WHEN p_detail IS NULL OR length(p_detail::text) <= 4000 THEN p_detail END,
    left(p_dedup, 200), p_user, NULL);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON stored_object_meta TO pmis_definer;
GRANT SELECT ON document_files, document_blank_forms TO pmis_definer;
GRANT SELECT, UPDATE ON document_export_jobs TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'storage_meta_put(text,text,text,bytea,bytea,bytea,text,bigint,text,boolean)', 'storage_meta_get(text)', 'storage_meta_set_scan(text,text)',
    'storage_meta_pending(integer)', 'storage_meta_delete(text)', 'storage_meta_list(text,integer)', 'storage_meta_rotation_batch(text,integer)',
    'storage_meta_rewrap(text,text,text,bytea)', 'storage_legacy_candidates(integer)', 'storage_expired_exports(integer)',
    'storage_export_purged(uuid)', 'storage_malware_alert(text,jsonb,text,uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f);
  END LOOP;
END $$;
