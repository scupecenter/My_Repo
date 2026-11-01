-- 0021_dismantle_register: the Dismantle register on the generic register framework of 0019 (no new endpoint, no new table).
-- Mirror: db/sql/020_dismantle_register.sql (kept identical).
--
-- Owner decision 2026-10-31 (docs/plans/2026-10-31-dismantle-stream-views-documents.md section 1, spec registers-and-streams.md 3.16):
--   * Dismantle has two parts per site, CW Dismantle and TE Dismantle: record types 'cw' and 'te', one logical record per site per part
--     (the first version of a part is unique per site; later versions are corrections, R9).
--   * Only the data the Dismantle register owns is seeded. PR, PO / WO, assignment mode and team stay in Procurement (scopes "CW Dismantle" and
--     "TE Dismantle" are in its scope list since 0019); the dismantle permits stay in Permits & HSE; the RN stays in Warehouse (Q50, Q101).
--   * Rules live in the database (trigger dismantle_rules): the RFD first, work end not before work start, a closed part needs its RN
--     reference, one record per part per site. "No future actual date" is the generic is_actual rule of reg_clean_data (0019).
--   * The matrix row ('dismantle', 3 levels) was seeded in 0020; the typed projection reg_apply has no Dismantle branch on purpose: an approved
--     Dismantle record stays in register_records until a Dismantle typed table is wanted (Master FN:FW export, Q99).
-- The Warehouse register is disabled, so "a part closes only when its signed RN is received in Warehouse" cannot be enforced yet:
-- closing requires the RN reference typed by the user (Q101).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Enable the register and give it its two parts
-- ---------------------------------------------------------------------------------------------------------------------
UPDATE register_definitions SET record_types = ARRAY['cw', 'te'], enabled = true WHERE register_key = 'dismantle';

-- One logical record per site per part. The trigger below answers a clash with the normal 409 duplicate; this index is the race backstop.
CREATE UNIQUE INDEX register_records_one_dismantle_part_idx ON register_records (site_id, record_type)
  WHERE register_key = 'dismantle' AND version_no = 1 AND state <> 'voided';

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Fields owned by Dismantle (idempotent). The reason list is a placeholder: the owner edits its values (Q101).
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order) VALUES
  ('dismantle', 'rfd_date',            'RFD Date',                   'تاريخ طلب الفك (RFD)',     'date',    true,  true,  false, NULL, true,  'RFD', 10),
  ('dismantle', 'rfd_document_ref',    'RFD Document Reference',     'مرجع مستند طلب الفك',      'text',    false, false, false, NULL, false, 'RFD', 20),
  ('dismantle', 'dismantle_reason',    'Dismantle Reason',           'سبب الفك',                 'list',    false, false, false,
     '["Swap", "Relocation", "Cancellation", "Other"]'::jsonb, true, 'Reason', 30),
  ('dismantle', 'supervising_engineer','Supervising Engineer',       'مهندس الإشراف',            'user',    false, false, false, NULL, false, 'Supervision and work', 40),
  ('dismantle', 'work_start_date',     'Work Start Date',            'تاريخ بدء العمل',          'date',    false, true,  false, NULL, true,  'Supervision and work', 50),
  ('dismantle', 'work_end_date',       'Work End Date',              'تاريخ انتهاء العمل',       'date',    false, true,  false, NULL, true,  'Supervision and work', 60),
  ('dismantle', 'closing_rn_ref',      'Closing RN Reference',       'مرجع إيصال الإرجاع (RN)',  'text',    false, false, false, NULL, false, 'Close', 70),
  ('dismantle', 'closed',              'Part Closed',                'الجزء مغلق',               'yes_no',  false, false, false, NULL, true,  'Close', 80)
ON CONFLICT (register_key, code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Rules (blocking, field-level errors like reg_clean_data). Fires on every insert and every change of the data of a Dismantle record.
-- ---------------------------------------------------------------------------------------------------------------------
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
  IF d ? 'work_start_date' AND d ? 'work_end_date' AND (d ->> 'work_end_date')::date < (d ->> 'work_start_date')::date THEN
    errs := errs || public.reg_err_item('/data/work_end_date', 'end_before_start', 'The work end is before the work start.');
  END IF;
  -- Q101: until the Warehouse register links the real RN, closing needs the RN reference
  IF coalesce((d ->> 'closed')::boolean, false) AND btrim(coalesce(d ->> 'closing_rn_ref', '')) = '' THEN
    errs := errs || public.reg_err_item('/data/closing_rn_ref', 'rn_required', 'A part closes only with the reference of its signed RN.');
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

CREATE TRIGGER b_dismantle_rules BEFORE INSERT OR UPDATE OF data, record_type, custom ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'dismantle') EXECUTE FUNCTION dismantle_rules();

ALTER FUNCTION dismantle_rules() OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION dismantle_rules() FROM PUBLIC;
