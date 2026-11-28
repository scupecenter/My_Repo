import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.464 (migration 0604): order warnings of every register, and the read only Register counts. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '{"registers": {}}'::jsonb WHERE key = 'register.order_warnings'`);
  await db.end();
});

describe('order warnings of any register', () => {
  it('reads need the Settings screen, writes need an administrator with a reason and the current version', async () => {
    const viewer = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await viewer.api.call('get', '/settings/registers/permits_hse/order-warnings')).status).toBe(403);
    const admin = await loggedIn(app, await makeAdmin(db));
    const cur = await admin.call('get', '/settings/registers/permits_hse/order-warnings');
    expect(cur.status).toBe(200);
    expect(cur.body).toMatchObject({ register_key: 'permits_hse', enabled: false, chains: [] });
    const dates: string[] = cur.body.fields.map((f: { code: string }) => f.code);
    expect(dates.length).toBeGreaterThanOrEqual(2);
    const etag = cur.headers.etag as string;
    const body = { reason: 'Warn on the permit dates', enabled: true, chains: [[dates[0], dates[1]]], billing_after: null, billing_field: null };
    expect((await viewer.api.call('put', '/settings/registers/permits_hse/order-warnings', body, { 'If-Match': etag })).status).toBe(403);
    expect((await admin.call('put', '/settings/registers/permits_hse/order-warnings', { ...body, reason: 'x' }, { 'If-Match': etag })).status).toBe(422);
    expect((await admin.call('put', '/settings/registers/permits_hse/order-warnings', { ...body, chains: [[dates[0], 'no_such_field']] }, { 'If-Match': etag })).status).toBe(422);
    expect((await admin.call('put', '/settings/registers/permits_hse/order-warnings', { ...body, billing_after: dates[0], billing_field: null }, { 'If-Match': etag })).status).toBe(422);
    expect((await admin.call('put', '/settings/registers/no_such_register/order-warnings', body, { 'If-Match': etag })).status).toBe(404);
    const ok = await admin.call('put', '/settings/registers/permits_hse/order-warnings', body, { 'If-Match': etag });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true, version: 1 });
    expect((await admin.call('put', '/settings/registers/permits_hse/order-warnings', body, { 'If-Match': etag })).status).toBe(412);
    const w = await db.query(`SELECT reg_order_warnings('permits_hse', $1::jsonb) AS w`, [JSON.stringify({ [dates[0]!]: '2026-02-01', [dates[1]!]: '2026-01-01' })]);
    expect(w.rows[0].w).toEqual([expect.objectContaining({ code: 'order', path: `/data/${dates[1]}`, related_path: `/data/${dates[0]}` })]);
    const aud = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'register_order_warnings_update' AND entity_id = 'register.order_warnings:permits_hse'`);
    expect(aud.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('GECOL keeps its old setting and its old output through the same routes', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const old = await admin.call('get', '/settings/gecol-order-warnings');
    const gen = await admin.call('get', '/settings/registers/gecol/order-warnings');
    expect(gen.status).toBe(200);
    expect(gen.body.chains).toEqual(old.body.chains);
    expect(gen.body.version).toBe(old.body.version);
    expect(gen.body.billing_field).toBe('billing_conversion_date');
    const bad = await admin.call('put', '/settings/registers/gecol/order-warnings', { reason: 'try', enabled: false, chains: [], billing_after: null, billing_field: 'remark' }, { 'If-Match': gen.headers.etag as string });
    expect(bad.status).toBe(422);
    const wrapper = await db.query(`SELECT gecol_order_warnings('{}'::jsonb) = reg_order_warnings('gecol', '{}'::jsonb) AS same`);
    expect(wrapper.rows[0].same).toBe(true);
  });
});

describe('GET /settings/register-counts', () => {
  it('lists every register read only; the totals match the latest versions in the table', async () => {
    const viewer = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await viewer.api.call('get', '/settings/register-counts')).status).toBe(403);
    const admin = await loggedIn(app, await makeAdmin(db));
    const r = await admin.call('get', '/settings/register-counts');
    expect(r.status).toBe(200);
    const gecol = r.body.registers.find((x: { register_key: string }) => x.register_key === 'gecol');
    expect(gecol).toBeTruthy();
    expect(gecol.by_state.reduce((a: number, x: { count: number }) => a + x.count, 0)).toBe(gecol.total);
    expect(gecol.versions).toBeGreaterThanOrEqual(gecol.total);
  });
});
