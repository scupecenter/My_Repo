-- 0022_dismantle_rules_v2: two more Dismantle rules in the existing trigger function dismantle_rules (0021 is merged and stays untouched).
-- Mirror: db/sql/021_dismantle_rules_v2.sql (kept identical).
--
-- Owner decisions 2026-11-01 (Q101, spec registers-and-streams.md 3.16):
--   a. the work start date must be on or after the RFD date;
--   b. once a part is closed (its approved, current version has closed = true) no new version of that part can be created.
-- Rule (b) sits in this row trigger, not in reg_new_version (0019): every version is an INSERT with supersedes_id set, so the trigger covers
-- reg_new_version and any other path with one check and without copying the 0019 function. The trigger runs after the grant and holder
-- checks of reg_new_version, so a caller without rights still gets the usual 403.
-- Unchanged: closing still needs closing_rn_ref (the link to the Warehouse RN record replaces it when that register is built, Q101).
-- The trigger fires only on insert and on a change of data, so records saved before this migration are not re-checked until they change.

CREATE OR REPLACE FUNCTION dismantle_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := NEW.data; errs jsonb := '[]'::jsonb; k text; dup uuid;
BEGIN
  IF NEW.record_type IS NULL THEN
    errs := errs || public.reg_err_item('/record_type', 'required', 'The part (cw or te) is required.');
  END IF;
  IF NEW.custom IS NOT NULL AND NEW.custom <> '{}'::jsonb THEN
    errs := errs || public.reg_err_item('/custom', 'unknown_field', 'Custom fields are not available on Dismantle yet.');
  END IF;
  -- the RFD must exist before any later step (its own document reference belongs to the same step)
  IF NOT (d ? 'rfd_date') THEN
    FOR k IN SELECT jsonb_object_keys(d) LOOP
      IF k NOT IN ('rfd_date', 'rfd_document_ref') THEN
        errs := errs || public.reg_err_item('/data/' || k, 'rfd_required', 'The RFD date must be entered before any later step.');
      END IF;
    END LOOP;
  END IF;
  -- 0022 (a): the work cannot start before the RFD
  IF d ? 'rfd_date' AND d ? 'work_start_date' AND (d ->> 'work_start_date')::date < (d ->> 'rfd_date')::date THEN
    errs := errs || public.reg_err_item('/data/work_start_date', 'start_before_rfd', 'The work start is before the RFD date.');
  END IF;
  IF d ? 'work_start_date' AND d ? 'work_end_date' AND (d ->> 'work_end_date')::date < (d ->> 'work_start_date')::date THEN
    errs := errs || public.reg_err_item('/data/work_end_date', 'end_before_start', 'The work end is before the work start.');
  END IF;
  -- Q101: until the Warehouse register links the real RN, closing needs the RN reference
  IF coalesce((d ->> 'closed')::boolean, false) AND btrim(coalesce(d ->> 'closing_rn_ref', '')) = '' THEN
    errs := errs || public.reg_err_item('/data/closing_rn_ref', 'rn_required', 'A part closes only with the reference of its signed RN.');
  END IF;
  -- 0022 (b): a closed part is final; a new version is a row with supersedes_id pointing at the closed, current, approved version
  IF TG_OP = 'INSERT' AND NEW.supersedes_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.register_records p
       WHERE p.id = NEW.supersedes_id AND p.state = 'approved' AND p.is_current AND coalesce((p.data ->> 'closed')::boolean, false)) THEN
    errs := errs || public.reg_err_item('/data/closed', 'part_closed', 'This part is closed: a closed part cannot get a new version.');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;

  IF TG_OP = 'INSERT' AND NEW.version_no = 1 THEN
    SELECT x.id INTO dup FROM public.register_records x
      WHERE x.register_key = 'dismantle' AND x.site_id = NEW.site_id AND x.record_type = NEW.record_type AND x.version_no = 1 AND x.state <> 'voided';
    IF dup IS NOT NULL THEN
      PERFORM public.wf_err('duplicate', jsonb_build_object('existing_id', dup, 'detail', 'This site already has a ' || upper(NEW.record_type) || ' Dismantle record: create a new version of it.'));
    END IF;
  END IF;
  RETURN NEW;
END $$;
