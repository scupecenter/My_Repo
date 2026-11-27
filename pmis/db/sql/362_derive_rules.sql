-- 0363 (derive): config-driven cross-register derive.
--
-- WHAT. One rule table, as the setting `derive.rules`, says which value a register shows from ANOTHER register. Each rule: target register, output name, source register,
-- the value to take (the source record's external party, or one named data field of the source) and how to find the source record: the record named by a link field of
-- the target record (for example HLC procurement_record_id), else the latest current approved source record of the SAME SITE that has the value. The two rules that were
-- hard-coded (GECOL and HLC contractor from Procurement) are seeded, so today's behaviour is kept.
-- SHOW MODE (this migration). The value is computed when a register list or record is read and is never stored. derive_values(ids) is a narrow SECURITY DEFINER reader: it
-- returns ONLY the configured value of the matching source record for target records the caller may read (app_region_read on the TARGET), never the source record, its
-- other fields, its link or its documents. The viewer needs no permission on the source register for the configured value, and no permission, role, grant or default is
-- changed. Every disclosure of a value from a register the caller could not otherwise see is audited (action derive_disclosed), once per person and rule per 10 minutes.
-- WRITER. admin_save_derive_rules(config, reason, version): System Admin or admin.settings edit, reason, If-Match, validated against register_fields, audited.
-- Fill-at-approval mode is NOT built here (a proposal in the PR). No table, no change to any existing function.

INSERT INTO settings (key, value, description, updated_at)
VALUES ('derive.rules',
        '{"version": 0, "rules": [{"key": "gecol_procurement_contractor", "enabled": true, "target_register": "gecol", "output": "procurement_contractor", "source_register": "procurement", "source": "external_party", "link_field": null, "site_fallback": false}, {"key": "hlc_procurement_contractor", "enabled": true, "target_register": "hlc", "output": "procurement_contractor", "source_register": "procurement", "source": "external_party", "link_field": "procurement_record_id", "site_fallback": true}, {"key": "car_dispatcher_procurement_contractor", "enabled": true, "target_register": "car_dispatcher", "output": "procurement_contractor", "source_register": "procurement", "source": "external_party", "link_field": "procurement_record_id", "site_fallback": false}, {"key": "car_dispatcher_procurement_pr_no", "enabled": true, "target_register": "car_dispatcher", "output": "procurement_pr_no", "source_register": "procurement", "source": "pr_no", "link_field": "procurement_record_id", "site_fallback": false}, {"key": "financial_advances_procurement_contractor", "enabled": true, "target_register": "financial_advances", "output": "procurement_contractor", "source_register": "procurement", "source": "external_party", "link_field": "procurement_record_id", "site_fallback": false}, {"key": "financial_advances_procurement_pr_no", "enabled": true, "target_register": "financial_advances", "output": "procurement_pr_no", "source_register": "procurement", "source": "pr_no", "link_field": "procurement_record_id", "site_fallback": false}, {"key": "warehouse_procurement_contractor", "enabled": true, "target_register": "warehouse", "output": "procurement_contractor", "source_register": "procurement", "source": "external_party", "link_field": "procurement_order_id", "site_fallback": false}, {"key": "warehouse_procurement_pr_no", "enabled": true, "target_register": "warehouse", "output": "procurement_pr_no", "source_register": "procurement", "source": "pr_no", "link_field": "procurement_order_id", "site_fallback": false}, {"key": "quality_procurement_contractor", "enabled": true, "target_register": "quality", "output": "procurement_contractor", "source_register": "procurement", "source": "external_party", "link_field": "procurement_order_id", "site_fallback": false}, {"key": "quality_procurement_pr_no", "enabled": true, "target_register": "quality", "output": "procurement_pr_no", "source_register": "procurement", "source": "pr_no", "link_field": "procurement_order_id", "site_fallback": false}, {"key": "issues_procurement_contractor", "enabled": true, "target_register": "issues", "output": "procurement_contractor", "source_register": "procurement", "source": "external_party", "link_field": "procurement_order_id", "site_fallback": false}, {"key": "issues_procurement_pr_no", "enabled": true, "target_register": "issues", "output": "procurement_pr_no", "source_register": "procurement", "source": "pr_no", "link_field": "procurement_order_id", "site_fallback": false}, {"key": "gecol_procurement_pr_no", "enabled": true, "target_register": "gecol", "output": "procurement_pr_no", "source_register": "procurement", "source": "pr_no", "link_field": null, "site_fallback": false}, {"key": "hlc_procurement_pr_no", "enabled": true, "target_register": "hlc", "output": "procurement_pr_no", "source_register": "procurement", "source": "pr_no", "link_field": "procurement_record_id", "site_fallback": true}]}'::jsonb,
        'Cross-register derive rules: a value a register shows from another register, computed on read, only the configured value (see migration 0363).',
        now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION derive_rules_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'rules', coalesce((SELECT s.value -> 'rules' FROM public.settings s WHERE s.key = 'derive.rules'), '[]'::jsonb),
    'version', coalesce((SELECT (s.value ->> 'version')::int FROM public.settings s WHERE s.key = 'derive.rules'), 0),
    'updated_at', (SELECT s.updated_at FROM public.settings s WHERE s.key = 'derive.rules'),
    'updated_by', (SELECT s.updated_by FROM public.settings s WHERE s.key = 'derive.rules'),
    'registers', (SELECT coalesce(jsonb_agg(jsonb_build_object('register_key', d.register_key,
                    'fields', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', f.code, 'label_en', f.label_en, 'label_ar', f.label_ar) ORDER BY f.sort_order), '[]'::jsonb)
                               FROM public.register_fields f WHERE f.register_key = d.register_key AND f.is_active)) ORDER BY d.register_key), '[]'::jsonb)
                  FROM public.register_definitions d))
