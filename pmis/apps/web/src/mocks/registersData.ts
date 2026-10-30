import type { RegisterDefinition, RegisterField, RegisterKey, UserRef, WorkflowStep } from '@/api/types';

/** Mock register catalogue and seed rows (synthetic). Field codes are the mock's own: the contract fixes the shape of RegisterField, not the codes. */
type FT = RegisterField['type'];
const opt = (pairs: [string, string, string][]) => pairs.map(([value, label_en, label_ar]) => ({ value, label_en, label_ar }));
const F = (code: string, label_en: string, label_ar: string, type: FT, o: { required?: boolean; in_list?: boolean; options?: [string, string, string][] } = {}): RegisterField => ({
  code, label_en, label_ar, type, required: !!o.required, read_only: false, in_list: !!o.in_list, is_custom: false, ...(o.options ? { options: opt(o.options) } : {}),
});
const YES_CHECK: [string, string, string][] = [['yes', 'Yes', 'نعم'], ['no', 'No', 'لا'], ['na', 'N/A', 'لا ينطبق']];

const procurement: RegisterDefinition = {
  register_key: 'procurement', name_en: 'Procurement (PR/PO/WO)', name_ar: 'المشتريات', module_key: 'procurement', site_scoped: true, multiple_per_site: true, record_types: ['pr', 'po', 'wo'], approval_levels: 3,
  fields: [
    F('scope', 'Scope', 'النطاق', 'list', { required: true, in_list: true, options: [['cw', 'CW', 'أعمال مدنية'], ['tower_erection', 'Tower Erection', 'نصب البرج'], ['site_adaption', 'Site Adaption', 'تهيئة الموقع'], ['te_installation', 'TE Installation', 'تركيب TE'], ['sta', 'STA', 'STA'], ['st', 'ST', 'ST'], ['cw_dismantle', 'CW Dismantle', 'إزالة مدنية'], ['te_dismantle', 'TE Dismantle', 'إزالة TE']] }),
    F('delivery', 'Delivery', 'طريقة التنفيذ', 'list', { required: true, options: [['outsourced', 'Outsourced', 'خارجي'], ['in_house', 'In-House', 'داخلي'], ['te_vendor', 'TE Vendor', 'مورد TE']] }),
    F('pr_no', 'PR No.', 'رقم طلب الشراء', 'text', { in_list: true }), F('pr_date', 'PR Date', 'تاريخ طلب الشراء', 'date'),
    F('po_wo_no', 'PO / WO No.', 'رقم أمر الشراء / العمل', 'text', { in_list: true }), F('po_wo_date', 'PO / WO Date', 'تاريخ أمر الشراء / العمل', 'date'),
    F('contractor', 'Contractor', 'المقاول', 'external_party', { options: [['at_global', 'A&T Global', 'A&T Global'], ['cw_one', 'Sahara Civil Works', 'الصحراء للأعمال المدنية'], ['cw_two', 'Nafusa Contracting', 'نفوسة للمقاولات']] }),
    F('team', 'Team', 'الفريق', 'list', { options: [['cw_team_1', 'CW Team 1', 'فريق مدني 1'], ['cw_team_2', 'CW Team 2', 'فريق مدني 2'], ['te_team_1', 'TE Team 1', 'فريق TE 1']] }),
    F('order_status', 'Order Status', 'حالة الطلب', 'list', { required: true, in_list: true, options: [['open', 'Open', 'مفتوح'], ['issued', 'Issued', 'صادر'], ['closed', 'Closed', 'مغلق'], ['cancelled', 'Cancelled', 'ملغي']] }),
    F('remark', 'Remark', 'ملاحظة', 'text'),
  ],
};
const gecol: RegisterDefinition = {
  register_key: 'gecol', name_en: 'GECOL power', name_ar: 'كهرباء الجيكول', module_key: 'gecol', site_scoped: true, multiple_per_site: false, approval_levels: 3,
  fields: [
    F('pr_no', 'GECOL PR No.', 'رقم طلب شراء الجيكول', 'text', { in_list: true }), F('pr_date', 'GECOL PR Date', 'تاريخ طلب شراء الجيكول', 'date'),
    F('survey_date', 'Survey Date', 'تاريخ المسح', 'date', { required: true }), F('layout_received', 'Layout Received', 'استلام المخطط', 'date'), F('layout_approved', 'Layout Approved', 'اعتماد المخطط', 'date'),
    F('notice_date', 'GECOL Notice Date', 'تاريخ إشعار الجيكول', 'date'), F('mos_date', 'MOS Date', 'تاريخ MOS', 'date'), F('install_finish', 'Installation Finish Date', 'تاريخ انتهاء التركيب', 'date', { in_list: true }),
    F('aat_acceptance', 'AAT Acceptance Date', 'تاريخ قبول AAT', 'date'), F('docs_approval', 'GECOL Docs Approval Date', 'تاريخ اعتماد مستندات الجيكول', 'date'),
    F('meter_no', 'Meter No.', 'رقم العداد', 'text', { in_list: true }), F('power_on', 'Power-On Date (Meter Charging)', 'تاريخ التشغيل (شحن العداد)', 'date', { in_list: true }), F('billing_conversion', 'Billing Conversion Date', 'تاريخ تحويل الفوترة', 'date'),
    F('remark', 'Remark', 'ملاحظة', 'text'),
  ],
};
const hlc: RegisterDefinition = {
  register_key: 'hlc', name_en: 'HLC Fiber', name_ar: 'ألياف HLC', module_key: 'hlc', site_scoped: true, multiple_per_site: false, approval_levels: 3,
  fields: [
    F('request_no', 'HLC Request No.', 'رقم طلب HLC', 'text', { required: true, in_list: true }), F('request_date', 'Request Date', 'تاريخ الطلب', 'date', { required: true }), F('fiber_uplink', 'Fiber Uplink (Exchange / Post)', 'وصلة الألياف (مقسم / عمود)', 'text'),
    F('fiber_status', 'Fiber Status', 'حالة الألياف', 'list', { required: true, in_list: true, options: [['planned', 'Planned', 'مخطط'], ['in_progress', 'In Progress', 'قيد التنفيذ'], ['installed', 'Installed', 'مركّب'], ['no_fiber', 'No Fiber', 'لا توجد ألياف'], ['through_mw', 'Through MW Link', 'عبر وصلة ميكروويف']] }),
    F('fiber_team', 'Internal Fiber Team', 'فريق الألياف الداخلي', 'list', { options: [['hlc_team_1', 'HLC Team 1', 'فريق HLC 1'], ['hlc_team_2', 'HLC Team 2', 'فريق HLC 2']] }),
    F('install_date', 'Installation Date', 'تاريخ التركيب', 'date', { in_list: true }), F('tx_tested_date', 'TX Link Tested Date', 'تاريخ اختبار وصلة TX', 'date', { in_list: true }), F('remark', 'Remark', 'ملاحظة', 'text'),
  ],
};
const permits: RegisterDefinition = {
  register_key: 'permits_hse', name_en: 'Permits & HSE', name_ar: 'التصاريح والسلامة', module_key: 'permits_hse', site_scoped: true, multiple_per_site: true, approval_levels: 3,
  fields: [
    F('type', 'Type', 'النوع', 'list', { required: true, in_list: true, options: [['caa', 'Civil Aviation Authority', 'الطيران المدني'], ['access_cw', 'Access - CW', 'دخول - مدني'], ['ptw_cw', 'PTW - CW', 'تصريح عمل - مدني'], ['access_te', 'Access - TE', 'دخول - TE'], ['ptw_te', 'PTW - TE', 'تصريح عمل - TE'], ['access_dismantle', 'Access - Dismantle', 'دخول - إزالة'], ['access_survey', 'Access - Survey', 'دخول - مسح'], ['access_qc', 'Access - QC / Maintenance', 'دخول - جودة / صيانة']] }),
    F('applied_date', 'Applied / Requested', 'تاريخ التقديم', 'date'),
    F('status', 'Status', 'الحالة', 'list', { required: true, in_list: true, options: [['applied', 'Applied', 'مقدّم'], ['approved', 'Approved', 'معتمد'], ['rejected', 'Rejected', 'مرفوض'], ['na', 'N/A', 'لا ينطبق']] }),
    F('valid_from', 'Valid From', 'ساري من', 'date', { in_list: true }), F('has_expiry', 'Has expiry date', 'له تاريخ انتهاء', 'yes_no'), F('valid_to', 'Valid To', 'ساري حتى', 'date', { in_list: true }),
    F('na_reason', 'N/A Reason', 'سبب عدم الانطباق', 'text'), F('na_approved_by', 'N/A Approved By', 'اعتمد عدم الانطباق', 'user'),
    F('jsa_tra', 'JSA / TRA', 'JSA / TRA', 'list', { options: YES_CHECK }), F('toolbox_talk', 'Toolbox Talk', 'اجتماع السلامة', 'list', { options: YES_CHECK }), F('work_at_height', 'Work at Height', 'العمل على ارتفاع', 'list', { options: YES_CHECK }),
    F('lifting_plan', 'Lifting Plan', 'خطة الرفع', 'list', { options: YES_CHECK }), F('loto', 'LOTO', 'LOTO', 'list', { options: YES_CHECK }), F('rescue_plan', 'Rescue Plan', 'خطة الإنقاذ', 'list', { options: YES_CHECK }),
    F('stop_work', 'Stop Work', 'إيقاف العمل', 'yes_no'), F('stop_lifted_date', 'Stop Lifted Date', 'تاريخ رفع الإيقاف', 'date'), F('remark', 'Remark', 'ملاحظة', 'text'),
  ],
};
export const REGISTER_DEFS: RegisterDefinition[] = [procurement, gecol, hlc, permits];
export const REGISTER_TEMPLATES: Record<string, RegisterKey> = { 'TPL-PO': 'procurement', 'TPL-GECOL': 'gecol', 'TPL-HLC': 'hlc', 'TPL-PRM': 'permits_hse' };

