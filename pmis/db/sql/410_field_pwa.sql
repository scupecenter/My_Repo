-- 0411_field_pwa: the field PWA (offline work for site teams), phase 1 (narrow scope: task read, snag photo upload and snag fix submit offline, with sync/conflict rules and rights). One additive change: the section "field_pwa" of the guarded ui.features setting
--   (Settings > Screens > Field mode). OFF by default. It holds the switch, how long the read cache lives, the size of the queue of waiting actions,
--   the largest photo the device queues and the retry interval. A stored value without the section takes the seed.
--   No table, no permission change, nothing public. The stored text of ui_features_seed() and ui_features_validate() is patched IN PLACE and idempotently
--   (never rebuilt from an old base), so every section added by other migrations (data_hub, panel, ...) stays.
-- Mirror: db/sql/410_field_pwa.sql (kept byte-identical).

SELECT set_config('app.region_ids', '*', true);

DO $$
DECLARE
  def text;
  seed_marker text := '"panel": {';
  seed_add text := '"field_pwa": {"enabled": false, "cache_hours": 24, "max_queue": 50, "max_photo_mb": 8, "sync_seconds": 60}, ';
  list_marker text := '''inbox'', ''panel''';
  list_add text := '''inbox'', ''field_pwa'', ''panel''';
  block_marker text := '  s := p_sections -> ''panel'';';
  block_add text := $blk$  s := p_sections -> 'field_pwa';
  IF s IS NOT NULL THEN
    IF jsonb_typeof(s) <> 'object' THEN
      errs := errs || public.reg_err_item('/sections/field_pwa', 'invalid', 'An object.');
    ELSE
      FOR kk IN SELECT jsonb_object_keys(s) LOOP
        IF kk NOT IN ('enabled', 'cache_hours', 'max_queue', 'max_photo_mb', 'sync_seconds') THEN errs := errs || public.reg_err_item('/sections/field_pwa/' || kk, 'unknown_key', 'Unknown key.'); END IF;
      END LOOP;
      IF jsonb_typeof(s -> 'enabled') IS DISTINCT FROM 'boolean' THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/enabled', 'invalid', 'true or false.'); END IF;
      IF jsonb_typeof(s -> 'cache_hours') IS DISTINCT FROM 'number' OR (s ->> 'cache_hours') !~ '^[0-9]+$' THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/cache_hours', 'invalid', 'A whole number of hours from 1 to 168.');
      ELSIF (s ->> 'cache_hours')::integer < 1 OR (s ->> 'cache_hours')::integer > 168 THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/cache_hours', 'out_of_range', 'From 1 to 168 hours.');
      END IF;
      IF jsonb_typeof(s -> 'max_queue') IS DISTINCT FROM 'number' OR (s ->> 'max_queue') !~ '^[0-9]+$' THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/max_queue', 'invalid', 'A whole number of waiting actions from 5 to 200.');
      ELSIF (s ->> 'max_queue')::integer < 5 OR (s ->> 'max_queue')::integer > 200 THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/max_queue', 'out_of_range', 'From 5 to 200 actions.');
      END IF;
      IF jsonb_typeof(s -> 'max_photo_mb') IS DISTINCT FROM 'number' OR (s ->> 'max_photo_mb') !~ '^[0-9]+$' THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/max_photo_mb', 'invalid', 'A whole number of MB from 1 to 25.');
      ELSIF (s ->> 'max_photo_mb')::integer < 1 OR (s ->> 'max_photo_mb')::integer > 25 THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/max_photo_mb', 'out_of_range', 'From 1 to 25 MB.');
      END IF;
      IF jsonb_typeof(s -> 'sync_seconds') IS DISTINCT FROM 'number' OR (s ->> 'sync_seconds') !~ '^[0-9]+$' THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/sync_seconds', 'invalid', 'A whole number of seconds from 15 to 600.');
      ELSIF (s ->> 'sync_seconds')::integer < 15 OR (s ->> 'sync_seconds')::integer > 600 THEN
        errs := errs || public.reg_err_item('/sections/field_pwa/sync_seconds', 'out_of_range', 'From 15 to 600 seconds.');
      END IF;
    END IF;
  END IF;

$blk$;
BEGIN
  def := pg_get_functiondef('public.ui_features_seed()'::regprocedure);
  IF position('field_pwa' IN def) = 0 THEN
    IF position(seed_marker IN def) = 0 THEN RAISE EXCEPTION 'ui_features_seed() has no panel section to patch'; END IF;
    EXECUTE replace(def, seed_marker, seed_add || seed_marker);
  END IF;

  def := pg_get_functiondef('public.ui_features_validate(jsonb)'::regprocedure);
  IF position('field_pwa' IN def) = 0 THEN
    IF position(list_marker IN def) = 0 THEN RAISE EXCEPTION 'ui_features_validate() has no section list to patch'; END IF;
    IF position(block_marker IN def) = 0 THEN RAISE EXCEPTION 'ui_features_validate() has no panel block to patch'; END IF;
    EXECUTE replace(replace(def, list_marker, list_add), block_marker, block_add || block_marker);
  END IF;
END $$;

-- The screen in the side menu (Work > Field mode): its key in the catalogue that validates a saved menu layout (0081). Additive; an existing key is kept.
INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
VALUES ('field', 'work', 95, '0411')
ON CONFLICT (key) DO NOTHING;

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('field_pwa_applied', 'workflow', NULL,
        jsonb_build_object('ui_features', 'section field_pwa added to ui.features', 'enabled', false, 'cache_hours', 24, 'max_queue', 50, 'max_photo_mb', 8, 'sync_seconds', 60),
        'Field PWA setting section, off by default (migration 0411, contract 0.15.340).');

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['ui_features_seed()', 'ui_features_validate(jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO pmis_definer', f);
  END LOOP;
END $$;
