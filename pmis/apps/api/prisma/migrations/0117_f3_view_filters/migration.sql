-- 0117_f3_view_filters: AND/OR filter builder inside saved views, and views shared with a region (F3 of the features build plan of 2026-11-14,
-- owner-approved; contract 0.15.31, CHANGELOG 154).
-- Mirror: db/sql/116_f3_view_filters.sql (kept byte-identical).
--
-- WHAT.
--   1. The filter tree. A saved view may hold, beside the screen's simple filters, the key `filters.advanced`: a group
--      {"op": "and" | "or", "items": [...]} whose items are conditions {"field", "operator", "value"} or groups of conditions (two levels at
--      most: the root group and its groups). The API validates the tree against the field whitelist of the list screen and compiles it to
--      parameterised SQL (apps/api/src/views/filter-compiler.ts); the client never sends SQL and never a field outside the whitelist. The
--      database repeats the shape and the size limits (sv_check_tree, called by sv_check_body) so a stored tree is always small:
--      at most 20 items per group, 10 groups, 50 conditions, 100 values per condition, 200 characters per value.
--   2. Hidden fields are never filterable by a reader who cannot see them. sv_hidden_filter_field decides it for a field id of the tree:
--      `f:<code>` on a register screen keeps the rule of sv_hidden_column (0065); `c:<code>` on a sites screen is a site custom field and is
--      hidden when it is unknown, inactive, not offered in list filters or hidden for the reader by a field rule. sv_strip (redefined from
--      0065) removes such conditions from the tree as it removes hidden columns, and counts them in stripped_columns; the API refuses them
--      with 422 unknown_field when a list is filtered (sv_filter_hidden, a door of the application role).
--   3. Sharing with a region. A view may be shared with regions (saved_view_region_targets) beside roles, groups, users and everyone. A view
--      shared with region R is addressed to every user whose own view right on the screen's module covers R (B3: an all-regions holder and a
--      System Admin cover every region; open question Q560). A region-limited sharer may only name regions inside their own view right on
--      the module; views.share is still needed. Recipients read the view only (the owner, or views.manage, changes it), and the rows they see
--      are filtered by their own rights, never by the sharer's.
--   4. Two safe casts for the compiled SQL of custom values kept as text (sv_try_numeric, sv_try_date): a malformed value is NULL, never an
--      error that stops the list.
-- Every function written here is SECURITY DEFINER (but the two casts), owner pmis_definer, search_path pg_catalog, public, pg_temp, PUBLIC
-- revoked; the redefined functions are copied from 0065 (the latest definition) with the additions marked "0115".

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The regions a view is shared with
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE saved_view_region_targets (
  view_id   uuid NOT NULL REFERENCES saved_views(id) ON DELETE RESTRICT,
  region_id integer NOT NULL REFERENCES regions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  PRIMARY KEY (view_id, region_id)
);
CREATE INDEX saved_view_region_targets_region ON saved_view_region_targets (region_id);
ALTER TABLE saved_view_region_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view_region_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_select ON saved_view_region_targets FOR SELECT USING (app_is_seeding() OR EXISTS (SELECT 1 FROM saved_views v WHERE v.id = view_id));
CREATE POLICY rls_seed_write ON saved_view_region_targets FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding());

