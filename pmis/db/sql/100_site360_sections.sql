-- Mirror of apps/api/prisma/migrations/0101_site360_sections/migration.sql (0101 -> 100).
-- 0101 (F15, 2026-11-15): SITE 360 menus. Each Master column carries a SET of menus (column metadata, owner decision 2026-11-15:
-- a column may appear in several menus, for example HOTO and O&M). Defaults (owner plan 2026-11-15, Master order A = 1):
-- design_acq = A:V; cw = W (Phase Gate) and AG:BY; sow = X:AF; te = BZ:EM; hoto = EN:EZ; om = FA:FM; dismantle = FN:FW; status = FX:GE (every menu).

ALTER TABLE master_columns ADD COLUMN IF NOT EXISTS site360_sections text[] NOT NULL DEFAULT '{}';

UPDATE master_columns SET site360_sections = ARRAY[CASE
  WHEN ord BETWEEN 1 AND 22 THEN 'design_acq'
  WHEN ord BETWEEN 23 AND 23 THEN 'cw'
  WHEN ord BETWEEN 24 AND 32 THEN 'sow'
  WHEN ord BETWEEN 33 AND 77 THEN 'cw'
  WHEN ord BETWEEN 78 AND 143 THEN 'te'
  WHEN ord BETWEEN 144 AND 156 THEN 'hoto'
  WHEN ord BETWEEN 157 AND 169 THEN 'om'
  WHEN ord BETWEEN 170 AND 179 THEN 'dismantle'
  WHEN ord BETWEEN 180 AND 187 THEN 'status'
END]::text[]
WHERE cardinality(site360_sections) = 0;

ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_site360_sections_chk;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_site360_sections_chk
  CHECK (cardinality(site360_sections) >= 1
    AND site360_sections <@ ARRAY['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om', 'status']::text[]);

COMMENT ON COLUMN master_columns.site360_sections IS 'The SITE 360 menus of the column (0101, F15): a set; status means every menu.';

-- The one door that changes the menus of a column: the whole set is replaced. System Admin rights through app_has_permission (admin.settings edit);
-- the step-up is checked by the API before the call. Status columns are fixed and cannot be changed.
CREATE OR REPLACE FUNCTION site360_set_sections(p_ord integer, p_sections text[], p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid; rs text := btrim(coalesce(p_reason, '')); before jsonb; col record; sec text[]; errs jsonb := '[]'::jsonb;
BEGIN
  a := public.app_actor();
  IF a IS NULL OR NOT public.app_has_permission(a, 'admin.settings', 'edit') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a user who may edit the settings can change the SITE 360 menus of a column.'));
  END IF;
  IF char_length(rs) < 3 OR char_length(rs) > 1000 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of 3 to 1000 characters is required.'));
  END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO sec FROM unnest(coalesce(p_sections, '{}'::text[])) AS x;
  IF cardinality(sec) = 0 OR NOT sec <@ ARRAY['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om']::text[] THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/sections', 'code', 'invalid', 'message', 'Choose one or more of the seven menus. The status columns are in every menu and cannot be changed.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  SELECT * INTO col FROM public.master_columns WHERE ord = p_ord;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  IF 'status' = ANY (col.site360_sections) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/sections', 'code', 'invalid', 'message', 'The status columns are in every menu and cannot be changed.'))));
  END IF;
  before := jsonb_build_object('ord', col.ord, 'letter', col.letter, 'sections', to_jsonb(col.site360_sections));
  UPDATE public.master_columns SET site360_sections = sec WHERE ord = p_ord;
  PERFORM public.log_audit_write('site360.column_sections_changed', 'master_column', col.letter, before,
    jsonb_build_object('ord', col.ord, 'letter', col.letter, 'sections', to_jsonb(sec)), rs, NULL, NULL, NULL, false);
  RETURN jsonb_build_object('ord', col.ord, 'letter', col.letter, 'sections', to_jsonb(sec));
END $$;

DO $$
BEGIN
  ALTER FUNCTION site360_set_sections(integer, text[], text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION site360_set_sections(integer, text[], text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION site360_set_sections(integer, text[], text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION site360_set_sections(integer, text[], text) TO pmis_app;
  END IF;
END $$;
