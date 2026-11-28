import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.598: the Report Center library and a run (read only, through the register read path, with an as-of stamp). */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

describe('report library and run', () => {
  it('the library lists ready reports with their groups', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const r = await api.call('get', '/reports/library');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.groups.map((g: { key: string }) => g.key)).toContain('procurement');
    expect(r.body.items[0].register).toBeUndefined();
  });

  it('a run carries the as-of stamp and consistent groups and totals', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const r = await api.call('post', '/reports/procurement_status/run', {});
    expect(r.status).toBe(200);
    expect(Number.isNaN(Date.parse(r.body.as_of))).toBe(false);
    expect(r.body.freshness).toBe('live');
    const n = r.body.groups.reduce((s: number, g: { count: number }) => s + g.count, 0);
    expect(n).toBe(r.body.totals.count);
    expect(r.body.chart.series.length).toBe(r.body.groups.length);
  });

  it('an unknown report is 404 and a bad body is 422', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    expect((await api.call('post', '/reports/nope/run', {})).status).toBe(404);
    expect((await api.call('post', '/reports/procurement_status/run', { from: 'x' })).status).toBe(422);
  });

  it('a caller with no grants sees an empty library and cannot run', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    const lib = await a.api.call('get', '/reports/library');
    expect(lib.status).toBe(200);
    expect(lib.body.items.find((i: { key: string }) => i.key === 'procurement_status')).toBeUndefined();
    expect((await a.api.call('post', '/reports/procurement_status/run', {})).status).toBe(403);
  });
});
