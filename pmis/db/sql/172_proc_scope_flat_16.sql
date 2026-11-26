-- 0173_proc_scope_flat_16: the Procurement Delivery Scope list, final owner design (2026-11-26): one flat list of 16
-- values. No sub-lists, no Trade field, no value hidden or merged, every code untouched. Mirror: db/sql/172_proc_scope_flat_16.sql (kept identical).
--
--   1. New values (additive only): Grounding, and GECOL shown as "Power (GECOL)". The `wrong_register` refusal of a
--      GECOL scope in the Procurement rules is NOT touched: entering a Procurement record with scope GECOL stays
--      refused until the GECOL re-pointing (package P1). The value exists so the list is complete and editable.
--   2. Labels (the owner's names): CW shows "Full Civil Work" and HLC shows "HLC Fiber" - HLC appears once, there is
--      no separate HLC value. Codes do not change, so the rules that read them (the B1/B2 task sources, the 0119
--      Master AJ/AK columns, the Matrix rows, the validation) and every stored record keep working unchanged.
--   3. Order: the owner's sequence - CW, Tower Erection, Site Adaption, Grounding, CW Dismantle, TE Dismantle,
--      TE Installation, STA, ST, Power (GECOL), HLC Fiber, Survey, Acquisition Visit, Inspection, Maintenance,
--      Emergency. sort_order is renumbered to match and the field options are refreshed from the list.
--   Every value stays editable in Settings > Lists (add, rename, reorder, hide). Arabic labels of the untouched
--   values are left as they are; the new or renamed labels carry Arabic that Settings can edit.

SELECT set_config('app.region_ids', '*', true);

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('ProcScope', 'Grounding', 'Grounding',      'التأريض',             40),
  ('ProcScope', 'GECOL',     'Power (GECOL)',  'الكهرباء (GECOL)',    100)
ON CONFLICT (catalogue_code, code) DO NOTHING;

UPDATE public.list_values SET label_en = 'Full Civil Work', label_ar = 'الأعمال المدنية الكاملة'
  WHERE catalogue_code = 'ProcScope' AND code = 'CW';
UPDATE public.list_values SET label_en = 'HLC Fiber', label_ar = 'ألياف HLC'
  WHERE catalogue_code = 'ProcScope' AND code = 'HLC';

UPDATE public.list_values v SET sort_order = x.ord
  FROM (VALUES
    ('CW', 10), ('Tower Erection', 20), ('Site Adaption', 30), ('Grounding', 40),
    ('CW Dismantle', 50), ('TE Dismantle', 60), ('TE Installation', 70),
    ('STA', 80), ('ST', 90), ('GECOL', 100), ('HLC', 110),
    ('Survey', 120), ('Acquisition Visit', 130), ('Inspection', 140), ('Maintenance', 150), ('Emergency', 160)
  ) AS x(code, ord)
  WHERE v.catalogue_code = 'ProcScope' AND v.code = x.code;

SELECT public.list_refresh_fields('ProcScope');
