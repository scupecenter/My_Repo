-- 0326_deliverables_register: the Deliverables register is switched on (item F4 of the approved relations review; the register row, its Matrix row
-- and its data reset part exist since 0020 / 0035 / 0183, with the register disabled).
-- Mirror: db/sql/325_deliverables_register.sql (kept identical to prisma/migrations/0326_deliverables_register/migration.sql).
--
--   Q71: the manual log behind the eight Project Status items (HLD, DOC, NMS-S, BILL, PILOT, NMS-I, NMS-A, TRN). Each unit has an acceptance reference
--   and a document. Entry by Project Support, approval by the Project Manager: the Matrix cells of 0035 stay as they are (no holder change).
--
--   1. Lists DeliverableKind and DeliverableState (Settings > Dropdown lists: add, rename, reorder, hide; the codes never change). Cancelling is a state.
--   2. The register row is enabled and becomes site-scoped (one site has several deliverables); its fields, with two links: the task (task_code) and the
--      gate (gate_code) the deliverable belongs to, both picked from the site's own lists in the form.
--   3. The row trigger deliverables_rules checks both links and the document on a version in entry (a version in review or approved is history).
--   4. The permission module deliverables (catalogue key in code; no grant is seeded: no permission widening), the nav catalogue key, the template.
--   5. Nothing to patch in the data reset (the part deliverables exists since 0183) and no new table, endpoint or grant. Nothing is deleted.
SELECT set_config('app.region_ids', '*', true);

INSERT INTO list_catalogues (code, name_en, name_ar, critical, status, allow_other, description) VALUES
  ('DeliverableKind',  'Deliverable kind',  'نوع المخرج',  false, 'pending', false, 'Which Project Status item a deliverable feeds (Q71).'),
  ('DeliverableState', 'Deliverable state', 'حالة المخرج', false, 'pending', false, 'Where a deliverable is between planning and acceptance (Q71).')
ON CONFLICT (code) DO NOTHING;

INSERT INTO list_values (catalogue_code, code, label_en, label_ar, sort_order) VALUES
  ('DeliverableKind',  'HLD',       'HLD',       'HLD',       10),
  ('DeliverableKind',  'DOC',       'DOC',       'DOC',       20),
  ('DeliverableKind',  'NMS-S',     'NMS-S',     'NMS-S',     30),
  ('DeliverableKind',  'BILL',      'BILL',      'BILL',      40),
  ('DeliverableKind',  'PILOT',     'PILOT',     'PILOT',     50),
  ('DeliverableKind',  'NMS-I',     'NMS-I',     'NMS-I',     60),
  ('DeliverableKind',  'NMS-A',     'NMS-A',     'NMS-A',     70),
  ('DeliverableKind',  'TRN',       'TRN',       'TRN',       80),
  ('DeliverableState', 'Planned',   'Planned',   'مخطط',      10),
  ('DeliverableState', 'Submitted', 'Submitted', 'مقدَّم',    20),
  ('DeliverableState', 'Accepted',  'Accepted',  'مقبول',     30),
  ('DeliverableState', 'Rejected',  'Rejected',  'مرفوض',     40),
  ('DeliverableState', 'Cancelled', 'Cancelled', 'ملغى',      50)
ON CONFLICT (catalogue_code, code) DO NOTHING;

UPDATE register_definitions SET enabled = true, site_scoped = true, multiple_per_site = true WHERE register_key = 'deliverables';

