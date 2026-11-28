-- Migration 0564 (hardening layer 3b, owner choices 1b and 2 of 2026-11-27): the approved template of the Daily Plan, TPL-DAILY-PLAN, and its import.
-- Additive. The plan stays written only through the doors of 0149 (dp_add_site, dp_save_row, dp_remove_site): the import calls them, row by row, so the region
-- scope, the Matrix level (L1 edits), the lock, the audit and the version of the plan are enforced there and nowhere else.
--   1. Template kind daily_plan; tpl_daily_plan_columns(); the definition TPL-DAILY-PLAN and its first version; tpl_sync (latest 0145) patched in place.
--   2. dp_import_rows(rows, meta): all or nothing. What a file may change: the Reason, the Remark, the manual values of the auto-filled columns that dp_save_row
--      accepts (a cell equal to the value now shown is not a change; an empty cell changes nothing), a site added by hand (a row for a site not in the plan) and
--      a site removed by hand (the column "Remove from plan" = yes). Site name and Region are read-only and ignored. A locked day, a site of a region the actor
--      may not edit and every other refusal are reported per row (/rows/<line>/<field>) and the whole file is refused.

ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_kind_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_kind_check
  CHECK (kind IN ('register', 'stream', 'master', 'sites', 'list_values', 'holidays', 'daily_plan'));
ALTER TABLE template_definitions DROP CONSTRAINT template_definitions_scope_check;
ALTER TABLE template_definitions ADD CONSTRAINT template_definitions_scope_check CHECK (
  (kind = 'register' AND register_key IS NOT NULL AND stream_code IS NULL)
  OR (kind = 'stream' AND stream_code IS NOT NULL AND register_key IS NULL)
  OR (kind IN ('master', 'sites', 'list_values', 'holidays', 'daily_plan') AND register_key IS NULL AND stream_code IS NULL));

CREATE OR REPLACE FUNCTION tpl_daily_plan_columns() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('code', 'plan_date',    'header', 'Plan date (YYYY-MM-DD)',     'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'site_code',    'header', 'Site ID',                    'type', 'text', 'kind', 'field', 'required', true,  'derived', false),
    jsonb_build_object('code', 'site_name',    'header', 'Site name (read only)',      'type', 'text', 'kind', 'field', 'required', false, 'derived', true),
    jsonb_build_object('code', 'region',       'header', 'Region (read only)',         'type', 'text', 'kind', 'field', 'required', false, 'derived', true),
    jsonb_build_object('code', 'tower_owner',  'header', 'Tower Owner',                'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'owner_id',     'header', 'Owner ID',                   'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'latitude',     'header', 'Latitude',                   'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'longitude',    'header', 'Longitude',                  'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'site_type',    'header', 'Site Type',                  'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'sow',          'header', 'SOW',                        'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'contractor',   'header', 'Vendor / Contractor Name',   'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'aat_se',       'header', 'AAT SE',                     'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'access_valid', 'header', 'Access Valid',               'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'planned_work', 'header', 'Planned Work',               'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'actual_work',  'header', 'Actual Work',                'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'reason',       'header', 'Reason (if not reach target)', 'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'remark',       'header', 'Remark',                     'type', 'text', 'kind', 'field', 'required', false, 'derived', false),
    jsonb_build_object('code', 'remove',       'header', 'Remove from plan (yes)',     'type', 'text', 'kind', 'field', 'required', false, 'derived', false))
$$;

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, module_key, match_keys, sort_order, is_master_format)
VALUES ('TPL-DAILY-PLAN', 'Daily Plan', 'الخطة اليومية', 'daily_plan', 'daily_plan', NULL, '[["plan_date","site_code"]]', 5, false)
ON CONFLICT (template_id) DO NOTHING;

INSERT INTO template_versions (template_def_id, version, header_checksum, field_set_version, columns, is_current, field_set_hash, reason)
SELECT d.id, 1, public.tpl_header_checksum(public.tpl_daily_plan_columns()), 1, public.tpl_daily_plan_columns(), true,
       public.tpl_field_hash(public.tpl_daily_plan_columns()), 'first version'
