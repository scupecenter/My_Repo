-- 0470: decision 32, a photo field in five places that had none (additive, data only: no table, no column). The unified documents system already has
-- placements on registers, a mandatory flag and min_files / max_files, all edited in Settings > Documents > Document types, so each place is a document type
-- of kind `photo` with a placement. Photos of kind `photo` appear in the Gallery on their own (media.gallery document_kinds).
-- Defaults: optional, at least 1 photo, images only (the admin switches mandatory on and sets the minimum per type). An existing type is never touched.
DO $$
DECLARE r record; did uuid; spec jsonb; pl jsonb;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('PHOTO_WH_RECEIPT',  'Warehouse: material condition at receipt', 'المخزن: حالة المواد عند الاستلام',   'warehouse', 'te_rn'),
    ('PHOTO_WH_RECEIPT_CW', 'Warehouse: material condition at receipt (civil)', 'المخزن: حالة المواد عند الاستلام (مدني)', 'warehouse', 'cw_rn'),
    ('PHOTO_WH_RETURN',   'Warehouse: material condition at return to the supplier', 'المخزن: حالة المواد عند الإرجاع للمورد', 'warehouse', 'sup_dn'),
    ('PHOTO_DEMO_BEFORE', 'Demolition: before', 'الإزالة: قبل', 'dismantle', ''),
    ('PHOTO_DEMO_AFTER',  'Demolition: after',  'الإزالة: بعد',  'dismantle', ''),
    ('PHOTO_HOTO',        'Handover (HOTO) photos', 'صور التسليم والاستلام (HOTO)', 'readiness_handover', ''),
    ('PHOTO_HSE',         'HSE: safety and incident photos', 'السلامة: صور السلامة والحوادث', 'permits_hse', '')
  ) AS v(code, name_en, name_ar, rkey, rtype) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM document_types WHERE code = r.code);
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM register_definitions WHERE register_key = r.rkey);
    pl := jsonb_build_object('target', 'register', 'ref', r.rkey);
    IF r.rtype <> '' THEN pl := pl || jsonb_build_object('record_type', r.rtype); END IF;
    spec := jsonb_build_object('kind', 'photo', 'form_kind', NULL, 'name_en', r.name_en, 'name_ar', r.name_ar,
      'placements', jsonb_build_array(pl), 'mandatory', false, 'condition_rule', NULL,
      'formats', jsonb_build_array('jpg', 'jpeg', 'png', 'webp', 'heic'), 'max_size_mb', 20, 'min_files', 1, 'max_files', NULL, 'photo_rules', NULL,
      'expiry_tracked', false, 'blank_form_file_id', NULL, 'is_active', true);
    INSERT INTO document_types (code, name_en, kind, is_active, lib_managed, published_version, needs_review, updated_at)
    VALUES (r.code, r.name_en, 'photo', false, true, 0, false, now()) RETURNING id INTO did;
    PERFORM doc_apply_spec(did, spec);
    PERFORM doc_snapshot_version(did, 'new_only', DATE '2024-01-01', 'seed: migration 0470 (decision 32 photo fields)', 0);
  END LOOP;
END $$;
