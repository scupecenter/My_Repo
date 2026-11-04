import type { RegisterDefinition, RegisterField, RegisterKey, RegisterRecordStep, UserRef } from '@/api/types';

/**
 * Mock register catalogue and seed rows (synthetic). Field codes, values, sections and required flags are the ones the API serves from
 * `register_fields` (migration 0019, `GET /registers`): the real server and this mock answer the same shapes.
 */
type FT = RegisterField['type'];
const opt = (values: string[]) => values.map((value) => ({ value, label_en: value }));
const F = (code: string, label_en: string, label_ar: string, type: FT, section: string, o: { required?: boolean; in_list?: boolean; read_only?: boolean; options?: string[] } = {}): RegisterField => ({
  code, label_en, label_ar, type, section, required: !!o.required, read_only: !!o.read_only, in_list: !!o.in_list, is_custom: false, ...(o.options ? { options: opt(o.options) } : {}),
});
export const PERMIT_TYPES = ['City Council Permit', 'Civil Aviation Authority Permit', 'Security Clearance', 'Other Permit', 'Access - Survey', 'Access - CW', 'Access - TE', 'Access - Dismantle', 'Access - QC / Maintenance', 'PTW - CW', 'PTW - TE', 'PTW - Dismantle'];

const procurement: RegisterDefinition = {
  register_key: 'procurement', name_en: 'Procurement (PR / PO / WO)', name_ar: 'المشتريات (PR / PO / WO)', module_key: 'procurement', site_scoped: true, multiple_per_site: true, record_types: ['pr', 'po', 'wo'], approval_levels: 2,
  fields: [
    F('scope', 'Scope', 'النطاق', 'list', 'Site and scope', { required: true, in_list: true, options: ['CW', 'Tower Erection', 'Site Adaption', 'TE Installation', 'CW Dismantle', 'TE Dismantle', 'STA', 'ST', 'HLC'] }),
    F('delivery', 'Delivery', 'طريقة التنفيذ', 'list', 'Site and scope', { in_list: true, options: ['Outsourced', 'In-House', 'TE Vendor'] }),
    F('pr_no', 'PR No.', 'رقم طلب الشراء', 'text', 'Request', { in_list: true }), F('pr_date', 'PR Date', 'تاريخ طلب الشراء', 'date', 'Request', { in_list: true }),
    // migration 0042: the HLC approval date of a scope-HLC request (the HLC purchase request lives here, entered by the HLC Fiber Team)
    F('hlc_approval_date', 'HLC Approval Date', 'تاريخ موافقة HLC', 'date', 'Request', { in_list: true }),
    F('po_wo_no', 'PO / WO No.', 'رقم أمر الشراء / العمل', 'text', 'Order', { in_list: true }), F('po_wo_date', 'PO / WO Date', 'تاريخ أمر الشراء / العمل', 'date', 'Order', { in_list: true }),
    F('team_id', 'Team', 'الفريق', 'text', 'Assignment'),
    F('order_status', 'Order Status', 'حالة الطلب', 'list', 'Status and remark', { required: true, in_list: true }),
    F('remark', 'Remark', 'ملاحظات', 'text', 'Status and remark'),
  ],
};
const gecol: RegisterDefinition = {
  register_key: 'gecol', name_en: 'GECOL power', name_ar: 'كهرباء GECOL', module_key: 'gecol', site_scoped: true, multiple_per_site: false, approval_levels: 2,
  fields: [
    F('pr_no', 'GECOL PR No.', 'رقم طلب الشراء (GECOL)', 'text', 'Request', { required: true, in_list: true }), F('request_date', 'GECOL Request Date', 'تاريخ طلب GECOL', 'date', 'Request', { required: true, in_list: true }),
    F('contractor', 'GECOL Contractor', 'مقاول GECOL', 'text', 'Request'),
    F('survey_date', 'Survey Date', 'تاريخ المسح', 'date', 'Survey and layout'), F('layout_received', 'Layout Received', 'استلام المخطط', 'date', 'Survey and layout'), F('layout_approved', 'Layout Approved', 'اعتماد المخطط', 'date', 'Survey and layout'),
    F('notice_date', 'GECOL Notice Date', 'تاريخ إشعار GECOL', 'date', 'Notice and works'), F('mos_date', 'MOS Date', 'تاريخ MOS', 'date', 'Notice and works'),
    F('installation_finish', 'Installation Finish Date', 'تاريخ انتهاء التركيب', 'date', 'Notice and works', { in_list: true }),
    F('aat_acceptance_date', 'AAT Acceptance Date', 'تاريخ قبول AAT', 'date', 'Acceptance'), F('docs_approval_date', 'GECOL Docs Approval Date', 'تاريخ اعتماد مستندات GECOL', 'date', 'Acceptance'),
    F('meter_no', 'Meter No.', 'رقم العداد', 'text', 'Meter and power-on'), F('power_on_date', 'Power-On Date (Meter Charging)', 'تاريخ التشغيل (شحن العداد)', 'date', 'Meter and power-on', { in_list: true }),
    F('billing_conversion_date', 'Billing Conversion Date', 'تاريخ تحويل الفوترة', 'date', 'Meter and power-on'),
    F('remark', 'Remark', 'ملاحظات', 'text', 'Remark'),
  ],
};
// migration 0042: execution only, linked to the approved scope-HLC Procurement record (pr_no, hlc_approval_date, procurement_record_id are filled by the server)
const hlc: RegisterDefinition = {
  register_key: 'hlc', name_en: 'HLC fiber', name_ar: 'ألياف HLC', module_key: 'hlc', site_scoped: true, multiple_per_site: false, approval_levels: 2,
  fields: [
    F('pr_no', 'HLC PR No.', 'رقم طلب شراء HLC', 'text', 'Purchase request', { in_list: true, read_only: true }),
    F('hlc_approval_date', 'HLC Approval Date', 'تاريخ موافقة HLC', 'date', 'Purchase request', { read_only: true }),
    F('procurement_record_id', 'Procurement record', 'سجل المشتريات', 'text', 'Purchase request', { read_only: true }),
    F('pr_exception', 'Emergency Exception (no approved PR)', 'استثناء طارئ (بدون طلب شراء معتمد)', 'yes_no', 'Purchase request'),
    F('pr_exception_reason', 'Emergency Exception Reason', 'سبب الاستثناء الطارئ', 'text', 'Purchase request'),
    F('fiber_uplink', 'Fiber Uplink (Exchange / Post)', 'وصلة الألياف (مقسم / عمود)', 'text', 'Status and team'),
    F('fiber_status', 'Fiber Status', 'حالة الألياف', 'list', 'Status and team', { in_list: true }), F('internal_fiber_team', 'Internal Fiber Team', 'فريق الألياف الداخلي', 'text', 'Status and team'),
    F('link_received_date', 'Link Received (handover from HLC)', 'استلام الوصلة (تسليم من HLC)', 'date', 'Installation and test', { in_list: true }),
    F('installation_date', 'Installation Date', 'تاريخ التركيب', 'date', 'Installation and test', { in_list: true }), F('tx_link_tested_date', 'TX Link Tested Date', 'تاريخ فحص وصلة TX', 'date', 'Installation and test', { in_list: true }),
    F('in_service_date', 'In Service (operation)', 'دخول الخدمة (التشغيل)', 'date', 'In service', { in_list: true }),
    F('remark', 'Remark', 'ملاحظات', 'text', 'Remark'),
  ],
};
const permits: RegisterDefinition = {
  register_key: 'permits_hse', name_en: 'Permits & HSE', name_ar: 'التصاريح والسلامة', module_key: 'permits_hse', site_scoped: true, multiple_per_site: true, approval_levels: 2,
  fields: [
    F('permit_type', 'Type', 'النوع', 'list', 'Permit', { required: true, in_list: true, options: PERMIT_TYPES }),
    // migration 0054 (Q220, D220b): the stream of a purpose-based permit type, chosen by the person entering it
    { ...F('permit_stream', 'Stream (by purpose)', 'المسار (حسب الغرض)', 'list', 'Permit', { in_list: true }), options: [
      { value: 'CW', label_en: 'Civil Works (CW)', label_ar: 'الأعمال المدنية (CW)' }, { value: 'TE', label_en: 'Installation (TE)', label_ar: 'التركيب (TE)' },
      { value: 'ACQ', label_en: 'Acquisition / RF & Design', label_ar: 'الاستحواذ / التصميم' }, { value: 'OM', label_en: 'O&M', label_ar: 'التشغيل والصيانة' }] },
    F('applied_date', 'Applied / Requested', 'تاريخ التقديم', 'date', 'Permit'),
    F('status', 'Status', 'الحالة', 'list', 'Permit', { required: true, in_list: true, options: ['Applied', 'Approved', 'Rejected', 'N/A'] }),
    F('has_expiry', 'Has expiry date', 'له تاريخ انتهاء', 'yes_no', 'Validity', { in_list: true }), F('valid_from', 'Valid From', 'ساري من', 'date', 'Validity', { in_list: true }), F('valid_to', 'Valid To', 'ساري حتى', 'date', 'Validity', { in_list: true }),
    F('na_reason', 'N/A Reason', 'سبب عدم الانطباق', 'text', 'N/A'), F('na_approved_by', 'N/A Approved By', 'معتمد عدم الانطباق', 'text', 'N/A', { read_only: true }),
    F('jsa_tra', 'JSA / TRA', 'JSA / TRA', 'list', 'PTW checks'), F('toolbox_talk', 'Toolbox Talk', 'Toolbox Talk', 'list', 'PTW checks'), F('work_at_height', 'Work at Height', 'العمل على المرتفعات', 'list', 'PTW checks'),
    F('lifting_plan', 'Lifting Plan', 'خطة الرفع', 'list', 'PTW checks'), F('loto', 'LOTO', 'LOTO', 'list', 'PTW checks'), F('rescue_plan', 'Rescue Plan', 'خطة الإنقاذ', 'list', 'PTW checks'),
    F('stop_work', 'Stop Work', 'إيقاف العمل', 'yes_no', 'Stop work', { in_list: true }), F('stop_lifted_date', 'Stop Lifted Date', 'تاريخ رفع الإيقاف', 'date', 'Stop work'),
    F('remark', 'Remark', 'ملاحظات', 'text', 'Remark'),
  ],
};
// Dismantle (migration 0021): two parts per site, record types cw and te; fields and sections as seeded in register_fields.
const dismantle: RegisterDefinition = {
  register_key: 'dismantle', name_en: 'Dismantle', name_ar: 'الفك', module_key: 'dismantle', site_scoped: true, multiple_per_site: true, record_types: ['cw', 'te'], approval_levels: 2,
  fields: [
    F('rfd_date', 'RFD Date', 'تاريخ طلب الفك (RFD)', 'date', 'RFD', { required: true, in_list: true }),
    F('rfd_document_ref', 'RFD Document Reference', 'مرجع مستند طلب الفك', 'text', 'RFD'),
    F('dismantle_reason', 'Dismantle Reason', 'سبب الفك', 'list', 'Reason', { in_list: true, options: ['Swap', 'Relocation', 'Cancellation', 'Other'] }),
    // migration 0063 (Q114): the execution mode; outsourced work takes its contractor (FO / FT) from the chosen Procurement order
    F('execution_mode', 'Execution Mode', 'طريقة التنفيذ', 'list', 'Execution', { in_list: true, options: ['Outsourced', 'In-House'] }),
    F('procurement_order_id', 'Procurement Order', 'أمر المشتريات', 'text', 'Execution'),
    F('internal_team', 'Internal Team (In-House)', 'الفريق الداخلي المنفذ', 'text', 'Execution'),
    F('supervising_engineer', 'Supervising Engineer', 'مهندس الإشراف', 'user', 'Supervision and work'),
    F('work_start_date', 'Work Start Date', 'تاريخ بدء العمل', 'date', 'Supervision and work', { in_list: true }),
    F('work_end_date', 'Work End Date', 'تاريخ انتهاء العمل', 'date', 'Supervision and work', { in_list: true }),
    F('closing_rn_ref', 'Closing RN Reference', 'مرجع إيصال الإرجاع (RN)', 'text', 'Close'),
    F('closed', 'Part Closed', 'الجزء مغلق', 'yes_no', 'Close', { in_list: true }),
  ],
};
// The registers enabled by migration 0025 (contract 0.4.8): a few synthetic fields each; the form is built from them like any other register.
// rf_design and acquisition are served by the API but missing from the contract's RegisterKey enum (reported to tech-lead), hence the cast.
const more = (register_key: string, name_en: string, name_ar: string, module_key: string, site_scoped: boolean, record_types?: string[]): RegisterDefinition => ({
  register_key: register_key as RegisterDefinition['register_key'], name_en, name_ar, module_key, site_scoped, multiple_per_site: true, approval_levels: 2, ...(record_types ? { record_types } : {}),
  fields: [F('title', 'Title', 'العنوان', 'text', 'Details', { required: true, in_list: true }), F('remark', 'Remark', 'ملاحظات', 'text', 'Details')],
});
// Contract 0.12.5 (Q12, Q111, migration 0057): Meetings with the structured fields; the old free-text fields are read-only until converted.
const ACTION_STATUS = { code: 'ActionStatus', status: 'pending' as const, critical: false, allow_other: false };
export const meetings: RegisterDefinition = {
  register_key: 'meetings', name_en: 'Meetings', name_ar: 'الاجتماعات', module_key: 'meetings', site_scoped: false, multiple_per_site: true, approval_levels: 2,
  fields: [
    F('meeting_date', 'Date', 'التاريخ', 'date', 'Meeting', { required: true, in_list: true }), F('title', 'Title', 'العنوان', 'text', 'Meeting', { required: true, in_list: true }),
    { ...F('meeting_type', 'Type', 'النوع', 'list', 'Meeting', { in_list: true }), list: { code: 'MeetingType', status: 'pending', critical: false, allow_other: true }, options: [] },
    F('organiser', 'Organiser', 'المنظم', 'user', 'Meeting', { in_list: true }),
    F('attendee_users', 'Attendees', 'الحضور', 'multi_user', 'Attendees and sites'), F('linked_site_ids', 'Linked sites', 'المواقع المرتبطة', 'multi_site', 'Attendees and sites'),
    F('minutes_file', 'Minutes file', 'ملف المحضر', 'file', 'Minutes'),
    { ...F('action_items_list', 'Action items', 'إجراءات المتابعة', 'child_list', 'Action items'), columns: [
      { code: 'description', label_en: 'Action', label_ar: 'الإجراء', type: 'text', required: true },
      { code: 'owner', label_en: 'Owner', label_ar: 'المسؤول', type: 'user', required: true },
      { code: 'due_date', label_en: 'Due date', label_ar: 'تاريخ الاستحقاق', type: 'date', required: true },
      { code: 'status', label_en: 'Status', label_ar: 'الحالة', type: 'list', required: true, list: ACTION_STATUS,
        options: [{ value: 'Open', label_en: 'Open', label_ar: 'مفتوح' }, { value: 'In Progress', label_en: 'In Progress', label_ar: 'قيد التنفيذ' }, { value: 'Done', label_en: 'Done', label_ar: 'منجز', groups: ['closed'] }, { value: 'Cancelled', label_en: 'Cancelled', label_ar: 'ملغى', groups: ['closed'] }] },
      { code: 'closed_date', label_en: 'Closed date', label_ar: 'تاريخ الإغلاق', type: 'date', required: false },
      { code: 'task_id', label_en: 'Task', label_ar: 'المهمة', type: 'task', required: false },
    ] },
    F('attendees', 'Attendees (old text)', 'الحضور (نص قديم)', 'text', 'Old text (to convert)', { read_only: true }),
    F('linked_sites', 'Linked sites (old text)', 'المواقع (نص قديم)', 'text', 'Old text (to convert)', { read_only: true }),
    F('minutes_ref', 'Minutes (reference) (old text)', 'مرجع المحضر (نص قديم)', 'text', 'Old text (to convert)', { read_only: true }),
    F('action_items', 'Action items (old text)', 'الإجراءات (نص قديم)', 'text', 'Old text (to convert)', { read_only: true }),
    F('legacy_converted_at', 'Old text converted on', 'تاريخ تحويل النص القديم', 'date', 'Old text (to convert)', { read_only: true }),
  ],
};
export const REGISTER_DEFS: RegisterDefinition[] = [
  procurement, more('contractors', 'Contractors', 'المقاولون', 'contractors', false, ['company', 'team']), gecol, hlc, permits,
  more('warehouse', 'Warehouse', 'المخزن', 'warehouse', false, ['te_dn', 'cw_dn', 'te_rn', 'cw_rn', 'pl', 'open', 'adj']),
  more('quality', 'Quality', 'الجودة', 'quality', true, ['qc', 'snag', 'itp', 'ncr']), more('issues', 'Issue Log', 'سجل المشاكل', 'issues', true), more('risks', 'Risk Register', 'سجل المخاطر', 'risks', false),
  more('change_control', 'Change Control', 'ضبط التغيير', 'change_control', true), more('readiness_handover', 'Readiness & Handover', 'الجاهزية والتسليم', 'readiness', true),
  more('as_built', 'As-Built', 'كما نُفّذ', 'as_built', true, ['cw_part', 'te_part']), meetings,
  more('rf_design', 'RF Design', 'تصميم RF', 'rf_design', true), more('acquisition', 'Acquisition', 'الاستحواذ', 'acquisition', true), dismantle,
];
/** The template of each register (contract 0.7.0: one `TPL-*` per register, issued by the database). Only these four have a sample upload in the mock. */
export const REGISTER_TEMPLATES: Record<string, RegisterKey> = { 'TPL-PO': 'procurement', 'TPL-GECOL': 'gecol', 'TPL-HLC': 'hlc', 'TPL-PRM': 'permits_hse' };
/** Contract 0.11.5: one Site Register template per stream, and the whole Master (kind master). */
export const STREAM_TEMPLATES: Record<string, 'DESIGN_ACQ' | 'CW' | 'TE' | 'CLOSURE'> = { 'TPL-SITE-DA': 'DESIGN_ACQ', 'TPL-SITE-CW': 'CW', 'TPL-SITE-TE': 'TE', 'TPL-SITE-CL': 'CLOSURE' };
export const TEMPLATE_OF_REGISTER: Record<string, string> = {
  procurement: 'TPL-PO', contractors: 'TPL-CTR', rf_design: 'TPL-RF', acquisition: 'TPL-ACQ', gecol: 'TPL-GECOL', hlc: 'TPL-HLC', permits_hse: 'TPL-PRM', warehouse: 'TPL-WH',
  quality: 'TPL-QLT', issues: 'TPL-ISS', risks: 'TPL-RSK', change_control: 'TPL-CHG', readiness_handover: 'TPL-RDY', as_built: 'TPL-ASB', meetings: 'TPL-MTG', dismantle: 'TPL-DIS',
};

