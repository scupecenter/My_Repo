import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpsLimitsService } from '../src/ops/ops-limits.service';
import { OPS_LIMIT_DEFAULTS, limit, loginLimits, resetLimits } from '../src/ops/ops-limits';
import { q } from './calc-helpers';
import { Api, delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Operational limits (migration 0402): GET / PUT /settings/ops-limits. Every default is the number the code used before. Only a System Admin changes a value, with a reason,
 * a step-up and If-Match; every change is audited. The suite always puts the setting back to "all defaults".
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let delegateAll: Actor;
const REASON = 'Review item 5 test';

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  delegateAll = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, delegateAll.user.id, [['settings', 'edit']]);
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '{}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'ops.limits'`);
  await db.end();
  await app.close();
  resetLimits();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const read = (who: Actor) => who.api.call('get', '/settings/ops-limits');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/ops-limits', body, tag === undefined ? {} : { 'If-Match': tag });
const audits = () => q<{ before: any; after: any; reason: string }>(db, `SELECT before, after, reason FROM audit_log WHERE action = 'ops_limits_update' AND entity_id = 'ops.limits' ORDER BY id`);
const reset = async () => {
  await db.query(`UPDATE settings SET value = '{}'::jsonb, updated_at = now() WHERE key = 'ops.limits'`);
};

describe('defaults', () => {
  it('the catalogue defaults are the numbers the code used before and match the code defaults', async () => {
    await reset();
    const r = await read(admin);
    expect(r.status).toBe(200);
    const byKey = Object.fromEntries((r.body.items as { key: string; default: number; value: number; is_default: boolean; min: number; max: number }[]).map((i) => [i.key, i]));
    expect(Object.keys(byKey).sort()).toEqual(Object.keys(OPS_LIMIT_DEFAULTS).sort());
    for (const [k, v] of Object.entries(OPS_LIMIT_DEFAULTS)) {
      expect(byKey[k]!.default).toBe(v);
      expect(byKey[k]!.value).toBe(v);
      expect(byKey[k]!.is_default).toBe(true);
      expect(byKey[k]!.min).toBeLessThanOrEqual(v);
      expect(byKey[k]!.max).toBeGreaterThanOrEqual(v);
    }
    expect(limit('session.idle_hours')).toBe(8);
  });

  it('every signed-in user reads; only a System Admin can edit', async () => {
    for (const [who, can] of [[plain, false], [delegateAll, false], [admin, true]] as [Actor, boolean][]) {
      const r = await read(who);
      expect(r.status).toBe(200);
      expect(etag(r)).toMatch(/^"\d{1,10}"$/);
      expect(r.body.can_edit).toBe(can);
    }
    expect((await new Api(app).raw('get', '/settings/ops-limits')).status).toBe(401);
    const tag = etag(await read(admin));
    for (const who of [plain, delegateAll]) {
      const r = await put(who, { values: { 'session.idle_hours': 4 }, reason: REASON }, tag);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('action_forbidden');
    }
    expect(await audits()).toHaveLength(0);
  });
});

