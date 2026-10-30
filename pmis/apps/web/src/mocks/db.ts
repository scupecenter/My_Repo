import type { ApprovalItem, BallInCourt, Comment, DocumentSlot, Matrix, Me, Notification, Session, TaskDetail, TaskSummary, UserRef, WorkflowStep } from '@/api/types';
import { initAdmin } from './adminData';
import { initCfg } from './settingsData';
import { initOrg } from './orgData';
import { byId, staffRef, uid } from './ids';
import { holdersOf, initialMatrix } from './matrixData';
import { initRegisters } from './registersData';
import { STAFF } from './staff';
import { HYBRID } from '@/lib/hybrid';

export { staffRef, uid };

/** Accounts offered on the fake Microsoft page. `linked=false` = first sign-in (needs employee ID). */
export const ACCOUNTS: Record<string, { employee_id: string | null; name: string; email: string; status: 'active' | 'pending_assignment'; nav: string[] }> = {
  pm: { employee_id: '1001', name: 'Ahmed Salem', email: 'ahmed.salem@example.com', status: 'active', nav: ['my_work', 'approvals', 'sites', 'dashboard', 'templates', 'admin.users', 'admin.roles', 'admin.groups', 'admin.delegation', 'absence', 'admin.matrix', 'admin.settings', 'admin.security_log', 'audit', 'messages', 'announcements', 'procurement', 'gecol', 'hlc', 'permits_hse'] },
  reviewer: { employee_id: '1102', name: 'Mona Fathi', email: 'mona.fathi@example.com', status: 'active', nav: ['my_work', 'approvals', 'sites', 'templates', 'absence', 'messages', 'procurement', 'gecol', 'hlc', 'permits_hse'] },
  auditor: { employee_id: '1103', name: 'Ali Barka', email: 'ali.barka@example.com', status: 'active', nav: ['my_work', 'approvals', 'admin.security_log', 'messages'] },
  newbie: { employee_id: null, name: 'New Employee', email: 'new.employee@example.com', status: 'pending_assignment', nav: [] },
  engineer: { employee_id: '1204', name: 'Sami Nuri', email: 'sami.nuri@example.com', status: 'active', nav: ['my_work', 'approvals', 'sites', 'absence', 'messages'] },
  pending: { employee_id: '1211', name: 'Wael Saadi', email: 'wael.saadi@example.com', status: 'pending_assignment', nav: [] },
};

/** Demo passwords for the synthetic accounts (README). Local sign-in only; never real secrets. */
export const DEMO_PASSWORDS: Record<string, string> = {
  pm: 'Demo-Pm-2026-pass', engineer: 'Demo-Staff-2026-pass', reviewer: 'Demo-Lead-2026-pass', auditor: 'Demo-Audit-2026-pass', pending: 'Demo-Pending-2026-pass', newbie: 'Demo-First-2026-pass',
};
/** First sign-in demo account: its temporary password must be changed (and it then asks for the employee ID). */
const MUST_CHANGE_DEMO = new Set(['newbie']);

export type Cred = { password: string; must_change: boolean; failures: number; locked_until: number | null; enabled: boolean };
/** Credentials of an account key ('pm', ..., 'u:<uuid>' for created users, 'e:<id>' for registry staff after a reset). Demo accounts are seeded on first use. */
export function cred(key: string, create = false): Cred | null {
  const d = db();
  d.auth ??= {};
  if (!d.auth[key] && key in DEMO_PASSWORDS) d.auth[key] = { password: DEMO_PASSWORDS[key], must_change: MUST_CHANGE_DEMO.has(key), failures: 0, locked_until: null, enabled: true };
  if (!d.auth[key] && create) d.auth[key] = { password: '', must_change: true, failures: 0, locked_until: null, enabled: true };
  return d.auth[key] ?? null;
}
/** Sign-in attempt times, kept in memory only: 10 per minute answer 429 (the IP limit of ADR 0012). */
export const attempts: number[] = [];

