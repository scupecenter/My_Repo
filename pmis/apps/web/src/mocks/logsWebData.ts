// Synthetic data for the logs and monitoring screens. Fictional people, devices and addresses only.
import type { ActivityReport, AdminSession, AuditRow, Deployment, DeviceInfo, FieldChange, JobRun, SecurityAlert, Via } from '@/api/logs';
import { byId, uid } from './ids';
import { siteIdOf, siteMeta, taskIdOf } from './sites';

const BASE = Date.parse('2026-11-01T12:00:00Z');
const USERS = ['1001', '1102', '1204', '1103', '1211'];
const ref = (e: string) => ({ id: uid(e), display_name: byId(e).name_en, employee_id: e });
const actor = (e: string) => ({ id: uid(e), name: byId(e).name_en, employee_id: e });

export const DEVICES: DeviceInfo[] = [
  { browser: 'Chrome 131', os: 'Windows 11', type: 'desktop' }, { browser: 'Safari 18', os: 'iOS 18', type: 'mobile' }, { browser: 'Edge 130', os: 'Windows 10', type: 'desktop' },
  { browser: 'Firefox 132', os: 'Ubuntu 24.04', type: 'desktop' }, { browser: 'Chrome 131', os: 'Android 15', type: 'mobile' }, { browser: 'Safari 18', os: 'iPadOS 18', type: 'tablet' },
];
const SERVER: DeviceInfo = { browser: 'PMIS-API', os: 'server', type: 'other' };
const SCHED: DeviceInfo = { browser: 'scheduler', os: 'server', type: 'other' };
const VIA_SEQ: Via[] = ['manual', 'manual', 'template', 'manual', 'bulk', 'api', 'job'];
const SITES = [3, 5, 8, 12];
const SESSION = (i: number) => `90000000-0000-4000-8000-${String(1000 + (i % 9)).padStart(12, '0')}`;

/** Power-On date of one register record, the example question of the screen: who changed it, from what to what, when, from which device. */
export const POWER_ON_RECORD = 'a0000000-0000-4000-8000-000000000501';
export const FIRST_TASK = '10000000-0000-4000-8000-000000000001';

