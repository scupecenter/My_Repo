import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Problem } from '@/api/types';
import { uid } from './ids';
import { ACCOUNTS, STAFF, approvalsFor, canAct, cred, db, meBody, save, sessionBody, skipPath, stepUpValid, toApproval, toDetail, toSummary, viewer, type MockTask } from './db';
import { touch } from './sites';

const B = API_BASE;
const pending = new Map<string, string | null>(); // OIDC state -> matched registry email, kept server-side only

export const problem = (status: number, code: string, title: string, extra: Partial<Problem> = {}) =>
  new HttpResponse(JSON.stringify({ type: `https://pmis.aljeel.internal/problems/${code}`, title, status, code, request_id: 'mock', ...extra }), {
    status, headers: { 'Content-Type': 'application/problem+json' },
  });
export const page = <T,>(items: T[]) => HttpResponse.json({ items, page: { limit: 50, next_cursor: null, total: items.length } });
export const guard = () => {
  const v = viewer();
  if (!v) return problem(401, 'unauthenticated', 'Sign in required');
  if (cred(db().session!.account)?.must_change && db().session!.method === 'local') return problem(403, 'password_change_required', 'Change your temporary password first');
  if (v.status !== 'active') return problem(403, 'pending_assignment', 'Your account waits for an assignment');
  return null;
};
export const stepUp = () => db().session?.method === 'local'
  ? problem(401, 'step_up_required', 'Re-authentication required', { step_up_method: 'password' })
  : problem(401, 'step_up_required', 'Re-authentication required', { step_up_url: '/mock-m365/step-up?return_to=%2Fstep-up-done', step_up_method: 'm365' });

