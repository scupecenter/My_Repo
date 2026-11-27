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
      expect(r.body).toMatchObject({ default_brand: 'current', allow_user_choice: true, brands: ['current', 'aljeel', 'executive', 'field', 'obsidian', 'sahara'], updated_by: null, can_edit: can });
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
    expect(await value()).toMatchObject({ default_brand: 'aljeel', allow_user_choice: true });
    // 0241: the stored value carries the appearance defaults (the built-in standard while none are set)
    expect((await value() as { defaults?: unknown }).defaults).toMatchObject({ density: 'standard', accent: 'default' });
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

  it('the two designs of 0164 (obsidian, sahara) can be chosen like the others, and an unknown name is still refused', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    for (const b of ['obsidian', 'sahara']) {
      const r = await patchBrand(api, b);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ui_brand: b });
    }
    expect((await patchBrand(api, 'neon')).status).toBeGreaterThanOrEqual(400);
    await patchBrand(api, null);
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

/** 0241 (owner approval 2026-11-27, the improvement proposal items 1-3): the appearance profile `ui_prefs` and the organization appearance defaults. */
describe('the appearance profile: PATCH /me/profile ui_prefs and the identity defaults', () => {
  const patchPrefs = async (api: Api, ui_prefs: unknown) => api.call('patch', '/me/profile', { ui_prefs }, { 'If-Match': await profileTag(api) });

  it('a user chooses dimensions one at a time; the effective appearance fills the rest from the defaults; audited per dimension; GET /me carries both', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const p = await api.call('get', '/me/profile');
    expect(p.body).toMatchObject({ ui_prefs: {}, identity: { allow_user_choice: true } });
    expect(p.body.identity.defaults).toMatchObject({ density: 'standard', accent: 'default' });
    expect(p.body.identity.pref_options.density).toEqual(['comfortable', 'standard', 'compact']);
    expect(p.body.editable_fields).toContain('ui_prefs');
    const r = await patchPrefs(api, { density: 'compact' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ui_prefs: { density: 'compact' } });
    expect(r.body.appearance).toMatchObject({ density: 'compact', font_scale: 'standard', accent: 'default' });
    const r2 = await patchPrefs(api, { density: 'compact', accent: 'violet' });
    expect(r2.status).toBe(200);
    expect(r2.body.appearance).toMatchObject({ density: 'compact', accent: 'violet' });
    expect((await api.call('get', '/me')).body.user).toMatchObject({ ui_prefs: { density: 'compact', accent: 'violet' } });
    const a = (await db.query(`SELECT before, after FROM audit_log WHERE action = 'profile_updated' AND entity_id = $1 ORDER BY id`, [u.id])).rows;
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ before: { ui_prefs: {} }, after: { ui_prefs: { density: 'compact' }, via: 'self_service' } });
    expect(a[1].after.ui_prefs).toMatchObject({ accent: 'violet' });
    // an unknown dimension or value is 422 on the field
    expect((await patchPrefs(api, { density: 'tiny' })).status).toBe(422);
    expect((await patchPrefs(api, { sparkle: 'lots' })).status).toBe(422);
  });

  it('the organization defaults come from PUT /settings/identity (omitted keeps them); everyone without a choice sees them', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const set = await put(admin, { default_brand: 'aljeel', allow_user_choice: true, defaults: { density: 'compact', accent: 'green' }, reason: REASON }, etag(await read(admin)));
    expect(set.status).toBe(200);
    expect(set.body.defaults).toMatchObject({ density: 'compact', accent: 'green' });
    expect((await api.call('get', '/me')).body.user.appearance).toMatchObject({ density: 'compact', accent: 'green' });
    // omitted keeps the current defaults
    const again = await put(admin, { default_brand: 'current', allow_user_choice: true, reason: REASON }, etag(await read(admin)));
    expect(again.status).toBe(200);
    expect(again.body.defaults).toMatchObject({ density: 'compact', accent: 'green' });
    expect((await put(admin, { default_brand: 'current', allow_user_choice: true, defaults: { density: 'airy' }, reason: REASON }, etag(await read(admin)))).status).toBe(422);
    await put(admin, { default_brand: 'current', allow_user_choice: true, defaults: {}, reason: REASON }, etag(await read(admin)));
  });

  it('while the admin locks the design, a personal appearance is refused (403 field_read_only); the stored choice is kept but the locked defaults apply', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await patchPrefs(api, { radius: 'rounded' })).status).toBe(200);
    const lock = await put(admin, { default_brand: 'current', allow_user_choice: false, defaults: { radius: 'sharp' }, reason: REASON }, etag(await read(admin)));
    expect(lock.status).toBe(200);
    const blocked = await patchPrefs(api, { radius: 'rounded', motion: 'reduced' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('field_read_only');
    expect(blocked.body.errors[0]).toMatchObject({ path: '/ui_prefs', code: 'appearance_choice_locked' });
    const stored = await q<{ ui_prefs: Record<string, string> }>(db, 'SELECT ui_prefs FROM users WHERE id = $1', [u.id]);
    expect(stored[0]!.ui_prefs).toMatchObject({ radius: 'rounded' });
    expect((await api.call('get', '/me')).body.user.appearance).toMatchObject({ radius: 'sharp' });
    await put(admin, { default_brand: 'current', allow_user_choice: true, defaults: {}, reason: REASON }, etag(await read(admin)));
    expect((await api.call('get', '/me')).body.user.appearance).toMatchObject({ radius: 'rounded' });
  });

  // 0347 (item 19 of the 2026-11-27 batch): `contrast` is an appearance dimension of the same framework - personal choice,
  // organization default and the admin lock all reach it through the same doors, with no parallel path.
  it('contrast: in the options, chosen personally, defaulted by the organization and locked with the rest', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const p = await api.call('get', '/me/profile');
    expect(p.body.identity.pref_options.contrast).toEqual(['standard', 'high']);
    expect(p.body.identity.defaults).toMatchObject({ contrast: 'standard' });
    expect(p.body.appearance).toMatchObject({ contrast: 'standard' });
    // the organization default from Settings > Identity reaches a user with no choice
    const set = await put(admin, { default_brand: 'current', allow_user_choice: true, defaults: { contrast: 'high' }, reason: REASON }, etag(await read(admin)));
    expect(set.status).toBe(200);
    expect(set.body.defaults).toMatchObject({ contrast: 'high' });
    expect((await api.call('get', '/me')).body.user.appearance).toMatchObject({ contrast: 'high' });
    // a personal choice wins over the organization default and is audited per dimension
    const r = await patchPrefs(api, { contrast: 'standard' });
    expect(r.status).toBe(200);
    expect(r.body.appearance).toMatchObject({ contrast: 'standard' });
    const a = (await db.query(`SELECT before, after FROM audit_log WHERE action = 'profile_updated' AND entity_id = $1 ORDER BY id`, [u.id])).rows;
    expect(a.at(-1)).toMatchObject({ before: { ui_prefs: {} }, after: { ui_prefs: { contrast: 'standard' } } });
    expect((await patchPrefs(api, { contrast: 'neon' })).status).toBe(422);
    // the admin lock refuses a personal contrast like every other dimension; the organization default still applies
    const lock = await put(admin, { default_brand: 'current', allow_user_choice: false, defaults: { contrast: 'high' }, reason: REASON }, etag(await read(admin)));
    expect(lock.status).toBe(200);
    const blocked = await patchPrefs(api, { contrast: 'standard' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.errors[0]).toMatchObject({ path: '/ui_prefs', code: 'appearance_choice_locked' });
    const u2 = await makeUser(db, { assigned: true });
    expect((await (await loggedIn(app, u2)).call('get', '/me')).body.user.appearance).toMatchObject({ contrast: 'high' });
    await put(admin, { default_brand: 'current', allow_user_choice: true, defaults: {}, reason: REASON }, etag(await read(admin)));
  });
});

