import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { DelayParty, DelayPeriod, ManualItem } from '@/api/dashboard';
import { tripoliToday } from '@/lib/today';
import { guard, problem } from './handlers';
import { buildDashboard, CENTRAL_ITEMS } from './dashboardData';
import { db, viewer, type Db } from './db';

const B = API_BASE;

/** The mock accounts see every region; the module comes from their navigation list (the real API checks `dashboard.view`). */
const canUse = (): boolean => !!viewer()?.nav.includes('dashboard');
/** In the mock the Project Manager account (`pm`) enters manual values and records delay periods; the real API decides by role, grant and matrix. */
const canEdit = (): boolean => viewer()?.key === 'pm';

const bad = (q: URLSearchParams) => {
  const ref = q.get('ref_date');
  if (ref && !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/ref_date', code: 'invalid' }] });
  if (q.get('region_id') && !/^[1-7]$/.test(q.get('region_id')!)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/region_id', code: 'invalid' }] });
  if (q.get('view') && !['CW', 'TE', 'OM'].includes(q.get('view')!)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/view', code: 'unknown_view' }] });
  return null;
};
const fields = (path: string, code: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code }] });

// ---------------------------------------------------------------- mock state (per mock database, so resetDb() starts it again)
type Value = { id: string; item_code: string; version: number; value_pct: number; effective_date: string; reason: string; created_at: string; by: string };
type State = { values: Value[]; periods: Record<string, DelayPeriod[]> };
const states = new WeakMap<Db, State>();
const S = (): State => {
  const d = db();
  let s = states.get(d);
  if (!s) { s = { values: [], periods: {} }; states.set(d, s); }
  return s;
};

/** The value of an item in force on a date (latest effective date on or before it, then the highest version). */
export function manualInForce(code: string, on: string): Value | undefined {
  return S().values.filter((v) => v.item_code === code && v.effective_date <= on).sort((a, b) => (b.effective_date.localeCompare(a.effective_date)) || b.version - a.version)[0];
}

function manualList() {
  const today = tripoliToday();
  const me = viewer();
  const items: ManualItem[] = CENTRAL_ITEMS.map((c) => {
    const cur = manualInForce(c.code, today);
    const history = S().values.filter((v) => v.item_code === c.code).sort((a, b) => b.version - a.version).map((v) => ({
      id: v.id, version: v.version, value_pct: v.value_pct, effective_date: v.effective_date, reason: v.reason, created_at: v.created_at, in_force: v.id === cur?.id,
      entered_by: { id: v.by, display_name: me?.name ?? 'Ahmed Salem', employee_id: me?.employee_id ?? null },
    }));
    return {
      item_code: c.code, name_en: c.name_en, name_ar: c.name_ar, weight: c.weight, activity_code: c.act, activity_name_en: c.act_en, activity_name_ar: c.act_ar,
      current: cur ? { value_pct: cur.value_pct, effective_date: cur.effective_date, version: cur.version } : null, history,
    };
  });
  return { as_of: today, can_edit: canEdit(), items, without_value: items.filter((i) => i.weight > 0 && !i.current).length };
}

const PARTIES: DelayParty[] = ['gecol', 'hlc', 'client', 'contractor', 'external', 'aljeel'];
const me = () => { const v = viewer(); return { id: v?.key ?? 'user', display_name: v?.name ?? 'User', employee_id: v?.employee_id ?? null }; };