const FIELDS: [string, string, string, string][] = [
  ['planned_date', 'Planned date', 'التاريخ المخطط', 'task'], ['actual_date', 'Actual date', 'التاريخ الفعلي', 'task'], ['power_on_date', 'Power-On date', 'تاريخ التشغيل الكهربائي', 'register_record'],
  ['remark', 'Remark', 'ملاحظة', 'register_record'], ['permit_status', 'Permit status', 'حالة التصريح', 'register_record'],
];
const dayOf = (n: number) => new Date(Date.parse('2026-09-01T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

export function buildFieldChanges(): FieldChange[] {
  const out: FieldChange[] = [];
  const add = (i: number, o: Partial<FieldChange> & Pick<FieldChange, 'field' | 'entity_type' | 'entity_id' | 'old_value' | 'new_value'>, siteIdx: number, emp = USERS[i % 5]) => {
    const via = o.via ?? VIA_SEQ[i % 7];
    const m = siteMeta(siteIdx), f = FIELDS.find((x) => x[0] === o.field)!;
    out.push({
      id: `fc-${String(i).padStart(3, '0')}`, audit_id: 1800 - i, at: new Date(BASE - i * 7.3 * 3600e3).toISOString(), actor: via === 'job' ? { id: uid('0000'), name: 'Scheduler', employee_id: null } : actor(emp), on_behalf_of: i % 11 === 4 ? actor('1001') : null,
      entity_label: o.entity_type === 'task' ? `${m.code} · ${o.field}` : `${m.code} · Power`, site_id: siteIdOf(siteIdx), site_code: m.code, region_id: m.region_id,
      field_label_en: f[1], field_label_ar: f[2], via, batch_id: via === 'bulk' || via === 'template' ? `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}` : null,
      ip: via === 'job' ? null : via === 'api' ? '10.20.9.5' : `10.20.${1 + (i % 3)}.${20 + (i % 40)}`, device: via === 'api' ? SERVER : via === 'job' ? SCHED : DEVICES[i % 6],
      user_agent: 'Mozilla/5.0 (synthetic)', session_id: SESSION(i), auth_method: i % 4 === 0 ? 'local' : 'oidc', mfa: i % 5 !== 0, reason: i % 3 === 0 ? 'Corrected after the site visit' : null, ...o,
    });
  };
  // the Power-On example: three changes to one record, three people, three devices
  add(0, { entity_type: 'register_record', entity_id: POWER_ON_RECORD, field: 'power_on_date', old_value: null, new_value: '2026-10-20', via: 'manual', at: new Date(BASE - 300 * 3600e3).toISOString() }, 5, '1204');
  add(1, { entity_type: 'register_record', entity_id: POWER_ON_RECORD, field: 'power_on_date', old_value: '2026-10-20', new_value: '2026-10-27', via: 'template', at: new Date(BASE - 200 * 3600e3).toISOString() }, 5, '1102');
  add(2, { entity_type: 'register_record', entity_id: POWER_ON_RECORD, field: 'power_on_date', old_value: '2026-10-27', new_value: '2026-11-03', via: 'manual', at: new Date(BASE - 100 * 3600e3).toISOString() }, 5, '1001');
  // the first task of the mock task list
  add(3, { entity_type: 'task', entity_id: FIRST_TASK, field: 'planned_date', old_value: '2026-10-10', new_value: '2026-10-14', via: 'manual', at: new Date(BASE - 400 * 3600e3).toISOString() }, 0, '1204');
  add(4, { entity_type: 'task', entity_id: FIRST_TASK, field: 'planned_date', old_value: '2026-10-14', new_value: '2026-10-21', via: 'manual', at: new Date(BASE - 150 * 3600e3).toISOString() }, 0, '1102');
  for (let i = 5; i < 64; i++) {
    const f = FIELDS[i % 5], s = SITES[i % 4], isTask = f[3] === 'task';
    add(i, {
      entity_type: f[3], entity_id: isTask ? taskIdOf(s, i % 6) : `a0000000-0000-4000-8000-${String(s * 100 + 10 + (i % 3)).padStart(12, '0')}`, field: f[0],
      old_value: f[0] === 'remark' ? 'Waiting for GECOL' : f[0] === 'permit_status' ? 'pending' : dayOf(i), new_value: f[0] === 'remark' ? 'GECOL visited' : f[0] === 'permit_status' ? 'approved' : dayOf(i + 6),
    }, s);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export function buildAudit(): AuditRow[] {
  const ACT: [string, string][] = [['task.update', 'task'], ['record.update', 'register_record'], ['task.approve', 'task'], ['task.reject', 'task'], ['settings.update', 'setting'], ['document.download', 'document'], ['export.create', 'export'], ['audit_log.read', 'audit_log']];
  const rows: AuditRow[] = [];
  for (let i = 0; i < 48; i++) {
    const [action, entity_type] = ACT[i % 8], s = SITES[i % 4], m = siteMeta(s), emp = USERS[i % 5], via = VIA_SEQ[i % 7];
    const isField = action === 'task.update' || action === 'record.update';
    rows.push({
      id: 1850 - i, at: new Date(BASE - i * 5.1 * 3600e3).toISOString(), actor: ref(emp), action, entity_type, entity_id: entity_type === 'task' ? taskIdOf(s, i % 6) : `a0000000-0000-4000-8000-${String(s * 100).padStart(12, '0')}`,
      site_id: entity_type === 'setting' || entity_type === 'audit_log' ? null : siteIdOf(s), site_code: entity_type === 'setting' || entity_type === 'audit_log' ? null : m.code, region_id: entity_type === 'setting' ? null : (m.region_id as AuditRow['region_id']),
      module_key: entity_type === 'task' ? 'sites' : entity_type === 'register_record' ? 'gecol' : null,
      before: isField ? { planned_date: dayOf(i), state: 'entry', remark: 'Waiting for GECOL' } : action === 'task.approve' ? { state: 'in_approval' } : action === 'settings.update' ? { 'work.weekend': 'fri,sat' } : null,
      after: isField ? { planned_date: dayOf(i + 5), state: 'entry', remark: 'Waiting for GECOL' } : action === 'task.approve' ? { state: 'approved', actual_date: dayOf(i) } : action === 'settings.update' ? { 'work.weekend': 'fri' } : null,
      reason: action === 'settings.update' ? 'Owner request' : action === 'task.reject' ? 'Document unreadable' : null, bulk_action_id: via === 'bulk' ? `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}` : null,
      batch_id: via === 'template' ? `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}` : null, is_admin_override: action === 'settings.update', privileged: action === 'settings.update' || i === 2,
      stepup_verified: action === 'settings.update' || i === 2, mfa: i % 5 !== 0, self_approval: i === 2, ip: via === 'api' ? '10.20.9.5' : `10.20.${1 + (i % 3)}.${20 + (i % 40)}`, request_id: `req-${2000 + i}`,
      via, device: via === 'api' ? SERVER : DEVICES[i % 6], user_agent: 'Mozilla/5.0 (synthetic)', session_id: SESSION(i), auth_method: i % 4 === 0 ? 'local' : 'oidc',
      ...(i % 11 === 4 ? { on_behalf_of: ref('1001'), on_behalf_kind: 'delegate' as AuditRow['on_behalf_kind'] } : {}),
    });
  }
  // the self-approval of the demo: Ahmed Salem approves his own submission (action task.approve, i = 2 above); make it unmistakable
  rows[2] = { ...rows[2], action: 'task.approve', entity_type: 'task', actor: ref('1001'), self_approval: true, before: { state: 'entry', submitted_by: '1001' }, after: { state: 'approved', approved_by: '1001' }, reason: 'Self-approval: L1 and L2 held by one person' };
  return rows;
}

export function buildSessions(): AdminSession[] {
  const ago = (m: number) => new Date(BASE - m * 60e3).toISOString();
  return [
    { session_id: SESSION(0), user: ref('1001'), started_at: ago(190), last_activity_at: ago(0), ip: '10.20.1.21', device: DEVICES[0], current_screen: '/admin/logs/online', auth_method: 'oidc', mfa: true },
    { session_id: SESSION(1), user: ref('1102'), started_at: ago(140), last_activity_at: ago(2), ip: '10.20.2.34', device: DEVICES[1], current_screen: '/approvals', auth_method: 'oidc', mfa: true },
    { session_id: SESSION(2), user: ref('1204'), started_at: ago(95), last_activity_at: ago(9), ip: '10.20.3.8', device: DEVICES[4], current_screen: '/sites/TR101', auth_method: 'local', mfa: false },
    { session_id: SESSION(3), user: ref('1103'), started_at: ago(60), last_activity_at: ago(1), ip: '10.20.1.77', device: DEVICES[3], current_screen: '/audit', auth_method: 'local', mfa: true },
    { session_id: SESSION(4), user: ref('1211'), started_at: ago(30), last_activity_at: ago(20), ip: '10.20.2.90', device: DEVICES[5], current_screen: '/registers/gecol', auth_method: 'oidc', mfa: true },
  ];
}

export function buildJobRuns(): JobRun[] {
  const NAMES = ['sla-recalc', 'notification-digest', 'backup-wal', 'audit-integrity-check', 'idle-task-alerts', 'export-cleanup'];
  return Array.from({ length: 30 }, (_, i) => {
    const started = BASE - i * 3.2 * 3600e3, failed = i === 4 || i === 17, running = i === 0;
    return { id: `job-${i + 1}`, name: NAMES[i % 6], started_at: new Date(started).toISOString(), finished_at: running ? null : new Date(started + (40 + i) * 1000).toISOString(), outcome: running ? 'running' : failed ? 'failed' : 'ok', rows: running ? null : 120 + i * 7, error: failed ? 'connection reset by peer' : null };
  });
}

export const buildDeployments = (): Deployment[] => Array.from({ length: 8 }, (_, i) => ({
  id: `dep-${8 - i}`, at: new Date(BASE - i * 6 * 86400e3).toISOString(), version: `0.${12 - i}.0`, git_sha: (`e17364${i}`.padEnd(40, 'f')).slice(0, 40), migrations: i % 3 === 0 ? [`0${60 - i}_logs_field_changes.sql`, `0${61 - i}_sessions_device.sql`] : [], by: i % 2 ? 'Ali Barka' : 'Ahmed Salem',
}));

export const buildAlerts = (): SecurityAlert[] => [
  { id: 'al-1', at: new Date(BASE - 1 * 3600e3).toISOString(), rule: 'repeated_failed_sign_in', severity: 'high', summary: '9 failed sign-ins from 10.20.2.90 in 10 minutes', detail: 'Identifiers: ?***#3f9c01d2ab47 (x7), 1211 (x2)', status: 'open', ack_by: null, ack_at: null },
  { id: 'al-2', at: new Date(BASE - 9 * 3600e3).toISOString(), rule: 'self_approval_burst', severity: 'medium', summary: 'Ahmed Salem self-approved 4 tasks today', detail: 'Tasks B2, B3, B4, B6 on TR108', status: 'open', ack_by: null, ack_at: null },
  { id: 'al-3', at: new Date(BASE - 30 * 3600e3).toISOString(), rule: 'off_hours_admin_override', severity: 'medium', summary: 'Admin override at 02:14 local time', detail: null, status: 'open', ack_by: null, ack_at: null },
  { id: 'al-4', at: new Date(BASE - 80 * 3600e3).toISOString(), rule: 'retention_reduced', severity: 'critical', summary: 'System log retention reduced from 365 to 120 days', detail: null, status: 'acknowledged', ack_by: 'Ali Barka', ack_at: new Date(BASE - 70 * 3600e3).toISOString() },
  { id: 'al-5', at: new Date(BASE - 120 * 3600e3).toISOString(), rule: 'audit_integrity_failure', severity: 'critical', summary: 'Security log chain break at #17 (test)', detail: 'hash_mismatch', status: 'acknowledged', ack_by: 'Ahmed Salem', ack_at: new Date(BASE - 119 * 3600e3).toISOString() },
];

export function buildReport(month: string): ActivityReport {
  const seed = Number(month.slice(5)) + Number(month.slice(2, 4));
  const users = USERS.map((e, i) => ({ user: ref(e), actions: 40 + ((seed * (i + 3)) % 90), field_changes: 20 + ((seed * (i + 5)) % 50), approvals: (seed * (i + 1)) % 25, sign_ins: 18 + ((seed + i) % 12), failed_sign_ins: i === 4 ? 9 : (seed + i) % 3 }));
  const at = (d: number, h: number) => `${month}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:10:00Z`;
  return {
    month, users,
    sensitive: [
      { at: at(3, 9), actor: ref('1001'), action: 'task.approve', entity_type: 'task', entity_label: 'TR108 · B3', summary: 'Self-approval (L1 and L2 held by one person)' },
      { at: at(7, 2), actor: ref('1001'), action: 'settings.update', entity_type: 'setting', entity_label: 'work.weekend', summary: 'Admin override: weekend days changed' },
      { at: at(12, 14), actor: ref('1103'), action: 'session.end', entity_type: 'session', entity_label: 'Sami Nuri', summary: 'Session ended by an admin' },
      { at: at(18, 11), actor: ref('1102'), action: 'export.create', entity_type: 'export', entity_label: 'Master export', summary: 'Full Master export' },
    ],
  };
}
