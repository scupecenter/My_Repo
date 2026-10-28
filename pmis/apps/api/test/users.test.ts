import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, delegate, grantProfile, loggedIn, makeAdmin, makeUser, startApp, superDb, TestUser } from './helpers';

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

async function adminWithStepUp(): Promise<{ admin: TestUser; api: Api }> {
  const admin = await makeAdmin(db);
  const api = await loggedIn(app, admin);
  expect((await api.stepUp(admin.password)).status).toBe(200);
  return { admin, api };
}

const newUserBody = (over: Record<string, unknown> = {}) => {
  const n = Math.random().toString(36).slice(2, 10);
  return { display_name: `New Person ${n}`, email: `New.Person.${n}@Example.Test`, reason: 'new engineer joined', ...over };
};

describe('POST /users (createLocalUser)', () => {
  it('creates a pending local account and returns the generated temporary password once', async () => {
    const { admin, api } = await adminWithStepUp();
    const body = newUserBody({ employee_id: '7123', phone: '+218913334455' });
    const emp = await db.query("SELECT 1 FROM users WHERE employee_id = '7123' OR phone = '+218913334455'");
    if (emp.rowCount) await db.query("UPDATE users SET employee_id = NULL, phone = NULL WHERE employee_id = '7123' OR phone = '+218913334455'");
    const res = await api.call('post', '/users', body);
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const tmp: string = res.body.temporary_password;
    expect(tmp).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{16}$/);
    expect(res.body.user).toMatchObject({
      display_name: body.display_name, email: (body.email as string).toLowerCase(), employee_id: '7123', phone: '+218913334455',
      status: 'pending_assignment', local_sign_in: true, must_change_password: true,
    });

    // never shown again, never stored in clear
    const get = await api.call('get', `/users/${res.body.user.id}`);
    expect(JSON.stringify(get.body)).not.toContain(tmp);
    const cred = await db.query('SELECT password_hash, must_change, set_by FROM local_credentials WHERE user_id = $1', [res.body.user.id]);
    expect(cred.rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,/);
    expect(cred.rows[0].password_hash).not.toContain(tmp);
    expect(cred.rows[0].must_change).toBe(true);
    expect(cred.rows[0].set_by).toBe(admin.id);
    const logs = await db.query('SELECT (SELECT count(*) FROM audit_log WHERE after::text LIKE $1 OR before::text LIKE $1 OR reason LIKE $1)::int AS a, (SELECT count(*) FROM system_log WHERE context::text LIKE $1 OR message LIKE $1)::int AS s', [`%${tmp}%`]);
    expect(logs.rows[0]).toEqual({ a: 0, s: 0 });

    // audited with the actor
    const audit = await db.query("SELECT actor_id, reason, after FROM audit_log WHERE action = 'user_created_local' AND entity_id = $1", [res.body.user.id]);
    expect(audit.rows[0]).toMatchObject({ actor_id: admin.id, reason: 'new engineer joined' });

    // the new person signs in with it (by employee ID) and must change it; their account is pending
    const person = new Api(app);
    const login = await person.login('7123', tmp);
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ must_change_password: true, status: 'pending_assignment' });
    expect((await person.call('get', '/groups')).body.code).toBe('password_change_required');
  });

  it('uses the temporary password the admin chose when it meets the policy, and refuses a weak one', async () => {
    const { api } = await adminWithStepUp();
    const weak = await api.call('post', '/users', newUserBody({ temporary_password: 'Password123456' }));
    expect(weak.status).toBe(422);
    expect(weak.body.code).toBe('weak_password');
    expect(weak.body.errors[0].path).toBe('/temporary_password');
    const short = await api.call('post', '/users', newUserBody({ temporary_password: 'abc' }));
    expect(short.status).toBe(422);
    const own = await api.call('post', '/users', newUserBody({ email: 'rania.fathi@example.test', temporary_password: 'Rania.Fathi-2026-xx' }));
    expect(own.body.code).toBe('weak_password'); // contains the email name
    expect(own.body.errors.map((e: { code: string }) => e.code)).toContain('contains_email');

    const chosen = 'Chosen-Temp-Phrase-55';
    const ok = await api.call('post', '/users', newUserBody({ temporary_password: chosen }));
    expect(ok.status).toBe(201);
    expect(ok.body.temporary_password).toBe(chosen);
  });

  it('answers 409 duplicate naming the field for a repeated email, employee ID and phone', async () => {
    const { api } = await adminWithStepUp();
    const existing = await makeUser(db, { assigned: true });
    const dupEmail = await api.call('post', '/users', newUserBody({ email: existing.email.toUpperCase() }));
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body).toMatchObject({ code: 'duplicate' });
    expect(dupEmail.body.errors).toEqual([expect.objectContaining({ path: '/email', code: 'duplicate' })]);
    expect(dupEmail.headers['content-type']).toMatch(/problem\+json/);

    const dupEmp = await api.call('post', '/users', newUserBody({ employee_id: existing.employeeId }));
    expect(dupEmp.status).toBe(409);
    expect(dupEmp.body.errors[0].path).toBe('/employee_id');
    const dupPhone = await api.call('post', '/users', newUserBody({ phone: existing.phone }));
    expect(dupPhone.status).toBe(409);
    expect(dupPhone.body.errors[0].path).toBe('/phone');
    // nothing was left behind by the failed attempts
    const n = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [existing.email]);
    expect(n.rows[0].n).toBe(1);
  });

  it('validates the body with field-level errors (422)', async () => {
    const { api } = await adminWithStepUp();
    const res = await api.call('post', '/users', { display_name: '', email: 'not-an-email', employee_id: '12', phone: '0911', reason: 'x', surprise: 1 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['/display_name', '/email', '/employee_id', '/phone', '/reason']));
    expect(res.body.errors.some((e: { code: string }) => e.code === 'unknown_field')).toBe(true);
    expect((await api.call('post', '/users')).status).toBe(422); // no body at all
  });

  it('is refused for a user without the right (403 action_forbidden) and for a user with only view', async () => {
    const plain = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, plain);
    const res = await api.call('post', '/users', newUserBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ status: 403, code: 'action_forbidden' });
    expect(res.headers['content-type']).toMatch(/problem\+json/);

    const viewer = await makeUser(db, { assigned: true });
    await grantProfile(db, viewer.id, [['admin.users', 'view']]);
    const v = await loggedIn(app, viewer);
    expect((await v.call('post', '/users', newUserBody())).status).toBe(403);
    const exists = await db.query("SELECT count(*)::int AS n FROM users WHERE display_name = $1", [(newUserBody() as { display_name: string }).display_name]);
    expect(exists.rows[0].n).toBe(0);
  });

  it('works for a delegate holding users.create', async () => {
    const delegate1 = await makeUser(db, { assigned: true });
    await delegate(db, delegate1.id, [['users', 'create']]);
    const api = await loggedIn(app, delegate1);
    const res = await api.call('post', '/users', newUserBody());
    expect(res.status).toBe(201);
    const audit = await db.query("SELECT on_behalf_of FROM audit_log WHERE action = 'user_created_local' AND entity_id = $1", [res.body.user.id]);
    expect(audit.rows[0].on_behalf_of).not.toBeNull(); // logged as "X on behalf of System Admin"
  });
});

