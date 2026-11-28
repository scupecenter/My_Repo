import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeAdmin, makeUser, superDb } from './helpers';

/** Migration 0623: time in stage is read only. A System Admin reads the report and a site that does not exist answers not found; nothing is written. */
let db: PgClient;
let adminId: string;

beforeAll(async () => {
  db = await superDb();
  adminId = (await makeAdmin(db)).id;
});
afterAll(async () => {
  await db.end();
});

describe('stage times (0623)', () => {
  it('answers the ranking with the closed shape and writes nothing', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const before = Number((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n);
    const r = await db.query('SELECT stage_times_report(NULL) AS j');
    expect(Array.isArray(r.rows[0].j.stages)).toBe(true);
    expect(Array.isArray(r.rows[0].j.slowest_sites)).toBe(true);
    for (const s of r.rows[0].j.stages as { rank: number | null; avg_days: number | null }[]) {
      if (s.avg_days !== null) expect(s.rank).toBeGreaterThanOrEqual(1);
    }
    expect(Number((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n)).toBe(before);
    await db.query('ROLLBACK');
  });

  it('answers not found for an unknown site and refuses a caller without the sites view', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    await expect(db.query(`SELECT site_stage_times('00000000-0000-4000-8000-000000000001'::uuid)`)).rejects.toThrow();
    await db.query('ROLLBACK');
    await db.query('BEGIN');
    const plain = await makeUser(db, { status: 'active' });
    await beginAs(db, plain.id);
    await expect(db.query('SELECT stage_times_report(NULL)')).rejects.toThrow();
    await db.query('ROLLBACK');
  });
});