FROM template_definitions d
WHERE d.template_id = 'TPL-DAILY-PLAN' AND NOT EXISTS (SELECT 1 FROM template_versions v WHERE v.template_def_id = d.id);
UPDATE template_definitions SET current_version = 1, updated_at = now() WHERE template_id = 'TPL-DAILY-PLAN' AND current_version < 1;

-- tpl_sync patched in place (no whole redefinition): one more branch for the kind, before the Master fallback. Idempotent.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.tpl_sync(text,text)'::regprocedure);
  IF position('daily_plan' IN def) = 0 THEN
    IF position('  ELSIF d.kind = ''holidays'' THEN' IN def) = 0 THEN RAISE EXCEPTION 'tpl_sync: the holidays branch is not where 0564 expects it'; END IF;
    def := replace(def, '  ELSIF d.kind = ''holidays'' THEN',
      '  ELSIF d.kind = ''daily_plan'' THEN' || E'\n' ||
      '    cols := public.tpl_daily_plan_columns(); h := public.tpl_field_hash(cols); cs := public.tpl_header_checksum(cols); why := ''daily plan template changed'';' || E'\n' ||
      '  ELSIF d.kind = ''holidays'' THEN');
    EXECUTE def;
  END IF;
END $$;

-- POST /daily-plans/import, after the API checked the file (size, xlsx guard, the _tpl sheet naming TPL-DAILY-PLAN and its current version, the header row).
-- p_rows = [{line, plan_date, site_code, tower_owner, ..., reason, remark, remove}] as read from the Data sheet; p_meta = {file_name, template_version}.
CREATE OR REPLACE FUNCTION dp_import_rows(p_rows jsonb, p_meta jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r jsonb; ln integer; d date; s public.sites%ROWTYPE; reg integer; pid uuid; st public.daily_plan_rows%ROWTYPE; cur jsonb; k text; v text; cv text; n1 numeric; n2 numeric;
  ov jsonb; body jsonb; visible boolean; rem boolean; errs jsonb := '[]'::jsonb; e jsonb; msg text; code text; extra jsonb; import_id uuid := gen_random_uuid();
  n_upd integer := 0; n_add integer := 0; n_rem integer := 0; n_same integer := 0; seen text[] := ARRAY[]::text[]; dedupe text;
BEGIN
  IF public.app_actor() IS NULL THEN RAISE EXCEPTION 'daily plan: no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/file', 'empty', 'The Data sheet has no row.')));
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    ln := (r ->> 'line')::integer;
    BEGIN
      d := NULL;
      IF coalesce(btrim(r ->> 'plan_date'), '') ~ '^\d{4}-\d{2}-\d{2}$' THEN
        BEGIN d := btrim(r ->> 'plan_date')::date; EXCEPTION WHEN others THEN d := NULL; END;
      END IF;
      IF d IS NULL THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', (public.reg_err_item('/plan_date', 'invalid', 'A date YYYY-MM-DD.'))));
      END IF;
      SELECT * INTO s FROM public.sites WHERE site_code = btrim(coalesce(r ->> 'site_code', ''));
      IF s.id IS NULL THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', (public.reg_err_item('/site_code', 'not_found', 'No site has this Site ID.'))));
      END IF;
      dedupe := d::text || '|' || s.id::text;
      IF dedupe = ANY (seen) THEN
        PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', (public.reg_err_item('/site_code', 'duplicate', 'This site appears twice for this date in the file.'))));
      END IF;
      seen := seen || dedupe;
      reg := s.region_id;
      rem := lower(btrim(coalesce(r ->> 'remove', ''))) IN ('yes', 'y', 'true', '1');
      SELECT id INTO pid FROM public.daily_plans WHERE region_id = reg AND plan_date = d;
      st := public.dp_stored(pid, s.id);
      visible := (st.id IS NOT NULL AND NOT st.removed AND (st.origin = 'added' OR EXISTS (SELECT 1 FROM public.dp_auto_sites(reg, d) a WHERE a.site_id = s.id)))
                 OR (st.id IS NULL AND EXISTS (SELECT 1 FROM public.dp_auto_sites(reg, d) a WHERE a.site_id = s.id));
      IF rem THEN
        IF NOT visible THEN
          PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', (public.reg_err_item('/remove', 'not_in_plan', 'The site is not in this plan, so it cannot be removed.'))));
        END IF;
        PERFORM public.dp_remove_site(reg, d, s.id, NULL);
        n_rem := n_rem + 1;
      ELSE
        IF NOT visible THEN
          PERFORM public.dp_add_site(reg, d, s.site_code, NULL);
          n_add := n_add + 1;
          SELECT id INTO pid FROM public.daily_plans WHERE region_id = reg AND plan_date = d;
          st := public.dp_stored(pid, s.id);
        END IF;
        cur := public.dp_row_json(reg, d, s.id, st);
        ov := '{}'::jsonb;
        FOREACH k IN ARRAY public.dp_override_keys() LOOP
          v := btrim(coalesce(r ->> k, ''));
          cv := btrim(coalesce(cur -> 'values' ->> k, ''));
          IF v = '' OR v = cv THEN CONTINUE; END IF;
          IF k IN ('latitude', 'longitude') THEN
            BEGIN n1 := v::numeric; n2 := cv::numeric; EXCEPTION WHEN others THEN n1 := NULL; n2 := NULL; END;
            IF n1 IS NOT NULL AND n2 IS NOT NULL AND n1 = n2 THEN CONTINUE; END IF;
          END IF;
          ov := ov || jsonb_build_object(k, v);
        END LOOP;
        body := '{}'::jsonb;
        IF ov <> '{}'::jsonb THEN body := body || jsonb_build_object('overrides', ov); END IF;
        v := btrim(coalesce(r ->> 'reason', ''));
        IF v <> '' AND v IS DISTINCT FROM btrim(coalesce(cur ->> 'reason', '')) THEN body := body || jsonb_build_object('reason', v); END IF;
        v := btrim(coalesce(r ->> 'remark', ''));
        IF v <> '' AND v IS DISTINCT FROM btrim(coalesce(cur ->> 'remark', '')) THEN body := body || jsonb_build_object('remark', v); END IF;
        IF body = '{}'::jsonb THEN
          n_same := n_same + 1;
        ELSE
          PERFORM public.dp_save_row(reg, d, s.id, body, NULL);
          n_upd := n_upd + 1;
        END IF;
      END IF;
    EXCEPTION WHEN others THEN
      msg := SQLERRM;
      IF msg LIKE 'wf:%:%' THEN
        code := split_part(msg, ':', 2);
        BEGIN extra := substr(msg, length('wf:' || code || ':') + 1)::jsonb; EXCEPTION WHEN others THEN extra := '{}'::jsonb; END;
        IF jsonb_typeof(extra -> 'errors') = 'array' THEN
          FOR e IN SELECT * FROM jsonb_array_elements(extra -> 'errors') LOOP
            errs := errs || jsonb_build_array(jsonb_set(e, '{path}', to_jsonb('/rows/' || ln || replace(coalesce(e ->> 'path', '/'), '/overrides/', '/'))));
          END LOOP;
        ELSE
          errs := errs || public.reg_err_item('/rows/' || ln, code, coalesce(extra ->> 'detail', 'The row was refused.'));
        END IF;
      ELSE
        errs := errs || public.reg_err_item('/rows/' || ln, 'invalid', 'The row could not be applied.');
      END IF;
    END;
    EXIT WHEN jsonb_array_length(errs) >= 100;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs));
  END IF;
  PERFORM public.log_audit_write('daily_plan.template_import', 'daily_plan_import', import_id::text, NULL,
    jsonb_build_object('file_name', p_meta ->> 'file_name', 'template_version', p_meta -> 'template_version', 'rows', jsonb_array_length(p_rows),
                       'updated', n_upd, 'added', n_add, 'removed', n_rem, 'unchanged', n_same), NULL);
  RETURN jsonb_build_object('id', import_id, 'rows', jsonb_array_length(p_rows), 'updated', n_upd, 'added', n_add, 'removed', n_rem, 'unchanged', n_same);
END $$;

GRANT SELECT ON sites, daily_plans TO pmis_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['tpl_daily_plan_columns()', 'dp_import_rows(jsonb,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION dp_import_rows(jsonb,jsonb) TO pmis_app;
  END IF;
END $$;
