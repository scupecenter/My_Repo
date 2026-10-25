import type { ApprovalItem, Me, Notification, Session, TaskDetail, TaskSummary } from '@/api/types';
import { STAFF, type StaffRow } from './staff';

export const uid = (employeeId: string) => `00000000-0000-4000-8000-00000000${employeeId.padStart(4, '0')}`;
export const staffRef = (s: StaffRow) => ({ id: uid(s.employee_id), display_name: s.name_en, employee_id: s.employee_id });
const byId = (id: string) => STAFF.find((s) => s.employee_id === id)!;

/** Accounts offered on the fake Microsoft page. `linked=false` = first sign-in (needs employee ID). */
export const ACCOUNTS: Record<string, { employee_id: string | null; name: string; email: string; status: 'active' | 'pending_assignment'; nav: string[] }> = {
  pm: { employee_id: '1001', name: 'Ahmed Salem', email: 'ahmed.salem@example.com', status: 'active', nav: ['my_work', 'approvals', 'sites', 'dashboard', 'templates', 'admin.users', 'admin.matrix', 'admin.settings', 'audit'] },
  reviewer: { employee_id: '1102', name: 'Mona Fathi', email: 'mona.fathi@example.com', status: 'active', nav: ['my_work', 'approvals', 'sites', 'templates'] },
  newbie: { employee_id: null, name: 'New Employee', email: 'new.employee@example.com', status: 'pending_assignment', nav: [] },
  pending: { employee_id: '1211', name: 'Wael Saadi', email: 'wael.saadi@example.com', status: 'pending_assignment', nav: [] },
};

type MockTask = TaskSummary & { submitted_by: string; waiting_since: string; level_kind: 'review' | 'approve'; docs: string[]; external: string; entered_by: string };

const mk = (n: number, site: string, region: number, code: string, name: string, kind: 'review' | 'approve', by: string, extra: Partial<TaskSummary> = {}, state?: TaskSummary['state']): MockTask => ({
  id: `10000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`,
  site_id: `20000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`,
  site_code: site, region_id: region, task_code: code, name_en: name, name_ar: null, stage_code: code.startsWith('D') ? 'te_pac' : 'site_release',
  state: state ?? (kind === 'review' ? 'in_review' : 'in_approval'), current_level: kind === 'review' ? 2 : 3, levels_required: 3,
  planned_date: '2026-10-14', actual_date: '2026-10-19', sla: { colour: 'green', min_wd: 3, max_wd: 5, elapsed_wd: 2, due_date: '2026-10-27' },
  slots_filled: 1, slots_required: 1, return_count: 0, ...extra, version: 1,
  submitted_by: by, waiting_since: `2026-10-${String(24 - (n % 6)).padStart(2, '0')}T08:30:00Z`, level_kind: kind, entered_by: by,
  docs: [`${code}_scan1.pdf`], external: 'A&T Global',
});

const fresh = () => ({
  tasks: [
    mk(1, 'WM105', 3, 'D14', 'PAT · NOC alarms', 'approve', '1204'),
    mk(2, 'GM117', 6, 'A2', 'TSSR approval', 'approve', '1102'),
    mk(3, 'MI129', 2, 'A3', 'Site acquisition · contract signed', 'approve', '1102'),
    mk(4, 'SB121', 7, 'D16', 'TE PAC', 'approve', '1205'),
    mk(5, 'GM131', 6, 'D16', 'TE PAC', 'approve', '1205'),
    mk(6, 'TR204', 1, 'B3', 'CW access permission', 'review', '1204'),
    mk(7, 'ZW310', 4, 'B6', 'Layout drawing', 'review', '1205', { last_return_note: 'Date before access permit' }),
  ] as MockTask[],
  /** Tasks the viewer submitted and is waiting on, and one overdue. */
  extra: [
    mk(8, 'BG220', 5, 'D5', 'Power-on test', 'approve', '1001', { sla: { colour: 'red', min_wd: 2, max_wd: 4, elapsed_wd: 6, due_date: '2026-10-20' } }, 'entry'),
  ] as MockTask[],
  notifications: [
    { id: '30000000-0000-4000-8000-000000000001', kind: 'approval_due', title: 'WM105 D14 waits for your approval', created_at: '2026-10-24T08:30:00Z', read_at: null, link: '/approvals' },
    { id: '30000000-0000-4000-8000-000000000002', kind: 'task_returned', title: 'ZW310 B6 was returned with a note', created_at: '2026-10-23T10:00:00Z', read_at: null, link: '/my-work' },
  ] as Notification[],
  session: null as null | { account: string; linked: boolean; stepupAt: number | null; employee_id?: string },
});

