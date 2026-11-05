-- 0071_site_identity_changes: technical decision Q473 (2026-11-05, docs/spec/technical-decisions-2026-11-04.md, "Site creation"). Contract 0.14.1, CHANGELOG 100.
-- Mirror: db/sql/070_site_identity_changes.sql (kept byte-identical).
--
-- A site's identity changes only through a Change Control proposal: L1 proposes, L2 approves, the change is audited with before and after values. No direct edit.
-- It is the Q225 path (0062: site_propose_change, p4a_site_parse, p4a_site_current, p4a_site_change_errors, p4a_apply_site_change), extended.
--
--   1. New field items of a Change Control record (Data Correction, Field):
--        site.name         the English site name (the column sites.name; max 200, no control characters)
--        site.name_ar      the Arabic site name (sites.name_ar, 0070; empty clears it)
--        site.coordinates  latitude and longitude as one pair "lat, lon" (the ranges of 0070: -90..90 and -180..180, six decimals; a pair is replaced, never cleared)
--        site.region       "<region> / <cluster>": the site moves to the region; the cluster is named in the same record, or kept when it fits the new region
--        site.cluster      the cluster code, or (none)
--      A cluster must belong to the target region, or be global (cluster_other_region); it must exist (unknown_cluster): a cluster is created only with the first
--      site (Q471), never by a change.
--   2. Region and cluster decide who can see the site, so only a System Admin proposes or approves them: a delegate or a Team Lead gets 403 action_forbidden, at the
--      proposal, at submit of a hand-made Change Control record, and again at the approval. On approval the site moves (the children that carry (site_id, region_id)
--      follow by the composite foreign keys, ON UPDATE CASCADE, 0003), the site is recalculated, and two audit rows are written for a move (the new and the old region).
--      Tasks already open keep their SLA rule (B12b: nothing resets); the matrix cells of a task are those of its first submission.
--   3. The Site ID never changes: site.site_code in a proposal or a Change Control record is refused with the field error immutable, and the database refuses an
--      UPDATE of sites.site_code for everyone except the migration role (trigger b_sites_identity_guard).
--   4. Direct writes are closed. pmis_app could still UPDATE sites (table-level right): it keeps the update right on the other columns only, not on site_code, name,
--      name_ar, region_id, cluster_id, latitude, longitude. The trigger refuses the same columns for any role but pmis_definer and the migration role (defence in depth).
--      admin_transfer_site_region (0009) was a second direct path (callable by pmis_app): it is dropped; the region moves only by an approved proposal.
--      PATCH /sites/{id} and site_save_custom write the custom values only (unchanged).
--      Left as it is, and reported as owner question Q476: the approved RF & Design feed (p4a_feed_rf, 0062) still writes sites.latitude and sites.longitude of an
--      approved RF & Design record (two levels, audited as site_identity_fed).
--   5. site_propose_identity(site, identity, reason): the writer of the proposals (one Change Control draft per item, entered by the caller as L1 through
--      reg_save_record, like site_propose_change). POST /sites/{id}/change-proposals calls it for the identity part of the body.
--
-- Every new function is SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, owned by pmis_definer, PUBLIC revoked. The actor comes from app_actor() only.
-- pmis_app stays read-only on the tables; audit rows go through log_audit_write (p4a_audit).

SELECT set_config('app.region_ids', '*', true);

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION si_identity_items() RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT ARRAY['site.name', 'site.name_ar', 'site.coordinates', 'site.region', 'site.cluster']
$$;

-- The coordinates as Change Control text: "lat, lon" with six decimals, or (none).
CREATE OR REPLACE FUNCTION si_coords_text(p_lat numeric, p_lon numeric) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_lat IS NULL OR p_lon IS NULL THEN '(none)' ELSE round(p_lat, 6)::numeric(9,6)::text || ', ' || round(p_lon, 6)::numeric(9,6)::text END
$$;

-- A field error of the proposal path (422 validation_failed).
CREATE OR REPLACE FUNCTION si_fail(p_path text, p_code text, p_msg text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item(p_path, p_code, p_msg)));
END $$;

-- Region and cluster decide who can see the site: only a System Admin (not a delegate, not a Team Lead) proposes or approves them (Q473). 403 action_forbidden.
-- A call without a signed-in actor is the maintenance role of the database, never the API.
CREATE OR REPLACE FUNCTION si_require_admin(p_what text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_actor() IS NOT NULL AND NOT public.app_actor_is_system_admin() THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail',
      'Only a System Admin proposes or approves a change of ' || p_what || ': it changes who can see the site (Q473).'));
  END IF;
