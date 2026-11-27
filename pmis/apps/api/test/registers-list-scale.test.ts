import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { plainAdmin } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * D62 (finding 3b of the production readiness review): GET /registers/{key} chooses the page first (ids only, same filter and sort) and computes the per-row
 * workflow functions for those rows alone, and reads both counts in one pass. With 10 000 records a page of 50 must come back fast, in the same order, with the
 * same counts, and the next page must continue it. The test also logs EXPLAIN ANALYZE times of the old shape (functions per row before the limit) and the new
 * shape, so the gain shows in the CI log.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
const KEY = 'lessons_learned';
const TAG = `lscale${Date.now().toString(36)}`;
const N = 10000;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  await db.query(`SET session_replication_role = replica`); // bulk fixture: no row triggers
  await db.query(
    `INSERT INTO register_records (entity_id, register_key, record_type, is_global, state, levels_required, data, created_at, updated_at)
     SELECT gen_random_uuid(), $1, NULL, true, 'entry', 3, jsonb_build_object('title', $2 || ' ' || g), now() - (g || ' seconds')::interval, now() FROM generate_series(1, ${N}) g`,
    [KEY, TAG],
  );
  await db.query(`SET session_replication_role = DEFAULT`);
}, 120000);
afterAll(async () => {
  await db.query(`SET session_replication_role = replica`);
  await db.query(`DELETE FROM register_records WHERE register_key = $1 AND data ->> 'title' LIKE $2`, [KEY, `${TAG}%`]);
  await db.query(`SET session_replication_role = DEFAULT`);
  await app.close();
  await db.end();
});

const explainMs = async (sql: string): Promise<number> => {
  const r = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
  return Number((r.rows[0]['QUERY PLAN'] as { 'Execution Time': number }[])[0]['Execution Time']);
};

describe('registers list at scale', () => {
  it(`returns a page of 50 of ${N} records fast, in order, with counts and a cursor that continues`, async () => {
    await admin.api.call('get', `/registers/${KEY}?limit=5`); // warm the app
    let ms = Infinity;
    let res = await admin.api.call('get', `/registers/${KEY}?limit=50`);
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      res = await admin.api.call('get', `/registers/${KEY}?limit=50`);
      ms = Math.min(ms, Date.now() - t0);
    }
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = res.body.items as { id: string; created_at: string }[];
    expect(items).toHaveLength(50);
    const times = items.map((i) => Date.parse(i.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times); // newest first
    expect((res.body.counts as { total: number }).total).toBeGreaterThanOrEqual(N);
    expect((res.body.counts as { filtered: number }).filtered).toBe((res.body.counts as { total: number }).total);
    const next = (res.body.page as { next_cursor: string | null }).next_cursor;
    expect(next).not.toBeNull();
    const p2 = await admin.api.call('get', `/registers/${KEY}?limit=50&cursor=${encodeURIComponent(next as string)}`);
    expect(p2.status).toBe(200);
    const ids2 = (p2.body.items as { id: string }[]).map((i) => i.id);
    expect(ids2).toHaveLength(50);
    expect(ids2.some((id) => items.some((i) => i.id === id))).toBe(false);
    expect(ms, `took ${ms} ms`).toBeLessThan(3000);
    console.log(`registers list, ${N} extra records, page of 50: ${ms} ms`);
  });

  it('a search and a filter keep the same results and counts', async () => {
    const res = await admin.api.call('get', `/registers/${KEY}?limit=20&q=${TAG}%2077`);
    expect(res.status).toBe(200);
    const f = (res.body.counts as { filtered: number }).filtered;
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(N);
    expect((res.body.items as unknown[]).length).toBe(Math.min(20, f));
  });

  it('logs the EXPLAIN ANALYZE times: functions per row before the limit (old shape) against the page first (new shape)', async () => {
    const fns = `reg_levels(r.id) AS n_levels, reg_warnings(r.id) AS warnings, reg_data_for(r.id, r.register_key, r.record_type, r.entity_id, r.data) AS data`;
    const oldMs = await explainMs(`SELECT r.id, ${fns} FROM register_records r LEFT JOIN LATERAL (SELECT 1) k ON true WHERE r.register_key = '${KEY}' ORDER BY r.created_at DESC, r.id DESC LIMIT 51`);
    const newMs = await explainMs(`SELECT r.id, ${fns} FROM register_records r WHERE r.id = ANY (ARRAY(SELECT x.id FROM register_records x WHERE x.register_key = '${KEY}' ORDER BY x.created_at DESC, x.id DESC LIMIT 51))`);
    console.log(`D62 EXPLAIN ANALYZE at ${N} records: old shape ${oldMs.toFixed(1)} ms, new shape ${newMs.toFixed(1)} ms`);
    expect(newMs).toBeLessThan(3000);
  });
});
