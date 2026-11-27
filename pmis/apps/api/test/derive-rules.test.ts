import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { GECOL, createRec, recPath, team } from './reg-helpers';
import { plainAdmin } from './wf-helpers';
import { partyWithContract } from './p4b-helpers';

/**
 * Migration 0363: cross-register derive. The GECOL record shows the contractor of the Procurement record of its site (the seeded rule) to a viewer who has NO right
 * on Procurement, only the configured value and never the Procurement record; the rules are edited through the settings door (reason, If-Match, validated), and a
 * disabled rule shows nothing.
 */
let app: NestExpressApplication;
let db: PgClient;
let saved: unknown;
beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  saved = (await db.query(`SELECT value FROM settings WHERE key = 'derive.rules'`)).rows[0]?.value;
});
beforeEach(async () => { await db.query('SELECT pg_advisory_lock(770101)'); });
afterEach(async () => { await db.query('SELECT pg_advisory_unlock(770101)'); });
afterAll(async () => {
  if (saved) await db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'derive.rules'`, [JSON.stringify(saved)]);
  await db.end();
  await app.close();
});

describe('derive rules', () => {
  it('shows the configured value of another register without a right on that register, and follows the rules setting', async () => {
    const t = await team(app, db, 'gecol', 'gecol', 7);
    const g = await createRec(t, GECOL);
    const party = await partyWithContract(db, { name: 'Derive Co', type: 'cw_contractor' });
    await db.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, approved_at, current_level, external_party_id)
       VALUES (gen_random_uuid(), 1, 'procurement', $1, 7, 'approved', true, '{}'::jsonb, now(), 3, $2)`, [t.site.id, party]);

    const read = async () => (await t.entry.api.call('get', recPath('gecol', g.id))).body as Record<string, any>;
    // the viewer holds no Procurement right: only the company is shown, not the Procurement record
    const body = await read();
    expect(body.derived.procurement_contractor).toMatchObject({ name: 'Derive Co', type: 'cw_contractor' });
    expect(body.procurement_contractor.name).toBe('Derive Co');
    expect(JSON.stringify(body.derived)).not.toContain('PR-');
    expect((await t.entry.api.call('get', recPath('procurement'))).status).toBe(403);

    // the first read of the rule by this person is audited
    const au = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'derive_disclosed' AND actor_id = $1`, [t.entry.user.id]);
    expect(au.rows[0].n).toBeGreaterThanOrEqual(1);

    // the settings door
    const admin = await plainAdmin(app, db);
    const cur = (await admin.api.call('get', '/settings/derive-rules')).body as { version: number; rules: Record<string, unknown>[]; registers: unknown[] };
    expect(cur.rules.map((r) => r.key)).toEqual(expect.arrayContaining(['gecol_procurement_contractor', 'hlc_procurement_contractor']));
    expect(cur.registers.length).toBeGreaterThan(5);
    const put = (rules: unknown[], version = cur.version) => admin.api.call('put', '/settings/derive-rules', { reason: 'derive test', rules }, { 'If-Match': `"${version}"` });
    expect((await put([{ ...cur.rules[0], source_register: 'gecol' }])).status).toBe(422);
    expect((await put(cur.rules, cur.version + 5)).status).toBe(412);
    const off = await put(cur.rules.map((r) => ({ ...r, enabled: false })));
    expect(off.status).toBe(200);
    expect((await read()).derived).toBeUndefined();
    expect((await read()).procurement_contractor).toBeUndefined();
    // a person without the Settings right cannot edit
    expect((await t.entry.api.call('put', '/settings/derive-rules', { reason: 'no', rules: [] }, { 'If-Match': `"${off.body.version}"` })).status).toBe(403);
  });
});
