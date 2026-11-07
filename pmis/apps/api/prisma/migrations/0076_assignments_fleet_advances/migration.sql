-- 0076_assignments_fleet_advances: field assignments in Procurement, the Car Dispatcher and Financial Advances registers, and the mobilization tasks
-- (owner decisions Q495-Q516 of 2026-11-07, plan docs/plans/2026-11-07-assignments-fleet-advances.md, contract 0.15.0).
--
--   1. ProcScope gets Survey, Acquisition Visit, Inspection, Maintenance and Emergency. The Procurement "Assignment" section gets the members, the field-work
--      dates, vehicle / advance required (a "not required" answer needs a reason) and the derived readiness. No Master column, the PR-PO export is unchanged.
--   2. Two registers, car_dispatcher (vehicle, booking; not site-scoped) and financial_advances (advance, expense, settlement; site-scoped), each with a Matrix
--      row (empty in the seed), the two fixed levels, the permission module of the same name and a template. Plain roles Fleet Dispatcher and Finance Officer.
--   3. vehicle_reservations: a btree_gist EXCLUDE constraint, so one vehicle is never reserved for overlapping dates (409 vehicle_already_reserved).
--   4. The link rule: a Procurement record with field work approved at L2 opens one draft booking (vehicle_required) and one draft individual advance per
--      member (advance_required), in the same transaction, idempotent on re-approval. Readiness is derived; ready_date feeds the tasks MOB-1, MOB-2, MOB-5.
--   5. Amounts of the advances are hidden from everybody but Finance, the Project Manager, the custodian and the custodian's manager (Q512). An expense is
--      never approved by its custodian (403 self_approval_forbidden).
--   6. MOB-1 (stage 1), MOB-2 (stage 2, after B2), MOB-5 (stage 5): counts_toward_milestone = false, in no gate condition, no document (Q515), SLA 2 to 3
--      working days from the L2 approval of the Procurement record (Q513), L1 Project Procurement Team and L2 the stage lead (Q514), applicability as A2 / B2 / all (Q516).
--      Milestones, gates, weights, existing tasks, existing SLA and the Master export are not touched.
-- Documented defaults (the admin edits them): the MOB responsible party is empty; scopes Inspection, Maintenance and Emergency feed no MOB task (data_in of
-- register_task_sources); the catalogue of advance kinds is AdvanceKind (list codes cannot hold an underscore).

SELECT set_config('app.region_ids', '*', true);
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. List catalogues
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('ProcScope', 'Survey',            'Survey',            'مسح',          1010),
  ('ProcScope', 'Acquisition Visit', 'Acquisition Visit', 'زيارة استحواذ', 1020),
  ('ProcScope', 'Inspection',        'Inspection',        'تفتيش',        1030),
  ('ProcScope', 'Maintenance',       'Maintenance',       'صيانة',        1040),
  ('ProcScope', 'Emergency',         'Emergency',         'طوارئ',        1050)
ON CONFLICT (catalogue_code, code) DO NOTHING;

INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('MemberRole',     'Assignment member role', 'دور عضو المهمة',     false, 'pending', false, 'Supervisor or executor of a field assignment (Q496).'),
  ('VehicleType',    'Vehicle type',           'نوع السيارة',        false, 'pending', false, 'Car Dispatcher fleet master.'),
  ('BookingType',    'Required vehicle type',  'نوع السيارة المطلوبة', false, 'pending', false, 'Car Dispatcher booking.'),
  ('AdvanceKind',    'Advance kind',           'نوع العهدة',         false, 'pending', false, 'Financial Advances (plan code ADVANCE_KIND).'),
  ('ExpenseKind',    'Expense kind',           'نوع المصروف',        false, 'pending', false, 'Financial Advances expenses.'),
  ('PaymentMethod',  'Payment method',         'طريقة الدفع',        false, 'pending', false, 'Financial Advances disbursement.'),
  ('HomeRegion',     'Vehicle home region',    'المنطقة الأم للسيارة', false, 'pending', false, 'Car Dispatcher: a booking outside it is allowed with a warning (Q510).'),
  ('VehicleStatus',  'Vehicle status',         'حالة السيارة',       true,  'pending', false, 'Drives whether a vehicle is bookable (available).'),
  ('BookingState',   'Booking state',          'حالة الحجز',         true,  'pending', false, 'Drives the reservation and the readiness of an assignment.'),
  ('AdvanceScope',   'Advance scope',          'نوع العهدة',         true,  'pending', false, 'Individual or group (Q497).'),
  ('AdvanceState',   'Advance state',          'حالة العهدة',        true,  'pending', false, 'Drives the readiness of an assignment and the balance.')
ON CONFLICT (code) DO NOTHING;
INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order)
SELECT v.c, v.code, v.code, v.ar, v.ord FROM (VALUES
  ('MemberRole', 'supervisor', 'مشرف', 10), ('MemberRole', 'executor', 'منفذ', 20),
  ('VehicleType', 'Pickup 4x4', 'بيك أب دفع رباعي', 10), ('VehicleType', 'Sedan', 'سيارة صالون', 20), ('VehicleType', 'Van', 'فان', 30), ('VehicleType', 'Truck', 'شاحنة', 40), ('VehicleType', 'Minibus', 'حافلة صغيرة', 50),
  ('BookingType', 'Any', 'أي نوع', 5), ('BookingType', 'Pickup 4x4', 'بيك أب دفع رباعي', 10), ('BookingType', 'Sedan', 'سيارة صالون', 20), ('BookingType', 'Van', 'فان', 30), ('BookingType', 'Truck', 'شاحنة', 40), ('BookingType', 'Minibus', 'حافلة صغيرة', 50),
  ('AdvanceKind', 'Daily allowance', 'بدل يومي', 10), ('AdvanceKind', 'Fuel', 'وقود', 20), ('AdvanceKind', 'Accommodation', 'إقامة', 30), ('AdvanceKind', 'Materials', 'مواد', 40), ('AdvanceKind', 'Other', 'أخرى', 90),
  ('ExpenseKind', 'Daily allowance', 'بدل يومي', 10), ('ExpenseKind', 'Fuel', 'وقود', 20), ('ExpenseKind', 'Accommodation', 'إقامة', 30), ('ExpenseKind', 'Meals', 'وجبات', 40), ('ExpenseKind', 'Materials', 'مواد', 50), ('ExpenseKind', 'Other', 'أخرى', 90),
  ('PaymentMethod', 'Cash', 'نقداً', 10), ('PaymentMethod', 'Bank transfer', 'تحويل مصرفي', 20), ('PaymentMethod', 'Cheque', 'شيك', 30),
  ('HomeRegion', 'Tripoli', 'طرابلس', 10), ('HomeRegion', 'Middle', 'الوسطى', 20), ('HomeRegion', 'WM', 'الغربية', 30), ('HomeRegion', 'Zawia', 'الزاوية', 40),
  ('HomeRegion', 'Benghazi', 'بنغازي', 50), ('HomeRegion', 'GM', 'الجبل الأخضر', 60), ('HomeRegion', 'Sebha', 'سبها', 70),
  ('VehicleStatus', 'available', 'متاحة', 10), ('VehicleStatus', 'under_maintenance', 'تحت الصيانة', 20), ('VehicleStatus', 'out_of_service', 'خارج الخدمة', 30),
  ('BookingState', 'requested', 'مطلوب', 10), ('BookingState', 'waiting_vehicle', 'بانتظار سيارة', 20), ('BookingState', 'reserved', 'محجوز', 30),
  ('BookingState', 'on_trip', 'في رحلة', 40), ('BookingState', 'returned', 'عاد', 50), ('BookingState', 'cancelled', 'ملغى', 60),
  ('AdvanceScope', 'individual', 'فردية', 10), ('AdvanceScope', 'group', 'جماعية', 20),
  ('AdvanceState', 'requested', 'مطلوبة', 10), ('AdvanceState', 'approved_for_disbursement', 'معتمدة للصرف', 20), ('AdvanceState', 'disbursed', 'مصروفة', 30),
  ('AdvanceState', 'settlement_in_progress', 'قيد التسوية', 40), ('AdvanceState', 'settled', 'مسوّاة', 50), ('AdvanceState', 'closed', 'مغلقة', 60), ('AdvanceState', 'cancelled', 'ملغاة', 70)
) AS v(c, code, ar, ord)
ON CONFLICT (catalogue_code, code) DO NOTHING;
SELECT list_refresh_fields('ProcScope');

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Registers, fields, task sources
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO register_definitions (register_key, name_en, name_ar, module_key, kind, site_scoped, multiple_per_site, record_types, approval_levels, rules, enabled, sort_order) VALUES
  ('car_dispatcher',     'Car Dispatcher',     'حجز وتوزيع السيارات', 'car_dispatcher',     'register', false, true, ARRAY['vehicle', 'booking'],                 2, '{}'::jsonb, true, 150),
  ('financial_advances', 'Financial Advances', 'العهد المالية',       'financial_advances', 'register', true,  true, ARRAY['advance', 'expense', 'settlement'], 2, '{"currency": "LYD"}'::jsonb, true, 160)
