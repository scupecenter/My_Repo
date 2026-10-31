import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import type request from 'supertest';
import type { Api } from './helpers';
import { Actor, Site, actor, makeSite } from './wf-helpers';

/** Fixtures for the register framework (migration 0019), written straight into the database as the superuser. */

export const G = (module: string, ...actions: string[]): [string, string][] => actions.map((a) => [module, a]);

/** Replaces the region cell of a register row (key, level, region) and names its holders. */
export async function regCell(
  db: PgClient, key: string, region: number, kind: 'entry' | 'review' | 'approve',
  assignees: { user?: string[]; role?: string[]; group?: string[] }, rule: 'any_one' | 'all_members' = 'any_one',
): Promise<string> {
  const level = kind === 'entry' ? 1 : kind === 'review' ? 2 : 3;
  await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id = $3', [key, level, region]);
  const c = await db.query(
    'INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ($1, $2, $3::"MatrixRule", $4, false, now()) RETURNING id',
    [key, level, rule, region],
  );
  const id = c.rows[0].id as string;
  for (const [k, list] of [['user', assignees.user], ['role', assignees.role], ['group', assignees.group]] as const) {
    for (const ref of list ?? []) await db.query('INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, $2::"AssigneeKind", $3)', [id, k, ref]);
  }
  return id;
}

export interface Team {
  entry: Actor;
  review: Actor;
  approve: Actor;
  site: Site;
  region: number;
  key: string;
}

/** One entry, one review and one approve holder of the register row in a region, and a site there (GECOL and HLC scope on). */
export async function team(app: NestExpressApplication, db: PgClient, key: string, module: string, region: number): Promise<Team> {
  const entry = await actor(app, db, { level: 'entry', grants: G(module, 'view', 'create', 'edit'), regions: [region], modules: null });
  const review = await actor(app, db, { level: 'review', grants: G(module, 'view'), regions: [region], modules: null });
  const approve = await actor(app, db, { level: 'approve', grants: G(module, 'view', 'approve'), regions: [region], modules: null });
  await regCell(db, key, region, 'entry', { user: [entry.user.id] });
  await regCell(db, key, region, 'review', { user: [review.user.id] });
  await regCell(db, key, region, 'approve', { user: [approve.user.id] });
  const site = await makeSite(db, region, { prefix: 'REG' });
  await db.query(`UPDATE sites SET scope_gecol_power = 'yes', scope_hlc_fiber = 'yes' WHERE id = $1`, [site.id]);
  return { entry, review, approve, site, region, key };
}

/** The same team on another site of the region (GECOL and HLC have one logical record per site). */
export async function otherSite(db: PgClient, t: Team): Promise<Team> {
  const site = await makeSite(db, t.region, { prefix: 'REG' });
  await db.query(`UPDATE sites SET scope_gecol_power = 'yes', scope_hlc_fiber = 'yes' WHERE id = $1`, [site.id]);
  return { ...t, site };
}

export const recPath = (key: string, id?: string, tail = ''): string => `/registers/${key}/records${id ? `/${id}` : ''}${tail}`;

export const post = (api: Api, key: string, id: string, action: string, version: number, body?: unknown): request.Test =>
  api.call('post', recPath(key, id, `/${action}`), body, { 'If-Match': `"${version}"` });

export const patch = (api: Api, key: string, id: string, version: number, body: unknown): request.Test =>
  api.call('patch', recPath(key, id), body, { 'If-Match': `"${version}"` });

export const PROC = { scope: 'CW', delivery: 'Outsourced', pr_no: 'PR-1001', pr_date: '2026-01-05', order_status: 'Open' };
export const GECOL = { pr_no: 'GP-1', request_date: '2026-01-05' };
export const HLC = { request_no: 'HR-1', request_date: '2026-01-05' };
export const PERMIT_CW = { permit_type: 'Access - CW', status: 'Approved', valid_from: '2025-12-01', valid_to: '2034-12-31' };

/** Creates a record as the team's entry holder and returns its body. */
export async function createRec(t: Team, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await t.entry.api.call('post', recPath(t.key), { site_id: t.site.id, data, ...extra });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}

/** Submits, reviews and approves a record through the team's three holders (3 levels). Returns the final body. */
export async function approveAll(t: Team, id: string, version: number): Promise<Record<string, any>> {
  let res = await post(t.entry.api, t.key, id, 'submit', version);
  if (res.status !== 200) throw new Error(`submit failed: ${res.status} ${JSON.stringify(res.body)}`);
  res = await post(t.review.api, t.key, id, 'review', res.body.version);
  if (res.status !== 200) throw new Error(`review failed: ${res.status} ${JSON.stringify(res.body)}`);
  await t.approve.api.stepUp(t.approve.user.password);
  res = await post(t.approve.api, t.key, id, 'approve', res.body.version);
  if (res.status !== 200) throw new Error(`approve failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}
