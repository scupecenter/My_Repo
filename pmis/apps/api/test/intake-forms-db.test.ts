import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

let db: Pg;
beforeAll(async () => { db = await superDb(); });
afterAll(async () => { await db.end(); });

describe('public intake forms: database shape (0730)', () => {
  it('both tables force row level security, so only the functions are a door', async () => {
    const r = await db.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('intake_forms','intake_submissions') ORDER BY relname`);
    expect(r.rows).toEqual([
      { relname: 'intake_forms', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'intake_submissions', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('the token hash must be a sha-256 hex string (a raw token cannot be stored)', async () => {
    const cols = await db.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'intake_forms'::regclass AND contype = 'c'`);
    expect(cols.rows.some((c: { d: string }) => c.d.includes('token_hash') && c.d.includes('[0-9a-f]{64}'))).toBe(true);
  });

  it('a link that does not exist is answered with nothing', async () => {
    const r = await db.query(`SELECT intake_form_peek(repeat('0', 64)) AS j`);
    expect(r.rows[0].j).toBeNull();
  });

  it('the data reset keeps both tables', async () => {
    const r = await db.query(`SELECT tbl, action FROM data_reset_plan() WHERE tbl IN ('intake_forms', 'intake_submissions') ORDER BY tbl`);
    expect(r.rows).toEqual([{ tbl: 'intake_forms', action: 'KEEP' }, { tbl: 'intake_submissions', action: 'KEEP' }]);
  });
});