ON CONFLICT (register_key) DO NOTHING;
UPDATE register_definitions SET rules = rules || '{"field_work_scopes": ["Survey", "Acquisition Visit", "Inspection", "Maintenance", "Emergency"]}'::jsonb
WHERE register_key = 'procurement' AND NOT rules ? 'field_work_scopes';

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  -- Procurement: the Assignment section (Q496, Q499, Q500)
  ('procurement', 'members',                     'Members (engineers)',       'الأعضاء (المهندسون)',     'child_list', false, false, false,
     '{"max_rows": 30, "columns": [{"code": "user_id", "label_en": "Engineer", "type": "user", "required": true}, {"code": "member_role", "label_en": "Role", "type": "list_code", "list_catalogue": "MemberRole", "required": true}, {"code": "is_lead", "label_en": "Lead", "type": "yes_no"}]}'::jsonb,
     false, 'Assignment', 72, NULL),
  ('procurement', 'planned_start',               'Planned start',             'بداية العمل المخططة',     'date',   false, false, false, NULL, false, 'Assignment', 73, NULL),
  ('procurement', 'planned_end',                 'Planned end',               'نهاية العمل المخططة',     'date',   false, false, false, NULL, false, 'Assignment', 74, NULL),
  ('procurement', 'actual_end',                  'Actual end',                'نهاية العمل الفعلية',     'date',   false, true,  false, NULL, false, 'Assignment', 75, NULL),
  ('procurement', 'vehicle_required',            'Vehicle required',          'سيارة مطلوبة',            'yes_no', false, false, false, NULL, false, 'Assignment', 76, NULL),
  ('procurement', 'vehicle_not_required_reason', 'Reason, no vehicle',        'سبب عدم الحاجة لسيارة',   'text',   false, false, false, NULL, false, 'Assignment', 77, NULL),
  ('procurement', 'advance_required',            'Advance required',          'عهدة مطلوبة',             'yes_no', false, false, false, NULL, false, 'Assignment', 78, NULL),
  ('procurement', 'advance_not_required_reason', 'Reason, no advance',        'سبب عدم الحاجة لعهدة',    'text',   false, false, false, NULL, false, 'Assignment', 79, NULL),
  ('procurement', 'readiness',                   'Readiness',                 'الجاهزية',                'text',   false, false, true,  NULL, true,  'Assignment', 80, NULL),
  ('procurement', 'ready_date',                  'Ready date',                'تاريخ الجاهزية',          'date',   false, false, true,  NULL, false, 'Assignment', 81, NULL),
  ('procurement', 'open_advances_after_close',   'Advances open after the work closed', 'عهد مفتوحة بعد انتهاء العمل', 'yes_no', false, false, true, NULL, false, 'Assignment', 82, NULL),
  -- Car Dispatcher: vehicle
  ('car_dispatcher', 'plate_no',          'Plate no.',         'رقم اللوحة',          'text',   false, false, false, NULL, true,  'Vehicle', 10, NULL),
  ('car_dispatcher', 'vehicle_type',      'Vehicle type',      'نوع السيارة',         'list_code', false, false, false, NULL, true, 'Vehicle', 20, 'VehicleType'),
  ('car_dispatcher', 'model',             'Model',             'الموديل',             'text',   false, false, false, NULL, false, 'Vehicle', 30, NULL),
  ('car_dispatcher', 'home_region',       'Home region',       'المنطقة الأم',        'list_code',   false, false, false, NULL, true, 'Vehicle', 40, 'HomeRegion'),
  ('car_dispatcher', 'driver_user_id',    'Driver (staff)',    'السائق (موظف)',       'user',   false, false, false, NULL, false, 'Vehicle', 50, NULL),
  ('car_dispatcher', 'driver_name',       'Driver (name)',     'السائق (اسم)',        'text',   false, false, false, NULL, false, 'Vehicle', 60, NULL),
  ('car_dispatcher', 'permit_expiry',     'Permit expiry',     'انتهاء الترخيص',      'date',   false, false, false, NULL, true,  'Vehicle', 70, NULL),
  ('car_dispatcher', 'insurance_expiry',  'Insurance expiry',  'انتهاء التأمين',      'date',   false, false, false, NULL, false, 'Vehicle', 80, NULL),
  ('car_dispatcher', 'inspection_date',   'Inspection date',   'تاريخ الفحص',         'date',   false, false, false, NULL, false, 'Vehicle', 90, NULL),
  ('car_dispatcher', 'vehicle_status',    'Vehicle status',    'حالة السيارة',        'list_code',   false, false, false, NULL, true, 'Vehicle', 100, 'VehicleStatus'),
  ('car_dispatcher', 'bookable',          'Bookable',          'قابلة للحجز',         'yes_no', false, false, true,  NULL, true,  'Vehicle', 110, NULL),
  -- Car Dispatcher: booking
  ('car_dispatcher', 'procurement_record_id', 'Assignment (Procurement record)', 'المهمة (سجل المشتريات)', 'text', false, false, false, NULL, false, 'Booking', 200, NULL),
  ('car_dispatcher', 'site_id',           'Site',              'الموقع',              'text',   false, false, false, NULL, false, 'Booking', 205, NULL),
  ('car_dispatcher', 'engineer_user_id',  'Engineer',          'المهندس',             'user',   false, false, false, NULL, true,  'Booking', 210, NULL),
  ('car_dispatcher', 'required_type',     'Required vehicle type', 'نوع السيارة المطلوبة', 'list_code', false, false, false, NULL, false, 'Booking', 220, 'BookingType'),
  ('car_dispatcher', 'from_date',         'From',              'من',                  'date',   false, false, false, NULL, true,  'Booking', 230, NULL),
  ('car_dispatcher', 'to_date',           'To',                'إلى',                 'date',   false, false, false, NULL, true,  'Booking', 240, NULL),
  ('car_dispatcher', 'vehicle_id',        'Vehicle',           'السيارة',             'text',   false, false, false, NULL, true,  'Booking', 250, NULL),
  ('car_dispatcher', 'booking_state',     'Booking state',     'حالة الحجز',          'list_code',   false, false, false, NULL, true, 'Booking', 260, 'BookingState'),
  ('car_dispatcher', 'parent_booking_id', 'Extends booking',   'تمديد للحجز',         'text',   false, false, false, NULL, false, 'Booking', 270, NULL),
  ('car_dispatcher', 'waiting_reason',    'Waiting reason',    'سبب الانتظار',        'text',   false, false, false, NULL, false, 'Booking', 280, NULL),
  ('car_dispatcher', 'out_of_region',     'Outside the home region', 'خارج المنطقة الأم', 'yes_no', false, false, true, NULL, false, 'Booking', 290, NULL),
  -- Financial Advances: advance
  ('financial_advances', 'procurement_record_id', 'Assignment (Procurement record)', 'المهمة (سجل المشتريات)', 'text', false, false, false, NULL, false, 'Advance', 10, NULL),
  ('financial_advances', 'advance_scope',     'Advance scope',     'نوع العهدة',          'list_code',   false, false, false, NULL, true, 'Advance', 20, 'AdvanceScope'),
  ('financial_advances', 'custodian_user_id', 'Custodian',         'أمين العهدة',         'user',   false, false, false, NULL, true,  'Advance', 30, NULL),
  ('financial_advances', 'beneficiaries',     'Beneficiaries (group)', 'المستفيدون (جماعية)', 'multi_user', false, false, false, NULL, false, 'Advance', 40, NULL),
  ('financial_advances', 'advance_kind',      'Advance kind',      'نوع المصروف المتوقع', 'list_code', false, false, false, NULL, true, 'Advance', 50, 'AdvanceKind'),
  ('financial_advances', 'requested_amount',  'Requested amount (LYD)', 'المبلغ المطلوب (دينار)', 'number', false, false, false, NULL, false, 'Advance', 60, NULL),
  ('financial_advances', 'approved_amount',   'Approved amount (LYD)',  'المبلغ المعتمد (دينار)', 'number', false, false, false, NULL, false, 'Advance', 70, NULL),
  ('financial_advances', 'disbursed_amount',  'Disbursed amount (LYD)', 'المبلغ المصروف (دينار)', 'number', false, false, false, NULL, false, 'Advance', 80, NULL),
  ('financial_advances', 'disbursed_date',    'Disbursed date',    'تاريخ الصرف',         'date',   false, true,  false, NULL, false, 'Advance', 90, NULL),
  ('financial_advances', 'payment_method',    'Payment method',    'طريقة الدفع',         'list_code', false, false, false, NULL, false, 'Advance', 100, 'PaymentMethod'),
  ('financial_advances', 'payment_ref',       'Payment reference', 'مرجع الدفع',          'text',   false, false, false, NULL, false, 'Advance', 110, NULL),
  ('financial_advances', 'payment_proof',     'Payment proof',     'إثبات الدفع',         'file',   false, false, false, NULL, false, 'Advance', 120, NULL),
  ('financial_advances', 'period_from',       'Period from',       'الفترة من',           'date',   false, false, false, NULL, false, 'Advance', 130, NULL),
  ('financial_advances', 'period_to',         'Period to',         'الفترة إلى',          'date',   false, false, false, NULL, false, 'Advance', 140, NULL),
  ('financial_advances', 'parent_advance_id', 'Top-up / extension of', 'تكملة / تمديد لـ', 'text',   false, false, false, NULL, false, 'Advance', 150, NULL),
  ('financial_advances', 'advance_state',     'Advance state',     'حالة العهدة',         'list_code',   false, false, false, NULL, true, 'Advance', 160, 'AdvanceState'),
  ('financial_advances', 'exceptional_note',  'Exceptional handling note', 'ملاحظة معالجة استثنائية', 'text', false, false, false, NULL, false, 'Advance', 170, NULL),
  ('financial_advances', 'balance',           'Balance (LYD)',     'الرصيد (دينار)',      'number', false, false, true,  NULL, false, 'Advance', 180, NULL),
  -- Financial Advances: expense, settlement
  ('financial_advances', 'advance_id',        'Advance',           'العهدة',              'text',   false, false, false, NULL, false, 'Expense', 200, NULL),
  ('financial_advances', 'expense_date',      'Expense date',      'تاريخ المصروف',       'date',   false, true,  false, NULL, false, 'Expense', 210, NULL),
  ('financial_advances', 'expense_kind',      'Expense kind',      'نوع المصروف',         'list_code', false, false, false, NULL, false, 'Expense', 220, 'ExpenseKind'),
  ('financial_advances', 'description',       'Description',       'الوصف',               'text',   false, false, false, NULL, false, 'Expense', 230, NULL),
  ('financial_advances', 'amount',            'Amount (LYD)',      'المبلغ (دينار)',      'number', false, false, false, NULL, false, 'Expense', 240, NULL),
  ('financial_advances', 'receipt',           'Receipt',           'الإيصال',             'file',   false, false, false, NULL, false, 'Expense', 250, NULL),
  ('financial_advances', 'returned_amount',   'Returned amount (LYD)', 'المبلغ المرتجع (دينار)', 'number', false, false, false, NULL, false, 'Settlement', 300, NULL),
  ('financial_advances', 'settlement_note',   'Settlement note',   'ملاحظة التسوية',      'text',   false, false, false, NULL, false, 'Settlement', 310, NULL)
