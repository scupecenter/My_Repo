// MSW handlers for contract 0.4.0: departments, the direct manager, messages and announcements (ADR 0013). Synthetic data only.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { AnnouncementAudience, MessageThread } from '@/api/types';
import { accountKeyOf, db, save, stepUpValid, viewer } from './db';
import { detail, uref, userBy } from './handlers.admin';
import { guard, page, problem, stepUp } from './handlers';
import type { MockAnnRow, MockMsg, MockThreadRow } from './orgData';
import { O } from './orgState';
import { uid } from './ids';

const B = API_BASE;
const A = () => db().admin;
const now = () => new Date().toISOString();
const bad = (path: string, code: string, title = 'Validation failed') => problem(422, 'validation_failed', title, { errors: [{ path, code }] });
const isAdmin = () => viewer()?.key === 'pm';
const needAdmin = () => guard() ?? (isAdmin() ? null : problem(403, 'action_forbidden', 'Administrators only'));

/** The signed-in user's id (the same one `/me` and the session report). */
function meId(): string {
  const v = viewer();
  if (!v) return '';
  const u = A().users.find((x) => accountKeyOf(x) === v.key);
  return u ? uref(u).id : uid(v.employee_id ?? '9999');
}
/** UserRef of an id; works for registry people and for local accounts. */
function refOf(id: string) {
  const u = A().users.find((x) => uref(x).id === id);
  return u ? uref(u) : { id, display_name: '?', employee_id: null };
}
const isActive = (id: string) => A().users.some((x) => uref(x).id === id && x.status === 'active');
const activeIds = () => A().users.filter((x) => x.status === 'active').map((x) => uref(x).id);

// ------------------------------------------------------------------ messages
const msgBody = (x: MockMsg) => ({ id: x.id, author: refOf(x.author), body: x.body, created_at: x.created_at });
const lastOf = (t: MockThreadRow) => [t.original, ...t.replies].reduce((a, b) => (b.created_at >= a.created_at ? b : a));
function threadBody(t: MockThreadRow, me: string): MessageThread {
  // Original first, replies newest first.
  return { id: t.id, subject: t.subject, participants: [refOf(t.a), refOf(t.b)], original: msgBody(t.original), replies: [...t.replies].reverse().map(msgBody), last_read_at: t.read[me] ?? null };
}
const unreadIn = (t: MockThreadRow, me: string) => [t.original, ...t.replies].some((x) => x.author !== me && (!t.read[me] || x.created_at > t.read[me]!));
function summary(t: MockThreadRow, me: string) {
  const last = lastOf(t), other = t.a === me ? t.b : t.a;
  return { id: t.id, subject: t.subject, other: refOf(other), started_by_me: t.started_by === me, last_message_at: last.created_at, last_message_preview: last.body.replace(/\s+/g, ' ').slice(0, 140), last_author: refOf(last.author), reply_count: t.replies.length, unread: unreadIn(t, me) };
}
const mine = (me: string) => O().threads.filter((t) => t.a === me || t.b === me);
const thread = (id: string, me: string) => mine(me).find((t) => t.id === id);
const lenOk = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length >= 1 && s.length <= max;
const canStart = (me: string, to: string) => isAdmin() || O().managers[me] === to || O().managers[to] === me;

