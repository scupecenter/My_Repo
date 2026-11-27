// MSW handlers of My Work > Daily Plan (plan W7, contract 0.15.67). Synthetic sites and people; the rules mirror the database (migration 0149):
// L1 edits and adds or removes sites, L2 locks, a System Admin unlocks with a reason and a step-up; a row below target needs a reason.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { DailyPlanDay, DailyPlanRegion, DailyPlanRow, DailyPlanSettings } from '@/api/dailyPlan';
import { OVERRIDE_KEYS, OWNER_COLUMNS } from '@/lib/dailyPlan';
import { stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';

const B = API_BASE;
type Auto = Record<string, string | null>;
interface SiteSeed { id: string; code: string; name: string; region: number; auto: Auto; planned: string[]; actual: string[] }
interface Stored { overrides: Record<string, string>; reason: string | null; remark: string | null; removed: boolean; origin: 'auto' | 'added' }
interface Plan { version: number; locked: boolean; lock_kind: 'manual' | 'auto' | null; rows: Map<string, Stored>; unlocked: boolean }

const REGIONS: Record<number, { code: string; en: string; ar: string }> = { 1: { code: 'TRIPOLI', en: 'Tripoli', ar: 'طرابلس' }, 5: { code: 'BENGHAZI', en: 'Benghazi', ar: 'بنغازي' } };
const base = (code: string, region: number, owner: string, contractor: string, se: string): Auto => ({
  tower_owner: owner, owner_id: `OWN-${code}`, latitude: region === 1 ? '32.887200' : '32.116700', longitude: region === 1 ? '13.191300' : '20.066700',
  site_type: 'Greenfield', sow: 'New Build: Tower Erection, TE Full Scope', contractor, aat_se: se, access_valid: 'Yes (to 2026-12-31)',
});
/** The synthetic work of a day: the same sites every day, with the planned and done items. */
function seeds(): SiteSeed[] {
  return [
    { id: '7d1a0000-0000-4000-8000-000000000001', code: 'TR101', name: 'Tripoli Port (synthetic)', region: 1, auto: base('TR101', 1, 'Libyana Towers (synthetic)', 'North Build Co (synthetic)', 'Demo User 06'),
      planned: ['B5 CW start', 'CW (PO-1001)'], actual: ['B5 CW start'] },
    { id: '7d1a0000-0000-4000-8000-000000000002', code: 'TR102', name: 'Souq Al Juma (synthetic)', region: 1, auto: base('TR102', 1, 'Aljeel (synthetic)', 'North Build Co (synthetic)', 'Demo User 02'),
      planned: ['B9 MOS'], actual: [] },
    { id: '7d1a0000-0000-4000-8000-000000000003', code: 'BG009', name: 'Benghazi Centre (synthetic)', region: 5, auto: { ...base('BG009', 5, 'Al Madar (synthetic)', 'East Works (synthetic)', 'Demo User 03'), access_valid: 'No' },
      planned: ['D2 TE installation'], actual: ['D2 TE installation'] },
  ];
}
const extraSite: SiteSeed = { id: '7d1a0000-0000-4000-8000-000000000004', code: 'TR150', name: 'Janzour (synthetic)', region: 1, auto: base('TR150', 1, 'Libyana Towers (synthetic)', 'In-House', 'Demo User 06'), planned: [], actual: [] };

const plans = new Map<string, Plan>();
let cfg: DailyPlanSettings = {
  columns: { progress: [...OWNER_COLUMNS.progress], tomorrow: [...OWNER_COLUMNS.tomorrow] }, default_region_scope: 'mine', auto_lock_time: null, reminder_hour: null, version: 0,
  known_columns: ['no', 'site_code', 'site_name', 'tower_owner', 'owner_id', 'latitude', 'longitude', 'region', 'site_type', 'sow', 'contractor', 'aat_se', 'access_valid', 'planned_work', 'actual_work', 'reason', 'remark'],
  default_columns: { progress: [...OWNER_COLUMNS.progress], tomorrow: [...OWNER_COLUMNS.tomorrow] },
};
/** Test hook: back to the seed. */
export function resetDailyPlanMock(): void {
  plans.clear();
  cfg = { ...cfg, columns: { progress: [...OWNER_COLUMNS.progress], tomorrow: [...OWNER_COLUMNS.tomorrow] }, default_region_scope: 'mine', auto_lock_time: null, reminder_hour: null, version: 0 };
}

const key = (date: string, region: number) => `${date}|${region}`;
const planAt = (date: string, region: number): Plan => {
  let p = plans.get(key(date, region));
  if (!p) plans.set(key(date, region), (p = { version: 0, locked: false, lock_kind: null, rows: new Map(), unlocked: false }));
  return p;
};
const isAdmin = () => viewer()?.key === 'pm';
const canEdit = () => !!viewer() && viewer()!.key !== 'auditor';
const workday = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 5 && w !== 6; };
const addWork = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); let k = Math.abs(n); while (k > 0) { x.setUTCDate(x.getUTCDate() + Math.sign(n)); if (workday(x.toISOString().slice(0, 10))) k--; } return x.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);
const lines = (s: string | null | undefined) => (s ?? '').split('\n').filter((x) => x.trim()).length;