ON CONFLICT (register_key, code) DO NOTHING;

-- The tasks MOB-x are fed by ready_date of the Procurement record, by scope. Inspection, Maintenance and Emergency feed none (documented default).
INSERT INTO register_task_sources (register_key, task_code, date_field, data_eq, data_in, sort_order) VALUES
  ('procurement', 'MOB-1', 'ready_date', '{}'::jsonb, '{"scope": ["Survey", "Acquisition Visit"]}'::jsonb, 110),
  ('procurement', 'MOB-2', 'ready_date', '{}'::jsonb, '{"scope": ["CW", "Tower Erection", "Site Adaption"]}'::jsonb, 120),
  ('procurement', 'MOB-5', 'ready_date', '{}'::jsonb, '{"scope": ["TE Installation"]}'::jsonb, 150)
ON CONFLICT (register_key, task_code) DO NOTHING;

-- Q512 / plan section 0: the two new registers and the Assignment fields of Procurement have no Master column. TPL-MASTER keeps its sheets and the 15 PR-PO columns.
UPDATE register_definitions SET rules = rules || '{"master_export": false}'::jsonb WHERE register_key IN ('car_dispatcher', 'financial_advances');
UPDATE register_definitions SET rules = rules || '{"master_exclude_fields": ["members", "planned_start", "planned_end", "actual_end", "vehicle_required", "vehicle_not_required_reason", "advance_required", "advance_not_required_reason", "readiness", "ready_date", "open_advances_after_close"]}'::jsonb
WHERE register_key = 'procurement';
CREATE OR REPLACE FUNCTION tpl_master_register_columns(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(c ORDER BY o), '[]'::jsonb)
  FROM jsonb_array_elements(public.tpl_columns(p_key)) WITH ORDINALITY AS t(c, o)
  WHERE NOT (c ->> 'code') IN (SELECT jsonb_array_elements_text(coalesce((SELECT d.rules -> 'master_exclude_fields' FROM public.register_definitions d WHERE d.register_key = p_key), '[]'::jsonb)))
$$;
CREATE OR REPLACE FUNCTION tpl_master_parts() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out jsonb;
BEGIN
  WITH p AS (
    SELECT 0 AS ord, 'master'::text AS part, 'Master'::text AS sheet, 'master'::text AS kind, NULL::text AS ref, public.tpl_master_columns() AS cols
    UNION ALL
    SELECT 10 + d.sort_order, d.register_key, coalesce(tp.sheet_name, left(btrim(regexp_replace(d.name, '[\[\]:*?/\\]', '', 'g')), 31)), 'register', d.register_key,
           public.tpl_master_register_columns(d.register_key)
    FROM public.template_definitions d
    JOIN public.register_definitions rd ON rd.register_key = d.register_key
    LEFT JOIN public.template_parts tp ON tp.template_id = 'TPL-MASTER' AND tp.register_key = d.register_key
    WHERE d.kind = 'register' AND d.is_active AND coalesce(rd.rules ->> 'master_export', 'true') <> 'false'
  )
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('part', p.part, 'sheet', p.sheet, 'kind', p.kind, 'ref', p.ref, 'columns', p.cols,
           'header_checksum', public.tpl_header_checksum(p.cols))) ORDER BY p.ord, p.part COLLATE "C"), '[]'::jsonb)
  INTO out FROM p;
  RETURN out;
END $$;
ALTER FUNCTION tpl_master_register_columns(text) OWNER TO pmis_definer;
ALTER FUNCTION tpl_master_parts() OWNER TO pmis_definer;

-- Templates (two entry ways); the first versions are issued by tpl_sync_all(), which also bumps the Procurement template (new fields).
INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, custom_entity, match_keys, sort_order)
SELECT v.tid, r.name_en, r.name_ar, r.register_key, 'register', r.register_key, r.module_key, NULL, v.keys::jsonb, r.sort_order
FROM (VALUES ('car_dispatcher', 'TPL-CAR', '[["record_type","plate_no"]]'), ('financial_advances', 'TPL-ADV', '[["site_code","record_type","payment_ref"]]')) AS v(rk, tid, keys)
JOIN register_definitions r ON r.register_key = v.rk
ON CONFLICT (template_id) DO NOTHING;
SELECT tpl_sync_all();

CREATE INDEX register_records_proc_idx ON register_records ((data ->> 'procurement_record_id')) WHERE register_key IN ('car_dispatcher', 'financial_advances');
CREATE INDEX register_records_advance_idx ON register_records ((data ->> 'advance_id')) WHERE register_key = 'financial_advances';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Roles (plain, Q-plan section 7), their default module
-- ---------------------------------------------------------------------------------------------------------------------
INSERT INTO roles (code, name_en, name_ar, description_en, description_ar, team, default_profile_id, default_all_regions, default_all_modules, can_hold_matrix_levels, sort)
SELECT v.code, v.name_en, v.name_ar, v.d_en, v.d_ar, 'none'::"TeamKind", (SELECT id FROM permission_profiles WHERE code = 'data_entry'), true, false, true, v.sort
FROM (VALUES
  ('FLEET_DISPATCHER', 'Fleet Dispatcher', 'مسؤول توزيع السيارات', 'Keeps the fleet master and the vehicle bookings of the Car Dispatcher.', 'يدير بيانات السيارات وحجوزاتها في حجز وتوزيع السيارات.', 410),
  ('FIN_OFFICER',      'Finance Officer',  'موظف مالي',           'Records and approves the disbursement, expenses and settlement of the field advances.', 'يسجّل ويعتمد صرف العهد المالية ومصروفاتها وتسويتها.', 420)
) AS v(code, name_en, name_ar, d_en, d_ar, sort)
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_default_modules (role_id, module_key)
SELECT r.id, v.m FROM (VALUES ('FLEET_DISPATCHER', 'car_dispatcher'), ('FIN_OFFICER', 'financial_advances')) AS v(c, m) JOIN roles r ON r.code = v.c
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The reservations (database guarantee) and the stored readiness
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE vehicle_reservations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_entity_id UUID        NOT NULL,                 -- the logical record of the vehicle (register_records.entity_id)
  booking_entity_id UUID        NOT NULL,                 -- the logical record of the booking
  booking_record_id UUID        NOT NULL,                 -- the approved version that wrote the reservation
  period            DATERANGE   NOT NULL CHECK (NOT isempty(period)),   -- [from, to] inclusive, stored as [from, to + 1)
  state             TEXT        NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'released')),
  created_by        UUID,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  released_at       TIMESTAMPTZ(6),
  CONSTRAINT vehicle_reservations_no_overlap EXCLUDE USING gist (vehicle_entity_id WITH =, period WITH &&) WHERE (state = 'reserved')
);
CREATE INDEX vehicle_reservations_booking_idx ON vehicle_reservations (booking_entity_id) WHERE state = 'reserved';
CREATE INDEX vehicle_reservations_vehicle_idx ON vehicle_reservations (vehicle_entity_id, state);

CREATE TABLE assignment_readiness (
  procurement_entity_id     UUID PRIMARY KEY,
  readiness                 TEXT        NOT NULL,
  ready_date                DATE,
  open_advances_after_close BOOLEAN     NOT NULL DEFAULT false,
  updated_at                TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX assignment_readiness_state_idx ON assignment_readiness (readiness);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicle_reservations', 'assignment_readiness'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY rls_seed_write ON %I FOR ALL USING (app_is_seeding()) WITH CHECK (app_is_seeding())', t);
  END LOOP;
END $$;
-- region filter inherited from the records (defence in depth): a global booking is readable by any session, an advance only in its region
CREATE POLICY rls_select ON vehicle_reservations FOR SELECT USING (EXISTS (SELECT 1 FROM register_records p WHERE p.id = booking_record_id));
CREATE POLICY rls_select ON assignment_readiness FOR SELECT USING (EXISTS (SELECT 1 FROM register_records p WHERE p.entity_id = procurement_entity_id));
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON vehicle_reservations FOR EACH ROW EXECUTE FUNCTION reg_backstop();
CREATE TRIGGER a_reg_backstop BEFORE INSERT OR UPDATE OR DELETE ON assignment_readiness FOR EACH ROW EXECUTE FUNCTION reg_backstop();
GRANT SELECT, INSERT, UPDATE ON vehicle_reservations, assignment_readiness TO pmis_definer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON vehicle_reservations, assignment_readiness FROM pmis_app;
    GRANT SELECT ON vehicle_reservations, assignment_readiness TO pmis_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Helpers: latest approved versions, vehicles, balance
-- ---------------------------------------------------------------------------------------------------------------------
-- The latest approved version of every logical record of a register whose data[p_field] = p_val (all of them when p_field is NULL).
CREATE OR REPLACE FUNCTION fa_latest(p_key text, p_field text DEFAULT NULL, p_val text DEFAULT NULL) RETURNS SETOF public.register_records
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT ON (r.entity_id) r.* FROM public.register_records r
  WHERE r.register_key = p_key AND r.state = 'approved' AND (p_field IS NULL OR r.data ->> p_field = p_val)
  ORDER BY r.entity_id, r.version_no DESC
$$;

CREATE OR REPLACE FUNCTION fa_bool(p_data jsonb, p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN jsonb_typeof(p_data -> p_key) = 'boolean' THEN (p_data -> p_key)::boolean END $$;

CREATE OR REPLACE FUNCTION fa_blank(p_data jsonb, p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(btrim(p_data ->> p_key), '') = '' $$;

-- Does the Procurement record data describe field work (a field-work scope, or members, or an answer on vehicle / advance)?
CREATE OR REPLACE FUNCTION fa_field_work(p_data jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(p_data -> 'members') = 'array' THEN p_data -> 'members' END), 0) > 0
      OR p_data ? 'vehicle_required' AND jsonb_typeof(p_data -> 'vehicle_required') = 'boolean'
      OR p_data ? 'advance_required' AND jsonb_typeof(p_data -> 'advance_required') = 'boolean'
      OR EXISTS (SELECT 1 FROM public.register_definitions d, jsonb_array_elements_text(coalesce(d.rules -> 'field_work_scopes', '[]'::jsonb)) s
                 WHERE d.register_key = 'procurement' AND s = p_data ->> 'scope')
$$;

-- Bookable on a date: available, and permit and insurance not expired (Q510 / plan 4.1).
CREATE OR REPLACE FUNCTION fleet_vehicle_bookable(p_data jsonb, p_on date) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_data ->> 'vehicle_status', '') = 'available'
     AND nullif(p_data ->> 'permit_expiry', '') IS NOT NULL AND (p_data ->> 'permit_expiry')::date >= p_on
     AND nullif(p_data ->> 'insurance_expiry', '') IS NOT NULL AND (p_data ->> 'insurance_expiry')::date >= p_on
