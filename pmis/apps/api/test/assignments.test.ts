import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, Api, delegate, grantProfile, loggedIn, makeAdmin, makeProfile, makeRole, makeUser, startApp, superDb, TestUser } from './helpers';

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

const key = (): string => `idem-${randomUUID()}`;
const count = async (sql: string, args: unknown[] = []): Promise<number> => Number((await db.query(sql, args)).rows[0].n);
const pending = (name?: string): Promise<TestUser> => makeUser(db, { assigned: false, name });

interface Setup { profile: string; role: string; admin: TestUser; api: Api }
async function setup(): Promise<Setup> {
  const profile = await makeProfile(db, [['sites', 'view'], ['warehouse', 'view']]);
  const role = await makeRole(db, { profile });
  return { profile, role, ...(await adminApi(app, db)) };
}
const assignBody = (s: Setup, users: TestUser[], extra: Record<string, unknown> = {}) => ({
  user_ids: users.map((u) => u.id),
  role_ids: [s.role],
  defaults: { permission_level: 'entry', region_ids: [1], module_keys: ['sites'], profile_ids: [s.profile], ...extra },
  reason: 'Tripoli site engineers',
});

describe('POST /assignments/bulk-assign', () => {
  it('assigns 12 people in one call under one bulk_action_id and skips the ones who already hold the role (already_assigned)', async () => {
    const s = await setup();
    const people: TestUser[] = [];
    for (let i = 0; i < 12; i++) people.push(await pending(`Site Engineer ${i}`));
    const res = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, people));
    expect(res.status).toBe(200);
    expect(res.body.bulk_action_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toMatchObject({ dry_run: false, skipped: [], failed: [] });
    expect(res.body.done).toHaveLength(12);
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE role_id = $1', [s.role])).toBe(12);
    // one audit row per assignment (written by idm_assign) and one row that carries the bulk_action_id
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'assignment_created' AND after->>'role' = $1", [s.role])).toBe(12);
    const summary = await db.query("SELECT actor_id, after FROM audit_log WHERE entity_type = 'bulk_action' AND entity_id = $1", [res.body.bulk_action_id]);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].actor_id).toBe(s.admin.id);
    expect(summary.rows[0].after).toMatchObject({ done: 12, skipped: 0, failed: 0 });

    // the same role again for 3 of them and for 2 new people: the 3 are skipped, the 2 are created
    const fresh = [await pending(), await pending()];
    const again = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [...people.slice(0, 3), ...fresh]));
    expect(again.status).toBe(200);
    expect(again.body.done).toHaveLength(2);
    expect(again.body.skipped.map((x: { ref: string }) => x.ref).sort()).toEqual(people.slice(0, 3).map((u) => `${u.id}:${s.role}`).sort());
    expect(again.body.skipped.every((x: { code: string }) => x.code === 'already_assigned')).toBe(true);
    expect(again.body.bulk_action_id).not.toBe(res.body.bulk_action_id);
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE role_id = $1', [s.role])).toBe(14);
  });

  it('a dry run returns the same result and writes nothing (no assignment, no audit row, status unchanged)', async () => {
    const s = await setup();
    const people = [await pending(), await pending(), await pending()];
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [people[0]!]));
    const rowsBefore = await count('SELECT count(*) AS n FROM user_role_assignments');
    const auditBefore = await count('SELECT count(*) AS n FROM audit_log');
    const res = await s.api.call('post', '/assignments/bulk-assign', { ...assignBody(s, people), dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.done).toHaveLength(2);
    expect(res.body.skipped).toEqual([expect.objectContaining({ ref: `${people[0]!.id}:${s.role}`, code: 'already_assigned' })]);
    expect(await count('SELECT count(*) AS n FROM user_role_assignments')).toBe(rowsBefore);
    expect(await count('SELECT count(*) AS n FROM audit_log')).toBe(auditBefore);
    const st = await db.query('SELECT status FROM users WHERE id = $1', [people[1]!.id]);
    expect(st.rows[0].status).toBe('pending_assignment');
  });

  it('replays an Idempotency-Key with the first response and refuses the key with another body', async () => {
    const s = await setup();
    const people = [await pending(), await pending()];
    const k = key();
    const first = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, people), { 'Idempotency-Key': k });
    const replay = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, people), { 'Idempotency-Key': k });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE role_id = $1', [s.role])).toBe(2);
    const other = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [people[0]!]), { 'Idempotency-Key': k });
    expect(other.status).toBe(422);
    expect(other.body.errors[0]).toMatchObject({ path: 'Idempotency-Key', code: 'key_reused' });
    expect((await s.api.call('post', '/assignments/bulk-assign', assignBody(s, people), { 'Idempotency-Key': 'x' })).status).toBe(422);
    // without a key the same request is evaluated again (and now skipped as already assigned)
    const noKey = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, people));
    expect(noKey.body.done).toHaveLength(0);
    expect(noKey.body.skipped).toHaveLength(2);
  });

  it('takes regions, modules, team and profile from the role when the request leaves them out', async () => {
    const profile = await makeProfile(db, [['sites', 'view']]);
    const role = await makeRole(db, { profile, regions: [2, 4], modules: ['sites', 'quality'] });
    const { api } = await adminApi(app, db);
    const person = await pending();
    const res = await api.call('post', '/assignments/bulk-assign', { user_ids: [person.id], role_ids: [role], defaults: { permission_level: 'view' }, reason: 'role defaults' });
    expect(res.status).toBe(200);
    expect(res.body.done).toHaveLength(1);
    const list = await api.call('get', `/users/${person.id}/assignments`);
    expect(list.body.items[0]).toMatchObject({ region_ids: [2, 4], module_keys: ['quality', 'sites'], profile_ids: [profile], permission_level: 'view', is_active_now: true, is_primary: true });
    expect(list.body.items[0].role.id).toBe(role);
    expect(list.body.items[0].version).toBeGreaterThan(0);
  });

  it('reports a row without any scope or profile as failed (validation_failed) and unknown people or roles as not_found', async () => {
    const { api } = await adminApi(app, db);
    const bare = await makeRole(db); // no defaults, no profile
    const person = await pending();
    const res = await api.call('post', '/assignments/bulk-assign', {
      user_ids: [person.id, randomUUID()], role_ids: [bare, randomUUID()], defaults: { permission_level: 'view' }, reason: 'no defaults',
    });
    expect(res.status).toBe(200);
    expect(res.body.done).toEqual([]);
    const byRef = Object.fromEntries(res.body.failed.map((f: { ref: string; code: string }) => [f.ref, f.code]));
    expect(byRef[`${person.id}:${bare}`]).toBe('validation_failed');
    expect(Object.values(byRef).filter((c) => c === 'not_found')).toHaveLength(3);
  });

  it('refuses an inactive role per row, a body with unknown keys or modules, a short reason and an empty list (422)', async () => {
    const s = await setup();
    await db.query('UPDATE roles SET is_active = false WHERE id = $1', [s.role]);
    const person = await pending();
    const res = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person]));
    expect(res.body.failed).toEqual([expect.objectContaining({ code: 'validation_failed' })]);
    expect((await s.api.call('post', '/assignments/bulk-assign', { ...assignBody(s, [person]), extra: 1 })).status).toBe(422);
    const mod = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person], { module_keys: ['nonsense'] }));
    expect(mod.status).toBe(422);
    expect(mod.body.errors[0].code).toBe('unknown_module');
    const prof = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person], { profile_ids: [randomUUID()] }));
    expect(prof.status).toBe(422);
    expect((await s.api.call('post', '/assignments/bulk-assign', { ...assignBody(s, [person]), reason: 'x' })).status).toBe(422);
    expect((await s.api.call('post', '/assignments/bulk-assign', { ...assignBody(s, []), user_ids: [] })).status).toBe(422);
    expect((await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person], { valid_from: '2030-01-02T00:00:00Z', valid_to: '2030-01-01T00:00:00Z' }))).status).toBe(422);
  });

  it('refuses more than 2000 rows (users x roles) in one request before anything is written (422 too_many_rows)', async () => {
    const s = await setup();
    const res = await s.api.call('post', '/assignments/bulk-assign', {
      user_ids: Array.from({ length: 500 }, () => randomUUID()), role_ids: Array.from({ length: 5 }, () => randomUUID()),
      defaults: { permission_level: 'view', region_ids: [1], module_keys: ['sites'], profile_ids: [s.profile] }, reason: 'too many',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('too_many_rows');
  });

  it('refuses a caller without the right (403 action_forbidden), without step-up (401) and without a session (401)', async () => {
    const s = await setup();
    const person = await pending();
    const plain = await makeUser(db, { assigned: true });
    await grantProfile(db, plain.id, [['admin.users', 'view']]);
    const plainApi = await loggedIn(app, plain);
    await plainApi.stepUp(plain.password);
    const denied = await plainApi.call('post', '/assignments/bulk-assign', assignBody(s, [person]));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE role_id = $1', [s.role])).toBe(0);

    const admin2 = await makeAdmin(db);
    const noStep = await loggedIn(app, admin2);
    const res = await noStep.call('post', '/assignments/bulk-assign', assignBody(s, [person]));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('step_up_required');
    expect((await new Api(app).call('post', '/assignments/bulk-assign', assignBody(s, [person]))).status).toBe(401);
  });

  it('nobody assigns to themselves: a row for the caller is failed with self_beneficiary, the others go through', async () => {
    const s = await setup();
    const person = await pending();
    const res = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [s.admin, person]));
    expect(res.status).toBe(200);
    expect(res.body.failed).toEqual([expect.objectContaining({ ref: `${s.admin.id}:${s.role}`, code: 'self_beneficiary' })]);
    expect(res.body.done).toHaveLength(1);
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE user_id = $1', [s.admin.id])).toBe(0);
  });

  it('a delegate assigns only inside the delegated regions and never wider than their own rights', async () => {
    const s = await setup();
    const delegateUser = await makeUser(db, {});
    await grantProfile(db, delegateUser.id, [['sites', 'view'], ['warehouse', 'view']]);
    await delegate(db, delegateUser.id, [['assignments', 'create']], [1]);
    const dApi = await loggedIn(app, delegateUser);
    await dApi.stepUp(delegateUser.password);
    const inside = await pending();
    const ok = await dApi.call('post', '/assignments/bulk-assign', assignBody(s, [inside]));
    expect(ok.status).toBe(200);
    expect(ok.body.done).toHaveLength(1);
    // the user stays pending: the delegate holds no users.edit, so the status is left to an admin
    expect((await db.query('SELECT status FROM users WHERE id = $1', [inside.id])).rows[0].status).toBe('pending_assignment');

    const outside = await pending();
    const wrongRegion = await dApi.call('post', '/assignments/bulk-assign', assignBody(s, [outside], { region_ids: [2] }));
    expect(wrongRegion.body.failed).toEqual([expect.objectContaining({ code: 'action_forbidden' })]);
    const everywhere = await dApi.call('post', '/assignments/bulk-assign', assignBody(s, [outside], { region_ids: 'all' }));
    expect(everywhere.body.failed).toEqual([expect.objectContaining({ code: 'action_forbidden' })]);
    const adminLevel = await dApi.call('post', '/assignments/bulk-assign', assignBody(s, [outside], { permission_level: 'admin' }));
    expect(adminLevel.body.failed).toEqual([expect.objectContaining({ code: 'action_forbidden' })]);
    const wide = await makeProfile(db, [['sites', 'view'], ['sites', 'delete']]);
    const tooWide = await dApi.call('post', '/assignments/bulk-assign', assignBody(s, [outside], { profile_ids: [wide] }));
    expect(tooWide.body.failed).toEqual([expect.objectContaining({ code: 'action_forbidden' })]);
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE user_id = $1', [outside.id])).toBe(0);
  });
});

