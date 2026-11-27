import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardCacheService } from '../src/dashboard/dashboard-cache.service';
import { startApp, superDb } from './helpers';
import { Actor, actor, makeSite, plainAdmin } from './wf-helpers';

/**
 * The short /dashboard cache (30 s, scope-keyed, single-flight, cleared by configuration writes). The checks that matter: an entry never serves another
 * scope, the rights check runs before the cache on every request, a configuration write clears it at once, the TTL ends an entry, a clear during a load
 * keeps that load out of the cache, and 100 callers of one key run the function once.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let reg1: Actor;
let reg2: Actor;
let none: Actor;
const G = [['dashboard', 'view'], ['issues', 'view'], ['sites', 'view']] as [string, string][];

beforeAll(async () => {
  process.env.DASHBOARD_CACHE_TTL_MS = '30000';
  app = await startApp();
  db = await superDb();
  await makeSite(db, 1);
  await makeSite(db, 2);
  admin = await plainAdmin(app, db);
  reg1 = await actor(app, db, { regions: [1], grants: G });
  reg2 = await actor(app, db, { regions: [2], grants: G });
  none = await actor(app, db, { regions: [1], grants: [['sites', 'view']] });
});
afterAll(async () => {
  delete process.env.DASHBOARD_CACHE_TTL_MS;
  await db.end();
  await app.close();
});

const get = async (a: Actor) => {
  const res = await a.api.call('get', '/dashboard');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body;
};

describe('GET /dashboard cache', () => {
  it('serves a repeat from the cache with the time the figures were read, and never lets one scope see another', async () => {
    const a1 = await get(reg1);
    const a2 = await get(reg1);
    expect(a2.meta.as_of).toBe(a1.meta.as_of); // the second answer is the first one's figures
    const b = await get(reg2);
    const all = await get(admin);
    expect(a1.regions.items.map((r: { region_id: number }) => r.region_id)).toEqual([1]);
    expect(b.regions.items.map((r: { region_id: number }) => r.region_id)).toEqual([2]);
    expect(b.meta.scope_regions).toEqual([2]);
    expect(all.regions.items.length).toBeGreaterThan(1);
    // asked again in the other order: each still sees only its own regions
    expect((await get(reg1)).regions.items.map((r: { region_id: number }) => r.region_id)).toEqual([1]);
    expect((await get(reg2)).regions.items.map((r: { region_id: number }) => r.region_id)).toEqual([2]);
  });

  it('checks the right on every request: a caller without the dashboard right gets 403 although the same regions are cached', async () => {
    await get(reg1);
    expect((await none.api.call('get', '/dashboard')).status).toBe(403);
  });

  it('a configuration write clears the cache at once', async () => {
    const before = await get(reg1);
    expect((await get(reg1)).meta.as_of).toBe(before.meta.as_of);
    const put = await admin.api.call('put', '/dashboard/pipeline-variant', { variant: before.meta.pipeline_variant === 'A' ? 'B' : 'A', reason: 'Cache test' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = await get(reg1);
    expect(after.meta.as_of).not.toBe(before.meta.as_of); // recomputed
    await admin.api.call('put', '/dashboard/pipeline-variant', { variant: before.meta.pipeline_variant, reason: 'Cache test back' });
  });
});

describe('DashboardCacheService', () => {
  const make = (ttl: string) => {
    const old = process.env.DASHBOARD_CACHE_TTL_MS;
    process.env.DASHBOARD_CACHE_TTL_MS = ttl;
    const c = new DashboardCacheService();
    if (old === undefined) delete process.env.DASHBOARD_CACHE_TTL_MS;
    else process.env.DASHBOARD_CACHE_TTL_MS = old;
    return c;
  };
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

  it('ends an entry after the TTL and gives every caller its own copy', async () => {
    const c = make('60');
    let n = 0;
    const load = async () => ({ n: ++n, list: [1, 2] });
    const first = await c.getOrLoad('k', load);
    (first.value.list as number[]).push(99); // a caller changing its copy does not change the cached one
    expect((await c.getOrLoad('k', load)).value).toEqual({ n: 1, list: [1, 2] });
    await sleep(90);
    expect((await c.getOrLoad('k', load)).value.n).toBe(2);
  });

  it('runs one load for many concurrent callers of the same key, and one per key', async () => {
    const c = make('5000');
    let n = 0;
    const load = async () => { await sleep(30); return { n: ++n }; };
    const rs = await Promise.all(Array.from({ length: 100 }, () => c.getOrLoad('same', load)));
    expect(new Set(rs.map((r) => r.value.n)).size).toBe(1);
    expect(n).toBe(1);
    await Promise.all([c.getOrLoad('a', load), c.getOrLoad('b', load)]);
    expect(n).toBe(3);
  });

  it('a clear while a load runs keeps that load out of the cache; clear empties it; 0 turns it off; at most 200 entries', async () => {
    const c = make('5000');
    let n = 0;
    const slow = async () => { await sleep(40); return { n: ++n }; };
    const p = c.getOrLoad('k', slow);
    c.clear();
    expect((await p).value.n).toBe(1); // the waiting caller still gets its answer
    expect((await c.getOrLoad('k', slow)).value.n).toBe(2); // but it was not stored
    c.clear();
    expect(c.size()).toBe(0);
    const off = make('0');
    let m = 0;
    expect((await off.getOrLoad('k', async () => ({ m: ++m }))).value.m).toBe(1);
    expect((await off.getOrLoad('k', async () => ({ m: ++m }))).value.m).toBe(2);
    const big = make('5000');
    for (let i = 0; i < 230; i++) await big.getOrLoad(`k${i}`, async () => ({ i }));
    expect(big.size()).toBe(200);
  });
});