$$;

-- advance balance = disbursed - approved expenses - returned (LYD)
CREATE OR REPLACE FUNCTION fin_balance(p_advance uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT (a.data ->> 'disbursed_amount')::numeric FROM public.fa_latest('financial_advances', NULL, NULL) a WHERE a.entity_id = p_advance AND a.record_type = 'advance'), 0)
       - coalesce((SELECT sum((e.data ->> 'amount')::numeric) FROM public.fa_latest('financial_advances', 'advance_id', p_advance::text) e WHERE e.record_type = 'expense'), 0)
       - coalesce((SELECT sum((e.data ->> 'returned_amount')::numeric) FROM public.fa_latest('financial_advances', 'advance_id', p_advance::text) e WHERE e.record_type = 'settlement'), 0)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Readiness (derived, plan section 5 rule 4)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fleet_readiness_calc(p_entity uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  p public.register_records%ROWTYPE; pid text := p_entity::text; veh_ok boolean; adv_ok boolean; rd text; bookings jsonb; advances jsonb; open_after boolean := false;
  n int; bad int;
BEGIN
  SELECT * INTO p FROM public.fa_latest('procurement') x WHERE x.entity_id = p_entity;
  IF NOT FOUND OR NOT public.fa_field_work(p.data) THEN
    RETURN jsonb_build_object('entity_id', p_entity, 'readiness', NULL, 'approved', FOUND, 'vehicle', jsonb_build_object('ok', false), 'advance', jsonb_build_object('ok', false),
      'open_advances_after_close', false, 'bookings', '[]'::jsonb, 'advances', '[]'::jsonb);
  END IF;
  -- bookings of the assignment (the roots; extensions are children): a draft or unapproved one is "not reserved yet"
  SELECT coalesce(jsonb_agg(jsonb_build_object('entity_id', e.entity_id, 'booking_state', e.st) ORDER BY e.entity_id), '[]'::jsonb),
         count(*) FILTER (WHERE coalesce(e.st, '') <> 'cancelled'),
         count(*) FILTER (WHERE coalesce(e.st, '') <> 'cancelled' AND coalesce(e.st, '') NOT IN ('reserved', 'on_trip', 'returned'))
    INTO bookings, n, bad
  FROM (SELECT d.entity_id, (SELECT l.data ->> 'booking_state' FROM public.fa_latest('car_dispatcher', 'procurement_record_id', pid) l WHERE l.entity_id = d.entity_id) AS st
        FROM (SELECT DISTINCT r.entity_id FROM public.register_records r WHERE r.register_key = 'car_dispatcher' AND r.record_type = 'booking' AND r.state <> 'voided'
                AND r.data ->> 'procurement_record_id' = pid AND nullif(r.data ->> 'parent_booking_id', '') IS NULL) d) e;
  veh_ok := CASE WHEN public.fa_bool(p.data, 'vehicle_required') IS FALSE THEN NOT public.fa_blank(p.data, 'vehicle_not_required_reason')
                 WHEN public.fa_bool(p.data, 'vehicle_required') IS TRUE THEN n > 0 AND bad = 0 ELSE false END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('entity_id', e.entity_id, 'custodian_user_id', e.cust, 'advance_state', e.st) ORDER BY e.entity_id), '[]'::jsonb),
         count(*) FILTER (WHERE coalesce(e.st, '') <> 'cancelled'),
         count(*) FILTER (WHERE coalesce(e.st, '') <> 'cancelled' AND coalesce(e.st, '') NOT IN ('disbursed', 'settlement_in_progress', 'settled', 'closed'))
    INTO advances, n, bad
  FROM (SELECT d.entity_id, d.cust, (SELECT l.data ->> 'advance_state' FROM public.fa_latest('financial_advances', 'procurement_record_id', pid) l WHERE l.entity_id = d.entity_id) AS st
        FROM (SELECT DISTINCT ON (r.entity_id) r.entity_id, r.data ->> 'custodian_user_id' AS cust FROM public.register_records r
              WHERE r.register_key = 'financial_advances' AND r.record_type = 'advance' AND r.state <> 'voided' AND r.data ->> 'procurement_record_id' = pid
                AND nullif(r.data ->> 'parent_advance_id', '') IS NULL AND coalesce(r.data ->> 'advance_scope', 'individual') = 'individual'
              ORDER BY r.entity_id, r.version_no DESC) d) e;
  adv_ok := CASE WHEN public.fa_bool(p.data, 'advance_required') IS FALSE THEN NOT public.fa_blank(p.data, 'advance_not_required_reason')
                 WHEN public.fa_bool(p.data, 'advance_required') IS TRUE THEN n > 0 AND bad = 0 ELSE false END;
  rd := CASE WHEN veh_ok AND adv_ok THEN 'ready_to_mobilize' WHEN NOT veh_ok AND NOT adv_ok THEN 'awaiting_both' WHEN NOT veh_ok THEN 'awaiting_vehicle' ELSE 'awaiting_advance' END;
  IF nullif(p.data ->> 'actual_end', '') IS NOT NULL THEN
    open_after := EXISTS (SELECT 1 FROM public.fa_latest('financial_advances', 'procurement_record_id', pid) a
                          WHERE a.record_type = 'advance' AND a.data ->> 'advance_state' IN ('approved_for_disbursement', 'disbursed', 'settlement_in_progress'));
  END IF;
  RETURN jsonb_build_object('entity_id', p_entity, 'readiness', rd, 'approved', true, 'vehicle', jsonb_build_object('required', public.fa_bool(p.data, 'vehicle_required'), 'ok', veh_ok),
    'advance', jsonb_build_object('required', public.fa_bool(p.data, 'advance_required'), 'ok', adv_ok), 'open_advances_after_close', open_after, 'bookings', bookings, 'advances', advances);
END $$;

