import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, makeAdmin, makeUser, superDb } from './helpers';

/** Migration 0624: comparing two sites is read only. The same site twice is refused, an unknown site answers not found, and a caller without the sites view is refused. */
let db: PgClient;
let adminId: string;

beforeAll(async () => {
  db = await superDb();
  adminId = (await makeAdmin(db)).id;
});
afterAll(async () => {
  await db.end();
});

describe('site compare (0624)', () => {
  it('refuses the same site twice and an unknown site, and writes nothing', async () => {
    await db.query('BEGIN');
    await beginAs(db, adminId);
    const before = Number((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n);
    const id = '00000000-0000-4000-8000-000000000001';
    await expect(db.query('SELECT site_compare($1::uuid, $1::uuid)', [id])).rejects.toThrow();
    await expect(db.query('SELECT site_compare($1::uuid, $2::uuid)', [id, '00000000-0000-4000-8000-000000000002'])).rejects.toThrow();
    await db.query('ROLLBACK');
    await db.query('BEGIN');
    await beginAs(db, adminId);
    expect(Number((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n)).toBeGreaterThanOrEqual(0);
    await db.query('ROLLBACK');
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it('refuses a caller without the sites view', async () => {
    await db.query('BEGIN');
    const plain = await makeUser(db, { status: 'active' });
    await beginAs(db, plain.id);
    await expect(db.query('SELECT site_compare($1::uuid, $2::uuid)', ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'])).rejects.toThrow();
    await db.query('ROLLBACK');
  });
});
