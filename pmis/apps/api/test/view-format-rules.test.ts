import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/** Migration 0670: sv_strip also strips the conditional formatting rules of a column the reader may not see, and keeps the others. */
let db: PgClient;
beforeAll(async () => { db = await superDb(); });
afterAll(async () => { await db.end(); });

describe('sv_strip and columns.rules', () => {
  it('knows the rules key (changed in place) and keeps the rules of a visible column and the other column keys', async () => {
    const def = (await db.query(`SELECT pg_get_functiondef('public.sv_strip(text,jsonb,jsonb,jsonb)'::regprocedure) AS d`)).rows[0].d as string;
    expect(def).toContain(`'rules'`);
    const cols = { order: ['site'], rules: [{ id: 'r1', col: 'site', op: 'contains', value: 'A', tone: 'red', scope: 'cell' }] };
    const r = (await db.query(`SELECT sv_strip('sites', '{}'::jsonb, $1::jsonb, '[]'::jsonb) AS s`, [JSON.stringify(cols)])).rows[0].s;
    expect(r.columns.rules).toEqual(cols.rules);
    expect(r.columns.order).toEqual(['site']);
    expect(r.stripped).toBe(0);
  });
});
