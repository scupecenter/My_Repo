-- 0715_site_coordinates_required (contract 0.15.583): the coordinates of a new site are required (proposal "coordinates mandatory on site creation").
-- Mirror: apps/api/prisma/migrations/0715_site_coordinates_required/migration.sql (kept byte-identical).
--
-- Additive. A new site (the manual draft, the New sites template, a bulk batch, creation from the Master) needs a latitude and a longitude.
-- A row of a bulk batch without them is refused with the field error `required` and listed in the batch; the other rows go on. A pair that is
-- half filled or out of range keeps its own error (`pair_required`, `invalid`). Existing sites are not touched: only new ones are checked.
-- How: site_new_clean (the wrapper of 0257) is patched in place, idempotently, to call site_new_coords_required first. This migration sorts after
-- 0257 and after every migration that replaces site_new_clean wholesale.

CREATE OR REPLACE FUNCTION site_new_coords_required(p_res jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE errs jsonb := coalesce(p_res -> 'errors', '[]'::jsonb);
BEGIN
  IF (p_res -> 'clean') ? 'latitude' AND (p_res -> 'clean') ? 'longitude' THEN RETURN p_res; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(errs) e WHERE e ->> 'field' IN ('latitude', 'longitude')) THEN RETURN p_res; END IF;
  RETURN jsonb_set(p_res, '{errors}', errs || public.site_new_err('latitude', 'required', 'The coordinates (latitude and longitude) are required for a new site.'));
END $$;

DO $$
DECLARE def text; fixed text;
BEGIN
  def := pg_get_functiondef('public.site_new_clean(jsonb,uuid)'::regprocedure);
  IF position('site_new_coords_required' IN def) = 0 THEN
    fixed := replace(def, 'BEGIN' || E'\n' || '  IF jsonb_array_length(coalesce(res -> ''errors'', ''[]''::jsonb)) > 0 THEN RETURN res; END IF;',
                          'BEGIN' || E'\n' || '  res := public.site_new_coords_required(res);' || E'\n' || '  IF jsonb_array_length(coalesce(res -> ''errors'', ''[]''::jsonb)) > 0 THEN RETURN res; END IF;');
    IF fixed = def THEN RAISE EXCEPTION 'site_new_clean: the anchor was not found'; END IF;
    EXECUTE fixed;
  END IF;
END $$;

DO $$
BEGIN
  ALTER FUNCTION site_new_coords_required(jsonb) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION site_new_coords_required(jsonb) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION site_new_coords_required(jsonb) TO pmis_definer;
END $$;