/** 0242 (owner approval 2026-11-27, the improvement proposal item 4): the personal sidebar `ui_prefs.sidebar`. */
describe('the personal sidebar: PATCH /me/profile ui_prefs.sidebar', () => {
  const patchPrefs = async (api: Api, ui_prefs: unknown) => api.call('patch', '/me/profile', { ui_prefs }, { 'If-Match': await profileTag(api) });

  it('saves the sidebar (audited per key); keeps the dimensions on a sidebar-only body; a dimensions-only body keeps the sidebar', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await patchPrefs(api, { density: 'compact' })).status).toBe(200);
    let r = await patchPrefs(api, { sidebar: { hidden: ['logs.mail'], order: ['messages', 'inbox'], badge_style: 'dot', pins: ['messages', 'approvals'] } });
    expect(r.status).toBe(200);
    expect(r.body.ui_prefs).toMatchObject({ density: 'compact', sidebar: { badge_style: 'dot', pins: ['messages', 'approvals'], hidden: ['logs.mail'], order: ['messages', 'inbox'] } });
    // the effective appearance carries the dimensions only
    expect(r.body.appearance.sidebar).toBeUndefined();
    // a dimensions-only body keeps the stored sidebar
    r = await patchPrefs(api, { density: 'standard' });
    expect(r.status).toBe(200);
    expect(r.body.ui_prefs).toMatchObject({ density: 'standard', sidebar: { badge_style: 'dot' } });
    // duplicates drop out of the lists
    r = await patchPrefs(api, { sidebar: { pins: ['messages', 'messages', 'inbox'] } });
    expect(r.body.ui_prefs.sidebar.pins).toEqual(['messages', 'inbox']);
    // audited per key of ui_prefs
    const a = (await db.query(`SELECT before, after FROM audit_log WHERE action = 'profile_updated' AND entity_id = $1 ORDER BY id`, [u.id])).rows;
    expect(a).toHaveLength(4);
    expect(a[1].after.ui_prefs.sidebar).toMatchObject({ badge_style: 'dot' });
    expect(a[1].after.via).toBe('self_service');
    // GET /me carries the sidebar too
    expect((await api.call('get', '/me')).body.user.ui_prefs.sidebar).toMatchObject({ pins: ['messages', 'inbox'] });
  });

  it('checks the sidebar: an unknown key, a badge style outside the list, a bad entry, more than 20 pins are 422', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    expect((await patchPrefs(api, { sidebar: { colour: 'red' } })).status).toBe(422);
    expect((await patchPrefs(api, { sidebar: { badge_style: 'huge' } })).status).toBe(422);
    expect((await patchPrefs(api, { sidebar: { hidden: 'messages' } })).status).toBe(422);
    expect((await patchPrefs(api, { sidebar: { hidden: ['No Space'] } })).status).toBe(422);
    expect((await patchPrefs(api, { sidebar: { pins: Array.from({ length: 21 }, (_, i) => `k${i}`) } })).status).toBe(422);
    expect((await patchPrefs(api, { sidebar: 'everything' })).status).toBe(422);
  });

  it('while the admin locks the appearance, a sidebar-only change stays allowed; a dimension with it is refused and nothing changes', async () => {
    const u = await makeUser(db, { assigned: true });
    const api = await loggedIn(app, u);
    const lock = await put(admin, { default_brand: 'current', allow_user_choice: false, defaults: {}, reason: REASON }, etag(await read(admin)));
    expect(lock.status).toBe(200);
    const r = await patchPrefs(api, { sidebar: { badge_style: 'none' } });
    expect(r.status).toBe(200);
    expect(r.body.ui_prefs.sidebar).toMatchObject({ badge_style: 'none' });
    const blocked = await patchPrefs(api, { sidebar: { badge_style: 'full' }, density: 'compact' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.errors[0]).toMatchObject({ path: '/ui_prefs', code: 'appearance_choice_locked' });
    const stored = await q<{ ui_prefs: Record<string, unknown> }>(db, 'SELECT ui_prefs FROM users WHERE id = $1', [u.id]);
    expect(stored[0]!.ui_prefs.sidebar).toMatchObject({ badge_style: 'none' });
    expect(stored[0]!.ui_prefs.density).toBeUndefined();
    await put(admin, { default_brand: 'current', allow_user_choice: true, defaults: {}, reason: REASON }, etag(await read(admin)));
  });
});
