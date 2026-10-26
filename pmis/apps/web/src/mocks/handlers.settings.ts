// MSW handlers for phase 3b: work calendar, rules, freeze, DLP, idle days, notification policy, log retention,
// staff visibility, security log, integrity, online now. Synthetic data; validation mirrors the contract.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Holiday, NotificationPolicyInput, SecurityLogEntry, SlaPublishPreview, SlaRuleSet, SlaTaskRule, WeightSet } from '@/api/types';
import { tripoliToday } from '@/lib/today';
import { weightIssues } from '@/lib/weights';
import { db, save, stepUpValid, viewer } from './db';
import { guard, page, problem, stepUp } from './handlers';
import { byId, uid } from './ids';
import { CALENDAR_CODES, CATALOGUE, GATES, MILESTONES, OPEN_TASKS, SCENARIOS, START_EVENT_CODES, TASK_DEFS, type SlaSetRec, type WeightRec } from './settingsData';

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

// ---- 0.2.6 helpers: rule sets and weight sets
const slaOut = ({ _rev, ...x }: SlaSetRec): SlaRuleSet => (void _rev, x);
const slaSummary = ({ rules, ...x }: SlaRuleSet) => (void rules, ((s) => { delete (s as { _rev?: number })._rev; return s; })({ ...x }));
const wOut = ({ _rev, ...x }: WeightRec): WeightSet => (void _rev, x);
const canon = (rules: SlaTaskRule[]) => [...rules].sort((a, b) => a.task_code.localeCompare(b.task_code)).map((r) => ({ ...r, overrides: r.overrides ?? [] }));
const wCanon = (w: WeightSet) => w.activities.map((a) => ({ c: a.code, w: a.weight, n: a.name_en, na: a.name_ar ?? null, i: a.items.map((i) => [i.code, i.weight, i.name_en, i.name_ar ?? null, i.unit ?? null, i.measure_rule ?? null]) }));

/** Effective date rules shared by the previews and the publishes: required, not in the past (Africa/Tripoli), after the latest published version. */
function dateErrs(d: string | undefined, kind: 'sla' | 'weights', code?: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) return [{ path: '/effective_date', code: 'required' }];
  if (d! < tripoliToday()) return [{ path: '/effective_date', code: 'effective_date_in_past' }];
  const last = (kind === 'sla' ? C().slaSets : C().weightSets.filter((w) => w.code === code)).filter((s) => s.status === 'published').map((s) => s.effective_from!).sort().pop();
  return last && d! <= last ? [{ path: '/effective_date', code: 'effective_date_not_after_current' }] : [];
}

