import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { penaltyOf } from '../src/contractors/contractor-performance.service';
import { superDb } from './helpers';

/** Contract 0.15.591: the SLA penalty is days late x the contractor's rate (else the default), never above the cap, two decimals. */
const P = { rate_per_day: 10, currency: 'USD', cap: 400 as number | null, overrides: { 'a-id': 2.5 } as Record<string, number> };
describe('penaltyOf', () => {
  it('uses the default rate, an override, the cap and two decimals', () => {
    expect(penaltyOf(3, 'x', P)).toEqual({ rate: 10, amount: 30, capped: false, currency: 'USD' });
    expect(penaltyOf(54, 'x', P)).toEqual({ rate: 10, amount: 400, capped: true, currency: 'USD' });
    expect(penaltyOf(3, 'a-id', P)).toEqual({ rate: 2.5, amount: 7.5, capped: false, currency: 'USD' });
    expect(penaltyOf(3, 'x', { ...P, rate_per_day: 0.333, cap: null })?.amount).toBe(1);
  });
  it('is no penalty without a rate, with a rate of 0, and never negative', () => {
    expect(penaltyOf(5, 'x', undefined)).toBeNull();
    expect(penaltyOf(5, 'x', { ...P, rate_per_day: 0 })).toBeNull();
    expect(penaltyOf(5, 'a-id', { ...P, overrides: { 'a-id': 0 } })).toBeNull();
    expect(penaltyOf(-4, 'x', P)?.amount).toBe(0);
  });
});

/** Migration 0671: the setting function is changed in place and takes the optional penalty object. */
describe('admin_set_contractor_perf_thresholds (0671)', () => {
  let db: PgClient;
  beforeAll(async () => { db = await superDb(); });
  afterAll(async () => { await db.end(); });
  it('knows the penalty key and validates it', async () => {
    const def = (await db.query(`SELECT pg_get_functiondef('public.admin_set_contractor_perf_thresholds(jsonb,text,integer)'::regprocedure) AS d`)).rows[0].d as string;
    expect(def).toContain(`'penalty'`);
    expect(def).toContain('/thresholds/penalty/currency');
    expect(def.match(/DECLARE/g)?.length).toBe(1);
  });
});