type MockTask = TaskSummary & {
  submitted_by: string; waiting_since: string; level_kind: 'review' | 'approve'; docs: string[]; external: string; entered_by: string;
  /** Generated site-grid tasks (mocks/sites.ts) carry their own slots, steps and comments once touched. */
  claimed_by?: UserRef; actual_start?: string | null;
  gen?: boolean; slots?: DocumentSlot[]; steps?: WorkflowStep[]; comments?: Comment[]; locks?: { kind: 'predecessor_not_approved' | 'gate_closed'; message: string; ref_code?: string }[];
};

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
    mk(8, 'BG220', 5, 'D5', 'Power-on test', 'approve', '1001', { sla: { colour: 'red', min_wd: 2, max_wd: 4, elapsed_wd: 6, due_date: '2026-10-20' }, idle_working_days: 3 }, 'entry'),
  ] as MockTask[],
  /** Generated site tasks changed by the user (full copies, keyed by task id). */
  ov: {} as Record<string, MockTask>,
  matrix: initialMatrix() as Matrix,
  reg: initRegisters(),
  notifications: [
    { id: '30000000-0000-4000-8000-000000000001', kind: 'approval_due', title: 'WM105 D14 waits for your approval', created_at: '2026-10-24T08:30:00Z', read_at: null, link: '/approvals' },
    { id: '30000000-0000-4000-8000-000000000002', kind: 'task_returned', title: 'ZW310 B6 was returned with a note', created_at: '2026-10-23T10:00:00Z', read_at: null, link: '/my-work' },
  ] as Notification[],
  admin: initAdmin(),
  org: initOrg(),
  cfg: initCfg(),
  session: null as null | { account: string; linked: boolean; stepupAt: number | null; employee_id?: string; method?: 'local' | 'm365' },
  auth: {} as Record<string, Cred>,
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
export function resetDb() { mem = fresh(); lastRaw = null; attempts.length = 0; store()?.removeItem(KEY); }

export const STEP_UP_SECONDS = 300;
export const stepUpValid = () => {
  if (HYBRID) return true; // hybrid: the real server decides for real endpoints; mocked ones must not loop
  const t = db().session?.stepupAt; return !!t && Date.now() - t < STEP_UP_SECONDS * 1000; };

/** Account key of an admin-list user: a demo account, a created local user, or a registry person. */
export function accountKeyOf(u: { employee_id: string; local?: { id: string } }) {
  if (u.local) return `u:${u.local.id}`;
  return Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].employee_id === u.employee_id) ?? `e:${u.employee_id}`;
}
/** Accounts that are not on the fake Microsoft page: created local users and registry staff with a reset password. */
function accountOf(key: string): (typeof ACCOUNTS)[string] | null {
  const u = db().admin.users.find((x) => accountKeyOf(x) === key);
  if (!u) return null;
  const s = STAFF.find((x) => x.employee_id === u.employee_id);
  return { employee_id: u.employee_id || null, name: u.local?.display_name ?? s?.name_en ?? '', email: u.local?.email ?? s?.email ?? '', status: u.status === 'active' ? 'active' : 'pending_assignment', nav: [] };
}

export function viewer() {
  const s = db().session;
  if (!s) return null;
  const a = ACCOUNTS[s.account] ?? accountOf(s.account);
  if (!a) return null;
  const employee_id = s.employee_id ?? a.employee_id;
  // An admin assignment (Users & Roles) activates a pending account and opens the basic navigation.
  const u = db().admin.users.find((x) => (x.local ? `u:${x.local.id}` === s.account : x.employee_id === employee_id));
  const active = s.linked && u?.status === 'active';
  return { ...a, employee_id, key: s.account, linked: s.linked, status: active ? ('active' as const) : a.status, nav: active && !a.nav.length ? ['my_work', 'approvals', 'sites', 'absence', 'messages'] : a.nav };
}

