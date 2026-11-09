import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * The editable side menu (migration 0081, contract 0.15.1): GET / PUT /settings/nav-layout. The layout is one shared setting (nav.layout); every signed-in user
 * reads it; a System Admin or a delegate of settings edit for all regions changes it with a reason and If-Match, validated and audited by the database.
 * The suite puts the setting back to the default at the end (no other suite reads it).
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let plain: Actor;
let allDelegate: Actor;
let regDelegate: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, false); // no step-up: the change does not need one (the rule of Settings, Imports)
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  allDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, allDelegate.user.id, [['settings', 'edit']]);
  regDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  await delegate(db, regDelegate.user.id, [['settings', 'edit']], [5]);
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = 'null'::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'nav.layout'`);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const read = (who: Actor) => who.api.call('get', '/settings/nav-layout');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/nav-layout', body, tag === undefined ? {} : { 'If-Match': tag });
const value = async (): Promise<unknown> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'nav.layout'`))[0]?.value;
const audits = (action: string) => q<{ before: any; after: any; reason: string; actor_id: string }>(db,
  `SELECT before, after, reason, actor_id::text AS actor_id FROM audit_log WHERE action = $1 AND entity_id = 'nav.layout' ORDER BY id`, [action]);

/** A valid layout: two main headings, a sub-heading, a renamed default heading. */
const LAYOUT = {
  headings: [
    { id: 'work', name_en: 'My day', name_ar: 'يومي', icon: 'home', children: ['dashboard', 'my_work', { id: 'h_comm', name_en: 'Talk', name_ar: 'تواصل', icon: null, children: ['messages', 'inbox'] }] },
    { id: 'registers', name_en: 'Registers & Logs', name_ar: 'السجلات والقيود', icon: null, children: ['warehouse', 'procurement'] },
  ],
};
const heading = (over: Record<string, unknown>) => ({ headings: [{ id: 'work', name_en: 'Work', name_ar: 'العمل', icon: null, children: ['my_work'], ...over }] });

