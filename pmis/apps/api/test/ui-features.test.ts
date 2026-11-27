import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Migrations 0280 and 0281, contracts 0.15.185 and 0.15.250: the interface features are one guarded setting (ui.features), read by every signed-in user, written by a System Admin
 * or an all-regions delegate of admin.settings with a reason and If-Match, closed per section, audited.
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
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/ui-features', body, tag === undefined ? {} : { 'If-Match': tag });
const AV = { style: 'geometric', shape: 'rounded', palette: 'brand', in_lists: false };
const NB = { enabled: false, days: 30 };
const INBOX_SEED = { tabs_enabled: true, default_tab: 'all', priority_kinds: ['mention', 'approval_due', 'task_returned', 'task_rejected', 'idle_task_alert', 'no_holder', 'absence_alert'] };
const HUB_SEED = { widgets: { quick_bar: true, batches: true, template_changes: true, recent: true, health: true, admin: true }, badge: true, default_view: { templates: 'cards', uploads: 'table', exports: 'table', master_import: 'table' } };
const MAP_SEED = { enabled: false, tile_url: '', min_zoom: 0, max_zoom: 18, attribution: '', center_lat: 32.9, center_lon: 13.2, default_zoom: 6 };
const PANEL_SEED = { mode: 'popover', width: 'medium', show_tabs: true };
const INBOX = { tabs_enabled: true, default_tab: 'priority', priority_kinds: ['mention', 'system'] };

