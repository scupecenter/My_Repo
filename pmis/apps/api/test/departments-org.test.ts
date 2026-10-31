import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, loggedIn, makeAdmin, makeUser, startApp, superDb } from './helpers';

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

const code = (): string => 'T' + Math.random().toString(36).slice(2, 9).toUpperCase();

async function admin(stepUp = false): Promise<Api> {
  const a = await makeAdmin(db);
  const api = await loggedIn(app, a);
  if (stepUp) expect((await api.stepUp(a.password)).status).toBe(200);
  return api;
}

async function department(api: Api, over: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const c = code();
  const res = await api.call('post', '/departments', { code: c.toLowerCase(), name_en: `Dept ${c}`, name_ar: 'قسم', reason: 'new department', ...over });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, code: c };
}

describe('departments', () => {
  it('creates a department with the code in upper case, lists it and audits the change', async () => {
    const api = await admin();
    const c = code();
    const res = await api.call('post', '/departments', { code: c.toLowerCase(), name_en: 'Planning', name_ar: 'التخطيط', reason: 'new department' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: c, name_en: 'Planning', name_ar: 'التخطيط', is_active: true, member_count: 0 });
    const list = await api.call('get', '/departments');
    expect(list.status).toBe(200);
    expect(list.body.items.map((d: { id: string }) => d.id)).toContain(res.body.id);
    const audit = await db.query("SELECT reason FROM audit_log WHERE action = 'department_created' AND entity_id = $1", [res.body.id]);
    expect(audit.rows[0].reason).toBe('new department');
  });

  it('refuses a duplicate code with 409 duplicate and errors[] path /code', async () => {
    const api = await admin();
    const d = await department(api);
    const again = await api.call('post', '/departments', { code: d.code, name_en: 'Other', reason: 'duplicate try' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('duplicate');
    expect(again.body.errors).toEqual([expect.objectContaining({ path: '/code', code: 'duplicate' })]);
    expect(again.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('updates, deactivates and keeps the member count; the name_ar stays when omitted', async () => {
    const api = await admin();
    const d = await department(api);
    const member = await makeUser(db, { assigned: true });
    await db.query('UPDATE users SET department_id = $1 WHERE id = $2', [d.id, member.id]);
    const upd = await api.call('patch', `/departments/${d.id}`, { code: d.code, name_en: 'Renamed', is_active: false, reason: 'closed down' });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name_en: 'Renamed', name_ar: 'قسم', is_active: false, member_count: 1 });
    expect((await api.call('patch', `/departments/${d.id}`, { code: d.code, name_en: 'Renamed', name_ar: null, reason: 'clear arabic' })).body.name_ar).toBeNull();
    const missing = await api.call('patch', '/departments/00000000-0000-4000-8000-000000000000', { code: 'ABC', name_en: 'x', reason: 'none' });
    expect(missing.status).toBe(404);
    const clash = await department(api);
    const taken = await api.call('patch', `/departments/${d.id}`, { code: clash.code, name_en: 'x', reason: 'recode' });
    expect(taken.status).toBe(409);
    expect(taken.body.errors[0].path).toBe('/code');
  });

  it('validates the body', async () => {
    const api = await admin();
    const bad = await api.call('post', '/departments', { code: 'x', name_en: '', reason: 'a' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('validation_failed');
    expect(bad.body.errors.length).toBeGreaterThan(0);
  });

  it('is open to read for any signed-in user (active ones only) and to write for admins only', async () => {
    const api = await admin();
    const active = await department(api);
    const inactive = await department(api, { is_active: false });
    const plain = await loggedIn(app, await makeUser(db, { assigned: true }));
    const list = await plain.call('get', '/departments?include_inactive=true');
    expect(list.status).toBe(200);
    const ids = list.body.items.map((d: { id: string }) => d.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id); // the flag is ignored without admin.users view
    const adminList = await api.call('get', '/departments?include_inactive=true');
    expect(adminList.body.items.map((d: { id: string }) => d.id)).toContain(inactive.id);
    expect((await api.call('get', '/departments')).body.items.map((d: { id: string }) => d.id)).not.toContain(inactive.id);

    const post = await plain.call('post', '/departments', { code: code(), name_en: 'Nope', reason: 'not allowed' });
    expect(post.status).toBe(403);
    expect(post.body.code).toBe('action_forbidden');
    const patch = await plain.call('patch', `/departments/${active.id}`, { code: active.code, name_en: 'Nope', reason: 'not allowed' });
    expect(patch.status).toBe(403);
    expect((await new Api(app).raw('get', '/departments')).status).toBe(401);
  });
});

describe('PUT /users/{id}/org', () => {
  it('sets manager and department, returns the UserDetail with both, and shows them in /users, /me and the picker data', async () => {
    const api = await admin(true);
    const d = await department(api);
    const boss = await makeUser(db, { assigned: true });
    const person = await makeUser(db, { assigned: true });
    const res = await api.call('put', `/users/${person.id}/org`, { manager_id: boss.id, department_id: d.id, reason: 'reporting line' });
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toMatch(/^"\d+"$/);
    expect(res.body.manager).toEqual({ id: boss.id, display_name: boss.name, employee_id: boss.employeeId });
    expect(res.body.department).toMatchObject({ id: d.id, code: d.code });
    expect(res.body.assignments).toBeDefined();
    const get = await api.call('get', `/users/${person.id}`);
    expect(get.body.manager.id).toBe(boss.id);
    const list = await api.call('get', `/users?q=${encodeURIComponent(person.email)}`);
    expect(list.body.items[0]).toMatchObject({ manager: { id: boss.id }, department: { id: d.id } });
    const me = await (await loggedIn(app, person)).call('get', '/me');
    expect(me.body.user.manager.id).toBe(boss.id);
    expect(me.body.user.department.code).toBe(d.code);
    const audit = await db.query("SELECT reason, after FROM audit_log WHERE action = 'user_org_set' AND entity_id = $1", [person.id]);
    expect(audit.rows[0]).toMatchObject({ reason: 'reporting line', after: { manager_id: boss.id, department_id: d.id } });

    const cleared = await api.call('put', `/users/${person.id}/org`, { manager_id: null, department_id: null, reason: 'left the team' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.manager).toBeNull();
    expect(cleared.body.department).toBeNull();
  });

  it('shows null manager and department for a user without them', async () => {
    const api = await admin();
    const u = await makeUser(db, { assigned: true });
    const get = await api.call('get', `/users/${u.id}`);
    expect(get.body.manager).toBeNull();
    expect(get.body.department).toBeNull();
  });

  it('refuses a manager loop with 422 and errors[].code manager_loop', async () => {
    const api = await admin(true);
    const a = await makeUser(db, { assigned: true });
    const b = await makeUser(db, { assigned: true });
    const c = await makeUser(db, { assigned: true });
    expect((await api.call('put', `/users/${b.id}/org`, { manager_id: a.id, department_id: null, reason: 'b under a' })).status).toBe(200);
    expect((await api.call('put', `/users/${c.id}/org`, { manager_id: b.id, department_id: null, reason: 'c under b' })).status).toBe(200);
    const loop = await api.call('put', `/users/${a.id}/org`, { manager_id: c.id, department_id: null, reason: 'a under c' });
    expect(loop.status).toBe(422);
    expect(loop.body.code).toBe('validation_failed');
    expect(loop.body.errors).toEqual([expect.objectContaining({ code: 'manager_loop' })]);
    const self = await api.call('put', `/users/${a.id}/org`, { manager_id: a.id, department_id: null, reason: 'a under a' });
    expect(self.status).toBe(422);
    expect(self.body.errors[0].code).toBe('manager_loop');
  });

  it('refuses an inactive manager and an inactive department with 422', async () => {
    const api = await admin(true);
    const person = await makeUser(db, { assigned: true });
    const gone = await makeUser(db, { status: 'suspended' });
    const m = await api.call('put', `/users/${person.id}/org`, { manager_id: gone.id, department_id: null, reason: 'suspended manager' });
    expect(m.status).toBe(422);
    expect(m.body.errors[0]).toMatchObject({ path: '/manager_id', code: 'inactive' });
    const d = await department(api, { is_active: false });
    const dep = await api.call('put', `/users/${person.id}/org`, { manager_id: null, department_id: d.id, reason: 'inactive dept' });
    expect(dep.status).toBe(422);
    expect(dep.body.errors[0]).toMatchObject({ path: '/department_id', code: 'inactive' });
  });

  it('needs step-up, an admin and a valid body', async () => {
    const api = await admin(false);
    const person = await makeUser(db, { assigned: true });
    const noStep = await api.call('put', `/users/${person.id}/org`, { manager_id: null, department_id: null, reason: 'no step-up yet' });
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');

    const plain = await loggedIn(app, await makeUser(db, { assigned: true }));
    const denied = await plain.call('put', `/users/${person.id}/org`, { manager_id: null, department_id: null, reason: 'not an admin' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');

    const stepped = await admin(true);
    const bad = await stepped.call('put', `/users/${person.id}/org`, { manager_id: 'nope', reason: 'x' });
    expect(bad.status).toBe(422);
    const unknown = await stepped.call('put', '/users/00000000-0000-4000-8000-000000000000/org', { manager_id: null, department_id: null, reason: 'no such user' });
    expect(unknown.status).toBe(404);
  });
});
