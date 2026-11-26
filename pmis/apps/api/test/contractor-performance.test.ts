import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expiryLevel, overall, pctLevel } from '../src/contractors/contractor-performance.service';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.89: the contractor performance view is computed and read only; its thresholds are an audited setting. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

describe('levels', () => {
  const t = { amber: 10, red: 25 };
  it('a percentage is insufficient below the least sample, then ok, amber, red', () => {
    expect(pctLevel(1, 2, t, 3).level).toBe('insufficient');
    expect(pctLevel(0, 0, t, 3)).toEqual({ pct: null, level: 'insufficient' });
    expect(pctLevel(0, 10, t, 3).level).toBe('ok');
    expect(pctLevel(1, 10, t, 3).level).toBe('amber');
    expect(pctLevel(3, 10, t, 3)).toEqual({ pct: 30, level: 'red' });
  });
  it('the contract turns amber then red as the days left fall', () => {
    const d = { amber: 60, red: 15 };
    expect(expiryLevel(null, d)).toBe('insufficient');
    expect(expiryLevel(100, d)).toBe('ok');
    expect(expiryLevel(60, d)).toBe('amber');
    expect(expiryLevel(15, d)).toBe('red');
    expect(expiryLevel(-5, d)).toBe('red');
  });
  it('the overall level is the worst known one', () => {
    expect(overall(['insufficient', 'insufficient'])).toBe('insufficient');
    expect(overall(['ok', 'insufficient'])).toBe('ok');
    expect(overall(['ok', 'red', 'amber'])).toBe('red');
  });
});

describe('contractor performance API', () => {
  it('a caller without the contractors view is refused', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await a.api.call('get', '/reports/contractor-performance')).status).toBe(403);
  });

  it('the thresholds change only with a reason and If-Match, are audited, and reject a red below the amber', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const g = await api.call('get', '/settings/contractor-performance');
    expect(g.status).toBe(200);
    const th = g.body.thresholds;
    const bad = await api.call('put', '/settings/contractor-performance', { reason: 'test bad', thresholds: { ...th, snag_overdue_pct: { amber: 30, red: 10 } } }, { 'If-Match': `"${g.body.version}"` });
    expect(bad.status).toBe(422);
    const ok = await api.call('put', '/settings/contractor-performance', { reason: 'test ok', thresholds: { ...th, min_sample: th.min_sample === 4 ? 5 : 4 } }, { 'If-Match': `"${g.body.version}"` });
    expect(ok.status).toBe(200);
    const au = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'contractor_performance_thresholds_update'`);
    expect(au.rows[0].n).toBeGreaterThanOrEqual(1);
    const back = await api.call('put', '/settings/contractor-performance', { reason: 'test restore', thresholds: th }, { 'If-Match': `"${ok.body.version}"` });
    expect(back.status).toBe(200);
    const rep = await api.call('get', '/reports/contractor-performance');
    expect(rep.status).toBe(200);
    expect(Array.isArray(rep.body.items)).toBe(true);
  });
});
