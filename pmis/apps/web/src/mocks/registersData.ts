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
  register_key: 'procurement', name_en: 'Procurement (PR / PO / WO)', name_ar: 'المشتريات (PR / PO / WO)', module_key: 'procurement', site_scoped: true, multiple_per_site: true, record_types: ['pr', 'po', 'wo'], approval_levels: 3,
  fields: [
    F('scope', 'Scope', 'النطاق', 'list', 'Site and scope', { required: true, in_list: true, options: ['CW', 'Tower Erection', 'Site Adaption', 'TE Installation', 'CW Dismantle', 'TE Dismantle', 'STA', 'ST'] }),
    F('delivery', 'Delivery', 'طريقة التنفيذ', 'list', 'Site and scope', { in_list: true, options: ['Outsourced', 'In-House', 'TE Vendor'] }),
    F('pr_no', 'PR No.', 'رقم طلب الشراء', 'text', 'Request', { in_list: true }), F('pr_date', 'PR Date', 'تاريخ طلب الشراء', 'date', 'Request', { in_list: true }),
    F('po_wo_no', 'PO / WO No.', 'رقم أمر الشراء / العمل', 'text', 'Order', { in_list: true }), F('po_wo_date', 'PO / WO Date', 'تاريخ أمر الشراء / العمل', 'date', 'Order', { in_list: true }),
    F('team_id', 'Team', 'الفريق', 'text', 'Assignment'),
    F('order_status', 'Order Status', 'حالة الطلب', 'list', 'Status and remark', { required: true, in_list: true }),
    F('remark', 'Remark', 'ملاحظات', 'text', 'Status and remark'),
  ],
};
const gecol: RegisterDefinition = {
  register_key: 'gecol', name_en: 'GECOL power', name_ar: 'كهرباء GECOL', module_key: 'gecol', site_scoped: true, multiple_per_site: false, approval_levels: 3,
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
const hlc: RegisterDefinition = {
  register_key: 'hlc', name_en: 'HLC fiber', name_ar: 'ألياف HLC', module_key: 'hlc', site_scoped: true, multiple_per_site: false, approval_levels: 3,
  fields: [
    F('request_no', 'HLC Request No.', 'رقم طلب HLC', 'text', 'Request', { required: true, in_list: true }), F('request_date', 'Request Date', 'تاريخ الطلب', 'date', 'Request', { required: true, in_list: true }),
    F('fiber_uplink', 'Fiber Uplink (Exchange / Post)', 'وصلة الألياف (مقسم / عمود)', 'text', 'Request'),
    F('fiber_status', 'Fiber Status', 'حالة الألياف', 'list', 'Status and team', { in_list: true }), F('internal_fiber_team', 'Internal Fiber Team', 'فريق الألياف الداخلي', 'text', 'Status and team'),
    F('installation_date', 'Installation Date', 'تاريخ التركيب', 'date', 'Installation and test', { in_list: true }), F('tx_link_tested_date', 'TX Link Tested Date', 'تاريخ فحص وصلة TX', 'date', 'Installation and test', { in_list: true }),
    F('remark', 'Remark', 'ملاحظات', 'text', 'Remark'),
  ],
};
const permits: RegisterDefinition = {
  register_key: 'permits_hse', name_en: 'Permits & HSE', name_ar: 'التصاريح والسلامة', module_key: 'permits_hse', site_scoped: true, multiple_per_site: true, approval_levels: 3,
  fields: [
    F('permit_type', 'Type', 'النوع', 'list', 'Permit', { required: true, in_list: true, options: PERMIT_TYPES }),
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
export const REGISTER_DEFS: RegisterDefinition[] = [procurement, gecol, hlc, permits];
export const REGISTER_TEMPLATES: Record<string, RegisterKey> = { 'TPL-PO': 'procurement', 'TPL-GECOL': 'gecol', 'TPL-HLC': 'hlc', 'TPL-PRM': 'permits_hse' };

export type MockRecord = {
  id: string; register_key: RegisterKey; record_type: string | null; site_index: number | null; state: 'entry' | 'in_review' | 'in_approval' | 'approved' | 'voided';
  current_level: number; levels_required?: number; data: Record<string, unknown>; version: number; return_count: number; last_return_note: string | null;
  created_by: string; created_at: string; updated_at: string; steps: RegisterRecordStep[]; claimed_by?: UserRef;
  /** The logical record (every version shares it) and this version's number; a new version supersedes the one before. */
  entity_id: string; version_no: number; supersedes_id?: string | null;
  /** Q43: the task this record is the source of, set at the first submission (or by the seed for an approved one). */
  task?: { id: string; task_code: string } | null;
};
export type MockBatch = {
  id: string; register_key: RegisterKey; template_id: string; file_name: string; status: string; current_level: number; levels_required: number; version: number; created: number;
  uploaded_by: string; uploaded_at: string; rows: { id: string; row_no: number; key: string; action: 'create' | 'update' | 'unchanged' | 'error'; decision: 'pending' | 'approved' | 'rejected' | 'pending_previous_approval'; payload: Record<string, unknown>; site_index: number | null; errors: { column?: string; code: string; message?: string }[]; diff: Record<string, { old?: unknown; new?: unknown }> }[];
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
    rec('hlc', null, 1, 'in_review', { request_no: 'HLC-2026-044', request_date: '2026-09-10', fiber_uplink: 'Exchange Ain Zara', fiber_status: 'In Progress', internal_fiber_team: 'HLC Team 1', installation_date: '2026-10-05' }),
    rec('hlc', null, 5, 'approved', { request_no: 'HLC-2026-031', request_date: '2026-08-14', fiber_status: 'Installed', installation_date: '2026-09-02', tx_link_tested_date: '2026-09-09' }),
    rec('permits_hse', null, 0, 'approved', { permit_type: 'Access - CW', applied_date: '2026-09-01', status: 'Approved', valid_from: '2026-09-10', has_expiry: true, valid_to: '2027-03-10' }),
    rec('permits_hse', null, 2, 'entry', { permit_type: 'PTW - CW', applied_date: '2026-10-10', status: 'Applied', has_expiry: true, jsa_tra: 'Done', stop_work: false }),
    rec('permits_hse', null, 3, 'approved', { permit_type: 'Civil Aviation Authority Permit', applied_date: '2026-08-01', status: 'Approved', valid_from: '2026-08-15', has_expiry: false }),
  ];
  return { records, batches: [] as MockBatch[], seq: 100 };
}
