import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, delegate, loggedIn, makeUser, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Switchable UI designs (owner decision 2026-11-19, migration 0130, contract 0.15.41): GET / PUT /settings/identity (the organization default design and whether users
 * may choose their own, setting ui.identity) and the personal design `ui_brand` of PATCH /me/profile. GET /me and GET /me/profile carry the stored `ui_brand` and the
 * effective `brand`. The suite puts the setting back to the default at the end; no other suite reads it.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let allDelegate: Actor;
let regDelegate: Actor;
const REASON = 'Owner decision 2026-11-19';

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  allDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, allDelegate.user.id, [['settings', 'edit']]);
  regDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, regDelegate.user.id, [['settings', 'edit']], [5]);
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = '{"default_brand": "current", "allow_user_choice": true}'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'ui.identity'`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const read = (who: Actor) => who.api.call('get', '/settings/identity');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/identity', body, tag === undefined ? {} : { 'If-Match': tag });
const value = async (): Promise<unknown> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'ui.identity'`))[0]?.value;
const audits = () => q<{ before: any; after: any; reason: string; actor_id: string }>(db,
  `SELECT before, after, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'ui_identity_update' AND entity_id = 'ui.identity' ORDER BY id`);
const profileTag = async (api: Api): Promise<string> => String((await api.call('get', '/me/profile')).headers.etag);
const patchBrand = async (api: Api, ui_brand: unknown) => api.call('patch', '/me/profile', { ui_brand }, { 'If-Match': await profileTag(api) });

describe('Settings, Identity & themes: GET and PUT /settings/identity', () => {
  it('every signed-in user reads the default (current, choice allowed); only a System Admin or an all-regions settings delegate may edit', async () => {
    for (const [who, can] of [[plain, false], [regDelegate, false], [allDelegate, true], [admin, true]] as [Actor, boolean][]) {
      const r = await read(who);
      expect(r.status).toBe(200);
      expect(etag(r)).toMatch(/^"\d{1,10}"$/);
      expect(r.body).toMatchObject({ default_brand: 'current', allow_user_choice: true, brands: ['current', 'aljeel', 'executive', 'field'], updated_by: null, can_edit: can });
    }
    expect((await new Api(app).raw('get', '/settings/identity')).status).toBe(401);
    const tag = etag(await read(admin));
    for (const who of [plain, regDelegate]) {
      const r = await put(who, { default_brand: 'aljeel', allow_user_choice: true, reason: REASON }, tag);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('action_forbidden');
    }
    expect(await value()).toEqual({ default_brand: 'current', allow_user_choice: true });
    expect(await audits()).toHaveLength(0);
  });

  it('checks the body, If-Match and the step-up', async () => {
    const tag = etag(await read(admin));
    const body = { default_brand: 'aljeel', allow_user_choice: true, reason: REASON };
    expect((await put(admin, body)).status).toBe(428);
    const stale = await put(admin, body, '"1"');
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    const noStepUp = await put(noStep, body, tag);
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.code).toBe('step_up_required');
    for (const bad of [
      { ...body, default_brand: 'dark' }, { ...body, default_brand: null }, { ...body, allow_user_choice: 'yes' }, { default_brand: 'aljeel', allow_user_choice: true },
      { ...body, reason: 'ab' }, { ...body, extra: 1 },
    ]) {
      const r = await put(admin, bad, tag);
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await value()).toEqual({ default_brand: 'current', allow_user_choice: true });
  });

  it('saves (audited with before and after), refuses the same values again (409) and a stale tag (412)', async () => {
    const cur = await read(admin);
    const ok = await put(admin, { default_brand: 'aljeel', allow_user_choice: true, reason: REASON }, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ default_brand: 'aljeel', allow_user_choice: true, updated_by: { id: admin.user.id }, can_edit: true });
    expect(etag(ok)).not.toBe(etag(cur));
    expect(await value()).toEqual({ default_brand: 'aljeel', allow_user_choice: true });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: admin.user.id, reason: REASON, before: { default_brand: 'current', allow_user_choice: true }, after: { default_brand: 'aljeel', allow_user_choice: true } });
    const same = await put(admin, { default_brand: 'aljeel', allow_user_choice: true, reason: REASON }, etag(ok));
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('invalid_transition');
    expect((await put(allDelegate, { default_brand: 'field', allow_user_choice: true, reason: REASON }, etag(cur))).status).toBe(412);
    // every user now follows the new default
    expect((await plain.api.call('get', '/me')).body.user).toMatchObject({ ui_brand: null, brand: 'aljeel' });
  });
});

describe('the personal design: PATCH /me/profile ui_brand', () => {
  it('a user chooses a design, goes back to the default with null; audited with before and after; GET /me and the profile carry both values', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const p = await api.call('get', '/me/profile');
    expect(p.body).toMatchObject({ ui_brand: null, brand: 'aljeel', identity: { default_brand: 'aljeel', allow_user_choice: true } });
    expect(p.body.editable_fields).toContain('ui_brand');
    const r = await patchBrand(api, 'field');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ui_brand: 'field', brand: 'field' });
    expect((await api.call('get', '/me')).body.user).toMatchObject({ ui_brand: 'field', brand: 'field', theme: 'light' });
    const back = await patchBrand(api, null);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ ui_brand: null, brand: 'aljeel' });
    const a = (await db.query(`SELECT before, after FROM audit_log WHERE action = 'profile_updated' AND entity_id = $1 ORDER BY id`, [u.id])).rows;
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ before: { ui_brand: null }, after: { ui_brand: 'field', via: 'self_service' } });
    expect(a[1]).toMatchObject({ before: { ui_brand: 'field' }, after: { ui_brand: null } });
    // an unknown design is 422 on the field
    const bad = await patchBrand(api, 'neon');
    expect(bad.status).toBe(422);
    expect(bad.body.errors.some((e: { path: string }) => e.path === '/ui_brand')).toBe(true);
  });

  it('while the admin locks the design, a personal one is refused (403 field_read_only) and ignored; null stays allowed', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await patchBrand(api, 'executive')).status).toBe(200);
    const lock = await put(admin, { default_brand: 'executive', allow_user_choice: false, reason: REASON }, etag(await read(admin)));
    expect(lock.status).toBe(200);
    const blocked = await patchBrand(api, 'field');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('field_read_only');
    expect(blocked.body.errors[0]).toMatchObject({ path: '/ui_brand', code: 'brand_choice_locked' });
    const stored = await q<{ ui_brand: string }>(db, 'SELECT ui_brand FROM users WHERE id = $1', [u.id]);
    expect(stored[0]!.ui_brand).toBe('executive');
    // the stored choice is kept but the locked default applies
    expect((await api.call('get', '/me')).body.user).toMatchObject({ ui_brand: 'executive', brand: 'executive' });
    await db.query(`UPDATE settings SET value = '{"default_brand": "aljeel", "allow_user_choice": false}'::jsonb WHERE key = 'ui.identity'`);
    expect((await api.call('get', '/me/profile')).body).toMatchObject({ ui_brand: 'executive', brand: 'aljeel', identity: { allow_user_choice: false } });
    expect((await patchBrand(api, null)).status).toBe(200);
    const unlock = await put(admin, { default_brand: 'current', allow_user_choice: true, reason: REASON }, etag(await read(admin)));
    expect(unlock.status).toBe(200);
    expect((await api.call('get', '/me')).body.user).toMatchObject({ ui_brand: null, brand: 'current' });
  });
});