export type MockRecord = {
  id: string; register_key: RegisterKey; record_type: string | null; site_index: number | null; state: 'entry' | 'in_review' | 'in_approval' | 'approved' | 'voided';
  current_level: number; levels_required?: number; data: Record<string, unknown>; version: number; return_count: number; last_return_note: string | null;
  created_by: string; created_at: string; updated_at: string; steps: RegisterRecordStep[]; claimed_by?: UserRef;
  /** The logical record (every version shares it) and this version's number; a new version supersedes the one before. */
  entity_id: string; version_no: number; supersedes_id?: string | null;
  /** Q43: the task this record is the source of, set at the first submission (or by the seed for an approved one). */
  task?: { id: string; task_code: string } | null;
  /** Q221 (0054): the draft was handed over to the entry holders of its stream row. */
  transferred?: boolean;
  /** Entered through a template batch (contract 0.7.0): the import row the version came from. */
  source?: 'manual' | 'template'; batch_row_id?: string;
  /** The contractor of the record (RegisterRecord.external_party); 0063 (Q114): derived from the Procurement order for an outsourced Dismantle part. */
  external_party?: { id: string; name: string; type: 'cw_contractor' | 'te_vendor' | 'gecol' | 'hlc' | 'supplier' | 'landlord' | 'other' } | null;
  /** 0063 (Q150): the HLC purchase requests (Procurement entity ids) an HLC record names. */
  pr_links?: string[];
};
export type MockBatchRow = {
  id: string; row_no: number; key: string; action: 'create' | 'update' | 'unchanged' | 'error'; decision: 'pending' | 'approved' | 'rejected' | 'pending_previous_approval';
  payload: Record<string, unknown>; site_index: number | null; errors: { column?: string; field?: string; code: string; message?: string }[];
  diff: Record<string, { old?: unknown; new?: unknown }>;
  /** The approved version an update is built on, the open version that holds a row, and the record created when the batch is sent. */
  base_id?: string; hold_reason?: 'open_version' | 'open_submission' | 'predecessor_open'; hold_record_id?: string; record_id?: string; note?: string | null;
  /** A stream batch row (contract 0.11.5): one per touched task; the file row is `row_no`. */
  task_code?: string; warnings?: { column?: string; field?: string; code: string; message?: string }[]; sheet?: string; source_ref?: string;
};
/** `status`: validated (staged), sent (in the flow; the shown status follows the rows) or discarded. */
export type MockBatch = {
  /** A stream batch has no register; `group_id` ties the batches of one TPL-MASTER file. */
  stream?: 'DESIGN_ACQ' | 'CW' | 'TE' | 'CLOSURE'; group_id?: string; part_sheet?: string;
  id: string; register_key: RegisterKey | null; template_id: string; file_name: string; status: 'validated' | 'sent' | 'discarded'; version: number; created: number;
  uploaded_by: string; uploaded_at: string; note?: string | null; rows: MockBatchRow[];
};

