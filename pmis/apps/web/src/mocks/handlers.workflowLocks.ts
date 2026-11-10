import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import type { SiteImportStatus, SiteWorkflowLocksResult } from '@/api/types';
import { db, save, stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';
import { gapsOf, locksOf, siteIndex, SITE_COUNT, siteMeta } from './sites';

/**
 * Contract 0.15.4 (migration 0085): the per-site workflow locks and the status of the sites of an import. The mock keeps the switched sites in
 * `db().siteLocks` (site id -> locked); only the System Admin (account `pm`) may switch them, with a reason and a step-up, as the server decides.
 */
const canManageLocks = () => viewer()?.key === 'pm';

function apply(ids: string[], locked: boolean, reason: unknown) {
  if (!canManageLocks()) return problem(403, 'action_forbidden', 'Switching the workflow locks needs a System Admin or the delegated right to unlock.');
  if (typeof reason !== 'string' || reason.trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required', message: 'A reason of 3 to 2000 characters is required.' }] });
  if (!stepUpValid()) return stepUp();
  const d = db();
  d.siteLocks = d.siteLocks ?? {};
  const sites = ids.map((id) => {
    const i = siteIndex(id);
    const before = locksOf(id), changed = before !== locked;
    d.siteLocks[id] = locked;
    return { site_id: id, site_code: i >= 0 ? siteMeta(i).code : id, workflow_locks: locked, changed, tasks_opened: changed && !locked ? ['A2'] : [], tasks_relocked: [] };
  });
  save();
  const changed = sites.filter((s) => s.changed).length;
  return HttpResponse.json<SiteWorkflowLocksResult>({ workflow_locks: locked, changed, unchanged: sites.length - changed, sites });
}

/** The status rows of a list of mock site indexes (the run and batch pages). */
export function importSites(idx: number[], gapsOnly: boolean): SiteImportStatus[] {
  return idx.map((i) => {
    const m = siteMeta(i), id = m.id;
    return { site_id: id, site_code: m.code, name: m.name, region_id: m.region_id as SiteImportStatus['region_id'], overall_status: m.status as SiteImportStatus['overall_status'], workflow_locks: locksOf(id),
      current_stream: 'CW', current_milestone: 'MS1', next_milestone: 'MS2', done_tasks: 6 + (i % 5), total_tasks: 40, warnings: i % 3 === 0 ? 3 : 0, errors: i % 5 === 4 ? 1 : 0, data_gaps: gapsOf(i) };
  }).filter((r) => !gapsOnly || r.warnings > 0 || r.data_gaps > 0);
}

export const workflowLocksHandlers = [
  http.put(`${B}/sites/:id/workflow-locks`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const i = siteIndex(params.id as string);
    if (i < 0 || i >= SITE_COUNT) return problem(404, 'not_found', 'Site not found');
    const b = (await request.json()) as { locked?: boolean; reason?: string };
    return apply([params.id as string], b.locked !== false, b.reason);
  }),
  http.post(`${B}/sites/workflow-locks`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = (await request.json()) as { locked?: boolean; reason?: string; site_ids?: string[]; master_run_id?: string; import_batch_id?: string };
    const ids = b.site_ids ?? (b.master_run_id || b.import_batch_id ? Array.from({ length: 6 }, (_, i) => siteMeta(i).id) : []);
    if (!ids.length) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/site_ids', code: 'required', message: 'No site to change.' }] });
    return apply(ids, b.locked !== false, b.reason);
  }),
  ...(['master-import/runs', 'import-batches'] as const).map((p) => http.get(`${B}/${p}/:id/sites`, ({ request }) => {
    const g = guard(); if (g) return g;
    const items = importSites([0, 1, 2, 3, 4, 5], new URL(request.url).searchParams.get('gaps') === 'only');
    return HttpResponse.json({ items, page: { limit: 50, next_cursor: null, total: items.length } });
  })),
];
