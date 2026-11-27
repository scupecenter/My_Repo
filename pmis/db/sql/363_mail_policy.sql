-- 0364: mail policy (assignment from the project lead via Main, 2026-11-27): the three new notification kinds join the mail catalogue, and a settings door decides who may be mailed.
--
-- 1. CATALOGUE. expiry_radar (0360), approval_digest (0362) and weekly_digest (0166) join mail_kind_catalogue(), so an admin can choose to mail them (Settings, Alerts, Mail).
--    They are NOT mailed until an admin lists them in mail.notification_kinds (unchanged rule). The function is patched IN PLACE from its stored text (idempotent), never
--    redefined whole, so no kind added by another migration is lost.
-- 2. POLICY. The setting `mail.policy` = {"version": 0, "enabled": true, "mode": "internal_only", "internal_domains": [], "kinds": {"<kind>": {"enabled": true, "mode": "inherit"}}}.
--    enabled = the global switch (false: no notification mail is queued; mandatory mail such as security alerts is never stopped). mode = internal_only | internal_external for all
--    kinds, a kind may set its own (enabled false, or mode inherit | internal_only | internal_external). An address is EXTERNAL when its domain is not in internal_domains; with no
--    domain listed every address counts as internal, so today's behaviour is unchanged. An external address is mailed only when the effective mode is internal_external AND the
--    security lock `block_public_sharing` is off (a lock is honoured). Defaults equal today's behaviour: enabled, internal_only, no domains.
-- 3. WHERE IT APPLIES. mail_policy_check(kind, address, mandatory) returns NULL (allowed) or the reason. It is called from mail_enqueue_internal, the single door of every mail
--    (notifications, invitations, API mail, digests), patched in place; a refused mail is stored as `suppressed` with the reason in the System Log, so the admin sees it in the Mail screen.
-- 4. DOOR. mail_policy_json() reads, admin_save_mail_policy(config, reason, version) writes: System Admin, reason, If-Match, validated, audited (mail_policy_update).
-- No table. No permission, role or grant change.

DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.mail_kind_catalogue()'::regprocedure);
  IF position('''expiry_radar''' IN def) = 0 THEN
    -- the end of the kind list, whatever the indentation of the migration that wrote the function last (0149 uses two spaces, 0340 six)
    IF def !~ E'\\n\\s*\\]\\) WITH ORDINALITY' THEN RAISE EXCEPTION 'mail_kind_catalogue: the end of the kind list was not found'; END IF;
    def := regexp_replace(def, E'(\\n\\s*)\\]\\) WITH ORDINALITY', E',\\1  ''expiry_radar'', ''approval_digest'', ''weekly_digest''\\1]) WITH ORDINALITY');
    EXECUTE def;
  END IF;
END $$;

INSERT INTO settings (key, value, description, updated_at)
VALUES ('mail.policy', '{"version": 0, "enabled": true, "mode": "internal_only", "internal_domains": [], "kinds": {}}'::jsonb,
        'Mail policy: global switch, internal only or internal plus external, internal domains, and per notification kind (see migration 0364).', now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION mail_policy_check(p_kind text, p_to text, p_mandatory boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE cfg jsonb; k text; kc jsonb; mode text; dom text; doms jsonb; ext boolean := false;
BEGIN
  IF coalesce(p_mandatory, false) OR p_kind LIKE 'security_alert%' THEN RETURN NULL; END IF;
  SELECT value INTO cfg FROM public.settings WHERE key = 'mail.policy';
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' THEN RETURN NULL; END IF;
  IF coalesce((cfg ->> 'enabled')::boolean, true) IS NOT TRUE THEN RETURN 'policy_off'; END IF;
  k := regexp_replace(coalesce(p_kind, ''), '^notification\.', '');
  kc := cfg -> 'kinds' -> k;
  IF jsonb_typeof(kc) = 'object' AND coalesce((kc ->> 'enabled')::boolean, true) IS NOT TRUE THEN RETURN 'kind_off'; END IF;
  mode := coalesce(NULLIF(kc ->> 'mode', 'inherit'), cfg ->> 'mode', 'internal_only');
  doms := cfg -> 'internal_domains';
  IF jsonb_typeof(doms) = 'array' AND jsonb_array_length(doms) > 0 THEN
    dom := lower(split_part(p_to, '@', 2));
    ext := NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(doms) d WHERE lower(d) = dom);
  END IF;
  IF ext THEN
    IF mode <> 'internal_external' THEN RETURN 'external_not_allowed'; END IF;
    IF public.security_lock_active('block_public_sharing') THEN RETURN 'security_lock'; END IF;
  END IF;
  RETURN NULL;
END $$;

-- patch mail_enqueue_internal in place: a refused mail is stored as suppressed with the reason (idempotent)
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.mail_enqueue_internal(text,text,uuid,text,text,text,boolean,jsonb)'::regprocedure);
  IF position('mail_policy_check' IN def) = 0 THEN
    IF position('subj text;' IN def) = 0 OR position('  INSERT INTO public.mail_outbox (kind, to_address' IN def) = 0 OR position('mail suppressed (hourly cap)' IN def) = 0 THEN
      RAISE EXCEPTION 'mail_enqueue_internal: the expected text was not found';
    END IF;
    def := replace(def, 'subj text;', 'subj text; pol text;');
    def := replace(def, '  INSERT INTO public.mail_outbox (kind, to_address',
      E'  pol := public.mail_policy_check(p_kind, addr, coalesce((p_source ->> ''mandatory'')::boolean, false));\n  IF pol IS NOT NULL THEN st := ''suppressed''; END IF;\n  INSERT INTO public.mail_outbox (kind, to_address');
    def := replace(def, '''mail suppressed (hourly cap)''', '''mail suppressed ('' || coalesce(pol, ''hourly cap'') || '')''');
    EXECUTE def;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION mail_policy_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'enabled', coalesce((s.value ->> 'enabled')::boolean, true), 'mode', coalesce(s.value ->> 'mode', 'internal_only'),
    'internal_domains', coalesce(s.value -> 'internal_domains', '[]'::jsonb), 'kinds', coalesce(s.value -> 'kinds', '{}'::jsonb),
    'version', coalesce((s.value ->> 'version')::int, 0), 'updated_at', s.updated_at, 'updated_by', s.updated_by,
    'catalogue', public.mail_kind_catalogue(),
    'block_public_sharing', public.security_lock_active('block_public_sharing'))
  FROM public.settings s WHERE s.key = 'mail.policy'
