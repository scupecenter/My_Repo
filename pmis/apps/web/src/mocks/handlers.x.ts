// MSW handlers of the phase 4b features X1 to X7 (contract 0.4.10 and 0.7.1): inbox, follow, register comments with mentions, time in state, workload,
// blocked-by and weekly status updates. They behave like the real API where it matters to the screens: the inbox hides what the caller cannot read,
// a mention reaches only people who can read the item (anyone else is dropped silently), only a lead writes a status update, and only the author edits it.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Comment, Notification, StatusUpdate, UserRef } from '@/api/types';
import { tripoliToday } from '@/lib/today';
import { weekStartOf } from '@/lib/x';
import { ballFor, db, save, STAFF, toDetail, viewer, type MockTask } from './db';
import { find, guard, page, problem } from './handlers';
import { staffRef, uid } from './ids';
import { SITE_COUNT, siteIdOf, siteIndex, siteMeta, siteTasks } from './sites';

const B = API_BASE;
const me = (): UserRef => { const v = viewer()!; return { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id ?? undefined }; };
/** A lead in the mock: the System Admin account and the Team Lead account (they hold the reassign right). */
const isLead = () => ['pm', 'reviewer'].includes(viewer()?.key ?? '');
const invalid = (path: string, code = 'invalid') => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code, message: code }] });

// ---------------------------------------------------------------------------------------------------------------- mentions
/**
 * The people a comment names (ids and `@1234` tokens). In the mock a person can read the item when the registry has them as active and their account is not the
 * pending one; the rest is dropped silently, so the answer never says whether someone exists.
 */
export function resolveMentions(text: string, ids: string[] | undefined): UserRef[] {
  const wanted = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(])@(\d{4})\b/g)) wanted.add(m[1] as string);
  for (const id of ids ?? []) { const s = STAFF.find((x) => uid(x.employee_id) === id); if (s) wanted.add(s.employee_id); }
  const v = viewer();
  return STAFF.filter((s) => wanted.has(s.employee_id) && s.status === 'active' && s.employee_id !== v?.employee_id && !['1211'].includes(s.employee_id)).slice(0, 20).map(staffRef);
}

// ---------------------------------------------------------------------------------------------------------------- X1 inbox
const KINDS = new Set(['task_assigned', 'task_returned', 'task_approved', 'approval_due', 'reassigned', 'absence_alert', 'idle_task_alert', 'no_holder', 'holiday_tentative', 'delegation', 'mfa_exemption', 'template_updated', 'import_batch', 'system', 'mention', 'task_rejected', 'no_eligible_holder', 'register_assigned', 'register_rejected', 'gate_closed_again', 'sla_negative_duration', 'followed_change']);
const asleep = (n: Notification) => !!n.snoozed_until && Date.parse(n.snoozed_until) > Date.now();
const newest = (a: Notification, b: Notification) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1);

function inboxPage(q: URLSearchParams) {
  const kind = q.get('kind'), snoozed = q.get('snoozed') ?? 'hide', limit = Number(q.get('limit') ?? 50);
  if (kind && !KINDS.has(kind)) return invalid('/kind');
  if (!['hide', 'only', 'include'].includes(snoozed)) return invalid('/snoozed');
  const all = [...db().notifications].sort(newest);
  let rows = all.filter((n) => (!kind || n.kind === kind) && (q.get('unread_only') !== 'true' || !n.read_at));
  rows = rows.filter((n) => (snoozed === 'include' ? true : snoozed === 'only' ? asleep(n) : !asleep(n)));
  const from = Number(q.get('cursor') ? atob(q.get('cursor') as string) : 0) || 0;
  const items = rows.slice(from, from + limit);
  return HttpResponse.json({
    items, page: { limit, next_cursor: from + limit < rows.length ? btoa(String(from + limit)) : null },
    unread_count: all.filter((n) => !n.read_at && !asleep(n)).length,
  });
}