$$;

CREATE OR REPLACE FUNCTION derive_values(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cfg jsonb; rule jsonb; rec record; src record; val jsonb; res jsonb := '{}'::jsonb; used text[] := ARRAY[]::text[]; k text; actor uuid := public.app_actor();
BEGIN
  IF p_ids IS NULL OR coalesce(array_length(p_ids, 1), 0) = 0 THEN RETURN res; END IF;
  SELECT value INTO cfg FROM public.settings WHERE key = 'derive.rules';
  IF cfg IS NULL OR jsonb_typeof(cfg -> 'rules') <> 'array' THEN RETURN res; END IF;
  FOR rec IN
    SELECT r.id, r.register_key, r.site_id, r.data FROM public.register_records r
    WHERE r.id = ANY (p_ids) AND public.app_region_read(r.is_global, r.region_id)
  LOOP
    FOR rule IN SELECT * FROM jsonb_array_elements(cfg -> 'rules') LOOP
      IF coalesce((rule ->> 'enabled')::boolean, true) IS NOT TRUE OR rule ->> 'target_register' <> rec.register_key THEN CONTINUE; END IF;
      val := NULL; src := NULL;
      IF rule ->> 'source' = 'external_party' THEN
        SELECT s.id, p.id AS pid, p.name, p.type::text AS ptype INTO src
          FROM public.register_records s JOIN public.external_parties p ON p.id = s.external_party_id
          WHERE s.register_key = rule ->> 'source_register' AND s.is_current AND s.state = 'approved' AND s.voided_at IS NULL
            AND ((coalesce(rule ->> 'link_field', '') <> '' AND (rec.data ->> (rule ->> 'link_field')) ~ '^[0-9a-f-]{36}$' AND (s.id::text = rec.data ->> (rule ->> 'link_field') OR s.entity_id::text = rec.data ->> (rule ->> 'link_field')))
                 OR ((coalesce(rule ->> 'link_field', '') = '' OR coalesce((rule ->> 'site_fallback')::boolean, false)) AND rec.site_id IS NOT NULL AND s.site_id = rec.site_id))
          ORDER BY (coalesce(rule ->> 'link_field', '') <> '' AND (s.id::text = rec.data ->> (rule ->> 'link_field') OR s.entity_id::text = rec.data ->> (rule ->> 'link_field'))) DESC, s.approved_at DESC NULLS LAST, s.id LIMIT 1;
        IF src.id IS NOT NULL THEN val := jsonb_build_object('id', src.pid::text, 'name', src.name, 'type', src.ptype); END IF;
      ELSE
        SELECT s.id, s.data -> (rule ->> 'source') AS v INTO src
          FROM public.register_records s
          WHERE s.register_key = rule ->> 'source_register' AND s.is_current AND s.state = 'approved' AND s.voided_at IS NULL
            AND coalesce(s.data ->> (rule ->> 'source'), '') <> ''
            AND ((coalesce(rule ->> 'link_field', '') <> '' AND (rec.data ->> (rule ->> 'link_field')) ~ '^[0-9a-f-]{36}$' AND (s.id::text = rec.data ->> (rule ->> 'link_field') OR s.entity_id::text = rec.data ->> (rule ->> 'link_field')))
                 OR ((coalesce(rule ->> 'link_field', '') = '' OR coalesce((rule ->> 'site_fallback')::boolean, false)) AND rec.site_id IS NOT NULL AND s.site_id = rec.site_id))
          ORDER BY (coalesce(rule ->> 'link_field', '') <> '' AND (s.id::text = rec.data ->> (rule ->> 'link_field') OR s.entity_id::text = rec.data ->> (rule ->> 'link_field'))) DESC, s.approved_at DESC NULLS LAST, s.id LIMIT 1;
        IF src.id IS NOT NULL THEN val := src.v; END IF;
      END IF;
      IF val IS NOT NULL THEN
        res := jsonb_set(res, ARRAY[rec.id::text], coalesce(res -> rec.id::text, '{}'::jsonb) || jsonb_build_object(rule ->> 'output', val), true);
        IF NOT (rule ->> 'key') = ANY (used) THEN used := used || (rule ->> 'key'); END IF;
      END IF;
    END LOOP;
  END LOOP;
  -- audit: a person reading a value taken from another register is logged once per rule per 10 minutes (lists do not flood the log)
  IF actor IS NOT NULL THEN
    FOREACH k IN ARRAY used LOOP
      IF NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'derive_disclosed' AND a.entity_id = k AND a.actor_id = actor AND a.at > now() - interval '10 minutes') THEN
        PERFORM public.log_audit_write('derive_disclosed', 'setting', k, NULL,
          jsonb_build_object('rule', k, 'records_read', (SELECT count(*) FROM jsonb_object_keys(res))), 'derive value shown from another register');
      END IF;
    END LOOP;
  END IF;
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION admin_save_derive_rules(p_config jsonb, p_reason text, p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cur jsonb; before jsonb; after jsonb; errs jsonb := '[]'::jsonb; v int; r jsonb; i int := 0; keys text[] := ARRAY[]::text[]; outs text[] := ARRAY[]::text[]; kk text;
BEGIN
  PERFORM public.calc_require_admin('admin.settings', true);
  PERFORM public.calc_require_reason(p_reason);
  PERFORM 1 FROM public.settings WHERE key = 'derive.rules' FOR UPDATE;
  SELECT value INTO cur FROM public.settings WHERE key = 'derive.rules';
  v := coalesce((cur ->> 'version')::int, 0);
  IF p_version IS NOT NULL AND p_version <> v THEN PERFORM public.wf_err('precondition_failed'); END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' OR jsonb_typeof(p_config -> 'rules') IS DISTINCT FROM 'array' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/', 'invalid', 'An object with the list of rules.')));
  END IF;
  IF jsonb_array_length(p_config -> 'rules') > 60 THEN errs := errs || public.reg_err_item('/rules', 'too_many', 'At most 60 rules.'); END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_config -> 'rules') LOOP
    IF jsonb_typeof(r) <> 'object' THEN errs := errs || public.reg_err_item('/rules/' || i, 'invalid', 'A rule is an object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(r) LOOP
        IF kk NOT IN ('key', 'enabled', 'target_register', 'output', 'source_register', 'source', 'link_field', 'site_fallback') THEN errs := errs || public.reg_err_item('/rules/' || i || '/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF coalesce(r ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,59}$' THEN errs := errs || public.reg_err_item('/rules/' || i || '/key', 'invalid', 'A lower-case code.');
      ELSIF (r ->> 'key') = ANY (keys) THEN errs := errs || public.reg_err_item('/rules/' || i || '/key', 'duplicate', 'Rule keys are unique.');
      ELSE keys := keys || (r ->> 'key'); END IF;
      IF jsonb_typeof(r -> 'enabled') IS DISTINCT FROM 'boolean' THEN errs := errs || public.reg_err_item('/rules/' || i || '/enabled', 'required', 'true or false.'); END IF;
      IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r ->> 'target_register') THEN errs := errs || public.reg_err_item('/rules/' || i || '/target_register', 'unknown_register', 'Not a register.'); END IF;
      IF NOT EXISTS (SELECT 1 FROM public.register_definitions d WHERE d.register_key = r ->> 'source_register') THEN errs := errs || public.reg_err_item('/rules/' || i || '/source_register', 'unknown_register', 'Not a register.');
      ELSIF r ->> 'source_register' = r ->> 'target_register' THEN errs := errs || public.reg_err_item('/rules/' || i || '/source_register', 'same_register', 'A rule reads from ANOTHER register.'); END IF;
      IF coalesce(r ->> 'output', '') !~ '^[a-z][a-z0-9_]{0,40}$' THEN errs := errs || public.reg_err_item('/rules/' || i || '/output', 'invalid', 'A lower-case name.');
      ELSIF (r ->> 'target_register') || '.' || (r ->> 'output') = ANY (outs) THEN errs := errs || public.reg_err_item('/rules/' || i || '/output', 'duplicate', 'This register already has this output.');
      ELSE outs := outs || ((r ->> 'target_register') || '.' || (r ->> 'output')); END IF;
      IF r ? 'site_fallback' AND jsonb_typeof(r -> 'site_fallback') <> 'boolean' THEN errs := errs || public.reg_err_item('/rules/' || i || '/site_fallback', 'invalid', 'true or false.'); END IF;
      IF coalesce(r ->> 'source', '') <> 'external_party' AND NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = r ->> 'source_register' AND f.code = r ->> 'source' AND f.is_active) THEN
        errs := errs || public.reg_err_item('/rules/' || i || '/source', 'unknown_field', 'external_party or a field of the source register.');
      END IF;
      IF jsonb_typeof(r -> 'link_field') IS DISTINCT FROM 'null' AND r -> 'link_field' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.register_fields f WHERE f.register_key = r ->> 'target_register' AND f.code = r ->> 'link_field' AND f.is_active) THEN
        errs := errs || public.reg_err_item('/rules/' || i || '/link_field', 'unknown_field', 'A field of the target register, or null.');
      END IF;
    END IF;
    i := i + 1;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  before := public.derive_rules_json() - 'registers' - 'updated_at' - 'updated_by';
  INSERT INTO public.settings (key, value, description, updated_by, updated_at)
  VALUES ('derive.rules', jsonb_build_object('rules', p_config -> 'rules', 'version', v + 1),
          'Cross-register derive rules: a value a register shows from another register, computed on read, only the configured value (see migration 0363).', public.app_actor(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  after := public.derive_rules_json();
  PERFORM public.log_audit_write('derive_rules_update', 'setting', 'derive.rules', before, after - 'registers' - 'updated_at' - 'updated_by', btrim(p_reason));
  RETURN after;
END $$;

GRANT SELECT ON settings, register_records, external_parties, register_definitions, register_fields, audit_log TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['derive_rules_json()', 'derive_values(uuid[])', 'admin_save_derive_rules(jsonb,text,integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_app', f); END IF;
  END LOOP;
END $$;