export function sessionBody(): Session {
  const v = viewer();
  if (!v) return { authenticated: false, csrf_token: 'csrf-anon' };
  const s = db().session!;
  return {
    authenticated: true, csrf_token: 'csrf-mock', auth_method: s.method ?? 'm365', must_change_password: !!cred(s.account)?.must_change && s.method === 'local', needs_employee_id: !s.linked, status: s.linked ? v.status : 'pending_assignment',
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
    effective: { grants: [...v.nav.map((m) => ({ module_key: m, action: 'view' as const, region_ids: 'all' as const })), ...(v.key === 'auditor' ? [{ module_key: 'admin.security_log', action: 'view_security_log' as const, region_ids: 'all' as const }] : [])], nav: v.nav },
  };
}

/** Level the viewer may act at. PM does both, reviewer only review. */
export const canAct = (kind: 'review' | 'approve') => { const v = viewer(); return !!v && (v.key === 'pm' || (v.key === 'reviewer' && kind === 'review')); };

export const inbox = (t: MockTask) => t.state === 'in_review' || t.state === 'in_approval';
export const approvalsFor = () => [...db().tasks, ...Object.values(db().ov)].filter((t) => inbox(t) && canAct(t.level_kind));

/** B14 badge: deleted accounts and deactivated (suspended or disabled) ones keep their tasks. */
export function accountStatus(emp: string): 'active' | 'deactivated' | 'deleted' {
  const a = db().admin;
  if (a.deleted.some((d) => d.employee_id === emp)) return 'deleted';
  const u = a.users.find((x) => x.employee_id === emp);
  return u && (u.status === 'suspended' || u.status === 'disabled') ? 'deactivated' : 'active';
}

/** Ball in court from the live matrix: entry holders until submitted, then the holders of the current level. */
export function ballFor(t: MockTask): BallInCourt {
  const level = t.state === 'in_review' || t.state === 'in_approval' ? t.current_level ?? 2 : t.state === 'approved' ? t.levels_required ?? 3 : 1;
  const kind = level === 1 ? 'entry' : level >= (t.levels_required ?? 3) ? 'approve' : 'review';
  const to = db().admin.reassigned[t.id];
  const holders = to ? [{ kind: 'user' as const, ref_id: uid(to), user_id: uid(to), label: byId(to).name_en, employee_id: to }] : holdersOf(db().matrix, t.stage_code, level);
  return { level, level_kind: kind, holders: holders.map((h) => (h.employee_id ? { ...h, account_status: accountStatus(h.employee_id) } : h)), ...(t.claimed_by ? { claimed_by: t.claimed_by } : {}) };
}

/** Levels after `level 1` the submitter's own seats take over (same person on consecutive levels, B5/B6/B7). */
export function skipPath(t: MockTask, employeeId: string | null | undefined, from = 1) {
  const L = t.levels_required ?? 3, skipped: number[] = [];
  let n = from + 1;
  while (n <= L && employeeId && holdersOf(db().matrix, t.stage_code, n).some((a) => a.kind === 'user' && a.employee_id === employeeId)) skipped.push(n++);
  return { skipped, to: n > L ? null : n, final: n > L };
}
export const canEditTask = (t: MockTask) => {
  const v = viewer();
  return !!v && (v.key === 'pm' || holdersOf(db().matrix, t.stage_code, 1).some((a) => a.employee_id === v.employee_id));
};

/** Employee IDs with an absence that covers `day`. */
export const absentOn = (day: string) => new Set(db().admin.absences.filter((a) => a.from_date <= day && day <= a.to_date).map((a) => a.employee_id));

export function toSummary(t: MockTask): TaskSummary {
  const { claimed_by: _cb, actual_start: _as, submitted_by: _s, waiting_since: _w, level_kind: _l, docs: _d, external: _e, entered_by: _b, gen: _g, slots: _sl, steps: _st, comments: _c, locks: _lk, ...rest } = t;
  void [_cb, _as, _s, _w, _l, _d, _e, _b, _g, _sl, _st, _c, _lk];
  const ball = ballFor(t), away = absentOn('2026-10-25');
  const bad = ball.holders.find((h) => h.account_status && h.account_status !== 'active');
  return { ...rest, ball_in_court: ball, ...(bad ? { holder_account_status: bad.account_status } : {}), lock_reasons: t.state === 'locked' ? (t.locks ?? []) : [], holder_absent: rest.holder_absent || (ball.holders.some((h) => !!h.employee_id && away.has(h.employee_id))) };
}

