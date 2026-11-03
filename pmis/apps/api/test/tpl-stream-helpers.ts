import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { q } from './calc-helpers';
import type { Api } from './helpers';
import { G } from './reg-helpers';
import { CellMap, TPL_GRANTS_ENTRY, TPL_GRANTS_VIEW, downloadTemplate, fillTemplate } from './tpl-helpers';
import { Actor, Site, actor, addAssignment, makeSite, makeTask, setCell } from './wf-helpers';

/** Fixtures for the Site Register stream templates and TPL-MASTER (migration 0051): people who hold L1 and L2 of the tasks of one region, and a site with tasks. */

/** A region that only these suites use for task cells (other suites run in parallel on the same database). */
export const SR = 7;
/** A region none of the callers holds. */
export const SOUT = 3;

export interface StreamTeam {
  entry: Actor;
  approve: Actor;
  site: Site;
  region: number;
  tasks: Record<string, string>;
}

export const SITE_ENTRY_GRANTS: [string, string][] = [...G('sites', 'view', 'edit'), ...TPL_GRANTS_ENTRY];
export const SITE_APPROVE_GRANTS: [string, string][] = [...G('sites', 'view', 'approve'), ...G('approvals', 'view', 'approve'), ...TPL_GRANTS_VIEW];

/**
 * An L1 holder and an L2 holder of the given tasks in the region, and one site with those tasks in the given states.
 * `sameUser` makes the entry holder the approver as well (self-approval, B5).
 */
export async function streamTeam(
  app: NestExpressApplication, db: PgClient, states: Record<string, string>, o: { region?: number; sameUser?: boolean; site?: Site; stepUp?: boolean } = {},
): Promise<StreamTeam> {
  const region = o.region ?? SR;
  const entry = await actor(app, db, { level: o.sameUser ? 'approve' : 'entry', grants: o.sameUser ? [...SITE_ENTRY_GRANTS, ...G('sites', 'approve'), ...G('approvals', 'view', 'approve')] : SITE_ENTRY_GRANTS,
    regions: [region], modules: null, stepUp: o.stepUp });
  const approve = o.sameUser ? entry : await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [region], modules: null });
  const site = o.site ?? (await makeSite(db, region, { prefix: 'SRT' }));
  const tasks: Record<string, string> = {};
  for (const [code, state] of Object.entries(states)) {
    tasks[code] = await makeTask(db, site, code, state);
    await setCell(db, code, region, 'entry', { user: [entry.user.id] });
    await setCell(db, code, region, 'approve', { user: [approve.user.id] });
  }
  return { entry, approve, site, region, tasks };
}

/** Another site of the team's region with the same tasks (the cells are already set). */
export async function moreSite(db: PgClient, t: StreamTeam, states: Record<string, string>): Promise<StreamTeam> {
  const site = await makeSite(db, t.region, { prefix: 'SRT' });
  const tasks: Record<string, string> = {};
  for (const [code, state] of Object.entries(states)) tasks[code] = await makeTask(db, site, code, state);
  return { ...t, site, tasks };
}

/** Downloads the template as the caller and fills rows by header text. */
export async function filled(api: Api, templateId: string, rows: CellMap[], query = ''): Promise<Buffer> {
  const dl = await downloadTemplate(api, templateId, query);
  if (dl.status !== 200) throw new Error(`download ${templateId} failed: ${dl.status} ${JSON.stringify(dl.body)}`);
  return fillTemplate(dl.buffer, rows);
}

export const taskRow = async (db: PgClient, id: string): Promise<{ state: string; actual_date: string | null; planned_date: string | null; actual_start: string | null; values: Record<string, unknown> | null; version: number }> =>
  (await q<{ state: string; actual_date: string | null; planned_date: string | null; actual_start: string | null; values: Record<string, unknown> | null; version: number }>(
    db, `SELECT state::text AS state, actual_date::text AS actual_date, planned_date::text AS planned_date, actual_start::text AS actual_start, "values" AS values, version FROM task_instances WHERE id = $1`, [id]))[0]!;

/** A user who also holds the sites grants of an entry holder (for the Master tests that mix a register and the Site Register). */
export async function giveSiteGrants(db: PgClient, userId: string, region: number): Promise<void> {
  await addAssignment(db, userId, { level: 'entry', regions: [region], modules: null, grants: SITE_ENTRY_GRANTS });
}

/** The sites grants of an approve holder, added to a user who already holds a register team role. */
export async function giveSiteApprove(db: PgClient, userId: string, region: number): Promise<void> {
  await addAssignment(db, userId, { level: 'approve', regions: [region], modules: null, grants: SITE_APPROVE_GRANTS });
}
