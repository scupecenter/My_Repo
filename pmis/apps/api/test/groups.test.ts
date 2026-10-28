import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, delegate, loggedIn, makeAdmin, makeUser, startApp, superDb, TestUser } from './helpers';

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

async function newGroup(name = `Group ${randomUUID().slice(0, 8)}`): Promise<string> {
  const r = await db.query("INSERT INTO groups (name, description) VALUES ($1, 'test group') RETURNING id", [name]);
  return r.rows[0].id as string;
}
async function addDirect(group: string, user: string): Promise<void> {
  await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [group, user]);
}
async function adminApi(): Promise<{ admin: TestUser; api: Api }> {
  const admin = await makeAdmin(db);
  const api = await loggedIn(app, admin);
  await api.stepUp(admin.password);
  return { admin, api };
}

describe('GET /groups and GET /groups/{id}', () => {
  it('lists groups with member counts, search and paging; any signed-in (non-pending) user may read', async () => {
    const tag = `Crew${Date.now().toString(36)}`;
    const ids = [await newGroup(`${tag} A`), await newGroup(`${tag} B`), await newGroup(`${tag} C`)];
    const member = await makeUser(db, { assigned: true });
    await addDirect(ids[0]!, member.id);
    const api = await loggedIn(app, member);

    const res = await api.call('get', `/groups?q=${tag}&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((g: { name: string }) => g.name)).toEqual([`${tag} A`, `${tag} B`]);
    expect(res.body.items[0]).toMatchObject({ member_count: 1, matrix_cell_count: 0, is_system_admins: false, is_active: true, description: 'test group' });
    expect(res.body.page).toMatchObject({ limit: 2, total: 3 });
    const next = await api.call('get', `/groups?q=${tag}&limit=2&cursor=${encodeURIComponent(res.body.page.next_cursor)}`);
    expect(next.body.items.map((g: { name: string }) => g.name)).toEqual([`${tag} C`]);
    expect(next.body.page.next_cursor).toBeNull();

    const all = await api.call('get', '/groups?q=System');
    expect(all.body.items.some((g: { is_system_admins: boolean }) => g.is_system_admins)).toBe(true);
    expect((await api.call('get', '/groups?limit=abc')).status).toBe(422);
  });

  it('returns the group with members, an ETag that follows the content, and 404 for unknown ids', async () => {
    const g = await newGroup();
    const a = await makeUser(db, { assigned: true, name: 'Alpha Member' });
    const b = await makeUser(db, { assigned: true, name: 'Bravo Member' });
    await addDirect(g, b.id);
    await addDirect(g, a.id);
    const api = await loggedIn(app, a);
    const res = await api.call('get', `/groups/${g}`);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe(`"${res.body.version}"`);
    expect(res.body.members.map((m: { user: { display_name: string } }) => m.user.display_name)).toEqual(['Alpha Member', 'Bravo Member']);
    expect(res.body.members[0]).toMatchObject({ status: 'active', user: { id: a.id, employee_id: a.employeeId } });
    expect(res.body.members[0].added_at).toBeTruthy();

    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [g, b.id]);
    const after = await api.call('get', `/groups/${g}`);
    expect(after.headers['etag']).not.toBe(res.headers['etag']);
    expect((await api.call('get', `/groups/${randomUUID()}`)).status).toBe(404);
    expect((await api.call('get', '/groups/nope')).body.code).toBe('not_found');
  });
});

describe('POST /groups/{id}/members', () => {
  it('needs step-up, then reports done, skipped and failed per user', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const g = await newGroup();
    const fresh = await makeUser(db, { assigned: true });
    const already = await makeUser(db, { assigned: true });
    await addDirect(g, already.id);
    const pending = await makeUser(db, { status: 'pending_assignment' });
    const ghost = randomUUID();
    const body = { user_ids: [fresh.id, already.id, pending.id, ghost, fresh.id], reason: 'staffing the crew' };

    const early = await api.call('post', `/groups/${g}/members`, body);
    expect(early.status).toBe(401);
    expect(early.body).toMatchObject({ code: 'step_up_required', step_up_method: 'password' });
    await api.stepUp(admin.password);

    const res = await api.call('post', `/groups/${g}/members`, body);
    expect(res.status).toBe(200);
    expect(res.body.bulk_action_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.done).toEqual([{ id: fresh.id }]);
    expect(res.body.skipped).toEqual([expect.objectContaining({ ref: already.id, code: 'already_assigned' })]);
    expect(res.body.failed).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: pending.id, code: 'pending_assignment' }),
      expect.objectContaining({ ref: ghost, code: 'not_found' }),
    ]));
    expect(res.body.failed).toHaveLength(2);
    const members = await db.query('SELECT user_id FROM group_members WHERE group_id = $1', [g]);
    expect(members.rows.map((r) => r.user_id).sort()).toEqual([already.id, fresh.id].sort());
    const audit = await db.query("SELECT actor_id, reason FROM audit_log WHERE action = 'group_member_added' AND entity_id = $1 AND after->>'user' = $2", [g, fresh.id]);
    expect(audit.rows[0]).toMatchObject({ actor_id: admin.id, reason: 'staffing the crew' });
  });

  it('refuses adding yourself (self_beneficiary per user) and validates the body', async () => {
    const { admin, api } = await adminApi();
    const g = await newGroup();
    const res = await api.call('post', `/groups/${g}/members`, { user_ids: [admin.id], reason: 'me too' });
    expect(res.status).toBe(200);
    expect(res.body.failed).toEqual([expect.objectContaining({ ref: admin.id, code: 'self_beneficiary' })]);
    expect(res.body.done).toEqual([]);
    expect((await api.call('post', `/groups/${g}/members`, { user_ids: [], reason: 'none' })).status).toBe(422);
    expect((await api.call('post', `/groups/${g}/members`, { user_ids: ['x'], reason: 'bad id' })).status).toBe(422);
    expect((await api.call('post', `/groups/${g}/members`, { user_ids: [admin.id] })).status).toBe(422);
    expect((await api.call('post', `/groups/${randomUUID()}/members`, { user_ids: [admin.id], reason: 'no group' })).status).toBe(404);
  });

  it('is 403 for a user without groups.edit, also with a plain assignment', async () => {
    const plain = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, plain);
    const g = await newGroup();
    const other = await makeUser(db, { assigned: true });
    const res = await api.call('post', `/groups/${g}/members`, { user_ids: [other.id], reason: 'sneaky' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
    const members = await db.query('SELECT 1 FROM group_members WHERE group_id = $1', [g]);
    expect(members.rowCount).toBe(0);
  });

  it('a delegate (groups.edit) manages ordinary groups but not the System Admins group', async () => {
    const del = await makeUser(db, { assigned: true });
    await delegate(db, del.id, [['groups', 'edit']]);
    const api = await loggedIn(app, del);
    await api.stepUp(del.password);
    const person = await makeUser(db, { assigned: true });
    const g = await newGroup();
    const ok = await api.call('post', `/groups/${g}/members`, { user_ids: [person.id], reason: 'delegated work' });
    expect(ok.status).toBe(200);
    expect(ok.body.done).toEqual([{ id: person.id }]);

    const adminGroup = (await db.query('SELECT id FROM groups WHERE is_system_admins LIMIT 1')).rows[0].id as string;
    const bad = await api.call('post', `/groups/${adminGroup}/members`, { user_ids: [person.id], reason: 'make admin' });
    expect(bad.status).toBe(200);
    expect(bad.body.done).toEqual([]);
    expect(bad.body.failed).toEqual([expect.objectContaining({ ref: person.id, code: 'action_forbidden' })]);
    const inAdmin = await db.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [adminGroup, person.id]);
    expect(inAdmin.rowCount).toBe(0);
    expect((await api.call('delete', `/groups/${adminGroup}/members/${person.id}?reason=cleanup`)).status).toBe(404); // not a member: nothing to remove
  });

  it('adding someone to the System Admins group makes them an admin', async () => {
    const { api } = await adminApi();
    const person = await makeUser(db, { assigned: true });
    const adminGroup = (await db.query('SELECT id FROM groups WHERE is_system_admins LIMIT 1')).rows[0].id as string;
    const res = await api.call('post', `/groups/${adminGroup}/members`, { user_ids: [person.id], reason: 'second admin' });
    expect(res.body.done).toEqual([{ id: person.id }]);
    const p = await loggedIn(app, person);
    expect((await p.call('get', '/me')).body.is_system_admin).toBe(true);
  });
});

describe('DELETE /groups/{id}/members/{user_id}', () => {
  it('needs step-up and a reason, removes the member and audits it', async () => {
    const admin = await makeAdmin(db);
    const api = await loggedIn(app, admin);
    const g = await newGroup();
    const m = await makeUser(db, { assigned: true });
    await addDirect(g, m.id);

    const early = await api.call('delete', `/groups/${g}/members/${m.id}?reason=rotation`);
    expect(early.status).toBe(401);
    expect(early.body.code).toBe('step_up_required');
    await api.stepUp(admin.password);

    expect((await api.call('delete', `/groups/${g}/members/${m.id}`)).status).toBe(422); // reason is required
    expect((await api.call('delete', `/groups/${g}/members/${m.id}?reason=no`)).status).toBe(422);
    const res = await api.call('delete', `/groups/${g}/members/${m.id}?reason=rotation`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await db.query('SELECT 1 FROM group_members WHERE group_id = $1', [g])).rowCount).toBe(0);
    const audit = await db.query("SELECT actor_id, reason FROM audit_log WHERE action = 'group_member_removed' AND entity_id = $1", [g]);
    expect(audit.rows[0]).toMatchObject({ actor_id: admin.id, reason: 'rotation' });

    expect((await api.call('delete', `/groups/${g}/members/${m.id}?reason=again`)).status).toBe(404); // no longer a member
    expect((await api.call('delete', `/groups/${randomUUID()}/members/${m.id}?reason=ghost`)).status).toBe(404);
  });

  it('is 403 for a user without groups.edit', async () => {
    const plain = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, plain);
    const g = await newGroup();
    await addDirect(g, plain.id);
    const res = await api.call('delete', `/groups/${g}/members/${plain.id}?reason=leave`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
    expect((await db.query('SELECT 1 FROM group_members WHERE group_id = $1', [g])).rowCount).toBe(1);
  });
});
