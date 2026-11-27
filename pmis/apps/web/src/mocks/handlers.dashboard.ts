import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { DelayParty, DelayPeriod, ManualItem, ManualPlanPoint, PipelineVariant } from '@/api/dashboard';
import { tripoliToday } from '@/lib/today';
import { guard, problem } from './handlers';
import { buildDashboard, CENTRAL_ITEMS } from './dashboardData';
import { db, viewer, type Db } from './db';
import { MAP_MILESTONES, mapItem, SITE_COUNT, STREAMS as SITE_STREAMS } from './sites';

const B = API_BASE;

const COUNTERS_MOCK = {
  available: true,
  kpis: [

  ],
  pending_kpis: [] as string[],
  site_master_menus: [
    { code: 'CW', name_en: 'Civil Works', name_ar: 'الأعمال المدنية', sites: 96 },
    { code: 'TE', name_en: 'Installation (TE)', name_ar: 'التركيبات', sites: 88 },
    { code: 'OM', name_en: 'O&M', name_ar: 'التشغيل والصيانة', sites: 40 },
  ],
  sla_totals: { open_tasks: 160, breach: 20, at_risk: 13 },
  sla_by_stage: [
    { stage_code: 'SITE_ACQ', stage_name: 'Site acquisition', stage_name_ar: 'اقتناء الموقع', open_tasks: 48, breach: 6, at_risk: 4, breach_pct: 12.5, at_risk_pct: 8.3 },
    { stage_code: 'CIVIL', stage_name: 'Civil works', stage_name_ar: 'الأعمال المدنية', open_tasks: 70, breach: 9, at_risk: 6, breach_pct: 12.9, at_risk_pct: 8.6 },
    { stage_code: 'COMMISSION', stage_name: 'Commissioning', stage_name_ar: 'التشغيل والتجهيز', open_tasks: 42, breach: 5, at_risk: 3, breach_pct: 11.9, at_risk_pct: 7.1 },
  ],
  sites_total: 120,
};


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
      entered_by: { id: v.by, display_name: me?.name ?? 'Demo User 01', employee_id: me?.employee_id ?? null }, source: v.source, historical_correction: v.historical_correction,
    }));
    const pl = planOf(c.code);
    return {
      item_code: c.code, name_en: c.name_en, name_ar: c.name_ar, weight: c.weight, activity_code: c.act, activity_name_en: c.act_en, activity_name_ar: c.act_ar,
      current: cur ? { value_pct: cur.value_pct, effective_date: cur.effective_date, version: cur.version, source: cur.source } : null, history,
      plan: pl ? { id: pl.id, version: pl.version, points: pl.points, reason: pl.reason, source: pl.source, created_at: pl.created_at, planned_pct_today: planPct(pl.points, today),
        entered_by: { id: pl.by, display_name: me?.name ?? 'Demo User 01', employee_id: me?.employee_id ?? null } } : null,
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
  // 0.14.5 (OV-12): the site map, built from the synthetic mock sites with synthetic coordinates spread over Libya. The mock accounts see every region.
  // 0.15.16 (F13): the risk matrix, data quality, swap and relocation and decisions (synthetic figures)
  http.get(`${B}/dashboard/extras`, () => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    const risks = [
      { risk_code: 'RSK-001', statement: 'Access permit delay near the airport', probability: 4, impact: 4, status: 'open', risk_owner: 'Project Manager', region_id: 1, is_global: false },
      { risk_code: 'RSK-002', statement: 'Vendor crew shortage in the south', probability: 3, impact: 5, status: 'in_progress', risk_owner: 'TE Team Lead', region_id: 7, is_global: false },
      { risk_code: 'RSK-003', statement: 'Power supply interruptions at two sites', probability: 2, impact: 3, status: 'open', risk_owner: 'Power Engineer', region_id: null, is_global: true },
      { risk_code: 'RSK-004', statement: 'Late delivery of warehouse items', probability: 2, impact: 2, status: 'open', risk_owner: 'Inventory Supervisor', region_id: 2, is_global: false },
    ];
    const cells = Array.from({ length: 25 }, (_, i) => {
      const probability = Math.floor(i / 5) + 1; const impact = (i % 5) + 1; const score = probability * impact;
      const band = score <= 4 ? 'low' : score <= 9 ? 'medium' : score <= 16 ? 'high' : 'critical';
      return { probability, impact, score, band, count: risks.filter((r) => r.probability === probability && r.impact === impact).length };
    });
    const bandCount = (b: string) => cells.filter((c) => c.band === b).reduce((n, c) => n + c.count, 0);
    const top = [...risks].map((r) => ({ ...r, score: r.probability * r.impact, band: r.probability * r.impact >= 10 ? 'high' : r.probability * r.impact >= 5 ? 'medium' : 'low' }))
      .sort((a, b) => b.score - a.score || a.risk_code.localeCompare(b.risk_code));
    const scen = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
    return HttpResponse.json({
      as_of: new Date().toISOString(), scope_regions: null, counters: COUNTERS_MOCK,
      risk_matrix: {
        available: true, open_total: risks.length, invalid_total: 0, cells,
        bands: [
          { band: 'low', min: 1, max: 4, count: bandCount('low') }, { band: 'medium', min: 5, max: 9, count: bandCount('medium') },
          { band: 'high', min: 10, max: 16, count: bandCount('high') }, { band: 'critical', min: 20, max: 25, count: bandCount('critical') },
        ],
        top_open_risks: top,
      },
      data_quality: {
        available: true, sites_checked: 120, sites_with_gaps: 14, gaps_total: 19,
        by_kind: [{ kind: 'missing_actual_date', field: null, count: 15 }, { kind: 'missing_field', field: 'delivery_scenario', count: 4 }],
      },
      swap_relocation: {
        available: true, unscenarioed: 4,
        rows: scen.map((sc, i) => ({ scenario: sc, sites_total: 20 + i * 5, by_overall_status: { not_started: 4, in_progress: 10 + i, on_hold: 1, completed: 5, cancelled: 0 } })),
      },
      decisions: {
        available: true,
        items: top.slice(0, 4).map((r) => ({ tag: r.band === 'high' ? 'act_now' : 'watch', risk_code: r.risk_code, statement: r.statement, score: r.score, band: r.band, risk_owner: r.risk_owner, region_id: r.region_id })),
      },
    });
  }),
  // 0.15.96: the follow-up sections (procurement and materials), synthetic figures
  http.get(`${B}/dashboard/ops`, () => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    return HttpResponse.json({
      as_of: new Date().toISOString(), scope_regions: null,
      procurement: {
        available: true, open_total: 14,
        pr_wait: { buckets: [{ key: 'd0_7', count: 2 }, { key: 'd8_14', count: 3 }, { key: 'd15_30', count: 1 }, { key: 'over_30', count: 1 }], total: 7, oldest_days: 41 },
        po_wait: { buckets: [{ key: 'd0_7', count: 4 }, { key: 'd8_14', count: 2 }, { key: 'd15_30', count: 1 }, { key: 'over_30', count: 0 }], total: 7, oldest_days: 22 },
        materials: {
          available: true, receive_pct: 62.5, required_total: 800, dispatched_total: 500, sites_short: 3,
          top_shortages: [
            { site_id: '00000000-0000-4000-8000-000000000101', site_code: 'TR101', item_code: 'PWR-001', item_name: 'Rectifier module', missing: 4, required: 6, dispatched: 2, contractor: 'A&T Global' },
            { site_id: '00000000-0000-4000-8000-000000000102', site_code: 'TR102', item_code: 'MW-014', item_name: 'ODU 7GHz', missing: 2, required: 4, dispatched: 2, contractor: 'A&T Global' },
          ],
          by_contractor: [
            { party_id: '00000000-0000-4000-8000-000000000201', name: 'A&T Global', sites: 2, missing_lines: 2, missing_qty: 6 },
            { party_id: null, name: '', sites: 1, missing_lines: 1, missing_qty: 3 },
          ],
        },
      },
      gecol_hlc: {
        gecol: {
          available: true, in_scope: 18, powered: 9, no_record: 2, civil_ready_no_power: 3,
          waiting: { buckets: [{ key: 'd0_7', count: 1 }, { key: 'd8_14', count: 2 }, { key: 'd15_30', count: 2 }, { key: 'over_30', count: 2 }], total: 7, oldest_days: 58 },
        },
        hlc: {
          available: true, in_scope: 21, in_service: 12, no_record: 1, installed_not_in_service: 2,
          waiting: { buckets: [{ key: 'd0_7', count: 3 }, { key: 'd8_14', count: 1 }, { key: 'd15_30', count: 1 }, { key: 'over_30', count: 1 }], total: 6, oldest_days: 34 },
        },
      },
      permits_hse: {
        available: true, total: 26,
        by_status: [
          { status: 'Approved', count: 15 },
          { status: 'Applied', count: 7 },
          { status: 'Rejected', count: 3 },
          { status: 'N/A', count: 1 },
        ],
        waiting: 7, sites_without_permit: 5, expiring_14: 4, expired: 2, stop_work_active: 1,
        ptw: {
          open: 9, with_gaps: 4,
          gaps: [
            { key: 'loto', count: 3 },
            { key: 'rescue_plan', count: 2 },
            { key: 'toolbox_talk', count: 1 },
          ],
        },
      },
      // 0.15.202: the contractor and supplier scorecard, synthetic figures, no amounts
      contractor_scorecard: {
        available: true, parties: 12,
        by_level: { ok: 7, amber: 3, red: 1, insufficient: 1 },
        avg_delay_days: 6.4, on_time_pct: 81.2, quality_fail_pct: 4.8,
        snags: { total: 160, open: 34, overdue: 30, returned: 12 },
        quality: { total: 125, failed: 6 },
        worst: [
          { party_id: '00000000-0000-4000-8000-000000000201', name: 'A&T Global', type: 'contractor', level: 'red', delay_days: 21, snags_overdue: 12, quality_failed: 3 },
          { party_id: '00000000-0000-4000-8000-000000000202', name: 'Delta Towers', type: 'contractor', level: 'amber', delay_days: 9, snags_overdue: 7, quality_failed: 1 },
          { party_id: '00000000-0000-4000-8000-000000000203', name: 'Sahara Power', type: 'supplier', level: 'amber', delay_days: 5, snags_overdue: 4, quality_failed: 2 },
          { party_id: '00000000-0000-4000-8000-000000000204', name: 'Nile Works', type: 'contractor', level: 'ok', delay_days: 2, snags_overdue: 3, quality_failed: 0 },
          { party_id: '00000000-0000-4000-8000-000000000205', name: 'Med Links', type: 'supplier', level: 'ok', delay_days: 0, snags_overdue: 2, quality_failed: 0 },
        ],
      },
      // 0.15.203: quality, snags and NCR, synthetic figures
      quality: {
        available: true,
        snags: { open: 34, closed: 126, avg_close_days: 9.6, returned_open: 5 },
        ncrs: { open: 6, closed: 41, avg_close_days: 14.2 },
        first_pass_pct: 92.4,
      },
    });
  }),
  http.get(`${B}/dashboard/site-map`, () => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    const items = Array.from({ length: SITE_COUNT }, (_, i) => mapItem(i));
    const live = items.filter((x) => x.overall_status !== 'cancelled');
    return HttpResponse.json({
      as_of: new Date().toISOString(), scope_regions: null, counters: COUNTERS_MOCK,
      counts: { total: items.length, cancelled: items.length - live.length, with_coordinates: live.filter((x) => x.has_coordinates).length, without_coordinates: live.filter((x) => !x.has_coordinates).length },
      streams: SITE_STREAMS, milestones: MAP_MILESTONES, items,
    });
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

  // ---------------------------------------------------------------- 0.7.2: the saved weekly snapshots (frozen values; the S-curve card, dashboard proposals item 2)
  http.get(`${B}/project-status/snapshots`, () => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    // Synthetic weekly (Thursday) series: the plan runs ahead, the actual curve catches up lately.
    const planned = [25, 30, 36, 42, 48, 54, 60, 66, 71, 76, 80, 84, 87, 90];
    const actual = [22, 26, 31, 36, 41, 46, 50, 55, 60, 64, 68, 71, 74, 76.5];
    const start = new Date('2026-08-20T00:00:00Z').getTime();
    const items = planned.map((pl, i) => ({
      id: `snap-${i + 1}`,
      taken_on: new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10),
      scope: 'project',
      region_id: null,
      progress_pct: actual[i],
      planned_pct: pl,
      spi: Math.round((actual[i]! / pl) * 1000) / 1000,
      health_index: 80 + i,
      weight_set: { id: 'ws-project-status-1', code: 'project_status', version: 3, effective_from: '2026-08-01', is_active: true },
      kind: 'weekly',
      kinds: ['weekly'],
    }));
    return HttpResponse.json({ items, page: { limit: 200, next_cursor: null } });
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
