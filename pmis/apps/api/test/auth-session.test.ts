import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter';
import { sha256Hex } from '../src/auth/session.service';
import { UserStateService } from '../src/auth/user-state.service';
import { Api, NEW_PASSWORD, PASSWORD, loggedIn, makeAdmin, makeUser, startApp, superDb } from './helpers';

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

const sessionRow = async (api: Api) =>
  (await db.query('SELECT *, last_activity_at > now() - interval \'5 seconds\' AS fresh FROM user_sessions WHERE token_hash = $1', [sha256Hex(api.token!)])).rows[0];

describe('GET /auth/session and POST /auth/logout', () => {
  it('returns the session and the csrf token; 401 problem+json without a cookie', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const res = await api.call('get', '/auth/session');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: true, csrf_token: api.csrf, auth_method: 'local', must_change_password: false, stepup_valid_until: null });
    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());

    const anon = await new Api(app).call('get', '/auth/session');
    expect(anon.status).toBe(401);
    expect(anon.headers['content-type']).toMatch(/problem\+json/);
    expect(anon.body).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(anon.body.request_id).toBe(anon.headers['x-request-id']);
  });

  it('logout needs the CSRF token, then ends the session and clears the cookie', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const noCsrf = await api.raw('post', '/auth/logout');
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('action_forbidden');
    expect(noCsrf.headers['content-type']).toMatch(/problem\+json/);
    const wrong = await api.call('post', '/auth/logout', undefined, { 'X-CSRF-Token': 'not-the-token' });
    expect(wrong.status).toBe(403);
    expect((await api.call('get', '/auth/session')).status).toBe(200); // the failed attempts did not end it

    const out = await api.call('post', '/auth/logout');
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/pmis_session=;/);
    expect((await api.call('get', '/auth/session')).status).toBe(401);
    expect((await api.call('post', '/auth/logout')).status).toBe(401);
    const row = await db.query('SELECT revoked_at, revoke_reason FROM user_sessions WHERE user_id = $1', [u.id]);
    expect(row.rows[0].revoked_at).not.toBeNull(); // revoked, not deleted
    expect(row.rows[0].revoke_reason).toBe('logout');
  });

  it('every unsafe method needs the CSRF token; GET does not', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    for (const [method, path] of [['post', '/auth/local/step-up'], ['post', '/auth/local/password'], ['post', '/users'], ['patch', '/users/x'], ['post', '/groups/x/members'], ['delete', '/groups/x/members/y']] as const) {
      const res = await api.raw(method, path).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.code).toBe('action_forbidden');
    }
    expect((await api.raw('get', '/me')).status).toBe(200);
  });
});

describe('session lifetime (8 h idle sliding, 12 h absolute, revoke)', () => {
  it('expires after 8 hours without activity', async () => {
    const api = await loggedIn(app, await makeUser(db, { assigned: true }));
    await db.query("UPDATE user_sessions SET last_activity_at = now() - interval '7 hours 59 minutes' WHERE token_hash = $1", [sha256Hex(api.token!)]);
    expect((await api.call('get', '/auth/session')).status).toBe(200);
    await db.query("UPDATE user_sessions SET last_activity_at = now() - interval '8 hours 1 minute' WHERE token_hash = $1", [sha256Hex(api.token!)]);
    const res = await api.call('get', '/auth/session');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthenticated');
  });

  it('expires after 12 hours however active the user is', async () => {
    const api = await loggedIn(app, await makeUser(db, { assigned: true }));
    await db.query("UPDATE user_sessions SET created_at = now() - interval '12 hours 1 minute', expires_at = now() - interval '1 minute' WHERE token_hash = $1", [sha256Hex(api.token!)]);
    expect((await api.call('get', '/me')).status).toBe(401);
  });

  it('real activity slides the idle window; X-PMIS-Live: 1 does not', async () => {
    const api = await loggedIn(app, await makeUser(db, { assigned: true }));
    const old = "UPDATE user_sessions SET last_activity_at = now() - interval '3 hours' WHERE token_hash = $1";
    await db.query(old, [sha256Hex(api.token!)]);
    expect((await api.call('get', '/auth/session', undefined, { 'X-PMIS-Live': '1' })).status).toBe(200);
    expect((await sessionRow(api)).fresh).toBe(false);
    expect((await api.call('get', '/auth/session')).status).toBe(200);
    expect((await sessionRow(api)).fresh).toBe(true);
  });

  it('a revoked session is refused at once', async () => {
    const api = await loggedIn(app, await makeUser(db, { assigned: true }));
    await db.query('UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1', [sha256Hex(api.token!)]);
    expect((await api.call('get', '/me')).status).toBe(401);
  });

  it('a forged or malformed cookie is refused', async () => {
    const api = new Api(app);
    api.token = 'A'.repeat(43);
    expect((await api.call('get', '/me')).status).toBe(401);
    api.token = 'short';
    expect((await api.call('get', '/me')).status).toBe(401);
  });

  it('a suspended user is refused on the next request', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [u.id]);
    expect((await api.call('get', '/me')).status).toBe(401);
  });
});

