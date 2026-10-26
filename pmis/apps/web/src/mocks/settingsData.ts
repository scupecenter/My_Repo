// Synthetic state for phase 3b: calendar, rules, freeze, DLP, notification policy, retention, sessions, security log.
import type { ActiveSession, DlpSettings, IdleTaskAlertSetting, LogRetention, NotificationPolicy, NotificationTypeDef, SecurityLogEntry, SlaRuleSet, SlaTaskRule, StaffVisibility, TaskDefinition, WeightSet, WorkflowGate, WorkflowMilestone } from '@/api/types';
import { HOLIDAYS } from './holidaysSeed';
import { byId, uid } from './ids';

const ref = (e: string) => ({ id: uid(e), display_name: byId(e).name_en, employee_id: e });
const at = (h: number, m = 0, d = 25) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

type Def = [NotificationTypeDef['code'], NotificationTypeDef['category'], string, string, boolean, boolean];
const DEFS: Def[] = [
  ['task_submitted_review', 'approvals', 'Task waits for review', 'مهمة بانتظار المراجعة', false, false], ['task_submitted_approval', 'approvals', 'Task waits for approval', 'مهمة بانتظار الاعتماد', false, false],
  ['approval_overdue_reminder', 'approvals', 'Approval reminder', 'تذكير بالاعتماد', false, false], ['approval_overdue_escalation', 'approvals', 'Approval escalation', 'تصعيد الاعتماد', false, false],
  ['no_holder', 'approvals', 'Level has no holder', 'مستوى بلا مسؤول', true, false], ['task_rejected', 'tasks', 'Task rejected', 'مهمة مرفوضة', false, false],
  ['holder_deactivated', 'tasks', 'Holder deactivated', 'حساب المسؤول معطل', false, false], ['sla_near_max', 'sla', 'SLA near maximum', 'اقتراب حد SLA', false, false],
  ['holiday_tentative_reminder', 'system', 'Tentative holiday reminder', 'تذكير بعطلة مبدئية', false, true], ['structural_freeze_lifted', 'system', 'Structural freeze lifted', 'رفع تجميد التغيير', false, true],
  ['repeated_failed_sign_in', 'security', 'Repeated failed sign-in', 'محاولات دخول فاشلة', false, true], ['audit_integrity_failure', 'security', 'Audit integrity failure', 'فشل سلامة السجل', true, true],
  ['retention_reduced', 'security', 'Retention reduced', 'تقليص مدة الاحتفاظ', true, true],
];
export const CATALOGUE: NotificationTypeDef[] = DEFS.map(([code, category, label_en, label_ar, mandatory, admins]) => ({
  code, category, label_en, label_ar, kind: 'system', default_recipients: [admins ? 'system_admins' : 'holder'], eligible_roles: admins ? [] : 'all', system_admins_only: admins, mandatory: mandatory || category === 'security', immediate: mandatory,
  default_channels: { in_app: true, email: mandatory || category === 'approvals' },
}));
export const COLUMNS = [
  { kind: 'role' as const, id: '91000000-0000-4000-8000-000000000001', name: 'Project Manager' }, { kind: 'role' as const, id: '91000000-0000-4000-8000-000000000002', name: 'CW Team Lead' },
  { kind: 'group' as const, id: '92000000-0000-4000-8000-000000000001', name: 'System Admins' },
];

const EVENTS = ['sign_in_started', 'sign_in_succeeded', 'sign_in_failed', 'step_up_passed', 'signed_out', 'session_revoked_by_admin', 'callback_account_mismatch'] as const;
export const SEC_LOG: SecurityLogEntry[] = Array.from({ length: 36 }, (_, i) => {
  const ev = EVENTS[i % EVENTS.length], emp = ['1001', '1102', '1204', '1305'][i % 4], unknown = ev === 'sign_in_failed' && i % 2 === 0;
  return {
    id: 36 - i, at: at(7 + Math.floor((36 - i) / 4), (i * 7) % 60, 25 - Math.floor(i / 18)), event: ev, outcome: ev === 'sign_in_failed' || ev === 'callback_account_mismatch' ? 'failure' : ev === 'session_revoked_by_admin' ? 'info' : 'success',
    user: unknown ? null : ref(emp), actor: ev === 'session_revoked_by_admin' ? ref('1001') : null, identifier_masked: unknown ? `?a***#3f9c01d2ab${String(40 + (i % 3))}` : null,
    client_type: 'web', ip: `10.20.${i % 8}.${10 + i}`, user_agent: 'Chromium', session_id: null, request_id: `req-${1000 + i}`, details: null,
  } as SecurityLogEntry;
});