GRANT SELECT, INSERT, DELETE ON saved_view_region_targets TO pmis_definer;
GRANT SELECT ON regions TO pmis_definer;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Safe casts (not definer: they read nothing)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sv_try_numeric(p text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p IS NULL OR p !~ '^\s*-?[0-9]{1,15}(\.[0-9]{1,10})?\s*$' THEN RETURN NULL; END IF;
  RETURN btrim(p)::numeric;
END $$;

CREATE OR REPLACE FUNCTION sv_try_date(p text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p IS NULL OR p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN RETURN NULL; END IF;
  RETURN left(p, 10)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The filter tree: shape and limits (the API checks the same, and the fields)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sv_check_tree(p_tree jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE g jsonb; it jsonb; sub jsonb; v jsonb; groups int := 0; conds int := 0; k text;
  bad CONSTANT text := '{"errors":[{"path":"/filters/advanced","code":"invalid"}]}';
BEGIN
  IF p_tree IS NULL OR jsonb_typeof(p_tree) = 'null' THEN RETURN; END IF;
  IF length(p_tree::text) > 12000 THEN PERFORM public.sv_fail('validation_failed', 'The filter is larger than 12 KB.', bad::jsonb); END IF;
  -- the root group, then its items; a group inside a group may hold conditions only (two levels)
  FOR g IN SELECT p_tree UNION ALL SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_tree -> 'items') = 'array' THEN p_tree -> 'items' ELSE '[]' END) q(x) WHERE x ? 'items' LOOP
    IF jsonb_typeof(g) <> 'object' OR coalesce(g ->> 'op', '') NOT IN ('and', 'or') OR jsonb_typeof(g -> 'items') IS DISTINCT FROM 'array'
       OR jsonb_array_length(g -> 'items') > 20 THEN
      PERFORM public.sv_fail('validation_failed', 'A filter group has op and/or and at most 20 items.', bad::jsonb);
    END IF;
    FOR k IN SELECT jsonb_object_keys(g) LOOP
      IF k NOT IN ('op', 'items') THEN PERFORM public.sv_fail('validation_failed', 'Unknown key in a filter group.', bad::jsonb); END IF;
    END LOOP;
    IF g IS DISTINCT FROM p_tree THEN groups := groups + 1; END IF;
    FOR it IN SELECT x FROM jsonb_array_elements(g -> 'items') q(x) LOOP
      IF jsonb_typeof(it) <> 'object' THEN PERFORM public.sv_fail('validation_failed', 'A filter item is an object.', bad::jsonb); END IF;
      IF it ? 'items' THEN
        IF g IS DISTINCT FROM p_tree THEN PERFORM public.sv_fail('validation_failed', 'Filters nest two levels at most.', '{"errors":[{"path":"/filters/advanced","code":"too_deep"}]}'::jsonb); END IF;
        CONTINUE;
      END IF;
      conds := conds + 1;
      FOR k IN SELECT jsonb_object_keys(it) LOOP
        IF k NOT IN ('field', 'operator', 'value') THEN PERFORM public.sv_fail('validation_failed', 'Unknown key in a filter condition.', bad::jsonb); END IF;
      END LOOP;
      IF jsonb_typeof(it -> 'field') IS DISTINCT FROM 'string' OR (it ->> 'field') !~ '^([a-z][a-z0-9_]{0,60}|[fc]:[a-z][a-z0-9_]{0,60}|ms:[A-Z][A-Z0-9_]{0,30})$'
         OR jsonb_typeof(it -> 'operator') IS DISTINCT FROM 'string' OR (it ->> 'operator') !~ '^[a-z_]{2,20}$' THEN
        PERFORM public.sv_fail('validation_failed', 'A filter condition needs a field and an operator.', bad::jsonb);
      END IF;
      sub := it -> 'value';
      IF sub IS NOT NULL AND jsonb_typeof(sub) = 'array' THEN
        IF jsonb_array_length(sub) > 100 THEN PERFORM public.sv_fail('validation_failed', 'At most 100 values in a condition.', '{"errors":[{"path":"/filters/advanced","code":"too_many"}]}'::jsonb); END IF;
        FOR v IN SELECT x FROM jsonb_array_elements(sub) q(x) LOOP
          IF jsonb_typeof(v) NOT IN ('string', 'number', 'boolean', 'object') OR length(v::text) > 202 THEN
            PERFORM public.sv_fail('validation_failed', 'A filter value is not valid.', bad::jsonb);
          END IF;
        END LOOP;
      ELSIF sub IS NOT NULL AND (jsonb_typeof(sub) NOT IN ('string', 'number', 'boolean', 'object', 'null') OR length(sub::text) > 202) THEN
        PERFORM public.sv_fail('validation_failed', 'A filter value is not valid.', bad::jsonb);
      END IF;
    END LOOP;
  END LOOP;
  IF groups > 10 OR conds > 50 THEN
    PERFORM public.sv_fail('validation_failed', 'At most 10 groups and 50 conditions.', '{"errors":[{"path":"/filters/advanced","code":"too_many"}]}'::jsonb);
  END IF;
END $$;

-- Is this field of a filter tree hidden from the actor? Built-in field ids are decided by the API whitelist; f: and c: are checked here.
CREATE OR REPLACE FUNCTION sv_hidden_filter_field(p_screen text, p_field text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE fid uuid; acc text;
BEGIN
  IF p_field IS NULL THEN RETURN true; END IF;
  IF p_field ~ '^f:' THEN RETURN public.sv_hidden_column(p_screen, p_field); END IF;
  IF p_field ~ '^c:' THEN
    IF p_screen NOT IN ('sites', 'sites-stream') THEN RETURN true; END IF;
    SELECT f.id INTO fid FROM public.field_definitions f
      WHERE f.entity_type::text = 'site' AND f.code = substr(p_field, 3) AND f.is_active AND f.in_list_filters AND f.task_code IS NULL;
    IF fid IS NULL THEN RETURN true; END IF;
    IF public.app_actor_is_system_admin() THEN RETURN false; END IF;
    acc := public.app_resolve_field_access(public.app_actor(), fid)::text;
    RETURN coalesce(acc = 'hidden', false);
  END IF;
  RETURN false;
END $$;

-- Door of the API: which of these field ids are hidden from the signed-in actor on the screen (the compiler answers 422 unknown_field for them).
CREATE OR REPLACE FUNCTION sv_filter_hidden(p_screen text, p_fields text[]) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT f ORDER BY f), ARRAY[]::text[])
  FROM unnest(coalesce(p_fields, ARRAY[]::text[])) f
  WHERE public.app_actor() IS NULL OR public.sv_hidden_filter_field(p_screen, f)