describe('must change password (ADR 0012 section 5)', () => {
  it('allows only /auth/* and GET /me until the password is changed, then everything', async () => {
    const u = await makeUser(db, { assigned: true, mustChange: true });
    const api = new Api(app);
    const login = await api.login(u.employeeId, u.password);
    expect(login.status).toBe(200);
    expect(login.body.must_change_password).toBe(true);

    expect((await api.call('get', '/auth/session')).body.must_change_password).toBe(true);
    const me = await api.call('get', '/me');
    expect(me.status).toBe(200);
    expect(me.body.user.must_change_password).toBe(true);
    for (const [method, path] of [['get', '/users'], ['get', '/groups'], ['post', '/users'], ['get', `/users/${u.id}`]] as const) {
      const res = await api.call(method, path, method === 'post' ? {} : undefined);
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe('password_change_required');
      expect(res.headers['content-type']).toMatch(/problem\+json/);
    }

    // a second session of the same user, to see it end
    const other = await loggedIn(app, u);

    const wrongCurrent = await api.call('post', '/auth/local/password', { current_password: 'Not-My-Password-1', new_password: NEW_PASSWORD });
    expect(wrongCurrent.status).toBe(401);
    expect(wrongCurrent.body.code).toBe('invalid_credentials');
    const failed = await db.query('SELECT failed_count FROM local_credentials WHERE user_id = $1', [u.id]);
    expect(failed.rows[0].failed_count).toBeGreaterThan(0); // the wrong password counted toward the lockout

    const weak = await api.call('post', '/auth/local/password', { current_password: u.password, new_password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body.code).toBe('weak_password');
    expect(weak.body.errors.map((e: { code: string }) => e.code)).toContain('too_short');
    expect(weak.body.errors[0].path).toBe('/new_password');

    const rules: [string, string][] = [
      [u.password, 'same_as_current'],
      ['Password123456', 'common_password'],
      [`${u.email.split('@')[0]}-Violet-Lantern`, 'contains_email'],
      [`Violet-${u.employeeId}-Lantern-x`, 'contains_employee_id'],
      [`Violet-${u.phone.slice(1)}-Lantern`, 'contains_phone'],
    ];
    for (const [pw, code] of rules) {
      const res = await api.call('post', '/auth/local/password', { current_password: u.password, new_password: pw });
      expect(res.status, code).toBe(422);
      expect(res.body.errors.map((e: { code: string }) => e.code), code).toContain(code);
    }

    const ok = await api.call('post', '/auth/local/password', { current_password: u.password, new_password: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.must_change_password).toBe(false);

    expect((await api.call('get', `/users/${u.id}`)).status).toBe(200); // everything works now (own record needs no grant)
    expect((await other.call('get', '/me')).status).toBe(401); // the other session ended
    expect((await new Api(app).login(u.email, u.password)).status).toBe(401); // the temporary password is dead
    expect((await new Api(app).login(u.email, NEW_PASSWORD)).status).toBe(200);
    const audit = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'password_changed' AND entity_id = $1", [u.id]);
    expect(audit.rows[0].n).toBe(1);
    const stored = await db.query('SELECT password_hash, must_change FROM local_credentials WHERE user_id = $1', [u.id]);
    expect(stored.rows[0].must_change).toBe(false);
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('a pending account that must change its password gets password_change_required first', async () => {
    const u = await makeUser(db, { status: 'pending_assignment', mustChange: true });
    const api = await loggedIn(app, u);
    const res = await api.call('get', '/groups');
    expect(res.body.code).toBe('password_change_required');
  });

  it('refuses a missing or oversized password field', async () => {
    const api = await loggedIn(app, await makeUser(db, { assigned: true }));
    expect((await api.call('post', '/auth/local/password', { new_password: NEW_PASSWORD })).status).toBe(422);
    expect((await api.call('post', '/auth/local/password', { current_password: PASSWORD, new_password: NEW_PASSWORD, extra: 1 })).status).toBe(422);
  });
});

describe('pending accounts (ADR 0002 section 5)', () => {
  it('a pending_assignment user reaches only /auth/* and GET /me', async () => {
    const u = await makeUser(db, { status: 'pending_assignment' });
    const api = await loggedIn(app, u);
    expect((await api.call('get', '/auth/session')).status).toBe(200);
    const me = await api.call('get', '/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ is_system_admin: false, assignments: [], groups: [], effective: { grants: [], nav: [], matrix_levels: [] } });
    for (const [method, path, body] of [
      ['get', '/users', undefined], ['get', '/groups', undefined], ['get', `/users/${u.id}`, undefined], ['post', '/users', {}], ['post', '/groups/x/members', {}],
    ] as const) {
      const res = await api.call(method, path, body);
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe('pending_assignment');
    }
    expect((await api.call('post', '/auth/local/step-up', { password: u.password })).status).toBe(200); // /auth/* works
    expect((await api.call('post', '/auth/logout')).status).toBe(204);
  });

  it('an active user without an assignment is pending too; an assignment frees them within the cache window', async () => {
    const u = await makeUser(db, { status: 'active' });
    const api = await loggedIn(app, u);
    expect((await api.call('get', '/groups')).body.code).toBe('pending_assignment');
    const { assign } = await import('./helpers');
    await assign(db, u.id);
    app.get(UserStateService).invalidateAll(); // the state is cached for up to 60 s
    expect((await api.call('get', `/users/${u.id}`)).status).toBe(200);
  });

  it('a System Admin without any assignment row is not pending (ADR 0012 section 9)', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const assignments = await db.query('SELECT 1 FROM user_role_assignments WHERE user_id = $1', [admin.id]);
    expect(assignments.rowCount).toBe(0);
    expect((await api.call('get', '/groups')).status).toBe(200);
  });

  it('POST /me/notify-admins is not built yet: 404 problem+json', async () => {
    const api = await loggedIn(app, await makeUser(db, { status: 'pending_assignment' }));
    const res = await api.call('post', '/me/notify-admins', {});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});

describe('step-up (password)', () => {
  it('answers 401 step_up_required with step_up_method password, then accepts the action after the password is re-entered', async () => {
    const admin = await makeAdmin(db);
    const target = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, admin);
    const version = (await api.call('get', `/users/${target.id}`)).headers['etag'];

    const first = await api.call('patch', `/users/${target.id}`, { status: 'suspended', reason: 'step-up test' }, { 'If-Match': version! });
    expect(first.status).toBe(401);
    expect(first.body).toMatchObject({ code: 'step_up_required', step_up_method: 'password' });
    expect(first.body.step_up_url).toBeUndefined();

    const wrong = await api.stepUp('Not-My-Password-1');
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('invalid_credentials');
    const afterWrong = await api.call('patch', `/users/${target.id}`, { status: 'suspended', reason: 'step-up test' }, { 'If-Match': version! });
    expect(afterWrong.status).toBe(401);

    const good = await api.stepUp(admin.password);
    expect(good.status).toBe(200);
    expect(new Date(good.body.stepup_valid_until).getTime()).toBeGreaterThan(Date.now() + 200_000);
    expect(new Date(good.body.stepup_valid_until).getTime()).toBeLessThanOrEqual(Date.now() + 300_000 + 2000);

    const done = await api.call('patch', `/users/${target.id}`, { status: 'suspended', reason: 'step-up test' }, { 'If-Match': version! });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('suspended');

    // the window is 300 seconds
    await db.query("UPDATE user_sessions SET stepup_at = now() - interval '301 seconds' WHERE token_hash = $1", [sha256Hex(api.token!)]);
    const again = await api.call('post', `/users/${target.id}/password-reset`, { reason: 'step-up expired' });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('step_up_required');
    expect((await api.call('get', '/auth/session')).body.stepup_valid_until).toBeNull();
  });

  it('wrong passwords at step-up count toward the lockout; a locked account answers 429', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    for (let i = 0; i < 5; i++) expect((await api.stepUp(`Wrong-Password-${i}-xyz`)).status).toBe(401);
    const row = await db.query('SELECT locked_until FROM local_credentials WHERE user_id = $1', [u.id]);
    expect(row.rows[0].locked_until).not.toBeNull();
    // a minute later the limiter is quiet, so the answer comes from the lock itself
    app.get(RateLimiter).setClock({ now: () => Date.now() + 120_000 });
    try {
      const res = await api.stepUp(u.password);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('account_locked');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      app.get(RateLimiter).setClock({ now: () => Date.now() });
    }
  });

  it('a non-admin who is not allowed gets 403, not a step-up prompt', async () => {
    const u = await makeUser(db, { assigned: true });
    const target = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const res = await api.call('patch', `/users/${target.id}`, { status: 'suspended', reason: 'no rights' }, { 'If-Match': '"1"' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
  });
});
