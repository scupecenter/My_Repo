import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { DelayParty, DelayPeriod, ManualItem, ManualPlanPoint, PipelineVariant } from '@/api/dashboard';
import { tripoliToday } from '@/lib/today';
import { guard, problem } from './handlers';
import { buildDashboard, CENTRAL_ITEMS } from './dashboardData';
import { db, viewer, type Db } from './db';

const B = API_BASE;

/** The mock accounts see every region; the module comes from their navigation list (the real API checks `dashboard.view`). */
const canUse = (): boolean => !!viewer()?.nav.includes('dashboard');
/** In the mock the Project Manager account (`pm`, a System Admin) enters manual values and decides delay periods; the real API decides by role, grant and matrix. */
const canEdit = (): boolean => viewer()?.key === 'pm';
/** L1 proposes delay periods too (Q182): in the mock the site engineer account as well as `pm`. */
const canPropose = (): boolean => canEdit() || viewer()?.key === 'engineer';
const firstOfMonth = (): string => `${tripoliToday().slice(0, 7)}-01`;

const bad = (q: URLSearchParams) => {
  const ref = q.get('ref_date');
  if (ref && !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/ref_date', code: 'invalid' }] });
  if (q.get('region_id') && !/^[1-7]$/.test(q.get('region_id')!)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/region_id', code: 'invalid' }] });
  if (q.get('view') && !['CW', 'TE', 'OM'].includes(q.get('view')!)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/view', code: 'unknown_view' }] });
  return null;
};
const fields = (path: string, code: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code }] });

// ---------------------------------------------------------------- mock state (per mock database, so resetDb() starts it again)
type Value = { id: string; item_code: string; version: number; value_pct: number; effective_date: string; reason: string; created_at: string; by: string; source: string; historical_correction: boolean };
type Plan = { id: string; item_code: string; version: number; points: ManualPlanPoint[]; reason: string; source: string; created_at: string; by: string };
type State = { values: Value[]; plans: Plan[]; periods: Record<string, DelayPeriod[]>; variant: PipelineVariant };
const states = new WeakMap<Db, State>();
const S = (): State => {
  const d = db();
  let s = states.get(d);
  if (!s) { s = { values: [], plans: [], periods: {}, variant: 'A' }; states.set(d, s); }
  return s;
};

/** Q349: the pipeline style in force (the site page follows the same setting as the dashboard). */
export const pipelineVariant = (): PipelineVariant => S().variant;

/** The value of an item in force on a date (latest effective date on or before it, then the highest version). */
export function manualInForce(code: string, on: string): Value | undefined {
  return S().values.filter((v) => v.item_code === code && v.effective_date <= on).sort((a, b) => (b.effective_date.localeCompare(a.effective_date)) || b.version - a.version)[0];
}

/** The planned % of a plan on a date (the rule of ps_plan_pct, 0059): 0 before the first point, a straight line between, the last value after. */
export function planPct(points: ManualPlanPoint[], on: string): number {
  const pts = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const prev = [...pts].reverse().find((x) => x.date <= on);
  const next = pts.find((x) => x.date > on);
  if (!prev) return 0;
  if (!next) return prev.planned_pct;
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  return Math.round((prev.planned_pct + ((next.planned_pct - prev.planned_pct) * (day(on) - day(prev.date))) / (day(next.date) - day(prev.date))) * 1000) / 1000;
}
const planOf = (code: string): Plan | undefined => S().plans.filter((x) => x.item_code === code).sort((a, b) => b.version - a.version)[0];

function manualList() {
  const today = tripoliToday();
  const me = viewer();
  const items: ManualItem[] = CENTRAL_ITEMS.map((c) => {
    const cur = manualInForce(c.code, today);
    const history = S().values.filter((v) => v.item_code === c.code).sort((a, b) => b.version - a.version).map((v) => ({
      id: v.id, version: v.version, value_pct: v.value_pct, effective_date: v.effective_date, reason: v.reason, created_at: v.created_at, in_force: v.id === cur?.id,
      entered_by: { id: v.by, display_name: me?.name ?? 'Ahmed Salem', employee_id: me?.employee_id ?? null }, source: v.source, historical_correction: v.historical_correction,
    }));
    const pl = planOf(c.code);
    return {
      item_code: c.code, name_en: c.name_en, name_ar: c.name_ar, weight: c.weight, activity_code: c.act, activity_name_en: c.act_en, activity_name_ar: c.act_ar,
      current: cur ? { value_pct: cur.value_pct, effective_date: cur.effective_date, version: cur.version, source: cur.source } : null, history,
      plan: pl ? { id: pl.id, version: pl.version, points: pl.points, reason: pl.reason, source: pl.source, created_at: pl.created_at, planned_pct_today: planPct(pl.points, today),
        entered_by: { id: pl.by, display_name: me?.name ?? 'Ahmed Salem', employee_id: me?.employee_id ?? null } } : null,
    };
  });
  return { as_of: today, can_edit: canEdit(), can_correct_history: canEdit(), open_period_from: firstOfMonth(), items,
    without_value: items.filter((i) => i.weight > 0 && !i.current).length, without_plan: items.filter((i) => i.weight > 0 && !i.plan).length };
}