export function initCfg() {
  return {
    holidays: HOLIDAYS.map((h) => ({ ...h })), weekend: { days: [5, 6], version: 1 },
    freeze: { active: true, starts_on: '2026-11-01', ends_on: '2027-01-31', lifted: false, lifted_at: null, lifted_by: null, lift_reason: null, blocked_operations: ['publishWorkflowVersion'], version: 1 },
    dlp: { current: { version: 2, cw_months: 3, te_months: 12, effective_from: '2026-09-01', reason: 'Contract terms', changed_by: ref('1001'), changed_at: '2026-09-01T08:00:00Z' }, history: [
      { version: 2, cw_months: 3, te_months: 12, effective_from: '2026-09-01', reason: 'Contract terms', changed_by: ref('1001'), changed_at: '2026-09-01T08:00:00Z' },
      { version: 1, cw_months: 3, te_months: 12, effective_from: '2026-01-01', reason: 'Seed', changed_by: ref('1001'), changed_at: '2026-01-01T08:00:00Z' }] } as DlpSettings,
    idle: { enabled: true, working_days: 2, version: 1 } as IdleTaskAlertSetting,
    policy: {
      enabled: true, timezone: 'Africa/Tripoli', digest_hour: 8, work_days_follow_calendar: true, work_days: [0, 1, 2, 3, 4],
      thresholds: { approval_remind_hours: 48, approval_escalate_days: 5, sla_warning_days_before_max: 2, rate_cap_per_hour: 50, retention_days: 180 }, columns: COLUMNS,
      matrix: CATALOGUE.map((c) => ({ type_code: c.code, channels: { ...c.default_channels }, cells: c.system_admins_only ? [{ kind: 'group' as const, id: COLUMNS[2].id, on: true }] : COLUMNS.slice(0, 2).map((x) => ({ kind: x.kind, id: x.id, on: true })) })),
      version: 1,
    } as NotificationPolicy,
    retention: { system_log_days: 365, security_log_days: 730, audit_log_years: 10, version: 1 } as LogRetention,
    visibility: { fields: { email: { default_visible: true, allow: [], deny: [] }, phone: { default_visible: true, allow: [], deny: [] } }, version: 1 } as StaffVisibility,
    hidden: {} as Record<string, string[]>,
    sessions: [
      { id: '97000000-0000-4000-8000-000000000001', emp: '1001', idleMin: 0, screen: '/admin/online', client: 'web', current: true },
      { id: '97000000-0000-4000-8000-000000000002', emp: '1102', idleMin: 1, screen: '/approvals', client: 'web' },
      { id: '97000000-0000-4000-8000-000000000003', emp: '1102', idleMin: 42, screen: '/sites', client: 'mobile' },
      { id: '97000000-0000-4000-8000-000000000004', emp: '1204', idleMin: 12, screen: '/my-work', client: 'web' },
    ] as { id: string; emp: string; idleMin: number; screen: string; client: ActiveSession['client_type']; current?: boolean }[],
    jobs: {} as Record<string, { polls: number }>,
    secLogReads: 0,
    tampered: false,
    actingDelegate: false,
    slaSets: initSla(),
    weightSets: initWeights(),
  };
}
export type CfgDb = ReturnType<typeof initCfg>;

