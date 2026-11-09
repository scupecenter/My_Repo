-- Changelog 116: an actual date is "in the future" against the Tripoli calendar day (cal_today()), not the server's
-- current_date. Between midnight in Tripoli and midnight UTC a user entering today's date was refused.
-- Bodies are copied unchanged from their latest migration, with only that comparison changed.

CREATE OR REPLACE FUNCTION reg_clean_cell(p_col jsonb, v jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t text := v #>> '{}'; d date; u uuid; c text;
BEGIN
  CASE p_col ->> 'type'
    WHEN 'text' THEN
      IF jsonb_typeof(v) <> 'string' OR length(t) > 2000 THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid', 'Text up to 2000 characters.')); END IF;
      RETURN jsonb_build_object('v', btrim(t));
    WHEN 'number' THEN
      IF jsonb_typeof(v) NOT IN ('number', 'string') OR t !~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid', 'A number.')); END IF;
      RETURN jsonb_build_object('v', t::numeric);
    WHEN 'yes_no' THEN
      IF jsonb_typeof(v) <> 'boolean' THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid', 'true or false.')); END IF;
      RETURN jsonb_build_object('v', v);
    WHEN 'date' THEN
      IF jsonb_typeof(v) <> 'string' OR t !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid_date', 'A date as YYYY-MM-DD.')); END IF;
      BEGIN d := t::date; EXCEPTION WHEN others THEN d := NULL; END;
      IF d IS NULL OR d::text <> t THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid_date', 'Not a calendar date.')); END IF;
      IF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN RETURN jsonb_build_object('e', jsonb_build_array('invalid_date', 'The date must be between 2020-01-01 and 2035-12-31.')); END IF;
      IF coalesce((p_col ->> 'is_actual')::boolean, false) AND d > public.cal_today() THEN RETURN jsonb_build_object('e', jsonb_build_array('future_date', 'An actual date cannot be in the future.')); END IF;
      RETURN jsonb_build_object('v', t);
    WHEN 'user' THEN
      u := CASE WHEN jsonb_typeof(v) = 'string' THEN public.reg_pick_user(t) END;
      IF u IS NULL THEN RETURN jsonb_build_object('e', jsonb_build_array('unknown_user', 'Unknown user: give the 4-digit employee ID or the e-mail of one user.')); END IF;
      RETURN jsonb_build_object('v', u::text);
    WHEN 'list_code' THEN
      c := CASE WHEN jsonb_typeof(v) = 'string' THEN public.reg_list_value(p_col ->> 'list_catalogue', t) END;
      IF c IS NULL THEN RETURN jsonb_build_object('e', jsonb_build_array('not_in_list', 'Not a value of the list.')); END IF;
      RETURN jsonb_build_object('v', c);
    WHEN 'task' THEN
      IF jsonb_typeof(v) <> 'string' OR t !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR NOT EXISTS (SELECT 1 FROM public.task_instances ti WHERE ti.id = t::uuid AND public.app_region_check(ti.region_id)) THEN
        RETURN jsonb_build_object('e', jsonb_build_array('unknown_task', 'Unknown task, or a task outside your regions.'));
      END IF;
      RETURN jsonb_build_object('v', lower(t));
    ELSE
      RETURN jsonb_build_object('e', jsonb_build_array('invalid', 'Unknown column type.'));
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION reg_clean_data(p_key text, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  k text; v jsonb; f public.register_fields%ROWTYPE; out jsonb := '{}'::jsonb; errs jsonb := '[]'::jsonb; t text; d date; refused jsonb;
  opts jsonb; items text[]; x text; arr jsonb; u uuid; i int; row_ jsonb; rk text; rv jsonb; col jsonb; cell jsonb; clean_row jsonb; ids text[]; rid text;
  closing jsonb; st text; maxn int; c text;
BEGIN
  IF p_patch IS NULL THEN RETURN out; END IF;
  SELECT dd.rules -> 'refused_scopes' INTO refused FROM public.register_definitions dd WHERE dd.register_key = p_key;
  IF jsonb_typeof(p_patch) <> 'object' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/data', 'code', 'invalid', 'message', 'data must be an object.'))));
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_patch) LOOP
    SELECT * INTO f FROM public.register_fields x WHERE x.register_key = p_key AND x.code = k AND x.is_active;
    IF NOT FOUND THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'unknown_field', 'message', 'This field does not exist in the register.'));
      CONTINUE;
    END IF;
    IF f.derived THEN
      errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'field_read_only', 'message', 'This value comes from the approval and cannot be typed (Q45).'));
      CONTINUE;
    END IF;
    IF jsonb_typeof(v) = 'null' OR (jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') = '') OR (jsonb_typeof(v) = 'array' AND jsonb_array_length(v) = 0) THEN
      out := out || jsonb_build_object(k, NULL); CONTINUE;
    END IF;
    t := v #>> '{}';
    CASE f.field_type
      WHEN 'text' THEN
        IF jsonb_typeof(v) <> 'string' OR length(t) > 2000 THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'Text up to 2000 characters.'));
        ELSE out := out || jsonb_build_object(k, btrim(t)); END IF;
      WHEN 'number' THEN
        IF jsonb_typeof(v) NOT IN ('number', 'string') OR t !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A number.'));
        ELSE out := out || jsonb_build_object(k, t::numeric); END IF;
      WHEN 'yes_no' THEN
        IF jsonb_typeof(v) <> 'boolean' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'true or false.'));
        ELSE out := out || jsonb_build_object(k, v); END IF;
      WHEN 'date' THEN
        IF jsonb_typeof(v) <> 'string' OR t !~ '^\d{4}-\d{2}-\d{2}$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid_date', 'message', 'A date as YYYY-MM-DD.'));
        ELSE
          BEGIN
            d := t::date;
          EXCEPTION WHEN others THEN d := NULL;
          END;
          IF d IS NULL OR d::text <> t THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid_date', 'message', 'Not a calendar date.'));
          ELSIF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid_date', 'message', 'The date must be between 2020-01-01 and 2035-12-31.'));
          ELSIF f.is_actual AND d > public.cal_today() THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'future_date', 'message', 'An actual date cannot be in the future.'));
          ELSE out := out || jsonb_build_object(k, t); END IF;
        END IF;
      WHEN 'list', 'list_code' THEN
        IF f.field_type = 'list_code' AND coalesce((f.options ->> 'multiple')::boolean, false) THEN
          -- several codes: a JSON array, or a text separated by ";" (templates)
          items := public.reg_split_values(v);
          IF items IS NULL THEN
            errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A list of values.'));
          ELSE
            arr := '[]'::jsonb;
            FOREACH x IN ARRAY items LOOP
              c := public.reg_list_value(f.list_catalogue, x);
              IF c IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'not_in_list', 'message', '"' || left(x, 80) || '" is not a value of the list.'));
              ELSIF NOT arr ? c THEN arr := arr || to_jsonb(c); END IF;
            END LOOP;
            out := out || jsonb_build_object(k, arr);
          END IF;
        ELSIF jsonb_typeof(v) <> 'string' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A text from the list.'));
        ELSIF k = 'scope' AND refused IS NOT NULL AND jsonb_typeof(refused) = 'object' AND refused ? t THEN
          -- Q56 ownership: a purchase request of another team's register is refused with a pointer to its register (rule parameters are data)
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/scope', 'code', 'wrong_register',
            'message', 'Enter this request in the ' || (refused ->> t) || ' register (each team enters its own purchase requests, Q56).'));
        ELSIF f.list_catalogue IS NOT NULL THEN
          c := public.reg_list_value(f.list_catalogue, t);
          IF c IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'not_in_list', 'message', 'Not a value of the list.'));
          ELSE out := out || jsonb_build_object(k, c); END IF;
        ELSE
          opts := f.options;
          IF opts IS NULL THEN out := out || jsonb_build_object(k, btrim(t));
          ELSIF jsonb_typeof(opts) = 'object' AND opts ->> 'source' = 'permit_types' THEN
            IF EXISTS (SELECT 1 FROM public.permit_types pt WHERE pt.code = t AND pt.is_active) THEN out := out || jsonb_build_object(k, t);
            ELSE errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'not_in_list', 'message', 'Not a permit type of the list.')); END IF;
          ELSIF jsonb_typeof(opts) = 'array' AND opts ? t THEN out := out || jsonb_build_object(k, t);
          ELSE errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'not_in_list', 'message', 'Not a value of the list.')); END IF;
        END IF;
      WHEN 'external_team' THEN
        IF jsonb_typeof(v) <> 'string' OR t !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM public.external_teams x WHERE x.id = t::uuid AND x.is_active) THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'unknown_team', 'message', 'Unknown or inactive team.'));
        ELSE out := out || jsonb_build_object(k, lower(t)); END IF;
      WHEN 'user' THEN
        IF jsonb_typeof(v) <> 'string' OR t !~* '^[0-9a-f-]{36}$' OR NOT EXISTS (SELECT 1 FROM public.users x WHERE x.id = t::uuid) THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'unknown_user', 'message', 'Unknown user.'));
        ELSE out := out || jsonb_build_object(k, lower(t)); END IF;
      WHEN 'multi_user' THEN
        items := public.reg_split_values(v);
        IF items IS NULL OR cardinality(items) > 200 THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A list of up to 200 people.'));
        ELSE
          arr := '[]'::jsonb; i := 0;
          FOREACH x IN ARRAY items LOOP
            u := public.reg_pick_user(x);
            IF u IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i, 'code', 'unknown_user', 'message', 'Unknown user: "' || left(x, 80) || '".'));
            ELSIF NOT arr ? u::text THEN arr := arr || to_jsonb(u::text); END IF;
            i := i + 1;
          END LOOP;
          out := out || jsonb_build_object(k, arr);
        END IF;
      WHEN 'multi_site' THEN
        items := public.reg_split_values(v);
        IF items IS NULL OR cardinality(items) > 500 THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A list of up to 500 sites.'));
        ELSE
          arr := '[]'::jsonb; i := 0;
          FOREACH x IN ARRAY items LOOP
            u := public.reg_pick_site(x);
            IF u IS NULL THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i, 'code', 'unknown_site', 'message', 'Unknown site, or a site outside your regions: "' || left(x, 80) || '".'));
            ELSIF NOT arr ? u::text THEN arr := arr || to_jsonb(u::text); END IF;
            i := i + 1;
          END LOOP;
          out := out || jsonb_build_object(k, arr);
        END IF;
      WHEN 'warehouse_item' THEN
        SELECT w.id INTO u FROM public.warehouse_items w
        WHERE jsonb_typeof(v) = 'string' AND (CASE WHEN btrim(t) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN w.id = btrim(t)::uuid ELSE upper(w.item_code) = upper(btrim(t)) END)
        LIMIT 1;
        IF NOT FOUND THEN errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'unknown_warehouse_item', 'message', 'No Warehouse item has this id or code.'));
        ELSE out := out || jsonb_build_object(k, u::text); END IF;
      WHEN 'file' THEN
        -- the id of a file uploaded into a document slot of the record; that it belongs to the record is checked at submit (Q111: a typed reference is not an upload)
        IF jsonb_typeof(v) <> 'string' OR btrim(t) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'The id of a file uploaded to the record.'));
        ELSE out := out || jsonb_build_object(k, lower(btrim(t))); END IF;
      WHEN 'child_list' THEN
        maxn := coalesce((f.options ->> 'max_rows')::int, 200);
        closing := f.options -> 'closing';
        IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > maxn THEN
          errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k, 'code', 'invalid', 'message', 'A list of up to ' || maxn || ' rows.'));
        ELSE
          arr := '[]'::jsonb; ids := ARRAY[]::text[]; i := 0;
          FOR row_ IN SELECT * FROM jsonb_array_elements(v) LOOP
            IF jsonb_typeof(row_) <> 'object' THEN
              errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i, 'code', 'invalid', 'message', 'A row is an object.'));
              i := i + 1; CONTINUE;
            END IF;
            clean_row := '{}'::jsonb;
            -- every row keeps a stable id (given back by the server on the first save), so a row is never entered twice
            rid := row_ ->> 'id';
            IF rid IS NULL THEN rid := gen_random_uuid()::text;
            ELSIF rid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR lower(rid) = ANY (ids) THEN
              errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/id', 'code', 'invalid', 'message', 'Each row has its own id.'));
            END IF;
            rid := lower(rid); ids := ids || rid;
            clean_row := jsonb_build_object('id', rid);
            FOR rk, rv IN SELECT * FROM jsonb_each(row_) LOOP
              CONTINUE WHEN rk = 'id';
              IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(f.options -> 'columns', '[]'::jsonb)) cc WHERE cc ->> 'code' = rk) THEN
                errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || rk, 'code', 'unknown_field', 'message', 'This column does not exist.'));
              END IF;
            END LOOP;
            FOR col IN SELECT * FROM jsonb_array_elements(coalesce(f.options -> 'columns', '[]'::jsonb)) LOOP
              rv := row_ -> (col ->> 'code');
              IF rv IS NULL OR jsonb_typeof(rv) = 'null' OR (jsonb_typeof(rv) = 'string' AND btrim(rv #>> '{}') = '') THEN
                IF coalesce((col ->> 'required')::boolean, false) THEN
                  errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || (col ->> 'code'), 'code', 'required', 'message', coalesce(col ->> 'label_en', col ->> 'code') || ' is required.'));
                END IF;
                CONTINUE;
              END IF;
              cell := public.reg_clean_cell(col, rv);
              IF cell ? 'e' THEN
                errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || (col ->> 'code'), 'code', cell -> 'e' ->> 0, 'message', cell -> 'e' ->> 1));
              ELSE clean_row := clean_row || jsonb_build_object(col ->> 'code', cell -> 'v'); END IF;
            END LOOP;
            -- a status of the group "closed" needs the closed date; any other status has none (Q12)
            IF closing IS NOT NULL AND clean_row ? (closing ->> 'status') THEN
              st := clean_row ->> (closing ->> 'status');
              IF EXISTS (SELECT 1 FROM public.list_values lv, jsonb_array_elements(f.options -> 'columns') cc
                         WHERE cc ->> 'code' = closing ->> 'status' AND lv.catalogue_code = cc ->> 'list_catalogue' AND lv.code = st AND (closing ->> 'group') = ANY (lv.groups)) THEN
                IF NOT clean_row ? (closing ->> 'date') THEN
                  errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || (closing ->> 'date'), 'code', 'required', 'message', 'A closed action needs its closed date.'));
                END IF;
              ELSIF clean_row ? (closing ->> 'date') THEN
                errs := errs || jsonb_build_array(jsonb_build_object('path', '/data/' || k || '/' || i || '/' || (closing ->> 'date'), 'code', 'not_closed', 'message', 'Only a closed action has a closed date.'));
              END IF;
            END IF;
            arr := arr || jsonb_build_array(clean_row);
            i := i + 1;
          END LOOP;
          out := out || jsonb_build_object(k, arr);
        END IF;
    END CASE;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION wf_start(p_task uuid, p_version int, p_start date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; sid uuid; d date := coalesce(p_start, public.cal_today()); pin uuid; cnt int;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF t.state <> 'open' THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a pending task can be started (it is ' || t.state::text || ').'));
  END IF;
  IF d > public.cal_today() OR d < DATE '2020-01-01' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/actual_start', 'code', 'invalid_date', 'message', 'The start date cannot be in the future.'))));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(p_task, 'entry', actor);
  before := public.wf_snap(p_task);
  SELECT count(*) INTO cnt FROM public.wf_eligible(p_task, 'entry');
  pin := CASE WHEN cnt > 1 THEN actor ELSE t.ball_in_court_user_id END;
  UPDATE public.task_instances SET state = 'entry', current_level = 1, actual_start = d, ball_in_court_user_id = pin, version = version + 1, updated_at = now() WHERE id = p_task;
  sid := public.wf_step(p_task, 1, 'start', actor, NULL, t.state, 'entry', false, false);
  PERFORM public.wf_audit('task_start', p_task, before, public.wf_snap(p_task), NULL);
  RETURN jsonb_build_object('step_ids', jsonb_build_array(sid), 'skipped_levels', '[]'::jsonb, 'unlocked_task_ids', '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION wf_save_entry(p_task uuid, p_version int, p_patch jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); t public.task_instances%ROWTYPE; before jsonb; k text; d date; errs jsonb := '[]'::jsonb; cnt int; pin uuid; key text;
BEGIN
  t := public.wf_lock_task(p_task, p_version);
  IF t.state NOT IN ('open', 'entry') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Entry data can be saved only while the task is pending or ongoing (it is ' || t.state::text || ').'));
  END IF;
  PERFORM public.wf_require_grant(t.region_id, 'edit');
  PERFORM public.wf_require_actor(p_task, 'entry', actor);
  FOREACH key IN ARRAY ARRAY['actual_start', 'actual_date', 'planned_date'] LOOP
    IF p_patch ? key AND jsonb_typeof(p_patch->key) <> 'null' THEN
      d := (p_patch->>key)::date;
      IF d < DATE '2020-01-01' OR d > DATE '2035-12-31' THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || key, 'code', 'invalid_date', 'message', 'The date must be between 2020-01-01 and 2035-12-31.'));
      ELSIF key <> 'planned_date' AND d > public.cal_today() THEN
        errs := errs || jsonb_build_array(jsonb_build_object('path', '/' || key, 'code', 'future_date', 'message', 'An actual date cannot be in the future.'));
      END IF;
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  before := public.wf_snap(p_task);
  SELECT count(*) INTO cnt FROM public.wf_eligible(p_task, 'entry');
  pin := CASE WHEN t.ball_in_court_user_id IS NULL AND cnt > 1 THEN actor ELSE t.ball_in_court_user_id END;
  UPDATE public.task_instances SET
    actual_start = CASE WHEN p_patch ? 'actual_start' THEN (p_patch->>'actual_start')::date ELSE actual_start END,
    actual_date  = CASE WHEN p_patch ? 'actual_date'  THEN (p_patch->>'actual_date')::date  ELSE actual_date END,
    planned_date = CASE WHEN p_patch ? 'planned_date' THEN (p_patch->>'planned_date')::date ELSE planned_date END,
    values = CASE WHEN p_patch ? 'values' AND jsonb_typeof(p_patch->'values') = 'object' THEN coalesce(values, '{}'::jsonb) || (p_patch->'values') ELSE values END,
    ball_in_court_user_id = pin, version = version + 1, updated_at = now()
  WHERE id = p_task;
  PERFORM public.wf_audit('task_entry_update', p_task, before, public.wf_snap(p_task) || jsonb_build_object('values', (SELECT values FROM public.task_instances WHERE id = p_task)), NULL);
END $$;