const PARTIES: DelayParty[] = ['gecol', 'hlc', 'client', 'contractor', 'external', 'aljeel'];
const me = () => { const v = viewer(); return { id: v?.key ?? 'user', display_name: v?.name ?? 'User', employee_id: v?.employee_id ?? null }; };

// Mock of GET /dashboard (contract 0.7.2, 0.11.0). An account without `dashboard` in its navigation gets the module_forbidden answer.
export const dashboardHandlers = [
  http.get(`${B}/dashboard`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    const q = new URL(request.url).searchParams;
    return bad(q) ?? HttpResponse.json(buildDashboard(q, null, (code, on) => manualInForce(code, on), { variant: S().variant, plan: (code, on) => { const pl = planOf(code); return pl ? planPct(pl.points, on) : undefined; } }));
  }),
  // Q116: the pipeline style; in the mock the System Admin is the `pm` account
  http.put(`${B}/dashboard/pipeline-variant`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'A System Admin or a dashboard administer holder chooses the pipeline style');
    const b = (await request.json()) as { variant?: string; reason?: string };
    if (b.variant !== 'A' && b.variant !== 'B') return fields('/variant', 'invalid');
    if (!b.reason || b.reason.trim().length < 3) return fields('/reason', 'required');
    S().variant = b.variant;
    return HttpResponse.json({ variant: b.variant });
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
    const b = (await request.json()) as { value_pct?: number; effective_date?: string; reason?: string; source?: string };
    if (!item || item.weight <= 0) return fields('/item_code', 'not_central_item');
    if (typeof b.value_pct !== 'number' || b.value_pct < 0 || b.value_pct > 100) return fields('/value_pct', 'invalid');
    if (!b.effective_date || b.effective_date > tripoliToday()) return fields('/effective_date', 'in_future');
    if (!b.reason || b.reason.trim().length < 3) return fields('/reason', 'required');
    if (!b.source || b.source.trim().length < 2) return fields('/source', 'required');
    const corr = b.effective_date < firstOfMonth();
    const version = S().values.filter((v) => v.item_code === code).length + 1;
    const v: Value = { id: crypto.randomUUID(), item_code: code, version, value_pct: b.value_pct, effective_date: b.effective_date, reason: b.reason.trim(), created_at: new Date().toISOString(),
      by: viewer()?.key ?? 'pm', source: b.source.trim(), historical_correction: corr };
    S().values.push(v);
    return HttpResponse.json({ id: v.id, item_code: code, version, value_pct: v.value_pct, effective_date: v.effective_date, reason: v.reason, source: v.source, historical_correction: corr, created_at: v.created_at }, { status: 201 });
  }),
  // Q177
  http.post(`${B}/project-status/manual-items/:code/plan`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    if (!canEdit()) return problem(403, 'action_forbidden', 'Only the Project Manager enters plans');
    const code = params.code as string;
    const item = CENTRAL_ITEMS.find((c) => c.code === code);
    if (!item || item.weight <= 0) return fields('/item_code', 'not_central_item');
    const b = (await request.json()) as { points?: ManualPlanPoint[]; target_date?: string; start_date?: string; reason?: string; source?: string };
    if (!b.reason || b.reason.trim().length < 3) return fields('/reason', 'required');
    if (!b.source || b.source.trim().length < 2) return fields('/source', 'required');
    const points = b.points ?? (b.target_date ? [...(b.start_date ? [{ date: b.start_date, planned_pct: 0 }] : []), { date: b.target_date, planned_pct: 100 }] : []);
    if (points.length === 0) return fields('/points', 'invalid');
    const sorted = [...points].sort((a, c) => a.date.localeCompare(c.date));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.date === sorted[i - 1]!.date) return fields(`/points/${i}/date`, 'duplicate');
      if (sorted[i]!.planned_pct < sorted[i - 1]!.planned_pct) return fields(`/points/${i}/planned_pct`, 'not_cumulative');
    }
    const pl: Plan = { id: crypto.randomUUID(), item_code: code, version: S().plans.filter((x) => x.item_code === code).length + 1, points: sorted, reason: b.reason.trim(), source: b.source.trim(),
      created_at: new Date().toISOString(), by: viewer()?.key ?? 'pm' };
    S().plans.push(pl);
    return HttpResponse.json({ id: pl.id, item_code: code, version: pl.version, points: pl.points, reason: pl.reason, source: pl.source, created_at: pl.created_at }, { status: 201 });
  }),

  // ---------------------------------------------------------------- Q122
  http.get(`${B}/tasks/:id/delay-periods`, ({ params }) => {
    const g = guard(); if (g) return g;
    const id = params.id as string;
    return HttpResponse.json({ task_id: id, due_date: '2026-09-20', can_edit: canEdit(), can_decide: canEdit(), can_propose: canPropose(), me: me().id, parties: PARTIES,
      external_parties: [{ id: '00000000-0000-4000-8000-0000000000c1', name: 'A&T Global', type: 'te_vendor' }, { id: '00000000-0000-4000-8000-0000000000c2', name: 'Sahara Civil Works', type: 'cw_contractor' }],
      items: S().periods[id] ?? [] });
  }),
  http.post(`${B}/tasks/:id/delay-periods`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!canPropose()) return problem(403, 'action_forbidden', 'L1 or L2 of the task proposes periods');
    const id = params.id as string;
    const b = (await request.json()) as { from_date?: string; to_date?: string; party?: DelayParty; reason?: string; evidence?: string | null; external_party_id?: string | null };
    if (!b.from_date || !b.to_date) return fields('/from_date', 'required');
    if (b.to_date < b.from_date) return fields('/to_date', 'before_from');
    if (!b.party || !PARTIES.includes(b.party)) return fields('/party', 'invalid');
    if (!b.reason || b.reason.trim().length < 3) return fields('/reason', 'required');
    const list = (S().periods[id] ??= []);
    if (list.some((p) => !p.voided && p.status !== 'rejected' && p.from_date <= b.to_date! && b.from_date! <= p.to_date)) return fields('/from_date', 'period_overlap');
    const p: DelayPeriod = { id: crypto.randomUUID(), task_id: id, from_date: b.from_date, to_date: b.to_date, party: b.party, external_party_id: b.external_party_id ?? null, external_party_name: null, reason: b.reason.trim(),
      created_at: new Date().toISOString(), created_by: me(), voided: false, voided_at: null, void_reason: null, voided_by: null,
      status: 'proposed', evidence: b.evidence ?? null, proposed_by: me(), decided_by: null, decided_at: null, decision_note: null, counts: false };
    list.push(p);
    return HttpResponse.json(p, { status: 201 });
  }),
  // Q182, Q184
  http.post(`${B}/tasks/:id/delay-periods/:pid/decision`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!canEdit()) return problem(403, 'action_forbidden', 'L2 of the task decides periods');
    const p = (S().periods[params.id as string] ?? []).find((x) => x.id === params.pid);
    if (!p) return problem(404, 'not_found', 'Period not found');
    if (p.voided || p.status !== 'proposed') return problem(409, 'invalid_transition', 'Not waiting for a decision');
    if (p.created_by.id === me().id) return problem(403, 'self_beneficiary', 'You cannot decide a period you proposed yourself');
    const b = (await request.json()) as { decision?: string; note?: string | null; external_party_id?: string | null };
    if (b.decision === 'reject') {
      if (!b.note || b.note.trim().length < 3) return fields('/note', 'required');
      Object.assign(p, { status: 'rejected', decided_by: me(), decided_at: new Date().toISOString(), decision_note: b.note.trim(), counts: false });
    } else {
      const ext = p.external_party_id ?? b.external_party_id ?? null;
      if ((p.party === 'contractor' || p.party === 'external') && !ext) return fields('/external_party_id', 'external_party_required');
      Object.assign(p, { status: 'approved', decided_by: me(), decided_at: new Date().toISOString(), decision_note: b.note?.trim() || null, external_party_id: ext,
        external_party_name: ext === '00000000-0000-4000-8000-0000000000c1' ? 'A&T Global' : ext ? 'Sahara Civil Works' : null, counts: true });
    }
    return HttpResponse.json(p);
  }),
  http.post(`${B}/tasks/:id/delay-periods/:pid/void`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const p = (S().periods[params.id as string] ?? []).find((x) => x.id === params.pid);
    if (!p) return problem(404, 'not_found', 'Period not found');
    if (!canEdit() && !(p.status === 'proposed' && p.created_by.id === me().id)) return problem(403, 'action_forbidden', 'Only the reviewer of the task voids periods');
    const b = (await request.json()) as { reason?: string };
    if (!b.reason || b.reason.trim().length < 3) return fields('/reason', 'required');
    if (p.voided) return problem(409, 'invalid_transition', 'Voided already');
    Object.assign(p, { voided: true, voided_at: new Date().toISOString(), void_reason: b.reason.trim(), voided_by: me() });
    return HttpResponse.json(p);
  }),
];