END $$;

-- The text of a parsed value, in the form of p4a_site_current (to compare a proposal with the site and to store the clean value).
CREATE OR REPLACE FUNCTION si_parsed_text(p_item text, p_v jsonb) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_item
    WHEN 'site.name'        THEN p_v #>> '{}'
    WHEN 'site.name_ar'     THEN CASE WHEN p_v = 'null'::jsonb THEN '(none)' ELSE p_v #>> '{}' END
    WHEN 'site.coordinates' THEN public.si_coords_text((p_v ->> 'latitude')::numeric, (p_v ->> 'longitude')::numeric)
    WHEN 'site.region'      THEN (SELECT r.name_en FROM public.regions r WHERE r.id = (p_v ->> 'region_id')::int) || ' / ' || coalesce(p_v ->> 'cluster_code', '(none)')
    WHEN 'site.cluster'     THEN coalesce(p_v ->> 'cluster_code', '(none)')
  END
$$;

-- The columns of the site that an identity item touches, for the audit row (before and after).
CREATE OR REPLACE FUNCTION si_site_cols(p_site uuid, p_item text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_item
    WHEN 'site.name'        THEN jsonb_build_object('name', s.name)
    WHEN 'site.name_ar'     THEN jsonb_build_object('name_ar', s.name_ar)
    WHEN 'site.coordinates' THEN jsonb_build_object('latitude', s.latitude, 'longitude', s.longitude)
    WHEN 'site.region'      THEN jsonb_build_object('region_id', s.region_id, 'cluster_code', (SELECT c.cluster_code FROM public.clusters c WHERE c.id = s.cluster_id))
    WHEN 'site.cluster'     THEN jsonb_build_object('cluster_code', (SELECT c.cluster_code FROM public.clusters c WHERE c.id = s.cluster_id))
  END
  FROM public.sites s WHERE s.id = p_site
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The Change Control field items: current value (latest definition: 0062, plus the identity items)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION p4a_site_current(p_site uuid, p_item text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.sites%ROWTYPE; col text;
BEGIN
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_item LIKE 'site.custom.%' THEN
    IF NOT EXISTS (SELECT 1 FROM public.field_definitions d WHERE d.entity_type = 'site' AND d.task_code IS NULL AND d.is_active AND d.code = substr(p_item, 13)) THEN RETURN NULL; END IF;
    RETURN public.p4a_site_value_text(s.custom -> substr(p_item, 13));
  END IF;
  -- Q473: the identity of the site
  IF p_item = 'site.site_code' THEN RETURN s.site_code; END IF;
  IF p_item = 'site.name' THEN RETURN s.name; END IF;
  IF p_item = 'site.name_ar' THEN RETURN coalesce(s.name_ar, '(none)'); END IF;
  IF p_item = 'site.coordinates' THEN RETURN public.si_coords_text(s.latitude, s.longitude); END IF;
  IF p_item = 'site.region' THEN
    RETURN (SELECT r.name_en FROM public.regions r WHERE r.id = s.region_id) || ' / ' || coalesce((SELECT c.cluster_code FROM public.clusters c WHERE c.id = s.cluster_id), '(none)');
  END IF;
  IF p_item = 'site.cluster' THEN RETURN coalesce((SELECT c.cluster_code FROM public.clusters c WHERE c.id = s.cluster_id), '(none)'); END IF;
  col := substr(p_item, 6);
  IF col = ANY (public.p4a_scope_flags()) THEN
    RETURN CASE (to_jsonb(s) ->> col) WHEN 'yes' THEN 'Yes' WHEN 'na' THEN 'N/A' ELSE '(none)' END;
  ELSIF col = 'site_scenario' THEN
    RETURN coalesce(s.site_scenario, '(none)');
  END IF;
  RETURN NULL;
END $$;

-- The new value of an identity item from its Change Control text, as JSON; raises a field error when invalid. The other items: p4a_site_parse(text, text) of 0062.
-- Paths: /data/new_value, and /data/new_value/<key> when the error belongs to one value of a pair (latitude, longitude, region_id, cluster_code).
CREATE OR REPLACE FUNCTION p4a_site_parse(p_site uuid, p_item text, p_text text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t text := btrim(coalesce(p_text, '')); s public.sites%ROWTYPE; ok boolean; lat_t text; lon_t text; lat numeric; lon numeric; rid int; rpart text; cpart text; has_c boolean; cl public.clusters%ROWTYPE;
  cid uuid; target int;
BEGIN
  IF p_item <> ALL (public.si_identity_items()) THEN RETURN public.p4a_site_parse(p_item, p_text); END IF;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  IF NOT FOUND THEN PERFORM public.si_fail('/site_id', 'unknown_site', 'The site does not exist.'); END IF;

  IF p_item = 'site.name' THEN
    t := btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', '', 'g'));
    IF t IN ('', '(none)') THEN PERFORM public.si_fail('/data/new_value', 'required', 'The English site name is required.'); END IF;
    IF char_length(t) > 200 THEN PERFORM public.si_fail('/data/new_value', 'too_long', 'The name is at most 200 characters.'); END IF;
    RETURN to_jsonb(t);

  ELSIF p_item = 'site.name_ar' THEN
    t := btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', '', 'g'));
    IF t IN ('', '(none)') THEN RETURN 'null'::jsonb; END IF;
    IF char_length(t) > 200 THEN PERFORM public.si_fail('/data/new_value', 'too_long', 'The name is at most 200 characters.'); END IF;
    RETURN to_jsonb(t);

  ELSIF p_item = 'site.coordinates' THEN
    IF t IN ('', '(none)') THEN PERFORM public.si_fail('/data/new_value', 'required', 'The coordinates are replaced as a pair (latitude, longitude); they are not cleared.'); END IF;
    IF cardinality(string_to_array(t, ',')) <> 2 THEN PERFORM public.si_fail('/data/new_value', 'pair_required', 'Latitude and longitude go together: "latitude, longitude".'); END IF;
    lat_t := btrim(split_part(t, ',', 1)); lon_t := btrim(split_part(t, ',', 2));
    IF lat_t = '' OR lon_t = '' THEN PERFORM public.si_fail('/data/new_value/' || CASE WHEN lat_t = '' THEN 'latitude' ELSE 'longitude' END, 'pair_required', 'Latitude and longitude go together.'); END IF;
    -- the ranges of 0070 (site_new_clean)
    ok := CASE WHEN lat_t ~ '^-?[0-9]{1,2}(\.[0-9]+)?$' THEN abs(lat_t::numeric) <= 90 ELSE false END;
    IF ok THEN lat := round(lat_t::numeric, 6);
    ELSE PERFORM public.si_fail('/data/new_value/latitude', 'invalid', 'A latitude is a number from -90 to 90.'); END IF;
    ok := CASE WHEN lon_t ~ '^-?[0-9]{1,3}(\.[0-9]+)?$' THEN abs(lon_t::numeric) <= 180 ELSE false END;
    IF ok THEN lon := round(lon_t::numeric, 6);
    ELSE PERFORM public.si_fail('/data/new_value/longitude', 'invalid', 'A longitude is a number from -180 to 180.'); END IF;
    RETURN jsonb_build_object('latitude', lat, 'longitude', lon);

  ELSIF p_item = 'site.region' THEN
    -- "<region>" keeps the cluster; "<region> / <cluster>" names it; "<region> / (none)" clears it
    has_c := position('/' IN t) > 0;
    rpart := btrim(split_part(t, '/', 1));
    cpart := CASE WHEN has_c THEN btrim(substr(t, position('/' IN t) + 1)) END;
    rid := coalesce(public.imp_region_resolve(rpart), (SELECT x.id FROM public.regions x WHERE lower(x.name_en) = lower(rpart) OR lower(x.code) = lower(rpart) ORDER BY x.id LIMIT 1));
    IF rid IS NULL THEN PERFORM public.si_fail('/data/new_value/region_id', 'unknown_region', 'Unknown region.'); END IF;
    IF NOT has_c THEN
      cid := s.cluster_id;
      IF cid IS NOT NULL THEN
        SELECT * INTO cl FROM public.clusters c WHERE c.id = cid;
        IF FOUND AND NOT cl.is_global AND cl.region_id IS DISTINCT FROM rid THEN
          PERFORM public.si_fail('/data/new_value/cluster_code', 'cluster_other_region',
            'The cluster of the site belongs to another region: name a cluster of the new region, or none, in the same proposal.');
        END IF;
      END IF;
    ELSIF cpart = '' THEN
      PERFORM public.si_fail('/data/new_value/cluster_code', 'invalid', 'Name a cluster, or (none).');
    ELSIF lower(cpart) = '(none)' THEN
      cid := NULL;
    ELSE
      SELECT * INTO cl FROM public.clusters c WHERE upper(c.cluster_code) = upper(cpart);
      IF NOT FOUND THEN PERFORM public.si_fail('/data/new_value/cluster_code', 'unknown_cluster', 'There is no such cluster. A cluster is created with its first site, not by a change.'); END IF;
      IF NOT cl.is_global AND cl.region_id IS DISTINCT FROM rid THEN
        PERFORM public.si_fail('/data/new_value/cluster_code', 'cluster_other_region', 'This cluster belongs to another region than the new region of the site.');
      END IF;
      cid := cl.id;
    END IF;
    RETURN jsonb_build_object('region_id', rid, 'cluster_id', cid, 'cluster_code', (SELECT c.cluster_code FROM public.clusters c WHERE c.id = cid));

  ELSE  -- site.cluster
    IF t = '' THEN PERFORM public.si_fail('/data/new_value/cluster_code', 'invalid', 'Name a cluster, or (none).'); END IF;
    IF lower(t) = '(none)' THEN RETURN jsonb_build_object('cluster_id', NULL, 'cluster_code', NULL); END IF;
    target := s.region_id;
    SELECT * INTO cl FROM public.clusters c WHERE upper(c.cluster_code) = upper(t);
    IF NOT FOUND THEN PERFORM public.si_fail('/data/new_value/cluster_code', 'unknown_cluster', 'There is no such cluster. A cluster is created with its first site, not by a change.'); END IF;
    IF NOT cl.is_global AND cl.region_id IS DISTINCT FROM target THEN
      PERFORM public.si_fail('/data/new_value/cluster_code', 'cluster_other_region', 'This cluster belongs to another region than the site.');
    END IF;
    RETURN jsonb_build_object('cluster_id', cl.id, 'cluster_code', cl.cluster_code);
  END IF;
END $$;

-- Checks one identity item: parses the new value, and says what is wrong. p_key names the request field (the proposal API: /identity/<key>), or is NULL for a
-- Change Control record (/data/new_value...). Returns {errors: [...], cur, norm}.
CREATE OR REPLACE FUNCTION si_check_item(p_site uuid, p_item text, p_text text, p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb; cur text := public.p4a_site_current(p_site, p_item); norm text; msg text; errs jsonb;
BEGIN
  BEGIN
    v := public.p4a_site_parse(p_site, p_item, p_text);
  EXCEPTION WHEN raise_exception THEN
    msg := SQLERRM;
    IF msg NOT LIKE 'wf:validation_failed:%' THEN RAISE; END IF;
    errs := (substr(msg, 22)::jsonb) -> 'errors';
    IF p_key IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_set(x, '{path}', to_jsonb(CASE WHEN x ->> 'path' LIKE '/data/new_value/%' THEN '/identity/' || substr(x ->> 'path', 17) ELSE '/identity/' || p_key END)))
        INTO errs FROM jsonb_array_elements(errs) x;
    END IF;
    RETURN jsonb_build_object('errors', coalesce(errs, '[]'::jsonb), 'cur', cur);
  END;
  norm := public.si_parsed_text(p_item, v);
  RETURN jsonb_build_object('errors', '[]'::jsonb, 'cur', cur, 'norm', norm);
END $$;

-- The submit checks of a site field change (latest definition: 0062, plus the identity items): the Site ID is immutable, region and cluster are for a System Admin,
-- a known field, a valid new value, an Old Value that is still the site's value (no stale proposal), and a change that changes something.
CREATE OR REPLACE FUNCTION p4a_site_change_errors(p_site uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE item text := p_data ->> 'field_item'; cur text; chk jsonb;
BEGIN
  IF item IS NULL OR item NOT LIKE 'site.%' THEN RETURN '[]'::jsonb; END IF;
  IF item = 'site.site_code' THEN
    RETURN public.reg_err_item('/data/field_item', 'immutable', 'The Site ID never changes (Q473).');
  END IF;
  IF item IN ('site.region', 'site.cluster') THEN PERFORM public.si_require_admin('the region or the cluster'); END IF;
  cur := public.p4a_site_current(p_site, item);
  IF cur IS NULL THEN
    RETURN public.reg_err_item('/data/field_item', 'unknown_site_field',
      'Not a site field that Change Control can change (site.custom.<code>, site.<scope flag>, site.site_scenario, site.name, site.name_ar, site.coordinates, site.region, site.cluster).');
  END IF;
  IF item = ANY (public.si_identity_items()) THEN
    chk := public.si_check_item(p_site, item, p_data ->> 'new_value', NULL);
    IF jsonb_array_length(chk -> 'errors') > 0 THEN RETURN chk -> 'errors'; END IF;
    IF btrim(coalesce(p_data ->> 'old_value', '')) <> cur THEN
      RETURN public.reg_err_item('/data/old_value', 'old_value_changed', 'The site value is now "' || cur || '": correct the Old Value.');
    END IF;
    IF chk ->> 'norm' = cur THEN
      RETURN public.reg_err_item('/data/new_value', 'unchanged', 'The site has this value already.');
    END IF;
    RETURN '[]'::jsonb;
  END IF;
  BEGIN
    PERFORM public.p4a_site_parse(item, p_data ->> 'new_value');
  EXCEPTION WHEN raise_exception THEN
    RETURN public.reg_err_item('/data/new_value', 'invalid', 'The new value is not valid for this site field.');
  END;
  IF btrim(coalesce(p_data ->> 'old_value', '')) <> cur THEN
    RETURN public.reg_err_item('/data/old_value', 'old_value_changed', 'The site value is now "' || cur || '": correct the Old Value.');
  END IF;
  RETURN '[]'::jsonb;
END $$;

-- Applies an approved identity change to the site, audited with before and after values; then the site is recalculated. Region and cluster again need a System Admin
-- (the approver), and the new value is checked again against the site as it is now.
CREATE OR REPLACE FUNCTION si_apply_identity(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.register_records%ROWTYPE; item text; v jsonb; s public.sites%ROWTYPE; before_ text; after_ text; cols_b jsonb; cols_a jsonb; res jsonb; why text; new_region int;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  item := r.data ->> 'field_item';
  IF item IN ('site.region', 'site.cluster') THEN PERFORM public.si_require_admin('the region or the cluster'); END IF;
  SELECT * INTO s FROM public.sites WHERE id = r.site_id FOR UPDATE;
  before_ := public.p4a_site_current(r.site_id, item);
  cols_b := public.si_site_cols(r.site_id, item);
  v := public.p4a_site_parse(r.site_id, item, r.data ->> 'new_value');
  IF item = 'site.name' THEN
    UPDATE public.sites SET name = v #>> '{}', updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSIF item = 'site.name_ar' THEN
    UPDATE public.sites SET name_ar = CASE WHEN v = 'null'::jsonb THEN NULL ELSE v #>> '{}' END, updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSIF item = 'site.coordinates' THEN
    UPDATE public.sites SET latitude = (v ->> 'latitude')::numeric, longitude = (v ->> 'longitude')::numeric, updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSIF item = 'site.region' THEN
    new_region := (v ->> 'region_id')::int;
    UPDATE public.sites SET region_id = new_region, cluster_id = (v ->> 'cluster_id')::uuid, updated_at = clock_timestamp() WHERE id = r.site_id;
  ELSE
    UPDATE public.sites SET cluster_id = (v ->> 'cluster_id')::uuid, updated_at = clock_timestamp() WHERE id = r.site_id;
  END IF;
  after_ := public.p4a_site_current(r.site_id, item);
  cols_a := public.si_site_cols(r.site_id, item);
  why := 'approved Change Control ' || coalesce(r.data ->> 'change_id', r.id::text) || ' (Q473)';
  res := jsonb_build_object('field', item, 'before', before_, 'after', after_, 'record_id', r.id, 'columns_before', cols_b, 'columns_after', cols_a);
  PERFORM public.p4a_audit('site_change_applied', 'site', r.site_id::text, jsonb_build_object('field', item, 'value', before_, 'columns', cols_b), res, why, r.site_id,
    coalesce(new_region, s.region_id));
  IF item = 'site.region' AND new_region IS DISTINCT FROM s.region_id THEN
    -- the lead of the old region sees the move too (the audit log is read by region)
    PERFORM public.p4a_audit('site_region_moved_out', 'site', r.site_id::text, jsonb_build_object('field', item, 'value', before_, 'columns', cols_b), res, why, r.site_id, s.region_id);
  END IF;
  PERFORM public.calc_refresh_site(r.site_id);
  RETURN res;
END $$;

-- Applies an approved site field change (latest definition: 0062). An identity item goes to si_apply_identity; the Site ID is refused again.
CREATE OR REPLACE FUNCTION p4a_apply_site_change(p_record uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.register_records%ROWTYPE; item text; v jsonb; col text; before_ text; res jsonb; conflicts jsonb; c jsonb; real_conflicts jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  item := r.data ->> 'field_item';
  IF item = 'site.site_code' THEN
    PERFORM public.si_fail('/data/field_item', 'immutable', 'The Site ID never changes (Q473).');
  END IF;
  IF item = ANY (public.si_identity_items()) THEN RETURN public.si_apply_identity(p_record); END IF;
  before_ := public.p4a_site_current(r.site_id, item);
  v := public.p4a_site_parse(r.site_id, item, r.data ->> 'new_value');
  IF item LIKE 'site.custom.%' THEN
    UPDATE public.sites SET custom = CASE WHEN v = 'null'::jsonb THEN custom - substr(item, 13) ELSE custom || jsonb_build_object(substr(item, 13), v) END, updated_at = clock_timestamp()
    WHERE id = r.site_id;
  ELSE
    col := substr(item, 6);
    IF col = 'site_scenario' THEN
      UPDATE public.sites SET site_scenario = v #>> '{}', delivery_scenario = replace(lower(v #>> '{}'), ' ', '_')::"DeliveryScenario", updated_at = clock_timestamp() WHERE id = r.site_id;
    ELSE
      EXECUTE format('UPDATE public.sites SET %I = $1::"ScopeFlag", updated_at = clock_timestamp() WHERE id = $2', col) USING v #>> '{}', r.site_id;
    END IF;
  END IF;
  res := jsonb_build_object('field', item, 'before', before_, 'after', public.p4a_site_current(r.site_id, item), 'record_id', r.id);
  PERFORM public.p4a_audit('site_change_applied', 'site', r.site_id::text, jsonb_build_object('field', item, 'value', before_), res,
    'approved Change Control ' || coalesce(r.data ->> 'change_id', r.id::text) || ' (Q225)', r.site_id, r.region_id);
  PERFORM public.p4a_hook('wf_apply_applicability', r.site_id);
  conflicts := public.p4a_hook('scope_scenario_conflicts', r.site_id);
  IF conflicts IS NOT NULL THEN
    FOR c IN SELECT * FROM jsonb_array_elements(conflicts) LOOP
      IF c IS NOT NULL AND c NOT IN ('null'::jsonb, '[]'::jsonb, '{}'::jsonb, 'false'::jsonb, '""'::jsonb) THEN real_conflicts := real_conflicts || jsonb_build_array(c); END IF;
    END LOOP;
    IF jsonb_array_length(real_conflicts) > 0 THEN
      PERFORM public.wf_err('validation_failed', jsonb_build_object('conflicts', real_conflicts,
        'errors', public.reg_err_item('/data/new_value', 'scope_scenario_conflict', 'The scope and the scenario of the site conflict after this change (Q3): it cannot be approved.')));
    END IF;
  END IF;
  PERFORM public.calc_refresh_site(r.site_id);
  RETURN res;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The proposal writer for the identity part of POST /sites/{id}/change-proposals
-- ---------------------------------------------------------------------------------------------------------------------
-- p_identity: {name, name_ar, latitude, longitude, region_id, cluster_code, site_code}. One Change Control draft (Data Correction, Field) per item: name, name_ar,
-- coordinates (latitude and longitude together), region (with the cluster when named, else the cluster is kept) or cluster. The caller is L1 of the Change Control row
-- (reg_save_record checks the holder and the create right, as in site_propose_change). Region and cluster: 403 for anybody but a System Admin, before any other check
-- (also before the visibility of the site: the answer is the same for every site).
-- The Site ID is refused with the field error immutable. Returns {items: [{field, record_id, change_id, old_value, new_value}]}.
CREATE OR REPLACE FUNCTION site_propose_identity(p_site uuid, p_identity jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor(); s public.sites%ROWTYPE; regs int[]; k text; errs jsonb := '[]'::jsonb; items jsonb := '[]'::jsonb; cand jsonb := '[]'::jsonb; c jsonb; chk jsonb;
  keys text[] := ARRAY['name', 'name_ar', 'latitude', 'longitude', 'region_id', 'cluster_code', 'site_code'];
  txt text; ctxt text; rnum int; rname text; rid uuid; cid text;
  has_lat boolean; has_lon boolean; has_reg boolean; has_cl boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'no signed-in actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- Q473: region and cluster change who can see the site: a System Admin only (a delegate or a Team Lead gets 403). Asked first: the answer is the same for every site,
  -- visible or not, so it tells nothing about a site the caller cannot see.
  IF jsonb_typeof(p_identity) = 'object' AND (p_identity ? 'region_id' OR p_identity ? 'cluster_code') THEN
    PERFORM public.si_require_admin('the region or the cluster');
  END IF;
  SELECT * INTO s FROM public.sites WHERE id = p_site;
  regs := public.wf_actor_regions('sites', 'view');
  IF NOT FOUND OR (regs IS NOT NULL AND NOT (s.region_id = ANY (regs))) THEN
    PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The site does not exist or is not visible to you.'));
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN errs := errs || public.reg_err_item('/reason', 'required', 'A proposal needs a reason.'); END IF;
  IF p_identity IS NULL OR jsonb_typeof(p_identity) <> 'object' OR p_identity = '{}'::jsonb THEN
    errs := errs || public.reg_err_item('/identity', 'required', 'Send at least one field.');
  ELSE
    FOR k IN SELECT jsonb_object_keys(p_identity) ORDER BY 1 LOOP
      IF NOT (k = ANY (keys)) THEN errs := errs || public.reg_err_item('/identity/' || left(k, 60), 'unknown_field', 'This field cannot be proposed.');
      ELSIF jsonb_typeof(p_identity -> k) NOT IN ('string', 'number', 'null') THEN errs := errs || public.reg_err_item('/identity/' || k, 'invalid', 'A single value is expected.');
      END IF;
    END LOOP;
    -- Q473: the Site ID never changes
    IF p_identity ? 'site_code' THEN errs := errs || public.reg_err_item('/identity/site_code', 'immutable', 'The Site ID never changes (Q473).'); END IF;
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  has_lat := p_identity ? 'latitude'; has_lon := p_identity ? 'longitude'; has_reg := p_identity ? 'region_id'; has_cl := p_identity ? 'cluster_code';
  FOREACH k IN ARRAY ARRAY['name', 'name_ar'] LOOP
    IF p_identity ? k THEN
      cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.' || k, 'key', k, 'text', CASE WHEN jsonb_typeof(p_identity -> k) = 'null' THEN '' ELSE p_identity ->> k END));
    END IF;
  END LOOP;
  IF has_lat OR has_lon THEN
    IF has_lat <> has_lon THEN
      errs := errs || public.reg_err_item('/identity/' || CASE WHEN has_lat THEN 'longitude' ELSE 'latitude' END, 'pair_required', 'Latitude and longitude go together.');
    ELSE
      cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.coordinates', 'key', 'latitude',
        'text', coalesce(p_identity ->> 'latitude', '') || ', ' || coalesce(p_identity ->> 'longitude', '')));
    END IF;
  END IF;
  IF has_cl THEN ctxt := coalesce(nullif(btrim(p_identity ->> 'cluster_code'), ''), '(none)'); END IF;
  IF has_reg THEN
    IF jsonb_typeof(p_identity -> 'region_id') = 'number' AND (p_identity ->> 'region_id') ~ '^[0-9]{1,3}$' THEN rnum := (p_identity ->> 'region_id')::int;
    ELSE errs := errs || public.reg_err_item('/identity/region_id', 'invalid', 'A region id.'); END IF;
    IF rnum IS NOT NULL THEN
      SELECT r.name_en INTO rname FROM public.regions r WHERE r.id = rnum;
      IF rname IS NULL THEN errs := errs || public.reg_err_item('/identity/region_id', 'unknown_region', 'Unknown region.');
      ELSIF rnum = s.region_id THEN
        -- the same region: only the cluster can change
        IF has_cl THEN cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.cluster', 'key', 'cluster_code', 'text', ctxt));
        ELSE errs := errs || public.reg_err_item('/identity/region_id', 'unchanged', 'The site is in this region already.'); END IF;
      ELSE
        cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.region', 'key', 'region_id', 'text', rname || CASE WHEN has_cl THEN ' / ' || ctxt ELSE '' END));
      END IF;
    END IF;
  ELSIF has_cl THEN
    cand := cand || jsonb_build_array(jsonb_build_object('item', 'site.cluster', 'key', 'cluster_code', 'text', ctxt));
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(cand) LOOP
    chk := public.si_check_item(p_site, c ->> 'item', c ->> 'text', c ->> 'key');
    IF jsonb_array_length(chk -> 'errors') > 0 THEN errs := errs || (chk -> 'errors');
    ELSIF chk ->> 'norm' = chk ->> 'cur' THEN errs := errs || public.reg_err_item('/identity/' || (c ->> 'key'), 'unchanged', 'The site has this value already.');
    END IF;
  END LOOP;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(cand) LOOP
    chk := public.si_check_item(p_site, c ->> 'item', c ->> 'text', c ->> 'key');
    cid := 'SFC-' || s.site_code || '-' || upper(substr(c ->> 'item', 6)) || '-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 4);
    rid := public.reg_save_record('change_control', NULL, NULL, p_site, NULL,
      jsonb_build_object('change_id', cid, 'change_type', 'Data Correction', 'change_scope', 'Field', 'field_item', c ->> 'item', 'old_value', chk ->> 'cur', 'new_value', chk ->> 'norm',
                         'reason', btrim(p_reason), 'request_date', current_date::text), NULL, NULL, false);
    items := items || jsonb_build_array(jsonb_build_object('field', substr(c ->> 'item', 6), 'record_id', rid, 'change_id', cid, 'old_value', chk ->> 'cur', 'new_value', chk ->> 'norm'));
  END LOOP;
  PERFORM public.log_audit_write('site_change_proposed', 'site', p_site::text, NULL, jsonb_build_object('proposals', items), btrim(p_reason), p_site, s.region_id);
  RETURN jsonb_build_object('items', items);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The Site ID never changes; the identity columns change only inside the approved path (defence in depth, the privileges below are the first wall).
--    The two trigger functions are the one exception to "SECURITY DEFINER": a trigger has to see who runs the UPDATE (current_user), as sites_block_region_change (0003)
--    and reg_backstop do, so they run with the caller's rights.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sites_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.site_code IS DISTINCT FROM OLD.site_code AND NOT public.app_is_seeding() THEN
    RAISE EXCEPTION 'sites.site_code never changes (Q473)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.name, NEW.name_ar, NEW.latitude, NEW.longitude, NEW.cluster_id) IS DISTINCT FROM (OLD.name, OLD.name_ar, OLD.latitude, OLD.longitude, OLD.cluster_id)
     AND NOT public.app_in_admin_path() THEN
    RAISE EXCEPTION 'the identity of a site changes only through an approved Change Control proposal (Q473)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_sites_identity_guard BEFORE UPDATE OF site_code, name, name_ar, latitude, longitude, cluster_id ON sites FOR EACH ROW EXECUTE FUNCTION sites_identity_guard();

-- The region trigger of 0003 (latest definition), with its message: the region-transfer path is gone.
CREATE OR REPLACE FUNCTION sites_block_region_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.region_id IS DISTINCT FROM OLD.region_id
     AND NOT app_in_admin_path() THEN
    RAISE EXCEPTION 'sites.region_id changes only through an approved Change Control proposal of a System Admin (Q473)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- The second direct path (0009): a System Admin or a delegate moved a region through a function that pmis_app could call. Closed: the move is the approved proposal.
DROP FUNCTION IF EXISTS admin_transfer_site_region(uuid, integer, text);

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Rights
-- ---------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON regions, clusters TO pmis_definer;
GRANT SELECT, UPDATE ON sites TO pmis_definer;
-- the text parser of 0062 is called by the new overload: its search path gets pg_temp last, like every function of this migration
ALTER FUNCTION p4a_site_parse(text, text) SET search_path = pg_catalog, public, pg_temp;
DO $$
DECLARE f text; cols text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'si_identity_items()', 'si_coords_text(numeric,numeric)', 'si_fail(text,text,text)', 'si_require_admin(text)', 'si_parsed_text(text,jsonb)', 'si_site_cols(uuid,text)',
    'p4a_site_current(uuid,text)', 'p4a_site_parse(uuid,text,text)', 'si_check_item(uuid,text,text,text)', 'p4a_site_change_errors(uuid,jsonb)', 'si_apply_identity(uuid)',
    'p4a_apply_site_change(uuid)', 'site_propose_identity(uuid,jsonb,text)', 'sites_identity_guard()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION site_propose_identity(uuid,jsonb,text) TO pmis_app;
    -- pmis_app keeps the update right on the columns that other paths write, and loses it on the identity (the column list is built from the table)
    REVOKE UPDATE ON sites FROM pmis_app;
    SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a WHERE a.attrelid = 'public.sites'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname NOT IN ('id', 'site_code', 'name', 'name_ar', 'region_id', 'cluster_id', 'latitude', 'longitude');
    EXECUTE format('GRANT UPDATE (%s) ON sites TO pmis_app', cols);
  END IF;
END $$;
