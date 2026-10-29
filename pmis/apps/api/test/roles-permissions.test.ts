import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as Pg } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, Api, assign, delegate, grantProfile, loggedIn, makeProfile, makeRole, makeUser, startApp, superDb } from './helpers';

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

const uid = (): string => randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
const ifMatch = (etag: string): Record<string, string> => ({ 'If-Match': etag });

async function signedIn(grants: [string, string][], delegations: [string, string][] = []): Promise<Api> {
  const u = await makeUser(db, { assigned: false });
  if (grants.length > 0) await grantProfile(db, u.id, grants);
  else await assign(db, u.id);
  await db.query("UPDATE users SET status = 'active' WHERE id = $1", [u.id]);
  if (delegations.length > 0) await delegate(db, u.id, delegations);
  const api = await loggedIn(app, u);
  await api.stepUp(u.password);
  return api;
}

describe('GET /regions', () => {
  it('lists the 7 regions with the contract codes; visible follows the regions of the caller', async () => {
    const { api } = await adminApi(app, db);
    const res = await api.call('get', '/regions');
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: number; code: string }) => [r.id, r.code])).toEqual([
      [1, 'Tripoli'], [2, 'Middle'], [3, 'WM'], [4, 'Zawia'], [5, 'Benghazi'], [6, 'GM'], [7, 'Sebha'],
    ]);
    expect(res.body.items.every((r: { visible: boolean; name_en: string }) => r.visible && r.name_en.length > 0)).toBe(true);

    const person = await makeUser(db, { assigned: false });
    const role = await makeRole(db);
    await db.query(`WITH a AS (INSERT INTO user_role_assignments (user_id, role_id, all_modules) VALUES ($1, $2, true) RETURNING id)
      INSERT INTO user_role_assignment_regions SELECT a.id, r FROM a, unnest(ARRAY[5, 7]) r`, [person.id, role]);
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [person.id]);
    const limited = await (await loggedIn(app, person)).call('get', '/regions');
    expect(limited.body.items.filter((r: { visible: boolean }) => r.visible).map((r: { code: string }) => r.code)).toEqual(['Benghazi', 'Sebha']);
    expect(limited.body.items).toHaveLength(7);
  });

  it('needs a session, and an account that is not pending', async () => {
    expect((await new Api(app).call('get', '/regions')).status).toBe(401);
    const pendingApi = await loggedIn(app, await makeUser(db, { assigned: false }));
    expect((await pendingApi.call('get', '/regions')).body.code).toBe('pending_assignment');
  });
});