$$;

-- The tree as the actor may see it: conditions on hidden fields are removed, groups left empty are removed. {tree, stripped}.
CREATE OR REPLACE FUNCTION sv_strip_tree(p_screen text, p_tree jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE out jsonb := '[]'::jsonb; sub jsonb; it jsonb; c jsonb; n int := 0;
BEGIN
  IF p_tree IS NULL OR jsonb_typeof(p_tree) <> 'object' OR jsonb_typeof(p_tree -> 'items') <> 'array' THEN
    RETURN jsonb_build_object('tree', p_tree, 'stripped', 0);
  END IF;
  FOR it IN SELECT x FROM jsonb_array_elements(p_tree -> 'items') q(x) LOOP
    IF jsonb_typeof(it) = 'object' AND jsonb_typeof(it -> 'items') = 'array' THEN
      sub := '[]'::jsonb;
      FOR c IN SELECT x FROM jsonb_array_elements(it -> 'items') q(x) LOOP
        IF public.sv_hidden_filter_field(p_screen, c ->> 'field') THEN n := n + 1; ELSE sub := sub || jsonb_build_array(c); END IF;
      END LOOP;
      IF jsonb_array_length(sub) > 0 THEN out := out || jsonb_build_array(jsonb_set(it, '{items}', sub)); END IF;
    ELSIF public.sv_hidden_filter_field(p_screen, it ->> 'field') THEN
      n := n + 1;
    ELSE
      out := out || jsonb_build_array(it);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('tree', jsonb_set(p_tree, '{items}', out), 'stripped', n);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Redefined from 0065
-- ---------------------------------------------------------------------------------------------------------------------
-- 0117: the advanced tree of the filters is stripped condition by condition (its hidden conditions count in `stripped`).
CREATE OR REPLACE FUNCTION sv_strip(p_screen text, p_filters jsonb, p_columns jsonb, p_sort jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE gone text[] := ARRAY[]::text[]; f jsonb := '{}'::jsonb; c jsonb := coalesce(p_columns, '{}'::jsonb); s jsonb := '[]'::jsonb; k text; e jsonb;
  tr jsonb; tn int := 0;
BEGIN
  FOR k IN SELECT jsonb_object_keys(coalesce(p_filters, '{}'::jsonb)) LOOP
    IF k = 'advanced' THEN
      tr := public.sv_strip_tree(p_screen, p_filters -> k);
      tn := (tr ->> 'stripped')::int;
      f := f || jsonb_build_object(k, tr -> 'tree');
    ELSIF public.sv_hidden_column(p_screen, k) THEN gone := gone || k; ELSE f := f || jsonb_build_object(k, p_filters -> k); END IF;
  END LOOP;
  IF jsonb_typeof(c -> 'order') = 'array' THEN
    SELECT coalesce(jsonb_agg(x ORDER BY o), '[]'::jsonb) INTO e FROM jsonb_array_elements_text(c -> 'order') WITH ORDINALITY q(x, o) WHERE NOT public.sv_hidden_column(p_screen, x);
    SELECT gone || coalesce(array_agg(x), ARRAY[]::text[]) INTO gone FROM jsonb_array_elements_text(c -> 'order') q(x) WHERE public.sv_hidden_column(p_screen, x);
    c := jsonb_set(c, '{order}', e);
  END IF;
  IF jsonb_typeof(c -> 'hidden') = 'array' THEN
    SELECT coalesce(jsonb_agg(x ORDER BY o), '[]'::jsonb) INTO e FROM jsonb_array_elements_text(c -> 'hidden') WITH ORDINALITY q(x, o) WHERE NOT public.sv_hidden_column(p_screen, x);
    c := jsonb_set(c, '{hidden}', e);
  END IF;
  IF jsonb_typeof(c -> 'width') = 'object' THEN
    SELECT coalesce(jsonb_object_agg(w.key, w.value), '{}'::jsonb) INTO e FROM jsonb_each(c -> 'width') w WHERE NOT public.sv_hidden_column(p_screen, w.key);
    c := jsonb_set(c, '{width}', e);
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(p_sort, '[]'::jsonb)) q(x) LOOP
    IF public.sv_hidden_column(p_screen, e ->> 'id') THEN gone := gone || (e ->> 'id'); ELSE s := s || jsonb_build_array(e); END IF;
  END LOOP;
  RETURN jsonb_build_object('filters', f, 'columns', c, 'sort', s,
    'stripped', (SELECT count(DISTINCT g) FROM unnest(gone) g) + tn);
END $$;

-- 0117: a view shared with regions is shared.
CREATE OR REPLACE FUNCTION sv_is_shared(p_view uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.saved_views v WHERE v.id = p_view AND v.share_everyone)
      OR EXISTS (SELECT 1 FROM public.saved_view_targets t WHERE t.view_id = p_view)
      OR EXISTS (SELECT 1 FROM public.saved_view_region_targets t WHERE t.view_id = p_view)
$$;

-- 0117: a region of the audience reaches the reader whose own view right on the screen's module covers it (decided for the signed-in actor
-- only, as sv_module_ok is; all regions = every region).
CREATE OR REPLACE FUNCTION sv_addressed_to(p_view uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.saved_views v WHERE v.id = p_view AND v.share_everyone)
      OR EXISTS (SELECT 1 FROM public.saved_view_targets t WHERE t.view_id = p_view AND t.target_kind = 'user' AND t.target_id = p_user)
      OR EXISTS (SELECT 1 FROM public.saved_view_targets t JOIN public.user_role_assignments a ON a.role_id = t.target_id AND a.user_id = p_user
                 WHERE t.view_id = p_view AND t.target_kind = 'role' AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()))
      OR EXISTS (SELECT 1 FROM public.saved_view_targets t JOIN public.group_members gm ON gm.group_id = t.target_id AND gm.user_id = p_user
                 JOIN public.groups g ON g.id = gm.group_id AND g.is_active
                 WHERE t.view_id = p_view AND t.target_kind = 'group')
      OR (p_user = public.app_actor() AND EXISTS (
            SELECT 1 FROM public.saved_view_region_targets t JOIN public.saved_views v ON v.id = t.view_id
            CROSS JOIN LATERAL (SELECT public.wf_actor_regions(public.sv_screen_module(v.screen_key), 'view'::"PermissionAction") AS r) x
            WHERE t.view_id = p_view AND public.sv_screen_module(v.screen_key) IS NOT NULL AND (x.r IS NULL OR t.region_id = ANY(x.r))))
