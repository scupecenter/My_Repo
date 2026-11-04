import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { GateEvent, ScenarioRule, SiteApplicability, SlaMasterColumn } from '@/api/scenario';
import { db, stepUpValid } from './db';
import { guard, problem, stepUp } from './handlers';
import { gridOf, siteIndex, siteMeta, SITE_COUNT, TODAY } from './sites';

/**
 * Contract 0.12.0 (P1, migration 0052): scenario applicability, scope exceptions, the gate history, the scenario rules and the SLA sheet columns.
 * The rules follow the seed of the migration: A1, A3 and the Site RFI are N/A for Hot / Cold Swap, D-1 is not measured there. Every third Swap site
 * has GECOL = Yes in the mock, so it shows the Q3 conflict until a scope exception is approved.
 */
const B = API_BASE;
const SWAP = new Set(['hot_swap', 'cold_swap']);
const RULES: ScenarioRule[] = [
  ...(['hot_swap', 'cold_swap'] as const).flatMap((sc) => [
    { task_code: 'A1', scenario: sc, rule: 'na' as const, flag_expr: null, reason: 'Q15: same site, no search' },
    { task_code: 'A3', scenario: sc, rule: 'na' as const, flag_expr: null, reason: 'Q15: same site, no new acquisition' },
    { task_code: 'MS4', scenario: sc, rule: 'na' as const, flag_expr: null, reason: 'Q3: Site RFI is N/A for Swap by scenario' },
    { task_code: 'D1', scenario: sc, rule: 'sla_not_measured' as const, flag_expr: null, reason: 'Q2: D-1 is not measured for Swap' },
  ]),
  { task_code: 'MS4', scenario: null, rule: 'flag', flag_expr: 'rfi', reason: 'Site RFI applies when any of AA:AD is Yes (Master BQ)' },
];
let rulesVersion = 1;
let excSeq = 0;
const excId = () => `5c000000-0000-4000-8000-${String(++excSeq).padStart(12, '0')}`;
type Exc = SiteApplicability['exceptions'][number];
const exceptions: Record<string, Exc[]> = {};
const gecolYes = (i: number) => SWAP.has(siteMeta(i).scenario) && i % 3 === 0;
const me = () => ({ id: db().session?.account ?? 'u', display_name: 'You', employee_id: null });

function applicability(i: number): SiteApplicability {
  const m = siteMeta(i);
  const grid = gridOf(i).stages.flatMap((s) => s.tasks);
  // the mock workflow has no Site RFI task: a locked MS4 row stands for it, so the Q3 decision has a row
  const tasks = grid.some((t) => t.task_code === 'MS4') ? grid : [...grid, { id: `${m.id.slice(0, -4)}ms04`, task_code: 'MS4', state: 'locked' as const }];
  const exc = (exceptions[m.id] ?? []).filter((e) => !e.revoked_at);
  const swap = SWAP.has(m.scenario);
  const rfiExc = exc.some((e) => e.task_code === 'MS4');
  const rfi = rfiExc || !swap;
  const master = gecolYes(i) || !swap;
  return {
    site_id: m.id, delivery_scenario: m.scenario,
    rfi: { applies: rfi, master_rfi: master, differs: rfi !== master },
    conflicts: swap && gecolYes(i) && !rfiExc ? [{ task_code: 'MS4', scenario: m.scenario, flag_expr: 'rfi', message: 'The scenario makes MS4 N/A, but the scope flags say the work exists.' }] : [],
    tasks: tasks.map((t) => {
      const byExc = exc.find((e) => e.task_code === t.task_code);
      const naByScenario = swap && ['A1', 'A3', 'MS4'].includes(t.task_code);
      const applies = byExc ? true : naByScenario ? false : null;
      return {
        task_id: t.id, task_code: t.task_code, state: t.state, applies, sla_measured: !(swap && t.task_code === 'D1'),
        source: byExc ? 'exception' : naByScenario ? 'scenario' : 'none', reason: null, exception_id: byExc?.id ?? null,
        would_change: applies === false && ['locked', 'open', 'entry'].includes(t.state) ? 'na' : null,
      };
    }),
    exceptions: exceptions[m.id] ?? [],
  };
}

const COLUMNS: SlaMasterColumn[] = ['A-1', 'A-3', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6', 'B-7', 'B-8', 'B-9', 'B-10a', 'B-10b', 'B-11', 'B-13', 'B-15', 'C-2', 'C-4', 'RFI', 'E2E-B1', 'E2E-B2', 'E2E-B3',
  'D-1', 'D-2', 'D-3', 'D-4', 'D-5', 'D-6', 'D-7', 'D-8', 'D-9', 'D-10', 'D-11', 'D-12', 'D-13', 'D-14', 'D-15', 'D-16', 'D-17', 'E2E-D1', 'E2E-D2', 'S-1', 'S-2', 'S-3', 'S-4', 'S-5']
  .map((code, k) => ({
    seq: k + 1, master_column: k < 23 ? String.fromCharCode(68 + k) : `A${String.fromCharCode(65 + k - 23)}`, sla_code: code, name_en: code, from_to: '', applies_when: '',
    task_code: code.startsWith('B-10') ? 'B10' : code === 'RFI' ? 'MS4' : /^E2E-B|^S-3|^S-4/.test(code) ? null : code.replace('-', '').replace(/^A3$/, 'A2'),
    flag_condition: code === 'B-10a' ? 'rt_or_gf=RT' : code === 'B-10b' ? 'rt_or_gf=GF' : null, inherited: code === 'B-6', note: null,
  }));