describe('roles', () => {
  it('creates a role with name, duties, default profile, regions and modules; reads it back with an ETag', async () => {
    const { api } = await adminApi(app, db);
    const profile = await makeProfile(db, [['sites', 'view']]);
    const code = `MGMT_${uid()}`;
    const res = await api.call('post', '/roles', {
      code, name_en: 'Management', name_ar: 'الإدارة', description_en: 'Reads the dashboard and the progress reports.',
      default_profile_id: profile, default_region_ids: 'all', default_module_keys: ['dashboard', 'reports'], can_hold_matrix_levels: false, reason: 'Management role',
    });
    expect(res.status).toBe(201);
    expect(res.headers['etag']).toBe(`"${res.body.version}"`);
    expect(res.body).toMatchObject({
      code, name_en: 'Management', name_ar: 'الإدارة', default_profile_id: profile, default_region_ids: 'all', default_module_keys: ['dashboard', 'reports'],
      can_hold_matrix_levels: false, is_active: true, active_assignment_count: 0, sub_roles: [], parent_role_id: null,
    });
    const get = await api.call('get', `/roles/${res.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body).toEqual(res.body);
    expect(get.headers['etag']).toBe(res.headers['etag']);
    expect((await api.call('get', `/roles/${randomUUID()}`)).status).toBe(404);
    expect((await api.call('get', '/roles/nope')).status).toBe(404);
    expect((await new Api(app).call('get', '/roles')).status).toBe(401);
    expect((await new Api(app).call('get', `/roles/${res.body.id}`)).status).toBe(401);
    // any signed-in person may read roles (the pickers need them)
    const reader = await signedIn([]);
    expect((await reader.call('get', `/roles/${res.body.id}`)).status).toBe(200);
  });

  it('makes a sub-role under a main role and lists main roles with their sub-roles', async () => {
    const { api } = await adminApi(app, db);
    const main = await api.call('post', '/roles', { code: `LEAD_${uid()}`, name_en: 'Team Lead', can_hold_matrix_levels: true, reason: 'main role', default_region_ids: [1], default_module_keys: 'all' });
    const sub = await api.call('post', '/roles', { code: `ENG_${uid()}`, name_en: 'Site Engineer', parent_role_id: main.body.id, can_hold_matrix_levels: true, reason: 'sub-role' });
    expect(sub.status).toBe(201);
    expect(sub.body.parent_role_id).toBe(main.body.id);
    expect(main.body).toMatchObject({ default_region_ids: [1], default_module_keys: 'all' });
    const list = await api.call('get', '/roles');
    const items = list.body.items as { id: string; sub_roles: { id: string }[] }[];
    const iMain = items.findIndex((r) => r.id === main.body.id);
    expect(items[iMain]!.sub_roles.map((r) => r.id)).toEqual([sub.body.id]);
    expect(items[iMain + 1]!.id).toBe(sub.body.id); // the sub-role follows its parent

    const deeper = await api.call('post', '/roles', { code: `X_${uid()}`, name_en: 'Too deep', parent_role_id: sub.body.id, can_hold_matrix_levels: true, reason: 'three levels' });
    expect(deeper.status).toBe(422);
    expect(deeper.body.errors[0].path).toBe('/parent_role_id');
    expect((await api.call('post', '/roles', { code: `X_${uid()}`, name_en: 'Orphan', parent_role_id: randomUUID(), can_hold_matrix_levels: true, reason: 'no parent' })).status).toBe(422);
  });

  it('renames a role and changes its defaults with If-Match (428 without, 412 when stale); the code is kept', async () => {
    const { api } = await adminApi(app, db);
    const created = await api.call('post', '/roles', { code: `REN_${uid()}`, name_en: 'Old name', description_en: 'Duties', can_hold_matrix_levels: true, reason: 'new role', default_region_ids: [1, 2], default_module_keys: ['sites'] });
    const etag = created.headers['etag']!;
    expect((await api.call('patch', `/roles/${created.body.id}`, { name_en: 'New name', reason: 'rename' })).status).toBe(428);
    const done = await api.call('patch', `/roles/${created.body.id}`, { name_en: 'New name', name_ar: 'اسم جديد', default_module_keys: ['sites', 'quality'], reason: 'rename' }, ifMatch(etag));
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ code: created.body.code, name_en: 'New name', name_ar: 'اسم جديد', description_en: 'Duties', default_region_ids: [1, 2], default_module_keys: ['quality', 'sites'] });
    expect(done.body.version).not.toBe(created.body.version);
    expect((await api.call('patch', `/roles/${created.body.id}`, { name_en: 'Third', reason: 'stale' }, ifMatch(etag))).status).toBe(412);
    // switching a default to "all", and back to a list
    const all = await api.call('patch', `/roles/${created.body.id}`, { default_region_ids: 'all', reason: 'everywhere' }, ifMatch(done.headers['etag']!));
    expect(all.body).toMatchObject({ default_region_ids: 'all', default_module_keys: ['quality', 'sites'] });
    const back = await api.call('patch', `/roles/${created.body.id}`, { default_region_ids: [3], reason: 'only WM' }, ifMatch(all.headers['etag']!));
    expect(back.body.default_region_ids).toEqual([3]);
    const audit = await db.query("SELECT count(*) AS n FROM audit_log WHERE entity_type = 'role' AND entity_id = $1", [created.body.id]);
    expect(Number(audit.rows[0].n)).toBeGreaterThanOrEqual(5);
    expect((await api.call('patch', `/roles/${created.body.id}`, { reason: 'nothing to change' }, ifMatch(back.headers['etag']!))).status).toBe(422);
    expect((await api.call('patch', `/roles/${created.body.id}`, { code: 'OTHER', reason: 'immutable' }, ifMatch(back.headers['etag']!))).status).toBe(422);
    expect((await api.call('patch', `/roles/${randomUUID()}`, { name_en: 'Ghost', reason: 'unknown' }, ifMatch('"1"'))).status).toBe(404);
  });

  it('deactivates a role only when nobody holds it (409 role_in_use); inactive roles are hidden unless asked for', async () => {
    const { api } = await adminApi(app, db);
    const profile = await makeProfile(db, [['sites', 'view']]);
    const role = await api.call('post', '/roles', { code: `USE_${uid()}`, name_en: 'In use', default_profile_id: profile, can_hold_matrix_levels: true, reason: 'new role', default_region_ids: [1], default_module_keys: ['sites'] });
    const person = await makeUser(db, { assigned: false });
    const assigned = await api.call('post', '/assignments/bulk-assign', { user_ids: [person.id], role_ids: [role.body.id], defaults: { permission_level: 'entry' }, reason: 'holds the role' });
    expect(assigned.body.done).toHaveLength(1);

    const fresh = await api.call('get', `/roles/${role.body.id}`);
    expect(fresh.body.active_assignment_count).toBe(1);
    const refused = await api.call('patch', `/roles/${role.body.id}`, { is_active: false, reason: 'retire' }, ifMatch(fresh.headers['etag']!));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('role_in_use');
    expect((await api.call('get', `/roles/${role.body.id}`)).body.is_active).toBe(true);

    const row = (await api.call('get', `/users/${person.id}/assignments`)).body.items[0];
    await api.call('post', '/assignments/bulk-end', { items: [{ id: row.id, version: row.version }], reason: 'role retired' });
    const free = await api.call('get', `/roles/${role.body.id}`);
    expect(free.body.active_assignment_count).toBe(0);
    const off = await api.call('patch', `/roles/${role.body.id}`, { is_active: false, reason: 'retire' }, ifMatch(free.headers['etag']!));
    expect(off.status).toBe(200);
    expect(off.body.is_active).toBe(false);

    expect((await api.call('get', '/roles')).body.items.some((r: { id: string }) => r.id === role.body.id)).toBe(false);
    expect((await api.call('get', '/roles?include_inactive=true')).body.items.some((r: { id: string }) => r.id === role.body.id)).toBe(true);
    // an inactive role cannot be assigned
    const again = await api.call('post', '/assignments/bulk-assign', { user_ids: [person.id], role_ids: [role.body.id], defaults: { permission_level: 'entry' }, reason: 'too late' });
    expect(again.body.failed).toEqual([expect.objectContaining({ code: 'validation_failed' })]);
    expect((await api.call('get', '/roles?include_inactive=maybe')).status).toBe(422);
  });

  it('refuses a duplicate code (409 duplicate), bad bodies (422), a caller without the right (403) and without step-up (401)', async () => {
    const { api } = await adminApi(app, db);
    const code = `DUP_${uid()}`;
    const body = { code, name_en: 'First', can_hold_matrix_levels: true, reason: 'first role' };
    expect((await api.call('post', '/roles', body)).status).toBe(201);
    const dup = await api.call('post', '/roles', body);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate');
    expect(dup.body.errors[0].path).toBe('/code');
    for (const bad of [{ ...body, code: 'lower' }, { ...body, name_en: 'x' }, { ...body, can_hold_matrix_levels: undefined }, { ...body, reason: 'no' }, { ...body, extra: true }, { ...body, default_module_keys: ['nope'] }, { ...body, default_profile_id: randomUUID() }]) {
      expect((await api.call('post', '/roles', { ...bad, code: bad.code === 'lower' ? 'lower' : `Z_${uid()}` })).status).toBe(422);
    }

    const plain = await signedIn([['admin.users', 'view']]);
    const denied = await plain.call('post', '/roles', { ...body, code: `Z_${uid()}` });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');
    const created = await api.call('post', '/roles', { ...body, code: `Z_${uid()}` });
    const deniedPatch = await plain.call('patch', `/roles/${created.body.id}`, { name_en: 'Hacked', reason: 'no right' }, ifMatch(created.headers['etag']!));
    expect(deniedPatch.status).toBe(403);

    const fresh = await adminApi(app, db);
    const lowStep = await loggedIn(app, fresh.admin);
    const res = await lowStep.call('post', '/roles', { ...body, code: `Z_${uid()}` });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('step_up_required');
  });

  it('a delegate with roles.create (all regions) creates a role; a regional delegate may not (global change)', async () => {
    const all = await signedIn([], [['roles', 'create']]);
    const ok = await all.call('post', '/roles', { code: `DLG_${uid()}`, name_en: 'By delegate', can_hold_matrix_levels: true, reason: 'delegated work' });
    expect(ok.status).toBe(201);
    const user = await makeUser(db, {});
    await delegate(db, user.id, [['roles', 'create']], [1]);
    const regional = await loggedIn(app, user);
    await regional.stepUp(user.password);
    const denied = await regional.call('post', '/roles', { code: `DLG_${uid()}`, name_en: 'Regional', can_hold_matrix_levels: true, reason: 'not global' });
    expect(denied.status).toBe(403);
    // the delegate cannot make a role that defaults to every region
    const wide = await all.call('post', '/roles', { code: `DLG_${uid()}`, name_en: 'Everywhere', can_hold_matrix_levels: true, reason: 'too wide', default_region_ids: 'all' });
    expect(wide.status).toBe(403);
  });
});

describe('permission catalogue and profiles', () => {
  it('serves the catalogue: modules with screens and actions, the actions the database stores, and the delegable rights', async () => {
    const { api } = await adminApi(app, db);
    const res = await api.call('get', '/permissions/catalogue');
    expect(res.status).toBe(200);
    const keys = res.body.modules.map((m: { key: string }) => m.key);
    expect(keys).toEqual(expect.arrayContaining(['sites', 'warehouse', 'admin', 'audit']));
    expect(res.body.modules.find((m: { key: string }) => m.key === 'sites').screens).toEqual([{ key: 'sites.documents', name_en: 'Site documents' }]);
    expect(res.body.actions).toEqual(expect.arrayContaining(['view', 'create', 'edit', 'delete', 'approve', 'export', 'import', 'download_documents', 'view_audit', 'administer']));
    expect(res.body.delegable_rights).toEqual(expect.arrayContaining(['unlock', 'users.edit', 'assignments.edit', 'warehouse.items.edit', 'workflow.publish']));
    expect((await new Api(app).call('get', '/permissions/catalogue')).status).toBe(401);
  });

  it('creates a profile with its grid and a field rule, reads it, lists it, and counts the assignments that use it', async () => {
    const { api } = await adminApi(app, db);
    const field = await db.query("INSERT INTO field_definitions (entity_type, code, label_en, data_type) VALUES ('site', $1, 'Owner phone', 'text') RETURNING id", [`f_${uid().toLowerCase()}`]);
    const code = `VIEWER_${uid()}`;
    const res = await api.call('post', '/permission-profiles', {
      code, name_en: 'Viewer', name_ar: 'مشاهد', description: 'Read only', grants: [{ module_key: 'sites', action: 'view' }, { module_key: 'sites.documents', action: 'view' }, { module_key: 'sites', action: 'view' }],
      field_rules: [{ field_id: field.rows[0].id, access: 'hidden' }], reason: 'read-only profile',
    });
    expect(res.status).toBe(201);
    expect(res.headers['etag']).toBe(`"${res.body.version}"`);
    expect(res.body).toMatchObject({ code, name_en: 'Viewer', name_ar: 'مشاهد', is_active: true, assignment_count: 0 });
    expect(res.body.grants).toEqual([{ module_key: 'sites', action: 'view' }, { module_key: 'sites.documents', action: 'view' }]);
    expect(res.body.field_rules).toEqual([expect.objectContaining({ field_id: field.rows[0].id, access: 'hidden', entity_type: 'site' })]);
    expect(res.body.changed_by.id).toBeTruthy();

    const person = await makeUser(db, { assigned: false });
    const role = await makeRole(db);
    await api.call('post', '/assignments/bulk-assign', { user_ids: [person.id], role_ids: [role], defaults: { permission_level: 'view', region_ids: [1], module_keys: ['sites'], profile_ids: [res.body.id] }, reason: 'uses the profile' });
    const get = await api.call('get', `/permission-profiles/${res.body.id}`);
    expect(get.body.assignment_count).toBe(1);
    expect((await api.call('get', '/permission-profiles')).body.items.map((p: { id: string }) => p.id)).toContain(res.body.id);
    expect((await api.call('get', `/permission-profiles/${randomUUID()}`)).status).toBe(404);

    const dup = await api.call('post', '/permission-profiles', { code, name_en: 'Again', grants: [], reason: 'duplicate code' });
    expect(dup.status).toBe(409);
    expect(dup.body.errors[0].path).toBe('/code');
  });

  it('replaces the grid and the field rules (If-Match), and the person gets the new grants at once', async () => {
    const { api } = await adminApi(app, db);
    const f1 = await db.query("INSERT INTO field_definitions (entity_type, code, label_en, data_type) VALUES ('site', $1, 'F1', 'text') RETURNING id", [`f_${uid().toLowerCase()}`]);
    const f2 = await db.query("INSERT INTO field_definitions (entity_type, code, label_en, data_type) VALUES ('site', $1, 'F2', 'text') RETURNING id", [`f_${uid().toLowerCase()}`]);
    const created = await api.call('post', '/permission-profiles', {
      code: `ENTRY_${uid()}`, name_en: 'Entry', grants: [{ module_key: 'sites', action: 'view' }], field_rules: [{ field_id: f1.rows[0].id, access: 'read' }], reason: 'first version',
    });
    const person = await makeUser(db, { assigned: false });
    const personApi = await loggedIn(app, person);
    const role = await makeRole(db);
    await api.call('post', '/assignments/bulk-assign', { user_ids: [person.id], role_ids: [role], defaults: { permission_level: 'entry', region_ids: [2], module_keys: ['sites', 'quality'], profile_ids: [created.body.id] }, reason: 'link' });
    expect((await personApi.call('get', '/me')).body.effective.grants).toEqual([{ module_key: 'sites', action: 'view', region_ids: [2] }]);

    const next = {
      code: created.body.code, name_en: 'Entry (v2)', description: 'More rights', is_active: true,
      grants: [{ module_key: 'sites', action: 'view' }, { module_key: 'sites', action: 'edit' }, { module_key: 'quality', action: 'view' }],
      field_rules: [{ field_id: f2.rows[0].id, access: 'edit' }], reason: 'second version',
    };
    expect((await api.call('put', `/permission-profiles/${created.body.id}`, next)).status).toBe(428);
    const done = await api.call('put', `/permission-profiles/${created.body.id}`, next, ifMatch(created.headers['etag']!));
    expect(done.status).toBe(200);
    expect(done.body.name_en).toBe('Entry (v2)');
    expect(done.body.grants).toEqual([{ module_key: 'quality', action: 'view' }, { module_key: 'sites', action: 'edit' }, { module_key: 'sites', action: 'view' }]);
    expect(done.body.field_rules).toEqual([expect.objectContaining({ field_id: f2.rows[0].id, access: 'edit' })]);
    expect(done.body.version).toBeGreaterThan(created.body.version);
    expect((await personApi.call('get', '/me')).body.effective.grants).toEqual([
      { module_key: 'quality', action: 'view', region_ids: [2] },
      { module_key: 'sites', action: 'edit', region_ids: [2] },
      { module_key: 'sites', action: 'view', region_ids: [2] },
    ]);
    expect((await api.call('put', `/permission-profiles/${created.body.id}`, next, ifMatch(created.headers['etag']!))).status).toBe(412);
    expect((await api.call('put', `/permission-profiles/${created.body.id}`, { ...next, code: 'CHANGED' }, ifMatch(done.headers['etag']!))).status).toBe(422);

    // deactivated: the grants stop counting
    const off = await api.call('put', `/permission-profiles/${created.body.id}`, { ...next, is_active: false, reason: 'retired' }, ifMatch(done.headers['etag']!));
    expect(off.body.is_active).toBe(false);
    expect((await personApi.call('get', '/me')).body.effective.grants).toEqual([]);
    expect((await api.call('get', '/permission-profiles')).body.items.some((p: { id: string }) => p.id === created.body.id)).toBe(false);
    expect((await api.call('get', '/permission-profiles?include_inactive=true')).body.items.some((p: { id: string }) => p.id === created.body.id)).toBe(true);
  });

  it('replaces a seeded-style profile whose code is lower case (the contract pattern only applies to new codes)', async () => {
    const { api } = await adminApi(app, db);
    const id = await makeProfile(db, [['sites', 'view']], `viewer_${uid().toLowerCase()}`);
    const cur = await api.call('get', `/permission-profiles/${id}`);
    const res = await api.call('put', `/permission-profiles/${id}`, { code: cur.body.code, name_en: 'Viewer plus', grants: [{ module_key: 'sites', action: 'view' }, { module_key: 'dashboard', action: 'view' }], reason: 'add the dashboard' }, ifMatch(cur.headers['etag']!));
    expect(res.status).toBe(200);
    expect(res.body.grants).toHaveLength(2);
    const bad = await api.call('post', '/permission-profiles', { code: 'lower_case', name_en: 'Bad', grants: [], reason: 'new codes follow the pattern' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].path).toBe('/code');
  });

  it('validates grants and field rules: unknown module, an action the database cannot store yet, unknown field, duplicates', async () => {
    const { api } = await adminApi(app, db);
    const base = { code: `V_${uid()}`, name_en: 'Validation', reason: 'validation' };
    const unknown = await api.call('post', '/permission-profiles', { ...base, grants: [{ module_key: 'moon', action: 'view' }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({ path: '/grants/0/module_key', code: 'unknown_module' });
    const notStored = await api.call('post', '/permission-profiles', { ...base, grants: [{ module_key: 'admin.users', action: 'manage_users' }] });
    expect(notStored.status).toBe(422);
    expect(notStored.body.errors[0]).toMatchObject({ path: '/grants/0/action', code: 'not_supported' });
    const ghost = await api.call('post', '/permission-profiles', { ...base, grants: [], field_rules: [{ field_id: randomUUID(), access: 'read' }] });
    expect(ghost.body.errors[0]).toMatchObject({ path: '/field_rules/0/field_id', code: 'not_found' });
    expect((await api.call('post', '/permission-profiles', { ...base, grants: [{ module_key: 'sites', action: 'fly' }] })).status).toBe(422);
    expect((await api.call('post', '/permission-profiles', { ...base })).status).toBe(422);
    expect(await db.query('SELECT 1 FROM permission_profiles WHERE code = $1', [base.code]).then((r) => r.rowCount)).toBe(0);
  });

  it('reading needs admin.roles or admin.users view (403 module_forbidden); writing needs the right (403) and step-up (401)', async () => {
    const { api } = await adminApi(app, db);
    const profile = await api.call('post', '/permission-profiles', { code: `P_${uid()}`, name_en: 'P', grants: [{ module_key: 'sites', action: 'view' }], reason: 'profile' });
    const nobody = await signedIn([['sites', 'view']]);
    for (const path of ['/permission-profiles', `/permission-profiles/${profile.body.id}`]) {
      const r = await nobody.call('get', path);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('module_forbidden');
    }
    const reader = await signedIn([['admin.roles', 'view']]);
    expect((await reader.call('get', '/permission-profiles')).status).toBe(200);
    const denied = await reader.call('post', '/permission-profiles', { code: `P_${uid()}`, name_en: 'No', grants: [], reason: 'no right' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');
    const deniedPut = await reader.call('put', `/permission-profiles/${profile.body.id}`, { code: profile.body.code, name_en: 'No', grants: [], reason: 'no right' }, ifMatch(profile.headers['etag']!));
    expect(deniedPut.status).toBe(403);

    const other = await adminApi(app, db);
    const noStep = await loggedIn(app, other.admin);
    const res = await noStep.call('post', '/permission-profiles', { code: `P_${uid()}`, name_en: 'No step', grants: [], reason: 'no step-up' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('step_up_required');
  });

  it('nobody edits a profile that gives them rights (403 self_beneficiary), and a delegate never grants more than they hold', async () => {
    const { api } = await adminApi(app, db);
    const profile = await makeProfile(db, [['sites', 'view'], ['admin.roles', 'view']]);
    const user = await makeUser(db, { assigned: false });
    const role = await makeRole(db, { profile });
    await api.call('post', '/assignments/bulk-assign', { user_ids: [user.id], role_ids: [role], defaults: { permission_level: 'view', region_ids: [1], module_keys: ['sites', 'admin'] }, reason: 'link the profile' });
    await delegate(db, user.id, [['permission_profiles', 'create'], ['permission_profiles', 'edit']]);
    const userApi = await loggedIn(app, user);
    await userApi.stepUp(user.password);
    const current = await userApi.call('get', `/permission-profiles/${profile}`);
    expect(current.status).toBe(200);
    const self = await userApi.call('put', `/permission-profiles/${profile}`, {
      code: current.body.code, name_en: 'Mine now', grants: [{ module_key: 'sites', action: 'view' }, { module_key: 'sites', action: 'approve' }], reason: 'give myself approve',
    }, ifMatch(current.headers['etag']!));
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');
    expect((await userApi.call('get', `/permission-profiles/${profile}`)).body.grants).toHaveLength(2);

    // a new profile wider than the delegate's own rights is refused
    const wider = await userApi.call('post', '/permission-profiles', { code: `W_${uid()}`, name_en: 'Wider', grants: [{ module_key: 'sites', action: 'delete' }], reason: 'wider than mine' });
    expect(wider.status).toBe(403);
    const same = await userApi.call('post', '/permission-profiles', { code: `W_${uid()}`, name_en: 'Same', grants: [{ module_key: 'sites', action: 'view' }], reason: 'within mine' });
    expect(same.status).toBe(201);
  });
});
