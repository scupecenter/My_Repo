import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, delegate, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Settings, Screens, Login page (owner request 2026-11-26, migration 0197, contract 0.15.97): GET / PUT /settings/login-page
 * (setting ui.login_page) and the public GET /settings/login-page/public, which answers ONLY what the signed-out pages render
 * (announcement, animation, default_locale, support_links): no version, no audit data, nothing about users. The suite puts the
 * setting back to the default at the end; no other suite reads it.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;
let allDelegate: Actor;
let regDelegate: Actor;
const REASON = 'Owner request 2026-11-26';
const DEFAULT = { announcement_en: '', announcement_ar: '', announcement_kind: 'info', animation: true, default_locale: null, support_links: [] };
/** 0658: the render-only card fields and their defaults (a body without them keeps the current values). */
const CARD = { show_remember: true, show_language_switch: true, show_theme_switch: true, show_help: true, welcome_title_en: '', welcome_title_ar: '', welcome_subtitle_en: '', welcome_subtitle_ar: '' };
const SAMPLE = {
  announcement_en: 'Planned maintenance on Sunday 02:00-04:00.', announcement_ar: 'صيانة مجدولة يوم الأحد من 02:00 إلى 04:00.',
  announcement_kind: 'maintenance', animation: false, default_locale: 'ar',
  support_links: [{ label_en: 'IT support', label_ar: 'الدعم الفني', url: 'mailto:it@example.test' }, { label_en: 'Help', label_ar: '', url: 'https://help.example.test/' }],
};

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
  await db.query(`UPDATE settings SET value = $1::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'ui.login_page'`, [JSON.stringify(DEFAULT)]);
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const read = (who: Actor) => who.api.call('get', '/settings/login-page');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/login-page', body, tag === undefined ? {} : { 'If-Match': tag });
const pub = () => new Api(app).raw('get', '/settings/login-page/public');
const value = async (): Promise<unknown> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'ui.login_page'`))[0]?.value;
const audits = () => q<{ before: any; after: any; reason: string; actor_id: string }>(db,
  `SELECT before, after, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'login_page_update' AND entity_id = 'ui.login_page' ORDER BY id`);

describe('the public door: GET /settings/login-page/public', () => {
  it('answers without a session, with ONLY what the sign-in page renders', async () => {
    const r = await pub();
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('max-age=30');
    expect(r.body).toEqual({ announcement: null, animation: true, default_locale: null, support_links: [], ...CARD });
    // nothing else leaks: no version, no audit data, nothing about users
    expect(Object.keys(r.body).sort()).toEqual(['animation', 'announcement', 'default_locale', 'support_links', ...Object.keys(CARD)].sort());
    expect(JSON.stringify(r.body)).not.toMatch(/version|updated_|can_edit|0\.15/);
  });
});

describe('Settings, Screens, Login page: GET and PUT /settings/login-page', () => {
  it('every signed-in user reads the default; only a System Admin or an all-regions settings delegate may edit', async () => {
    for (const [who, can] of [[plain, false], [regDelegate, false], [allDelegate, true], [admin, true]] as [Actor, boolean][]) {
      const r = await read(who);
      expect(r.status).toBe(200);
      expect(etag(r)).toMatch(/^"\d{1,10}"$/);
      expect(r.body).toMatchObject({ ...DEFAULT, updated_by: null, can_edit: can });
      expect(r.body.server_version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect((await new Api(app).raw('get', '/settings/login-page')).status).toBe(401);
    const tag = etag(await read(admin));
    for (const who of [plain, regDelegate]) {
      const r = await put(who, { ...SAMPLE, reason: REASON }, tag);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('action_forbidden');
    }
    expect(await value()).toEqual(DEFAULT);
    expect(await audits()).toHaveLength(0);
  });

  it('checks the body, If-Match and the step-up', async () => {
    const tag = etag(await read(admin));
    const body = { ...SAMPLE, reason: REASON };
    expect((await put(admin, body)).status).toBe(428);
    const stale = await put(admin, body, '"1"');
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    const noStepUp = await put(noStep, body, tag);
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.code).toBe('step_up_required');
    for (const bad of [
      { ...body, announcement_kind: 'urgent' }, { ...body, announcement_en: 'x'.repeat(281) }, { ...body, animation: 'yes' },
      { ...body, default_locale: 'fr' }, { ...body, support_links: [...SAMPLE.support_links, { label_en: 'x', label_ar: '', url: 'javascript:alert(1)' }] },
      { ...body, support_links: Array(6).fill(SAMPLE.support_links[0]) }, { ...body, reason: 'ab' }, { ...body, extra: 1 },
    ]) {
      const r = await put(admin, bad, tag);
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await value()).toEqual(DEFAULT);
  });

  it('saves (audited with before and after), shows on the public door, refuses the same values again (409) and a stale tag (412)', async () => {
    const cur = await read(admin);
    const ok = await put(admin, { ...SAMPLE, reason: REASON }, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ...SAMPLE, updated_by: { id: admin.user.id }, can_edit: true });
    expect(etag(ok)).not.toBe(etag(cur));
    expect(await value()).toEqual({ ...SAMPLE, ...CARD }); // the stored value now carries the card fields (0658)
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: admin.user.id, reason: REASON, before: DEFAULT, after: SAMPLE });
    // the public door now shows the announcement and the links, and still nothing else
    const p = await pub();
    expect(p.status).toBe(200);
    expect(p.body).toEqual({
      announcement: { en: SAMPLE.announcement_en, ar: SAMPLE.announcement_ar, kind: 'maintenance' },
      animation: false, default_locale: 'ar', support_links: SAMPLE.support_links, ...CARD,
    });
    const same = await put(admin, { ...SAMPLE, reason: REASON }, etag(ok));
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('invalid_transition');
    expect((await put(allDelegate, { ...DEFAULT, reason: REASON }, etag(cur))).status).toBe(412);
    // back to the default; the banner hides again
    const back = await put(admin, { ...DEFAULT, reason: REASON }, etag(ok));
    expect(back.status).toBe(200);
    expect((await pub()).body).toEqual({ announcement: null, animation: true, default_locale: null, support_links: [], ...CARD });
  });
});

describe('card display fields (0658)', () => {
  it('are written with the page, validated, kept when a body omits them, and shown by the public door', async () => {
    const cur = await read(admin);
    const card = { show_remember: false, show_help: false, welcome_title_en: 'Welcome back', welcome_title_ar: 'أهلاً بعودتك', welcome_subtitle_en: 'Sign in to GSDN', welcome_subtitle_ar: 'سجّل الدخول' };
    const ok = await put(admin, { ...DEFAULT, ...card, reason: REASON }, etag(cur));
    expect(ok.status).toBe(200);
    expect((await pub()).body).toMatchObject({ ...CARD, ...card });
    for (const bad of [{ show_remember: 'no' }, { welcome_title_en: 'x'.repeat(81) }, { welcome_subtitle_ar: 'x'.repeat(161) }, { welcome_title_ar: 5 }]) {
      expect((await put(admin, { ...DEFAULT, ...bad, reason: REASON }, etag(ok))).status).toBe(422);
    }
    // a body without the card keys keeps them
    const kept = await put(admin, { ...DEFAULT, animation: false, reason: REASON }, etag(ok));
    expect(kept.status).toBe(200);
    expect((await pub()).body).toMatchObject({ ...CARD, ...card, animation: false });
  });
});