describe('a pending person becomes usable with the first assignment (ADR 0002 section 5, ADR 0003)', () => {
  it('stops being pending at once, and /me shows the grants limited to the assignment regions and modules', async () => {
    const s = await setup();
    const person = await pending();
    const personApi = await loggedIn(app, person);
    const before = await personApi.call('get', '/me');
    expect(before.status).toBe(200);
    expect(before.body.effective).toMatchObject({ grants: [], nav: [] });
    expect((await personApi.call('get', '/regions')).body.code).toBe('pending_assignment');

    const res = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person], { region_ids: [1, 3] }));
    expect(res.body.done).toHaveLength(1);

    // same session, no wait for the 60 s state cache
    const regions = await personApi.call('get', '/regions');
    expect(regions.status).toBe(200);
    const me = await personApi.call('get', '/me');
    expect(me.body.user.status).toBe('active');
    expect(me.body.assignments).toHaveLength(1);
    // the profile grants sites and warehouse view, the assignment is limited to the sites module in regions 1 and 3
    expect(me.body.effective.grants).toEqual([{ module_key: 'sites', action: 'view', region_ids: [1, 3] }]);
    expect(me.body.effective.nav).toContain('sites');
    expect(me.body.effective.nav).not.toContain('warehouse');
    expect(regions.body.items.filter((r: { visible: boolean }) => r.visible).map((r: { id: number }) => r.id)).toEqual([1, 3]);
  });

  it('scopes never cross: sites in Tripoli plus warehouse in Benghazi gives exactly those two', async () => {
    const s = await setup();
    const person = await pending();
    const personApi = await loggedIn(app, person);
    const second = await makeRole(db, { profile: s.profile });
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person], { region_ids: [1], module_keys: ['sites'] }));
    const two = await s.api.call('post', '/assignments/bulk-assign', { ...assignBody(s, [person], { region_ids: [5], module_keys: ['warehouse'] }), role_ids: [second] });
    expect(two.body.done).toHaveLength(1);
    const me = await personApi.call('get', '/me');
    expect(me.body.effective.grants).toEqual([
      { module_key: 'sites', action: 'view', region_ids: [1] },
      { module_key: 'warehouse', action: 'view', region_ids: [5] },
    ]);
    expect(me.body.assignments.filter((a: { is_primary: boolean }) => a.is_primary)).toHaveLength(1);
  });

  it('a person who loses the last assignment is pending again', async () => {
    const s = await setup();
    const person = await pending();
    const personApi = await loggedIn(app, person);
    const res = await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person]));
    expect((await personApi.call('get', '/regions')).status).toBe(200);
    const row = (await s.api.call('get', `/users/${person.id}/assignments`)).body.items[0];
    const end = await s.api.call('post', '/assignments/bulk-end', { items: [{ id: row.id, version: row.version }], reason: 'left the project' });
    expect(end.body.done).toEqual([{ id: res.body.done[0].id }]);
    expect((await personApi.call('get', '/regions')).body.code).toBe('pending_assignment');
  });
});