INSERT INTO register_fields (register_key, code, label_en, label_ar, field_type, required, is_actual, derived, options, in_list, section, sort_order, list_catalogue) VALUES
  ('deliverables', 'deliverable_no',    'Deliverable No.',      'رقم المخرج',            'text',      true,  false, false, NULL, true,  'Deliverable', 10,  NULL),
  ('deliverables', 'deliverable_kind',  'Kind',                 'النوع',                 'list_code', true,  false, false, NULL, true,  'Deliverable', 20,  'DeliverableKind'),
  ('deliverables', 'title',             'Title',                'العنوان',               'text',      true,  false, false, NULL, true,  'Deliverable', 30,  NULL),
  ('deliverables', 'task_code',         'Task',                 'المهمة',                'text',      false, false, false, NULL, true,  'Links',       40,  NULL),
  ('deliverables', 'gate_code',         'Gate',                 'البوابة',               'text',      false, false, false, NULL, true,  'Links',       50,  NULL),
  ('deliverables', 'due_date',          'Due Date',             'تاريخ الاستحقاق',       'date',      false, false, false, NULL, true,  'Acceptance',  60,  NULL),
  ('deliverables', 'submitted_date',    'Submitted Date',       'تاريخ التقديم',         'date',      false, true,  false, NULL, true,  'Acceptance',  70,  NULL),
  ('deliverables', 'accepted_date',     'Accepted Date',        'تاريخ القبول',          'date',      false, true,  false, NULL, true,  'Acceptance',  80,  NULL),
  ('deliverables', 'acceptance_ref',    'Acceptance Ref.',      'مرجع القبول',           'text',      true,  false, false, NULL, true,  'Acceptance',  90,  NULL),
  ('deliverables', 'deliverable_state', 'Deliverable state',    'حالة المخرج',           'list_code', false, false, false, NULL, true,  'Acceptance',  100, 'DeliverableState'),
  ('deliverables', 'deliverable_file',  'Document',             'المستند',               'file',      false, false, false, NULL, false, 'Acceptance',  110, NULL),
  ('deliverables', 'remark',            'Remark',               'ملاحظات',               'text',      false, false, false, NULL, false, 'Remark',      120, NULL)
ON CONFLICT (register_key, code) DO NOTHING;

CREATE OR REPLACE FUNCTION deliverables_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  d jsonb := NEW.data; errs jsonb := '[]'::jsonb;
  live boolean := NEW.state = 'entry' OR (TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state <> 'voided');
  leaving boolean := TG_OP = 'UPDATE' AND OLD.state = 'entry' AND NEW.state NOT IN ('entry', 'voided');
BEGIN
  IF NOT live THEN RETURN NEW; END IF;
  IF coalesce(d ->> 'task_code', '') = '' THEN NEW.data := NEW.data - 'task_code';
  ELSIF NOT (TG_OP = 'UPDATE' AND OLD.data ->> 'task_code' IS NOT DISTINCT FROM d ->> 'task_code') THEN   -- unchanged: never re-checked
    IF NOT EXISTS (SELECT 1 FROM public.task_definitions td WHERE td.code = d ->> 'task_code') THEN
      errs := errs || public.reg_err_item('/data/task_code', 'unknown_task', 'Not a task code of the workflow.');
    END IF;
  END IF;
  IF coalesce(d ->> 'gate_code', '') = '' THEN NEW.data := NEW.data - 'gate_code';
  ELSIF NOT (TG_OP = 'UPDATE' AND OLD.data ->> 'gate_code' IS NOT DISTINCT FROM d ->> 'gate_code') THEN
    IF NOT EXISTS (SELECT 1 FROM public.phase_gate_rules g WHERE g.link_code = d ->> 'gate_code') THEN
      errs := errs || public.reg_err_item('/data/gate_code', 'unknown_gate', 'Not a gate code of the workflow.');
    END IF;
  END IF;
  IF leaving AND coalesce(d ->> 'deliverable_file', '') = '' THEN
    errs := errs || public.reg_err_item('/data/deliverable_file', 'document_required', 'A deliverable needs its document before it goes to review (Q71).');
  END IF;
  IF jsonb_array_length(errs) > 0 THEN PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', errs)); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_deliverables_rules BEFORE INSERT OR UPDATE OF data, state ON register_records
  FOR EACH ROW WHEN (NEW.register_key = 'deliverables') EXECUTE FUNCTION deliverables_rules();

INSERT INTO nav_item_catalogue (key, default_group, ord, added_in)
VALUES ('deliverables', 'registers', 35, '0326')
ON CONFLICT (key) DO NOTHING;

INSERT INTO template_definitions (template_id, name, name_ar, target_entity, kind, register_key, module_key, custom_entity, match_keys, sort_order)
SELECT 'TPL-DELIVERABLES', r.name_en, r.name_ar, r.register_key, 'register', r.register_key, r.module_key, NULL, '[["site_code","deliverable_no"]]'::jsonb, r.sort_order
FROM register_definitions r WHERE r.register_key = 'deliverables'
ON CONFLICT (template_id) DO NOTHING;
SELECT tpl_sync_all();