export type MockRecord = {
  id: string; register_key: RegisterKey; record_type: string | null; site_index: number | null; state: 'entry' | 'in_review' | 'in_approval' | 'approved' | 'voided';
  current_level: number; levels_required?: number; data: Record<string, unknown>; version: number; return_count: number; last_return_note: string | null;
  created_by: string; created_at: string; updated_at: string; steps: WorkflowStep[]; claimed_by?: UserRef;
};
export type MockBatch = {
  id: string; register_key: RegisterKey; template_id: string; file_name: string; status: string; current_level: number; levels_required: number; version: number; created: number;
  uploaded_by: string; uploaded_at: string; rows: { id: string; row_no: number; key: string; action: 'create' | 'update' | 'unchanged' | 'error'; decision: 'pending' | 'approved' | 'rejected' | 'pending_previous_approval'; payload: Record<string, unknown>; site_index: number | null; errors: { column?: string; code: string; message?: string }[]; diff: Record<string, { old?: unknown; new?: unknown }> }[];
};

const pad = (n: number) => String(n).padStart(12, '0');
export const recId = (n: number) => `a0000000-0000-4000-8000-${pad(n)}`;
const task = (site: number, k: number) => `60000000-0000-4000-8000-${pad((site + 1) * 100 + k)}`;
let n = 0;
const rec = (key: RegisterKey, type: string | null, site: number, state: MockRecord['state'], data: Record<string, unknown>, extra: Partial<MockRecord> = {}): MockRecord => ({
  id: recId(++n), register_key: key, record_type: type, site_index: site, state, current_level: state === 'entry' ? 1 : state === 'in_review' ? 2 : state === 'in_approval' ? 3 : 3, data, version: 1, return_count: 0, last_return_note: null,
  created_by: '1509', created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-20T08:00:00Z', steps: [], ...extra,
});