// ------------------------------------------------------------------ announcements
function resolve(a: AnnouncementAudience, sender: string): string[] {
  const out = new Set<string>();
  if (a.all) activeIds().forEach((i) => out.add(i));
  (a.user_ids ?? []).forEach((i) => out.add(i));
  (a.group_ids ?? []).forEach((g) => A().groups.find((x) => x.id === g)?.members.forEach((e) => out.add(uid(e))));
  (a.role_ids ?? []).forEach((r) => A().assignments.filter((x) => x.is_active_now && x.role.id === r).forEach((x) => out.add(x.user.id)));
  (a.department_ids ?? []).forEach((d) => Object.entries(O().deptOf).forEach(([u, dd]) => { if (dd === d) out.add(u); }));
  out.delete(sender);
  return [...out].filter(isActive);
}
const counts = (r: MockAnnRow) => {
  const agree = r.recipients.filter((i) => r.answers[i]?.decision === 'agree').length, dis = r.recipients.filter((i) => r.answers[i]?.decision === 'disagree').length;
  return { recipient_count: r.recipients.length, agree_count: agree, disagree_count: dis, pending_count: r.recipients.length - agree - dis };
};
const annSummary = (r: MockAnnRow) => ({ id: r.id, title: r.title, created_at: r.created_at, created_by: refOf(r.created_by), ...counts(r) });
const deptRef = (id: string | null | undefined) => {
  const d = O().departments.find((x) => x.id === id);
  return d ? { id: d.id, code: d.code, name_en: d.name_en, name_ar: d.name_ar } : null;
};
function annDetail(r: MockAnnRow) {
  const a = r.audience;
  return {
    ...annSummary(r), body: r.body,
    audience: {
      all: !!a.all, users: (a.user_ids ?? []).map(refOf),
      groups: (a.group_ids ?? []).flatMap((g) => A().groups.filter((x) => x.id === g).map((x) => ({ id: x.id, name: x.name, is_system_admins: x.is_system_admins }))),
      roles: (a.role_ids ?? []).flatMap((r2) => A().roles.filter((x) => x.id === r2).map((x) => ({ id: x.id, code: x.code, name_en: x.name_en, name_ar: x.name_ar }))),
      departments: (a.department_ids ?? []).flatMap((d) => { const x = deptRef(d); return x ? [x] : []; }),
    },
  };
}
const rowsOf = (r: MockAnnRow) => r.recipients.map((id) => {
  const ans = r.answers[id];
  return { user: refOf(id), department: deptRef(O().deptOf[id]), decision: ans?.decision ?? ('pending' as const), note: ans?.note ?? null, responded_at: ans?.at ?? null };
}).sort((x, y) => x.user.display_name.localeCompare(y.user.display_name));
const canRead = (r: MockAnnRow) => isAdmin() || r.created_by === meId();
const csv = (v: string | null) => `"${(v ?? '').replace(/"/g, '""')}"`;