describe('POST /users/{id}/password-reset', () => {
  it('needs step-up, then sets a new temporary password, ends the user\'s sessions and unlocks the account', async () => {
    const admin = await makeAdmin(db);
    const target = await makeUser(db, { assigned: true });
    await db.query("UPDATE local_credentials SET locked_until = now() + interval '10 minutes', failed_count = 3 WHERE user_id = $1", [target.id]);
    expect((await new Api(app).login(target.email, target.password)).status).toBe(401); // locked: cannot sign in
    await db.query('UPDATE local_credentials SET locked_until = NULL WHERE user_id = $1', [target.id]);
    const s1 = await loggedIn(app, target);
    const s2 = await loggedIn(app, target);
    await db.query("UPDATE local_credentials SET locked_until = now() + interval '10 minutes' WHERE user_id = $1", [target.id]);

    const api = await loggedIn(app, admin);
    const early = await api.call('post', `/users/${target.id}/password-reset`, { reason: 'forgot it' });
    expect(early.status).toBe(401);
    expect(early.body).toMatchObject({ code: 'step_up_required', step_up_method: 'password' });
    await api.stepUp(admin.password);

    const res = await api.call('post', `/users/${target.id}/password-reset`, { reason: 'forgot it' });
    expect(res.status).toBe(200);
    expect(res.body.temporary_password).toMatch(/^[A-Za-z2-9]{16}$/);
    expect(Object.keys(res.body)).toEqual(['temporary_password']);

    expect((await s1.call('get', '/me')).status).toBe(401); // sessions ended
    expect((await s2.call('get', '/me')).status).toBe(401);
    const revoked = await db.query("SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL AND revoke_reason = 'password_reset' AND revoked_by = $2", [target.id, admin.id]);
    expect(revoked.rows[0].n).toBe(2);
    expect((await new Api(app).login(target.email, target.password)).status).toBe(401); // the old password is dead
    const again = new Api(app);
    const login = await again.login(target.email, res.body.temporary_password); // and the lock is gone
    expect(login.status).toBe(200);
    expect(login.body.must_change_password).toBe(true);
    const audit = await db.query("SELECT actor_id, reason FROM audit_log WHERE action = 'password_reset' AND entity_id = $1", [target.id]);
    expect(audit.rows[0]).toMatchObject({ actor_id: admin.id, reason: 'forgot it' });
  });

  it('accepts an admin-chosen temporary password that meets the policy, refuses a weak one', async () => {
    const { api } = await adminWithStepUp();
    const target = await makeUser(db, { assigned: true });
    const weak = await api.call('post', `/users/${target.id}/password-reset`, { reason: 'reset', temporary_password: 'qwertyuiop123' });
    expect(weak.status).toBe(422);
    expect(weak.body.code).toBe('weak_password');
    const ok = await api.call('post', `/users/${target.id}/password-reset`, { reason: 'reset', temporary_password: 'Fresh-Temp-Phrase-31' });
    expect(ok.status).toBe(200);
    expect(ok.body.temporary_password).toBe('Fresh-Temp-Phrase-31');
  });

  it('refuses your own account (self_beneficiary), an unknown user (404), and a missing reason (422)', async () => {
    const { admin, api } = await adminWithStepUp();
    const self = await api.call('post', `/users/${admin.id}/password-reset`, { reason: 'myself' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');
    expect((await api.call('post', '/users/00000000-0000-4000-8000-000000000000/password-reset', { reason: 'ghost' })).status).toBe(404);
    expect((await api.call('post', '/users/not-a-uuid/password-reset', { reason: 'ghost' })).status).toBe(404);
    const target = await makeUser(db, { assigned: true });
    expect((await api.call('post', `/users/${target.id}/password-reset`, {})).status).toBe(422);
  });

  it('is refused for a non-admin (403)', async () => {
    const plain = await makeUser(db, { assigned: true });
    const target = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, plain);
    const res = await api.call('post', `/users/${target.id}/password-reset`, { reason: 'no rights' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
  });

  it('a delegate with users.edit resets only an account without assignments and without an Entra link; an admin cannot be reset by a delegate', async () => {
    const del = await makeUser(db, { assigned: true });
    await delegate(db, del.id, [['users', 'edit']]);
    const api = await loggedIn(app, del);
    expect((await api.stepUp(del.password)).status).toBe(200);

    const fresh = await makeUser(db, { status: 'pending_assignment' });
    expect((await api.call('post', `/users/${fresh.id}/password-reset`, { reason: 'new account' })).status).toBe(200);

    const holder = await makeUser(db, { assigned: true });
    const refused = await api.call('post', `/users/${holder.id}/password-reset`, { reason: 'has rights' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('action_forbidden');

    const entra = await makeUser(db, { status: 'pending_assignment' });
    await db.query("UPDATE users SET m365_object_id = 'oid-' || id WHERE id = $1", [entra.id]);
    const entraRes = await api.call('post', `/users/${entra.id}/password-reset`, { reason: 'entra user' });
    expect(entraRes.status).toBe(403);
    expect(entraRes.body.code).toBe('action_forbidden');

    const admin = await makeAdmin(db);
    const adminRes = await api.call('post', `/users/${admin.id}/password-reset`, { reason: 'admin' });
    expect(adminRes.status).toBe(403);
    expect(adminRes.body.code).toBe('action_forbidden');
  });
});

describe('GET /users and GET /users/{id}', () => {
  it('lists users with search, status filter and cursor paging', async () => {
    const admin = await makeAdmin(db);
    const tag = `Zed${Date.now().toString(36)}`;
    const made: TestUser[] = [];
    for (let i = 0; i < 5; i++) made.push(await makeUser(db, { assigned: i % 2 === 0, name: `${tag} Person ${i}` }));
    const api = await loggedIn(app, admin);

    const all = await api.call('get', `/users?q=${tag}&limit=2`);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.page).toMatchObject({ limit: 2, total: 5 });
    expect(all.body.page.next_cursor).toBeTruthy();
    const second = await api.call('get', `/users?q=${tag}&limit=2&cursor=${encodeURIComponent(all.body.page.next_cursor)}`);
    const third = await api.call('get', `/users?q=${tag}&limit=2&cursor=${encodeURIComponent(second.body.page.next_cursor)}`);
    expect(third.body.items).toHaveLength(1);
    expect(third.body.page.next_cursor).toBeNull();
    const names = [...all.body.items, ...second.body.items, ...third.body.items].map((u: { display_name: string }) => u.display_name);
    expect(names).toEqual(made.map((m) => m.name).sort());
    expect(all.body.items[0]).toMatchObject({ local_sign_in: true, must_change_password: false });
    expect(all.body.items[0]).not.toHaveProperty('password_hash');

    const byEmp = await api.call('get', `/users?q=${made[1]!.employeeId}`);
    expect(byEmp.body.items.map((u: { id: string }) => u.id)).toContain(made[1]!.id);
    const pending = await api.call('get', `/users?q=${tag}&status=pending_assignment`);
    expect(pending.body.page.total).toBe(2);
    expect((await api.call('get', '/users?status=bogus')).status).toBe(422);
    expect((await api.call('get', '/users?limit=0')).status).toBe(422);
    expect((await api.call('get', '/users?limit=201')).status).toBe(422);
    expect((await api.call('get', '/users?cursor=@@@')).status).toBe(400);
    expect((await api.call('get', `/users?q=${encodeURIComponent('%')}`)).body.page.total).toBe(0); // % is literal, not a wildcard
  });

  it('is module_forbidden without view on admin.users and works with the grant', async () => {
    const plain = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, plain);
    const denied = await api.call('get', '/users');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('module_forbidden');

    const viewer = await makeUser(db, { assigned: true });
    await grantProfile(db, viewer.id, [['admin.users', 'view']]);
    app.get((await import('../src/auth/user-state.service')).UserStateService).invalidateAll();
    const v = await loggedIn(app, viewer);
    expect((await v.call('get', '/users')).status).toBe(200);
    expect((await v.call('get', `/users/${plain.id}`)).status).toBe(200);
  });

  it('returns UserDetail with ETag, assignments, groups and teams; a user may read their own row', async () => {
    const admin = await makeAdmin(db);
    const person = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, admin);
    const res = await api.call('get', `/users/${person.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe(`"${res.body.version}"`);
    expect(res.body).toMatchObject({ id: person.id, email: person.email, status: 'active', local_sign_in: true });
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0]).toMatchObject({ region_ids: 'all', module_keys: 'all', permission_level: 'view', is_active_now: true });
    expect(res.body.groups).toEqual([]);
    expect(res.body.teams).toEqual([]);
    const adminRow = await api.call('get', `/users/${admin.id}`);
    expect(adminRow.body.groups).toEqual([expect.objectContaining({ name: 'System Admins', is_system_admins: true })]);

    const own = await loggedIn(app, person);
    expect((await own.call('get', `/users/${person.id}`)).status).toBe(200);
    const other = await own.call('get', `/users/${admin.id}`);
    expect(other.status).toBe(403);
  });

  it('404 for an unknown or malformed id', async () => {
    const { api } = await adminWithStepUp();
    const res = await api.call('get', '/users/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect((await api.call('get', '/users/nope')).status).toBe(404);
  });
});

describe('PATCH /users/{id} (status)', () => {
  it('needs If-Match (428), refuses a stale one (412), then changes the status, audits it and ends the sessions', async () => {
    const { admin, api } = await adminWithStepUp();
    const target = await makeUser(db, { assigned: true });
    const live = await loggedIn(app, target);
    const got = await api.call('get', `/users/${target.id}`);
    const etag = got.headers['etag']!;

    const none = await api.call('patch', `/users/${target.id}`, { status: 'suspended', reason: 'left the company' });
    expect(none.status).toBe(428);
    expect(none.body.code).toBe('precondition_required');
    const stale = await api.call('patch', `/users/${target.id}`, { status: 'suspended', reason: 'left the company' }, { 'If-Match': '"1"' });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    expect((await live.call('get', '/me')).status).toBe(200); // nothing changed yet

    const ok = await api.call('patch', `/users/${target.id}`, { status: 'suspended', reason: 'left the company' }, { 'If-Match': etag });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('suspended');
    expect(ok.headers['etag']).toBe(`"${ok.body.version}"`);
    expect(ok.headers['etag']).not.toBe(etag);

    expect((await live.call('get', '/me')).status).toBe(401); // sessions ended at once
    expect((await new Api(app).login(target.email, target.password)).status).toBe(401);
    const audit = await db.query("SELECT actor_id, before, after, reason FROM audit_log WHERE action = 'user_status' AND entity_id = $1", [target.id]);
    expect(audit.rows[0]).toMatchObject({ actor_id: admin.id, before: { status: 'active' }, after: { status: 'suspended' }, reason: 'left the company' });

    // and back
    const re = await api.call('patch', `/users/${target.id}`, { status: 'active', reason: 'back again' }, { 'If-Match': ok.headers['etag']! });
    expect(re.status).toBe(200);
    expect((await new Api(app).login(target.email, target.password)).status).toBe(200);
  });

  it('refuses your own row (self_beneficiary), an unknown user, bad bodies, and the employee ID change that has no database path yet', async () => {
    const { admin, api } = await adminWithStepUp();
    const mine = await api.call('get', `/users/${admin.id}`);
    const self = await api.call('patch', `/users/${admin.id}`, { status: 'disabled', reason: 'oops' }, { 'If-Match': mine.headers['etag']! });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');

    expect((await api.call('patch', '/users/00000000-0000-4000-8000-000000000000', { status: 'active', reason: 'ghost' }, { 'If-Match': '"1"' })).status).toBe(404);
    const target = await makeUser(db, { assigned: true });
    const etag = (await api.call('get', `/users/${target.id}`)).headers['etag']!;
    expect((await api.call('patch', `/users/${target.id}`, { reason: 'nothing to change' }, { 'If-Match': etag })).status).toBe(422);
    expect((await api.call('patch', `/users/${target.id}`, { status: 'gone', reason: 'bad status' }, { 'If-Match': etag })).status).toBe(422);
    expect((await api.call('patch', `/users/${target.id}`, { status: 'active' }, { 'If-Match': etag })).status).toBe(422); // reason is required
    const emp = await api.call('patch', `/users/${target.id}`, { employee_id: '5555', reason: 'fix typo' }, { 'If-Match': etag });
    expect(emp.status).toBe(422);
    expect(emp.body.errors[0]).toMatchObject({ path: '/employee_id', code: 'not_supported' });
  });

  it('a delegate (users.edit) cannot deactivate an admin', async () => {
    const del = await makeUser(db, { assigned: true });
    await delegate(db, del.id, [['users', 'edit']]);
    const api = await loggedIn(app, del);
    await api.stepUp(del.password);
    const admin = await makeAdmin(db);
    const probe = await api.call('get', `/users/${admin.id}`);
    expect(probe.status).toBe(403); // no view on admin.users: the row is not even readable
    const v = (await db.query('SELECT (extract(epoch FROM updated_at) * 1000000)::bigint::text AS v FROM users WHERE id = $1', [admin.id])).rows[0].v as string;
    const res = await api.call('patch', `/users/${admin.id}`, { status: 'disabled', reason: 'try' }, { 'If-Match': `"${v}"` });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
    const still = await db.query('SELECT status FROM users WHERE id = $1', [admin.id]);
    expect(still.rows[0].status).toBe('active');
  });

  it('the non-admin gets 403 before any step-up prompt', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const res = await api.call('patch', `/users/${u.id}`, { status: 'active', reason: 'self' }, { 'If-Match': '"1"' });
    expect(res.status).toBe(403);
  });
});

describe('the last System Admin', () => {
  it('cannot be removed or deactivated (409 last_admin), and nothing is committed', async () => {
    const soloApp = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_SOLO as string });
    const solo = await superDb(true);
    try {
      const boot = (await import('./global-setup')).BOOTSTRAP_ADMIN;
      const api = new Api(soloApp);
      expect((await api.login(boot.email, boot.password)).status).toBe(200);
      expect((await api.stepUp(boot.password)).status).toBe(200);
      const group = (await solo.query('SELECT id FROM groups WHERE is_system_admins')).rows[0].id as string;
      const me = (await solo.query('SELECT id FROM users WHERE email = $1', [boot.email])).rows[0].id as string;
      const res = await api.call('delete', `/groups/${group}/members/${me}?reason=${encodeURIComponent('leaving')}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_admin');
      expect(res.headers['content-type']).toMatch(/problem\+json/);
      const still = await solo.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [group, me]);
      expect(still.rowCount).toBe(1);
      expect((await api.call('get', '/groups')).status).toBe(200); // still an admin
    } finally {
      await soloApp.close();
      await solo.end();
    }
  });
});

describe('what pmis_app may do in the database', () => {
  it('cannot read local_credentials or write users; the API still works', async () => {
    const { Client } = await import('pg');
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      await expect(c.query('SELECT * FROM local_credentials')).rejects.toThrow(/permission denied/);
      await expect(c.query("INSERT INTO users (email, display_name) VALUES ('x@example.test', 'x')")).rejects.toThrow(/permission denied/);
      await expect(c.query("UPDATE users SET status = 'active'")).rejects.toThrow(/permission denied/);
      await expect(c.query('DELETE FROM user_sessions')).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT idm_bootstrap_admin('e@example.test', 'E', NULL, NULL, '$argon2id$x')")).rejects.toThrow(/permission denied/);
      await expect(c.query('UPDATE audit_log SET action = action')).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });
});

describe('GET /users/picker', () => {
  it('returns active users only, the reduced shape, and needs 2 characters', async () => {
    const tag = `Pick${Date.now().toString(36)}`;
    const active = await makeUser(db, { assigned: true, name: `${tag} Active` });
    await makeUser(db, { status: 'pending_assignment', name: `${tag} Pending` });
    const api = await loggedIn(app, active);
    const res = await api.call('get', `/users/picker?q=${tag}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: active.id, display_name: `${tag} Active`, employee_id: active.employeeId }]);
    expect((await api.call('get', '/users/picker?q=a')).status).toBe(422);
    const domain = active.email.split('@')[1]!;
    expect((await api.call('get', `/users/picker?q=${encodeURIComponent(domain)}`)).body.items).toEqual([]); // never matches on email
  });
});
