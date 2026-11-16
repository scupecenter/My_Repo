import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { KanbanWip, SiteBoardCard, SitesBoard, TasksBoard } from '@/api/boards';
import type { TaskSummary } from '@/api/types';
import { db, toSummary, viewer, type MockTask } from './db';
import { guard, problem } from './handlers';
import { STAGE_CODES } from './matrixData';
import { listItem, siteMeta, siteTasks, SITE_COUNT } from './sites';

/**
 * F5 (contract 0.15.32): the sites board, the tasks board and the WIP limits, from the same mock sites and tasks as the lists. Read only:
 * like the server, the mock offers no board endpoint that writes.
 */
const B = API_BASE;
const STAGE_EN = ['Site Release', 'PRE-CW Completion', 'CW Completion', 'Site RFI', 'TE Completion', 'On-Air', 'TE PAC', 'KPI Acceptance', 'HOTO', 'Final Closure'];
const STAGE_AR = ['إطلاق الموقع', 'إنجاز ما قبل الأعمال المدنية', 'إنجاز الأعمال المدنية', 'جاهزية الموقع', 'إنجاز التركيبات', 'البث', 'الاستلام المبدئي TE', 'قبول مؤشرات الأداء', 'التسليم والتسلّم', 'الإغلاق النهائي'];
const REGIONS: [string, string][] = [['Tripoli', 'طرابلس'], ['Middle', 'الوسطى'], ['WM', 'الجبل الغربي'], ['Zawia', 'الزاوية'], ['Benghazi', 'بنغازي'], ['GM', 'الجبل الأخضر'], ['Sebha', 'سبها']];
const PARTY = { id: '80000000-0000-4000-8000-000000000001', name: 'A&T Global' };

/** The WIP limits of the mock (kept in memory: a warning only). */
export const wipState: { limits: Record<string, number>; version: number; updated_at: string | null } = { limits: {}, version: 1, updated_at: null };
const wipBody = (): KanbanWip => ({
  limits: wipState.limits, columns: STAGE_CODES.map((code, s) => ({ code, name_en: STAGE_EN[s]!, name_ar: STAGE_AR[s]! })), min: 1, max: 10000,
  updated_at: wipState.updated_at, updated_by: null, version: wipState.version, can_edit: viewer()?.key === 'pm' || viewer()?.key === 'admin',
});

function siteCard(i: number): { card: SiteBoardCard; column: string } {
  const m = siteMeta(i), it = listItem(i);
  const column = m.status === 'completed' || !it.current_milestone ? 'closed' : it.current_milestone;
  const own = column === 'closed' ? [] : siteTasks(i).filter((t) => t.stage_code === column && ['open', 'entry', 'in_review', 'in_approval'].includes(t.state));
  const worst = own.some((t) => t.sla?.colour === 'red') ? 'red' : own.some((t) => t.sla?.colour === 'amber') ? 'amber' : own.some((t) => t.sla?.colour === 'green') ? 'green' : null;
  const s = STAGE_CODES.indexOf(column as never);
  return {
    column,
    card: {
      id: m.id, site_code: m.code, name: m.name, name_ar: it.name_ar ?? null, region_id: m.region_id as SiteBoardCard['region_id'], overall_status: m.status, delivery_scenario: m.scenario,
      contractor: s >= 4 ? PARTY : null, entered_on: '2026-10-01', ageing_wd: (i * 3) % 25, sla_colour: worst,
      at_l1: own.filter((t) => t.state === 'open' || t.state === 'entry').length, at_l2: own.filter((t) => t.state === 'in_review' || t.state === 'in_approval').length,
      late_count: own.filter((t) => t.sla?.colour === 'red').length,
    },
  };
}

/** The tasks of the board: the inbox tasks and the generated tasks of the first sites (not locked, N/A or skipped). */
function boardTasks(): MockTask[] {
  const gen = Array.from({ length: 8 }, (_, i) => siteTasks(i)).flat().filter((t) => ['open', 'entry', 'in_review', 'in_approval', 'approved'].includes(t.state));
  const merged = new Map<string, MockTask>();
  for (const t of [...db().tasks, ...db().extra, ...gen]) merged.set(t.id, db().ov[t.id] ?? t);
  return [...merged.values()];
}
const columnOf = (t: TaskSummary): 'entry' | 'review' | 'rejected' | 'approved' =>
  t.state === 'approved' ? 'approved' : t.state === 'in_review' || t.state === 'in_approval' ? 'review' : (t.return_count ?? 0) > 0 && !!t.last_return_note ? 'rejected' : 'entry';

