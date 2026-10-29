import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserStateService } from '../src/auth/user-state.service';
import { NAV_KEYS } from '../src/me/me.service';
import { API, Api, delegate, grantProfile, loggedIn, makeAdmin, makeUser, startApp, superDb } from './helpers';

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

describe('problem+json, request ids, unknown routes', () => {
  it('every other route is 404 not_found as problem+json with an X-Request-Id', async () => {
    const api = await loggedIn(app, await makeUser(db, { assigned: true }));
    const cases: [Api, 'get' | 'post' | 'put' | 'patch' | 'delete', string][] = [
      [api, 'get', '/nothing-here'],
      [api, 'put', '/users'],
      [api, 'delete', '/users/00000000-0000-4000-8000-000000000000'],
      [api, 'post', '/groups'], // createGroup is in the contract but not built yet
      [api, 'patch', '/groups/00000000-0000-4000-8000-000000000000'],
      [api, 'get', '/matrix'], // in the contract, not built yet
      [new Api(app), 'get', '/matrix'], // unauthenticated: still a plain 404
    ];
    for (const [client, method, path] of cases) {
      const res = await client.call(method, path, method === 'get' || method === 'delete' ? undefined : {});
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 404, code: 'not_found', title: 'Not found' });
      expect(res.body.type).toMatch(/^https:\/\/pmis\.aljeel\.internal\/problems\/not_found$/);
      expect(res.body.request_id).toBe(res.headers['x-request-id']);
    }
  });

  it('echoes a safe X-Request-Id and replaces an unsafe one', async () => {
    const ok = await request(app.getHttpServer()).get(`${API}/auth/session`).set('X-Request-Id', 'client-req-12345');
    expect(ok.headers['x-request-id']).toBe('client-req-12345');
    expect(ok.body.request_id).toBe('client-req-12345');
    const bad = await request(app.getHttpServer()).get(`${API}/auth/session`).set('X-Request-Id', 'bad id with spaces <script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const two = await request(app.getHttpServer()).get(`${API}/auth/session`);
    expect(two.headers['x-request-id']).not.toBe(bad.headers['x-request-id']);
  });

  it('sets no-store and nosniff, and does not announce the framework', async () => {
    const res = await request(app.getHttpServer()).get(`${API}/auth/session`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('unexpected failures answer 500 internal_error with a request id and no internals', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.port = '1'; // nothing listens there: every query fails
    const broken = await startApp({ databaseUrl: url.toString() });
    try {
      const res = await new Api(broken).login('someone@example.test', 'Whatever-Pass-123');
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/problem\+json/);
      expect(res.body).toMatchObject({ status: 500, code: 'internal_error' });
      expect(res.body.request_id).toBe(res.headers['x-request-id']);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/pmis_app|127\.0\.0\.1|prisma|ECONN|password/i);
    } finally {
      await broken.close();
    }
  });

  it('a malformed id is a 404 (or 403 without the right), never a 500', async () => {
    const admin = await loggedIn(app, await makeAdmin(db));
    expect((await admin.call('get', '/users/00000000-0000-0000-0000-00000000000g')).status).toBe(404);
    expect((await admin.call('get', '/groups/%00')).status).toBe(404);
  });

  it('401 for protected routes without a cookie, as problem+json', async () => {
    for (const [method, path] of [['get', '/me'], ['get', '/users'], ['get', '/groups'], ['post', '/auth/logout']] as const) {
      const res = await new Api(app).raw(method, path);
      expect(res.status, path).toBe(401);
      expect(res.body.code).toBe('unauthenticated');
    }
  });
});

