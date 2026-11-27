import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/**
 * Migration 0546 (0.15.269): the Arabic names of the 45 progress weight items are backfilled in every project_status set (published and drafts), an
 * Arabic name already typed is kept, and the published-set freeze now allows a name_ar-only update while still blocking everything else.
 */
let db: PgClient;

beforeAll(async () => {
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

const ITEMS = `FROM weight_items i JOIN weight_activities a ON a.id = i.activity_id JOIN weight_sets s ON s.id = a.weight_set_id WHERE s.code = 'project_status'`;

describe('name_ar backfill (0546)', () => {
  it('fills every item of every project_status set', async () => {
    const r = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE i.name_ar IS NULL OR btrim(i.name_ar) = '')::int AS empty ${ITEMS}`);
    expect(r.rows[0]!.n).toBeGreaterThanOrEqual(45);
    expect(r.rows[0]!.empty).toBe(0);
  });

  it('keeps the owner-approved antenna names', async () => {
    const r = await db.query(`SELECT i.code, i.name_ar ${ITEMS} AND s.status = 'published' AND i.code IN ('3.2', '3.3', '3.4')`);
    const m = Object.fromEntries(r.rows.map((x) => [x.code, x.name_ar]));
    expect(m['3.2']).toBe('هوائي الراديو');
    expect(m['3.3']).toBe('هوائي التراسل');
    expect(m['3.4']).toBe('هوائي طرفي');
  });

  it('still blocks a weight change on the published set but allows a name_ar-only update', async () => {
    const r = await db.query(`SELECT i.id, i.name_ar ${ITEMS} AND s.status = 'published' LIMIT 1`);
    const { id, name_ar } = r.rows[0]!;
    await expect(db.query('UPDATE weight_items SET weight = weight + 1 WHERE id = $1', [id])).rejects.toThrow();
    await db.query('UPDATE weight_items SET name_ar = $2 WHERE id = $1', [id, name_ar]);
  });
});