describe('listing assignments', () => {
  it('GET /users/{id}/assignments: own rows for the person, any person for a holder of admin.users view, 404 for unknown people', async () => {
    const s = await setup();
    const person = await pending();
    const other = await pending();
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person, other]));
    const personApi = await loggedIn(app, person);
    expect((await personApi.call('get', `/users/${person.id}/assignments`)).body.items).toHaveLength(1);
    const denied = await personApi.call('get', `/users/${other.id}/assignments`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('module_forbidden');
    expect((await s.api.call('get', `/users/${other.id}/assignments`)).status).toBe(200);
    expect((await s.api.call('get', `/users/${randomUUID()}/assignments`)).status).toBe(404);
    expect((await s.api.call('get', '/users/not-a-uuid/assignments')).status).toBe(404);
  });

  it('GET /assignments: by role, with paging, include_ended and a permission check', async () => {
    const s = await setup();
    const people = [await pending('Aaa One'), await pending('Aaa Two'), await pending('Aaa Three')];
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, people));
    const page1 = await s.api.call('get', `/assignments?role_id=${s.role}&limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.page).toMatchObject({ limit: 2, total: 3 });
    const page2 = await s.api.call('get', `/assignments?role_id=${s.role}&limit=2&cursor=${encodeURIComponent(page1.body.page.next_cursor)}`);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.page.next_cursor).toBeNull();
    expect([...page1.body.items, ...page2.body.items].map((a: { user: { display_name: string } }) => a.user.display_name)).toEqual(['Aaa One', 'Aaa Three', 'Aaa Two']);
    expect((await s.api.call('get', `/assignments?profile_id=${s.profile}&user_id=${people[0]!.id}`)).body.items).toHaveLength(1);

    const row = page1.body.items[0];
    await s.api.call('post', '/assignments/bulk-end', { items: [{ id: row.id, version: row.version }], reason: 'moved on' });
    expect((await s.api.call('get', `/assignments?role_id=${s.role}`)).body.items).toHaveLength(2);
    expect((await s.api.call('get', `/assignments?role_id=${s.role}&include_ended=true`)).body.items).toHaveLength(3);
    expect((await s.api.call('get', `/users/${row.user.id}/assignments?include_ended=true`)).body.items).toHaveLength(1);
    expect((await s.api.call('get', `/users/${row.user.id}/assignments`)).body.items).toHaveLength(0);
    expect((await s.api.call('get', '/assignments?active_on=2000-01-01')).body.items.filter((a: { role: { id: string } }) => a.role.id === s.role)).toHaveLength(0);
    expect((await s.api.call('get', '/assignments?role_id=nope')).status).toBe(422);
    expect((await s.api.call('get', '/assignments?active_on=yesterday')).status).toBe(422);

    const plain = await makeUser(db, { assigned: true });
    const denied = await (await loggedIn(app, plain)).call('get', '/assignments');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('module_forbidden');
  });
});

describe('POST /assignments/bulk-update', () => {
  it('changes level, regions, modules and end date of several rows; a stale version fails only that row', async () => {
    const s = await setup();
    const people = [await pending(), await pending(), await pending()];
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, people));
    const rows = (await s.api.call('get', `/assignments?role_id=${s.role}`)).body.items as { id: string; version: number }[];
    await s.api.call('post', '/assignments/bulk-update', { items: [{ id: rows[2]!.id, version: rows[2]!.version }], patch: { permission_level: 'review' }, reason: 'first change' });

    const patch = { permission_level: 'approve', region_ids: [2, 6], module_keys: ['sites', 'warehouse'], valid_to: '2031-01-01T00:00:00Z' };
    const res = await s.api.call('post', '/assignments/bulk-update', { items: rows.map((r) => ({ id: r.id, version: r.version })), patch, reason: 'promotion' });
    expect(res.status).toBe(200);
    expect(res.body.done).toHaveLength(2);
    expect(res.body.failed).toEqual([expect.objectContaining({ ref: rows[2]!.id, code: 'precondition_failed' })]);
    const after = (await s.api.call('get', `/users/${people[0]!.id}/assignments`)).body.items[0];
    expect(after).toMatchObject({ permission_level: 'approve', region_ids: [2, 6], module_keys: ['sites', 'warehouse'], valid_to: '2031-01-01T00:00:00.000Z' });
    expect(after.version).not.toBe(rows[0]!.version);

    // dry run: nothing changes
    const dry = await s.api.call('post', '/assignments/bulk-update', { items: [{ id: after.id, version: after.version }], patch: { permission_level: 'view' }, reason: 'preview', dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, done: [{ id: after.id }] });
    expect((await s.api.call('get', `/users/${people[0]!.id}/assignments`)).body.items[0].permission_level).toBe('approve');

    // clearing the end date, 'all' regions, and changing the profile
    const other = await makeProfile(db, [['sites', 'view']]);
    const clear = await s.api.call('post', '/assignments/bulk-update', { items: [{ id: after.id, version: after.version }], patch: { valid_to: null, region_ids: 'all', profile_ids: [other] }, reason: 'open ended' });
    expect(clear.body.done).toHaveLength(1);
    expect((await s.api.call('get', `/users/${people[0]!.id}/assignments`)).body.items[0]).toMatchObject({ valid_to: null, region_ids: 'all', profile_ids: [other] });
  });

  it('validates the patch, the permissions and the rows (404, valid_from, ended rows)', async () => {
    const s = await setup();
    const person = await pending();
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person]));
    const row = (await s.api.call('get', `/users/${person.id}/assignments`)).body.items[0];
    const ref = [{ id: row.id, version: row.version }];
    expect((await s.api.call('post', '/assignments/bulk-update', { items: ref, patch: {}, reason: 'empty' })).status).toBe(422);
    expect((await s.api.call('post', '/assignments/bulk-update', { items: ref, patch: { module_keys: ['nope'] }, reason: 'bad module' })).status).toBe(422);
    expect((await s.api.call('post', '/assignments/bulk-update', { items: ref, patch: { permission_level: 'god' }, reason: 'bad level' })).status).toBe(422);
    const missing = await s.api.call('post', '/assignments/bulk-update', { items: [{ id: randomUUID(), version: 1 }], patch: { team: 'cw' }, reason: 'unknown row' });
    expect(missing.body.failed).toEqual([expect.objectContaining({ code: 'not_found' })]);
    const from = await s.api.call('post', '/assignments/bulk-update', { items: ref, patch: { valid_from: '2031-01-01T00:00:00Z' }, reason: 'move start' });
    expect(from.body.failed).toEqual([expect.objectContaining({ code: 'validation_failed' })]);

    const plain = await makeUser(db, { assigned: true });
    await grantProfile(db, plain.id, [['admin.users', 'view']]);
    const plainApi = await loggedIn(app, plain);
    await plainApi.stepUp(plain.password);
    const denied = await plainApi.call('post', '/assignments/bulk-update', { items: ref, patch: { team: 'te' }, reason: 'not allowed' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');

    // the caller's own row is not theirs to edit
    const own = await db.query("INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, 'view', true, true) RETURNING id", [s.admin.id, s.role]);
    const ownRow = (await s.api.call('get', `/users/${s.admin.id}/assignments`)).body.items.find((a: { id: string }) => a.id === own.rows[0].id);
    const self = await s.api.call('post', '/assignments/bulk-update', { items: [{ id: ownRow.id, version: ownRow.version }], patch: { permission_level: 'admin' }, reason: 'grant myself' });
    expect(self.body.failed).toEqual([expect.objectContaining({ code: 'self_beneficiary' })]);
  });
});

describe('POST /assignments/bulk-end', () => {
  it('ends rows (history kept), skips a row that already ended, supports a future end date and a dry run', async () => {
    const s = await setup();
    const people = [await pending(), await pending(), await pending()];
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, people));
    const rows = (await s.api.call('get', `/assignments?role_id=${s.role}`)).body.items as { id: string; version: number; user: { id: string } }[];
    const items = rows.map((r) => ({ id: r.id, version: r.version }));

    const dry = await s.api.call('post', '/assignments/bulk-end', { items, reason: 'preview', dry_run: true });
    expect(dry.body.done).toHaveLength(3);
    expect((await s.api.call('get', `/assignments?role_id=${s.role}`)).body.items).toHaveLength(3);

    const res = await s.api.call('post', '/assignments/bulk-end', { items: items.slice(0, 2), reason: 'project phase over' });
    expect(res.status).toBe(200);
    expect(res.body.done).toHaveLength(2);
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE role_id = $1', [s.role])).toBe(3); // never deleted
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'assignment_ended' AND entity_id = ANY($1)", [[rows[0]!.id, rows[1]!.id]])).toBe(2);
    expect((await db.query('SELECT is_primary FROM user_role_assignments WHERE id = $1', [rows[0]!.id])).rows[0].is_primary).toBe(false);

    const again = await s.api.call('post', '/assignments/bulk-end', { items: items.slice(0, 2), reason: 'twice' });
    expect(again.body.done).toEqual([]);
    expect(again.body.skipped.map((x: { code: string }) => x.code)).toEqual(['invalid_transition', 'invalid_transition']);

    const later = new Date(Date.now() + 30 * 86400_000).toISOString();
    const future = await s.api.call('post', '/assignments/bulk-end', { items: [items[2]!], valid_to: later, reason: 'ends next month' });
    expect(future.body.done).toHaveLength(1);
    const row = (await s.api.call('get', `/users/${rows[2]!.user.id}/assignments`)).body.items[0];
    expect(row.valid_to).toBe(later);
    expect(row.is_active_now).toBe(true);
  });

  it('refuses a caller without assignments.delete (403) and a stale version (precondition_failed)', async () => {
    const s = await setup();
    const person = await pending();
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [person]));
    const row = (await s.api.call('get', `/users/${person.id}/assignments`)).body.items[0];
    const editor = await makeUser(db, { assigned: true });
    await delegate(db, editor.id, [['assignments', 'edit']]);
    const editorApi = await loggedIn(app, editor);
    await editorApi.stepUp(editor.password);
    const denied = await editorApi.call('post', '/assignments/bulk-end', { items: [{ id: row.id, version: row.version }], reason: 'no right to delete' });
    expect(denied.status).toBe(403);
    const stale = await s.api.call('post', '/assignments/bulk-end', { items: [{ id: row.id, version: row.version + 1 }], reason: 'stale' });
    expect(stale.body.failed).toEqual([expect.objectContaining({ code: 'precondition_failed' })]);
    expect((await s.api.call('get', `/users/${person.id}/assignments`)).body.items).toHaveLength(1);
  });
});

describe('POST /assignments/copy', () => {
  async function source(s: Setup) {
    const from = await makeUser(db, { assigned: false });
    const second = await makeRole(db, { profile: s.profile });
    await s.api.call('post', '/assignments/bulk-assign', assignBody(s, [from], { region_ids: [1, 3], module_keys: ['sites'] }));
    await s.api.call('post', '/assignments/bulk-assign', { ...assignBody(s, [from], { region_ids: [5], module_keys: ['warehouse'], permission_level: 'review' }), role_ids: [second] });
    return { from, second };
  }

  it('previews by default, then copies the active rows (scope, level and profiles) to several people', async () => {
    const s = await setup();
    const { from, second } = await source(s);
    const targets = [await pending(), await pending()];
    const body = { from_user_id: from.id, to_user_ids: targets.map((t) => t.id), mode: 'add', reason: 'same team' };
    const preview = await s.api.call('post', '/assignments/copy', body);
    expect(preview.status).toBe(200);
    expect(preview.body.dry_run).toBe(true);
    expect(preview.body.done).toHaveLength(4);
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE user_id = ANY($1)', [targets.map((t) => t.id)])).toBe(0);

    const real = await s.api.call('post', '/assignments/copy', { ...body, dry_run: false });
    expect(real.body.dry_run).toBe(false);
    expect(real.body.done).toHaveLength(4);
    const rows = (await s.api.call('get', `/users/${targets[0]!.id}/assignments`)).body.items as { role: { id: string }; region_ids: number[]; module_keys: string[]; permission_level: string; profile_ids: string[] }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.role.id === s.role)).toMatchObject({ region_ids: [1, 3], module_keys: ['sites'], permission_level: 'entry', profile_ids: [s.profile] });
    expect(rows.find((r) => r.role.id === second)).toMatchObject({ region_ids: [5], module_keys: ['warehouse'], permission_level: 'review' });
    // the targets are no longer pending
    expect((await db.query('SELECT status FROM users WHERE id = $1', [targets[1]!.id])).rows[0].status).toBe('active');

    // add again: everything is already assigned
    const twice = await s.api.call('post', '/assignments/copy', { ...body, dry_run: false });
    expect(twice.body.done).toEqual([]);
    expect(twice.body.skipped).toHaveLength(4);
    expect(twice.body.skipped[0].code).toBe('already_assigned');
  });

  it('replace ends the current rows of the target first', async () => {
    const s = await setup();
    const { from, second } = await source(s);
    const target = await pending();
    const old = await makeRole(db, { profile: s.profile });
    await s.api.call('post', '/assignments/bulk-assign', { ...assignBody(s, [target]), role_ids: [old] });
    const res = await s.api.call('post', '/assignments/copy', { from_user_id: from.id, to_user_ids: [target.id], mode: 'replace', reason: 'takes over', dry_run: false });
    expect(res.body.done).toHaveLength(2);
    const active = (await s.api.call('get', `/users/${target.id}/assignments`)).body.items as { role: { id: string } }[];
    expect(active.map((a) => a.role.id).sort()).toEqual([s.role, second].sort());
    const all = (await s.api.call('get', `/users/${target.id}/assignments?include_ended=true`)).body.items;
    expect(all).toHaveLength(3);
    expect(all.find((a: { role: { id: string } }) => a.role.id === old).is_active_now).toBe(false);
  });

  it('refuses copying to the caller (403 self_beneficiary, also as a preview), unknown people, the wrong body and a caller without the right', async () => {
    const s = await setup();
    const { from } = await source(s);
    const target = await pending();
    for (const dry_run of [true, false]) {
      const self = await s.api.call('post', '/assignments/copy', { from_user_id: from.id, to_user_ids: [target.id, s.admin.id], mode: 'add', reason: 'sneaky', dry_run });
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('self_beneficiary');
    }
    expect(await count('SELECT count(*) AS n FROM user_role_assignments WHERE user_id = ANY($1)', [[target.id, s.admin.id]])).toBe(0);
    expect((await s.api.call('post', '/assignments/copy', { from_user_id: randomUUID(), to_user_ids: [target.id], mode: 'add', reason: 'ghost' })).status).toBe(404);
    const ghost = await s.api.call('post', '/assignments/copy', { from_user_id: from.id, to_user_ids: [randomUUID()], mode: 'add', reason: 'ghost' });
    expect(ghost.body.failed).toEqual([expect.objectContaining({ code: 'not_found' })]);
    expect((await s.api.call('post', '/assignments/copy', { from_user_id: from.id, to_user_ids: [target.id], mode: 'merge', reason: 'bad mode' })).status).toBe(422);

    const plain = await makeUser(db, { assigned: true });
    const plainApi = await loggedIn(app, plain);
    await plainApi.stepUp(plain.password);
    const denied = await plainApi.call('post', '/assignments/copy', { from_user_id: from.id, to_user_ids: [target.id], mode: 'add', reason: 'not allowed' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');

    // assignments.create alone does not let a delegate read (and copy) someone else's assignments
    const blind = await makeUser(db, {});
    await delegate(db, blind.id, [['assignments', 'create']]);
    const blindApi = await loggedIn(app, blind);
    await blindApi.stepUp(blind.password);
    const noView = await blindApi.call('post', '/assignments/copy', { from_user_id: from.id, to_user_ids: [target.id], mode: 'add', reason: 'no view', dry_run: true });
    expect(noView.status).toBe(403);
  });
});
