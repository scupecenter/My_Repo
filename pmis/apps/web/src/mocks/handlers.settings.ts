// MSW handlers for phase 3b: work calendar, rules, freeze, DLP, idle days, notification policy, log retention,
// staff visibility, security log, integrity, online now. Synthetic data; validation mirrors the contract.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Holiday, NotificationPolicyInput, SecurityLogEntry } from '@/api/types';
import { db, save, stepUpValid, viewer } from './db';
import { guard, page, problem, stepUp } from './handlers';
import { byId, uid } from './ids';
import { CATALOGUE, SLA, WEIGHTS } from './settingsData';

const B = API_BASE;
const TODAY = '2026-10-25';
const C = () => db().cfg;
const isAdmin = () => viewer()?.key === 'pm';
const needAdmin = () => guard() ?? (isAdmin() ? null : problem(403, 'action_forbidden', 'Administrators only'));
const fields = (...errors: { path: string; code: string }[]) => problem(422, 'validation_failed', 'Validation failed', { errors });
const reasonErr = (r?: string) => ((r ?? '').trim().length < 3 || (r ?? '').length > 1000 ? fields({ path: '/reason', code: 'required' }) : null);
const tag = (n: number) => ({ headers: { ETag: `"${n}"` } });
const ver = (req: Request, v: number) => { const h = req.headers.get('If-Match'); return h && Number(h.replace(/"/g, '')) !== v ? problem(412, 'precondition_failed', 'Changed by someone else; reload') : null; };
const ref = (e: string) => ({ id: uid(e), display_name: byId(e).name_en, employee_id: e });
const me = () => ref(viewer()!.employee_id!);
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const body = async <T,>(r: Request) => ((await r.json().catch(() => ({}))) ?? {}) as T;

const summary = () => {
  const h = C().holidays, tent = h.filter((x) => x.tentative && x.date >= TODAY).sort((a, b) => a.date.localeCompare(b.date));
  return { tentative_count: h.filter((x) => x.tentative).length, next_tentative_date: tent[0]?.date ?? null, tentative_reminder_due: !!tent[0] && day(tent[0].date) - day(TODAY) <= 14 * 864e5, next_year: 2027, next_year_table_empty: !h.some((x) => x.date.startsWith('2027')) };
};
const changed = (holiday: Holiday) => HttpResponse.json({ holiday, affected_open_tasks: 12, recalculation_job_id: null });

const POLICY_KEYS = ['reason', 'enabled', 'timezone', 'digest_hour', 'work_days_follow_calendar', 'work_days', 'thresholds', 'columns', 'matrix'];
const TH: Record<string, [number, number]> = { approval_remind_hours: [4, 168], approval_escalate_days: [1, 30], sla_warning_days_before_max: [0, 30], rate_cap_per_hour: [5, 500], retention_days: [30, 730] };

/** Pure validation of a notification policy body (also unit-tested). */
export function validatePolicy(b: NotificationPolicyInput & Record<string, unknown>, tzOk = (z: string) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } }) {
  const errs: { path: string; code: string }[] = [];
  for (const k of Object.keys(b)) if (!POLICY_KEYS.includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
  if (!tzOk(b.timezone ?? '')) errs.push({ path: '/timezone', code: 'invalid_timezone' });
  if (!int(b.digest_hour, 0, 23)) errs.push({ path: '/digest_hour', code: 'out_of_range' });
  const t = (b.thresholds ?? {}) as Record<string, number>;
  for (const k of Object.keys(t)) if (!TH[k]) errs.push({ path: `/thresholds/${k}`, code: 'unknown_key' });
  for (const [k, [lo, hi]] of Object.entries(TH)) if (!int(t[k], lo, hi)) errs.push({ path: `/thresholds/${k}`, code: t[k] === undefined ? 'required' : 'out_of_range' });
  if (!errs.some((e) => e.path.startsWith('/thresholds/approval_')) && t.approval_escalate_days * 24 <= t.approval_remind_hours)
    errs.push({ path: '/thresholds/approval_escalate_days', code: 'must_exceed_remind_hours' }, { path: '/thresholds/approval_remind_hours', code: 'must_exceed_remind_hours' });
  if (!b.work_days_follow_calendar && !(b.work_days ?? []).length) errs.push({ path: '/work_days', code: 'required' });
  (b.matrix ?? []).forEach((row, i) => {
    const def = CATALOGUE.find((c) => c.code === row.type_code);
    if (!def) return void errs.push({ path: `/matrix/${i}/type_code`, code: 'unknown_type' });
    if (def.mandatory) {
      (['in_app', 'email'] as const).forEach((ch) => { if (def.default_channels[ch] && !row.channels[ch]) errs.push({ path: `/matrix/${i}/channels/${ch}`, code: 'mandatory_locked' }); });
      row.cells.forEach((c, j) => { if (!c.on) errs.push({ path: `/matrix/${i}/cells/${j}`, code: 'mandatory_locked' }); });
    }
  });
  return errs;
}

export const settingsHandlers = [
  // ------------------------------------------------------------------ calendar
  http.get(`${B}/settings/holidays`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, year = u.get('year'), tent = u.get('tentative');
    const items = C().holidays.filter((h) => (!year || h.date.startsWith(year)) && (tent === null || h.tentative === (tent === 'true'))).sort((a, b) => a.date.localeCompare(b.date));
    return HttpResponse.json({ items, summary: summary() });
  }),
  http.get(`${B}/settings/calendars`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: [{ id: uid('1001'), code: 'LY', name: 'Libya', weekend_days: C().weekend.days, is_default: true, holidays: C().holidays.map((h) => ({ date: h.date, name: h.name_en })), holiday_table_empty: false }] }); }),
  http.post(`${B}/settings/holidays`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ date?: string; name_en?: string; kind?: string; tentative?: boolean; name_ar?: string; reason?: string }>(request);
    const errs: { path: string; code: string }[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '')) errs.push({ path: '/date', code: 'required' });
    if ((b.name_en ?? '').trim().length < 2) errs.push({ path: '/name_en', code: 'min_length' });
    if (b.kind !== 'national' && b.kind !== 'religious') errs.push({ path: '/kind', code: 'required' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (C().holidays.some((h) => h.date === b.date)) return problem(409, 'duplicate', 'A holiday exists on this date', { errors: [{ path: '/date', code: 'duplicate' }] });
    const h = { id: crypto.randomUUID(), calendar_code: 'LY', date: b.date!, name_en: b.name_en!.trim(), name_ar: b.name_ar ?? null, kind: b.kind as 'national', tentative: !!b.tentative, confirmed_at: null, confirmed_by: null, version: 1 } as Holiday;
    C().holidays.push(h); save();
    return HttpResponse.json({ holiday: h, affected_open_tasks: 12, recalculation_job_id: null }, { status: 201 });
  }),
  http.post(`${B}/settings/holidays/import`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const f = (await request.formData().catch(() => null))?.get('file');
    if (!(f instanceof File) || !/\.(csv|xlsx)$/i.test(f.name)) return problem(422, 'template_rejected', 'Not an approved template', { reason: 'tpl_missing' } as never);
    const rows = (await f.text()).split(/\r?\n/).slice(1).map((l) => l.split(',')).filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c[0]) && !C().holidays.some((h) => h.date === c[0]));
    rows.forEach((c, i) => C().holidays.push({ id: crypto.randomUUID(), calendar_code: 'LY', date: c[0], name_en: c[1] ?? `Imported ${i}`, name_ar: c[2] ?? null, kind: c[3] === 'religious' ? 'religious' : 'national', tentative: c[4] === 'yes', confirmed_at: null, confirmed_by: null, version: 1 } as Holiday));
    save();
    return HttpResponse.json({ id: crypto.randomUUID(), status: 'applied', rows_added: rows.length }, { status: 202 });
  }),
  http.patch(`${B}/settings/holidays/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const h = C().holidays.find((x) => x.id === params.id); if (!h) return problem(404, 'not_found', 'Holiday not found');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, h.version); if (p) return p;
    const { reason, ...patch } = await body<Partial<Holiday> & { reason?: string }>(request);
    const r = reasonErr(reason); if (r) return r;
    if (patch.name_en !== undefined && patch.name_en.trim().length < 2) return fields({ path: '/name_en', code: 'min_length' });
    if (patch.date && C().holidays.some((x) => x.id !== h.id && x.date === patch.date)) return problem(409, 'duplicate', 'A holiday exists on this date', { errors: [{ path: '/date', code: 'duplicate' }] });
    Object.assign(h, patch, { version: h.version + 1 }); save();
    return changed(h);
  }),
  http.delete(`${B}/settings/holidays/:id`, ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const h = C().holidays.find((x) => x.id === params.id); if (!h) return problem(404, 'not_found', 'Holiday not found');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    if (!stepUpValid()) return stepUp();
    const r = reasonErr(new URL(request.url).searchParams.get('reason') ?? ''); if (r) return r;
    const p = ver(request, h.version); if (p) return p;
    C().holidays = C().holidays.filter((x) => x.id !== h.id); save();
    return changed(h);
  }),
  http.post(`${B}/settings/holidays/:id/confirm`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const h = C().holidays.find((x) => x.id === params.id); if (!h) return problem(404, 'not_found', 'Holiday not found');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, h.version); if (p) return p;
    const b = await body<{ date?: string; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    if (!h.tentative) return problem(409, 'invalid_transition', 'Already confirmed');
    Object.assign(h, { tentative: false, date: b.date ?? h.date, confirmed_at: new Date().toISOString(), confirmed_by: me(), version: h.version + 1 }); save();
    return changed(h);
  }),
  http.put(`${B}/settings/weekend-days`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ weekend_days?: number[]; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    const d = b.weekend_days ?? [];
    if (!d.length || d.length > 6 || new Set(d).size !== d.length || d.some((x) => !int(x, 0, 6))) return fields({ path: '/weekend_days', code: 'invalid' });
    C().weekend = { days: [...d].sort(), version: C().weekend.version + 1 }; save();
    return HttpResponse.json({ calendar_code: 'LY', weekend_days: C().weekend.days, affected_open_tasks: 12, version: C().weekend.version });
  }),

  // ------------------------------------------------------------------ rules (read-only in the contract)
  http.get(`${B}/settings/sla-rules`, () => { const g = guard(); if (g) return g; return page(SLA); }),
  http.get(`${B}/settings/weight-sets`, ({ request }) => {
    const g = guard(); if (g) return g;
    const code = new URL(request.url).searchParams.get('code');
    return HttpResponse.json({ items: WEIGHTS.filter((w) => !code || w.code === code) });
  }),

  // ------------------------------------------------------------------ freeze
  http.get(`${B}/settings/structural-freeze`, () => { const g = guard(); if (g) return g; return HttpResponse.json(C().freeze, tag(C().freeze.version)); }),
  http.post(`${B}/settings/structural-freeze/lift`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const f = C().freeze, p = ver(request, f.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ reason?: string; confirm_text?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    if (b.confirm_text === undefined) return fields({ path: '/confirm_text', code: 'required' });
    if (b.confirm_text !== 'structural-freeze') return problem(422, 'confirmation_mismatch', 'The typed confirmation does not match', { errors: [{ path: '/confirm_text', code: 'confirmation_mismatch' }] });
    if (f.lifted) return problem(409, 'invalid_transition', 'Already lifted');
    Object.assign(f, { active: false, lifted: true, lifted_at: new Date().toISOString(), lifted_by: me(), lift_reason: b.reason!.trim(), version: f.version + 1 }); save();
    return HttpResponse.json(f, tag(f.version));
  }),

  // ------------------------------------------------------------------ DLP and idle days
  http.get(`${B}/settings/dlp`, () => { const g = guard(); if (g) return g; return HttpResponse.json(C().dlp); }),
  http.post(`${B}/settings/dlp/versions`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ cw_months?: number; te_months?: number; effective_from?: string; reason?: string }>(request);
    const errs: { path: string; code: string }[] = [];
    if (!int(b.cw_months, 0, 120)) errs.push({ path: '/cw_months', code: 'out_of_range' });
    if (!int(b.te_months, 0, 120)) errs.push({ path: '/te_months', code: 'out_of_range' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effective_from ?? '')) errs.push({ path: '/effective_from', code: 'required' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    const v = { version: C().dlp.current.version + 1, cw_months: b.cw_months!, te_months: b.te_months!, effective_from: b.effective_from!, reason: b.reason!.trim(), changed_by: me(), changed_at: new Date().toISOString() };
    C().dlp = { current: v, history: [v, ...C().dlp.history] }; save();
    return HttpResponse.json(v, { status: 201 });
  }),
  http.get(`${B}/settings/idle-task-alert`, () => { const g = guard(); if (g) return g; return HttpResponse.json(C().idle, tag(C().idle.version)); }),
  http.put(`${B}/settings/idle-task-alert`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const p = ver(request, C().idle.version); if (p) return p;
    const b = await body<{ enabled?: boolean; working_days?: number; reason?: string }>(request);
    const errs: { path: string; code: string }[] = [];
    if (!int(b.working_days, 1, 30)) errs.push({ path: '/working_days', code: 'out_of_range' });
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    C().idle = { enabled: b.enabled!, working_days: b.working_days!, version: C().idle.version + 1, updated_by: me() }; db().admin.idleDays = b.working_days!; save();
    return HttpResponse.json(C().idle, tag(C().idle.version));
  }),

  // ------------------------------------------------------------------ notification policy
  http.get(`${B}/settings/notification-policy/catalogue`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json({ items: CATALOGUE }); }),
  http.get(`${B}/settings/notification-policy`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json(C().policy, tag(C().policy.version)); }),
  http.put(`${B}/settings/notification-policy`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const cur = C().policy, p = ver(request, cur.version); if (p) return p;
    const b = await body<NotificationPolicyInput & Record<string, unknown>>(request);
    const r = reasonErr(b.reason); if (r) return r;
    const errs = validatePolicy(b); if (errs.length) return fields(...errs);
    // Security and system rows and the rate cap are System-Admin-only (no delegate) and need step-up.
    const sensitive = JSON.stringify(b.matrix.filter((m) => ['security', 'system'].includes(CATALOGUE.find((c) => c.code === m.type_code)!.category))) !== JSON.stringify(cur.matrix.filter((m) => ['security', 'system'].includes(CATALOGUE.find((c) => c.code === m.type_code)!.category)).map(({ mandatory: _m, ...x }) => (void _m, x)))
      || b.thresholds.rate_cap_per_hour !== cur.thresholds.rate_cap_per_hour;
    if (sensitive) {
      if (C().actingDelegate) return problem(403, 'delegate_forbidden', 'Only a System Admin acting without delegation may change this');
      if (!stepUpValid()) return stepUp();
    }
    C().policy = { ...cur, ...b, matrix: b.matrix, columns: b.columns ?? cur.columns, work_days: b.work_days_follow_calendar ? [0, 1, 2, 3, 4] : b.work_days ?? cur.work_days, version: cur.version + 1, updated_by: me() } as never; delete (C().policy as never as Record<string, unknown>).reason; save();
    return HttpResponse.json(C().policy, tag(C().policy.version));
  }),

  // ------------------------------------------------------------------ log retention
  http.get(`${B}/settings/log-retention`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json(C().retention, tag(C().retention.version)); }),
  http.put(`${B}/settings/log-retention`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const cur = C().retention, p = ver(request, cur.version); if (p) return p;
    const b = await body<Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = [];
    for (const k of Object.keys(b)) if (!['reason', 'system_log_days', 'security_log_days'].includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
    if (!int(b.system_log_days, 90, 3650)) errs.push({ path: '/system_log_days', code: 'below_minimum' });
    if (!int(b.security_log_days, 365, 3650)) errs.push({ path: '/security_log_days', code: 'below_minimum' });
    if (String(b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    const reduced = (b.system_log_days as number) < cur.system_log_days || (b.security_log_days as number) < cur.security_log_days;
    if (reduced && !stepUpValid()) return stepUp();
    C().retention = { ...cur, system_log_days: b.system_log_days as number, security_log_days: b.security_log_days as number, version: cur.version + 1, updated_by: me() };
    if (reduced) db().notifications.unshift({ id: crypto.randomUUID(), kind: 'system', title: 'Mandatory alert: log retention was reduced', created_at: new Date().toISOString(), read_at: null, link: '/admin/settings/retention' } as never);
    save();
    return HttpResponse.json(C().retention, tag(C().retention.version));
  }),

  // ------------------------------------------------------------------ staff field visibility (item 8)
  http.get(`${B}/staff-registry/visibility`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json(C().visibility, tag(C().visibility.version)); }),
  http.put(`${B}/staff-registry/visibility`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ fields?: Record<string, unknown>; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    if (!b.fields || !Object.keys(b.fields).length) return fields({ path: '/fields', code: 'required' });
    Object.assign(C().visibility.fields, b.fields); C().visibility.version += 1; save();
    return HttpResponse.json(C().visibility, tag(C().visibility.version));
  }),
  http.patch(`${B}/staff-registry/:emp`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!byIdSafe(params.emp as string)) return problem(404, 'not_found', 'Not in the registry');
    if (!stepUpValid()) return stepUp();
    const b = await body<{ hidden_fields?: string[]; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    C().hidden[params.emp as string] = b.hidden_fields ?? []; save();
    return HttpResponse.json({ employee_id: params.emp, hidden_fields: C().hidden[params.emp as string], version: 2 });
  }),

  // ------------------------------------------------------------------ security log, integrity, jobs
  http.get(`${B}/security-log`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin() && viewer()?.key !== 'auditor') return problem(403, 'action_forbidden', 'Needs view_security_log');
    const u = new URL(request.url).searchParams, ev = (u.get('event') ?? '').split(',').filter(Boolean), q = (u.get('q') ?? '').toLowerCase(), from = u.get('from'), to = u.get('to'), out = u.get('outcome');
    C().secLogReads += 1; save(); // every read is audited server-side
    const items = SEC_FILTER({ ev, q, from, to, out }).map((e) => (isAdmin() ? e : { ...e, ip: null }));
    return page(items);
  }),
  http.post(`${B}/security-log/exports`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Needs the export grant');
    await request.json().catch(() => ({}));
    const id = `job-${crypto.randomUUID().slice(0, 8)}`; C().jobs[id] = { polls: 0 }; save();
    return HttpResponse.json({ id, kind: 'security_export', status: 'queued' }, { status: 202 });
  }),
  http.get(`${B}/jobs/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const j = C().jobs[params.id as string]; if (!j) return problem(404, 'not_found', 'Job not found');
    j.polls += 1; save();
    const done = j.polls >= 2;
    return HttpResponse.json({ id: params.id, kind: 'security_export', status: done ? 'done' : 'running', progress: done ? 1 : 0.5, result_file_id: done ? '9a000000-0000-4000-8000-000000000001' : null });
  }),
  http.get(`${B}/files/9a000000-0000-4000-8000-000000000001/download`, () => {
    const g = guard(); if (g) return g;
    return new HttpResponse('id,at,event,outcome\n', { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="security-log.csv"' } });
  }),
  ...(['audit', 'security'] as const).map((log) => http.get(`${B}/${log}-log/integrity`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const u = new URL(request.url).searchParams, f = u.get('from_seq'), t = u.get('to_seq');
    if (f && t && Number(t) < Number(f)) return fields({ path: '/to_seq', code: 'before_from_seq' });
    const n = log === 'audit' ? 1842 : SEC_LOG_LEN(), broken = C().tampered && log === 'security';
    return HttpResponse.json({
      log, status: broken ? 'broken' : 'ok', row_count: n, first_seq: 1, last_seq: n, head_hash: (log === 'audit' ? 'a1' : 'b2').repeat(32), checked_at: new Date().toISOString(),
      breaks: broken ? [{ seq: 17, kind: 'hash_mismatch', expected_hash: 'c3'.repeat(32), found_hash: 'd4'.repeat(32) }] : [],
    });
  })),
  http.post(`${B}/__mock/tamper`, () => { C().tampered = true; save(); return new HttpResponse(null, { status: 204 }); }),
  http.post(`${B}/__mock/acting-delegate`, async ({ request }) => { C().actingDelegate = !!(await body<{ on?: boolean }>(request)).on; save(); return new HttpResponse(null, { status: 204 }); }),

  // ------------------------------------------------------------------ online now
  http.get(`${B}/sessions/active`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const u = new URL(request.url).searchParams, st = u.get('status'), q = (u.get('q') ?? '').toLowerCase(), now = Date.now();
    const items = C().sessions.map((s) => ({
      session_id: s.id, user: ref(s.emp), status: s.idleMin < 5 ? 'online' : 'idle', last_activity_at: new Date(now - s.idleMin * 60_000).toISOString(), current_screen: s.screen,
      signed_in_at: new Date(now - 3 * 3600e3).toISOString(), client_type: s.client, ip: `10.20.1.${s.emp.slice(-2)}`, is_current: !!s.current && s.emp === viewer()!.employee_id,
    })).filter((s) => (!st || s.status === st) && (!q || `${s.user.display_name} ${s.user.employee_id}`.toLowerCase().includes(q)));
    return page(items);
  }),
  http.post(`${B}/sessions/:id/revoke`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const s = C().sessions.find((x) => x.id === params.id); if (!s) return problem(404, 'not_found', 'Session not found');
    if (s.current && s.emp === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'Use sign out for your own session');
    if (!stepUpValid()) return stepUp();
    const r = reasonErr((await body<{ reason?: string }>(request)).reason); if (r) return r;
    C().sessions = C().sessions.filter((x) => x.id !== s.id); save();
    return HttpResponse.json({ user: ref(s.emp), revoked_count: 1 });
  }),
  http.post(`${B}/users/:uid/sessions/revoke`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const rows = C().sessions.filter((x) => uid(x.emp) === params.uid && !(x.current && x.emp === viewer()!.employee_id));
    if (!C().sessions.some((x) => uid(x.emp) === params.uid)) return problem(404, 'not_found', 'User has no sessions');
    if (!stepUpValid()) return stepUp();
    const r = reasonErr((await body<{ reason?: string }>(request)).reason); if (r) return r;
    C().sessions = C().sessions.filter((x) => !rows.includes(x)); save();
    return HttpResponse.json({ user: ref(rows[0]?.emp ?? '1001'), revoked_count: rows.length });
  }),
];

import { SEC_LOG } from './settingsData';
const SEC_LOG_LEN = () => SEC_LOG.length;
const byIdSafe = (e: string) => { try { return byId(e); } catch { return null; } };
function SEC_FILTER({ ev, q, from, to, out }: { ev: string[]; q: string; from: string | null; to: string | null; out: string | null }): SecurityLogEntry[] {
  return SEC_LOG.filter((e) => (!ev.length || ev.includes(e.event)) && (!out || e.outcome === out) && (!from || e.at >= from) && (!to || e.at <= to)
    && (!q || `${e.user?.display_name ?? ''} ${e.user?.employee_id ?? ''} ${e.identifier_masked ?? ''} ${e.request_id ?? ''}`.toLowerCase().includes(q)));
}