export type Db = ReturnType<typeof fresh>;
const KEY = 'pmis-mock-db';
let mem: Db = fresh();
const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

let lastRaw: string | null = null;
// Re-read only when another tab/reload changed storage, so objects held by a handler stay live until save().
export function db(): Db {
  const s = store()?.getItem(KEY) ?? null;
  if (s && s !== lastRaw) { mem = JSON.parse(s); lastRaw = s; }
  return mem;
}
export const save = () => { lastRaw = JSON.stringify(mem); store()?.setItem(KEY, lastRaw); };
export function resetDb() { mem = fresh(); lastRaw = null; store()?.removeItem(KEY); }

export const STEP_UP_SECONDS = 300;
export const stepUpValid = () => { const t = db().session?.stepupAt; return !!t && Date.now() - t < STEP_UP_SECONDS * 1000; };

export function viewer() {
  const s = db().session;
  return s ? { ...ACCOUNTS[s.account], employee_id: s.employee_id ?? ACCOUNTS[s.account].employee_id, key: s.account, linked: s.linked } : null;
}

export function sessionBody(): Session {
  const v = viewer();
  if (!v) return { authenticated: false, csrf_token: 'csrf-anon' };
  const s = db().session!;
  return {
    authenticated: true, csrf_token: 'csrf-mock', needs_employee_id: !s.linked, status: s.linked ? v.status : 'pending_assignment',
    user: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: s.linked ? v.employee_id : null },
    mfa: true, stepup_valid_until: stepUpValid() ? new Date(s.stepupAt! + STEP_UP_SECONDS * 1000).toISOString() : null,
    expires_at: new Date(Date.now() + 8 * 3600e3).toISOString(),
  };
}

export function meBody(): Me {
  const v = viewer()!;
  return {
    user: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id, email: v.email, status: v.status, locale: 'en', theme: 'light' },
    assignments: [], is_system_admin: v.key === 'pm',
    effective: { grants: v.nav.map((m) => ({ module_key: m, action: 'view', region_ids: 'all' as const })), nav: v.nav },
  };
}

/** Level the viewer may act at. PM does both, reviewer only review. */
export const canAct = (kind: 'review' | 'approve') => { const v = viewer(); return !!v && (v.key === 'pm' || (v.key === 'reviewer' && kind === 'review')); };

const inbox = (t: MockTask) => t.state === 'in_review' || t.state === 'in_approval';
export const approvalsFor = () => db().tasks.filter((t) => inbox(t) && canAct(t.level_kind));

export function toSummary(t: MockTask): TaskSummary {
  const { submitted_by: _s, waiting_since: _w, level_kind: _l, docs: _d, external: _e, entered_by: _b, ...rest } = t;
  void [_s, _w, _l, _d, _e, _b];
  return { ...rest, ball_in_court: { level: t.current_level ?? 1, level_kind: t.level_kind, holders: [{ kind: 'role', ref_id: uid('0001'), label: t.level_kind === 'approve' ? 'Project Manager' : 'Team Lead' }] } };
}

export function toApproval(t: MockTask): ApprovalItem {
  return { task: toSummary(t), level_kind: t.level_kind, waiting_since: t.waiting_since, submitted_by: staffRef(byId(t.submitted_by)) };
}

export function toDetail(t: MockTask): TaskDetail {
  return {
    ...toSummary(t),
    approval_path: [
      { level: 1, kind: 'entry', status: 'done', acted_by: staffRef(byId(t.entered_by)), acted_at: '2026-10-20T09:00:00Z' },
      { level: 2, kind: 'review', status: t.level_kind === 'review' && inbox(t) ? 'current' : 'done' },
      { level: 3, kind: 'approve', status: t.state === 'approved' ? 'done' : t.level_kind === 'approve' && inbox(t) ? 'current' : 'pending' },
    ],
    slots: t.docs.map((d, i) => ({ id: `40000000-0000-4000-8000-00000000000${i}`, doc_code: t.task_code, name_en: d, status: 'in_review', mandatory: true, files: [] })),
    allowed_actions: inbox(t) && canAct(t.level_kind)
      ? [{ action: t.level_kind === 'approve' ? 'approve' : 'review', step_up: t.level_kind === 'approve' }, { action: 'reject' }] : [],
  } as TaskDetail;
}

export { STAFF, byId };
export type { MockTask };