$$;

-- 0117: the regions of the audience.
CREATE OR REPLACE FUNCTION sv_audience(p_view uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'everyone', coalesce((SELECT v.share_everyone FROM public.saved_views v WHERE v.id = p_view), false),
    'roles', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name_en', r.name_en, 'name_ar', r.name_ar) ORDER BY r.code COLLATE "C", r.id)
                       FROM public.saved_view_targets t JOIN public.roles r ON r.id = t.target_id WHERE t.view_id = p_view AND t.target_kind = 'role'), '[]'::jsonb),
    'groups', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.id)
                       FROM public.saved_view_targets t JOIN public.groups g ON g.id = t.target_id WHERE t.view_id = p_view AND t.target_kind = 'group'), '[]'::jsonb),
    'users', coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'display_name', u.display_name, 'employee_id', btrim(u.employee_id)) ORDER BY u.id)
                       FROM public.saved_view_targets t JOIN public.users u ON u.id = t.target_id WHERE t.view_id = p_view AND t.target_kind = 'user'), '[]'::jsonb),
    'regions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name_en', r.name_en, 'name_ar', r.name_ar) ORDER BY r.id)
                       FROM public.saved_view_region_targets t JOIN public.regions r ON r.id = t.region_id WHERE t.view_id = p_view), '[]'::jsonb))