export function initRegisters() {
  n = 0;
  const records: MockRecord[] = [
    rec('procurement', 'pr', 0, 'approved', { scope: 'cw', delivery: 'outsourced', pr_no: 'PR-2026-014', pr_date: '2026-09-02', contractor: 'cw_one', team: 'cw_team_1', order_status: 'open', source_task_id: task(0, 4), source_task_code: 'B1' }),
    rec('procurement', 'po', 1, 'in_review', { scope: 'cw', delivery: 'outsourced', pr_no: 'PR-2026-015', pr_date: '2026-09-05', po_wo_no: 'PO-2026-031', po_wo_date: '2026-09-12', order_status: 'issued' }),
    rec('procurement', 'wo', 2, 'entry', { scope: 'site_adaption', delivery: 'in_house', po_wo_no: 'WO-2026-007', po_wo_date: '2026-09-20', order_status: 'open' }),
    rec('procurement', 'pr', 3, 'in_approval', { scope: 'tower_erection', delivery: 'outsourced', pr_no: 'PR-2026-019', pr_date: '2026-09-18', order_status: 'open' }),
    rec('gecol', null, 0, 'approved', { pr_no: 'GPR-2026-002', pr_date: '2026-08-10', survey_date: '2026-08-20', notice_date: '2026-09-01', install_finish: '2026-09-25', meter_no: 'M-77120', power_on: '2026-10-02', source_task_id: task(0, 13), source_task_code: 'C2' }),
    rec('gecol', null, 4, 'entry', { survey_date: '2026-10-01', notice_date: '2026-10-08' }),
    rec('hlc', null, 1, 'in_review', { request_no: 'HLC-2026-044', request_date: '2026-09-10', fiber_uplink: 'Exchange Ain Zara', fiber_status: 'in_progress', fiber_team: 'hlc_team_1', install_date: '2026-10-05' }),
    rec('hlc', null, 5, 'approved', { request_no: 'HLC-2026-031', request_date: '2026-08-14', fiber_status: 'installed', install_date: '2026-09-02', tx_tested_date: '2026-09-09' }),
    rec('permits_hse', null, 0, 'approved', { type: 'access_cw', applied_date: '2026-09-01', status: 'approved', valid_from: '2026-09-10', has_expiry: true, valid_to: '2027-03-10' }),
    rec('permits_hse', null, 2, 'entry', { type: 'ptw_cw', applied_date: '2026-10-10', status: 'applied', has_expiry: true, jsa_tra: 'yes', stop_work: false }),
    rec('permits_hse', null, 3, 'approved', { type: 'caa', applied_date: '2026-08-01', status: 'approved', valid_from: '2026-08-15', has_expiry: false }),
  ];
  return { records, batches: [] as MockBatch[], seq: 100 };
}