const note = (id: string) => db().notifications.find((n) => n.id === id);

// ---------------------------------------------------------------------------------------------------------------- X4 to X6
const DAY = 86_400_000;
const STATE_LEVEL: Record<string, 'entry' | 'review' | 'approve' | null> = { open: 'entry', entry: 'entry', rejected: 'entry', in_review: 'review', in_approval: 'approve', locked: null, approved: null };

/** A history the screen can show: L1 for three days, then the current level (still open), or both closed for an approved task. */
function visitsOf(t: MockTask) {
  const now = Date.parse(`${tripoliToday()}T08:00:00Z`);
  const lvl = STATE_LEVEL[t.state] ?? null;
  const holder = (emp: string) => staffRef(STAFF.find((s) => s.employee_id === emp) ?? STAFF[0]!);
  const seg = (state: 'entry' | 'review' | 'approve', from: number, to: number | null, by?: string) => {
    const end = to ?? now;
    return { state, started_at: new Date(from).toISOString(), ended_at: to === null ? null : new Date(to).toISOString(), seconds: Math.round((end - from) / 1000), working_days: Math.max(0, Math.round((end - from) / DAY * 5 / 7)), ...(by ? { handled_by: holder(by) } : {}) };
  };
  if (t.state === 'locked') return [];
  if (t.state === 'approved') return [seg('entry', now - 7 * DAY, now - 4 * DAY, t.entered_by), seg('approve', now - 4 * DAY, now - 3 * DAY, '1001')];
  if (lvl === 'entry') return [seg('entry', now - 2 * DAY, null)];
  return [seg('entry', now - 5 * DAY, now - 2 * DAY, t.entered_by), seg(lvl ?? 'approve', now - 2 * DAY, null)];
}

function timeInState(t: MockTask) {
  const segments = visitsOf(t);
  const items = (['entry', 'review', 'approve'] as const).map((state) => {
    const mine = segments.filter((s) => s.state === state);
    return { state, visits: mine.length, total_seconds: mine.reduce((a, s) => a + s.seconds, 0), longest_seconds: Math.max(0, ...mine.map((s) => s.seconds)), working_days: mine.reduce((a, s) => a + s.working_days, 0) };
  });
  const open = segments.find((s) => s.ended_at === null);
  return { task_id: t.id, current_state: open ? open.state : null, items, segments };
}

const OPEN = new Set(['open', 'entry', 'in_review', 'in_approval']);
function workload(region: number | null) {
  const rows = new Map<string, { holder: UserRef; team: 'cw' | 'te' | 'both' | 'none'; open: number; late: number; by_level: { entry: number; review: number; approve: number } }>();
  const none = { open: 0, late: 0 };
  const tasks = [...db().tasks, ...db().extra, ...Object.values(db().ov)].filter((t) => OPEN.has(t.state) && (region === null || t.region_id === region));
  for (const t of tasks) {
    const b = ballFor(t);
    const late = t.sla?.colour === 'red';
    const users = b.holders.filter((h) => h.employee_id);
    if (!users.length) { none.open += 1; none.late += late ? 1 : 0; continue; }
    for (const h of users) {
      const s = STAFF.find((x) => x.employee_id === h.employee_id);
      const r = rows.get(h.employee_id as string) ?? { holder: staffRef(s ?? STAFF[0]!), team: ((s?.team as 'cw') ?? 'none'), open: 0, late: 0, by_level: { entry: 0, review: 0, approve: 0 } };
      r.open += 1; r.late += late ? 1 : 0; r.by_level[(b.level_kind ?? 'entry') as 'entry'] += 1;
      rows.set(h.employee_id as string, r);
    }
  }
  return { items: [...rows.values()].sort((a, b) => b.late - a.late || b.open - a.open || a.holder.display_name.localeCompare(b.holder.display_name)), no_holder: none };
}