$$;

-- 0117: region_ids in the audience (checked against the sharer's own view right on the screen's module when the sharer is region-limited).
CREATE OR REPLACE FUNCTION sv_set_audience(p_view uuid, p_aud jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid := public.sv_actor(); scope text; everyone boolean; k text; ids uuid[]; i uuid; v public.saved_views%ROWTYPE; empty boolean;
  same boolean; mgr boolean := public.sv_is_manager(); regs int[]; mine int[]; r int;
BEGIN
  IF p_aud IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p_aud) <> 'object' THEN PERFORM public.sv_fail('validation_failed', 'The audience is not valid.', '{"errors":[{"path":"/audience","code":"invalid"}]}'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_aud) LOOP
    IF k NOT IN ('everyone', 'role_ids', 'group_ids', 'user_ids', 'region_ids') THEN
      PERFORM public.sv_fail('validation_failed', 'Unknown audience field.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/' || k, 'code', 'unknown_field'))));
    END IF;
    IF k <> 'everyone' AND (jsonb_typeof(p_aud -> k) <> 'array' OR jsonb_array_length(p_aud -> k) > 100) THEN
      PERFORM public.sv_fail('validation_failed', 'The audience is not valid.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/' || k, 'code', 'invalid'))));
    END IF;
  END LOOP;
  BEGIN
    SELECT coalesce(array_agg(DISTINCT x::int ORDER BY x::int), ARRAY[]::int[]) INTO regs FROM jsonb_array_elements_text(coalesce(p_aud -> 'region_ids', '[]')) x;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    PERFORM public.sv_fail('validation_failed', 'A region id is not valid.', '{"errors":[{"path":"/audience/region_ids","code":"invalid"}]}');
  END;
  everyone := coalesce((p_aud ->> 'everyone')::boolean, false);
  SELECT * INTO v FROM public.saved_views WHERE id = p_view;
  empty := NOT everyone AND coalesce(jsonb_array_length(p_aud -> 'role_ids'), 0) + coalesce(jsonb_array_length(p_aud -> 'group_ids'), 0)
           + coalesce(jsonb_array_length(p_aud -> 'user_ids') - (CASE WHEN (p_aud -> 'user_ids') ? a::text THEN 1 ELSE 0 END), 0)
           + cardinality(regs) = 0;
  -- the same audience as now needs no right (an owner who lost views.share still edits the filters of a view already shared)
  same := v.share_everyone = everyone
    AND NOT EXISTS ((SELECT t.target_kind, t.target_id FROM public.saved_view_targets t WHERE t.view_id = p_view)
                    EXCEPT (SELECT 'role', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'role_ids', '[]')) x
                            UNION SELECT 'group', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'group_ids', '[]')) x
                            UNION SELECT 'user', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'user_ids', '[]')) x WHERE x <> a::text))
    AND NOT EXISTS ((SELECT 'role'::text, x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'role_ids', '[]')) x
                     UNION SELECT 'group', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'group_ids', '[]')) x
                     UNION SELECT 'user', x::uuid FROM jsonb_array_elements_text(coalesce(p_aud -> 'user_ids', '[]')) x WHERE x <> a::text)
                    EXCEPT (SELECT t.target_kind, t.target_id FROM public.saved_view_targets t WHERE t.view_id = p_view))
    AND coalesce((SELECT array_agg(t.region_id ORDER BY t.region_id) FROM public.saved_view_region_targets t WHERE t.view_id = p_view), ARRAY[]::int[]) = regs;
  IF NOT empty AND NOT same AND NOT (mgr AND v.owner_id <> a) THEN
    scope := public.sv_share_scope(a);
    IF scope = 'none' THEN PERFORM public.sv_fail('action_forbidden', 'Sharing a view needs the views.share right.'); END IF;
    IF everyone AND scope <> 'all' THEN PERFORM public.sv_fail('action_forbidden', 'Sharing with everyone needs views.share for all regions; choose roles, groups or users.'); END IF;
    -- 0117: a region-limited sharer names only regions of their own view right on the screen's module
    IF cardinality(regs) > 0 AND scope <> 'all' THEN
      mine := public.wf_actor_regions(public.sv_screen_module(v.screen_key), 'view'::"PermissionAction");
      IF mine IS NOT NULL AND NOT regs <@ mine THEN
        PERFORM public.sv_fail('action_forbidden', 'You may share a view only with regions you can see yourself.',
          '{"errors":[{"path":"/audience/region_ids","code":"out_of_scope"}]}');
      END IF;
    END IF;
  END IF;
  DELETE FROM public.saved_view_targets WHERE view_id = p_view;
  DELETE FROM public.saved_view_region_targets WHERE view_id = p_view;
  UPDATE public.saved_views SET share_everyone = everyone WHERE id = p_view;
  FOREACH k IN ARRAY ARRAY['role', 'group', 'user'] LOOP
    BEGIN
      SELECT coalesce(array_agg(DISTINCT x::uuid), ARRAY[]::uuid[]) INTO ids FROM jsonb_array_elements_text(coalesce(p_aud -> (k || '_ids'), '[]')) x;
    EXCEPTION WHEN invalid_text_representation THEN
      PERFORM public.sv_fail('validation_failed', 'An audience id is not valid.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/' || k || '_ids', 'code', 'invalid'))));
    END;
    FOREACH i IN ARRAY ids LOOP
      IF k = 'user' AND i = v.owner_id THEN CONTINUE; END IF;
      IF (k = 'role' AND NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.id = i AND r.is_active))
         OR (k = 'group' AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = i AND g.is_active))
         OR (k = 'user' AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = i AND u.status = 'active' AND u.deleted_at IS NULL)) THEN
        PERFORM public.sv_fail('validation_failed', 'An audience entry does not exist or is not active.',
          jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/' || k || '_ids', 'code', 'not_found', 'message', i::text))));
      END IF;
      INSERT INTO public.saved_view_targets (view_id, target_kind, target_id) VALUES (p_view, k, i);
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY regs LOOP
    IF NOT EXISTS (SELECT 1 FROM public.regions g WHERE g.id = r) THEN
      PERFORM public.sv_fail('validation_failed', 'An audience entry does not exist or is not active.',
        jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/audience/region_ids', 'code', 'not_found', 'message', r::text))));
    END IF;
    INSERT INTO public.saved_view_region_targets (view_id, region_id) VALUES (p_view, r);
  END LOOP;
END $$;

-- 0117: filters.advanced must be a valid filter tree (sv_check_tree).
CREATE OR REPLACE FUNCTION sv_check_body(p_body jsonb, p_create boolean) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; e jsonb;
BEGIN
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN PERFORM public.sv_fail('validation_failed', 'The body is not valid.'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_body) LOOP
    IF k NOT IN ('screen_key', 'name', 'filters', 'columns', 'sort', 'audience') OR (k = 'screen_key' AND NOT p_create) THEN
      PERFORM public.sv_fail('validation_failed', 'Unknown field.', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/' || k, 'code', 'unknown_field'))));
    END IF;
  END LOOP;
  IF p_create AND (p_body ->> 'screen_key' IS NULL OR public.sv_screen_module(p_body ->> 'screen_key') IS NULL) THEN
    PERFORM public.sv_fail('validation_failed', 'Not a list screen with saved views.', '{"errors":[{"path":"/screen_key","code":"invalid"}]}');
  END IF;
  IF (p_create OR p_body ? 'name') AND (jsonb_typeof(p_body -> 'name') IS DISTINCT FROM 'string' OR length(btrim(p_body ->> 'name')) NOT BETWEEN 1 AND 120) THEN
    PERFORM public.sv_fail('validation_failed', 'A name of 1 to 120 characters is required.', '{"errors":[{"path":"/name","code":"invalid"}]}');
  END IF;
  IF p_body ? 'filters' AND (jsonb_typeof(p_body -> 'filters') <> 'object' OR length((p_body -> 'filters')::text) > 16000) THEN
    PERFORM public.sv_fail('validation_failed', 'The filters are not valid.', '{"errors":[{"path":"/filters","code":"invalid"}]}');
  END IF;
  IF p_body ? 'filters' AND (p_body -> 'filters') ? 'advanced' THEN PERFORM public.sv_check_tree(p_body #> '{filters,advanced}'); END IF;
  IF p_body ? 'columns' AND (jsonb_typeof(p_body -> 'columns') <> 'object' OR length((p_body -> 'columns')::text) > 16000) THEN
    PERFORM public.sv_fail('validation_failed', 'The columns are not valid.', '{"errors":[{"path":"/columns","code":"invalid"}]}');
  END IF;
  IF p_body ? 'sort' THEN
    IF jsonb_typeof(p_body -> 'sort') <> 'array' OR jsonb_array_length(p_body -> 'sort') > 5 THEN
      PERFORM public.sv_fail('validation_failed', 'The sort is not valid.', '{"errors":[{"path":"/sort","code":"invalid"}]}');
    END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(p_body -> 'sort') q(x) LOOP
      IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'id') IS DISTINCT FROM 'string' OR coalesce(e ->> 'dir', '') NOT IN ('asc', 'desc') THEN
        PERFORM public.sv_fail('validation_failed', 'The sort is not valid.', '{"errors":[{"path":"/sort","code":"invalid"}]}');
      END IF;
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Ownership and rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['sv_try_numeric(text)', 'sv_try_date(text)', 'sv_check_tree(jsonb)', 'sv_hidden_filter_field(text,text)',
                           'sv_filter_hidden(text,text[])', 'sv_strip_tree(text,jsonb)', 'sv_strip(text,jsonb,jsonb,jsonb)', 'sv_is_shared(uuid)',
                           'sv_addressed_to(uuid,uuid)', 'sv_audience(uuid)', 'sv_set_audience(uuid,jsonb)', 'sv_check_body(jsonb,boolean)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    -- the doors of the compiled SQL and of the hidden-field check; everything else stays internal
    GRANT EXECUTE ON FUNCTION sv_try_numeric(text), sv_try_date(text), sv_filter_hidden(text, text[]) TO pmis_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON saved_view_region_targets FROM pmis_app;
    GRANT SELECT ON saved_view_region_targets TO pmis_app;
  END IF;
END $$;
