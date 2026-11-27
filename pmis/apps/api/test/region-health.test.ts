import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { actor, plainAdmin } from './wf-helpers';

/**
 * Region health (contract 0.15.241, migration 0341; item 12 of the PM-platforms research). GET /status-updates/region-health: one row per visible
 * region, the current week's Weekly status update or the missing-update flag. Regions 4 and 5: every CI file shares one throw-away database, and
 * x-status (regions 6 and 7) and x-features (region 2) post current-week region updates of their own; 4 and 5 stay free (beforeAll sweeps them too).
 */
const A = 4;
const B = 5;
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  // A clean current week for the two regions, in case a seed or a parallel file ever writes one.
  await db.query(`DELETE FROM status_updates WHERE region_id = ANY($1) AND week_start = public.cal_today() - extract(dow FROM public.cal_today())::int`, [[A, B]]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const LEAD_GRANTS: [string, string][] = [...G('sites', 'view'), ['overrides.reassign', 'administer']];
const lead = (regions: number[] | null = [A]) => actor(app, db, { level: 'approve', grants: LEAD_GRANTS, regions, modules: null });
const reader = (regions: number[] | null = [A]) => actor(app, db, { level: 'view', grants: G('sites', 'view'), regions, modules: null });
const input = (o: Record<string, unknown> = {}) => ({ scope: 'region', region_id: A, health: 'at_risk', summary: 'Power works late.', ...o });
const row = (res: { body: { items: { region_id: number }[] } }, region: number) =>
  res.body.items.find((i) => i.region_id === region) as {
    region_id: number;
    health: string | null;
    summary: string | null;
    author: { display_name: string } | null;
    updated_at: string | null;
    missing_update: boolean;
  };

describe('region health: who may call it', () => {
  it('needs a session (401) and the Sites module (403)', async () => {
    expect((await request(app.getHttpServer()).get(`${API}/status-updates/region-health`)).status).toBe(401);
    const noSites = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [A], modules: null });
    expect((await noSites.api.call('get', '/status-updates/region-health')).status).toBe(403);
  });
});

describe('region health: the board', () => {
  it('one row per region; a region without an update this week is flagged missing', async () => {
    const who = await lead([A]);
    expect((await who.api.call('post', '/status-updates', input())).status).toBe(201);
    const admin = await plainAdmin(app, db, false);
    const res = await admin.api.call('get', '/status-updates/region-health');
    expect(res.status).toBe(200);
    expect(res.body.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.items).toHaveLength(7);
    expect(res.body.items.map((i: { region_id: number }) => i.region_id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const a = row(res, A);
    expect(a.health).toBe('at_risk');
    expect(a.summary).toBe('Power works late.');
    expect(a.missing_update).toBe(false);
    expect(a.author?.display_name).toBeTruthy();
    expect(a.updated_at).toBeTruthy();
    const b = row(res, B);
    expect(b.health).toBeNull();
    expect(b.summary).toBeNull();
    expect(b.author).toBeNull();
    expect(b.updated_at).toBeNull();
    expect(b.missing_update).toBe(true);
  });

  it('reads follow the Sites regions of the caller', async () => {
    const r = await reader([B]);
    const res = await r.api.call('get', '/status-updates/region-health');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { region_id: number }) => i.region_id)).toEqual([B]);
  });

  it('the latest update of the week wins', async () => {
    const who = await lead([A]);
    expect((await who.api.call('post', '/status-updates', input({ health: 'on_track', summary: 'first' }))).status).toBe(201);
    expect((await who.api.call('post', '/status-updates', input({ health: 'off_track', summary: 'second' }))).status).toBe(201);
    const res = await who.api.call('get', '/status-updates/region-health');
    const a = row(res, A);
    expect(a.health).toBe('off_track');
    expect(a.summary).toBe('second');
    expect(a.missing_update).toBe(false);
  });

  it('a team update does not count as the region update', async () => {
    const who = await lead([B]);
    expect((await who.api.call('post', '/status-updates', { scope: 'team', team: 'cw', region_id: B, health: 'on_track', summary: 'team note' })).status).toBe(201);
    const res = await who.api.call('get', '/status-updates/region-health');
    expect(row(res, B).missing_update).toBe(true);
  });
});
