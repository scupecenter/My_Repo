import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * W8 item 4 (migration 0148, contract 0.15.68): the defaults of the Display menu are a general setting (Administration > Settings > Display), read by
 * every signed-in user, written by a System Admin or an all-regions delegate of admin.settings with a reason and If-Match, audited; saved views keep the
 * Display options of a view and the middle density.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let plain: Actor;
let delegateAll: Actor;
let delegateReg: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [4], modules: null });
  delegateAll = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [4], modules: null });
  await delegate(db, delegateAll.user.id, [['admin.settings', 'edit']]);
  delegateReg = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [4], modules: null });
  await delegate(db, delegateReg.user.id, [['admin.settings', 'edit']], [4]);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const codes = (res: { body: any }): string[] => (res.body.errors ?? []).map((e: { path: string; code: string }) => `${e.path}:${e.code}`).sort();
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/table-display', body, tag === undefined ? {} : { 'If-Match': tag });
const GOOD = { size: 'lg', align: 'center', density: 'normal', wrap: true, zebra: false, groupbar: false };

describe('W8: Settings > Display (table display defaults)', () => {
  it('every signed-in user reads the defaults (the seed before any save) with an ETag', async () => {
    const res = await plain.api.call('get', '/settings/table-display');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.defaults).sort()).toEqual(['align', 'density', 'groupbar', 'size', 'wrap', 'zebra']);
    expect(etag(res)).toBe(`"${res.body.version}"`);
  });

  it('refuses a plain user and a one-region delegate; needs a reason; closed body with field errors; If-Match', async () => {
    const cur = await admin.api.call('get', '/settings/table-display');
    expect((await put(plain, { defaults: GOOD, reason: 'Try it' }, etag(cur))).status).toBe(403);
    expect((await put(delegateReg, { defaults: GOOD, reason: 'Try it' }, etag(cur))).status).toBe(403);
    expect((await put(admin, { defaults: GOOD }, etag(cur))).status).toBe(422);
    const bad = await put(admin, { defaults: { size: 'xl', align: 'left', density: 'tight', wrap: 'yes', zebra: true, font: 1 }, extra: 1, reason: 'Bad values' }, etag(cur));
    expect(bad.status).toBe(422);
    expect(codes(bad)).toEqual(['/defaults/align:invalid', '/defaults/density:invalid', '/defaults/font:unknown_key', '/defaults/size:invalid', '/defaults/wrap:invalid', '/extra:unknown_key']);
  });

  it('an all-regions delegate saves, the version moves, a stale ETag is refused, and the change is audited with before and after', async () => {
    const cur = await admin.api.call('get', '/settings/table-display');
    const res = await put(delegateAll, { defaults: GOOD, reason: 'Larger text for the field teams' }, etag(cur));
    expect(res.status).toBe(200);
    expect(res.body.defaults).toEqual(GOOD);
    expect(res.body.updated_by).toMatchObject({ id: delegateAll.user.id });
    expect(etag(res)).not.toBe(etag(cur));
    expect((await put(admin, { defaults: GOOD, reason: 'Stale' }, etag(cur))).status).toBe(412);
    const rows = await db.query("SELECT entity_id, before, after, reason FROM audit_log WHERE action = 'table_display_update' ORDER BY id DESC LIMIT 1");
    expect(rows.rows[0]).toMatchObject({ entity_id: 'table.display', reason: 'Larger text for the field teams', after: GOOD });
    expect(rows.rows[0].before).toEqual(cur.body.defaults);
    expect((await plain.api.call('get', '/settings/table-display')).body.defaults).toEqual(GOOD);
    // back to the seed so other suites see the default look
    const back = await put(admin, { defaults: { size: 'md', align: 'start', density: 'comfortable', wrap: false, zebra: true }, reason: 'Back to the default' }, etag(res));
    expect(back.status).toBe(200);
  });

  it('Item 9: groupbar is optional in a PUT (an older client), reads as on when missing, and must be true or false', async () => {
    const cur = await admin.api.call('get', '/settings/table-display');
    expect(cur.body.defaults.groupbar).toBe(true);
    const bad = await put(admin, { defaults: { size: 'md', align: 'start', density: 'comfortable', wrap: false, zebra: true, groupbar: 'yes' }, reason: 'Bad value' }, etag(cur));
    expect(bad.status).toBe(422);
    expect(codes(bad)).toEqual(['/defaults/groupbar:invalid']);
    const old = await put(admin, { defaults: { size: 'md', align: 'start', density: 'comfortable', wrap: false, zebra: true }, reason: 'Older client without groupbar' }, etag(cur));
    expect(old.status).toBe(200);
    expect(old.body.defaults.groupbar).toBe(true);
    const off = await put(admin, { defaults: { size: 'md', align: 'start', density: 'comfortable', wrap: false, zebra: true, groupbar: false }, reason: 'Group summary off' }, etag(old));
    expect(off.status).toBe(200);
    expect(off.body.defaults.groupbar).toBe(false);
    const back = await put(admin, { defaults: { size: 'md', align: 'start', density: 'comfortable', wrap: false, zebra: true, groupbar: true }, reason: 'Back to the default' }, etag(off));
    expect(back.status).toBe(200);
  });

  it('the setting cannot be written around its door (the app role changes nothing; the guard trigger refuses)', async () => {
    const before = (await db.query("SELECT value FROM settings WHERE key = 'table.display'")).rows[0]?.value;
    try { await db.query("SET ROLE pmis_app; UPDATE settings SET value = '{}' WHERE key = 'table.display'"); } catch { /* refused */ }
    await db.query('RESET ROLE');
    expect((await db.query("SELECT value FROM settings WHERE key = 'table.display'")).rows[0]?.value).toEqual(before);
    // nor can it be deleted
    try { await db.query("SET ROLE pmis_app; DELETE FROM settings WHERE key = 'table.display'"); } catch { /* refused */ }
    await db.query('RESET ROLE');
    expect((await db.query("SELECT count(*)::int AS n FROM settings WHERE key = 'table.display'")).rows[0].n).toBe(before === undefined ? 0 : 1);
  });

  it('a saved view keeps the Display options and the middle density; unknown Display keys are refused', async () => {
    const ok = await plain.api.call('post', '/saved-views', { screen_key: 'sites', name: 'W8 display', filters: {}, columns: { density: 'normal', display: { size: 'sm', align: 'center', wrap: true, zebra: false, groupbar: false } } });
    expect(ok.status).toBe(201);
    const got = await plain.api.call('get', `/saved-views/${ok.body.id}`);
    expect(got.body.columns).toMatchObject({ density: 'normal', display: { size: 'sm', align: 'center', wrap: true, zebra: false, groupbar: false } });
    const bad = await plain.api.call('post', '/saved-views', { screen_key: 'sites', name: 'W8 bad', columns: { display: { font: 'x' } } });
    expect(bad.status).toBe(422);
  });
});