export const xHandlers = [
  // ---- X1
  http.get(`${B}/notifications`, ({ request }) => { const g = guard(); if (g) return g; return inboxPage(new URL(request.url).searchParams); }),
  http.post(`${B}/notifications/read-all`, () => {
    const g = guard(); if (g) return g;
    db().notifications.forEach((n) => { if (!n.read_at && !asleep(n)) n.read_at = new Date().toISOString(); });
    save();
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${B}/notifications/:id/read`, ({ params }) => { const g = guard(); if (g) return g; const n = note(params.id as string); if (!n) return problem(404, 'not_found', 'Not found'); n.read_at ??= new Date().toISOString(); save(); return HttpResponse.json(n); }),
  http.post(`${B}/notifications/:id/unread`, ({ params }) => { const g = guard(); if (g) return g; const n = note(params.id as string); if (!n) return problem(404, 'not_found', 'Not found'); n.read_at = null; save(); return HttpResponse.json(n); }),
  http.post(`${B}/notifications/:id/snooze`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const n = note(params.id as string); if (!n) return problem(404, 'not_found', 'Not found');
    const b = (await request.json()) as { until?: unknown };
    if (!('until' in b) || Object.keys(b).length !== 1) return invalid('/until');
    if (b.until === null) n.snoozed_until = null;
    else {
      const t = typeof b.until === 'string' ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(b.until) ? `${b.until}T00:00:00+02:00` : b.until) : NaN;
      if (Number.isNaN(t) || t <= Date.now() || t > Date.now() + 366 * DAY) return invalid('/until');
      n.snoozed_until = new Date(t).toISOString();
    }
    save();
    return HttpResponse.json(n);
  }),

  // ---- X2
  http.get(`${B}/me/follows`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: [...db().x.follows].reverse() }); }),
  http.put(`${B}/sites/:id/follow`, ({ params }) => {
    const g = guard(); if (g) return g;
    const i = siteIndex(params.id as string);
    if (!Number.isInteger(i) || i < 0 || i >= SITE_COUNT) return problem(404, 'not_found', 'Not found');
    const m = siteMeta(i);
    let f = db().x.follows.find((x) => x.entity_type === 'site' && x.entity_id === m.id);
    if (!f) { f = { id: crypto.randomUUID(), entity_type: 'site', entity_id: m.id, register_key: null, site_id: m.id, label: `${m.code} ${m.name}`, created_at: new Date().toISOString() }; db().x.follows.push(f); save(); }
    return HttpResponse.json(f);
  }),
  http.delete(`${B}/sites/:id/follow`, ({ params }) => { const g = guard(); if (g) return g; db().x.follows = db().x.follows.filter((x) => !(x.entity_type === 'site' && x.entity_id === params.id)); save(); return new HttpResponse(null, { status: 204 }); }),
  http.put(`${B}/registers/:key/records/:id/follow`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = db().reg.records.find((x) => x.id === params.id && x.register_key === params.key);
    if (!r) return problem(404, 'not_found', 'Not found');
    let f = db().x.follows.find((x) => x.entity_type === 'register_record' && x.entity_id === r.entity_id);
    if (!f) {
      const sid = r.site_index !== null ? siteIdOf(r.site_index) : null;
      f = { id: crypto.randomUUID(), entity_type: 'register_record', entity_id: r.entity_id, register_key: r.register_key, site_id: sid, label: `${r.register_key} v${r.version_no}`, created_at: new Date().toISOString() };
      db().x.follows.push(f); save();
    }
    return HttpResponse.json(f);
  }),
  http.delete(`${B}/registers/:key/records/:id/follow`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = db().reg.records.find((x) => x.id === params.id && x.register_key === params.key);
    if (r) { db().x.follows = db().x.follows.filter((x) => !(x.entity_type === 'register_record' && x.entity_id === r.entity_id)); save(); }
    return new HttpResponse(null, { status: 204 });
  }),

  // ---- X3 (register records; task comments are in handlers.sites.ts and call resolveMentions)
  http.get(`${B}/registers/:key/records/:id/comments`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = db().reg.records.find((x) => x.id === params.id && x.register_key === params.key);
    if (!r) return problem(404, 'not_found', 'Not found');
    return page(db().x.regComments[r.entity_id] ?? []);
  }),
  http.post(`${B}/registers/:key/records/:id/comments`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = db().reg.records.find((x) => x.id === params.id && x.register_key === params.key);
    if (!r) return problem(404, 'not_found', 'Not found');
    const b = (await request.json()) as { body?: string; mention_user_ids?: string[] };
    if (!b.body?.trim() || b.body.length > 4000) return invalid('/body');
    const c: Comment = { id: crypto.randomUUID(), author: me(), body: b.body.trim(), is_rejection_note: false, mentions: resolveMentions(b.body, b.mention_user_ids), created_at: new Date().toISOString() };
    db().x.regComments[r.entity_id] = [...(db().x.regComments[r.entity_id] ?? []), c];
    save();
    return HttpResponse.json(c, { status: 201 });
  }),

  // ---- X4 to X6
  http.get(`${B}/tasks/:id/time-in-state`, ({ params }) => { const g = guard(); if (g) return g; const t = find(params.id as string); return t ? HttpResponse.json(timeInState(t)) : problem(404, 'not_found', 'Task not found'); }),
  http.get(`${B}/tasks/:id/blocked-by`, ({ params }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    if (!t) return problem(404, 'not_found', 'Task not found');
    const reasons = toDetail(t).lock_reasons ?? [];
    const sibs = t.site_id.startsWith('50000000') ? siteTasks(siteIndex(t.site_id)) : [];
    const items = reasons.map((r) => {
      const p = r.kind === 'predecessor_not_approved' ? sibs.find((x) => x.task_code === r.ref_code) : undefined;
      return { kind: r.kind, ref_code: r.ref_code ?? null, message: r.message, ...(p ? { task: { id: p.id, task_code: p.task_code, name_en: p.name_en, state: p.state } } : {}) };
    });
    return HttpResponse.json({ task_id: t.id, state: t.state, blocked: items.length > 0, items });
  }),
  http.get(`${B}/reports/workload`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!['pm', 'reviewer'].includes(viewer()?.key ?? '')) return problem(403, 'module_forbidden', 'You cannot use reports');
    const r = new URL(request.url).searchParams.get('region_id');
    if (r && !/^[1-7]$/.test(r)) return invalid('/region_id');
    return HttpResponse.json(workload(r ? Number(r) : null));
  }),
  http.get(`${B}/reports/time-in-state`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!['pm', 'reviewer'].includes(viewer()?.key ?? '')) return problem(403, 'module_forbidden', 'You cannot use reports');
    const q = new URL(request.url).searchParams;
    const by = q.get('group_by') ?? 'holder';
    if (!['holder', 'team'].includes(by)) return invalid('/group_by');
    const lv = (visits: number, avg: number) => ({ visits, total_seconds: visits * avg, average_seconds: avg, max_seconds: Math.round(avg * 1.6), working_days: Math.round(visits * avg / DAY) });
    const items = by === 'holder'
      ? [{ holder: staffRef(STAFF.find((s) => s.employee_id === '1204')!), levels: { entry: lv(6, 2.5 * DAY / 1000), approve: lv(4, 0.9 * DAY / 1000) } },
         { holder: staffRef(STAFF.find((s) => s.employee_id === '1102')!), levels: { approve: lv(9, 1.4 * DAY / 1000) } }]
      : [{ team: 'cw', levels: { entry: lv(8, 2.8 * DAY / 1000), approve: lv(7, 1.1 * DAY / 1000) } }, { team: 'te', levels: { entry: lv(5, 1.9 * DAY / 1000), approve: lv(6, 1.6 * DAY / 1000) } }];
    return HttpResponse.json({ group_by: by, items });
  }),

  // ---- X7
  http.get(`${B}/status-updates`, ({ request }) => {
    const g = guard(); if (g) return g;
    const q = new URL(request.url).searchParams;
    const limit = Number(q.get('limit') ?? 50), scope = q.get('scope'), region = q.get('region_id'), team = q.get('team');
    if (scope && !['region', 'team'].includes(scope)) return invalid('/scope');
    if (region && !/^[1-7]$/.test(region)) return invalid('/region_id');
    const today = tripoliToday();
    const rows = db().x.statuses
      .filter((u) => (!scope || u.scope === scope) && (!region || u.region_id === Number(region)) && (!team || u.team === team))
      .sort((a, b) => (a.week_start < b.week_start ? 1 : a.week_start > b.week_start ? -1 : a.created_at < b.created_at ? 1 : -1))
      .map((u) => ({ ...u, editable: u.author.id === me().id && today <= u.week_end }));
    const from = Number(q.get('cursor') ? atob(q.get('cursor') as string) : 0) || 0;
    return HttpResponse.json({ items: rows.slice(from, from + limit), page: { limit, next_cursor: from + limit < rows.length ? btoa(String(from + limit)) : null } });
  }),
  http.post(`${B}/status-updates`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = (await request.json()) as { scope?: string; region_id?: number; team?: string; health?: string; summary?: string };
    if (!['region', 'team'].includes(b.scope ?? '')) return invalid('/scope');
    if (b.scope === 'region' && !b.region_id) return invalid('/region_id', 'required');
    if (b.scope === 'region' && b.team) return invalid('/team');
    if (b.scope === 'team' && !b.team) return invalid('/team', 'required');
    if (!['on_track', 'at_risk', 'off_track'].includes(b.health ?? '')) return invalid('/health');
    if (!b.summary?.trim() || b.summary.length > 4000) return invalid('/summary');
    if (!isLead() || (viewer()?.key === 'reviewer' && !b.region_id)) return problem(403, 'action_forbidden', 'Only a lead of this region, or a System Admin, writes its status update.');
    const today = tripoliToday();
    const week = weekStartOf(today);
    const end = new Date(`${week}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
    const at = new Date().toISOString();
    const u: StatusUpdate = { id: crypto.randomUUID(), scope: b.scope as 'region', region_id: b.region_id ?? null, team: (b.team as 'cw') ?? null, week_start: week, week_end: end.toISOString().slice(0, 10), health: b.health as 'on_track', summary: b.summary.trim(), author: me(), version: 1, created_at: at, updated_at: at, editable: true };
    db().x.statuses.push(u); save();
    return HttpResponse.json(u, { status: 201, headers: { ETag: '"1"' } });
  }),
  http.patch(`${B}/status-updates/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const u = db().x.statuses.find((x) => x.id === params.id);
    if (!u) return problem(404, 'not_found', 'Not found');
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (Number(h.replace(/"/g, '')) !== u.version) return problem(412, 'precondition_failed', 'The update changed; reload and retry');
    const b = (await request.json()) as { health?: string; summary?: string };
    if (!Object.keys(b).length || Object.keys(b).some((k) => !['health', 'summary'].includes(k))) return invalid('/');
    if (u.author.id !== me().id || !isLead()) return problem(403, 'action_forbidden', 'Only the author edits a status update.');
    if (tripoliToday() > u.week_end) return problem(409, 'invalid_transition', 'The week of this update has ended.');
    if (b.health) { if (!['on_track', 'at_risk', 'off_track'].includes(b.health)) return invalid('/health'); u.health = b.health as 'on_track'; }
    if (b.summary !== undefined) { if (!b.summary.trim() || b.summary.length > 4000) return invalid('/summary'); u.summary = b.summary.trim(); }
    u.version += 1; u.updated_at = new Date().toISOString(); save();
    return HttpResponse.json({ ...u, editable: true }, { headers: { ETag: `"${u.version}"` } });
  }),
];