export const orgHandlers = [
  // ---- departments
  http.get(`${B}/departments`, ({ request }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const all = new URL(request.url).searchParams.get('include_inactive') === 'true' && isAdmin();
    const members = (id: string) => Object.values(O().deptOf).filter((d) => d === id).length;
    return HttpResponse.json({ items: O().departments.filter((d) => all || d.is_active).map((d) => ({ ...d, member_count: members(d.id) })).sort((a, b) => a.name_en.localeCompare(b.name_en)) });
  }),
  http.post(`${B}/departments`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json()) as { code?: string; name_en?: string; name_ar?: string | null; reason?: string };
    if ((b.reason ?? '').trim().length < 3) return bad('/reason', 'required', 'A reason is required');
    if (!/^[A-Za-z0-9_]{2,20}$/.test(b.code ?? '')) return bad('/code', 'pattern');
    if (!(b.name_en ?? '').trim()) return bad('/name_en', 'required');
    const code = b.code!.toUpperCase();
    if (O().departments.some((d) => d.code === code)) return problem(409, 'duplicate', 'A department with this code exists');
    const d = { id: crypto.randomUUID(), code, name_en: b.name_en!.trim(), name_ar: b.name_ar?.trim() || null, is_active: true };
    O().departments.push(d); save();
    return HttpResponse.json({ ...d, member_count: 0 }, { status: 201 });
  }),
  http.patch(`${B}/departments/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const d = O().departments.find((x) => x.id === params.id);
    if (!d) return problem(404, 'not_found', 'Department not found');
    const b = (await request.json()) as { code?: string; name_en?: string; name_ar?: string | null; is_active?: boolean; reason?: string };
    if ((b.reason ?? '').trim().length < 3) return bad('/reason', 'required', 'A reason is required');
    if (!/^[A-Za-z0-9_]{2,20}$/.test(b.code ?? '')) return bad('/code', 'pattern');
    if (!(b.name_en ?? '').trim()) return bad('/name_en', 'required');
    const code = b.code!.toUpperCase();
    if (O().departments.some((x) => x.id !== d.id && x.code === code)) return problem(409, 'duplicate', 'A department with this code exists');
    Object.assign(d, { code, name_en: b.name_en!.trim(), name_ar: b.name_ar?.trim() || null, ...(b.is_active !== undefined ? { is_active: b.is_active } : {}) }); save();
    return HttpResponse.json({ ...d, member_count: Object.values(O().deptOf).filter((x) => x === d.id).length });
  }),

  // ---- direct manager and department of a user
  http.put(`${B}/users/:id/org`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const u = userBy(params.id as string);
    if (!u) return problem(404, 'not_found', 'User not found');
    const b = (await request.json()) as { manager_id?: string | null; department_id?: string | null; reason?: string };
    if ((b.reason ?? '').trim().length < 3) return bad('/reason', 'required', 'A reason is required');
    if (b.manager_id === undefined || b.department_id === undefined) return bad('/manager_id', 'required');
    const me = uref(u).id;
    if (b.manager_id) {
      if (!isActive(b.manager_id)) return bad('/manager_id', 'not_active');
      for (let cur: string | null | undefined = b.manager_id; cur; cur = O().managers[cur]) if (cur === me) return bad('/manager_id', 'manager_loop', 'The manager would report to this person');
    }
    if (b.department_id && !O().departments.some((d) => d.id === b.department_id && d.is_active)) return bad('/department_id', 'not_active');
    O().managers[me] = b.manager_id ?? null; O().deptOf[me] = b.department_id ?? null; u.version += 1; save();
    return HttpResponse.json(detail(u));
  }),

  // ---- messages
  http.get(`${B}/messages/contacts`, () => {
    const g = guard(); if (g) return g;
    const me = meId(), mgr = O().managers[me];
    return HttpResponse.json({
      manager: mgr && isActive(mgr) ? refOf(mgr) : null,
      reports: Object.entries(O().managers).filter(([id, m]) => m === me && isActive(id)).map(([id]) => refOf(id)).sort((a, b) => a.display_name.localeCompare(b.display_name)),
      can_message_anyone: isAdmin(),
    });
  }),
  http.get(`${B}/messages/threads`, ({ request }) => {
    const g = guard(); if (g) return g;
    const me = meId(), u = new URL(request.url).searchParams;
    const all = mine(me).sort((a, b) => lastOf(b).created_at.localeCompare(lastOf(a).created_at)).map((t) => summary(t, me));
    const items = all.filter((t) => u.get('unread') !== 'true' || t.unread).slice(0, Number(u.get('limit') ?? 50));
    return HttpResponse.json({ items, page: { limit: Number(u.get('limit') ?? 50), next_cursor: null, total: items.length }, unread_total: all.filter((t) => t.unread).length });
  }),
  http.post(`${B}/messages/threads`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const me = meId();
    const b = (await request.json()) as { to_user_id?: string; subject?: string; body?: string };
    if (!lenOk(b.subject, 200)) return bad('/subject', 'required');
    if (!lenOk(b.body, 5000)) return bad('/body', 'required');
    if (!b.to_user_id || b.to_user_id === me || !isActive(b.to_user_id)) return bad('/to_user_id', 'invalid');
    if (!canStart(me, b.to_user_id)) return problem(403, 'action_forbidden', 'You may write to your manager and your reports only');
    const at = now(), t: MockThreadRow = {
      id: crypto.randomUUID(), subject: b.subject.trim(), a: me, b: b.to_user_id, started_by: me,
      original: { id: crypto.randomUUID(), author: me, body: b.body, created_at: at }, replies: [], read: { [me]: at, [b.to_user_id]: null },
    };
    O().threads.push(t); save();
    return HttpResponse.json(threadBody(t, me), { status: 201 });
  }),
  http.get(`${B}/messages/threads/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const me = meId(), t = thread(params.id as string, me);
    return t ? HttpResponse.json(threadBody(t, me)) : problem(404, 'not_found', 'Thread not found');
  }),
  http.post(`${B}/messages/threads/:id/replies`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const me = meId(), t = thread(params.id as string, me);
    if (!t) return problem(404, 'not_found', 'Thread not found');
    const b = (await request.json()) as { body?: string };
    if (!lenOk(b.body, 5000)) return bad('/body', 'required');
    const at = now();
    t.replies.push({ id: crypto.randomUUID(), author: me, body: b.body, created_at: at }); t.read[me] = at; save();
    return HttpResponse.json(threadBody(t, me), { status: 201 });
  }),
  http.post(`${B}/messages/threads/:id/read`, ({ params }) => {
    const g = guard(); if (g) return g;
    const me = meId(), t = thread(params.id as string, me);
    if (!t) return problem(404, 'not_found', 'Thread not found');
    t.read[me] = now(); save();
    return new HttpResponse(null, { status: 204 });
  }),

  // ---- announcements
  http.get(`${B}/announcements`, () => {
    const g = needAdmin(); if (g) return g;
    return page(O().announcements.filter(canRead).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(annSummary));
  }),
  http.post(`${B}/announcements`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json()) as { title?: string; body?: string; audience?: AnnouncementAudience };
    if (!lenOk(b.title, 200)) return bad('/title', 'required');
    if (!lenOk(b.body, 5000)) return bad('/body', 'required');
    const a: AnnouncementAudience = b.audience ?? { all: false }, me = meId(), recipients = resolve(a, me);
    if (!recipients.length) return bad('/audience', 'no_recipients', 'Nobody matches this audience');
    const row: MockAnnRow = { id: crypto.randomUUID(), title: b.title.trim(), body: b.body, created_at: now(), created_by: me, audience: a, recipients, answers: {} };
    O().announcements.push(row); save();
    return HttpResponse.json(annSummary(row), { status: 201 });
  }),
  http.get(`${B}/announcements/:id/responses/export`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = O().announcements.find((x) => x.id === params.id);
    if (!r || !canRead(r)) return problem(404, 'not_found', 'Announcement not found');
    const lines = [['employee_id', 'name', 'department', 'decision', 'note', 'responded_at'].join(','), ...rowsOf(r).map((x) => [x.user.employee_id ?? '', x.user.display_name, x.department?.name_en ?? '', x.decision, x.note, x.responded_at ?? ''].map((c) => csv(c)).join(','))];
    return new HttpResponse(`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="announcement-${r.id.slice(0, 8)}-responses.csv"` } });
  }),
  http.get(`${B}/announcements/:id/responses`, ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = O().announcements.find((x) => x.id === params.id);
    if (!r || !canRead(r)) return problem(404, 'not_found', 'Announcement not found');
    const u = new URL(request.url).searchParams, dec = u.get('decision'), limit = Number(u.get('limit') ?? 50), from = Number(u.get('cursor') ?? 0);
    const all = rowsOf(r).filter((x) => !dec || x.decision === dec), items = all.slice(from, from + limit);
    return HttpResponse.json({ items, page: { limit, next_cursor: from + limit < all.length ? String(from + limit) : null, total: all.length } });
  }),
  http.post(`${B}/announcements/:id/respond`, async ({ params, request }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const me = meId(), r = O().announcements.find((x) => x.id === params.id);
    if (!r || !r.recipients.includes(me)) return problem(404, 'not_found', 'Announcement not found');
    const b = (await request.json()) as { decision?: string; note?: string | null };
    if (b.decision !== 'agree' && b.decision !== 'disagree') return bad('/decision', 'invalid');
    if (r.answers[me]) return problem(409, 'duplicate', 'You already answered this announcement');
    if (b.decision === 'disagree' && (b.note ?? '').trim().length < 3) return problem(422, 'note_required', 'A disagreement needs a note', { errors: [{ path: '/note', code: 'required' }] });
    r.answers[me] = { decision: b.decision, note: b.decision === 'disagree' ? b.note!.trim() : null, at: now() }; save();
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${B}/announcements/:id`, ({ params }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const r = O().announcements.find((x) => x.id === params.id);
    if (!r) return problem(404, 'not_found', 'Announcement not found');
    if (canRead(r)) return HttpResponse.json(annDetail(r));
    // A recipient gets the text only.
    if (r.recipients.includes(meId())) return HttpResponse.json({ id: r.id, title: r.title, body: r.body, created_at: r.created_at, created_by: refOf(r.created_by), recipient_count: 0, agree_count: 0, disagree_count: 0, pending_count: 0, audience: {} });
    return problem(404, 'not_found', 'Announcement not found');
  }),
  http.get(`${B}/me/announcements/pending`, () => {
    // Pending and must-change accounts get it too: no guard(), only a session.
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const me = meId();
    return HttpResponse.json({
      items: O().announcements.filter((r) => r.recipients.includes(me) && !r.answers[me]).sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((r) => ({ id: r.id, title: r.title, body: r.body, created_at: r.created_at, created_by: refOf(r.created_by) })),
    });
  }),
];
