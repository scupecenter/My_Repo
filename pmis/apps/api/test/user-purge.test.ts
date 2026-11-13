import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, beginAs, delegate, loggedIn, makeAdmin, makeUser, startApp, superDb } from './helpers';
import type { TestUser } from './helpers';

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

/** A System Admin with a fresh step-up, and a user that is already soft-deleted. */
async function setup(): Promise<{ admin: TestUser; api: Api; target: TestUser }> {
  const admin = await makeAdmin(db);
  const api = await loggedIn(app, admin);
  await api.stepUp(admin.password);
  const target = await makeUser(db, { assigned: true });
  const etag = (await api.call('get', `/users/${target.id}`)).headers['etag']!;
  const del = await api.call('post', `/users/${target.id}/delete`, { reason: 'Left the company' }, { 'If-Match': etag });
  expect(del.status).toBe(200);
  return { admin, api, target };
}

describe('permanent delete of a soft-deleted user (decision 3 of 2026-11-12, migration 0089)', () => {
  it('purges a soft-deleted user: tombstone, released identifiers, no sign-in, hidden everywhere, history kept', async () => {
    const { admin, api, target } = await setup();
    // History that must keep pointing at the person: an announcement they sent, an audit row they caused, a group they belonged to, a delegation to them.
    await db.query('INSERT INTO announcements (title, body, audience_all, created_by) VALUES ($1, $2, true, $3)', ['Old notice', 'Body', target.id]);
    await db.query("INSERT INTO audit_log (action, entity_type, entity_id, actor_id) VALUES ('test_history', 'thing', 'x1', $1)", [target.id]);
    const grp = (await db.query("INSERT INTO groups (name, description) VALUES ($1, 'purge test') RETURNING id", [`Purge group ${target.id}`])).rows[0].id as string;
    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [grp, target.id]);
    await delegate(db, target.id, [['sites', 'view']]);

    const base = { reason: 'Account closed for good' };
    // typed confirmation, reason and step-up
    expect((await api.call('post', `/users/${target.id}/purge`, { ...base, confirm_text: '0000' })).status).toBe(422);
    const bad = await api.call('post', `/users/${target.id}/purge`, { ...base, confirm_text: '0000' });
    expect(bad.body.code).toBe('confirmation_mismatch');
    expect((await api.call('post', `/users/${target.id}/purge`, { reason: 'x', confirm_text: target.employeeId })).status).toBe(422);
    expect((await api.call('post', `/users/${target.id}/purge`, { reason: 'Account closed' })).status).toBe(422); // no confirm_text
    const fresh = await loggedIn(app, admin);
    const noStepUp = await fresh.call('post', `/users/${target.id}/purge`, { ...base, confirm_text: target.employeeId });
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.code).toBe('step_up_required');
    expect((await db.query('SELECT purged_at FROM users WHERE id = $1', [target.id])).rows[0].purged_at).toBeNull();

    const res = await api.call('post', `/users/${target.id}/purge`, { ...base, confirm_text: target.employeeId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, display_name: target.name, purge_reason: 'Account closed for good', purged_by: { id: admin.id } });
    expect(res.body.identifiers.employee_id).toBe(target.employeeId);
    expect(res.body.identifiers.email).toMatch(/^u\*\*\*@example\.test$/);
    expect(JSON.stringify(res.body)).not.toContain(target.email);

    // the row is kept as a tombstone: name and id stay, the identifiers are released
    const row = (await db.query('SELECT * FROM users WHERE id = $1', [target.id])).rows[0];
    expect(row.display_name).toBe(target.name);
    expect(row.status).toBe('disabled');
    expect(row.deleted_at).not.toBeNull();
    expect(row.purged_at).not.toBeNull();
    expect(row.employee_id).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.m365_object_id).toBeNull();
    expect(row.email).toBe(`purged-${target.id}@purged.invalid`);
    // credentials, memberships and delegations are gone, assignments ended
    expect((await db.query('SELECT 1 FROM local_credentials WHERE user_id = $1', [target.id])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM group_members WHERE user_id = $1', [target.id])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [target.id])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM user_role_assignments WHERE user_id = $1 AND (valid_to IS NULL OR valid_to > now())', [target.id])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM delegations WHERE target_user_id = $1 AND NOT revoked', [target.id])).rowCount).toBe(0);

    // history still references the tombstone
    const ann = await db.query('SELECT u.display_name FROM announcements a JOIN users u ON u.id = a.created_by WHERE a.title = $1 AND a.created_by = $2', ['Old notice', target.id]);
    expect(ann.rows[0].display_name).toBe(target.name);
    const hist = await db.query("SELECT actor_id FROM audit_log WHERE action = 'test_history' AND actor_id = $1", [target.id]);
    expect(hist.rowCount).toBe(1);
    // audit before and after
    const aud = await db.query("SELECT before, after, reason, actor_id FROM audit_log WHERE action = 'user_purged' AND entity_id = $1", [target.id]);
    expect(aud.rowCount).toBe(1);
    expect(aud.rows[0]).toMatchObject({ reason: 'Account closed for good', actor_id: admin.id });
    expect(aud.rows[0].before).toMatchObject({ display_name: target.name, employee_id: target.employeeId });
    expect(aud.rows[0].after).toMatchObject({ purged: true, identifiers_released: true, groups_removed: 1 });

    // cannot sign in with any old identifier
    for (const by of ['email', 'employeeId', 'phone'] as const) {
      expect((await new Api(app).login(target[by], target.password)).status).toBe(401);
    }
    // hidden from lists, pickers and detail; not restorable; not purgeable twice
    expect((await api.call('get', `/users?q=${encodeURIComponent(target.name)}`)).body.items).toEqual([]);
    expect((await api.call('get', `/users/deleted?q=${encodeURIComponent(target.name)}`)).body.items).toEqual([]);
    expect((await api.call('get', `/users/picker?q=${encodeURIComponent(target.name.slice(0, 8))}`)).body.items.map((u: { id: string }) => u.id)).not.toContain(target.id);
    expect((await api.call('get', `/users/${target.id}`)).status).toBe(404);
    const restore = await api.call('post', `/users/${target.id}/restore`, { reason: 'Came back' }, { 'If-Match': '"1"' });
    expect(restore.status).toBe(404);
    const again = await api.call('post', `/users/${target.id}/purge`, { ...base, confirm_text: target.employeeId });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
  });

  it('accepts the e-mail as the typed confirmation', async () => {
    const { api, target } = await setup();
    const res = await api.call('post', `/users/${target.id}/purge`, { reason: 'Duplicate account', confirm_text: target.email.toUpperCase() });
    expect(res.status).toBe(200);
  });

  it('refuses a user that is not soft-deleted yet', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    await api.stepUp(admin.password);
    const live = await makeUser(db, { assigned: true });
    const res = await api.call('post', `/users/${live.id}/purge`, { reason: 'Too eager', confirm_text: live.employeeId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
    const row = (await db.query('SELECT purged_at, employee_id FROM users WHERE id = $1', [live.id])).rows[0];
    expect(row.purged_at).toBeNull();
    expect(row.employee_id).toBe(live.employeeId);
    expect((await api.call('post', `/users/${'00000000-0000-4000-8000-000000000000'}/purge`, { reason: 'Ghost', confirm_text: '1234' })).status).toBe(404);
  });

  it('is System Admin only: a delegate of users.delete, a plain user and a not signed-in caller are refused', async () => {
    const { target } = await setup();
    const delegateUser = await makeUser(db, { assigned: true });
    await delegate(db, delegateUser.id, [['admin.users', 'view'], ['users', 'delete']]);
    const d = await loggedIn(app, delegateUser);
    await d.stepUp(delegateUser.password);
    const res = await d.call('post', `/users/${target.id}/purge`, { reason: 'Delegated purge', confirm_text: target.employeeId });
    expect(res.status).toBe(403);
    const plain = await makeUser(db, { assigned: true });
    const p = await loggedIn(app, plain);
    await p.stepUp(plain.password);
    expect((await p.call('post', `/users/${target.id}/purge`, { reason: 'Plain user', confirm_text: target.employeeId })).status).toBe(403);
    expect((await new Api(app).call('post', `/users/${target.id}/purge`, { reason: 'Nobody', confirm_text: target.employeeId })).status).toBe(401);
    expect((await db.query('SELECT purged_at FROM users WHERE id = $1', [target.id])).rows[0].purged_at).toBeNull();
  });

  it('frees the identifiers: a NEW account with the same e-mail, employee ID and phone can be created, and the old history stays on the old row', async () => {
    const { admin, api, target } = await setup();
    // while soft-deleted the identifiers are still held
    const blocked = await api.call('post', '/users', { display_name: 'Newcomer', email: target.email, employee_id: target.employeeId, phone: target.phone, reason: 'rehire' });
    expect(blocked.status).toBe(409);
    expect((await api.call('post', `/users/${target.id}/purge`, { reason: 'Free the data', confirm_text: target.employeeId })).status).toBe(200);
    const created = await api.call('post', '/users', { display_name: 'Newcomer', email: target.email, employee_id: target.employeeId, phone: target.phone, reason: 'rehire' });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ email: target.email, employee_id: target.employeeId, phone: target.phone });
    expect(created.body.user.id).not.toBe(target.id);
    // the new account signs in with the old identifiers; the tombstone is still the old person
    expect((await new Api(app).login(target.employeeId, created.body.temporary_password)).status).toBe(200);
    expect((await db.query('SELECT display_name FROM users WHERE id = $1', [target.id])).rows[0].display_name).toBe(target.name);
    expect(admin.id).not.toBe(created.body.user.id);
  });

  it('refuses purging yourself', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    await api.stepUp(admin.password);
    const res = await api.call('post', `/users/${admin.id}/purge`, { reason: 'Myself', confirm_text: admin.employeeId });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('self_beneficiary');
  });

  it('purging a deleted former System Admin removes the membership and leaves an active admin', async () => {
    const { api, target } = await (async () => {
      const admin = await makeAdmin(db);
      const api = await loggedIn(app, admin);
      await api.stepUp(admin.password);
      const former = await makeAdmin(db);
      const etag = (await api.call('get', `/users/${former.id}`)).headers['etag']!;
      expect((await api.call('post', `/users/${former.id}/delete`, { reason: 'Left the project' }, { 'If-Match': etag })).status).toBe(200);
      return { api, target: former };
    })();
    const res = await api.call('post', `/users/${target.id}/purge`, { reason: 'Former admin removed', confirm_text: target.employeeId });
    expect(res.status).toBe(200);
    const admins = await db.query(`SELECT count(*)::int AS n FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.is_system_admins
      JOIN users u ON u.id = gm.user_id AND u.status = 'active'`);
    expect(admins.rows[0].n).toBeGreaterThan(0);
    expect((await db.query('SELECT 1 FROM group_members WHERE user_id = $1', [target.id])).rowCount).toBe(0);
  });

  it('keeps the last-admin guard: the only System Admin can neither purge nor delete themselves, and a former admin can be purged', async () => {
    const soloApp = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_SOLO as string });
    const solo = await superDb(true);
    try {
      const boot = (await import('./global-setup')).BOOTSTRAP_ADMIN;
      const api = new Api(soloApp);
      expect((await api.login(boot.email, boot.password)).status).toBe(200);
      expect((await api.stepUp(boot.password)).status).toBe(200);
      const me = (await solo.query('SELECT id FROM users WHERE email = $1', [boot.email])).rows[0].id as string;
      const etag = (await api.call('get', `/users/${me}`)).headers['etag']!;
      expect((await api.call('post', `/users/${me}/delete`, { reason: 'Leaving now' }, { 'If-Match': etag })).status).toBe(403);
      expect((await api.call('post', `/users/${me}/purge`, { reason: 'Leaving now', confirm_text: boot.employeeId })).status).toBe(403);
      // a second admin who was soft-deleted can be purged; the first stays an active admin
      const group = (await solo.query('SELECT id FROM groups WHERE is_system_admins')).rows[0].id as string;
      const hash = (await solo.query('SELECT password_hash FROM local_credentials WHERE user_id = $1', [me])).rows[0].password_hash as string;
      const x = (await solo.query('SELECT idm_bootstrap_admin($1, $2, $3, $4, $5) AS id', ['second.admin@example.test', 'Second Admin', '9002', '+218910000002', hash])).rows[0].id as string;
      expect((await solo.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [group, x])).rowCount).toBe(1);
      const xTag = (await api.call('get', `/users/${x}`)).headers['etag']!;
      expect((await api.call('post', `/users/${x}/delete`, { reason: 'Second admin left' }, { 'If-Match': xTag })).status).toBe(200);
      const purged = await api.call('post', `/users/${x}/purge`, { reason: 'Second admin removed', confirm_text: '9002' });
      expect(purged.status).toBe(200);
      expect((await solo.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [group, x])).rowCount).toBe(0);
      expect((await solo.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [group, me])).rowCount).toBe(1);
      expect((await api.call('get', '/groups')).status).toBe(200);
    } finally {
      await soloApp.close();
      await solo.end();
    }
  });
});

describe('restore after the permanent delete', () => {
  it('lists a normal deleted user as restorable and the database refuses to restore a tombstone', async () => {
    const { api, target } = await setup();
    const listed = (await api.call('get', '/users/deleted')).body.items.find((u: { id: string }) => u.id === target.id);
    expect(listed).toMatchObject({ can_restore: true, restore_blocked_reason: null });
    expect((await api.call('post', `/users/${target.id}/purge`, { reason: 'Gone for good', confirm_text: target.employeeId })).status).toBe(200);
    await db.query('BEGIN');
    try {
      const admin = (await db.query("SELECT u.id FROM users u JOIN group_members gm ON gm.user_id = u.id JOIN groups g ON g.id = gm.group_id AND g.is_system_admins WHERE u.status = 'active' LIMIT 1")).rows[0].id as string;
      await beginAs(db, admin);
      await expect(db.query('SELECT idm_restore_user($1::uuid, $2)', [target.id, 'Came back'])).rejects.toThrow(/purged/);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
