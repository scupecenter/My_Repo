import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Admin lock keys (migration 0290, contract 0.15.190): GET / PUT /settings/security-locks and the `@ExportAction()` enforcement. Both locks are off by default.
 * Only a System Admin changes them (a settings delegate does not), with a reason, a step-up and If-Match; every change is audited. The suite always turns the locks
 * back off; the lock-on windows are short and use /my-work/daily-plans/export, which no other suite calls, because the database is shared by the suites that run in parallel.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let delegateAll: Actor;
const REASON = 'Owner decision 2026-11-27';
const OFF = { block_public_sharing: false, disable_export: false };

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
  await db.query(`UPDATE settings SET value = '{"block_public_sharing": false, "disable_export": false}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'security.locks'`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const read = (who: Actor) => who.api.call('get', '/settings/security-locks');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/security-locks', body, tag === undefined ? {} : { 'If-Match': tag });
const value = async (): Promise<unknown> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'security.locks'`))[0]?.value;
const audits = () => q<{ before: any; after: any; reason: string; actor_id: string }>(db,
  `SELECT before, after, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'security_locks_update' AND entity_id = 'security.locks' ORDER BY id`);
const setLocks = async (body: { block_public_sharing: boolean; disable_export: boolean }) => {
  const r = await put(admin, { ...body, reason: REASON }, etag(await read(admin)));
  expect(r.status).toBe(200);
  return r;
};

describe('GET and PUT /settings/security-locks', () => {
  it('both locks are off by default; every signed-in user reads them; only a System Admin can edit', async () => {
    for (const [who, can] of [[plain, false], [delegateAll, false], [admin, true]] as [Actor, boolean][]) {
      const r = await read(who);
      expect(r.status).toBe(200);
      expect(etag(r)).toMatch(/^"\d{1,10}"$/);
      expect(r.body).toMatchObject({ ...OFF, updated_by: null, can_edit: can });
    }
    expect((await new Api(app).raw('get', '/settings/security-locks')).status).toBe(401);
    const tag = etag(await read(admin));
    for (const who of [plain, delegateAll]) {
      const r = await put(who, { block_public_sharing: true, disable_export: false, reason: REASON }, tag);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('action_forbidden');
    }
    expect(await value()).toEqual(OFF);
    expect(await audits()).toHaveLength(0);
  });

  it('checks the body, If-Match and the step-up', async () => {
    const tag = etag(await read(admin));
    const body = { block_public_sharing: true, disable_export: false, reason: REASON };
    expect((await put(admin, body)).status).toBe(428);
    const stale = await put(admin, body, '"1"');
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    const noStepUp = await put(noStep, body, tag);
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.code).toBe('step_up_required');
    for (const bad of [{ ...body, block_public_sharing: 'yes' }, { ...body, disable_export: null }, { block_public_sharing: true, reason: REASON }, { ...body, reason: 'ab' }, { ...body, extra: 1 }]) {
      expect((await put(admin, bad, tag)).status, JSON.stringify(bad)).toBe(422);
    }
    expect(await value()).toEqual(OFF);
  });

  it('saves with before and after in the audit log, refuses the same values (409), and turning a lock off is as easy as turning it on', async () => {
    const cur = await read(admin);
    const on = await put(admin, { block_public_sharing: true, disable_export: true, reason: REASON }, etag(cur));
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ block_public_sharing: true, disable_export: true, updated_by: { id: admin.user.id }, can_edit: true });
    expect(etag(on)).not.toBe(etag(cur));
    expect(await value()).toEqual({ block_public_sharing: true, disable_export: true });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: admin.user.id, reason: REASON, before: OFF, after: { block_public_sharing: true, disable_export: true } });
    const same = await put(admin, { block_public_sharing: true, disable_export: true, reason: REASON }, etag(on));
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('invalid_transition');
    expect((await put(admin, { ...OFF, reason: REASON }, etag(cur))).status).toBe(412);
    const off = await put(admin, { ...OFF, reason: REASON }, etag(on));
    expect(off.status).toBe(200);
    expect(await value()).toEqual(OFF);
    expect(await audits()).toHaveLength(2);
  });

  it('the setting cannot be written around the door: a direct write by the application role changes nothing', async () => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE pmis_app');
      await db.query(`UPDATE settings SET value = '{"disable_export": true, "block_public_sharing": true}'::jsonb WHERE key = 'security.locks'`).catch(() => undefined);
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await value()).toEqual(OFF);
  });
});

describe('export lock enforcement', () => {
  it('while disable_export is on an export route answers 403 export_locked and does nothing; off again, the route is reachable', async () => {
    await setLocks({ block_public_sharing: false, disable_export: true });
    try {
      for (const who of [plain, admin]) {
        const r = await who.api.call('get', '/daily-plans/export');
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('action_forbidden');
        expect(r.body.errors[0].code).toBe('export_locked');
      }
      // the lock reads and changes are never locked, so an admin can always turn it off again
      expect((await read(plain)).body.disable_export).toBe(true);
    } finally {
      await setLocks(OFF);
    }
    const open = await plain.api.call('get', '/daily-plans/export');
    expect(open.body?.errors?.[0]?.code).not.toBe('export_locked');
  });

  it('block_public_sharing alone does not stop an export', async () => {
    await setLocks({ block_public_sharing: true, disable_export: false });
    try {
      const r = await plain.api.call('get', '/daily-plans/export');
      expect(r.body?.errors?.[0]?.code).not.toBe('export_locked');
    } finally {
      await setLocks(OFF);
    }
  });

  it('security_lock_active answers one boolean per key and refuses an unknown key', async () => {
    expect((await q<{ a: boolean; b: boolean }>(db, `SELECT security_lock_active('block_public_sharing') AS a, security_lock_active('disable_export') AS b`))[0]).toEqual({ a: false, b: false });
    await expect(db.query(`SELECT security_lock_active('disable_exports')`)).rejects.toThrow(/unknown lock key/);
  });
});
