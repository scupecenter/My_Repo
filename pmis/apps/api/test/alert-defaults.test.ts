import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { type Actor, plainAdmin } from './wf-helpers';

/**
 * Migration 0625: the data_gaps rule kind (weekly data-completeness reminder) and the default rules the daily run puts in place once.
 * The run itself is not asserted on globally (other suites share the database); only this suite's rules are checked.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
});
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770202)');
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770202)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const PATH = '/settings/alert-rules';

describe('alert defaults (0625)', () => {
  it('validates data_gaps params: only min_sites, 1..100000', async () => {
    const ok = (await db.query(`SELECT alert_rule_params_errs('data_gaps', '{"min_sites": 3}'::jsonb) AS e`)).rows[0].e as unknown[];
    expect(ok).toHaveLength(0);
    const extra = (await db.query(`SELECT alert_rule_params_errs('data_gaps', '{"days": 3}'::jsonb) AS e`)).rows[0].e as unknown[];
    expect(extra.length).toBeGreaterThan(0);
    const range = (await db.query(`SELECT alert_rule_params_errs('data_gaps', '{"min_sites": 0}'::jsonb) AS e`)).rows[0].e as unknown[];
    expect(range.length).toBeGreaterThan(0);
  });

  it('puts the default rules in place once, as ordinary rules that stay switched off when an admin turns them off', async () => {
    await db.query(`SELECT alert_rules_run('2031-04-05'::date)`);
    const rows = (await db.query(`SELECT code, kind, enabled FROM alert_rules WHERE code = 'data-completeness-weekly'`)).rows as { kind: string; enabled: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('data_gaps');

    await db.query(`UPDATE alert_rules SET enabled = false WHERE code = 'data-completeness-weekly'`);
    await db.query(`SELECT alert_rules_run('2031-04-12'::date)`);
    const again = (await db.query(`SELECT count(*)::int AS n, bool_or(enabled) AS on FROM alert_rules WHERE code = 'data-completeness-weekly'`)).rows[0] as { n: number; on: boolean };
    expect(again.n).toBe(1);
    expect(again.on).toBe(false);
  });

  it('lists the data_gaps kind and its template', async () => {
    const res = await admin.api.call('get', PATH);
    expect(res.status).toBe(200);
    expect(res.body.catalogue.kinds.some((k: { kind: string }) => k.kind === 'data_gaps')).toBe(true);
    expect(res.body.catalogue.templates.some((t: { kind: string }) => t.kind === 'data_gaps')).toBe(true);
  });
});