describe('PUT /settings/ops-limits', () => {
  it('checks the body, If-Match, ranges and the step-up', async () => {
    await reset();
    const tag = etag(await read(admin));
    expect((await put(admin, { values: { 'session.idle_hours': 4 }, reason: REASON })).status).toBe(428);
    expect((await put(admin, { values: { 'session.idle_hours': 4 }, reason: 'x' }, tag)).status).toBe(422);
    expect((await put(admin, { values: { 'nope.key': 4 }, reason: REASON }, tag)).status).toBe(422);
    expect((await put(admin, { values: { 'session.idle_hours': 0 }, reason: REASON }, tag)).status).toBe(422);
    expect((await put(admin, { values: { 'session.idle_hours': 2.5 }, reason: REASON }, tag)).status).toBe(422);
    expect((await put(admin, { values: { 'stepup.seconds': 5 }, reason: REASON }, tag)).status).toBe(422);
    const shorter = await put(admin, { values: { 'session.idle_hours': 10, 'session.absolute_hours': 6 }, reason: REASON }, tag);
    expect(shorter.status).toBe(422);
    expect((await put(admin, { values: { 'session.idle_hours': 4 }, reason: REASON }, '"1"')).status).toBe(412);
    expect((await put(noStep, { values: { 'session.idle_hours': 4 }, reason: REASON }, tag)).status).toBe(401);
    expect(await audits()).toHaveLength(0);
  });

  it('saves, audits, reads back, and the database functions use the new numbers; leaving a key out resets it', async () => {
    await reset();
    const before = await audits();
    const r = await put(admin, { values: { 'session.idle_hours': 2, 'session.absolute_hours': 5, 'stepup.seconds': 120, 'import.max_rows': 777 }, reason: REASON }, etag(await read(admin)));
    expect(r.status).toBe(200);
    const items = Object.fromEntries((r.body.items as { key: string; value: number; is_default: boolean }[]).map((i) => [i.key, i]));
    expect(items['session.idle_hours']).toMatchObject({ value: 2, is_default: false });
    expect(items['export.max_rows']).toMatchObject({ value: 100000, is_default: true });
    expect((await q<{ s: number; i: number }>(db, `SELECT ops_limit('stepup.seconds') AS s, ops_limit('session.idle_hours') AS i`))[0]).toEqual({ s: 120, i: 2 });
    const a = await audits();
    expect(a).toHaveLength(before.length + 1);
    expect(a.at(-1)).toMatchObject({ before: {}, after: { 'session.idle_hours': 2, 'session.absolute_hours': 5, 'stepup.seconds': 120, 'import.max_rows': 777 }, reason: REASON });
    // the same values again: nothing to change
    expect((await put(admin, { values: { 'session.idle_hours': 2, 'session.absolute_hours': 5, 'stepup.seconds': 120, 'import.max_rows': 777 }, reason: REASON }, etag(await read(admin)))).status).toBe(409);
    // a key that is left out goes back to its default
    const back = await put(admin, { values: { 'session.idle_hours': 2 }, reason: REASON }, etag(await read(admin)));
    expect(back.status).toBe(200);
    expect((await q<{ s: number }>(db, `SELECT ops_limit('stepup.seconds') AS s`))[0]!.s).toBe(300);
  });
});

describe('sign-in rate limits (migration 0563)', () => {
  it('are in the catalogue with the old numbers, are range-checked, and loginLimits() follows a saved value', async () => {
    await reset();
    const r = await read(admin);
    const byKey = Object.fromEntries((r.body.items as { key: string; value: number; group: string }[]).map((i) => [i.key, i]));
    expect(['login.ip_attempts', 'login.ip_window_seconds', 'login.ip_base_seconds', 'login.ip_max_seconds', 'login.identifier_attempts'].map((k) => byKey[k]?.value)).toEqual([10, 900, 2, 60, 5]);
    expect(loginLimits()).toEqual({ perIp: 10, windowMs: 900_000, baseSeconds: 2, maxSeconds: 60, perIdentifier: 5 });
    const tag = etag(r);
    expect((await put(admin, { values: { 'login.ip_attempts': 1 }, reason: REASON }, tag)).status).toBe(422);
    expect((await put(admin, { values: { 'login.ip_base_seconds': 30, 'login.ip_max_seconds': 10 }, reason: REASON }, tag)).status).toBe(422);
    const ok = await put(admin, { values: { 'login.ip_attempts': 20, 'login.ip_window_seconds': 600, 'login.identifier_attempts': 8 }, reason: REASON }, tag);
    expect(ok.status).toBe(200);
    await app.get(OpsLimitsService).refresh();
    expect(loginLimits()).toMatchObject({ perIp: 20, windowMs: 600_000, perIdentifier: 8, baseSeconds: 2, maxSeconds: 60 });
    await reset();
    resetLimits();
    expect(loginLimits().perIp).toBe(10);
  });
});