export const boardHandlers = [
  http.get(`${B}/boards/sites`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const swim = (u.get('swimlane') ?? 'none') as SitesBoard['swimlane'];
    if (!['none', 'region', 'contractor'].includes(swim)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/swimlane', code: 'invalid' }] });
    const limit = Number(u.get('card_limit') ?? 20), q = (u.get('q') ?? '').toLowerCase(), regions = u.getAll('region_id').map(Number), status = u.get('overall_status'), sc = u.get('scenario');
    const placed = Array.from({ length: SITE_COUNT }, (_, i) => i).map(siteCard)
      .filter(({ card: c }) => (!q || `${c.site_code} ${c.name}`.toLowerCase().includes(q)) && (!regions.length || regions.includes(c.region_id)) && (!sc || c.delivery_scenario === sc)
        && (status ? c.overall_status === status : c.overall_status !== 'cancelled'));
    const laneOf = (c: SiteBoardCard) => (swim === 'region' ? String(c.region_id) : swim === 'contractor' ? c.contractor?.id ?? 'none' : 'all');
    const count = (col?: string, lane?: string) => placed.filter((p) => (!col || p.column === col) && (!lane || laneOf(p.card) === lane)).length;
    const columns: SitesBoard['columns'] = [...STAGE_CODES.map((code, s) => {
      const n = count(code), lim = wipState.limits[code] ?? null;
      return { key: code, kind: 'milestone' as const, name_en: STAGE_EN[s]!, name_ar: STAGE_AR[s]!, count: n, wip_limit: lim, over_wip: lim !== null && n > lim };
    }), { key: 'closed', kind: 'closed', name_en: 'Closed', name_ar: 'مغلق', count: count('closed'), wip_limit: null, over_wip: false }];
    const laneKeys = [...new Set(placed.map((p) => laneOf(p.card)))].sort((a, b) => (a === 'none' ? 1 : b === 'none' ? -1 : Number(a) - Number(b) || a.localeCompare(b)));
    const lanes: SitesBoard['lanes'] = laneKeys.map((k) => ({
      key: k, count: count(undefined, k),
      label_en: swim === 'region' ? REGIONS[Number(k) - 1]![0] : swim === 'contractor' ? (k === 'none' ? 'No contractor' : PARTY.name) : 'All sites',
      label_ar: swim === 'region' ? REGIONS[Number(k) - 1]![1] : swim === 'contractor' ? (k === 'none' ? 'دون مقاول' : null) : 'كل المواقع',
    }));
    const cells: SitesBoard['cells'] = [];
    for (const c of columns) for (const l of lanes) {
      const list = placed.filter((p) => p.column === c.key && laneOf(p.card) === l.key).map((p) => p.card).sort((a, b) => b.ageing_wd - a.ageing_wd || a.site_code.localeCompare(b.site_code));
      if (list.length) cells.push({ column: c.key, lane: l.key, count: list.length, more: list.length > limit, cards: list.slice(0, limit) });
    }
    return HttpResponse.json({ swimlane: swim, card_limit: limit, total: placed.length, columns, lanes, cells } satisfies SitesBoard);
  }),
  http.get(`${B}/boards/tasks`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams;
    const limit = Number(u.get('card_limit') ?? 30), q = (u.get('q') ?? '').toLowerCase(), site = u.get('site_id');
    const all = boardTasks().map(toSummary).filter((t) => (!q || `${t.site_code} ${t.task_code} ${t.name_en}`.toLowerCase().includes(q)) && (!site || t.site_id === site));
    const columns: TasksBoard['columns'] = (['entry', 'review', 'rejected', 'approved'] as const).map((key) => {
      const items = all.filter((t) => columnOf(t) === key);
      return { key, count: items.length, more: items.length > limit, items: items.slice(0, limit) };
    });
    return HttpResponse.json({ card_limit: limit, total: all.length, columns } satisfies TasksBoard);
  }),
  http.get(`${B}/settings/kanban-wip`, () => {
    const g = guard(); if (g) return g;
    return HttpResponse.json(wipBody(), { headers: { ETag: `"${wipState.version}"` } });
  }),
  http.put(`${B}/settings/kanban-wip`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!wipBody().can_edit) return problem(403, 'action_forbidden', 'Not allowed');
    if (request.headers.get('If-Match') !== `"${wipState.version}"`) return problem(412, 'precondition_failed', 'Stale');
    const b = await request.json() as { limits: Record<string, number | null>; reason?: string };
    if (!b.reason || b.reason.trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    const bad = Object.entries(b.limits ?? {}).find(([k, v]) => !STAGE_CODES.includes(k as never) || (v !== null && (!Number.isInteger(v) || v < 1 || v > 10000)));
    if (bad) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: `/limits/${bad[0]}`, code: STAGE_CODES.includes(bad[0] as never) ? 'out_of_range' : 'unknown_stage' }] });
    wipState.limits = Object.fromEntries(Object.entries(b.limits).filter((e): e is [string, number] => e[1] !== null));
    wipState.version += 1;
    wipState.updated_at = new Date().toISOString();
    return HttpResponse.json(wipBody(), { headers: { ETag: `"${wipState.version}"` } });
  }),
];