-- Readiness for the screens: the stored ready_date (when the last condition became true) with the live state.
CREATE OR REPLACE FUNCTION fleet_readiness(p_entity uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c || jsonb_build_object('ready_date', CASE WHEN c ->> 'readiness' = 'ready_to_mobilize' THEN (SELECT ar.ready_date FROM public.assignment_readiness ar WHERE ar.procurement_entity_id = p_entity) END)
  FROM (SELECT public.fleet_readiness_calc(p_entity) AS c) x
$$;

-- Completes the MOB tasks of the site whose source scope matches the record (the register_task_sources rows, date_field ready_date).
CREATE OR REPLACE FUNCTION fa_mob_complete(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; src record; t public.task_instances%ROWTYPE; before jsonb; actor uuid := public.app_actor();
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF r.site_id IS NULL THEN RETURN; END IF;
  FOR src IN SELECT x.task_code FROM public.register_task_sources x WHERE x.register_key = 'procurement' AND x.is_active AND x.task_code LIKE 'MOB-%' ORDER BY x.sort_order LOOP
    CONTINUE WHEN NOT public.reg_source_matches(p_record, src.task_code);
    SELECT ti.* INTO t FROM public.task_instances ti JOIN public.task_definitions td ON td.id = ti.task_def_id JOIN public.sites s ON s.id = ti.site_id AND s.workflow_version_id = td.workflow_id
      WHERE ti.site_id = r.site_id AND td.code = src.task_code FOR UPDATE OF ti;
    CONTINUE WHEN NOT FOUND OR t.state IN ('approved', 'na', 'skipped') OR t.is_na;
    before := public.wf_snap(t.id);
    UPDATE public.task_instances SET actual_date = (r.data ->> 'ready_date')::date, state = 'approved', current_level = levels_required,
      path_frozen_at = coalesce(path_frozen_at, now()), submitted_date = current_date, approved_date = current_date, ball_in_court_user_id = NULL, level_opened_at = NULL,
      self_approval = false, version = version + 1, updated_at = now()
    WHERE id = t.id;
    INSERT INTO public.workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, stepup_verified, self_approval, created_at)
    VALUES (t.id, t.levels_required, 'approve', actor, 'ready to mobilize: ' || r.register_key || ' ' || r.id::text, t.state, 'approved', false, false, clock_timestamp());
    PERFORM public.wf_audit('task_approve', t.id, before, public.wf_snap(t.id) || jsonb_build_object('via_register_record', r.id, 'register', r.register_key), 'ready to mobilize (Q506)');
    PERFORM public.wf_unlock_successors(t.id);
  END LOOP;
END $$;

-- Stores the readiness of a Procurement logical record in its latest approved version and feeds the MOB tasks.
CREATE OR REPLACE FUNCTION fleet_sync(p_entity uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c jsonb; p public.register_records%ROWTYPE; old public.assignment_readiness%ROWTYPE; rdate date; rd text;
BEGIN
  SELECT * INTO p FROM public.fa_latest('procurement') x WHERE x.entity_id = p_entity;
  IF NOT FOUND OR NOT public.fa_field_work(p.data) THEN RETURN; END IF;
  c := public.fleet_readiness_calc(p_entity);
  rd := c ->> 'readiness';
  SELECT * INTO old FROM public.assignment_readiness WHERE procurement_entity_id = p_entity;
  rdate := CASE WHEN rd = 'ready_to_mobilize' THEN coalesce(CASE WHEN old.readiness = 'ready_to_mobilize' THEN old.ready_date END, public.cal_today()) END;
  INSERT INTO public.assignment_readiness (procurement_entity_id, readiness, ready_date, open_advances_after_close, updated_at)
  VALUES (p_entity, rd, rdate, (c ->> 'open_advances_after_close')::boolean, now())
  ON CONFLICT (procurement_entity_id) DO UPDATE SET readiness = EXCLUDED.readiness, ready_date = EXCLUDED.ready_date, open_advances_after_close = EXCLUDED.open_advances_after_close, updated_at = now();
  UPDATE public.register_records SET data = (data - 'ready_date') || jsonb_build_object('readiness', rd, 'open_advances_after_close', (c ->> 'open_advances_after_close')::boolean)
    || CASE WHEN rdate IS NOT NULL THEN jsonb_build_object('ready_date', rdate) ELSE '{}'::jsonb END
  WHERE id = p.id;
  IF rdate IS NOT NULL THEN PERFORM public.fa_mob_complete(p.id); END IF;
  IF p.site_id IS NOT NULL THEN PERFORM public.calc_refresh_site(p.site_id); END IF;   -- the MOB clocks start with the approval of the record
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. The link rule: drafts opened by the approval of the assignment (idempotent)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fa_new_draft(p_key text, p_type text, p_site uuid, p_region int, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); d public.register_definitions%ROWTYPE; rid uuid; h record; cnt int;
BEGIN
  SELECT * INTO d FROM public.register_definitions WHERE register_key = p_key;
  SELECT count(*) INTO cnt FROM public.reg_entry_holders(p_key, p_region);
  INSERT INTO public.register_records (entity_id, register_key, record_type, site_id, region_id, is_global, levels_required, data, ball_in_court_user_id, created_by, level_opened_at)
  VALUES (gen_random_uuid(), p_key, p_type, CASE WHEN d.site_scoped THEN p_site END, CASE WHEN d.site_scoped THEN p_region END, NOT d.site_scoped, d.approval_levels,
          jsonb_strip_nulls(p_data), NULL, actor, now())
  RETURNING id INTO rid;
  PERFORM public.reg_step(rid, 1, 'create', actor, 'opened by the approval of the assignment', NULL, 'entry', false, false);
  PERFORM public.reg_audit('register_record_create', rid, NULL, public.reg_snap(rid), 'opened by the approval of the assignment (link rule, Q507)');
  FOR h IN SELECT e.user_id FROM public.reg_entry_holders(p_key, CASE WHEN d.site_scoped THEN p_region END) e LIMIT 20 LOOP
    PERFORM public.reg_notify(h.user_id, 'register_assigned', 'A register record waits for you', public.reg_label(rid), rid);
  END LOOP;
  RETURN rid;
END $$;

CREATE OR REPLACE FUNCTION fa_open_drafts(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; pid text; m jsonb; lead text; eng text;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record;
  IF NOT public.fa_field_work(r.data) OR r.site_id IS NULL THEN RETURN; END IF;
  pid := r.entity_id::text;
  SELECT x ->> 'user_id' INTO eng FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.data -> 'members') = 'array' THEN r.data -> 'members' ELSE '[]'::jsonb END) x
    ORDER BY (x ->> 'is_lead')::boolean DESC NULLS LAST, x ->> 'user_id' LIMIT 1;
  IF public.fa_bool(r.data, 'vehicle_required') IS TRUE
     AND NOT EXISTS (SELECT 1 FROM public.register_records b WHERE b.register_key = 'car_dispatcher' AND b.record_type = 'booking' AND b.state <> 'voided'
                     AND b.data ->> 'procurement_record_id' = pid AND nullif(b.data ->> 'parent_booking_id', '') IS NULL) THEN
    PERFORM public.fa_new_draft('car_dispatcher', 'booking', r.site_id, r.region_id, jsonb_build_object('procurement_record_id', pid, 'site_id', r.site_id::text, 'engineer_user_id', eng,
      'from_date', r.data ->> 'planned_start', 'to_date', r.data ->> 'planned_end', 'booking_state', 'requested'));
  END IF;
  IF public.fa_bool(r.data, 'advance_required') IS TRUE THEN
    FOR m IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.data -> 'members') = 'array' THEN r.data -> 'members' ELSE '[]'::jsonb END) x LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.register_records a WHERE a.register_key = 'financial_advances' AND a.record_type = 'advance' AND a.state <> 'voided'
                            AND a.data ->> 'procurement_record_id' = pid AND a.data ->> 'custodian_user_id' = m ->> 'user_id' AND nullif(a.data ->> 'parent_advance_id', '') IS NULL
                            AND coalesce(a.data ->> 'advance_scope', 'individual') = 'individual');
      PERFORM public.fa_new_draft('financial_advances', 'advance', r.site_id, r.region_id, jsonb_build_object('procurement_record_id', pid, 'advance_scope', 'individual',
        'custodian_user_id', m ->> 'user_id', 'period_from', r.data ->> 'planned_start', 'period_to', r.data ->> 'planned_end', 'advance_state', 'requested'));
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Rules at submit and at approval (a trigger, so the screen, templates and batches are all covered)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fa_proc_current(p_text text) RETURNS public.register_records
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT x FROM public.fa_latest('procurement') x WHERE p_text ~* '^[0-9a-f-]{36}$' AND x.entity_id = p_text::uuid
$$;

CREATE OR REPLACE FUNCTION fa_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  errs jsonb := '[]'::jsonb; d jsonb := NEW.data; actor uuid := public.app_actor(); typ text := NEW.record_type; x jsonb; n int; lead int; ids text[] := ARRAY[]::text[];
  prev jsonb; ps text; st text; veh public.register_records%ROWTYPE; adv public.register_records%ROWTYPE; cust uuid; bal numeric; f date; t date; pr public.register_records%ROWTYPE;