describe('the editable side menu: GET and PUT /settings/nav-layout', () => {
  it('every signed-in user reads it (the default: null, the catalogue); only a System Admin or an all-regions delegate of settings may edit', async () => {
    for (const [who, can] of [[plain, false], [regDelegate, false], [allDelegate, true], [admin, true]] as [Actor, boolean][]) {
      const r = await read(who);
      expect(r.status).toBe(200);
      expect(etag(r)).toMatch(/^"\d{1,9}"$/);
      expect(r.body).toMatchObject({ layout: null, is_default: true, updated_by: null, can_edit: can });
      expect(r.body.catalogue).toHaveLength(42);
      expect(r.body.catalogue.slice(0, 3)).toEqual(['my_work', 'inbox', 'approvals']);
      expect(r.body.catalogue).toContain('admin.settings');
    }
    expect((await new Api(app).raw('get', '/settings/nav-layout')).status).toBe(401);
    const tag = etag(await read(admin));
    for (const who of [plain, regDelegate]) {
      const r = await put(who, { layout: LAYOUT, reason: 'I want my own order' }, tag);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('action_forbidden');
    }
    expect(await value()).toBeNull();
    expect(await audits('nav_layout_update')).toHaveLength(0);
  });

  it('validates the tree, the reason, unknown keys and If-Match with field errors', async () => {
    const tag = etag(await read(admin));
    expect((await put(admin, { layout: LAYOUT, reason: 'no tag' })).status).toBe(428);
    const stale = await put(admin, { layout: LAYOUT, reason: 'stale tag' }, '"1"');
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    const cases: [unknown, string, string][] = [
      [{ layout: LAYOUT }, '/reason', ''],
      [{ layout: LAYOUT, reason: 'ab' }, '/reason', 'too_small'],
      [{ layout: LAYOUT, reason: 'extra key', mode: 'x' }, '/', 'unknown_field'],
      [{ layout: [], reason: 'an array' }, '/layout', ''],
      [{ layout: { headings: [] }, reason: 'no heading' }, '/layout/headings', 'too_many'],
      [{ layout: { headings: [], extra: 1 }, reason: 'unknown field' }, '/layout/extra', 'unknown_field'],
      [{ layout: heading({ name_ar: '  ' }), reason: 'no Arabic name' }, '/layout/headings/0/name_ar', 'required'],
      [{ layout: heading({ name_en: 'x'.repeat(61) }), reason: 'long name' }, '/layout/headings/0/name_en', 'too_long'],
      [{ layout: heading({ id: 'Bad Id' }), reason: 'bad id' }, '/layout/headings/0/id', 'invalid'],
      [{ layout: heading({ icon: 'not an icon!' }), reason: 'bad icon' }, '/layout/headings/0/icon', 'invalid'],
      [{ layout: heading({ children: ['/admin/users?x=1'] }), reason: 'a link' }, '/layout/headings/0/children/0', 'unknown_item'],
      [{ layout: heading({ children: ['my_work', 'my_work'] }), reason: 'twice' }, '/layout/headings/0/children/1', 'duplicate_item'],
      [{ layout: heading({ children: [{ id: 's', name_en: 'S', name_ar: 'س', children: [{ id: 't', name_en: 'T', name_ar: 'ت', children: [] }] }] }), reason: 'too deep' },
        '/layout/headings/0/children/0/children/0', 'too_deep'],
      [{ layout: heading({ children: [{ id: 'work', name_en: 'S', name_ar: 'س', children: [] }] }), reason: 'same id' }, '/layout/headings/0/children/0/id', 'duplicate_id'],
      [{ layout: heading({ children: [42] }), reason: 'a number' }, '/layout/headings/0/children/0', 'invalid'],
    ];
    for (const [body, path, code] of cases) {
      const r = await put(admin, body, tag);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(422);
      if (path) expect(r.body.errors.some((e: { path: string; code: string }) => e.path === path && (!code || e.code === code)), JSON.stringify(r.body.errors)).toBe(true);
    }
    const many = { headings: Array.from({ length: 31 }, (_, i) => ({ id: `h${i}`, name_en: 'H', name_ar: 'ع', children: [] })) };
    expect((await put(admin, { layout: many, reason: 'too many headings' }, tag)).status).toBe(422);
    expect(await value()).toBeNull();
  });

  it('saves a layout (audited with before and after), refuses the same layout again (409), and an all-regions delegate resets it to the default', async () => {
    const cur = await read(admin);
    const ok = await put(admin, { layout: LAYOUT, reason: 'The owner asked for this order' }, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ is_default: false, updated_by: { id: admin.user.id }, layout: LAYOUT });
    expect(ok.body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(etag(ok)).not.toBe(etag(cur));
    expect(await value()).toEqual(LAYOUT);
    const a = await audits('nav_layout_update');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: admin.user.id, reason: 'The owner asked for this order', before: { layout: null, is_default: true }, after: { layout: LAYOUT, is_default: false, updated_by: admin.user.id } });

    // every user reads the shared layout
    expect((await read(plain)).body).toMatchObject({ layout: LAYOUT, is_default: false, updated_by: { id: admin.user.id } });

    // names are trimmed; the same layout again is 409
    const same = await put(admin, { layout: LAYOUT, reason: 'twice' }, etag(ok));
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('invalid_transition');
    // the old tag is stale now
    expect((await put(allDelegate, { layout: null, reason: 'With an old tag' }, etag(cur))).status).toBe(412);

    const reset = await put(allDelegate, { layout: null, reason: 'Back to the default menu' }, etag(await read(allDelegate)));
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ layout: null, is_default: true, updated_by: { id: allDelegate.user.id } });
    expect(await value()).toBeNull();
    const r = await audits('nav_layout_reset');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ actor_id: allDelegate.user.id, reason: 'Back to the default menu', before: { layout: LAYOUT, is_default: false }, after: { layout: null, is_default: true } });
    const again = await put(admin, { layout: null, reason: 'Reset twice' }, etag(reset));
    expect(again.status).toBe(409);
  });

  it('trims the heading names and keeps a missing icon as null', async () => {
    const cur = await read(admin);
    const r = await put(admin, { layout: { headings: [{ id: 'work', name_en: '  Work  ', name_ar: ' العمل ', children: ['my_work'] }] }, reason: 'Trimmed names' }, etag(cur));
    expect(r.status).toBe(200);
    expect(r.body.layout).toEqual({ headings: [{ id: 'work', name_en: 'Work', name_ar: 'العمل', icon: null, children: ['my_work'] }] });
    expect((await put(admin, { layout: null, reason: 'Clean up' }, etag(r))).status).toBe(200);
  });
});