// ---- workflow catalogue for the SLA start-event picker (milestones, gates, tasks of the version in force)
const MS: [string, string, string][] = [
  ['site_release', 'Site Release', 'إطلاق الموقع'], ['pre_cw', 'PRE-CW Completion', 'اكتمال ما قبل الأعمال المدنية'], ['cw', 'CW Completion', 'اكتمال الأعمال المدنية'], ['site_rfi', 'Site RFI', 'جاهزية الموقع'],
  ['te_installation', 'TE Completion', 'اكتمال تركيب TE'], ['on_air', 'On-Air', 'البث'], ['te_pac', 'TE PAC', 'قبول TE المبدئي'], ['kpi_acceptance', 'KPI Acceptance', 'قبول مؤشرات الأداء'], ['hoto', 'HOTO', 'التسليم'], ['final_closure', 'Final Closure', 'الإغلاق النهائي'],
];
export const MILESTONES: WorkflowMilestone[] = MS.map(([code, name_en, name_ar], i) => ({ code, seq: i + 1, canonical_seq: i + 1, name_en, name_ar, formula_kind: 'master', counts_in_project_status: i < 8, master_export_column: null }));
export const GATES: WorkflowGate[] = MS.slice(1).map(([code, name_en, name_ar], i) => ({ code: `gate_${MS[i][0]}_${code}`, from_milestone: MS[i][0], to_milestone: code, name_en: `Gate: ${MS[i][1]} to ${name_en}`, name_ar: `بوابة: ${MS[i][2]} إلى ${name_ar}`, conditions: [{ type: 'milestone', ref: MS[i][0] }] }));
const TD: [string, string, string, string][] = [
  ['A1', 'SAR (each candidate)', 'تقرير مسح الموقع', 'site_release'], ['A2', 'TSSR', 'TSSR', 'site_release'], ['A3', 'Owner contract', 'عقد المالك', 'site_release'], ['A4', 'LLD', 'LLD', 'site_release'],
  ['B3', 'CW access permission', 'تصريح دخول الأعمال المدنية', 'pre_cw'], ['B6', 'Layout drawing', 'مخطط التخطيط', 'pre_cw'], ['D1', 'TE Access', 'وصول TE', 'site_rfi'], ['D5', 'Power-on test', 'اختبار التشغيل', 'te_installation'],
  ['D14', 'Antenna installation', 'تركيب الهوائي', 'te_installation'], ['D16', 'TE PAC', 'قبول TE المبدئي', 'te_pac'],
];
export const TASK_DEFS: TaskDefinition[] = TD.map(([code, name_en, name_ar, stage_code], i) => ({ id: `9b000000-0000-4000-8000-0000000000${String(i + 10)}`, code, name_en, name_ar, stage_code, sort_order: i + 1, predecessors: [], is_active: true, version: 1 }));
export const START_EVENT_CODES = new Set([...MILESTONES.map((m) => m.code), ...GATES.map((g) => g.code), ...TASK_DEFS.map((t) => t.code)]);
export const CALENDAR_CODES = ['LY'];
export const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
/** Open (not approved) tasks per task code, used by the SLA preview. */
export const OPEN_TASKS: Record<string, number> = { A2: 14, A4: 9, B3: 11, D1: 7, D5: 5, D14: 6 };

// ---- SLA rule sets: version 1 (seed, closed) and version 2 (in force). `_rev` is the ETag.
export type SlaSetRec = SlaRuleSet & { _rev: number };
const rule = (task_code: string, min: number, max: number, start_event: string, overrides: SlaTaskRule['overrides'] = []): SlaTaskRule => ({ task_code, min_working_days: min, max_working_days: max, start_event, calendar_code: 'LY', overrides });
const SEED_RULES = (): SlaTaskRule[] => [rule('A2', 3, 5, 'site_release'), rule('A4', 2, 4, 'site_release'), rule('B3', 2, 3, 'pre_cw'), rule('D1', 1, 3, 'site_rfi'), rule('D5', 2, 4, 'te_installation'), rule('D14', 2, 4, 'te_installation')];
function initSla(): SlaSetRec[] {
  const v2 = SEED_RULES(); v2[5] = rule('D14', 2, 4, 'te_installation', [{ scenario: 'hot_swap', min_working_days: 1, max_working_days: 2 }]);
  return [
    { id: '99000000-0000-4000-8000-000000000002', version: 2, status: 'published', is_active: true, effective_from: '2026-09-01', effective_to: null, base_version: 1, reason: 'Hot Swap is faster on D14', created_by: ref('1001'), created_at: '2026-08-30T08:00:00Z', published_by: ref('1001'), published_at: '2026-08-30T09:00:00Z', apply_to_open_tasks: false, affected_open_tasks: 0, rule_count: v2.length, rules: v2, _rev: 1 },
    { id: '99000000-0000-4000-8000-000000000001', version: 1, status: 'published', is_active: false, effective_from: '2026-01-01', effective_to: '2026-09-01', base_version: null, reason: 'Seed', created_by: ref('1001'), created_at: '2026-01-01T08:00:00Z', published_by: ref('1001'), published_at: '2026-01-01T08:00:00Z', apply_to_open_tasks: false, affected_open_tasks: 0, rule_count: 6, rules: SEED_RULES(), _rev: 1 },
  ];
}

