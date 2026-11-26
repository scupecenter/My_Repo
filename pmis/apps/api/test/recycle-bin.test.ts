import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { HLC, createRec, post, team } from './reg-helpers';
import { plainAdmin } from './wf-helpers';

/** Contract 0.15.98 (migration 0186): the recycle bin lists voided register records and a System Admin restores one to a draft. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const R = 7;
const restore = (api: Awaited<ReturnType<typeof plainAdmin>>['api'], id: string, version: number, body: unknown = { reason: 'voided by mistake' }) =>
  api.call('post', `/recycle-bin/${id}/restore`, body, { 'If-Match': `"${version}"` });

describe('recycle bin', () => {
  it('lists a voided record, refuses anyone but a System Admin and restores to a draft with audit and history', async () => {
    const t = await team(app, db, 'hlc', 'hlc', R);
    const rec = await createRec(t, HLC);
    const admin = await plainAdmin(app, db);
    const v = await post(admin.api, 'hlc', rec.id, 'void', rec.version, { reason: 'wrong site' });
    expect(v.status).toBe(200);
    expect((await t.entry.api.call('get', '/recycle-bin')).status).toBe(403);
    expect((await restore(t.entry.api, rec.id, v.body.version)).status).toBe(403);
    const bin = await admin.api.call('get', '/recycle-bin');
    expect(bin.status).toBe(200);
    expect(bin.body.retention_days).toBe(90);
    const item = bin.body.items.find((i: { id: string }) => i.id === rec.id);
    expect(item.void_reason).toBe('wrong site');
    expect(item.blocked).toBeNull();
    expect((await restore(admin.api, rec.id, v.body.version, {})).status).toBe(422);      // a reason is needed
    expect((await restore(admin.api, rec.id, v.body.version + 5)).status).toBe(412);      // stale version
    const ok = await restore(admin.api, rec.id, v.body.version);
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('entry');
    const row = await db.query(`SELECT state, current_level, voided_at, void_reason FROM register_records WHERE id = $1`, [rec.id]);
    expect(row.rows[0]).toMatchObject({ state: 'entry', current_level: 1, voided_at: null, void_reason: null });
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1 AND action IN ('register_record_void','register_record_restore') ORDER BY created_at`, [rec.id]);
    expect(audit.rows.map((a: { action: string }) => a.action)).toEqual(['register_record_void', 'register_record_restore']);
    expect((await admin.api.call('get', '/recycle-bin')).body.items.some((i: { id: string }) => i.id === rec.id)).toBe(false);
    expect((await restore(admin.api, rec.id, ok.body.version)).status).toBe(409);         // no longer voided
  });

  it('blocks a restore when the site has another record, and after the retention', async () => {
    const t = await team(app, db, 'hlc', 'hlc', R);
    const rec = await createRec(t, HLC);
    const admin = await plainAdmin(app, db);
    const v = await post(admin.api, 'hlc', rec.id, 'void', rec.version, { reason: 'wrong site' });
    await createRec(t, HLC);                                                                // the freed site slot is taken again
    const item = (await admin.api.call('get', '/recycle-bin')).body.items.find((i: { id: string }) => i.id === rec.id);
    expect(['site_slot_taken', 'open_version_exists']).toContain(item.blocked);
    expect((await restore(admin.api, rec.id, v.body.version)).status).toBe(409);
    await db.query(`UPDATE register_records SET voided_at = now() - interval '200 days' WHERE id = $1`, [rec.id]);
    expect((await admin.api.call('get', '/recycle-bin')).body.items.some((i: { id: string }) => i.id === rec.id)).toBe(false);
    expect((await restore(admin.api, rec.id, v.body.version)).status).toBe(409);
  });

  it('the retention is a setting: 30 to 730 days, with a reason, audited', async () => {
    const admin = await plainAdmin(app, db);
    const cur = await admin.api.call('get', '/recycle-bin');
    const put = (days: number, v: number, reason = 'tidy') => admin.api.call('put', '/recycle-bin/retention', { retention_days: days, reason }, { 'If-Match': `"${v}"` });
    expect((await put(10, cur.body.version)).status).toBe(422);
    expect((await put(1000, cur.body.version)).status).toBe(422);
    const a = await put(120, cur.body.version);
    expect(a.status).toBe(200);
    expect(a.body.retention_days).toBe(120);
    const back = await put(90, a.body.version);
    expect(back.status).toBe(200);
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'recycle_bin_retention_update'`);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