/** Closed-schema validation of SLA rule items; `min_exceeds_max` sits on the max_working_days path. Exported for unit tests. */
export function validateSlaRules(rules: (SlaTaskRule & { __i?: number })[]) {
  const errs: { path: string; code: string }[] = [], seen = new Set<string>();
  const KEYS = ['task_code', 'min_working_days', 'max_working_days', 'start_event', 'calendar_code', 'overrides'], OKEYS = ['scenario', 'region_id', 'min_working_days', 'max_working_days'];
  rules.forEach((r, n) => {
    const i = r.__i ?? n, P = `/rules/${i}`;
    for (const k of Object.keys(r)) if (k !== '__i' && !KEYS.includes(k)) errs.push({ path: `${P}/${k}`, code: 'unknown_key' });
    if (!TASK_DEFS.some((t) => t.code === r.task_code)) errs.push({ path: `${P}/task_code`, code: 'unknown_task_code' });
    else if (seen.has(r.task_code)) errs.push({ path: `${P}/task_code`, code: 'duplicate_task_code' });
    seen.add(r.task_code);
    for (const k of ['min_working_days', 'max_working_days'] as const) if (!int(r[k], 0, 365)) errs.push({ path: `${P}/${k}`, code: 'out_of_range' });
    if (int(r.min_working_days, 0, 365) && int(r.max_working_days, 0, 365) && r.min_working_days > r.max_working_days) errs.push({ path: `${P}/max_working_days`, code: 'min_exceeds_max' });
    if (!START_EVENT_CODES.has(r.start_event)) errs.push({ path: `${P}/start_event`, code: 'unknown_start_event' });
    if (!CALENDAR_CODES.includes(r.calendar_code)) errs.push({ path: `${P}/calendar_code`, code: 'unknown_calendar' });
    const keys = new Set<string>();
    (r.overrides ?? []).forEach((o, j) => {
      const O = `${P}/overrides/${j}`;
      for (const k of Object.keys(o)) if (!OKEYS.includes(k)) errs.push({ path: `${O}/${k}`, code: 'unknown_key' });
      if (o.scenario === undefined && o.region_id === undefined) errs.push({ path: `${O}/scenario`, code: 'required' });
      if (o.scenario !== undefined && !SCENARIOS.includes(o.scenario)) errs.push({ path: `${O}/scenario`, code: 'invalid' });
      if (o.region_id !== undefined && !int(o.region_id, 1, 7)) errs.push({ path: `${O}/region_id`, code: 'invalid' });
      for (const k of ['min_working_days', 'max_working_days'] as const) if (!int(o[k], 0, 365)) errs.push({ path: `${O}/${k}`, code: 'out_of_range' });
      if (int(o.min_working_days, 0, 365) && int(o.max_working_days, 0, 365) && o.min_working_days > o.max_working_days) errs.push({ path: `${O}/max_working_days`, code: 'min_exceeds_max' });
      const key = `${o.scenario ?? ''}|${o.region_id ?? ''}`;
      if (keys.has(key)) errs.push({ path: `${O}/scenario`, code: 'duplicate_override' });
      keys.add(key);
    });
  });
  return errs;
}

/** Counts how many open tasks change when the draft is applied to them (rules that differ from the version in force). */
function slaPreview(x: SlaRuleSet, effective_date: string): SlaPublishPreview {
  const cur = C().slaSets.find((s) => s.is_active)!, SITES = ['TR204', 'MI129', 'WM105', 'ZW310', 'BG220', 'SB121'];
  const by = x.rules.map((r) => {
    const o = cur.rules.find((c) => c.task_code === r.task_code), open = OPEN_TASKS[r.task_code] ?? 0;
    const diff = JSON.stringify(canon(o ? [o] : [])) !== JSON.stringify(canon([r]));
    return { r, o, open, changed: diff ? open : 0 };
  });
  const samples: SlaPublishPreview['samples'] = [];
  by.forEach(({ r, o, changed }) => { for (let k = 0; k < changed && samples.length < 20; k++) { const delta = r.max_working_days - (o?.max_working_days ?? r.max_working_days); samples.push({ task_id: crypto.randomUUID(), site_code: SITES[(samples.length) % SITES.length], task_code: r.task_code, due_date_before: `2026-11-${String(2 + k).padStart(2, '0')}`, due_date_after: `2026-11-${String(Math.max(1, 2 + k + delta)).padStart(2, '0')}` }); } });
  const late = (f: (d: number) => boolean) => by.reduce((n, { r, o, changed }) => n + (o && f(r.max_working_days - o.max_working_days) ? Math.ceil(changed * 0.3) : 0), 0);
  return {
    set_id: x.id, effective_date, open_tasks_total: Object.values(OPEN_TASKS).reduce((a, b) => a + b, 0), changed_due_date_count: by.reduce((n, b) => n + b.changed, 0),
    became_late_count: late((d) => d < 0), no_longer_late_count: late((d) => d > 0), by_task: by.map(({ r, open, changed }) => ({ task_code: r.task_code, open_tasks: open, changed })), samples,
  };
}