const site = (id: string) => { const i = siteIndex(id); return i >= 0 && i < SITE_COUNT ? i : -1; };
const reasonOk = (b: { reason?: unknown }) => typeof b.reason === 'string' && b.reason.trim().length >= 3;
const noReason = () => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });

export const scenarioHandlers = [
  http.get(`${B}/sites/:id/applicability`, ({ params }) => {
    const g = guard(); if (g) return g;
    const i = site(params.id as string);
    return i < 0 ? problem(404, 'not_found', 'Site not found') : HttpResponse.json(applicability(i));
  }),
  http.post(`${B}/sites/:id/applicability/apply`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const i = site(params.id as string);
    if (i < 0) return problem(404, 'not_found', 'Site not found');
    const b = (await request.json()) as { reason?: string };
    if (!reasonOk(b)) return noReason();
    if (!stepUpValid()) return stepUp();
    const a = applicability(i);
    if (a.conflicts.length) return problem(422, 'scope_scenario_conflict', 'The scenario and the scope flags disagree', { conflicts: a.conflicts });
    const changed = a.tasks.filter((t) => t.would_change).map((t) => ({ task_code: t.task_code, from: t.state, to: t.would_change ?? 'na', source: t.source }));
    return HttpResponse.json({ result: { site_id: a.site_id, changed, kept: [] }, applicability: a });
  }),
  http.post(`${B}/sites/:id/scope-exceptions`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const i = site(params.id as string);
    if (i < 0) return problem(404, 'not_found', 'Site not found');
    const b = (await request.json()) as { task_code?: string; reason?: string; change_request_id?: string | null };
    if (!reasonOk(b)) return noReason();
    const a = applicability(i);
    if (!a.tasks.some((t) => t.task_code === b.task_code && t.source === 'scenario')) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/task_code', code: 'not_na_by_scenario' }] });
    if (!stepUpValid()) return stepUp();
    const id = siteMeta(i).id;
    (exceptions[id] ??= []).push({ id: excId(), task_code: b.task_code!, reason: b.reason!.trim(), change_request_id: b.change_request_id ?? null, approved_by: me(), approved_at: `${TODAY}T09:00:00Z`, revoked_at: null, revoked_by: null, revoke_reason: null });
    return HttpResponse.json(applicability(i), { status: 201 });
  }),
  http.post(`${B}/sites/:id/scope-exceptions/:exceptionId/revoke`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const i = site(params.id as string);
    if (i < 0) return problem(404, 'not_found', 'Site not found');
    const e = (exceptions[siteMeta(i).id] ?? []).find((x) => x.id === params.exceptionId);
    if (!e) return problem(404, 'not_found', 'Exception not found');
    const b = (await request.json()) as { reason?: string };
    if (!reasonOk(b)) return noReason();
    if (e.revoked_at) return problem(409, 'invalid_transition', 'Already revoked');
    if (!stepUpValid()) return stepUp();
    Object.assign(e, { revoked_at: `${TODAY}T10:00:00Z`, revoked_by: me(), revoke_reason: b.reason!.trim() });
    return HttpResponse.json(applicability(i));
  }),
  http.get(`${B}/sites/:id/gate-events`, ({ params }) => {
    const g = guard(); if (g) return g;
    const i = site(params.id as string);
    if (i < 0) return problem(404, 'not_found', 'Site not found');
    const items: GateEvent[] = i % 4 === 1
      ? [{ id: '3', gate_code: 'G2', event: 'opened', status: 'open', gate_date: TODAY, previous_date: null, shifted: true, cause: [], at: `${TODAY}T09:00:00Z` },
         { id: '2', gate_code: 'G2', event: 'closed', status: 'blocked', gate_date: null, previous_date: TODAY, shifted: false, cause: [{ kind: 'suspension', ref_code: null, message: 'The site is suspended.' }], at: `${TODAY}T08:00:00Z` },
         { id: '1', gate_code: 'G2', event: 'opened', status: 'open', gate_date: TODAY, previous_date: null, shifted: false, cause: [], at: `${TODAY}T07:00:00Z` }]
      : [];
    return HttpResponse.json({ items });
  }),
  http.get(`${B}/settings/scenario-rules`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json({ version: rulesVersion, items: RULES }, { headers: { ETag: `"${rulesVersion}"` } });
  }),
  http.put(`${B}/settings/scenario-rules`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (h.replace(/"/g, '') !== String(rulesVersion)) return problem(412, 'precondition_failed', 'Changed since you read it');
    const b = (await request.json()) as { reason?: string; rules?: ScenarioRule[] };
    if (!reasonOk(b)) return noReason();
    if (!stepUpValid()) return stepUp();
    RULES.splice(0, RULES.length, ...(b.rules ?? []));
    rulesVersion += 1;
    return HttpResponse.json({ version: rulesVersion, items: RULES }, { headers: { ETag: `"${rulesVersion}"` } });
  }),
  http.get(`${B}/settings/sla-master-columns`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json({ items: COLUMNS });
  }),
];