describe('Settings > Screens > Interface (ui.features)', () => {
  it('every signed-in user reads the seed before any save, with an ETag', async () => {
    const res = await plain.api.call('get', '/settings/ui-features');
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual({
      avatars: { style: 'gradient', shape: 'circle', palette: 'varied', in_lists: true },
      new_badge: { enabled: true, days: 14 },
      inbox: INBOX_SEED,
      data_hub: HUB_SEED, map: MAP_SEED,
      panel: PANEL_SEED,
    });
    expect(etag(res)).toBe(`"${res.body.version}"`);
  });

  it('refuses a plain user and a one-region delegate; needs a reason; closed body with field errors; If-Match', async () => {
    const cur = await admin.api.call('get', '/settings/ui-features');
    expect((await put(plain, { sections: { avatars: AV }, reason: 'Try it' }, etag(cur))).status).toBe(403);
    expect((await put(delegateReg, { sections: { avatars: AV }, reason: 'Try it' }, etag(cur))).status).toBe(403);
    expect((await put(admin, { sections: { avatars: AV } }, etag(cur))).status).toBe(422);
    const bad = await put(admin, {
      sections: { avatars: { style: 'cartoon', shape: 'square', palette: 'x', in_lists: 'yes', size: 1 }, new_badge: { enabled: true, days: 400 }, not_a_section: {} },
      extra: 1, reason: 'Bad values',
    }, etag(cur));
    expect(bad.status).toBe(422);
    expect(codes(bad)).toEqual([
      '/extra:unknown_key', '/sections/avatars/in_lists:invalid', '/sections/avatars/palette:invalid', '/sections/avatars/shape:invalid',
      '/sections/avatars/size:unknown_key', '/sections/avatars/style:invalid', '/sections/new_badge/days:out_of_range', '/sections/not_a_section:unknown_key',
    ]);
    const zero = await put(admin, { sections: { new_badge: { enabled: true, days: 0 } }, reason: 'Zero days' }, etag(cur));
    expect(codes(zero)).toEqual(['/sections/new_badge/days:out_of_range']);
    const frac = await put(admin, { sections: { new_badge: { enabled: true, days: 1.5 } }, reason: 'Fraction' }, etag(cur));
    expect(codes(frac)).toEqual(['/sections/new_badge/days:invalid']);
    const missing = await put(admin, { sections: { avatars: { style: 'none' } }, reason: 'Incomplete section' }, etag(cur));
    expect(codes(missing)).toEqual(['/sections/avatars/in_lists:invalid', '/sections/avatars/palette:invalid', '/sections/avatars/shape:invalid']);
  });

  it('an all-regions delegate saves one section, the other keeps its value, a stale ETag is refused, and the change is audited with before and after', async () => {
    const cur = await admin.api.call('get', '/settings/ui-features');
    const res = await put(delegateAll, { sections: { avatars: AV }, reason: 'Square avatars in the lists' }, etag(cur));
    expect(res.status).toBe(200);
    expect(res.body.sections.avatars).toEqual(AV);
    expect(res.body.sections.new_badge).toEqual(cur.body.sections.new_badge);
    expect(res.body.updated_by).toMatchObject({ id: delegateAll.user.id });
    expect(etag(res)).not.toBe(etag(cur));
    expect((await put(admin, { sections: { new_badge: NB }, reason: 'Stale' }, etag(cur))).status).toBe(412);
    const both = await put(admin, { sections: { avatars: AV, new_badge: NB }, reason: 'Both sections' }, etag(res));
    expect(both.status).toBe(200);
    expect(both.body.sections).toEqual({ avatars: AV, new_badge: NB, inbox: INBOX_SEED, panel: PANEL_SEED, data_hub: HUB_SEED, map: MAP_SEED });
    const rows = await db.query("SELECT entity_id, before, after, reason FROM audit_log WHERE action = 'ui_features_update' ORDER BY id DESC LIMIT 1");
    expect(rows.rows[0]).toMatchObject({ entity_id: 'ui.features', reason: 'Both sections', after: { avatars: AV, new_badge: NB, inbox: INBOX_SEED, panel: PANEL_SEED, data_hub: HUB_SEED, map: MAP_SEED } });
    expect(rows.rows[0].before.avatars).toEqual(AV);
    expect((await plain.api.call('get', '/settings/ui-features')).body.sections).toEqual({ avatars: AV, new_badge: NB, inbox: INBOX_SEED, panel: PANEL_SEED, data_hub: HUB_SEED, map: MAP_SEED });
    const back = await put(admin, {
      sections: { avatars: { style: 'gradient', shape: 'circle', palette: 'varied', in_lists: true }, new_badge: { enabled: true, days: 14 } }, reason: 'Back to the default',
    }, etag(both));
    expect(back.status).toBe(200);
  });

  it('the inbox section (0281): saved on its own, closed, kinds checked, and the other sections keep their value', async () => {
    const cur = await admin.api.call('get', '/settings/ui-features');
    const bad = await put(admin, { sections: { inbox: { tabs_enabled: 'yes', default_tab: 'inbox', priority_kinds: ['mention', 'nope'], extra: 1 } }, reason: 'Bad inbox' }, etag(cur));
    expect(bad.status).toBe(422);
    expect(codes(bad)).toEqual(['/sections/inbox/default_tab:invalid', '/sections/inbox/extra:unknown_key', '/sections/inbox/priority_kinds:invalid', '/sections/inbox/tabs_enabled:invalid']);
    const notList = await put(admin, { sections: { inbox: { ...INBOX, priority_kinds: 'mention' } }, reason: 'Not a list' }, etag(cur));
    expect(codes(notList)).toEqual(['/sections/inbox/priority_kinds:invalid']);
    const ok = await put(admin, { sections: { inbox: INBOX }, reason: 'Priority tab first' }, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body.sections.inbox).toEqual(INBOX);
    expect(ok.body.sections.avatars).toEqual(cur.body.sections.avatars);
    expect((await plain.api.call('get', '/settings/ui-features')).body.sections.inbox).toEqual(INBOX);
    const back = await put(admin, { sections: { inbox: INBOX_SEED, panel: PANEL_SEED, data_hub: HUB_SEED, map: MAP_SEED }, reason: 'Back to the default' }, etag(ok));
    expect(back.status).toBe(200);
  });

  it('the panel section (0282): saved on its own, closed, values checked, and the other sections keep their value', async () => {
    const cur = await admin.api.call('get', '/settings/ui-features');
    const bad = await put(admin, { sections: { panel: { mode: 'drawer', width: 'huge', show_tabs: 'yes', extra: 1 } }, reason: 'Bad panel' }, etag(cur));
    expect(bad.status).toBe(422);
    expect(codes(bad)).toEqual(['/sections/panel/extra:unknown_key', '/sections/panel/mode:invalid', '/sections/panel/show_tabs:invalid', '/sections/panel/width:invalid']);
    const PANEL = { mode: 'side_panel', width: 'wide', show_tabs: false };
    const ok = await put(admin, { sections: { panel: PANEL }, reason: 'Side panel' }, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body.sections.panel).toEqual(PANEL);
    expect(ok.body.sections.inbox).toEqual(cur.body.sections.inbox);
    expect((await plain.api.call('get', '/settings/ui-features')).body.sections.panel).toEqual(PANEL);
    const back = await put(admin, { sections: { panel: PANEL_SEED }, reason: 'Back to the default' }, etag(ok));
    expect(back.status).toBe(200);
  });

  it('the setting cannot be written around its door (the app role changes nothing; the guard trigger refuses)', async () => {
    const before = (await db.query("SELECT value FROM settings WHERE key = 'ui.features'")).rows[0]?.value;
    try { await db.query("SET ROLE pmis_app; UPDATE settings SET value = '{}' WHERE key = 'ui.features'"); } catch { /* refused */ }
    await db.query('RESET ROLE');
    expect((await db.query("SELECT value FROM settings WHERE key = 'ui.features'")).rows[0]?.value).toEqual(before);
    try { await db.query("SET ROLE pmis_app; DELETE FROM settings WHERE key = 'ui.features'"); } catch { /* refused */ }
    await db.query('RESET ROLE');
    expect((await db.query("SELECT count(*)::int AS n FROM settings WHERE key = 'ui.features'")).rows[0].n).toBe(before === undefined ? 0 : 1);
  });
});
