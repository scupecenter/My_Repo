import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeAdmin, superDb } from './helpers';

/**
 * Migration 0476 (D3): the Data quality report settings. admin_set_data_quality is the only writer (admin.settings edit for all regions, a reason,
 * If-Match, closed lists, one audit row); data_quality_state reads. The report itself is a read-only API query (no function, nothing written).
 */
let db: PgClient;
let adminId: string;
beforeAll(async () => {
  db = await superDb();
  adminId = (await makeAdmin(db)).id;
});
afterAll(async () => {
  await db.end();
});

const set = (body: unknown, reason: string, version: number | null) =>
  db.query('SELECT admin_set_data_quality($1::jsonb, $2, $3::int) AS j', [JSON.stringify(body), reason, version]);
const body = (over: Record<string, unknown> = {}) => ({ enabled: true, checks: ['site_required_empty', 'missing_photos'], required_site_fields: ['latitude', 'address'], max_rows: 50, ...over });

describe('data quality settings (0476)', () => {
  it('reads the defaults, saves a valid change with one audit row, and refuses a stale version, an unknown check and an unknown field', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const st = (await db.query('SELECT data_quality_state() AS j')).rows[0].j;
    expect(st.enabled).toBe(true);
    expect(st.checks).toContain('orphan_ids');
    expect(st.can_edit).toBe(true);
    const saved = (await set(body(), 'narrow the checks', st.version)).rows[0].j;
    expect(saved.checks).toEqual(['site_required_empty', 'missing_photos']);
    expect(saved.max_rows).toBe(50);
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'data_quality_update' AND entity_id = 'data_quality.report'`);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    await db.query('SAVEPOINT a');
    await expect(set(body({ max_rows: 60 }), 'stale', st.version)).rejects.toThrow();
    await db.query('ROLLBACK TO a');
    await expect(set(body({ checks: ['not_a_check'] }), 'bad check', saved.version)).rejects.toThrow();
    await db.query('ROLLBACK TO a');
    await expect(set(body({ required_site_fields: ['password'] }), 'bad field', saved.version)).rejects.toThrow();
    await db.query('ROLLBACK TO a');
    await expect(set({ ...body(), extra: 1 }, 'unknown key', saved.version)).rejects.toThrow();
    await db.query('ROLLBACK');
  });
});
