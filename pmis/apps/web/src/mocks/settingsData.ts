// Synthetic state for phase 3b: calendar, rules, freeze, DLP, notification policy, retention, sessions, security log.
import type { ActiveSession, DlpSettings, IdleTaskAlertSetting, LogRetention, NotificationPolicy, NotificationTypeDef, SecurityLogEntry, SlaRule, StaffVisibility, WeightSet } from '@/api/types';
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
  };
}
export type CfgDb = ReturnType<typeof initCfg>;

const w = (code: string, name_en: string, weight: number, items: { code: string; name_en: string; weight: number }[] = []) => ({ code, name_en, weight, items });
export const WEIGHTS: WeightSet[] = [{
  id: '98000000-0000-4000-8000-000000000001', code: 'project_status', version: 3, status: 'published', effective_from: '2026-09-01', reason: 'Seed',
  activities: [w('a1', 'Site Release', 12, [{ code: 'a1_1', name_en: 'TSSR', weight: 60 }, { code: 'a1_2', name_en: 'LLD', weight: 40 }]), w('a2', 'PRE-CW', 8, [{ code: 'a2_1', name_en: 'Access', weight: 100 }]), w('a3', 'CW', 5, [{ code: 'a3_1', name_en: 'Civil works', weight: 100 }]),
    w('a4', 'Site RFI', 25), w('a5', 'TE', 20), w('a6', 'On-Air', 12), w('a7', 'TE PAC', 13), w('a8', 'KPI', 5)],
} as WeightSet, {
  id: '98000000-0000-4000-8000-000000000002', code: 'health_index', version: 1, status: 'draft', effective_from: '2026-11-01', reason: 'Draft for review',
  activities: [w('h1', 'Schedule', 50, [{ code: 'h1_1', name_en: 'On time', weight: 70 }, { code: 'h1_2', name_en: 'Late', weight: 20 }]), w('h2', 'Quality', 40)],
} as WeightSet];

export const SLA: SlaRule[] = [
  { id: '99000000-0000-4000-8000-000000000001', task_code: 'A2', min_working_days: 3, max_working_days: 5, start_event: 'site_release', calendar_code: 'LY', effective_from: '2026-01-01', reason: 'Seed', changed_at: '2026-01-01T08:00:00Z', open_task_count: 14 },
  { id: '99000000-0000-4000-8000-000000000002', task_code: 'D14', min_working_days: 2, max_working_days: 4, start_event: 'te_install', calendar_code: 'LY', effective_from: '2026-01-01', reason: 'Seed', changed_at: '2026-01-01T08:00:00Z', open_task_count: 6 },
] as SlaRule[];
