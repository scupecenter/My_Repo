import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, startApp, superDb } from './helpers';
import { G, PROC, approveAll, createRec, post, recPath, team } from './reg-helpers';
import { Actor, actor, makeSite } from './wf-helpers';

/**
 * X2, follow a site or a register record (migration 0031, review fixes in 0036). Region 4 (Zawia) for sites; the Procurement register in region 4.
 * Nothing depends on the weekday or the database collation.
 */
const REGION = 4;
const PREFIX = `XF${randomBytes(3).toString('hex').toUpperCase()}`;
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const site = (region = REGION) => makeSite(db, region, { prefix: PREFIX });
const reader = (regions: number[] | null = [REGION], grants: [string, string][] = [...G('sites', 'view'), ...G('procurement', 'view')]) =>
  actor(app, db, { level: 'view', grants, regions, modules: null });
const dropGrant = (userId: string, module: string) =>
  db.query(
    `DELETE FROM permission_grants WHERE module_key = $2 AND profile_id IN
       (SELECT ap.profile_id FROM user_role_assignment_profiles ap JOIN user_role_assignments ua ON ua.id = ap.assignment_id WHERE ua.user_id = $1)`,
    [userId, module],
  );
const watches = async (userId: string) => (await db.query('SELECT entity_type, entity_id::text AS entity_id, register_key FROM watches WHERE user_id = $1', [userId])).rows;
const followed = async (userId: string) => (await db.query(`SELECT title, link FROM notifications WHERE user_id = $1 AND kind = 'followed_change' ORDER BY created_at, id`, [userId])).rows;
const audits = async (action: string, actorId: string) => (await db.query('SELECT entity_id, after, before, region_id FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id', [action, actorId])).rows;

describe('follow a site: permission and region', () => {
  it('needs a session (401), the Sites module (403) and a site in the caller\'s regions (404, with no watch written)', async () => {
    const s = await site();
    const far = await site(2);
    const anon = (m: 'put' | 'delete' | 'get', p: string) => request(app.getHttpServer())[m](`${API}${p}`);
    expect((await anon('put', `/sites/${s.id}/follow`)).status).toBe(401);
    expect((await anon('delete', `/sites/${s.id}/follow`)).status).toBe(401);
    expect((await anon('get', '/me/follows')).status).toBe(401);

    const noSites = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [REGION], modules: ['approvals'] });
    expect((await noSites.api.call('put', `/sites/${s.id}/follow`)).status).toBe(403);
    expect(await watches(noSites.user.id)).toEqual([]);

    const me = await reader();
    for (const id of [far.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      expect((await me.api.call('put', `/sites/${id}/follow`)).status, id).toBe(404);
    }
    expect(await watches(me.user.id)).toEqual([]);
    // the answer for a site outside the regions is exactly the answer for a site that does not exist
    const a = await me.api.call('put', `/sites/${far.id}/follow`);
    const b = await me.api.call('put', '/sites/00000000-0000-4000-8000-000000000000/follow');
    expect({ ...a.body, request_id: 0, instance: 0 }).toEqual({ ...b.body, request_id: 0, instance: 0 });
  });

  it('follows idempotently with one audit row, lists newest first, and stops idempotently', async () => {
    const me = await reader();
    const s1 = await site();
    const s2 = await site();
    const r1 = await me.api.call('put', `/sites/${s1.id}/follow`);
    expect(r1.status).toBe(200);
    expect((await me.api.call('put', `/sites/${s1.id}/follow`)).body.id).toBe(r1.body.id);
    await me.api.call('put', `/sites/${s2.id}/follow`);
    expect(await audits('follow', me.user.id)).toHaveLength(2);
    expect((await audits('follow', me.user.id))[0]).toMatchObject({ region_id: REGION, after: { entity_type: 'site', entity_id: s1.id } });
    const list = await me.api.call('get', '/me/follows');
    expect(list.body.items.map((i: { entity_id: string }) => i.entity_id)).toEqual([s2.id, s1.id]);
    expect(list.body.items[0].label).toContain(s2.code);

    expect((await me.api.call('delete', `/sites/${s1.id}/follow`)).status).toBe(204);
    expect((await me.api.call('delete', `/sites/${s1.id}/follow`)).status).toBe(204);
    expect((await me.api.call('delete', '/sites/not-a-uuid/follow')).status).toBe(404);
    expect(await audits('unfollow', me.user.id)).toHaveLength(1);
    expect((await me.api.call('get', '/me/follows')).body.items.map((i: { entity_id: string }) => i.entity_id)).toEqual([s2.id]);
  });

  it('a follow grants nothing: after the region or the module is taken away the follow is hidden, notifies nobody, and can still be removed', async () => {
    const me = await reader([REGION, 1]);
    const other = await reader();
    const s = await site();
    await me.api.call('put', `/sites/${s.id}/follow`);
    await other.api.call('put', `/sites/${s.id}/follow`);
    expect((await me.api.call('get', '/me/follows')).body.items).toHaveLength(1);

    // the region is taken away
    await db.query('BEGIN');
    const a = await db.query('SELECT id FROM user_role_assignments WHERE user_id = $1', [me.user.id]);
    await db.query('UPDATE user_role_assignments SET all_regions = false WHERE id = $1', [a.rows[0].id]);
    await db.query('DELETE FROM user_role_assignment_regions WHERE assignment_id = $1', [a.rows[0].id]);
    await db.query('INSERT INTO user_role_assignment_regions (assignment_id, region_id) VALUES ($1, 1)', [a.rows[0].id]);
    await db.query('COMMIT');
    expect((await me.api.call('get', '/me/follows')).body.items).toEqual([]);
    expect(await watches(me.user.id)).toHaveLength(1); // still stored, never shown

    // a change of the site reaches the one who can read it and not the one who cannot
    const tid = (await db.query(
      `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, level_opened_at, level_round, updated_at)
       SELECT $1, $2, td.id, 'open', 1, 2, now(), 1, now() FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = 'A1' RETURNING id::text AS id`,
      [s.id, REGION])).rows[0].id as string;
    await db.query(`SELECT wf_audit('task_start', $1::uuid, NULL, '{"state":"entry"}'::jsonb, NULL)`, [tid]);
    expect((await followed(other.user.id)).map((r) => r.title)).toEqual(['A followed site changed']);
    expect(await followed(me.user.id)).toEqual([]);

    // stopping needs no read right
    await dropGrant(me.user.id, 'sites');
    expect((await me.api.call('delete', `/sites/${s.id}/follow`)).status).toBe(204);
    expect(await watches(me.user.id)).toEqual([]);
  });

  it('nobody sees or removes another person\'s follow', async () => {
    const s = await site();
    const a = await reader();
    const b = await reader();
    await a.api.call('put', `/sites/${s.id}/follow`);
    expect((await b.api.call('get', '/me/follows')).body.items).toEqual([]);
    expect((await b.api.call('delete', `/sites/${s.id}/follow`)).status).toBe(204); // its own, which does not exist
    expect(await watches(a.user.id)).toHaveLength(1);
  });
});