// Mock of GET /dashboard (contract 0.7.2, 0.11.0). An account without `dashboard` in its navigation gets the module_forbidden answer.
export const dashboardHandlers = [
  http.get(`${B}/dashboard`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    const q = new URL(request.url).searchParams;
    return bad(q) ?? HttpResponse.json(buildDashboard(q, null, (code, on) => manualInForce(code, on)));
  }),
  http.get(`${B}/dashboard/export`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    const q = new URL(request.url).searchParams;
    const fmt = q.get('format') ?? 'xlsx';
    if (fmt !== 'xlsx' && fmt !== 'csv') return fields('/format', 'invalid');
    const d = buildDashboard(q);
    if (fmt === 'csv') {
      const csv = `${String.fromCharCode(0xfeff)}section,item,metric,value\r\nheadline,sites,active,${d.headline.sites_total}\r\n`;
      return new HttpResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="GSDN_Dashboard_${d.basis.ref_date}.csv"` } });
    }
    // the mock does not build a workbook: a placeholder body with the real content type and name
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="GSDN_Dashboard_${d.basis.ref_date}.xlsx"` },
    });
  }),

  // ---------------------------------------------------------------- Q118
  http.get(`${B}/project-status/manual-items`, () => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    return HttpResponse.json(manualList());
  }),
  http.post(`${B}/project-status/manual-items/:code/values`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    if (!canEdit()) return problem(403, 'action_forbidden', 'Only the Project Manager enters manual values');
    const code = params.code as string;
    const item = CENTRAL_ITEMS.find((c) => c.code === code);
    const b = (await request.json()) as { value_pct?: number; effective_date?: string; reason?: string };
    if (!item || item.weight <= 0) return fields('/item_code', 'not_central_item');
    if (typeof b.value_pct !== 'number' || b.value_pct < 0 || b.value_pct > 100) return fields('/value_pct', 'invalid');
    if (!b.effective_date || b.effective_date > tripoliToday()) return fields('/effective_date', 'in_future');
    if (!b.reason || b.reason.trim().length < 3) return fields('/reason', 'required');
    const version = S().values.filter((v) => v.item_code === code).length + 1;
    const v: Value = { id: crypto.randomUUID(), item_code: code, version, value_pct: b.value_pct, effective_date: b.effective_date, reason: b.reason.trim(), created_at: new Date().toISOString(), by: viewer()?.key ?? 'pm' };
    S().values.push(v);
    return HttpResponse.json({ id: v.id, item_code: code, version, value_pct: v.value_pct, effective_date: v.effective_date, reason: v.reason, created_at: v.created_at }, { status: 201 });
  }),

  // ---------------------------------------------------------------- Q122
  http.get(`${B}/tasks/:id/delay-periods`, ({ params }) => {
    const g = guard(); if (g) return g;
    const id = params.id as string;
    return HttpResponse.json({ task_id: id, due_date: '2026-09-20', can_edit: canEdit(), parties: PARTIES, items: S().periods[id] ?? [] });
  }),
  http.post(`${B}/tasks/:id/delay-periods`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'Only the reviewer of the task records periods');
    const id = params.id as string;
    const b = (await request.json()) as { from_date?: string; to_date?: string; party?: DelayParty; reason?: string };
    if (!b.from_date || !b.to_date) return fields('/from_date', 'required');
    if (b.to_date < b.from_date) return fields('/to_date', 'before_from');
    if (!b.party || !PARTIES.includes(b.party)) return fields('/party', 'invalid');
    if (!b.reason || b.reason.trim().length < 3) return fields('/reason', 'required');
    const list = (S().periods[id] ??= []);
    if (list.some((p) => !p.voided && p.from_date <= b.to_date! && b.from_date! <= p.to_date)) return fields('/from_date', 'period_overlap');
    const p: DelayPeriod = { id: crypto.randomUUID(), task_id: id, from_date: b.from_date, to_date: b.to_date, party: b.party, external_party_id: null, external_party_name: null, reason: b.reason.trim(),
      created_at: new Date().toISOString(), created_by: me(), voided: false, voided_at: null, void_reason: null, voided_by: null };
    list.push(p);
    return HttpResponse.json(p, { status: 201 });
  }),
  http.post(`${B}/tasks/:id/delay-periods/:pid/void`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'Only the reviewer of the task voids periods');
    const p = (S().periods[params.id as string] ?? []).find((x) => x.id === params.pid);
    if (!p) return problem(404, 'not_found', 'Period not found');
    const b = (await request.json()) as { reason?: string };
    if (!b.reason || b.reason.trim().length < 3) return fields('/reason', 'required');
    if (p.voided) return problem(409, 'invalid_transition', 'Voided already');
    Object.assign(p, { voided: true, voided_at: new Date().toISOString(), void_reason: b.reason.trim(), voided_by: me() });
    return HttpResponse.json(p);
  }),
];