function row(date: string, s: SiteSeed, st: Stored | undefined): DailyPlanRow {
  const auto: Auto = { ...s.auto, planned_work: s.planned.join('\n') || null, actual_work: s.actual.join('\n') || null };
  const ov = st?.overrides ?? {};
  const values: Record<string, string | null> = { site_code: s.code, site_name: s.name, region: REGIONS[s.region]!.en };
  for (const k of OVERRIDE_KEYS) values[k] = k in ov ? ov[k]! : auto[k] ?? null;
  const pc = 'planned_work' in ov ? lines(ov.planned_work) : s.planned.length;
  const ac = 'actual_work' in ov ? lines(ov.actual_work) : s.actual.length;
  const below = date <= today() && ac < pc;
  return {
    row_id: st ? `00000000-0000-4000-9000-${String(s.id).replace(/\D/g, '').padStart(12, '0').slice(-12)}` : null, region_id: s.region, site_id: s.id, site_code: s.code, site_name: s.name, origin: st?.origin ?? 'auto', values, auto,
    overridden: OVERRIDE_KEYS.filter((k) => k in ov), reason: st?.reason ?? null, remark: st?.remark ?? null,
    planned_items: s.planned.map((l) => ({ kind: 'task' as const, code: l.split(' ')[0]!, label: l })), actual_items: s.actual.map((l) => ({ kind: 'task' as const, code: l.split(' ')[0]!, label: l })),
    planned_count: pc, actual_count: ac, below_target: below, reason_missing: below && !(st?.reason ?? '').trim(), frozen: false,
  };
}
function rowsOf(date: string, region: number): DailyPlanRow[] {
  const p = planAt(date, region);
  const all = [...seeds(), extraSite].filter((s) => s.region === region);
  return all.filter((s) => {
    const st = p.rows.get(s.id);
    if (st?.removed) return false;
    return s.id !== extraSite.id || st?.origin === 'added';
  }).map((s) => ({ ...row(date, s, p.rows.get(s.id)), frozen: p.locked }));
}
function head(date: string, region: number, rows: DailyPlanRow[]): DailyPlanRegion {
  const p = planAt(date, region);
  return {
    plan_id: `00000000-0000-4000-a000-${date.replace(/\D/g, '')}${String(region).padStart(4, '0')}`, entity_locked: false, region_id: region, region_code: REGIONS[region]!.code, region_name_en: REGIONS[region]!.en, region_name_ar: REGIONS[region]!.ar, plan_date: date, version: p.version,
    locked: p.locked, lock_kind: p.lock_kind, locked_at: p.locked ? `${date}T15:00:00Z` : null, locked_by: p.locked && p.lock_kind === 'manual' ? { id: 'mock', display_name: viewer()?.name ?? 'Lead', employee_id: null } : null,
    unlocked_at: null, unlocked_by: null, updated_at: null, updated_by: null, row_count: rows.length, reason_missing_count: rows.filter((r) => r.reason_missing).length,
    can_edit: !p.locked && canEdit(), can_lock: !p.locked && canEdit(), can_unlock: p.locked && isAdmin(),
  };
}
function day(date: string, regions?: number[]): DailyPlanDay {
  const ids = Object.keys(REGIONS).map(Number).filter((r) => !regions || regions.includes(r));
  const rows = ids.flatMap((r) => rowsOf(date, r));
  return { date, today: today(), is_workday: workday(date), next_working_day: addWork(date, 1), previous_working_day: addWork(date, -1), my_region_ids: [1],
    plans: ids.map((r) => head(date, r, rows.filter((x) => x.region_id === r))), rows };
}
const ver = (req: Request, p: Plan) => {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  if (h.trim() !== '*' && h.replace(/"/g, '').trim() !== String(p.version)) return problem(412, 'precondition_failed', 'The plan changed');
  return null;
};
const fields = (...errors: { path: string; code: string }[]) => problem(422, 'validation_failed', 'The request is not valid', { errors: errors.map((e) => ({ ...e, message: e.code })) } as never);
const pre = (req: Request, date: string, region: number) => {
  const g = guard(); if (g) return { r: g };
  if (!REGIONS[region]) return { r: problem(404, 'not_found', 'The plan does not exist') };
  const p = planAt(date, region);
  const v = ver(req, p); if (v) return { r: v };
  if (p.locked) return { r: problem(409, 'plan_locked', 'The day is locked') };
  if (!canEdit()) return { r: problem(403, 'action_forbidden', 'Only the L1 holders edit the plan') };
  return { p };
};

export const dailyPlanHandlers = [
  http.get(`${B}/daily-plans`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url);
    const date = u.searchParams.get('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fields({ path: '/date', code: 'required' });
    const r = u.searchParams.getAll('region_id').map(Number);
    return HttpResponse.json(day(date, r.length ? r : undefined));
  }),
  http.get(`${B}/daily-plans/export`, () => {
    const g = guard(); if (g) return g;
    return new HttpResponse(new Uint8Array([80, 75, 3, 4]), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="Daily_Plan.xlsx"' } });
  }),
  http.patch(`${B}/daily-plans/:date/regions/:region/sites/:site`, async ({ request, params }) => {
    const date = String(params.date), region = Number(params.region);
    const { r, p } = pre(request, date, region); if (r) return r;
    const s = [...seeds(), extraSite].find((x) => x.id === params.site && x.region === region);
    if (!s) return problem(404, 'not_found', 'The site is not in this plan');
    const b = (await request.json()) as { overrides?: Record<string, string | null>; reason?: string | null; remark?: string | null };
    const cur: Stored = p!.rows.get(s.id) ?? { overrides: {}, reason: null, remark: null, removed: false, origin: 'auto' };
    const next: Stored = { ...cur, overrides: { ...cur.overrides } };
    for (const [k, v] of Object.entries(b.overrides ?? {})) { if (v === null) delete next.overrides[k]; else next.overrides[k] = v; }
    if ('reason' in b) next.reason = b.reason?.trim() || null;
    if ('remark' in b) next.remark = b.remark?.trim() || null;
    if (row(date, s, next).reason_missing) return fields({ path: '/reason', code: 'required' });
    p!.rows.set(s.id, next);
    p!.version++;
    return HttpResponse.json(day(date, [region]));
  }),
  http.post(`${B}/daily-plans/:date/regions/:region/sites`, async ({ request, params }) => {
    const date = String(params.date), region = Number(params.region);
    const { r, p } = pre(request, date, region); if (r) return r;
    const b = (await request.json()) as { site_code?: string };
    const s = [...seeds(), extraSite].find((x) => x.code.toLowerCase() === (b.site_code ?? '').trim().toLowerCase());
    if (!s || s.region !== region) return fields({ path: '/site_code', code: 'not_in_region' });
    const cur = p!.rows.get(s.id);
    const auto = s.id !== extraSite.id;
    if ((cur && !cur.removed && (cur.origin === 'added' || auto)) || (!cur && auto)) return problem(409, 'duplicate', 'The site is already in the plan');
    p!.rows.set(s.id, { overrides: cur?.overrides ?? {}, reason: cur?.reason ?? null, remark: cur?.remark ?? null, removed: false, origin: auto ? 'auto' : 'added' });
    p!.version++;
    return HttpResponse.json(day(date, [region]));
  }),
  http.delete(`${B}/daily-plans/:date/regions/:region/sites/:site`, ({ request, params }) => {
    const date = String(params.date), region = Number(params.region);
    const { r, p } = pre(request, date, region); if (r) return r;
    const s = [...seeds(), extraSite].find((x) => x.id === params.site && x.region === region);
    if (!s) return problem(404, 'not_found', 'The site is not in this plan');
    if (s.id === extraSite.id) p!.rows.delete(s.id);
    else p!.rows.set(s.id, { ...(p!.rows.get(s.id) ?? { overrides: {}, reason: null, remark: null, origin: 'auto' as const }), removed: true });
    p!.version++;
    return HttpResponse.json(day(date, [region]));
  }),
  http.post(`${B}/daily-plans/:date/regions/:region/lock`, ({ request, params }) => {
    const date = String(params.date), region = Number(params.region);
    const { r, p } = pre(request, date, region); if (r) return r;
    const missing = rowsOf(date, region).filter((x) => x.reason_missing);
    if (missing.length) return fields(...missing.map((x) => ({ path: `/rows/${x.site_code}/reason`, code: 'required' })));
    p!.locked = true; p!.lock_kind = 'manual'; p!.version++;
    return HttpResponse.json(day(date, [region]));
  }),
  http.post(`${B}/daily-plans/:date/regions/:region/unlock`, async ({ request, params }) => {
    const g = guard(); if (g) return g;
    const date = String(params.date), region = Number(params.region);
    if (!REGIONS[region]) return problem(404, 'not_found', 'The plan does not exist');
    const p = planAt(date, region);
    const v = ver(request, p); if (v) return v;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Only a System Admin reopens a locked day');
    const b = (await request.json()) as { reason?: string };
    if ((b.reason ?? '').trim().length < 3) return fields({ path: '/reason', code: 'required' });
    if (!stepUpValid()) return stepUp();
    if (!p.locked) return problem(409, 'invalid_transition', 'The day is not locked');
    p.locked = false; p.lock_kind = null; p.unlocked = true; p.version++;
    return HttpResponse.json(day(date, [region]));
  }),
  http.get(`${B}/settings/daily-plan`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json(cfg, { headers: { ETag: `"${cfg.version}"` } });
  }),
  http.put(`${B}/settings/daily-plan`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'System Admin only');
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (h.trim() !== '*' && h.replace(/"/g, '').trim() !== String(cfg.version)) return problem(412, 'precondition_failed', 'The settings changed');
    const b = (await request.json()) as Partial<DailyPlanSettings> & { reason?: string };
    const errs: { path: string; code: string }[] = [];
    for (const tab of ['progress', 'tomorrow'] as const) {
      const c = b.columns?.[tab] ?? [];
      if (!c.includes('site_code')) errs.push({ path: `/columns/${tab}`, code: 'site_code_required' });
      if (new Set(c).size !== c.length) errs.push({ path: `/columns/${tab}`, code: 'duplicate' });
    }
    if (b.auto_lock_time !== null && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(b.auto_lock_time))) errs.push({ path: '/auto_lock_time', code: 'invalid' });
    if (b.reminder_hour !== null && !(Number.isInteger(b.reminder_hour) && b.reminder_hour! >= 0 && b.reminder_hour! <= 23)) errs.push({ path: '/reminder_hour', code: 'out_of_range' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    cfg = { ...cfg, columns: b.columns!, default_region_scope: b.default_region_scope === 'all' ? 'all' : 'mine', auto_lock_time: b.auto_lock_time ?? null, reminder_hour: b.reminder_hour ?? null, version: cfg.version + 1 };
    return HttpResponse.json(cfg, { headers: { ETag: `"${cfg.version}"` } });
  }),
];