// ---- weight sets
const w = (code: string, name_en: string, name_ar: string, weight: number, items: { code: string; name_en: string; name_ar?: string; weight: number; unit?: string; measure_rule?: string }[] = []) => ({ code, name_en, name_ar, weight, items });
export type WeightRec = WeightSet & { _rev: number };
const PS = (a: number[]) => [
  w('a1', 'Site Release', 'إطلاق الموقع', a[0], [{ code: 'a1_1', name_en: 'TSSR', name_ar: 'TSSR', weight: 60, unit: 'site', measure_rule: 'Approved TSSR counts 1' }, { code: 'a1_2', name_en: 'LLD', name_ar: 'LLD', weight: 40, unit: 'site', measure_rule: 'Approved LLD counts 1' }]),
  w('a2', 'PRE-CW', 'ما قبل الأعمال المدنية', a[1], [{ code: 'a2_1', name_en: 'Access', name_ar: 'الوصول', weight: 100, unit: 'site', measure_rule: 'Access permission approved' }]),
  w('a3', 'CW', 'الأعمال المدنية', a[2], [{ code: 'a3_1', name_en: 'Civil works', name_ar: 'الأعمال المدنية', weight: 100, unit: '%', measure_rule: 'Contractor progress, approved weekly' }]),
  w('a4', 'Site RFI', 'جاهزية الموقع', a[3]), w('a5', 'TE', 'تركيب TE', a[4]), w('a6', 'On-Air', 'البث', a[5]), w('a7', 'TE PAC', 'قبول TE', a[6]), w('a8', 'KPI', 'مؤشرات الأداء', a[7]),
];
function initWeights(): WeightRec[] {
  const base = { reason: 'Seed', changed_by: ref('1001'), created_at: '2026-01-01T08:00:00Z', published_at: '2026-01-01T08:00:00Z', _rev: 1 };
  return [
    { ...base, id: '98000000-0000-4000-8000-000000000001', code: 'project_status', version: 3, status: 'published', is_active: true, effective_from: '2026-09-01', effective_to: null, reason: 'Re-weight CW and TE', activities: PS([12, 8, 5, 25, 20, 12, 13, 5]) },
    { ...base, id: '98000000-0000-4000-8000-000000000003', code: 'project_status', version: 2, status: 'published', is_active: false, effective_from: '2026-03-01', effective_to: '2026-09-01', activities: PS([10, 10, 10, 20, 20, 10, 15, 5]) },
    { ...base, id: '98000000-0000-4000-8000-000000000004', code: 'project_status', version: 1, status: 'published', is_active: false, effective_from: '2026-01-01', effective_to: '2026-03-01', activities: PS([12, 8, 5, 25, 20, 12, 13, 5]) },
    {
      ...base, id: '98000000-0000-4000-8000-000000000002', code: 'health_index', version: 1, status: 'draft', is_active: false, effective_from: '2026-11-01', reason: 'Draft for review', published_at: null,
      activities: [w('h1', 'Schedule', 'الجدول', 50, [{ code: 'h1_1', name_en: 'On time', weight: 70 }, { code: 'h1_2', name_en: 'Late', weight: 20 }]), w('h2', 'Quality', 'الجودة', 40)],
    },
  ] as WeightRec[];
}
