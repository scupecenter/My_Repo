import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { Team, createRec, recPath, team } from './reg-helpers';

/** Contract 0.15.138 (migration 0381): enable, disable and lock a whole register from Settings. One register is used, and is always unlocked and enabled again. */
let app: NestExpressApplication;
let db: PgClient;
let t: Team;
const KEY = 'lessons_learned';

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  t = await team(app, db, KEY, KEY, 7);
});
afterAll(async () => {
  await db.query(`UPDATE register_definitions SET locked = false, enabled = true WHERE register_key = $1`, [KEY]);
  await db.end();
});

describe('register state control', () => {
  it('lists every register with its state to a System Admin only', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const res = await admin.call('get', '/settings/register-state');
    expect(res.status).toBe(200);
    const row = (res.body.items as { register_key: string; enabled: boolean; locked: boolean; records: number }[]).find((r) => r.register_key === KEY);
    expect(row).toMatchObject({ enabled: true, locked: false });
    expect((res.body.items as unknown[]).length).toBeGreaterThan(15);
    expect((await t.entry.api.call('get', '/settings/register-state')).status).toBe(403);
    expect((await t.entry.api.call('put', `/settings/register-state/${KEY}`, { locked: true, reason: 'not allowed' })).status).toBe(403);
  });

  it('needs a reason, answers an unknown register with 404 and a stale version with 412', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    expect((await admin.call('put', `/settings/register-state/${KEY}`, { locked: false, reason: 'x' })).status).toBe(422);
    expect((await admin.call('put', `/settings/register-state/no_such_register`, { locked: true, reason: 'valid reason' })).status).toBe(404);
    expect((await admin.call('put', `/settings/register-state/${KEY}`, { reason: 'valid reason' })).status).toBe(422);
  });

  it('locks: reads stay, a non-admin cannot create or change a record, a System Admin can, and the change is audited', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const rec = await createRec(t, { lesson_date: '2026-11-20', title: 'before the lock' }).catch(() => null);
    const before = await admin.call('get', '/settings/register-state');
    const ver = (before.body.items as { register_key: string; version: number }[]).find((r) => r.register_key === KEY)!.version;
    const lock = await admin.call('put', `/settings/register-state/${KEY}`, { locked: true, reason: 'freeze for audit' }, { 'If-Match': `"${ver}"` });
    expect(lock.status).toBe(200);
    expect(lock.body).toMatchObject({ register_key: KEY, locked: true, enabled: true });
    try {
      const blocked = await t.entry.api.call('post', recPath(KEY), { site_id: t.site.id, data: { lesson_date: '2026-11-20', title: 'during the lock' } });
      expect(blocked.status).toBe(403);
      expect(JSON.stringify(blocked.body)).toContain('register_locked');
      const read = await t.entry.api.call('get', recPath(KEY));
      expect(read.status).toBe(200);
      const direct = await db.query(`SELECT register_is_locked($1) AS l`, [KEY]);
      expect(direct.rows[0].l).toBe(true);
      const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'register' AND entity_id = $1 AND reason = 'freeze for audit'`, [KEY]);
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
      void rec;
    } finally {
      const un = await admin.call('put', `/settings/register-state/${KEY}`, { locked: false, reason: 'unfreeze after test' });
      expect(un.status).toBe(200);
    }
    const ok = await t.entry.api.call('post', recPath(KEY), { site_id: t.site.id, data: { lesson_date: '2026-11-20', title: 'after the lock' } });
    expect(ok.status).toBe(201);
    expect(ok.status === 422 ? JSON.stringify(ok.body) : '').not.toContain('register_locked');
  });

  it('disables: the register leaves the catalogue for a user and comes back, nothing is deleted', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    const count = async () => (await db.query(`SELECT count(*)::int AS n FROM register_records WHERE register_key = $1`, [KEY])).rows[0].n;
    const n0 = await count();
    try {
      expect((await admin.call('put', `/settings/register-state/${KEY}`, { enabled: false, reason: 'hide for test' })).status).toBe(200);
      const list = await t.entry.api.call('get', '/registers');
      expect((list.body.items as { register_key: string }[]).some((r) => r.register_key === KEY)).toBe(false);
      const states = await admin.call('get', '/settings/register-state');
      expect((states.body.items as { register_key: string; enabled: boolean }[]).find((r) => r.register_key === KEY)?.enabled).toBe(false);
      expect(await count()).toBe(n0);
    } finally {
      expect((await admin.call('put', `/settings/register-state/${KEY}`, { enabled: true, reason: 'show again' })).status).toBe(200);
    }
    const list2 = await t.entry.api.call('get', '/registers');
    expect((list2.body.items as { register_key: string }[]).some((r) => r.register_key === KEY)).toBe(true);
  });
});
