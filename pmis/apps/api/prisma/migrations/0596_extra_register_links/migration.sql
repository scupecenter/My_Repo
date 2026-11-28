-- 0596_extra_register_links: five extra register links, declared with their fields (L10, D60 follow-up, contract 0.15.456). Additive; no table, no grant, no permission change; nothing is deleted.
-- Mirror: db/sql/595_extra_register_links.sql (kept identical to prisma/migrations/0596_extra_register_links/migration.sql).
--
-- Each link is a field that holds the id of a record of another register, declared once in `register_links` (0409) so it gets the generic picker, the Related records panel
-- (both sides), the orphan report and the filters without new code. All three are optional text fields, same site, declared with enforce = false: switch the check on in
-- Settings after the orphan check (register_link_orphans()).
--   lessons_learned.incident_id  -> incidents       the incident a lesson comes from
--   lessons_learned.issue_id     -> issues          the issue a lesson comes from
--   incidents.permit_id          -> permits_hse     the permit to work (PTW) the incident happened under
--   car_dispatcher.parent_booking_id       -> car_dispatcher (booking)    the booking an extension continues (field exists since 0075; had no picker link)
--   financial_advances.parent_advance_id    -> financial_advances (advance) the advance a top-up continues (same)
-- A row is written only when both registers exist, and every statement is idempotent.
SELECT set_config('app.region_ids', '*', true);

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order)
SELECT v.* FROM (VALUES
  ('lessons_learned', 'incident_id', 'Incident (optional)',       'الحادث (اختياري)',       'text', false, false, false, NULL::text, false, 'Lesson',   45),
  ('lessons_learned', 'issue_id',    'Issue (optional)',          'المشكلة (اختياري)',      'text', false, false, false, NULL::text, false, 'Lesson',   46),
  ('incidents',       'permit_id',   'Permit to work (optional)', 'تصريح العمل (اختياري)',  'text', false, false, false, NULL::text, false, 'Incident', 45)
) v(register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order)
WHERE EXISTS (SELECT 1 FROM register_definitions d WHERE d.register_key = v.register_key)
ON CONFLICT (register_key, code) DO NOTHING;

INSERT INTO register_links (register_key, field_code, target_register, target_record_type, same_site, label_fields, enforce, sort_order)
SELECT v.* FROM (VALUES
  ('lessons_learned', 'incident_id', 'incidents',   NULL::text, true, ARRAY['incident_date', 'incident_type']::text[], false, 1100),
  ('lessons_learned', 'issue_id',    'issues',      NULL::text, true, ARRAY['issue_no', 'issue_category']::text[],     false, 1110),
  ('incidents',       'permit_id',   'permits_hse', NULL::text, true, ARRAY['permit_type', 'status']::text[],          false, 1120),
  ('car_dispatcher',  'parent_booking_id', 'car_dispatcher',     'booking', true, ARRAY['plate_no', 'from_date', 'to_date']::text[], false, 1130),
  ('financial_advances', 'parent_advance_id', 'financial_advances', 'advance', true, ARRAY['advance_kind', 'disbursed_date']::text[],   false, 1140)
) v(register_key, field_code, target_register, target_record_type, same_site, label_fields, enforce, sort_order)
WHERE EXISTS (SELECT 1 FROM register_definitions d WHERE d.register_key = v.register_key)
  AND EXISTS (SELECT 1 FROM register_definitions d WHERE d.register_key = v.target_register)
ON CONFLICT (register_key, field_code) DO NOTHING;

-- the upload / download templates read the register fields
SELECT tpl_sync_all();