describe('GET /me', () => {
  it('a System Admin gets every module key the web app knows, all grants and is_system_admin', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const res = await api.call('get', '/me');
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toMatch(/^"\d+"$/);
    expect(res.body.is_system_admin).toBe(true);
    expect([...res.body.effective.nav].sort()).toEqual([...NAV_KEYS].sort());
    expect(res.body.effective.nav).toEqual(expect.arrayContaining(['sites', 'admin.users', 'admin.groups', 'audit', 'my_work']));
    expect(res.body.effective.grants).toEqual(expect.arrayContaining([{ module_key: '*', action: 'view', region_ids: 'all' }, { module_key: '*', action: 'administer', region_ids: 'all' }]));
    expect(res.body.groups).toEqual([expect.objectContaining({ name: 'System Admins', is_system_admins: true })]);
    expect(res.body.assignments).toEqual([]);
    expect(res.body.user).toMatchObject({ local_sign_in: true, must_change_password: false });
  });

  it('a regular user gets assignments, groups and grants from the database, with regions per grant', async () => {
    const u = await makeUser(db, { assigned: true });
    // a regional assignment with its own module and profile
    const role = (await db.query("INSERT INTO roles (code, name_en) VALUES ($1, 'Regional CW') RETURNING id", [`REG_${Date.now()}`])).rows[0].id as string;
    await db.query('BEGIN'); // the scope check is deferred to commit
    const a = (await db.query(`INSERT INTO user_role_assignments (user_id, role_id, permission_level, team, all_regions, all_modules)
      VALUES ($1, $2, 'approve', 'cw', false, false) RETURNING id`, [u.id, role])).rows[0].id as string;
    await db.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 1), ($1, 3)', [a]);
    await db.query("INSERT INTO user_role_assignment_modules (assignment_id, module_key) VALUES ($1, 'sites')", [a]);
    await db.query('COMMIT');
    const p = (await db.query("INSERT INTO permission_profiles (code, name_en) VALUES ($1, 'p') RETURNING id", [`P_${Date.now()}`])).rows[0].id as string;
    await db.query("INSERT INTO permission_grants (profile_id, module_key, action) VALUES ($1, 'sites', 'view'), ($1, 'sites.tasks', 'edit'), ($1, 'warehouse', 'view')", [p]);
    await db.query('INSERT INTO user_role_assignment_profiles (assignment_id, profile_id) VALUES ($1, $2)', [a, p]);
    const g = (await db.query("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`CW Reviewers ${Date.now()}`])).rows[0].id as string;
    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [g, u.id]);

    const api = await loggedIn(app, u);
    const res = await api.call('get', '/me');
    expect(res.status).toBe(200);
    const mine = res.body.assignments.find((x: { id: string }) => x.id === a);
    expect(mine).toMatchObject({ permission_level: 'approve', team: 'cw', region_ids: [1, 3], module_keys: ['sites'], profile_ids: [p], is_active_now: true });
    expect(res.body.groups.map((x: { id: string }) => x.id)).toEqual([g]);
    const grants = res.body.effective.grants;
    expect(grants).toEqual([
      { module_key: 'sites', action: 'view', region_ids: [1, 3] },
      { module_key: 'sites.tasks', action: 'edit', region_ids: [1, 3] },
    ]); // warehouse is outside the assignment's modules: scopes never cross
    expect(res.body.effective.nav).toEqual(['messages', 'sites']);
    expect(res.body.effective.matrix_levels).toEqual(expect.arrayContaining([{ module_key: 'sites', level: 'approve', region_ids: [1, 3] }]));
  });

  it('delegated rights show up in the effective grants', async () => {
    const u = await makeUser(db, { assigned: true });
    await delegate(db, u.id, [['users', 'create']]);
    const api = await loggedIn(app, u);
    const res = await api.call('get', '/me');
    expect(res.body.effective.grants).toEqual([{ module_key: 'users', action: 'create', region_ids: 'all' }]);
  });

  it('grants through a profile open the module in nav and the screen it names', async () => {
    const u = await makeUser(db, { assigned: true });
    await grantProfile(db, u.id, [['admin.users', 'view']]);
    app.get(UserStateService).invalidateAll();
    const api = await loggedIn(app, u);
    const res = await api.call('get', '/me');
    expect(res.body.effective.nav).toContain('admin.users');
  });
});
