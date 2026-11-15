-- 0101 (F15, 2026-11-15): SITE 360 menus. Each Master column belongs to one menu section (column metadata).
-- Ranges (owner plan 2026-11-15, Master order A = 1): design_acq = A:V (identity, coordinates, tower, RF, acquisition, Site Release);
-- cw = W (Phase Gate) and AG:BY (CW procurement through CW PAC, GECOL, HLC, Site RFI); sow = X:AF (Project Phase to TE SOW);
-- te = BZ:EM (TE access through TE PAC); hoto = EN:EZ (cluster optimization, launch, HOTO); om = FA:FM (DLP/FAC, final closure);
-- dismantle = FN:FW (CW and TE bands); status = FX:GE (every menu). One section per column: no overlap between HOTO and O&M.
ALTER TABLE master_columns ADD COLUMN IF NOT EXISTS site360_section text;

UPDATE master_columns SET site360_section = CASE
  WHEN ord BETWEEN 1 AND 22 THEN 'design_acq'
  WHEN ord BETWEEN 23 AND 23 THEN 'cw'
  WHEN ord BETWEEN 24 AND 32 THEN 'sow'
  WHEN ord BETWEEN 33 AND 77 THEN 'cw'
  WHEN ord BETWEEN 78 AND 143 THEN 'te'
  WHEN ord BETWEEN 144 AND 156 THEN 'hoto'
  WHEN ord BETWEEN 157 AND 169 THEN 'om'
  WHEN ord BETWEEN 170 AND 179 THEN 'dismantle'
  WHEN ord BETWEEN 180 AND 187 THEN 'status'
END
WHERE site360_section IS NULL;

ALTER TABLE master_columns ALTER COLUMN site360_section SET NOT NULL;
ALTER TABLE master_columns DROP CONSTRAINT IF EXISTS master_columns_site360_section_chk;
ALTER TABLE master_columns ADD CONSTRAINT master_columns_site360_section_chk
  CHECK (site360_section IN ('design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om', 'status'));

COMMENT ON COLUMN master_columns.site360_section IS 'The SITE 360 menu of the column (0101, F15). status columns are in every menu.';

-- The one door that moves a column: System Admin rights through app_has_permission (admin.settings edit); the step-up is checked by the API before the call.
CREATE OR REPLACE FUNCTION site360_move_column(p_ord integer, p_section text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a uuid; rs text := btrim(coalesce(p_reason, '')); before jsonb; col record; errs jsonb := '[]'::jsonb;
BEGIN
  a := public.app_actor();
  IF a IS NULL OR NOT public.app_has_permission(a, 'admin.settings', 'edit') THEN
    PERFORM public.wf_err('action_forbidden', jsonb_build_object('detail', 'Only a user who may edit the settings can move a SITE 360 column.'));
  END IF;
  IF char_length(rs) < 3 OR char_length(rs) > 1000 THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/reason', 'code', 'required', 'message', 'A reason of 3 to 1000 characters is required.'));
  END IF;
  IF p_section IS NULL OR p_section NOT IN ('design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om') THEN
    errs := errs || jsonb_build_array(jsonb_build_object('path', '/section', 'code', 'invalid', 'message', 'The section must be one of the seven menus. The status columns cannot be moved.'));
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  SELECT * INTO col FROM public.master_columns WHERE ord = p_ord;
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'No Master column has this order.')); END IF;
  IF col.site360_section = 'status' THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/section', 'code', 'invalid', 'message', 'The status columns cannot be moved.'))));
  END IF;
  before := jsonb_build_object('ord', col.ord, 'letter', col.letter, 'section', col.site360_section);
  UPDATE public.master_columns SET site360_section = p_section WHERE ord = p_ord;
  PERFORM public.log_audit_write('site360.column_moved', 'master_column', col.letter, before,
    jsonb_build_object('ord', col.ord, 'letter', col.letter, 'section', p_section), rs, NULL, NULL, NULL, false);
  RETURN jsonb_build_object('ord', col.ord, 'letter', col.letter, 'section', p_section);
END $$;

DO $$
BEGIN
  ALTER FUNCTION site360_move_column(integer, text, text) OWNER TO pmis_definer;
  REVOKE ALL ON FUNCTION site360_move_column(integer, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION site360_move_column(integer, text, text) TO pmis_definer;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION site360_move_column(integer, text, text) TO pmis_app;
  END IF;
END $$;