$$;

CREATE OR REPLACE FUNCTION admin_save_mail_policy(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur jsonb; v int; errs jsonb := '[]'::jsonb; before jsonb; after jsonb; kk text; kv jsonb; d jsonb; known jsonb := public.mail_kind_catalogue(); i int := 0;
BEGIN
  IF NOT public.app_actor_is_system_admin() THEN RAISE EXCEPTION 'mail policy: System Admin only' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM public.calc_require_reason(p_reason);
  IF NOT public.app_ctx_stepup() THEN PERFORM public.wf_err('step_up_required'); END IF;
  PERFORM 1 FROM public.settings WHERE key = 'mail.policy' FOR UPDATE;
  SELECT value INTO cur FROM public.settings WHERE key = 'mail.policy';
  v := coalesce((cur ->> 'version')::int, 0);
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object.')));
  END IF;
  FOR kk IN SELECT jsonb_object_keys(p_config) LOOP
    IF kk NOT IN ('enabled', 'mode', 'internal_domains', 'kinds') THEN errs := errs || public.reg_err_item('/' || kk, 'unknown_key', 'Unknown key.'); END IF;
  END LOOP;
  IF jsonb_typeof(p_config -> 'enabled') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/enabled', 'required', 'true or false.'); END IF;
  IF (p_config ->> 'mode') IS NULL OR (p_config ->> 'mode') NOT IN ('internal_only', 'internal_external') THEN errs := errs || public.reg_err_item('/mode', 'invalid', 'internal_only or internal_external.'); END IF;
  IF jsonb_typeof(p_config -> 'internal_domains') IS DISTINCT FROM 'array' OR jsonb_array_length(p_config -> 'internal_domains') > 50 THEN
    errs := errs || public.reg_err_item('/internal_domains', 'invalid', 'A list of at most 50 domains.');
  ELSE
    FOR d IN SELECT * FROM jsonb_array_elements(p_config -> 'internal_domains') LOOP
      IF jsonb_typeof(d) <> 'string' OR (d #>> '{}') !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' THEN
        errs := errs || public.reg_err_item('/internal_domains/' || i, 'invalid', 'A lower-case domain such as example.com.');
      END IF;
      i := i + 1;
    END LOOP;
  END IF;
  IF jsonb_typeof(p_config -> 'kinds') IS DISTINCT FROM 'object' THEN errs := errs || public.reg_err_item('/kinds', 'required', 'An object (it may be empty).');
  ELSE
    FOR kk, kv IN SELECT * FROM jsonb_each(p_config -> 'kinds') LOOP
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(known) e WHERE e ->> 'kind' = kk) THEN errs := errs || public.reg_err_item('/kinds/' || kk, 'unknown_kind', 'Not a notification kind of the catalogue.');
      ELSIF jsonb_typeof(kv) <> 'object' OR jsonb_typeof(kv -> 'enabled') IS DISTINCT FROM 'boolean' OR coalesce(kv ->> 'mode', '') NOT IN ('inherit', 'internal_only', 'internal_external') THEN
        errs := errs || public.reg_err_item('/kinds/' || kk, 'invalid', 'An object with enabled (true or false) and mode (inherit, internal_only or internal_external).');
      END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := public.mail_policy_json() - 'catalogue' - 'updated_at' - 'updated_by' - 'block_public_sharing';
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('mail.policy', jsonb_build_object('version', v + 1, 'enabled', p_config -> 'enabled', 'mode', p_config -> 'mode', 'internal_domains', p_config -> 'internal_domains', 'kinds', p_config -> 'kinds'),
          'Mail policy: global switch, internal only or internal plus external, internal domains, and per notification kind (see migration 0364).', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  after := public.mail_policy_json();
  PERFORM public.log_audit_write('mail_policy_update', 'setting', 'mail.policy', before, after - 'catalogue' - 'updated_at' - 'updated_by' - 'block_public_sharing', btrim(p_reason));
  RETURN after;
END $$;

GRANT SELECT, INSERT, UPDATE ON settings TO pmis_definer;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['mail_policy_check(text,text,boolean)', 'mail_policy_json()', 'admin_save_mail_policy(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION mail_policy_json(), admin_save_mail_policy(jsonb, text, integer) TO pmis_app;
  END IF;
END $$;
