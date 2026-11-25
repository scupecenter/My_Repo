import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, grantProfile, loggedIn, makeUser, startApp, superDb } from './helpers';

/** Migration 0163 (contract 0.15.80): the dashboard tabs a role opens and the Messages/Inbox menu switch. */
let app: NestExpressApplication;
let db: Pg;
beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await app.close();
  await db.end();
});

/** A signed-in person with dashboard view, whose single role is set to the given tabs / hide flag. */
async function person(tabs: string[] | null, hide = false) {
  const u = await makeUser(db, { assigned: false });
  await grantProfile(db, u.id, [['dashboard', 'view'], ['sites', 'view']]);
  await db.query("UPDATE users SET status = 'active' WHERE id = $1", [u.id]);
  if (tabs) {
    await db.query(
      `UPDATE roles SET dashboard_tabs = $2::text[], hide_messages_inbox = $3
        WHERE id IN (SELECT role_id FROM user_role_assignments WHERE user_id = $1)`,
      [u.id, tabs, hide],
    );
  }
  return loggedIn(app, u);
}

describe('role dashboard access (0163)', () => {
  it('a role has all three tabs and shows Messages and Inbox by default', async () => {
    const api = await person(null);
    const me = await api.call('get', '/me');
    expect(me.body.effective.dashboard_tabs).toEqual(['pmo', 'cw', 'te']);
    expect(me.body.effective.nav).toEqual(expect.arrayContaining(['messages', 'inbox']));
  });

  it('a CW-only role may open the CW tab and gets 403 on the PMO and TE tabs', async () => {
    const api = await person(['cw']);
    expect((await api.call('get', '/me')).body.effective.dashboard_tabs).toEqual(['cw']);
    expect((await api.call('get', '/dashboard?view=CW')).status).toBe(200);
    const pmo = await api.call('get', '/dashboard');
    expect(pmo.status).toBe(403);
    expect(pmo.body.code ?? pmo.body.type).toMatch(/action_forbidden/);
    expect((await api.call('get', '/dashboard?view=TE')).status).toBe(403);
  });

  it('the PMO tab includes the other two', async () => {
    const api = await person(['pmo']);
    expect((await api.call('get', '/dashboard?view=CW')).status).toBe(200);
    expect((await api.call('get', '/dashboard?view=TE')).status).toBe(200);
  });

  it('hiding Messages and Inbox removes them from the menu only', async () => {
    const api = await person(['pmo', 'cw', 'te'], true);
    const nav = (await api.call('get', '/me')).body.effective.nav as string[];
    expect(nav).not.toContain('messages');
    expect(nav).not.toContain('inbox');
    expect(nav).toContain('dashboard');
  });

  it('a System Admin is never limited', async () => {
    const { api } = await adminApi(app, db);
    const me = await api.call('get', '/me');
    expect(me.body.effective.dashboard_tabs).toEqual(['pmo', 'cw', 'te']);
    expect((await api.call('get', '/dashboard?view=TE')).status).toBe(200);
  });

  it('only a System Admin changes the settings, with a reason, and the change is audited', async () => {
    const { api } = await adminApi(app, db);
    const created = await api.call('post', '/roles', { code: `DA_${Date.now()}`, name_en: 'Dash access', description_en: 'x', can_hold_matrix_levels: false, reason: 'new role', default_region_ids: [1], default_module_keys: ['dashboard'] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ dashboard_tabs: ['pmo', 'cw', 'te'], hide_messages_inbox: false });
    const done = await api.call('patch', `/roles/${created.body.id}`, { dashboard_tabs: ['te', 'cw'], hide_messages_inbox: true, reason: 'management view' }, { 'If-Match': created.headers['etag']! });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ dashboard_tabs: ['cw', 'te'], hide_messages_inbox: true });
    const bad = await api.call('patch', `/roles/${created.body.id}`, { dashboard_tabs: [], reason: 'none' }, { 'If-Match': done.headers['etag']! });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const audit = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'role_dashboard_access_set' AND entity_id = $1", [String(created.body.id)]);
    expect(audit.rows[0].n).toBeGreaterThan(0);
    const plain = await person(null);
    expect([403, 404]).toContain((await plain.call('patch', `/roles/${created.body.id}`, { hide_messages_inbox: false, reason: 'x' }, { 'If-Match': done.headers['etag']! })).status);
  });
});