export function ifMatch(req: Request, t: MockTask) {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return Number(h.replace(/"/g, '')) === t.version ? null : problem(412, 'precondition_failed', 'The task changed; reload and retry');
}
export const find = (id: string) => db().tasks.find((t) => t.id === id) ?? db().extra.find((t) => t.id === id) ?? touch(id);

export function transition(t: MockTask, op: 'pass' | 'approve' | 'reject', note?: string) {
  if (op === 'pass') { t.state = 'in_approval'; t.level_kind = 'approve'; t.current_level = 3; }
  else if (op === 'approve') { t.state = 'approved'; t.actual_date = t.actual_date ?? '2026-10-25'; }
  else if (t.level_kind === 'approve') { t.state = 'in_review'; t.level_kind = 'review'; t.current_level = 2; t.return_count = (t.return_count ?? 0) + 1; t.last_return_note = note; }
  else { t.state = 'entry'; t.current_level = 1; t.return_count = (t.return_count ?? 0) + 1; t.last_return_note = note; }
  t.version += 1;
}

/** Appends a workflow step to a generated task (history) and a rejection note to its comments. */
export function recordStep(t: MockTask, action: string, note?: string, skipped: number[] = []) {
  const v = viewer()!, who = { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? undefined };
  const at = new Date().toISOString();
  t.steps = [...(t.steps ?? []),
    { id: crypto.randomUUID(), level: t.current_level ?? 1, action: action as 'submit', acted_by: who, note: note ?? null, created_at: at, self_approval: t.state === 'approved' && skipped.length > 1 },
    ...skipped.map((l) => ({ id: crypto.randomUUID(), level: l, action: 'auto_skip' as const, acted_by: who, note: `Level ${l} skipped: same person`, created_at: at }))];
  if (action === 'reject') t.comments = [...(t.comments ?? []), { id: crypto.randomUUID(), author: who, body: note ?? '', is_rejection_note: true, created_at: at }];
}

export const handlers = [
  // ---- auth: identical response whether or not the identifier matches; registry email never derived or exposed.
  http.get(`${B}/auth/login`, ({ request }) => {
    const id = (new URL(request.url).searchParams.get('identifier') ?? '').trim();
    const row = STAFF.find((s) => s.employee_id === id || s.email === id.toLowerCase() || s.phone.replace(/\s/g, '') === id.replace(/\s/g, ''));
    const state = crypto.randomUUID();
    pending.set(state, row?.email ?? null);
    const loc = new URLSearchParams({ state });
    if (id.includes('@')) loc.set('login_hint', id); // only what the user typed themselves
    return new HttpResponse(null, { status: 302, headers: { Location: `/mock-m365?${loc}` } });
  }),
  http.get(`${B}/auth/session`, () => {
    const body = sessionBody();
    return body.authenticated ? HttpResponse.json(body) : problem(401, 'unauthenticated', 'Sign in required');
  }),
  http.post(`${B}/__mock/signin`, async ({ request }) => {
    const { account, state } = (await request.json()) as { account: string; state?: string };
    const a = ACCOUNTS[account];
    if (!a) return problem(422, 'validation_failed', 'Unknown mock account');
    const matched = state ? pending.get(state) : null;
    if (matched && matched !== a.email) return problem(401, 'unauthenticated', 'Signed in account does not match the registry row');
    db().session = { account, linked: a.employee_id !== null, stepupAt: null, method: 'm365' };
    save();
    return HttpResponse.json(sessionBody());
  }),
  http.post(`${B}/__mock/step-up`, () => {
    if (db().session) { db().session!.stepupAt = Date.now(); save(); }
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${B}/auth/logout`, () => { db().session = null; save(); return new HttpResponse(null, { status: 204 }); }),
  http.post(`${B}/auth/employee-id`, async ({ request }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const { employee_id } = (await request.json()) as { employee_id: string };
    if (!/^[0-9]{4}$/.test(employee_id ?? '') || !STAFF.some((s) => s.employee_id === employee_id))
      return problem(422, 'validation_failed', 'Employee ID not found in the staff registry', { errors: [{ path: '/employee_id', code: 'not_in_registry' }] });
    if (Object.values(ACCOUNTS).some((a) => a.employee_id === employee_id)) return problem(409, 'duplicate', 'This employee ID is already linked to another account');
    Object.assign(db().session!, { linked: true, employee_id });
    const au = db().admin.users.find((u) => u.employee_id === employee_id);
    if (au) au.status = 'pending_assignment'; // a newly linked account waits for an assignment
    save();
    return HttpResponse.json(sessionBody());
  }),
  http.post(`${B}/me/notify-admins`, () => new HttpResponse(null, { status: 202 })),

  // ---- me
  http.get(`${B}/me`, () => (viewer() ? HttpResponse.json(meBody()) : problem(401, 'unauthenticated', 'Sign in required'))),
  http.patch(`${B}/me/preferences`, async ({ request }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const me = meBody();
    return HttpResponse.json({ ...me, user: { ...me.user, ...(await request.json() as object) } });
  }),
  http.get(`${B}/me/tasks`, ({ request }) => {
    const g = guard(); if (g) return g;
    const v = viewer()!;
    const bucket = new URL(request.url).searchParams.get('bucket');
    if (bucket === 'late') return page(v.key === 'pm' ? db().extra.filter((t) => t.sla?.colour === 'red').map(toSummary) : []);
    if (bucket === 'do_now') return page(approvalsFor().map(toSummary));
    const waiting = db().tasks.filter((t) => (t.state === 'in_review' || t.state === 'in_approval') && t.submitted_by === v.employee_id && !canAct(t.level_kind));
    return page(waiting.map(toSummary));
  }),

  // ---- approvals
  http.get(`${B}/approvals`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const tab = u.get('tab') ?? 'all', q = (u.get('q') ?? '').toLowerCase();
    const items = approvalsFor().filter((t) => (tab === 'all' || t.level_kind === tab) && (!q || `${t.site_code} ${t.name_en} ${t.task_code}`.toLowerCase().includes(q)));
    return page(items.map(toApproval));
  }),
  http.post(`${B}/approvals/bulk`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const { action, items } = (await request.json()) as { action: 'pass' | 'approve'; items: { id: string; version: number }[] };
    if (action === 'approve' && !stepUpValid()) return stepUp();
    const out = { bulk_action_id: crypto.randomUUID(), done: [] as { id: string }[], skipped: [] as object[], failed: [] as object[] };
    for (const it of items) {
      const t = find(it.id);
      if (!t) out.failed.push({ ref: it.id, code: 'not_found' });
      else if (t.version !== it.version) out.failed.push({ ref: it.id, code: 'precondition_failed', message: 'Changed by someone else' });
      else if (t.level_kind !== (action === 'pass' ? 'review' : 'approve') || !canAct(t.level_kind)) out.skipped.push({ ref: it.id, code: 'invalid_transition' });
      else { transition(t, action === 'pass' ? 'pass' : 'approve'); out.done.push({ id: t.id }); }
    }
    save();
    return HttpResponse.json(out);
  }),

  // ---- tasks
  http.get(`${B}/tasks/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    return t ? HttpResponse.json(toDetail(t), { headers: { ETag: `"${t.version}"` } }) : problem(404, 'not_found', 'Task not found');
  }),
  ...(['review', 'approve', 'reject'] as const).map((op) =>
    http.post(`${B}/tasks/:id/${op}`, async ({ params, request }) => {
      const g = guard(); if (g) return g;
      const t = find(params.id as string);
      if (!t) return problem(404, 'not_found', 'Task not found');
      const bad = ifMatch(request, t); if (bad) return bad;
      const body = (await request.json().catch(() => ({}))) as { note?: string };
      if (op === 'reject' && !body.note?.trim()) return problem(422, 'note_required', 'A rejection needs a note', { errors: [{ path: '/note', code: 'required' }] });
      if (t.state !== 'in_review' && t.state !== 'in_approval') return problem(409, 'invalid_transition', 'Task is not waiting for review');
      if (!canAct(t.level_kind) || (op === 'review' && t.level_kind !== 'review') || (op === 'approve' && t.level_kind !== 'approve')) return problem(403, 'not_eligible_holder', 'You do not hold this level');
      if (op === 'approve' && !stepUpValid()) return stepUp();
      const sp = t.gen && op === 'review' ? skipPath(t, viewer()!.employee_id, t.current_level ?? 2) : null;
      if (sp?.final && !stepUpValid()) return stepUp();
      // B6: after an auto-skip a rejection returns to the person who acted on the previous level, i.e. entry.
      const skippedPrev = t.gen && op === 'reject' && !!t.steps?.some((x) => x.action === 'auto_skip' && x.level === (t.current_level ?? 2) - 1);
      transition(t, sp?.final ? 'approve' : op === 'review' ? 'pass' : op, body.note);
      if (skippedPrev) { t.state = 'entry'; t.current_level = 1; }
      if (t.gen) recordStep(t, op === 'review' && sp?.final ? 'approve' : op, body.note, sp?.skipped);
      save();
      return HttpResponse.json({ task: toDetail(t), step_ids: [] }, { headers: { ETag: `"${t.version}"` } });
    })),

  // ---- registry hover card (phone hidden for 1104 to exercise "Not visible to you")
  http.get(`${B}/staff-registry/:id`, ({ params }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const s = STAFF.find((x) => x.employee_id === params.id);
    if (!s) return problem(404, 'not_found', 'Not in the registry');
    const vis = db().cfg.visibility.fields, admin = viewer()?.key === 'pm';
    const hidden = [...new Set([...(s.employee_id === '1104' ? ['phone'] : []), ...(db().cfg.hidden[s.employee_id] ?? []), ...(['email', 'phone'] as const).filter((f) => !vis[f].default_visible && !admin)])] as ('phone' | 'email')[];
    return HttpResponse.json({
      employee_id: s.employee_id, name_en: s.name_en, name_ar: s.name_ar, position: s.position, team: s.team, region: s.region,
      status: s.status === 'active' ? 'active' : 'inactive', email: hidden.includes('email') ? null : s.email, phone: hidden.includes('phone') ? null : s.phone, hidden_fields: hidden, version: 1,
    });
  }),

  // ---- notifications
  http.get(`${B}/notifications`, () => {
    const g = guard(); if (g) return g;
    const items = db().notifications;
    return HttpResponse.json({ items, page: { limit: 50, next_cursor: null }, unread_count: items.filter((n) => !n.read_at).length });
  }),
  http.post(`${B}/notifications/read-all`, () => { db().notifications.forEach((n) => { n.read_at ??= new Date().toISOString(); }); save(); return new HttpResponse(null, { status: 204 }); }),
  http.post(`${B}/notifications/:id/read`, ({ params }) => {
    const n = db().notifications.find((x) => x.id === params.id);
    if (!n) return problem(404, 'not_found', 'Not found');
    n.read_at ??= new Date().toISOString(); save();
    return HttpResponse.json(n);
  }),
];