type WeightInput = { reason: string; activities: { code: string; name_en: string; name_ar?: string | null; weight: number; items?: { code: string; name_en: string; name_ar?: string | null; weight: number; unit?: string | null; measure_rule?: string | null; source?: string | null }[] }[] } & Record<string, unknown>;
const w3 = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 100 && Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6;
const CODE = /^[A-Za-z0-9._-]{1,20}$/;
/** Closed-schema checks of a weight set body (not the 100% rule, which the preview and publish apply). */
export function validateWeightInput(b: WeightInput) {
  const errs: { path: string; code: string }[] = [];
  for (const k of Object.keys(b)) if (!['reason', 'activities'].includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
  if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
  if (!Array.isArray(b.activities) || !b.activities.length || b.activities.length > 50) return [...errs, { path: '/activities', code: 'required' }];
  const AK = ['code', 'name_en', 'name_ar', 'weight', 'items'], IK = ['code', 'name_en', 'name_ar', 'weight', 'unit', 'measure_rule', 'source'], codes = new Set<string>();
  b.activities.forEach((a, i) => {
    const P = `/activities/${i}`;
    for (const k of Object.keys(a)) if (!AK.includes(k)) errs.push({ path: `${P}/${k}`, code: 'unknown_key' });
    if (!CODE.test(a.code ?? '')) errs.push({ path: `${P}/code`, code: 'invalid' }); else if (codes.has(a.code)) errs.push({ path: `${P}/code`, code: 'duplicate' });
    codes.add(a.code);
    if (!(a.name_en ?? '').trim()) errs.push({ path: `${P}/name_en`, code: 'required' });
    if (!w3(a.weight)) errs.push({ path: `${P}/weight`, code: 'out_of_range' });
    const ic = new Set<string>();
    (a.items ?? []).forEach((it, j) => {
      const Q = `${P}/items/${j}`;
      for (const k of Object.keys(it)) if (!IK.includes(k)) errs.push({ path: `${Q}/${k}`, code: 'unknown_key' });
      if (!CODE.test(it.code ?? '')) errs.push({ path: `${Q}/code`, code: 'invalid' }); else if (ic.has(it.code)) errs.push({ path: `${Q}/code`, code: 'duplicate' });
      ic.add(it.code);
      if (!(it.name_en ?? '').trim()) errs.push({ path: `${Q}/name_en`, code: 'required' });
      if (!w3(it.weight)) errs.push({ path: `${Q}/weight`, code: 'out_of_range' });
    });
  });
  return errs;
}
/** The 100% rule per level, with the paths of the contract. Reuses the screen's weightIssues. */
export function weightErrors(set: Pick<WeightSet, 'activities'>) {
  return weightIssues(set).map((i) => ({ path: i.level === 'activities' ? '/activities' : `/activities/${set.activities.findIndex((a) => a.code === i.activity)}/items`, code: 'weights_must_total_100', message: `Total is ${i.sum}, not 100` }));
}
const DONE: Record<string, number> = { a1: 100, a2: 90, a3: 70, a4: 55, a5: 40, a6: 20, a7: 10, a8: 0 };
const contrib = (a?: { code: string; weight: number }) => (a ? Math.round(a.weight * (DONE[a.code] ?? 50)) / 100 : 0);
const progress = (s: Pick<WeightSet, 'activities'>) => Math.round(s.activities.reduce((n, a) => n + contrib(a), 0) * 10) / 10;

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
    const form = await request.formData().catch(() => null);
    if (String(form?.get('reason') ?? '').trim().length < 3) return fields({ path: '/reason', code: 'required' });
    const f = form?.get('file'); // checked by size, not name: jsdom files lose their name through undici
    if (!f || typeof f === 'string' || !f.size) return problem(422, 'template_rejected', 'Not an approved template', { reason: 'tpl_missing' } as never);
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

  // ------------------------------------------------------------------ SLA rule sets (0.2.6)
  http.get(`${B}/settings/sla-rules`, () => {
    const g = guard(); if (g) return g;
    const act = C().slaSets.find((x) => x.is_active)!;
    return page(act.rules.map((r, i) => ({ id: `99100000-0000-4000-8000-0000000000${10 + i}`, ...r, effective_from: act.effective_from!, reason: act.reason, open_task_count: OPEN_TASKS[r.task_code] ?? 0, set_version: act.version })));
  }),
  http.get(`${B}/workflow/versions`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: [{ version: 1, status: 'published', is_current: true, light_revision: 1, parent_version: null, site_count: 150 }] }); }),
  http.get(`${B}/workflow/versions/:v`, ({ params }) => {
    const g = guard(); if (g) return g;
    if (params.v !== '1') return problem(404, 'not_found', 'Version not found');
    return HttpResponse.json({ version: 1, status: 'published', is_current: true, light_revision: 1, milestones: MILESTONES, gates: GATES, placements: TASK_DEFS.map((t) => ({ task_code: t.code, stage_code: t.stage_code, sort_order: t.sort_order })) });
  }),
  http.get(`${B}/settings/task-definitions`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: TASK_DEFS }); }),
  http.get(`${B}/settings/sla-rule-sets`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const st = new URL(request.url).searchParams.get('status');
    return page(C().slaSets.filter((x) => !st || x.status === st).sort((a, b) => b.version - a.version).map(slaSummary));
  }),
  http.post(`${B}/settings/sla-rule-sets`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ reason?: string }>(request);
    const unk = Object.keys(b).filter((k) => k !== 'reason').map((k) => ({ path: `/${k}`, code: 'unknown_key' }));
    if (unk.length) return fields(...unk);
    const r = reasonErr(b.reason); if (r) return r;
    if (C().slaSets.some((x) => x.status === 'draft')) return problem(409, 'duplicate', 'A draft already exists', { errors: [{ path: '/', code: 'duplicate' }] });
    const base = C().slaSets.find((x) => x.is_active)!;
    const d: SlaSetRec = { ...base, id: crypto.randomUUID(), version: Math.max(...C().slaSets.map((x) => x.version)) + 1, status: 'draft', is_active: false, effective_from: null, effective_to: null, base_version: base.version, reason: b.reason!.trim(), created_by: me(), created_at: new Date().toISOString(), published_by: null, published_at: null, apply_to_open_tasks: null, affected_open_tasks: null, rules: structuredClone(base.rules), _rev: 1 };
    C().slaSets.push(d); save();
    return HttpResponse.json(slaOut(d), { status: 201, ...tag(d._rev) });
  }),
  http.get(`${B}/settings/sla-rule-sets/:id`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().slaSets.find((s) => s.id === params.id); if (!x) return problem(404, 'not_found', 'Rule set not found');
    return HttpResponse.json(slaOut(x), tag(x._rev));
  }),
  http.patch(`${B}/settings/sla-rule-sets/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().slaSets.find((s) => s.id === params.id); if (!x) return problem(404, 'not_found', 'Rule set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be changed');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, x._rev); if (p) return p;
    const b = await body<{ reason?: string; rules?: SlaTaskRule[] } & Record<string, unknown>>(request);
    const unk = Object.keys(b).filter((k) => !['reason', 'rules'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_key' }));
    if (unk.length) return fields(...unk);
    const r = reasonErr(b.reason); if (r) return r;
    if (!Array.isArray(b.rules) || !b.rules.length) return fields({ path: '/rules', code: 'required' });
    const errs = validateSlaRules(b.rules); if (errs.length) return fields(...errs);
    for (const nr of b.rules) { const i = x.rules.findIndex((o) => o.task_code === nr.task_code); if (i < 0) x.rules.push(nr); else x.rules[i] = nr; }
    Object.assign(x, { reason: b.reason!.trim(), rule_count: x.rules.length, _rev: x._rev + 1 }); save();
    return HttpResponse.json(slaOut(x), tag(x._rev));
  }),
  http.post(`${B}/settings/sla-rule-sets/:id/preview`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().slaSets.find((s) => s.id === params.id); if (!x) return problem(404, 'not_found', 'Rule set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be previewed');
    const b = await body<{ effective_date?: string }>(request);
    const e = dateErrs(b.effective_date, 'sla'); if (e.length) return fields(...e);
    return HttpResponse.json(slaPreview(x, b.effective_date!));
  }),
  http.post(`${B}/settings/sla-rule-sets/:id/publish`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().slaSets.find((s) => s.id === params.id); if (!x) return problem(404, 'not_found', 'Rule set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be published');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, x._rev); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ effective_date?: string; reason?: string; apply_to_open_tasks?: unknown } & Record<string, unknown>>(request);
    const unk = Object.keys(b).filter((k) => !['effective_date', 'reason', 'apply_to_open_tasks'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_key' }));
    const errs = [...unk, ...((b.reason ?? '').trim().length < 3 ? [{ path: '/reason', code: 'required' }] : []), ...dateErrs(b.effective_date, 'sla'), ...validateSlaRules(x.rules.map((r, i) => ({ ...r, __i: i })))];
    if (b.apply_to_open_tasks !== undefined && typeof b.apply_to_open_tasks !== 'boolean') errs.push({ path: '/apply_to_open_tasks', code: 'invalid' });
    if (!errs.length && JSON.stringify(canon(x.rules)) === JSON.stringify(canon(C().slaSets.find((s) => s.is_active)!.rules))) errs.push({ path: '/', code: 'no_changes' });
    if (errs.length) return fields(...errs);
    // A regional delegate may re-point open tasks only in their own regions; the mock treats any delegate as regional.
    if (b.apply_to_open_tasks && C().actingDelegate) return problem(403, 'action_forbidden', 'A regional delegate can apply a rule only to open tasks in their regions');
    const apply = b.apply_to_open_tasks === true, n = apply ? slaPreview(x, b.effective_date!).changed_due_date_count : 0;
    const today = tripoliToday(), prev = C().slaSets.find((s) => s.is_active)!;
    prev.effective_to = b.effective_date!;
    if (b.effective_date! <= today) { prev.is_active = false; x.is_active = true; }
    Object.assign(x, { status: 'published', effective_from: b.effective_date!, reason: b.reason!.trim(), published_by: me(), published_at: new Date().toISOString(), apply_to_open_tasks: apply, affected_open_tasks: n, _rev: x._rev + 1 }); save();
    return HttpResponse.json({ rule_set: slaSummary(x), affected_open_tasks: n, recalculation_job_id: n ? `job-${crypto.randomUUID().slice(0, 8)}` : null });
  }),

  // ------------------------------------------------------------------ weight sets (0.2.6)
  http.get(`${B}/settings/weight-sets`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, code = u.get('code'), st = u.get('status');
    return HttpResponse.json({ items: C().weightSets.filter((w) => (!code || w.code === code) && (!st || w.status === st)).sort((a, b) => a.code.localeCompare(b.code) || b.version - a.version).map(wOut) });
  }),
  http.post(`${B}/settings/weight-sets`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ code?: string; base_set_id?: string; reason?: string } & Record<string, unknown>>(request);
    const errs = [...Object.keys(b).filter((k) => !['code', 'base_set_id', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_key' })), ...(['project_status', 'health_index', 'delay_attribution'].includes(b.code ?? '') ? [] : [{ path: '/code', code: 'required' }]), ...((b.reason ?? '').trim().length < 3 ? [{ path: '/reason', code: 'required' }] : [])];
    if (errs.length) return fields(...errs);
    if (C().weightSets.some((w) => w.code === b.code && w.status === 'draft')) return problem(409, 'duplicate', 'A draft of this set already exists', { errors: [{ path: '/code', code: 'duplicate' }] });
    const base = b.base_set_id ? C().weightSets.find((w) => w.id === b.base_set_id) : C().weightSets.find((w) => w.code === b.code && w.is_active);
    if (!base) return problem(404, 'not_found', 'No set to copy');
    if (base.code !== b.code) return fields({ path: '/base_set_id', code: 'invalid' });
    const d: WeightRec = { ...structuredClone(base), id: crypto.randomUUID(), version: Math.max(...C().weightSets.filter((w) => w.code === b.code).map((w) => w.version)) + 1, status: 'draft', is_active: false, effective_from: tripoliToday(), effective_to: null, reason: b.reason!.trim(), changed_by: me(), created_at: new Date().toISOString(), published_at: null, _rev: 1 };
    C().weightSets.push(d); save();
    return HttpResponse.json(wOut(d), { status: 201, ...tag(d._rev) });
  }),
  http.get(`${B}/settings/weight-sets/:id`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().weightSets.find((w) => w.id === params.id); if (!x) return problem(404, 'not_found', 'Weight set not found');
    return HttpResponse.json(wOut(x), tag(x._rev));
  }),
  http.put(`${B}/settings/weight-sets/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().weightSets.find((w) => w.id === params.id); if (!x) return problem(404, 'not_found', 'Weight set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be changed');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, x._rev); if (p) return p;
    const b = await body<WeightInput>(request);
    const errs = validateWeightInput(b); if (errs.length) return fields(...errs);
    // A draft may be saved while the totals are not 100; the preview reports it and the publish refuses it.
    x.activities = b.activities.map((a) => ({ code: a.code, name_en: a.name_en, name_ar: a.name_ar ?? null, weight: a.weight, items: (a.items ?? []).map((i) => ({ code: i.code, name_en: i.name_en, name_ar: i.name_ar ?? null, weight: i.weight, unit: i.unit ?? null, measure_rule: i.measure_rule ?? null, source: i.source ?? null })) }));
    Object.assign(x, { reason: b.reason.trim(), changed_by: me(), _rev: x._rev + 1 }); save();
    return HttpResponse.json(wOut(x), tag(x._rev));
  }),
  http.post(`${B}/settings/weight-sets/:id/preview`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().weightSets.find((w) => w.id === params.id); if (!x) return problem(404, 'not_found', 'Weight set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be previewed');
    const errors = weightErrors(x), cur = C().weightSets.find((w) => w.code === x.code && w.is_active);
    const prog = x.code === 'project_status';
    return HttpResponse.json({
      valid: !errors.length, errors, progress_current_pct: prog && cur ? progress(cur) : null, progress_new_pct: prog && !errors.length ? progress(x) : null,
      ...(prog && cur ? { activities: x.activities.map((a) => ({ code: a.code, current_pct: contrib(cur.activities.find((c) => c.code === a.code)), new_pct: errors.length ? null : contrib(a) })) } : {}),
    });
  }),
  http.post(`${B}/settings/weight-sets/:id/publish`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().weightSets.find((w) => w.id === params.id); if (!x) return problem(404, 'not_found', 'Weight set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be published');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, x._rev); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ effective_date?: string; reason?: string } & Record<string, unknown>>(request);
    const prev = C().weightSets.find((w) => w.code === x.code && w.is_active);
    const errs = [...Object.keys(b).filter((k) => !['effective_date', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_key' })), ...((b.reason ?? '').trim().length < 3 ? [{ path: '/reason', code: 'required' }] : []),
      ...dateErrs(b.effective_date, 'weights', x.code), ...weightErrors(x).map(({ path, code, message }) => ({ path, code, message }))] as { path: string; code: string; message?: string }[];
    if (!errs.length && prev && JSON.stringify(wCanon(prev)) === JSON.stringify(wCanon(x))) errs.push({ path: '/', code: 'no_changes' });
    if (errs.length) return fields(...errs);
    const today = tripoliToday();
    if (prev) { prev.effective_to = b.effective_date!; if (b.effective_date! <= today) prev.is_active = false; }
    Object.assign(x, { status: 'published', is_active: b.effective_date! <= today, effective_from: b.effective_date!, reason: b.reason!.trim(), changed_by: me(), published_at: new Date().toISOString(), _rev: x._rev + 1 }); save();
    return HttpResponse.json({ weight_set: wOut(x), previous_set_id: prev?.id ?? null, recalculation_job_id: x.code === 'project_status' ? `job-${crypto.randomUUID().slice(0, 8)}` : null });
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