BEGIN
  IF public.app_is_seeding() THEN RETURN NEW; END IF;
  IF OLD.state = 'entry' THEN
    -- ------------------------------------------------------------------ Procurement: the Assignment section
    IF NEW.register_key = 'procurement' AND public.fa_field_work(d) THEN
      n := coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(d -> 'members') = 'array' THEN d -> 'members' END), 0);
      IF n = 0 THEN errs := errs || public.reg_err_item('/data/members', 'required', 'A field assignment needs at least one member (Q496).'); END IF;
      lead := 0;
      FOR x IN SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d -> 'members') = 'array' THEN d -> 'members' ELSE '[]'::jsonb END) e LOOP
        IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = (x ->> 'user_id')::uuid AND u.deleted_at IS NULL AND u.status = 'active') THEN
          errs := errs || public.reg_err_item('/data/members', 'member_not_active', 'Every member must be an active user.');
        END IF;
        IF x ->> 'user_id' = ANY (ids) THEN errs := errs || public.reg_err_item('/data/members', 'duplicate_member', 'A member is listed twice.'); END IF;
        ids := ids || (x ->> 'user_id');
        IF public.fa_bool(x, 'is_lead') IS TRUE THEN lead := lead + 1; END IF;
      END LOOP;
      IF lead > 1 THEN errs := errs || public.reg_err_item('/data/members', 'one_lead', 'Only one member can be the lead.'); END IF;
      IF public.fa_bool(d, 'vehicle_required') IS NULL THEN errs := errs || public.reg_err_item('/data/vehicle_required', 'required', 'Answer whether a vehicle is required.');
      ELSIF public.fa_bool(d, 'vehicle_required') IS FALSE AND public.fa_blank(d, 'vehicle_not_required_reason') THEN
        errs := errs || public.reg_err_item('/data/vehicle_not_required_reason', 'reason_required', 'A reason is required when no vehicle is needed (Q499).');
      END IF;
      IF public.fa_bool(d, 'advance_required') IS NULL THEN errs := errs || public.reg_err_item('/data/advance_required', 'required', 'Answer whether an advance is required.');
      ELSIF public.fa_bool(d, 'advance_required') IS FALSE AND public.fa_blank(d, 'advance_not_required_reason') THEN
        errs := errs || public.reg_err_item('/data/advance_not_required_reason', 'reason_required', 'A reason is required when no advance is needed (Q500).');
      END IF;
      IF nullif(d ->> 'planned_start', '') IS NOT NULL AND nullif(d ->> 'planned_end', '') IS NOT NULL AND (d ->> 'planned_end')::date < (d ->> 'planned_start')::date THEN
        errs := errs || public.reg_err_item('/data/planned_end', 'end_before_start', 'The planned end is before the planned start.');
      END IF;
      IF EXISTS (SELECT 1 FROM public.register_definitions df, jsonb_array_elements_text(coalesce(df.rules -> 'field_work_scopes', '[]'::jsonb)) s
                 WHERE df.register_key = 'procurement' AND s = d ->> 'scope') AND coalesce(d ->> 'delivery', 'In-House') <> 'In-House' THEN
        errs := errs || public.reg_err_item('/data/delivery', 'in_house_required', 'Field work without a PO / WO is In-House (Q505).');
      END IF;
    -- ------------------------------------------------------------------ vehicle
    ELSIF NEW.register_key = 'car_dispatcher' AND typ = 'vehicle' THEN
      FOREACH ps IN ARRAY ARRAY['plate_no', 'vehicle_status', 'permit_expiry', 'insurance_expiry'] LOOP
        IF public.fa_blank(d, ps) THEN errs := errs || public.reg_err_item('/data/' || ps, 'required', 'Required.'); END IF;
      END LOOP;
      IF NOT public.fa_blank(d, 'plate_no') AND EXISTS (SELECT 1 FROM public.register_records v WHERE v.register_key = 'car_dispatcher' AND v.record_type = 'vehicle' AND v.state <> 'voided'
           AND v.entity_id <> NEW.entity_id AND upper(btrim(v.data ->> 'plate_no')) = upper(btrim(d ->> 'plate_no'))) THEN
        errs := errs || public.reg_err_item('/data/plate_no', 'duplicate', 'This plate number belongs to another vehicle.');
      END IF;
    -- ------------------------------------------------------------------ booking
    ELSIF NEW.register_key = 'car_dispatcher' AND typ = 'booking' THEN
      pr := public.fa_proc_current(d ->> 'procurement_record_id');
      IF pr.id IS NULL OR NOT public.app_region_check(pr.region_id) THEN errs := errs || public.reg_err_item('/data/procurement_record_id', 'unknown_assignment', 'Choose an approved Procurement record (the assignment).');
      ELSIF NOT public.fa_blank(d, 'site_id') AND d ->> 'site_id' <> pr.site_id::text THEN errs := errs || public.reg_err_item('/data/site_id', 'site_mismatch', 'The site is not the site of the assignment.');
      END IF;
      IF NOT public.fa_blank(d, 'parent_booking_id') AND NOT EXISTS (SELECT 1 FROM public.fa_latest('car_dispatcher') pb WHERE pb.record_type = 'booking' AND pb.entity_id::text = d ->> 'parent_booking_id'
           AND pb.data ->> 'procurement_record_id' = d ->> 'procurement_record_id') THEN
        errs := errs || public.reg_err_item('/data/parent_booking_id', 'unknown_booking', 'The booking to extend is not an approved booking of the same assignment.');
      END IF;
      IF public.fa_blank(d, 'from_date') THEN errs := errs || public.reg_err_item('/data/from_date', 'required', 'Required.'); END IF;
      IF public.fa_blank(d, 'to_date') THEN errs := errs || public.reg_err_item('/data/to_date', 'required', 'Required.'); END IF;
      IF NOT public.fa_blank(d, 'from_date') AND NOT public.fa_blank(d, 'to_date') THEN
        f := (d ->> 'from_date')::date; t := (d ->> 'to_date')::date;
        IF t < f THEN errs := errs || public.reg_err_item('/data/to_date', 'end_before_start', 'The end is before the start.');
        ELSIF NOT public.fa_blank(d, 'vehicle_id') THEN
          SELECT * INTO veh FROM public.fa_latest('car_dispatcher') v WHERE v.record_type = 'vehicle' AND v.entity_id::text = d ->> 'vehicle_id';
          IF NOT FOUND THEN errs := errs || public.reg_err_item('/data/vehicle_id', 'unknown_vehicle', 'Unknown vehicle.');
          ELSIF NOT public.fleet_vehicle_bookable(veh.data, t) THEN errs := errs || public.reg_err_item('/data/vehicle_id', 'vehicle_not_bookable', 'The vehicle is not available, or its permit or insurance expires before the end of the booking.');
          ELSIF EXISTS (SELECT 1 FROM public.vehicle_reservations vr WHERE vr.vehicle_entity_id = veh.entity_id AND vr.state = 'reserved' AND vr.booking_entity_id <> NEW.entity_id
                        AND vr.period && daterange(f, t + 1)) AND coalesce(d ->> 'booking_state', 'requested') NOT IN ('cancelled', 'returned') THEN
            PERFORM public.wf_err('vehicle_already_reserved', jsonb_build_object('detail', 'The vehicle is already reserved for overlapping dates.'));
          END IF;
        END IF;
      END IF;
      IF public.fa_blank(d, 'vehicle_id') AND coalesce(d ->> 'booking_state', 'requested') NOT IN ('cancelled') AND public.fa_blank(d, 'waiting_reason') THEN
        errs := errs || public.reg_err_item('/data/waiting_reason', 'reason_required', 'Without a vehicle the booking waits: give the reason.');
      END IF;
    -- ------------------------------------------------------------------ advance
    ELSIF NEW.register_key = 'financial_advances' AND typ = 'advance' THEN
      pr := public.fa_proc_current(d ->> 'procurement_record_id');
      IF pr.id IS NULL OR NOT public.app_region_check(pr.region_id) THEN errs := errs || public.reg_err_item('/data/procurement_record_id', 'unknown_assignment', 'Choose an approved Procurement record (the assignment).');
      ELSIF pr.site_id IS DISTINCT FROM NEW.site_id THEN errs := errs || public.reg_err_item('/data/procurement_record_id', 'site_mismatch', 'The assignment belongs to another site.');
      END IF;
      IF public.fa_blank(d, 'advance_scope') THEN errs := errs || public.reg_err_item('/data/advance_scope', 'required', 'Required.'); END IF;
      IF public.fa_blank(d, 'custodian_user_id') THEN errs := errs || public.reg_err_item('/data/custodian_user_id', 'required', 'A named custodian is required (Q497).'); END IF;
      IF d ->> 'advance_scope' = 'group' AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(d -> 'beneficiaries') = 'array' THEN d -> 'beneficiaries' END), 0) = 0 THEN
        errs := errs || public.reg_err_item('/data/beneficiaries', 'required', 'A group advance names its beneficiaries.');
      END IF;
      IF public.fa_blank(d, 'advance_kind') THEN errs := errs || public.reg_err_item('/data/advance_kind', 'required', 'Required.'); END IF;
      IF public.fa_blank(d, 'requested_amount') OR (d ->> 'requested_amount')::numeric < 0 OR ((d ->> 'requested_amount')::numeric = 0 AND public.fa_blank(d, 'parent_advance_id')) THEN
        errs := errs || public.reg_err_item('/data/requested_amount', 'invalid_amount', 'The requested amount (LYD) must be greater than zero.');
      END IF;
      IF nullif(d ->> 'period_from', '') IS NOT NULL AND nullif(d ->> 'period_to', '') IS NOT NULL AND (d ->> 'period_to')::date < (d ->> 'period_from')::date THEN
        errs := errs || public.reg_err_item('/data/period_to', 'end_before_start', 'The period ends before it starts.');
      END IF;
      IF NOT public.fa_blank(d, 'parent_advance_id') AND NOT EXISTS (SELECT 1 FROM public.fa_latest('financial_advances') a WHERE a.record_type = 'advance' AND a.entity_id::text = d ->> 'parent_advance_id' AND a.site_id = NEW.site_id
                     AND a.data ->> 'procurement_record_id' = d ->> 'procurement_record_id') THEN
        errs := errs || public.reg_err_item('/data/parent_advance_id', 'unknown_advance', 'The advance to top up is not an approved advance.');
      END IF;
      SELECT p.data ->> 'advance_state' INTO ps FROM public.register_records p WHERE p.entity_id = NEW.entity_id AND p.id <> NEW.id AND p.state = 'approved' ORDER BY p.version_no DESC LIMIT 1;
      st := coalesce(d ->> 'advance_state', 'requested');
      IF NOT (CASE coalesce(ps, '-') WHEN '-' THEN st = 'requested'
                 WHEN 'approved_for_disbursement' THEN st IN ('approved_for_disbursement', 'disbursed', 'cancelled')
                 WHEN 'disbursed' THEN st IN ('disbursed', 'settlement_in_progress', 'settled', 'closed')
                 WHEN 'settlement_in_progress' THEN st IN ('settlement_in_progress', 'settled', 'closed')
                 WHEN 'settled' THEN st IN ('settled', 'closed') ELSE st = ps END) THEN
        errs := errs || public.reg_err_item('/data/advance_state', 'invalid_state', 'The advance cannot move from ' || coalesce(ps, 'new') || ' to ' || st || '.');
      END IF;
      IF st = 'disbursed' THEN
        IF public.fa_blank(d, 'disbursed_amount') OR (d ->> 'disbursed_amount')::numeric <= 0 THEN errs := errs || public.reg_err_item('/data/disbursed_amount', 'invalid_amount', 'The disbursed amount (LYD) must be greater than zero.'); END IF;
        FOREACH ps IN ARRAY ARRAY['disbursed_date', 'payment_method', 'payment_ref'] LOOP
          IF public.fa_blank(d, ps) THEN errs := errs || public.reg_err_item('/data/' || ps, 'required', 'A disbursement needs the date, method and payment reference (Q508); the proof file is attached to the record.'); END IF;
        END LOOP;
      END IF;
      IF st = 'closed' AND public.fin_balance(NEW.entity_id) <> 0 AND public.fa_blank(d, 'exceptional_note') THEN
        errs := errs || public.reg_err_item('/data/exceptional_note', 'balance_not_zero', 'Closing needs a balance of zero, or the L2 note "exceptional handling".');
      END IF;
    -- ------------------------------------------------------------------ expense, settlement
    ELSIF NEW.register_key = 'financial_advances' AND typ IN ('expense', 'settlement') THEN
      SELECT * INTO adv FROM public.fa_latest('financial_advances') a WHERE a.record_type = 'advance' AND a.entity_id::text = d ->> 'advance_id';
      IF NOT FOUND OR adv.data ->> 'advance_state' NOT IN ('disbursed', 'settlement_in_progress') OR adv.site_id IS DISTINCT FROM NEW.site_id OR adv.region_id IS DISTINCT FROM NEW.region_id THEN
        errs := errs || public.reg_err_item('/data/advance_id', 'advance_not_disbursed', 'Choose a disbursed advance.');
      END IF;
      IF typ = 'expense' THEN
        IF public.fa_blank(d, 'expense_date') OR public.fa_blank(d, 'expense_kind') THEN errs := errs || public.reg_err_item('/data/expense_date', 'required', 'The date and the kind of the expense are required.'); END IF;
        IF public.fa_blank(d, 'amount') OR (d ->> 'amount')::numeric <= 0 THEN errs := errs || public.reg_err_item('/data/amount', 'invalid_amount', 'The amount (LYD) must be greater than zero.'); END IF;
      ELSIF public.fa_blank(d, 'returned_amount') OR (d ->> 'returned_amount')::numeric < 0 THEN
        errs := errs || public.reg_err_item('/data/returned_amount', 'invalid_amount', 'The returned amount (LYD) is required and not negative.');
      END IF;
    END IF;
    IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  END IF;

  IF NEW.state = 'approved' THEN
    IF NEW.register_key = 'car_dispatcher' AND typ = 'booking' THEN
      st := coalesce(d ->> 'booking_state', 'requested');
      UPDATE public.vehicle_reservations SET state = 'released', released_at = now() WHERE booking_entity_id = NEW.entity_id AND state = 'reserved';
      IF st IN ('cancelled', 'returned') THEN NULL;
      ELSIF public.fa_blank(d, 'vehicle_id') THEN NEW.data := d || '{"booking_state": "waiting_vehicle"}'::jsonb;
      ELSE
        IF st IN ('requested', 'waiting_vehicle') THEN NEW.data := d || '{"booking_state": "reserved"}'::jsonb; END IF;
        BEGIN
          INSERT INTO public.vehicle_reservations (vehicle_entity_id, booking_entity_id, booking_record_id, period, created_by)
          VALUES ((d ->> 'vehicle_id')::uuid, NEW.entity_id, NEW.id, daterange((d ->> 'from_date')::date, (d ->> 'to_date')::date + 1), actor);
        EXCEPTION WHEN exclusion_violation THEN
          PERFORM public.wf_err('vehicle_already_reserved', jsonb_build_object('detail', 'The vehicle is already reserved for overlapping dates.'));
        END;
      END IF;
    ELSIF NEW.register_key = 'financial_advances' AND typ = 'advance' THEN
      IF coalesce(d ->> 'advance_state', 'requested') = 'requested' THEN
        NEW.data := d || jsonb_build_object('advance_state', 'approved_for_disbursement', 'approved_amount', coalesce(d -> 'approved_amount', d -> 'requested_amount'));
      END IF;
    ELSIF NEW.register_key = 'financial_advances' AND typ IN ('expense', 'settlement') THEN
      -- Q512: the custodian never approves their own expenses (nor their own settlement)
      SELECT (a.data ->> 'custodian_user_id')::uuid INTO cust FROM public.fa_latest('financial_advances') a WHERE a.record_type = 'advance' AND a.entity_id::text = d ->> 'advance_id';
      IF cust IS NOT NULL AND cust = actor THEN
        PERFORM public.wf_err('self_approval_forbidden', jsonb_build_object('detail', 'The custodian of the advance cannot approve its expenses: the Finance L2 holder does.'));
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER b_fa_rules BEFORE UPDATE OF state ON register_records FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('in_review', 'in_approval', 'approved')
        AND NEW.register_key IN ('procurement', 'car_dispatcher', 'financial_advances')) EXECUTE FUNCTION fa_rules();

