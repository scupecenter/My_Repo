import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapDbError } from '../src/common/db-errors';
import { adminApi, Api, grantProfile, loggedIn, makeProfile, makeRole, makeUser, startApp, superDb, TestUser } from './helpers';

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

const inDays = (n: number): string => new Date(Date.now() + n * 86400_000).toISOString();
const ago = (): string => new Date(Date.now() - 60_000).toISOString();

/** An active person with an assignment (not pending) who has passed step-up. */
async function person(grants: [string, string][] = []): Promise<{ user: TestUser; api: Api }> {
  const user = await makeUser(db, { assigned: true });
  if (grants.length > 0) await grantProfile(db, user.id, grants);
  const api = await loggedIn(app, user);
  await api.stepUp(user.password);
  return { user, api };
}

describe('POST /delegations', () => {
  it('a System Admin delegates partial rights to a person for chosen regions; the delegate gets them in /me', async () => {
    const { api } = await adminApi(app, db);
    const { user: to, api: toApi } = await person();
    const res = await api.call('post', '/delegations', {
      to_user_id: to.id, scope: 'partial', rights: ['users.edit', 'groups.edit'], region_codes: [1, 3], valid_from: ago(), valid_to: inDays(30), reason: 'Covers the Tripoli desk',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      target_kind: 'user', scope: 'partial', region_codes: [1, 3], module_codes: [], allow_redelegate: false, state: 'active', reason: 'Covers the Tripoli desk', revoked_at: null,
      to_user: { id: to.id }, target: { kind: 'user', id: to.id, label: to.name },
    });
    expect(res.body.rights.sort()).toEqual(['groups.edit', 'users.edit']);
    expect(res.body.from_user.display_name).toMatch(/Test Admin/);
    expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'delegation_created' AND entity_id = $1", [res.body.id]).then((r) => r.rowCount)).toBe(1);

    const me = await toApi.call('get', '/me');
    expect(me.body.effective.grants).toEqual(expect.arrayContaining([
      { module_key: 'users', action: 'edit', region_ids: [1, 3] },
      { module_key: 'groups', action: 'edit', region_ids: [1, 3] },
    ]));
  });

  it('delegates to a role and to a group; every holder of the role or member of the group gets the rights', async () => {
    const { api } = await adminApi(app, db);
    const role = await makeRole(db);
    const holder = await makeUser(db, { assigned: true });
    await db.query("INSERT INTO user_role_assignments (user_id, role_id, all_regions, all_modules) VALUES ($1, $2, true, true)", [holder.id, role]);
    const holderApi = await loggedIn(app, holder);
    const byRole = await api.call('post', '/delegations', { target_kind: 'role', target_id: role, scope: 'full', valid_from: ago(), reason: 'The role runs the desk' });
    expect(byRole.status).toBe(201);
    expect(byRole.body).toMatchObject({ target_kind: 'role', to_user: null, scope: 'full', rights: [], region_codes: [], target: { kind: 'role', id: role } });
    expect((await holderApi.call('get', '/me')).body.effective.grants).toEqual(expect.arrayContaining([{ module_key: '*', action: 'edit', region_ids: 'all' }]));

    const group = await db.query("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`Desk ${randomUUID().slice(0, 6)}`]);
    const member = await person();
    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [group.rows[0].id, member.user.id]);
    const byGroup = await api.call('post', '/delegations', { target_kind: 'group', target_id: group.rows[0].id, scope: 'partial', rights: ['matrix.edit'], valid_from: ago(), reason: 'Group covers the matrix' });
    expect(byGroup.status).toBe(201);
    expect(byGroup.body).toMatchObject({ target_kind: 'group', rights: ['matrix.edit'], target: { kind: 'group', id: group.rows[0].id } });
    expect((await member.api.call('get', '/me')).body.effective.grants).toEqual(expect.arrayContaining([{ module_key: 'matrix', action: 'edit', region_ids: 'all' }]));
  });

  it('validates the body: one target, rights for partial, dates, module limits, regions, unknown targets (422)', async () => {
    const { admin, api } = await adminApi(app, db);
    const { user: to } = await person();
    const ok = { scope: 'partial', rights: ['users.edit'], valid_from: ago(), reason: 'validation run' };
    const cases: [string, Record<string, unknown>, string][] = [
      ['no target', { ...ok }, '/'],
      ['two targets', { ...ok, to_user_id: to.id, target_kind: 'user', target_id: to.id }, '/'],
      ['kind without id', { ...ok, target_kind: 'role' }, '/target_id'],
      ['partial without rights', { scope: 'partial', valid_from: ago(), reason: 'no rights', to_user_id: to.id }, '/rights'],
      ['full with rights', { ...ok, scope: 'full', to_user_id: to.id }, '/rights'],
      ['end before start', { ...ok, to_user_id: to.id, valid_to: inDays(-1) }, '/valid_to'],
      ['module limit', { ...ok, to_user_id: to.id, module_codes: ['sites'] }, '/module_codes'],
      ['unknown right', { ...ok, to_user_id: to.id, rights: ['fly'] }, '/rights/0'],
      ['unknown user', { ...ok, to_user_id: randomUUID() }, '/to_user_id'],
      ['unknown role', { ...ok, target_kind: 'role', target_id: randomUUID() }, '/target_id'],
    ];
    for (const [name, body, path] of cases) {
      const r = await api.call('post', '/delegations', body);
      expect(r.status, name).toBe(422);
      expect(r.body.errors.map((e: { path: string }) => e.path), name).toContain(path);
    }
    expect((await api.call('post', '/delegations', { ...ok, to_user_id: to.id, region_codes: [9] })).status).toBe(422);
    expect((await api.call('post', '/delegations', { ...ok, to_user_id: to.id, reason: 'no' })).status).toBe(422);
    expect(await db.query('SELECT 1 FROM delegations WHERE from_user_id = $1', [admin.id]).then((r) => r.rowCount)).toBe(0);
  });

  it('refuses delegating to yourself (403 self_beneficiary), also through a group you belong to', async () => {
    const { admin, api } = await adminApi(app, db);
    const self = await api.call('post', '/delegations', { to_user_id: admin.id, scope: 'full', valid_from: ago(), reason: 'grant myself everything' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');
    const group = await db.query("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`Mine ${randomUUID().slice(0, 6)}`]);
    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [group.rows[0].id, admin.id]);
    const viaGroup = await api.call('post', '/delegations', { target_kind: 'group', target_id: group.rows[0].id, scope: 'full', valid_from: ago(), reason: 'through my group' });
    expect(viaGroup.status).toBe(403);
    expect(viaGroup.body.code).toBe('self_beneficiary');
    expect(await db.query('SELECT 1 FROM delegations WHERE from_user_id = $1', [admin.id]).then((r) => r.rowCount)).toBe(0);
  });

  it('a delegate cannot delegate (403 delegate_forbidden); a person without any right gets 403 action_forbidden; step-up is needed', async () => {
    const { api } = await adminApi(app, db);
    const { user: target } = await person();
    const delegateUser = await makeUser(db, { assigned: true });
    const created = await api.call('post', '/delegations', { to_user_id: delegateUser.id, scope: 'partial', rights: ['users.edit', 'assignments.edit'], valid_from: ago(), reason: 'plain delegate' });
    expect(created.status).toBe(201);
    const dApi = await loggedIn(app, delegateUser);
    await dApi.stepUp(delegateUser.password);
    const body = { to_user_id: target.id, scope: 'partial', rights: ['users.edit'], valid_from: ago(), reason: 'passing it on' };
    const refused = await dApi.call('post', '/delegations', body);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('delegate_forbidden');

    const nobody = await person();
    const denied = await nobody.api.call('post', '/delegations', body);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');
    expect(await db.query('SELECT 1 FROM delegations WHERE target_user_id = $1', [target.id]).then((r) => r.rowCount)).toBe(0);

    const second = await adminApi(app, db);
    const noStep = await loggedIn(app, second.admin);
    const res = await noStep.call('post', '/delegations', body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('step_up_required');
    expect((await new Api(app).call('post', '/delegations', body)).status).toBe(401);
  });

  it('a delegate may pass on only what the admin allowed (allow_redelegate), never wider and never longer', async () => {
    const { api } = await adminApi(app, db);
    const middle = await makeUser(db, { assigned: true });
    const grant = await api.call('post', '/delegations', {
      to_user_id: middle.id, scope: 'partial', rights: ['users.edit'], region_codes: [1], valid_from: ago(), valid_to: inDays(10), allow_redelegate: true, reason: 'may pass on users.edit',
    });
    expect(grant.body.allow_redelegate).toBe(true);
    const mApi = await loggedIn(app, middle);
    await mApi.stepUp(middle.password);
    const { user: end } = await person();
    const base = { to_user_id: end.id, scope: 'partial', rights: ['users.edit'], region_codes: [1], valid_from: ago(), valid_to: inDays(5), reason: 'passing it on' };
    const ok = await mApi.call('post', '/delegations', base);
    expect(ok.status).toBe(201);
    expect(ok.body.from_user.id).toBe(middle.id);
    for (const wider of [{ rights: ['users.edit', 'groups.edit'] }, { scope: 'full', rights: undefined }, { region_codes: [1, 2] }, { region_codes: [] }, { valid_to: inDays(40) }, { valid_to: null }]) {
      const r = await mApi.call('post', '/delegations', { ...base, ...wider });
      expect(r.status, JSON.stringify(wider)).toBe(403);
    }
    // the person who made the delegation revokes it; revoking the parent ends the chain
    const own = await mApi.call('post', `/delegations/${ok.body.id}/revoke`, { reason: 'changed my mind' });
    expect(own.status).toBe(200);
    expect(own.body.state).toBe('revoked');
  });
});

describe('GET /delegations', () => {
  it('lists by state (active by default), with paging, newest first; a holder of admin.delegation view may read', async () => {
    const { api } = await adminApi(app, db);
    const people = [await person(), await person(), await person(), await person()];
    const make = (i: number, extra: Record<string, unknown>) => api.call('post', '/delegations', {
      to_user_id: people[i]!.user.id, scope: 'partial', rights: ['reassign'], valid_from: ago(), reason: `listing ${i}`, ...extra,
    });
    const active = await make(0, {});
    const scheduled = await make(1, { valid_from: inDays(5) });
    const expired = await make(2, { valid_from: inDays(-10), valid_to: inDays(-5) });
    const revoked = await make(3, {});
    await api.call('post', `/delegations/${revoked.body.id}/revoke`, { reason: 'not needed any more' });
    expect([active, scheduled, expired, revoked].map((r) => r.body.state)).toEqual(['active', 'scheduled', 'expired', 'active']);

    const ids = async (state?: string, extra = ''): Promise<string[]> => {
      const r = await api.call('get', `/delegations?${state ? `state=${state}&` : ''}limit=200${extra}`);
      expect(r.status).toBe(200);
      return r.body.items.map((d: { id: string }) => d.id);
    };
    const mine = [active, scheduled, expired, revoked].map((r) => r.body.id as string);
    const only = async (state?: string): Promise<string[]> => (await ids(state)).filter((id) => mine.includes(id));
    expect(await only()).toEqual([active.body.id]);
    expect(await only('active')).toEqual([active.body.id]);
    expect(await only('scheduled')).toEqual([scheduled.body.id]);
    expect(await only('expired')).toEqual([expired.body.id]);
    expect(await only('revoked')).toEqual([revoked.body.id]);
    expect((await only('all')).sort()).toEqual([...mine].sort());
    expect((await api.call('get', '/delegations?state=bogus')).status).toBe(422);
    const rev = (await api.call('get', '/delegations?state=revoked&limit=200')).body.items.find((d: { id: string }) => d.id === revoked.body.id);
    expect(rev).toMatchObject({ state: 'revoked', reason: 'listing 3' });
    expect(rev.revoked_by.id).toBeTruthy();
    expect(rev.revoked_at).toBeTruthy();

    const p1 = await api.call('get', '/delegations?state=all&limit=2');
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.page.next_cursor).toBeTruthy();
    const p2 = await api.call('get', `/delegations?state=all&limit=2&cursor=${encodeURIComponent(p1.body.page.next_cursor)}`);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    expect(p2.body.items.map((d: { id: string }) => d.id)).not.toEqual(expect.arrayContaining(p1.body.items.map((d: { id: string }) => d.id)));

    const viewer = await person([['admin.delegation', 'view']]);
    expect((await viewer.api.call('get', '/delegations')).status).toBe(200);
    const nobody = await person([['sites', 'view']]);
    const denied = await nobody.api.call('get', '/delegations');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('module_forbidden');
  });
});

describe('POST /delegations/{id}/revoke', () => {
  it('revokes, stops the rights at once, audits it, and refuses a second revoke (409) and unknown ids (404)', async () => {
    const { api } = await adminApi(app, db);
    const { user: to, api: toApi } = await person();
    const d = await api.call('post', '/delegations', { to_user_id: to.id, scope: 'full', valid_from: ago(), reason: 'temporary cover' });
    expect((await toApi.call('get', '/me')).body.effective.grants.length).toBeGreaterThan(0);
    const res = await api.call('post', `/delegations/${d.body.id}/revoke`, { reason: 'back from leave' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: d.body.id, state: 'revoked' });
    expect((await toApi.call('get', '/me')).body.effective.grants).toEqual([]);
    expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'delegation_revoked' AND entity_id = $1", [d.body.id]).then((r) => r.rowCount)).toBe(1);
    const again = await api.call('post', `/delegations/${d.body.id}/revoke`, { reason: 'twice' });
    expect(again.status).toBe(409);
    expect((await api.call('post', `/delegations/${randomUUID()}/revoke`, { reason: 'unknown id' })).status).toBe(404);
    expect((await api.call('post', '/delegations/nope/revoke', { reason: 'unknown id' })).status).toBe(404);
    expect((await api.call('post', `/delegations/${d.body.id}/revoke`, { reason: 'x' })).status).toBe(422);
  });

  it('only a System Admin or the delegator revokes; another delegate and a plain user get 403; step-up is needed', async () => {
    const { api } = await adminApi(app, db);
    const delegateUser = await makeUser(db, { assigned: true });
    const other = await makeUser(db, { assigned: true });
    await api.call('post', '/delegations', { to_user_id: other.id, scope: 'partial', rights: ['users.edit'], valid_from: ago(), reason: 'another delegate' });
    const d = await api.call('post', '/delegations', { to_user_id: delegateUser.id, scope: 'partial', rights: ['users.edit'], valid_from: ago(), reason: 'the delegation' });
    const otherApi = await loggedIn(app, other);
    await otherApi.stepUp(other.password);
    const denied = await otherApi.call('post', `/delegations/${d.body.id}/revoke`, { reason: 'not mine' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('delegate_forbidden');
    const nobody = await person();
    expect((await nobody.api.call('post', `/delegations/${d.body.id}/revoke`, { reason: 'not mine' })).body.code).toBe('action_forbidden');
    const second = await adminApi(app, db);
    const noStep = await loggedIn(app, second.admin);
    expect((await noStep.call('post', `/delegations/${d.body.id}/revoke`, { reason: 'no step-up' })).body.code).toBe('step_up_required');
    expect((await api.call('get', '/delegations?limit=200')).body.items.find((x: { id: string }) => x.id === d.body.id).state).toBe('active');
  });
});

describe('delegated rights in use, and the last System Admin', () => {
  it('a delegate with assignments.create assigns for the delegated region and the action is audited on behalf of the delegating admin', async () => {
    const { admin, api } = await adminApi(app, db);
    const profile = await makeProfile(db, [['sites', 'view']]);
    const role = await makeRole(db, { profile });
    const delegateUser = await makeUser(db, { assigned: true });
    await grantProfile(db, delegateUser.id, [['sites', 'view']]);
    const d = await api.call('post', '/delegations', { to_user_id: delegateUser.id, scope: 'partial', rights: ['assignments.edit'], region_codes: [1], valid_from: ago(), reason: 'Tripoli desk' });
    expect(d.status).toBe(201);
    const dApi = await loggedIn(app, delegateUser);
    await dApi.stepUp(delegateUser.password);
    const target = await makeUser(db, { assigned: false });
    const body = { user_ids: [target.id], role_ids: [role], defaults: { permission_level: 'entry', region_ids: [1], module_keys: ['sites'] }, reason: 'delegated assignment' };
    const res = await dApi.call('post', '/assignments/bulk-assign', body);
    expect(res.body.done).toHaveLength(1);
    const audit = await db.query("SELECT actor_id, on_behalf_of FROM audit_log WHERE action = 'assignment_created' AND entity_id = $1", [res.body.done[0].id]);
    expect(audit.rows[0]).toMatchObject({ actor_id: delegateUser.id, on_behalf_of: admin.id });
    const bulk = await db.query("SELECT on_behalf_of FROM audit_log WHERE entity_type = 'bulk_action' AND entity_id = $1", [res.body.bulk_action_id]);
    expect(bulk.rows[0].on_behalf_of).toBe(admin.id);
    // after the revoke the same call is refused
    await api.call('post', `/delegations/${d.body.id}/revoke`, { reason: 'desk closed' });
    const late = await dApi.call('post', '/assignments/bulk-assign', { ...body, user_ids: [(await makeUser(db, { assigned: false })).id] });
    expect(late.status).toBe(403);
  });

  it('maps the database refusal to remove the last active System Admin to 409 last_admin', async () => {
    const { Prisma } = await import('@prisma/client');
    const err = new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code: '23514', message: 'at least one active System Admin must remain' } });
    const p = mapDbError(err);
    expect(p?.getStatus()).toBe(409);
    expect(p?.code).toBe('last_admin');
    const inUse = mapDbError(new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code: '23514', message: 'role X is assigned or referenced: deactivate it instead of deleting' } }));
    expect(inUse?.code).toBe('role_in_use');
    const redelegate = mapDbError(new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code: '42501', message: 'only a System Admin can create a delegation' } }));
    expect(redelegate?.code).toBe('delegate_forbidden');
    const ceiling = mapDbError(new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code: '42501', message: 'module quality is outside your own scope' } }));
    expect(ceiling?.code).toBe('action_forbidden');
  });
});