const pad = (n: number) => String(n).padStart(12, '0');
export const recId = (n: number) => `a0000000-0000-4000-8000-${pad(n)}`;
const task = (site: number, k: number) => `60000000-0000-4000-8000-${pad((site + 1) * 100 + k)}`;
let n = 0;
const rec = (key: RegisterKey, type: string | null, site: number, state: MockRecord['state'], data: Record<string, unknown>, extra: Partial<MockRecord> = {}): MockRecord => {
  const id = recId(++n);
  return {
    id, entity_id: id, version_no: 1, register_key: key, record_type: type, site_index: site, state, current_level: state === 'entry' ? 1 : state === 'in_review' ? 2 : state === 'in_approval' ? 3 : 3, data, version: 1, return_count: 0, last_return_note: null,
    created_by: '1509', created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-20T08:00:00Z', steps: [], ...extra,
  };
};

export function initRegisters() {
  n = 0;
  const records: MockRecord[] = [
    rec('procurement', 'pr', 0, 'approved', { scope: 'CW', delivery: 'Outsourced', pr_no: 'PR-2026-014', pr_date: '2026-09-02', order_status: 'Open' }, { task: { id: task(0, 4), task_code: 'B1' } }),
    rec('procurement', 'po', 1, 'in_review', { scope: 'CW', delivery: 'Outsourced', pr_no: 'PR-2026-015', pr_date: '2026-09-05', po_wo_no: 'PO-2026-031', po_wo_date: '2026-09-12', order_status: 'Issued' }),
    rec('procurement', 'wo', 2, 'entry', { scope: 'Site Adaption', delivery: 'In-House', po_wo_no: 'WO-2026-007', po_wo_date: '2026-09-20', order_status: 'Open' }),
    rec('procurement', 'pr', 3, 'in_approval', { scope: 'Tower Erection', delivery: 'Outsourced', pr_no: 'PR-2026-019', pr_date: '2026-09-18', order_status: 'Open' }),
    rec('gecol', null, 0, 'approved', { pr_no: 'GPR-2026-002', request_date: '2026-08-10', survey_date: '2026-08-20', notice_date: '2026-09-01', installation_finish: '2026-09-25', meter_no: 'M-77120', power_on_date: '2026-10-02' }, { task: { id: task(0, 13), task_code: 'C2' } }),
    rec('gecol', null, 4, 'entry', { pr_no: 'GPR-2026-009', request_date: '2026-10-01', survey_date: '2026-10-01', notice_date: '2026-10-08' }),
    rec('hlc', null, 1, 'in_review', { pr_no: 'HPR-2026-044', hlc_approval_date: '2026-09-14', procurement_record_id: recId(14), fiber_uplink: 'Exchange Ain Zara', fiber_status: 'In Progress', internal_fiber_team: 'HLC Team 1', link_received_date: '2026-09-28', installation_date: '2026-10-05' }),
    // entered before migration 0042: the old request fields stay readable (legacy), the request is not yet in Procurement
    rec('hlc', null, 5, 'approved', { request_no: 'HLC-2026-031', request_date: '2026-08-14', fiber_status: 'Installed', installation_date: '2026-09-02', tx_link_tested_date: '2026-09-09' }),
    rec('permits_hse', null, 0, 'approved', { permit_type: 'Access - CW', applied_date: '2026-09-01', status: 'Approved', valid_from: '2026-09-10', has_expiry: true, valid_to: '2027-03-10' }),
    rec('permits_hse', null, 2, 'entry', { permit_type: 'PTW - CW', applied_date: '2026-10-10', status: 'Applied', has_expiry: true, jsa_tra: 'Done', stop_work: false }),
    rec('permits_hse', null, 3, 'approved', { permit_type: 'Civil Aviation Authority Permit', applied_date: '2026-08-01', status: 'Approved', valid_from: '2026-08-15', has_expiry: false }),
    rec('dismantle', 'cw', 0, 'approved', { rfd_date: '2026-09-15', dismantle_reason: 'Swap', work_start_date: '2026-09-20', work_end_date: '2026-09-24', closing_rn_ref: 'RN-2026-0042', closed: true }),
    rec('dismantle', 'te', 1, 'entry', { rfd_date: '2026-10-05', dismantle_reason: 'Relocation' }),
    // migration 0042: the HLC purchase request of site 1, entered by the HLC Fiber Team in Procurement; it closed C3 on the HLC approval date
    rec('procurement', 'pr', 1, 'approved', { scope: 'HLC', delivery: 'Outsourced', pr_no: 'HPR-2026-044', pr_date: '2026-09-10', hlc_approval_date: '2026-09-14', order_status: 'Open' }, { task: { id: task(1, 14), task_code: 'C3' } }),
    // contract 0.12.5 (Q111): a meeting entered with the old free text, to convert after a review (recId(15))
    rec('meetings', null, 0, 'entry', { meeting_date: '2026-10-01', title: 'Weekly progress', attendees: 'Ahmed Salem, Mona Fathi', linked_sites: 'TR101',
      minutes_ref: 'MoM-07 on the share', action_items: '- Send the LLD\n- Book the crane' }, { site_index: null }),
    // migration 0063 (Q114): (recId(16), after the P5 meeting) the approved TE Dismantle order of site 1, which the TE Dismantle part takes its contractor (FT) from
    rec('procurement', 'wo', 1, 'approved', { scope: 'TE Dismantle', delivery: 'Outsourced', pr_no: 'PR-2026-061', pr_date: '2026-09-25', po_wo_no: 'WO-2026-061', po_wo_date: '2026-09-28', order_status: 'Open' },
      { external_party: { id: 'e0000000-0000-4000-8000-000000000061', name: 'Desert Lift Services (synthetic)', type: 'cw_contractor' } }),
  ];
  return { records, batches: [] as MockBatch[], seq: 100 };
}