CREATE OR REPLACE FUNCTION fa_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_is_seeding() THEN RETURN NULL; END IF;
  IF NEW.register_key = 'procurement' THEN
    IF NEW.state = 'approved' AND public.fa_field_work(NEW.data) THEN PERFORM public.fa_open_drafts(NEW.id); PERFORM public.fleet_sync(NEW.entity_id); END IF;
  ELSIF NEW.state = 'voided' AND NEW.register_key = 'car_dispatcher' THEN
    UPDATE public.vehicle_reservations SET state = 'released', released_at = now() WHERE booking_entity_id = NEW.entity_id AND state = 'reserved';
    IF NEW.record_type = 'booking' AND NOT public.fa_blank(NEW.data, 'procurement_record_id') THEN PERFORM public.fleet_sync((NEW.data ->> 'procurement_record_id')::uuid); END IF;
  ELSIF NEW.state = 'approved' AND NEW.record_type IN ('booking', 'advance') AND NOT public.fa_blank(NEW.data, 'procurement_record_id') THEN
    PERFORM public.fleet_sync((NEW.data ->> 'procurement_record_id')::uuid);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER z_fa_after AFTER UPDATE OF state ON register_records FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('approved', 'voided') AND NEW.register_key IN ('procurement', 'car_dispatcher', 'financial_advances')) EXECUTE FUNCTION fa_after();

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. What the screens see: derived values and the amounts rule (Q512)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_amounts_visible(p_id uuid, p_type text, p_data jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := public.app_actor(); cust uuid;
BEGIN
  IF actor IS NULL THEN RETURN false; END IF;
  IF public.app_user_is_system_admin(actor) THEN RETURN true; END IF;
  IF p_type = 'advance' THEN cust := nullif(p_data ->> 'custodian_user_id', '')::uuid;
  ELSE SELECT nullif(a.data ->> 'custodian_user_id', '')::uuid INTO cust FROM public.fa_latest('financial_advances') a WHERE a.record_type = 'advance' AND a.entity_id::text = p_data ->> 'advance_id';
  END IF;
  RETURN actor = cust
    OR public.reg_is_eligible(p_id, 'entry', actor) OR public.reg_is_eligible(p_id, 'approve', actor)
    OR EXISTS (SELECT 1 FROM public.user_role_assignments ura JOIN public.roles ro ON ro.id = ura.role_id
               WHERE ura.user_id = actor AND ro.code = 'PM' AND ura.valid_from <= now() AND (ura.valid_to IS NULL OR ura.valid_to > now()))
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = cust AND u.manager_id = actor);
END $$;

CREATE OR REPLACE FUNCTION reg_data_for(p_id uuid, p_key text, p_type text, p_entity uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE out jsonb := p_data; c jsonb; veh public.register_records%ROWTYPE; hr text; sc int;
BEGIN
  IF p_key = 'procurement' THEN
    IF public.fa_field_work(p_data) THEN
      c := public.fleet_readiness(p_entity);
      out := p_data || jsonb_strip_nulls(jsonb_build_object('readiness', c ->> 'readiness', 'ready_date', c ->> 'ready_date')) || jsonb_build_object('open_advances_after_close', (c ->> 'open_advances_after_close')::boolean);
    END IF;
  ELSIF p_key = 'car_dispatcher' THEN
    IF p_type = 'vehicle' THEN out := p_data || jsonb_build_object('bookable', public.fleet_vehicle_bookable(p_data, public.cal_today()));
    ELSIF p_type = 'booking' THEN
      SELECT * INTO veh FROM public.fa_latest('car_dispatcher') v WHERE v.record_type = 'vehicle' AND v.entity_id::text = p_data ->> 'vehicle_id';
      SELECT s.region_id INTO sc FROM public.sites s WHERE s.id::text = p_data ->> 'site_id';
      SELECT rg.code INTO hr FROM public.regions rg WHERE rg.id = sc;
      out := p_data || jsonb_build_object('out_of_region', veh.id IS NOT NULL AND hr IS NOT NULL AND coalesce(veh.data ->> 'home_region', hr) <> hr);
    END IF;
  ELSIF p_key = 'financial_advances' THEN
    IF p_type = 'advance' THEN out := p_data || jsonb_build_object('balance', public.fin_balance(p_entity)); END IF;
    out := out || '{"currency": "LYD"}'::jsonb;
    IF NOT public.fin_amounts_visible(p_id, p_type, p_data) THEN
      out := (out - 'requested_amount' - 'approved_amount' - 'disbursed_amount' - 'amount' - 'returned_amount' - 'balance') || '{"amounts_hidden": true}'::jsonb;
    END IF;
  END IF;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Extend a booking, top up an advance, free vehicles
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fleet_extend_booking(p_record uuid, p_to date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; cur public.register_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record AND register_key = 'car_dispatcher' AND record_type = 'booking';
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The booking does not exist.')); END IF;
  PERFORM public.reg_require_grant('car_dispatcher', NULL, 'create');
  IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders('car_dispatcher', NULL) h WHERE h.user_id = public.app_actor())
          OR (public.app_user_is_system_admin(public.app_actor()) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders('car_dispatcher', NULL)))) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not an entry holder (L1) of the Car Dispatcher row of the Matrix.'));
  END IF;
  SELECT * INTO cur FROM public.fa_latest('car_dispatcher') x WHERE x.entity_id = r.entity_id;
  IF NOT FOUND THEN PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only an approved booking can be extended.')); END IF;
  IF coalesce(cur.data ->> 'booking_state', '') NOT IN ('reserved', 'on_trip') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a reserved booking or one on a trip can be extended.'));
  END IF;
  IF p_to IS NULL OR p_to <= (cur.data ->> 'to_date')::date THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/to_date', 'invalid', 'The new end must be after the end of the booking.')));
  END IF;
  RETURN public.reg_save_record('car_dispatcher', NULL, NULL, NULL, 'booking', jsonb_strip_nulls(jsonb_build_object(
    'procurement_record_id', cur.data ->> 'procurement_record_id', 'site_id', cur.data ->> 'site_id', 'engineer_user_id', cur.data ->> 'engineer_user_id',
    'required_type', cur.data ->> 'required_type', 'vehicle_id', cur.data ->> 'vehicle_id', 'from_date', ((cur.data ->> 'to_date')::date + 1)::text,
    'to_date', p_to::text, 'booking_state', 'requested', 'parent_booking_id', cur.entity_id::text)), '{}'::jsonb, NULL, false);
END $$;

CREATE OR REPLACE FUNCTION fin_top_up(p_record uuid, p_amount numeric, p_period_to date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.register_records%ROWTYPE; cur public.register_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.register_records WHERE id = p_record AND register_key = 'financial_advances' AND record_type = 'advance';
  IF NOT FOUND THEN PERFORM public.wf_err('not_found', jsonb_build_object('detail', 'The advance does not exist.')); END IF;
  PERFORM public.reg_require_grant('financial_advances', r.region_id, 'create');
  IF NOT (EXISTS (SELECT 1 FROM public.reg_entry_holders('financial_advances', r.region_id) h WHERE h.user_id = public.app_actor())
          OR (public.app_user_is_system_admin(public.app_actor()) AND NOT EXISTS (SELECT 1 FROM public.reg_entry_holders('financial_advances', r.region_id)))) THEN
    PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'You are not an entry holder (L1) of the Financial Advances row of the Matrix.'));
  END IF;
  SELECT * INTO cur FROM public.fa_latest('financial_advances') x WHERE x.entity_id = r.entity_id;
  IF NOT FOUND OR cur.data ->> 'advance_state' NOT IN ('disbursed', 'settlement_in_progress') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a disbursed advance can be topped up or extended.'));
  END IF;
  IF p_amount IS NULL OR p_amount < 0 OR (p_amount = 0 AND p_period_to IS NULL) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/requested_amount', 'invalid_amount', 'Give an amount (LYD), or a new end date for an extension.')));
  END IF;
  RETURN public.reg_save_record('financial_advances', NULL, NULL, cur.site_id, 'advance', jsonb_strip_nulls(jsonb_build_object(
    'procurement_record_id', cur.data ->> 'procurement_record_id', 'advance_scope', cur.data ->> 'advance_scope', 'custodian_user_id', cur.data ->> 'custodian_user_id',
    'beneficiaries', cur.data -> 'beneficiaries', 'advance_kind', cur.data ->> 'advance_kind', 'requested_amount', p_amount,
    'period_from', cur.data ->> 'period_to', 'period_to', p_period_to::text, 'parent_advance_id', cur.entity_id::text, 'advance_state', 'requested')), '{}'::jsonb, NULL, false);
