import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDbDash } from './helpers';
import { actor, plainAdmin } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * Performance (CLAUDE.md: pages under 2 s with 1000 sites): the dashboard, Project Status and the weekly snapshot on 1000 synthetic sites (dash-seed.sql),
 * in a database of their own (TEST_DATABASE_URL_DASHPERF). The time is the whole HTTP call, the median of five; it must stay under 2 s.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let regional: Actor;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DASHPERF as string });
  db = await superDbDash(true);
  await db.query(readFileSync(join(__dirname, 'dash-seed.sql'), 'utf8'));
  await db.query("SELECT dash_seed_sites(1000, 'PF')");
  await db.query('ANALYZE');
  admin = await plainAdmin(app, db, true);
  regional = await actor(app, db, { regions: [1, 2], grants: [['dashboard', 'view'], ['issues', 'view'], ['sites', 'view']] });
}, 120_000);
afterAll(async () => {
  await db.end();
  await app.close();
});

/** The median time of `runs` calls (one slow run under load is not the page time), and the body of the last one. */
async function slowest(a: Actor, path: string, runs = 5): Promise<{ ms: number; body: any }> {
  const times: number[] = [];
  let body: unknown;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = await a.api.call('get', path);
    times.push(performance.now() - t0);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    body = res.body;
  }
  times.sort((x, y) => x - y);
  return { ms: times[Math.floor(times.length / 2)]!, body };
}

describe('1000 sites', () => {
  it('the dashboard answers in under 2 seconds, for all regions and for two regions', async () => {
    const all = await slowest(admin, '/dashboard');
    expect(all.body.headline.sites_total).toBe(973); // 1000 sites, every 37th is cancelled
    expect(all.ms).toBeLessThan(2000);
    const two = await slowest(regional, '/dashboard');
    expect(two.body.headline.sites_total).toBeLessThan(all.body.headline.sites_total);
    expect(two.body.regions.items.map((r: { region_id: number }) => r.region_id)).toEqual([1, 2]);
    expect(two.ms).toBeLessThan(2000);
  });

  it('a filtered view, a past reference date, Project Status by region and by site, and the export stay under 2 seconds too', async () => {
    const day = (await db.query("SELECT (cal_today() - 30)::text AS d")).rows[0].d as string;
    expect((await slowest(admin, `/dashboard?region_id=3&scenario=new_build`, 3)).ms).toBeLessThan(2000);
    expect((await slowest(admin, `/dashboard?ref_date=${day}`, 3)).ms).toBeLessThan(2000);
    expect((await slowest(admin, '/project-status?group_by=region', 3)).ms).toBeLessThan(2000);
    const bySite = await slowest(admin, '/project-status?group_by=site', 3);
    expect(bySite.body.rows.length).toBeGreaterThan(900);
    expect(bySite.ms).toBeLessThan(2000);
    expect((await slowest(admin, '/dashboard/export', 3)).ms).toBeLessThan(2000);
  }, 180_000);

  it('the weekly snapshot of 1000 sites is stored in one run, and a past date with a snapshot is also fast', async () => {
    const day30 = (await db.query('SELECT (cal_today() - 30)::text AS d')).rows[0].d as string;
    const t0 = performance.now();
    const n = (await db.query('SELECT dash_snapshot_take($1::date) AS n', [day30])).rows[0].n as number;
    expect(n).toBe(1000);
    expect(performance.now() - t0).toBeLessThan(30_000);
    expect((await db.query('SELECT count(*)::int AS n FROM progress_snapshots WHERE snapshot_date = $1', [day30])).rows[0].n).toBe(8);
    const read = await slowest(admin, `/dashboard?ref_date=${day30}`);
    expect(read.body.basis.source).toBe('snapshot');
    expect(read.ms).toBeLessThan(2000);
  }, 180_000);
  it('the site map (OV-12, 0.14.5) of 1000 sites answers in under 2 seconds, for all regions and for two regions', async () => {
    const all = await slowest(admin, '/dashboard/site-map');
    expect(all.body.items).toHaveLength(1000);
    expect(all.body.counts.cancelled).toBe(27);
    expect(all.ms).toBeLessThan(2000);
    const two = await slowest(regional, '/dashboard/site-map');
    expect(two.body.items.every((x: { region_id: number }) => x.region_id === 1 || x.region_id === 2)).toBe(true);
    expect(two.ms).toBeLessThan(2000);
  }, 120_000);
});