describe('follow a register record', () => {
  it('needs the register\'s module (403), a record in the caller\'s regions (404) and follows the record across its versions', async () => {
    const t = await team(app, db, 'procurement', 'procurement', REGION);
    const w = await reader();
    const wrongRegion = await reader([2]);
    const wrongModule = await reader([REGION], G('sites', 'view'));
    const rec = await createRec(t, PROC);
    const url = recPath('procurement', rec.id, '/follow');

    expect((await wrongModule.api.call('put', url)).status).toBe(403);
    expect((await wrongRegion.api.call('put', url)).status).toBe(404);
    expect((await w.api.call('put', recPath('nope', rec.id, '/follow'))).status).toBe(404);
    expect((await w.api.call('put', recPath('gecol', rec.id, '/follow'))).status).toBe(403); // a register the caller has no right on
    expect(await watches(wrongModule.user.id)).toEqual([]);
    expect(await watches(wrongRegion.user.id)).toEqual([]);
    const ok = await w.api.call('put', url);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ entity_type: 'register_record', register_key: 'procurement', site_id: t.site.id });
    expect(ok.body.entity_id).not.toBe(rec.id); // the stable entity id of the record, shared by all its versions
    expect((await audits('follow', w.user.id))[0].after).toMatchObject({ entity_type: 'register_record', register_key: 'procurement' });

    // the entry holder submits, the approver approves: the follower hears about the changes of every version
    const done = await approveAll(t, rec.id, rec.version);
    expect(done.state).toBe('approved');
    expect((await followed(w.user.id)).length).toBeGreaterThanOrEqual(2);
    const before = (await followed(w.user.id)).length;
    const nv = await post(t.entry.api, 'procurement', rec.id, 'versions', done.version);
    expect([201, 200]).toContain(nv.status);
    expect(nv.body.id).not.toBe(rec.id);
    const sub = await post(t.entry.api, 'procurement', nv.body.id, 'submit', nv.body.version);
    expect(sub.status).toBe(200);
    expect((await followed(w.user.id)).length).toBeGreaterThan(before);
    // the link points at the record's own route, so the inbox scopes it by register and region
    const last = (await followed(w.user.id)).at(-1) as { link: string };
    expect(last.link).toBe(`/registers/procurement/records/${nv.body.id}`);
  });

  it('never tells a follower who lost the register, the region or the view right, and hides the follow from the list', async () => {
    const t = await team(app, db, 'procurement', 'procurement', REGION);
    const keeps = await reader();
    const noModule = await reader();
    const rec = await createRec(t, PROC);
    await keeps.api.call('put', recPath('procurement', rec.id, '/follow'));
    await noModule.api.call('put', recPath('procurement', rec.id, '/follow'));
    await dropGrant(noModule.user.id, 'procurement');
    expect((await noModule.api.call('get', '/me/follows')).body.items).toEqual([]);
    const sub = await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version);
    expect(sub.status).toBe(200);
    expect((await followed(keeps.user.id)).map((r) => r.title)).toEqual(['A followed record changed']);
    expect(await followed(noModule.user.id)).toEqual([]);
    // may still stop following
    expect((await noModule.api.call('delete', recPath('procurement', rec.id, '/follow'))).status).toBe(204);
    expect(await watches(noModule.user.id)).toEqual([]);
  });

  it('the followers of a site also hear about a register record of that site, but only if they can read the register', async () => {
    const t = await team(app, db, 'procurement', 'procurement', REGION);
    const full: Actor = await reader();
    const sitesOnly: Actor = await reader([REGION], G('sites', 'view'));
    await full.api.call('put', `/sites/${t.site.id}/follow`);
    await sitesOnly.api.call('put', `/sites/${t.site.id}/follow`);
    const rec = await createRec(t, PROC);
    expect((await post(t.entry.api, 'procurement', rec.id, 'submit', rec.version)).status).toBe(200);
    expect((await followed(full.user.id)).map((r) => r.title)).toContain('A followed record changed');
    expect(await followed(sitesOnly.user.id)).toEqual([]);
    expect((await followed(t.entry.user.id))).toEqual([]); // the person who acted is never told
  });
});