END $$;

-- Bookable vehicles that are free in the range (the current approved vehicle records), optionally of a home region or type.
CREATE OR REPLACE FUNCTION fleet_availability(p_from date, p_to date, p_region text DEFAULT NULL, p_type text DEFAULT NULL, p_exclude_booking uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE regs int[] := public.wf_actor_regions('car_dispatcher', 'view');
BEGIN
  IF regs IS NOT NULL AND cardinality(regs) = 0 THEN PERFORM public.wf_err('module_forbidden', jsonb_build_object('detail', 'You have no access to the Car Dispatcher.')); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', public.reg_err_item('/to', 'invalid', 'from and to are dates, and to is not before from.')));
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('vehicle_id', v.entity_id, 'plate_no', v.data ->> 'plate_no', 'vehicle_type', v.data ->> 'vehicle_type', 'model', v.data ->> 'model',
           'home_region', v.data ->> 'home_region', 'driver_user_id', v.data ->> 'driver_user_id', 'driver_name', v.data ->> 'driver_name') ORDER BY v.data ->> 'plate_no')
    FROM public.fa_latest('car_dispatcher') v
    WHERE v.record_type = 'vehicle' AND public.fleet_vehicle_bookable(v.data, p_to)
      AND (p_region IS NULL OR v.data ->> 'home_region' = p_region) AND (p_type IS NULL OR v.data ->> 'vehicle_type' = p_type)
      AND NOT EXISTS (SELECT 1 FROM public.vehicle_reservations vr WHERE vr.vehicle_entity_id = v.entity_id AND vr.state = 'reserved'
                      AND (p_exclude_booking IS NULL OR vr.booking_entity_id <> p_exclude_booking) AND vr.period && daterange(p_from, p_to + 1))), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. SLA start event "REC:procurement": the L2 approval of the Procurement record of the task's source scope (Q513)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER FUNCTION sla_start_ref_valid(text, uuid) RENAME TO sla_start_ref_valid_pre_0076;
CREATE FUNCTION sla_start_ref_valid(p_ref text, p_workflow uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT p_ref = 'REC:procurement' OR public.sla_start_ref_valid_pre_0076(p_ref, p_workflow)
$$;

ALTER FUNCTION sla_resolve_start(uuid, text) RENAME TO sla_resolve_start_pre_0076;
CREATE FUNCTION sla_resolve_start(p_task uuid, p_ref text) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t public.task_instances%ROWTYPE; code text;
BEGIN
  IF p_ref IS DISTINCT FROM 'REC:procurement' THEN RETURN public.sla_resolve_start_pre_0076(p_task, p_ref); END IF;
  SELECT * INTO t FROM public.task_instances WHERE id = p_task;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT td.code INTO code FROM public.task_definitions td WHERE td.id = t.task_def_id;
  -- the earliest approval of a field-work Procurement record of the site whose scope feeds this task
  RETURN (SELECT min(p.approved_at AT TIME ZONE 'Africa/Tripoli')::date FROM public.fa_latest('procurement') p
          JOIN public.register_task_sources s ON s.register_key = 'procurement' AND s.task_code = code AND s.is_active
          WHERE p.site_id = t.site_id AND public.fa_field_work(p.data)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(s.data_in -> 'scope', '[]'::jsonb)) sc WHERE sc = p.data ->> 'scope'));
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 12. The tasks MOB-1, MOB-2, MOB-5 (additions only)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  wf uuid; cal uuid; rs uuid; v record; td uuid; stg uuid; cid uuid; n int := 0;
BEGIN
  SELECT w.id INTO wf FROM workflow_definitions w WHERE w.status = 'published' ORDER BY w.version DESC LIMIT 1;
  SELECT c.id INTO cal FROM work_calendars c WHERE c.code = 'std';
  SELECT s.id INTO rs FROM sla_rule_sets s WHERE s.status = 'published' ORDER BY s.version DESC LIMIT 1;
  IF wf IS NULL THEN RETURN; END IF;
  FOR v IN SELECT * FROM (VALUES ('MOB-1', 1, 'A2', 'RFD_ACQ_TL'), ('MOB-2', 2, 'B2', 'CW_TL'), ('MOB-5', 5, NULL, 'TE_TL')) AS x(code, seq, like_code, l2) LOOP
    SELECT st.id INTO stg FROM stage_definitions st WHERE st.workflow_id = wf AND st.seq = v.seq;
    CONTINUE WHEN stg IS NULL OR EXISTS (SELECT 1 FROM task_definitions x WHERE x.workflow_id = wf AND x.code = v.code);
    INSERT INTO task_definitions (workflow_id, code, stage_id, sort_order, name_en, name_ar, has_documents, is_milestone_task, counts_toward_milestone, condition_rule,
                                  default_external_party, effective_from, reason)
    VALUES (wf, v.code, stg, 900 + v.seq, 'Field mobilization', 'التعبئة الميدانية', false, false, false, NULL, NULL, DATE '2024-01-01', 'seed (migration 0076, Q506)')
    RETURNING id INTO td;
    -- Q516 applicability follows the stage: the rules of A2 (stage 1) and B2 (stage 2); MOB-5 applies to every scenario
    IF v.like_code IS NOT NULL THEN
      INSERT INTO scenario_task_rules (workflow_id, task_code, scenario, rule, flag_expr, reason)
      SELECT r.workflow_id, v.code, r.scenario, r.rule, r.flag_expr, r.reason FROM scenario_task_rules r
      WHERE r.workflow_id = wf AND r.task_code = v.like_code AND r.is_active;
    END IF;
    -- Q513 SLA: 2 to 3 working days from the L2 approval of the Procurement record (admin-editable)
    INSERT INTO sla_rules (task_def_id, min_working_days, max_working_days, start_event, scenario, region_id, calendar_id, effective_from, reason, changed_by, start_ref, end_ref, code, rule_set_id)
    VALUES (td, 2, 3, 'L2 approval of the Procurement record (assignment)', NULL, NULL, cal, DATE '2024-01-01', 'seed: Q513 (migration 0076)', '00000000-0000-0000-0000-000000000000'::uuid,
            'REC:procurement', NULL, v.code, rs);
    IF rs IS NOT NULL THEN
      INSERT INTO sla_rule_set_items (set_id, task_def_id, min_working_days, max_working_days, start_ref, end_ref, calendar_id, code)
      VALUES (rs, td, 2, 3, 'REC:procurement', NULL, cal, v.code) ON CONFLICT (set_id, task_def_id) DO NOTHING;
    END IF;
    IF v.code = 'MOB-2' THEN
      INSERT INTO task_predecessors (task_def_id, predecessor_id) SELECT td, b.id FROM task_definitions b WHERE b.workflow_id = wf AND b.code = 'B2' ON CONFLICT DO NOTHING;
    END IF;
    -- Q514 matrix cells: L1 Project Procurement Team, L2 the stage lead (global cells; the admin edits them)
    INSERT INTO matrix_cells (stage_id, task_def_id, level, rule, region_id, is_global, updated_at) VALUES (stg, td, 1, 'any_one', NULL, true, now()) RETURNING id INTO cid;
    INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', r.id FROM roles r WHERE r.code = 'PROC_TEAM';
    INSERT INTO matrix_cells (stage_id, task_def_id, level, rule, region_id, is_global, updated_at) VALUES (stg, td, 3, 'any_one', NULL, true, now()) RETURNING id INTO cid;
    INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) SELECT cid, 'role', r.id FROM roles r WHERE r.code = v.l2;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    UPDATE matrix_state SET revision = revision + 1, updated_at = now();
    -- the sites already in the system get the new tasks locked, like a task added to an existing stage (B8); the admin opens or sets them N/A
    INSERT INTO task_instances (site_id, region_id, task_def_id, state, levels_required, sla_rule_id, updated_at)
    SELECT s.id, s.region_id, d.id, 'locked', coalesce(d.approval_levels, st.approval_levels), sla_rule_for(d.id, s.delivery_scenario, s.region_id, current_date), now()
    FROM sites s JOIN task_definitions d ON d.workflow_id = s.workflow_version_id AND d.code IN ('MOB-1', 'MOB-2', 'MOB-5') JOIN stage_definitions st ON st.id = d.stage_id
    WHERE NOT EXISTS (SELECT 1 FROM task_instances x WHERE x.site_id = s.id AND x.task_def_id = d.id);
    INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
    VALUES ('mob_tasks_seeded', 'workflow', wf::text, jsonb_build_object('tasks', jsonb_build_array('MOB-1', 'MOB-2', 'MOB-5'), 'counts_toward_milestone', false, 'sla', '2-3 working days from REC:procurement'),
            'Owner decisions Q506 and Q513 to Q516 (migration 0076): mobilization tasks added inside existing stages; milestones, gates, weights and existing SLA unchanged.');
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 13. Ownership and execute rights
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['fa_latest(text,text,text)', 'fa_field_work(jsonb)', 'fin_balance(uuid)', 'fleet_readiness_calc(uuid)', 'fleet_readiness(uuid)', 'fa_mob_complete(uuid)',
      'fleet_sync(uuid)', 'fa_new_draft(text,text,uuid,integer,jsonb)', 'fa_open_drafts(uuid)', 'fa_proc_current(text)', 'fa_rules()', 'fa_after()', 'fin_amounts_visible(uuid,text,jsonb)',
      'reg_data_for(uuid,text,text,uuid,jsonb)', 'fleet_extend_booking(uuid,date)', 'fin_top_up(uuid,numeric,date)', 'fleet_availability(date,date,text,text,uuid)',
      'sla_resolve_start(uuid,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pmis_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION fleet_readiness(uuid), reg_data_for(uuid, text, text, uuid, jsonb), fleet_extend_booking(uuid, date), fin_top_up(uuid, numeric, date),
      fleet_availability(date, date, text, text, uuid), sla_resolve_start(uuid, text) TO pmis_app;
  END IF;
END $$;
GRANT SELECT, UPDATE ON task_instances TO pmis_definer;
GRANT INSERT ON workflow_steps TO pmis_definer;
