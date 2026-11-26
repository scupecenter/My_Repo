import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.84: GET /reports/gecol-hlc-counts is read only, admin only, and its numbers match the tables. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

describe('GET /reports/gecol-hlc-counts', () => {
  it('a caller without admin.settings view is refused', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    const r = await a.api.call('get', '/reports/gecol-hlc-counts');
    expect(r.status).toBe(403);
  });

  it('a System Admin gets the counts (between the table counts before and after, as other suites add records), and nothing is written by the call', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const totals = async () => {
      const w = await db.query(`
        WITH l AS (SELECT DISTINCT ON (entity_id) entity_id, register_key FROM register_records WHERE register_key IN ('gecol','hlc','procurement') ORDER BY entity_id, version_no DESC)
        SELECT register_key, count(*)::int AS n FROM l GROUP BY 1`);
      return (k: string): number => w.rows.find((x) => x.register_key === k)?.n ?? 0;
    };
    const lo = await totals();
    const r = await api.call('get', '/reports/gecol-hlc-counts');
    expect(r.status).toBe(200);
    const hi = await totals();
    expect(r.body.gecol.total).toBeGreaterThanOrEqual(lo('gecol'));
    expect(r.body.gecol.total).toBeLessThanOrEqual(hi('gecol'));
    expect(r.body.hlc.total).toBeGreaterThanOrEqual(lo('hlc'));
    expect(r.body.hlc.total).toBeLessThanOrEqual(hi('hlc'));
    expect(r.body.procurement.total).toBeGreaterThanOrEqual(lo('procurement'));
    expect(r.body.procurement.total).toBeLessThanOrEqual(hi('procurement'));
    expect(r.body.gecol.by_state.reduce((a: number, x: { count: number }) => a + x.count, 0)).toBe(r.body.gecol.total);
    expect(r.body.hlc.linked_to_procurement + r.body.hlc.not_linked).toBe(r.body.hlc.total);
    expect(typeof r.body.sites.with_gecol_scope).toBe('number');
  });
});
