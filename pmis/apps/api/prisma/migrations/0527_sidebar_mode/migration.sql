-- 0527: the personal sidebar gains `mode` ('pinned' = the menu stays open, the default; 'autohide' = it collapses to a rail and opens on hover, focus or the
-- keyboard shortcut). Ahmed's decision 2026-11-25, approved again 2026-11-27. Additive: ui_nav_check is patched in place (owner and grants stay), a stored
-- sidebar without `mode` is unchanged. No table, no new setting, no reset-plan change (the value lives in users.ui_prefs, already classified).
-- The audit in idm_update_own_profile is generic over the keys, so `mode` is audited like the other sidebar keys.

CREATE OR REPLACE FUNCTION ui_nav_check(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o jsonb := '{}'::jsonb; bad text; v text; name text; el jsonb; seen text[]; items jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN o; END IF;
  IF jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar must be an object'; END IF;
  SELECT string_agg(key, ', ' ORDER BY key COLLATE "C") INTO bad FROM jsonb_object_keys(p) key
   WHERE key NOT IN ('hidden', 'order', 'badge_style', 'pins', 'mode');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar: unknown key: %', bad; END IF;
  IF p ? 'badge_style' THEN
    IF jsonb_typeof(p -> 'badge_style') <> 'string' OR NOT ((p ->> 'badge_style') IN ('full', 'dot', 'none')) THEN
      RAISE EXCEPTION 'profile: ui_prefs.sidebar: badge_style must be full, dot or none';
    END IF;
    o := o || jsonb_build_object('badge_style', p ->> 'badge_style');
  END IF;
  IF p ? 'mode' THEN
    IF jsonb_typeof(p -> 'mode') <> 'string' OR NOT ((p ->> 'mode') IN ('pinned', 'autohide')) THEN
      RAISE EXCEPTION 'profile: ui_prefs.sidebar: mode must be pinned or autohide';
    END IF;
    o := o || jsonb_build_object('mode', p ->> 'mode');
  END IF;
  FOREACH name IN ARRAY ARRAY['hidden', 'order', 'pins'] LOOP
    CONTINUE WHEN NOT (p ? name);
    IF jsonb_typeof(p -> name) <> 'array' THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar: % must be a list of menu keys', name; END IF;
    seen := '{}'; items := '[]'::jsonb;
    FOR el IN SELECT * FROM jsonb_array_elements(p -> name) LOOP
      IF jsonb_typeof(el) <> 'string' OR el #>> '{}' !~ '^[a-z0-9_.]{1,60}$' THEN
        RAISE EXCEPTION 'profile: ui_prefs.sidebar: % holds an entry that is not a menu key', name;
      END IF;
      IF NOT (el #>> '{}' = ANY (seen)) THEN seen := seen || (el #>> '{}'); items := items || jsonb_build_array(el); END IF;
    END LOOP;
    IF jsonb_array_length(items) > 200 THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar: % holds at most 200 entries', name; END IF;
    IF name = 'pins' AND jsonb_array_length(items) > 20 THEN RAISE EXCEPTION 'profile: ui_prefs.sidebar: pins holds at most 20 shortcuts'; END IF;
    o := o || jsonb_build_object(name, items);
  END LOOP;
  RETURN o;
END $$;