export function toApproval(t: MockTask): ApprovalItem {
  const slots = slotsOf(t);
  return {
    task: toSummary(t), level_kind: t.level_kind, waiting_since: t.waiting_since, submitted_by: staffRef(byId(t.submitted_by)),
    documents_summary: slots.map((x) => ({ slot_id: x.id, name: x.name_en, status: x.status, file_count: x.files.length })),
  };
}

export const slotsOf = (t: MockTask): DocumentSlot[] =>
  t.slots ?? t.docs.map((d, i) => ({ id: `40000000-0000-4000-8000-00000000000${i}`, doc_code: t.task_code, name_en: d, status: 'in_review' as const, mandatory: true, files: [] }));

function allowed(t: MockTask): TaskDetail['allowed_actions'] {
  const v = viewer();
  if (!v) return [];
  const out: TaskDetail['allowed_actions'] = [{ action: 'comment' }];
  if (t.state === 'open' && canEditTask(t)) out.push({ action: 'start' }, { action: 'edit' });
  else if (t.state === 'entry' && canEditTask(t)) {
    const sp = skipPath(t, v.employee_id);
    const missing = slotsOf(t).some((s) => s.mandatory && (s.status === 'missing' || s.status === 'rejected'));
    out.push({ action: 'edit' }, { action: 'submit', step_up: sp.final, final: sp.final, will_skip_to: sp.to, disabled_reason: missing ? 'mandatory_slots_missing' : null });
  }
  if (inbox(t) && canAct(t.level_kind)) {
    const sp = t.level_kind === 'review' ? skipPath(t, v.employee_id, t.current_level ?? 2) : null;
    out.push({ action: t.level_kind === 'approve' ? 'approve' : 'review', step_up: t.level_kind === 'approve' || !!sp?.final, will_skip_to: sp?.to ?? null, final: sp?.final }, { action: 'reject' });
    // a group level can be taken by one holder; only generated site-grid tasks offer it in the mock
    if (t.gen) out.push({ action: t.claimed_by?.id === uid(v.employee_id ?? '9999') ? 'release' : 'claim' });
  }
  return out;
}

export function toDetail(t: MockTask): TaskDetail {
  const L = t.levels_required ?? 3, m = db().matrix;
  const path = Array.from({ length: L }, (_, k) => {
    const level = k + 1, cur = t.current_level ?? 1, kind = level === 1 ? 'entry' : level === L ? 'approve' : 'review';
    const done = t.state === 'approved' || level < cur || (level === 1 && inbox(t));
    const status = done ? 'done' : level === cur && t.state !== 'locked' ? 'current' : 'pending';
    const next = holdersOf(m, t.stage_code, level + 1).map((a) => a.ref_id);
    return {
      level, kind, status, will_skip: level < L && holdersOf(m, t.stage_code, level).some((a) => a.kind === 'user' && next.includes(a.ref_id)),
      ...(level === 1 && done ? { acted_by: staffRef(byId(t.entered_by)), acted_at: '2026-10-20T09:00:00Z' } : {}),
    };
  });
  return {
    ...toSummary(t), approval_path: path, slots: slotsOf(t), allowed_actions: allowed(t), workflow_version: 1,
    lock_reasons: t.state === 'locked' ? (t.locks ?? []) : [],
    missing_for_submit: slotsOf(t).filter((s) => s.mandatory && (s.status === 'missing' || s.status === 'rejected')).map((s) => s.name_en),
    planned_start: t.planned_date, actual_start: t.actual_start ?? t.actual_date,
  } as TaskDetail;
}

export { STAFF, byId };
export type { MockTask };
