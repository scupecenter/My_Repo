import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, Actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/** P10 (owner answers Q115 and Q117, migration 0065, contract 0.12.12): saved views on the server, shared views and drafts. */
const TAG = randomBytes(3).toString('hex');
let app: NestExpressApplication;
let db: PgClient;

const SITES_VIEW: [string, string][] = [['sites', 'view']];
const LEAD: [string, string][] = [['sites', 'view'], ['issues', 'view'], ['views', 'create']];

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const nm = (s: string): string => `${s} ${TAG}`;
const create = (a: Actor, body: Record<string, unknown>) => a.api.call('post', '/saved-views', body);
const etagOf = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const idsOf = (body: { items: { id: string }[] }): string[] => body.items.map((v) => v.id);

describe('private views', () => {
  it('another user cannot read, list, change or deactivate my private view; neither can a System Admin', async () => {
    const ann = await actor(app, db, { grants: SITES_VIEW });
    const ben = await actor(app, db, { grants: SITES_VIEW });
    const admin = await plainAdmin(app, db);
    const res = await create(ann, { screen_key: 'sites', name: nm('Mine'), filters: { region_id: '1', bucket: 'late' }, columns: { hidden: ['scenario'], density: 'compact' }, sort: [{ id: 'code', dir: 'asc' }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ screen_key: 'sites', is_owner: true, shared: false, can_edit: true, version: 1, filters: { region_id: '1', bucket: 'late' }, sort: [{ id: 'code', dir: 'asc' }] });
    expect(res.headers.etag).toBe('"1"');
    const id = res.body.id as string;

    expect((await ann.api.call('get', `/saved-views/${id}`)).status).toBe(200);
    for (const other of [ben, admin]) {
      expect((await other.api.call('get', `/saved-views/${id}`)).status).toBe(404);
      const list = await other.api.call('get', '/saved-views?screen_key=sites');
      expect(list.status).toBe(200);
      expect(idsOf(list.body)).not.toContain(id);
      expect((await other.api.call('patch', `/saved-views/${id}`, { name: 'hijack', reason: 'testing' }, { 'If-Match': '"1"' })).status).toBe(404);
      expect((await other.api.call('post', `/saved-views/${id}/deactivate`, { reason: 'testing' }, { 'If-Match': '*' })).status).toBe(404);
      expect((await other.api.call('get', `/saved-views/${id}/versions`)).status).toBe(404);
    }
    const mine = await ann.api.call('get', '/saved-views?screen_key=sites&scope=mine');
    expect(idsOf(mine.body)).toContain(id);
    expect(mine.body.can_share).toBe('none');
  });

  it('a user without views.share cannot share; an unknown screen or field is refused', async () => {
    const ann = await actor(app, db, { grants: SITES_VIEW });
    const ben = await actor(app, db, { grants: SITES_VIEW });
    expect((await create(ann, { screen_key: 'sites', name: nm('S'), audience: { user_ids: [ben.user.id] } })).status).toBe(403);
    expect((await create(ann, { screen_key: 'not-a-screen', name: nm('S') })).status).toBe(422);
    expect((await create(ann, { screen_key: 'sites', name: nm('S'), extra: 1 })).status).toBe(422);
    expect((await create(ann, { screen_key: 'audit-log', name: nm('S') })).status).toBe(403); // no right on the screen's module
    // the same name twice on one screen
    expect((await create(ann, { screen_key: 'sites', name: nm('Twice') })).status).toBe(201);
    expect((await create(ann, { screen_key: 'sites', name: nm('twice') })).status).toBe(409);
  });
});

describe('shared views (Q117)', () => {
  it('a Team Lead shares with a user and a role; only the audience that may open the module sees it, without the audience list', async () => {
    const lead = await actor(app, db, { grants: LEAD });
    const ben = await actor(app, db, { grants: SITES_VIEW });
    const roleMate = await actor(app, db, { grants: SITES_VIEW });
    const noModule = await actor(app, db, { grants: [['issues', 'view']] });
    const outsider = await actor(app, db, { grants: SITES_VIEW });
    await db.query('INSERT INTO user_role_assignments (user_id, role_id, permission_level, all_regions, all_modules) VALUES ($1, $2, \'view\', true, true)', [noModule.user.id, roleMate.roleId]);
    const res = await create(lead, { screen_key: 'sites', name: nm('Late'), filters: { bucket: 'late' }, audience: { user_ids: [ben.user.id], role_ids: [roleMate.roleId] } });
    expect(res.status).toBe(201);
    expect(res.body.shared).toBe(true);
    expect(res.body.audience.users.map((u: { id: string }) => u.id)).toEqual([ben.user.id]);
    const id = res.body.id as string;

    for (const who of [ben, roleMate]) {
      const list = await who.api.call('get', '/saved-views?screen_key=sites&scope=shared');
      const v = list.body.items.find((x: { id: string }) => x.id === id);
      expect(v).toMatchObject({ is_owner: false, can_edit: false, shared: true, audience: null, filters: { bucket: 'late' } });
      expect((await who.api.call('get', `/saved-views/${id}`)).status).toBe(200);
      expect((await who.api.call('patch', `/saved-views/${id}`, { name: 'x' }, { 'If-Match': '"1"' })).status).toBe(403);
    }
    for (const who of [noModule, outsider]) {
      expect((await who.api.call('get', `/saved-views/${id}`)).status).toBe(404);
      expect(idsOf((await who.api.call('get', '/saved-views')).body)).not.toContain(id);
    }
    const flags = await lead.api.call('get', '/saved-views?screen_key=sites');
    expect(flags.body).toMatchObject({ can_share: 'all', can_manage: false });
  });

  it('a region-limited lead shares with people, not with everyone, and only filters on their own regions', async () => {
    const lead = await actor(app, db, { grants: LEAD, regions: [1] });
    const ben = await actor(app, db, { grants: SITES_VIEW });
    expect((await lead.api.call('get', '/saved-views?screen_key=sites')).body.can_share).toBe('limited');
    expect((await create(lead, { screen_key: 'sites', name: nm('All'), audience: { everyone: true } })).status).toBe(403);
    const out = await create(lead, { screen_key: 'sites', name: nm('Zawia'), filters: { region_id: '4' }, audience: { user_ids: [ben.user.id] } });
    expect(out.status).toBe(422);
    expect(out.body.errors[0]).toMatchObject({ path: '/filters/region_id', code: 'out_of_scope' });
    expect((await create(lead, { screen_key: 'sites', name: nm('Tripoli'), filters: { region_id: '1' }, audience: { user_ids: [ben.user.id] } })).status).toBe(201);
    // a private view may hold any filter: the reader's own rights filter the rows
    expect((await create(lead, { screen_key: 'sites', name: nm('Zawia private'), filters: { region_id: '4' } })).status).toBe(201);
  });

  it('versions, If-Match, audit; views.manage edits with a reason; deactivate and restore; never deleted', async () => {
    const lead = await actor(app, db, { grants: LEAD });
    const ben = await actor(app, db, { grants: SITES_VIEW });
    const admin = await plainAdmin(app, db);
    const res = await create(lead, { screen_key: 'sites', name: nm('Versioned'), audience: { everyone: true } });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    expect((await lead.api.call('patch', `/saved-views/${id}`, { name: nm('V2') })).status).toBe(428);
    expect((await lead.api.call('patch', `/saved-views/${id}`, { name: nm('V2') }, { 'If-Match': '"7"' })).status).toBe(412);
    const p = await lead.api.call('patch', `/saved-views/${id}`, { name: nm('V2'), columns: { order: ['code', 'name'] } }, { 'If-Match': etagOf(res) });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ version: 2, name: nm('V2'), columns: { order: ['code', 'name'] } });

    // views.manage (System Admin): needs a reason on somebody else's view
    expect((await admin.api.call('patch', `/saved-views/${id}`, { name: nm('V3') }, { 'If-Match': '"2"' })).status).toBe(422);
    const m = await admin.api.call('patch', `/saved-views/${id}`, { name: nm('V3'), reason: 'tidy the shared views' }, { 'If-Match': '"2"' });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ version: 3, is_owner: false, can_edit: true });

    const d = await lead.api.call('post', `/saved-views/${id}/deactivate`, {}, { 'If-Match': '"3"' });
    expect(d.status).toBe(200);
    expect(d.body.is_active).toBe(false);
    expect((await ben.api.call('get', `/saved-views/${id}`)).status).toBe(404);
    expect(idsOf((await lead.api.call('get', '/saved-views?screen_key=sites')).body)).not.toContain(id);
    expect(idsOf((await lead.api.call('get', '/saved-views?screen_key=sites&include_inactive=true')).body)).toContain(id);
    expect((await lead.api.call('patch', `/saved-views/${id}`, { name: 'x' }, { 'If-Match': '*' })).status).toBe(409);
    const r = await lead.api.call('post', `/saved-views/${id}/restore`, {}, { 'If-Match': '"4"' });
    expect(r.status).toBe(200);
    expect((await ben.api.call('get', `/saved-views/${id}`)).status).toBe(200);

    const v = await lead.api.call('get', `/saved-views/${id}/versions`);
    expect(v.body.items.map((x: { change: string }) => x.change)).toEqual(['restore', 'deactivate', 'edit', 'edit', 'create']);
    const audit = await db.query(`SELECT action, actor_id::text AS actor, reason FROM audit_log WHERE entity_type = 'saved_view' AND entity_id = $1 ORDER BY id`, [id]);
    expect(audit.rows.map((x) => x.action)).toEqual(['saved_view.create', 'saved_view.edit', 'saved_view.edit', 'saved_view.deactivate', 'saved_view.restore']);
    expect(audit.rows[2]).toMatchObject({ actor: admin.user.id, reason: 'tidy the shared views' });
    await expect(db.query('DELETE FROM saved_views WHERE id = $1', [id])).rejects.toThrow(/append-only/);
  });

  it('hidden columns are stripped for each reader (a custom field a field rule hides)', async () => {
    const lead = await actor(app, db, { grants: LEAD });
    const ben = await actor(app, db, { grants: [['issues', 'view']] });
    const code = `secret_${TAG}`;
    const f = await db.query(`INSERT INTO field_definitions (entity_type, code, label_en, data_type) VALUES ('issue', $1, 'Secret', 'text') RETURNING id`, [code]);
    await db.query(`INSERT INTO field_permissions (field_id, role_id, access) VALUES ($1, $2, 'hidden')`, [f.rows[0].id, ben.roleId]);
    const res = await create(lead, {
      screen_key: 'register-issues', name: nm('Issues'), filters: { state: 'entry', [`f:${code}`]: 'x' },
      columns: { order: ['site', `f:${code}`, 'f:owner_user', 'f:no_such_field'], width: { [`f:${code}`]: 200 } }, sort: [{ id: `f:${code}`, dir: 'desc' }],
      audience: { user_ids: [ben.user.id] },
    });
    expect(res.status).toBe(201);
    expect(res.body.columns.order).toEqual(['site', `f:${code}`, 'f:owner_user']); // the owner sees the field; an unknown field never shows
    const seen = await ben.api.call('get', `/saved-views/${res.body.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.columns.order).toEqual(['site', 'f:owner_user']);
    expect(seen.body.columns.width).toEqual({});
    expect(seen.body.filters).toEqual({ state: 'entry' });
    expect(seen.body.sort).toEqual([]);
    expect(seen.body.stripped_columns).toBe(2);
    expect(JSON.stringify(seen.body)).not.toContain(code);
  });

  it('ownership moves to the active direct manager when the owner leaves, else views.manage transfers it', async () => {
    const mgr = await actor(app, db, { grants: LEAD });
    const lead = await actor(app, db, { grants: LEAD });
    const lead2 = await actor(app, db, { grants: LEAD });
    const ben = await actor(app, db, { grants: SITES_VIEW });
    const admin = await plainAdmin(app, db);
    await db.query('UPDATE users SET manager_id = $1 WHERE id = $2', [mgr.user.id, lead.user.id]);
    const shared = (await create(lead, { screen_key: 'sites', name: nm('Handed'), audience: { user_ids: [ben.user.id, mgr.user.id] } })).body.id as string;
    const priv = (await create(lead, { screen_key: 'sites', name: nm('Private') })).body.id as string;
    const orphanOwner = await actor(app, db, { grants: LEAD });
    const orphan = (await create(orphanOwner, { screen_key: 'sites', name: nm('Orphan'), audience: { everyone: true } })).body.id as string;

    await db.query(`UPDATE users SET status = 'disabled' WHERE id = ANY($1::uuid[])`, [[lead.user.id, orphanOwner.user.id]]);
    const moved = await mgr.api.call('get', `/saved-views/${shared}`);
    expect(moved.body).toMatchObject({ is_owner: true, owner: { id: mgr.user.id }, owner_left: false });
    expect(moved.body.audience.users.map((u: { id: string }) => u.id)).toEqual([ben.user.id]);
    expect((await mgr.api.call('get', `/saved-views/${priv}`)).status).toBe(404); // a private view never moves
    const hist = await mgr.api.call('get', `/saved-views/${shared}/versions`);
    expect(hist.body.items[0]).toMatchObject({ change: 'owner_left' });

    const left = await ben.api.call('get', `/saved-views/${orphan}`);
    expect(left.body.owner_left).toBe(true);
    expect((await ben.api.call('get', '/saved-views?scope=orphaned')).status).toBe(403);
    const orphans = await admin.api.call('get', '/saved-views?screen_key=sites&scope=orphaned');
    expect(idsOf(orphans.body)).toContain(orphan);
    expect((await admin.api.call('post', `/saved-views/${orphan}/transfer`, { owner_id: ben.user.id, reason: 'creator left' }, { 'If-Match': '*' })).status).toBe(422); // no views.share
    const t = await admin.api.call('post', `/saved-views/${orphan}/transfer`, { owner_id: lead2.user.id, reason: 'creator left' }, { 'If-Match': '"1"' });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ owner: { id: lead2.user.id }, owner_left: false, version: 2 });
    expect((await lead2.api.call('get', `/saved-views/${orphan}`)).body.is_owner).toBe(true);
  });
});

describe('import of the browser views', () => {
  it('imports once per local id as private views, renaming a clash', async () => {
    const ann = await actor(app, db, { grants: SITES_VIEW });
    expect((await create(ann, { screen_key: 'sites', name: nm('Old') })).status).toBe(201);
    const items = [{ local_id: 'a1', name: nm('Old'), filters: { q: 'TR' } }, { local_id: 'a2', name: nm('Other'), filters: {} }];
    const r1 = await ann.api.call('post', '/saved-views/import', { screen_key: 'sites', items });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ imported: 2, skipped: 0 });
    expect(r1.body.items.map((v: { name: string }) => v.name)).toEqual([`${nm('Old')} (2)`, nm('Other')]);
    expect(r1.body.items.every((v: { imported: boolean; shared: boolean }) => v.imported && !v.shared)).toBe(true);
    const r2 = await ann.api.call('post', '/saved-views/import', { screen_key: 'sites', items });
    expect(r2.body).toMatchObject({ imported: 0, skipped: 2 });
  });
});

describe('drafts (Q115)', () => {
  it('saves, reads and discards my own draft; a stale base version is 412; nobody else reads it', async () => {
    const ann = await actor(app, db, { grants: SITES_VIEW, regions: [1] });
    const ben = await actor(app, db, { grants: SITES_VIEW, regions: [1] });
    const zawia = await actor(app, db, { grants: SITES_VIEW, regions: [4] });
    const site = await makeSite(db, 1, { prefix: `DR${TAG}` });
    const task = await makeTask(db, site, 'A1', 'entry');
    const key = `task.${task}`;
    const s1 = await ann.api.call('put', `/me/drafts/${key}`, { payload: { actual_date: '2026-10-01' } });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ key, version: 1 });
    expect(s1.body.payload).toBeUndefined();
    expect((await ann.api.call('put', `/me/drafts/${key}`, { payload: { actual_date: '2026-10-02' }, base_version: 1 })).body.version).toBe(2);
    expect((await ann.api.call('put', `/me/drafts/${key}`, { payload: { actual_date: '2026-10-03' }, base_version: 1 })).status).toBe(412);
    const g = await ann.api.call('get', `/me/drafts/${key}`);
    expect(g.body).toMatchObject({ version: 2, payload: { actual_date: '2026-10-02' } });
    expect((await ann.api.call('get', '/me/drafts')).body.items.map((d: { key: string }) => d.key)).toContain(key);
    // the draft saves nothing on the task
    const t = await db.query('SELECT actual_date FROM task_instances WHERE id = $1', [task]);
    expect(t.rows[0].actual_date).toBeNull();

    expect((await ben.api.call('get', `/me/drafts/${key}`)).status).toBe(404);
    expect((await zawia.api.call('put', `/me/drafts/${key}`, { payload: { a: 1 } })).status).toBe(404); // cannot read the task
    expect((await ann.api.call('put', '/me/drafts/record.issues.new', { payload: { a: 1 } })).status).toBe(403); // no create on issues
    expect((await ann.api.call('put', '/me/drafts/form.profile', { payload: { a: 1 } })).status).toBe(200);
    expect((await ann.api.call('put', '/me/drafts/bad key', { payload: {} })).status).toBe(422);

    expect((await ann.api.call('delete', `/me/drafts/${key}`)).status).toBe(204);
    expect((await ann.api.call('get', `/me/drafts/${key}`)).status).toBe(404);
  });
});
