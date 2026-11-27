import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDbDash } from './helpers';
import { actor } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * Load test (production readiness review, item 1): 100 signed-in users at the same time on 1000 synthetic sites, a mix of the read screens people
 * open all day; the acceptance criterion is CLAUDE.md "pages under 2 s" (95th percentile) with no failed request.
 *
 * Repeatable, and off by default (it takes minutes): `LOAD_TEST=1 npm run test:load`. Knobs: LOAD_USERS (100), LOAD_THINK_MS (10000, 0 = back to back, a stress run), LOAD_POOL (database connections of the API, 10), LOAD_ROUNDS (20 passes of the mix per user),
 * LOAD_OUT (a file for the Markdown result table; default: print only). See docs/ops/load-test.md for how to read the result and what it does not prove.
 * The users and the app share one process here, so the numbers include the client side: they are a floor for the server, not a substitute for a run
 * against the production-like host (docs/ops/load-test.md, "Where to run it").
 */
const ON = process.env.LOAD_TEST === '1';
const USERS = Number(process.env.LOAD_USERS ?? 100);
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 20);
const SITES = Number(process.env.LOAD_SITES ?? 1000);
// The API opens at most this many database connections (Prisma `connection_limit`; its own default is 2 x CPUs + 1, 3 on a 1 vCPU box, which starves 100 users).
// Think time between two requests of one user (a person reads the page before the next click); each user starts at a random point inside it.
const THINK_MS = Number(process.env.LOAD_THINK_MS ?? 10_000);
const POOL = Number(process.env.LOAD_POOL ?? 10);
const MIX = ['/dashboard', '/dashboard/site-map', '/project-status?group_by=region', '/sites?limit=50', '/search?q=PF', '/me/profile'] as const;

let app: NestExpressApplication;
let db: PgClient;
const users: Actor[] = [];

const pct = (xs: number[], p: number): number => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

describe.skipIf(!ON)('load test: 100 users, 1000 sites', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL_DASHPERF as string);
    url.searchParams.set('connection_limit', String(POOL));
    app = await startApp({ databaseUrl: url.toString() });
    db = await superDbDash(true);
    await db.query(readFileSync(join(__dirname, 'dash-seed.sql'), 'utf8'));
    await db.query(`SELECT dash_seed_sites(${SITES}, 'PF')`);
    await db.query('ANALYZE');
    const grants: [string, string][] = [['dashboard', 'view'], ['issues', 'view'], ['sites', 'view']];
    for (let i = 0; i < USERS; i++) users.push(await actor(app, db, { regions: i % 5 === 0 ? null : [1 + (i % 7), 1 + ((i + 3) % 7)], grants }));
  }, 600_000);
  afterAll(async () => {
    await db?.end();
    await app?.close();
  });

  it('every user runs the mix at the same time: p95 under 2 s and no failed request', async () => {
    const lat: Record<string, number[]> = {};
    const bad: string[] = [];
    const started = performance.now();
    await Promise.all(users.map(async (u, i) => {
      await new Promise((ok) => setTimeout(ok, Math.random() * THINK_MS));
      for (let r = 0; r < ROUNDS; r++) {
        if (r > 0) await new Promise((ok) => setTimeout(ok, THINK_MS * (0.5 + Math.random())));
        const path = MIX[(i + r) % MIX.length]!;
        const t0 = performance.now();
        const res = await u.api.call('get', path);
        (lat[path] ??= []).push(performance.now() - t0);
        if (res.status !== 200) bad.push(`${path} -> ${res.status}`);
      }
    }));
    const wall = (performance.now() - started) / 1000;
    const all = Object.values(lat).flat().sort((a, b) => a - b);
    const rows = Object.entries(lat).map(([path, xs]) => {
      xs.sort((a, b) => a - b);
      return `| \`${path}\` | ${xs.length} | ${Math.round(pct(xs, 50))} | ${Math.round(pct(xs, 95))} | ${Math.round(pct(xs, 99))} | ${Math.round(xs[xs.length - 1]!)} |`;
    });
    const md = [
      `Load test: ${USERS} users at the same time, ${SITES} sites, pool ${POOL}, ${ROUNDS} requests each, think time ${THINK_MS / 1000} s (${all.length} in all), ${wall.toFixed(1)} s wall time, ${(all.length / wall).toFixed(1)} requests/s, ${bad.length} failed.`,
      '',
      '| Request | Count | p50 ms | p95 ms | p99 ms | Max ms |',
      '|---|---|---|---|---|---|',
      ...rows,
      `| **All** | ${all.length} | ${Math.round(pct(all, 50))} | ${Math.round(pct(all, 95))} | ${Math.round(pct(all, 99))} | ${Math.round(all[all.length - 1]!)} |`,
      '',
    ].join('\n');
    console.log(md);
    if (process.env.LOAD_OUT) writeFileSync(process.env.LOAD_OUT, md);
    expect(bad.slice(0, 5)).toEqual([]);
    expect(pct(all, 95)).toBeLessThan(2000);
  }, 900_000);
});
