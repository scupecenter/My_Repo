-- 0412_map_tiles: the site map on real tiles, phase 2 of field mode (design note approved: option C, self-hosted tiles on the same origin). One additive change: the
--   section "map" of the guarded ui.features setting (Settings > Screens > Map). OFF by default. It holds the switch, the tile URL template (EMPTY by default; only a
--   path on this server, for example /tiles/{z}/{x}/{y}.png, never another host, so the Content-Security-Policy is unchanged), the zoom range, the attribution
--   text and the start view. A stored value without the section takes the seed.
--   No table, no permission change, no external account, nothing public. The stored text of ui_features_seed() and ui_features_validate() is patched IN PLACE
--   and idempotently (never rebuilt from an old base), so every section added by other migrations stays.
-- Mirror: db/sql/411_map_tiles.sql (kept byte-identical).

SELECT set_config('app.region_ids', '*', true);

DO $$
DECLARE
  def text;
  seed_marker text := '"panel": {';
  seed_add text := '"map": {"enabled": false, "tile_url": "", "min_zoom": 0, "max_zoom": 18, "attribution": "", "center_lat": 32.9, "center_lon": 13.2, "default_zoom": 6}, ';
  list_marker text := '''panel'', ''data_hub''';
  list_add text := '''panel'', ''data_hub'', ''map''';
  block_marker text := '  s := p_sections -> ''panel'';';
  block_add text := $blk$  s := p_sections -> 'map';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/map', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('enabled', 'tile_url', 'min_zoom', 'max_zoom', 'attribution', 'center_lat', 'center_lon', 'default_zoom') THEN errs := errs || public.reg_err_item('/sections/map/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'enabled') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/map/enabled', 'invalid', 'true or false.'); END IF;
      -- the tile URL: empty (no tiles) or a path on this server with {z}, {x} and {y}; no host, no scheme, no "//", no "..", no query or spaces
      IF jsonb_typeof(s -> 'tile_url') IS DISTINCT FROM 'string' THEN
        errs := errs || public.reg_err_item('/sections/map/tile_url', 'invalid', 'A text.');
      ELSIF (s ->> 'tile_url') <> '' AND (
              (s ->> 'tile_url') !~ '^/[A-Za-z0-9._~/{}-]{1,198}$' OR (s ->> 'tile_url') LIKE '//%' OR (s ->> 'tile_url') LIKE '%..%' OR (s ->> 'tile_url') LIKE '%//%'
              OR (s ->> 'tile_url') NOT LIKE '%{z}%' OR (s ->> 'tile_url') NOT LIKE '%{x}%' OR (s ->> 'tile_url') NOT LIKE '%{y}%') THEN
        errs := errs || public.reg_err_item('/sections/map/tile_url', 'invalid', 'Empty, or a path on this server such as /tiles/{z}/{x}/{y}.png (no other host).');
      END IF;
      IF jsonb_typeof(s -> 'min_zoom') IS DISTINCT FROM 'number' OR (s ->> 'min_zoom') !~ '^[0-9]+$' OR (s ->> 'min_zoom')::integer > 19 THEN
        errs := errs || public.reg_err_item('/sections/map/min_zoom', 'invalid', 'A whole number from 0 to 19.'); END IF;
      IF jsonb_typeof(s -> 'max_zoom') IS DISTINCT FROM 'number' OR (s ->> 'max_zoom') !~ '^[0-9]+$' OR (s ->> 'max_zoom')::integer > 19 THEN
        errs := errs || public.reg_err_item('/sections/map/max_zoom', 'invalid', 'A whole number from 0 to 19.');
      ELSIF jsonb_typeof(s -> 'min_zoom') = 'number' AND (s ->> 'min_zoom') ~ '^[0-9]+$' AND (s ->> 'max_zoom')::integer < (s ->> 'min_zoom')::integer THEN
        errs := errs || public.reg_err_item('/sections/map/max_zoom', 'out_of_range', 'Not below the minimum zoom.');
      END IF;
      IF jsonb_typeof(s -> 'attribution') IS DISTINCT FROM 'string' OR char_length(s ->> 'attribution') > 200 THEN
        errs := errs || public.reg_err_item('/sections/map/attribution', 'invalid', 'A text of at most 200 characters.'); END IF;
      IF NOT coalesce(CASE WHEN jsonb_typeof(s -> 'center_lat') = 'number' THEN (s ->> 'center_lat')::numeric BETWEEN -85 AND 85 END, false) THEN
        errs := errs || public.reg_err_item('/sections/map/center_lat', 'invalid', 'A latitude from -85 to 85.'); END IF;
      IF NOT coalesce(CASE WHEN jsonb_typeof(s -> 'center_lon') = 'number' THEN (s ->> 'center_lon')::numeric BETWEEN -180 AND 180 END, false) THEN
        errs := errs || public.reg_err_item('/sections/map/center_lon', 'invalid', 'A longitude from -180 to 180.'); END IF;
      IF jsonb_typeof(s -> 'default_zoom') IS DISTINCT FROM 'number' OR (s ->> 'default_zoom') !~ '^[0-9]+$' OR (s ->> 'default_zoom')::integer > 19 THEN
        errs := errs || public.reg_err_item('/sections/map/default_zoom', 'invalid', 'A whole number from 0 to 19.'); END IF;
    END IF;
  END IF;

$blk$;
BEGIN
  def := pg_get_functiondef('public.ui_features_seed()'::regprocedure);
  IF position('"map"' IN def) = 0 THEN
    IF position(seed_marker IN def) = 0 THEN RAISE EXCEPTION 'ui_features_seed() has no panel section to patch'; END IF;
    EXECUTE replace(def, seed_marker, seed_add || seed_marker);
  END IF;

  def := pg_get_functiondef('public.ui_features_validate(jsonb)'::regprocedure);
  IF position('/sections/map' IN def) = 0 THEN
    IF position(list_marker IN def) = 0 THEN RAISE EXCEPTION 'ui_features_validate() has no section list to patch'; END IF;
    IF position(block_marker IN def) = 0 THEN RAISE EXCEPTION 'ui_features_validate() has no panel block to patch'; END IF;
    EXECUTE replace(replace(def, list_marker, list_add), block_marker, block_add || block_marker);
  END IF;
END $$;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('map_tiles_applied', 'workflow', NULL,
        jsonb_build_object('ui_features', 'section map added to ui.features', 'enabled', false, 'tile_url', ''),
        'Map tiles setting section, off by default, same-origin tiles only (migration 0412, contract 0.15.341).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ui_features_seed()', 'ui_features_validate(jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
END $$;
